/**
 * Explicit apply-credits — the deliberate counterpart to auto-application.
 *
 * ── The hole this closes ──────────────────────────────────────────────────────
 * Credits Flexibility (0219) let a merchant say "do not auto-apply refundable credits /
 * excess payments", and `planCreditApplication` + `collect_payment` both obey it. Which
 * meant a merchant who set it had NO way to apply credit at all: the setting stopped
 * deferring automatic application and started abolishing application. So the merchant
 * gets an explicit apply action:
 * `POST /v1/businesses/:biz/invoices/:inv/apply_credits`.
 *
 * ── The decision this suite is really pinning ─────────────────────────────────
 * An explicit apply IGNORES the Credits Flexibility ceilings — both the site grid and the
 * per-subscription maxima — and honours everything that is an INVARIANT rather than a
 * preference. §2 asserts both halves against the same fixture, because a suite that only
 * proved "it applies credit" would pass just as happily against an implementation that
 * quietly re-applied the ceiling and under-applied, and that failure mode is invisible in
 * a green log. The reasoning lives on `applyCreditsToInvoice`; this is its evidence.
 *
 * Sections:
 *   §1 THE HOLE — "do not auto-apply" leaves the credit stranded through billing and
 *      collect_payment; the explicit action spends it and settles the invoice.
 *   §2 CEILINGS — a site "up to 2000" AND a subscription max of 1000 are both ignored by
 *      an explicit apply; the control re-proves they still bind automatic application.
 *   §3 INVARIANTS — the four things it must never do, each as a refusal or a clamp:
 *      over-apply the invoice, over-draw a bucket, cross a currency, touch promotional.
 *   §4 REFUSALS — the request shapes that must 400/404 rather than half-execute.
 *   §5 LEDGER + PROVENANCE — AR credited, buckets debited, the books net to zero, and
 *      the refundable draw is allocated to the credit note that funded it.
 *   §6 STATUS + EVENTS — settled-by-credit is `paid` + `dunning_status: stopped` (NOT
 *      `success` — no cash arrived), and it emits invoice_paid / invoice_updated /
 *      customer_updated exactly once.
 *   §7 HTTP — auth, tenancy, and the `Idempotency-Key` replay, over `app.inject`.
 *   §9 VOID RELEASES THE ALLOCATION (#57) — voiding an invoice gave the credit back in the
 *      LEDGER and left the note claiming it was spent, so the customer's own money could
 *      not be refunded to them. 9G is the load-bearing one: the note's available must equal
 *      the ledger's balance, because the arithmetic invariant held all through the defect.
 *
 * ⚠️ Run it on a SCRATCH database, never the dev one:
 *   pnpm db:scratch --setup --name apply
 *   pnpm db:scratch --name apply -- pnpm verify:apply-credits
 */
import { eq, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb, type Tx } from "@/platform/db";
import {
  createOrganization,
  createBusiness,
  createApiKey,
  updateBusiness,
} from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription, updateSubscriptionSettings } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod, createInvoiceFromLines } from "@/modules/invoicing/service";
import { recordOfflinePayment, applyCreditsToInvoice, voidInvoice } from "@/modules/invoicing/ops";
import {
  creditNoteAvailable,
  issueAdjustmentCreditNote,
  issueRefundableCreditNote,
  recordOfflineCnRefund,
} from "@/modules/credit-notes/service";
import {
  addPromotionalCredits,
  recordExcessPayment,
  bucketBalancesForCurrency,
} from "@/modules/customers/balances";
import { collectPayment } from "@/modules/customers/collect";
import { creditNoteAllocations, creditNotes, events, invoices } from "@db/schema";

const checks: Array<[string, boolean, string]> = [];
const ok = (name: string, pass: boolean, detail = "") => checks.push([name, pass, detail]);
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));

const org = await createOrganization({ name: "Apply Credits Org" });
const orgId = org.organization.id;
const app = await buildApp({ logger: false });
const { secret } = await createApiKey(orgId, "test");

const invRow = (id: string) =>
  withTenant(
    orgId,
    async (tx) => (await tx.select().from(invoices).where(eq(invoices.id, id)).limit(1))[0]!,
  );

async function acctBal(businessId: string, account: string, currency = "USD"): Promise<bigint> {
  return withTenant(orgId, async (tx: Tx) => {
    const res = await tx.execute(sql`
      select coalesce(sum(case when direction='debit' then amount_minor else -amount_minor end),0)::bigint as bal
      from ledger_entries where business_id = ${businessId} and account = ${account} and currency = ${currency}`);
    return BigInt((res as unknown as Array<{ bal: string | number }>)[0]?.bal ?? 0);
  });
}
async function ledgerNetsZero(businessId: string): Promise<boolean> {
  return withTenant(orgId, async (tx: Tx) => {
    const res = await tx.execute(sql`
      select coalesce(sum(case when direction='debit' then amount_minor else -amount_minor end),0)::bigint as bal
      from ledger_entries where business_id = ${businessId} group by currency`);
    return (res as unknown as Array<{ bal: string | number }>).every((r) => BigInt(r.bal) === 0n);
  });
}
async function eventTypes(businessId: string, since: Date): Promise<string[]> {
  return withTenant(orgId, async (tx) => {
    const rows = await tx
      .select({ type: events.type, createdAt: events.createdAt })
      .from(events)
      .where(eq(events.businessId, businessId));
    return rows.filter((r) => r.createdAt.getTime() >= since.getTime()).map((r) => r.type);
  });
}

/**
 * A business + customer holding 5000 refundable (from a real credit note, so the
 * allocation half of §5 has something to attribute to) and 5000 excess, plus a monthly
 * 10000 price. Deliberately the same fixture shape as `verify:credits-flexibility` so the
 * two suites' numbers are comparable line for line.
 */
async function fixture(label: string, currency = "USD") {
  const biz = await createBusiness({
    organizationId: orgId,
    name: `Apply ${label}`,
    defaultCurrency: currency,
    livemode: "test",
    timezone: "Asia/Kolkata",
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `${label.replace(/\W+/g, "-")}@apply.test`,
  });
  const product = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: `Apply ${label} Plan`,
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency,
    amountMinor: 10000,
    interval: "month",
  });
  // Refundable: bill 5000, pay it offline, credit it back refundably.
  const { invoice: seed } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    currency,
    lines: [{ description: "seed", amountMinor: 5000n }],
  });
  await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: seed.publicId,
  });
  await issueRefundableCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: seed.publicId,
    items: [{ description: "seed credit", amountMinor: 5000 }],
  });
  await recordExcessPayment({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    amountMinor: 5000,
    currency,
  });
  return { biz, customer, price, currency };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const NO_AUTO_APPLY = {
  refundable: { recurring: { mode: "none" }, one_time: { mode: "none" } },
  excess: { recurring: { mode: "none" }, one_time: { mode: "none" } },
};

async function billMonth(
  f: Fixture,
  subPatch?: {
    maxRefundableCreditsUsageMinor?: bigint | null;
    maxExcessPaymentUsageMinor?: bigint | null;
  },
) {
  const created = await createSubscription({
    organizationId: orgId,
    businessId: f.biz.id,
    customerId: f.customer.id,
    now: new Date(),
    items: [{ price: f.price, quantity: 1 }],
  });
  let sub = created.subscription;
  if (subPatch)
    sub =
      (await updateSubscriptionSettings({
        organizationId: orgId,
        businessId: f.biz.id,
        subscriptionPublicId: sub.publicId,
        ...subPatch,
      })) ?? sub;
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: f.biz.id,
    subscription: sub,
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
  });
  return { invoice: await invRow(invoice.id), sub };
}

// ══════════════════════════════════════════════════════════════════════════════
// §1  THE HOLE — "do not auto-apply" strands the credit; the explicit action spends it
// ══════════════════════════════════════════════════════════════════════════════
{
  const f = await fixture("hole");
  await updateBusiness(orgId, f.biz.publicId, { creditsFlexibility: NO_AUTO_APPLY });
  const { invoice } = await billMonth(f);
  ok(
    "1A: with auto-apply off, a 10000 renewal draws NO credit and stands fully due",
    invoice.refundableCreditsAppliedMinor === 0n &&
      invoice.excessPaymentsAppliedMinor === 0n &&
      invoice.amountDueMinor === 10000n,
    `ref=${invoice.refundableCreditsAppliedMinor} exc=${invoice.excessPaymentsAppliedMinor} due=${invoice.amountDueMinor}`,
  );
  const collected = await collectPayment({
    organizationId: orgId,
    businessId: f.biz.id,
    customerPublicId: f.customer.publicId,
    invoiceIds: [invoice.publicId],
  });
  ok(
    "1B: …and collect_payment applies nothing either — the credit is unreachable",
    collected?.applied.refundable === 0 && collected?.applied.excess === 0,
    j(collected?.applied),
  );
  const applied = await applyCreditsToInvoice({
    organizationId: orgId,
    businessId: f.biz.id,
    invoicePublicId: invoice.publicId,
  });
  ok(
    "1C: the EXPLICIT apply spends both buckets — 5000 refundable + 5000 excess",
    applied.appliedRefundableMinor === 5000n && applied.appliedExcessMinor === 5000n,
    `ref=${applied.appliedRefundableMinor} exc=${applied.appliedExcessMinor}`,
  );
  const after = await invRow(invoice.id);
  ok(
    "1D: …and the 10000 invoice is settled: amount_due 0, status paid",
    after.amountDueMinor === 0n && after.status === "paid",
    `due=${after.amountDueMinor} status=${after.status}`,
  );
  const bal = await bucketBalancesForCurrency(orgId, f.customer.id, "USD");
  ok("1E: both buckets are drawn to zero", bal.refundable === 0n && bal.excess === 0n, j(bal));
}

// ══════════════════════════════════════════════════════════════════════════════
// §2  CEILINGS — an explicit apply ignores them; automatic application still obeys
// ══════════════════════════════════════════════════════════════════════════════
{
  const f = await fixture("ceilings");
  // Site: refundable "up to 2000" on recurring. Subscription: excess max 1000.
  await updateBusiness(orgId, f.biz.publicId, {
    creditsFlexibility: { refundable: { recurring: { mode: "limit", limit_minor: 2000 } } },
  });
  const { invoice } = await billMonth(f, { maxExcessPaymentUsageMinor: 1000n });
  ok(
    "2A: CONTROL — automatic application still obeys BOTH ceilings (2000 + 1000)",
    invoice.refundableCreditsAppliedMinor === 2000n && invoice.excessPaymentsAppliedMinor === 1000n,
    `ref=${invoice.refundableCreditsAppliedMinor} exc=${invoice.excessPaymentsAppliedMinor}`,
  );
  // 10000 invoice, 3000 already applied → 7000 outstanding, and 3000 refundable + 4000
  // excess still in the buckets. An explicit apply must spend ALL of it despite both
  // ceilings being long since reached.
  const applied = await applyCreditsToInvoice({
    organizationId: orgId,
    businessId: f.biz.id,
    invoicePublicId: invoice.publicId,
  });
  ok(
    "2B: an explicit apply IGNORES the site limit — the remaining 3000 refundable goes on",
    applied.appliedRefundableMinor === 3000n,
    `ref=${applied.appliedRefundableMinor} (ceiling said 2000, already spent)`,
  );
  ok(
    "2C: …and ignores the SUBSCRIPTION maximum — the remaining 4000 excess goes on",
    applied.appliedExcessMinor === 4000n,
    `exc=${applied.appliedExcessMinor} (max_excess_payment_usage_minor said 1000, already spent)`,
  );
  const after = await invRow(invoice.id);
  ok(
    "2D: the invoice ends fully settled by credit, with the ceilings' totals summed",
    after.refundableCreditsAppliedMinor === 5000n &&
      after.excessPaymentsAppliedMinor === 5000n &&
      after.amountDueMinor === 0n &&
      after.status === "paid",
    `ref=${after.refundableCreditsAppliedMinor} exc=${after.excessPaymentsAppliedMinor} due=${after.amountDueMinor} ${after.status}`,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// §3  INVARIANTS — what an explicit apply must NEVER do, ceiling or no ceiling
// ══════════════════════════════════════════════════════════════════════════════
{
  const f = await fixture("invariants");
  await updateBusiness(orgId, f.biz.publicId, { creditsFlexibility: NO_AUTO_APPLY });
  // A 3000 one-time invoice against 10000 of credit: it must take 3000 and stop.
  const { invoice: small } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: f.biz.id,
    customerId: f.customer.id,
    currency: "USD",
    lines: [{ description: "small", amountMinor: 3000n }],
  });
  const a = await applyCreditsToInvoice({
    organizationId: orgId,
    businessId: f.biz.id,
    invoicePublicId: small.publicId,
  });
  ok(
    "3A: never over-applies — a 3000 invoice takes 3000 of the 10000 available",
    a.appliedRefundableMinor + a.appliedExcessMinor === 3000n && a.appliedRefundableMinor === 3000n,
    `ref=${a.appliedRefundableMinor} exc=${a.appliedExcessMinor}`,
  );
  const bal = await bucketBalancesForCurrency(orgId, f.customer.id, "USD");
  ok(
    "3B: …and the rest stays with the customer (2000 refundable, 5000 excess untouched)",
    bal.refundable === 2000n && bal.excess === 5000n,
    j(bal),
  );
  const settled = await invRow(small.id);
  ok(
    "3C: …the invoice is paid and holds exactly what was applied",
    settled.status === "paid" &&
      settled.amountDueMinor === 0n &&
      settled.refundableCreditsAppliedMinor === 3000n,
    `${settled.status} due=${settled.amountDueMinor} ref=${settled.refundableCreditsAppliedMinor}`,
  );

  // Never over-draw a bucket: 2000 refundable is left, so 2500 must be refused outright
  // rather than silently applying 2000.
  const { invoice: next } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: f.biz.id,
    customerId: f.customer.id,
    currency: "USD",
    lines: [{ description: "next", amountMinor: 9000n }],
  });
  let refused = "";
  try {
    await applyCreditsToInvoice({
      organizationId: orgId,
      businessId: f.biz.id,
      invoicePublicId: next.publicId,
      refundableMinor: 2500,
    });
  } catch (e) {
    refused = (e as Error).message;
  }
  ok(
    "3D: never over-draws a bucket — an explicit 2500 against 2000 available is REFUSED",
    refused.includes("2000") && refused.includes("refundable"),
    refused || "no error thrown",
  );
  const untouched = await invRow(next.id);
  ok(
    "3E: …and the refusal changed nothing (no partial application)",
    untouched.amountDueMinor === 9000n && untouched.refundableCreditsAppliedMinor === 0n,
    `due=${untouched.amountDueMinor} ref=${untouched.refundableCreditsAppliedMinor}`,
  );

  // Promotional credit is not reachable. Grant 4000 of it and prove an apply-max leaves
  // it alone (it is pre-tax and would change the invoice's tax base).
  await addPromotionalCredits({
    organizationId: orgId,
    businessId: f.biz.id,
    customer: f.customer,
    amountMinor: 4000,
    currency: "USD",
  });
  const b = await applyCreditsToInvoice({
    organizationId: orgId,
    businessId: f.biz.id,
    invoicePublicId: next.publicId,
  });
  const promo = (await bucketBalancesForCurrency(orgId, f.customer.id, "USD")).promotional;
  ok(
    "3F: promotional credit is untouched — only refundable + excess move",
    b.appliedRefundableMinor === 2000n && b.appliedExcessMinor === 5000n && promo === 4000n,
    `ref=${b.appliedRefundableMinor} exc=${b.appliedExcessMinor} promo_left=${promo}`,
  );
  const partial = await invRow(next.id);
  ok(
    "3G: a partial application leaves the invoice OPEN with the balance reduced",
    partial.status !== "paid" && partial.amountDueMinor === 2000n,
    `${partial.status} due=${partial.amountDueMinor}`,
  );
}

// Currency: buckets are per (customer, currency), and an invoice must only see its own.
{
  const f = await fixture("currency", "EUR");
  await updateBusiness(orgId, f.biz.publicId, { creditsFlexibility: NO_AUTO_APPLY });
  // 6000 of USD credit on the SAME customer, whose invoice below is in EUR.
  await recordExcessPayment({
    organizationId: orgId,
    businessId: f.biz.id,
    customer: f.customer,
    amountMinor: 6000,
    currency: "USD",
  });
  const { invoice } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: f.biz.id,
    customerId: f.customer.id,
    currency: "EUR",
    lines: [{ description: "eur", amountMinor: 20000n }],
  });
  const a = await applyCreditsToInvoice({
    organizationId: orgId,
    businessId: f.biz.id,
    invoicePublicId: invoice.publicId,
  });
  const usd = await bucketBalancesForCurrency(orgId, f.customer.id, "USD");
  ok(
    "3H: only the invoice's own currency is drawn — 10000 EUR applied, the 6000 USD stands",
    a.appliedRefundableMinor + a.appliedExcessMinor === 10000n && usd.excess === 6000n,
    `applied=${a.appliedRefundableMinor + a.appliedExcessMinor} usd_excess=${usd.excess}`,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// §4  REFUSALS — request shapes that must fail loudly rather than half-execute
// ══════════════════════════════════════════════════════════════════════════════
{
  const f = await fixture("refusals");
  await updateBusiness(orgId, f.biz.publicId, { creditsFlexibility: NO_AUTO_APPLY });
  const mk = async (amountMinor: bigint) =>
    (
      await createInvoiceFromLines({
        organizationId: orgId,
        businessId: f.biz.id,
        customerId: f.customer.id,
        currency: "USD",
        lines: [{ description: "r", amountMinor }],
      })
    ).invoice;
  const message = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };

  const open = await mk(1000n);
  ok(
    "4A: refuses amount_minor together with a per-bucket amount",
    (
      await message(() =>
        applyCreditsToInvoice({
          organizationId: orgId,
          businessId: f.biz.id,
          invoicePublicId: open.publicId,
          amountMinor: 500,
          refundableMinor: 500,
        }),
      )
    ).includes("not both"),
  );
  ok(
    "4B: refuses an explicit request larger than the invoice's outstanding balance",
    (
      await message(() =>
        applyCreditsToInvoice({
          organizationId: orgId,
          businessId: f.biz.id,
          invoicePublicId: open.publicId,
          refundableMinor: 4000,
        }),
      )
    ).includes("exceeds the invoice's outstanding balance"),
  );
  ok(
    "4C: refuses an all-zero explicit request",
    (
      await message(() =>
        applyCreditsToInvoice({
          organizationId: orgId,
          businessId: f.biz.id,
          invoicePublicId: open.publicId,
          refundableMinor: 0,
          excessMinor: 0,
        }),
      )
    ).includes("The request asks for no credit."),
  );

  // A settled invoice has nothing to absorb.
  await applyCreditsToInvoice({
    organizationId: orgId,
    businessId: f.biz.id,
    invoicePublicId: open.publicId,
  });
  ok(
    "4D: refuses a PAID invoice",
    (
      await message(() =>
        applyCreditsToInvoice({
          organizationId: orgId,
          businessId: f.biz.id,
          invoicePublicId: open.publicId,
        }),
      )
    ).includes("You cannot apply credits to a paid invoice"),
  );

  const voided = await mk(1000n);
  await voidInvoice(orgId, f.biz.id, voided.publicId);
  ok(
    "4E: refuses a VOIDED invoice",
    (
      await message(() =>
        applyCreditsToInvoice({
          organizationId: orgId,
          businessId: f.biz.id,
          invoicePublicId: voided.publicId,
        }),
      )
    ).includes("You cannot apply credits to a voided invoice"),
  );

  // A customer with no credit at all in this currency.
  const barren = await createCustomer({
    organizationId: orgId,
    businessId: f.biz.id,
    email: "barren@apply.test",
  });
  const { invoice: dry } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: f.biz.id,
    customerId: barren.id,
    currency: "USD",
    lines: [{ description: "dry", amountMinor: 1000n }],
  });
  ok(
    "4F: refuses when the customer has no refundable or excess credit",
    (
      await message(() =>
        applyCreditsToInvoice({
          organizationId: orgId,
          businessId: f.biz.id,
          invoicePublicId: dry.publicId,
        }),
      )
    ).includes("This customer has no refundable or excess credit in"),
  );
  ok(
    "4G: refuses an unknown invoice",
    (
      await message(() =>
        applyCreditsToInvoice({
          organizationId: orgId,
          businessId: f.biz.id,
          invoicePublicId: "in_does_not_exist",
        }),
      )
    ).includes("We could not find the invoice"),
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// §5  LEDGER + PROVENANCE
// ══════════════════════════════════════════════════════════════════════════════
{
  const f = await fixture("ledger");
  await updateBusiness(orgId, f.biz.publicId, { creditsFlexibility: NO_AUTO_APPLY });
  const { invoice } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: f.biz.id,
    customerId: f.customer.id,
    currency: "USD",
    lines: [{ description: "L", amountMinor: 8000n }],
  });
  const arBefore = await acctBal(f.biz.id, "accounts_receivable");
  const refBefore = await acctBal(f.biz.id, "refundable_credit_balance");
  await applyCreditsToInvoice({
    organizationId: orgId,
    businessId: f.biz.id,
    invoicePublicId: invoice.publicId,
  });
  const arAfter = await acctBal(f.biz.id, "accounts_receivable");
  ok(
    "5A: AR is credited by exactly the 8000 applied",
    arBefore - arAfter === 8000n,
    `ar ${arBefore} → ${arAfter}`,
  );
  ok(
    "5B: the refundable bucket liability is debited by its 5000 share",
    (await acctBal(f.biz.id, "refundable_credit_balance")) - refBefore === 5000n,
  );
  ok("5C: the books still net to zero in every currency", await ledgerNetsZero(f.biz.id));
  const [cn] = await withTenant(orgId, (tx) =>
    tx.select().from(creditNotes).where(eq(creditNotes.customerId, f.customer.id)),
  );
  ok(
    "5D: the refundable draw is attributed to the funding credit note (FIFO provenance)",
    cn?.allocatedMinor === 5000n && cn?.status === "refunded",
    `allocated=${cn?.allocatedMinor} status=${cn?.status}`,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// §6  STATUS + EVENTS — settled by CREDIT is not a recovered collection
// ══════════════════════════════════════════════════════════════════════════════
{
  const f = await fixture("status");
  await updateBusiness(orgId, f.biz.publicId, { creditsFlexibility: NO_AUTO_APPLY });
  const { invoice } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: f.biz.id,
    customerId: f.customer.id,
    currency: "USD",
    lines: [{ description: "S", amountMinor: 9000n }],
  });
  // Put it in a chase, the way a failed collection would, so the settle has a
  // dunning_status to answer for.
  await withTenant(orgId, (tx) =>
    tx
      .update(invoices)
      .set({ status: "payment_due", dunningStatus: "in_progress", attemptCount: 2 })
      .where(eq(invoices.id, invoice.id)),
  );
  const since = new Date(Date.now() - 1);
  const cashBefore = await acctBal(f.biz.id, "cash");
  await applyCreditsToInvoice({
    organizationId: orgId,
    businessId: f.biz.id,
    invoicePublicId: invoice.publicId,
  });
  const after = await invRow(invoice.id);
  ok(
    "6A: settled by credit → paid, next_attempt cleared, paid_at stamped",
    after.status === "paid" && after.nextAttemptAt === null && after.paidAt !== null,
    `${after.status} next=${after.nextAttemptAt} paid_at=${after.paidAt !== null}`,
  );
  ok(
    "6B: dunning_status is 'stopped', NOT 'succeeded' — the chase ended, it did not succeed",
    after.dunningStatus === "stopped",
    `dunning_status=${after.dunningStatus}`,
  );
  ok(
    "6C: no cash moved — the ledger's cash account is exactly where it was",
    (await acctBal(f.biz.id, "cash")) === cashBefore,
    `cash ${cashBefore} → ${await acctBal(f.biz.id, "cash")}`,
  );
  const types = await eventTypes(f.biz.id, since);
  ok(
    "6D: emits invoice_paid exactly once",
    types.filter((t) => t === "invoice_paid").length === 1,
    types.join(","),
  );
  ok(
    "6E: emits invoice_updated exactly once (once for the application, not once per bucket)",
    types.filter((t) => t === "invoice_updated").length === 1,
    types.join(","),
  );
  ok(
    "6F: emits customer_updated exactly once",
    types.filter((t) => t === "customer_updated").length === 1,
    types.join(","),
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// §7  HTTP — auth, tenancy, idempotency
// ══════════════════════════════════════════════════════════════════════════════
{
  const f = await fixture("http");
  await updateBusiness(orgId, f.biz.publicId, { creditsFlexibility: NO_AUTO_APPLY });
  const { invoice } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: f.biz.id,
    customerId: f.customer.id,
    currency: "USD",
    lines: [{ description: "H", amountMinor: 9000n }],
  });
  const url = `/v1/businesses/${f.biz.publicId}/invoices/${invoice.publicId}/apply_credits`;
  // `Idempotency-Key` is REQUIRED on every write (platform/idempotency.ts), so a fresh one
  // per call unless a case is deliberately testing the replay. Without this every
  // assertion below would pass or fail on `idempotency_required` instead of on the thing
  // it names — which is exactly how 7B and 7C first went green for the wrong reason.
  let keyN = 0;
  const post = (payload: unknown, headers: Record<string, string> = {}, path = url) =>
    app.inject({
      method: "POST",
      url: path,
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        "idempotency-key": `apply-http-${keyN++}`,
        ...headers,
      },
      payload: JSON.stringify(payload),
    });

  const anon = await app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", "idempotency-key": "anon" },
    payload: "{}",
  });
  ok("7A: unauthenticated is refused", anon.statusCode === 401, `${anon.statusCode}`);

  const keyless = await app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    payload: "{}",
  });
  ok(
    "7A2: a write with no Idempotency-Key is refused as idempotency_required",
    keyless.statusCode === 400 &&
      (JSON.parse(keyless.payload) as { error?: { type?: string } }).error?.type ===
        "idempotency_required",
    `${keyless.statusCode} ${keyless.payload.slice(0, 80)}`,
  );

  const missing = await post(
    {},
    {},
    `/v1/businesses/${f.biz.publicId}/invoices/in_nope/apply_credits`,
  );
  ok(
    "7B: an unknown invoice is a 404, not a 400",
    missing.statusCode === 404,
    `${missing.statusCode}`,
  );

  const strict = await post({ promotional_minor: 1000 });
  ok(
    "7C: an unknown body field is REFUSED, not silently stripped (promotional_minor)",
    strict.statusCode === 400 &&
      (JSON.parse(strict.payload) as { error?: { type?: string } }).error?.type !==
        "idempotency_required",
    `${strict.statusCode} ${strict.payload.slice(0, 120)}`,
  );

  const KEY = "apply-credits-once";
  const r1 = await post({ amount_minor: 4000 }, { "idempotency-key": KEY });
  const b1 = JSON.parse(r1.payload) as { applied: { total_minor: number } };
  ok(
    "7D: the first call applies 4000 and reports it",
    r1.statusCode === 200 && b1.applied.total_minor === 4000,
    `${r1.statusCode} ${j(b1.applied)}`,
  );
  const r2 = await post({ amount_minor: 4000 }, { "idempotency-key": KEY });
  ok(
    "7E: the SAME Idempotency-Key replays instead of applying twice",
    r2.statusCode === 200 && r2.headers["idempotent-replayed"] === "true",
    `${r2.statusCode} replayed=${r2.headers["idempotent-replayed"]}`,
  );
  const row = await invRow(invoice.id);
  ok(
    "7F: …so the invoice took the credit exactly ONCE (5000 still due of 9000)",
    row.amountDueMinor === 5000n,
    `due=${row.amountDueMinor}`,
  );
  const bal = await bucketBalancesForCurrency(orgId, f.customer.id, "USD");
  ok(
    "7G: …and the buckets moved exactly once (10000 − 4000 = 6000 left)",
    bal.refundable + bal.excess === 6000n,
    j(bal),
  );

  // Cross-tenant: another org's key must not reach this invoice.
  const other = await createOrganization({ name: "Apply Credits Other Org" });
  const otherKey = (await createApiKey(other.organization.id, "test")).secret;
  const cross = await app.inject({
    method: "POST",
    url,
    headers: {
      authorization: `Bearer ${otherKey}`,
      "content-type": "application/json",
      "idempotency-key": "apply-cross-tenant",
    },
    payload: "{}",
  });
  ok(
    "7H: another organization's API key cannot reach this invoice",
    cross.statusCode === 404 || cross.statusCode === 403,
    `${cross.statusCode}`,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// §8  THE SIBLING PATH — collect_payment settling by credit alone says the same thing
// ══════════════════════════════════════════════════════════════════════════════
//
// Not about this endpoint, but found by building it and fixed in the same change:
// `collectPayment`'s credit-only settle stamped `dunning_status: 'succeeded'`, reporting a
// recovered collection on an invoice where the card was never charged. `status.ts`
// documents that exact defect against ten live invoices. The two routes that settle an
// invoice with credit must not answer this differently, so it is asserted here — next to
// 6B, which is the same property for the explicit action.
{
  const f = await fixture("sibling"); // no creditsFlexibility: auto-apply, as before
  const { invoice } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: f.biz.id,
    customerId: f.customer.id,
    currency: "USD",
    lines: [{ description: "sib", amountMinor: 9000n }],
    applyCredit: false,
  });
  await withTenant(orgId, (tx) =>
    tx
      .update(invoices)
      .set({ status: "payment_due", dunningStatus: "in_progress", attemptCount: 2 })
      .where(eq(invoices.id, invoice.id)),
  );
  const res = await collectPayment({
    organizationId: orgId,
    businessId: f.biz.id,
    customerPublicId: f.customer.publicId,
    invoiceIds: [invoice.publicId],
  });
  const after = await invRow(invoice.id);
  ok(
    "8A: collect_payment settles the 9000 with 5000 refundable + 4000 excess",
    res?.applied.refundable === 5000 && res?.applied.excess === 4000 && after.status === "paid",
    `${j(res?.applied)} status=${after.status}`,
  );
  ok(
    "8B: …and reports dunning_status 'stopped', not a collection that never happened",
    after.dunningStatus === "stopped",
    `dunning_status=${after.dunningStatus}`,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// §9  VOIDING RELEASES THE ALLOCATION (#57) — the ledger and the note must move together
// ══════════════════════════════════════════════════════════════════════════════
//
// Found 2026-09-04 on a live reactivation that failed at the gateway. `voidInvoice`
// posted a FLAWLESS compensating ledger entry (`invoice_void` mirroring
// `credit_applied`, so the bucket got its money back) and left every denormalised
// satellite behind: the `credit_note_allocations` row still pointed at the now-voided
// invoice, `allocated_minor` still read the full draw, and the note's status had been
// flipped `refund_due` → `refunded` with `refunded_minor` and `paid_out_minor` both 0.
//
// That is not a cosmetic staleness. `creditNoteAvailable` is `total − allocated −
// refunded`, so it read 0 while the LEDGER (the line immediately after it in both refund
// paths) said the money was spendable — and BOTH refund paths gate on the stale figure
// first, so the customer's own money could not be paid back to them. The measured
// second-order failure was worse: `allocateRefundableDraw` skips a note whose `avail <= 0`,
// so the next invoice applied ₹9,661.13 of credit from the ledger while creating NO
// allocation row — the note→invoice funding record, not merely a counter, went wrong.
//
// 9G is the assertion that matters most: the note's own availability must equal the
// LEDGER's refundable balance. Every other check here can be satisfied by arithmetic
// (`total = allocated + refunded + available` HELD throughout the live defect:
// 966113 = 966113 + 0 + 0); only comparing the satellite against the ledger catches a
// divergence, which is exactly the class this defect belongs to.
{
  const f = await fixture("void-release");
  const [cnBefore] = await withTenant(orgId, (tx) =>
    tx.select().from(creditNotes).where(eq(creditNotes.customerId, f.customer.id)),
  );
  // 20000 against 10000 of credit: auto-application draws the note's 5000 refundable and
  // the 5000 excess, and the invoice stays OPEN owing 10000 — which is what makes it
  // voidable at all. A fully-credited invoice goes `paid` and `voidInvoice` refuses it.
  const { invoice } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: f.biz.id,
    customerId: f.customer.id,
    currency: "USD",
    lines: [{ description: "V", amountMinor: 20000n }],
    // Auto-application is OFF by default on this path (`applyCredit` is optional and
    // falsy) — without this the whole section passed vacuously against no credit at all.
    applyCredit: true,
  });
  const allocRows = (id: string) =>
    withTenant(orgId, (tx) =>
      tx.select().from(creditNoteAllocations).where(eq(creditNoteAllocations.invoiceId, id)),
    );
  const cnRow = () =>
    withTenant(
      orgId,
      async (tx) =>
        (await tx.select().from(creditNotes).where(eq(creditNotes.id, cnBefore!.id)).limit(1))[0]!,
    );
  const applied = await cnRow();
  ok(
    "9-pre: the draw was allocated to the funding note (the state this defect starts from)",
    applied.allocatedMinor === 5000n &&
      applied.status === "refunded" &&
      (await allocRows(invoice.id)).length === 1,
    `allocated=${applied.allocatedMinor} status=${applied.status} rows=${(await allocRows(invoice.id)).length}`,
  );
  // Put it in a chase, the way a failed collection would, so the void has a
  // `dunning_status` to answer for (41 voided invoices on the box that found this defect
  // still read `in_progress`).
  await withTenant(orgId, (tx) =>
    tx
      .update(invoices)
      .set({ status: "payment_due", dunningStatus: "in_progress", attemptCount: 2 })
      .where(eq(invoices.id, invoice.id)),
  );
  await voidInvoice(orgId, f.biz.id, invoice.publicId);
  const released = await cnRow();
  ok(
    "9A: no allocation row points at the voided invoice",
    (await allocRows(invoice.id)).length === 0,
    `rows=${j((await allocRows(invoice.id)).map((r) => r.amountMinor))}`,
  );
  ok(
    "9B: allocated_minor is decremented by exactly what was released",
    released.allocatedMinor === 0n,
    `allocated=${released.allocatedMinor}`,
  );
  ok(
    "9C: the note is refundable again — available back to its full 5000",
    creditNoteAvailable(released) === 5000n,
    `available=${creditNoteAvailable(released)}`,
  );
  ok(
    "9D: status is restored to 'refund_due' — nothing was ever refunded",
    released.status === "refund_due" &&
      released.refundedMinor === 0n &&
      released.paidOutMinor === 0n,
    `status=${released.status} refunded=${released.refundedMinor} paid_out=${released.paidOutMinor}`,
  );
  const voidedInv = await invRow(invoice.id);
  ok(
    "9E: the voided invoice is out of the chase — dunning_status is no longer 'in_progress'",
    voidedInv.dunningStatus === "stopped" && voidedInv.nextAttemptAt === null,
    `status=${voidedInv.status} dunning_status=${voidedInv.dunningStatus}`,
  );
  // The ops invariant `credit_note_allocations_reconcile` (critical), asserted here
  // rather than trusted: the cached column every screen reads must equal the signed sum
  // of the rows that justify it.
  const reconcile = await withTenant(orgId, async (tx: Tx) => {
    const res = await tx.execute(sql`
      select (cn.allocated_minor - coalesce(sum(a.amount_minor), 0))::text as delta
      from credit_notes cn
      left join credit_note_allocations a on a.credit_note_id = cn.id
      where cn.id = ${cnBefore!.id}
      group by cn.id, cn.allocated_minor`);
    return (res as unknown as Array<{ delta: string }>)[0]?.delta ?? "missing";
  });
  ok(
    "9F: allocated_minor still equals Σ its allocation rows (the ops critical invariant)",
    reconcile === "0",
    `delta=${reconcile}`,
  );
  const bal = await bucketBalancesForCurrency(orgId, f.customer.id, "USD");
  ok(
    "9G: the note's available equals the LEDGER's refundable balance — no divergence",
    bal.refundable === creditNoteAvailable(released),
    `ledger=${bal.refundable} note=${creditNoteAvailable(released)}`,
  );
  // The point of the fix: the customer's money can actually be paid back. A full refund
  // computes `requested = available`, so the stale 0 killed it twice over — "Refund
  // amount must be positive" for the full request, "exceeds available 0" for an explicit one.
  let refundErr: string | null = null;
  const refunded = await recordOfflineCnRefund({
    organizationId: orgId,
    businessId: f.biz.id,
    creditNotePublicId: cnBefore!.publicId,
    method: "bank_transfer",
    reference: "VOID-RELEASE-57",
  }).catch((e: unknown) => {
    refundErr = (e as Error)?.message ?? String(e);
    return null;
  });
  ok(
    "9H: a FULL refund of the released credit now succeeds",
    refunded?.refundedMinor === 5000n && refunded?.paidOutMinor === 5000n,
    refundErr ?? `refunded=${refunded?.refundedMinor} paid_out=${refunded?.paidOutMinor}`,
  );
  ok(
    "9I: …and the ledger agrees the bucket is now empty",
    (await bucketBalancesForCurrency(orgId, f.customer.id, "USD")).refundable === 0n,
    j(await bucketBalancesForCurrency(orgId, f.customer.id, "USD")),
  );
  ok("9J: the books still net to zero in every currency", await ledgerNetsZero(f.biz.id));
}

// The MEASURED second-order failure (PROGRESS #57, attempt 2 on the live box): credit
// APPLICATION reads the ledger, ALLOCATION reads the note, so a note left at `avail <= 0`
// was skipped by the loop while its money was still spent — an invoice funded by ₹9,661.13
// of credit with nothing linking it to the note that funded it. Releasing the allocation is
// what makes the two agree again, and this is the check that says so.
{
  const f = await fixture("void-reapply");
  const [cn] = await withTenant(orgId, (tx) =>
    tx.select().from(creditNotes).where(eq(creditNotes.customerId, f.customer.id)),
  );
  const mkOpen = async (label: string) => {
    const { invoice } = await createInvoiceFromLines({
      organizationId: orgId,
      businessId: f.biz.id,
      customerId: f.customer.id,
      currency: "USD",
      lines: [{ description: label, amountMinor: 20000n }],
      applyCredit: true,
    });
    return invoice;
  };
  const first = await mkOpen("attempt-1");
  await voidInvoice(orgId, f.biz.id, first.publicId);
  const second = await mkOpen("attempt-2");
  const rows = await withTenant(orgId, (tx) =>
    tx.select().from(creditNoteAllocations).where(eq(creditNoteAllocations.invoiceId, second.id)),
  );
  const after = await invRow(second.id);
  const [cnAfter] = await withTenant(orgId, (tx) =>
    tx.select().from(creditNotes).where(eq(creditNotes.id, cn!.id)),
  );
  ok(
    "9K: a SECOND attempt after the void applies the credit AND records the allocation",
    rows.length === 1 &&
      rows[0]!.amountMinor === 5000n &&
      after.amountDueMinor === 10000n &&
      cnAfter!.allocatedMinor === 5000n,
    `rows=${j(rows.map((r) => r.amountMinor))} due=${after.amountDueMinor} allocated=${cnAfter!.allocatedMinor}`,
  );
}

// The other half of the dunning rule, and the reason the void does NOT reuse
// `dunningFieldsOnCreditSettle`: dunning's own final action voids from `not_paid` +
// `exhausted`, which is already terminal and already TRUE — we walked the whole retry
// ladder and got nothing. 203 invoices on the box that found #57 are exactly that shape
// (168 with a real failed attempt behind them). Rewriting them to `stopped` would erase
// the distinction on the commonest void path there is, so only a LIVE chase
// (`in_progress` / `parked`) is ended by a void.
{
  const f = await fixture("void-exhausted");
  const { invoice } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: f.biz.id,
    customerId: f.customer.id,
    currency: "USD",
    lines: [{ description: "X", amountMinor: 20000n }],
  });
  await withTenant(orgId, (tx) =>
    tx
      .update(invoices)
      .set({ status: "not_paid", dunningStatus: "exhausted", attemptCount: 3 })
      .where(eq(invoices.id, invoice.id)),
  );
  await voidInvoice(orgId, f.biz.id, invoice.publicId);
  const after = await invRow(invoice.id);
  ok(
    "9L: voiding an EXHAUSTED invoice keeps 'exhausted' — a finished chase is not restated",
    after.status === "voided" && after.dunningStatus === "exhausted",
    `status=${after.status} dunning_status=${after.dunningStatus}`,
  );
}

// The scope line: an ADJUSTMENT note's allocation is NOT released. It self-allocates to
// the invoice it reduces and books `credit_adjustments`/`bad_debt` → AR, a posting
// `voidInvoice` deliberately does not mirror (it reverses `invoice`, `import` and
// `credit_applied` only). That credit was therefore never handed back, and "freeing" it
// would advertise availability on a note whose money sits in no bucket at all — the same
// false claim of spendable money as the defect, pointing the other way. The rule is the
// fix's own principle: the satellite moves only where the ledger moved. 41 of the 42 live
// allocation rows pointing at a voided invoice on the box that found #57 are exactly this
// shape, so widening the release would have touched all of them.
{
  const f = await fixture("void-adjustment");
  const { invoice } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: f.biz.id,
    customerId: f.customer.id,
    currency: "USD",
    lines: [{ description: "A", amountMinor: 20000n }],
  });
  const adj = await issueAdjustmentCreditNote({
    organizationId: orgId,
    businessId: f.biz.id,
    invoicePublicId: invoice.publicId,
    items: [{ description: "partial adjustment", amountMinor: 5000 }],
  });
  await voidInvoice(orgId, f.biz.id, invoice.publicId);
  const rows = await withTenant(orgId, (tx) =>
    tx.select().from(creditNoteAllocations).where(eq(creditNoteAllocations.invoiceId, invoice.id)),
  );
  const [after] = await withTenant(orgId, (tx) =>
    tx.select().from(creditNotes).where(eq(creditNotes.id, adj.id)),
  );
  ok(
    "9M: an ADJUSTMENT note's allocation survives the void — its credit was never given back",
    rows.length === 1 &&
      rows[0]!.amountMinor === 5000n &&
      after!.allocatedMinor === 5000n &&
      after!.status === "adjusted" &&
      creditNoteAvailable(after!) === 0n,
    `rows=${j(rows.map((r) => r.amountMinor))} allocated=${after!.allocatedMinor} status=${after!.status} available=${creditNoteAvailable(after!)}`,
  );
}

await app.close();
let failed = 0;
for (const [name, pass, detail] of checks) {
  if (pass) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
console.log(
  failed === 0
    ? `\n✅ APPLY-CREDITS: PASS (${checks.length} checks)`
    : `\n❌ APPLY-CREDITS: FAIL — ${failed} of ${checks.length}`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);

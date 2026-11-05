/**
 * Credit units and grants against real invoices (design G3 §9, steps 2–3): drawdown at
 * renewal, the ledger postings of §4 to the minor unit, each credit_grants_* account closing
 * to 0, expiry, void, invoice-void restore (same grant / a new first-drawn grant), the
 * credit-note cap on a pack line, the unit lock, and preview = booking.
 *
 * The pack sale and its activation are simulated with the postings §4 Ex 1 states, so
 * this suite does not depend on the purchase path.
 *
 *   pnpm verify:all:fresh -- --suite credit-grants
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { recordUsage } from "@/modules/metering/service";
import { runBillingClockTick } from "@/modules/subscriptions/renewal";
import { estimateChange, estimateRenewal } from "@/modules/subscriptions/estimate";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { createManualInvoice, voidInvoice } from "@/modules/invoicing/ops";
import {
  issueAdjustmentCreditNote,
  getCreditNoteDetail,
  issueRefundableCreditNote,
  refundInvoiceViaCreditNote,
} from "@/modules/credit-notes/service";
import { serializeCreditNote } from "@/modules/credit-notes/serialize";
import { assembleCreditNoteDocument } from "@/modules/credit-notes/document";
import { refundPayment } from "@/modules/refunds/service";
import { postEntries } from "@/modules/ledger/service";
import { addPromotionalCredits } from "@/modules/customers/balances";
import {
  bookGrantRemainder,
  createCreditUnit,
  createPromotionalGrant,
  CreditConflictError,
  grantRemaining,
  insertCreditGrant,
  loadPlannerGrants,
  restoreGrantDraws,
  updateCreditUnit,
  voidCreditGrant,
  type CreditGrant,
} from "@/modules/credits/service";
import { planGrantApplication } from "@/modules/credits/planner";
import { E12 } from "@/modules/credits/units";
import {
  CREDIT_LEDGER_ACCOUNTS as A,
  creditGrantMovements,
  creditGrants,
  creditNoteDiscounts,
  creditNotes,
  creditUnits,
  invoiceLineItems,
  invoices,
  ledgerEntries,
  payments,
  subscriptions,
} from "@db/schema";
import { loadGeoReference } from "@/platform/geo";

await loadGeoReference();
const checks: Array<[string, boolean, string?]> = [];
const check = (label: string, ok: boolean, detail?: unknown) =>
  checks.push([
    label,
    ok,
    ok ? undefined : JSON.stringify(detail, (_, v) => (typeof v === "bigint" ? `${v}n` : v)),
  ]);

const org = await createOrganization({ name: "Credit Grants Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Grants",
  defaultCurrency: "USD",
  livemode: "test",
});
const bizId = biz.id;
const product = await createProduct({ organizationId: orgId, businessId: bizId, name: "API" });
const flat = await createPrice({
  organizationId: orgId,
  businessId: bizId,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});
// $0.05 per call, summed, billed in arrears.
const metered = await createPrice({
  organizationId: orgId,
  businessId: bizId,
  productId: product.id,
  type: "recurring",
  model: "usage",
  currency: "USD",
  amountMinor: 5,
  interval: "month",
  usageAggregation: "sum",
});

const T = Date.now();
const H = 3600_000;
const longAgo = new Date(T - 3 * H);

/** Σ (debit − credit) per account for one customer. */
async function accounts(customerId: string): Promise<Record<string, bigint>> {
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({
        account: ledgerEntries.account,
        net: sql<string>`sum(case when ${ledgerEntries.direction} = 'debit' then ${ledgerEntries.amountMinor} else -${ledgerEntries.amountMinor} end)`,
      })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.customerId, customerId))
      .groupBy(ledgerEntries.account),
  );
  return Object.fromEntries(rows.map((r) => [r.account, BigInt(r.net)]));
}
const credit = (a: Record<string, bigint>, k: string) => -(a[k] ?? 0n);
const left = async (g: CreditGrant) =>
  (await withTenant(orgId, (tx) => grantRemaining(tx, [g.id]))).get(g.id)!;

/** A subscription whose closed past period carries `calls` usage, ready to renew. */
async function meteredCustomer(email: string, calls: number, card: boolean) {
  // No card: collection off, so the renewal raises an open invoice instead of cancelling.
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email,
    ...(card ? {} : { autoCollection: "off" as const }),
  });
  if (card)
    await vaultPaymentMethod({
      organizationId: orgId,
      businessId: bizId,
      customer,
      token: "tok_4242",
    });
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: bizId,
    customerId: customer.id,
    now: new Date(),
    items: [
      { price: flat, quantity: 1 },
      { price: metered, quantity: 1 },
    ],
  });
  await systemDb
    .update(subscriptions)
    .set({ currentPeriodStart: new Date(T - 2 * H), currentPeriodEnd: new Date(T - H) })
    .where(eq(subscriptions.id, sub.subscription.id));
  const item = sub.items.find((i) => i.priceId === metered.id)!;
  await recordUsage({
    organizationId: orgId,
    businessId: bizId,
    subscriptionItemId: item.id,
    quantity: calls,
    timestamp: new Date(T - 90 * 60_000),
  });
  return { customer, sub: sub.subscription, items: sub.items };
}
async function renew(subscriptionId: string) {
  await runWithClockScope({ onlyBusinessId: bizId }, () => runBillingClockTick(new Date()));
  return withTenant(orgId, async (tx) => {
    const [i] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.subscriptionId, subscriptionId))
      .orderBy(desc(invoices.createdAt))
      .limit(1);
    return i!;
  });
}
/** §4 Ex 1 pack sale + activation, as the purchase path books them. */
async function simulatePaidGrant(input: {
  customerId: string;
  unit: typeof creditUnits.$inferSelect | null;
  amount: bigint;
  cost: bigint;
  expiresAt?: Date | null;
  applicability?: { kind: "prices"; prices: string[] };
}) {
  const { invoice } = await createManualInvoice({
    organizationId: orgId,
    businessId: bizId,
    customerId: input.customerId,
    currency: "USD",
    lines: [{ description: "Credit pack", amountMinor: input.cost, kind: "one_time" }],
  });
  const [line] = await withTenant(orgId, (tx) =>
    tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoice.id)),
  );
  const g = await withTenant(orgId, async (tx) => {
    const grant = await insertCreditGrant(tx, {
      organizationId: orgId,
      businessId: bizId,
      customerId: input.customerId,
      currency: "USD",
      unit: input.unit,
      amount: input.amount,
      costBasisMinor: input.cost,
      category: "paid",
      taxTreatment: "taxed_at_purchase",
      source: "purchase",
      sourceRef: line!.id,
      invoiceId: invoice.id,
      effectiveAt: longAgo,
      expiresAt: input.expiresAt ?? null,
      applicability: input.applicability,
    });
    for (const [dr, cr] of [
      ["revenue", A.pending],
      [A.pending, A.paid],
    ] as const)
      await postEntries(
        {
          organizationId: orgId,
          businessId: bizId,
          customerId: input.customerId,
          sourceType: "invoice",
          sourceId: invoice.publicId,
          lines: [
            { account: dr, direction: "debit", amountMinor: input.cost, currency: "USD" },
            { account: cr, direction: "credit", amountMinor: input.cost, currency: "USD" },
          ],
        },
        tx,
      );
    return grant;
  });
  return { grant: g, invoice, line: line! };
}

// ── §1 Units: rate, Ex 3 grant posting, lock ─────────────────────────────────
await createCreditUnit({
  organizationId: orgId,
  businessId: bizId,
  key: "credit",
  unit: { name: "credit", currency: "USD", minorPerUnitE12: E12 },
});
const token = await createCreditUnit({
  organizationId: orgId,
  businessId: bizId,
  key: "token",
  unit: { name: "token", currency: "USD", minorPerUnitE12: 100n * E12 },
});

// ── §2 Renewal draws grants in order; Ex 1 / Ex 3 postings; accounts close ───
{
  const { customer, sub } = await meteredCustomer("g1@example.com", 300, true); // usage 1,500
  const P = await createPromotionalGrant({
    organizationId: orgId,
    businessId: bizId,
    customerPublicId: customer.publicId,
    unitKey: "credit",
    amount: 300n,
    effectiveAt: longAgo,
  });
  const a0 = await accounts(customer.id);
  check(
    "Ex 3: promotional grant books Dr promotional_credit / Cr credit_grants_promotional 300",
    a0.promotional_credit === 300n && credit(a0, A.promotional) === 300n,
    a0,
  );
  const { grant: Q } = await simulatePaidGrant({
    customerId: customer.id,
    unit: null,
    amount: 1000n,
    cost: 800n,
    expiresAt: new Date(T + 365 * 24 * H),
  });

  let refused = false;
  try {
    await updateCreditUnit({
      organizationId: orgId,
      businessId: bizId,
      key: "credit",
      patch: { minorPerUnitE12: 2n * E12 },
    });
  } catch (e) {
    refused = e instanceof CreditConflictError;
  }
  const renamed = await updateCreditUnit({
    organizationId: orgId,
    businessId: bizId,
    key: "credit",
    patch: { name: "Credit" },
  });
  check(
    "a locked unit refuses a rate change and keeps its name editable",
    refused && renamed?.name === "Credit",
  );

  const preview = await estimateRenewal({
    organizationId: orgId,
    businessId: bizId,
    subscriptionId: sub.id,
    includeUsageSoFar: true,
  });
  const inv = await renew(sub.id);
  check(
    "renewal draws Q (sooner expiry) 1,000 then P 300 before tax",
    inv.grantCreditsPreTaxMinor === 1300n && inv.grantCreditsPostTaxMinor === 0n,
    inv,
  );
  check(
    "the rest is due and charged: 1,000 + 200",
    inv.amountDueMinor === 1200n && inv.status === "paid",
    inv,
  );
  check(
    "preview equals booking",
    preview?.grant_credits_pre_tax_minor === 1300 && preview?.amount_due_minor === 1200,
    preview,
  );
  const a1 = await accounts(customer.id);
  check(
    "Ex 1 draw: Dr credit_grants_paid 800 + Dr credit_grant_discount 200 / Cr AR",
    (a1[A.paid] ?? 0n) === 0n && a1[A.discount] === 200n,
    a1,
  );
  check(
    "every credit_grants_* account closes to 0",
    (a1[A.paid] ?? 0n) === 0n && (a1[A.promotional] ?? 0n) === 0n && (a1[A.pending] ?? 0n) === 0n,
    a1,
  );
  // Only the (unpaid) pack invoice is left in AR.
  check("the renewal leaves nothing in AR", a1.accounts_receivable === 800n, a1);
  const [lq, lp] = [await left(Q), await left(P)];
  check(
    "both grants close to 0 units / 0 money / 0 cost",
    lq.units === 0n && lq.face === 0n && lq.cost === 0n && lp.units === 0n && lp.face === 0n,
    { lq, lp },
  );
}

// ── §3 Expiry: paid → breakage at cost (Ex 1), promotional → expense reverses ─
{
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email: "g3@example.com",
  });
  const { grant: X } = await simulatePaidGrant({
    customerId: customer.id,
    unit: token,
    amount: 1000n,
    cost: 80000n,
  });
  const Pr = await createPromotionalGrant({
    organizationId: orgId,
    businessId: bizId,
    customerPublicId: customer.publicId,
    currency: "USD",
    amount: 500n,
  });
  await withTenant(orgId, async (tx) => {
    await bookGrantRemainder(tx, { grant: X, kind: "expire" });
    await bookGrantRemainder(tx, { grant: Pr, kind: "expire" });
  });
  const a = await accounts(customer.id);
  check(
    "paid expiry: Dr credit_grants_paid 80,000 / Cr credit_breakage 80,000",
    credit(a, A.breakage) === 80000n && (a[A.paid] ?? 0n) === 0n,
    a,
  );
  check(
    "promotional expiry: the expense reverses",
    (a.promotional_credit ?? 0n) === 0n && (a[A.promotional] ?? 0n) === 0n,
    a,
  );
  const [g] = await withTenant(orgId, (tx) =>
    tx.select().from(creditGrants).where(eq(creditGrants.id, X.id)),
  );
  check(
    "expired grant is `expired` with 0 left",
    g?.status === "expired" && (await left(X)).units === 0n,
  );

  const V = await createPromotionalGrant({
    organizationId: orgId,
    businessId: bizId,
    customerPublicId: customer.publicId,
    currency: "USD",
    amount: 700n,
  });
  const voided = await voidCreditGrant({
    organizationId: orgId,
    businessId: bizId,
    customerPublicId: customer.publicId,
    grantPublicId: V.publicId,
  });
  let paidRefused = false;
  try {
    await voidCreditGrant({
      organizationId: orgId,
      businessId: bizId,
      customerPublicId: customer.publicId,
      grantPublicId: X.publicId,
    });
  } catch (e) {
    paidRefused = e instanceof CreditConflictError;
  }
  check(
    "void books the remainder; a paid grant cannot be voided by hand",
    voided.status === "voided" && (await left(V)).face === 0n && paidRefused,
  );
}

// ── §4 Invoice void restores to the same grant, or as a new first-drawn grant ─
{
  const { customer, sub } = await meteredCustomer("g4@example.com", 300, false); // usage 1,500, no card
  const E = await createPromotionalGrant({
    organizationId: orgId,
    businessId: bizId,
    customerPublicId: customer.publicId,
    currency: "USD",
    amount: 200n,
    priority: 10,
    effectiveAt: longAgo,
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
  const L = await createPromotionalGrant({
    organizationId: orgId,
    businessId: bizId,
    customerPublicId: customer.publicId,
    currency: "USD",
    amount: 1000n,
    priority: 60,
    effectiveAt: longAgo,
  });
  const inv = await renew(sub.id);
  check(
    "void fixture: E 200 + L 1,000 drawn",
    inv.grantCreditsPreTaxMinor === 1200n && inv.status !== "paid",
    inv,
  );
  // E expires before the void (the pass would book it; here directly).
  await withTenant(orgId, async (tx) => {
    const [row] = await tx.select().from(creditGrants).where(eq(creditGrants.id, E.id));
    await bookGrantRemainder(tx, { grant: row!, kind: "expire" });
  });
  await voidInvoice(orgId, bizId, inv.publicId);
  const lL = await left(L);
  check(
    "restore returns L's units to L itself (not a new promotional grant)",
    lL.face === 1000n && lL.units === 1000n,
    lL,
  );
  const restored = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(creditGrants)
      .where(and(eq(creditGrants.customerId, customer.id), eq(creditGrants.source, "restore"))),
  );
  const R = restored[0];
  const months = R?.expiresAt ? (R.expiresAt.getTime() - Date.now()) / (30.4 * 24 * H) : 0;
  check(
    "the expired grant's part comes back as a new restore grant: same category, 200, expiring in 12 months",
    restored.length === 1 &&
      R!.category === "promotional" &&
      R!.faceMinor === 200n &&
      R!.restoredFromId === E.id &&
      months > 11.5 &&
      months < 12.5,
    R,
  );
  const grants = await withTenant(orgId, (tx) =>
    loadPlannerGrants(tx, { businessId: bizId, customerId: customer.id, currency: "USD" }),
  );
  const plan = planGrantApplication({
    phase: "pre_tax",
    grants: grants.map((g) => (g.id === R!.id ? { ...g, priority: 100 } : g)),
    lines: [{ key: "0", kind: "usage", pricePublicId: metered.publicId, valueMinor: 50n }],
  });
  check(
    "the restore grant draws first, even at priority 100",
    !!R && plan.draws[0]?.grantId === R.id,
    plan.draws,
  );
  const a = await accounts(customer.id);
  const movementSum = await withTenant(orgId, (tx) =>
    tx
      .select({ s: sql<string>`coalesce(sum(${creditGrantMovements.faceMinor}), 0)` })
      .from(creditGrantMovements)
      .innerJoin(creditGrants, eq(creditGrants.id, creditGrantMovements.grantId))
      .where(
        and(
          eq(creditGrantMovements.customerId, customer.id),
          eq(creditGrants.category, "promotional"),
        ),
      ),
  );
  check(
    "credit_grants_promotional = Σ movement money of promotional grants (1,200)",
    credit(a, A.promotional) === 1200n && BigInt(movementSum[0]!.s) === 1200n,
    { a, movementSum },
  );
}

// ── §5 Credit note on a pack line: capped at unused cost (Ex 5) ──────────────
{
  const { customer, sub } = await meteredCustomer("g5@example.com", 6000, true); // usage 30,000
  const {
    grant: K,
    invoice: packInv,
    line,
  } = await simulatePaidGrant({
    customerId: customer.id,
    unit: token,
    amount: 1000n,
    cost: 80000n,
    applicability: { kind: "prices", prices: [metered.publicId] },
  });
  const inv = await renew(sub.id);
  const lk = await left(K);
  check(
    "Ex 1: 300 tokens drawn — face 30,000, cost 24,000",
    inv.grantCreditsPreTaxMinor === 30000n && lk.units === 700n && lk.cost === 56000n,
    { inv: inv.grantCreditsPreTaxMinor, lk },
  );
  const a0 = await accounts(customer.id);
  check(
    "Ex 1 draw: Dr paid 24,000 + Dr discount 6,000",
    a0[A.discount] === 6000n && credit(a0, A.paid) === 56000n,
    a0,
  );
  let capped = "";
  try {
    await issueAdjustmentCreditNote({
      organizationId: orgId,
      businessId: bizId,
      invoicePublicId: packInv.publicId,
      items: [
        { description: "Pack refund", amountMinor: 80000, invoiceLineItemPublicId: line.publicId },
      ],
    });
  } catch (e) {
    capped = (e as Error).message;
  }
  check(
    "a credit note for the whole pack is refused: only the unused 56,000 is creditable",
    /only .*560\.00/.test(capped),
    capped,
  );
  await issueAdjustmentCreditNote({
    organizationId: orgId,
    businessId: bizId,
    invoicePublicId: packInv.publicId,
    items: [
      { description: "Pack refund", amountMinor: 56000, invoiceLineItemPublicId: line.publicId },
    ],
  }).catch((e: Error) => check("the unused-cost credit note is accepted", false, e.message));
  const a1 = await accounts(customer.id);
  const lk2 = await left(K);
  const [k2] = await withTenant(orgId, (tx) =>
    tx.select().from(creditGrants).where(eq(creditGrants.id, K.id)),
  );
  check(
    "Ex 5: the note voids 700 tokens and moves 56,000 out of deferred revenue",
    lk2.units === 0n && lk2.cost === 0n && (a1[A.paid] ?? 0n) === 0n && k2?.status === "voided",
    { lk2, a1, status: k2?.status },
  );
}

// ── §6 Refunds give grant draws back, in proportion, never more than drawn ───
{
  const { customer, sub } = await meteredCustomer("g6@example.com", 300, true); // usage 1,500
  const G = await createPromotionalGrant({
    organizationId: orgId,
    businessId: bizId,
    customerPublicId: customer.publicId,
    currency: "USD",
    amount: 1000n,
    effectiveAt: longAgo,
  });
  const { grant: Q } = await simulatePaidGrant({
    customerId: customer.id,
    unit: null,
    amount: 400n,
    cost: 300n,
  });
  const inv = await renew(sub.id);
  check(
    "refund fixture: G 1,000 + Q 400 drawn, 1,100 charged",
    inv.grantCreditsPreTaxMinor === 1400n && inv.amountDueMinor === 1100n && inv.status === "paid",
    inv,
  );
  const [pay] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(payments)
      .where(and(eq(payments.invoiceId, inv.id), eq(payments.status, "succeeded"))),
  );
  // Half the cash back → half the grant draws back: 700 = G 500 + Q 200 (cost 150).
  await refundPayment({
    organizationId: orgId,
    businessId: bizId,
    paymentPublicId: pay!.publicId,
    amountMinor: 550,
  });
  const [g1, q1] = [await left(G), await left(Q)];
  check(
    "a partial refund gives back half of each draw: G 500, Q 200 (cost 150)",
    g1.face === 500n && q1.face === 200n && q1.cost === 150n,
    { g1, q1 },
  );
  const full = await refundInvoiceViaCreditNote({
    organizationId: orgId,
    businessId: bizId,
    invoicePublicId: inv.publicId,
  });
  const [g2, q2] = [await left(G), await left(Q)];
  check(
    "the full refund gives back only the rest: G 1,000 and Q 400 / cost 300 — never more than drawn",
    g2.face === 1000n &&
      g2.units === 1000n &&
      q2.face === 400n &&
      q2.cost === 300n &&
      full.cardRefundedMinor === 550,
    { g2, q2, full },
  );
  const again = await withTenant(orgId, (tx) =>
    restoreGrantDraws(tx, {
      organizationId: orgId,
      businessId: bizId,
      customerId: customer.id,
      invoiceId: inv.id,
      invoicePublicId: inv.publicId,
      faceMinor: "all",
      ledger: true,
      sourceType: "refund",
    }),
  );
  check("a second give-back of the same invoice restores nothing", again === 0n, again);
  const a = await accounts(customer.id);
  check(
    "ledger closes: credit_grants_promotional 1,000, credit_grants_paid 300, discount 0",
    credit(a, A.promotional) === 1000n &&
      credit(a, A.paid) === 300n &&
      (a[A.discount] ?? 0n) === 0n,
    a,
  );
}

// ── §7 A change on a grant-funded invoice: preview = booking, grant and cash slices ─
const cheaper = await createPrice({
  organizationId: orgId,
  businessId: bizId,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 400,
  interval: "month",
});
async function changeCase(email: string, fund: "grant" | "promo", op: "remove" | "downgrade") {
  const { customer, sub, items } = await meteredCustomer(email, 300, true); // usage 1,500
  if (fund === "grant")
    await createPromotionalGrant({
      organizationId: orgId,
      businessId: bizId,
      customerPublicId: customer.publicId,
      currency: "USD",
      amount: 1000n,
      effectiveAt: longAgo,
    });
  else
    await addPromotionalCredits({
      organizationId: orgId,
      businessId: bizId,
      customer,
      amountMinor: 1000,
      currency: "USD",
    });
  const inv = await renew(sub.id);
  const flatItem = items.find((i) => i.priceId === flat.id)!;
  const change = {
    organizationId: orgId,
    businessId: bizId,
    subscriptionId: sub.id,
    now: new Date(),
    changes:
      op === "downgrade" ? [{ itemId: flatItem.publicId, newPriceId: cheaper.publicId }] : [],
    ...(op === "remove" ? { removes: [flatItem.publicId] } : {}),
  };
  const preview = await estimateChange(change);
  await changeSubscription(change);
  const notes = await withTenant(orgId, (tx) =>
    tx.select().from(creditNotes).where(eq(creditNotes.invoiceId, inv.id)),
  );
  const ds = await withTenant(orgId, (tx) => tx.select().from(creditNoteDiscounts));
  const slice = (type: string) =>
    ds
      .filter((d) => d.type === type && notes.some((n) => n.id === d.creditNoteId))
      .reduce((s2, d) => s2 + d.amountMinor, 0n);
  return {
    preview: {
      returned: BigInt(preview?.credit_returned_to_buckets_minor ?? 0),
      grants: BigInt(preview?.credit_returned_to_grants_minor ?? 0),
      cash: BigInt(preview?.credit_note_total_minor ?? 0),
    },
    booked: {
      returned: slice("credit_grants") + slice("promotional_credits"),
      grants: slice("credit_grants"),
      cash: notes.reduce((s2, n) => s2 + n.totalMinor, 0n),
    },
  };
}
{
  const r = await changeCase("g7-remove@example.com", "grant", "remove");
  check(
    "change preview = booking (remove): the credit_grants slice and the cash slice match to the cent",
    r.booked.grants > 0n &&
      r.preview.grants === r.booked.grants &&
      r.preview.cash === r.booked.cash,
    r,
  );
  // A downgrade whose new charge nets the credit splits differently in preview and booking for
  // the promotional bucket too (known, outside credit grants). Grants must follow that rule
  // exactly: the same figures as a promotional bucket in the same shape.
  const g = await changeCase("g7-down@example.com", "grant", "downgrade");
  const p = await changeCase("g7-promo@example.com", "promo", "downgrade");
  check(
    "change (downgrade): grants split exactly as the promotional bucket, in preview and in booking",
    g.preview.grants === p.preview.returned &&
      g.preview.cash === p.preview.cash &&
      g.booked.grants === p.booked.returned &&
      g.booked.cash === p.booked.cash,
    { g, p },
  );
}

// ── §8 A credit note on a grant-paid usage invoice gives the grant units back ───
{
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email: "g8@example.com",
    autoCollection: "off",
  });
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: bizId,
    customerId: customer.id,
    now: new Date(),
    items: [{ price: metered, quantity: 1 }],
  });
  await systemDb
    .update(subscriptions)
    .set({ currentPeriodStart: new Date(T - 2 * H), currentPeriodEnd: new Date(T - H) })
    .where(eq(subscriptions.id, sub.subscription.id));
  await recordUsage({
    organizationId: orgId,
    businessId: bizId,
    subscriptionItemId: sub.items[0]!.id,
    quantity: 300,
    timestamp: new Date(T - 90 * 60_000),
  });
  const G = await createPromotionalGrant({
    organizationId: orgId,
    businessId: bizId,
    customerPublicId: customer.publicId,
    currency: "USD",
    amount: 2000n,
    effectiveAt: longAgo,
  });
  const inv = await renew(sub.subscription.id);
  check(
    "fixture: usage 1,500 paid in full by the grant, no cash",
    inv.grantCreditsPreTaxMinor === 1500n && inv.status === "paid" && inv.amountDueMinor === 0n,
    inv,
  );
  const issue = async (amount: number) => {
    try {
      return await issueRefundableCreditNote({
        organizationId: orgId,
        businessId: bizId,
        invoicePublicId: inv.publicId,
        items: [{ description: "Usage credit", amountMinor: amount }],
      });
    } catch (e) {
      return e as Error;
    }
  };
  const cn1 = await issue(600);
  const discounts1 =
    cn1 instanceof Error
      ? []
      : await systemDb
          .select()
          .from(creditNoteDiscounts)
          .where(eq(creditNoteDiscounts.creditNoteId, cn1.id));
  check(
    "a refundable note for 600 gives 600 back to the grant: total 0, gross 600, credit_grants 600",
    !(cn1 instanceof Error) &&
      cn1.totalMinor === 0n &&
      cn1.subtotalMinor === 600n &&
      discounts1.length === 1 &&
      discounts1[0]!.type === "credit_grants" &&
      discounts1[0]!.amountMinor === 600n &&
      (await left(G)).face === 1100n,
    { cn1: cn1 instanceof Error ? cn1.message : cn1, discounts1, left: await left(G) },
  );
  // The note is a document: it lists the credited line and states the grants' return.
  const detail1 =
    cn1 instanceof Error ? null : await getCreditNoteDetail(orgId, bizId, cn1.publicId);
  const api1 = detail1 ? serializeCreditNote(detail1.view) : null;
  const doc1 =
    cn1 instanceof Error ? null : await assembleCreditNoteDocument(orgId, bizId, cn1.publicId);
  check(
    "the fully returned note lists its line (600) and a 'Credit Grants Returned' row of 600 on the API and the PDF",
    api1 !== null &&
      api1.items.length === 1 &&
      api1.items[0]!.description === "Usage credit" &&
      api1.items[0]!.amount_minor === 600 &&
      api1.subtotal_minor === 600 &&
      api1.total_minor === 0 &&
      detail1!.discounts.length === 1 &&
      detail1!.discounts[0]!.description === "Credit Grants Returned" &&
      doc1 !== null &&
      doc1.chargeLines.length === 1 &&
      doc1.chargeLines[0]!.amountMinor === 600n &&
      doc1.discountLines.length === 1 &&
      doc1.discountLines[0]!.description === "Credit Grants Returned" &&
      doc1.discountLines[0]!.amountMinor === 600n &&
      doc1.totals.subtotalMinor === 600n &&
      doc1.totals.taxTotalMinor === 0n &&
      doc1.totals.totalMinor === 0n,
    {
      items: api1?.items,
      discounts: detail1?.discounts,
      lines: doc1?.chargeLines,
      totals: doc1?.totals,
    },
  );
  const cn2 = await issue(900);
  check(
    "the rest (900) gives the whole draw back: the grant holds 2,000 again",
    !(cn2 instanceof Error) && (await left(G)).face === 2000n,
    { cn2: cn2 instanceof Error ? cn2.message : cn2.totalMinor, left: await left(G) },
  );
  const cn3 = await issue(1);
  check(
    "nothing is left to give back and no cash was paid: a further note is refused",
    cn3 instanceof Error && /no succeeded payment/.test(cn3.message),
    cn3 instanceof Error ? cn3.message : cn3,
  );
  const a = await accounts(customer.id);
  check(
    "ledger: credit_grants_promotional holds the 2,000 again; receivable untouched",
    credit(a, A.promotional) === 2000n && (a["accounts_receivable"] ?? 0n) === 0n,
    a,
  );
}

let failed = 0;
for (const [label, ok, detail] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n      ${detail}` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
await closeDb();
process.exit(failed ? 1 : 0);

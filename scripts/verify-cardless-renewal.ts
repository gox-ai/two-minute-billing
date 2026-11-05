/**
 * The RENEWAL boundary's collectability gate — what happens when an active
 * auto-collect subscription reaches its term end with no payment method at all.
 *
 * `isUncollectableAutoCollect` (`src/modules/subscriptions/renewal.ts`) guarded
 * trial-end and first-period boundaries from the start, and never the renewal. So a
 * cardless auto-collect subscription rolled its term, raised an invoice, recorded a
 * `no_payment_method` failure and emailed `payment_failed` — then dunning unwound all of
 * it days later as involuntary churn. Measured on a shadow run 2026-08-27: 48
 * subscriptions where nothing should have been raised at the boundary and we transacted.
 *
 * The remedy is the business's own dunning FINAL ACTION, asked at the boundary instead
 * of after four impossible retries — never a policy this file invents:
 *  - `cancel` → cancel here, reason `no_card`, nothing raised,
 *  - `retain` → raise the invoice so the dues stay on the books, but skip the attempt
 *    that cannot reach a gateway,
 *  - `retain` + `no_payment_method_at_renewal: cancel` → cancel as above; card
 *    declines still follow `retain`.
 *
 * The teeth matter as much as the gate: it must NOT eat a send-invoice subscription, a
 * carded one, a free one, or one whose credit balance covers the renewal. Every one of
 * those needs no card at the boundary and must renew.
 *
 *   pnpm verify:cardless-renewal
 */
import { desc, eq } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { addPromotionalCredits } from "@/modules/customers/balances";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { runBillingClockTick } from "@/modules/subscriptions/renewal";
import { subscriptions, invoices, payments, businesses } from "@db/schema";

const org = await createOrganization({ name: "CardlessRenewal" });
const orgId = org.organization.id;

/** One business per final action — the config is a business-level setting. */
async function bizWithFinalAction(
  label: string,
  subscriptionAction: "cancel" | "retain",
  extra: Record<string, unknown> = {},
) {
  const biz = await createBusiness({
    organizationId: orgId,
    name: label,
    defaultCurrency: "USD",
    livemode: "test",
  });
  // `createBusiness` takes no dunning config; set it the way Settings → Dunning would.
  await systemDb
    .update(businesses)
    .set({
      dunningConfig: {
        retries: [{ after_days: 1 }, { after_days: 3 }],
        final_action: { invoice: "not_paid", subscription: subscriptionAction },
        ...extra,
      },
    })
    .where(eq(businesses.id, biz.id));
  const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
  return { biz, product };
}

const cancelBiz = await bizWithFinalAction("FinalActionCancel", "cancel");
const retainBiz = await bizWithFinalAction("FinalActionRetain", "retain");
const retainCancelNoPmBiz = await bizWithFinalAction("RetainCancelNoPm", "retain", {
  no_payment_method_at_renewal: "cancel",
});

const getSub = (id: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1))[0]!,
  );
const invCount = (id: string) =>
  withTenant(
    orgId,
    async (tx) => (await tx.select().from(invoices).where(eq(invoices.subscriptionId, id))).length,
  );
const newestInvoice = (id: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (
        await tx
          .select()
          .from(invoices)
          .where(eq(invoices.subscriptionId, id))
          .orderBy(desc(invoices.createdAt))
          .limit(1)
      )[0] ?? null,
  );
/** Every payment row ever booked against this subscription's invoices, including failures. */
const paymentRows = async (subId: string) => {
  const invs = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.subscriptionId, subId)),
  );
  if (invs.length === 0) return [];
  return withTenant(orgId, async (tx) => {
    const rows = await tx.select().from(payments);
    return rows.filter((p) => invs.some((i) => i.id === p.invoiceId));
  });
};

/**
 * An ACTIVE subscription whose term end is already in the past, so the very next tick
 * renews it. `createSubscription` does not bill in advance (the route does), so these
 * start with zero invoices and every count below is unambiguous.
 *
 * `activatedAt` is stamped explicitly rather than left to the create path: the cancel
 * case asserts it SURVIVES the boundary cancel, because that is what tells an
 * end-of-term cancellation from a trial that never converted.
 */
async function activeSubDueNow(opts: {
  label: string;
  ctx: { biz: { id: string }; product: { id: string } };
  amountMinor?: number;
  card?: boolean;
  autoCollection?: "on" | "off";
  promoCreditMinor?: number;
}) {
  const bizId = opts.ctx.biz.id;
  const c = await createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email: `${opts.label}${Math.random()}@a.com`,
  });
  const pm = opts.card
    ? await vaultPaymentMethod({
        organizationId: orgId,
        businessId: bizId,
        customer: c,
        token: "tok_4242",
      })
    : null;
  if (opts.promoCreditMinor) {
    await addPromotionalCredits({
      organizationId: orgId,
      businessId: bizId,
      customer: c,
      amountMinor: opts.promoCreditMinor,
      currency: "USD",
      description: "cardless renewal test credit",
    });
  }
  const price = await createPrice({
    organizationId: orgId,
    businessId: bizId,
    productId: opts.ctx.product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: opts.amountMinor ?? 5000,
    interval: "month",
  });
  const s = (
    await createSubscription({
      organizationId: orgId,
      businessId: bizId,
      customerId: c.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
      autoCollection: opts.autoCollection,
      ...(pm ? { defaultPaymentMethodId: pm.id } : {}),
    })
  ).subscription;
  if (s.status !== "active")
    throw new Error(`${opts.label}: expected active at setup, got ${s.status}`);
  const past = new Date(Date.now() - 60_000);
  const activatedAt = new Date(Date.now() - 40 * 24 * 3600_000);
  await systemDb
    .update(subscriptions)
    .set({ currentPeriodEnd: past, activatedAt })
    .where(eq(subscriptions.id, s.id));
  return { sub: s, boundary: past };
}

const checks: Array<[string, boolean]> = [];

// ── 1. cardless + auto-collect ON + final_action cancel → cancelled AT the boundary ──
{
  const { sub: s, boundary } = await activeSubDueNow({
    label: "cancel-nocard",
    ctx: cancelBiz,
    autoCollection: "on",
  });
  const before = await invCount(s.id);
  await runBillingClockTick(new Date());
  const after = await getSub(s.id);
  const count = await invCount(s.id);
  const pays = await paymentRows(s.id);
  console.log(
    `cardless renewal + final_action cancel → ${after.status}/${after.cancelReason}, invoices ${before}→${count}, payments ${pays.length}`,
  );
  checks.push(["cardless renewal cancels", after.status === "cancelled"]);
  checks.push(["cancel reason is no_card", after.cancelReason === "no_card"]);
  // The whole point: no uncollectible invoice, so no AR on the append-only ledger to
  // unwind with a compensating void days later.
  checks.push(["no invoice raised for a cardless renewal", count === before]);
  checks.push(["no payment attempt recorded", pays.length === 0]);
  // The term is NOT rolled — the subscription never entered the next period, so
  // `cancelled_at` must land on or after the boundary it died at.
  checks.push([
    "term not advanced past the boundary",
    after.currentPeriodEnd?.getTime() === boundary.getTime(),
  ]);
  // Present, not NULL: this is an ordinary end-of-term cancellation, and clearing it
  // would make it read as a trial that never converted.
  checks.push(["activated_at preserved", after.activatedAt !== null]);
  checks.push(["cancelled → mrr 0", (after.mrr ?? 0n) === 0n]);
}

// ── 2. cardless + auto-collect ON + final_action retain → renews, billed, NOT attempted ──
//
// The merchant chose to keep the customer, so the dues belong on the books. What must
// NOT happen is the boundary attempt: with no payment method `collectInvoice` cannot
// reach a gateway, so it would only book a failed payment and email `payment_failed`.
// Dunning owns the retries from here — that is what `retain` means.
{
  const { sub: s, boundary } = await activeSubDueNow({
    label: "retain-nocard",
    ctx: retainBiz,
    autoCollection: "on",
  });
  const before = await invCount(s.id);
  await runBillingClockTick(new Date());
  const after = await getSub(s.id);
  const count = await invCount(s.id);
  const newest = await newestInvoice(s.id);
  const pays = await paymentRows(s.id);
  console.log(
    `cardless renewal + final_action retain → ${after.status}, invoices ${before}→${count}, newest=${newest?.status}, payments ${pays.length}`,
  );
  checks.push(["retain keeps the subscription active", after.status === "active"]);
  checks.push([
    "retain advances the term",
    (after.currentPeriodEnd?.getTime() ?? 0) > boundary.getTime(),
  ]);
  checks.push(["retain raises the invoice", count === before + 1]);
  checks.push(["retain leaves the invoice open", newest?.status === "payment_due"]);
  checks.push(["retain books NO failed payment at the boundary", pays.length === 0]);
}

// ── 3. TEETH: cardless + auto-collect OFF → renews and bills (send-invoice) ──────────
//
// No card is EXPECTED here: the invoice IS the bill and net terms apply. A gate that
// read card presence alone would cancel every send-invoice customer on the book.
{
  const { sub: s, boundary } = await activeSubDueNow({
    label: "sendinv",
    ctx: cancelBiz,
    autoCollection: "off",
  });
  const before = await invCount(s.id);
  await runBillingClockTick(new Date());
  const after = await getSub(s.id);
  const count = await invCount(s.id);
  console.log(`cardless renewal + auto-collect OFF → ${after.status}, invoices ${before}→${count}`);
  checks.push(["send-invoice renewal stays active", after.status === "active"]);
  checks.push([
    "send-invoice renewal advances the term",
    (after.currentPeriodEnd?.getTime() ?? 0) > boundary.getTime(),
  ]);
  checks.push(["send-invoice renewal IS invoiced", count === before + 1]);
}

// ── 4. TEETH: a card on file → renews, bills and collects, exactly as before ─────────
{
  const { sub: s, boundary } = await activeSubDueNow({
    label: "carded",
    ctx: cancelBiz,
    autoCollection: "on",
    card: true,
  });
  const before = await invCount(s.id);
  await runBillingClockTick(new Date());
  const after = await getSub(s.id);
  const count = await invCount(s.id);
  const newest = await newestInvoice(s.id);
  console.log(
    `carded renewal → ${after.status}, invoices ${before}→${count}, newest=${newest?.status}`,
  );
  checks.push(["carded renewal stays active", after.status === "active"]);
  checks.push([
    "carded renewal advances the term",
    (after.currentPeriodEnd?.getTime() ?? 0) > boundary.getTime(),
  ]);
  checks.push(["carded renewal IS invoiced", count === before + 1]);
  checks.push(["carded renewal collected", newest?.status === "paid"]);
}

// ── 5. TEETH: a ZERO-amount renewal never needed a card ──────────────────────────────
{
  const { sub: s, boundary } = await activeSubDueNow({
    label: "free",
    ctx: cancelBiz,
    autoCollection: "on",
    amountMinor: 0,
  });
  const before = await invCount(s.id);
  await runBillingClockTick(new Date());
  const after = await getSub(s.id);
  const count = await invCount(s.id);
  console.log(`zero-amount cardless renewal → ${after.status}, invoices ${before}→${count}`);
  checks.push(["free renewal stays active", after.status === "active"]);
  checks.push([
    "free renewal advances the term",
    (after.currentPeriodEnd?.getTime() ?? 0) > boundary.getTime(),
  ]);
  checks.push(["free renewal IS invoiced", count === before + 1]);
}

// ── 6. TEETH: a credit balance covering the renewal is collectable ───────────────────
//
// A renewal covered by promotional credit settles from that credit and raises no
// transaction at all (shadow triage 2026-08-27, `promotional_credits_deducted`). Ours
// reaches that answer through the probe's own plan, which prices the credit buckets —
// so a covered renewal is NOT cardless-uncollectable and must go through.
{
  const { sub: s, boundary } = await activeSubDueNow({
    label: "credit-covered",
    ctx: cancelBiz,
    autoCollection: "on",
    amountMinor: 5000,
    promoCreditMinor: 20000,
  });
  const before = await invCount(s.id);
  await runBillingClockTick(new Date());
  const after = await getSub(s.id);
  const count = await invCount(s.id);
  const newest = await newestInvoice(s.id);
  console.log(
    `credit-covered cardless renewal → ${after.status}, invoices ${before}→${count}, newest=${newest?.status}`,
  );
  checks.push(["credit-covered renewal stays active", after.status === "active"]);
  checks.push([
    "credit-covered renewal advances the term",
    (after.currentPeriodEnd?.getTime() ?? 0) > boundary.getTime(),
  ]);
  checks.push(["credit-covered renewal IS invoiced", count === before + 1]);
  checks.push(["credit-covered renewal is settled, not left open", newest?.status === "paid"]);
}

// ── 7. retain + no_payment_method_at_renewal cancel → cardless renewal cancels ───────
{
  const { sub: s, boundary } = await activeSubDueNow({
    label: "retain-cancel-nopm",
    ctx: retainCancelNoPmBiz,
    autoCollection: "on",
  });
  const before = await invCount(s.id);
  await runBillingClockTick(new Date());
  const after = await getSub(s.id);
  const count = await invCount(s.id);
  const pays = await paymentRows(s.id);
  console.log(
    `cardless renewal + retain + no_payment_method_at_renewal=cancel → ${after.status}/${after.cancelReason}, invoices ${before}→${count}, payments ${pays.length}`,
  );
  checks.push(["no-pm override cancels under retain", after.status === "cancelled"]);
  checks.push(["no-pm override cancel reason is no_card", after.cancelReason === "no_card"]);
  checks.push(["no-pm override raises no invoice", count === before]);
  checks.push(["no-pm override books no payment", pays.length === 0]);
  checks.push([
    "no-pm override does not advance the term",
    after.currentPeriodEnd?.getTime() === boundary.getTime(),
  ]);
}

// ── 8. TEETH: same business, a card on file → renews and collects ────────────────────
{
  const { sub: s, boundary } = await activeSubDueNow({
    label: "retain-cancel-nopm-carded",
    ctx: retainCancelNoPmBiz,
    autoCollection: "on",
    card: true,
  });
  const before = await invCount(s.id);
  await runBillingClockTick(new Date());
  const after = await getSub(s.id);
  const count = await invCount(s.id);
  const newest = await newestInvoice(s.id);
  console.log(
    `carded renewal under the no-pm override → ${after.status}, invoices ${before}→${count}, newest=${newest?.status}`,
  );
  checks.push(["no-pm override leaves a carded sub active", after.status === "active"]);
  checks.push([
    "no-pm override: carded renewal advances the term",
    (after.currentPeriodEnd?.getTime() ?? 0) > boundary.getTime(),
  ]);
  checks.push(["no-pm override: carded renewal collected", newest?.status === "paid"]);
}

let pass = true;
for (const [n, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${n}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ CARDLESS RENEWAL: PASS" : "❌ CARDLESS RENEWAL: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);

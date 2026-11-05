/**
 * One payment, many refunders — the mirror of `verify:concurrent-collect`, for money going OUT.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 * `verify:concurrent-collect` was written for the 0162 double-book: every guard inside
 * `collectInvoice` is a read-then-act, so two arrivals inside the same window each read
 * "nothing collected yet" and both charge. That path now has TWO defences — a claim
 * (`invoices.collecting_at`) and a unique index (`payments_provider_charge_uq`).
 *
 * `refundPayment` has the same shape and, reading it, neither defence:
 *
 *   1. It loads the payment and sums prior refunds in ONE `withTenant` transaction, then
 *      computes `remaining` and writes in LATER ones. Nothing is claimed in between, so two
 *      full refunds arriving together both read `refunded = 0`.
 *   2. Its provider idempotency key is `pubId` — the refund's OWN freshly-generated public id.
 *      Two racers therefore build DIFFERENT keys, which is exactly the case the collect suite
 *      calls out as the one where "the gateway does not deduplicate, and the customer is
 *      charged twice for real".
 *   3. `refunds` carries one unique index, on `public_id` — unique per row by construction, so
 *      it constrains nothing here. There is no `provider_refund_id` uniqueness to mirror
 *      `payments_provider_charge_uq`.
 *
 * Money out is worse than money in: an over-collection is visible and refundable, an
 * over-refund is cash gone to a customer who is not expecting it, and the ledger says the
 * business paid out more than it ever took.
 *
 * ── WHAT THIS ASSERTS ───────────────────────────────────────────────────────────
 * The load-bearing assertion is the LEDGER, not the row count. A suite that counted refund
 * rows would pass while cash doubled, which is the same trap `verify:concurrent-collect`
 * documents: total cash CREDITED for refunds must never exceed what was collected.
 *
 *   pnpm verify:concurrent-refund
 */
import { eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod, collectInvoice } from "@/modules/invoicing/service";
import { refundPayment } from "@/modules/refunds/service";
import { payments, refunds, ledgerEntries, tmtestCharges } from "@db/schema";

const REFUNDERS = 5;
const AMOUNT = 1500;

const checks: [string, boolean, string][] = [];
const ok = (name: string, pass: boolean, detail = "") => checks.push([name, pass, detail]);

const org = await createOrganization({ name: "Concurrent Refund Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  defaultCurrency: "USD",
  organizationId: orgId,
  name: "Biz",
  livemode: "test",
});
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "cr@a.com",
});
await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz.id,
  customer,
  token: "tok_4242",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: AMOUNT,
  interval: "month",
});
const sub = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(),
  items: [{ price, quantity: 1 }],
});
const { invoice } = await billSubscriptionPeriod({
  organizationId: orgId,
  businessId: biz.id,
  subscription: sub.subscription,
  periodStart: sub.subscription.currentPeriodStart!,
  periodEnd: sub.subscription.currentPeriodEnd!,
});
await collectInvoice({
  organizationId: orgId,
  businessId: biz.id,
  invoice,
  subscription: sub.subscription,
});

const paid = await withTenant(orgId, (tx) =>
  tx.select().from(payments).where(eq(payments.invoiceId, invoice.id)),
);
const payment = paid.find((p) => p.status === "succeeded");
ok(
  "setup: the invoice collected into exactly one succeeded payment",
  paid.length === 1 && !!payment,
  `${paid.length} payment row(s)`,
);
if (!payment) {
  console.log("❌ CONCURRENT REFUND: cannot run — no succeeded payment to refund");
  await closeDb();
  process.exit(1);
}

// ── the race ─────────────────────────────────────────────────────────────────────
//
// Every caller asks for the FULL amount with no `amountMinor`, which is the real shape: each
// one reads `refunded = 0`, computes `remaining = 1500`, and believes it is the first.
const results = await Promise.allSettled(
  Array.from({ length: REFUNDERS }, () =>
    refundPayment({
      organizationId: orgId,
      businessId: biz.id,
      paymentPublicId: payment.publicId,
      reason: "concurrency probe",
    }),
  ),
);
const fulfilled = results.filter((r) => r.status === "fulfilled").length;
const rejected = results.length - fulfilled;
console.log(`race: ${fulfilled} succeeded, ${rejected} refused of ${REFUNDERS}`);

// ── what actually happened, measured three ways ──────────────────────────────────
const refundRows = await withTenant(orgId, (tx) =>
  tx.select().from(refunds).where(eq(refunds.paymentId, payment.id)),
);
const succeeded = refundRows.filter((r) => r.status === "succeeded");
const refundedTotal = succeeded.reduce((s, r) => s + r.amountMinor, 0n);

ok(
  `refund rows never exceed the payment (${AMOUNT})`,
  refundedTotal <= BigInt(AMOUNT),
  `refunded ${refundedTotal} across ${succeeded.length} succeeded refund row(s)`,
);

// THE MONEY ASSERTION. Row counts can look sane while the ledger doubles — the ledger is
// what the business's cash position is derived from, so it is the only authority here.
const entries = await withTenant(orgId, (tx) => tx.select().from(ledgerEntries));
const cashCredited = entries
  .filter((e) => e.account === "cash" && e.direction === "credit")
  .reduce((s, e) => s + e.amountMinor, 0n);
ok(
  `LEDGER: cash credited for refunds never exceeds what was collected (${AMOUNT})`,
  cashCredited <= BigInt(AMOUNT),
  `cash credited ${cashCredited}`,
);

// The gateway's own view. Each racer builds its idempotency key from its OWN new refund id, so
// the provider cannot deduplicate them — if more than one refund reached it, real money left.
// tmtest keeps refunds in `tmtest_charges` with `kind='refund'` (there is no separate table).
// Scoped to THIS business: `tmtest_charges` is a shared table across the whole dev estate, and
// an unscoped count picked up 34 refunds belonging to other suites.
const atGateway = (
  await withTenant(orgId, (tx) =>
    tx.select().from(tmtestCharges).where(eq(tmtestCharges.businessId, biz.id)),
  )
).filter((c) => c.kind === "refund");
ok(
  "the GATEWAY was asked to refund at most once",
  atGateway.length <= 1,
  `${atGateway.length} provider refund(s): ${atGateway.map((r) => String(r.amountMinor)).join(", ")}`,
);

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
    ? `\n✅ CONCURRENT REFUND: PASS (${checks.length} checks)`
    : `\n❌ CONCURRENT REFUND: FAIL — ${failed} of ${checks.length}`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);

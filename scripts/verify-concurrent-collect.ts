/**
 * One invoice, many collectors — the double-book regression (0162).
 *
 * The billing clock's auto-collection and the shadow poller's bucket-2 replay both reach
 * `collectInvoice` from separate job queues. Every guard inside it is a read-then-act, so
 * two arrivals inside the same window each read "nothing collected yet" and both charge.
 * On INV-65615 that booked ONE gateway charge as TWO payments with two cash/AR postings:
 * "Amount paid -$30.00" against a $15.00 total.
 *
 * Both defences are exercised here, because they cover different failures:
 *
 *   1. The claim (`invoices.collecting_at`). Only one concurrent collector proceeds; the
 *      rest get `CollectionInFlightError`. This is the half that matters, because racers
 *      holding DIFFERENT stale attempt counts build different idempotency keys, the
 *      gateway does not deduplicate, and the customer is charged twice for real.
 *   2. The index (`payments_provider_charge_uq`). One gateway charge books at most one
 *      payment even if a booking is somehow attempted twice — the case where the racers
 *      agreed on a key, so the gateway deduplicated and handed back the same charge.
 *
 * The money assertion is the point of the whole file: cash debited must equal the invoice
 * total exactly. A test that only counts payment rows would pass while the ledger doubled.
 *
 *   pnpm verify:concurrent-collect
 */
import { and, eq } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import {
  billSubscriptionPeriod,
  collectInvoice,
  CollectionInFlightError,
} from "@/modules/invoicing/service";
import { publicId } from "@/platform/ids";
import { invoices, payments, ledgerEntries, tmtestCharges } from "@db/schema";

const COLLECTORS = 5;
const AMOUNT = 1500;

const org = await createOrganization({ name: "Concurrent Collect Org" });
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
  email: "cc@a.com",
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

// ── 0. the claim engages, DETERMINISTICALLY ───────────────────────────────────
// A race cannot prove this. How many racers get refused is a scheduler outcome: 4 of 5 on
// a fast dev box, 3 of 5 on CI, 0 of 5 if they happen to arrive strictly one after another
// (each straggler then takes the claim, finds the invoice paid, and returns the winner's
// row without charging). Counting refusals therefore tests the machine, not the engine.
//
// State it directly instead: `collecting_at` IS the claim (`claimCollection` sets exactly
// this column), so hold it and require `collectInvoice` to refuse. Deterministic, and it
// still fails the moment someone removes the claim from the collect path — which the
// gateway-charge count below does NOT catch, because racers sharing one invoice snapshot
// build one idempotency key and the gateway dedupes them into a single charge.
await withTenant(orgId, (tx) =>
  tx.update(invoices).set({ collectingAt: new Date() }).where(eq(invoices.id, invoice.id)),
);
let refusedWhileClaimed = false;
try {
  await collectInvoice({
    organizationId: orgId,
    businessId: biz.id,
    invoice,
    subscription: sub.subscription,
  });
} catch (e) {
  refusedWhileClaimed = e instanceof CollectionInFlightError;
}
await withTenant(orgId, (tx) =>
  tx.update(invoices).set({ collectingAt: null }).where(eq(invoices.id, invoice.id)),
);
console.log(`0) an already-claimed invoice is refused by collectInvoice: ${refusedWhileClaimed}`);

// ── 1. concurrent collectors ──────────────────────────────────────────────────
// Every caller passes the SAME invoice snapshot, which is the real shape of the bug:
// each collector loaded the row before any of them wrote, so all of them believe
// attempt_count is 0 and nothing has been collected.
const results = await Promise.allSettled(
  Array.from({ length: COLLECTORS }, () =>
    collectInvoice({
      organizationId: orgId,
      businessId: biz.id,
      invoice,
      subscription: sub.subscription,
    }),
  ),
);

const succeeded = results.filter((r) => r.status === "fulfilled" && r.value.status === "succeeded");
const inFlight = results.filter(
  (r) => r.status === "rejected" && r.reason instanceof CollectionInFlightError,
);
const unexpected = results.filter(
  (r) => r.status === "rejected" && !(r.reason instanceof CollectionInFlightError),
);
for (const u of unexpected)
  console.log(`   unexpected rejection: ${(u as PromiseRejectedResult).reason}`);

/**
 * WHAT "CHARGED" MEANS HERE, AND WHY IT IS NOT `succeeded.length`.
 *
 * A returned `succeeded` is not evidence of a charge. A straggler that arrives after the
 * winner has already released the claim takes the claim itself, finds the invoice settled
 * (`paidMinor > 0 && due <= 0` in `collectClaimedInvoice`) and returns the winner's
 * EXISTING payment row without going near the gateway. That is the idempotent answer we
 * want, and it counts as `succeeded`.
 *
 * So the old assertion — exactly 1 succeeded, exactly COLLECTORS-1 refused — was measuring
 * scheduler timing, not correctness. It held on a fast dev box (1/4 on 8 consecutive local
 * runs) and failed on CI (2/3, consistently, on runs 32649221896 and 32652110097) while
 * every money invariant below was green: one payment row, one gateway charge, cash exactly
 * 1500. Red CI, correct engine.
 *
 * What defence #1 actually claims is that the customer's card is hit ONCE, so ask the
 * gateway. `tmtest_charges` is the test gateway's own book: one row per charge object it
 * created. Two racers with different stale attempt counts build different idempotency keys,
 * the gateway does not deduplicate them, and TWO rows appear here — the INV-65615 bug, in
 * the only place that can see it. That number is timing-independent.
 */
const gatewayCharges = await systemDb
  .select()
  .from(tmtestCharges)
  .where(eq(tmtestCharges.businessId, biz.id));
// Every winner must point at the same payment row: a straggler replays the winner's row,
// it never mints a second one.
const distinctReturned = new Set(
  succeeded.map(
    (r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof collectInvoice>>>).value.publicId,
  ),
);

console.log(
  `1) ${COLLECTORS} concurrent collectors \u2192 ${gatewayCharges.length} gateway charge(s) (expect 1), ${succeeded.length} returned succeeded (all the same row: ${distinctReturned.size <= 1}), ${inFlight.length} refused as in-flight, ${unexpected.length} errored`,
);

// ── 2. what actually landed in the book ───────────────────────────────────────
const booked = await withTenant(orgId, (tx) =>
  tx
    .select()
    .from(payments)
    .where(and(eq(payments.invoiceId, invoice.id), eq(payments.status, "succeeded"))),
);
const chargeIds = new Set(booked.map((p) => p.providerChargeId));
console.log(
  `2) succeeded payment rows: ${booked.length} (expect 1), distinct gateway charges: ${chargeIds.size} (expect 1)`,
);

const cash = await withTenant(orgId, async (tx) => {
  const rows = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.account, "cash"));
  return rows.reduce((s, r) => s + (r.direction === "debit" ? r.amountMinor : -r.amountMinor), 0n);
});
const [finalInv] = await withTenant(orgId, (tx) =>
  tx.select().from(invoices).where(eq(invoices.id, invoice.id)).limit(1),
);
console.log(
  `3) cash debited: ${cash} (expect ${AMOUNT} — the bug doubled this), invoice: ${finalInv!.status}`,
);

// The claim must be released whatever happened, or the invoice is uncollectable until the
// stale window expires — a fix that strands invoices is not a fix.
console.log(`4) claim released: ${finalInv!.collectingAt === null}`);

// ── 3. the index backstop, independently ──────────────────────────────────────
// Booking a second payment against a charge that is already booked must be refused by the
// DATABASE, not merely avoided by application code — that is what makes the double-book
// unreachable from any path, including ones written later.
let indexRefused = false;
const first = booked[0];
if (first?.providerChargeId) {
  try {
    await withTenant(orgId, (tx) =>
      tx.insert(payments).values({
        organizationId: orgId,
        businessId: biz.id,
        customerId: customer.id,
        invoiceId: invoice.id,
        publicId: publicId("pay"),
        status: "succeeded",
        amountMinor: BigInt(AMOUNT),
        currency: "USD",
        providerKey: first.providerKey,
        providerChargeId: first.providerChargeId,
      }),
    );
  } catch {
    indexRefused = true;
  }
}
console.log(`5) second booking of the same gateway charge refused by the index: ${indexRefused}`);

// Offline payments must stay unaffected: `recordPayment` stores the METHOD NAME in
// provider_charge_id ('cash', 'cheque'), so many rows share one value by design. The
// first cut of the index had no `provider_key <> 'offline'` term and would have made a
// business's second cash payment impossible.
let offlineRepeatable = true;
try {
  for (let i = 0; i < 2; i++) {
    await withTenant(orgId, (tx) =>
      tx.insert(payments).values({
        organizationId: orgId,
        businessId: biz.id,
        customerId: customer.id,
        invoiceId: null,
        publicId: publicId("pay"),
        status: "succeeded",
        amountMinor: 1n,
        currency: "USD",
        providerKey: "offline",
        providerChargeId: "cash",
      }),
    );
  }
} catch {
  offlineRepeatable = false;
}
console.log(`6) repeated offline 'cash' payments still allowed: ${offlineRepeatable}`);

const pass =
  refusedWhileClaimed &&
  gatewayCharges.length === 1 &&
  distinctReturned.size === 1 &&
  succeeded.length + inFlight.length === COLLECTORS &&
  unexpected.length === 0 &&
  booked.length === 1 &&
  chargeIds.size === 1 &&
  cash === BigInt(AMOUNT) &&
  finalInv!.status === "paid" &&
  finalInv!.collectingAt === null &&
  indexRefused &&
  offlineRepeatable;

console.log("");
console.log(pass ? "✅ CONCURRENT COLLECT: PASS" : "❌ CONCURRENT COLLECT: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);

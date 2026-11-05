/**
 * Proves the ACCEPTED → SETTLED refund path, which had no coverage because the test
 * gateway settled every refund synchronously.
 *
 * The claims under test, in the order the money makes them:
 *   1. A refund the provider only ACCEPTS is recorded `pending` — and books its ledger pair
 *      immediately, because the money is committed on the rail the moment the instruction is
 *      taken. It used to book nothing, so committed cash was invisible for days.
 *   2. That state emails `refund_initiated` ("we've started it"), never `refund_issued`.
 *   3. The provider's settlement webhook — the one signal every gateway sends and the one
 *      the reconciler used to discard as a duplicate — flips it to `succeeded`, reconciles
 *      the transaction, and emits `refund_settled`.
 *   4. Settlement posts NO further ledger lines. Booking on acceptance and booking again on
 *      settlement would double the refund.
 *   5. A redelivered settlement webhook changes nothing (the conditional claim holds).
 *   6. An accepted-then-REFUSED refund is reversed, because acceptance did book lines.
 *
 *   pnpm verify:refund-settlement
 */
import { and, eq } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { refundPayment } from "@/modules/refunds/service";
import { handleProviderEvent } from "@/modules/webhooks/inbound";
// Imported for the side effect: `registerEventSink(enqueueEmails)` runs at module load, so
// emails are enqueued inside the emitting transaction rather than by a call here.
import "@/modules/emails/outbox";
import {
  ledgerEntries,
  refunds,
  transactions,
  events,
  emailMessages,
  businesses,
} from "@db/schema";
import type { NormalizedProviderEvent } from "@/providers/types";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log("✓", label);
  } else {
    fail++;
    console.log("✗", label, detail ?? "");
  }
}

const org = await createOrganization({ name: "Refund Settlement Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
// Customer email is opt-in per business; without this the sink enqueues nothing and the
// mail assertions below would pass vacuously.
await withTenant(orgId, (tx) =>
  tx
    .update(businesses)
    .set({ emailConfig: { enabled: true } })
    .where(eq(businesses.id, biz.id)),
);
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "settle@a.com",
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
  amountMinor: 10000,
  interval: "month",
});
const sub = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(),
  items: [{ price, quantity: 1 }],
});
const { payment } = await billSubscriptionPeriod({
  organizationId: orgId,
  businessId: biz.id,
  subscription: sub.subscription,
  periodStart: sub.subscription.currentPeriodStart!,
  periodEnd: sub.subscription.currentPeriodEnd!,
});
if (!payment || payment.status !== "succeeded") {
  console.log("❌ no succeeded payment");
  process.exit(1);
}

const bal = (account: string) =>
  withTenant(orgId, async (tx) => {
    const rows = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.account, account));
    return rows.reduce(
      (s, r) => s + (r.direction === "debit" ? r.amountMinor : -r.amountMinor),
      0n,
    );
  });
const refundRow = (publicId: string) =>
  withTenant(orgId, async (tx) => {
    const [r] = await tx.select().from(refunds).where(eq(refunds.publicId, publicId)).limit(1);
    return r;
  });
const eventTypes = () =>
  withTenant(orgId, async (tx) =>
    (await tx.select({ type: events.type }).from(events)).map((e) => e.type),
  );
const emailTypes = () =>
  withTenant(orgId, async (tx) =>
    (await tx.select({ type: emailMessages.type }).from(emailMessages)).map((e) => e.type),
  );

// ── 1. Accept a refund the gateway will NOT settle (magic amount ending in 17) ──
const cashBefore = await bal("cash");
const r = await refundPayment({
  organizationId: orgId,
  businessId: biz.id,
  paymentPublicId: payment.publicId,
  amountMinor: 2017,
  reason: "unsettled",
});
ok("an accepted-but-unsettled refund is recorded pending", r.status === "pending", r.status);

const booked = await refundRow(r.publicId);
ok(
  "…and it booked the ledger on ACCEPTANCE, not on settlement",
  (await bal("cash")) === cashBefore - 2017n,
  await bal("cash"),
);
ok("…contra-revenue carries it", (await bal("refunds")) === 2017n, await bal("refunds"));

const txnAfterAccept = await withTenant(orgId, async (tx) => {
  const [t] = await tx
    .select()
    .from(transactions)
    .where(eq(transactions.refundId, booked!.id))
    .limit(1);
  return t;
});
ok(
  "…the transaction is in_progress, not success",
  txnAfterAccept?.status === "in_progress",
  txnAfterAccept?.status,
);

// ── 2. The email says STARTED, not done ──
let mails = await emailTypes();
ok("the customer is told the refund has STARTED", mails.includes("refund_initiated"), mails);
ok("…and is NOT told it has been issued", !mails.includes("refund_issued"), mails);

// ── 3. The settlement webhook — the signal that used to be discarded ──
const settleEvent: NormalizedProviderEvent = {
  providerEventId: `evt_settle_${booked!.publicId}`,
  type: "charge.refunded",
  providerChargeId: payment.providerChargeId!,
  providerRefundId: booked!.providerRefundId!,
  amountRefundedMinor: 2017n,
  occurredAt: new Date(),
  raw: {},
};
const outcome = await handleProviderEvent("tmtest", settleEvent, { businessId: biz.id });
ok(
  "the settlement webhook is PROCESSED, not ignored as a duplicate",
  outcome === "processed",
  outcome,
);

const settled = await refundRow(r.publicId);
ok("…the refund is now succeeded", settled?.status === "succeeded", settled?.status);

const txnAfterSettle = await withTenant(orgId, async (tx) => {
  const [t] = await tx
    .select()
    .from(transactions)
    .where(eq(transactions.refundId, booked!.id))
    .limit(1);
  return t;
});
ok(
  "…the transaction is reconciled to success",
  txnAfterSettle?.status === "succeeded",
  txnAfterSettle?.status,
);
ok("…a refund_settled event was emitted", (await eventTypes()).includes("refund_settled"));

// ── 4. Settlement must not book the money a second time ──
ok(
  "settlement posts NO further ledger lines",
  (await bal("cash")) === cashBefore - 2017n,
  await bal("cash"),
);
ok("…contra-revenue is unchanged", (await bal("refunds")) === 2017n, await bal("refunds"));

// ── 5. The confirmation email ──
mails = await emailTypes();
ok("the customer is now told the refund was issued", mails.includes("refund_issued"), mails);
ok("…exactly once", mails.filter((m) => m === "refund_issued").length === 1, mails);
ok(
  "…and the initiation mail was not re-sent",
  mails.filter((m) => m === "refund_initiated").length === 1,
  mails,
);

// ── 6. A redelivered settlement changes nothing ──
const before = await eventTypes();
const replay = await handleProviderEvent("tmtest", settleEvent, { businessId: biz.id });
ok(
  "a redelivered settlement webhook is a duplicate",
  replay === "duplicate" || replay === "ignored",
  replay,
);
ok(
  "…and emits no second refund_settled",
  (await eventTypes()).filter((t) => t === "refund_settled").length ===
    before.filter((t) => t === "refund_settled").length,
);
ok("…and moves no money", (await bal("cash")) === cashBefore - 2017n, await bal("cash"));

// ── 7. An accepted refund the provider later REFUSES must be reversed ──
// Acceptance booked lines, so unlike before there is something to undo.
const r2 = await refundPayment({
  organizationId: orgId,
  businessId: biz.id,
  paymentPublicId: payment.publicId,
  amountMinor: 1017,
  reason: "will fail",
});
ok("a second unsettled refund is pending", r2.status === "pending", r2.status);
const booked2 = await refundRow(r2.publicId);
const cashAfterSecond = await bal("cash");
ok("…and booked on acceptance", cashAfterSecond === cashBefore - 2017n - 1017n, cashAfterSecond);

const failEvent: NormalizedProviderEvent = {
  providerEventId: `evt_fail_${booked2!.publicId}`,
  type: "refund.failed",
  providerRefundId: booked2!.providerRefundId!,
  occurredAt: new Date(),
  raw: {},
};
await handleProviderEvent("tmtest", failEvent, { businessId: biz.id });
const failed = await refundRow(r2.publicId);
ok("a refused refund is marked failed", failed?.status === "failed", failed?.status);
// The reversal is the whole reason booking-on-acceptance is safe.
ok(
  "…and its booking is REVERSED, so the cash comes back",
  (await bal("cash")) === cashBefore - 2017n,
  await bal("cash"),
);

const reversals = await withTenant(orgId, async (tx) =>
  tx
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.sourceType, "refund_reversal"),
        eq(ledgerEntries.sourceId, booked2!.publicId),
      ),
    ),
);
ok("…via a refund_reversal posting", reversals.length > 0, reversals.length);

// ── 8. The sweeper backstop: a settlement webhook that NEVER arrives ──────────
// Everything above assumed the webhook came. This is the case where it does not: the
// money is out on the rail, the ledger has booked it, and nothing else in the engine
// would ever revisit the row.
const { sweepStalePendingRefunds, __refundGraceHours } =
  await import("@/modules/refunds/stale-pending");
const store = await import("@/providers/tmtest/store");

const r3 = await refundPayment({
  organizationId: orgId,
  businessId: biz.id,
  paymentPublicId: payment.publicId,
  amountMinor: 1117,
  reason: "webhook will be lost",
});
const booked3 = await refundRow(r3.publicId);
ok("a third unsettled refund is pending", r3.status === "pending", r3.status);

// Inside its grace window the sweep must not even look — a refund legitimately takes days.
let swept = await sweepStalePendingRefunds(new Date());
ok("a FRESH pending refund is not examined", swept.examined === 0, swept);

// Age it past the grace period. The gateway still says pending.
const backdate = (id: string, hours: number) =>
  withTenant(orgId, (tx) =>
    tx
      .update(refunds)
      .set({ createdAt: new Date(Date.now() - hours * 60 * 60 * 1000) })
      .where(eq(refunds.id, id)),
  );
await backdate(booked3!.id, __refundGraceHours + 24);

swept = await sweepStalePendingRefunds(new Date());
ok("an aged refund IS examined", swept.examined >= 1, swept);
ok("…but a gateway still saying pending is left alone", swept.stillPending >= 1, swept);
ok(
  "…and it is not settled on the clock’s say-so",
  (await refundRow(r3.publicId))?.status === "pending",
);

// The gateway settled it — the webhook simply never reached us.
await store.setChargeStatus(booked3!.providerRefundId!, "succeeded");
const cashBeforeSweep = await bal("cash");
swept = await sweepStalePendingRefunds(new Date());
ok("the sweep settles a refund whose webhook was lost", swept.settled === 1, swept);
ok("…the row is succeeded", (await refundRow(r3.publicId))?.status === "succeeded");
ok(
  "…it emitted refund_settled, exactly as the webhook would",
  (await eventTypes()).filter((t) => t === "refund_settled").length === 2,
);
// The whole point of sharing settleRefund: a swept outcome and a delivered one are
// byte-identical in the ledger.
ok(
  "…and posted NO ledger lines (acceptance already booked it)",
  (await bal("cash")) === cashBeforeSweep,
  await bal("cash"),
);

// ── 9. The sweeper's other verdict: the gateway refused it ────────────────────
const r4 = await refundPayment({
  organizationId: orgId,
  businessId: biz.id,
  paymentPublicId: payment.publicId,
  amountMinor: 1217,
  reason: "gateway will refuse",
});
const booked4 = await refundRow(r4.publicId);
await backdate(booked4!.id, __refundGraceHours + 24);
await store.setChargeStatus(booked4!.providerRefundId!, "failed");

const cashBeforeReverse = await bal("cash");
swept = await sweepStalePendingRefunds(new Date());
ok("the sweep reverses a refund the gateway refused", swept.reversed === 1, swept);
ok("…the row is failed", (await refundRow(r4.publicId))?.status === "failed");
ok(
  "…and the booking is undone, so the cash comes back",
  (await bal("cash")) === cashBeforeReverse + 1217n,
  await bal("cash"),
);

// ── 10. Idempotency across the two routes ────────────────────────────────────
// A settled refund must not be touched again by a later sweep.
const eventsBefore = (await eventTypes()).length;
swept = await sweepStalePendingRefunds(new Date());
ok("a second sweep settles nothing further", swept.settled === 0 && swept.reversed === 0, swept);
ok("…and emits no further events", (await eventTypes()).length === eventsBefore);

console.log(`\n${pass} passed, ${fail} failed`);
await closeDb();
process.exit(fail === 0 ? 0 : 1);

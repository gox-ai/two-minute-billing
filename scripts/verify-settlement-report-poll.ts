/**
 * Settlement-report polling (`pollGatewaySettlementReports`): outcomes a gateway reports
 * only in a report, read from a per-account cursor and fed through the webhook handlers.
 *
 * Driven on tmtest (`settlement_report: "true"`): `TmtestProvider.returnCharge` returns a
 * booked charge, and only the poll reports it, as the existing late-failure event.
 *
 * Hermetic against the dev worker: the business runs on Time Travel (the real tick
 * excludes it) and every pass here runs under `onlyBusinessId`.
 *
 *   pnpm verify:settlement-report-poll
 */
import { and, eq } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { accountBalance } from "@/modules/ledger/service";
import { startTimeTravel } from "@/modules/time-travel/service";
import {
  pollGatewaySettlementReports,
  SETTLEMENT_POLL_OVERLAP_MS,
} from "@/modules/gateway/settlement-report";
import { runBillingClockTickOnce, TICK_PASSES } from "@/platform/jobs";
import { TmtestProvider } from "@/providers/tmtest";
import {
  gatewayAccounts,
  gatewaySettlementCursors,
  invoices,
  ledgerEntries,
  payments,
  providerEvents,
  transactions,
} from "@db/schema";

const checks: [string, boolean, string?][] = [];
const ok = (name: string, cond: boolean, detail?: string) => checks.push([name, cond, detail]);
const MIN = 60_000;

const org = await createOrganization({ name: "Settlement report poll verify" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "SRP Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const T0 = new Date();
await startTimeTravel({ orgId, bizId: biz.id, genesisTime: T0 });

const main = await createGatewayAccount({
  organizationId: orgId,
  businessId: biz.id,
  gatewayKey: "tmtest",
  label: "Reports",
  credentials: { settlement_report: "true" },
  currencies: ["USD"],
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

async function paidCharge(email: string) {
  const customer = await createCustomer({ organizationId: orgId, businessId: biz.id, email });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
  });
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  const { invoice, payment } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  return { invoice, payment: payment!, chargeId: payment!.providerChargeId! };
}

// Charges first. tmtest's report is per business, so the account that charged does not
// matter; only `main` reads it (the auto-provisioned test account has no capability).
const first = await paidCharge("first@example.com");
const second = await paidCharge("second@example.com");
ok("fixture: both invoices paid by a tmtest charge", !!first.chargeId && !!second.chargeId);

const plain = await createGatewayAccount({
  organizationId: orgId,
  businessId: biz.id,
  gatewayKey: "tmtest",
  label: "No report",
  credentials: {},
  currencies: ["EUR"],
});
const disabled = await createGatewayAccount({
  organizationId: orgId,
  businessId: biz.id,
  gatewayKey: "tmtest",
  label: "Disabled",
  credentials: { settlement_report: "true" },
  currencies: ["EUR"],
});
await withTenant(orgId, (tx) =>
  tx.update(gatewayAccounts).set({ status: "disabled" }).where(eq(gatewayAccounts.id, disabled.id)),
);

const poll = (now: Date, opts?: Parameters<typeof pollGatewaySettlementReports>[1]) =>
  runWithClockScope({ onlyBusinessId: biz.id, now }, () => pollGatewaySettlementReports(now, opts));
const cursorOf = async (id: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx
        .select({ c: gatewaySettlementCursors.polledUntil })
        .from(gatewaySettlementCursors)
        .where(eq(gatewaySettlementCursors.gatewayAccountId, id)),
    )
  )[0]?.c ?? null;
const txnFor = async (chargeId: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(transactions)
        .where(and(eq(transactions.businessId, biz.id), eq(transactions.idAtGateway, chargeId))),
    )
  ).find((t) => t.type === "payment");
const reversalPostings = async (txnPublicId: string) =>
  new Set(
    (
      await withTenant(orgId, (tx) =>
        tx
          .select({ t: ledgerEntries.transactionId })
          .from(ledgerEntries)
          .where(
            and(
              eq(ledgerEntries.sourceType, "payment_reversal"),
              eq(ledgerEntries.sourceId, txnPublicId),
            ),
          ),
      )
    ).map((r) => r.t),
  ).size;
const cash = () => accountBalance(orgId, biz.id, "cash", "USD");

ok("the billing clock declares the pass", TICK_PASSES.includes("settlement_reports" as never));

// ── 1. first pass: reads the last maxWindowHours, cursor moves to now ──────────────────
const now1 = new Date(T0.getTime() + MIN);
const p1 = await poll(now1);
ok(
  "only the active capable account is polled (no capability / disabled are skipped)",
  p1.capable === 1 && p1.polled === 1,
  JSON.stringify(p1),
);
ok(
  "a never-polled account's cursor advances to now",
  (await cursorOf(main.id))?.getTime() === now1.getTime(),
);

// ── 2. not due before intervalMinutes ─────────────────────────────────────────────────
const p2 = await poll(new Date(now1.getTime() + 14 * MIN));
ok("not polled again before intervalMinutes (15)", p2.polled === 0, JSON.stringify(p2));
ok("…and the cursor does not move", (await cursorOf(main.id))?.getTime() === now1.getTime());

// ── 3. a returned charge runs the late-failure path ───────────────────────────────────
const cashBefore = await cash();
await TmtestProvider.returnCharge(first.chargeId, {
  occurredAt: new Date(now1.getTime() + 5 * MIN),
  code: "R01",
});
const now2 = new Date(now1.getTime() + 15 * MIN);
const p3 = await poll(now2);
ok(
  "the return is reported and processed",
  p3.events === 1 && p3.processed === 1,
  JSON.stringify(p3),
);
const t1 = await txnFor(first.chargeId);
ok("returned charge: transaction late_failed", t1?.status === "late_failed", t1?.status);
const [pay1] = await withTenant(orgId, (tx) =>
  tx.select().from(payments).where(eq(payments.id, first.payment.id)),
);
ok(
  "returned charge: payment failed as late_failure",
  pay1?.status === "failed" && pay1?.failureCode === "late_failure",
  `${pay1?.status}/${pay1?.failureCode}`,
);
const [inv1] = await withTenant(orgId, (tx) =>
  tx.select().from(invoices).where(eq(invoices.id, first.invoice.id)),
);
ok("returned charge: invoice reopened (payment_due)", inv1?.status === "payment_due", inv1?.status);
ok("returned charge: one payment_reversal posting", (await reversalPostings(t1!.publicId)) === 1);
ok("returned charge: cash reversed", (await cash()) === cashBefore - 10000n);
// `provider_events` is the platform-global log (no RLS).
const [logged] = await systemDb
  .select()
  .from(providerEvents)
  .where(
    and(
      eq(providerEvents.businessId, biz.id),
      eq(providerEvents.transactionPublicId, t1!.publicId),
    ),
  );
ok(
  "the event is logged as polled, with the report's payload",
  !!logged?.requestUrl?.startsWith(`poll:settlement_report?account=${main.publicId}`) &&
    (logged?.payload as { data?: { source?: string } })?.data?.source === "settlement_report" &&
    logged?.outcome === "processed",
  `${logged?.requestUrl} ${logged?.outcome}`,
);
ok("the cursor advances past the window", (await cursorOf(main.id))?.getTime() === now2.getTime());

// ── 4. the overlap re-reads the same event; dedupe drops it ──────────────────────────
const now3 = new Date(now2.getTime() + 15 * MIN);
ok(
  "fixture: the return sits inside the next window's overlap",
  now1.getTime() + 5 * MIN >= now2.getTime() - SETTLEMENT_POLL_OVERLAP_MS,
);
const p4 = await poll(now3);
ok(
  "the same event in an overlapping window is a duplicate",
  p4.events === 1 && p4.duplicates === 1 && p4.processed === 0,
  JSON.stringify(p4),
);
ok("…and books nothing twice", (await reversalPostings(t1!.publicId)) === 1);
ok("…and cash is not reversed again", (await cash()) === cashBefore - 10000n);
ok("the cursor still advances", (await cursorOf(main.id))?.getTime() === now3.getTime());

// ── 5. a handler error keeps the cursor; the next pass retries ───────────────────────
await TmtestProvider.returnCharge(second.chargeId, {
  occurredAt: new Date(now3.getTime() + 5 * MIN),
  code: "R02",
});
const now4 = new Date(now3.getTime() + 15 * MIN);
const p5 = await poll(now4, { handle: async () => "error" });
ok(
  "a handler error fails the window",
  p5.failed === 1 && p5.errors.length === 1,
  JSON.stringify(p5),
);
ok("…and leaves the cursor where it was", (await cursorOf(main.id))?.getTime() === now3.getTime());
const p5b = await poll(now4, {
  handle: async () => {
    throw new Error("handler blew up");
  },
});
ok("a throwing handler fails the window too", p5b.failed === 1, JSON.stringify(p5b));
ok("…and leaves the cursor too", (await cursorOf(main.id))?.getTime() === now3.getTime());
const p6 = await poll(now4);
ok("the next pass retries the window and processes it", p6.processed === 1, JSON.stringify(p6));
const t2 = await txnFor(second.chargeId);
ok("retried return: transaction late_failed", t2?.status === "late_failed", t2?.status);
ok("…and the cursor advances", (await cursorOf(main.id))?.getTime() === now4.getTime());

// ── 6. one throwing account does not stop another ─────────────────────────────────────
// Never polled, so it sorts first (nulls first) and throws before `main` is reached.
const faulty = await createGatewayAccount({
  organizationId: orgId,
  businessId: biz.id,
  gatewayKey: "tmtest",
  label: "Report down",
  credentials: { settlement_report: "fault" },
  currencies: ["EUR"],
});
const now5 = new Date(now4.getTime() + 15 * MIN);
const p7 = await poll(now5);
ok(
  "a throwing account is recorded as failed",
  p7.failed === 1 && p7.errors[0]?.business === biz.id,
  JSON.stringify(p7),
);
ok("…its cursor stays unset", (await cursorOf(faulty.id)) === null);
ok(
  "…and the account after it is still polled",
  (await cursorOf(main.id))?.getTime() === now5.getTime(),
);

// ── 7. wired into the billing clock ───────────────────────────────────────────────────
const now6 = new Date(now5.getTime() + 15 * MIN);
await runWithClockScope({ onlyBusinessId: biz.id, now: now6 }, () =>
  runBillingClockTickOnce(() => {}, now6),
);
ok(
  "a clock tick runs the pass (cursor advances)",
  (await cursorOf(main.id))?.getTime() === now6.getTime(),
);

// ── 8. a polled dispute on a charge this business never made is not booked ─────────────
// A poll reads everything under the API key; another business on the same key owns it.
const { handleProviderEvent } = await import("@/modules/webhooks/inbound");
const { disputes: disputesT } = await import("@db/schema");
const foreignDispute = (id: string) => ({
  providerEventId: `evt_poll_foreign_${id}`,
  type: "dispute.funds_withdrawn" as const,
  providerDisputeId: `dp_foreign_${id}`,
  providerChargeId: `ch_foreign_${id}`,
  disputeAmountMinor: 1234n,
  disputeCurrency: "USD",
  occurredAt: new Date(),
  raw: {},
});
const cashForeign = await cash();
const polledResult = await handleProviderEvent("tmtest", foreignDispute(`p_${T0.getTime()}`), {
  businessId: biz.id,
  polled: true,
});
const polledRows = await withTenant(orgId, (tx) =>
  tx
    .select()
    .from(disputesT)
    .where(eq(disputesT.providerDisputeId, `dp_foreign_p_${T0.getTime()}`)),
);
ok(
  "a polled dispute on a foreign charge is ignored: no dispute row, no clawback",
  polledResult === "ignored" && polledRows.length === 0 && (await cash()) === cashForeign,
  `${polledResult} rows=${polledRows.length}`,
);
const deliveredResult = await handleProviderEvent("tmtest", foreignDispute(`d_${T0.getTime()}`), {
  businessId: biz.id,
});
ok(
  "a DELIVERED dispute on an unknown charge is still recorded under its business",
  deliveredResult === "processed",
  deliveredResult,
);

// ── untouched ─────────────────────────────────────────────────────────────────────────
ok("an account without the capability is never polled", (await cursorOf(plain.id)) === null);
ok("a disabled account is never polled", (await cursorOf(disabled.id)) === null);

let pass = true;
for (const [n, c, d] of checks) {
  console.log(` ${c ? "✓" : "✗"} ${n}${!c && d ? `  [${d}]` : ""}`);
  if (!c) pass = false;
}
console.log("");
console.log(pass ? "✅ SETTLEMENT REPORT POLL: PASS" : "❌ SETTLEMENT REPORT POLL: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);

/**
 * Proves API refunds and charge.refunded webhooks don't double-count the ledger:
 *  1. API partial refund $30 → cash 7000.
 *  2. webhook for THAT SAME provider refund → reconciled, ledger unchanged (cash 7000).
 *  3. out-of-band webhook refund (new provider refund id, +$20) → booked once, cash 5000.
 *  4. the SAME provider refund id in ANOTHER org → still books (tenant isolation).
 *
 *   pnpm verify:refund-reconciliation
 *
 * Re-runnable against the same database (`RUN` below) — it was not, until 2026-08-21.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { refundPayment } from "@/modules/refunds/service";
import { handleProviderEvent } from "@/modules/webhooks/inbound";
import { ledgerEntries, refunds, transactions } from "@db/schema";

/**
 * Same salt-per-run rule as `verify-disputes.ts`, for the same reason plus a second one
 * unique to refunds. TWO global lookups made a literal id here a time bomb:
 *
 *  - `provider_events` dedups on (provider_key, provider_event_id) PLATFORM-GLOBALLY, so a
 *    reused event id comes back `duplicate` — the dedup working, indistinguishable from a
 *    broken reconciler.
 *  - `applyRefund`'s "already booked this provider refund?" check used to match
 *    `refunds.provider_refund_id` across the WHOLE table, so a reused out-of-band refund
 *    id came back `ignored`. That one was a real bug, not just a test problem — §4 below
 *    is its regression test — and the check is now scoped to the payment.
 *
 * Both together made this suite pass exactly once per fresh DB and report a false
 * regression on every run after, which is worse than failing outright.
 */
const RUN = randomUUID().slice(0, 8);

/** An org with one $100 subscription, billed and paid. Returns the payment to refund. */
async function mintPaidSubscription(label: string) {
  const org = await createOrganization({ name: `Reconcile ${label}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `r_${label}_${RUN}@a.com`,
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
    // Non-null by construction: this fixture creates a subscription with NO trial, so it
    // starts `active` with a term. A trialling subscription has none (2026-08-25).
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  return { orgId, businessId: biz.id, customerId: customer.id, payment: payment! };
}

const cash = (orgId: string) =>
  withTenant(orgId, async (tx) => {
    const rows = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.account, "cash"));
    return rows.reduce(
      (s, r) => s + (r.direction === "debit" ? r.amountMinor : -r.amountMinor),
      0n,
    );
  });
const refundCount = (orgId: string, paymentId: string) =>
  withTenant(
    orgId,
    async (tx) => (await tx.select().from(refunds).where(eq(refunds.paymentId, paymentId))).length,
  );

const a = await mintPaidSubscription("OrgA");

// 1) API partial refund $30.
const r1 = await refundPayment({
  organizationId: a.orgId,
  businessId: a.businessId,
  paymentPublicId: a.payment.publicId,
  amountMinor: 3000,
});
const cashAfterApi = await cash(a.orgId);
console.log(
  `1) API refund $30 → cash ${cashAfterApi} (expect 7000), provider_refund=${r1.providerRefundId?.slice(0, 10)}…`,
);

// 2) Webhook for the SAME provider refund → must reconcile (no double count).
const dup = await handleProviderEvent("tmtest", {
  providerEventId: `evt_dup_${RUN}`,
  type: "charge.refunded",
  providerChargeId: a.payment.providerChargeId!,
  providerRefundId: r1.providerRefundId!, // same refund the API created
  amountRefundedMinor: 3000n,
  occurredAt: new Date(),
  raw: {},
});
const cashAfterDup = await cash(a.orgId);
console.log(
  `2) webhook (same refund) → ${dup}; cash ${cashAfterDup} (expect 7000, unchanged); refunds=${await refundCount(a.orgId, a.payment.id)} (expect 1)`,
);

// 3) Out-of-band webhook refund (+$20, new provider refund id).
const oobRefundId = `tmrf_dashboard_${RUN}`;
const oob = await handleProviderEvent("tmtest", {
  providerEventId: `evt_oob_${RUN}`,
  type: "charge.refunded",
  providerChargeId: a.payment.providerChargeId!,
  providerRefundId: oobRefundId,
  amountRefundedMinor: 5000n, // total refunded now reported as 5000 (3000 already booked → +2000)
  occurredAt: new Date(),
  raw: {},
});
const cashAfterOob = await cash(a.orgId);
const finalRefunds = await refundCount(a.orgId, a.payment.id);
console.log(
  `3) out-of-band webhook → ${oob}; cash ${cashAfterOob} (expect 5000); refunds=${finalRefunds} (expect 2)`,
);

// 4) TENANT ISOLATION (regression, 2026-08-21).
//
// `applyRefund`'s "already booked this provider refund?" check used to match
// `refunds.provider_refund_id` across the entire table — no payment, no provider, no
// org. So the moment ANY tenant had booked an id, the identical id arriving for a
// DIFFERENT tenant's charge was answered `ignored`, and a real out-of-band refund never
// reached that org's ledger. Provider refund ids are only unique within a provider
// account, and a shared/sandbox account makes the collision ordinary rather than exotic.
//
// Same id as §3, different org and different charge. It must book.
const b = await mintPaidSubscription("OrgB");
const crossTenant = await handleProviderEvent("tmtest", {
  providerEventId: `evt_xtenant_${RUN}`,
  type: "charge.refunded",
  providerChargeId: b.payment.providerChargeId!,
  providerRefundId: oobRefundId, // ← the id org A already booked in §3
  amountRefundedMinor: 2000n,
  occurredAt: new Date(),
  raw: {},
});
const cashB = await cash(b.orgId);
const refundsB = await refundCount(b.orgId, b.payment.id);
console.log(
  `4) same refund id, other org → ${crossTenant}; cash ${cashB} (expect 8000); refunds=${refundsB} (expect 1)`,
);
// And org A is untouched by org B's booking.
const cashAAfter = await cash(a.orgId);

// Belt and braces: the two orgs really do hold rows with the SAME provider refund id,
// which is the condition the old global lookup could not survive.
const sharedId = await withTenant(b.orgId, (tx) =>
  tx
    .select()
    .from(refunds)
    .where(and(eq(refunds.providerRefundId, oobRefundId), eq(refunds.paymentId, b.payment.id))),
);

// 5) CONCURRENT DELIVERIES (regression, 2026-10-27). Two refund events for one payment,
// processed at the same moment, each read "nothing recorded" and both booked: $30 on a $25
// payment, measured live. Both report the running total (1500); one booking must stand.
const c = await mintPaidSubscription("OrgC");
const [c1, c2] = await Promise.all(
  ["a", "b"].map((k) =>
    handleProviderEvent("tmtest", {
      providerEventId: `evt_race_${k}_${RUN}`,
      type: "charge.refunded",
      providerChargeId: c.payment.providerChargeId!,
      providerRefundId: `tmrf_race_${k}_${RUN}`,
      amountRefundedMinor: 1500n,
      occurredAt: new Date(),
      raw: {},
    }),
  ),
);
const cashC = await cash(c.orgId);
console.log(`5) two concurrent out-of-band events → ${c1}/${c2}; cash ${cashC} (expect 8500)`);

// 6) The same refund delivered twice at once (two event ids): booked once.
const d = await mintPaidSubscription("OrgD");
await Promise.all(
  ["x", "y"].map((k) =>
    handleProviderEvent("tmtest", {
      providerEventId: `evt_dupe_${k}_${RUN}`,
      type: "charge.refunded",
      providerChargeId: d.payment.providerChargeId!,
      providerRefundId: `tmrf_dupe_${RUN}`,
      amountRefundedMinor: 2000n,
      occurredAt: new Date(),
      raw: {},
    }),
  ),
);
const cashD = await cash(d.orgId);
const refundsD = await refundCount(d.orgId, d.payment.id);
console.log(
  `6) one refund delivered twice at once → cash ${cashD} (expect 8000); refunds=${refundsD} (expect 1)`,
);

// 7) Invoice and payment ledger lines carry the customer, as refund lines already did.
const custLines = await withTenant(a.orgId, (tx) =>
  tx
    .select()
    .from(ledgerEntries)
    .where(inArray(ledgerEntries.sourceType, ["invoice", "payment"])),
);
const custOk = custLines.length > 0 && custLines.every((l) => l.customerId === a.customerId);
console.log(
  `7) invoice/payment ledger lines with the customer → ${custLines.filter((l) => l.customerId === a.customerId).length}/${custLines.length}`,
);

// 8) A refund made outside us that carries the SALE's ref (a gateway copies the order id
// onto the refund): booked once. Only a refund's own ref (`re_…`) means "ours, in flight".
const e = await mintPaidSubscription("OrgE");
const inherited = await handleProviderEvent("tmtest", {
  providerEventId: `evt_inherited_${RUN}`,
  type: "charge.refunded",
  providerChargeId: e.payment.providerChargeId!,
  refunds: [
    {
      providerRefundId: `tmrf_inherited_${RUN}`,
      amountMinor: 2000n,
      status: "succeeded",
      ownershipRef: e.payment.publicId.replace(/^pay_/, "inv_"),
    },
  ],
  occurredAt: new Date(),
  raw: {},
});
const cashE = await cash(e.orgId);
const refundsE = await refundCount(e.orgId, e.payment.id);
const ours = await handleProviderEvent("tmtest", {
  providerEventId: `evt_ours_inflight_${RUN}`,
  type: "charge.refunded",
  providerChargeId: e.payment.providerChargeId!,
  refunds: [
    {
      providerRefundId: `tmrf_ours_${RUN}`,
      amountMinor: 1000n,
      status: "succeeded",
      ownershipRef: `re_inflight_${RUN}`,
    },
  ],
  occurredAt: new Date(),
  raw: {},
});
const cashE2 = await cash(e.orgId);
console.log(
  `8) refund with the sale's ref → ${inherited}; cash ${cashE} (expect 8000), refunds=${refundsE} (expect 1); with an in-flight refund ref → ${ours}, cash ${cashE2} (expect 8000)`,
);

// 9) An out-of-band refund that does not fit only because a refund of ours is still
// pending: asked again later (error → redelivered), never dropped. Once ours is refused,
// the redelivery books it.
const f = await mintPaidSubscription("OrgF");
const held = await refundPayment({
  organizationId: f.orgId,
  businessId: f.businessId,
  paymentPublicId: f.payment.publicId,
  amountMinor: 9917, // tmtest: an amount ending in 17 is accepted but unsettled
});
const oobEvent = {
  providerEventId: `evt_oob_while_pending_${RUN}`,
  type: "charge.refunded" as const,
  providerChargeId: f.payment.providerChargeId!,
  refunds: [
    {
      providerRefundId: `tmrf_oob_pending_${RUN}`,
      amountMinor: 1000n,
      status: "succeeded" as const,
    },
  ],
  occurredAt: new Date(),
  raw: {},
};
const whilePending = await handleProviderEvent("tmtest", oobEvent);
await handleProviderEvent("tmtest", {
  providerEventId: `evt_ours_refused_${RUN}`,
  type: "refund.failed",
  providerRefundId: held.providerRefundId!,
  occurredAt: new Date(),
  raw: {},
});
const redelivered = await handleProviderEvent("tmtest", oobEvent);
const cashF = await cash(f.orgId);
console.log(
  `9) out-of-band refund while ours is pending → ${held.status}/${whilePending}; after ours is refused → ${redelivered}; cash ${cashF} (expect 9000)`,
);

// 10) A refund made outside us is on the Transactions list: one refund transaction, linked
// to its refund row, at its own amount; a later refund.failed flips it.
const refundTxns = (orgId: string, providerRefundId: string) =>
  withTenant(orgId, async (tx) => {
    const [r] = await tx
      .select()
      .from(refunds)
      .where(eq(refunds.providerRefundId, providerRefundId))
      .limit(1);
    if (!r) return [];
    return tx.select().from(transactions).where(eq(transactions.refundId, r.id));
  });
const oobTxns = await refundTxns(b.orgId, oobRefundId);
const txnOk =
  oobTxns.length === 1 &&
  oobTxns[0]!.type === "refund" &&
  oobTxns[0]!.status === "succeeded" &&
  oobTxns[0]!.amountMinor === 2000n &&
  oobTxns[0]!.idAtGateway === oobRefundId;
await handleProviderEvent(
  "tmtest",
  {
    providerEventId: `evt_oob_refund_failed_${RUN}`,
    type: "refund.failed",
    providerRefundId: oobRefundId,
    providerChargeId: b.payment.providerChargeId!,
    occurredAt: new Date(),
    raw: {},
  },
  { businessId: b.businessId },
);
const failedTxns = await refundTxns(b.orgId, oobRefundId);
// Org A holds a refund with the SAME gateway id (§4); org B's failure must not touch it.
const otherOrg = await refundTxns(a.orgId, oobRefundId);
const cashAFinal = await cash(a.orgId);
const txnFailedOk =
  failedTxns.length === 1 &&
  failedTxns[0]!.status === "failed" &&
  otherOrg.length === 1 &&
  otherOrg[0]!.status === "succeeded" &&
  cashAFinal === 5000n;
console.log(
  `10) out-of-band refund transaction → ${oobTxns.map((t) => `${t.type}/${t.status}/${t.amountMinor}`).join(",") || "none"}; after refund.failed → ${failedTxns.map((t) => t.status).join(",")}; same id in org A → ${otherOrg.map((t) => t.status).join(",")}, cash ${cashAFinal} (expect 5000)`,
);

const pass =
  cashAfterApi === 7000n &&
  dup === "ignored" &&
  cashAfterDup === 7000n &&
  oob === "processed" &&
  cashAfterOob === 5000n &&
  finalRefunds === 2 &&
  crossTenant === "processed" &&
  cashB === 8000n &&
  refundsB === 1 &&
  sharedId.length === 1 &&
  cashAAfter === 5000n &&
  cashC === 8500n &&
  cashD === 8000n &&
  refundsD === 1 &&
  custOk &&
  inherited === "processed" &&
  cashE === 8000n &&
  refundsE === 1 &&
  ours === "ignored" &&
  cashE2 === 8000n &&
  held.status === "pending" &&
  whilePending === "error" &&
  redelivered === "processed" &&
  cashF === 9000n &&
  txnOk &&
  txnFailedOk;

console.log("");
console.log(
  pass
    ? "✅ REFUND RECONCILIATION: PASS (no double-count, tenant-isolated)"
    : "❌ REFUND RECONCILIATION: FAIL",
);
await closeDb();
process.exit(pass ? 0 : 1);

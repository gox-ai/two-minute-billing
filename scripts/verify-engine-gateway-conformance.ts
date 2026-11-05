/**
 * Engine fixes every gateway relies on (gateway plan 3d), through the real webhook and engine
 * paths on the test gateway:
 *
 *  - § R per-refund records: two out-of-band partials, a redelivery, a failure of one, a
 *        lost-answer refund of ours, the cap, and a payment request's charge
 *  - § L lost answers: the sweep finds a charge by our ref, fails one never created after the
 *        window, alerts once where there is no lookup; the webhook matches by ownership ref;
 *        a `timeout` row with a stranded gateway id is read by that id
 *  - § D dispute money: win after loss, partial wins, two disputes on one payment, a refund
 *        then a dispute, late reversal before and after a withdrawal, operator outcome on a
 *        gateway dispute
 *  - § V late reversals take only what the payment still holds: after refunds, a withdrawal,
 *        a stated amount, and on a payment request's charge
 *  - § C conventions: a refund refusal releases the reservation; one late-reversal flag
 *  - § M mandate currency: a mandate is never debited in another currency (audit C1)
 *
 * After every scenario: each ledger transaction balances, cash equals collected less what was
 * refunded or taken, and a redelivery posts nothing.
 *
 *   pnpm verify:engine-gateway-conformance
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, systemDb, closeDb } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod, invoiceOutstanding } from "@/modules/invoicing/service";
import { refundPayment, RefundError } from "@/modules/refunds/service";
import { handleProviderEvent } from "@/modules/webhooks/inbound";
import { sweepStalePendingCharges } from "@/modules/payments/stale-pending";
import { accountBalance } from "@/modules/ledger/service";
import { TmtestProvider } from "@/providers/tmtest";
import { createPaymentIntent, PaymentIntentError } from "@/modules/payment-intents/service";
import {
  ProviderIndeterminateError,
  ProviderRefusalError,
  type ChargeResult,
  type NormalizedProviderEvent,
  type ProviderRefundRecord,
} from "@/providers/types";
import {
  businesses,
  disputes,
  invoices,
  ledgerEntries,
  paymentMethods,
  paymentRequests,
  payments,
  refunds,
  transactions,
} from "@db/schema";

const app = await buildApp({ logger: false });
const RUN = randomUUID().slice(0, 8);
const checks: [string, boolean][] = [];
const ok = (name: string, cond: boolean, detail?: unknown) => {
  checks.push([name, cond]);
  if (!cond && detail !== undefined) console.log(`   ✗ ${name} — ${String(detail)}`);
};
/** A scenario that throws (e.g. a column or module missing) fails, and the run goes on. */
async function section(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    ok(`${name}: ran without throwing`, false, (e as Error)?.stack ?? e);
  }
}

const org = await createOrganization({ name: `Engine conformance ${RUN}` });
const orgId = org.organization.id;
let ev = 0;
const evId = (tag: string) => `ev_${tag}_${RUN}_${ev++}`;

/** A fresh business: its cash account is this scenario's alone. */
async function scenario(label: string) {
  const biz = await createBusiness({
    organizationId: orgId,
    name: `EGC ${label}`,
    defaultCurrency: "USD",
    livemode: "test",
  });
  // Charges in this suite are made on purpose, never by a card being added.
  await systemDb
    .update(businesses)
    .set({ dunningConfig: { collect_on_payment_method_update: false } })
    .where(eq(businesses.id, biz.id));
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
  const bill = async (token = "tok_4242") => {
    const customer = await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: `${label}-${ev++}-${RUN}@example.com`,
    });
    const pm = await vaultPaymentMethod({
      organizationId: orgId,
      businessId: biz.id,
      customer,
      token,
    });
    const sub = await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
      defaultPaymentMethodId: pm.id,
    });
    const res = await billSubscriptionPeriod({
      organizationId: orgId,
      businessId: biz.id,
      subscription: sub.subscription,
      periodStart: sub.subscription.currentPeriodStart!,
      periodEnd: sub.subscription.currentPeriodEnd!,
    });
    return { ...res, customer, pm };
  };
  const cash = () => accountBalance(orgId, biz.id, "cash", "USD");
  const bal = (account: string) => accountBalance(orgId, biz.id, account, "USD");
  const entries = async () =>
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(ledgerEntries).where(eq(ledgerEntries.businessId, biz.id)),
      )
    ).length;
  const deliver = (e: Omit<NormalizedProviderEvent, "occurredAt" | "raw"> & { raw?: unknown }) =>
    handleProviderEvent(
      "tmtest",
      { occurredAt: new Date(), raw: {}, ...e } as NormalizedProviderEvent,
      { businessId: biz.id },
    );
  /** Every ledger transaction of this business balances. */
  const balanced = async () => {
    const rows = await withTenant(orgId, (tx) =>
      tx.select().from(ledgerEntries).where(eq(ledgerEntries.businessId, biz.id)),
    );
    const net = new Map<string, bigint>();
    for (const r of rows)
      net.set(
        `${r.transactionId}:${r.currency}`,
        (net.get(`${r.transactionId}:${r.currency}`) ?? 0n) +
          (r.direction === "debit" ? r.amountMinor : -r.amountMinor),
      );
    return [...net.values()].every((v) => v === 0n);
  };
  return { biz, bill, cash, bal, entries, deliver, balanced };
}

const refundRows = (paymentId: string) =>
  withTenant(orgId, (tx) => tx.select().from(refunds).where(eq(refunds.paymentId, paymentId)));
const txnOf = async (invoiceId: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(transactions)
        .where(and(eq(transactions.invoiceId, invoiceId), eq(transactions.type, "payment"))),
    )
  )[0]!;
const invoiceRow = async (id: string) =>
  (await withTenant(orgId, (tx) => tx.select().from(invoices).where(eq(invoices.id, id))))[0]!;
const disputeRow = async (providerDisputeId: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx.select().from(disputes).where(eq(disputes.providerDisputeId, providerDisputeId)),
    )
  )[0]!;
const rec = (
  providerRefundId: string,
  amountMinor: bigint,
  status: ProviderRefundRecord["status"],
  ownershipRef?: string,
): ProviderRefundRecord => ({
  providerRefundId,
  amountMinor,
  status,
  ...(ownershipRef ? { ownershipRef } : {}),
});
const sweepAt = (bizId: string, at: Date) =>
  runWithClockScope({ onlyBusinessId: bizId }, () => sweepStalePendingCharges(at));
const later = (ms: number) => new Date(Date.now() + ms);

// ═══ § R — per-refund records ═══════════════════════════════════════════════════════════
await section("R1 out-of-band partials", async () => {
  const s = await scenario("r1");
  const { payment } = await s.bill();
  const charge = payment!.providerChargeId!;
  const cash0 = await s.cash();
  const refunded = (refunds: ProviderRefundRecord[]) =>
    s.deliver({
      providerEventId: evId("r1"),
      type: "charge.refunded",
      providerChargeId: charge,
      refunds,
    });
  await refunded([rec(`re_a_${RUN}`, 3000n, "succeeded")]);
  await refunded([rec(`re_b_${RUN}`, 2000n, "pending")]);
  ok("R1: a pending out-of-band refund books nothing", (await s.cash()) === cash0 - 3000n);
  await refunded([rec(`re_b_${RUN}`, 2000n, "succeeded")]);
  ok("R1: two out-of-band partials book 3000 + 2000", (await s.cash()) === cash0 - 5000n);
  const n = await s.entries();
  await refunded([rec(`re_a_${RUN}`, 3000n, "succeeded"), rec(`re_b_${RUN}`, 2000n, "succeeded")]);
  ok("R1: a redelivery naming both posts nothing", (await s.entries()) === n);
  await refunded([rec(`re_b_${RUN}`, 2000n, "failed")]);
  const rows = await refundRows(payment!.id);
  ok(
    "R1: a failed record reverses that refund by id (cash back to −3000)",
    (await s.cash()) === cash0 - 3000n &&
      rows.find((r) => r.providerRefundId === `re_b_${RUN}`)?.status === "failed",
    `cash=${(await s.cash()) - cash0} rows=${rows.map((r) => `${r.providerRefundId}:${r.status}`)}`,
  );
  const n2 = await s.entries();
  await refunded([rec(`re_b_${RUN}`, 2000n, "failed")]);
  ok("R1: the failure redelivered reverses nothing twice", (await s.entries()) === n2);
  await refunded([rec(`re_c_${RUN}`, 9000n, "succeeded")]);
  ok(
    "R1: an out-of-band refund is capped at what remains (7000)",
    (await s.cash()) === cash0 - 10000n,
  );
  ok("R1: the ledger balances", await s.balanced());
});

await section("R2 our refund with a lost answer", async () => {
  const s = await scenario("r2");
  const { payment } = await s.bill();
  const proto = TmtestProvider.prototype as unknown as Record<string, unknown>;
  const realRefund = proto.refund;
  const hadLocate = Object.prototype.hasOwnProperty.call(proto, "locateRefund");
  proto.refund = async () => {
    throw new ProviderIndeterminateError("tmtest: refund timed out");
  };
  proto.locateRefund = async () => null;
  const cash0 = await s.cash();
  try {
    await refundPayment({
      organizationId: orgId,
      businessId: s.biz.id,
      paymentPublicId: payment!.publicId,
      amountMinor: 4000,
    });
  } finally {
    proto.refund = realRefund;
    if (!hadLocate) delete proto.locateRefund;
  }
  const [ours] = await refundRows(payment!.id);
  ok(
    "R2: a lost answer books the refund pending with no gateway id",
    ours?.status === "pending" && !ours.providerRefundId && (await s.cash()) === cash0 - 4000n,
  );
  await s.deliver({
    providerEventId: evId("r2"),
    type: "charge.refunded",
    providerChargeId: payment!.providerChargeId!,
    refunds: [rec(`re_lost_${RUN}`, 4000n, "succeeded", ours!.publicId)],
  });
  const [after] = await refundRows(payment!.id);
  ok(
    "R2: the record adopts the id by our tag and settles it, booking nothing twice",
    after?.status === "succeeded" &&
      after.providerRefundId === `re_lost_${RUN}` &&
      (await s.cash()) === cash0 - 4000n,
    `${after?.status} ${after?.providerRefundId} cash=${(await s.cash()) - cash0}`,
  );
  ok("R2: the ledger balances", await s.balanced());
});

/** Two open 50.00 invoices, then a request charging both to a card with `token`. */
async function chargedRequest(s: Awaited<ReturnType<typeof scenario>>, tag: string, token: string) {
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: s.biz.id,
    email: `${tag}-${RUN}@example.com`,
  });
  const bad = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: s.biz.id,
    customer,
    token: "4000000000009995",
  });
  const product = await createProduct({ organizationId: orgId, businessId: s.biz.id, name: "Req" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: s.biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const invs: string[] = [];
  for (let i = 0; i < 2; i++) {
    const sub = await createSubscription({
      organizationId: orgId,
      businessId: s.biz.id,
      customerId: customer.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
      defaultPaymentMethodId: bad.id,
    });
    const { invoice } = await billSubscriptionPeriod({
      organizationId: orgId,
      businessId: s.biz.id,
      subscription: sub.subscription,
      periodStart: sub.subscription.currentPeriodStart!,
      periodEnd: sub.subscription.currentPeriodEnd!,
    });
    invs.push(invoice.publicId);
  }
  const good = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: s.biz.id,
    customer,
    token,
  });
  const res = await app.inject({
    method: "POST",
    url: `/v1/businesses/${s.biz.publicId}/customers/${customer.publicId}/payment_requests`,
    headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": `${tag}-${RUN}` },
    payload: { invoices: invs, mode: "charge", payment_method: good.publicId },
  });
  const reqId = (JSON.parse(res.body) as { id?: string }).id;
  const [req] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.publicId, reqId ?? "")),
  );
  return { req, res };
}

await section("R3 a payment request's charge", async () => {
  const s = await scenario("r3");
  const { req, res } = await chargedRequest(s, "r3", "tok_4242");
  ok("R3: the request was charged", !!req?.providerChargeId, res.body);
  const cash0 = await s.cash();
  await s.deliver({
    providerEventId: evId("r3"),
    type: "charge.refunded",
    providerChargeId: req!.providerChargeId!,
    refunds: [rec(`re_req_${RUN}`, 1500n, "succeeded")],
  });
  ok(
    "R3: a per-refund record on a request books its own amount, not the whole charge",
    (await s.cash()) === cash0 - 1500n,
    `cash delta ${(await s.cash()) - cash0}`,
  );
  const n = await s.entries();
  await s.deliver({
    providerEventId: evId("r3"),
    type: "charge.refunded",
    providerChargeId: req!.providerChargeId!,
    refunds: [rec(`re_req_${RUN}`, 1500n, "succeeded")],
  });
  ok("R3: its redelivery posts nothing", (await s.entries()) === n);
  await s.deliver({
    providerEventId: evId("r3"),
    type: "charge.refunded",
    providerChargeId: req!.providerChargeId!,
    refunds: [rec(`re_req_${RUN}`, 1500n, "failed")],
  });
  ok("R3: its failure reverses it", (await s.cash()) === cash0);
  ok("R3: the ledger balances", await s.balanced());
});

// ═══ § L — lost answers ═════════════════════════════════════════════════════════════════
await section("L1 sweep finds a charge by our ref", async () => {
  const s = await scenario("l1");
  const cash0 = await s.cash();
  const { invoice } = await s.bill("tok_4000000000000127");
  const t0 = (await txnOf(invoice.id)) as Record<string, unknown> & { status: string };
  ok(
    "L1: a lost answer books `timeout` with no gateway id, and keeps our ref, key and account",
    t0.status === "timeout" &&
      !t0.idAtGateway &&
      t0.ownershipRef === invoice.publicId &&
      typeof t0.idempotencyKey === "string" &&
      !!t0.gatewayAccountId,
    JSON.stringify({
      s: t0.status,
      id: t0.idAtGateway,
      ref: t0.ownershipRef,
      key: t0.idempotencyKey,
      acc: t0.gatewayAccountId,
    }),
  );
  await sweepAt(s.biz.id, later(2 * 60_000));
  ok(
    "L1: inside the grace period nothing is asked",
    (await txnOf(invoice.id)).status === "timeout",
  );
  await sweepAt(s.biz.id, later(15 * 60_000));
  const t1 = await txnOf(invoice.id);
  const [pay] = await withTenant(orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.id, t1.paymentId!)),
  );
  ok(
    "L1: the sweep adopts the gateway id and settles: txn succeeded, payment succeeded, invoice paid",
    t1.status === "succeeded" &&
      !!t1.idAtGateway &&
      pay?.providerChargeId === t1.idAtGateway &&
      pay?.status === "succeeded" &&
      (await invoiceRow(invoice.id)).status === "paid",
    `${t1.status} ${t1.idAtGateway} ${pay?.status} ${(await invoiceRow(invoice.id)).status}`,
  );
  ok("L1: cash is the charge, once", (await s.cash()) === cash0 + 10000n);
  const n = await s.entries();
  await sweepAt(s.biz.id, later(30 * 60_000));
  await s.deliver({
    providerEventId: evId("l1"),
    type: "charge.succeeded",
    providerChargeId: t1.idAtGateway!,
    amountMinor: 10000n,
  });
  ok("L1: a second sweep and the late webhook post nothing", (await s.entries()) === n);
  ok("L1: the ledger balances", await s.balanced());
});

await section("L2 never created", async () => {
  const s = await scenario("l2");
  const cash0 = await s.cash();
  const { invoice } = await s.bill("tok_4000000000000135");
  await sweepAt(s.biz.id, later(15 * 60_000));
  ok(
    "L2: not found before the window: still `timeout`, invoice still parked",
    (await txnOf(invoice.id)).status === "timeout" &&
      (await invoiceRow(invoice.id)).nextAttemptAt == null,
  );
  await sweepAt(s.biz.id, later(25 * 3_600_000));
  const t = await txnOf(invoice.id);
  const inv = await invoiceRow(invoice.id);
  ok(
    "L2: not found after 24 h: failed `gateway_charge_not_created`, retriable",
    t.status === "failed" && t.errorCode === "gateway_charge_not_created" && t.retriable === true,
    `${t.status} ${t.errorCode} ${t.retriable}`,
  );
  ok(
    "L2: dunning resumes (the invoice has a next attempt) and no cash moved",
    inv.nextAttemptAt != null && inv.status !== "paid" && (await s.cash()) === cash0,
    `${inv.status} next=${inv.nextAttemptAt?.toISOString()}`,
  );
  ok("L2: the ledger balances", await s.balanced());
});

await section("L3 webhook matches by ownership ref", async () => {
  const s = await scenario("l3");
  const cash0 = await s.cash();
  const { invoice } = await s.bill("tok_4000000000000127");
  const t0 = await txnOf(invoice.id);
  // The charge the gateway made: tmtest stored it under the idempotency key.
  const located = await new TmtestProvider(s.biz.id).locateCharge?.({
    idempotencyKey: (t0 as Record<string, unknown>).idempotencyKey as string,
  } as never);
  const chargeId = located?.providerChargeId ?? `tmch_unknown_${RUN}`;
  const capture = () =>
    s.deliver({
      providerEventId: evId("l3"),
      type: "charge.succeeded",
      providerChargeId: chargeId,
      amountMinor: 10000n,
      ownership: "ours",
      ownershipRef: invoice.publicId,
    });
  const r = await capture();
  const t1 = await txnOf(invoice.id);
  ok(
    "L3: the capture is matched by our ref and booked (not left unattributed)",
    r === "processed" && t1.status === "succeeded" && t1.idAtGateway === chargeId,
    `${r} ${t1.status} ${t1.idAtGateway}`,
  );
  ok("L3: cash is the charge", (await s.cash()) === cash0 + 10000n);
  const n = await s.entries();
  await capture();
  await sweepAt(s.biz.id, later(15 * 60_000));
  ok("L3: a redelivery and the sweep post nothing", (await s.entries()) === n);
  ok("L3: the ledger balances", await s.balanced());
});

await section("L4 a capture after `not created`", async () => {
  const s = await scenario("l4");
  const cash0 = await s.cash();
  const { invoice } = await s.bill("tok_4000000000000135");
  await sweepAt(s.biz.id, later(25 * 3_600_000));
  const r = await s.deliver({
    providerEventId: evId("l4"),
    type: "charge.succeeded",
    providerChargeId: `tmch_late_${RUN}`,
    amountMinor: 10000n,
    ownership: "ours",
    ownershipRef: invoice.publicId,
  });
  ok(
    "L4: money that arrives after all is booked, once",
    r === "processed" && (await s.cash()) === cash0 + 10000n,
    `${r} cash=${(await s.cash()) - cash0}`,
  );
  ok("L4: the ledger balances", await s.balanced());
});

await section("L5 no lookup", async () => {
  const s = await scenario("l5");
  const proto = TmtestProvider.prototype as unknown as Record<string, unknown>;
  const real = proto.locateCharge;
  proto.locateCharge = undefined;
  try {
    const { invoice } = await s.bill("tok_4000000000000127");
    const first = await sweepAt(s.biz.id, later(15 * 60_000));
    const second = await sweepAt(s.biz.id, later(5 * 3_600_000));
    const third = await sweepAt(s.biz.id, later(30 * 3_600_000));
    const f = first as unknown as Record<string, number>;
    const g = second as unknown as Record<string, number>;
    const h = third as unknown as Record<string, number>;
    ok(
      "L5: no lookup: left `timeout`, alerted on the first tick only",
      (await txnOf(invoice.id)).status === "timeout" &&
        f.lostAnswerAlerted === 1 &&
        g.lostAnswerAlerted === 0 &&
        h.lostAnswerAlerted === 0 &&
        h.lostAnswerUnsupported === 1,
      JSON.stringify([
        f.lostAnswerAlerted,
        g.lostAnswerAlerted,
        h.lostAnswerAlerted,
        h.lostAnswerUnsupported,
      ]),
    );
    ok("L5: never failed, so no new key", (await invoiceRow(invoice.id)).nextAttemptAt == null);
  } finally {
    proto.locateCharge = real;
  }
});

await section("L6 a payment request's lost answer", async () => {
  const s = await scenario("l6");
  const cash0 = await s.cash();
  const { req } = await chargedRequest(s, "l6", "tok_4000000000000127");
  const [t0] = await withTenant(orgId, (tx) =>
    tx.select().from(transactions).where(eq(transactions.paymentRequestId, req!.id)),
  );
  ok("L6: the request's charge is a lost answer", t0?.status === "timeout" && !t0.idAtGateway);
  await sweepAt(s.biz.id, later(15 * 60_000));
  const [t1] = await withTenant(orgId, (tx) =>
    tx.select().from(transactions).where(eq(transactions.paymentRequestId, req!.id)),
  );
  const [r1] = await withTenant(orgId, (tx) =>
    tx.select().from(paymentRequests).where(eq(paymentRequests.id, req!.id)),
  );
  ok(
    "L6: the sweep finds it, stamps the id on the request and books both invoices once",
    t1?.status === "succeeded" &&
      !!t1.idAtGateway &&
      r1?.providerChargeId === t1.idAtGateway &&
      (await s.cash()) === cash0 + 10000n,
    `${t1?.status} ${t1?.idAtGateway} ${r1?.providerChargeId} cash=${(await s.cash()) - cash0}`,
  );
  ok("L6: the ledger balances", await s.balanced());
});

/** Bill with the gateway making the charge but its answer lost, the adapter keeping its id. */
async function strandedBill(s: Awaited<ReturnType<typeof scenario>>, token: string) {
  const proto = TmtestProvider.prototype as unknown as Record<string, unknown>;
  const real = proto.charge as (this: unknown, input: unknown) => Promise<ChargeResult>;
  let chargeId = "";
  proto.charge = async function (this: unknown, input: unknown) {
    const r = await real.call(this, input);
    chargeId = r.providerChargeId;
    throw Object.assign(new ProviderIndeterminateError("tmtest: the answer was lost"), {
      strandedObjectId: r.providerChargeId,
    });
  };
  try {
    const res = await s.bill(token);
    return { ...res, chargeId };
  } finally {
    proto.charge = real;
  }
}

await section("L7 a stranded id: the charge went through", async () => {
  const s = await scenario("l7");
  const cash0 = await s.cash();
  const { invoice, chargeId } = await strandedBill(s, "tok_4242");
  const t0 = await txnOf(invoice.id);
  ok(
    "L7: booked `timeout` with the stranded id",
    t0.status === "timeout" && !!chargeId && t0.idAtGateway === chargeId,
    `${t0.status} ${t0.idAtGateway} ${chargeId}`,
  );
  await sweepAt(s.biz.id, later(2 * 60_000));
  ok(
    "L7: inside the grace period nothing is asked",
    (await txnOf(invoice.id)).status === "timeout",
  );
  await sweepAt(s.biz.id, later(15 * 60_000));
  const t1 = await txnOf(invoice.id);
  ok(
    "L7: the sweep reads the id and settles: txn succeeded, invoice paid, cash +10000 once",
    t1.status === "succeeded" &&
      (await invoiceRow(invoice.id)).status === "paid" &&
      (await s.cash()) === cash0 + 10000n,
    `${t1.status} ${(await invoiceRow(invoice.id)).status} cash=${(await s.cash()) - cash0}`,
  );
  const n = await s.entries();
  await sweepAt(s.biz.id, later(30 * 60_000));
  await s.deliver({
    providerEventId: evId("l7"),
    type: "charge.succeeded",
    providerChargeId: chargeId,
    amountMinor: 10000n,
  });
  ok("L7: a second sweep and the late webhook post nothing", (await s.entries()) === n);
  ok("L7: the ledger balances", await s.balanced());
});

await section("L8 a stranded id: the charge was declined", async () => {
  const s = await scenario("l8");
  const cash0 = await s.cash();
  const { invoice, chargeId } = await strandedBill(s, "tok_4000000000009995");
  ok(
    "L8: booked `timeout` with the stranded id",
    (await txnOf(invoice.id)).idAtGateway === chargeId,
  );
  await sweepAt(s.biz.id, later(15 * 60_000));
  const t = await txnOf(invoice.id);
  const inv = await invoiceRow(invoice.id);
  ok(
    "L8: the gateway's decline is booked: failed insufficient_funds, dunning resumes, no cash",
    t.status === "failed" &&
      t.errorCode === "insufficient_funds" &&
      inv.nextAttemptAt != null &&
      (await s.cash()) === cash0,
    `${t.status} ${t.errorCode} next=${inv.nextAttemptAt?.toISOString()} cash=${(await s.cash()) - cash0}`,
  );
  const n = await s.entries();
  await sweepAt(s.biz.id, later(30 * 60_000));
  await s.deliver({
    providerEventId: evId("l8"),
    type: "charge.failed",
    providerChargeId: chargeId,
    failureCode: "insufficient_funds",
  });
  ok("L8: a second sweep and the late webhook post nothing", (await s.entries()) === n);
  ok("L8: the ledger balances", await s.balanced());
});

await section("L9 a stranded id still pending at the gateway", async () => {
  const s = await scenario("l9");
  const cash0 = await s.cash();
  const { invoice, chargeId } = await strandedBill(s, "tok_4000000000000101");
  await sweepAt(s.biz.id, later(15 * 60_000));
  ok(
    "L9: a pending answer inside the window changes nothing: still `timeout`, invoice parked",
    (await txnOf(invoice.id)).status === "timeout" &&
      (await invoiceRow(invoice.id)).nextAttemptAt == null,
  );
  await sweepAt(s.biz.id, later(25 * 3_600_000));
  ok(
    "L9: still pending after 24 h: handed to the pending sweep as `in_progress`, never failed",
    (await txnOf(invoice.id)).status === "in_progress" &&
      (await invoiceRow(invoice.id)).nextAttemptAt == null &&
      (await s.cash()) === cash0,
    (await txnOf(invoice.id)).status,
  );
  const settle = () =>
    s.deliver({
      providerEventId: evId("l9"),
      type: "charge.succeeded",
      providerChargeId: chargeId,
      amountMinor: 10000n,
    });
  await settle();
  ok("L9: the webhook then settles it once", (await s.cash()) === cash0 + 10000n);
  const n = await s.entries();
  await settle();
  ok("L9: its redelivery posts nothing", (await s.entries()) === n);
  ok("L9: the ledger balances", await s.balanced());
});

await section("L10 a stranded id with no status lookup", async () => {
  const s = await scenario("l10");
  const proto = TmtestProvider.prototype as unknown as Record<string, unknown>;
  const real = proto.fetchChargeStatus;
  proto.fetchChargeStatus = undefined;
  try {
    const { invoice } = await strandedBill(s, "tok_4242");
    const f = (await sweepAt(s.biz.id, later(15 * 60_000))) as unknown as Record<string, number>;
    const g = (await sweepAt(s.biz.id, later(5 * 3_600_000))) as unknown as Record<string, number>;
    ok(
      "L10: no lookup: left `timeout`, alerted on the first tick only",
      (await txnOf(invoice.id)).status === "timeout" &&
        f.lostAnswerAlerted === 1 &&
        g.lostAnswerAlerted === 0,
      JSON.stringify([f.lostAnswerAlerted, g.lostAnswerAlerted]),
    );
  } finally {
    proto.fetchChargeStatus = real;
  }
});

// ═══ § D — dispute money ════════════════════════════════════════════════════════════════
type DisputeType = NormalizedProviderEvent["type"];
async function disputeOn(
  s: Awaited<ReturnType<typeof scenario>>,
  charge: string,
  dp: string,
  steps: Array<DisputeType | { type: DisputeType; won?: bigint; amount?: bigint }>,
) {
  for (const step of steps) {
    const st = typeof step === "string" ? { type: step } : step;
    await s.deliver({
      providerEventId: evId(dp),
      type: st.type,
      providerDisputeId: dp,
      providerChargeId: charge,
      disputeAmountMinor: st.amount ?? 10000n,
      disputeCurrency: "USD",
      disputeReason: "fraudulent",
      ...(st.won != null ? { disputeAmountWonMinor: st.won } : {}),
    } as NormalizedProviderEvent);
  }
  return disputeRow(dp);
}

await section("D1 win after loss", async () => {
  for (const withdrawn of [true, false]) {
    const s = await scenario(`d1${withdrawn ? "w" : "n"}`);
    const { payment } = await s.bill();
    const cash0 = await s.cash();
    const dp = `dp_d1_${withdrawn}_${RUN}`;
    await disputeOn(s, payment!.providerChargeId!, dp, [
      "dispute.created",
      ...(withdrawn ? (["dispute.funds_withdrawn"] as const) : []),
      "dispute.lost",
    ]);
    ok(
      `D1(${withdrawn ? "withdrawn" : "never withdrawn"}): the loss took 10000`,
      (await s.cash()) === cash0 - 10000n,
    );
    const d = await disputeOn(s, payment!.providerChargeId!, dp, ["dispute.won"]);
    ok(
      `D1(${withdrawn ? "withdrawn" : "never withdrawn"}): a win after the loss credits it back`,
      d.status === "won" && (await s.cash()) === cash0 && (await s.bal("dispute_losses")) === 0n,
      `${d.status} cash=${(await s.cash()) - cash0} losses=${await s.bal("dispute_losses")}`,
    );
    const n = await s.entries();
    await disputeOn(s, payment!.providerChargeId!, dp, ["dispute.won", "dispute.funds_reinstated"]);
    ok(
      `D1(${withdrawn ? "withdrawn" : "never withdrawn"}): a second win posts nothing`,
      (await s.entries()) === n,
    );
    ok(
      `D1(${withdrawn ? "withdrawn" : "never withdrawn"}): the ledger balances`,
      await s.balanced(),
    );
  }
});

await section("D2 partial win", async () => {
  for (const withdrawn of [true, false]) {
    const s = await scenario(`d2${withdrawn ? "w" : "n"}`);
    const { payment } = await s.bill();
    const cash0 = await s.cash();
    const d = await disputeOn(s, payment!.providerChargeId!, `dp_d2_${withdrawn}_${RUN}`, [
      "dispute.created",
      ...(withdrawn ? (["dispute.funds_withdrawn"] as const) : []),
      { type: "dispute.won", won: 6000n },
    ]);
    ok(
      `D2(${withdrawn ? "withdrawn" : "never withdrawn"}): won 6000 of 10000 — 4000 stays a loss`,
      d.status === "won" &&
        (await s.cash()) === cash0 - 4000n &&
        (await s.bal("dispute_losses")) === 4000n &&
        (await s.bal("disputed_funds")) === 0n,
      `cash=${(await s.cash()) - cash0} losses=${await s.bal("dispute_losses")} held=${await s.bal("disputed_funds")}`,
    );
    ok(
      `D2(${withdrawn ? "withdrawn" : "never withdrawn"}): the ledger balances`,
      await s.balanced(),
    );
  }
});

await section("D3 two disputes on one payment", async () => {
  const s = await scenario("d3");
  const { payment } = await s.bill();
  const charge = payment!.providerChargeId!;
  const cash0 = await s.cash();
  await disputeOn(s, charge, `dp_d3_cb_${RUN}`, ["dispute.created", "dispute.funds_withdrawn"]);
  await disputeOn(s, charge, `dp_d3_pa_${RUN}`, ["dispute.created", "dispute.funds_withdrawn"]);
  ok(
    "D3: a second withdrawal on the same payment takes nothing more (cash −10000, not −20000)",
    (await s.cash()) === cash0 - 10000n,
    `cash=${(await s.cash()) - cash0}`,
  );
  await disputeOn(s, charge, `dp_d3_pa_${RUN}`, ["dispute.lost"]);
  await disputeOn(s, charge, `dp_d3_cb_${RUN}`, ["dispute.lost"]);
  ok(
    "D3: both lost — the loss is 10000 once",
    (await s.cash()) === cash0 - 10000n && (await s.bal("dispute_losses")) === 10000n,
    `cash=${(await s.cash()) - cash0} losses=${await s.bal("dispute_losses")}`,
  );
  // Out of order: a loss on a dispute that was never withdrawn, after another took the cash.
  const s2 = await scenario("d3b");
  const { payment: p2 } = await s2.bill();
  const c2 = await s2.cash();
  await disputeOn(s2, p2!.providerChargeId!, `dp_d3b_a_${RUN}`, ["dispute.funds_withdrawn"]);
  await disputeOn(s2, p2!.providerChargeId!, `dp_d3b_b_${RUN}`, ["dispute.lost"]);
  ok(
    "D3: a loss never withdrawn, after another dispute withdrew, takes nothing more",
    (await s2.cash()) === c2 - 10000n,
    `cash=${(await s2.cash()) - c2}`,
  );
  ok("D3: the ledgers balance", (await s.balanced()) && (await s2.balanced()));
});

await section("D4 refund, then dispute", async () => {
  const s = await scenario("d4");
  const { payment } = await s.bill();
  const cash0 = await s.cash();
  await refundPayment({
    organizationId: orgId,
    businessId: s.biz.id,
    paymentPublicId: payment!.publicId,
    amountMinor: 4000,
  });
  await disputeOn(s, payment!.providerChargeId!, `dp_d4_${RUN}`, ["dispute.funds_withdrawn"]);
  ok(
    "D4: a chargeback of 10000 after a 4000 refund takes 6000 (the payment net of refunds)",
    (await s.cash()) === cash0 - 10000n && (await s.bal("disputed_funds")) === 6000n,
    `cash=${(await s.cash()) - cash0} held=${await s.bal("disputed_funds")}`,
  );
  await disputeOn(s, payment!.providerChargeId!, `dp_d4_${RUN}`, ["dispute.won"]);
  ok("D4: a win gives back the 6000 it took", (await s.cash()) === cash0 - 4000n);
  ok("D4: the ledger balances", await s.balanced());
});

await section("D5 late reversal and a dispute", async () => {
  // Reversal first, then the chargeback.
  const s = await scenario("d5a");
  const { payment } = await s.bill();
  const charge = payment!.providerChargeId!;
  const cash0 = await s.cash();
  await s.deliver({
    providerEventId: evId("d5"),
    type: "charge.failed",
    providerChargeId: charge,
    lateReversal: true,
  });
  ok("D5: the late reversal took 10000", (await s.cash()) === cash0 - 10000n);
  await disputeOn(s, charge, `dp_d5a_${RUN}`, [
    "dispute.created",
    "dispute.funds_withdrawn",
    "dispute.lost",
  ]);
  ok(
    "D5: a chargeback on a reversed payment takes nothing more",
    (await s.cash()) === cash0 - 10000n,
    `cash=${(await s.cash()) - cash0}`,
  );
  // Chargeback first, then the reversal.
  const s2 = await scenario("d5b");
  const { payment: p2, invoice: inv2 } = await s2.bill();
  const c2 = await s2.cash();
  const ar2 = await s2.bal("accounts_receivable");
  await disputeOn(s2, p2!.providerChargeId!, `dp_d5b_${RUN}`, [
    "dispute.created",
    "dispute.funds_withdrawn",
  ]);
  await s2.deliver({
    providerEventId: evId("d5"),
    type: "charge.failed",
    providerChargeId: p2!.providerChargeId!,
    lateReversal: true,
  });
  ok(
    "D5: a late reversal after a withdrawal reopens the invoice but takes no more cash",
    (await s2.cash()) === c2 - 10000n &&
      (await s2.bal("accounts_receivable")) === ar2 + 10000n &&
      (await s2.bal("disputed_funds")) === 0n,
    `cash=${(await s2.cash()) - c2} ar=${(await s2.bal("accounts_receivable")) - ar2} held=${await s2.bal("disputed_funds")}`,
  );
  ok("D5: the invoice is owed again", (await invoiceRow(inv2.id)).status !== "paid");
  await disputeOn(s2, p2!.providerChargeId!, `dp_d5b_${RUN}`, ["dispute.lost"]);
  ok("D5: the loss after that books no second cash", (await s2.cash()) === c2 - 10000n);
  ok("D5: the ledgers balance", (await s.balanced()) && (await s2.balanced()));
});

await section("D6 operator outcome on a gateway dispute", async () => {
  const s = await scenario("d6");
  const cash0 = await s.cash();
  const outcome = (id: string, value: string) =>
    app.inject({
      method: "POST",
      url: `/v1/businesses/${s.biz.publicId}/disputes/${id}/outcome`,
      headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": `d6-${id}-${value}` },
      payload: { outcome: value },
    });
  /** A dispute as `provider` reports it, on this business. */
  const report = async (provider: string, dp: string, types: DisputeType[]) => {
    for (const type of types)
      await handleProviderEvent(
        provider,
        {
          providerEventId: evId(`d6${provider}`),
          type,
          providerDisputeId: dp,
          disputeAmountMinor: 10000n,
          disputeCurrency: "USD",
          occurredAt: new Date(),
          raw: {},
        },
        { businessId: s.biz.id },
      );
    return disputeRow(dp);
  };
  // A Mollie chargeback: opened and withdrawn, never a final state.
  const dp = `dp_d6_mollie_${RUN}`;
  const d = await report("mollie", dp, ["dispute.created", "dispute.funds_withdrawn"]);
  const r = await outcome(d.publicId, "lost");
  ok(
    "D6: a person records the outcome of a gateway dispute with no final state",
    r.statusCode === 200 &&
      (await disputeRow(dp)).status === "lost" &&
      (await s.bal("dispute_losses")) === 10000n,
    `${r.statusCode} ${r.body}`,
  );
  // The gateway reverses it later: the win after the loss credits it back.
  await report("mollie", dp, ["dispute.funds_reinstated"]);
  ok(
    "D6: a later reversal from the gateway credits the loss back",
    (await s.cash()) === cash0 && (await s.bal("dispute_losses")) === 0n,
    `cash=${(await s.cash()) - cash0}`,
  );
  const stripe = await outcome(
    (await report("stripe", `dp_d6_stripe_${RUN}`, ["dispute.created"])).publicId,
    "won",
  );
  ok(
    "D6: refused on a gateway that sends the outcome (Stripe)",
    stripe.statusCode === 400,
    stripe.statusCode,
  );
  ok("D6: the ledger balances", await s.balanced());
});

// ═══ § V — a late reversal takes only what the payment still holds ══════════════════════
const ar = (s: Awaited<ReturnType<typeof scenario>>) => s.bal("accounts_receivable");
const refund = (s: Awaited<ReturnType<typeof scenario>>, paymentPublicId: string, n: number) =>
  refundPayment({
    organizationId: orgId,
    businessId: s.biz.id,
    paymentPublicId,
    amountMinor: n,
  });

await section("V1 late reversal after a partial refund", async () => {
  for (const type of ["charge.failed", "charge.reversed"] as const) {
    const s = await scenario(`v1${type === "charge.failed" ? "f" : "r"}`);
    const { payment } = await s.bill();
    const cash0 = await s.cash();
    const ar0 = await ar(s);
    await refund(s, payment!.publicId, 4000);
    const reverse = () =>
      s.deliver({
        providerEventId: evId("v1"),
        type,
        providerChargeId: payment!.providerChargeId!,
        ...(type === "charge.failed" ? { lateReversal: true } : {}),
      });
    await reverse();
    ok(
      `V1(${type}): takes the 6000 still collected, not 10000 (cash net 0, AR +6000)`,
      (await s.cash()) === cash0 - 10000n && (await ar(s)) === ar0 + 6000n,
      `cash=${(await s.cash()) - cash0} ar=${(await ar(s)) - ar0}`,
    );
    const inv = await invoiceRow(payment!.invoiceId!);
    const due = await withTenant(orgId, (tx) => invoiceOutstanding(tx, inv));
    ok(
      `V1(${type}): the invoice reopens for 6000 (amount − refunds), as AR does`,
      due.remainingMinor === 6000n && due.paidMinor === 4000n,
      `remaining=${due.remainingMinor} paid=${due.paidMinor}`,
    );
    const n = await s.entries();
    await reverse();
    ok(`V1(${type}): a redelivery posts nothing`, (await s.entries()) === n);
    ok(`V1(${type}): the ledger balances`, await s.balanced());
  }
});

await section("V2 refund, chargeback withdrawn, then late reversal", async () => {
  const s = await scenario("v2");
  const { payment } = await s.bill();
  const charge = payment!.providerChargeId!;
  const cash0 = await s.cash();
  const ar0 = await ar(s);
  await refund(s, payment!.publicId, 3000);
  await disputeOn(s, charge, `dp_v2_${RUN}`, ["dispute.created", "dispute.funds_withdrawn"]);
  ok("V2: the withdrawal held the 7000 left", (await s.bal("disputed_funds")) === 7000n);
  const reverse = () =>
    s.deliver({
      providerEventId: evId("v2"),
      type: "charge.failed",
      providerChargeId: charge,
      lateReversal: true,
    });
  await reverse();
  ok(
    "V2: the reversal moves the held 7000 to AR and takes no more cash",
    (await s.cash()) === cash0 - 10000n &&
      (await s.bal("disputed_funds")) === 0n &&
      (await ar(s)) === ar0 + 7000n,
    `cash=${(await s.cash()) - cash0} held=${await s.bal("disputed_funds")} ar=${(await ar(s)) - ar0}`,
  );
  await disputeOn(s, charge, `dp_v2_${RUN}`, ["dispute.lost"]);
  ok("V2: a loss after that books no cash", (await s.cash()) === cash0 - 10000n);
  const n = await s.entries();
  await reverse();
  ok("V2: a redelivery posts nothing", (await s.entries()) === n);
  ok("V2: the ledger balances", await s.balanced());
});

await section("V3 the gateway states the reversal amount", async () => {
  for (const [label, refunded, stated, taken] of [
    ["capped", 2000, 9000n, 8000n],
    ["partial", 0, 5000n, 5000n],
  ] as const) {
    const s = await scenario(`v3${label}`);
    const { payment } = await s.bill();
    const cash0 = await s.cash();
    const ar0 = await ar(s);
    if (refunded) await refund(s, payment!.publicId, refunded);
    const reverse = () =>
      s.deliver({
        providerEventId: evId("v3"),
        type: "charge.failed",
        providerChargeId: payment!.providerChargeId!,
        lateReversal: true,
        reversalAmountMinor: stated,
      } as never);
    await reverse();
    ok(
      `V3(${label}): stated ${stated} after ${refunded} refunded takes ${taken}`,
      (await s.cash()) === cash0 - BigInt(refunded) - taken && (await ar(s)) === ar0 + taken,
      `cash=${(await s.cash()) - cash0} ar=${(await ar(s)) - ar0}`,
    );
    const n = await s.entries();
    await reverse();
    ok(`V3(${label}): a redelivery posts nothing`, (await s.entries()) === n);
    ok(`V3(${label}): the ledger balances`, await s.balanced());
  }
});

await section("V4 a payment request's charge", async () => {
  // Refunded in part, then reversed.
  const s = await scenario("v4a");
  const { req } = await chargedRequest(s, "v4a", "tok_4242");
  const charge = req!.providerChargeId!;
  const cash0 = await s.cash();
  const ar0 = await ar(s);
  await s.deliver({
    providerEventId: evId("v4"),
    type: "charge.refunded",
    providerChargeId: charge,
    refunds: [rec(`re_v4_${RUN}`, 1500n, "succeeded")],
  });
  const reverse = (sc: typeof s, ch: string) =>
    sc.deliver({
      providerEventId: evId("v4"),
      type: "charge.failed",
      providerChargeId: ch,
      lateReversal: true,
    });
  await reverse(s, charge);
  ok(
    "V4: a request reversed after a 1500 refund takes 8500 (cash net 0, AR +8500)",
    (await s.cash()) === cash0 - 10000n && (await ar(s)) === ar0 + 8500n,
    `cash=${(await s.cash()) - cash0} ar=${(await ar(s)) - ar0}`,
  );
  const n = await s.entries();
  await reverse(s, charge);
  ok("V4: a redelivery posts nothing", (await s.entries()) === n);
  ok("V4: the ledger balances", await s.balanced());

  // Withdrawn by a chargeback, then reversed.
  const s2 = await scenario("v4b");
  const { req: req2 } = await chargedRequest(s2, "v4b", "tok_4242");
  const charge2 = req2!.providerChargeId!;
  const c2 = await s2.cash();
  const ar2 = await ar(s2);
  await disputeOn(s2, charge2, `dp_v4b_${RUN}`, ["dispute.created", "dispute.funds_withdrawn"]);
  ok(
    "V4: the chargeback on the request held 10000",
    (await s2.bal("disputed_funds")) === 10000n,
    await s2.bal("disputed_funds"),
  );
  await reverse(s2, charge2);
  ok(
    "V4: the reversal after it moves the held 10000 to AR and takes no more cash",
    (await s2.cash()) === c2 - 10000n &&
      (await s2.bal("disputed_funds")) === 0n &&
      (await ar(s2)) === ar2 + 10000n,
    `cash=${(await s2.cash()) - c2} held=${await s2.bal("disputed_funds")} ar=${(await ar(s2)) - ar2}`,
  );
  ok("V4: the second ledger balances", await s2.balanced());
});

// ═══ § C — conventions ══════════════════════════════════════════════════════════════════
await section("C1 a refund refusal releases the reservation", async () => {
  const s = await scenario("c1");
  const { payment } = await s.bill();
  const proto = TmtestProvider.prototype as unknown as Record<string, unknown>;
  const real = proto.refund;
  proto.refund = async () => {
    throw new ProviderRefusalError("The refund amount is not valid.");
  };
  let refused = false;
  try {
    await refundPayment({
      organizationId: orgId,
      businessId: s.biz.id,
      paymentPublicId: payment!.publicId,
      amountMinor: 4000,
    });
  } catch (e) {
    refused = e instanceof RefundError;
  } finally {
    proto.refund = real;
  }
  const full = await refundPayment({
    organizationId: orgId,
    businessId: s.biz.id,
    paymentPublicId: payment!.publicId,
  }).catch((e) => e as Error);
  ok(
    "C1: a refused partial refund frees its amount: the full 10000 can then be refunded",
    refused && !(full instanceof Error) && full.amountMinor === 10000n,
    full instanceof Error ? full.message : String(full.amountMinor),
  );
});

await section("C2 one late-reversal flag", async () => {
  for (const form of ["typed", "legacy"] as const) {
    const s = await scenario(`c2${form}`);
    const { payment } = await s.bill();
    const cash0 = await s.cash();
    await s.deliver({
      providerEventId: evId("c2"),
      type: "charge.failed",
      providerChargeId: payment!.providerChargeId!,
      ...(form === "typed" ? { lateReversal: true } : { raw: { data: { reversal: true } } }),
    });
    const [p] = await withTenant(orgId, (tx) =>
      tx.select().from(payments).where(eq(payments.id, payment!.id)),
    );
    ok(
      `C2: the ${form} reversal flag reverses a succeeded charge`,
      p?.failureCode === "late_failure" && (await s.cash()) === cash0 - 10000n,
    );
  }
});

// ═══ § M — mandate currency (audit C1) ══════════════════════════════════════════════════
await section("M1 a mandate is never debited in another currency", async () => {
  const s = await scenario("m1");
  // Every gateway charge, by the instrument it was sent for.
  const sent: string[] = [];
  const realCharge = TmtestProvider.prototype.charge;
  TmtestProvider.prototype.charge = function (this: TmtestProvider, input) {
    sent.push(input.paymentMethod.providerPaymentMethodId);
    return realCharge.call(this, input);
  };
  const intentCalls: string[] = [];
  const realIntent = TmtestProvider.prototype.createIntent;
  TmtestProvider.prototype.createIntent = function (this: TmtestProvider, input) {
    intentCalls.push(input.currency);
    return realIntent.call(this, input);
  };
  const inrMandate = (id: string) =>
    withTenant(orgId, (tx) =>
      tx
        .update(paymentMethods)
        .set({ mandateCurrency: "INR", mandateRail: "card", mandateStatus: "active" })
        .where(eq(paymentMethods.id, id)),
    );
  const pmRow = async (id: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(paymentMethods).where(eq(paymentMethods.id, id)),
      )
    )[0]!;
  try {
    // Only an INR mandate on file: the USD invoice is refused before any gateway call.
    const customer = await createCustomer({
      organizationId: orgId,
      businessId: s.biz.id,
      email: `m1-${RUN}@example.com`,
    });
    const inr = await vaultPaymentMethod({
      organizationId: orgId,
      businessId: s.biz.id,
      customer,
      token: "tok_4242",
    });
    await inrMandate(inr.id);
    const product = await createProduct({
      organizationId: orgId,
      businessId: s.biz.id,
      name: "M1",
    });
    const price = await createPrice({
      organizationId: orgId,
      businessId: s.biz.id,
      productId: product.id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor: 5000,
      interval: "month",
    });
    const billOn = async (defaultPaymentMethodId: string) => {
      const sub = await createSubscription({
        organizationId: orgId,
        businessId: s.biz.id,
        customerId: customer.id,
        now: new Date(),
        items: [{ price, quantity: 1 }],
        defaultPaymentMethodId,
      });
      return billSubscriptionPeriod({
        organizationId: orgId,
        businessId: s.biz.id,
        subscription: sub.subscription,
        periodStart: sub.subscription.currentPeriodStart!,
        periodEnd: sub.subscription.currentPeriodEnd!,
      });
    };
    sent.length = 0;
    const refused = await billOn(inr.id);
    const refusedPays = await withTenant(orgId, (tx) =>
      tx.select().from(payments).where(eq(payments.invoiceId, refused.invoice.id)),
    );
    ok(
      "M1: a USD invoice on an INR mandate is refused before any gateway call, as mandate_currency_mismatch",
      sent.length === 0 &&
        refusedPays.length > 0 &&
        refusedPays.every((p) => p.status === "failed") &&
        refusedPays.some((p) => p.failureCode === "mandate_currency_mismatch") &&
        (await invoiceRow(refused.invoice.id)).status !== "paid",
      JSON.stringify({ sent, pays: refusedPays.map((p) => [p.status, p.failureCode]) }),
    );
    ok(
      "M1: the INR mandate is not branded invalid (it is good for INR)",
      (await pmRow(inr.id)).status === "valid",
      (await pmRow(inr.id)).status,
    );
    // Collect now through a payment intent takes the same refusal, before the gateway.
    const intentsBefore = intentCalls.length;
    const intentErr = await createPaymentIntent({
      organizationId: orgId,
      businessId: s.biz.id,
      purpose: "payment",
      paymentMethodPublicId: (await pmRow(inr.id)).publicId,
      amountMinor: 5000,
      currency: "USD",
    }).catch((e: unknown) => e);
    ok(
      "M1: a USD payment intent on an INR mandate is refused before any gateway call",
      intentErr instanceof PaymentIntentError &&
        intentErr.code === "mandate_currency_mismatch" &&
        intentCalls.length === intentsBefore,
      intentErr instanceof Error ? intentErr.message : "created",
    );
    // A card that can take USD is on file too: it is charged, the INR mandate never is.
    const usdCard = await vaultPaymentMethod({
      organizationId: orgId,
      businessId: s.biz.id,
      customer,
      token: "tok_4242",
    });
    sent.length = 0;
    const paid = await billOn(inr.id);
    ok(
      "M1: with a USD-capable card on file, the USD invoice is collected on it and the INR mandate is skipped",
      sent.length === 1 &&
        sent[0] === usdCard.providerPaymentMethodId &&
        !sent.includes(inr.providerPaymentMethodId) &&
        (await invoiceRow(paid.invoice.id)).status === "paid",
      JSON.stringify({ sent, status: (await invoiceRow(paid.invoice.id)).status }),
    );
  } finally {
    TmtestProvider.prototype.charge = realCharge;
    TmtestProvider.prototype.createIntent = realIntent;
  }
});

await app.close();
let pass = true;
for (const [n, c] of checks) {
  console.log(` ${c ? "✓" : "✗"} ${n}`);
  if (!c) pass = false;
}
const failed = checks.filter(([, c]) => !c).length;
console.log(`\n${checks.length - failed}/${checks.length} passed`);
console.log(pass ? "✅ ENGINE GATEWAY CONFORMANCE: PASS" : "❌ ENGINE GATEWAY CONFORMANCE: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);

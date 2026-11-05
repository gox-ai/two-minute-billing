/**
 * Payment requests (0388): one charge for several invoices, booked as per-invoice child
 * payments, and every gateway path that names only the charge (webhook success/failure,
 * late failure, gateway refund, dispute, operator reconcile, stale sweep, unmatched capture)
 * finds the request and spreads the money over its children.
 *
 *   pnpm verify:payment-requests
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { buildApp } from "@/index";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod, pendingPaymentForInvoice } from "@/modules/invoicing/service";
import { collectInvoiceNow, recordOfflinePayment } from "@/modules/invoicing/ops";
import { recordExcessPayment } from "@/modules/customers/balances";
import { bucketBalance, EXCESS_PAYMENT } from "@/modules/customers/balances-read";
import { handleProviderEvent, reconcileLateRequestCapture } from "@/modules/webhooks/inbound";
import { reconcileTransaction } from "@/modules/transactions/service";
import { sweepStalePendingCharges } from "@/modules/payments/stale-pending";
import { refundPayment } from "@/modules/refunds/service";
import { refundInvoiceViaCreditNote } from "@/modules/credit-notes/service";
import { runWithClockScope } from "@/platform/clock";
import {
  chargePaymentRequest,
  createPaymentRequest,
  getPaymentRequest,
  recordPaymentRequestPayment,
} from "@/modules/payment-requests/service";
import { TmtestProvider } from "@/providers/tmtest";
import type { ChargeInput, NormalizedProviderEvent } from "@/providers/types";
import {
  businesses,
  disputes,
  events,
  invoices,
  ledgerEntries,
  paymentRequests,
  payments,
  receipts,
  refunds,
  transactions,
} from "@db/schema";

const RUN = randomUUID().slice(0, 8);
const checks: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  checks.push([name, ok, detail]);
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// Capture every ChargeInput the test gateway receives.
const charges: ChargeInput[] = [];
const realCharge = TmtestProvider.prototype.charge;
TmtestProvider.prototype.charge = function (this: TmtestProvider, input: ChargeInput) {
  charges.push(input);
  return realCharge.call(this, input);
};

const org = await createOrganization({ name: `Payment requests ${RUN}` });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "PR Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
// No automatic collection when a card is added: the suite charges on purpose.
await systemDb
  .update(businesses)
  .set({ dunningConfig: { collect_on_payment_method_update: false } })
  .where(eq(businesses.id, biz.id));
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
const priceOf = async (amountMinor: number) =>
  createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor,
    interval: "month",
  });
const [p50, p120, p30] = [await priceOf(5000), await priceOf(12000), await priceOf(3000)];

const app = await buildApp({ logger: false });
let n = 0;
const call = async (method: "GET" | "POST", url: string, payload?: object) => {
  const res = await app.inject({
    method,
    url: `/v1/businesses/${biz.publicId}${url}`,
    headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": `pr-${RUN}-${n++}` },
    ...(payload ? { payload } : {}),
  });
  return { status: res.statusCode, body: JSON.parse(res.body || "null") };
};

/** A customer with three failed (open) invoices: 50.00, 120.00, 30.00, due 1 Sep / 1 Oct / 15 Oct. */
async function threeOpenInvoices(label: string, opts: { autoCollection?: "on" | "off" } = {}) {
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `${label}-${RUN}@example.com`,
    autoCollection: opts.autoCollection,
  });
  const bad = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "4000000000009995",
  });
  const ids: string[] = [];
  const dues = [
    new Date("2026-09-01T00:00:00Z"),
    new Date("2026-10-01T00:00:00Z"),
    new Date("2026-10-15T00:00:00Z"),
  ];
  for (const [i, price] of [p50, p120, p30].entries()) {
    const sub = await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
      defaultPaymentMethodId: bad.id,
    });
    const { invoice } = await billSubscriptionPeriod({
      organizationId: orgId,
      businessId: biz.id,
      subscription: sub.subscription,
      periodStart: sub.subscription.currentPeriodStart!,
      periodEnd: sub.subscription.currentPeriodEnd!,
    });
    await systemDb.update(invoices).set({ dueDate: dues[i]! }).where(eq(invoices.id, invoice.id));
    ids.push(invoice.id);
  }
  const inv = async () =>
    withTenant(orgId, (tx) =>
      tx
        .select()
        .from(invoices)
        .where(sql`${invoices.id} in ${ids}`),
    );
  const rows = await inv();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { customer, invoices: ids.map((id) => byId.get(id)!), badPm: bad };
}
const goodCard = (customer: Awaited<ReturnType<typeof createCustomer>>, token = "tok_4242") =>
  vaultPaymentMethod({ organizationId: orgId, businessId: biz.id, customer, token });
const getInv = (id: string) =>
  withTenant(
    orgId,
    async (tx) => (await tx.select().from(invoices).where(eq(invoices.id, id)).limit(1))[0]!,
  );
const childrenOf = (requestPid: string) =>
  withTenant(orgId, async (tx) => {
    const [r] = await tx
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.publicId, requestPid));
    return tx.select().from(payments).where(eq(payments.paymentRequestId, r!.id));
  });
const requestRow = (pid: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(paymentRequests).where(eq(paymentRequests.publicId, pid)))[0]!,
  );
const eventsOf = (type: string) =>
  withTenant(orgId, (tx) =>
    tx
      .select()
      .from(events)
      .where(and(eq(events.businessId, biz.id), eq(events.type, type))),
  );
const ev = (
  over: Partial<NormalizedProviderEvent> & Pick<NormalizedProviderEvent, "type">,
): NormalizedProviderEvent =>
  ({
    providerEventId: `ev_${RUN}_${n++}`,
    occurredAt: new Date(),
    raw: {},
    ...over,
  }) as NormalizedProviderEvent;

// ── 1. The worked example, to the minor unit ───────────────────────────────────
let worked: { pid: string; customer: Awaited<ReturnType<typeof createCustomer>>; ids: string[] };
{
  const {
    customer,
    invoices: [a, b, c],
  } = await threeOpenInvoices("worked");
  await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: c!.publicId,
    amountMinor: 1000,
    method: "cash",
  });
  await recordExcessPayment({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    amountMinor: 2500,
    currency: "USD",
  });
  const pm = await goodCard(customer);
  const before = charges.length;
  const res = await call("POST", `/customers/${customer.publicId}/payment_requests`, {
    invoices: [c!.publicId, a!.publicId, b!.publicId],
    mode: "charge",
    payment_method: pm.publicId,
  });
  const pid = res.body?.id as string;
  worked = { pid, customer, ids: [a!.id, b!.id, c!.id] };
  const kids = await childrenOf(pid);
  const amt = (id: string) => kids.find((k) => k.invoiceId === id)?.amountMinor ?? -1n;
  check(
    "1 create+charge returns 201, status paid",
    res.status === 201 && res.body?.status === "paid",
    `${res.status} ${res.body?.status} ${JSON.stringify(res.body?.error ?? res.body?.last_payment_error ?? null)}`,
  );
  check(
    "1 credit first: INV-A gets 25.00 of credit, one charge of 165.00",
    charges.length - before === 1 && charges[charges.length - 1]!.amountMinor === 16500n,
    `charges=${charges.length - before} amount=${charges[charges.length - 1]?.amountMinor}`,
  );
  check(
    "1 children: 25.00 / 120.00 / 20.00, no charge id on any",
    amt(a!.id) === 2500n &&
      amt(b!.id) === 12000n &&
      amt(c!.id) === 2000n &&
      kids.every((k) => k.providerChargeId === null && k.status === "succeeded"),
    kids.map((k) => `${k.amountMinor}/${k.status}/${k.providerChargeId}`).join(","),
  );
  const invs = await Promise.all([a, b, c].map((i) => getInv(i!.id)));
  check(
    "1 all three invoices paid",
    invs.every((i) => i.status === "paid"),
    invs.map((i) => i.status).join(","),
  );
  const req = await requestRow(pid);
  check(
    "1 the request holds the charge id",
    !!req.providerChargeId && req.status === "paid",
    `${req.providerChargeId} ${req.status}`,
  );
  const [txn] = await withTenant(orgId, (tx) =>
    tx.select().from(transactions).where(eq(transactions.paymentRequestId, req.id)),
  );
  check(
    "1 one transaction for the request, payment_id null",
    !!txn && txn.paymentId === null && txn.amountMinor === 16500n && txn.status === "succeeded",
    `${txn?.amountMinor} ${txn?.status}`,
  );
  const recs = await withTenant(orgId, (tx) =>
    tx.select().from(receipts).where(eq(receipts.paymentRequestId, req.id)),
  );
  const childRecs = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(receipts)
      .where(sql`${receipts.paymentId} in ${kids.map((k) => k.id)}`),
  );
  const snap = recs[0]?.snapshot as { allocations?: Array<{ amount_minor: number }> } | undefined;
  check(
    "1 one receipt for 165.00 with three lines; none per child",
    recs.length === 1 &&
      recs[0]!.amountMinor === 16500n &&
      snap?.allocations?.length === 3 &&
      childRecs.length === 0,
    `receipts=${recs.length} amount=${recs[0]?.amountMinor} lines=${snap?.allocations?.length} child=${childRecs.length}`,
  );
  const last = charges[charges.length - 1]!;
  check(
    "1 ChargeInput.initiator = merchant, not recurring",
    last.initiator?.by === "merchant" && last.initiator?.recurring === false,
    JSON.stringify(last.initiator),
  );
  check("1 ownershipRef names the request", last.ownershipRef === pid, String(last.ownershipRef));
  const paidEvs = await eventsOf("payment_request_paid");
  check(
    "1 payment_request_paid emitted",
    paidEvs.some((e) => JSON.stringify(e.data).includes(pid)),
  );
  const childEvs = (await eventsOf("payment_succeeded")).filter((e) =>
    JSON.stringify(e.data).includes(pid),
  );
  check(
    "1 child payment_succeeded events name the request",
    childEvs.length === 3,
    `n=${childEvs.length}`,
  );
}

// ── 2. One open request per invoice ───────────────────────────────────────────
{
  const {
    customer,
    invoices: [a, b],
  } = await threeOpenInvoices("unique");
  const r1 = call("POST", `/customers/${customer.publicId}/payment_requests`, {
    invoices: [a!.publicId, b!.publicId],
    mode: "link",
  });
  const r2 = call("POST", `/customers/${customer.publicId}/payment_requests`, {
    invoices: [a!.publicId],
    mode: "link",
  });
  const [x, y] = await Promise.all([r1, r2]);
  const statuses = [x.status, y.status].sort();
  check(
    "2 concurrent create: one 201, one 409",
    statuses[0] === 201 && statuses[1] === 409,
    `${x.status} ${y.status} ${JSON.stringify(x.body?.error ?? y.body?.error)}`,
  );
  const ok = x.status === 201 ? x : y;
  const live = await call("GET", `/payment_requests/${ok.body.id}`);
  check(
    "2 live amount is the sum of what is still due",
    live.body?.amount_minor ===
      (ok.body.lines as Array<{ amount_due_minor: number }>).reduce(
        (s, l) => s + l.amount_due_minor,
        0,
      ),
    `${live.body?.amount_minor}`,
  );
  // Paid elsewhere before charge: the invoice drops out; all paid → canceled.
  await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: (ok.body.lines[0] as { invoice: string }).invoice,
    method: "cash",
  });
  const after = await call("GET", `/payment_requests/${ok.body.id}`);
  const dropped = ((after.body?.lines ?? []) as Array<{ state: string }>).filter(
    (l) => l.state === "settled_elsewhere",
  ).length;
  check(
    "2 paid elsewhere: the line drops out and the total shrinks",
    dropped >= 1 && after.body.amount_minor < live.body.amount_minor,
    `dropped=${dropped} amount=${after.body?.amount_minor}`,
  );
  for (const l of after.body.lines as Array<{ invoice: string; state: string }>)
    if (l.state === "open")
      await recordOfflinePayment({
        organizationId: orgId,
        businessId: biz.id,
        invoicePublicId: l.invoice,
        method: "cash",
      });
  const gone = await call("GET", `/payment_requests/${ok.body.id}`);
  check(
    "2 all paid elsewhere → canceled (settled_elsewhere)",
    gone.body?.status === "canceled" && gone.body?.cancel_reason === "settled_elsewhere",
    `${gone.body?.status} ${gone.body?.cancel_reason}`,
  );
}

// ── 3. Decline: children fail as manual attempts, request stays open ──────────
{
  const {
    customer,
    invoices: [a, b],
    badPm,
  } = await threeOpenInvoices("decline");
  const attemptsBefore = (await getInv(a!.id)).attemptCount;
  const res = await call("POST", `/customers/${customer.publicId}/payment_requests`, {
    invoices: [a!.publicId, b!.publicId],
    mode: "charge",
    payment_method: badPm.publicId,
  });
  const kids = await childrenOf(res.body.id);
  check(
    "3 decline: request open with last_payment_error",
    res.status === 201 && res.body.status === "open" && !!res.body.last_payment_error,
    `${res.status} ${res.body?.status} ${JSON.stringify(res.body?.last_payment_error)}`,
  );
  check(
    "3 decline: both children failed",
    kids.length === 2 && kids.every((k) => k.status === "failed"),
    kids.map((k) => k.status).join(","),
  );
  check(
    "3 decline: no dunning attempt spent",
    (await getInv(a!.id)).attemptCount === attemptsBefore,
    `${attemptsBefore}→${(await getInv(a!.id)).attemptCount}`,
  );
  const failedEvs = (await eventsOf("payment_request_payment_failed")).filter((e) =>
    JSON.stringify(e.data).includes(res.body.id),
  );
  check(
    "3 decline: payment_request_payment_failed emitted",
    failedEvs.length === 1,
    `n=${failedEvs.length}`,
  );
  const [txn] = await withTenant(orgId, async (tx) =>
    tx
      .select()
      .from(transactions)
      .where(eq(transactions.paymentRequestId, (await requestRow(res.body.id)).id)),
  );
  check(
    "3 decline: the attempt booked a failed transaction",
    txn?.status === "failed",
    `${txn?.status}`,
  );
}

// ── 4. Auto-collection off refuses mode=charge ────────────────────────────────
{
  const {
    customer,
    invoices: [a],
  } = await threeOpenInvoices("manualpay", { autoCollection: "off" });
  await goodCard(customer);
  const res = await call("POST", `/customers/${customer.publicId}/payment_requests`, {
    invoices: [a!.publicId],
    mode: "charge",
  });
  check(
    "4 manual-payment invoice: charge refused (400)",
    res.status === 400,
    `${res.status} ${res.body?.error?.message}`,
  );
  const link = await call("POST", `/customers/${customer.publicId}/payment_requests`, {
    invoices: [a!.publicId],
    mode: "link",
  });
  check("4 manual-payment invoice: link allowed", link.status === 201, `${link.status}`);
}

// ── 5. Indeterminate → processing; guards block; operator reconcile settles ────
{
  const {
    customer,
    invoices: [a, b],
  } = await threeOpenInvoices("timeout");
  const pm = await goodCard(customer, "4000000000000077");
  const res = await call("POST", `/customers/${customer.publicId}/payment_requests`, {
    invoices: [a!.publicId, b!.publicId],
    mode: "charge",
    payment_method: pm.publicId,
  });
  const kids = await childrenOf(res.body.id);
  check(
    "5 timeout: request processing, children pending",
    res.body?.status === "processing" &&
      kids.length === 2 &&
      kids.every((k) => k.status === "pending"),
    `${res.body?.status} ${kids.map((k) => k.status)}`,
  );
  check(
    "5 timeout: the invoice reads in flight (blocks dunning, Pay now)",
    !!(await pendingPaymentForInvoice(orgId, a!.id)),
  );
  let collectRefused = false;
  try {
    await collectInvoiceNow(orgId, biz.id, a!.publicId, {});
  } catch {
    collectRefused = true;
  }
  const kidsAfter = await childrenOf(res.body.id);
  check(
    "5 timeout: Collect now does not charge over it",
    collectRefused || kidsAfter.length === 2,
    `refused=${collectRefused}`,
  );
  const cancel = await call("POST", `/payment_requests/${res.body.id}/cancel`, {});
  check("5 cancel refused while processing (409)", cancel.status === 409, `${cancel.status}`);
  const req = await requestRow(res.body.id);
  const [txn] = await withTenant(orgId, (tx) =>
    tx.select().from(transactions).where(eq(transactions.paymentRequestId, req.id)),
  );
  await reconcileTransaction({
    organizationId: orgId,
    txnPublicId: txn!.publicId,
    outcome: "succeeded",
  });
  const settled = await getPaymentRequest(orgId, biz.id, res.body.id);
  const [aa, bb] = [await getInv(a!.id), await getInv(b!.id)];
  check(
    "5 operator reconcile settles the request and both invoices",
    settled?.request.status === "paid" && aa.status === "paid" && bb.status === "paid",
    `${settled?.request.status} ${aa.status} ${bb.status}`,
  );
  const recs = await withTenant(orgId, (tx) =>
    tx.select().from(receipts).where(eq(receipts.paymentRequestId, req.id)),
  );
  check("5 reconcile leaves one receipt", recs.length === 1, `n=${recs.length}`);
}

// ── 6. Async pending → webhook success; overshoot when an invoice is paid meanwhile ─
{
  const {
    customer,
    invoices: [a, b],
  } = await threeOpenInvoices("async");
  const pm = await goodCard(customer, "4000000000000101");
  const res = await call("POST", `/customers/${customer.publicId}/payment_requests`, {
    invoices: [a!.publicId, b!.publicId],
    mode: "charge",
    payment_method: pm.publicId,
  });
  const req = await requestRow(res.body.id);
  check(
    "6 async: processing with the charge id stored on the request",
    res.body?.status === "processing" && !!req.providerChargeId,
    `${res.body?.status} ${req.providerChargeId}`,
  );
  // INV-B is paid by bank transfer while the charge is in flight.
  await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: b!.publicId,
    method: "bank_transfer",
  });
  const excessBefore = await withTenant(orgId, (tx) =>
    bucketBalance(tx, customer.id, EXCESS_PAYMENT, "USD"),
  );
  const out = await handleProviderEvent(
    "tmtest",
    ev({ type: "charge.succeeded", providerChargeId: req.providerChargeId! }),
    { businessId: biz.id },
  );
  const excessAfter = await withTenant(orgId, (tx) =>
    bucketBalance(tx, customer.id, EXCESS_PAYMENT, "USD"),
  );
  const after = await requestRow(res.body.id);
  check(
    "6 webhook success settles the request",
    out === "processed" && after.status === "paid",
    `${out} ${after.status}`,
  );
  check(
    "6 the overshoot child (INV-B paid meanwhile) became customer credit",
    excessAfter - excessBefore === 12000n,
    `excess +${excessAfter - excessBefore}`,
  );
  check("6 INV-A paid", (await getInv(a!.id)).status === "paid");
}

// ── 7. Gateway refund on the charge spreads newest invoice first ──────────────
let refundCase: { pid: string; chargeId: string; ids: string[] };
{
  const {
    customer,
    invoices: [a, b, c],
  } = await threeOpenInvoices("gwrefund");
  const pm = await goodCard(customer);
  const res = await call("POST", `/customers/${customer.publicId}/payment_requests`, {
    invoices: [a!.publicId, b!.publicId, c!.publicId],
    mode: "charge",
    payment_method: pm.publicId,
  });
  const req = await requestRow(res.body.id);
  refundCase = { pid: res.body.id, chargeId: req.providerChargeId!, ids: [a!.id, b!.id, c!.id] };
  const out = await handleProviderEvent(
    "tmtest",
    ev({
      type: "charge.refunded",
      providerChargeId: req.providerChargeId!,
      providerRefundId: `re_gw_${RUN}`,
      amountRefundedMinor: 13000n,
    }),
    { businessId: biz.id },
  );
  const kids = await childrenOf(res.body.id);
  const rf = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(refunds)
      .where(sql`${refunds.paymentId} in ${kids.map((k) => k.id)}`),
  );
  const byInv = (id: string) =>
    rf
      .filter((r) => kids.find((k) => k.id === r.paymentId)?.invoiceId === id)
      .reduce((s, r) => s + r.amountMinor, 0n);
  check(
    "7 gateway refund 130.00: INV-C 30.00, INV-B 100.00, INV-A 0",
    out === "processed" && byInv(c!.id) === 3000n && byInv(b!.id) === 10000n && byInv(a!.id) === 0n,
    `${out} C=${byInv(c!.id)} B=${byInv(b!.id)} A=${byInv(a!.id)}`,
  );
  const again = await handleProviderEvent(
    "tmtest",
    ev({
      type: "charge.refunded",
      providerChargeId: req.providerChargeId!,
      providerRefundId: `re_gw_${RUN}`,
      amountRefundedMinor: 13000n,
    }),
    { businessId: biz.id },
  );
  check(
    "7 replay of the same refund books nothing",
    again === "ignored" || again === "duplicate",
    String(again),
  );
}

// ── 8. Child refund through the payment, and through a credit note ────────────
{
  const kids = await childrenOf(worked.pid);
  const childB = kids.find((k) => k.invoiceId === worked.ids[1])!;
  const r = await refundPayment({
    organizationId: orgId,
    businessId: biz.id,
    paymentPublicId: childB.publicId,
    amountMinor: 5000,
  }).catch((e) => e as Error);
  check(
    "8 refund a child: partial refund of the shared charge",
    !(r instanceof Error) && r.status !== "failed",
    r instanceof Error ? r.message : r.status,
  );
  const invA = await getInv(refundCase.ids[0]!);
  const cn = await refundInvoiceViaCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: invA.publicId,
  }).catch((e) => e as Error);
  check(
    "8 refund an invoice through a credit note reaches its child",
    !(cn instanceof Error) && cn.cardRefundedMinor === 5000,
    cn instanceof Error ? cn.message : `card=${cn.cardRefundedMinor}`,
  );
}

// ── 9. Dispute on the charge is attributed to the newest invoice ──────────────
{
  const out = await handleProviderEvent(
    "tmtest",
    ev({
      type: "dispute.created",
      providerChargeId: refundCase.chargeId,
      providerDisputeId: `dp_${RUN}`,
      disputeAmountMinor: 3000n,
      disputeCurrency: "USD",
    }),
    { businessId: biz.id, providerKey: "tmtest" } as never,
  );
  const [d] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(disputes)
      .where(eq(disputes.providerDisputeId, `dp_${RUN}`)),
  );
  const kids = await childrenOf(refundCase.pid);
  const newest = kids.find((k) => k.invoiceId === refundCase.ids[2]);
  check(
    "9 dispute correlates to the newest child",
    out === "processed" && d?.paymentId === newest?.id,
    `${out} ${d?.paymentId === newest?.id}`,
  );
}

// ── 10. Late failure reverses every child and reopens the invoices ────────────
{
  const {
    customer,
    invoices: [a, b],
  } = await threeOpenInvoices("late");
  const pm = await goodCard(customer);
  const res = await call("POST", `/customers/${customer.publicId}/payment_requests`, {
    invoices: [a!.publicId, b!.publicId],
    mode: "charge",
    payment_method: pm.publicId,
  });
  const req = await requestRow(res.body.id);
  const out = await handleProviderEvent(
    "tmtest",
    ev({
      type: "charge.failed",
      providerChargeId: req.providerChargeId!,
      raw: { data: { reversal: true } },
    }),
    { businessId: biz.id },
  );
  const kids = await childrenOf(res.body.id);
  const [aa, bb] = [await getInv(a!.id), await getInv(b!.id)];
  const after = await requestRow(res.body.id);
  check(
    "10 late failure: children failed late_failure",
    out === "processed" &&
      kids.every((k) => k.status === "failed" && k.failureCode === "late_failure"),
    `${out} ${kids.map((k) => `${k.status}/${k.failureCode}`)}`,
  );
  check(
    "10 late failure: both invoices reopen",
    aa.status === "payment_due" && bb.status === "payment_due",
    `${aa.status} ${bb.status}`,
  );
  check("10 late failure: request reopens", after.status === "open", after.status);
}

// ── 11. Offline partial payment on a request ───────────────────────────────────
{
  const {
    customer,
    invoices: [a, b, c],
  } = await threeOpenInvoices("offline");
  const link = await createPaymentRequest({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: customer.publicId,
    invoicePublicIds: [a!.publicId, b!.publicId, c!.publicId],
    mode: "link",
  });
  const v = await recordPaymentRequestPayment({
    organizationId: orgId,
    businessId: biz.id,
    paymentRequestPublicId: link.request.publicId,
    amountMinor: 10000,
    method: "cash",
  });
  const [aa, bb, cc] = [await getInv(a!.id), await getInv(b!.id), await getInv(c!.id)];
  check(
    "11 offline 100.00 of 200.00: INV-A paid, INV-B 50.00 of 120.00, INV-C untouched",
    aa.status === "paid" &&
      bb.status !== "paid" &&
      cc.status !== "paid" &&
      v.amountMinor === 10000n &&
      v.request.status === "open",
    `${aa.status} ${bb.status} ${cc.status} left=${v.amountMinor} ${v.request.status}`,
  );
  const recs = await withTenant(orgId, (tx) =>
    tx.select().from(receipts).where(eq(receipts.paymentRequestId, link.request.id)),
  );
  check(
    "11 offline: one receipt for 100.00",
    recs.length === 1 && recs[0]!.amountMinor === 10000n,
    `n=${recs.length}`,
  );
  const over = await call("POST", `/payment_requests/${link.request.publicId}/record_payment`, {
    amount_minor: 999999,
  });
  check("11 offline: more than the request owes is refused", over.status === 400, `${over.status}`);
}

// ── 12. Stale sweep settles a request transaction ──────────────────────────────
{
  const {
    customer,
    invoices: [a],
  } = await threeOpenInvoices("sweep");
  const pm = await goodCard(customer, "4000000000000101");
  const res = await call("POST", `/customers/${customer.publicId}/payment_requests`, {
    invoices: [a!.publicId],
    mode: "charge",
    payment_method: pm.publicId,
  });
  const req = await requestRow(res.body.id);
  const [txn] = await withTenant(orgId, (tx) =>
    tx.select().from(transactions).where(eq(transactions.paymentRequestId, req.id)),
  );
  const sweep = () =>
    runWithClockScope({ onlyBusinessId: biz.id, now: new Date() }, () =>
      sweepStalePendingCharges(new Date(), { onlyTransactionId: txn!.id }),
    );
  const r0 = await sweep();
  const mid = await requestRow(res.body.id);
  check(
    "12 stale sweep: a still-pending charge leaves the request processing",
    r0.stillPending === 1 && mid.status === "processing",
    `pending=${r0.stillPending} ${mid.status}`,
  );
  // The gateway now reports the charge settled.
  await systemDb.execute(
    sql`update tmtest_charges set status = 'succeeded' where charge_id = ${req.providerChargeId}`,
  );
  const r1 = await sweep();
  const after = await requestRow(res.body.id);
  check(
    "12 stale sweep: a settled charge pays the request and its invoice",
    r1.settled === 1 && after.status === "paid" && (await getInv(a!.id)).status === "paid",
    `settled=${r1.settled} ${after.status}`,
  );
}

// ── 13. One charge still books at most one payment ────────────────────────────
{
  const { customer } = await threeOpenInvoices("uq");
  let refused = false;
  try {
    await withTenant(orgId, async (tx) => {
      for (let i = 0; i < 2; i++)
        await tx.insert(payments).values({
          organizationId: orgId,
          businessId: biz.id,
          customerId: customer.id,
          publicId: `pay_uq_${RUN}_${i}`,
          status: "succeeded",
          amountMinor: 100n,
          currency: "USD",
          providerKey: "tmtest",
          providerChargeId: `ch_uq_${RUN}`,
        });
    });
  } catch {
    refused = true;
  }
  check("13 payments_provider_charge_uq still refuses two payments on one charge", refused);
  const children = await withTenant(orgId, (tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(payments)
      .where(
        and(
          sql`${payments.paymentRequestId} is not null`,
          sql`${payments.providerChargeId} is not null`,
          sql`${payments.providerKey} <> 'offline'`,
        ),
      ),
  );
  check(
    "13 no request child carries a gateway charge id",
    children[0]?.n === 0,
    `n=${children[0]?.n}`,
  );
}

// ── 14. Portal pay sets initiator = customer ───────────────────────────────────
{
  const {
    customer,
    invoices: [a],
  } = await threeOpenInvoices("portal");
  const pm = await goodCard(customer);
  const link = await createPaymentRequest({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: customer.publicId,
    invoicePublicIds: [a!.publicId],
    mode: "link",
  });
  await chargePaymentRequest({
    organizationId: orgId,
    businessId: biz.id,
    paymentRequestPublicId: link.request.publicId,
    paymentMethodPublicId: pm.publicId,
    initiator: "customer",
    customerId: customer.id,
  });
  const last = charges[charges.length - 1]!;
  check(
    "14 portal pay: initiator = customer",
    last.initiator?.by === "customer",
    JSON.stringify(last.initiator),
  );
}

// ── 15. Capture after an abandoned (AFA) request charge pays the invoices still owed ─
/** A request for INV-A + INV-B (170.00) whose charge was abandoned as `afa_not_completed`. */
async function abandonedRequest(label: string) {
  const {
    customer,
    invoices: [a, b],
  } = await threeOpenInvoices(label);
  const pm = await goodCard(customer, "4000000000000101");
  const res = await call("POST", `/customers/${customer.publicId}/payment_requests`, {
    invoices: [a!.publicId, b!.publicId],
    mode: "charge",
    payment_method: pm.publicId,
  });
  const req = await requestRow(res.body.id);
  await handleProviderEvent(
    "tmtest",
    ev({
      type: "charge.failed",
      providerChargeId: req.providerChargeId!,
      failureCode: "afa_not_completed",
    }),
    { businessId: biz.id },
  );
  // The gateway captures it after all.
  await systemDb.execute(
    sql`update tmtest_charges set status = 'succeeded' where charge_id = ${req.providerChargeId}`,
  );
  const txnOf = async () =>
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(transactions).where(eq(transactions.paymentRequestId, req.id)),
      )
    )[0]!;
  return {
    customer,
    a: a!,
    b: b!,
    pid: res.body.id as string,
    req,
    chargeId: req.providerChargeId!,
    txnOf,
  };
}
const capture = (chargeId: string, extra: Record<string, unknown> = {}) =>
  handleProviderEvent(
    "tmtest",
    ev({ type: "charge.succeeded", providerChargeId: chargeId, ...extra } as never),
    { businessId: biz.id },
  );
const succeededChildMinor = async (pid: string) =>
  (await childrenOf(pid))
    .filter((k) => k.status === "succeeded")
    .reduce((s, k) => s + k.amountMinor, 0n);
const refundedMinor = async (pid: string) => {
  const kids = await childrenOf(pid);
  const rf = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(refunds)
      .where(sql`${refunds.paymentId} in ${kids.map((k) => k.id)}`),
  );
  return rf.filter((r) => r.status !== "failed").reduce((s, r) => s + r.amountMinor, 0n);
};
const chargeIdPayments = (chargeId: string) =>
  withTenant(orgId, (tx) =>
    tx
      .select()
      .from(payments)
      .where(and(eq(payments.businessId, biz.id), eq(payments.providerChargeId, chargeId))),
  );
{
  const s = await abandonedRequest("latefull");
  const t0 = await s.txnOf();
  check(
    "15 setup: the request charge failed as afa_not_completed",
    t0.status === "failed" && t0.errorCode === "afa_not_completed",
    `${t0.status} ${t0.errorCode}`,
  );
  const excessBefore = await withTenant(orgId, (tx) =>
    bucketBalance(tx, s.customer.id, EXCESS_PAYMENT, "USD"),
  );
  const out = await capture(s.chargeId);
  const [aa, bb] = [await getInv(s.a.id), await getInv(s.b.id)];
  const t1 = await s.txnOf();
  const excessAfter = await withTenant(orgId, (tx) =>
    bucketBalance(tx, s.customer.id, EXCESS_PAYMENT, "USD"),
  );
  check(
    "15 late capture: both invoices paid",
    out === "processed" && aa.status === "paid" && bb.status === "paid",
    `${out} ${aa.status} ${bb.status}`,
  );
  check(
    "15 late capture: 170.00 booked on the children, nothing refunded",
    (await succeededChildMinor(s.pid)) === 17000n && (await refundedMinor(s.pid)) === 0n,
    `children=${await succeededChildMinor(s.pid)} refunded=${await refundedMinor(s.pid)}`,
  );
  check(
    "15 late capture: no credit left, no payment row on the charge",
    excessAfter === excessBefore && (await chargeIdPayments(s.chargeId)).length === 0,
    `excess ${excessBefore}→${excessAfter}`,
  );
  check(
    "15 late capture: transaction succeeded, failure cleared; request paid",
    t1.status === "succeeded" &&
      t1.errorCode === null &&
      (await requestRow(s.pid)).status === "paid",
    `${t1.status} ${t1.errorCode} ${(await requestRow(s.pid)).status}`,
  );
  const recs = await withTenant(orgId, (tx) =>
    tx.select().from(receipts).where(eq(receipts.paymentRequestId, s.req.id)),
  );
  check(
    "15 late capture: one receipt for 170.00",
    recs.length === 1 && recs[0]!.amountMinor === 17000n,
    `n=${recs.length} ${recs[0]?.amountMinor}`,
  );
}
{
  const s = await abandonedRequest("latepartial");
  // INV-B (120.00, the newest) is paid by bank transfer before the capture arrives.
  await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: s.b.publicId,
    method: "bank_transfer",
  });
  const excessBefore = await withTenant(orgId, (tx) =>
    bucketBalance(tx, s.customer.id, EXCESS_PAYMENT, "USD"),
  );
  const out = await capture(s.chargeId);
  const excessAfter = await withTenant(orgId, (tx) =>
    bucketBalance(tx, s.customer.id, EXCESS_PAYMENT, "USD"),
  );
  check(
    "15 paid elsewhere: INV-A takes 50.00 and is paid",
    out === "processed" && (await getInv(s.a.id)).status === "paid",
    `${out} ${(await getInv(s.a.id)).status}`,
  );
  check(
    "15 paid elsewhere: INV-B's 120.00 is refunded, not held",
    (await refundedMinor(s.pid)) === 12000n && excessAfter === excessBefore,
    `refunded=${await refundedMinor(s.pid)} excess ${excessBefore}→${excessAfter}`,
  );
}
{
  const s = await abandonedRequest("lateredeliver");
  const outs = await Promise.all([capture(s.chargeId), capture(s.chargeId)]);
  const third = await capture(s.chargeId);
  check(
    "15 redelivery: booked once across concurrent and repeated deliveries",
    outs.filter((o) => o === "processed").length === 1 &&
      third !== "processed" &&
      (await succeededChildMinor(s.pid)) === 17000n,
    `${outs.join(",")} ${third} children=${await succeededChildMinor(s.pid)}`,
  );
  check(
    "15 redelivery: nothing refunded, no payment row on the charge",
    (await refundedMinor(s.pid)) === 0n && (await chargeIdPayments(s.chargeId)).length === 0,
    `refunded=${await refundedMinor(s.pid)}`,
  );
}
{
  const s = await abandonedRequest("latemismatch");
  const out = await capture(s.chargeId, { capturedAmountMinor: 16900n });
  const t = await s.txnOf();
  check(
    "15 amount mismatch: refused, nothing booked",
    out === "ignored" &&
      t.status === "failed" &&
      (await succeededChildMinor(s.pid)) === 0n &&
      (await chargeIdPayments(s.chargeId)).length === 0,
    `${out} ${t.status} children=${await succeededChildMinor(s.pid)}`,
  );
  check(
    "15 amount mismatch: invoices still owed",
    (await getInv(s.a.id)).status !== "paid" && (await getInv(s.b.id)).status !== "paid",
  );
}

// ── 16. Late failure on a charge with a no-invoice child reverses what that child holds ─
const reversal = (chargeId: string) =>
  handleProviderEvent(
    "tmtest",
    ev({ type: "charge.failed", providerChargeId: chargeId, raw: { data: { reversal: true } } }),
    { businessId: biz.id },
  );
/** Reversal lines posted against the request's children: cash out, and AR re-opened per child. */
const reversalLines = async (pid: string) => {
  const kids = await childrenOf(pid);
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(ledgerEntries)
      .where(
        and(
          sql`${ledgerEntries.sourceType} in ('payment_reversal', 'excess_payment_reversal')`,
          sql`${ledgerEntries.sourceId} in ${kids.map((k) => k.publicId)}`,
        ),
      ),
  );
  const sum = (account: string, direction: string, ids?: string[]) =>
    rows
      .filter(
        (r) =>
          r.account === account && r.direction === direction && (!ids || ids.includes(r.sourceId)),
      )
      .reduce((s, r) => s + r.amountMinor, 0n);
  const detached = kids.filter((k) => k.invoiceId === null).map((k) => k.publicId);
  return {
    cashOut: sum("cash", "credit"),
    arOnDetached: sum("accounts_receivable", "debit", detached),
    detached: detached.length,
  };
};
{
  // Late capture: INV-A takes 50.00, INV-B's 120.00 is an excess child refunded at once.
  const s = await abandonedRequest("latereverse");
  await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: s.b.publicId,
    method: "bank_transfer",
  });
  await capture(s.chargeId);
  const excessBefore = await withTenant(orgId, (tx) =>
    bucketBalance(tx, s.customer.id, EXCESS_PAYMENT, "USD"),
  );
  const out = await reversal(s.chargeId);
  const lines = await reversalLines(s.pid);
  const excessAfter = await withTenant(orgId, (tx) =>
    bucketBalance(tx, s.customer.id, EXCESS_PAYMENT, "USD"),
  );
  check(
    "16 refunded excess child: setup has one",
    (await refundedMinor(s.pid)) === 12000n && lines.detached === 1,
    `refunded=${await refundedMinor(s.pid)} detached=${lines.detached}`,
  );
  check(
    "16 refunded excess child: no AR re-opened for it",
    out === "processed" && lines.arOnDetached === 0n,
    `${out} ar=${lines.arOnDetached}`,
  );
  check(
    "16 refunded excess child: cash out is INV-A's 50.00 only (the 120.00 already left)",
    lines.cashOut === 5000n,
    `cash=${lines.cashOut}`,
  );
  check(
    "16 refunded excess child: customer credit unchanged",
    excessAfter === excessBefore,
    `${excessBefore}→${excessAfter}`,
  );
  check(
    "16 refunded excess child: INV-A reopens",
    (await getInv(s.a.id)).status === "payment_due",
    (await getInv(s.a.id)).status,
  );
}
{
  // Overshoot: INV-B paid by transfer while the charge is in flight → its child became credit.
  const {
    customer,
    invoices: [a, b],
  } = await threeOpenInvoices("overshootreverse");
  const pm = await goodCard(customer, "4000000000000101");
  const res = await call("POST", `/customers/${customer.publicId}/payment_requests`, {
    invoices: [a!.publicId, b!.publicId],
    mode: "charge",
    payment_method: pm.publicId,
  });
  const req = await requestRow(res.body.id);
  await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: b!.publicId,
    method: "bank_transfer",
  });
  const excessStart = await withTenant(orgId, (tx) =>
    bucketBalance(tx, customer.id, EXCESS_PAYMENT, "USD"),
  );
  await handleProviderEvent(
    "tmtest",
    ev({ type: "charge.succeeded", providerChargeId: req.providerChargeId! }),
    { businessId: biz.id },
  );
  const excessHeld = await withTenant(orgId, (tx) =>
    bucketBalance(tx, customer.id, EXCESS_PAYMENT, "USD"),
  );
  const out = await reversal(req.providerChargeId!);
  const lines = await reversalLines(res.body.id);
  const excessAfter = await withTenant(orgId, (tx) =>
    bucketBalance(tx, customer.id, EXCESS_PAYMENT, "USD"),
  );
  check(
    "16 overshoot child: setup held 120.00 as credit",
    excessHeld - excessStart === 12000n && lines.detached === 1,
    `+${excessHeld - excessStart} detached=${lines.detached}`,
  );
  check(
    "16 overshoot child: no AR re-opened for it",
    out === "processed" && lines.arOnDetached === 0n,
    `${out} ar=${lines.arOnDetached}`,
  );
  check(
    "16 overshoot child: its 120.00 of credit is taken back",
    excessAfter === excessStart,
    `${excessStart}→${excessHeld}→${excessAfter}`,
  );
  check(
    "16 overshoot child: cash out is the whole 170.00",
    lines.cashOut === 17000n,
    `cash=${lines.cashOut}`,
  );
  check(
    "16 overshoot child: INV-A reopens, INV-B stays paid",
    (await getInv(a!.id)).status === "payment_due" && (await getInv(b!.id)).status === "paid",
    `${(await getInv(a!.id)).status} ${(await getInv(b!.id)).status}`,
  );
}

// ── 17. The AFA recheck sweep books a request's late capture, once, beside the webhook ─
const afaSweep = () =>
  runWithClockScope({ onlyBusinessId: biz.id, now: new Date() }, () =>
    sweepStalePendingCharges(new Date()),
  );
const requestReceipts = async (requestId: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx.select().from(receipts).where(eq(receipts.paymentRequestId, requestId)),
    )
  ).length;
{
  const s = await abandonedRequest("latesweep");
  const r = await afaSweep();
  const t = await s.txnOf();
  check(
    "17 sweep alone: both invoices paid, 170.00 on the children",
    r.afaRecovered >= 1 &&
      (await getInv(s.a.id)).status === "paid" &&
      (await getInv(s.b.id)).status === "paid" &&
      (await succeededChildMinor(s.pid)) === 17000n,
    `recovered=${r.afaRecovered} children=${await succeededChildMinor(s.pid)}`,
  );
  check(
    "17 sweep alone: transaction succeeded, request paid, one receipt",
    t.status === "succeeded" &&
      (await requestRow(s.pid)).status === "paid" &&
      (await requestReceipts(s.req.id)) === 1,
    `${t.status} ${(await requestRow(s.pid)).status}`,
  );
  await afaSweep();
  check(
    "17 sweep alone: the next tick books nothing",
    (await succeededChildMinor(s.pid)) === 17000n && (await requestReceipts(s.req.id)) === 1,
    `children=${await succeededChildMinor(s.pid)}`,
  );
}
{
  const s = await abandonedRequest("latesweepexcess");
  await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: s.b.publicId,
    method: "bank_transfer",
  });
  await afaSweep();
  check(
    "17 sweep, INV-B paid meanwhile: INV-A takes 50.00, 120.00 refunded",
    (await getInv(s.a.id)).status === "paid" && (await refundedMinor(s.pid)) === 12000n,
    `${(await getInv(s.a.id)).status} refunded=${await refundedMinor(s.pid)}`,
  );
}
{
  const s = await abandonedRequest("latesweeprace");
  const [w1, r1] = await Promise.all([capture(s.chargeId), afaSweep()]);
  const w2 = await capture(s.chargeId);
  const r2 = await afaSweep();
  const booked =
    [w1, w2].filter((o) => o === "processed").length + r1.afaRecovered + r2.afaRecovered;
  check(
    "17 webhook + sweep: exactly one of them books it",
    booked === 1,
    `webhook=${w1},${w2} sweep=${r1.afaRecovered},${r2.afaRecovered}`,
  );
  check(
    "17 webhook + sweep: 170.00 once, nothing refunded, one receipt, no payment row on the charge",
    (await succeededChildMinor(s.pid)) === 17000n &&
      (await refundedMinor(s.pid)) === 0n &&
      (await requestReceipts(s.req.id)) === 1 &&
      (await chargeIdPayments(s.chargeId)).length === 0,
    `children=${await succeededChildMinor(s.pid)} refunded=${await refundedMinor(s.pid)} receipts=${await requestReceipts(s.req.id)}`,
  );
}
{
  // A refused mismatch must stay refused: the sweep has no amount to compare and would book 170.00.
  const s = await abandonedRequest("latesweepmismatch");
  const out = await capture(s.chargeId, { capturedAmountMinor: 16900n });
  const t = await s.txnOf();
  check(
    "17 amount mismatch: refused, transaction re-coded off the AFA code",
    out === "ignored" &&
      t.status === "failed" &&
      t.errorCode === "capture_amount_mismatch" &&
      /afa_not_completed/.test(t.errorText ?? "") &&
      /16900/.test(t.errorText ?? "") &&
      /17000/.test(t.errorText ?? ""),
    `${out} ${t.status} ${t.errorCode} ${t.errorText}`,
  );
  await afaSweep();
  const redelivered = await capture(s.chargeId, { capturedAmountMinor: 16900n });
  const bare = await capture(s.chargeId);
  // A sweep that selected the row before it was re-coded still reaches the settle call.
  const stale = await reconcileLateRequestCapture(t, {
    providerKey: "tmtest",
    chargeId: s.chargeId,
    occurredAt: new Date(),
  });
  check(
    "17 amount mismatch: the sweep and redeliveries book nothing",
    redelivered === "ignored" &&
      bare !== "processed" &&
      stale === "ignored" &&
      (await s.txnOf()).status === "failed" &&
      (await succeededChildMinor(s.pid)) === 0n &&
      (await refundedMinor(s.pid)) === 0n &&
      (await chargeIdPayments(s.chargeId)).length === 0 &&
      (await getInv(s.a.id)).status !== "paid" &&
      (await getInv(s.b.id)).status !== "paid",
    `redelivered=${redelivered} bare=${bare} stale=${stale} children=${await succeededChildMinor(s.pid)}`,
  );
}

// ── 18. A late failure never re-arms an invoice that other money still pays ──────
{
  const {
    customer,
    invoices: [a, b, c],
  } = await threeOpenInvoices("stillpaid");
  const pm = await goodCard(customer);
  const res = await call("POST", `/customers/${customer.publicId}/payment_requests`, {
    invoices: [a!.publicId, b!.publicId],
    mode: "charge",
    payment_method: pm.publicId,
  });
  const req = await requestRow(res.body.id);
  const direct = await collectInvoiceNow(orgId, biz.id, c!.publicId, {
    paymentMethodOverrideId: pm.publicId,
  });
  // A second payment pays invoices a and c in full as well.
  for (const inv of [a!, c!])
    await withTenant(orgId, (tx) =>
      tx.insert(payments).values({
        organizationId: orgId,
        businessId: biz.id,
        customerId: customer.id,
        invoiceId: inv.id,
        publicId: `pay_${RUN}_second_${inv.publicId.slice(-6)}`,
        status: "succeeded",
        amountMinor: inv.totalMinor,
        currency: "USD",
        providerKey: "offline",
        providerChargeId: `cash_${RUN}_${inv.publicId.slice(-6)}`,
      }),
    );
  const outReq = await reversal(req.providerChargeId!);
  const outDirect = await reversal(direct.payment!.providerChargeId!);
  const [aa, bb, cc] = [await getInv(a!.id), await getInv(b!.id), await getInv(c!.id)];
  // Any re-arm announces itself with `reopened: late_failure`.
  const reopened = [
    ...(await eventsOf("invoice_payment_due")),
    ...(await eventsOf("invoice_not_paid")),
  ]
    .map((e) => JSON.stringify(e.data))
    .filter((d) => d.includes("late_failure"));
  const stillPaid = (i: typeof aa) =>
    i.status === "paid" &&
    i.paidAt != null &&
    i.nextAttemptAt == null &&
    i.dunningStatus !== "in_progress";
  check(
    "18 request late failure: the invoice a second payment pays stays paid, no dunning",
    outReq === "processed" && stillPaid(aa) && !reopened.some((d) => d.includes(aa.publicId)),
    `${outReq} ${aa.status} ${aa.dunningStatus} ${aa.nextAttemptAt?.toISOString()}`,
  );
  check(
    "18 request late failure: the invoice only the reversed charge paid reopens",
    bb.status === "payment_due",
    bb.status,
  );
  check(
    "18 direct late failure: the invoice a second payment pays stays paid, no dunning",
    outDirect === "processed" && stillPaid(cc) && !reopened.some((d) => d.includes(cc.publicId)),
    `${outDirect} ${cc.status} ${cc.dunningStatus} ${cc.nextAttemptAt?.toISOString()}`,
  );
}

await app.close();
TmtestProvider.prototype.charge = realCharge;
const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} passed`);
console.log(failed ? "❌ PAYMENT-REQUESTS: FAIL" : "✅ PAYMENT-REQUESTS: PASS");
await closeDb();
process.exit(failed ? 1 : 0);

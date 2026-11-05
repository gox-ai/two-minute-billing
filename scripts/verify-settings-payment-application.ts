/**
 * Payment application and credit settings (Part B Phase 2, slice H):
 *   2.51 several due invoices (separate | combined | customer_chooses)
 *   2.66 open-invoice order (oldest_first | newest_first | customer_chooses)
 *   2.69 excess payment (credit | refund | customer_chooses)
 *   2.55 credit scope (meters on a grant; credit_config.credit_scope)
 * 2.54 (paid credit only after payment) is today's rule for every pack; `verify:credit-packs` pins it.
 *
 *   pnpm verify:settings-payment-application
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { buildApp } from "@/index";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod, createInvoiceFromLines } from "@/modules/invoicing/service";
import { collectInvoiceNow } from "@/modules/invoicing/ops";
import { retryDueInvoice } from "@/modules/subscriptions/dunning";
import { recordExcessPayment } from "@/modules/customers/balances";
import { bucketBalance, EXCESS_PAYMENT } from "@/modules/customers/balances-read";
import {
  listCustomerOverpayments,
  refundCustomerOverpayment,
  refundExcessPayment,
} from "@/modules/refunds/excess";
import { presentations } from "@/modules/invoicing/representment";
import { settlePaymentSucceeded, settleTransactionOutcome } from "@/modules/payments/settlement";
import {
  cancelPaymentRequest,
  createPaymentRequest,
  payInvoicesFromPortal,
  PortalPayNotAllowedError,
} from "@/modules/payment-requests/service";
import { resolvePaymentApplication } from "@/modules/payments/application-config";
import { createMeter } from "@/modules/metering/meters";
import { loadPlannerGrants } from "@/modules/credits/service";
import { grantCoversLine } from "@/modules/credits/planner";
import { TmtestProvider } from "@/providers/tmtest";
import type { ChargeInput } from "@/providers/types";
import {
  businesses,
  creditGrants,
  invoices,
  paymentMethods,
  paymentRequests,
  payments,
  refunds,
  subscriptions,
  transactions,
} from "@db/schema";

const RUN = randomUUID().slice(0, 8);
const checks: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  checks.push([name, ok, detail]);
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const charges: ChargeInput[] = [];
const realCharge = TmtestProvider.prototype.charge;
TmtestProvider.prototype.charge = function (this: TmtestProvider, input: ChargeInput) {
  charges.push(input);
  return realCharge.call(this, input);
};

const org = await createOrganization({ name: `Payment application ${RUN}` });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "PA Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
await systemDb
  .update(businesses)
  .set({ dunningConfig: { collect_on_payment_method_update: false } })
  .where(eq(businesses.id, biz.id));
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
const priceOf = (amountMinor: number) =>
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
const call = async (method: "GET" | "PATCH" | "POST", url: string, payload?: object) => {
  const res = await app.inject({
    method,
    url: `/v1/businesses/${biz.publicId}${url}`,
    headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": `pa-${RUN}-${n++}` },
    ...(payload ? { payload } : {}),
  });
  return { status: res.statusCode, body: JSON.parse(res.body || "null") };
};
const setPa = (pa: Record<string, string>) =>
  call("PATCH", "", { billing_rules_config: { payment_application: pa } });
const getInv = (id: string) =>
  withTenant(
    orgId,
    async (tx) => (await tx.select().from(invoices).where(eq(invoices.id, id)).limit(1))[0]!,
  );

/**
 * Three invoices that failed on `token` (50.00 / 120.00 / 30.00, due 1 Sep / 1 Oct / 15 Oct),
 * each in dunning. `retryWith` becomes every subscription's card before the retry.
 */
async function threeInDunning(
  label: string,
  retryWith?: string,
  list: Array<typeof p50> = [p50, p120, p30],
) {
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `${label}-${RUN}@example.com`,
  });
  const bad = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "4000000000009995",
  });
  const ids: string[] = [];
  const subIds: string[] = [];
  const dues = ["2026-09-01", "2026-10-01", "2026-10-15", "2026-10-20", "2026-10-25"].map(
    (d) => new Date(`${d}T00:00:00Z`),
  );
  for (const [i, price] of list.entries()) {
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
    subIds.push(sub.subscription.id);
  }
  if (retryWith) {
    const pm = await vaultPaymentMethod({
      organizationId: orgId,
      businessId: biz.id,
      customer,
      token: retryWith,
    });
    await systemDb
      .update(subscriptions)
      .set({ defaultPaymentMethodId: pm.id })
      .where(inArray(subscriptions.id, subIds));
  }
  return { customer, ids, subIds, badPm: bad };
}
/** Make every retry due now. */
const dueNow = (ids: string[]) =>
  systemDb
    .update(invoices)
    .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
    .where(inArray(invoices.id, ids));
const retry = (id: string, subId: string) =>
  retryDueInvoice(
    { id, organizationId: orgId, businessId: biz.id, subscriptionId: subId },
    new Date(),
  );
const requestsOf = (customerId: string) =>
  withTenant(orgId, (tx) =>
    tx.select().from(paymentRequests).where(eq(paymentRequests.customerId, customerId)),
  );

// ── 0. Unset = today; the API stores and merges the block ─────────────────────
{
  const d = resolvePaymentApplication({ billingRulesConfig: null });
  const junk = resolvePaymentApplication({
    billingRulesConfig: { payment_application: { several_due_invoices: "x", invoice_order: 3 } },
  });
  check(
    "0A resolver: absent or unknown values resolve to today (separate, oldest first, credit)",
    d.severalDueInvoices === "separate" &&
      d.invoiceOrder === "oldest_first" &&
      d.excessPayment === "credit" &&
      junk.severalDueInvoices === "separate" &&
      junk.invoiceOrder === "oldest_first",
    JSON.stringify(d),
  );
  const read = await call("GET", "");
  check(
    "0B an API-created business reads today's values",
    JSON.stringify(read.body?.billing_rules_config?.payment_application) ===
      JSON.stringify({
        several_due_invoices: "separate",
        invoice_order: "oldest_first",
        excess_payment: "credit",
      }),
    JSON.stringify(read.body?.billing_rules_config?.payment_application),
  );
  const a = await setPa({ excess_payment: "refund" });
  const b = await setPa({ invoice_order: "newest_first" });
  check(
    "0C a PATCH of one key keeps the others",
    a.status === 200 &&
      b.status === 200 &&
      b.body.billing_rules_config.payment_application.excess_payment === "refund" &&
      b.body.billing_rules_config.payment_application.invoice_order === "newest_first" &&
      b.body.billing_rules_config.payment_application.several_due_invoices === "separate",
    JSON.stringify(b.body?.billing_rules_config?.payment_application),
  );
  const bad = await setPa({ invoice_order: "random" });
  check("0D an unknown value is refused (400)", bad.status === 400, `status=${bad.status}`);
  await setPa({
    several_due_invoices: "separate",
    invoice_order: "oldest_first",
    excess_payment: "credit",
  });
}

// ── 1. 2.51 several due invoices ────────────────────────────────────────────────
{
  // Today: one retry charges one invoice.
  const s = await threeInDunning("separate", "tok_4242");
  await dueNow(s.ids);
  const before = charges.length;
  await retry(s.ids[0]!, s.subIds[0]!);
  const [a, b, c] = [await getInv(s.ids[0]!), await getInv(s.ids[1]!), await getInv(s.ids[2]!)];
  check(
    "1A separate (unset): the retry charges only its own invoice",
    charges.length - before === 1 &&
      charges[charges.length - 1]!.amountMinor === 5000n &&
      a.status === "paid" &&
      b.status === "payment_due" &&
      c.status === "payment_due" &&
      (await requestsOf(s.customer.id)).length === 0,
    `charges=${charges.length - before} b=${b.status} c=${c.status}`,
  );
}
{
  await setPa({ several_due_invoices: "combined" });
  const s = await threeInDunning("combined-ok", "tok_4242");
  await dueNow(s.ids);
  const attemptsBefore = (await Promise.all(s.ids.map(getInv))).map((i) => i.attemptCount);
  const before = charges.length;
  const outcome = await retry(s.ids[0]!, s.subIds[0]!);
  const rows = await Promise.all(s.ids.map(getInv));
  const [req] = await requestsOf(s.customer.id);
  const kids = req
    ? await withTenant(orgId, (tx) =>
        tx.select().from(payments).where(eq(payments.paymentRequestId, req.id)),
      )
    : [];
  check(
    "1B combined: one charge of 200.00 pays all three due invoices",
    outcome === "recovered" &&
      charges.length - before === 1 &&
      charges[charges.length - 1]!.amountMinor === 20000n &&
      rows.every((r) => r.status === "paid"),
    `outcome=${outcome} charges=${charges.length - before} amount=${charges[charges.length - 1]?.amountMinor} statuses=${rows.map((r) => r.status)}`,
  );
  check(
    "1C combined: a dunning-origin request, paid, one child payment per invoice at its own amount",
    req?.origin === "dunning" &&
      req.status === "paid" &&
      kids.length === 3 &&
      kids.every((k) => k.status === "succeeded") &&
      kids
        .map((k) => Number(k.amountMinor))
        .sort((x, y) => x - y)
        .join() === "3000,5000,12000",
    `origin=${req?.origin} status=${req?.status} kids=${kids.map((k) => `${k.status}:${k.amountMinor}`)}`,
  );
  check(
    "1D combined: each invoice counts one dunning attempt",
    rows.every((r, i) => r.attemptCount === attemptsBefore[i]! + 1),
    `before=${attemptsBefore} after=${rows.map((r) => r.attemptCount)}`,
  );
}
{
  const s = await threeInDunning("combined-decline");
  await dueNow(s.ids);
  const attemptsBefore = (await Promise.all(s.ids.map(getInv))).map((i) => i.attemptCount);
  const before = charges.length;
  await retry(s.ids[0]!, s.subIds[0]!);
  const rows = await Promise.all(s.ids.map(getInv));
  const [req] = await requestsOf(s.customer.id);
  check(
    "1E combined decline: one charge, and every invoice re-arms its own retry",
    charges.length - before === 1 &&
      rows.every(
        (r, i) =>
          r.status === "payment_due" &&
          r.dunningStatus === "in_progress" &&
          r.nextAttemptAt != null &&
          r.nextAttemptAt.getTime() > Date.now() &&
          r.attemptCount === attemptsBefore[i]! + 1,
      ),
    rows
      .map(
        (r) => `${r.status}/${r.dunningStatus}/${r.attemptCount}/${r.nextAttemptAt?.toISOString()}`,
      )
      .join(" "),
  );
  check(
    "1F combined decline: the request closes (canceled, payment_failed) and sends no link",
    req?.origin === "dunning" && req.status === "canceled" && req.cancelReason === "payment_failed",
    `status=${req?.status} reason=${req?.cancelReason}`,
  );
  // The closed request lets its invoices go: the next retry combines again.
  await dueNow(s.ids);
  const b2 = charges.length;
  await retry(s.ids[0]!, s.subIds[0]!);
  const reqs = await requestsOf(s.customer.id);
  check(
    "1I after a combined decline, the next retry combines again",
    charges.length - b2 === 1 &&
      charges[charges.length - 1]!.amountMinor === 20000n &&
      reqs.length === 2 &&
      reqs.every((r) => r.origin === "dunning" && r.status === "canceled"),
    `charges=${charges.length - b2} requests=${reqs.map((r) => `${r.origin}:${r.status}`)}`,
  );
  const pids = (await Promise.all(s.ids.map(getInv))).map((i) => i.publicId);
  const manual = await createPaymentRequest({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: s.customer.publicId,
    invoicePublicIds: pids,
    mode: "link",
  }).catch((e: Error) => e);
  check(
    "1J a manual payment request can be created for the declined invoices",
    !(manual instanceof Error) && manual.lines.length === 3,
    manual instanceof Error ? manual.message : `lines=${manual.lines.length}`,
  );
  if (!(manual instanceof Error))
    await cancelPaymentRequest({
      organizationId: orgId,
      businessId: biz.id,
      paymentRequestPublicId: manual.request.publicId,
    });
  await setPa({ several_due_invoices: "customer_chooses" });
  const good = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: s.customer,
    token: "tok_4242",
  });
  const all = await payInvoicesFromPortal({
    organizationId: orgId,
    businessId: biz.id,
    customerId: s.customer.id,
    paymentMethodPublicId: good.publicId,
  }).catch((e: Error) => e);
  check(
    "1K portal Pay all takes the declined invoices again",
    !(all instanceof Error) &&
      all.lines.length === 3 &&
      (await Promise.all(s.ids.map(getInv))).every((r) => r.status === "paid"),
    all instanceof Error ? all.message : `lines=${all.lines.length} status=${all.request.status}`,
  );
  await setPa({ several_due_invoices: "combined" });
}
{
  // Five invoices on one card: each combined decline is ONE presentation for the card caps.
  const s = await threeInDunning("combined-caps", undefined, [p50, p120, p30, p50, p120]);
  const presented = async () =>
    presentations(
      await withTenant(orgId, (tx) =>
        tx
          .select({
            at: payments.createdAt,
            request: payments.paymentRequestId,
            attempt: sql<string | null>`${payments.metadata} ->> 'payment_request_attempt'`,
          })
          .from(payments)
          .where(and(eq(payments.paymentMethodId, s.badPm.id), eq(payments.status, "failed"))),
      ),
    ).length;
  const failedRows = async () =>
    (
      await withTenant(orgId, (tx) =>
        tx
          .select({ id: payments.id })
          .from(payments)
          .where(and(eq(payments.paymentMethodId, s.badPm.id), eq(payments.status, "failed"))),
      )
    ).length;
  const [p0, r0, c0] = [await presented(), await failedRows(), charges.length];
  for (let round = 0; round < 3; round++) {
    await dueNow(s.ids);
    await retry(s.ids[0]!, s.subIds[0]!);
  }
  const combined = charges.length - c0;
  const p1 = await presented();
  const r1 = await failedRows();
  check(
    "1L 5 invoices, combined declines: each counts as one card presentation, not five",
    combined >= 2 && p1 - p0 === combined && r1 - r0 === 5 * combined,
    `charges=${combined} presentations=+${p1 - p0} failed rows=+${r1 - r0}`,
  );
}
{
  // Fixed mode (default): a hard decline that arrives late stops every invoice's retries.
  const s = await threeInDunning("combined-late", "4000000000000101");
  await dueNow(s.ids);
  await retry(s.ids[0]!, s.subIds[0]!);
  const [req] = await requestsOf(s.customer.id);
  const [txn] = req
    ? await withTenant(orgId, (tx) =>
        tx.select().from(transactions).where(eq(transactions.paymentRequestId, req.id)),
      )
    : [];
  if (txn)
    await withTenant(orgId, (tx) =>
      settleTransactionOutcome(tx, {
        organizationId: orgId,
        businessId: biz.id,
        outcome: "failed",
        retriable: false,
        txn: {
          id: txn.id,
          paymentId: null,
          invoiceId: null,
          paymentRequestId: req!.id,
          amountMinor: txn.amountMinor,
          currency: txn.currency,
          idAtGateway: txn.idAtGateway,
          errorCode: "card_declined",
          errorText: "Declined",
        },
      }),
    );
  const rows = await Promise.all(s.ids.map(getInv));
  check(
    "1M a late hard decline of a combined charge stops retrying every invoice",
    req?.status === "processing" &&
      !!txn &&
      rows.every((r) => r.nextAttemptAt == null && r.dunningStatus !== "in_progress"),
    `req=${req?.status} txn=${!!txn} ${rows.map((r) => `${r.status}/${r.dunningStatus}/${r.nextAttemptAt?.toISOString() ?? "none"}`)}`,
  );
}
{
  // A mandate on the card: one charge each.
  const s = await threeInDunning("combined-mandate", "tok_4242");
  const [sub] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.id, s.subIds[0]!)),
  );
  await systemDb
    .update(paymentMethods)
    .set({ mandateRail: "card" })
    .where(eq(paymentMethods.id, sub!.defaultPaymentMethodId!));
  await dueNow(s.ids);
  const nextBefore = (await getInv(s.ids[1]!)).nextAttemptAt;
  await retry(s.ids[0]!, s.subIds[0]!);
  const b = await getInv(s.ids[1]!);
  check(
    "1G combined, card with a mandate: no combined charge; the other retries keep their instant",
    (await requestsOf(s.customer.id)).length === 0 &&
      b.status === "payment_due" &&
      b.nextAttemptAt?.getTime() === nextBefore?.getTime(),
    `requests=${(await requestsOf(s.customer.id)).length} b=${b.status}`,
  );
}
{
  // Above the card limit in total, but not each: one charge each.
  await call("PATCH", "", { card_payment_limits: { USD: 15000 } });
  const s = await threeInDunning("combined-limit", "tok_4242");
  await dueNow(s.ids);
  const before = charges.length;
  await retry(s.ids[0]!, s.subIds[0]!);
  check(
    "1H combined, total above the card limit: the retry charges its own invoice only",
    (await requestsOf(s.customer.id)).length === 0 &&
      charges.length - before === 1 &&
      charges[charges.length - 1]!.amountMinor === 5000n &&
      (await getInv(s.ids[1]!)).status === "payment_due",
    `requests=${(await requestsOf(s.customer.id)).length} charges=${charges.length - before}`,
  );
  await call("PATCH", "", { card_payment_limits: null });
  await setPa({ several_due_invoices: "separate" });
}

// ── 2. 2.66 open-invoice order ──────────────────────────────────────────────────
async function creditOrderCase(label: string) {
  const s = await threeInDunning(label);
  await recordExcessPayment({
    organizationId: orgId,
    businessId: biz.id,
    customer: s.customer,
    amountMinor: 3000,
    currency: "USD",
  });
  const res = await call("POST", `/customers/${s.customer.publicId}/collect_payment`, {
    amount_minor: 3000,
    currency: "USD",
  });
  return { s, res, rows: await Promise.all(s.ids.map(getInv)) };
}
{
  const { res, rows } = await creditOrderCase("order-oldest");
  check(
    "2A oldest first (unset): 30.00 of credit goes to the invoice due 1 Sep",
    res.status === 200 &&
      rows[0]!.excessPaymentsAppliedMinor === 3000n &&
      rows[2]!.status !== "paid",
    `status=${res.status} applied=${rows.map((r) => r.excessPaymentsAppliedMinor)}`,
  );
}
{
  await setPa({ invoice_order: "newest_first" });
  const { res, rows } = await creditOrderCase("order-newest");
  check(
    "2B newest first: the same 30.00 pays the invoice due 15 Oct",
    res.status === 200 &&
      rows[2]!.status === "paid" &&
      (rows[0]!.excessPaymentsAppliedMinor ?? 0n) === 0n,
    `status=${res.status} applied=${rows.map((r) => r.excessPaymentsAppliedMinor)} c=${rows[2]!.status}`,
  );
  const s = await threeInDunning("order-request");
  const view = await createPaymentRequest({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: s.customer.publicId,
    invoicePublicIds: (await Promise.all(s.ids.map(getInv))).map((i) => i.publicId),
    mode: "link",
  });
  check(
    "2C newest first: a payment request lists the invoice due 15 Oct at position 0",
    view.lines[0]!.invoice.id === s.ids[2] && view.lines[2]!.invoice.id === s.ids[0],
    view.lines.map((l) => l.invoice.dueDate?.toISOString().slice(0, 10)).join(","),
  );
  await setPa({ invoice_order: "oldest_first" });
}

// ── 3. Customer chooses: the portal pays several invoices in one charge ──────────
{
  const s = await threeInDunning("portal-pay", "tok_4242");
  const good = (
    await withTenant(orgId, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.id, s.subIds[0]!)),
    )
  )[0]!.defaultPaymentMethodId!;
  const [pm] = await withTenant(orgId, (tx) =>
    tx.select().from(paymentMethods).where(eq(paymentMethods.id, good)),
  );
  let refused = "";
  try {
    await payInvoicesFromPortal({
      organizationId: orgId,
      businessId: biz.id,
      customerId: s.customer.id,
      paymentMethodPublicId: pm!.publicId,
    });
  } catch (e) {
    refused = e instanceof PortalPayNotAllowedError ? "not_allowed" : String(e);
  }
  check(
    "3A Pay all is refused while the setting is not customer_chooses",
    refused === "not_allowed",
    refused,
  );
  await setPa({ several_due_invoices: "customer_chooses" });
  const before = charges.length;
  const view = await payInvoicesFromPortal({
    organizationId: orgId,
    businessId: biz.id,
    customerId: s.customer.id,
    paymentMethodPublicId: pm!.publicId,
  });
  const rows = await Promise.all(s.ids.map(getInv));
  check(
    "3B customer_chooses: Pay all charges 200.00 once and pays every open invoice (origin portal)",
    view.request.origin === "portal" &&
      view.request.status === "paid" &&
      charges.length - before === 1 &&
      charges[charges.length - 1]!.amountMinor === 20000n &&
      rows.every((r) => r.status === "paid"),
    `origin=${view.request.origin} status=${view.request.status} charges=${charges.length - before}`,
  );
  // The clock under customer_chooses still charges one each.
  const t = await threeInDunning("portal-clock", "tok_4242");
  await dueNow(t.ids);
  const b2 = charges.length;
  await retry(t.ids[0]!, t.subIds[0]!);
  check(
    "3C customer_chooses: the clock still charges one invoice per retry",
    charges.length - b2 === 1 && (await getInv(t.ids[1]!)).status === "payment_due",
    `charges=${charges.length - b2}`,
  );
  await setPa({ several_due_invoices: "separate", invoice_order: "customer_chooses" });
  const u = await threeInDunning("portal-select", "tok_4242");
  const uRows = await Promise.all(u.ids.map(getInv));
  const sel = await payInvoicesFromPortal({
    organizationId: orgId,
    businessId: biz.id,
    customerId: u.customer.id,
    invoicePublicIds: [uRows[1]!.publicId, uRows[2]!.publicId],
  });
  const after = await Promise.all(u.ids.map(getInv));
  check(
    "3D invoice_order customer_chooses: the customer pays only the selected invoices",
    sel.request.status === "paid" &&
      after[0]!.status === "payment_due" &&
      after[1]!.status === "paid" &&
      after[2]!.status === "paid",
    after.map((r) => r.status).join(","),
  );
  await setPa({ invoice_order: "oldest_first" });
}

// ── 4. 2.69 excess payment ──────────────────────────────────────────────────────
/**
 * A pending charge for the whole invoice, then the invoice owes less (default 50.00 → 40.00:
 * a 10.00 overpayment). `bankDebit` books it on a SEPA debit instead of a card.
 */
async function overpayment(
  label: string,
  o: {
    customer?: Awaited<ReturnType<typeof createCustomer>>;
    price?: typeof p50;
    owes?: bigint;
    bankDebit?: boolean;
    /** Another pending card, so a second overpayment does not reuse the first instrument. */
    token?: string;
  } = {},
) {
  const p = await pendingOverpayment(label, o);
  return p.settle();
}

/** The invoice and its pending charge; `settle()` lands the overpayment later. */
async function pendingOverpayment(label: string, o: Parameters<typeof overpayment>[1] = {}) {
  const customer =
    o.customer ??
    (await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: `${label}-${RUN}@example.com`,
    }));
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: o.token ?? "4000000000000101", // async pending
  });
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date(),
    items: [{ price: o.price ?? p50, quantity: 1 }],
    defaultPaymentMethodId: pm.id,
  });
  if (o.bankDebit)
    await systemDb
      .update(paymentMethods)
      .set({ type: "sepa_debit" })
      .where(eq(paymentMethods.id, pm.id));
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  const [pay] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(payments)
      .where(and(eq(payments.invoiceId, invoice.id), eq(payments.status, "pending"))),
  );
  const settle = async () => {
    // Stands in for an adjustment note that lowered what the invoice owes mid-flight.
    await systemDb
      .update(invoices)
      .set({ amountDueMinor: o.owes ?? 4000n })
      .where(eq(invoices.id, invoice.id));
    if (o.bankDebit)
      await systemDb
        .update(payments)
        .set({ methodType: "sepa_debit" })
        .where(eq(payments.id, pay!.id));
    await withTenant(orgId, (tx) =>
      settlePaymentSucceeded(tx, { organizationId: orgId, businessId: biz.id, paymentId: pay!.id }),
    );
    const refundRows = await withTenant(orgId, (tx) =>
      tx.select().from(refunds).where(eq(refunds.paymentId, pay!.id)),
    );
    return {
      customer,
      pay: pay!,
      inv: await getInv(invoice.id),
      excess: await bucketBalance(systemDb as never, customer.id, EXCESS_PAYMENT, "USD"),
      refundRows,
    };
  };
  return { customer, settle };
}
{
  const o = await overpayment("excess-credit");
  check(
    "4A credit (unset): the 10.00 over the invoice stays customer credit, no refund",
    !!o.pay && o.inv.status === "paid" && o.excess === 1000n && o.refundRows.length === 0,
    `pay=${!!o.pay} status=${o.inv.status} excess=${o.excess} refunds=${o.refundRows.length}`,
  );
  await setPa({ excess_payment: "refund" });
  const r = await overpayment("excess-refund");
  check(
    "4B refund: the same 10.00 is refunded to the card and leaves no credit",
    r.inv.status === "paid" &&
      r.excess === 0n &&
      r.refundRows.length === 1 &&
      r.refundRows[0]!.amountMinor === 1000n,
    `excess=${r.excess} refunds=${r.refundRows.map((x) => `${x.status}:${x.amountMinor}`)}`,
  );
  await setPa({ excess_payment: "customer_chooses" });
  const c = await overpayment("excess-choose");
  const listed = await listCustomerOverpayments(orgId, biz.id, c.customer.id);
  const refund = await refundCustomerOverpayment({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.customer.id,
    paymentPublicId: c.pay.publicId,
  });
  const excessAfter = await bucketBalance(systemDb as never, c.customer.id, EXCESS_PAYMENT, "USD");
  check(
    "4C customer_chooses: kept as credit, listed for the customer, refunded on request",
    c.excess === 1000n &&
      c.refundRows.length === 0 &&
      listed.length === 1 &&
      listed[0]!.refundableMinor === 1000n &&
      refund.amountMinor === 1000n &&
      excessAfter === 0n,
    `excess=${c.excess} listed=${listed.length} refund=${refund.amountMinor} after=${excessAfter}`,
  );
  // A SEPA overshoot of 80.00 and a card overshoot of 10.00 share one bucket: the card can
  // give back only its own 10.00, and the SEPA money never leaves through a card refund.
  // Both invoices are billed before either settles, so no credit on file pays the second.
  const sepaP = await pendingOverpayment("mixed", { price: p120, owes: 4000n, bankDebit: true });
  const cardP = await pendingOverpayment("mixed-card", {
    customer: sepaP.customer,
    price: p120,
    owes: 11000n,
    token: "4000000000000119",
  });
  const sepa = await sepaP.settle();
  const card = await cardP.settle();
  const mixed = await listCustomerOverpayments(orgId, biz.id, sepa.customer.id);
  const tooMuch = await refundCustomerOverpayment({
    organizationId: orgId,
    businessId: biz.id,
    customerId: sepa.customer.id,
    paymentPublicId: card.pay.publicId,
  });
  const left = await bucketBalance(systemDb as never, sepa.customer.id, EXCESS_PAYMENT, "USD");
  check(
    "4D customer_chooses, mixed bucket: the card lists and refunds only its own 10.00; SEPA stays credit",
    card.excess === 9000n &&
      mixed.length === 1 &&
      mixed[0]!.paymentPublicId === card.pay.publicId &&
      mixed[0]!.refundableMinor === 1000n &&
      tooMuch.amountMinor === 1000n &&
      left === 8000n,
    `bucket=${card.excess} listed=${mixed.map((m) => `${m.paymentPublicId === card.pay.publicId ? "card" : "sepa"}:${m.refundableMinor}`)} refund=${tooMuch.amountMinor} left=${left}`,
  );
  await setPa({ excess_payment: "refund" });
  const sepa2P = await pendingOverpayment("mixed-auto", {
    price: p120,
    owes: 4000n,
    bankDebit: true,
  });
  const card2P = await pendingOverpayment("mixed-auto-card", {
    customer: sepa2P.customer,
    price: p120,
    owes: 11000n,
    token: "4000000000000119",
  });
  const sepa2 = await sepa2P.settle();
  const card2 = await card2P.settle();
  check(
    "4E refund, mixed bucket: the SEPA 80.00 stays credit; the card refunds its own 10.00 only",
    sepa2.refundRows.length === 0 &&
      sepa2.excess === 8000n &&
      card2.refundRows.length === 1 &&
      card2.refundRows[0]!.amountMinor === 1000n &&
      card2.excess === 8000n,
    `sepaRefunds=${sepa2.refundRows.length} cardRefunds=${card2.refundRows.map((r) => r.amountMinor)} bucket=${card2.excess}`,
  );
  // 4G/4H: a card refund never takes bank-debit money, whatever the order of events.
  await setPa({ excess_payment: "customer_chooses" });
  /** Reopen a paid invoice so a credit draw can land on it (stands in for a voided payment). */
  const reopen = (id: string) =>
    systemDb
      .update(invoices)
      .set({ status: "payment_due", amountDueMinor: 3000n })
      .where(eq(invoices.id, id));
  const drawOn = (cusPid: string, invPid: string, amount: number) =>
    call("POST", `/customers/${cusPid}/collect_payment`, {
      amount_minor: amount,
      currency: "USD",
      invoice_ids: [invPid],
    });
  const bucketOf = (id: string) => bucketBalance(systemDb as never, id, EXCESS_PAYMENT, "USD");
  const listedFor = async (cusId: string, payPid: string) =>
    (await listCustomerOverpayments(orgId, biz.id, cusId)).find((x) => x.paymentPublicId === payPid)
      ?.refundableMinor ?? 0n;
  {
    // SEPA B 10.00 over, card P1 10.00 over, a 10.00 draw, card P2 10.00 over; operator refunds P1.
    const bP = await pendingOverpayment("g-sepa", { owes: 4000n, bankDebit: true });
    const p1P = await pendingOverpayment("g-p1", {
      customer: bP.customer,
      price: p120,
      owes: 11000n,
      token: "4000000000000119",
    });
    const p2P = await pendingOverpayment("g-p2", {
      customer: bP.customer,
      price: p120,
      owes: 11000n,
      token: "4000000000000119",
    });
    await bP.settle();
    const p1 = await p1P.settle();
    await reopen(p1.inv.id);
    const drew = await drawOn(bP.customer.publicId, p1.inv.publicId, 1000);
    const p2 = await p2P.settle();
    const op = await refundExcessPayment({
      organizationId: orgId,
      businessId: biz.id,
      paymentPublicId: p1.pay.publicId,
    }).catch((e: Error) => e);
    const bucket = await bucketOf(bP.customer.id);
    const p2Listed = await listedFor(bP.customer.id, p2.pay.publicId);
    check(
      "4G after an operator refund of P1, the portal offers P2 at most bucket − 10.00, and the SEPA 10.00 stays",
      drew.status === 200 &&
        !(op instanceof Error) &&
        p2Listed <= (bucket - 1000n > 0n ? bucket - 1000n : 0n) &&
        bucket >= 1000n,
      `draw=${drew.status} op=${op instanceof Error ? op.message : `${op.status}:${op.amountMinor}`} bucket=${bucket} p2Listed=${p2Listed}`,
    );
  }
  {
    // A reopened absorbed invoice is drawn again by credit_applied: P1 still never exceeds
    // bucket − nonCardHeld.
    const bP = await pendingOverpayment("h-sepa", { owes: 4000n, bankDebit: true });
    const p1P = await pendingOverpayment("h-p1", {
      customer: bP.customer,
      price: p120,
      owes: 11000n,
      token: "4000000000000119",
    });
    await bP.settle();
    const p1 = await p1P.settle();
    await reopen(p1.inv.id);
    const drew = await drawOn(bP.customer.publicId, p1.inv.publicId, 1500);
    const bucket = await bucketOf(bP.customer.id);
    const listed = await listedFor(bP.customer.id, p1.pay.publicId);
    const room = bucket - 1000n > 0n ? bucket - 1000n : 0n;
    check(
      "4H a later credit_applied draw on the reopened absorbed invoice still caps P1 at bucket − nonCardHeld",
      drew.status === 200 && bucket === 500n && listed <= room,
      `draw=${drew.status} bucket=${bucket} listed=${listed} room=${room}`,
    );
  }
  await setPa({ excess_payment: "refund" });

  // Two children of ONE combined charge overshoot in one settlement: each refunds its own rest.
  await setPa({ several_due_invoices: "combined" });
  const t = await threeInDunning("two-children", "4000000000000101", [p50, p30]);
  await dueNow(t.ids);
  await retry(t.ids[0]!, t.subIds[0]!);
  const [preq] = await requestsOf(t.customer.id);
  const [ptxn] = preq
    ? await withTenant(orgId, (tx) =>
        tx.select().from(transactions).where(eq(transactions.paymentRequestId, preq.id)),
      )
    : [];
  // Each invoice now owes less than its child carries: 50.00 → 40.00 and 30.00 → 25.00.
  await systemDb.update(invoices).set({ amountDueMinor: 4000n }).where(eq(invoices.id, t.ids[0]!));
  await systemDb.update(invoices).set({ amountDueMinor: 2500n }).where(eq(invoices.id, t.ids[1]!));
  if (ptxn)
    await withTenant(orgId, (tx) =>
      settleTransactionOutcome(tx, {
        organizationId: orgId,
        businessId: biz.id,
        outcome: "succeeded",
        txn: {
          id: ptxn.id,
          paymentId: null,
          invoiceId: null,
          paymentRequestId: preq!.id,
          amountMinor: ptxn.amountMinor,
          currency: ptxn.currency,
          idAtGateway: ptxn.idAtGateway,
        },
      }),
    );
  const kids = preq
    ? await withTenant(orgId, (tx) =>
        tx.select().from(payments).where(eq(payments.paymentRequestId, preq.id)),
      )
    : [];
  const kidRefunds = kids.length
    ? await withTenant(orgId, (tx) =>
        tx
          .select()
          .from(refunds)
          .where(
            inArray(
              refunds.paymentId,
              kids.map((k) => k.id),
            ),
          ),
      )
    : [];
  const leftTwo = await bucketBalance(systemDb as never, t.customer.id, EXCESS_PAYMENT, "USD");
  check(
    "4F refund: two children over in one combined settlement both refund their own rest (10.00 + 5.00)",
    !!ptxn &&
      kidRefunds
        .map((r) => Number(r.amountMinor))
        .sort((a, b) => a - b)
        .join() === "500,1000" &&
      leftTwo === 0n,
    `txn=${!!ptxn} refunds=${kidRefunds.map((r) => r.amountMinor)} left=${leftTwo}`,
  );
  await setPa({ several_due_invoices: "separate", excess_payment: "credit" });
}

// ── 4H. Per call: `excess` on an operator's offline payment ─────────────────────────
{
  const offline = async (label: string, paid: number, extra: object) => {
    const cus = await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: `offline-${label}-${RUN}@example.com`,
    });
    const { invoice } = await createInvoiceFromLines({
      organizationId: orgId,
      businessId: biz.id,
      customerId: cus.id,
      currency: "USD",
      lines: [{ description: "Service", amountMinor: 1000n, kind: "one_time" }],
      collect: false,
    });
    const r = await call("POST", `/invoices/${invoice.publicId}/pay`, {
      amount_minor: paid,
      method: "cash",
      ...extra,
    });
    const bucket = await bucketBalance(systemDb as never, cus.id, EXCESS_PAYMENT, "USD");
    const txns = await withTenant(orgId, (tx) =>
      tx
        .select({ type: transactions.type, amount: transactions.amountMinor })
        .from(transactions)
        .where(eq(transactions.invoiceId, invoice.id)),
    );
    const cash = await withTenant(orgId, (tx) =>
      tx.execute(sql`select coalesce(sum(case when direction='debit' then amount_minor else -amount_minor end),0)::bigint as bal
        from ledger_entries where customer_id = ${cus.id} and account = 'cash'`),
    );
    return {
      status: r.status,
      body: r.body,
      bucket,
      txns: txns
        .map((t) => `${t.type}:${t.amount}`)
        .sort()
        .join(","),
      cash: BigInt((cash as unknown as Array<{ bal: string }>)[0]?.bal ?? 0),
      inv: await getInv(invoice.id),
    };
  };
  // The business rule says refund: it governs gateway payments, so an offline one still credits.
  await setPa({ excess_payment: "refund" });
  const omitted = await offline("omitted", 1200, {});
  check(
    "4H omitted: offline excess is kept as credit (today), whatever excess_payment says",
    omitted.status === 200 &&
      omitted.bucket === 200n &&
      omitted.body.excess_credited_minor === 200 &&
      omitted.body.excess_refunded_minor === 0,
    `${omitted.status} bucket=${omitted.bucket} ${JSON.stringify(omitted.body?.excess_credited_minor)}`,
  );
  await setPa({ excess_payment: "credit" });
  const refunded = await offline("refund", 1200, { excess: "refund" });
  check(
    "4H excess=refund: the 200 is recorded as returned (no credit, a refund transaction, cash net 1000)",
    refunded.status === 200 &&
      refunded.inv.status === "paid" &&
      refunded.bucket === 0n &&
      refunded.cash === 1000n &&
      refunded.body.excess_refunded_minor === 200 &&
      refunded.body.excess_credited_minor === 0 &&
      refunded.txns === "payment:1200,refund:200",
    `${refunded.status} bucket=${refunded.bucket} cash=${refunded.cash} txns=${refunded.txns}`,
  );
  const credited = await offline("credit", 1200, { excess: "credit" });
  check(
    "4H excess=credit: the 200 stays as credit",
    credited.status === 200 && credited.bucket === 200n && credited.cash === 1200n,
    `bucket=${credited.bucket} cash=${credited.cash}`,
  );
  const exact = await offline("exact", 1000, { excess: "refund" });
  check(
    "4H excess=refund with nothing above the due amount changes nothing",
    exact.status === 200 && exact.bucket === 0n && exact.txns === "payment:1000",
    exact.txns,
  );
  const bad = await offline("bad", 1200, { excess: "keep" });
  check("4H an unknown excess value is a 400", bad.status === 400, String(bad.status));
}

// ── 5. 2.55 credit scope ────────────────────────────────────────────────────────
{
  const meter = await createMeter({
    organizationId: orgId,
    businessId: biz.id,
    key: `tokens-${RUN}`,
    definition: {
      name: "Tokens",
      eventName: `llm_${RUN}`,
      aggregation: "sum",
      valueProperty: "tokens",
    },
  } as never);
  const meterPrice = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "usage",
    currency: "USD",
    interval: "month",
    meter: meter.key,
    unitAmountDecimal: "0.001",
  } as never);
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `scope-${RUN}@example.com`,
  });
  const grant = (applicability?: object) =>
    call("POST", `/customers/${customer.publicId}/credit_grants`, {
      category: "promotional",
      currency: "USD",
      amount: 1000,
      ...(applicability ? { applicability } : {}),
    });
  const unknown = await grant({ kind: "meters", meters: ["no-such-meter"] });
  const scoped = await grant({ kind: "meters", meters: [meter.key] });
  const all = await grant();
  check(
    "5A a grant scoped to an unknown meter is refused; a known meter is stored",
    unknown.status === 400 &&
      (scoped.status === 200 || scoped.status === 201) &&
      scoped.body.applicability?.kind === "meters",
    `unknown=${unknown.status} scoped=${scoped.status} ${JSON.stringify(scoped.body?.applicability)}`,
  );
  const planned = () =>
    withTenant(orgId, (tx) =>
      loadPlannerGrants(tx, { businessId: biz.id, customerId: customer.id, currency: "USD" }),
    );
  const usageLine = (price: string) => ({ kind: "usage", pricePublicId: price, adjustment: null });
  const byId = async () => {
    const rows = await withTenant(orgId, (tx) =>
      tx.select().from(creditGrants).where(eq(creditGrants.customerId, customer.id)),
    );
    const pid = new Map(rows.map((r) => [r.id, r.publicId]));
    return new Map((await planned()).map((g) => [pid.get(g.id)!, g]));
  };
  let g = await byId();
  const sg = g.get(scoped.body.id)!;
  const ag = g.get(all.body.id)!;
  check(
    "5B at draw time a meter scope pays that meter's price and nothing else",
    grantCoversLine(sg, usageLine(meterPrice.publicId)) &&
      !grantCoversLine(sg, usageLine("price_other")) &&
      grantCoversLine(ag, usageLine("price_other")),
    JSON.stringify(sg.applicability),
  );
  const badScope = await call("PATCH", "", {
    credit_config: { credit_scope: { kind: "meters", meters: ["no-such-meter"] } },
  });
  const okScope = await call("PATCH", "", {
    credit_config: { credit_scope: { kind: "meters", meters: [meter.key] } },
  });
  g = await byId();
  check(
    "5C credit_config.credit_scope narrows an all-usage grant; an unknown meter is refused",
    badScope.status === 400 &&
      okScope.status === 200 &&
      okScope.body.credit_config?.credit_scope?.kind === "meters" &&
      grantCoversLine(g.get(all.body.id)!, usageLine(meterPrice.publicId)) &&
      !grantCoversLine(g.get(all.body.id)!, usageLine("price_other")),
    `bad=${badScope.status} ok=${okScope.status}`,
  );
  await call("PATCH", "", { credit_config: null });
  g = await byId();
  check(
    "5D no credit scope (unset): an all-usage grant pays every usage line again",
    grantCoversLine(g.get(all.body.id)!, usageLine("price_other")),
  );
}

await app.close();
TmtestProvider.prototype.charge = realCharge;
const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} passed`);
console.log(
  failed ? "❌ SETTINGS-PAYMENT-APPLICATION: FAIL" : "✅ SETTINGS-PAYMENT-APPLICATION: PASS",
);
await closeDb();
process.exit(failed ? 1 : 0);

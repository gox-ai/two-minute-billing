/**
 * A debit still in flight at the gateway must not collect on top of an invoice an operator
 * settles another way.
 *
 *   pnpm verify:pending-debit-guard
 *
 * Recording an offline payment, applying credit and voiding the invoice each ask the gateway
 * to cancel the pending debit first. A cancelled debit is booked failed (no money moved) and
 * the action proceeds; a debit the gateway will not stop refuses the action with a 409.
 * Also pins the operator's own "Cancel pending debit" action, its permission and its audit
 * row, and that a later gateway "failed" webhook for the cancelled debit changes nothing.
 *
 * tmtest card 4000000000000101 books a pending debit the gateway can cancel;
 * 4000000000000119 books one already submitted to the bank, which it cannot.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, systemDb, closeDb } from "@/platform/db";
import { loadGeoReference } from "@/platform/geo";
import { createOrganization, createBusiness, createApiKey } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { voidInvoice } from "@/modules/invoicing/ops";
import { recordExcessPayment } from "@/modules/customers/balances";
import { bucketBalance, EXCESS_PAYMENT } from "@/modules/customers/balances-read";
import { applyCreditOnFile } from "@/modules/customers/collect";
import { handleProviderEvent } from "@/modules/webhooks/inbound";
import { inviteUser, acceptInvite } from "@/modules/auth/service";
import { getCharge } from "@/providers/tmtest/store";
import {
  auditLogs,
  authTokens,
  events,
  invoices,
  paymentMethods,
  payments,
  transactions,
} from "@db/schema";

const CANCELABLE = "4000000000000101";
const SUBMITTED = "4000000000000119";
const AMOUNT = 250_000;
const RUN = randomUUID().slice(0, 8);

let pass = true;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) pass = false;
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

await loadGeoReference();
const org = await createOrganization({ name: `PendingDebitGuard ${RUN}` });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Debit Co",
  defaultCurrency: "INR",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };
const app = await buildApp({ logger: false });
const { secret } = await createApiKey(orgId, "test");

const product = await createProduct({ ...ctx, name: "Plan" });
const price = await createPrice({
  ...ctx,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "INR",
  amountMinor: AMOUNT,
  interval: "month",
});

/** A customer on `token`, billed once: the invoice carries one pending debit. */
async function pendingInvoice(label: string, token: string) {
  const customer = await createCustomer({ ...ctx, email: `${label}-${RUN}@example.com` });
  const pm = await vaultPaymentMethod({ ...ctx, customer, token });
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({ mandateRail: "card", mandateMaxAmountMinor: 99_999_999n, mandateCurrency: "INR" })
      .where(eq(paymentMethods.id, pm.id)),
  );
  const sub = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    defaultPaymentMethodId: pm.id,
  });
  const { invoice } = await billSubscriptionPeriod({
    ...ctx,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  const [debit] = await paymentsOf(invoice.id);
  if (debit?.status !== "pending") throw new Error(`${label}: expected a pending debit`);
  return { customer, invoice, debit };
}

const paymentsOf = (invoiceId: string) =>
  withTenant(orgId, (tx) => tx.select().from(payments).where(eq(payments.invoiceId, invoiceId)));
const paymentById = async (id: string) =>
  (await withTenant(orgId, (tx) => tx.select().from(payments).where(eq(payments.id, id))))[0]!;
const invoiceById = async (id: string) =>
  (await withTenant(orgId, (tx) => tx.select().from(invoices).where(eq(invoices.id, id))))[0]!;
const txnOf = async (paymentId: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx.select().from(transactions).where(eq(transactions.paymentId, paymentId)),
    )
  )[0];
const paidOnce = async (invoiceId: string) => {
  const rows = await paymentsOf(invoiceId);
  const ok = rows.filter((p) => p.status === "succeeded");
  return { count: ok.length, sum: ok.reduce((a, p) => a + p.amountMinor, 0n) };
};

type Auth = { key: string } | { cookie: string };
const KEY: Auth = { key: secret };
const post = (url: string, payload: object = {}, auth: Auth = KEY, idem = randomUUID()) =>
  app.inject({
    method: "POST",
    url: `/v1/businesses/${biz.publicId}${url}`,
    headers: {
      ...("key" in auth
        ? { authorization: `Bearer ${auth.key}` }
        : { cookie: `tmb_session=${auth.cookie}` }),
      "idempotency-key": idem,
    },
    payload,
  });
const getTxn = (publicId: string) =>
  app.inject({
    method: "GET",
    url: `/v1/businesses/${biz.publicId}/transactions/${publicId}`,
    headers: { authorization: `Bearer ${secret}` },
  });

/** The debit was stopped at the gateway and booked failed, with nothing posted. */
async function assertCancelled(tag: string, debitId: string) {
  const pay = await paymentById(debitId);
  ok(
    `${tag}: the debit is failed / debit_cancelled`,
    pay.status === "failed" && pay.failureCode === "debit_cancelled",
    `${pay.status}/${pay.failureCode}`,
  );
  const charge = await getCharge(pay.providerChargeId!);
  ok(
    `${tag}: …and cancelled at the gateway`,
    charge?.status === "failed" && charge.errorCode === "debit_cancelled",
    `${charge?.status}/${charge?.errorCode}`,
  );
  const txn = await txnOf(debitId);
  ok(
    `${tag}: …its transaction is failed`,
    txn?.status === "failed" && txn.errorCode === "debit_cancelled",
    `${txn?.status}/${txn?.errorCode}`,
  );
  const audit = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "payment.cancel_pending_debit"),
          eq(auditLogs.resourceId, pay.publicId),
        ),
      ),
  );
  ok(`${tag}: …with one audit row`, audit.length === 1, String(audit.length));
  return pay;
}

// ── A. Offline payment while a debit is pending ─────────────────────────────────
{
  const { invoice, debit } = await pendingInvoice("offline", CANCELABLE);
  const res = await post(`/invoices/${invoice.publicId}/pay`, { method: "cash" });
  ok(
    "A: recording the payment succeeds",
    res.statusCode === 200,
    `${res.statusCode} ${res.body.slice(0, 200)}`,
  );
  await assertCancelled("A", debit.id);
  const inv = await invoiceById(invoice.id);
  ok("A: the invoice is paid", inv.status === "paid", inv.status);
  const once = await paidOnce(invoice.id);
  ok(
    "A: …exactly once, for its total",
    once.count === 1 && once.sum === BigInt(AMOUNT),
    `${once.count} × ${once.sum}`,
  );
  const evs = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(events)
      .where(and(eq(events.businessId, biz.id), eq(events.type, "payment_failed"))),
  );
  ok(
    "A: payment_failed carries code debit_cancelled",
    evs.some(
      (e) =>
        JSON.stringify(e.data).includes(debit.publicId) &&
        JSON.stringify(e.data).includes("debit_cancelled"),
    ),
  );

  // ── E. The gateway later reports the cancelled debit as failed ────────────────
  const ev = {
    providerEventId: `ev_cancel_${RUN}`,
    type: "charge.failed" as const,
    providerChargeId: debit.providerChargeId!,
    failureCode: "debit_cancelled",
    occurredAt: new Date(),
    raw: {},
  };
  const first = await handleProviderEvent("tmtest", ev, { businessId: biz.id });
  const again = await handleProviderEvent("tmtest", ev, { businessId: biz.id });
  ok("E: the late webhook books nothing", first === "ignored", first);
  ok("E: …and its redelivery is a duplicate", again === "duplicate", again);
  const after = await paymentById(debit.id);
  const invAfter = await invoiceById(invoice.id);
  ok(
    "E: the debit stays debit_cancelled",
    after.status === "failed" && after.failureCode === "debit_cancelled",
  );
  ok(
    "E: the invoice stays paid, with no retry armed",
    invAfter.status === "paid" && invAfter.nextAttemptAt === null,
    `${invAfter.status} ${invAfter.nextAttemptAt}`,
  );
}

// ── B. A debit the gateway will not cancel refuses the payment ──────────────────
{
  const { invoice, debit } = await pendingInvoice("offline-locked", SUBMITTED);
  const res = await post(`/invoices/${invoice.publicId}/pay`, { method: "cash" });
  const body = res.json() as { error?: { code?: string; message?: string } };
  ok("B: recording the payment is refused 409", res.statusCode === 409, `${res.statusCode}`);
  ok("B: …code debit_in_progress", body.error?.code === "debit_in_progress", body.error?.code);
  ok(
    "B: …and the message says what to do",
    body.error?.message?.startsWith("We could not record a payment on this invoice.") === true &&
      body.error.message.includes("Try again after the debit succeeds or fails."),
    body.error?.message,
  );
  console.log(`   message: ${body.error?.message}`);
  const pay = await paymentById(debit.id);
  ok("B: the debit is still pending", pay.status === "pending", pay.status);
  const once = await paidOnce(invoice.id);
  ok("B: no payment was recorded", once.count === 0, String(once.count));
  ok("B: the invoice is still open", (await invoiceById(invoice.id)).status !== "paid");
}

// ── C. Applying credit ──────────────────────────────────────────────────────────
{
  // C0: no credit at all — refused BEFORE the debit is touched.
  const bare = await pendingInvoice("credit-none", CANCELABLE);
  const none = await post(`/invoices/${bare.invoice.publicId}/apply_credits`, {});
  ok(
    "C0: no credit to apply is a 400",
    none.statusCode === 400,
    `${none.statusCode} ${none.body.slice(0, 120)}`,
  );
  ok(
    "C0: …and the debit was not cancelled",
    (await paymentById(bare.debit.id)).status === "pending",
  );

  const { customer, invoice, debit } = await pendingInvoice("credit", CANCELABLE);
  await recordExcessPayment({ ...ctx, customer, amountMinor: AMOUNT, currency: "INR" });

  // C1: automatic credit application skips an invoice with a debit in flight.
  const auto = await applyCreditOnFile({ ...ctx, invoice });
  const held = await withTenant(orgId, (tx) =>
    bucketBalance(tx, customer.id, EXCESS_PAYMENT, "INR"),
  );
  ok(
    "C1: automatic credit skips the invoice while the debit is live",
    auto === null && held === BigInt(AMOUNT),
    `${String(auto)} ${held}`,
  );

  const res = await post(`/invoices/${invoice.publicId}/apply_credits`, {});
  ok(
    "C: applying credit succeeds",
    res.statusCode === 200,
    `${res.statusCode} ${res.body.slice(0, 200)}`,
  );
  await assertCancelled("C", debit.id);
  const inv = await invoiceById(invoice.id);
  ok("C: the invoice is paid by credit", inv.status === "paid", inv.status);
  const left = await withTenant(orgId, (tx) =>
    bucketBalance(tx, customer.id, EXCESS_PAYMENT, "INR"),
  );
  ok("C: …the credit is spent once", left === 0n, String(left));
  ok("C: …and no debit succeeded", (await paidOnce(invoice.id)).count === 0);

  const locked = await pendingInvoice("credit-locked", SUBMITTED);
  await recordExcessPayment({
    ...ctx,
    customer: locked.customer,
    amountMinor: AMOUNT,
    currency: "INR",
  });
  const refused = await post(`/invoices/${locked.invoice.publicId}/apply_credits`, {});
  const rb = refused.json() as { error?: { code?: string; message?: string } };
  ok(
    "C: a debit that cannot be cancelled refuses the credit 409",
    refused.statusCode === 409 && rb.error?.code === "debit_in_progress",
    `${refused.statusCode}`,
  );
  ok(
    "C: …message",
    rb.error?.message?.startsWith("We could not apply credit to this invoice.") === true,
    rb.error?.message,
  );
  const kept = await withTenant(orgId, (tx) =>
    bucketBalance(tx, locked.customer.id, EXCESS_PAYMENT, "INR"),
  );
  ok("C: …the credit is untouched", kept === BigInt(AMOUNT), String(kept));
}

// ── D. Void ─────────────────────────────────────────────────────────────────────
{
  const { invoice, debit } = await pendingInvoice("void", CANCELABLE);
  const res = await post(`/invoices/${invoice.publicId}/void`, {});
  ok("D: voiding succeeds", res.statusCode === 200, `${res.statusCode} ${res.body.slice(0, 200)}`);
  await assertCancelled("D", debit.id);
  ok("D: the invoice is voided", (await invoiceById(invoice.id)).status === "voided");

  const locked = await pendingInvoice("void-locked", SUBMITTED);
  const refused = await post(`/invoices/${locked.invoice.publicId}/void`, {});
  const rb = refused.json() as { error?: { code?: string; message?: string } };
  ok(
    "D: a debit that cannot be cancelled refuses the void 409",
    refused.statusCode === 409 && rb.error?.code === "debit_in_progress",
    `${refused.statusCode}`,
  );
  ok(
    "D: …message",
    rb.error?.message?.startsWith("We could not void this invoice.") === true,
    rb.error?.message,
  );
  ok("D: …the invoice stays open", (await invoiceById(locked.invoice.id)).status !== "voided");

  // An automated void (subscription cancel, dunning) never cancels a debit: voidBlocker refuses.
  const auto = await pendingInvoice("void-auto", CANCELABLE);
  const msg = await voidInvoice(orgId, biz.id, auto.invoice.publicId).then(
    () => null,
    (e: Error) => e.message,
  );
  ok(
    "D: an automated void still refuses while a debit is in flight",
    msg?.includes("still in progress") === true,
    msg ?? "voided",
  );
  ok("D: …and leaves the debit alone", (await paymentById(auto.debit.id)).status === "pending");
}

// ── F. The operator's "Cancel pending debit" ────────────────────────────────────
{
  const PW = "Correct-Horse-Battery-9";
  const member = async (email: string, role: string) => {
    const invited = await inviteUser({ organizationId: orgId, email, role });
    const tok = `invt_${randomBytes(32).toString("base64url")}`;
    await systemDb.insert(authTokens).values({
      userId: invited.userId,
      tokenHash: createHash("sha256").update(tok).digest("hex"),
      purpose: "invite",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return (await acceptInvite(tok, PW)).token;
  };
  const ops = await member(`ops-${RUN}@example.com`, "ops");
  const mgr = await member(`mgr-${RUN}@example.com`, "manager");

  const { invoice, debit } = await pendingInvoice("operator", CANCELABLE);
  const txn = (await txnOf(debit.id))!;
  const before = (await getTxn(txn.publicId)).json() as {
    pending_debit_cancel: { payment: string } | null;
  };
  ok(
    "F: the transaction offers the cancel",
    before.pending_debit_cancel?.payment === debit.publicId,
    JSON.stringify(before.pending_debit_cancel),
  );

  const url = `/payments/${debit.publicId}/cancel_pending_debit`;
  const denied = await post(url, {}, { cookie: ops });
  ok(
    `F: an ops member (no payments:refund) is refused 403`,
    denied.statusCode === 403,
    String(denied.statusCode),
  );
  ok("F: …and the debit is untouched", (await paymentById(debit.id)).status === "pending");

  const idem = randomUUID();
  const res = await post(url, {}, { cookie: mgr }, idem);
  const body = res.json() as { outcome?: string; status?: string; failure_code?: string };
  ok(
    "F: a manager cancels it",
    res.statusCode === 200 && body.outcome === "cancelled",
    `${res.statusCode} ${res.body.slice(0, 200)}`,
  );
  await assertCancelled("F", debit.id);
  const inv = await invoiceById(invoice.id);
  ok(
    "F: the invoice stays open and stops automatic collection",
    inv.status === "payment_due" && inv.dunningStatus === "stopped" && inv.nextAttemptAt === null,
    `${inv.status}/${inv.dunningStatus}/${inv.nextAttemptAt}`,
  );
  const replay = await post(url, {}, { cookie: mgr }, idem);
  const rp = replay.json() as typeof body & { id?: string };
  ok(
    "F: a replayed Idempotency-Key answers the same",
    replay.statusCode === 200 && rp.outcome === "cancelled" && rp.id === debit.publicId,
    `${replay.statusCode} ${replay.body.slice(0, 160)}`,
  );
  const twice = await post(url, {}, { cookie: mgr });
  ok(
    "F: a second cancel is a 409 (not in progress)",
    twice.statusCode === 409,
    `${twice.statusCode} ${twice.body.slice(0, 160)}`,
  );
  const afterTxn = (await getTxn(txn.publicId)).json() as {
    pending_debit_cancel: unknown;
    status: string;
  };
  ok(
    "F: the transaction no longer offers it",
    afterTxn.pending_debit_cancel === null && afterTxn.status === "failed",
    `${afterTxn.status}`,
  );

  const locked = await pendingInvoice("operator-locked", SUBMITTED);
  const no = await post(
    `/payments/${locked.debit.publicId}/cancel_pending_debit`,
    {},
    { cookie: mgr },
  );
  const nb = no.json() as { error?: { code?: string; message?: string } };
  ok(
    "F: a submitted debit is a 409 debit_not_cancelable",
    no.statusCode === 409 && nb.error?.code === "debit_not_cancelable",
    `${no.statusCode} ${nb.error?.message}`,
  );
  console.log(`   message: ${nb.error?.message}`);
  ok("F: …and stays pending", (await paymentById(locked.debit.id)).status === "pending");

  // Recording a payment after the operator's cancel works as usual.
  const later = await post(`/invoices/${invoice.publicId}/pay`, { method: "cash" });
  ok(
    "F: the invoice can then be paid offline",
    later.statusCode === 200 && (await invoiceById(invoice.id)).status === "paid",
    String(later.statusCode),
  );
}

await app.close();
await closeDb();
console.log(pass ? "\nPASS verify:pending-debit-guard" : "\nFAIL verify:pending-debit-guard");
process.exit(pass ? 0 : 1);

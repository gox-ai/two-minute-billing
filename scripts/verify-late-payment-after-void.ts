/**
 * A debit that settles after its invoice was voided, and the refund of that money, must
 * both be visible from the invoice.
 *
 *   pnpm verify:late-payment-after-void
 *
 * The settlement detaches the payment and books it as excess (`markUnapplied`), but its
 * transaction keeps `invoice_id`, and the excess refund carries no invoice at all. So the
 * invoice's money log showed a succeeded payment on a voided invoice and never the refund.
 * The read side now serves `unapplied_reason` on the payment row; the dashboard follows
 * `reference_payment` from it to the refund. This pins both halves over HTTP.
 */
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb } from "@/platform/db";
import { loadGeoReference } from "@/platform/geo";
import { createOrganization, createBusiness, createApiKey } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { voidInvoice } from "@/modules/invoicing/ops";
import { refundExcessPayment } from "@/modules/refunds/excess";
import { bucketBalance, EXCESS_PAYMENT } from "@/modules/customers/balances-read";
import { TmtestProvider } from "@/providers/tmtest";
import { setChargeStatus } from "@/providers/tmtest/store";
import { advanceTmtest } from "@/providers/tmtest/webhooks";
import { invoices, payments, paymentMethods, transactions } from "@db/schema";

const SUCCESS = "4242424242424242";
/** Books `in_progress` and never self-settles. */
const ASYNC_PENDING = "4000000000000101";
const AMOUNT = 250_000;

let pass = true;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) pass = false;
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

await loadGeoReference();
const org = await createOrganization({ name: `LatePaymentAfterVoid ${Date.now()}` });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Late Co",
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

/** A customer on `token`, billed once. The mandate is stamped huge so the cap never refuses. */
async function billedCustomer(email: string, token: string) {
  const customer = await createCustomer({ ...ctx, email });
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
  return { customer, invoice };
}

const paymentsOf = (invoiceId: string) =>
  withTenant(orgId, (tx) => tx.select().from(payments).where(eq(payments.invoiceId, invoiceId)));
const excess = (customerId: string) =>
  withTenant(orgId, (tx) => bucketBalance(tx, customerId, EXCESS_PAYMENT, "INR"));

type TxnJson = {
  id: string;
  type: string;
  status: string;
  amount_minor: number;
  invoice: string | null;
  reference_payment: string | null;
  unapplied_reason: string | null;
};
async function listTxns(query: string): Promise<TxnJson[]> {
  const res = await app.inject({
    method: "GET",
    url: `/v1/businesses/${biz.publicId}/transactions?${query}`,
    headers: { authorization: `Bearer ${secret}` },
  });
  if (res.statusCode !== 200) {
    ok(`GET transactions?${query} answers 200`, false, `${res.statusCode} ${res.body}`);
    return [];
  }
  return (res.json() as { data: TxnJson[] }).data;
}

// ── 1. An invoice with a debit live at the gateway ──────────────────────────────
const late = await billedCustomer("late@example.com", ASYNC_PENDING);
const [pending] = await paymentsOf(late.invoice.id);
ok(
  "1: the debit is pending with a charge id",
  pending?.status === "pending" && pending.providerChargeId != null,
  `${pending?.status}/${pending?.providerChargeId ?? "—"}`,
);
const [liveTxn] = await withTenant(orgId, (tx) =>
  tx.select().from(transactions).where(eq(transactions.invoiceId, late.invoice.id)),
);
ok("1: …and its transaction is in_progress", liveTxn?.status === "in_progress", liveTxn?.status);
const pay = pending!;

// ── 2. Void it ──────────────────────────────────────────────────────────────────
// Since 2026-09-29 the void refuses while a payment is in flight, so the incident state
// only exists on rows voided before that. Reproduce it through the real void path by
// hiding the payment from the guard for the call, then restoring it.
const refusal = await voidInvoice(orgId, biz.id, late.invoice.publicId).then(
  () => null,
  (e: Error) => e.message,
);
ok(
  "2: the void refuses while the debit is in flight",
  refusal?.includes("still in progress") === true,
  refusal ?? "voided",
);
await withTenant(orgId, (tx) =>
  tx.update(payments).set({ status: "failed" }).where(eq(payments.id, pay.id)),
);
await voidInvoice(orgId, biz.id, late.invoice.publicId);
await withTenant(orgId, (tx) =>
  tx.update(payments).set({ status: "pending" }).where(eq(payments.id, pay.id)),
);
const [voided] = await withTenant(orgId, (tx) =>
  tx.select().from(invoices).where(eq(invoices.id, late.invoice.id)),
);
ok("2: the invoice is voided with the debit still pending", voided?.status === "voided");

// ── 3. The gateway settles it, through the inbound webhook pipeline ─────────────
await setChargeStatus(pay.providerChargeId!, "succeeded");
await new TmtestProvider(biz.id).triggerSyntheticEvent("charge.succeeded", {
  charge_id: pay.providerChargeId!,
});
await advanceTmtest(orgId, new Date());

// ── 4. Detached and booked as excess ────────────────────────────────────────────
const [settled] = await withTenant(orgId, (tx) =>
  tx.select().from(payments).where(eq(payments.id, pay.id)),
);
ok("4: the debit settles as succeeded", settled?.status === "succeeded", settled?.status);
ok("4: …detached from the voided invoice", settled?.invoiceId === null, String(settled?.invoiceId));
ok(
  "4: …marked async_overpay",
  (settled?.metadata as Record<string, unknown> | null)?.unapplied_gateway_capture ===
    "async_overpay",
  JSON.stringify(settled?.metadata ?? null),
);
const held = await excess(late.customer.id);
ok("4: the whole amount is the customer's excess", held === BigInt(AMOUNT), String(held));

// ── 5. Refund the excess (the customer page's action → POST /payments/:pay/refund) ──
const refund = await refundExcessPayment({ ...ctx, paymentPublicId: pay.publicId });
ok(
  "5: the excess refund succeeds for the full amount",
  refund.status === "succeeded" && refund.amountMinor === BigInt(AMOUNT),
  `${refund.status} ${refund.amountMinor}`,
);
const after = await excess(late.customer.id);
ok("5: …leaving no excess behind", after === 0n, String(after));

// ── 6. What the invoice page reads ──────────────────────────────────────────────
const onInvoice = await listTxns(`invoice=${late.invoice.publicId}`);
const payRow = onInvoice.find((t) => t.type === "payment" && t.status === "succeeded");
ok(
  "6: the voided invoice still lists the late payment",
  payRow != null,
  onInvoice.map((t) => `${t.type}/${t.status}`).join(", "),
);
ok(
  "6: …flagged unapplied_reason=async_overpay",
  payRow?.unapplied_reason === "async_overpay",
  String(payRow?.unapplied_reason),
);
ok(
  "6: …with reference_payment naming the payment",
  payRow?.reference_payment === pay.publicId,
  String(payRow?.reference_payment),
);
ok(
  "6: the refund is not on the invoice's own list (why the lookup exists)",
  !onInvoice.some((t) => t.type === "refund"),
);

const refunds = await listTxns(
  `type=refund&reference_payment[is]=${encodeURIComponent(pay.publicId)}`,
);
ok(
  "6: the reference_payment lookup finds exactly one refund",
  refunds.length === 1,
  `${refunds.length}`,
);
ok(
  "6: …for the same payment and amount",
  refunds[0]?.reference_payment === pay.publicId && refunds[0]?.amount_minor === AMOUNT,
  `${refunds[0]?.reference_payment} ${refunds[0]?.amount_minor}`,
);
ok(
  "6: …and the refund row does not inherit the payment's unapplied_reason",
  refunds[0] != null && refunds[0].unapplied_reason === null,
  String(refunds[0]?.unapplied_reason),
);

// Non-vacuity: an applied payment reads null.
const paid = await billedCustomer("paid@example.com", SUCCESS);
const paidRows = await listTxns(`invoice=${paid.invoice.publicId}`);
const applied = paidRows.find((t) => t.type === "payment" && t.status === "succeeded");
ok("6: an applied payment is listed on its invoice", applied != null);
ok(
  "6: …with unapplied_reason null",
  applied != null && applied.unapplied_reason === null,
  String(applied?.unapplied_reason),
);

await app.close();
console.log(pass ? "✅ LATE-PAYMENT-AFTER-VOID: PASS" : "❌ LATE-PAYMENT-AFTER-VOID: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);

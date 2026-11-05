/**
 * verify:excess-refund — money a payment left on a customer's excess credit is refunded out
 * of that credit, never as contra-revenue, and can never be paid out twice or while spent.
 *
 * Each case books its excess the way production does (`settleUnmatchedGatewayCapture`, a
 * second charge for an invoice already paid) and refunds through the local test gateway,
 * whose magic amounts decide the outcome: `…13` is refused, `…17` accepted but pending.
 */
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { settleUnmatchedGatewayCapture } from "@/modules/payments/settlement";
import { refundExcessPayment, listExcessPayments } from "@/modules/refunds/excess";
import { reverseRefund } from "@/modules/refunds/settlement";
import { RefundError } from "@/modules/refunds/service";
import { ledgerEntries, refunds } from "@db/schema";

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

const org = await createOrganization({ name: "Excess Refund Org" });
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
  email: "x@a.com",
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
const { payment: first, invoice } = await billSubscriptionPeriod({
  organizationId: orgId,
  businessId: biz.id,
  subscription: sub.subscription,
  periodStart: sub.subscription.currentPeriodStart!,
  periodEnd: sub.subscription.currentPeriodEnd!,
});
if (!first || first.status !== "succeeded" || !invoice) {
  console.log("❌ no paid invoice to overpay");
  process.exit(1);
}

/** A second charge for the invoice already paid — booked as the customer's excess credit. */
async function duplicateCharge(amountMinor: bigint): Promise<string> {
  const res = await withTenant(orgId, (tx) =>
    settleUnmatchedGatewayCapture(tx, {
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      invoiceId: invoice!.id,
      currency: "USD",
      amountMinor,
      providerKey: first!.providerKey,
      providerChargeId: `ch_dup_${crypto.randomUUID()}`,
      paymentMethodId: first!.paymentMethodId,
      reason: "second_checkout",
      occurredAt: new Date(),
    }),
  );
  if (!res.booked || res.disposition !== "excess")
    throw new Error(`not booked as excess: ${JSON.stringify(res)}`);
  return res.paymentPublicId;
}

const balance = (account: string) =>
  withTenant(orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.account, account), eq(ledgerEntries.businessId, biz.id)));
    return rows.reduce(
      (s, r) => s + (r.direction === "credit" ? r.amountMinor : -r.amountMinor),
      0n,
    );
  });
const snapshot = async () => ({
  excess: await balance("excess_payment_balance"),
  pending: await balance("excess_refund_pending"),
  refunds: await balance("refunds"),
  cash: -(await balance("cash")),
});

// ── 1. A duplicate charge is listed, refunded in full, and never touches revenue ──────
const dup = await duplicateCharge(148562n);
const listed = await listExcessPayments(orgId, biz.id, customer.id);
const row = listed.find((r) => r.paymentPublicId === dup);
ok("the duplicate charge is listed as holding excess credit", row?.heldMinor === 148562n, listed);
ok("…and all of it is refundable", row?.refundableMinor === 148562n, row);

const before = await snapshot();
const refund = await refundExcessPayment({
  organizationId: orgId,
  businessId: biz.id,
  paymentPublicId: dup,
});
const after = await snapshot();
ok("the refund is for the whole duplicate", refund.amountMinor === 148562n, refund.amountMinor);
ok("the customer's excess credit is drawn down by it", before.excess - after.excess === 148562n, {
  before,
  after,
});
ok("cash leaves by the same amount", before.cash - after.cash === 148562n, { before, after });
ok("nothing is left in flight", after.pending === 0n, after);
ok("no contra-revenue is booked — it was never revenue", after.refunds === before.refunds, {
  before,
  after,
});
ok(
  "the payment no longer appears as refundable",
  !(await listExcessPayments(orgId, biz.id, customer.id)).some((r) => r.paymentPublicId === dup),
);
let second: unknown = null;
try {
  await refundExcessPayment({ organizationId: orgId, businessId: biz.id, paymentPublicId: dup });
} catch (e) {
  second = e;
}
ok("a second refund of the same excess is refused", second instanceof RefundError, second);

// ── 2. More than the payment holds is refused ────────────────────────────────────────
const dup2 = await duplicateCharge(5000n);
let over: unknown = null;
try {
  await refundExcessPayment({
    organizationId: orgId,
    businessId: biz.id,
    paymentPublicId: dup2,
    amountMinor: 5001,
  });
} catch (e) {
  over = e;
}
ok("a refund above what the payment holds is refused", over instanceof RefundError, over);
ok("…and the refusal moved nothing", (await snapshot()).pending === 0n);

// ── 3. A gateway refusal gives the credit back ───────────────────────────────────────
const refused = await duplicateCharge(10013n);
const b3 = await snapshot();
let declined: unknown = null;
try {
  await refundExcessPayment({
    organizationId: orgId,
    businessId: biz.id,
    paymentPublicId: refused,
  });
} catch (e) {
  declined = e;
}
const a3 = await snapshot();
ok("a refused refund surfaces as a RefundError", declined instanceof RefundError, declined);
ok("the customer keeps the credit", a3.excess === b3.excess, { b3, a3 });
ok("nothing is stranded in flight", a3.pending === 0n, a3);
ok("no cash moved", a3.cash === b3.cash, { b3, a3 });
ok(
  "the payment is refundable again",
  (await listExcessPayments(orgId, biz.id, customer.id)).find((r) => r.paymentPublicId === refused)
    ?.refundableMinor === 10013n,
);

// ── 4. Accepted, then failed at the rail: the reversal returns it to credit ──────────
const later = await duplicateCharge(10017n);
const b4 = await snapshot();
const pendingRefund = await refundExcessPayment({
  organizationId: orgId,
  businessId: biz.id,
  paymentPublicId: later,
});
ok("the accepted refund is pending", pendingRefund.status === "pending", pendingRefund.status);
await reverseRefund(pendingRefund, { failureCode: "bank_reversed" });
const a4 = await snapshot();
ok("after the reversal the customer has the credit back", a4.excess === b4.excess, { b4, a4 });
ok("…nothing is stranded in flight", a4.pending === 0n, a4);
ok("…cash is back", a4.cash === b4.cash, { b4, a4 });
ok("…and contra-revenue was never touched", a4.refunds === b4.refunds, { b4, a4 });

// ── 5. Two refunders at once pay out once ────────────────────────────────────────────
const race = await duplicateCharge(7000n);
const results = await Promise.allSettled([
  refundExcessPayment({ organizationId: orgId, businessId: biz.id, paymentPublicId: race }),
  refundExcessPayment({ organizationId: orgId, businessId: biz.id, paymentPublicId: race }),
]);
const won = results.filter((r) => r.status === "fulfilled").length;
ok("two concurrent refunds of one excess payment: exactly one pays", won === 1, results);
const paidOut = await withTenant(orgId, async (tx) =>
  (await tx.select().from(refunds).where(eq(refunds.businessId, biz.id)))
    .filter((r) => r.status !== "failed")
    .reduce((s, r) => s + r.amountMinor, 0n),
);
ok("…and the total paid out is 148562 + 7000 (case 4 was reversed)", paidOut === 155562n, paidOut);
ok("…with nothing left in flight", (await snapshot()).pending === 0n);
// The payment lock alone stops the second PAYOUT; the customer lock is what stops the
// second RESERVATION. Without it both reserve, and for a moment the same credit is drawn
// twice — the window a concurrent collect would spend. So the history must never dip.
const history = await withTenant(orgId, (tx) =>
  tx
    .select()
    .from(ledgerEntries)
    .where(
      and(eq(ledgerEntries.account, "excess_payment_balance"), eq(ledgerEntries.sourceId, race)),
    )
    .orderBy(ledgerEntries.createdAt, ledgerEntries.id),
);
let running = 0n;
let lowest = 0n;
for (const e of history) {
  running += e.direction === "credit" ? e.amountMinor : -e.amountMinor;
  if (running < lowest) lowest = running;
}
ok("…and the payment's excess was never reserved twice (never below zero)", lowest >= 0n, {
  lowest,
  history: history.length,
});

// ── 6. The HTTP route: an unattached payment goes through the excess path ────────────
const app = await buildApp({ logger: false });
const auth = { authorization: `Bearer ${org.secret}` };
const viaRoute = await duplicateCharge(3000n);
const listRes = await app.inject({
  method: "GET",
  url: `/v1/businesses/${biz.publicId}/customers/${customer.publicId}/excess_payments`,
  headers: auth,
});
const listBody = listRes.json() as { data: Array<{ payment: string; refundable_minor: number }> };
ok(
  "GET …/excess_payments lists the payment and its refundable amount",
  listRes.statusCode === 200 &&
    listBody.data.some((d) => d.payment === viaRoute && d.refundable_minor === 3000),
  listRes.body,
);
const b6 = await snapshot();
const refundRes = await app.inject({
  method: "POST",
  url: `/v1/businesses/${biz.publicId}/payments/${viaRoute}/refund`,
  headers: { ...auth, "idempotency-key": crypto.randomUUID() },
  payload: {},
});
const a6 = await snapshot();
ok("POST …/payments/:pay/refund refunds it", refundRes.statusCode === 201, refundRes.body);
ok(
  "…out of the excess credit, not as a revenue refund",
  b6.excess - a6.excess === 3000n && a6.refunds === b6.refunds,
  {
    b6,
    a6,
  },
);
await app.close();

console.log(
  `\n${fail === 0 ? "✅" : "❌"} EXCESS REFUND: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`,
);
await closeDb();
process.exit(fail === 0 ? 0 : 1);

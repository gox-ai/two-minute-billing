/**
 * verify:checkout-purchase — one-time purchases through the hosted checkout (E1).
 *
 * Driven over HTTP: the purchase branch, the pinned-customer guard and the invoice id on
 * the response all live in the routes. Covers the mint rules, the catalogue rule, paying
 * without saving, saving first, a decline, a 3DS challenge, a capture held for review, a
 * known customer, and replay.
 */
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createProduct, createPrice, updateProduct } from "@/modules/catalog/service";
import { createFlatTaxRate } from "@/modules/tax/service";
import { createCustomer } from "@/modules/customers/service";
import { authorizePaymentIntent } from "@/modules/payment-intents/service";
import { listCustomerPurchases } from "@/modules/checkout/service";
import { createManualInvoice } from "@/modules/invoicing/ops";
import { refundPayment } from "@/modules/refunds/service";
import { handleProviderEvent } from "@/modules/webhooks/inbound";
import { TmtestProvider } from "@/providers/tmtest";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";
import {
  businesses,
  checkoutSessions,
  customerAddresses,
  customers,
  invoices,
  paymentMethods,
  paymentIntents,
  payments,
  subscriptions,
  transactions,
} from "@db/schema";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log("✓", label);
  } else {
    fail++;
    console.log("✗", label);
  }
}

const app = await buildApp({ logger: false });
await clearPublicRateLimits();

const org = await createOrganization({ name: "Purchase Co" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Purchase Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
// A test business is created with its own TM Test gateway; a second would make USD ambiguous.
await createFlatTaxRate({
  organizationId: orgId,
  businessId: biz.id,
  name: "Sales tax",
  country: "US",
  rateBps: 1000,
});
const pack = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Credit pack",
  kind: "charge",
});
const packPrice = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: pack.id,
  type: "one_time",
  model: "flat",
  currency: "USD",
  amountMinor: 2500,
});
const plan = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Plan" });
const planPrice = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: plan.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 5000,
  interval: "month",
});

const body = (r: { body: string }) => JSON.parse(r.body);
const mint = (payload: object) =>
  app.inject({
    method: "POST",
    url: `/v1/businesses/${biz.publicId}/checkout_sessions`,
    headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": crypto.randomUUID() },
    payload,
  });
const call = (path: string, token: string, method: "GET" | "POST" = "GET", payload?: unknown) =>
  app.inject({
    method,
    url: path,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method === "POST" ? { "idempotency-key": crypto.randomUUID() } : {}),
    },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const address = {
  line1: "1 Market St",
  city: "San Francisco",
  state: "California",
  state_code: "CA",
  postal_code: "94105",
  country: "US",
  first_name: "Bu",
  last_name: "Yer",
};
const setSave = (v: "never" | "always" | "ask") =>
  withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({ storefrontConfig: { one_time_save_payment_method: v } })
      .where(eq(businesses.id, biz.id)),
  );
const purchaseLink = async () => {
  const r = await mint({ price: packPrice.publicId, mode: "purchase" });
  return body(r) as { token: string; id: string };
};
const invoiceRow = (publicId: string) =>
  withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.publicId, publicId)).limit(1),
  ).then((r) => r[0]);
// ── Mint rules ────────────────────────────────────────────────────────────────
ok(
  "mint: a recurring price is refused in purchase mode",
  (await mint({ price: planPrice.publicId, mode: "purchase" })).statusCode === 400,
);
ok(
  "mint: a coupon is refused in purchase mode",
  (await mint({ price: packPrice.publicId, mode: "purchase", coupons: ["X"] })).statusCode === 400,
);
ok(
  "mint: metadata is refused in purchase mode",
  (await mint({ price: packPrice.publicId, mode: "purchase", metadata: { a: 1 } })).statusCode ===
    400,
);
ok(
  "mint: customer_id is refused outside purchase mode",
  (await mint({ price: planPrice.publicId, customer_id: "cus_nope" })).statusCode === 400,
);
const okMint = await mint({ price: packPrice.publicId, mode: "purchase" });
ok("mint: a one-time price in purchase mode answers 201", okMint.statusCode === 201);

// ── Pay without saving ────────────────────────────────────────────────────────
await setSave("ask");
const a = await purchaseLink();
const before = body(await call("/checkout/v1/session", a.token));
ok("view: mode is purchase", before.mode === "purchase");
ok(
  "view: before the address, the total has no tax and says so",
  before.purchase?.tax_known === false && before.purchase?.total_minor === 2500,
);
ok("view: the buyer cannot type coupons on a purchase", before.allow_coupons === false);
await call("/checkout/v1/customer", a.token, "POST", { email: "a@example.com", address });
const after = body(await call("/checkout/v1/session", a.token));
ok(
  "view: after the address, tax is added (10% of 2500)",
  after.purchase?.tax_known === true &&
    after.purchase?.tax_minor === 250 &&
    after.purchase?.total_minor === 2750,
);
const done = await call("/checkout/v1/complete", a.token, "POST", {});
const doneBody = body(done);
ok("pay: completes with 201 and an invoice id", done.statusCode === 201 && !!doneBody.invoice_id);
ok("pay: the response names no subscription", doneBody.subscription_id === undefined);
const inv = await invoiceRow(doneBody.invoice_id);
ok(
  "pay: the invoice is paid, taxed, and belongs to no subscription",
  inv?.status === "paid" && Number(inv.totalMinor) === 2750 && inv.subscriptionId === null,
);
const subs = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptions).where(eq(subscriptions.customerId, inv!.customerId)),
);
ok("pay: no subscription was created", subs.length === 0);
const pms = await withTenant(orgId, (tx) =>
  tx.select().from(paymentMethods).where(eq(paymentMethods.customerId, inv!.customerId)),
);
ok("pay: no payment method was saved", pms.length === 0);
const replay = await call("/checkout/v1/complete", a.token, "POST", {});
const pays = await withTenant(orgId, (tx) =>
  tx
    .select()
    .from(payments)
    .where(and(eq(payments.invoiceId, inv!.id), eq(payments.status, "succeeded"))),
);
ok(
  "replay: a second complete returns the same invoice and charges nothing more",
  body(replay).invoice_id === doneBody.invoice_id && pays.length === 1,
);
const [sess] = await withTenant(orgId, (tx) =>
  tx.select().from(checkoutSessions).where(eq(checkoutSessions.publicId, a.id)),
);
ok(
  "session: completed, recording the invoice and a payment step",
  sess?.status === "completed" && sess.resultingInvoiceId === inv!.id && !!sess.paymentStartedAt,
);
const retrieved = body(
  await app.inject({
    method: "GET",
    url: `/v1/businesses/${biz.publicId}/checkout_sessions/${a.id}`,
    headers: { authorization: `Bearer ${org.secret}` },
  }),
);
ok(
  "retrieve: the operator sees mode purchase and the invoice",
  retrieved.mode === "purchase" && retrieved.resulting_invoice === doneBody.invoice_id,
);

// ── Save first ────────────────────────────────────────────────────────────────
await setSave("always");
const b = await purchaseLink();
await call("/checkout/v1/customer", b.token, "POST", { email: "b@example.com", address });
const saved = body(await call("/checkout/v1/complete", b.token, "POST", { token: "tok_4242" }));
const savedInv = await invoiceRow(saved.invoice_id);
const savedPms = await withTenant(orgId, (tx) =>
  tx.select().from(paymentMethods).where(eq(paymentMethods.customerId, savedInv!.customerId)),
);
ok(
  "save: the method is saved and the invoice paid",
  savedInv?.status === "paid" && savedPms.length === 1,
);

await setSave("never");
const c = await purchaseLink();
await call("/checkout/v1/customer", c.token, "POST", { email: "c@example.com", address });
const refusedSave = await call("/checkout/v1/complete", c.token, "POST", { token: "tok_4242" });
ok("never: a method sent anyway is refused (400)", refusedSave.statusCode === 400);

// ── Decline ───────────────────────────────────────────────────────────────────
await setSave("always");
const d = await purchaseLink();
await call("/checkout/v1/customer", d.token, "POST", { email: "d@example.com", address });
// The test gateway's "retry" card: the intent authorises, then its first capture fails.
const declined = await call("/checkout/v1/complete", d.token, "POST", {
  token: "tok_4000000000002008",
});
const [dSess] = await withTenant(orgId, (tx) =>
  tx.select().from(checkoutSessions).where(eq(checkoutSessions.publicId, d.id)),
);
ok(
  "decline: answers 400 and the session is open again",
  declined.statusCode === 400 && dSess?.status === "open",
);
const dInvoices = await withTenant(orgId, (tx) =>
  tx
    .select({ status: invoices.status })
    .from(invoices)
    .where(eq(invoices.customerId, dSess!.resultingCustomerId!)),
);
ok(
  "decline: no open invoice is left behind",
  dInvoices.every((i) => i.status === "voided"),
);
const retry = await call("/checkout/v1/complete", d.token, "POST", { token: "tok_4242" });
ok("decline: the buyer can retry with another card", retry.statusCode === 201);

// ── 3DS challenge ─────────────────────────────────────────────────────────────
const e = await purchaseLink();
await call("/checkout/v1/customer", e.token, "POST", { email: "e@example.com", address });
const CHALLENGE = "tok_4000000000003155";
const leg1 = await call("/checkout/v1/complete", e.token, "POST", { token: CHALLENGE });
const pi = body(leg1).payment_intent?.id as string | undefined;
ok("3ds: leg 1 answers 402 with a payment intent", leg1.statusCode === 402 && !!pi);
const [eSess] = await withTenant(orgId, (tx) =>
  tx.select().from(checkoutSessions).where(eq(checkoutSessions.publicId, e.id)),
);
const eInvoicesBefore = await withTenant(orgId, (tx) =>
  tx.select().from(invoices).where(eq(invoices.customerId, eSess!.resultingCustomerId!)),
);
ok("3ds: no invoice exists before the buyer authenticates", eInvoicesBefore.length === 0);
await authorizePaymentIntent(orgId, biz.id, pi!);
const leg2 = await call("/checkout/v1/complete", e.token, "POST", {
  token: CHALLENGE,
  payment_intent: pi,
});
const eInv = await invoiceRow(body(leg2).invoice_id);
const ePms = await withTenant(orgId, (tx) =>
  tx
    .select()
    .from(paymentMethods)
    .where(eq(paymentMethods.customerId, eSess!.resultingCustomerId!)),
);
ok("3ds: leg 2 pays the invoice", leg2.statusCode === 201 && eInv?.status === "paid");
ok("3ds: leg 2 does not save the method twice", ePms.length === 1);

// ── Lost webhook: the gateway authorized, our row never heard ─────────────────
// Leg 2 must ask the gateway rather than refuse on our stale `in_progress`.
{
  const lw = await purchaseLink();
  await call("/checkout/v1/customer", lw.token, "POST", { email: "lw@example.com", address });
  const first = await call("/checkout/v1/complete", lw.token, "POST", { token: CHALLENGE });
  const lwPi = body(first).payment_intent?.id as string;
  const early = await call("/checkout/v1/complete", lw.token, "POST", {
    token: CHALLENGE,
    payment_intent: lwPi,
  });
  ok(
    "lost webhook: before the gateway authorizes, leg 2 still refuses (400)",
    early.statusCode === 400 && /Complete the payment step first/.test(early.body),
  );
  const [lwRow] = await withTenant(orgId, (tx) =>
    tx.select().from(paymentIntents).where(eq(paymentIntents.publicId, lwPi)),
  );
  // The gateway approves the challenge; no webhook reaches us.
  await TmtestProvider.resolveChallenge(lwRow!.intentAtGateway!, true);
  const [stale] = await withTenant(orgId, (tx) =>
    tx.select().from(paymentIntents).where(eq(paymentIntents.publicId, lwPi)),
  );
  const done = await call("/checkout/v1/complete", lw.token, "POST", {
    token: CHALLENGE,
    payment_intent: lwPi,
  });
  const again = await call("/checkout/v1/complete", lw.token, "POST", {
    token: CHALLENGE,
    payment_intent: lwPi,
  });
  const lwInv = body(done).invoice_id ? await invoiceRow(body(done).invoice_id) : undefined;
  const lwPays = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(payments)
      .where(eq(payments.invoiceId, lwInv?.id ?? crypto.randomUUID())),
  );
  const lwTxns = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(transactions)
      .where(eq(transactions.invoiceId, lwInv?.id ?? crypto.randomUUID())),
  );
  ok(
    "lost webhook: leg 2 reads the gateway and pays the invoice",
    stale?.status !== "authorized" && done.statusCode === 201 && lwInv?.status === "paid",
  );
  ok(
    "lost webhook: a second submit books nothing more (1 payment, 1 transaction)",
    again.statusCode === 201 &&
      body(again).invoice_id === body(done).invoice_id &&
      lwPays.length === 1 &&
      lwTxns.length === 1,
  );
}

// ── Capture held for review ───────────────────────────────────────────────────
// The gateway takes the capture but holds the money (PayPal PENDING_REVIEW). It must be
// booked as money in flight, and the gateway's later verdict must settle it.
const reviewed = async (email: string) => {
  const link = await purchaseLink();
  await call("/checkout/v1/customer", link.token, "POST", { email, address });
  const first = await call("/checkout/v1/complete", link.token, "POST", { token: CHALLENGE });
  const intent = body(first).payment_intent?.id as string;
  await authorizePaymentIntent(orgId, biz.id, intent);
  const chargeId = `tmch_review_${crypto.randomUUID()}`;
  const original = TmtestProvider.prototype.consumeIntent;
  TmtestProvider.prototype.consumeIntent = async () => ({
    purpose: "payment",
    charge: { status: "pending", providerChargeId: chargeId },
  });
  try {
    const second = await call("/checkout/v1/complete", link.token, "POST", {
      token: CHALLENGE,
      payment_intent: intent,
    });
    return { second, intent, chargeId };
  } finally {
    TmtestProvider.prototype.consumeIntent = original;
  }
};
const verdict = (type: "charge.succeeded" | "charge.failed", chargeId: string) =>
  handleProviderEvent(
    "tmtest",
    {
      providerEventId: `tmev_review_${crypto.randomUUID()}`,
      type,
      providerChargeId: chargeId,
      occurredAt: new Date(),
      raw: { data: {} },
    },
    { businessId: biz.id },
  );
const moneyFor = async (invoiceId: string) => {
  const pays = await withTenant(orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.invoiceId, invoiceId)),
  );
  const txns = await withTenant(orgId, (tx) =>
    tx.select().from(transactions).where(eq(transactions.invoiceId, invoiceId)),
  );
  return { pays, txns };
};

const r1 = await reviewed("review-ok@example.com");
const r1Body = body(r1.second);
const r1Inv = await invoiceRow(r1Body.invoice_id);
const r1Money = await moneyFor(r1Inv!.id);
const [r1Intent] = await withTenant(orgId, (tx) =>
  tx.select().from(paymentIntents).where(eq(paymentIntents.publicId, r1.intent)),
);
ok(
  "review: the buyer is told the payment is in progress, not received",
  r1.second.statusCode === 201 && r1Body.unpaid_invoice?.state === "processing",
);
ok(
  "review: a pending payment and an in-progress transaction, never a failure",
  r1Money.pays.length === 1 &&
    r1Money.pays[0]!.status === "pending" &&
    r1Money.txns.length === 1 &&
    r1Money.txns[0]!.status === "in_progress",
);
ok(
  "review: the intent stays consumed and dunning is parked",
  r1Intent?.status === "consumed" && r1Inv?.status === "payment_due" && !r1Inv.nextAttemptAt,
);
ok(
  "review: the gateway's success is processed",
  (await verdict("charge.succeeded", r1.chargeId)) === "processed",
);
const r1After = await invoiceRow(r1Body.invoice_id);
const r1MoneyAfter = await moneyFor(r1Inv!.id);
ok(
  "review: …and pays the invoice",
  r1After?.status === "paid" && r1MoneyAfter.pays[0]!.status === "succeeded",
);

const r2 = await reviewed("review-denied@example.com");
const r2Inv = await invoiceRow(body(r2.second).invoice_id);
await verdict("charge.failed", r2.chargeId);
const r2After = await invoiceRow(body(r2.second).invoice_id);
const r2Money = await moneyFor(r2Inv!.id);
ok(
  "review: a refused review leaves the invoice open with the payment failed",
  r2After?.status !== "paid" && r2Money.pays[0]!.status === "failed",
);

// ── Known customer ────────────────────────────────────────────────────────────
await setSave("ask");
const known = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "known@example.com",
  firstName: "Known",
  lastName: "Buyer",
});
const kMint = body(
  await mint({ price: packPrice.publicId, mode: "purchase", customer_id: known.publicId }),
) as { token: string; id: string };
const kView = body(await call("/checkout/v1/session", kMint.token));
ok(
  "known: the view says the customer is pinned and shows no email",
  kView.purchase?.customer_pinned === true && kView.customer?.email === undefined,
);
await call("/checkout/v1/customer", kMint.token, "POST", {
  email: "attacker@example.com",
  address,
});
const [knownAfter] = await withTenant(orgId, (tx) =>
  tx.select().from(customers).where(eq(customers.id, known.id)),
);
ok("known: an email the buyer sends is ignored", knownAfter?.email === "known@example.com");
ok(
  "known: the buyer can complete the address (200)",
  (await call("/checkout/v1/customer", kMint.token, "POST", { address })).statusCode === 200,
);
const kDone = body(await call("/checkout/v1/complete", kMint.token, "POST", {}));
const kInv = await invoiceRow(kDone.invoice_id);
ok(
  "known: the invoice is the known customer's",
  kInv?.customerId === known.id && kInv.status === "paid",
);

// ── Shipping address on a purchase (0360) ─────────────────────────────────────
{
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({ checkoutFieldConfig: { "shipping.address": "show" } })
      .where(eq(businesses.id, biz.id)),
  );
  const ship = { ...address, line1: "8 Harbor Rd", first_name: "Rec" };
  const sh = await purchaseLink();
  await call("/checkout/v1/customer", sh.token, "POST", {
    email: "ship@example.com",
    address,
    shipping_address: ship,
  });
  const shDone = body(await call("/checkout/v1/complete", sh.token, "POST", {}));
  const shInv = await invoiceRow(shDone.invoice_id);
  const shBook = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(customerAddresses)
      .where(eq(customerAddresses.customerId, shInv?.customerId ?? crypto.randomUUID())),
  );
  ok(
    "shipping: a purchase stores the ship-to as the customer's default",
    shBook.length === 1 && shBook[0]!.isDefault && shBook[0]!.line1 === "8 Harbor Rd",
  );
  ok(
    "shipping: the purchase invoice snapshots it",
    (shInv?.shippingAddress as Record<string, string> | null)?.line1 === "8 Harbor Rd",
  );
  const kShip = body(
    await mint({ price: packPrice.publicId, mode: "purchase", customer_id: known.publicId }),
  ) as { token: string };
  const kShipView = body(await call("/checkout/v1/session", kShip.token));
  ok(
    "shipping: a known customer's purchase has no shipping section",
    kShipView.field_config?.["shipping.address"] === "hide",
  );
  await withTenant(orgId, (tx) =>
    tx.update(businesses).set({ checkoutFieldConfig: null }).where(eq(businesses.id, biz.id)),
  );
}

// ── E5: the portal's purchase list ────────────────────────────────────────────
// An operator's one-off invoice for the same customer is NOT a purchase.
await createManualInvoice({
  organizationId: orgId,
  businessId: biz.id,
  customerId: known.id,
  currency: "USD",
  lines: [{ description: "Consulting", amountMinor: 1000n }],
});
const listed = await listCustomerPurchases({
  organizationId: orgId,
  businessId: biz.id,
  customerId: known.id,
  limit: 10,
});
ok(
  "portal: lists the purchase, not the operator's one-off invoice",
  listed.data.length === 1 && listed.data[0]!.invoiceId === kDone.invoice_id,
);
ok(
  "portal: names what was bought, without tax rows",
  listed.data[0]!.items.length === 1 && listed.data[0]!.items[0]!.description === "Credit pack",
);
await updateProduct({
  organizationId: orgId,
  businessId: biz.id,
  productPublicId: pack.publicId,
  imageUrl: "https://cdn.example.com/pack.png",
});
const withImage = await listCustomerPurchases({
  organizationId: orgId,
  businessId: biz.id,
  customerId: known.id,
  limit: 10,
});
ok(
  "portal: a purchase shows its product's image",
  withImage.data[0]!.items[0]!.imageUrl === "https://cdn.example.com/pack.png",
);
const [kPay] = await withTenant(orgId, (tx) =>
  tx.select().from(payments).where(eq(payments.invoiceId, kInv!.id)),
);
await refundPayment({
  organizationId: orgId,
  businessId: biz.id,
  paymentPublicId: kPay!.publicId,
  amountMinor: 500,
});
const afterRefund = await listCustomerPurchases({
  organizationId: orgId,
  businessId: biz.id,
  customerId: known.id,
  limit: 10,
});
ok("portal: a refund shows on the purchase", afterRefund.data[0]!.refundedMinor === 500);

console.log(`\n${pass} passed, ${fail} failed`);
await app.close();
await closeDb();
process.exit(fail ? 1 : 0);

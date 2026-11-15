/**
 * verify:checkout-purchase — one-time purchases through the hosted checkout (E1).
 *
 * Driven over HTTP: the purchase branch, the pinned-customer guard and the invoice id on
 * the response all live in the routes. Covers the mint rules, the catalogue rule, paying
 * without saving, saving first, a decline, a 3DS challenge, a capture held for review, a
 * known customer, replay, and coupons (API and buyer codes, 100% off, release on a decline,
 * a code refused on the 3-D Secure return leg releasing the hold, and `POST /invoices` with
 * `coupons`), and metadata carried onto the purchase's invoice (and `POST /invoices`). Also a
 * create checkout for a known customer (`customer_id`): it subscribes that customer, and refuses
 * a customer of another business, two currencies and a meter already billed.
 */
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { createTestMeter } from "./lib/meter-fixtures";
import { createProduct, createPrice, updateProduct } from "@/modules/catalog/service";
import { createFlatTaxRate } from "@/modules/tax/service";
import { createCustomer } from "@/modules/customers/service";
import { authorizePaymentIntent } from "@/modules/payment-intents/service";
import { listCustomerPurchases } from "@/modules/checkout/service";
import { createManualInvoice } from "@/modules/invoicing/ops";
import { createCoupon, createCouponSet } from "@/modules/coupons/service";
import { handleProviderEvent } from "@/modules/webhooks/inbound";
import { TmtestProvider } from "@/providers/tmtest";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";
import { tmtestPayAtOnce } from "./lib/tmtest-pay-at-once";
import {
  appliedCoupons,
  businesses,
  checkoutSessions,
  coupons,
  couponSetCodes,
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
  "mint: an unknown coupon 404s in purchase mode",
  (await mint({ price: packPrice.publicId, mode: "purchase", coupons: ["X"] })).statusCode === 404,
);
ok(
  "mint: metadata is accepted in purchase mode",
  (await mint({ price: packPrice.publicId, mode: "purchase", metadata: { a: 1 } })).statusCode ===
    201,
);
ok(
  "mint: customer_id is refused in change mode",
  (
    await mint({
      price: planPrice.publicId,
      mode: "change",
      subscription: "sub_nope",
      customer_id: "cus_nope",
    })
  ).statusCode === 400,
);
const okMint = await mint({ price: packPrice.publicId, mode: "purchase" });
ok("mint: a one-time price in purchase mode answers 201", okMint.statusCode === 201);

// ── Test gateway dialog: Pay answers Approve/Decline, Decline leaves nothing paid ──
{
  await setSave("ask");
  const t = await purchaseLink();
  await call("/checkout/v1/customer", t.token, "POST", { email: "dlg@example.com", address });
  const leg1 = await call("/checkout/v1/complete", t.token, "POST", {});
  const l1 = body(leg1);
  ok(
    "dialog: Pay answers 402 with the sdk challenge",
    leg1.statusCode === 402 && l1.next_action?.mode === "sdk" && !!l1.payment_intent?.id,
  );
  const declined = await call("/checkout/v1/complete", t.token, "POST", {
    payment_intent: l1.payment_intent?.id,
    client_result: { nonce: "tmtest_decline" },
  });
  const [tSess] = await withTenant(orgId, (tx) =>
    tx.select().from(checkoutSessions).where(eq(checkoutSessions.publicId, t.id)),
  );
  const tPaid = await withTenant(orgId, (tx) =>
    tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.customerId, tSess?.resultingCustomerId ?? crypto.randomUUID()),
          eq(invoices.status, "paid"),
        ),
      ),
  );
  ok(
    "dialog: Decline answers 400, leaves the session open and no paid invoice",
    declined.statusCode === 400 && tSess?.status === "open" && tPaid.length === 0,
  );
  const again = body(await call("/checkout/v1/complete", t.token, "POST", {}));
  const approved = await call("/checkout/v1/complete", t.token, "POST", {
    payment_intent: again.payment_intent?.id,
    client_result: { nonce: "tmtest_ok" },
  });
  const aInv = approved.statusCode === 201 ? await invoiceRow(body(approved).invoice_id) : null;
  ok("dialog: the buyer retries and Approve pays", aInv?.status === "paid");
}
// The rest tests past the dialog: Pay authorizes at once.
await tmtestPayAtOnce(orgId, biz.id);

// ── Pay without saving ────────────────────────────────────────────────────────
await setSave("ask");
const a = await purchaseLink();
const before = body(await call("/checkout/v1/session", a.token));
ok("view: mode is purchase", before.mode === "purchase");
ok(
  "view: before the address, the total has no tax and says so",
  before.purchase?.tax_known === false && before.purchase?.total_minor === 2500,
);
ok("view: no coupon box while the business does not allow one", before.allow_coupons === false);
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

// ── Metadata: the app's order reference lands on the purchase's invoice ─────────
{
  const m = body(
    await mint({ price: packPrice.publicId, mode: "purchase", metadata: { order_id: "ord_1042" } }),
  ) as { token: string };
  await call("/checkout/v1/customer", m.token, "POST", { email: "m@example.com", address });
  const mDone = body(await call("/checkout/v1/complete", m.token, "POST", {}));
  const mInv = body(
    await app.inject({
      method: "GET",
      url: `/v1/businesses/${biz.publicId}/invoices/${mDone.invoice_id}`,
      headers: { authorization: `Bearer ${org.secret}` },
    }),
  );
  ok(
    "metadata: the paid purchase invoice returns the checkout's metadata",
    mInv.status === "paid" && mInv.metadata?.order_id === "ord_1042",
  );
  ok(
    "metadata: a purchase without metadata leaves the invoice's empty",
    !inv?.metadata || Object.keys(inv.metadata as object).length === 0,
  );
}

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

// ── Known customer on a create checkout ───────────────────────────────────────
{
  const app2 = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "app-created@example.com",
    address: {
      line1: "9 First St",
      city: "San Francisco",
      stateCode: "CA",
      postalCode: "94105",
      country: "US",
      firstName: "App",
      lastName: "Buyer",
    },
  });
  const cMint = await mint({ price: planPrice.publicId, customer_id: app2.publicId });
  ok("create known: mint with customer_id answers 201", cMint.statusCode === 201);
  const cTok = (body(cMint) as { token: string }).token;
  const cView = body(await call("/checkout/v1/session", cTok));
  ok(
    "create known: the page is pinned, shows no email and prefills the stored address",
    cView.customer_pinned === true &&
      cView.customer?.email === undefined &&
      cView.customer?.address?.line1 === "9 First St",
  );
  ok(
    "create known: the buyer can correct the billing address (200)",
    (await call("/checkout/v1/customer", cTok, "POST", { address })).statusCode === 200,
  );
  const cDone = await call("/checkout/v1/complete", cTok, "POST", { token: "tok_4242" });
  const cBody = body(cDone);
  const [cSub] = cBody.subscription_id
    ? await withTenant(orgId, (tx) =>
        tx.select().from(subscriptions).where(eq(subscriptions.publicId, cBody.subscription_id)),
      )
    : [];
  ok(
    "create known: completing subscribes THAT customer",
    cDone.statusCode === 201 && cBody.customer_id === app2.publicId && cSub?.customerId === app2.id,
  );
  const sameEmail = await withTenant(orgId, (tx) =>
    tx.select().from(customers).where(eq(customers.email, "app-created@example.com")),
  );
  ok(
    "create known: no second customer, and the corrected address is stored",
    sameEmail.length === 1 && sameEmail[0]!.addressLine1 === "1 Market St",
  );

  const otherBiz = await createBusiness({
    organizationId: orgId,
    name: "Other Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const stranger = await createCustomer({
    organizationId: orgId,
    businessId: otherBiz.id,
    email: "stranger@example.com",
  });
  ok(
    "create known: a customer of another business → 404",
    (await mint({ price: planPrice.publicId, customer_id: stranger.publicId })).statusCode === 404,
  );
  const eurPlan = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: plan.id,
    type: "recurring",
    model: "flat",
    currency: "EUR",
    amountMinor: 4500,
    interval: "month",
  });
  const mixed = await mint({
    items: [{ price: planPrice.publicId }, { price: eurPlan.publicId }],
    customer_id: app2.publicId,
  });
  ok(
    "create known: items in two currencies → 400",
    mixed.statusCode === 400 && /one currency/.test(String(body(mixed).error?.message)),
  );
  const noCus = body(await mint({ price: planPrice.publicId })) as { token: string };
  ok(
    "create: without customer_id the page is not pinned, as before",
    body(await call("/checkout/v1/session", noCus.token)).customer_pinned === false,
  );

  // One live subscription per customer bills a meter: refused at mint, before the buyer pays.
  const meter = await createTestMeter({ organizationId: orgId, businessId: biz.id });
  const usage = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: plan.id,
    type: "recurring",
    model: "usage",
    currency: "USD",
    interval: "month",
    meter: meter.key,
    unitAmountDecimal: "5",
  });
  await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: app2.id,
    now: new Date(),
    items: [
      { price: planPrice, quantity: 1 },
      { price: usage, quantity: 1 },
    ],
    autoCollection: "off",
  });
  const twice = await mint({
    items: [{ price: planPrice.publicId }, { price: usage.publicId }],
    customer_id: app2.publicId,
  });
  ok(
    "create known: a live subscription already bills the meter → 409",
    twice.statusCode === 409 && /already bills the meter/.test(String(body(twice).error?.message)),
  );
}

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
// The invoice names the `pay_…` the refund route takes, so an API client needs no other read.
const invoiceApi = async (id: string) =>
  body(
    await app.inject({
      method: "GET",
      url: `/v1/businesses/${biz.publicId}/invoices/${id}`,
      headers: { authorization: `Bearer ${org.secret}` },
    }),
  ) as { linked_payments: Array<{ type: string; status: string; payment: string | null }> };
const kLinked = (await invoiceApi(kInv!.publicId)).linked_payments.find(
  (t) => t.type === "payment" && t.status === "succeeded",
);
ok(
  "refund: linked_payments[].payment is the payment's pay_ id",
  kLinked?.payment === kPay!.publicId && kPay!.publicId.startsWith("pay_"),
);
const refundRes = await app.inject({
  method: "POST",
  url: `/v1/businesses/${biz.publicId}/payments/${kLinked?.payment}/refund`,
  headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": crypto.randomUUID() },
  payload: { amount_minor: 500 },
});
ok("refund: that id refunds through the API (201)", refundRes.statusCode === 201);
ok(
  "refund: the refund's linked payment names the payment it reverses",
  (await invoiceApi(kInv!.publicId)).linked_payments.some(
    (t) => t.type === "refund" && t.payment === kPay!.publicId,
  ),
);
const afterRefund = await listCustomerPurchases({
  organizationId: orgId,
  businessId: biz.id,
  customerId: known.id,
  limit: 10,
});
ok("portal: a refund shows on the purchase", afterRefund.data[0]!.refundedMinor === 500);

// ── Coupons on a purchase ─────────────────────────────────────────────────────
{
  await setSave("ask");
  const cctx = { organizationId: orgId, businessId: biz.id };
  const other = await createProduct({ ...cctx, name: "Other charge", kind: "charge" });
  await createCoupon({ ...cctx, code: "PUR20", kind: "percentage", percentOffBps: 2000 });
  await createCoupon({
    ...cctx,
    code: "PURFIX5",
    kind: "fixed_amount",
    amountOffMinor: 500,
    currency: "USD",
    durationType: "forever",
  });
  await createCoupon({
    ...cctx,
    code: "PUREUR",
    kind: "fixed_amount",
    amountOffMinor: 500,
    currency: "EUR",
  });
  await createCoupon({
    ...cctx,
    code: "PACKONLY",
    kind: "percentage",
    percentOffBps: 5000,
    applyOn: "each_specified_item",
    itemConstraints: [
      { itemKind: "charge", constraintType: "specific", productIds: [pack.publicId] },
    ],
  });
  await createCoupon({
    ...cctx,
    code: "OTHERONLY",
    kind: "percentage",
    percentOffBps: 5000,
    applyOn: "each_specified_item",
    itemConstraints: [
      { itemKind: "charge", constraintType: "specific", productIds: [other.publicId] },
    ],
  });
  await createCoupon({ ...cctx, code: "FREE100", kind: "percentage", percentOffBps: 10000 });
  await createCoupon({ ...cctx, code: "BUYER10", kind: "percentage", percentOffBps: 1000 });
  await createCoupon({
    ...cctx,
    code: "ONCEMAIL",
    kind: "percentage",
    percentOffBps: 1000,
    maxRedemptionsPerCustomer: 1,
    perCustomerLimitBy: "email",
  });
  await createCoupon({ ...cctx, code: "SETP", kind: "percentage", percentOffBps: 1000 });
  const set = await createCouponSet({ ...cctx, couponId: "SETP", name: "Purchase", count: 1 });
  const [setCode] = await withTenant(orgId, (tx) =>
    tx.select().from(couponSetCodes).where(eq(couponSetCodes.couponSetId, set.set.id)),
  );

  const couponLink = async (codes: string[], extra: object = {}) => {
    const r = await mint({ price: packPrice.publicId, mode: "purchase", coupons: codes, ...extra });
    return { status: r.statusCode, ...(body(r) as { token: string; id: string; error?: any }) };
  };
  const redemptions = (invoiceId: string) =>
    withTenant(orgId, (tx) =>
      tx.select().from(appliedCoupons).where(eq(appliedCoupons.invoiceId, invoiceId)),
    );

  // API coupon, percentage: 2500 − 20% = 2000, then 10% tax = 2200.
  const p1 = await couponLink(["PUR20"]);
  ok("coupon: a percentage coupon is accepted in purchase mode (201)", p1.status === 201);
  const p1Guest = body(await call("/checkout/v1/session", p1.token)).purchase;
  ok(
    "coupon: before the address, the view shows the discount row and the net total",
    p1Guest?.discount_minor === 500 &&
      p1Guest?.discounts?.length === 1 &&
      p1Guest.discounts[0].amount_minor === 500 &&
      p1Guest.subtotal_minor === 2500 &&
      p1Guest.total_minor === 2000 &&
      p1Guest.tax_known === false,
  );
  await call("/checkout/v1/customer", p1.token, "POST", { email: "cp1@example.com", address });
  const p1View = body(await call("/checkout/v1/session", p1.token)).purchase;
  ok(
    "coupon: after the address, tax is on the discounted amount (2200)",
    p1View?.discount_minor === 500 && p1View.tax_minor === 200 && p1View.total_minor === 2200,
  );
  const p1Done = body(await call("/checkout/v1/complete", p1.token, "POST", {}));
  const p1Inv = await invoiceRow(p1Done.invoice_id);
  const p1Red = await redemptions(p1Inv!.id);
  ok(
    "coupon: the paid invoice matches the page (2200) and holds one invoice redemption",
    p1Inv?.status === "paid" &&
      Number(p1Inv.totalMinor) === p1View.total_minor &&
      p1Red.length === 1 &&
      p1Red[0]!.scope === "invoice" &&
      p1Red[0]!.enteredByCustomer === false,
  );

  // API coupon, fixed amount: 2500 − 500 = 2000, then tax = 2200.
  const p2 = await couponLink(["PURFIX5"]);
  await call("/checkout/v1/customer", p2.token, "POST", { email: "cp2@example.com", address });
  const p2Done = body(await call("/checkout/v1/complete", p2.token, "POST", {}));
  const p2Inv = await invoiceRow(p2Done.invoice_id);
  ok(
    "coupon: a fixed coupon in the purchase currency pays 2200",
    p2Inv?.status === "paid" && Number(p2Inv.totalMinor) === 2200,
  );

  // Item match and currency, at mint.
  ok(
    "coupon: an item-scoped coupon that matches the price is accepted",
    (await couponLink(["PACKONLY"])).status === 201,
  );
  const miss = await couponLink(["OTHERONLY"]);
  ok(
    "coupon: an item-scoped coupon for another product is refused at mint (400)",
    miss.status === 400 && /applies to none of the items on this invoice/.test(miss.error?.message),
  );
  ok(
    "coupon: a fixed coupon in another currency is refused at mint (400)",
    (await couponLink(["PUREUR"])).status === 400,
  );

  // Per-email limit: a guest whose email used the code is refused at mint.
  const m1 = await couponLink(["ONCEMAIL"]);
  await call("/checkout/v1/customer", m1.token, "POST", { email: "once@example.com", address });
  ok(
    "coupon: a per-email coupon completes once",
    (await call("/checkout/v1/complete", m1.token, "POST", {})).statusCode === 201,
  );
  ok(
    "coupon: the same email is refused at mint once its limit is used (400)",
    (await couponLink(["ONCEMAIL"], { prefill: { email: "once@example.com" } })).status === 400,
  );

  // 100% off: no payment step, the invoice is paid at 0. Even when the business always saves.
  await setSave("always");
  const f = await couponLink(["FREE100"]);
  await call("/checkout/v1/customer", f.token, "POST", { email: "free@example.com", address });
  const fView = body(await call("/checkout/v1/session", f.token)).purchase;
  ok("free: the page shows nothing due", fView?.amount_due_minor === 0 && fView.total_minor === 0);
  const fDone = await call("/checkout/v1/complete", f.token, "POST", {});
  const fInv = await invoiceRow(body(fDone).invoice_id);
  const fIntents = await withTenant(orgId, (tx) =>
    tx.select().from(paymentIntents).where(eq(paymentIntents.customerId, fInv!.customerId)),
  );
  const fPays = await withTenant(orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.invoiceId, fInv!.id)),
  );
  ok(
    "free: completes with no card, the invoice is paid at 0, and nothing is charged",
    fDone.statusCode === 201 &&
      fInv?.status === "paid" &&
      Number(fInv.totalMinor) === 0 &&
      fIntents.length === 0 &&
      fPays.length === 0,
  );

  // A declined payment voids the invoice and gives the single-use code back.
  const parentCount = async () =>
    withTenant(orgId, (tx) =>
      tx.select({ n: coupons.timesRedeemed }).from(coupons).where(eq(coupons.code, "SETP")),
    ).then((r) => r[0]?.n);
  const codeRow = async () =>
    withTenant(orgId, (tx) =>
      tx.select().from(couponSetCodes).where(eq(couponSetCodes.id, setCode!.id)),
    ).then((r) => r[0]);
  const dl = await couponLink([setCode!.code]);
  ok("decline: a coupon-set code is accepted at mint", dl.status === 201);
  await call("/checkout/v1/customer", dl.token, "POST", { email: "dl@example.com", address });
  const dlRes = await call("/checkout/v1/complete", dl.token, "POST", {
    token: "tok_4000000000002008",
  });
  const [dlSess] = await withTenant(orgId, (tx) =>
    tx.select().from(checkoutSessions).where(eq(checkoutSessions.publicId, dl.id)),
  );
  const dlInvoices = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.customerId, dlSess!.resultingCustomerId!)),
  );
  const dlRed = dlInvoices.length ? await redemptions(dlInvoices[0]!.id) : [];
  const freed = await codeRow();
  ok(
    "decline: the invoice is voided and its redemption released",
    dlRes.statusCode === 400 &&
      dlInvoices.length === 1 &&
      dlInvoices[0]!.status === "voided" &&
      dlRed.length === 1 &&
      dlRed[0]!.status === "released",
  );
  ok(
    "decline: the set code is redeemable again and the count is back to 0",
    freed?.status === "not_redeemed" && (await parentCount()) === 0,
  );
  const dlRetry = await call("/checkout/v1/complete", dl.token, "POST", { token: "tok_4242" });
  const dlInv = await invoiceRow(body(dlRetry).invoice_id);
  ok(
    "decline: a retry with a good card redeems the same code (2475)",
    dlRetry.statusCode === 201 &&
      dlInv?.status === "paid" &&
      Number(dlInv.totalMinor) === 2475 &&
      (await codeRow())?.status === "redeemed" &&
      (await parentCount()) === 1,
  );

  // 3-D Secure: a code refused on the return leg releases the authorised payment.
  await createCoupon({ ...cctx, code: "GONE10", kind: "percentage", percentOffBps: 1000 });
  const gn = await couponLink(["GONE10"]);
  await call("/checkout/v1/customer", gn.token, "POST", { email: "gone@example.com", address });
  const gnLeg1 = await call("/checkout/v1/complete", gn.token, "POST", { token: CHALLENGE });
  const gnPi = body(gnLeg1).payment_intent?.id as string;
  await authorizePaymentIntent(orgId, biz.id, gnPi);
  await withTenant(orgId, (tx) =>
    tx.update(coupons).set({ active: false }).where(eq(coupons.code, "GONE10")),
  );
  const gnLeg2 = await call("/checkout/v1/complete", gn.token, "POST", {
    token: CHALLENGE,
    payment_intent: gnPi,
  });
  const [gnRow] = await withTenant(orgId, (tx) =>
    tx.select().from(paymentIntents).where(eq(paymentIntents.publicId, gnPi)),
  );
  const gnInvoices = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(invoices)
      .where(eq(invoices.customerId, gnRow?.customerId ?? crypto.randomUUID())),
  );
  ok(
    "3ds: a coupon refused on leg 2 refuses (400), voids the authorised intent, raises nothing",
    gnLeg1.statusCode === 402 &&
      gnLeg2.statusCode === 400 &&
      gnRow?.status === "voided" &&
      gnInvoices.every((i) => i.status === "voided"),
  );

  // The buyer's own codes, under the business cap.
  await setSave("ask");
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({ allowCustomerCoupons: true, maxCustomerCouponCodes: 1 })
      .where(eq(businesses.id, biz.id)),
  );
  const by = await purchaseLink();
  ok(
    "buyer: the coupon box shows when the business allows it",
    body(await call("/checkout/v1/session", by.token)).allow_coupons === true,
  );
  const typedOther = await call("/checkout/v1/coupon", by.token, "POST", { code: "OTHERONLY" });
  ok("buyer: a code for another product is refused (400)", typedOther.statusCode === 400);
  const typed = await call("/checkout/v1/coupon", by.token, "POST", { code: "BUYER10" });
  ok(
    "buyer: a typed code re-prices the purchase (2500 − 250)",
    typed.statusCode === 200 && body(typed).purchase?.total_minor === 2250,
  );
  const second = await call("/checkout/v1/coupon", by.token, "POST", { code: "PUR20" });
  ok("buyer: a second typed code is refused at a cap of 1 (400)", second.statusCode === 400);
  await call("/checkout/v1/customer", by.token, "POST", { email: "by@example.com", address });
  const byInv = await invoiceRow(
    body(await call("/checkout/v1/complete", by.token, "POST", {})).invoice_id,
  );
  const byRed = await redemptions(byInv!.id);
  ok(
    "buyer: the invoice is paid at 2475 and the redemption is marked as the buyer's",
    byInv?.status === "paid" &&
      Number(byInv.totalMinor) === 2475 &&
      byRed.length === 1 &&
      byRed[0]!.enteredByCustomer === true,
  );

  // An API code and a typed code together: each redemption keeps who entered it.
  const mx = await couponLink(["PUR20"]);
  await call("/checkout/v1/coupon", mx.token, "POST", { code: "BUYER10" });
  await call("/checkout/v1/customer", mx.token, "POST", { email: "mx@example.com", address });
  const mxView = body(await call("/checkout/v1/session", mx.token)).purchase;
  const mxInv = await invoiceRow(
    body(await call("/checkout/v1/complete", mx.token, "POST", {})).invoice_id,
  );
  const mxRed = await redemptions(mxInv!.id);
  const pur20 = await withTenant(orgId, (tx) =>
    tx.select().from(coupons).where(eq(coupons.code, "PUR20")),
  ).then((r) => r[0]!);
  ok(
    "mixed: two discount rows, and the invoice matches the page",
    mxView?.discounts?.length === 2 && Number(mxInv?.totalMinor) === mxView.total_minor,
  );
  ok(
    "mixed: the API code is the operator's, the typed code the buyer's",
    mxRed.length === 2 && mxRed.every((r) => r.enteredByCustomer === (r.couponId !== pur20.id)),
  );
  await withTenant(orgId, (tx) =>
    tx.update(businesses).set({ allowCustomerCoupons: false }).where(eq(businesses.id, biz.id)),
  );

  // POST /invoices with coupons.
  const invPost = (payload: object) =>
    app.inject({
      method: "POST",
      url: `/v1/businesses/${biz.publicId}/invoices`,
      headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": crypto.randomUUID() },
      payload: { customer: known.publicId, lines: [{ price: packPrice.publicId }], ...payload },
    });
  const ip = await invPost({ coupons: ["PUR20"] });
  ok(
    "invoices: POST with a coupon raises the discounted invoice (2000)",
    ip.statusCode === 201 && body(ip).total_minor === 2000,
  );
  const ipEur = await invPost({ coupons: ["PUREUR"] });
  ok("invoices: a coupon in another currency is refused (400)", ipEur.statusCode === 400);
  const ipNone = await invPost({ coupons: ["NOPE"] });
  ok("invoices: an unknown code is refused (400)", ipNone.statusCode === 400);
  const ipMeta = await invPost({ metadata: { order_id: "ord_2001" } });
  ok(
    "invoices: POST stores metadata on the invoice and returns it",
    ipMeta.statusCode === 201 && body(ipMeta).metadata?.order_id === "ord_2001",
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
await app.close();
await closeDb();
process.exit(fail ? 1 : 0);

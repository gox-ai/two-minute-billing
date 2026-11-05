/**
 * Proves the hosted-checkout flow (#10d), offline + DB-backed:
 *  - an operator mints a price-scoped checkout session (cstk_ token, cosess_ id)
 *  - the token resolves NON-tenant → context (org/business/price/quantity)
 *  - setCheckoutCustomer always creates a fresh customer (public link → no email reuse)
 *  - completeCheckout vaults a test card (tok_4242 on the tmtest gateway) and
 *    creates a subscription for the session's price + quantity as default pm
 *  - the session is marked completed with the resulting subscription recorded
 *  - a second completeCheckout is idempotent (same ids, no new subscription)
 *
 * Then CHANGE mode (#10b) — hosted checkout for an EXISTING subscription:
 *  - mint validation (change needs a target; create rejects one; unknown /
 *    cancelled / currency-mismatched targets rejected)
 *  - the customer is PINNED to the subscription's owner at mint, and
 *    setCheckoutCustomer is refused (a public link must not repoint it)
 *  - the view carries the current plan, a proration preview, and card-on-file
 *  - completing CHANGES the existing subscription's plan (no second sub) and
 *    needs no new card when one is already vaulted
 *  - create mode still requires a card token
 *
 * PORTAL_BASE_URL is set by the pnpm script so the mint returns a usable url.
 *
 *   pnpm verify:checkout
 */
import { readFileSync } from "node:fs";
import { eq, and, inArray, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { config } from "@/platform/config";
import { withTenant, closeDb, systemDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount, updateGatewayAccount } from "@/modules/gateway/service";
import { GatewayRouterError, selectGatewayAccount } from "@/modules/gateway/router";
import {
  createProduct,
  createPrice,
  setDifferentialPrice,
  updatePrice,
} from "@/modules/catalog/service";
import { formatMoney } from "@/platform/currency";
import { addSubscriptionItem } from "@/modules/subscriptions/items";
import { createFlatTaxRate } from "@/modules/tax/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import {
  createCheckoutSession,
  resolveCheckoutSession,
  getCheckoutView,
  setCheckoutCustomer,
  updateCheckoutCustomerDetails,
  completeCheckout,
  readCheckoutInvoiceState,
  getCheckoutSession,
  addCheckoutCoupon,
  removeCheckoutCoupon,
} from "@/modules/checkout/service";
import { createCoupon } from "@/modules/coupons/service";
import { createCustomer } from "@/modules/customers/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { createDefinition } from "@/modules/custom-fields/service";
import { createPortalSession, resolvePortalSession } from "@/modules/customer-portal/service";
import { createPaymentIntent } from "@/modules/payment-intents/service";
import { beginVaultSetup } from "@/api/vault-setup";
import { getCustomerById } from "@/modules/customers/service";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";
import type { CreateIntentInput, IntentRef } from "@/providers/types";
import { PAYER_SAFE_INTERNAL_FAILURE } from "@/providers/decline-codes";
import { TmtestProvider } from "@/providers/tmtest";
import {
  listVaultGatewaysForBusiness,
  vaultPaymentMethod,
  setPaymentMethodStatus,
} from "@/modules/payment-methods/service";
import {
  subscriptions,
  customers,
  subscriptionItems,
  prices,
  products,
  invoices,
  payments,
  paymentMethods,
  appliedCoupons,
  events,
  checkoutSessions,
  businesses,
  transactions,
  paymentIntents,
  customerAddresses,
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

const org = await createOrganization({ name: "Checkout Co" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Acme Reports",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "Asia/Kolkata",
});
await createGatewayAccount({
  organizationId: orgId,
  businessId: biz.id,
  gatewayKey: "tmtest",
  label: "TM Test",
  credentials: {},
});
const product = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Pro Plan",
});
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 5000,
  interval: "month",
});

// ── Mint ─────────────────────────────────────────────────────────────────────
const session = await createCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  priceId: price.publicId,
  quantity: 1,
});
ok("mint returns cstk_ token", session.token.startsWith("cstk_"));
ok("mint returns cosess_ public id", session.publicId.startsWith("cosess_"));
/**
 * Composed from the CONFIGURED base, never a literal.
 *
 * This used to assert `https://portal.test/checkout/…`, so it was red on any machine
 * whose `.env` said anything else (locally `http://localhost:4100`) — it tested the
 * runner's environment instead of the code, and a suite that is red for a reason nobody
 * can act on is a suite people learn to ignore. The behaviour actually worth pinning is
 * what `createCheckoutSession` DOES with the base: strip one trailing slash, and omit
 * `url` entirely when there is no base to build it from.
 */
const configuredBase = config.PORTAL_BASE_URL?.replace(/\/$/, "");
// `/checkout/s/<token>` is the EXCHANGE route, not the checkout page (W1): it moves
// the token into an HttpOnly cookie and redirects to a clean `/checkout`, so the card
// step — which injects a gateway SDK from a third-party host — never puts a credential
// in a `Referer`. Handing out the page URL directly would undo that.
ok(
  "mint composes the /checkout/s/ exchange url from PORTAL_BASE_URL",
  configuredBase
    ? session.url === `${configuredBase}/checkout/s/${session.token}`
    : session.url === undefined,
);

// The two branches of that composition, driven rather than assumed. `config` is a plain
// parsed object, so the suite can stand in a base and put the real one back.
const savedPortalBase = config.PORTAL_BASE_URL;
const mutableConfig = config as { PORTAL_BASE_URL?: string };
try {
  mutableConfig.PORTAL_BASE_URL = "https://portal.test/";
  const slashSession = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    priceId: price.publicId,
    quantity: 1,
  });
  ok(
    "a trailing slash on PORTAL_BASE_URL does not double up in the url",
    slashSession.url === `https://portal.test/checkout/s/${slashSession.token}`,
  );
  mutableConfig.PORTAL_BASE_URL = undefined;
  const baselessSession = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    priceId: price.publicId,
    quantity: 1,
  });
  ok(
    "no PORTAL_BASE_URL ⇒ no url field at all (never a half-formed link)",
    baselessSession.url === undefined && baselessSession.token.startsWith("cstk_"),
  );
} finally {
  mutableConfig.PORTAL_BASE_URL = savedPortalBase;
}

// ── Resolve (non-tenant) ──────────────────────────────────────────────────────
const ctx = await resolveCheckoutSession(session.token);
ok("token resolves to a context", ctx != null);
ok("context carries the org/business", ctx?.organizationId === orgId && ctx?.businessId === biz.id);
ok("context resolves the internal price id", ctx?.items[0]?.priceId === price.id);
ok("context status is open", ctx?.status === "open");
ok("unknown token → null", (await resolveCheckoutSession("cstk_nope")) === null);

// ── View ──────────────────────────────────────────────────────────────────────
const view = await getCheckoutView(ctx!);
ok("view has the business name", view?.business.name === "Acme Reports");
// The buyer surface has no BusinessTzProvider, so the ZONE has to travel in the
// payload — without it the renewal date in the change preview rendered in UTC and
// could read a day off the one the operator sees. Asserted here because a serializer
// field with no gate is exactly what went missing the first time.
ok(
  "view carries the business timezone for buyer-facing dates",
  view?.business.timezone === "Asia/Kolkata",
);
ok("view summarizes the price amount", view?.items[0]?.amount === "$50.00 / month");
// Absent, not an empty object: a create-mode session has no customer until the details
// step is submitted, and there is nothing to prefill. The form must be able to tell
// "nothing on file" from "a record with blank fields".
ok("view carries no customer before the session has one", view?.customer === undefined);

// ── Customer (create) ──────────────────────────────────────────────────────────
const cust1 = await setCheckoutCustomer(ctx!, {
  email: "Buyer@Example.com",
  address: { line1: "1 Main St", country: "US", firstName: "Bea", lastName: "Buyer" },
});
ok("customer created", cust1.publicId.startsWith("cus_"));
ok("resulting customer stored on session ctx", ctx?.resultingCustomerId === cust1.id);

/**
 * PREFILL — a gate, not a nicety, because the details step is DESTRUCTIVE without it.
 *
 * `POST /checkout/v1/customer` replaces the address (`applyAddress` nulls every column it
 * is not given), and the storefront's form is reachable a second time through the card
 * step's "Edit billing details". Rendered blank, a buyer who fills only the required
 * fields silently wipes their company, address lines 2/3, state, last name and tax
 * registration number — the last of which is an Indian B2B buyer's GSTIN, and its absence
 * costs them the input tax credit on every later invoice. The view is the only thing that
 * lets the form show what it is about to overwrite.
 */
const seededView = await getCheckoutView(ctx!);
ok(
  "create mode: the view prefills the address the session just wrote",
  seededView?.customer?.address?.line1 === "1 Main St" &&
    seededView?.customer?.address?.country === "US" &&
    seededView?.customer?.address?.first_name === "Bea",
);
ok("…and the email, which create mode alone may edit", seededView?.customer?.email === cust1.email);

// ── Complete ────────────────────────────────────────────────────────────────────
const result = await completeCheckout(ctx!, { paymentMethodToken: "tok_4242" });
ok("complete returns a subscription id", (result.subscriptionId ?? "").startsWith("sub_"));
ok("complete returns the customer id", result.customerId === cust1.publicId);

const subsAfter = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptions).where(eq(subscriptions.customerId, cust1.id)),
);
ok("exactly one subscription created", subsAfter.length === 1);
ok("subscription uses a default payment method", subsAfter[0]?.defaultPaymentMethodId != null);

// Session marked completed with the resulting subscription recorded.
const ctxAfter = await resolveCheckoutSession(session.token);
ok("session status is completed", ctxAfter?.status === "completed");
ok("resulting subscription recorded", ctxAfter?.resultingSubscriptionId === subsAfter[0]?.id);

// ── Idempotency ──────────────────────────────────────────────────────────────────
const result2 = await completeCheckout(ctxAfter!, { paymentMethodToken: "tok_4242" });
ok(
  "second complete returns the same subscription id",
  result2.subscriptionId === result.subscriptionId,
);
ok("second complete returns the same customer id", result2.customerId === result.customerId);
const subsAfter2 = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptions).where(eq(subscriptions.customerId, cust1.id)),
);
ok("no second subscription created (idempotent)", subsAfter2.length === 1);

// SECURITY: a public checkout must NOT reuse an existing customer by email
// (enumeration / PII / grafting). A fresh session with the SAME email must mint
// a DISTINCT customer.
const session2 = await createCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  priceId: price.publicId,
});
const ctx2 = await resolveCheckoutSession(session2.token);
const cust3 = await setCheckoutCustomer(ctx2!, { email: "buyer@example.com" });
ok("same email creates a DISTINCT customer (no reuse)", cust3.id !== cust1.id);
const custRows = await withTenant(orgId, (tx) =>
  tx.select().from(customers).where(eq(customers.businessId, biz.id)),
);
ok("two distinct customer rows now exist", custRows.length === 2);

// ── A SECOND details POST updates; it does not mint another customer ─────────
// Re-posting `/checkout/v1/customer` is ordinary traffic, not an edge case: the card
// step's "Edit billing details" returns the buyer to the details step, and the
// storefront sends a fresh RANDOM Idempotency-Key per call (deliberately), so nothing
// dedupes it. This used to call createCustomer unconditionally and repoint
// `resulting_customer_id`, so every edit orphaned a row carrying the buyer's email and
// address — and a card vaulted in between stayed attached to the ORPHAN, so completing
// through the setup intent consumed an intent minted for a different customer.
{
  const editSession = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    priceId: price.publicId,
  });
  const editCtx = await resolveCheckoutSession(editSession.token);
  const firstCust = await setCheckoutCustomer(editCtx!, {
    email: "typo@exmaple.com",
    address: { line1: "9 First St", country: "US", firstName: "Ed", lastName: "Itor" },
  });
  // Vaulted BEFORE the edit — `/checkout/v1/setup` 400s until a customer exists, so this
  // is the ordinary order, and it is what made the orphan dangerous rather than untidy.
  const editPm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: firstCust,
    token: "tok_4242",
  });

  // The buyer goes back and fixes the address and the typo'd email. Re-resolved from the
  // token, exactly as the route does on every request.
  const editCtx2 = await resolveCheckoutSession(editSession.token);
  const secondCust = await setCheckoutCustomer(editCtx2!, {
    email: "fixed@example.com",
    address: { line1: "10 Second St", country: "US", firstName: "Ed", lastName: "Itor" },
  });
  ok(
    "a second details POST returns the SAME customer, not a new one",
    secondCust.id === firstCust.id,
  );
  const editRows = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(customers)
      .where(inArray(customers.email, ["typo@exmaple.com", "fixed@example.com"])),
  );
  ok("…leaving no orphan row behind", editRows.length === 1);
  ok("…with the corrected email actually written", secondCust.email === "fixed@example.com");
  ok("…and the corrected address", secondCust.addressLine1 === "10 Second St");
  const [editSessRow] = await withTenant(orgId, (tx) =>
    tx.select().from(checkoutSessions).where(eq(checkoutSessions.id, editCtx!.sessionId)),
  );
  ok(
    "…the session still points at the customer it minted",
    editSessRow?.resultingCustomerId === firstCust.id,
  );
  const [pmAfter] = await withTenant(orgId, (tx) =>
    tx.select().from(paymentMethods).where(eq(paymentMethods.id, editPm.id)),
  );
  ok(
    "…and the card vaulted before the edit is still on the checkout customer",
    pmAfter?.customerId != null && pmAfter.customerId === editSessRow?.resultingCustomerId,
  );

  // The control that keeps the guard honest — and that an always-refusing or
  // always-reusing guard would fail: the update is of the session's OWN row, never a
  // lookup by email, so a DIFFERENT link with the same email still mints a distinct
  // customer (no enumeration, no grafting onto a stranger's record).
  const otherSession = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    priceId: price.publicId,
  });
  const otherCtx = await resolveCheckoutSession(otherSession.token);
  const otherCust = await setCheckoutCustomer(otherCtx!, { email: "fixed@example.com" });
  ok(
    "a DIFFERENT session with the same email still mints a distinct customer",
    otherCust.id !== firstCust.id,
  );
}

// ═══ CHANGE MODE (#10b) — hosted checkout for an EXISTING subscription ═══════
// The buyer upgrades/downgrades the plan on a subscription they already have.
const upgradePrice = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 12900,
  interval: "month",
});
const eurPrice = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "EUR",
  amountMinor: 12900,
  interval: "month",
});
const liveSub = subsAfter[0]!;

const throws = async (label: string, fn: () => Promise<unknown>, match?: RegExp) => {
  try {
    await fn();
    ok(label, false);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ok(label, match ? match.test(msg) : true);
  }
};

// ── Mint validation ──────────────────────────────────────────────────────────
await throws(
  "mode='change' without a subscription is rejected",
  () =>
    createCheckoutSession({
      organizationId: orgId,
      businessId: biz.id,
      priceId: upgradePrice.publicId,
      mode: "change",
    }),
  /subscription is required/,
);
await throws(
  "mode='create' with a subscription is rejected",
  () =>
    createCheckoutSession({
      organizationId: orgId,
      businessId: biz.id,
      priceId: upgradePrice.publicId,
      mode: "create",
      subscriptionId: liveSub.publicId,
    }),
  /Omit subscription when mode is "create"/,
);
await throws(
  "unknown target subscription is rejected",
  () =>
    createCheckoutSession({
      organizationId: orgId,
      businessId: biz.id,
      priceId: upgradePrice.publicId,
      mode: "change",
      subscriptionId: "sub_nope",
    }),
  /No such subscription/,
);
await throws(
  "currency-mismatched target is rejected",
  () =>
    createCheckoutSession({
      organizationId: orgId,
      businessId: biz.id,
      priceId: eurPrice.publicId,
      mode: "change",
      subscriptionId: liveSub.publicId,
    }),
  /EUR price/,
);

// A cancelled subscription can't be changed (that's a reactivation) — reject at mint.
const { cancelSubscription } = await import("@/modules/subscriptions/service");
const doomedSession = await createCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  priceId: price.publicId,
});
const doomedCtx = await resolveCheckoutSession(doomedSession.token);
const doomedCust = await setCheckoutCustomer(doomedCtx!, { email: "doomed@example.com" });
await completeCheckout(doomedCtx!, { paymentMethodToken: "tok_4242" });
const [doomedSub] = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptions).where(eq(subscriptions.customerId, doomedCust.id)),
);
await cancelSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: doomedSub!.id,
  atPeriodEnd: false,
  now: new Date(),
});
await throws(
  "a cancelled target needs reactivate: true",
  () =>
    createCheckoutSession({
      organizationId: orgId,
      businessId: biz.id,
      priceId: upgradePrice.publicId,
      mode: "change",
      subscriptionId: doomedSub!.publicId,
    }),
  /pass reactivate: true/,
);

// ── Reactivation through checkout ─────────────────────────────────────────────
await throws(
  "reactivate on a live subscription is refused",
  () =>
    createCheckoutSession({
      organizationId: orgId,
      businessId: biz.id,
      mode: "change",
      subscriptionId: liveSub.publicId,
      reactivate: true,
    }),
  /applies only to a cancelled subscription/,
);
await throws(
  "reactivate_from without reactivate is refused",
  () =>
    createCheckoutSession({
      organizationId: orgId,
      businessId: biz.id,
      mode: "change",
      subscriptionId: doomedSub!.publicId,
      reactivateFrom: new Date(Date.now() - 1000),
    }),
  /needs reactivate: true/,
);
await throws(
  "reactivate_from in the future is refused",
  () =>
    createCheckoutSession({
      organizationId: orgId,
      businessId: biz.id,
      mode: "change",
      subscriptionId: doomedSub!.publicId,
      reactivate: true,
      reactivateFrom: new Date(Date.now() + 86_400_000),
    }),
  /future/,
);
await throws(
  "reactivate_from before the cancellation is refused",
  () =>
    createCheckoutSession({
      organizationId: orgId,
      businessId: biz.id,
      mode: "change",
      subscriptionId: doomedSub!.publicId,
      reactivate: true,
      reactivateFrom: new Date(Date.now() - 30 * 86_400_000),
    }),
  /before the subscription was cancelled/,
);
await throws(
  "redirect_url must be http(s)",
  () =>
    createCheckoutSession({
      organizationId: orgId,
      businessId: biz.id,
      mode: "change",
      subscriptionId: doomedSub!.publicId,
      reactivate: true,
      redirectUrl: "javascript:alert(1)",
    }),
  /http\(s\) URL/,
);

// A declined charge refuses the reactivation: cancelled again, session open for another card.
const reSession = await createCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  priceId: upgradePrice.publicId,
  mode: "change",
  subscriptionId: doomedSub!.publicId,
  reactivate: true,
  // Sent alongside reactivate by callers built for the other vendor; accepted and moot.
  resetTerm: true,
  redirectUrl: "https://example.com/billing/done",
  cancelUrl: "https://example.com/billing",
  passThruContent: '{"upgrade_flow":"winback"}',
});
const reCtx = await resolveCheckoutSession(reSession.token);
ok("reactivation context carries the flag", reCtx?.reactivate === true);
const reView = await getCheckoutView(reCtx!);
ok("reactivation view says so", reView?.change?.reactivation != null);
ok("reactivation view quotes the fresh term", (reView?.change?.preview?.amountDueMinor ?? 0) > 0);
ok("view carries redirect_url", reView?.redirect_url === "https://example.com/billing/done");
ok("view carries cancel_url", reView?.cancel_url === "https://example.com/billing");
await throws(
  "a declined reactivation charge refuses the checkout",
  () => completeCheckout(reCtx!, { paymentMethodToken: "tok_4000000000000341" }),
  /did not reactivate the subscription/,
);
const [afterDecline] = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptions).where(eq(subscriptions.id, doomedSub!.id)),
);
ok("…and the subscription is cancelled again", afterDecline?.status === "cancelled");
const [reRowAfterDecline] = await withTenant(orgId, (tx) =>
  tx.select().from(checkoutSessions).where(eq(checkoutSessions.publicId, reSession.publicId)),
);
ok("…and the session is open for another card", reRowAfterDecline?.status === "open");

// Another card: reactivated on the upgraded plan, and the invoice is the quoted figure.
const reResult = await completeCheckout(reCtx!, { paymentMethodToken: "tok_4242" });
const [reactivated] = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptions).where(eq(subscriptions.id, doomedSub!.id)),
);
ok("a reactivation checkout reactivates the subscription", reactivated?.status === "active");
ok("…with nothing left to pay", !reResult.unpaidInvoice);
const reItems = await withTenant(orgId, (tx) =>
  tx
    .select({ priceId: subscriptionItems.priceId })
    .from(subscriptionItems)
    .where(eq(subscriptionItems.subscriptionId, doomedSub!.id)),
);
ok(
  "…on the plan the session named",
  reItems.length === 1 && reItems[0]!.priceId === upgradePrice.id,
);
const reInvoices = await withTenant(orgId, (tx) =>
  tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.subscriptionId, doomedSub!.id), eq(invoices.status, "paid"))),
);
// The newest paid invoice: the subscription's original one was paid moments before.
const freshTerm = [...reInvoices].sort((a, b) => +b.createdAt - +a.createdAt)[0];
ok(
  `…billed at the figure the page quoted (quoted ${reView?.change?.preview?.totalMinor}, billed ${freshTerm?.totalMinor})`,
  freshTerm != null && Number(freshTerm.totalMinor) === reView?.change?.preview?.totalMinor,
);
const reRecord = await getCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  sessionPublicId: reSession.publicId,
});
ok("retrieve reports it completed", reRecord?.status === "completed");
ok(
  "retrieve names the reactivated subscription",
  reRecord?.resultingSubscription === doomedSub!.publicId,
);
ok(
  "retrieve returns pass_thru_content",
  reRecord?.passThruContent === '{"upgrade_flow":"winback"}',
);

// A backdated start is governed by the business's backdating policy.
await cancelSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: doomedSub!.id,
  atPeriodEnd: false,
  now: new Date(Date.now() - 5 * 86_400_000),
});
await withTenant(orgId, (tx) =>
  tx
    .update(businesses)
    .set({ backdatingConfig: { allowed_actions: ["create", "change", "cancel"] } })
    .where(eq(businesses.id, biz.id)),
);
await throws(
  "a backdated reactivation is refused when the policy leaves reactivate out",
  () =>
    createCheckoutSession({
      organizationId: orgId,
      businessId: biz.id,
      mode: "change",
      subscriptionId: doomedSub!.publicId,
      reactivate: true,
      reactivateFrom: new Date(Date.now() - 2 * 86_400_000),
    }),
  /reactivating a subscription from a past date/,
);
await withTenant(orgId, (tx) =>
  tx.update(businesses).set({ backdatingConfig: null }).where(eq(businesses.id, biz.id)),
);
const backdated = await createCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  mode: "change",
  subscriptionId: doomedSub!.publicId,
  reactivate: true,
  reactivateFrom: new Date(Date.now() - 2 * 86_400_000),
});
const backdatedCtx = await resolveCheckoutSession(backdated.token);
await completeCheckout(backdatedCtx!, {});
const [backdatedSub] = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptions).where(eq(subscriptions.id, doomedSub!.id)),
);
ok(
  "a backdated reactivation starts its term on reactivate_from's day",
  backdatedSub?.status === "active" &&
    !!backdatedSub.currentPeriodStart &&
    Math.abs(+backdatedSub.currentPeriodStart - (Date.now() - 2 * 86_400_000)) < 86_400_000,
);

// ── Mint + resolve a real change session ─────────────────────────────────────
const chg = await createCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  priceId: upgradePrice.publicId,
  mode: "change",
  subscriptionId: liveSub.publicId,
});
const chgCtx = await resolveCheckoutSession(chg.token);
ok("change session resolves", chgCtx != null);
ok("context mode is 'change'", chgCtx?.mode === "change");
ok("context carries the target subscription", chgCtx?.subscriptionId === liveSub.id);
// The customer is pinned AT MINT — the buyer never chooses it.
ok(
  "customer is pinned to the subscription owner at mint",
  chgCtx?.resultingCustomerId === cust1.id,
);

// ── View: current plan + proration preview + card-on-file ────────────────────
const chgView = await getCheckoutView(chgCtx!);
ok("view mode is 'change'", chgView?.mode === "change");
ok("view names the target subscription", chgView?.change?.subscriptionId === liveSub.publicId);
ok("view shows the CURRENT plan amount", chgView?.change?.currentPlan?.amount === "$50.00 / month");
ok("view shows the NEW plan amount", chgView?.items[0]?.amount === "$129.00 / month");
ok("view reports a card is already on file", chgView?.change?.hasPaymentMethod === true);
ok("view includes a proration preview", chgView?.change?.preview != null);
// 50.00 → 129.00 on day 0 of the term: an upgrade must cost something now.
ok("preview charges for the upgrade", (chgView?.change?.preview?.amountDueMinor ?? 0) > 0);
ok("preview is in the subscription currency", chgView?.change?.preview?.currency === "USD");
ok("preview carries line items", (chgView?.change?.preview?.lines.length ?? 0) > 0);

// ── MANDATE SIZING: the ceiling this change needs, and whether the card can carry it ──
// The defect this closes, measured 2026-08-18 and again in the audit: the ceiling was
// derived from the customer's CURRENT subscriptions, so an upgrade registered a mandate
// sized for the plan the buyer was LEAVING — and "Use a different card", the only remedy
// on offer, re-registered it just as small. A change checkout knows what it is selling.
{
  const { resolveSessionMandateRequirement } = await import("@/modules/checkout/service");
  const { withMandateHeadroom } = await import("@/modules/payment-methods/service");

  // A plain card (tmtest vaults no mandate) must make NO mandate claims: null ceiling
  // means unknown, not unlimited, and this is what keeps an international buyer clear of
  // the whole apparatus without anyone testing their country.
  const plain = await resolveSessionMandateRequirement(chgCtx!);
  ok("sizes the change even with no mandate on file", plain != null);
  ok("a card with no mandate reports no current ceiling", plain?.current === null);
  ok("and therefore never demands re-authorisation", plain?.reauthorizationRequired === false);
  // $129/month upgrade, no tax in this fixture: 12900 × MANDATE_HEADROOM_BPS (3.5× since
  // 2026-09-01, and computed rather than restated so the multiple lives in one place).
  ok(
    "ceiling is headroom over the POST-change amount",
    plain?.requiredCeilingMinor === withMandateHeadroom(12_900n),
  );
  ok("sized from the new plan, not the old $50 one", (plain?.largestDebitMinor ?? 0n) === 12_900n);

  // Now give that instrument a mandate too small for the upgrade — the shape a RazorPay
  // UPI/card mandate registered against the OLD plan actually has. The columns are what
  // `mandateRefusal` reads at debit time, so writing them is writing the real condition.
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({ mandateMaxAmountMinor: 8_000n, mandateCurrency: "USD", mandateRail: "card" })
      .where(eq(paymentMethods.customerId, cust1.id)),
  );
  const tooSmall = await resolveSessionMandateRequirement(chgCtx!);
  ok(
    "a ceiling below the change is reported as current",
    tooSmall?.current?.ceilingMinor === 8_000n,
  );
  ok("re-authorisation is REQUIRED, not advised", tooSmall?.reauthorizationRequired === true);
  ok(
    "the ceiling to re-register still covers the new plan",
    (tooSmall?.requiredCeilingMinor ?? 0n) > 12_900n,
  );

  // A mandate that already covers it must NOT force the buyer through a card step again:
  // "unless necessary" is the rule, and 20,000 > 12,900 is not necessary.
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({ mandateMaxAmountMinor: 20_000n })
      .where(eq(paymentMethods.customerId, cust1.id)),
  );
  const bigEnough = await resolveSessionMandateRequirement(chgCtx!);
  ok("a sufficient mandate demands nothing", bigEnough?.reauthorizationRequired === false);
  ok(
    "but its ceiling is still reported, so the page can say it",
    bigEnough?.current?.ceilingMinor === 20_000n,
  );

  // A mandate in ANOTHER currency cannot be compared to this amount — same rule as
  // `mandateRefusal`, which skips rather than guessing an FX rate.
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({ mandateMaxAmountMinor: 1n, mandateCurrency: "INR" })
      .where(eq(paymentMethods.customerId, cust1.id)),
  );
  const otherCurrency = await resolveSessionMandateRequirement(chgCtx!);
  ok(
    "a foreign-currency mandate is not compared",
    otherCurrency?.reauthorizationRequired === false,
  );

  // The view carries it to the buyer's page, which gates its confirm button on it.
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({ mandateMaxAmountMinor: 8_000n, mandateCurrency: "USD", mandateRail: "card" })
      .where(eq(paymentMethods.customerId, cust1.id)),
  );
  const gatedView = await getCheckoutView(chgCtx!);
  ok("the change view carries the mandate block", gatedView?.change?.mandate != null);
  ok(
    "view says re-authorisation is required",
    gatedView?.change?.mandate?.reauthorizationRequired === true,
  );
  ok(
    "view reports the ceiling in minor units, as a number",
    typeof gatedView?.change?.mandate?.requiredCeilingMinor === "number",
  );

  // Left as it was found, so the completion checks below are unaffected.
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({ mandateMaxAmountMinor: null, mandateCurrency: null, mandateRail: null })
      .where(eq(paymentMethods.customerId, cust1.id)),
  );
}

// ── SIGNUP mandates are sized from the SESSION, not from an empty subscription list ──
// The measured defect (2026-08-13): the ordinary signup order is vault-THEN-subscribe, so at
// mandate-registration time the customer has no subscriptions and `deriveMandateCeiling` fell
// straight through to its currency fallback — every INR mandate registered at ₹15,000 however
// large the plan was, and a ₹2,595 subscription was refused on its FIRST invoice. The session
// knows what it is selling before anything is vaulted.
{
  const { resolveSessionMandateRequirement } = await import("@/modules/checkout/service");
  const { withMandateHeadroom, mandateFallbackCeiling } =
    await import("@/modules/payment-methods/service");

  const signup = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    priceId: upgradePrice.publicId,
  });
  const signupCtx = await resolveCheckoutSession(signup.token);
  // BEFORE the customer exists there is nothing to size against — and nothing is claimed.
  ok(
    "a signup with no customer yet sizes nothing",
    (await resolveSessionMandateRequirement(signupCtx!)) === null,
  );

  await setCheckoutCustomer(signupCtx!, {
    email: "signup-sizing@example.com",
    address: { line1: "10 Main St", country: "US", firstName: "Sign", lastName: "Up" },
  });
  const sized = await resolveSessionMandateRequirement(signupCtx!);
  ok("a signup sizes the mandate from the session it is selling", sized != null);
  ok(
    "…off the plan being bought, not an empty subscription list",
    sized?.largestDebitMinor === 12_900n,
  );
  ok("…with headroom over it", sized?.requiredCeilingMinor === withMandateHeadroom(12_900n));
  ok(
    "…which is NOT the currency fallback that used to be registered",
    sized?.requiredCeilingMinor !== mandateFallbackCeiling("USD"),
  );
  ok(
    "…and demands no re-authorisation: there is no mandate to outgrow yet",
    sized?.reauthorizationRequired === false && sized?.current === null,
  );
  // The business's own headroom (`mandate_config.headroom_bps`), as `deriveMandateCeiling`
  // applies it. This is the ceiling every gateway receives as `maxAmountMinor` at setup
  // (RazorPay, Cashfree, PayU, Stripe, GoCardless, PayPal).
  await systemDb
    .update(businesses)
    .set({ mandateConfig: { headroom_bps: 10_000 } })
    .where(eq(businesses.id, biz.id));
  const ownHeadroom = await resolveSessionMandateRequirement(signupCtx!);
  await systemDb.update(businesses).set({ mandateConfig: null }).where(eq(businesses.id, biz.id));
  ok(
    "…with the business's own headroom when it sets one (1.0× → the debit itself)",
    ownHeadroom?.requiredCeilingMinor === 12_900n,
  );
}

// ── "MANAGE CARDS": an instrument the buyer already holds ────────────────────
// The change flow offered two doors — confirm on whatever the engine picks, or add a NEW
// card — so a buyer holding two cards, one of whose mandate cannot carry the new plan,
// could only get through by adding a third. `payment_method` on /complete is that third
// door, and because this is a PUBLIC link its ownership rule is a session invariant.
{
  const { resolveHeldPaymentMethod } = await import("@/modules/checkout/service");
  const held = await withTenant(orgId, (tx) =>
    tx.select().from(paymentMethods).where(eq(paymentMethods.customerId, cust1.id)),
  );
  const mine = held[0]!;
  ok(
    "an instrument the pinned customer holds resolves",
    (await resolveHeldPaymentMethod(chgCtx!, mine.publicId)) === mine.id,
  );

  // Another customer's instrument, on a link scoped to cust1 — `doomedCust` vaulted one
  // during the cancelled-target checks above.
  const [theirs] = await withTenant(orgId, (tx) =>
    tx.select().from(paymentMethods).where(eq(paymentMethods.customerId, doomedCust.id)),
  );
  if (theirs) {
    await throws(
      "another customer's payment method is refused on this link",
      () => resolveHeldPaymentMethod(chgCtx!, theirs.publicId),
      /No such payment method/,
    );
    // The SAME wording as a nonexistent id: a public link must not become an oracle for
    // which payment-method ids are real.
    await throws(
      "a nonexistent id answers identically (no existence oracle)",
      () => resolveHeldPaymentMethod(chgCtx!, "pm_nope"),
      /No such payment method/,
    );
  }

  // An instrument that can no longer be charged is refused HERE rather than by collection,
  // which would find out only after the change had been applied.
  await withTenant(orgId, (tx) =>
    tx.update(paymentMethods).set({ status: "invalid" }).where(eq(paymentMethods.id, mine.id)),
  );
  await throws(
    "an invalid instrument is refused before anything is billed",
    () => resolveHeldPaymentMethod(chgCtx!, mine.publicId),
    /can no longer charge that payment method/,
  );
  await withTenant(orgId, (tx) =>
    tx.update(paymentMethods).set({ status: "valid" }).where(eq(paymentMethods.id, mine.id)),
  );
}

// ── THE CARD A CHECKOUT BILLS BECOMES THE CUSTOMER'S DEFAULT ─────────────────
// A subscription default alone is not enough: another subscription, a dunning retry and an
// ad-hoc collection all resolve through the CUSTOMER's primary, so a buyer who re-authorised
// because the old ceiling was too small would have left every other path pointed at the card
// that cannot pay.
{
  const roleSession = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    priceId: price.publicId,
  });
  const roleCtx = await resolveCheckoutSession(roleSession.token);
  const roleCust = await setCheckoutCustomer(roleCtx!, {
    email: "rolepick@example.com",
    address: { line1: "13 Main St", country: "US", firstName: "Role", lastName: "Pick" },
  });
  await completeCheckout(roleCtx!, { paymentMethodToken: "tok_4242" });
  const first = await withTenant(orgId, (tx) =>
    tx.select().from(paymentMethods).where(eq(paymentMethods.customerId, roleCust.id)),
  );
  ok(
    "the only instrument a customer holds is their primary",
    first.length === 1 && first[0]?.role === "primary",
  );

  // A second checkout that adds ANOTHER instrument: it becomes primary, and the first is
  // demoted rather than deleted — a smaller mandate is still a valid backup.
  const [roleSub] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.customerId, roleCust.id)),
  );
  const roleChange = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    priceId: upgradePrice.publicId,
    mode: "change",
    subscriptionId: roleSub!.publicId,
  });
  const roleChangeCtx = await resolveCheckoutSession(roleChange.token);
  await completeCheckout(roleChangeCtx!, { paymentMethodToken: "tok_5555555555554444" });
  const after = await withTenant(orgId, (tx) =>
    tx.select().from(paymentMethods).where(eq(paymentMethods.customerId, roleCust.id)),
  );
  const primaries = after.filter((r) => r.role === "primary");
  ok("the newly added card becomes the customer default", primaries.length === 1);
  ok(
    "…and it is the NEW one, not the card that was already there",
    primaries[0]?.last4 === "4444" || primaries[0]?.id !== first[0]?.id,
  );
  ok(
    "the previous card survives as a non-primary instrument, not deleted",
    after.length === 2 && after.some((r) => r.id === first[0]?.id && r.role !== "primary"),
  );
  const [afterSub] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.id, roleSub!.id)),
  );
  ok(
    "…and the subscription points at it too",
    afterSub?.defaultPaymentMethodId === primaries[0]?.id,
  );
}

// ── SECURITY: the pinned customer is immutable on a public link ──────────────
await throws(
  "setCheckoutCustomer is refused in change mode",
  () => setCheckoutCustomer(chgCtx!, { email: "attacker@example.com" }),
  /You cannot change its customer/,
);
// The details-update door, which a change link CAN reach, must refuse the email too:
// create mode may edit the email of the customer it minted, change mode may not touch
// the identity of a customer that predates the link (it would redirect their invoices).
await throws(
  "updateCheckoutCustomerDetails refuses an email in change mode",
  () => updateCheckoutCustomerDetails(chgCtx!, { email: "attacker@example.com" }),
  /You cannot change the email of its customer/,
);
// Paired green: the details it IS allowed to edit still go through on the same session.
const chgDetails = await updateCheckoutCustomerDetails(chgCtx!, {
  address: { line1: "77 Change St", country: "US", firstName: "Bea", lastName: "Buyer" },
  taxRegistrationNumber: "29AAACT2727Q1ZW",
});
ok(
  "…while the address it IS allowed to edit still goes through",
  chgDetails.addressLine1 === "77 Change St" && chgDetails.email === cust1.email,
);
/**
 * The change link's half of the prefill, and the SECURITY line drawn through it.
 *
 * A change session's customer predates the link, so what it discloses is a real widening
 * of a public URL and is scoped deliberately: the address and tax number the form can
 * overwrite are returned, the pinned EMAIL — which that form does not render and the
 * engine refuses to change (asserted two blocks up) — is not. If the email ever starts
 * appearing here, a leaked link has begun disclosing an identity it cannot even edit.
 */
const chgPrefill = await getCheckoutView(chgCtx!);
ok(
  "change mode: the view prefills the pinned customer's address",
  chgPrefill?.customer?.address?.line1 === "77 Change St",
);
ok(
  "…and the tax registration number a blank form would have wiped",
  chgPrefill?.customer?.tax_registration_number === "29AAACT2727Q1ZW",
);
ok(
  "…but NOT the pinned email, which this link may not edit and need not read",
  chgPrefill?.customer !== undefined && chgPrefill.customer.email === undefined,
);

// ── Complete: no token needed, the card on file is reused ────────────────────
const planPriceOf = async (subId: string) => {
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({ price: prices.publicId, kind: products.kind })
      .from(subscriptionItems)
      .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
      .innerJoin(products, eq(products.id, prices.productId))
      .where(eq(subscriptionItems.subscriptionId, subId)),
  );
  return rows.find((r) => r.kind === "plan")?.price ?? null;
};
ok(
  "plan is on the ORIGINAL price before the change",
  (await planPriceOf(liveSub.id)) === price.publicId,
);

const chgResult = await completeCheckout(chgCtx!, {});
ok("change completes without a new card token", chgResult.subscriptionId === liveSub.publicId);
ok("change returns the pinned customer", chgResult.customerId === cust1.publicId);
ok(
  "plan is on the NEW price after the change",
  (await planPriceOf(liveSub.id)) === upgradePrice.publicId,
);

// The whole point: it CHANGED the sub, it did not create a second one.
const subsForCust = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptions).where(eq(subscriptions.customerId, cust1.id)),
);
ok("no second subscription was created", subsForCust.length === 1);

const chgCtxAfter = await resolveCheckoutSession(chg.token);
ok("change session is completed", chgCtxAfter?.status === "completed");
ok(
  "change session records the EXISTING subscription",
  chgCtxAfter?.resultingSubscriptionId === liveSub.id,
);

// ── Idempotent replay ───────────────────────────────────────────────────────
const chgResult2 = await completeCheckout(chgCtxAfter!, {});
ok(
  "replayed change returns the same subscription",
  chgResult2.subscriptionId === chgResult.subscriptionId,
);
const subsForCust2 = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptions).where(eq(subscriptions.customerId, cust1.id)),
);
ok("replay creates no extra subscription", subsForCust2.length === 1);

// ═══ A CHANGE INSIDE A TRIAL IS A DEFERRED CHARGE, NOT A CREDIT ══════════════
// The buyer's page reads this preview to headline the outcome, and
// `immediate_charge: false` is TRUE for two opposite things — a downgrade's credit
// and a trial change's deferred charge. Reading the flag alone (and abs()-ing the
// total) told a trialing upgrader "Credited to your balance ₹28,215.00" when
// nothing had been credited. `dueAtTrialEnd` is what disambiguates them, so the
// preview must carry it; the sign of the total must never be the evidence.
const trialPrice = await (async () => {
  const p = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Trial Plan" });
  return createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: p.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 3000,
    interval: "month",
    trialPeriod: 14,
    trialPeriodUnit: "day",
  });
})();
const trialSess = await createCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  priceId: trialPrice.publicId,
});
const trialCtx = await resolveCheckoutSession(trialSess.token);
const trialCust = await setCheckoutCustomer(trialCtx!, { email: "trialchange@example.com" });
await completeCheckout(trialCtx!, { paymentMethodToken: "tok_4242" });
const [trialSub] = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptions).where(eq(subscriptions.customerId, trialCust.id)),
);
ok("a trial-period checkout lands in_trial", trialSub?.status === "in_trial");
const trialEndBefore = trialSub!.trialEnd?.toISOString() ?? null;

const trialChg = await createCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  mode: "change",
  subscriptionId: trialSub!.publicId,
  items: [{ price: upgradePrice.publicId, quantity: 1 }],
  // A typical plan-change payload: an exhaustive list plus a term reset.
  replaceItemsList: true,
  resetTerm: true,
});
const trialChgCtx = await resolveCheckoutSession(trialChg.token);
const trialView = await getCheckoutView(trialChgCtx!);
const tPrev = trialView?.change?.preview;
ok("trial change preview is flagged due at trial end", tPrev?.dueAtTrialEnd === trialEndBefore);
ok("trial change collects NOTHING now", tPrev?.amountDueMinor === 0);
ok("trial change is not an immediate charge", tPrev?.immediateCharge === false);
// The bug in one assertion: a positive total with immediateCharge false is a
// CHARGE the buyer owes later, and must never be rendered as money received.
ok("trial change total is a positive future charge, not a credit", (tPrev?.totalMinor ?? 0) > 0);

await completeCheckout(trialChgCtx!, {});
const [trialAfter] = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptions).where(eq(subscriptions.id, trialSub!.id)),
);
ok("completing a trial change keeps the trial", trialAfter?.status === "in_trial");
ok(
  "completing a trial change does not move the trial end",
  (trialAfter?.trialEnd?.toISOString() ?? null) === trialEndBefore,
);
const trialInvs = await withTenant(orgId, (tx) =>
  tx.select().from(invoices).where(eq(invoices.subscriptionId, trialSub!.id)),
);
ok("a trial change raises no invoice", trialInvs.length === 0);

// ── create mode still REQUIRES a card ───────────────────────────────────────
const noCardSession = await createCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  priceId: price.publicId,
});
const noCardCtx = await resolveCheckoutSession(noCardSession.token);
await setCheckoutCustomer(noCardCtx!, { email: "nocard@example.com" });
await throws(
  "create mode still requires a payment method token",
  () => completeCheckout(noCardCtx!, {}),
  /payment method token is required/,
);

// ═══ FIRST-PERIOD BILLING ════════════════════════════════════════════════════
// The hosted page COLLECTS on the spot — the subscription is created by a successful
// payment. Completing a checkout must therefore leave a paid invoice,
// not an active subscription nobody was charged for.
const paidInvs = await withTenant(orgId, (tx) =>
  tx.select().from(invoices).where(eq(invoices.customerId, cust1.id)),
);
ok("completing a checkout BILLS the first period", paidInvs.length >= 1);
ok("the first invoice is paid", paidInvs[0]?.status === "paid");
const paidPays = await withTenant(orgId, (tx) =>
  tx.select().from(payments).where(eq(payments.customerId, cust1.id)),
);
ok(
  "a payment was actually taken",
  paidPays.some((p) => p.status === "succeeded"),
);
ok(
  "the charge is the plan amount (5000)",
  paidPays.some((p) => Number(p.amountMinor) === 5000),
);

// ═══ MULTI-ITEM + COUPONS (subscription_items[…] + coupon_ids[…]) ═════════════
const addonProduct = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Seats",
  kind: "addon",
});
const addonPrice = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: addonProduct.id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});
const pctCoupon = await createCoupon({
  organizationId: orgId,
  businessId: biz.id,
  code: "CHECKOUT10",
  kind: "percentage",
  percentOffBps: 1000,
  durationType: "forever",
});

// ── Mint validation for items/coupons (BOTH are validated at mint) ────────────
await throws(
  "unknown price in items is rejected at mint",
  () =>
    createCheckoutSession({
      organizationId: orgId,
      businessId: biz.id,
      items: [{ price: "price_nope" }],
    }),
  /No such price/,
);
await throws(
  "unknown coupon is rejected at mint",
  () =>
    createCheckoutSession({
      organizationId: orgId,
      businessId: biz.id,
      items: [{ price: price.publicId }],
      coupons: ["NOPE"],
    }),
  /No such coupon/,
);
await throws(
  "mixed-currency items are rejected",
  () =>
    createCheckoutSession({
      organizationId: orgId,
      businessId: biz.id,
      items: [{ price: price.publicId }, { price: eurPrice.publicId }],
    }),
  /must use one currency/,
);
await throws(
  "a duplicate price is rejected",
  () =>
    createCheckoutSession({
      organizationId: orgId,
      businessId: biz.id,
      items: [{ price: price.publicId }, { price: price.publicId }],
    }),
  /has the same item price two times/,
);
await throws(
  "an empty session is rejected",
  () => createCheckoutSession({ organizationId: orgId, businessId: biz.id }),
  /at least one item or coupon/,
);
await throws(
  "create mode with only coupons is rejected",
  () =>
    createCheckoutSession({ organizationId: orgId, businessId: biz.id, coupons: ["CHECKOUT10"] }),
  /needs at least one item/,
);

// ── CREATE with 2 items + a coupon: all billed on ONE discounted invoice ──────
const multi = await createCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  items: [{ price: price.publicId }, { price: addonPrice.publicId, quantity: 3 }],
  coupons: ["CHECKOUT10"],
});
const multiCtx = await resolveCheckoutSession(multi.token);
ok(
  "session carries BOTH items in order",
  multiCtx?.items.length === 2 && multiCtx?.items[0]?.priceId === price.id,
);
ok("session preserves the add-on quantity", multiCtx?.items[1]?.quantity === 3);
ok("session carries the coupon code", multiCtx?.couponCodes[0] === "CHECKOUT10");

const multiView = await getCheckoutView(multiCtx!);
ok("view lists both items", multiView?.items.length === 2);
ok("view marks the add-on kind", multiView?.items[1]?.kind === "addon");
ok("view surfaces the coupon", multiView?.coupons[0] === "CHECKOUT10");

// ── 0495: coupon codes a buyer can enter — default 1, merchant codes do not count ───
{
  for (const code of ["BUYERCAP-A", "BUYERCAP-B"])
    await createCoupon({
      organizationId: orgId,
      businessId: biz.id,
      code,
      kind: "percentage",
      percentOffBps: 500,
      durationType: "forever",
    });
  const capSess = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    items: [{ price: price.publicId }],
    coupons: ["CHECKOUT10"],
  });
  const ctxNow = async () => (await resolveCheckoutSession(capSess.token))!;
  const refusal = async (code: string) => {
    try {
      await addCheckoutCoupon(await ctxNow(), code);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  ok(
    "0495: a buyer code is accepted beside the merchant's code (merchant codes do not count)",
    (await refusal("BUYERCAP-A")) === null,
  );
  ok(
    "0495: a second buyer code is refused at the default cap of 1",
    (await refusal("BUYERCAP-B")) === "You can enter 1 coupon code. Remove the other code first.",
  );
  ok("0495: …and is not on the session", !(await ctxNow()).couponCodes.includes("BUYERCAP-B"));
  await removeCheckoutCoupon(await ctxNow(), "buyercap-a");
  ok("0495: removing the buyer's code frees the slot", (await refusal("BUYERCAP-B")) === null);
  await systemDb
    .update(businesses)
    .set({ maxCustomerCouponCodes: 2 })
    .where(eq(businesses.id, biz.id));
  ok(
    "0495: a merchant cap of 2 accepts a second buyer code",
    (await refusal("BUYERCAP-A")) === null,
  );
  const capCtx = await ctxNow();
  ok(
    "0495: the session holds the merchant code and both buyer codes",
    capCtx.couponCodes.length === 3 && capCtx.customerCouponCodes.length === 2,
  );
  await systemDb
    .update(businesses)
    .set({ maxCustomerCouponCodes: 1 })
    .where(eq(businesses.id, biz.id));
}

const multiCust = await setCheckoutCustomer(multiCtx!, {
  email: "multi@example.com",
  address: { line1: "2 Main St", country: "US", firstName: "Multi", lastName: "Buyer" },
});
const multiRes = await completeCheckout(multiCtx!, { paymentMethodToken: "tok_4242" });
ok("multi-item checkout completes", (multiRes.subscriptionId ?? "").startsWith("sub_"));

const multiItems = await withTenant(orgId, (tx) =>
  tx
    .select({ price: prices.publicId, qty: subscriptionItems.quantity })
    .from(subscriptionItems)
    .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
    .innerJoin(subscriptions, eq(subscriptions.id, subscriptionItems.subscriptionId))
    .where(eq(subscriptions.customerId, multiCust.id)),
);
ok("subscription has BOTH items", multiItems.length === 2);
ok(
  "add-on quantity carried to the subscription",
  multiItems.find((i) => i.price === addonPrice.publicId)?.qty === 3,
);

const multiInvs = await withTenant(orgId, (tx) =>
  tx.select().from(invoices).where(eq(invoices.customerId, multiCust.id)),
);
ok("exactly ONE invoice for the whole order", multiInvs.length === 1);
// 5000 plan + 3×1000 add-on = 8000, less 10% forever coupon = 7200.
ok("invoice totals both items MINUS the coupon (7200)", Number(multiInvs[0]?.totalMinor) === 7200);
ok("the discounted invoice is paid", multiInvs[0]?.status === "paid");

// ── CHANGE with an ADDED item + a coupon on an existing subscription ─────────
// NOTE: this uses a subscription with NO pre-existing coupon on purpose. A
// discounted subscription currently cannot be changed at all — `issueCurrentTermCredit`
// credits the LIST price while only the discounted amount was paid, so the engine
// throws "Refundable credit N exceeds refundable paid amount M". That's a
// PRE-EXISTING engine bug (reproducible with no checkout involved), tracked in
// PROGRESS — not a checkout limitation. Mixing it in here would hide it.
const plainSession = await createCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  items: [{ price: price.publicId }, { price: addonPrice.publicId, quantity: 2 }],
});
const plainCtx = await resolveCheckoutSession(plainSession.token);
const plainCust = await setCheckoutCustomer(plainCtx!, {
  email: "plain@example.com",
  address: { line1: "3 Main St", country: "US", firstName: "Plain", lastName: "Buyer" },
});
await completeCheckout(plainCtx!, { paymentMethodToken: "tok_4242" });
const upgSub = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptions).where(eq(subscriptions.customerId, plainCust.id)),
);
await createCoupon({
  organizationId: orgId,
  businessId: biz.id,
  code: "LOYAL5",
  kind: "percentage",
  percentOffBps: 500,
  durationType: "forever",
});
const seats2 = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: addonProduct.id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  amountMinor: 2500,
  interval: "month",
});
const chg2 = await createCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  mode: "change",
  subscriptionId: upgSub[0]!.publicId,
  items: [{ price: upgradePrice.publicId }, { price: seats2.publicId, quantity: 2 }],
  coupons: ["LOYAL5"],
});
const chg2Ctx = await resolveCheckoutSession(chg2.token);
const chg2View = await getCheckoutView(chg2Ctx!);
ok("change view lists all requested items", chg2View?.items.length === 2);
// The per-period figure the item list alone could never state (plan + add-ons + tax).
ok("the view quotes what each period costs", (chg2View?.nextPayment?.totalMinor ?? 0) > 0);
ok("the per-period quote names its currency", chg2View?.nextPayment?.currency === "USD");
// seats2 is NOT on the sub yet. The view used to have no preview at all for the added
// half and printed a footnote admitting it; the whole operation is priced now, so the
// guard is that the quote EXISTS and carries the addition's charge.
ok(
  "change view previews the whole operation, additions included",
  chg2View?.change?.preview != null,
);
ok(
  "the preview charges for the added item",
  (chg2View?.change?.preview?.lines ?? []).some((l) => l.amountMinor > 0),
);
ok(
  "the preview quotes a total the buyer can read",
  (chg2View?.change?.preview?.totalMinor ?? 0) > 0,
);

await completeCheckout(chg2Ctx!, {});
const after2 = await withTenant(orgId, (tx) =>
  tx
    .select({ price: prices.publicId, qty: subscriptionItems.quantity, kind: products.kind })
    .from(subscriptionItems)
    .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
    .innerJoin(products, eq(products.id, prices.productId))
    .where(eq(subscriptionItems.subscriptionId, upgSub[0]!.id)),
);
ok("plan was SWAPPED (not duplicated)", after2.filter((i) => i.kind === "plan").length === 1);
ok(
  "plan is on the upgraded price",
  after2.find((i) => i.kind === "plan")?.price === upgradePrice.publicId,
);
ok(
  "the NEW add-on was added",
  after2.some((i) => i.price === seats2.publicId && i.qty === 2),
);
ok(
  "the pre-existing add-on is untouched (upsert, not replace)",
  after2.some((i) => i.price === addonPrice.publicId),
);
const couponsOnSub = await withTenant(orgId, (tx) =>
  tx.select().from(appliedCoupons).where(eq(appliedCoupons.subscriptionId, upgSub[0]!.id)),
);
ok("the change session applied its coupon", couponsOnSub.length === 1);

// ── COUPON-ONLY change session (a valid flow) ───────────────────────────────
await createCoupon({
  organizationId: orgId,
  businessId: biz.id,
  code: "JUSTADISCOUNT",
  kind: "percentage",
  percentOffBps: 200,
  durationType: "forever",
});
const cOnly = await createCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  mode: "change",
  subscriptionId: upgSub[0]!.publicId,
  coupons: ["JUSTADISCOUNT"],
});
const cOnlyCtx = await resolveCheckoutSession(cOnly.token);
ok("coupon-only change session mints", cOnlyCtx != null);
ok("coupon-only session has no items", cOnlyCtx?.items.length === 0);
const cOnlyView = await getCheckoutView(cOnlyCtx!);
ok("coupon-only view renders with no items", cOnlyView?.items.length === 0);
const itemsBefore = (
  await withTenant(orgId, (tx) =>
    tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, upgSub[0]!.id)),
  )
).length;
await completeCheckout(cOnlyCtx!, {});
const itemsAfter = (
  await withTenant(orgId, (tx) =>
    tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, upgSub[0]!.id)),
  )
).length;
ok("coupon-only change leaves the item set alone", itemsBefore === itemsAfter);
const couponsAfter = await withTenant(orgId, (tx) =>
  tx.select().from(appliedCoupons).where(eq(appliedCoupons.subscriptionId, upgSub[0]!.id)),
);
ok("coupon-only change applied another coupon", couponsAfter.length === 2);

// ═══ REPLACE_ITEMS_LIST — the exhaustive reading of the item list ════════════
// Upsert (asserted above) cannot express removal: a buyer who deselects a
// destination add-on posts a list that merely OMITS it, and the line keeps billing.
// `replace_items_list` declares the list exhaustive, so omission means removal.
await throws("replace_items_list is refused on a create session", () =>
  createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    priceId: price.publicId,
    replaceItemsList: true,
  }),
);
await throws("replace_items_list with no items is refused (would strip every add-on)", () =>
  createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    mode: "change",
    subscriptionId: upgSub[0]!.publicId,
    coupons: ["LOYAL5"],
    replaceItemsList: true,
  }),
);

// The subscription currently carries: plan(upgradePrice) + addonPrice + seats2.
// Post an exhaustive list WITHOUT addonPrice — it must come off, and only it.
const beforeReplace = await withTenant(orgId, (tx) =>
  tx
    .select({ price: prices.publicId, kind: products.kind })
    .from(subscriptionItems)
    .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
    .innerJoin(products, eq(products.id, prices.productId))
    .where(eq(subscriptionItems.subscriptionId, upgSub[0]!.id)),
);
ok(
  "fixture: the add-on to be dropped is on the subscription",
  beforeReplace.some((i) => i.price === addonPrice.publicId),
);

const repl = await createCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  mode: "change",
  subscriptionId: upgSub[0]!.publicId,
  items: [{ price: upgradePrice.publicId }, { price: seats2.publicId, quantity: 2 }],
  replaceItemsList: true,
});
const replCtx = await resolveCheckoutSession(repl.token);
ok(
  "replace_items_list survives the round-trip through the session",
  replCtx?.replaceItemsList === true,
);
const replView = await getCheckoutView(replCtx!);
// A removal credits the buyer, and that credit is now IN the quote — it used to be
// left out with a footnote. A credit is a negative line, which is what proves it.
ok("the view previews the removal too", replView?.change?.preview != null);
ok(
  "the previewed removal credits the buyer",
  (replView?.change?.preview?.lines ?? []).some((l) => l.amountMinor < 0),
);

await completeCheckout(replCtx!, {});
const afterReplace = await withTenant(orgId, (tx) =>
  tx
    .select({ price: prices.publicId, qty: subscriptionItems.quantity, kind: products.kind })
    .from(subscriptionItems)
    .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
    .innerJoin(products, eq(products.id, prices.productId))
    .where(eq(subscriptionItems.subscriptionId, upgSub[0]!.id)),
);
ok("the omitted add-on was REMOVED", !afterReplace.some((i) => i.price === addonPrice.publicId));
ok(
  "a listed add-on survived",
  afterReplace.some((i) => i.price === seats2.publicId && i.qty === 2),
);
ok("the plan survived", afterReplace.filter((i) => i.kind === "plan").length === 1);
ok(
  "the plan is still the listed one",
  afterReplace.find((i) => i.kind === "plan")?.price === upgradePrice.publicId,
);

// The plan is never a removal candidate. Post an exhaustive list of ADD-ONS ONLY:
// under a naive "remove everything unlisted" this strips the plan and leaves a
// subscription that bills nothing.
const noPlan = await createCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  mode: "change",
  subscriptionId: upgSub[0]!.publicId,
  items: [{ price: seats2.publicId, quantity: 2 }],
  replaceItemsList: true,
});
const noPlanCtx = await resolveCheckoutSession(noPlan.token);
await completeCheckout(noPlanCtx!, {});
const afterNoPlan = await withTenant(orgId, (tx) =>
  tx
    .select({ price: prices.publicId, kind: products.kind })
    .from(subscriptionItems)
    .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
    .innerJoin(products, eq(products.id, prices.productId))
    .where(eq(subscriptionItems.subscriptionId, upgSub[0]!.id)),
);
ok(
  "an exhaustive list that omits the plan does NOT remove the plan",
  afterNoPlan.filter((i) => i.kind === "plan").length === 1,
);
ok(
  "  …and it is still the same plan",
  afterNoPlan.find((i) => i.kind === "plan")?.price === upgradePrice.publicId,
);

// ═══ DECLINED FIRST CHARGE LEAVES NOTHING ════════════════════════════════════
// The operator create route already refuses a signup whose first charge is
// declined, leaving no subscription / invoice / ledger / events. The hosted page
// must behave identically: a buyer whose card is refused must not end up with a
// cancelled subscription, a voided invoice and a phantom webhook trail — and the
// session must stay OPEN so they can try another card on the same link.
const declineSession = await createCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  priceId: price.publicId,
});
const declineCtx = await resolveCheckoutSession(declineSession.token);
const declineCust = await setCheckoutCustomer(declineCtx!, {
  email: "declined@example.com",
  address: { line1: "4 Main St", country: "US", firstName: "Dee", lastName: "Clined" },
});
const subEventsBefore = (
  await withTenant(orgId, (tx) => tx.select().from(events).where(eq(events.businessId, biz.id)))
).filter((e) => e.type.startsWith("subscription")).length;
// tok_4000000000000341 vaults fine and fails every charge — exactly the shape
// that used to leave a husk behind.
await throws(
  "a declined first charge refuses the checkout",
  () => completeCheckout(declineCtx!, { paymentMethodToken: "tok_4000000000000341" }),
  /declined/,
);
const declinedSubs = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptions).where(eq(subscriptions.customerId, declineCust.id)),
);
ok("declined checkout leaves NO subscription", declinedSubs.length === 0);
const declinedInvs = await withTenant(orgId, (tx) =>
  tx.select().from(invoices).where(eq(invoices.customerId, declineCust.id)),
);
ok("declined checkout leaves NO invoice", declinedInvs.length === 0);
const declinedPays = await withTenant(orgId, (tx) =>
  tx.select().from(payments).where(eq(payments.customerId, declineCust.id)),
);
// The refused ATTEMPT is deliberately kept (same as the operator create route):
// a failed payment with NO invoice + a payment_failed event, so the merchant can
// see why the signup was refused. Nothing else survives.
ok(
  "declined checkout keeps only the failed attempt (no invoice attached)",
  declinedPays.length === 1 &&
    declinedPays[0]?.status === "failed" &&
    declinedPays[0]?.invoiceId == null,
);
const subEventsAfter = (
  await withTenant(orgId, (tx) => tx.select().from(events).where(eq(events.businessId, biz.id)))
).filter((e) => e.type.startsWith("subscription")).length;
ok("declined checkout emits NO subscription events", subEventsAfter === subEventsBefore);
const declineCtxAfter = await resolveCheckoutSession(declineSession.token);
ok("declined checkout leaves the session OPEN for a retry", declineCtxAfter?.status === "open");
ok(
  "declined checkout records no resulting subscription",
  declineCtxAfter?.resultingSubscriptionId == null,
);
// …and the retry with a good card works on the very same link.
const retryRes = await completeCheckout(declineCtxAfter!, { paymentMethodToken: "tok_4242" });
ok(
  "the buyer can retry the same link with a good card",
  (retryRes.subscriptionId ?? "").startsWith("sub_"),
);
const retryInvs = await withTenant(orgId, (tx) =>
  tx.select().from(invoices).where(eq(invoices.customerId, declineCust.id)),
);
ok(
  "the retry bills exactly ONE paid invoice",
  retryInvs.length === 1 && retryInvs[0]?.status === "paid",
);

// ═══ AUTO-COLLECTION OFF IS INVOICED, NEVER CHARGED (OFF branch) ══════════════
// The charge-before-persist path above must be GATED on auto-collection, or a
// send-invoice buyer would be charged — and worse, a decline would delete a
// subscription that should exist with an unpaid invoice. Same contrast the
// operator create route draws: OFF ⇒ raise the invoice, collect nothing, and
// the card's behavior is irrelevant because no charge is attempted at all.
const offSession = await createCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  priceId: price.publicId,
});
const offCtx = await resolveCheckoutSession(offSession.token);
const offCust = await setCheckoutCustomer(offCtx!, {
  email: "sendinvoice@example.com",
  address: { line1: "5 Main St", country: "US", firstName: "Otto", lastName: "Off" },
});
await withTenant(orgId, (tx) =>
  tx.update(customers).set({ autoCollection: "off" }).where(eq(customers.id, offCust.id)),
);
// The very card that refused the checkout above — it must never be presented.
const offRes = await completeCheckout(offCtx!, { paymentMethodToken: "tok_4000000000000341" });
ok(
  "auto-collect-OFF checkout completes despite a would-decline card",
  (offRes.subscriptionId ?? "").startsWith("sub_"),
);
const offSubs = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptions).where(eq(subscriptions.customerId, offCust.id)),
);
ok(
  "auto-collect-OFF checkout leaves an ACTIVE subscription",
  offSubs.length === 1 && offSubs[0]?.status === "active",
);
const offInvs = await withTenant(orgId, (tx) =>
  tx.select().from(invoices).where(eq(invoices.customerId, offCust.id)),
);
ok(
  "auto-collect-OFF checkout raises exactly ONE unpaid invoice",
  offInvs.length === 1 &&
    offInvs[0]?.status !== "paid" &&
    Number(offInvs[0]?.amountDueMinor) === 5000,
);
const offPays = await withTenant(orgId, (tx) =>
  tx.select().from(payments).where(eq(payments.customerId, offCust.id)),
);
ok("auto-collect-OFF checkout attempts NO charge", offPays.length === 0);
const offCtxAfter = await resolveCheckoutSession(offSession.token);
ok("auto-collect-OFF checkout completes the session", offCtxAfter?.status === "completed");

// ── An instrument the ROUTE already vaulted (setup-intent completion) ─────────
// `/checkout/v1/complete` now resolves the card by CONSUMING the setup intent the
// checkout began (`completeVaultFromIntent`) instead of posting the provider token,
// because the gateway's webhook harvests that same intent for the buyer who never comes
// back — measured 2026-08-21 on the portal's equivalent path, both sides wrote and one
// UPI mandate became two payment methods. The service must therefore ADOPT a
// pre-vaulted instrument, and must not treat create-mode-with-no-token as an error when
// one is handed in.
const preSession = await createCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  priceId: price.publicId,
});
const preCtx = await resolveCheckoutSession(preSession.token);
const preCust = await setCheckoutCustomer(preCtx!, {
  email: "prevaulted@example.com",
  address: { line1: "9 Main St", country: "US", firstName: "Pre", lastName: "Vaulted" },
});
const preExisting = await withTenant(orgId, (tx) =>
  tx.select().from(paymentMethods).where(eq(paymentMethods.customerId, preCust.id)),
);
const prePm = await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz.id,
  customer: preCust,
  token: "tok_4242",
});
const preRes = await completeCheckout(preCtx!, { paymentMethodId: prePm.id });
ok(
  "checkout completes on an already-vaulted instrument, with no token",
  (preRes.subscriptionId ?? "").startsWith("sub_"),
);
const preSubs = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptions).where(eq(subscriptions.customerId, preCust.id)),
);
ok(
  "…and the subscription collects on THAT instrument",
  preSubs.length === 1 && preSubs[0]?.defaultPaymentMethodId === prePm.id,
);
const prePms = await withTenant(orgId, (tx) =>
  tx.select().from(paymentMethods).where(eq(paymentMethods.customerId, preCust.id)),
);
ok("…and nothing was vaulted a second time", prePms.length === preExisting.length + 1);

// ── The link's LIFETIME ──────────────────────────────────────────────────────
// Checkout is deliberately REUSABLE on a single clock, unlike the portal's single-use
// entry credential plus separate session ceiling: abandoning a checkout and coming back
// is ordinary behaviour worth real money, and this credential grants materially less
// than the portal's. That decision is documented in `CHECKOUT_SESSION_TTL_MS` and in
// `config.CHECKOUT_SESSION_TTL_HOURS` — but nothing TESTED it, so a later change could
// quietly make the link single-use, or stop enforcing expiry, and every suite stayed green.
const ttlSession = await createCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  priceId: price.publicId,
  quantity: 1,
});
const firstResolve = await resolveCheckoutSession(ttlSession.token);
const secondResolve = await resolveCheckoutSession(ttlSession.token);
ok(
  "the checkout link is REUSABLE — resolving it does not consume it",
  firstResolve !== null &&
    secondResolve !== null &&
    firstResolve.organizationId === secondResolve.organizationId,
);

ok(
  `the mint stamps the configured TTL (${config.CHECKOUT_SESSION_TTL_HOURS}h)`,
  Math.round((ttlSession.expiresAt.getTime() - Date.now()) / 3600_000) ===
    config.CHECKOUT_SESSION_TTL_HOURS,
);

// Backdate the stored clock rather than waiting the TTL out.
await withTenant(orgId, (tx) =>
  tx
    .update(checkoutSessions)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(checkoutSessions.publicId, ttlSession.publicId)),
);
ok(
  "an EXPIRED checkout link resolves to null",
  (await resolveCheckoutSession(ttlSession.token)) === null,
);

// ═══ A CHANGE WHOSE INVOICE IS NOT COLLECTED REPORTS ITSELF ══════════════════
// A change is not provisional the way a signup is: `completePlanChange` moves the items,
// raises the proration invoice and collects — and a refused collection does not throw, so
// the completion used to return plain success. Measured 2026-08-18: a customer was moved
// onto an expensive plan, the proration invoice was refused with `mandate_ceiling_exceeded`,
// MRR was updated, and the buyer's page said "Plan updated".
//
// The change checkout now blocks the MANDATE case before the buyer can confirm (step 2), so
// this exercises what remains: the API path, and any other refusal reaching the same place.
{
  const hugePrice = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 99900,
    interval: "month",
  });
  const upSession = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    priceId: price.publicId,
  });
  const upCtx = await resolveCheckoutSession(upSession.token);
  const upCust = await setCheckoutCustomer(upCtx!, {
    email: "uncollected@example.com",
    address: { line1: "11 Main St", country: "US", firstName: "Un", lastName: "Collected" },
  });
  await completeCheckout(upCtx!, { paymentMethodToken: "tok_4242" });
  const [upSub] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.customerId, upCust.id)),
  );

  // A mandate far below the upgrade's proration — the real shape of a ceiling registered
  // against the old plan. `mandateRefusal` reads these columns at debit time.
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({ mandateMaxAmountMinor: 100n, mandateCurrency: "USD", mandateRail: "card" })
      .where(eq(paymentMethods.customerId, upCust.id)),
  );

  const bigChange = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    priceId: hugePrice.publicId,
    mode: "change",
    subscriptionId: upSub!.publicId,
  });
  const bigCtx = await resolveCheckoutSession(bigChange.token);
  // A SECOND context resolved from the same token before anything completes — the loser
  // of two concurrent /complete posts, deterministically. Its `status` is still `open`,
  // so it misses the entry replay, loses the open→completing compare-and-set, and lands
  // in the CAS-loser branch. See its assertions below.
  const staleBigCtx = await resolveCheckoutSession(bigChange.token);
  const bigRes = await completeCheckout(bigCtx!, {});

  ok("the change still APPLIES — it is not provisional", bigRes.subscriptionId === upSub!.publicId);
  ok("completion reports the invoice it could not collect", bigRes.unpaidInvoice != null);
  ok(
    "…as OUTSTANDING — a refusal, not an attempt still in flight",
    bigRes.unpaidInvoice?.state === "outstanding",
  );
  ok("…with the amount still due", (bigRes.unpaidInvoice?.amountDueMinor ?? 0) > 0);
  ok("…in the subscription currency", bigRes.unpaidInvoice?.currency === "USD");
  ok(
    "…naming the reason the buyer can act on",
    bigRes.unpaidInvoice?.failure?.code === "mandate_ceiling_exceeded",
  );
  ok("…and pointing at a real invoice id", Boolean(bigRes.unpaidInvoice?.id?.startsWith("inv_")));
  const bigInvs = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.customerId, upCust.id)),
  );
  ok(
    "the reported invoice is the OPEN one, not the paid signup invoice",
    bigInvs.some((i) => i.publicId === bigRes.unpaidInvoice?.id && i.status !== "paid"),
  );

  // The contrast that makes the field meaningful: a change that DOES collect reports nothing.
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({ mandateMaxAmountMinor: null, mandateCurrency: null, mandateRail: null })
      .where(eq(paymentMethods.customerId, upCust.id)),
  );
  const okSession = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    priceId: price.publicId,
  });
  const okCtx = await resolveCheckoutSession(okSession.token);
  const okCust = await setCheckoutCustomer(okCtx!, {
    email: "collected@example.com",
    address: { line1: "12 Main St", country: "US", firstName: "Col", lastName: "Lected" },
  });
  await completeCheckout(okCtx!, { paymentMethodToken: "tok_4242" });
  const [okSub] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.customerId, okCust.id)),
  );
  const okChange = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    priceId: upgradePrice.publicId,
    mode: "change",
    subscriptionId: okSub!.publicId,
  });
  const okChangeCtx = await resolveCheckoutSession(okChange.token);
  const staleOkChangeCtx = await resolveCheckoutSession(okChange.token);
  const okRes = await completeCheckout(okChangeCtx!, {});
  ok("a change that collects reports NO unpaid invoice", okRes.unpaidInvoice == null);

  /**
   * ── A REPLAY must not turn "payment outstanding" into "you're all set" ──────
   *
   * The buyer's page believes the completion it is handed, and a second POST is an
   * ordinary thing: the redirect leg's own "Try again" is exactly that. The replay
   * branch returned the two ids and nothing else, so re-posting a change whose invoice
   * had NOT collected reported a plain success over an open invoice — the very
   * misreport `unpaidInvoice` exists to prevent, reached through a second door.
   */
  const replay = await completeCheckout(bigCtx!, {});
  ok("a replayed completion still reports the unpaid invoice", replay.unpaidInvoice != null);
  if (replay.unpaidInvoice?.id !== bigRes.unpaidInvoice?.id) {
    console.log(
      `    ↳ replay named ${replay.unpaidInvoice?.id}, first completion named ${bigRes.unpaidInvoice?.id}`,
    );
  }
  ok(
    "…the same invoice the first completion named",
    replay.unpaidInvoice?.id === bigRes.unpaidInvoice?.id,
  );
  ok("…with its state read LIVE, not remembered", replay.unpaidInvoice?.state === "outstanding");
  ok(
    "…and it is still idempotent — the same subscription, no second charge",
    replay.subscriptionId === bigRes.subscriptionId,
  );

  /**
   * ── The SECOND door into the same replay: the compare-and-set LOSER ─────────
   *
   * `completeCheckout` reaches "already completed" two ways. The entry check above is
   * one; the other is the loser of two concurrent /complete posts, which misses the
   * entry check (its context still says `open`), loses the open→completing CAS, re-reads
   * a now-`completed` row and replays from there. That branch returned the two bare ids,
   * so a double-submit — the exact traffic the CAS exists for — reported a green
   * "You're all set" over the same unpaid invoice the other door correctly reports.
   * Both doors now go through one builder, so they cannot drift again.
   */
  ok(
    "the CAS-loser context really is stale — it has not seen the completion",
    staleBigCtx?.status === "open",
  );
  const casLoser = await completeCheckout(staleBigCtx!, {});
  ok("the CAS-loser replay reports the unpaid invoice too", casLoser.unpaidInvoice != null);
  ok(
    "…the same invoice the winning completion named",
    casLoser.unpaidInvoice?.id === bigRes.unpaidInvoice?.id,
  );
  ok("…with the same state, read live", casLoser.unpaidInvoice?.state === "outstanding");
  ok(
    "…and naming the reason",
    casLoser.unpaidInvoice?.failure?.code === "mandate_ceiling_exceeded",
  );
  ok(
    "…on the same subscription, with no second one created",
    casLoser.subscriptionId === bigRes.subscriptionId,
  );
  const casSubs = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.customerId, upCust.id)),
  );
  ok("…and the CAS loser charged nothing — still one subscription", casSubs.length === 1);

  // Paired green, so a builder that ALWAYS reported an unpaid invoice would fail here:
  // the CAS loser of a change that DID collect reports success and nothing else.
  const casLoserOk = await completeCheckout(staleOkChangeCtx!, {});
  ok(
    "a CAS-loser replay of a COLLECTED change reports no unpaid invoice",
    casLoserOk.unpaidInvoice == null,
  );
  ok(
    "…and still returns the right subscription",
    casLoserOk.subscriptionId === okRes.subscriptionId,
  );
}

// ═══ AN IN-FLIGHT DEBIT IS NOT A REFUSAL ════════════════════════════════════
// An async debit — UPI Autopay, an e-mandate presentation, ACH — is answered by the
// gateway with "created, I am working on it" and settles by webhook seconds to days
// later. `collectInvoice` books that as an `in_progress` transaction and leaves the
// invoice OPEN while it waits, which is the same shape a refusal leaves behind.
//
// The completion used to read only "open, money due" and told the buyer "We could not
// collect INR 15,528.80" — for a payment nobody had refused, often seconds before it
// landed (observed on a RazorPay change checkout, 2026-08-28). The state field is what
// lets the buyer's page wait instead of accusing.
{
  const pendSession = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    priceId: price.publicId,
  });
  const pendCtx = await resolveCheckoutSession(pendSession.token);
  const pendCust = await setCheckoutCustomer(pendCtx!, {
    email: `pending+${Date.now()}@example.com`,
    address: { line1: "13 Main St", country: "US", firstName: "Pen", lastName: "Ding" },
  });
  // The `async_pending` instrument: the gateway says yes-and-waits, and deliberately
  // never settles on its own (see providers/tmtest/instruments.ts).
  await completeCheckout(pendCtx!, { paymentMethodToken: "tok_4000000000000101" });
  const [pendSub] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.customerId, pendCust.id)),
  );

  const pendChange = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    priceId: upgradePrice.publicId,
    mode: "change",
    subscriptionId: pendSub!.publicId,
  });
  const pendChangeCtx = await resolveCheckoutSession(pendChange.token);
  const pendRes = await completeCheckout(pendChangeCtx!, {});

  ok("an in-flight debit still reports the open invoice", pendRes.unpaidInvoice != null);
  ok("…as PROCESSING, not as a failed collection", pendRes.unpaidInvoice?.state === "processing");
  ok(
    "…and names NO failure, because nobody refused anything",
    pendRes.unpaidInvoice?.failure == null,
  );

  // The poll the buyer's done screen runs while it waits.
  const polled = await readCheckoutInvoiceState(pendChangeCtx!, pendRes.unpaidInvoice!.id);
  ok("the poll route reads the same state back", polled?.state === "processing");
  ok("…with the amount still due", (polled?.amountDueMinor ?? 0) > 0);

  // Ownership: a public link must not become a way to read a stranger's invoice by id.
  const allInvoices = await withTenant(orgId, (tx) => tx.select().from(invoices));
  const strangerInv = allInvoices.find((i) => i.customerId !== pendCust.id);
  ok(
    "the poll refuses an invoice belonging to another customer",
    strangerInv != null &&
      (await readCheckoutInvoiceState(pendChangeCtx!, strangerInv.publicId)) === null,
  );

  // A failure carrying OUR text (an exception, a router refusal) reaches the buyer as our
  // neutral sentence; the transaction keeps the full text for the operator.
  const invRow = allInvoices.find((i) => i.publicId === pendRes.unpaidInvoice!.id)!;
  await withTenant(orgId, (tx) =>
    tx
      .update(transactions)
      .set({
        status: "failed",
        errorCode: "gateway_error",
        errorText: "Gateway 500 — outcome unknown",
      })
      .where(eq(transactions.invoiceId, invRow.id)),
  );
  const faulted = await readCheckoutInvoiceState(pendChangeCtx!, pendRes.unpaidInvoice!.id);
  ok(
    "a gateway fault tells the buyer our sentence, not the gateway's",
    faulted?.failure?.message === PAYER_SAFE_INTERNAL_FAILURE,
  );
  ok("…under the same code", faulted?.failure?.code === "gateway_error");

  // And when the debit lands, the same poll says so — this is the transition the done
  // screen is waiting for, and it must reach `paid` rather than merely stop being open.
  await withTenant(orgId, (tx) =>
    tx
      .update(invoices)
      .set({ status: "paid", amountDueMinor: 0n })
      .where(eq(invoices.publicId, pendRes.unpaidInvoice!.id)),
  );
  const settled = await readCheckoutInvoiceState(pendChangeCtx!, pendRes.unpaidInvoice!.id);
  ok("a settled invoice polls as PAID", settled?.state === "paid");
}

// ═══ A CHECKOUT THE BUYER NEVER COMES BACK TO IS FINISHED BY THE WEBHOOK ═════
// The netbanking e-mandate rail never returns the payer: RazorPay's auth-link endpoint
// ignores `callback_url` (measured three times — see providers/razorpay.ts), so they end on
// RazorPay's own "MANDATE REGISTRATION COMPLETED" page. `harvestSetupIntent` vaults the
// instrument from the gateway's event with no browser involved, but nothing used to post
// /complete — so the buyer authorised an auto-debit and got NO subscription, and the session
// sat open until it expired. 0200 gives the session a thread back to its setup intent.
{
  const { recordCheckoutSetupIntent, completeCheckoutForSetupIntent } =
    await import("@/modules/checkout/service");
  /**
   * SALTED. `checkout_sessions.setup_payment_intent` carries a partial UNIQUE index (0200),
   * and this suite re-runs against a live database that is not truncated between runs — a
   * fixed literal here passed once and then failed with a duplicate-key error on every run
   * after it. Real ids are minted per intent, so uniqueness is right; the test has to behave
   * like a real caller.
   */
  const harvestIntentId = `pi_harvest_test_${Date.now()}`;

  const abandoned = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    priceId: price.publicId,
  });
  const abandonedCtx = await resolveCheckoutSession(abandoned.token);
  const abandonedCust = await setCheckoutCustomer(abandonedCtx!, {
    email: `abandoned+${Date.now()}@example.com`,
    address: { line1: "14 Main St", country: "US", firstName: "Aban", lastName: "Doned" },
  });
  // The instrument the gateway's webhook would have vaulted for this session.
  const harvested = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: abandonedCust,
    token: "tok_4242",
  });
  await recordCheckoutSetupIntent(abandonedCtx!, harvestIntentId);

  const before = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.customerId, abandonedCust.id)),
  );
  ok("the abandoned checkout has created nothing yet", before.length === 0);

  const outcome = await completeCheckoutForSetupIntent({
    organizationId: orgId,
    businessId: biz.id,
    intentPublicId: harvestIntentId,
    paymentMethodId: harvested.id,
  });
  ok("the webhook path completes it", outcome === "completed");
  const after = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.customerId, abandonedCust.id)),
  );
  ok("…and the subscription now exists, with no browser involved", after.length === 1);
  ok(
    "…billed to the instrument the harvest vaulted",
    after[0]?.defaultPaymentMethodId === harvested.id,
  );
  const abandonedAfter = await resolveCheckoutSession(abandoned.token);
  ok("…and the session is marked completed", abandonedAfter?.status === "completed");

  // IDEMPOTENT against the buyer who does come back, and against a redelivered event: the
  // second call must not create a second subscription.
  const second = await completeCheckoutForSetupIntent({
    organizationId: orgId,
    businessId: biz.id,
    intentPublicId: harvestIntentId,
    paymentMethodId: harvested.id,
  });
  ok("a redelivered event is skipped, not replayed", second === "skipped");
  const afterTwice = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.customerId, abandonedCust.id)),
  );
  ok("…so there is still exactly one subscription", afterTwice.length === 1);

  // An intent no session is waiting on must be a quiet no-op, not an error: most setup
  // intents come from the portal's add-card, which has no checkout to finish.
  ok(
    "a setup intent with no session behind it is a no-op",
    (await completeCheckoutForSetupIntent({
      organizationId: orgId,
      businessId: biz.id,
      intentPublicId: `pi_not_a_checkout_${Date.now()}`,
      paymentMethodId: harvested.id,
    })) === "skipped",
  );
}

// ═══ ONE BUYER ACTION, ONE `subscription_changed` ════════════════════════════
// `applyItemOperations` buffers its three legs and emits ONE summary event, because three
// identical events differing only by which internal step raised them tell a consumer
// nothing it can act on and invite it to react three times (2026-08-27). The CHECKOUT's
// coupon loop was never brought under that rule: `applyCouponToSubscription` with
// atSignup:false emits its own `subscription_changed` per coupon, so a change checkout
// carrying N coupons emitted N + 1 for one press of "Confirm change".
{
  const { createCoupon } = await import("@/modules/coupons/service");
  // Salted for the same reason as the intent id above: coupon codes are unique per business
  // and this suite shares a live database with its own previous runs.
  const eventCoupon = `EVENTCOUNT5-${Date.now()}`;
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: eventCoupon,
    kind: "percentage",
    percentOffBps: 500,
    durationType: "forever",
  });

  const evSession = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    priceId: price.publicId,
  });
  const evCtx = await resolveCheckoutSession(evSession.token);
  const evCust = await setCheckoutCustomer(evCtx!, {
    email: `eventcount+${Date.now()}@example.com`,
    address: { line1: "15 Main St", country: "US", firstName: "Ev", lastName: "Count" },
  });
  await completeCheckout(evCtx!, { paymentMethodToken: "tok_4242" });
  const [evSub] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.customerId, evCust.id)),
  );

  const changedCount = async () =>
    (
      await withTenant(orgId, (tx) =>
        tx
          .select()
          .from(events)
          .where(and(eq(events.businessId, biz.id), eq(events.type, "subscription_changed"))),
      )
    ).filter(
      (e) =>
        (e.data as { subscription?: { id?: string } })?.subscription?.id === evSub!.publicId ||
        JSON.stringify(e.data).includes(evSub!.publicId),
    ).length;

  const before = await changedCount();
  // TWO coupons AND a plan swap — the composition that multiplied the event.
  const evChange = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    priceId: upgradePrice.publicId,
    mode: "change",
    subscriptionId: evSub!.publicId,
    coupons: ["CHECKOUT10", eventCoupon],
  });
  const evChangeCtx = await resolveCheckoutSession(evChange.token);
  await completeCheckout(evChangeCtx!, {});
  const emitted = (await changedCount()) - before;

  console.log(`    subscription_changed emitted for one "Confirm change": ${emitted}`);
  ok("a change checkout with 2 coupons emits ONE subscription_changed, not three", emitted === 1);
  // The coupons themselves must still be announced — the fix suppresses the duplicated
  // SUMMARY, never the per-coupon fact.
  const couponEvents = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(events)
      .where(and(eq(events.businessId, biz.id), eq(events.type, "coupon_applied"))),
  );
  ok(
    "…and both coupon_applied events still fire",
    couponEvents.filter((e) =>
      ["CHECKOUT10", eventCoupon].some((c) => JSON.stringify(e.data).includes(c)),
    ).length >= 2,
  );

  // A coupon-only change (no item operations) must still emit exactly one: suppressing
  // every coupon's summary would trade duplicates for a MISSING event, which is worse.
  const onlySession = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    priceId: price.publicId,
  });
  const onlyCtx = await resolveCheckoutSession(onlySession.token);
  const onlyCust = await setCheckoutCustomer(onlyCtx!, {
    email: `couponsonly+${Date.now()}@example.com`,
    address: { line1: "16 Main St", country: "US", firstName: "Coup", lastName: "Only" },
  });
  await completeCheckout(onlyCtx!, { paymentMethodToken: "tok_4242" });
  const [onlySub] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.customerId, onlyCust.id)),
  );
  const onlyBefore = (
    await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(events)
        .where(and(eq(events.businessId, biz.id), eq(events.type, "subscription_changed"))),
    )
  ).filter((e) => JSON.stringify(e.data).includes(onlySub!.publicId)).length;
  const onlyChange = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    // SAME plan price the subscription already has → no item operations at all.
    priceId: price.publicId,
    mode: "change",
    subscriptionId: onlySub!.publicId,
    coupons: ["CHECKOUT10", eventCoupon],
  });
  const onlyChangeCtx = await resolveCheckoutSession(onlyChange.token);
  await completeCheckout(onlyChangeCtx!, {});
  const onlyAfter = (
    await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(events)
        .where(and(eq(events.businessId, biz.id), eq(events.type, "subscription_changed"))),
    )
  ).filter((e) => JSON.stringify(e.data).includes(onlySub!.publicId)).length;
  console.log(`    subscription_changed for a coupon-only change: ${onlyAfter - onlyBefore}`);
  ok("a coupon-ONLY change still emits exactly one (not zero)", onlyAfter - onlyBefore === 1);

  /**
   * THE ITEM LEGS, through the checkout — and then all of them at once.
   *
   * The coupon cases above only prove the coupon half. `applyItemOperations` buffers its
   * three legs (change / additions / removals) into one summary, but that is its own unit's
   * guarantee; what matters here is that the CHECKOUT still ends at one event when the legs
   * and the coupons compose, which is the shape a real "Confirm change" takes: a
   * plan-change page posts an exhaustive item list plus coupons in a single completion.
   */
  const countFor = async (subPublicId: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx
          .select()
          .from(events)
          .where(and(eq(events.businessId, biz.id), eq(events.type, "subscription_changed"))),
      )
    ).filter((e) => JSON.stringify(e.data).includes(subPublicId)).length;

  /** A fresh subscription carrying plan + one add-on, for each composition below. */
  const freshSub = async (label: string) => {
    const sess = await createCheckoutSession({
      organizationId: orgId,
      businessId: biz.id,
      items: [{ price: price.publicId }, { price: addonPrice.publicId, quantity: 2 }],
    });
    const c = await resolveCheckoutSession(sess.token);
    await setCheckoutCustomer(c!, {
      email: `${label}+${Date.now()}@example.com`,
      address: { line1: "17 Main St", country: "US", firstName: "Ev", lastName: "Item" },
    });
    await completeCheckout(c!, { paymentMethodToken: "tok_4242" });
    const [row] = await withTenant(orgId, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.customerId, c!.resultingCustomerId!)),
    );
    return row!;
  };

  // (a) ADD-ON ONLY: bump the add-on's quantity, no plan swap, no coupons. One leg, one event.
  {
    const sub = await freshSub("ev-addon");
    const before2 = await countFor(sub.publicId);
    const sess = await createCheckoutSession({
      organizationId: orgId,
      businessId: biz.id,
      mode: "change",
      subscriptionId: sub.publicId,
      items: [{ price: addonPrice.publicId, quantity: 5 }],
    });
    await completeCheckout((await resolveCheckoutSession(sess.token))!, {});
    const n = (await countFor(sub.publicId)) - before2;
    console.log(`    subscription_changed for an add-on quantity change: ${n}`);
    ok("an add-on-only change emits exactly one", n === 1);
  }

  // (b) ADD an add-on the subscription does not have — the `additions` leg on its own.
  {
    const sub = await freshSub("ev-add");
    const extra = await createPrice({
      organizationId: orgId,
      businessId: biz.id,
      productId: addonProduct.id,
      type: "recurring",
      model: "per_unit",
      currency: "USD",
      amountMinor: 700,
      interval: "month",
    });
    const before2 = await countFor(sub.publicId);
    const sess = await createCheckoutSession({
      organizationId: orgId,
      businessId: biz.id,
      mode: "change",
      subscriptionId: sub.publicId,
      items: [{ price: extra.publicId, quantity: 1 }],
    });
    await completeCheckout((await resolveCheckoutSession(sess.token))!, {});
    const n = (await countFor(sub.publicId)) - before2;
    console.log(`    subscription_changed for an add-on ADDITION: ${n}`);
    ok("adding an add-on emits exactly one", n === 1);
  }

  // (c) REMOVE an add-on — `replace_items_list` makes omission mean removal, so this is the
  //     `removals` leg on its own.
  {
    const sub = await freshSub("ev-remove");
    const before2 = await countFor(sub.publicId);
    const sess = await createCheckoutSession({
      organizationId: orgId,
      businessId: biz.id,
      mode: "change",
      subscriptionId: sub.publicId,
      items: [{ price: price.publicId }],
      replaceItemsList: true,
    });
    await completeCheckout((await resolveCheckoutSession(sess.token))!, {});
    const n = (await countFor(sub.publicId)) - before2;
    console.log(`    subscription_changed for an add-on REMOVAL: ${n}`);
    ok("removing an add-on emits exactly one", n === 1);
  }

  // (d) EVERYTHING AT ONCE — plan swap + an addition + a removal + two coupons, one
  //     completion. Five primitives that each used to announce themselves; the buyer pressed
  //     one button. This is the assertion the whole block exists for.
  {
    const sub = await freshSub("ev-all");
    const alsoNew = await createPrice({
      organizationId: orgId,
      businessId: biz.id,
      productId: addonProduct.id,
      type: "recurring",
      model: "per_unit",
      currency: "USD",
      amountMinor: 900,
      interval: "month",
    });
    const before2 = await countFor(sub.publicId);
    const sess = await createCheckoutSession({
      organizationId: orgId,
      businessId: biz.id,
      mode: "change",
      subscriptionId: sub.publicId,
      // Exhaustive: the plan moves, `alsoNew` is added, and `addonPrice` is omitted → removed.
      items: [{ price: upgradePrice.publicId }, { price: alsoNew.publicId, quantity: 3 }],
      replaceItemsList: true,
      coupons: ["CHECKOUT10", eventCoupon],
    });
    await completeCheckout((await resolveCheckoutSession(sess.token))!, {});
    const n = (await countFor(sub.publicId)) - before2;
    console.log(`    subscription_changed for plan swap + add + remove + 2 coupons: ${n}`);
    ok("a plan swap, an addition, a removal and two coupons emit exactly ONE", n === 1);
    // And the composition really did all four things — an event count of one is only
    // meaningful if the edit it summarises actually happened.
    const finalItems = await withTenant(orgId, (tx) =>
      tx
        .select({ price: prices.publicId, qty: subscriptionItems.quantity })
        .from(subscriptionItems)
        .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
        .where(eq(subscriptionItems.subscriptionId, sub.id)),
    );
    ok(
      "…the plan moved",
      finalItems.some((i) => i.price === upgradePrice.publicId),
    );
    ok(
      "…the new add-on is attached with its quantity",
      finalItems.find((i) => i.price === alsoNew.publicId)?.qty === 3,
    );
    ok(
      "…and the omitted add-on came off",
      !finalItems.some((i) => i.price === addonPrice.publicId),
    );
  }
}

// ═══ THE BUYER SURFACE'S AUTHORIZATION, AT THE ROUTE ═════════════════════════
// Everything above drives the SERVICE. That is the right level for the billing
// rules, but it cannot see the surface an attacker actually reaches: which token
// satisfies which route, what a SPENT link still reaches, and which ids a public
// body may name. Measured over `app.inject` for exactly that reason — the guards
// below live in `authenticateCheckout` and in checkout-routes.ts, not in the
// service, so no service-level assertion can hold them.
{
  const app = await buildApp({ logger: false });
  // The portal link exchange is rate-limited per IP and every suite shares 127.0.0.1.
  // One exchange happens below; see scripts/lib/rate-limit-reset.ts for the illegible
  // failure this prevents.
  await clearPublicRateLimits();

  const zOrg = await createOrganization({ name: "Checkout Authz Co" });
  const zOrgId = zOrg.organization.id;
  const zBiz = await createBusiness({
    organizationId: zOrgId,
    name: "Authz Biz",
    defaultCurrency: "USD",
    livemode: "test",
    timezone: "UTC",
  });
  const zGwa = await createGatewayAccount({
    organizationId: zOrgId,
    businessId: zBiz.id,
    gatewayKey: "tmtest",
    label: "Authz TM Test",
    credentials: {},
  });
  const zProduct = await createProduct({
    organizationId: zOrgId,
    businessId: zBiz.id,
    name: "Authz Plan",
  });
  const zPrice = await createPrice({
    organizationId: zOrgId,
    businessId: zBiz.id,
    productId: zProduct.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const zPriceUp = await createPrice({
    organizationId: zOrgId,
    businessId: zBiz.id,
    productId: zProduct.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 12_900,
    interval: "month",
  });
  // A SECOND business in the SAME organization, with its own gateway account: the
  // interesting tenancy boundary here is business-level, because the org key that minted
  // the link is authorized for both and the buyer's token is scoped to one.
  const yBiz = await createBusiness({
    organizationId: zOrgId,
    name: "Other Authz Biz",
    defaultCurrency: "USD",
    livemode: "test",
    timezone: "UTC",
  });
  const yGwa = await createGatewayAccount({
    organizationId: zOrgId,
    businessId: yBiz.id,
    gatewayKey: "tmtest",
    label: "Other TM Test",
    credentials: {},
  });

  const body = (r: { body: string }) => {
    try {
      return JSON.parse(r.body) as Record<string, any>;
    } catch {
      return {} as Record<string, any>;
    }
  };
  const call = (
    path: string,
    token: string,
    method: "GET" | "POST" = "GET",
    payload?: unknown,
    key?: string,
  ) =>
    app.inject({
      method,
      url: path,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === "POST" ? { "idempotency-key": key ?? crypto.randomUUID() } : {}),
      },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const mintLink = async (payload: object) => {
    const r = await app.inject({
      method: "POST",
      url: `/v1/businesses/${zBiz.publicId}/checkout_sessions`,
      headers: { authorization: `Bearer ${zOrg.secret}`, "idempotency-key": crypto.randomUUID() },
      payload,
    });
    return body(r) as { token: string; id: string };
  };
  const usAddress = (line1: string) => ({
    line1,
    city: "San Francisco",
    state: "California",
    state_code: "CA",
    postal_code: "94105",
    country: "US",
    first_name: "Buy",
    last_name: "Er",
  });
  const setupPayload = {
    return_url: "https://portal.test/done",
    cancel_url: "https://portal.test/back",
  };

  // ── Token namespaces, driven both ways with live credentials on both sides ───
  // The comment on `authenticateCheckout` claims all three namespaces are disjoint.
  // Nothing asserted it at the route, and a refusal proves nothing without the
  // matching acceptance — a route broken for everyone reads as perfect security.
  const isoLink = await mintLink({ price: zPrice.publicId, quantity: 1 });
  ok(
    "route: a live cstk_ token is ACCEPTED by /checkout/v1/session (200)",
    (await call("/checkout/v1/session", isoLink.token)).statusCode === 200,
  );
  ok(
    "route: the ORG KEY is refused by /checkout/v1/session (401)",
    (await call("/checkout/v1/session", zOrg.secret)).statusCode === 401,
  );

  // ── Mint prefill: details-step defaults, replaced by the buyer's own submit ───
  {
    const plainView = body(await call("/checkout/v1/session", isoLink.token));
    ok("prefill: a link minted without prefill has no view.customer", !("customer" in plainView));
    const pre = await mintLink({
      price: zPrice.publicId,
      customer: { email: "prefill@example.com", tax_registration_number: "TAX-1" },
      billing_address: { line1: "1 Prefill St", city: "Austin", state_code: "TX", country: "US" },
    });
    const preView = body(await call("/checkout/v1/session", pre.token));
    ok(
      "prefill: the view serves the mint-time email, address and tax number",
      preView.customer?.email === "prefill@example.com" &&
        preView.customer?.address?.line1 === "1 Prefill St" &&
        preView.customer?.address?.country === "US" &&
        preView.customer?.tax_registration_number === "TAX-1",
    );
    const preGet = body(
      await app.inject({
        method: "GET",
        url: `/v1/businesses/${zBiz.publicId}/checkout_sessions/${pre.id}`,
        headers: { authorization: `Bearer ${zOrg.secret}` },
      }),
    );
    ok(
      "prefill: retrieve returns customer_prefill + billing_address_prefill",
      preGet.customer_prefill?.email === "prefill@example.com" &&
        preGet.billing_address_prefill?.city === "Austin" &&
        preGet.customer === null,
    );
    const submitted = await call("/checkout/v1/customer", pre.token, "POST", {
      email: "buyer@example.com",
      address: usAddress("9 Buyer Ave"),
    });
    const afterView = body(await call("/checkout/v1/session", pre.token));
    ok(
      "prefill: the buyer's submit wins — the view now shows the customer they created",
      submitted.statusCode === 200 &&
        afterView.customer?.email === "buyer@example.com" &&
        afterView.customer?.address?.line1 === "9 Buyer Ave",
    );
    const changeWithPrefill = await app.inject({
      method: "POST",
      url: `/v1/businesses/${zBiz.publicId}/checkout_sessions`,
      headers: { authorization: `Bearer ${zOrg.secret}`, "idempotency-key": crypto.randomUUID() },
      payload: {
        mode: "change",
        subscription: "sub_XXXXXXXXXXXX01",
        customer: { email: "x@example.com" },
      },
    });
    ok("prefill: rejected on a change checkout (400)", changeWithPrefill.statusCode === 400);
    const badCountry = await app.inject({
      method: "POST",
      url: `/v1/businesses/${zBiz.publicId}/checkout_sessions`,
      headers: { authorization: `Bearer ${zOrg.secret}`, "idempotency-key": crypto.randomUUID() },
      payload: { price: zPrice.publicId, billing_address: { country: "ZZ" } },
    });
    ok("prefill: a malformed billing_address is a 400", badCountry.statusCode === 400);
  }
  ok(
    "route: a checkout token is refused by the OPERATOR api /v1/* (401)",
    (await call("/v1/businesses", isoLink.token)).statusCode === 401,
  );
  ok(
    "route: a checkout token is refused by the PORTAL /portal/v1/* (401)",
    (await call("/portal/v1/me", isoLink.token)).statusCode === 401,
  );

  const isoCustomer = await createCustomer({
    organizationId: zOrgId,
    businessId: zBiz.id,
    email: "authz-portal@acme.test",
  });
  const isoPortal = await createPortalSession({
    organizationId: zOrgId,
    businessId: zBiz.id,
    customerId: isoCustomer.id,
  });
  const exchanged = await app.inject({
    method: "POST",
    url: "/portal/v1/session",
    headers: { authorization: `Bearer ${isoPortal.accessToken}` },
  });
  const psst = (body(exchanged).token as string | undefined) ?? "";
  // The POSITIVE control for the next line: the portal token is live right now.
  ok(
    "route: the exchanged portal token WORKS on the portal (200)",
    psst.startsWith("psst_") && (await call("/portal/v1/me", psst)).statusCode === 200,
  );
  ok(
    "route: a live PORTAL session token is refused by /checkout/v1/session (401)",
    (await call("/checkout/v1/session", psst)).statusCode === 401,
  );
  // Structural rather than merely guarded: the two surfaces keep their credentials in
  // SEPARATE tables behind prefix-checked resolvers, so neither resolver can ever be
  // handed the other's row. These two lines are what would notice a "unify the session
  // tables" refactor that made confusion possible again.
  ok(
    "resolve: a portal token never resolves as a checkout session",
    (await resolveCheckoutSession(psst)) === null &&
      (await resolveCheckoutSession(isoPortal.accessToken)) === null,
  );
  ok(
    "resolve: a checkout token never resolves as a portal session",
    (await resolvePortalSession(isoLink.token)) === null,
  );

  // ── A PUBLIC BODY MAY NOT NAME ANOTHER TENANT'S GATEWAY ─────────────────────
  // `gateway_account` on /setup and /complete comes straight off a public body. It is
  // resolved through `getGatewayAccount(org, business, id)` — scoped — but nothing
  // exercised the cross-business case at the route, and a widened lookup would be
  // invisible: the buyer would simply be vaulted on a gateway belonging to another
  // business of the same organization.
  await call("/checkout/v1/customer", isoLink.token, "POST", {
    email: "authz-buyer@acme.test",
    address: usAddress("1 Real Street"),
  });
  const foreignGw = await call("/checkout/v1/setup", isoLink.token, "POST", {
    ...setupPayload,
    gateway_account: yGwa.publicId,
  });
  ok(
    "route: another BUSINESS's gateway_account is refused by /checkout/v1/setup (400)",
    foreignGw.statusCode === 400 &&
      /could not find the selected payment gateway for this business/i.test(
        String(body(foreignGw).error?.message),
      ),
  );
  const ownGw = await call("/checkout/v1/setup", isoLink.token, "POST", {
    ...setupPayload,
    gateway_account: zGwa.publicId,
  });
  ok(
    "route: …while the session's OWN gateway_account starts a setup (201)",
    ownGw.statusCode === 201,
  );

  // ── A GATEWAY'S OWN RAIL CAP: PayU UPI takes at most ₹15,000 per debit ──────
  {
    const { gatewayRailCapMinor } = await import("@/modules/checkout/service");
    ok(
      "rail cap: PayU UPI is ₹15,000 in INR; none for cards, other currencies or other gateways",
      gatewayRailCapMinor("payu", "upi", "INR") === 1_500_000n &&
        gatewayRailCapMinor("payu", "card", "INR") === null &&
        gatewayRailCapMinor("payu", "upi", "USD") === null &&
        gatewayRailCapMinor("razorpay", "upi", "INR") === null,
    );
    const inBiz = await createBusiness({
      organizationId: zOrgId,
      name: "Rail Cap Biz",
      defaultCurrency: "INR",
      livemode: "test",
      timezone: "Asia/Kolkata",
    });
    const payuGwa = await createGatewayAccount({
      organizationId: zOrgId,
      businessId: inBiz.id,
      gatewayKey: "payu",
      label: "PayU",
      credentials: { merchant_key: "key_x", merchant_salt: "salt_x" },
    });
    const inProduct = await createProduct({
      organizationId: zOrgId,
      businessId: inBiz.id,
      name: "Big",
    });
    const bigInr = await createPrice({
      organizationId: zOrgId,
      businessId: inBiz.id,
      productId: inProduct.id,
      type: "recurring",
      model: "flat",
      currency: "INR",
      amountMinor: 2_000_000,
      interval: "month",
    });
    const capSession = await createCheckoutSession({
      organizationId: zOrgId,
      businessId: inBiz.id,
      priceId: bigInr.publicId,
    });
    await call("/checkout/v1/customer", capSession.token, "POST", {
      email: "rail-cap@example.com",
      address: {
        line1: "3 Church Street",
        city: "Bengaluru",
        state_code: "KA",
        postal_code: "560001",
        country: "IN",
        first_name: "Rail",
        last_name: "Cap",
      },
    });
    const overCap = await call("/checkout/v1/setup", capSession.token, "POST", {
      ...setupPayload,
      gateway_account: payuGwa.publicId,
      method_type: "upi",
    });
    ok(
      "route: UPI on PayU for a ₹20,000 plan is refused before the gateway (400, names the ₹15,000 cap)",
      overCap.statusCode === 400 && /at most ₹15,000/.test(String(body(overCap).error?.message)),
    );
  }

  // Another customer's setup intent must not mint an instrument on this session's
  // customer. Guarded in `completeVaultFromIntent`; asserted here because the route is
  // where an untrusted `pi_…` arrives.
  const strangerCus = await createCustomer({
    organizationId: zOrgId,
    businessId: zBiz.id,
    email: "authz-stranger@acme.test",
  });
  const strangerIntent = await createPaymentIntent({
    organizationId: zOrgId,
    businessId: zBiz.id,
    purpose: "setup",
    customerPublicId: strangerCus.publicId,
    currency: "USD",
    gatewayAccountId: zGwa.publicId,
    session: "on_session",
    methodTypes: ["card"],
  });
  const stolenIntent = await call("/checkout/v1/complete", isoLink.token, "POST", {
    setup_intent: strangerIntent.intent.publicId,
  });
  ok(
    "route: another customer's setup_intent is refused by /checkout/v1/complete (400)",
    stolenIntent.statusCode === 400 &&
      /belongs to a different customer/i.test(String(body(stolenIntent).error?.message)),
  );

  // ── POSITIVE CONTROLS on an OPEN link, so the refusals below mean something ──
  const openPms = await call("/checkout/v1/payment_methods", isoLink.token);
  ok("route: an OPEN link reads its own payment methods (200)", openPms.statusCode === 200);
  ok(
    "route: an OPEN link reads its own gateways (200)",
    (await call("/checkout/v1/gateways", isoLink.token)).statusCode === 200,
  );
  const completed = await call("/checkout/v1/complete", isoLink.token, "POST", {
    token: "tok_4242",
  });
  ok("route: the checkout completes over HTTP (201)", completed.statusCode === 201);
  const doneCustomer = String(body(completed).customer_id);
  const doneSubscription = String(body(completed).subscription_id);

  // ═══ A SPENT LINK IS NOT A LIVE CHECKOUT ══════════════════════════════════
  // `resolveCheckoutSession` keeps a COMPLETED session resolvable so /complete can
  // replay its stored result — and every other route on the surface inherited that for
  // the rest of the link's TTL. Measured 2026-08-28, all against a completed session:
  // /setup answered 201 and /complete{setup_intent} then vaulted a SECOND card on the
  // real customer — which claims the PRIMARY role whenever no valid one is left, proved
  // further down; /customer rewrote a change-mode customer's
  // address and tax registration number; on a create-mode link it minted a fresh
  // customer and repointed the session at it, after which the replay answered with the
  // real buyer's sub_… under the attacker's cus_…; /payment_methods read the buyer's
  // instruments. The hosted page already treats `completed` as terminal, so the grant
  // served no client.
  const spentCustomerPost = await call("/checkout/v1/customer", isoLink.token, "POST", {
    email: "authz-attacker@evil.test",
    address: usAddress("9 Attacker Way"),
  });
  ok(
    "spent link: POST /checkout/v1/customer is refused (409)",
    spentCustomerPost.statusCode === 409,
  );
  const custRowsAfterSpent = await withTenant(zOrgId, (tx) =>
    tx
      .select({ email: customers.email })
      .from(customers)
      .where(eq(customers.email, "authz-attacker@evil.test")),
  );
  ok("spent link: …and no customer was minted by the attempt", custRowsAfterSpent.length === 0);
  const spentSess = await withTenant(zOrgId, (tx) =>
    tx.select().from(checkoutSessions).where(eq(checkoutSessions.publicId, isoLink.id)),
  );
  const spentCustomerRow = await withTenant(zOrgId, (tx) =>
    tx.select({ id: customers.id }).from(customers).where(eq(customers.publicId, doneCustomer)),
  );
  ok(
    "spent link: …and resulting_customer_id still names the buyer it billed",
    spentSess[0]?.resultingCustomerId === spentCustomerRow[0]?.id,
  );

  ok(
    "spent link: POST /checkout/v1/setup is refused (409)",
    (await call("/checkout/v1/setup", isoLink.token, "POST", setupPayload)).statusCode === 409,
  );
  ok(
    "spent link: GET /checkout/v1/payment_methods no longer reads the buyer's instruments (409)",
    (await call("/checkout/v1/payment_methods", isoLink.token)).statusCode === 409,
  );
  ok(
    "spent link: GET /checkout/v1/gateways is refused (409)",
    (await call("/checkout/v1/gateways", isoLink.token)).statusCode === 409,
  );

  // The two routes that MUST survive completion, or the fix above breaks the buyer's
  // own page: it reads `status` to render "already complete", and it polls the invoice
  // for a few seconds AFTER the completion that marked the session completed.
  const spentView = await call("/checkout/v1/session", isoLink.token);
  ok(
    "spent link: GET /checkout/v1/session still answers — the page reads that status",
    spentView.statusCode === 200 && body(spentView).status === "completed",
  );
  // …and the replay contract itself is unchanged.
  const replayed = await call("/checkout/v1/complete", isoLink.token, "POST", {});
  ok(
    "spent link: POST /checkout/v1/complete still replays the stored result (201, same ids)",
    replayed.statusCode === 201 &&
      body(replayed).subscription_id === doneSubscription &&
      body(replayed).customer_id === doneCustomer,
  );

  // The escalation itself, asserted on the state rather than on the status code: a
  // retry re-posts the body it sent the first time, so a spent /complete carrying a
  // setup_intent must SKIP the vault, not refuse the request.
  const buyerId = spentCustomerRow[0]!.id;
  const pmsBeforeReplay = await withTenant(zOrgId, (tx) =>
    tx
      .select({ id: paymentMethods.id, role: paymentMethods.role })
      .from(paymentMethods)
      .where(eq(paymentMethods.customerId, buyerId)),
  );
  // The intent the OPEN link's own /setup produced, above — i.e. exactly the body a
  // buyer's stalled card step re-posts. Reached through `beginVaultSetup` rather than
  // minted directly, because the escalation is in what CONSUMING it does: on the
  // measured defect this instrument became the customer's `role: 'primary'`, and a
  // bare `createPaymentIntent` fixture does not reproduce that promotion.
  const staleIntentId = String(body(ownGw).payment_intent);
  const replayWithIntent = await call("/checkout/v1/complete", isoLink.token, "POST", {
    setup_intent: staleIntentId,
  });
  ok(
    "spent link: a replay carrying a setup_intent still replays (201) rather than erroring",
    replayWithIntent.statusCode === 201 &&
      body(replayWithIntent).subscription_id === doneSubscription,
  );
  const pmsAfterReplay = await withTenant(zOrgId, (tx) =>
    tx
      .select({ id: paymentMethods.id, role: paymentMethods.role })
      .from(paymentMethods)
      .where(eq(paymentMethods.customerId, buyerId)),
  );
  ok(
    "spent link: …and it vaulted NOTHING on the buyer",
    pmsAfterReplay.length === pmsBeforeReplay.length,
  );

  // ── CHANGE MODE: the residual risk is bounded to a checkout IN PROGRESS ──────
  // `updateCheckoutCustomerDetails` deliberately lets whoever holds a change link edit
  // that customer's address and tax id (a gateway can demand them mid-checkout, and the
  // buyer legitimately owns them) — and its own note says so. Address is place-of-supply,
  // so it moves tax. The POSITIVE half below is that grant; the refusal is its bound.
  const chgLink = await mintLink({
    mode: "change",
    subscription: doneSubscription,
    price: zPriceUp.publicId,
    quantity: 1,
  });
  const liveEdit = await call("/checkout/v1/customer", chgLink.token, "POST", {
    email: "authz-ignored@evil.test",
    address: usAddress("2 Legitimate Road"),
    tax_registration_number: "GST-EDITED",
  });
  ok(
    "change link, OPEN: the buyer may edit their own address + tax id (200)",
    liveEdit.statusCode === 200,
  );
  const edited = await withTenant(zOrgId, (tx) =>
    tx
      .select({
        line1: customers.addressLine1,
        tax: customers.taxRegistrationNumber,
        email: customers.email,
      })
      .from(customers)
      .where(eq(customers.publicId, doneCustomer)),
  );
  ok(
    "change link, OPEN: …the edit landed",
    edited[0]?.line1 === "2 Legitimate Road" && edited[0]?.tax === "GST-EDITED",
  );
  // Identity stays pinned even while details are editable — the route never passes
  // `email` to the change-mode updater, and that is the half that could redirect an
  // invoice to an attacker's inbox.
  ok(
    "change link, OPEN: …but the EMAIL it also sent was ignored",
    edited[0]?.email === "authz-buyer@acme.test",
  );

  const chgDone = await call("/checkout/v1/complete", chgLink.token, "POST", {});
  ok("change link: the change completes over HTTP (201)", chgDone.statusCode === 201);
  const spentEdit = await call("/checkout/v1/customer", chgLink.token, "POST", {
    address: usAddress("9 Attacker Way"),
    tax_registration_number: "GST-ATTACKER",
  });
  ok("change link, SPENT: the same edit is now refused (409)", spentEdit.statusCode === 409);
  const unedited = await withTenant(zOrgId, (tx) =>
    tx
      .select({
        line1: customers.addressLine1,
        tax: customers.taxRegistrationNumber,
      })
      .from(customers)
      .where(eq(customers.publicId, doneCustomer)),
  );
  ok(
    "change link, SPENT: …and the address + tax id are untouched",
    unedited[0]?.line1 === "2 Legitimate Road" && unedited[0]?.tax === "GST-EDITED",
  );

  // ── WHAT THE EXTRA INSTRUMENT IS WORTH: THE PRIMARY ROLE ────────────────────
  // `vaultPaymentMethod` never demotes an existing primary, so the second card a spent
  // replay used to vault was usually only a spare — which is why the measurement had to
  // go one step further rather than stop at the card count. It is not a spare for a
  // customer with NO valid primary, which is the state a hard decline leaves behind:
  // dunning marks the instrument `invalid`, and that is precisely when a "your payment
  // failed" mail has put a checkout link in the buyer's inbox. The next card vaulted
  // then claims collection for every renewal, retry and ad-hoc charge.
  await withTenant(zOrgId, async (tx) => {
    for (const pm of pmsAfterReplay) await setPaymentMethodStatus(tx, zOrgId, pm.id, "invalid");
  });
  const validPrimary = () =>
    withTenant(zOrgId, (tx) =>
      tx
        .select({ id: paymentMethods.id })
        .from(paymentMethods)
        .where(
          and(
            eq(paymentMethods.customerId, buyerId),
            eq(paymentMethods.role, "primary"),
            eq(paymentMethods.status, "valid"),
          ),
        ),
    );
  ok(
    "fixture: a hard decline has left the buyer with no VALID primary",
    (await validPrimary()).length === 0,
  );
  // A SECOND setup intent, because the one above is single-use: `completeVaultFromIntent`
  // consumes it, so re-posting the same id can only ever resolve the row it already
  // names. Minted through the very function `/checkout/v1/setup` calls, so this is the
  // same animal the buyer's stalled card step would be holding.
  const freshBuyer = await getCustomerById(zOrgId, buyerId);
  const freshSetup = await beginVaultSetup({
    organizationId: zOrgId,
    businessId: zBiz.id,
    customer: freshBuyer!,
    returnUrl: setupPayload.return_url,
    cancelUrl: setupPayload.cancel_url,
    gatewayAccountId: zGwa.publicId,
    methodTypes: ["card"],
  });
  const replayAfterDecline = await call("/checkout/v1/complete", isoLink.token, "POST", {
    setup_intent: freshSetup.intent!.publicId,
  });
  ok(
    "spent link: the replay still answers with the stored result (201)",
    replayAfterDecline.statusCode === 201,
  );
  ok(
    "spent link: …and no instrument the buyer never chose has claimed collection",
    (await validPrimary()).length === 0,
  );

  // ── REPLAY on the buyer surface ─────────────────────────────────────────────
  // The buyer surface carries the `idempotency` preHandler, and on THIS route a lost
  // response is the expensive case: `setCheckoutCustomer` deliberately never reuses a
  // customer by email (a public link must not match strangers), so without replay
  // protection one retry is one extra customer row — and the second one is the row the
  // session then points at. Nothing exercised the header on this surface.
  const replayLink = await mintLink({ price: zPrice.publicId, quantity: 1 });
  const replayKey = `checkout-replay-${crypto.randomUUID()}`;
  const replayBody = { email: "authz-replay@acme.test", address: usAddress("7 Retry Lane") };
  const rFirst = await call(
    "/checkout/v1/customer",
    replayLink.token,
    "POST",
    replayBody,
    replayKey,
  );
  const rSecond = await call(
    "/checkout/v1/customer",
    replayLink.token,
    "POST",
    replayBody,
    replayKey,
  );
  ok(
    "idempotency: a replayed /checkout/v1/customer returns the SAME customer",
    rFirst.statusCode === 200 && rSecond.statusCode === 200 && body(rSecond).id === body(rFirst).id,
  );
  const replayRows = await withTenant(zOrgId, (tx) =>
    tx
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.email, "authz-replay@acme.test")),
  );
  ok("idempotency: …and the retry minted no SECOND customer row", replayRows.length === 1);
  const rConflict = await call(
    "/checkout/v1/customer",
    replayLink.token,
    "POST",
    { email: "authz-replay-other@acme.test", address: usAddress("7 Retry Lane") },
    replayKey,
  );
  ok(
    "idempotency: the same key with a different payload is refused (409)",
    rConflict.statusCode === 409 && body(rConflict).error?.type === "idempotency_error",
  );

  // ── REVOKED / EXPIRED, at the route ─────────────────────────────────────────
  // The service-level expiry assertion above proves `resolveCheckoutSession` returns
  // null. This proves the SURFACE turns that into a 401 rather than a 500 or a
  // half-authenticated request, and covers `revoked_at` at the resolver. The operator
  // route that WRITES `revoked_at` is driven in its own section below; these two lines
  // set the guard's baseline with a direct DB write, independent of that route.
  const killLink = await mintLink({ price: zPrice.publicId, quantity: 1 });
  ok(
    "route: a fresh link answers before it is killed (200)",
    (await call("/checkout/v1/session", killLink.token)).statusCode === 200,
  );
  await withTenant(zOrgId, (tx) =>
    tx
      .update(checkoutSessions)
      .set({ revokedAt: new Date() })
      .where(eq(checkoutSessions.publicId, killLink.id)),
  );
  ok(
    "route: a REVOKED link is 401 on the buyer surface",
    (await call("/checkout/v1/session", killLink.token)).statusCode === 401,
  );
  ok(
    "route: …and 401 on a mutating route too",
    (await call("/checkout/v1/customer", killLink.token, "POST", { email: "nope@evil.test" }))
      .statusCode === 401,
  );

  const expLink = await mintLink({ price: zPrice.publicId, quantity: 1 });
  await withTenant(zOrgId, (tx) =>
    tx
      .update(checkoutSessions)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(checkoutSessions.publicId, expLink.id)),
  );
  ok(
    "route: an EXPIRED link is 401 on the buyer surface",
    (await call("/checkout/v1/session", expLink.token)).statusCode === 401,
  );

  // ── THE OPERATOR'S REVOKE, AT THE ROUTE ─────────────────────────────────────
  // `POST /v1/businesses/:biz/checkout_sessions/:id/revoke` is the WRITER for
  // `revoked_at`. Until it existed the column was a guard no code path exercised, and an
  // operator whose link had leaked had no lever at all — a checkout link is public by
  // construction (minted, mailed, forwarded, then sitting in an inbox for the rest of the
  // TTL), so waiting the TTL out is not a remedy.
  //
  // Driven in the two halves the portal's equivalent uses (verify-customer-portal.ts):
  // a token ALREADY IN FLIGHT stops working, and a link NEVER OPENED cannot be entered at
  // all. Checkout is a single-token model — the URL token IS the session token, there is
  // no portal-style exchange (see lib/storefront-session.ts) — so the halves are "the
  // buyer was mid-flow" and "the buyer had not arrived yet" rather than two credentials.
  // Each half carries its positive control: a refusal proves nothing unless the same
  // route answers for a link that was NOT revoked.
  const revoke = (bizPublicId: string, sessionId: string, token: string) =>
    call(`/v1/businesses/${bizPublicId}/checkout_sessions/${sessionId}/revoke`, token, "POST", {});

  // ── Half (a): a token the buyer is already holding ───────────────────────────
  const liveLink = await mintLink({ price: zPrice.publicId, quantity: 1 });
  const bystander = await mintLink({ price: zPrice.publicId, quantity: 1 });
  ok(
    "revoke: the link answers before it is revoked (200)",
    (await call("/checkout/v1/session", liveLink.token)).statusCode === 200,
  );
  ok(
    "revoke: …and the buyer is genuinely mid-flow on it (customer captured)",
    (
      await call("/checkout/v1/customer", liveLink.token, "POST", {
        email: "authz-revoke@acme.test",
        address: usAddress("11 Revoke Row"),
      })
    ).statusCode === 200,
  );
  const revoked1 = await revoke(zBiz.publicId, liveLink.id, zOrg.secret);
  ok(
    "revoke: the operator route answers 200 and echoes the session + revoked_at",
    revoked1.statusCode === 200 &&
      body(revoked1).id === liveLink.id &&
      typeof body(revoked1).revoked_at === "string",
  );
  // Revocation is orthogonal to the LIFECYCLE: it does not mark the session completed or
  // expired. What kills the link is the resolver's `isNull(revoked_at)`, nothing else.
  ok(
    "revoke: …and it leaves the session status alone (still open)",
    body(revoked1).status === "open",
  );
  ok(
    "revoke, half (a): the in-flight token is now 401 on the READ route",
    (await call("/checkout/v1/session", liveLink.token)).statusCode === 401,
  );
  ok(
    "revoke, half (a): …and 401 on a MUTATING route",
    (
      await call("/checkout/v1/customer", liveLink.token, "POST", {
        email: "authz-revoke-2@acme.test",
        address: usAddress("12 Revoke Row"),
      })
    ).statusCode === 401,
  );
  // THE POSITIVE CONTROL. A route broken for everyone reads as perfect security.
  ok(
    "revoke: a sibling link minted alongside it is UNAFFECTED (200)",
    (await call("/checkout/v1/session", bystander.token)).statusCode === 200,
  );

  // ── Half (b): a link nobody has opened yet ───────────────────────────────────
  // The portal asserts "a revoked link cannot be EXCHANGED at all"; here the equivalent
  // is that the very FIRST request the buyer's browser makes is refused, so the hosted
  // page never mounts. Half (a) alone would leave the mailed-but-unopened link alive.
  const unopened = await mintLink({ price: zPrice.publicId, quantity: 1 });
  ok(
    "revoke, half (b): a never-opened link is revocable (200)",
    (await revoke(zBiz.publicId, unopened.id, zOrg.secret)).statusCode === 200,
  );
  ok(
    "revoke, half (b): …and its FIRST request is 401 — the link cannot be entered at all",
    (await call("/checkout/v1/session", unopened.token)).statusCode === 401,
  );
  ok(
    "revoke, half (b): …401 on its mutating routes too",
    (
      await call("/checkout/v1/customer", unopened.token, "POST", {
        email: "authz-unopened@acme.test",
        address: usAddress("13 Revoke Row"),
      })
    ).statusCode === 401,
  );

  // ── Idempotent, and scoped to the one row ────────────────────────────────────
  const revoked2 = await revoke(zBiz.publicId, liveLink.id, zOrg.secret);
  ok(
    "revoke: a second revoke answers 200 with the SAME revoked_at (never moves it)",
    revoked2.statusCode === 200 && body(revoked2).revoked_at === body(revoked1).revoked_at,
  );
  const revokedRows = await withTenant(zOrgId, (tx) =>
    tx
      .select({ id: checkoutSessions.publicId, revokedAt: checkoutSessions.revokedAt })
      .from(checkoutSessions),
  );
  const revokedAtOf = (id: string) => revokedRows.find((r) => r.id === id)?.revokedAt ?? null;
  ok(
    "revoke: it wrote revoked_at on the named session and on NO other row",
    revokedAtOf(liveLink.id) !== null &&
      revokedAtOf(unopened.id) !== null &&
      revokedAtOf(bystander.id) === null,
  );

  // ── Who may revoke what ─────────────────────────────────────────────────────
  ok(
    "revoke: an unknown session id is 404",
    (await revoke(zBiz.publicId, "cosess_doesnotexist", zOrg.secret)).statusCode === 404,
  );
  // Same ORGANIZATION, wrong BUSINESS. The org key is authorized for both businesses, so
  // only the service's own business predicate stands between them.
  ok(
    "revoke: another business's path cannot revoke this session (404)",
    (await revoke(yBiz.publicId, bystander.id, zOrg.secret)).statusCode === 404,
  );
  ok(
    "revoke: …and the session still works after that refusal",
    (await call("/checkout/v1/session", bystander.token)).statusCode === 200,
  );
  // CROSS-TENANT. A second organization with its own business, so the request is
  // well-formed for the caller and only tenancy refuses it.
  const xOrg = await createOrganization({ name: "Checkout Foreign Co" });
  const xBiz = await createBusiness({
    organizationId: xOrg.organization.id,
    name: "Foreign Biz",
    defaultCurrency: "USD",
    livemode: "test",
    timezone: "UTC",
  });
  ok(
    "revoke: org X cannot revoke org Z's session through its OWN business (404)",
    (await revoke(xBiz.publicId, bystander.id, xOrg.secret)).statusCode === 404,
  );
  ok(
    "revoke: org X naming org Z's business is 404 at the business itself",
    (await revoke(zBiz.publicId, bystander.id, xOrg.secret)).statusCode === 404,
  );
  ok(
    "revoke: …and org Z's link is still alive after both attempts",
    (await call("/checkout/v1/session", bystander.token)).statusCode === 200,
  );
  // And the operator's own revoke still works on it afterwards — proving the four
  // refusals above were about AUTHORIZATION, not a route that had stopped functioning.
  ok(
    "revoke: the rightful operator can still revoke it (200)",
    (await revoke(zBiz.publicId, bystander.id, zOrg.secret)).statusCode === 200,
  );
  ok(
    "revoke: …and it is dead now (401)",
    (await call("/checkout/v1/session", bystander.token)).statusCode === 401,
  );

  // ── REVOKED is not SPENT: a completed link's last reach ──────────────────────
  // `isSpent` refuses the MUTATING buyer routes on a completed session with a 409 while
  // `/session` and `/invoice` keep answering (the page has to read "already complete" and
  // poll the invoice it just paid), and `/complete` still replays its stored result.
  // That replay is the reach a leaked SPENT link retains, and revocation is what ends it:
  // the resolver refuses first, so all three become 401.
  ok(
    "spent link: /session is readable while it is merely SPENT (200)",
    (await call("/checkout/v1/session", isoLink.token)).statusCode === 200,
  );
  ok(
    "spent link: …a mutating route is 409 — SPENT, not revoked",
    (
      await call("/checkout/v1/customer", isoLink.token, "POST", {
        email: "authz-spent@acme.test",
        address: usAddress("14 Revoke Row"),
      })
    ).statusCode === 409,
  );
  ok(
    "spent link: …and /complete still replays its stored result (201)",
    (
      await call("/checkout/v1/complete", isoLink.token, "POST", {
        setup_intent: freshSetup.intent!.publicId,
      })
    ).statusCode === 201,
  );
  const revokedSpent = await revoke(zBiz.publicId, isoLink.id, zOrg.secret);
  ok(
    "revoke: a COMPLETED session is revocable on purpose — that IS the leaked-link case",
    revokedSpent.statusCode === 200 && body(revokedSpent).status === "completed",
  );
  ok(
    "revoke: …the readable /session route is 401 now, not 200",
    (await call("/checkout/v1/session", isoLink.token)).statusCode === 401,
  );
  ok(
    "revoke: …and the /complete REPLAY is 401, not 201 — the spent link keeps nothing",
    (
      await call("/checkout/v1/complete", isoLink.token, "POST", {
        setup_intent: freshSetup.intent!.publicId,
      })
    ).statusCode === 401,
  );

  // ═══ F-45: A REDIRECT CHALLENGE ON THE FIRST CHARGE NEEDS SOMEWHERE TO RETURN ═
  //
  // `chargeBeforeSubscriptionInvoice` has taken `returnUrl`/`cancelUrl` since the
  // on-session intent was added, and `/checkout/v1/complete` accepted neither — so a
  // hosted checkout's first charge minted a PayPal order with NO `experience_context`
  // and the buyer who approved it was never sent back. Nothing failed loudly: the 402
  // is correct, the approval URL is correct, and the sale simply never completes.
  //
  // Asserted at the ADAPTER boundary, because that is the only place the field is
  // observable — it is handed to `createIntent` and never persisted (see
  // `createPaymentIntent`), so no row and no response body can witness it. tmtest's
  // `4000000000003155` is a real `requires_action` charge, so the 402 below is the
  // engine's own, not a stub.
  {
    const seen: Array<Pick<CreateIntentInput, "returnUrl" | "cancelUrl" | "purpose">> = [];
    const originalCreateIntent = TmtestProvider.prototype.createIntent;
    TmtestProvider.prototype.createIntent = async function (
      this: TmtestProvider,
      input: CreateIntentInput,
    ): Promise<IntentRef> {
      seen.push({
        purpose: input.purpose,
        ...(input.returnUrl !== undefined ? { returnUrl: input.returnUrl } : {}),
        ...(input.cancelUrl !== undefined ? { cancelUrl: input.cancelUrl } : {}),
      });
      return originalCreateIntent.call(this, input);
    };
    const RETURN_URL = "https://portal.test/checkout?pay=return";
    const CANCEL_URL = "https://portal.test/checkout?pay=cancel";
    /** The card whose charge comes back `requires_action` — see providers/tmtest/instruments.ts. */
    const CHALLENGE_TOKEN = "tok_4000000000003155";
    let challenged: Awaited<ReturnType<typeof call>>;
    let control: Awaited<ReturnType<typeof call>>;
    /** Snapshotted per case: `seen` is reset between them, so a late read sees the wrong run. */
    let challengedSeen: typeof seen = [];
    let controlSeen: typeof seen = [];
    try {
      const rtLink = await mintLink({ price: zPrice.publicId, quantity: 1 });
      await call("/checkout/v1/customer", rtLink.token, "POST", {
        email: "authz-redirect@acme.test",
        address: usAddress("7 Redirect Road"),
      });
      challenged = await call("/checkout/v1/complete", rtLink.token, "POST", {
        token: CHALLENGE_TOKEN,
        return_url: RETURN_URL,
        cancel_url: CANCEL_URL,
      });
      challengedSeen = [...seen];

      // The CONTROL, and it is the half that makes the assertion mean something: the same
      // charge with no pair sent must reach the adapter with no pair set, or "the field
      // arrived" would be indistinguishable from a default someone wired in elsewhere.
      seen.length = 0;
      const ctlLink = await mintLink({ price: zPrice.publicId, quantity: 1 });
      await call("/checkout/v1/customer", ctlLink.token, "POST", {
        email: "authz-redirect-control@acme.test",
        address: usAddress("8 Redirect Road"),
      });
      control = await call("/checkout/v1/complete", ctlLink.token, "POST", {
        token: CHALLENGE_TOKEN,
      });
      controlSeen = [...seen];
    } finally {
      TmtestProvider.prototype.createIntent = originalCreateIntent;
    }

    ok(
      "F-45: a requires_action first charge still answers 402 + a redirect next_action",
      challenged.statusCode === 402 &&
        body(challenged).error?.code === "requires_action" &&
        body(challenged).next_action?.mode === "redirect" &&
        typeof body(challenged).payment_intent?.id === "string",
    );
    const charge = challengedSeen.find((s) => s.purpose === "payment");
    ok(
      "F-45: …and the return_url/cancel_url off the body reach the GATEWAY's payment intent",
      charge?.returnUrl === RETURN_URL && charge?.cancelUrl === CANCEL_URL,
    );
    const controlCharge = controlSeen.find((s) => s.purpose === "payment");
    ok(
      "F-45: …while a completion that sends neither reaches it with neither (control)",
      control.statusCode === 402 &&
        controlCharge !== undefined &&
        controlCharge.returnUrl === undefined &&
        controlCharge.cancelUrl === undefined,
    );

    // A public body, so the pair is validated like every other URL on this surface. A
    // checkout that accepted `javascript:…` here would hand a gateway a redirect target.
    const badUrl = await mintLink({ price: zPrice.publicId, quantity: 1 });
    await call("/checkout/v1/customer", badUrl.token, "POST", {
      email: "authz-redirect-bad@acme.test",
      address: usAddress("9 Redirect Road"),
    });
    ok(
      "F-45: a return_url that is not a URL is refused (400)",
      (
        await call("/checkout/v1/complete", badUrl.token, "POST", {
          token: "tok_4242",
          return_url: "not-a-url",
        })
      ).statusCode === 400,
    );

    // ── THE REPLAY PATH IS UNTOUCHED ──────────────────────────────────────────
    // The return leg re-posts `/complete`, and a buyer who lands on it twice (a reload, a
    // double tap) re-posts it against a session that is already `completed`. The new pair
    // must not change that: `completeCheckout` answers from the stored result BEFORE the
    // CAS claim, and nothing on that path reads a return_url — it only ever reaches the
    // charge, and a replay never charges.
    const replayLink = await mintLink({ price: zPrice.publicId, quantity: 1 });
    await call("/checkout/v1/customer", replayLink.token, "POST", {
      email: "authz-redirect-replay@acme.test",
      address: usAddress("10 Redirect Road"),
    });
    const first = await call("/checkout/v1/complete", replayLink.token, "POST", {
      token: "tok_4242",
      return_url: RETURN_URL,
      cancel_url: CANCEL_URL,
    });
    const again = await call("/checkout/v1/complete", replayLink.token, "POST", {
      token: "tok_4242",
      return_url: RETURN_URL,
      cancel_url: CANCEL_URL,
    });
    ok(
      "F-45: a completion carrying the pair still completes (201)",
      first.statusCode === 201 && typeof body(first).subscription_id === "string",
    );
    ok(
      "F-45: …and re-posting it WITH the pair replays the stored result, same ids",
      again.statusCode === 201 &&
        body(again).subscription_id === body(first).subscription_id &&
        body(again).customer_id === body(first).customer_id,
    );
    const replaySubs = await withTenant(zOrgId, (tx) =>
      tx
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(eq(subscriptions.publicId, String(body(first).subscription_id))),
    );
    ok("F-45: …and the replay created no second subscription", replaySubs.length === 1);
  }

  // ═══ LOST WEBHOOK ON THE FIRST CHARGE: LEG 2 ASKS THE GATEWAY ═══════════════
  // The buyer passed the challenge and the gateway authorized, but its webhook never
  // reached us. Leg 2 must read the gateway instead of refusing on our stale row.
  {
    const CHALLENGE_TOKEN = "tok_4000000000003155";
    const lwLink = await mintLink({ price: zPrice.publicId, quantity: 1 });
    await call("/checkout/v1/customer", lwLink.token, "POST", {
      email: "lost-webhook@acme.test",
      address: usAddress("11 Redirect Road"),
    });
    const leg1 = await call("/checkout/v1/complete", lwLink.token, "POST", {
      token: CHALLENGE_TOKEN,
    });
    const lwPi = String(body(leg1).payment_intent?.id);
    const [row] = await withTenant(zOrgId, (tx) =>
      tx.select().from(paymentIntents).where(eq(paymentIntents.publicId, lwPi)),
    );
    await TmtestProvider.resolveChallenge(row!.intentAtGateway!, true);
    const leg2 = await call("/checkout/v1/complete", lwLink.token, "POST", {
      token: CHALLENGE_TOKEN,
      payment_intent: lwPi,
    });
    const [sub] = await withTenant(zOrgId, (tx) =>
      tx
        .select({ id: subscriptions.id, status: subscriptions.status })
        .from(subscriptions)
        .where(eq(subscriptions.publicId, String(body(leg2).subscription_id))),
    );
    const subInvoices = sub
      ? await withTenant(zOrgId, (tx) =>
          tx.select().from(invoices).where(eq(invoices.subscriptionId, sub.id)),
        )
      : [];
    const subPays = subInvoices[0]
      ? await withTenant(zOrgId, (tx) =>
          tx.select().from(payments).where(eq(payments.invoiceId, subInvoices[0]!.id)),
        )
      : [];
    ok(
      "lost webhook: first-charge leg 2 reads the gateway and creates the subscription",
      row?.status !== "authorized" && leg2.statusCode === 201 && sub?.status === "active",
    );
    ok(
      "lost webhook: …its first invoice is paid once",
      subInvoices.length === 1 && subInvoices[0]!.status === "paid" && subPays.length === 1,
    );
  }

  // ═══ THE REGISTRATION PAYS THE FIRST INVOICE (setupCollectsFirstCharge) ═════
  // One payment at signup: the mandate registration collects the first invoice, and the
  // completion books it — whether the buyer or the gateway's webhook gets there first.
  {
    const fBiz = await createBusiness({
      organizationId: zOrgId,
      name: "First Charge Biz",
      defaultCurrency: "USD",
      livemode: "test",
      timezone: "UTC",
    });
    const fGwa = await createGatewayAccount({
      organizationId: zOrgId,
      businessId: fBiz.id,
      gatewayKey: "tmtest",
      label: "First charge TM Test",
      credentials: { setup_first_charge: "card" },
    });
    const fProduct = await createProduct({
      organizationId: zOrgId,
      businessId: fBiz.id,
      name: "F",
    });
    const fPrice = await createPrice({
      organizationId: zOrgId,
      businessId: fBiz.id,
      productId: fProduct.id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor: 5000,
      interval: "month",
    });
    const fLink = async () => {
      const r = await app.inject({
        method: "POST",
        url: `/v1/businesses/${fBiz.publicId}/checkout_sessions`,
        headers: { authorization: `Bearer ${zOrg.secret}`, "idempotency-key": crypto.randomUUID() },
        payload: { price: fPrice.publicId, quantity: 1 },
      });
      return body(r) as { token: string; id: string };
    };
    const startSetup = async (email: string) => {
      const link = await fLink();
      await call("/checkout/v1/customer", link.token, "POST", {
        email,
        address: usAddress("5 First Charge Way"),
      });
      const setup = await call("/checkout/v1/setup", link.token, "POST", {
        ...setupPayload,
        gateway_account: fGwa.publicId,
      });
      const piId = String(body(setup).payment_intent);
      const [pi] = await withTenant(zOrgId, (tx) =>
        tx.select().from(paymentIntents).where(eq(paymentIntents.publicId, piId)),
      );
      return { link, setup, piId, pi };
    };
    const paidOnce = async (subPublicId: string, gatewayId: string) => {
      const [sub] = await withTenant(zOrgId, (tx) =>
        tx.select().from(subscriptions).where(eq(subscriptions.publicId, subPublicId)),
      );
      const invs = sub
        ? await withTenant(zOrgId, (tx) =>
            tx.select().from(invoices).where(eq(invoices.subscriptionId, sub.id)),
          )
        : [];
      const pays = invs[0]
        ? await withTenant(zOrgId, (tx) =>
            tx.select().from(payments).where(eq(payments.invoiceId, invs[0]!.id)),
          )
        : [];
      return (
        sub?.status === "active" &&
        invs.length === 1 &&
        invs[0]!.status === "paid" &&
        pays.length === 1 &&
        pays[0]!.providerChargeId === gatewayId
      );
    };

    const a = await startSetup("first-charge-a@acme.test");
    ok(
      "first charge: the setup intent carries the first invoice before the buyer leaves",
      a.setup.statusCode === 201 && a.pi?.firstChargeMinor === 5000n && a.pi.amountMinor === 0n,
    );
    await TmtestProvider.resolveChallenge(a.pi!.intentAtGateway!, true);
    const aDone = await call("/checkout/v1/complete", a.link.token, "POST", {
      setup_intent: a.piId,
    });
    ok(
      "first charge (buyer first): the subscription is active and its invoice paid once, by the registration",
      aDone.statusCode === 201 &&
        (await paidOnce(String(body(aDone).subscription_id), a.pi!.intentAtGateway!)),
    );
    const [refundJob] = (await systemDb.execute(
      sql`select run_at from graphile_worker._private_jobs where key = ${`setup_auth_refund:tmtest:${a.pi!.intentAtGateway}`}`,
    )) as unknown as Array<{ run_at: Date }>;
    ok(
      "first charge: its safety refund waits (it stands down once it finds the charge booked)",
      !!refundJob && new Date(refundJob.run_at).getTime() > Date.now() + 60 * 60_000,
    );

    const b = await startSetup("first-charge-b@acme.test");
    await TmtestProvider.resolveChallenge(b.pi!.intentAtGateway!, true);
    const { completeVaultFromIntent } = await import("@/api/vault-setup");
    const { completeCheckoutForSetupIntent: finishByHook } =
      await import("@/modules/checkout/service");
    const [bCust] = await withTenant(zOrgId, (tx) =>
      tx.select().from(customers).where(eq(customers.email, "first-charge-b@acme.test")),
    );
    const bPm = await completeVaultFromIntent({
      organizationId: zOrgId,
      businessId: fBiz.id,
      customerId: bCust!.id,
      paymentIntentPublicId: b.piId,
    });
    const hook = await finishByHook({
      organizationId: zOrgId,
      businessId: fBiz.id,
      intentPublicId: b.piId,
      paymentMethodId: bPm.id,
    });
    const bLate = await call("/checkout/v1/complete", b.link.token, "POST", {
      setup_intent: b.piId,
    });
    ok(
      "first charge (webhook first): the webhook completes it, the late buyer replays the same subscription",
      hook === "completed" &&
        bLate.statusCode === 201 &&
        (await paidOnce(String(body(bLate).subscription_id), b.pi!.intentAtGateway!)),
    );
    ok(
      "first charge: nothing was charged a second time at the gateway",
      (
        await systemDb
          .select()
          .from(transactions)
          .where(and(eq(transactions.businessId, fBiz.id), eq(transactions.type, "payment")))
      ).length === 2,
    );
  }

  await app.close();
}

// ═══ A DOWNGRADE AT CHECKOUT IS A CREDIT, AND THE FOOTER MUST ADD UP ═════════
// Two separate things this pins, neither of which anything covered before:
//
//  1. THE SIGN. `previewOutcome` has had a `totalMinor < 0 → "Credit from this
//     change"` branch all along, and it could never fire: `estimateChange` returned
//     `net + invoiceTax`, so a downgrade whose credit outweighed its charge previewed
//     POSITIVE and the buyer was told "Due today". Measured 2026-08-30 on the operator
//     screen at ₹7,234.24 for a change that owed ₹887.36 back.
//
//  2. THE LADDER IDENTITY the storefront footer now depends on. `PreviewCard` prints
//     subtotal → tax rows → … → total, where `subtotalMinor` is net of the credit's
//     PRE-tax amount while the tax rows are the INVOICE's tax, gross of it. The credit
//     note's own tax is in neither, so the column only reconciles with an explicit
//     "Tax reversed on your credit" row, derived as
//     `creditNoteTotalMinor − Σ(negative lines)`. Assert that identity here, or the
//     next change to the estimate's convention breaks a buyer-facing total silently.
//
// Needs its OWN business: every other case in this file is untaxed, which is exactly
// why none of them could see this — with no tax, the credit note's tax is 0 and the
// identity holds trivially.
{
  const dgBiz = await createBusiness({
    organizationId: orgId,
    name: "Downgrade Co",
    defaultCurrency: "USD",
    livemode: "test",
    timezone: "Asia/Kolkata",
  });
  await createGatewayAccount({
    organizationId: orgId,
    businessId: dgBiz.id,
    gatewayKey: "tmtest",
    label: "TM Test",
    credentials: {},
  });
  await createFlatTaxRate({
    organizationId: orgId,
    businessId: dgBiz.id,
    name: "GST18",
    country: "US",
    rateBps: 1800,
  } as never).catch(() => undefined);
  const dgProd = await createProduct({
    organizationId: orgId,
    businessId: dgBiz.id,
    name: "Tiered Plan",
  });
  const mk = (amountMinor: number) =>
    createPrice({
      organizationId: orgId,
      businessId: dgBiz.id,
      productId: dgProd.id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor,
      interval: "month",
    });
  const bigPrice = await mk(4000000);
  const smallPrice = await mk(1000000);

  const dgSess = await createCheckoutSession({
    organizationId: orgId,
    businessId: dgBiz.id,
    priceId: bigPrice.publicId,
    quantity: 1,
  });
  const dgCtx = await resolveCheckoutSession(dgSess.token);
  await setCheckoutCustomer(dgCtx!, {
    email: "downgrade@example.com",
    address: { line1: "8 Credit St", country: "US", state: "CA", city: "SF", postalCode: "94105" },
  } as never);
  await completeCheckout(dgCtx!, { paymentMethodToken: "tok_4242" });
  const [dgSub] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.businessId, dgBiz.id)),
  );
  // The term must be BILLED or the credit falls to negative invoice lines instead of a
  // credit note — a different shape, and not the one the storefront ladder describes.
  await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: dgBiz.id,
    subscription: dgSub!,
    periodStart: dgSub!.currentPeriodStart!,
    periodEnd: dgSub!.currentPeriodEnd!,
  });

  const dgChg = await createCheckoutSession({
    organizationId: orgId,
    businessId: dgBiz.id,
    mode: "change",
    subscriptionId: dgSub!.publicId,
    items: [{ price: smallPrice.publicId, quantity: 1 }],
    replaceItemsList: true,
  });
  const dgChgCtx = await resolveCheckoutSession(dgChg.token);
  const dPrev = (await getCheckoutView(dgChgCtx!))?.change?.preview;

  const creditLines = (dPrev?.lines ?? []).reduce(
    (sum, l) => (l.amountMinor < 0 ? sum - l.amountMinor : sum),
    0,
  );
  const chargeLines = (dPrev?.lines ?? []).reduce(
    (sum, l) => (l.amountMinor > 0 ? sum + l.amountMinor : sum),
    0,
  );
  const invoiceTotal =
    chargeLines - (dPrev?.promotionalDiscountMinor ?? 0) + (dPrev?.taxMinor ?? 0);
  console.log(
    `downgrade preview: total=${dPrev?.totalMinor} due=${dPrev?.amountDueMinor} immediate=${dPrev?.immediateCharge}` +
      ` netSubtotal=${dPrev?.subtotalMinor} chargeLines=${chargeLines} tax=${dPrev?.taxMinor}` +
      ` invoiceTotal=${invoiceTotal} note=${dPrev?.creditNoteTotalMinor} creditLines=${creditLines}`,
  );

  ok("checkout downgrade previews a CREDIT, not a charge", (dPrev?.totalMinor ?? 0) < 0);
  ok("checkout downgrade is not an immediate charge", dPrev?.immediateCharge === false);
  ok("checkout downgrade collects nothing now", dPrev?.amountDueMinor === 0);
  ok(
    "checkout downgrade quotes a tax-inclusive credit note",
    (dPrev?.creditNoteTotalMinor ?? 0) > creditLines,
  );
  // ⚠ THE FOOTER LADDER, and it is the SAME ladder the operator's rail and confirm dialog
  // print. If this fails, a buyer-facing column stops summing to the figure beneath it.
  //
  // The rule all three screens share: `Subtotal` is the CHARGES (so the tax rows under it
  // are a readable percentage of it), then the invoice's total, then the credit note at its
  // tax-inclusive face value. Quoting the estimate's `subtotal_minor` here instead — the
  // NET — put ₹44,368.00 on one screen and −₹752.00 on another for one change, under the
  // same word, with a CGST row that was 9% of neither.
  // ⚠ THE DEBT-RELIEF TERM IS PART OF THE LAW, not an exception to it (2026-08-31). This
  // used to assert `invoiceTotal − creditNote === total`, which is only the ladder's law
  // when the term is fully PAID — true of this case, and of every case in this file, which
  // is why 337/0 held while the buyer's screen announced "₹17,010.12 credited to your
  // balance" on a change that credited ₹0 and still wanted ₹5,088.01. On an UNPAID term the
  // credit is spent relieving what is still owed before any of it can offset this invoice,
  // so that slice has to appear in the identity or the column cannot sum. It is 0 here, so
  // this case's arithmetic is unchanged — the law is simply now stated in full.
  ok(
    "storefront ladder reconciles: invoice − creditNote + debtRelieved === total",
    invoiceTotal -
      (dPrev?.creditNoteTotalMinor ?? 0) +
      (dPrev?.creditAppliedToOpenInvoicesMinor ?? 0) ===
      dPrev?.totalMinor,
  );
  ok(
    "…and this case really is the fully-paid shape the rest of the file assumes",
    (dPrev?.creditAppliedToOpenInvoicesMinor ?? 0) === 0,
  );
  // ⚠ RELATIVE, NOT ABSOLUTE — see the note on the tolerance below. The CLAIM is that the
  // ladder's Subtotal is the charge lines while `subtotal_minor` is the net; pinning the two
  // to 1000000/-3000000 asserted the proration factor as well, which is not what this is for.
  ok(
    "the ladder's Subtotal is the charges, not the net (as on the operator screens)",
    chargeLines > 0 && dPrev?.subtotalMinor === chargeLines - creditLines,
  );
  // ⚠ THE "FROM YOUR NEXT PAYMENT" STRIP. It is priced by `estimateNewSubscription`, which
  // reads the balance as it stands BEFORE this change — so it cannot see the credit the
  // change is about to create, and quoted the GROSS recurring figure while the card
  // directly beneath it announced that credit. Measured in a browser 2026-08-30: the buyer
  // was shown ₹90,732.56 where the operator's rail said ₹89,845.20, differing by exactly
  // the ₹887.36 both screens named. The preview must therefore CARRY the credit forward.
  ok(
    "the preview carries the credit forward for the next-payment strip",
    (dPrev?.refundableCreditAddedMinor ?? 0) > 0,
  );
  ok(
    "…and it equals the whole refund, since no invoice absorbed any of it",
    dPrev?.refundableCreditAddedMinor === -(dPrev?.totalMinor ?? 0),
  );
  // ⚠ PIN THE ACTUAL PRE-FIX VALUE, not just "≠ the subtotal". The old convention returned
  // `net + invoiceTax` = −3000000 + 180000 = −2820000: still negative, so this case does NOT
  // exercise the sign FLIP (that needs |net| < creditTax, and here 3000000 ≫ 720000 — the
  // estimates suite's qty 60→59 case covers it). What it does catch is the refund being
  // under-quoted by the credit's own tax, 720000, which is the same defect measured on the
  // buyer's own money. Asserting `!== -3000000` alone would have passed against the bug.
  ok("checkout downgrade is not the OLD net+invoiceTax total", dPrev?.totalMinor !== -2820000);
  ok(
    "checkout downgrade refund equals invoice − credit note",
    dPrev?.totalMinor === invoiceTotal - (dPrev?.creditNoteTotalMinor ?? 0),
  );
  // ⚠ WHY THESE ARE RELATIVE, AND WHY ONE TOLERANCE SURVIVES.
  //
  // This case is priced through the CHECKOUT path, which uses `businessWallClock` — the real
  // current time — so the proration factor moves as the suite runs through the billing
  // period. Measured 2026-08-30, two runs hours apart on unchanged code:
  //
  //   creditLines 4000000 → 3999999,  note 4720000 → 4719998,  total -3540000 → -3539998
  //
  // one minor unit on the credit line, because `4000000 × f` rounds down while `1000000 × f`
  // does not. The first version of this block hardcoded those absolutes and passed only by
  // the luck of running inside one window; the three assertions that broke were exactly the
  // three that pinned amounts instead of relationships.
  //
  // Every identity above is time-invariant and stays exact. This last one keeps an ABSOLUTE
  // anchor so a gross regression still fails — a few units of proration drift is expected, a
  // few thousand is a bug — with a tolerance wide enough for the rounding and nothing else.
  // ⚠ THE TWO CALCULATORS. `view.nextPayment` is priced by `projectRecurringPayment` →
  // `estimateNewSubscription`; `preview.nextRenewalTotalMinor` comes from `estimateChange`'s
  // own `next_renewal`. They answer ONE question — what does this subscription renew at
  // after the change — and they are deliberately not merged, because the strip also serves
  // signup mode and carries `excludesUsage` / `includesExistingItems` the estimate has no
  // equivalent for. So they are compared instead. This is the assertion that fails the day
  // they drift, which is the failure that actually reaches a buyer: measured 2026-08-30, the
  // strip showed ₹90,732.56 where the operator's rail said ₹89,845.20 for one subscription
  // at one instant, and nothing anywhere noticed.
  const dgView = await getCheckoutView(dgChgCtx!);
  ok(
    "the two renewal calculators agree (nextPayment vs estimateChange.next_renewal)",
    typeof dgView?.nextPayment?.totalMinor === "number" &&
      dgView.nextPayment.totalMinor === dPrev?.nextRenewalTotalMinor,
  );
  ok(
    "checkout downgrade is still the right ORDER of magnitude (−3540000 ± 100)",
    Math.abs((dPrev?.totalMinor ?? 0) - -3540000) <= 100,
  );
}

// ═══ ADD-ON SHAPES THROUGH THE CHECKOUT PATH ════════════════════════════════
// `verify:checkout` covered the plan-swap downgrade thoroughly and NOTHING ELSE. The
// engine is shared with the operator estimate, which covers ten shapes — but the risk was
// never the engine, it was the checkout-specific layer: its own footer ladder, its
// `businessWallClock` pricing, and the `Math.min(creditNote, invoiceTotal)` clamp that only
// runs when an invoice ABSORBS a note. That layer produced two independent bugs on this
// branch (an inverted sign, and a ladder that stopped reconciling), so "the engine is
// shared" is not the same as "the surface is covered".
//
// Four shapes, one taxed business, each asserting the SAME ladder identity the downgrade
// case pins — `chargeLines − promo + tax − creditNote === totalMinor` — plus the direction
// of the money. Relative, not absolute: this path prices with `businessWallClock`, and a
// hardcoded prorated amount asserts the time of day (see the note in the downgrade case).
{
  const aoBiz = await createBusiness({
    organizationId: orgId,
    name: "Addon Shapes Co",
    defaultCurrency: "USD",
    livemode: "test",
    timezone: "Asia/Kolkata",
  });
  await createGatewayAccount({
    organizationId: orgId,
    businessId: aoBiz.id,
    gatewayKey: "tmtest",
    label: "TM Test",
    credentials: {},
  });
  await createFlatTaxRate({
    organizationId: orgId,
    businessId: aoBiz.id,
    name: "GST18",
    country: "US",
    rateBps: 1800,
  } as never).catch(() => undefined);
  const aoPlanProd = await createProduct({
    organizationId: orgId,
    businessId: aoBiz.id,
    name: "AO Plan",
  });
  const aoAddProd = await createProduct({
    organizationId: orgId,
    businessId: aoBiz.id,
    name: "AO Addon",
    kind: "addon",
  } as never);
  const aoExtraProd = await createProduct({
    organizationId: orgId,
    businessId: aoBiz.id,
    name: "AO Extra",
    kind: "addon",
  } as never);
  const price = (productId: string, amountMinor: number, model: "flat" | "per_unit") =>
    createPrice({
      organizationId: orgId,
      businessId: aoBiz.id,
      productId,
      type: "recurring",
      model,
      currency: "USD",
      amountMinor,
      interval: "month",
    });
  const aoPlan = await price(aoPlanProd.id, 2000000, "flat");
  const aoAddon = await price(aoAddProd.id, 100000, "per_unit");
  const aoExtra = await price(aoExtraProd.id, 500000, "flat");

  /** A fresh billed, taxed subscription: plan + 10 add-on units. */
  let seq = 0;
  const freshCheckoutSub = async () => {
    const sess = await createCheckoutSession({
      organizationId: orgId,
      businessId: aoBiz.id,
      priceId: aoPlan.publicId,
      quantity: 1,
    });
    const ctx0 = await resolveCheckoutSession(sess.token);
    await setCheckoutCustomer(ctx0!, {
      email: `addonshape${seq++}-${Date.now()}@example.com`,
      address: { line1: "9 Addon St", country: "US", state: "CA", city: "SF", postalCode: "94105" },
    } as never);
    await completeCheckout(ctx0!, { paymentMethodToken: "tok_4242" });
    // ⚠ BY ID, NOT "the last row". The first cut selected every subscription in the business
    // with NO `ORDER BY` and took `subs[subs.length - 1]`, which is a coin flip the moment a
    // second one exists — the same trap `preconditions.ts` records as "an unordered LIMIT is
    // not a choice, it is a coin flip". It produced a `remove an add-on` shape crediting
    // 3999996 against a subscription worth 3000000, and every assertion still PASSED because
    // they are relative identities that hold against the wrong subscription just as well.
    const settled = await resolveCheckoutSession(sess.token);
    const subId = settled?.resultingSubscriptionId;
    if (!subId) throw new Error("checkout completed without a resulting subscription");
    const [sub] = await withTenant(orgId, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.id, subId)).limit(1),
    );
    if (!sub) throw new Error(`no subscription ${subId}`);
    // The add-on joins AFTER signup so the session above stays a plain plan checkout.
    await addSubscriptionItem({
      organizationId: orgId,
      businessId: aoBiz.id,
      subscriptionId: sub.id,
      price: aoAddon,
      quantity: 10,
      now: new Date(),
    } as never);
    await billSubscriptionPeriod({
      organizationId: orgId,
      businessId: aoBiz.id,
      subscription: sub,
      periodStart: sub.currentPeriodStart!,
      periodEnd: sub.currentPeriodEnd!,
    });
    return sub;
  };

  const shapes: Array<{
    name: string;
    items: Array<{ price: string; quantity?: number }>;
    charges: boolean;
  }> = [
    // Quantity UP: the engine bills only the delta and issues no credit note, so the
    // invoice has nothing to absorb and `amountDue > 0` — the clamp's other branch.
    {
      name: "add-on quantity increase",
      items: [
        { price: aoPlan.publicId, quantity: 1 },
        { price: aoAddon.publicId, quantity: 15 },
      ],
      charges: true,
    },
    // Quantity DOWN: re-rates the whole line and credits it — two documents.
    {
      name: "add-on quantity decrease",
      items: [
        { price: aoPlan.publicId, quantity: 1 },
        { price: aoAddon.publicId, quantity: 6 },
      ],
      charges: false,
    },
    // ADD a second add-on: a pure charge, no credit note at all.
    {
      name: "add an add-on",
      items: [
        { price: aoPlan.publicId, quantity: 1 },
        { price: aoAddon.publicId, quantity: 10 },
        { price: aoExtra.publicId, quantity: 1 },
      ],
      charges: true,
    },
    // REMOVE the add-on (omitted from an exhaustive list): a pure credit.
    { name: "remove an add-on", items: [{ price: aoPlan.publicId, quantity: 1 }], charges: false },
  ];

  for (const shape of shapes) {
    const sub = await freshCheckoutSub();
    const chg = await createCheckoutSession({
      organizationId: orgId,
      businessId: aoBiz.id,
      mode: "change",
      subscriptionId: sub.publicId,
      items: shape.items,
      replaceItemsList: true,
    });
    const chgCtx = await resolveCheckoutSession(chg.token);
    const prev = (await getCheckoutView(chgCtx!))?.change?.preview;
    const cl = (prev?.lines ?? []).reduce((n, l) => (l.amountMinor < 0 ? n - l.amountMinor : n), 0);
    const ch = (prev?.lines ?? []).reduce((n, l) => (l.amountMinor > 0 ? n + l.amountMinor : n), 0);
    const inv = ch - (prev?.promotionalDiscountMinor ?? 0) + (prev?.taxMinor ?? 0);
    const note = prev?.creditNoteTotalMinor ?? 0;
    console.log(
      `checkout ${shape.name}: total=${prev?.totalMinor} due=${prev?.amountDueMinor}` +
        ` immediate=${prev?.immediateCharge} chargeLines=${ch} creditLines=${cl}` +
        ` tax=${prev?.taxMinor} invoiceTotal=${inv} note=${note}`,
    );
    ok(`checkout ${shape.name}: a preview exists at all`, !!prev);
    // ⚠ THE LADDER. The same identity the storefront footer renders; if it fails the
    // visible column stops summing to the figure printed beneath it.
    ok(
      `checkout ${shape.name}: ladder reconciles (chargeLines − promo + tax − note === total)`,
      inv - note === prev?.totalMinor,
    );
    ok(
      `checkout ${shape.name}: money moves in the expected direction`,
      shape.charges ? (prev?.totalMinor ?? 0) > 0 : (prev?.totalMinor ?? 0) < 0,
    );
    ok(
      `checkout ${shape.name}: immediate_charge follows the total`,
      prev?.immediateCharge === (prev?.totalMinor ?? 0) > 0,
    );
    ok(`checkout ${shape.name}: amount due is never negative`, (prev?.amountDueMinor ?? 0) >= 0);
    // A credit note exists only where the shape actually credits.
    ok(
      `checkout ${shape.name}: credit note reported iff the shape credits`,
      note > 0 === !shape.charges,
    );
    // Tax is charged on the CHARGES, never on the net — the defect this branch began with.
    ok(
      `checkout ${shape.name}: tax is on the charges, not the net`,
      (prev?.taxMinor ?? 0) === Math.round((ch - (prev?.promotionalDiscountMinor ?? 0)) * 0.18),
    );
  }

  /**
   * A REMOVED differential add-on must never quote zero, and must quote the OUTGOING
   * plan's rate.
   *
   * A differential add-on carries `amount_minor = 0` in the catalog and gets its real rate
   * per plan+currency+interval (CAT-7). `removedItems` read the catalog column straight, so
   * a removal rendered "$0.00 / month" struck through, directly above a four-figure credit
   * for that very line — a price that lies on the screen a buyer confirms.
   *
   * The second half is the subtlety: a removal is quoted at the rate it was BILLED at, so it
   * resolves against the plan the subscription has NOW — not the session's new plan line,
   * which is right only for an item being ADDED. The two plans below carry deliberately
   * different differential rates, so resolving against the wrong one fails loudly instead of
   * passing by coincidence.
   */
  const aoDiffProd = await createProduct({
    organizationId: orgId,
    businessId: aoBiz.id,
    name: "AO Differential",
    kind: "addon",
  } as never);
  const aoPlan2Prod = await createProduct({
    organizationId: orgId,
    businessId: aoBiz.id,
    name: "AO Plan 2",
  });
  const aoDiff = await price(aoDiffProd.id, 0, "flat");
  const aoPlan2 = await price(aoPlan2Prod.id, 3000000, "flat");
  const OUTGOING_RATE = 376000;
  const INCOMING_RATE = 999900;
  for (const [plan, amountMinor] of [
    [aoPlanProd, OUTGOING_RATE],
    [aoPlan2Prod, INCOMING_RATE],
  ] as const) {
    await setDifferentialPrice({
      organizationId: orgId,
      businessId: aoBiz.id,
      addonPublicId: aoDiffProd.publicId,
      planPublicId: plan.publicId,
      currency: "USD",
      interval: "month",
      amountMinor,
    });
  }
  ok("fixture: the differential add-on is free in the catalog", Number(aoDiff.amountMinor) === 0);

  const diffSub = await freshCheckoutSub();
  await addSubscriptionItem({
    organizationId: orgId,
    businessId: aoBiz.id,
    subscriptionId: diffSub.id,
    price: aoDiff,
    quantity: 1,
    now: new Date(),
  } as never);
  // Swap the plan AND drop the differential add-on in one exhaustive list.
  const diffChg = await createCheckoutSession({
    organizationId: orgId,
    businessId: aoBiz.id,
    mode: "change",
    subscriptionId: diffSub.publicId,
    items: [
      { price: aoPlan2.publicId, quantity: 1 },
      { price: aoAddon.publicId, quantity: 10 },
    ],
    replaceItemsList: true,
  });
  const diffCtx = await resolveCheckoutSession(diffChg.token);
  const diffRemoved = (await getCheckoutView(diffCtx!))?.change?.removedItems ?? [];
  const diffRow = diffRemoved.find((r) => r.quantity === 1 && r.amount !== "");
  console.log(
    `checkout removed differential: ${JSON.stringify(diffRemoved)}` +
      ` (outgoing=${formatMoney(OUTGOING_RATE, "USD")} incoming=${formatMoney(INCOMING_RATE, "USD")})`,
  );
  ok("the dropped differential add-on is listed as removed", diffRemoved.length === 1);
  ok(
    "a removed differential add-on never quotes zero",
    !!diffRow && !diffRow.amount.includes(formatMoney(0, "USD")),
  );
  ok(
    "a removed differential add-on quotes the OUTGOING plan's rate",
    diffRow?.amount === `${formatMoney(OUTGOING_RATE, "USD")} / month`,
  );
  ok(
    "a removed differential add-on is NOT quoted at the incoming plan's rate",
    !!diffRow && !diffRow.amount.includes(formatMoney(INCOMING_RATE, "USD")),
  );

  /**
   * …and the frozen rate beats a MOVED catalog — for the removed row AND the plan row.
   *
   * `subscription_items.price_snapshot` is what bills a live subscription (`updatePrice`'s
   * own docstring: "Edits apply to NEW subscriptions only"). The credit printed under these
   * rows comes from invoice lines that rated from the snapshot, so a row sourced from the
   * catalog makes the card quote a composition that cannot add up to its own credit. Both
   * catalog figures move here AFTER the subscription exists — the grandfathered-pricing case,
   * which is the ordinary one for any catalog whose prices have ever changed.
   */
  const REPRICED_DIFF = 611100;
  const REPRICED_PLAN = 2500000;
  await setDifferentialPrice({
    organizationId: orgId,
    businessId: aoBiz.id,
    addonPublicId: aoDiffProd.publicId,
    planPublicId: aoPlanProd.publicId,
    currency: "USD",
    interval: "month",
    amountMinor: REPRICED_DIFF,
  });
  await updatePrice({
    organizationId: orgId,
    businessId: aoBiz.id,
    pricePublicId: aoPlan.publicId,
    amountMinor: REPRICED_PLAN,
  });
  const staleChg = await createCheckoutSession({
    organizationId: orgId,
    businessId: aoBiz.id,
    mode: "change",
    subscriptionId: diffSub.publicId,
    items: [
      { price: aoPlan.publicId, quantity: 1 },
      { price: aoAddon.publicId, quantity: 10 },
    ],
    replaceItemsList: true,
  });
  const staleView = (await getCheckoutView((await resolveCheckoutSession(staleChg.token))!))
    ?.change;
  const staleRow = (staleView?.removedItems ?? [])[0];
  console.log(
    `checkout stale catalog: removed=${JSON.stringify(staleRow)}` +
      ` plan=${JSON.stringify(staleView?.currentPlan)}` +
      ` (billed diff=${formatMoney(OUTGOING_RATE, "USD")} repriced=${formatMoney(REPRICED_DIFF, "USD")};` +
      ` billed plan=${formatMoney(2000000, "USD")} repriced=${formatMoney(REPRICED_PLAN, "USD")})`,
  );
  ok(
    "a removed add-on quotes the rate it was BILLED at, not the repriced catalog",
    staleRow?.amount === `${formatMoney(OUTGOING_RATE, "USD")} / month`,
  );
  ok(
    "a removed add-on is NOT quoted at the moved catalog rate",
    !!staleRow && !staleRow.amount.includes(formatMoney(REPRICED_DIFF, "USD")),
  );
  ok(
    "the current plan quotes its snapshot, not the repriced catalog",
    staleView?.currentPlan?.amount === `${formatMoney(2000000, "USD")} / month`,
  );
  ok(
    "the current plan is NOT quoted at the moved catalog rate",
    !!staleView?.currentPlan &&
      !staleView.currentPlan.amount.includes(formatMoney(REPRICED_PLAN, "USD")),
  );
}

// ── Required custom fields do not block hosted checkout ──────────────────────
// Hosted checkout collects no custom fields, so it skips the Required check; dashboard
// and API creates still enforce it. Own business so no other section sees the fields.
{
  const cfBiz = await createBusiness({
    organizationId: orgId,
    name: "Custom Field Co",
    defaultCurrency: "USD",
    livemode: "test",
  });
  await createGatewayAccount({
    organizationId: orgId,
    businessId: cfBiz.id,
    gatewayKey: "tmtest",
    label: "TM Test",
    credentials: {},
  });
  const cfProduct = await createProduct({
    organizationId: orgId,
    businessId: cfBiz.id,
    name: "CF Plan",
  });
  const cfPrice = await createPrice({
    organizationId: orgId,
    businessId: cfBiz.id,
    productId: cfProduct.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1500,
    interval: "month",
  });
  for (const entityType of ["customer", "subscription"] as const) {
    await createDefinition({
      organizationId: orgId,
      businessId: cfBiz.id,
      entityType,
      apiName: "cost_center",
      label: "Cost center",
      dataType: "string",
      required: true,
    });
  }

  const cfSession = await createCheckoutSession({
    organizationId: orgId,
    businessId: cfBiz.id,
    priceId: cfPrice.publicId,
    quantity: 1,
  });
  const cfCtx = await resolveCheckoutSession(cfSession.token);
  let cfErr: unknown = null;
  let cfSubId: string | null = null;
  try {
    await setCheckoutCustomer(cfCtx!, {
      email: "cf-buyer@example.com",
      address: {
        line1: "1 Main St",
        city: "Austin",
        state: "Texas",
        stateCode: "TX",
        postalCode: "73301",
        country: "US",
        firstName: "Cee",
      },
    });
    cfSubId =
      (await completeCheckout(cfCtx!, { paymentMethodToken: "tok_4242" })).subscriptionId ?? null;
  } catch (e) {
    cfErr = e;
  }
  ok(
    `a required custom field does not block a hosted checkout signup${cfErr ? ` (${(cfErr as Error).message})` : ""}`,
    cfErr === null && !!cfSubId?.startsWith("sub_"),
  );

  let apiCustErr = "";
  try {
    await createCustomer({ organizationId: orgId, businessId: cfBiz.id, email: "api@example.com" });
  } catch (e) {
    apiCustErr = (e as Error).message;
  }
  ok(
    "an API/dashboard customer create without it is still refused",
    apiCustErr.includes("cf_cost_center is required"),
  );

  const supplied = await createCustomer({
    organizationId: orgId,
    businessId: cfBiz.id,
    email: "api2@example.com",
    customFields: { cost_center: "R&D" },
  });
  let apiSubErr = "";
  try {
    await createSubscription({
      organizationId: orgId,
      businessId: cfBiz.id,
      customerId: supplied.id,
      now: new Date(),
      items: [{ price: cfPrice, quantity: 1 }],
    });
  } catch (e) {
    apiSubErr = (e as Error).message;
  }
  ok(
    "an API/dashboard subscription create without it is still refused",
    apiSubErr.includes("cf_cost_center is required"),
  );

  let badValueErr = "";
  try {
    await createCustomer({
      organizationId: orgId,
      businessId: cfBiz.id,
      email: "api3@example.com",
      customFields: { no_such_field: "x" },
      skipRequiredCustomFields: true,
    });
  } catch (e) {
    badValueErr = (e as Error).message;
  }
  ok(
    "skipping the Required check still validates supplied values",
    badValueErr.includes("Unknown custom field"),
  );
}

// ── The view carries the field matrix and the PO switch ──────────────────────
{
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({
        checkoutFieldConfig: { "customer.phone": "hide", "invoice.po_number": "mandatory" },
        storefrontConfig: { collect_po_number: true },
      })
      .where(eq(businesses.id, biz.id)),
  );
  const fcSession = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    priceId: price.publicId,
    quantity: 1,
  });
  const fcView = await getCheckoutView((await resolveCheckoutSession(fcSession.token))!);
  ok(
    "view carries a hidden field from the matrix",
    fcView?.field_config["customer.phone"] === "hide",
  );
  ok(
    "view carries a required PO number",
    fcView?.field_config["invoice.po_number"] === "mandatory",
  );
  ok(
    "view carries the business defaults for untouched fields",
    fcView?.field_config["billing.line1"] === "mandatory",
  );
  ok("view says the PO number is collected", fcView?.collect_po_number === true);
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({ checkoutFieldConfig: null, storefrontConfig: null })
      .where(eq(businesses.id, biz.id)),
  );
  const plainView = await getCheckoutView((await resolveCheckoutSession(fcSession.token))!);
  ok("no PO switch ⇒ the view says not collected", plainView?.collect_po_number === false);
}

// ── Shipping address section (0360) ──────────────────────────────────────────
// Over the route: hiding, requiring and checking the ship-to all live in checkout-routes.ts.
{
  const app = await buildApp({ logger: false });
  const sOrg = await createOrganization({ name: "Ship Co" });
  const sOrgId = sOrg.organization.id;
  const sBiz = await createBusiness({
    organizationId: sOrgId,
    name: "Ship Biz",
    defaultCurrency: "USD",
    livemode: "test",
    timezone: "UTC",
  });
  await createGatewayAccount({
    organizationId: sOrgId,
    businessId: sBiz.id,
    gatewayKey: "tmtest",
    label: "Ship TM Test",
    credentials: {},
  });
  const sProduct = await createProduct({
    organizationId: sOrgId,
    businessId: sBiz.id,
    name: "Box Plan",
  });
  const sPrice = await createPrice({
    organizationId: sOrgId,
    businessId: sBiz.id,
    productId: sProduct.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 2500,
    interval: "month",
  });
  const setShipping = (v: "show" | "hide" | "mandatory" | null) =>
    withTenant(sOrgId, (tx) =>
      tx
        .update(businesses)
        .set({ checkoutFieldConfig: v === null ? null : { "shipping.address": v } })
        .where(eq(businesses.id, sBiz.id)),
    );
  const mint = async () =>
    (
      await createCheckoutSession({
        organizationId: sOrgId,
        businessId: sBiz.id,
        priceId: sPrice.publicId,
        quantity: 1,
      })
    ).token;
  const post = (token: string, payload: object) =>
    app.inject({
      method: "POST",
      url: "/checkout/v1/customer",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": crypto.randomUUID() },
      payload,
    });
  const billing = {
    line1: "1 Market St",
    city: "San Francisco",
    state: "California",
    state_code: "CA",
    postal_code: "94105",
    country: "US",
    first_name: "Ship",
  };
  const shipTo = (line1: string) => ({
    line1,
    city: "Seattle",
    state: "Washington",
    state_code: "WA",
    postal_code: "98101",
    country: "US",
    first_name: "Rec",
  });
  const customerOf = async (cusPublicId: string) =>
    (
      await withTenant(sOrgId, (tx) =>
        tx.select().from(customers).where(eq(customers.publicId, cusPublicId)).limit(1),
      )
    )[0]!;
  const bookOf = (customerId: string) =>
    withTenant(sOrgId, (tx) =>
      tx.select().from(customerAddresses).where(eq(customerAddresses.customerId, customerId)),
    );
  const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, any>;

  // hide (the default): a sent ship-to is ignored.
  await setShipping(null);
  const hTok = await mint();
  const hRes = await post(hTok, {
    email: "ship-hide@example.com",
    address: billing,
    shipping_address: shipTo("5 Hidden Way"),
  });
  const hCust = await customerOf(json(hRes).id);
  ok(
    "shipping hidden: a sent shipping address is ignored",
    hRes.statusCode === 200 &&
      (await bookOf(hCust.id)).length === 0 &&
      hCust.shippingAddress == null,
  );
  const hView = await getCheckoutView((await resolveCheckoutSession(hTok))!);
  ok("shipping hidden: the view says hide", hView?.field_config["shipping.address"] === "hide");

  // mandatory: missing → 400; an incomplete one → 400 naming the field.
  await setShipping("mandatory");
  const mTok = await mint();
  const mMissing = await post(mTok, { email: "ship-must@example.com", address: billing });
  ok(
    "shipping mandatory: a details post without one is refused (400)",
    mMissing.statusCode === 400 && mMissing.body.includes("shipping_address"),
  );
  const { city: _c, ...noCity } = shipTo("7 Pier St");
  const mPartial = await post(mTok, {
    email: "ship-must@example.com",
    address: billing,
    shipping_address: noCity,
  });
  ok(
    "shipping mandatory: a ship-to without a city is refused (400)",
    mPartial.statusCode === 400 && mPartial.body.includes("City is required"),
  );
  // The email-only API path skips the details check, so completion holds the rule.
  const mEmail = await post(mTok, { email: "ship-must@example.com" });
  const mEarly = await completeCheckout((await resolveCheckoutSession(mTok))!, {
    paymentMethodToken: "tok_4242",
  }).then(
    () => "",
    (e: Error) => e.message,
  );
  ok(
    "shipping mandatory: completing without one is refused",
    mEmail.statusCode === 200 && mEarly.includes("A shipping address is required"),
  );
  await post(mTok, {
    email: "ship-must@example.com",
    address: billing,
    shipping_address: shipTo("11 Must Ln"),
  });
  const mDone = await completeCheckout((await resolveCheckoutSession(mTok))!, {
    paymentMethodToken: "tok_4242",
  });
  ok(
    "shipping mandatory: the refused session completes once a ship-to is added",
    !!mDone.subscriptionId?.startsWith("sub_"),
  );

  // show: sent → the customer's default book entry; a re-post replaces it in place.
  await setShipping("show");
  const sTok = await mint();
  const s1 = await post(sTok, {
    email: "ship-show@example.com",
    address: billing,
    shipping_address: shipTo("10 First Ave"),
  });
  const sCust = await customerOf(json(s1).id);
  const book1 = await bookOf(sCust.id);
  ok(
    "shipping show: the ship-to is the customer's default book entry",
    s1.statusCode === 200 &&
      book1.length === 1 &&
      book1[0]!.isDefault &&
      book1[0]!.line1 === "10 First Ave" &&
      (sCust.shippingAddress as Record<string, string> | null)?.line1 === "10 First Ave",
  );
  const s2 = await post(sTok, {
    email: "ship-show@example.com",
    address: billing,
    shipping_address: shipTo("20 Second Ave"),
  });
  const book2 = await bookOf(sCust.id);
  ok(
    "shipping show: a re-post replaces the same row (no second row)",
    s2.statusCode === 200 &&
      book2.length === 1 &&
      book2[0]!.id === book1[0]!.id &&
      book2[0]!.line1 === "20 Second Ave",
  );
  const sView = await getCheckoutView((await resolveCheckoutSession(sTok))!);
  ok(
    "shipping show: the view round-trips the entered ship-to",
    sView?.customer?.shipping_address?.line1 === "20 Second Ave",
  );
  const s3 = await post(sTok, { email: "ship-show@example.com", address: billing });
  const book3 = await bookOf(sCust.id);
  const archivedEvents = await withTenant(sOrgId, (tx) =>
    tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.organizationId, sOrgId),
          eq(events.type, "customer_shipping_address_archived"),
        ),
      ),
  );
  ok("shipping show: clearing emits one archived event", archivedEvents.length === 1);
  ok(
    "shipping show: a details post without one clears it",
    s3.statusCode === 200 &&
      book3.every((r) => r.archivedAt != null && !r.isDefault) &&
      (await customerOf(sCust.publicId)).shippingAddress == null,
  );
  await post(sTok, {
    email: "ship-show@example.com",
    address: billing,
    shipping_address: shipTo("30 Third Ave"),
  });
  const live = (await bookOf(sCust.id)).filter((r) => r.archivedAt == null);
  ok(
    "shipping show: adding it back leaves one live row",
    live.length === 1 && live[0]!.isDefault && live[0]!.line1 === "30 Third Ave",
  );

  // Create-mode completion pins the subscription; its first invoice snapshots the ship-to.
  const done = await completeCheckout((await resolveCheckoutSession(sTok))!, {
    paymentMethodToken: "tok_4242",
  });
  const [sSub] = await withTenant(sOrgId, (tx) =>
    tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.publicId, done.subscriptionId ?? ""))
      .limit(1),
  );
  ok(
    "create mode: the subscription ships to the entered address",
    sSub?.shippingAddressId === live[0]!.id,
  );
  const [firstInv] = await withTenant(sOrgId, (tx) =>
    tx
      .select()
      .from(invoices)
      .where(eq(invoices.subscriptionId, sSub?.id ?? crypto.randomUUID()))
      .limit(1),
  );
  ok(
    "create mode: the first invoice snapshots that ship-to",
    (firstInv?.shippingAddress as Record<string, string> | null)?.line1 === "30 Third Ave",
  );

  // Change mode: the customer is pinned, so the link never writes their address book.
  const chg = await createCheckoutSession({
    organizationId: sOrgId,
    businessId: sBiz.id,
    priceId: sPrice.publicId,
    quantity: 2,
    mode: "change",
    subscriptionId: done.subscriptionId!,
  });
  const chgView = await getCheckoutView((await resolveCheckoutSession(chg.token))!);
  ok(
    "change mode: the view has no shipping section",
    chgView?.field_config["shipping.address"] === "hide" &&
      chgView?.customer?.shipping_address === undefined,
  );
  const chgRes = await post(chg.token, {
    address: billing,
    shipping_address: shipTo("99 Takeover Rd"),
  });
  const chgBook = (await bookOf(sCust.id)).filter((r) => r.archivedAt == null);
  ok(
    "change mode: a sent ship-to is not written",
    chgRes.statusCode === 200 &&
      chgBook.length === 1 &&
      chgBook[0]!.line1 === "30 Third Ave" &&
      (await customerOf(sCust.publicId)).shippingAddress != null &&
      ((await customerOf(sCust.publicId)).shippingAddress as Record<string, string>).line1 ===
        "30 Third Ave",
  );
  ok(
    "change mode: the service refuses a ship-to outright",
    await updateCheckoutCustomerDetails((await resolveCheckoutSession(chg.token))!, {
      shippingAddress: shipTo("99 Takeover Rd"),
    }).then(
      () => false,
      (e: Error) => /shipping address/.test(e.message),
    ),
  );
  await app.close();
}

// ═══ A SIGNUP OFFERS GATEWAYS, AND SAVES THE METHOD, IN THE PLAN'S CURRENCY ═════
// A USD plan on an INR-default business used to be offered Cashfree (whose mandates are
// INR only) and to open an INR mandate sized from the USD amount.
{
  const app = await buildApp({ logger: false });
  await clearPublicRateLimits();
  const cOrg = await createOrganization({ name: "Checkout Currency Co" });
  const cOrgId = cOrg.organization.id;
  const cBiz = await createBusiness({
    organizationId: cOrgId,
    name: "Currency Biz",
    defaultCurrency: "INR",
    livemode: "test",
    timezone: "Asia/Kolkata",
  });
  await createGatewayAccount({
    organizationId: cOrgId,
    businessId: cBiz.id,
    gatewayKey: "tmtest",
    label: "Currency TM Test",
    credentials: {},
  });
  const cf = await createGatewayAccount({
    organizationId: cOrgId,
    businessId: cBiz.id,
    gatewayKey: "cashfree",
    label: "Currency Cashfree",
    credentials: { app_id: "CFTEST00000000000000000001", secret_key: "cfsk_ma_test_000000000001" },
  });
  const cProduct = await createProduct({
    organizationId: cOrgId,
    businessId: cBiz.id,
    name: "FX Plan",
  });
  const cPrice = (currency: string, amountMinor: number) =>
    createPrice({
      organizationId: cOrgId,
      businessId: cBiz.id,
      productId: cProduct.id,
      type: "recurring",
      model: "flat",
      currency,
      amountMinor,
      interval: "month",
    });
  const usdPrice = await cPrice("USD", 500);
  const inrPrice = await cPrice("INR", 20_000);
  const parse = (r: { body: string }) => {
    try {
      return JSON.parse(r.body) as Record<string, any>;
    } catch {
      return {} as Record<string, any>;
    }
  };
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
  const signup = async (priceId: string, email: string) => {
    const s = await createCheckoutSession({
      organizationId: cOrgId,
      businessId: cBiz.id,
      priceId,
      quantity: 1,
    });
    await call("/checkout/v1/customer", s.token, "POST", {
      email,
      address: {
        line1: "12 MG Road",
        city: "Bengaluru",
        state_code: "KA",
        postal_code: "560001",
        country: "IN",
        first_name: "Asha",
        last_name: "Payer",
        phone: "+919000000001",
      },
    });
    return s.token;
  };
  const cashfreeOffer = (b: Record<string, any>) =>
    (b.data as Array<{ gateway_key: string; method_types: string[] }> | undefined)?.find(
      (g) => g.gateway_key === "cashfree",
    );

  const okd = (label: string, cond: boolean, detail: string) => {
    if (!cond) console.log(`   detail: ${detail}`);
    ok(label, cond);
  };
  // ── "International payments" switch (Razorpay, Cashfree): new accounts start OFF ──────
  const rzp = await createGatewayAccount({
    organizationId: cOrgId,
    businessId: cBiz.id,
    gatewayKey: "razorpay",
    label: "Currency Razorpay",
    credentials: { key_id: "rzp_test_XXXXXXXXXXXX01", key_secret: "rzp_secret_XXXXXXXXXXXX01" },
  });
  const pick = (purpose: "setup" | "payment", currency: string, override?: string) =>
    withTenant(cOrgId, (tx) =>
      selectGatewayAccount(tx, {
        businessId: cBiz.id,
        currency,
        purpose,
        ...(override ? { override } : {}),
      }),
    ).then(
      (a) => a.gatewayKey,
      (e: Error) => (e instanceof GatewayRouterError ? e.code : e.message),
    );
  const offered = async (currency: string, purpose: "setup" | "payment") =>
    (await listVaultGatewaysForBusiness(cOrgId, cBiz.id, currency, purpose))
      .map((g) => g.gatewayKey)
      .filter((k) => k !== "tmtest")
      .sort()
      .join();
  const offState = {
    new: [cf.internationalEnabled, rzp.internationalEnabled],
    cfUsdSetup: await pick("setup", "USD", cf.publicId),
    cfUsdPay: await pick("payment", "USD", cf.publicId),
    rzpUsdPay: await pick("payment", "USD", rzp.publicId),
    rzpEurSetup: await pick("setup", "EUR", rzp.publicId),
    usdSetupOffer: await offered("USD", "setup"),
    usdPayOffer: await offered("USD", "payment"),
    inrSetupOffer: await offered("INR", "setup"),
    inrPay: await pick("payment", "INR", cf.publicId),
  };
  okd(
    "international off (new accounts): Cashfree and Razorpay take no USD/EUR setup or pay now; INR still routes",
    offState.new.join() === "false,false" &&
      offState.cfUsdSetup === "no_gateway_for_currency" &&
      offState.cfUsdPay === "no_gateway_for_currency" &&
      offState.rzpUsdPay === "no_gateway_for_currency" &&
      offState.rzpEurSetup === "no_gateway_for_currency" &&
      offState.usdSetupOffer === "" &&
      offState.usdPayOffer === "" &&
      offState.inrSetupOffer === "cashfree,razorpay" &&
      offState.inrPay === "cashfree",
    JSON.stringify(offState),
  );
  const offSession = await createCheckoutSession({
    organizationId: cOrgId,
    businessId: cBiz.id,
    priceId: usdPrice.publicId,
    quantity: 1,
  });
  const offGws = parse(await call("/checkout/v1/gateways", offSession.token));
  okd(
    "international off: a USD checkout does not offer Cashfree or Razorpay",
    !cashfreeOffer(offGws) &&
      !(offGws.data as Array<{ gateway_key: string }> | undefined)?.some(
        (g) => g.gateway_key === "razorpay",
      ),
    JSON.stringify(offGws.data?.map((g: { gateway_key: string }) => g.gateway_key)),
  );
  const listed = await updateGatewayAccount({
    organizationId: cOrgId,
    businessId: cBiz.id,
    gwaPublicId: cf.publicId,
    currencies: ["INR", "USD"],
  }).catch((e: Error) => e);
  okd(
    "international off: a currency list naming USD is refused with the reason",
    listed instanceof Error && /International payments are off/.test(listed.message),
    listed instanceof Error ? listed.message : "saved",
  );
  for (const gwa of [cf.publicId, rzp.publicId])
    await updateGatewayAccount({
      organizationId: cOrgId,
      businessId: cBiz.id,
      gwaPublicId: gwa,
      internationalEnabled: true,
    });
  const onState = {
    cfUsdSetup: await pick("setup", "USD", cf.publicId),
    cfUsdPay: await pick("payment", "USD", cf.publicId),
    rzpUsdPay: await pick("payment", "USD", rzp.publicId),
    rzpEurSetup: await pick("setup", "EUR", rzp.publicId),
    usdPayOffer: await offered("USD", "payment"),
    gbpSetupOffer: await offered("GBP", "setup"),
  };
  okd(
    "international on: Cashfree and Razorpay take USD/EUR setup and pay now again (Cashfree never a GBP mandate)",
    onState.cfUsdSetup === "cashfree" &&
      onState.cfUsdPay === "cashfree" &&
      onState.rzpUsdPay === "razorpay" &&
      onState.rzpEurSetup === "razorpay" &&
      onState.usdPayOffer === "cashfree,razorpay" &&
      onState.gbpSetupOffer === "razorpay",
    JSON.stringify(onState),
  );
  // Migration 0480 on rows that existed before it: backfilled ON; a row inserted after: OFF.
  // Run on a scratch copy of the table so the real rows are untouched.
  const m0480 = readFileSync("db/migrations/0480_gateway_international_switch.sql", "utf8")
    .split("--> statement-breakpoint")
    .map((q) => q.replaceAll('"gateway_accounts"', '"ga_0480_check"'));
  const backfill = await systemDb.transaction(async (tx) => {
    await tx.execute(
      sql.raw('CREATE TEMP TABLE "ga_0480_check" (gateway_key text) ON COMMIT DROP'),
    );
    await tx.execute(sql.raw(`INSERT INTO "ga_0480_check" VALUES ('razorpay'), ('cashfree')`));
    for (const q of m0480) await tx.execute(sql.raw(q));
    await tx.execute(sql.raw(`INSERT INTO "ga_0480_check" (gateway_key) VALUES ('cashfree')`));
    return (await tx.execute(
      sql.raw('SELECT international_enabled AS on FROM "ga_0480_check"'),
    )) as unknown as Array<{ on: boolean }>;
  });
  const [liveDefault] = (await systemDb.execute(
    sql.raw(
      `SELECT column_default AS d FROM information_schema.columns WHERE table_name = 'gateway_accounts' AND column_name = 'international_enabled'`,
    ),
  )) as unknown as Array<{ d: string }>;
  okd(
    "migration 0480: accounts that existed are backfilled ON, a later one starts OFF; the live column defaults to false",
    backfill.map((r) => r.on).join() === "true,true,false" && liveDefault?.d === "false",
    JSON.stringify({ backfill, liveDefault }),
  );

  // The rest of this block is about Cashfree's own currencies, not routing between accounts.
  await updateGatewayAccount({
    organizationId: cOrgId,
    businessId: cBiz.id,
    gwaPublicId: rzp.publicId,
    status: "disabled",
  });

  // Before the buyer's details exist, the offer still follows the plan, not the business.
  const bare = await createCheckoutSession({
    organizationId: cOrgId,
    businessId: cBiz.id,
    priceId: usdPrice.publicId,
    quantity: 1,
  });
  const bareGws = parse(await call("/checkout/v1/gateways", bare.token));
  ok(
    "currency: before the buyer's details, a USD signup's offer is USD with Cashfree card only",
    bareGws.debit_currency === "USD" && cashfreeOffer(bareGws)?.method_types.join() === "card",
  );
  const usdToken = await signup(usdPrice.publicId, "fx.usd@example.com");
  const usdGws = parse(await call("/checkout/v1/gateways", usdToken));
  ok(
    "currency: a USD signup is offered Cashfree card only (UPI and eNACH mandates are INR only)",
    cashfreeOffer(usdGws)?.method_types.join() === "card",
  );
  ok("currency: a USD signup's offer is in USD", usdGws.debit_currency === "USD");
  const usdSetup = await call("/checkout/v1/setup", usdToken, "POST", {
    return_url: "https://portal.test/done",
    cancel_url: "https://portal.test/back",
    gateway_account: cf.publicId,
    method_type: "upi",
  });
  const usdIntents = await withTenant(cOrgId, (tx) =>
    tx
      .select({ currency: paymentIntents.currency, purpose: paymentIntents.purpose })
      .from(paymentIntents)
      .where(eq(paymentIntents.businessId, cBiz.id)),
  );
  ok(
    "currency: a USD signup pinned to Cashfree UPI is refused (400, select card), and no INR mandate is opened",
    usdSetup.statusCode === 400 &&
      /select card/.test(usdSetup.body) &&
      !usdIntents.some((i) => i.purpose === "setup" && i.currency !== "USD"),
  );

  const inrToken = await signup(inrPrice.publicId, "fx.inr@example.com");
  const inrGws = parse(await call("/checkout/v1/gateways", inrToken));
  ok(
    "currency: an INR signup is still offered Cashfree with its mandate rails",
    (cashfreeOffer(inrGws)?.method_types ?? []).includes("upi") && inrGws.debit_currency === "INR",
  );
  await app.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
await closeDb();
process.exit(fail ? 1 : 0);

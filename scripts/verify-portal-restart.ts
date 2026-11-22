/**
 * Portal restart of an ENDED subscription (`storefront_config.allow_restart`):
 *  - setting unset → no `restart` block, the route refuses (403), today's 409 on /reactivate
 *  - each refusal: not ended, window closed, open invoices, manual collection, plan archived
 *  - another customer's portal session cannot restart it (404)
 *  - the restart checkout charges first even when the business lets reactivations dun:
 *    a decline keeps it cancelled and the session open; a good card restarts it
 *  - `restart_price`: `current` bills today's catalogue price, `keep` the frozen one
 *  - a replayed Idempotency-Key returns the same checkout
 *  - a pending charge on the cancelled subscription is quoted and charged with the new term
 *
 *   pnpm verify:portal-restart
 */
import { and, desc, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb, systemDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { createProduct, createPrice, setDifferentialPrice } from "@/modules/catalog/service";
import {
  createCheckoutSession,
  resolveCheckoutSession,
  getCheckoutView,
  setCheckoutCustomer,
  completeCheckout,
} from "@/modules/checkout/service";
import { cancelSubscription, cancelSubscriptionWithOptions } from "@/modules/subscriptions/service";
import { addAdHocCharge } from "@/modules/subscriptions/items";
import { createPortalSession } from "@/modules/customer-portal/service";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";
import {
  businesses,
  checkoutSessions,
  invoices,
  prices,
  subscriptionItems,
  subscriptions,
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
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
await clearPublicRateLimits();

const org = await createOrganization({ name: "Restart Co" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Tallyhaven Reports",
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
  name: "Analytics Plan",
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

const setStorefront = (cfg: Record<string, unknown> | null) =>
  systemDb.update(businesses).set({ storefrontConfig: cfg }).where(eq(businesses.id, biz.id));

/** A subscriber who paid by card, then cancelled immediately. */
async function endedSubscriber(email: string) {
  const s = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    priceId: price.publicId,
  });
  const ctx = await resolveCheckoutSession(s.token);
  const cus = await setCheckoutCustomer(ctx!, { email });
  await completeCheckout(ctx!, { paymentMethodToken: "tok_4242" });
  const [sub] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.customerId, cus.id)),
  );
  await cancelSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub!.id,
    atPeriodEnd: false,
    now: new Date(),
  });
  return { sub: sub!, customerId: cus.id };
}

async function portalToken(customerId: string) {
  const mint = await createPortalSession({ organizationId: orgId, businessId: biz.id, customerId });
  const res = await fetch(`${base}/portal/v1/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${mint.accessToken}` },
  });
  return ((await res.json()) as { token: string }).token;
}

async function http(
  path: string,
  token: string,
  opts: { method?: string; body?: unknown; key?: string } = {},
) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.method && opts.method !== "GET"
        ? { "Idempotency-Key": opts.key ?? crypto.randomUUID() }
        : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

type RestartBlock = {
  allowed: boolean;
  reason: string | null;
  message: string | null;
  open_invoices: string[];
  closes_at: string | null;
} | null;
async function restartBlock(token: string, subPublicId: string): Promise<RestartBlock | undefined> {
  const res = await http("/portal/v1/subscriptions", token);
  const row = (res.json.data as Array<{ id: string; restart?: RestartBlock }>).find(
    (s) => s.id === subPublicId,
  );
  return row?.restart;
}
const restartBody = { return_url: "https://example.com/portal" };
const restart = (token: string, subPublicId: string, key?: string) =>
  http(`/portal/v1/subscriptions/${subPublicId}/restart`, token, {
    method: "POST",
    body: restartBody,
    ...(key ? { key } : {}),
  });

const a = await endedSubscriber("restart-a@example.com");
const tokA = await portalToken(a.customerId);

// ── Setting unset = today ─────────────────────────────────────────────────────
ok("unset: no restart block in the list", (await restartBlock(tokA, a.sub.publicId)) === null);
const offRefusal = await restart(tokA, a.sub.publicId);
ok(`unset: the route refuses (403, got ${offRefusal.status})`, offRefusal.status === 403);
const oldReactivate = await http(`/portal/v1/subscriptions/${a.sub.publicId}/reactivate`, tokA, {
  method: "POST",
  body: {},
});
ok(
  "unset: /reactivate on an ended subscription keeps today's refusal",
  oldReactivate.status === 403 ||
    (oldReactivate.status === 409 &&
      /Contact us to start it again/.test(JSON.stringify(oldReactivate.json))),
);

// ── On ────────────────────────────────────────────────────────────────────────
// Operator reactivations may dun on a failed charge here; a checkout restart must still refuse.
await systemDb
  .update(businesses)
  .set({ dunningConfig: { require_successful_charge_on_reactivation: false } })
  .where(eq(businesses.id, biz.id));
await setStorefront({ allow_restart: true, allow_reactivate: true });
const onBlock = await restartBlock(tokA, a.sub.publicId);
ok("on: the ended subscription can restart", onBlock?.allowed === true && onBlock.reason === null);
const newReactivate = await http(`/portal/v1/subscriptions/${a.sub.publicId}/reactivate`, tokA, {
  method: "POST",
  body: {},
});
ok(
  "on: /reactivate points at Reactivate subscription",
  newReactivate.status === 409 &&
    /Reactivate subscription/.test(JSON.stringify(newReactivate.json)),
);

// Another customer's session cannot reach it.
const other = await endedSubscriber("restart-other@example.com");
const tokOther = await portalToken(other.customerId);
const foreign = await restart(tokOther, a.sub.publicId);
ok(`another customer's session gets 404 (got ${foreign.status})`, foreign.status === 404);

// Window: 1 day, ended 3 days ago.
await setStorefront({ allow_restart: true, restart_window_days: 1 });
await systemDb
  .update(subscriptions)
  .set({ canceledAt: new Date(Date.now() - 3 * 86_400_000) })
  .where(eq(subscriptions.id, other.sub.id));
const closed = await restartBlock(tokOther, other.sub.publicId);
ok(
  "window closed: refused with the reason",
  closed?.allowed === false && closed.reason === "window_closed",
);
const closedPost = await restart(tokOther, other.sub.publicId);
ok(`window closed: the route refuses (409, got ${closedPost.status})`, closedPost.status === 409);
await setStorefront({ allow_restart: true, restart_window_days: 30 });
ok(
  "window open: 30 days allows it and reports the close date",
  (await restartBlock(tokOther, other.sub.publicId))?.closes_at != null &&
    (await restartBlock(tokOther, other.sub.publicId))?.allowed === true,
);

// Open invoices block by default and stop blocking under `allow`.
const [paidInv] = await withTenant(orgId, (tx) =>
  tx.select().from(invoices).where(eq(invoices.subscriptionId, other.sub.id)).limit(1),
);
await systemDb.update(invoices).set({ status: "not_paid" }).where(eq(invoices.id, paidInv!.id));
const owing = await restartBlock(tokOther, other.sub.publicId);
ok(
  "open invoice: refused and named",
  owing?.reason === "open_invoices" && owing.open_invoices.includes(paidInv!.publicId),
);
await setStorefront({ allow_restart: true, restart_open_invoices: "allow" });
ok(
  "open invoice + allow: not blocked",
  (await restartBlock(tokOther, other.sub.publicId))?.allowed === true,
);
await systemDb.update(invoices).set({ status: "paid" }).where(eq(invoices.id, paidInv!.id));

// Collected by invoice: pay-first cannot hold, so the portal does not offer it.
await systemDb
  .update(subscriptions)
  .set({ autoCollection: "off" })
  .where(eq(subscriptions.id, other.sub.id));
ok(
  "manual collection: refused",
  (await restartBlock(tokOther, other.sub.publicId))?.reason === "manual_collection",
);
await systemDb
  .update(subscriptions)
  .set({ autoCollection: null })
  .where(eq(subscriptions.id, other.sub.id));

// An archived plan is never resold by the portal.
await systemDb.update(prices).set({ active: false }).where(eq(prices.id, price.id));
ok(
  "archived price: refused",
  (await restartBlock(tokOther, other.sub.publicId))?.reason === "plan_unavailable",
);
const archivedPost = await restart(tokOther, other.sub.publicId);
ok(
  `archived price: the route refuses (409, got ${archivedPost.status})`,
  archivedPost.status === 409,
);
await systemDb.update(prices).set({ active: true }).where(eq(prices.id, price.id));

// ── Restart at the current price ──────────────────────────────────────────────
await setStorefront({ allow_restart: true });
// The catalogue price moved after signup: `current` bills 8000, `keep` would bill 5000.
await systemDb.update(prices).set({ amountMinor: 8000n }).where(eq(prices.id, price.id));
const key = crypto.randomUUID();
const minted = await restart(tokA, a.sub.publicId, key);
ok(`restart: 201 with a checkout url (got ${minted.status})`, minted.status === 201);
const url = String(minted.json.url ?? "");
ok("restart: the url is a checkout link", /\/checkout\/s\/cstk_/.test(url));
const replay = await restart(tokA, a.sub.publicId, key);
ok("restart: a replayed key returns the same checkout", replay.json.url === url);

const ctxA = await resolveCheckoutSession(url.split("/checkout/s/")[1]!);
ok("restart: the session reactivates", ctxA?.reactivate === true);
let declineMessage = "";
try {
  await completeCheckout(ctxA!, { paymentMethodToken: "tok_4000000000000341" });
} catch (e) {
  declineMessage = (e as Error).message;
}
ok(
  `decline: the card's decline refuses the checkout, though the business lets reactivations dun (${declineMessage})`,
  /did not reactivate the subscription/.test(declineMessage) &&
    !/amount due changed/.test(declineMessage),
);
const [afterDecline] = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptions).where(eq(subscriptions.id, a.sub.id)),
);
ok("decline: the subscription stays cancelled", afterDecline?.status === "cancelled");
const [sessionAfterDecline] = await withTenant(orgId, (tx) =>
  tx.select().from(checkoutSessions).where(eq(checkoutSessions.subscriptionId, a.sub.id)),
);
ok("decline: the session stays open for another card", sessionAfterDecline?.status === "open");
const unpaidAfterDecline = await withTenant(orgId, (tx) =>
  tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.subscriptionId, a.sub.id), eq(invoices.status, "payment_due"))),
);
ok("decline: no unpaid invoice left behind", unpaidAfterDecline.length === 0);

await completeCheckout(ctxA!, { paymentMethodToken: "tok_4242" });
const [restarted] = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptions).where(eq(subscriptions.id, a.sub.id)),
);
ok("good card: the subscription is active again", restarted?.status === "active");
const [freshA] = await withTenant(orgId, (tx) =>
  tx
    .select()
    .from(invoices)
    .where(eq(invoices.subscriptionId, a.sub.id))
    .orderBy(desc(invoices.createdAt))
    .limit(1),
);
ok(
  `current price: the new term is billed at 8000 and paid (got ${freshA?.totalMinor} ${freshA?.status})`,
  Number(freshA?.totalMinor) === 8000 && freshA?.status === "paid",
);
ok(
  "not ended: an active subscription has no restart block",
  (await restartBlock(tokA, a.sub.publicId)) === null,
);
const liveRefusal = await restart(tokA, a.sub.publicId);
ok(`not ended: the route refuses (409, got ${liveRefusal.status})`, liveRefusal.status === 409);
const { sendAdhocEmail, AdhocEmailError } = await import("@/modules/emails/adhoc-service");
let liveEmail: unknown = null;
try {
  await sendAdhocEmail(orgId, biz.id, {
    type: "subscription_restart",
    subscriptionId: a.sub.publicId,
  });
} catch (e) {
  liveEmail = e;
}
ok(
  "not ended: a restart email is refused",
  liveEmail instanceof AdhocEmailError && /has not ended/.test((liveEmail as Error).message),
);

// ── Restart at the price the subscription had ─────────────────────────────────
// Signed up at 8000 now, so move the catalogue again to tell the two apart.
const k = await endedSubscriber("restart-keep@example.com");
await systemDb.update(prices).set({ amountMinor: 9000n }).where(eq(prices.id, price.id));
await setStorefront({ allow_restart: true, restart_price: "keep" });
const tokK = await portalToken(k.customerId);
const mintedK = await restart(tokK, k.sub.publicId);
const ctxK = await resolveCheckoutSession(String(mintedK.json.url).split("/checkout/s/")[1]!);
const viewK = await getCheckoutView(ctxK!);
ok(
  `keep price: the page quotes the frozen 8000, not today's 9000 (got ${viewK?.change?.preview?.totalMinor})`,
  viewK?.change?.preview?.totalMinor === 8000,
);
await completeCheckout(ctxK!, { paymentMethodToken: "tok_4242" });
const [freshK] = await withTenant(orgId, (tx) =>
  tx
    .select()
    .from(invoices)
    .where(eq(invoices.subscriptionId, k.sub.id))
    .orderBy(desc(invoices.createdAt))
    .limit(1),
);
ok(
  `keep price: the new term is billed at the old 8000 (got ${freshK?.totalMinor})`,
  Number(freshK?.totalMinor) === 8000 && freshK?.status === "paid",
);

// ── A restart that adds a differential-priced add-on ──────────────────────────
// The add-on is free in the catalog; its real price is the plan-scoped differential. A
// restart listing it as a NEW line froze it at 0 (billed 0 at every renewal).
const addonProd = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Extra Seats",
  kind: "addon",
});
const addonPrice = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: addonProd.id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  amountMinor: 0,
  interval: "month",
});
await setDifferentialPrice({
  organizationId: orgId,
  businessId: biz.id,
  addonPublicId: addonProd.publicId,
  planPublicId: product.publicId,
  currency: "USD",
  interval: "month",
  amountMinor: 500,
});
const d = await endedSubscriber("restart-addon@example.com");
const [planNow] = await withTenant(orgId, (tx) =>
  tx.select().from(prices).where(eq(prices.id, price.id)),
);
const planMinor = Number(planNow!.amountMinor);
const addSession = await createCheckoutSession({
  organizationId: orgId,
  businessId: biz.id,
  mode: "change",
  subscriptionId: d.sub.publicId,
  reactivate: true,
  items: [
    { price: price.publicId, quantity: 1 },
    { price: addonPrice.publicId, quantity: 2 },
  ],
});
const addCtx = await resolveCheckoutSession(addSession.token);
const addView = await getCheckoutView(addCtx!);
ok(
  `add-on: the page quotes the differential (got ${addView?.change?.preview?.totalMinor}, want ${planMinor + 1000})`,
  addView?.change?.preview?.totalMinor === planMinor + 1000,
);
await completeCheckout(addCtx!, { paymentMethodToken: "tok_4242" });
const addonLine = (
  await withTenant(orgId, (tx) =>
    tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, d.sub.id)),
  )
).find((i) => i.priceId === addonPrice.id);
const frozen = (addonLine?.priceSnapshot as { amountMinor?: number } | null)?.amountMinor;
ok(`add-on: the line keeps the differential for renewals (snapshot ${frozen})`, frozen === 500);
const [addInv] = await withTenant(orgId, (tx) =>
  tx
    .select()
    .from(invoices)
    .where(eq(invoices.subscriptionId, d.sub.id))
    .orderBy(desc(invoices.createdAt))
    .limit(1),
);
ok(
  `add-on: the new term bills plan + 2 × 500 (got ${addInv?.totalMinor} ${addInv?.status})`,
  Number(addInv?.totalMinor) === planMinor + 1000 && addInv?.status === "paid",
);

// ── Reactivation with a deferred charge still pending: the quote is what is charged ────
// A cancel can leave a deferred charge pending, and the fresh term's invoice bills it. A quote
// without it charged less than the invoice, so the charge was refunded and the page refused.
{
  const yProd = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Pro",
    kind: "plan",
  });
  const yPlan = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: yProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 199000,
    interval: "year",
  });
  const ySeat = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: addonProd.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 12000,
    interval: "year",
  });
  const yItems = [
    { price: yPlan.publicId, quantity: 1 },
    { price: ySeat.publicId, quantity: 7 },
  ];
  const s = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    items: yItems,
  });
  const sctx = await resolveCheckoutSession(s.token);
  const cus = await setCheckoutCustomer(sctx!, { email: "restart-yearly@example.com" });
  await completeCheckout(sctx!, { paymentMethodToken: "tok_4242" });
  const [ysub] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.customerId, cus.id)),
  );
  await addAdHocCharge({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: ysub!.id,
    description: "Per seat, yearly - Prorated Charges",
    amountMinor: 11400,
    priceId: ySeat.id,
    invoiceNow: false,
    now: new Date(),
  });
  await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: ysub!.id,
    now: new Date(),
    cancelOption: "immediately",
  });
  const ys = await createCheckoutSession({
    organizationId: orgId,
    businessId: biz.id,
    mode: "change",
    subscriptionId: ysub!.publicId,
    reactivate: true,
    items: yItems,
  });
  const yctx = await resolveCheckoutSession(ys.token);
  const quoted = (await getCheckoutView(yctx!))?.change?.preview?.amountDueMinor;
  ok(
    `pending charge: the page quotes the term plus the pending charge (got ${quoted}, want 294400)`,
    quoted === 294400,
  );
  let yErr = "";
  try {
    // No card on the page: the saved one is charged.
    await completeCheckout(yctx!, {});
  } catch (e) {
    yErr = (e as Error).message;
  }
  const [yInv] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(invoices)
      .where(eq(invoices.subscriptionId, ysub!.id))
      .orderBy(desc(invoices.createdAt))
      .limit(1),
  );
  ok(
    `pending charge, saved card: reactivated and billed what was quoted (${yErr || "ok"}; got ${yInv?.totalMinor} ${yInv?.status})`,
    !yErr && Number(yInv?.amountDueMinor) === quoted && yInv?.status === "paid",
  );
}

await app.close();
await closeDb();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

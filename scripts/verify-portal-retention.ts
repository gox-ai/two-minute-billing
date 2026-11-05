/**
 * verify:portal-retention — the portal cancel flow: reason, offers, cancel.
 *
 * Unset = today's flow (an optional reason, no offers). With the settings on: each offer is a
 * real engine action (pause with a resume date, a scheduled cheaper plan, a coupon, a link),
 * "offer once" holds, a required reason is enforced, and cancellations are recorded.
 */
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createProduct, createPrice, setItemApplicablePlans } from "@/modules/catalog/service";
import { createCoupon } from "@/modules/coupons/service";
import { createPortalSession } from "@/modules/customer-portal/service";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";
import { resolveReport } from "@/modules/metrics/reports/resolve";
import {
  businesses,
  customers,
  invoices,
  retentionEvents,
  scheduledChanges,
  subscriptionItems,
  subscriptions,
} from "@db/schema";
import { and } from "drizzle-orm";
import { runWithClockScope } from "@/platform/clock";
import { applyDueScheduledChanges } from "@/modules/subscriptions/scheduled-changes";
import { changeSubscription } from "@/modules/subscriptions/proration";

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
const body = (r: { body: string }) => JSON.parse(r.body);

const org = await createOrganization({ name: "Retention Co" });
const orgId = org.organization.id;
// A test business comes with its TM Test gateway.
const biz = await createBusiness({
  organizationId: orgId,
  name: "Retention Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
const plan = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Team",
  kind: "plan",
});
const team = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: plan.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 4900,
  interval: "month",
});
const lite = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: plan.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 1900,
  interval: "month",
});
await createCoupon({
  organizationId: orgId,
  businessId: biz.id,
  code: "STAY30",
  kind: "percentage",
  percentOffBps: 3000,
  durationType: "repeating",
  durationInPeriods: 3,
});

const address = {
  line1: "1 Market St",
  city: "San Francisco",
  state: "California",
  state_code: "CA",
  postal_code: "94105",
  country: "US",
  first_name: "Sam",
  last_name: "Rivera",
};
const buyer = async (email: string) => {
  const mint = body(
    await app.inject({
      method: "POST",
      url: `/v1/businesses/${biz.publicId}/checkout_sessions`,
      headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": crypto.randomUUID() },
      payload: { price: team.publicId },
    }),
  ) as { token: string };
  const as = (path: string, payload: object) =>
    app.inject({
      method: "POST",
      url: path,
      headers: { authorization: `Bearer ${mint.token}`, "idempotency-key": crypto.randomUUID() },
      payload,
    });
  await as("/checkout/v1/customer", { email, address });
  const done = body(await as("/checkout/v1/complete", { token: "tok_4242" })) as {
    subscription_id: string;
    customer_id: string;
  };
  const [cus] = await withTenant(orgId, (tx) =>
    tx.select().from(customers).where(eq(customers.publicId, done.customer_id)),
  );
  const session = await createPortalSession({
    organizationId: orgId,
    businessId: biz.id,
    customerId: cus!.id,
  });
  const ex = body(
    await app.inject({
      method: "POST",
      url: "/portal/v1/session",
      headers: { authorization: `Bearer ${session.accessToken}` },
    }),
  ) as { token: string };
  return { sub: done.subscription_id, token: ex.token, customerId: cus!.id };
};
const portal = (token: string, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method !== "GET" ? { "idempotency-key": crypto.randomUUID() } : {}),
    },
    ...(payload ? { payload } : {}),
  });
const flow = async (b: { token: string; sub: string }) =>
  body(await portal(b.token, "GET", `/portal/v1/subscriptions/${b.sub}/cancel_flow`));
const take = (b: { token: string; sub: string }, payload: object) =>
  portal(b.token, "POST", `/portal/v1/subscriptions/${b.sub}/retention_offer`, payload);
const cancel = (b: { token: string; sub: string }, payload: object = {}) =>
  portal(b.token, "POST", `/portal/v1/subscriptions/${b.sub}/cancel`, payload);
const setConfig = (cfg: Record<string, unknown>) =>
  withTenant(orgId, (tx) =>
    tx.update(businesses).set({ storefrontConfig: cfg }).where(eq(businesses.id, biz.id)),
  );
const subRow = (publicId: string) =>
  withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.publicId, publicId)),
  ).then((r) => r[0]!);
const events = (customerId: string) =>
  withTenant(orgId, (tx) =>
    tx.select().from(retentionEvents).where(eq(retentionEvents.customerId, customerId)),
  );

// ── Cancel off: no flow ─────────────────────────────────────────────────────
const a = await buyer("ret-a@example.com");
ok(
  "cancel off → the flow answers 403",
  (await portal(a.token, "GET", `/portal/v1/subscriptions/${a.sub}/cancel_flow`)).statusCode ===
    403,
);

// ── Unset = today: optional reason, no offers ───────────────────────────────
await setConfig({ allow_cancel_subscription: true, cancel_timing: "end_of_term" });
const f0 = await flow(a);
ok(
  "unset: reason is optional and reasons are listed",
  f0.reason === "optional" && f0.reasons.length > 0,
);
ok("unset: no offers", Array.isArray(f0.offers) && f0.offers.length === 0);
ok("unset: customers cannot undo (allow_reactivate off)", f0.can_undo === false);

// ── All offers on ───────────────────────────────────────────────────────────
await setConfig({
  allow_cancel_subscription: true,
  cancel_timing: "end_of_term",
  retention_pause: true,
  retention_pause_months: 3,
  retention_pause_choice: true,
  retention_downgrade_price: lite.publicId,
  retention_coupon: "STAY30",
  retention_contact_url: "https://help.example.com/contact",
});
const f1 = await flow(a);
const kinds = (f1.offers as Array<{ offer: string }>)
  .map((o) => o.offer)
  .sort()
  .join(",");
ok("all four offers are made", kinds === "contact,discount,downgrade,pause");
const discount = (f1.offers as Array<{ offer: string; summary?: string }>).find(
  (o) => o.offer === "discount",
);
ok(
  "the discount is described from the coupon",
  discount?.summary === "30% off on your next 3 payments",
);
ok(
  "a pause longer than allowed → 400",
  (await take(a, { offer: "pause", months: 4 })).statusCode === 400,
);

const paused = await take(a, { offer: "pause", months: 2 });
ok("take the pause → 200", paused.statusCode === 200);
const pausedRow = await subRow(a.sub);
ok("the subscription is paused", pausedRow.status === "paused");
const resumeAt = body(paused).resume_scheduled_at;
ok(
  "the resume is scheduled about 2 months out",
  !!resumeAt &&
    Math.abs(new Date(resumeAt).getTime() - Date.now() - 60 * 86_400_000) < 2 * 86_400_000,
);
ok(
  "the offer is recorded",
  (await events(a.customerId)).some((e) => e.kind === "offer_accepted" && e.offer === "pause"),
);
ok("offer once: no more offers for this customer", (await flow(a)).offers.length === 0);
ok(
  "an offer the flow no longer makes → 409",
  (await take(a, { offer: "discount" })).statusCode === 409,
);

// Paused by the offer: the card shows the resume date, and the customer may resume it even
// though the business has pause/resume off.
const listed = (token: string, sub: string) =>
  portal(token, "GET", "/portal/v1/subscriptions").then((r) =>
    (body(r).data as Array<Record<string, any>>).find((x) => x.id === sub)!,
  );
const aCard = await listed(a.token, a.sub);
ok("paused: the card carries the resume date", !!aCard.paused?.resumes_at);
ok("paused by the offer: resume is offered", aCard.actions?.resume === true);
const pf = await flow(a);
ok(
  "paused: the flow cancels now and offers no undo",
  pf.timing === "immediately" && pf.can_undo === false,
);
ok(
  "paused by the offer: resume → 200",
  (await portal(a.token, "POST", `/portal/v1/subscriptions/${a.sub}/resume`, {})).statusCode ===
    200,
);
ok("resumed: the subscription is active", (await subRow(a.sub)).status === "active");
// The pause's scheduled resume goes with a manual resume; past its date nothing happens.
const aRow = await subRow(a.sub);
const aResumes = await withTenant(orgId, (tx) =>
  tx
    .select()
    .from(scheduledChanges)
    .where(and(eq(scheduledChanges.subscriptionId, aRow.id), eq(scheduledChanges.type, "resume"))),
);
ok(
  "manual resume: the scheduled resume is canceled",
  aResumes.length === 1 && aResumes[0]!.status === "canceled",
);
const aInvoices = async () =>
  (
    await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.subscriptionId, aRow.id)),
    )
  ).length;
const aBefore = await aInvoices();
const past = new Date(new Date(resumeAt).getTime() + 86_400_000);
await runWithClockScope({ onlyBusinessId: biz.id, now: past }, () =>
  applyDueScheduledChanges(past),
);
const aAfter = await subRow(a.sub);
ok(
  "past the old resume date: nothing changes and nothing is billed",
  aAfter.status === "active" &&
    String(aAfter.currentPeriodEnd) === String(aRow.currentPeriodEnd) &&
    (await aInvoices()) === aBefore,
);

// A pause the business sets later is not the customer's to end, offer or not.
const merchantPause = await app.inject({
  method: "POST",
  url: `/v1/businesses/${biz.publicId}/subscriptions/${a.sub}/pause`,
  headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": crypto.randomUUID() },
  payload: { pause_option: "immediately" },
});
ok("the business pauses the same subscription → 200", merchantPause.statusCode === 200);
ok(
  "a business pause is recorded as the operator's",
  (await subRow(a.sub)).pauseSource === "operator",
);
ok(
  "business pause after an earlier offer: resume is not offered",
  (await listed(a.token, a.sub)).actions?.resume === false,
);
ok(
  "business pause after an earlier offer: resume → 403, still paused",
  (await portal(a.token, "POST", `/portal/v1/subscriptions/${a.sub}/resume`, {})).statusCode ===
    403 && (await subRow(a.sub)).status === "paused",
);

// ── Downgrade and discount on other customers ───────────────────────────────
const b = await buyer("ret-b@example.com");
const down = body(await take(b, { offer: "downgrade" }));
ok(
  "take the downgrade → scheduled for the term end",
  down.starts === "end_of_term" && !!down.scheduled_change,
);
const c = await buyer("ret-c@example.com");
const disc = await take(c, { offer: "discount" });
ok("take the discount → 200", disc.statusCode === 200);
ok(
  "the discount answer describes it and does not show the code",
  body(disc).summary === "30% off on your next 3 payments" && !("coupon" in body(disc)),
);
// A scheduled plan change is not offered again as the downgrade offer.
await setConfig({
  allow_cancel_subscription: true,
  cancel_timing: "end_of_term",
  retention_pause: true,
  retention_downgrade_price: lite.publicId,
  retention_offer_once: false,
});
const bKinds = ((await flow(b)).offers as Array<{ offer: string }>).map((o) => o.offer);
ok(
  "downgrade scheduled: no downgrade offer, pause still offered",
  !bKinds.includes("downgrade") && bKinds.includes("pause"),
);
await setConfig({
  allow_cancel_subscription: true,
  cancel_timing: "end_of_term",
  retention_pause: true,
  retention_pause_months: 3,
  retention_downgrade_price: lite.publicId,
  retention_coupon: "STAY30",
  retention_contact_url: "https://help.example.com/contact",
});
const d = await buyer("ret-d@example.com");
const contact = body(await take(d, { offer: "contact" }));
ok("take contact → the merchant's URL", contact.url === "https://help.example.com/contact");

// The retention coupon comes only from the accepted offer: every coupon box refuses it.
await withTenant(orgId, (tx) =>
  tx.update(businesses).set({ allowCustomerCoupons: true }).where(eq(businesses.id, biz.id)),
);
await createCoupon({
  organizationId: orgId,
  businessId: biz.id,
  code: "WELCOME10",
  kind: "percentage",
  percentOffBps: 1000,
  durationType: "forever",
});
const portalCoupon = (code: string) =>
  portal(d.token, "POST", `/portal/v1/subscriptions/${d.sub}/coupon`, { code });
const typedRetention = await portalCoupon("STAY30");
ok(
  "portal coupon box: the retention coupon → 400 not available",
  typedRetention.statusCode === 400 &&
    body(typedRetention).error?.message ===
      "We could not apply this coupon. It is not available here.",
);
ok(
  "portal coupon box: another coupon still applies",
  (await portalCoupon("WELCOME10")).statusCode === 200,
);
const checkoutToken = (
  body(
    await app.inject({
      method: "POST",
      url: `/v1/businesses/${biz.publicId}/checkout_sessions`,
      headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": crypto.randomUUID() },
      payload: { price: team.publicId },
    }),
  ) as { token: string }
).token;
const checkoutCoupon = (code: string) =>
  app.inject({
    method: "POST",
    url: "/checkout/v1/coupon",
    headers: { authorization: `Bearer ${checkoutToken}` },
    payload: { code },
  });
const checkoutTyped = await checkoutCoupon("STAY30");
ok(
  "checkout coupon box: the retention coupon → 400 not available",
  checkoutTyped.statusCode === 400 &&
    body(checkoutTyped).error?.message ===
      "We could not apply this coupon. It is not available here.",
);
ok(
  "checkout coupon box: another coupon still applies",
  (await checkoutCoupon("WELCOME10")).statusCode === 200,
);
const mintedWith = await app.inject({
  method: "POST",
  url: `/v1/businesses/${biz.publicId}/checkout_sessions`,
  headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": crypto.randomUUID() },
  payload: { price: team.publicId, coupons: ["STAY30"] },
});
ok("a checkout page cannot carry the retention coupon → 4xx", mintedWith.statusCode >= 400);

// ── Required reason, and the cancel record ──────────────────────────────────
const e = await buyer("ret-e@example.com");
await setConfig({
  allow_cancel_subscription: true,
  cancel_timing: "end_of_term",
  cancel_reason: "required",
});
ok("required reason: cancel without one → 400", (await cancel(e)).statusCode === 400);
const reason = (await flow(e)).reasons[0].code as string;
const cancelled = await cancel(e, { reason_code: reason, offers_shown: true });
ok("required reason: cancel with one → 200", cancelled.statusCode === 200);
ok(
  "the cancellation is recorded with its reason and that offers were shown",
  (await events(e.customerId)).some(
    (x) => x.kind === "cancelled" && x.reasonCode === reason && x.offersShown,
  ),
);
await setConfig({ allow_cancel_subscription: true, cancel_timing: "end_of_term" });
const g = await buyer("ret-g@example.com");
ok("unset: cancel without a reason → 200 (today's flow)", (await cancel(g)).statusCode === 200);

// A save is revoked by a cancel within 30 days: c took the discount, then cancels.
ok("c cancels after taking the discount → 200", (await cancel(c)).statusCode === 200);
// A paused subscription has no term end: with end-of-term timing it still cancels, now.
await setConfig({
  allow_cancel_subscription: true,
  cancel_timing: "end_of_term",
  retention_pause: true,
});
const h = await buyer("ret-h@example.com");
ok("h takes the pause → 200", (await take(h, { offer: "pause" })).statusCode === 200);
ok("paused + end-of-term timing: cancel → 200", (await cancel(h)).statusCode === 200);
ok("the paused subscription is cancelled now", (await subRow(h.sub)).status === "cancelled");
await setConfig({ allow_cancel_subscription: true, cancel_timing: "end_of_term" });

// ── The saves report ────────────────────────────────────────────────────────
const saves = await resolveReport(orgId, biz.id, "cancellation_saves", { range: "12m" });
console.log("  saves:", saves.headline, JSON.stringify(saves.rows));
// Saves a (pause, resumed), b (downgrade), d (contact); lost c and h (revoked) and e (shown).
ok(
  "saves: 3 kept of 6 decided = 50%; a cancel within 30 days revokes the save",
  saves.headline === 5000,
);
ok("saves: one row per offer kept (pause, downgrade, contact)", (saves.rows ?? []).length === 3);

// Offer once holds under parallel requests: one offer wins, the others are refused.
// After the saves report, so this buyer's save does not count there.
await setConfig({
  allow_cancel_subscription: true,
  cancel_timing: "end_of_term",
  retention_pause: true,
  retention_pause_months: 3,
  retention_coupon: "STAY30",
  retention_contact_url: "https://help.example.com/contact",
});
const r = await buyer("ret-race@example.com");
const raced = await Promise.all([
  take(r, { offer: "pause" }),
  take(r, { offer: "discount" }),
  take(r, { offer: "contact" }),
]);
ok(
  "parallel offers: exactly one is taken",
  raced.filter((x) => x.statusCode === 200).length === 1 &&
    raced.filter((x) => x.statusCode === 409).length === 2,
);
ok(
  "parallel offers: one offer is recorded",
  (await events(r.customerId)).filter((x) => x.kind === "offer_accepted").length === 1,
);

// ── A cheaper plan that brings a mandatory add-on ───────────────────────────
// The offer states the plan plus the add-on, and the scheduled change names the add-on.
const basic = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Basic",
  kind: "plan",
});
const basicMonthly = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: basic.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 1500,
  interval: "month",
});
const support = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Support fee",
  kind: "addon",
});
const supportMonthly = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: support.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 300,
  interval: "month",
});
await setItemApplicablePlans({
  organizationId: orgId,
  businessId: biz.id,
  itemPublicId: support.publicId,
  planPublicIds: [basic.publicId],
  applicability: { [basic.publicId]: "mandatory" },
});
await setConfig({
  allow_cancel_subscription: true,
  cancel_timing: "end_of_term",
  retention_downgrade_price: basicMonthly.publicId,
});
const k = await buyer("ret-k@example.com");
const kOffer = (
  (await flow(k)).offers as Array<{ offer: string; amount_minor?: number; includes?: string[] }>
).find((o) => o.offer === "downgrade");
ok(
  "downgrade offer: the price includes the mandatory add-on (1500 + 300)",
  kOffer?.amount_minor === 1800 && kOffer?.includes?.[0] === "Support fee",
);
const kDown = body(await take(k, { offer: "downgrade" }));
const [kRow] = await withTenant(orgId, (tx) =>
  tx.select().from(scheduledChanges).where(eq(scheduledChanges.publicId, kDown.scheduled_change)),
);
const kAdds =
  (kRow?.payload as { adds?: Array<{ priceId: string; autoIncluded?: boolean }> } | null)?.adds ??
  [];
ok(
  "downgrade offer: the scheduled change names the mandatory add-on",
  kAdds.some((a) => a.priceId === supportMonthly.publicId && a.autoIncluded === true),
);

// ── The offer prices what the renewal after the switch bills ────────────────
// Held + stays (an optional add-on), held + dropped (Team's own mandatory add-on), and
// brought (Basic's mandatory Support fee).
const seatPack = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Seat pack",
  kind: "addon",
});
const seatPackMonthly = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: seatPack.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 500,
  interval: "month",
});
await setItemApplicablePlans({
  organizationId: orgId,
  businessId: biz.id,
  itemPublicId: seatPack.publicId,
  planPublicIds: [plan.publicId],
});
const teamFee = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Team fee",
  kind: "addon",
});
const teamFeeMonthly = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: teamFee.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 200,
  interval: "month",
});
await setItemApplicablePlans({
  organizationId: orgId,
  businessId: biz.id,
  itemPublicId: teamFee.publicId,
  planPublicIds: [plan.publicId],
  applicability: { [plan.publicId]: "mandatory" },
});
const h2 = await buyer("ret-held@example.com");
const h2Row = await subRow(h2.sub);
const h2Items = () =>
  withTenant(orgId, (tx) =>
    tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, h2Row.id)),
  );
await changeSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: h2Row.id,
  now: new Date(),
  changes: [],
  adds: [{ priceId: seatPackMonthly.publicId, quantity: 1 }],
  invoiceImmediately: false,
});
const feeItem = (await h2Items()).find((i) => i.priceId === teamFeeMonthly.id);
ok("setup: Team's mandatory fee is on the subscription", !!feeItem);
const hOffer = (
  (await flow(h2)).offers as Array<{ offer: string; amount_minor?: number; includes?: string[] }>
).find((o) => o.offer === "downgrade");
console.log("  held offer:", JSON.stringify(hOffer));
ok(
  "offer price = Basic 1500 + Seat pack 500 (held, stays) + Support fee 300 (brought); Team fee dropped",
  hOffer?.amount_minor === 2300,
);
ok(
  "offer names the add-ons it includes, not the dropped one",
  !!hOffer?.includes?.includes("Seat pack") &&
    !!hOffer?.includes?.includes("Support fee") &&
    !hOffer?.includes?.includes("Team fee"),
);
const hDown = body(await take(h2, { offer: "downgrade" }));
const [hSched] = await withTenant(orgId, (tx) =>
  tx.select().from(scheduledChanges).where(eq(scheduledChanges.publicId, hDown.scheduled_change)),
);
const hPayload = hSched?.payload as {
  removes?: string[];
  adds?: Array<{ priceId: string }>;
} | null;
ok(
  "the booking removes the dropped add-on and adds the brought one",
  !!hPayload?.removes?.includes(feeItem!.publicId) &&
    !!hPayload?.adds?.some((x) => x.priceId === supportMonthly.publicId),
);

// ── Ownership ───────────────────────────────────────────────────────────────
ok(
  "another customer's subscription → 404",
  (await portal(a.token, "GET", `/portal/v1/subscriptions/${b.sub}/cancel_flow`)).statusCode ===
    404,
);

console.log(`\n${pass} passed, ${fail} failed`);
await app.close();
await closeDb();
process.exit(fail ? 1 : 0);

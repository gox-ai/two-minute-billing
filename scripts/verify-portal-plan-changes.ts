/**
 * verify:portal-plan-changes — plan, seat and add-on changes from the customer portal.
 *
 * Drives a real subscription (created through hosted checkout) over the portal routes:
 * the options, the settings that gate them, the preview, the apply with its stale-price
 * guard, a downgrade scheduled for the term end and its withdrawal, the shorter-period
 * rule and the ownership scope.
 */
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createProduct, createPrice, setItemApplicablePlans } from "@/modules/catalog/service";
import { createPortalSession } from "@/modules/customer-portal/service";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";
import {
  businesses,
  customers,
  products,
  subscriptionItems,
  subscriptions,
  unbilledCharges,
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
const body = (r: { body: string }) => JSON.parse(r.body);

const org = await createOrganization({ name: "Plan Change Co" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Plan Change Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
// A test business is created with its TM Test gateway.
const product = (name: string, kind: "plan" | "addon", enabledInPortal = true) =>
  createProduct({ organizationId: orgId, businessId: biz.id, name, kind, enabledInPortal });
const recurring = (
  productId: string,
  model: "flat" | "per_unit",
  amountMinor: number,
  interval: "month" | "year",
) =>
  createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId,
    type: "recurring",
    model,
    currency: "USD",
    amountMinor,
    interval,
  });
const team = await product("Team", "plan");
const teamMonthly = await recurring(team.id, "per_unit", 1000, "month");
const teamYearly = await recurring(team.id, "per_unit", 10000, "year");
const starter = await product("Starter", "plan");
const starterMonthly = await recurring(starter.id, "flat", 1900, "month");
const hidden = await product("Hidden", "plan", false);
const hiddenMonthly = await recurring(hidden.id, "flat", 900, "month");
const trialPlan = await product("Trial Team", "plan");
const trialMonthly = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: trialPlan.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 3000,
  interval: "month",
  trialPeriod: 14,
  trialPeriodUnit: "day",
});
const trialCheap = await recurring(trialPlan.id, "flat", 1500, "month");
const priority = await product("Priority support", "addon");
const priorityMonthly = await recurring(priority.id, "flat", 500, "month");
// The portal offers an add-on only on the plans it attaches to. No limits = today.
const attach = (
  addon: { publicId: string },
  plans: Array<{ publicId: string }>,
  extra: Partial<Parameters<typeof setItemApplicablePlans>[0]> = {},
) =>
  setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: addon.publicId,
    planPublicIds: plans.map((x) => x.publicId),
    ...extra,
  });
await attach(priority, [team]);

// ── A real subscription, through hosted checkout ────────────────────────────
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
const buyer = async (email: string, price = teamMonthly.publicId) => {
  const mint = body(
    await app.inject({
      method: "POST",
      url: `/v1/businesses/${biz.publicId}/checkout_sessions`,
      headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": crypto.randomUUID() },
      payload: { price, quantity: 1 },
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
  const exchanged = body(
    await app.inject({
      method: "POST",
      url: "/portal/v1/session",
      headers: { authorization: `Bearer ${session.accessToken}` },
    }),
  ) as { token: string };
  return { sub: done.subscription_id, token: exchanged.token };
};
const a = await buyer("plans-a@example.com");
const b = await buyer("plans-b@example.com");
const t = await buyer("plans-trial@example.com", trialMonthly.publicId);

const portal = (token: string, method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method !== "GET" ? { "idempotency-key": crypto.randomUUID() } : {}),
    },
    ...(payload ? { payload } : {}),
  });
const options = async (t = a.token, sub = a.sub) =>
  body(await portal(t, "GET", `/portal/v1/subscriptions/${sub}/change_options`));
const preview = (payload: object, t = a.token, sub = a.sub) =>
  portal(t, "POST", `/portal/v1/subscriptions/${sub}/change/preview`, payload);
const apply = (payload: object, t = a.token, sub = a.sub) =>
  portal(t, "POST", `/portal/v1/subscriptions/${sub}/change`, payload);
const setConfig = (cfg: Record<string, unknown>) =>
  withTenant(orgId, (tx) =>
    tx.update(businesses).set({ storefrontConfig: cfg }).where(eq(businesses.id, biz.id)),
  );
const planItem = async () =>
  withTenant(orgId, async (tx) => {
    const [s] = await tx.select().from(subscriptions).where(eq(subscriptions.publicId, a.sub));
    return tx
      .select()
      .from(subscriptionItems)
      .where(and(eq(subscriptionItems.subscriptionId, s!.id)));
  });

// ── Off by default ──────────────────────────────────────────────────────────
const off = await options();
ok("plan changes are off by default", off.allowed === false && !!off.unavailable_reason);
ok("a preview while off → 403", (await preview({ seats: 2 })).statusCode === 403);

await setConfig({
  allow_plan_changes: true,
  seat_changes: "both",
  allow_addon_changes: true,
  shorter_period: "after_12_months",
});

// ── Options ─────────────────────────────────────────────────────────────────
const o1 = await options();
const planIds = (o1.plans as Array<{ price: string }>).map((p) => p.price);
ok("options: allowed once switched on", o1.allowed === true);
ok(
  "options: plans shown in the portal are listed, the hidden one is not",
  planIds.includes(teamMonthly.publicId) &&
    planIds.includes(teamYearly.publicId) &&
    planIds.includes(starterMonthly.publicId) &&
    !planIds.includes(hiddenMonthly.publicId),
);
ok(
  "options: the current plan is marked",
  (o1.plans as Array<{ price: string; current: boolean }>).find((p) => p.current)?.price ===
    teamMonthly.publicId,
);
ok(
  "options: seats for a per-unit plan (current 1, decreases allowed)",
  o1.seats?.current === 1 && o1.seats?.decrease_allowed === true,
);
ok(
  "options: the add-on is offered at quantity 0",
  (o1.addons as Array<{ price: string; quantity: number }>).some(
    (x) => x.price === priorityMonthly.publicId && x.quantity === 0,
  ),
);
ok(
  "options: today's timing — upgrade now, downgrade at term end",
  o1.timing.upgrade.default === "now" && o1.timing.downgrade.default === "end_of_term",
);

// ── Upgrade: more seats, now ────────────────────────────────────────────────
// Without proration (the business default) a seat increase bills nothing now.
const p0 = body(await preview({ seats: 3 }));
ok(
  "proration off → an upgrade has nothing to pay today",
  p0.direction === "upgrade" && p0.total_minor === 0,
);
await withTenant(orgId, (tx) =>
  tx.update(businesses).set({ defaultProrateOnChange: true }).where(eq(businesses.id, biz.id)),
);
// The business rule adds change charges to the next invoice: the preview must say so.
const deferred = body(await preview({ seats: 3 }));
ok(
  "change charges deferred by the business rule → nothing due today, added to the next invoice",
  deferred.total_minor === 0 && deferred.due_today?.added_to_next_invoice === true,
);
await setConfig({
  allow_plan_changes: true,
  seat_changes: "both",
  allow_addon_changes: true,
  shorter_period: "after_12_months",
  charge_upgrade: "now",
});
const p1 = body(await preview({ seats: 3 }));
console.log(
  "  seats preview:",
  JSON.stringify({ d: p1.direction, t: p1.timing, total: p1.total_minor }),
);
ok(
  "more seats → upgrade, now, something to pay",
  p1.direction === "upgrade" && p1.timing === "now" && p1.total_minor > 0,
);
const stale = await apply({ seats: 3, expected_total_minor: p1.total_minor + 1 });
ok("apply with a total that moved → 409", stale.statusCode === 409);
const a1 = await apply({ seats: 3, expected_total_minor: p1.total_minor });
ok("apply the upgrade → 200 with its invoice", a1.statusCode === 200 && !!body(a1).invoice?.id);
ok(
  "the plan item now has 3 seats",
  (await planItem()).some((i) => i.quantity === 3),
);

// ── Add an add-on ───────────────────────────────────────────────────────────
const p2 = body(await preview({ addons: [{ price: priorityMonthly.publicId, quantity: 1 }] }));
ok(
  "adding an add-on is priced (the preview includes the addition)",
  p2.direction === "upgrade" && p2.total_minor > 0,
);
const a2 = await apply({
  addons: [{ price: priorityMonthly.publicId, quantity: 1 }],
  expected_total_minor: p2.total_minor,
});
ok("apply the add-on → 200", a2.statusCode === 200);
ok("the add-on is on the subscription", (await planItem()).length === 2);

// ── Downgrade: fewer seats, at term end, then withdraw ──────────────────────
const p3 = body(await preview({ seats: 2 }));
ok(
  "fewer seats → downgrade at term end, nothing to pay today",
  p3.direction === "downgrade" && p3.timing === "end_of_term" && p3.total_minor === 0,
);
ok(
  "asking a downgrade to start now → 400",
  (await preview({ seats: 2, timing: "now" })).statusCode === 400,
);
const a3 = body(await apply({ seats: 2, expected_total_minor: 0 }));
ok("apply the downgrade → a scheduled change", !!a3.scheduled_change?.id);
ok(
  "seats unchanged until the term ends",
  (await planItem()).some((i) => i.quantity === 3),
);
ok(
  "options show the scheduled change",
  (await options()).scheduled_change?.id === a3.scheduled_change.id,
);
const withdrawn = await portal(
  a.token,
  "DELETE",
  `/portal/v1/subscriptions/${a.sub}/scheduled_change`,
);
ok("withdraw the scheduled change → 200", withdrawn.statusCode === 200);
ok("no scheduled change left", (await options()).scheduled_change === null);

// ── Refusals ────────────────────────────────────────────────────────────────
ok(
  "a plan not shown in the portal → 400",
  (await preview({ plan: hiddenMonthly.publicId })).statusCode === 400,
);
ok("nothing changed → 400", (await preview({ seats: 3 })).statusCode === 400);
await setConfig({
  allow_plan_changes: true,
  seat_changes: "increase",
  allow_addon_changes: true,
  shorter_period: "after_12_months",
  charge_upgrade: "now",
});
ok("seat decreases off → 400", (await preview({ seats: 2 })).statusCode === 400);
ok(
  "another customer's subscription → 404",
  (await preview({ seats: 2 }, a.token, b.sub)).statusCode === 404,
);

// ── Shorter billing period after 12 months ──────────────────────────────────
const toYear = body(await preview({ plan: teamYearly.publicId }));
const yearly = await apply({ plan: teamYearly.publicId, expected_total_minor: toYear.total_minor });
ok(
  "monthly → yearly is an upgrade, charged now",
  toYear.direction === "upgrade" && toYear.timing === "now" && yearly.statusCode === 200,
);
const o2 = await options();
ok(
  "on yearly, the monthly plan is not offered before 12 months",
  !(o2.plans as Array<{ price: string }>).some((p) => p.price === teamMonthly.publicId),
);
ok(
  "previewing the monthly plan → 400",
  (await preview({ plan: teamMonthly.publicId })).statusCode === 400,
);

// ── In trial: every change applies now, nothing to pay ──────────────────────
const tOpts = await options(t.token, t.sub);
ok("in trial: options carry the trial end", typeof tOpts.trial_end === "string");
const tPrev = body(await preview({ plan: trialCheap.publicId }, t.token, t.sub));
ok(
  "in trial: a downgrade applies now with nothing to pay",
  tPrev.direction === "downgrade" &&
    tPrev.timing === "now" &&
    tPrev.total_minor === 0 &&
    !!tPrev.trial_end,
);
const tApply = await apply({ plan: trialCheap.publicId, expected_total_minor: 0 }, t.token, t.sub);
ok(
  "in trial: the downgrade applies → 200, no scheduled change",
  tApply.statusCode === 200 && body(tApply).scheduled_change === null,
);

// ── A cancelling subscription cannot change ─────────────────────────────────
await withTenant(orgId, (tx) =>
  tx
    .update(subscriptions)
    .set({ cancelAtPeriodEnd: true })
    .where(eq(subscriptions.publicId, b.sub)),
);
ok("a subscription set to cancel cannot change", (await options(b.token, b.sub)).allowed === false);

// ── Add-ons follow the plan, with portal-only limits ────────────────────────
const storage = await product("Extra storage", "addon");
const storageMonthly = await recurring(storage.id, "per_unit", 200, "month");
const onboarding = await product("Onboarding pack", "addon");
const onboardingMonthly = await recurring(onboarding.id, "flat", 300, "month");
const extras = await product("Starter extras", "addon");
const extrasMonthly = await recurring(extras.id, "flat", 400, "month");
const fee = await product("Platform fee", "addon");
const feeMonthly = await recurring(fee.id, "flat", 100, "month");
await attach(storage, [team], {
  config: {
    [team.publicId]: { minQuantity: 2, maxQuantity: 10, quantityStep: 2, defaultQuantity: 2 },
  },
});
await attach(onboarding, [team], {
  config: { [team.publicId]: { customerCanChangeQuantity: false } },
});
await attach(extras, [starter]);
await attach(fee, [starter], { applicability: { [starter.publicId]: "mandatory" } });
const studio = await product("Studio", "plan");
const studioMonthly = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: studio.id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  amountMinor: 800,
  interval: "month",
  portalMinQuantity: 5,
  portalMaxQuantity: 20,
});
await setConfig({ allow_plan_changes: true, seat_changes: "both", allow_addon_changes: true });

const c = await buyer("plans-c@example.com");
const oc = await options(c.token, c.sub);
type Addon = { price: string; rules: Record<string, { mandatory: boolean; min: number | null }> };
const addonOf = (price: string) => (oc.addons as Addon[]).find((x) => x.price === price);
ok(
  "rules: an add-on attached to Team carries a Team rule",
  !!addonOf(priorityMonthly.publicId)?.rules[teamMonthly.publicId],
);
ok(
  "rules: an add-on attached only to Starter has no Team rule",
  !addonOf(extrasMonthly.publicId)?.rules[teamMonthly.publicId] &&
    !!addonOf(extrasMonthly.publicId)?.rules[starterMonthly.publicId],
);
ok(
  "rules: a mandatory add-on is marked on its plan",
  addonOf(feeMonthly.publicId)?.rules[starterMonthly.publicId]?.mandatory === true,
);
ok(
  "seats: a plan price's own limits are listed",
  oc.seats?.by_plan?.[studioMonthly.publicId]?.min === 5 &&
    oc.seats?.by_plan?.[studioMonthly.publicId]?.max === 20,
);

const pc = (payload: object) => preview(payload, c.token, c.sub);
const addonQ = (price: string, quantity: number) => pc({ addons: [{ price, quantity }] });
ok(
  "an add-on the plan does not take → 400",
  (await addonQ(extrasMonthly.publicId, 1)).statusCode === 400,
);
ok("below the minimum → 400", (await addonQ(storageMonthly.publicId, 1)).statusCode === 400);
ok("off the step → 400", (await addonQ(storageMonthly.publicId, 3)).statusCode === 400);
ok("above the maximum → 400", (await addonQ(storageMonthly.publicId, 12)).statusCode === 400);
ok("inside the limits → 200", (await addonQ(storageMonthly.publicId, 4)).statusCode === 200);
ok(
  "fixed quantity: another quantity → 400",
  (await addonQ(onboardingMonthly.publicId, 2)).statusCode === 400,
);
ok(
  "fixed quantity: the default quantity → 200",
  (await addonQ(onboardingMonthly.publicId, 1)).statusCode === 200,
);
ok(
  "no limits set: any quantity → 200 (today)",
  (await addonQ(priorityMonthly.publicId, 7)).statusCode === 200,
);

// A plan switch: add-ons the new plan does not take must go.
const pa = body(await pc({ addons: [{ price: priorityMonthly.publicId, quantity: 1 }] }));
await apply(
  {
    addons: [{ price: priorityMonthly.publicId, quantity: 1 }],
    expected_total_minor: pa.total_minor,
  },
  c.token,
  c.sub,
);
const keep = await pc({ plan: starterMonthly.publicId });
ok(
  "switch with an add-on the new plan does not take → 400",
  keep.statusCode === 400 && /Remove it first/.test(body(keep).error?.message ?? ""),
);
ok(
  "switch that removes it → 200",
  (
    await pc({
      plan: starterMonthly.publicId,
      addons: [{ price: priorityMonthly.publicId, quantity: 0 }],
    })
  ).statusCode === 200,
);

// A held add-on the business hides from the portal: remove only, in preview and apply.
const setPortal = (on: boolean) =>
  withTenant(orgId, (tx) =>
    tx.update(products).set({ enabledInPortal: on }).where(eq(products.id, priority.id)),
  );
await setPortal(false);
const heldHidden = ((await options(c.token, c.sub)).addons as Array<Record<string, unknown>>).find(
  (x) => x.price === priorityMonthly.publicId,
);
ok("hidden held add-on: listed as remove only", heldHidden?.remove_only === true);
const hiddenQ = { addons: [{ price: priorityMonthly.publicId, quantity: 3 }] };
const hiddenPreview = await pc(hiddenQ);
ok(
  "hidden held add-on: a quantity change → 400 in the preview",
  hiddenPreview.statusCode === 400 &&
    /You can remove it/.test(body(hiddenPreview).error?.message ?? ""),
);
ok(
  "hidden held add-on: a quantity change → 400 in the apply",
  (
    await apply(
      { ...hiddenQ, expected_total_minor: body(hiddenPreview).total_minor ?? 0 },
      c.token,
      c.sub,
    )
  ).statusCode === 400,
);
ok(
  "hidden held add-on: removing it → 200",
  (await addonQ(priorityMonthly.publicId, 0)).statusCode === 200,
);
await setPortal(true);

// Seat limits of the plan switched to.
const toStudio = (extra: object = {}) =>
  pc({
    plan: studioMonthly.publicId,
    addons: [{ price: priorityMonthly.publicId, quantity: 0 }],
    ...extra,
  });
const oneSeat = await toStudio();
ok(
  "switch to a 5–20 seat plan with 1 seat → 400",
  oneSeat.statusCode === 400 && /needs 5 to 20 seats/.test(body(oneSeat).error?.message ?? ""),
);
ok("… with 5 seats → 200", (await toStudio({ seats: 5 })).statusCode === 200);
ok("… with 25 seats → 400", (await toStudio({ seats: 25 })).statusCode === 400);

// A mandatory add-on cannot be removed.
const d = await buyer("plans-d@example.com", starterMonthly.publicId);
const dItems = await withTenant(orgId, async (tx) => {
  const [s] = await tx.select().from(subscriptions).where(eq(subscriptions.publicId, d.sub));
  return tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, s!.id));
});
console.log("  starter items:", dItems.length);
ok("checkout on Starter brings the mandatory add-on", dItems.length === 2);
ok(
  "removing the mandatory add-on → 400",
  (await preview({ addons: [{ price: feeMonthly.publicId, quantity: 0 }] }, d.token, d.sub))
    .statusCode === 400,
);

// ── Money: the preview is what the customer pays ────────────────────────────
// Starter brings a mandatory add-on (Platform fee). The preview must price it, and the
// charge must equal the previewed total.
await setConfig({
  allow_plan_changes: true,
  seat_changes: "both",
  allow_addon_changes: true,
  charge_upgrade: "now",
});
const m = await buyer("plans-money@example.com");
const mp = body(await preview({ plan: starterMonthly.publicId }, m.token, m.sub));
console.log(
  "  mandatory preview:",
  mp.total_minor,
  JSON.stringify(
    mp.due_today?.lines?.map((l: { description: string; amount_minor: number }) => [
      l.description,
      l.amount_minor,
    ]),
  ),
);
ok(
  "preview of a switch to a plan with a mandatory add-on prices the add-on",
  (mp.due_today?.lines ?? []).some(
    (l: { description: string; amount_minor: number }) =>
      l.amount_minor === 100 && /Prorated/.test(l.description),
  ),
);
const ma = await apply(
  { plan: starterMonthly.publicId, expected_total_minor: mp.total_minor },
  m.token,
  m.sub,
);
const maInv = body(ma).invoice as { amount_due_minor: number } | null;
console.log("  mandatory apply:", ma.statusCode, maInv?.amount_due_minor);
ok(
  "the charge equals the previewed total",
  ma.statusCode === 200 && mp.total_minor > 0 && maInv?.amount_due_minor === mp.total_minor,
);
const mItems = await withTenant(orgId, async (tx) => {
  const [s] = await tx.select().from(subscriptions).where(eq(subscriptions.publicId, m.sub));
  return tx
    .select({ priceId: subscriptionItems.priceId, metadata: subscriptionItems.metadata })
    .from(subscriptionItems)
    .where(eq(subscriptionItems.subscriptionId, s!.id));
});
ok(
  "the mandatory add-on is on the subscription, marked auto-included",
  mItems.some(
    (i) =>
      i.priceId === feeMonthly.id &&
      (i.metadata as { auto_included?: string } | null)?.auto_included === "mandatory",
  ),
);

// The engine refuses a change it would extend with items the caller did not name.
const n = await buyer("plans-strict@example.com");
const nRow = await withTenant(orgId, async (tx) => {
  const [s] = await tx.select().from(subscriptions).where(eq(subscriptions.publicId, n.sub));
  const items = await tx
    .select()
    .from(subscriptionItems)
    .where(eq(subscriptionItems.subscriptionId, s!.id));
  return { sub: s!, item: items[0]! };
});
let refused = "";
try {
  await changeSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: nRow.sub.id,
    now: new Date(),
    changes: [{ itemId: nRow.item.publicId, newPriceId: starterMonthly.publicId }],
    refuseUnrequestedItems: true,
  });
} catch (e) {
  refused = (e as Error).message;
}
ok("strict booking refuses an unnamed mandatory add-on", /did not include/.test(refused));
ok(
  "… and nothing changed",
  (
    await withTenant(orgId, (tx) =>
      tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, nRow.sub.id)),
    )
  ).length === 1,
);

// A quantity the new plan fixes is reset to that plan's quantity, not carried.
await attach(storage, [team, starter], {
  config: {
    [team.publicId]: { minQuantity: 2, maxQuantity: 10, quantityStep: 2, defaultQuantity: 2 },
    [starter.publicId]: { customerCanChangeQuantity: false, defaultQuantity: 2 },
  },
});
const q = await buyer("plans-qty@example.com");
const qp = body(
  await preview({ addons: [{ price: storageMonthly.publicId, quantity: 6 }] }, q.token, q.sub),
);
await apply(
  {
    addons: [{ price: storageMonthly.publicId, quantity: 6 }],
    expected_total_minor: qp.total_minor,
  },
  q.token,
  q.sub,
);
const qs = await preview(
  { plan: starterMonthly.publicId, addons: [{ price: storageMonthly.publicId, quantity: 2 }] },
  q.token,
  q.sub,
);
ok("switch that resets a fixed quantity to the plan's quantity → 200", qs.statusCode === 200);
const qn = await preview({ plan: starterMonthly.publicId }, q.token, q.sub);
ok("switch that does not name it → 200, the server resets it", qn.statusCode === 200);
ok(
  "a different quantity on the fixed plan → 400",
  (
    await preview(
      { plan: starterMonthly.publicId, addons: [{ price: storageMonthly.publicId, quantity: 4 }] },
      q.token,
      q.sub,
    )
  ).statusCode === 400,
);

// Seat limits follow the plan switched to (per-unit → per-unit).
const sq = await buyer("plans-seats@example.com");
const sOpts = await options(sq.token, sq.sub);
ok(
  "seats: the current plan uses the business limits, Studio its own",
  sOpts.seats?.min === 1 && sOpts.seats?.by_plan?.[studioMonthly.publicId]?.min === 5,
);
ok(
  "seats: 4 on Studio → 400",
  (await preview({ plan: studioMonthly.publicId, seats: 4 }, sq.token, sq.sub)).statusCode === 400,
);
ok(
  "seats: 20 on Studio → 200",
  (await preview({ plan: studioMonthly.publicId, seats: 20 }, sq.token, sq.sub)).statusCode === 200,
);

// ── A booking later than its preview books the previewed amounts ─────────────
// A large plan makes the unused-time credit move ~38 minor units a second, so a short
// wait shows it. Change charges are deferred (business default): total_minor is 0, so
// only the quote can see that the deferred amount moved.
await setConfig({ allow_plan_changes: true, seat_changes: "both", allow_addon_changes: true });
const big = await product("Enterprise", "plan");
const bigMonthly = await recurring(big.id, "flat", 100_000_000, "month");
const bigger = await product("Enterprise Plus", "plan");
const biggerMonthly = await recurring(bigger.id, "flat", 200_000_000, "month");
const unbilled = async (subPublicId: string) => {
  const [s] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.publicId, subPublicId)),
  );
  const rows = await withTenant(orgId, (tx) =>
    tx.select().from(unbilledCharges).where(eq(unbilledCharges.subscriptionId, s!.id)),
  );
  return rows.reduce((sum, r) => sum + Number(r.amountMinor), 0);
};
const q1 = await buyer("plans-quote-1@example.com", bigMonthly.publicId);
const q1p = body(await preview({ plan: biggerMonthly.publicId }, q1.token, q1.sub));
ok(
  "quote: a deferred upgrade previews 0 due today and a deferred amount",
  q1p.total_minor === 0 &&
    q1p.due_today?.added_to_next_invoice === true &&
    !!q1p.quote &&
    !!q1p.priced_at,
);
await new Promise((r) => setTimeout(r, 1500));
const q1a = await apply(
  {
    plan: biggerMonthly.publicId,
    expected_total_minor: 0,
    priced_at: q1p.priced_at,
    quote: q1p.quote,
  },
  q1.token,
  q1.sub,
);
const q1Booked = await unbilled(q1.sub);
console.log("  quote: previewed", q1p.due_today?.total_minor, "booked", q1Booked);
ok(
  "quote: booked 1.5 s later at the preview's instant → the deferred amount is the previewed one",
  q1a.statusCode === 200 && q1Booked === q1p.due_today?.total_minor,
);

const q2 = await buyer("plans-quote-2@example.com", bigMonthly.publicId);
const q2p = body(await preview({ plan: biggerMonthly.publicId }, q2.token, q2.sub));
await new Promise((r) => setTimeout(r, 1500));
// No priced_at: priced now, 1.5 s later. The deferred amount moved, total_minor did not.
const q2a = await apply(
  { plan: biggerMonthly.publicId, expected_total_minor: 0, quote: q2p.quote },
  q2.token,
  q2.sub,
);
ok(
  "quote: amounts that moved since the preview → 409, nothing booked",
  q2a.statusCode === 409 && (await unbilled(q2.sub)) === 0,
);
const oldPricedAt = new Date(Date.now() - 16 * 60_000).toISOString();
const q3 = await buyer("plans-quote-3@example.com", bigMonthly.publicId);
const q3p = body(await preview({ plan: biggerMonthly.publicId }, q3.token, q3.sub));
ok(
  "quote: a priced_at older than 15 minutes is not re-used → 409",
  (
    await apply(
      {
        plan: biggerMonthly.publicId,
        expected_total_minor: 0,
        priced_at: oldPricedAt,
        quote: q3p.quote,
      },
      q3.token,
      q3.sub,
    )
  ).statusCode === 409,
);

// ── Direction: a volume plan counts at what it bills, not as 0 ─────────────
const volume = await product("Volume", "plan");
const volumeMonthly = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: volume.id,
  type: "recurring",
  model: "volume",
  currency: "USD",
  interval: "month",
  tiers: [{ upToMinor: null, unitAmountMinor: 5000 }],
});
await setConfig({ allow_plan_changes: true, seat_changes: "both", allow_addon_changes: true });
const v = await buyer("plans-volume@example.com", starterMonthly.publicId);
const vp = body(await preview({ plan: volumeMonthly.publicId }, v.token, v.sub));
ok("a dearer volume plan is an upgrade", vp.direction === "upgrade");
if (vp.direction !== "upgrade") console.log(JSON.stringify(vp));

console.log(`\n${pass} passed, ${fail} failed`);
await app.close();
await closeDb();
process.exit(fail ? 1 : 0);

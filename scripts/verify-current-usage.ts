/**
 * Current usage so far (API, customer roll-up, portal, renewal estimate). Runs on Time
 * Travel, scoped to the test business. What regresses without each check:
 *  - the view rates or taxes usage differently from the invoice (figures, tax lines);
 *  - the view reads a different window from the invoice: at the boundary, the renewal,
 *    the pending-invoice close and the term-end final invoice each equal the view;
 *  - the projection scales the amount instead of rating the projected quantity, holds
 *    a level wrongly, shows before 10% of the window, or drops the minimum true-up;
 *  - a removed item stays in the view, or its settled usage leaves the total;
 *  - a deleted record still counts; trial usage gets an amount;
 *  - currencies are summed together on the customer roll-up;
 *  - another org, business or customer can read the usage; the portal switches leak;
 *  - `renewal_estimate` changes by default, or `include_usage_so_far` ignores a coupon.
 *
 *   pnpm verify:current-usage
 */
import { and, desc, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { loadGeoReference } from "@/platform/geo";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { configureIndiaGst } from "@/modules/tax/service";
import { cancelSubscription, createSubscription } from "@/modules/subscriptions/service";
import { removeSubscriptionItem } from "@/modules/subscriptions/items";
import { createCoupon, applyCouponToSubscription } from "@/modules/coupons/service";
import { closeInvoice } from "@/modules/invoicing/pending";
import { recordUsage } from "@/modules/metering/service";
import { startTimeTravel, travelForward } from "@/modules/time-travel/service";
import { businesses, invoiceLineItems, invoices, subscriptions } from "@db/schema";

const checks: [string, boolean, string?][] = [];
const ok = (n: string, c: boolean, detail?: string) => checks.push([n, c, detail]);
const DAY = 86_400_000;
const G = new Date("2027-01-01T00:00:00.000Z");
const FEB = new Date("2027-02-01T00:00:00.000Z");
const RUN = Math.random().toString(36).slice(2, 8);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function main() {
  await loadGeoReference();
  const org = await createOrganization({ name: `Current Usage Org ${RUN}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Current Usage Biz",
    defaultCurrency: "INR",
    livemode: "test",
  });
  const ctx = { organizationId: orgId, businessId: biz.id };
  await configureIndiaGst({
    ...ctx,
    homeStateCode: "TN",
    cgstBps: 900,
    sgstBps: 900,
    registrationNumber: "33AAFCN5032R1Z6",
  });
  const newCustomer = async (tag: string) => {
    const c = await createCustomer({
      ...ctx,
      email: `current-usage-${tag}-${RUN}@example.com`,
      autoCollection: "on",
      address: { country: "IN", stateCode: "TN" },
    });
    await vaultPaymentMethod({ ...ctx, customer: c, token: "tok_4242" });
    return c;
  };
  const customer = await newCustomer("a");

  const app = await buildApp({ logger: false });
  let n = 0;
  const call = async (method: "GET" | "DELETE" | "POST", url: string, token = org.secret) => {
    const res = await app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method !== "GET" ? { "idempotency-key": `cu-${RUN}-${n++}` } : {}),
      },
    });
    return { status: res.statusCode, body: JSON.parse(res.body || "{}") as Json };
  };
  const bizUrl = `/v1/businesses/${biz.publicId}`;
  const usageOf = async (subPublicId: string, projection = true) =>
    (
      await call(
        "GET",
        `${bizUrl}/subscriptions/${subPublicId}/current_usage${projection ? "?include_projection=true" : ""}`,
      )
    ).body;

  // ── Catalog ────────────────────────────────────────────────────────────────
  const meter = await createProduct({ ...ctx, name: "API calls", kind: "addon" });
  const usagePrice = (over: Partial<Parameters<typeof createPrice>[0]> = {}) =>
    createPrice({
      ...ctx,
      productId: meter.id,
      type: "recurring",
      model: "usage",
      usageAggregation: "sum",
      currency: "INR",
      amountMinor: 50,
      interval: "month",
      ...over,
    });
  const perUnit = await usagePrice({ freeQuantity: 1000 }); // A
  const withMin = await usagePrice({ freeQuantity: 1000, minimumAmountMinor: 300000 }); // E
  const graduated = await usagePrice({
    model: "tiered",
    amountMinor: undefined,
    tiers: [
      { upToMinor: 10000, unitAmountMinor: 50 },
      { upToMinor: null, unitAmountMinor: 30 },
    ],
  }); // B
  const seats = await usagePrice({ usageAggregation: "max", amountMinor: 1000 }); // C
  const percent = await usagePrice({
    model: "percentage",
    amountMinor: undefined,
    percentageBps: 290,
  }); // D
  const usdPrice = await usagePrice({ currency: "USD", amountMinor: 2 });

  await startTimeTravel({ orgId, bizId: biz.id, genesisTime: G });
  const subscribe = async (
    prices: Array<Awaited<ReturnType<typeof usagePrice>>>,
    over: Partial<Parameters<typeof createSubscription>[0]> = {},
  ) =>
    createSubscription({
      ...ctx,
      customerId: customer.id,
      now: G,
      items: prices.map((price) => ({ price, quantity: 1 })),
      ...over,
    });
  const record = (itemId: string, quantity: number, at: Date) =>
    recordUsage({ ...ctx, subscriptionItemId: itemId, quantity, timestamp: at });
  const D5 = new Date(G.getTime() + 5 * DAY);

  const a = await subscribe([perUnit]);
  await record(a.items[0]!.id, 4000, D5);
  const e = await subscribe([withMin]);
  await record(e.items[0]!.id, 4000, D5);
  const eLow = await subscribe([withMin]);
  await record(eLow.items[0]!.id, 1500, D5);
  const b = await subscribe([graduated]);
  await record(b.items[0]!.id, 4000, D5);
  const c = await subscribe([seats]);
  await record(c.items[0]!.id, 30, D5);
  await record(c.items[0]!.id, 42, new Date(D5.getTime() + DAY));
  const d = await subscribe([percent]);
  await record(d.items[0]!.id, 1_000_000, D5);
  const rm = await subscribe([perUnit, graduated]);
  await record(rm.items[0]!.id, 2000, D5);
  await record(rm.items[1]!.id, 500, D5);
  const del = await subscribe([perUnit]);
  await record(del.items[0]!.id, 1500, D5);
  const extra = await record(del.items[0]!.id, 700, D5);
  const pend = await subscribe([perUnit], { createPendingInvoices: true });
  await record(pend.items[0]!.id, 3000, D5);
  const termEnd = await subscribe([perUnit]);
  await record(termEnd.items[0]!.id, 2500, D5);
  await cancelSubscription({
    ...ctx,
    subscriptionId: termEnd.subscription.id,
    atPeriodEnd: true,
    now: D5,
  });
  const coupon = await subscribe([perUnit]);
  await record(coupon.items[0]!.id, 3000, D5);
  await createCoupon({
    ...ctx,
    code: `CU10${RUN}`.toUpperCase(),
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
  });
  await applyCouponToSubscription({
    ...ctx,
    subscriptionId: coupon.subscription.id,
    code: `CU10${RUN}`.toUpperCase(),
    now: G,
  });
  const trial = await subscribe([perUnit], { trialEnd: new Date(G.getTime() + 20 * DAY) });
  await record(trial.items[0]!.id, 250, D5);

  // ── 1. Example A at 10 days of 31 ──────────────────────────────────────────
  await travelForward({ orgId, bizId: biz.id, toTime: new Date(G.getTime() + 10 * DAY) });
  const va = await usageOf(a.subscription.publicId);
  const ia = va.items?.[0] ?? {};
  ok(
    "A: window is the term, billed by the renewal",
    va.window?.start === G.toISOString() &&
      va.window?.end === FEB.toISOString() &&
      va.window?.billed_by === "renewal",
    JSON.stringify(va.window),
  );
  ok(
    "A: 4,000 units, 1,000 free, 150,000 so far",
    ia.quantity === 4000 && ia.free_quantity === 1000 && ia.amount_minor === 150000,
    JSON.stringify(ia),
  );
  ok(
    "A: CGST 13,500 + SGST 13,500, total 177,000",
    va.tax_minor === 27000 &&
      va.total_minor === 177000 &&
      va.tax_lines?.length === 2 &&
      va.tax_lines.every((t: Json) => t.amount_minor === 13500),
    JSON.stringify([va.tax_minor, va.total_minor, va.tax_lines]),
  );
  ok(
    "A: projection rates 12,400 units → 570,000 + 102,600 tax = 672,600",
    ia.projected_quantity === 12400 &&
      ia.projected_amount_minor === 570000 &&
      ia.method === "linear" &&
      va.projection?.tax_minor === 102600 &&
      va.projection?.total_minor === 672600,
    JSON.stringify([ia, va.projection]),
  );
  ok("A: discounts are not applied", va.discounts_applied === false);
  const noProj = await usageOf(a.subscription.publicId, false);
  ok(
    "no projection unless asked",
    noProj.projection === null && noProj.items?.[0]?.method === null,
  );

  // ── 3. Projection rules ──────────────────────────────────────────────────────
  const vb = await usageOf(b.subscription.publicId);
  ok(
    "B: graduated tiers rate the projected quantity (572,000, not 620,000)",
    vb.items?.[0]?.amount_minor === 200000 && vb.items?.[0]?.projected_amount_minor === 572000,
    JSON.stringify(vb.items?.[0]),
  );
  const vc = await usageOf(c.subscription.publicId);
  ok(
    "C: max seats hold their level",
    vc.items?.[0]?.quantity === 42 &&
      vc.items?.[0]?.projected_quantity === 42 &&
      vc.items?.[0]?.method === "held_level" &&
      vc.items?.[0]?.amount_minor === 42000,
    JSON.stringify(vc.items?.[0]),
  );
  const vd = await usageOf(d.subscription.publicId);
  ok(
    "D: 2.9% of a summed stream",
    vd.items?.[0]?.amount_minor === 29000,
    JSON.stringify(vd.items?.[0]),
  );
  const ve = await usageOf(e.subscription.publicId);
  ok(
    "E: no true-up so far; minimum reported; projection above the minimum",
    ve.items?.[0]?.amount_minor === 150000 &&
      ve.items?.[0]?.minimum_amount_minor === 300000 &&
      ve.subtotal_minor === 150000 &&
      ve.items?.[0]?.projected_minimum_true_up_minor === 0,
    JSON.stringify(ve.items?.[0]),
  );
  const veLow = await usageOf(eLow.subscription.publicId);
  ok(
    "E: a projection below the minimum carries the true-up",
    veLow.items?.[0]?.projected_amount_minor === 182500 &&
      veLow.projection?.minimum_true_up_minor === 117500 &&
      veLow.projection?.subtotal_minor === 300000,
    JSON.stringify([veLow.items?.[0], veLow.projection]),
  );

  // ── 5. Deleted record, trial ────────────────────────────────────────────────
  const delBefore = (await usageOf(del.subscription.publicId)).items?.[0]?.quantity;
  const delRes = await call("DELETE", `${bizUrl}/usages/${extra.publicId}`);
  const delAfter = (await usageOf(del.subscription.publicId)).items?.[0]?.quantity;
  ok(
    "a deleted record leaves the view at once",
    delRes.status === 200 && delBefore === 2200 && delAfter === 1500,
    JSON.stringify([delRes.status, delBefore, delAfter]),
  );
  const vt = await usageOf(trial.subscription.publicId);
  ok(
    "trial: no window, trial units with no amount",
    vt.window === null &&
      vt.items?.length === 0 &&
      vt.total_minor === 0 &&
      vt.trial?.items?.[0]?.quantity === 250 &&
      !("amount_minor" in (vt.trial?.items?.[0] ?? {})),
    JSON.stringify(vt),
  );
  ok(
    "pending mode with no draft yet: billed by a pending invoice",
    (await usageOf(pend.subscription.publicId)).window?.billed_by === "pending_invoice",
  );
  ok(
    "cancel at term end: billed by the term-end invoice",
    (await usageOf(termEnd.subscription.publicId)).window?.billed_by === "term_end_invoice",
  );

  // ── 4. Plan change: the removed item leaves, its settlement stays in the total ─
  await removeSubscriptionItem({
    ...ctx,
    subscriptionId: rm.subscription.id,
    itemPublicId: rm.items[1]!.publicId,
    now: new Date(G.getTime() + 10 * DAY),
  });
  const vrm = await usageOf(rm.subscription.publicId);
  ok(
    "removed metered item leaves the view; its settled usage is listed",
    vrm.items?.length === 1 &&
      vrm.items[0].quantity === 2000 &&
      vrm.settled_charges?.length === 1 &&
      vrm.settled_charges[0].amount_minor === 25000 &&
      vrm.subtotal_minor === 50000 + 25000,
    JSON.stringify([vrm.items, vrm.settled_charges, vrm.subtotal_minor]),
  );

  // ── 8. renewal_estimate ────────────────────────────────────────────────────
  const est = async (subPublicId: string, q = "") =>
    (await call("GET", `${bizUrl}/subscriptions/${subPublicId}/renewal_estimate${q}`)).body;
  const estDefault = await est(a.subscription.publicId);
  const estFalse = await est(a.subscription.publicId, "?include_usage_so_far=false");
  const estUsage = await est(a.subscription.publicId, "?include_usage_so_far=true");
  ok(
    "renewal_estimate: the default has no usage and equals include_usage_so_far=false",
    JSON.stringify(estDefault) === JSON.stringify(estFalse) &&
      (estDefault.estimate?.lines ?? []).length === 0,
    JSON.stringify(estDefault).slice(0, 300),
  );
  ok(
    "renewal_estimate: include_usage_so_far adds the usage lines and tax",
    estUsage.estimate?.subtotal_minor === 150000 && estUsage.estimate?.total_minor === 177000,
    JSON.stringify(estUsage.estimate).slice(0, 400),
  );
  const estCoupon = await est(coupon.subscription.publicId, "?include_usage_so_far=true");
  ok(
    "renewal_estimate: the coupon applies to usage so far",
    estCoupon.estimate?.subtotal_minor === 100000 && estCoupon.estimate?.discount_minor === 10000,
    JSON.stringify(estCoupon.estimate).slice(0, 400),
  );

  // ── 6. Customer roll-up ─────────────────────────────────────────────────────
  const multi = await newCustomer("multi");
  const inr = await subscribe([perUnit], { customerId: multi.id });
  await record(inr.items[0]!.id, 2000, D5);
  const usd = await subscribe([usdPrice], { customerId: multi.id });
  await record(usd.items[0]!.id, 1000, D5);
  const roll = (
    await call("GET", `${bizUrl}/customers/${multi.publicId}/current_usage?include_projection=true`)
  ).body;
  const tINR = roll.totals?.find((t: Json) => t.currency === "INR");
  const tUSD = roll.totals?.find((t: Json) => t.currency === "USD");
  ok(
    "customer: one entry per metered subscription, totals per currency",
    roll.data?.length === 2 &&
      roll.has_more === false &&
      roll.totals?.length === 2 &&
      tINR?.subtotal_minor === 50000 &&
      tUSD?.subtotal_minor === 2000 &&
      tINR?.projected_total_minor != null,
    JSON.stringify(roll.totals),
  );
  const crowd = await newCustomer("crowd");
  for (let i = 0; i < 51; i++) await subscribe([perUnit], { customerId: crowd.id });
  const capped = (await call("GET", `${bizUrl}/customers/${crowd.publicId}/current_usage`)).body;
  ok(
    "customer: at most 50 subscriptions, has_more",
    capped.data?.length === 50 && capped.has_more === true,
    JSON.stringify([capped.data?.length, capped.has_more]),
  );

  // ── 7. Isolation and the portal switches ───────────────────────────────────
  const other = await createBusiness({
    organizationId: orgId,
    name: "Other Biz",
    defaultCurrency: "INR",
    livemode: "test",
  });
  ok(
    "another business's path → 404",
    (
      await call(
        "GET",
        `/v1/businesses/${other.publicId}/subscriptions/${a.subscription.publicId}/current_usage`,
      )
    ).status === 404,
  );
  const org2 = await createOrganization({ name: `Current Usage Org2 ${RUN}` });
  const cross = await call(
    "GET",
    `${bizUrl}/subscriptions/${a.subscription.publicId}/current_usage`,
    org2.secret,
  );
  ok("another org's key → 404", cross.status === 404, String(cross.status));
  const portalToken = async (cusPublicId: string) => {
    const mint = await call("POST", `${bizUrl}/customers/${cusPublicId}/portal_sessions`);
    const res = await app.inject({
      method: "POST",
      url: "/portal/v1/session",
      headers: { authorization: `Bearer ${mint.body.token}` },
    });
    return (JSON.parse(res.body) as { token: string }).token;
  };
  const tokA = await portalToken(customer.publicId);
  const portalGet = async (url: string, tok = tokA) => {
    const res = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${tok}` },
    });
    return { status: res.statusCode, body: JSON.parse(res.body || "{}") as Json };
  };
  const pUsage = `/portal/v1/subscriptions/${a.subscription.publicId}/usage`;
  const own = await portalGet(`${pUsage}?include_projection=true`);
  ok(
    "portal: own subscription, no ids or minimum, projection off by default",
    own.status === 200 &&
      own.body.items?.[0]?.amount_minor === 150000 &&
      own.body.total_minor === 177000 &&
      !("price" in own.body.items[0]) &&
      !("item" in own.body.items[0]) &&
      !("minimum_amount_minor" in own.body.items[0]) &&
      own.body.projection === null,
    JSON.stringify(own.body).slice(0, 300),
  );
  ok(
    "portal: another customer's subscription → 404",
    (await portalGet(`/portal/v1/subscriptions/${inr.subscription.publicId}/usage`)).status === 404,
  );
  ok(
    "portal: no token → 401",
    (await app.inject({ method: "GET", url: pUsage })).statusCode === 401,
  );
  const list = await portalGet("/portal/v1/subscriptions");
  // The list shows the newest 10; the trial subscription is customer A's newest.
  const listed = (list.body.data ?? []).find((s: Json) => s.id === trial.subscription.publicId);
  ok("portal list: has_metered_items", listed?.has_metered_items === true);
  const setConfig = (cfg: Record<string, boolean>) =>
    systemDb.update(businesses).set({ storefrontConfig: cfg }).where(eq(businesses.id, biz.id));
  await setConfig({ portal_show_usage_projection: true });
  ok(
    "portal: projection shows when the business enables it",
    (await portalGet(pUsage)).body.projection?.total_minor === 672600,
  );
  await setConfig({ portal_show_usage: false });
  ok("portal: usage hidden → 404", (await portalGet(pUsage)).status === 404);
  await setConfig({});

  // ── 2. Agreement at the boundary ───────────────────────────────────────────
  await travelForward({ orgId, bizId: biz.id, toTime: new Date(FEB.getTime() - 1000) });
  const before = {
    a: await usageOf(a.subscription.publicId),
    e: await usageOf(e.subscription.publicId),
    eLow: await usageOf(eLow.subscription.publicId),
    rm: await usageOf(rm.subscription.publicId),
    termEnd: await usageOf(termEnd.subscription.publicId),
  };
  await travelForward({ orgId, bizId: biz.id, toTime: new Date(FEB.getTime() + 3600_000) });
  const invoiceFor = async (subId: string, periodStart: Date) => {
    const [inv] = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.subscriptionId, subId), eq(invoices.periodStart, periodStart)))
        .orderBy(desc(invoices.createdAt))
        .limit(1),
    );
    const lines = inv
      ? await withTenant(orgId, (tx) =>
          tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, inv.id)),
        )
      : [];
    return { inv, lines };
  };
  const agree = async (
    name: string,
    subId: string,
    view: Json,
    periodStart: Date,
    projected = false,
  ) => {
    const { inv, lines } = await invoiceFor(subId, periodStart);
    const usage = lines
      .filter((l) => l.kind === "usage")
      .reduce((s, l) => s + Number(l.amountMinor), 0);
    const want = projected ? view.projection : view;
    ok(
      `${name}: the invoice equals the view (usage, tax, total)`,
      inv != null &&
        usage === want?.subtotal_minor &&
        Number(inv.totalMinor - inv.subtotalMinor) === want?.tax_minor &&
        Number(inv.totalMinor) === want?.total_minor,
      String([
        usage,
        inv?.subtotalMinor,
        inv?.totalMinor,
        want?.subtotal_minor,
        want?.tax_minor,
        want?.total_minor,
      ]),
    );
  };
  await agree("renewal", a.subscription.id, before.a, FEB);
  // The minimum is owed only at window end, so there the projection is the invoice.
  await agree("renewal with a minimum true-up", e.subscription.id, before.e, FEB, true);
  await agree("renewal with a larger true-up", eLow.subscription.id, before.eLow, FEB, true);
  await agree("renewal with settled usage", rm.subscription.id, before.rm, FEB);
  await agree("term-end final invoice", termEnd.subscription.id, before.termEnd, G);

  // Pending invoice: the open draft's window, then its close.
  const vp = await usageOf(pend.subscription.publicId);
  ok(
    "F: pending draft owns the window and is named",
    vp.window?.billed_by === "pending_invoice" &&
      typeof vp.window?.invoice === "string" &&
      vp.window?.start === G.toISOString(),
    JSON.stringify(vp.window),
  );
  if (vp.window?.invoice) {
    const { invoice: closed } = await closeInvoice(orgId, biz.id, vp.window.invoice);
    const lines = await withTenant(orgId, (tx) =>
      tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, closed.id)),
    );
    const usage = lines
      .filter((l) => l.kind === "usage")
      .reduce((s, l) => s + Number(l.amountMinor), 0);
    ok(
      "F: the closed pending invoice bills the view's usage",
      usage === vp.subtotal_minor &&
        Number(closed.totalMinor - closed.subtotalMinor) === vp.tax_minor,
      String([usage, vp.subtotal_minor, closed.totalMinor, closed.subtotalMinor, vp.tax_minor]),
    );
  }
  const after = await usageOf(a.subscription.publicId);
  ok(
    "after the renewal: the new window opens empty, projection null under 10%",
    after.window?.start === FEB.toISOString() &&
      after.items?.[0]?.quantity === 0 &&
      after.projection === null,
    JSON.stringify([after.window, after.items?.[0], after.projection]),
  );
  const [cancelled] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.id, termEnd.subscription.id)),
  );
  ok(
    "a cancelled subscription has no window",
    cancelled?.status === "cancelled" &&
      (await usageOf(termEnd.subscription.publicId)).window === null,
  );
  await app.close();
}

try {
  await main();
} catch (e) {
  console.error(`threw: ${e instanceof Error ? e.stack : String(e)}`);
  checks.push(["suite completed", false]);
}

console.log("");
let pass = true;
for (const [name, c, detail] of checks) {
  console.log(`${c ? "✅" : "❌"} ${name}${!c && detail ? `  (${detail})` : ""}`);
  if (!c) pass = false;
}
console.log(pass ? "\n✅ CURRENT USAGE: PASS" : "\n❌ CURRENT USAGE: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);

/**
 * Skipped renewals, end to end on Time Travel (the real clock pipeline, scoped to the
 * test business). What regresses without each check:
 *  - a skipped renewal still charges the plan, or decrements a fixed term;
 *  - metered usage from the skipped period is never invoiced;
 *  - the renewal reminder promises a charge that will not happen;
 *  - next_billing_at names the skipped date;
 *  - skips past the 48-hour cut-off, over the portal cap, or on a trial are accepted;
 *  - a skip whose renewal never comes stays `scheduled` forever.
 *
 *   pnpm verify:subscription-skip
 */
import { and, eq, sql } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { buildApp } from "@/index";
import { createOrganization, createBusiness, createApiKey } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { recordUsage } from "@/modules/metering/service";
import { startTimeTravel, travelForward } from "@/modules/time-travel/service";
import {
  listUpcomingRenewals,
  renewalSkipViews,
  skipRenewal,
  unskipRenewal,
} from "@/modules/subscriptions/renewal-skips";
import {
  events,
  invoiceLineItems,
  invoices,
  renewalSkips,
  subscriptions,
  subscriptionItems,
} from "@db/schema";

const checks: [string, boolean, string?][] = [];
const ok = (n: string, c: boolean, detail?: string) => checks.push([n, c, detail]);
const DAY = 86_400_000;
const G = new Date("2027-03-01T00:00:00.000Z");
const APR = new Date("2027-04-01T00:00:00.000Z");
const MAY = new Date("2027-05-01T00:00:00.000Z");
const JUN = new Date("2027-06-01T00:00:00.000Z");
const JUL = new Date("2027-07-01T00:00:00.000Z");
const RUN = Math.random().toString(36).slice(2, 8);

async function refuses(p: Promise<unknown>, text: RegExp): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (e) {
    return text.test(e instanceof Error ? e.message : String(e));
  }
}

async function main() {
  const org = await createOrganization({ name: `Skip Org ${RUN}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Skip Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `skip-${RUN}@example.com`,
    autoCollection: "on",
    address: { country: "US" },
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
  });
  const plan = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Box",
    id: `box-${RUN}`,
    kind: "plan",
  });
  const monthly = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: plan.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const termed = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: plan.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
    billingCycles: 3,
  });
  const meter = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Extras",
    id: `extras-${RUN}`,
    kind: "addon",
  });
  const usagePrice = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: meter.id,
    type: "recurring",
    model: "usage",
    usageAggregation: "sum",
    currency: "USD",
    amountMinor: 100,
    interval: "month",
  });

  await startTimeTravel({ orgId, bizId: biz.id, genesisTime: G });
  const subscribe = async (
    price: typeof monthly,
    extra: { trialDays?: number; usage?: boolean } = {},
  ) => {
    const c = await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      now: G,
      items: [{ price, quantity: 1 }, ...(extra.usage ? [{ price: usagePrice, quantity: 1 }] : [])],
      ...(extra.trialDays ? { trialDays: extra.trialDays } : {}),
    });
    if (!extra.trialDays)
      await billSubscriptionPeriod({
        organizationId: orgId,
        businessId: biz.id,
        subscription: c.subscription,
        periodStart: c.subscription.currentPeriodStart!,
        periodEnd: c.subscription.currentPeriodEnd!,
      });
    return c.subscription;
  };
  const sub = (id: string) =>
    withTenant(
      orgId,
      async (tx) => (await tx.select().from(subscriptions).where(eq(subscriptions.id, id)))[0]!,
    );
  const invoicesOf = (id: string) =>
    withTenant(orgId, (tx) => tx.select().from(invoices).where(eq(invoices.subscriptionId, id)));
  const eventsOf = (type: string, publicId: string) =>
    systemDb
      .select({ data: events.data })
      .from(events)
      .where(and(eq(events.type, type), sql`${events.data}->'subscription'->>'id' = ${publicId}`));

  const a = await subscribe(monthly); // plain skip
  const b = await subscribe(termed); // fixed term of 3 cycles
  const c = await subscribe(monthly, { usage: true }); // usage still billed
  const d = await subscribe(monthly); // never skipped: the control
  const h = await subscribe(monthly); // skip that never comes → void
  const capped = await subscribe(monthly);
  const trial = await subscribe(monthly, { trialDays: 14 });

  // ── Upcoming renewals ─────────────────────────────────────────────────────
  const upA = await listUpcomingRenewals(orgId, a.id, G);
  ok("upcoming renewals start at the term end", upA[0]?.renewalAt.getTime() === APR.getTime());
  ok("…and list 12 of them", upA.length === 12, String(upA.length));
  const upB = await listUpcomingRenewals(orgId, b.id, G);
  ok("a 3-cycle term has 2 renewals left", upB.length === 2, String(upB.length));
  ok("a trial cannot skip", (await listUpcomingRenewals(orgId, trial.id, G)).length === 0);

  // ── Scheduling ────────────────────────────────────────────────────────────
  const common = { organizationId: orgId, businessId: biz.id, source: "api" as const, now: G };
  await skipRenewal({ ...common, subscriptionId: a.id, renewalAt: APR });
  ok(
    "the same renewal cannot be skipped twice",
    await refuses(
      skipRenewal({ ...common, subscriptionId: a.id, renewalAt: APR }),
      /already skipped/,
    ),
  );
  ok(
    "a date that is not a renewal is refused",
    await refuses(
      skipRenewal({ ...common, subscriptionId: a.id, renewalAt: new Date("2027-04-15T00:00:00Z") }),
      /not one of the next/,
    ),
  );
  ok(
    "a trial skip is refused",
    await refuses(skipRenewal({ ...common, subscriptionId: trial.id, renewalAt: APR }), /trial/),
  );
  ok(
    "a skip inside 48 hours is refused",
    await refuses(
      skipRenewal({
        ...common,
        subscriptionId: d.id,
        renewalAt: APR,
        now: new Date(APR.getTime() - DAY),
      }),
      /48 hours/,
    ),
  );
  await skipRenewal({ ...common, subscriptionId: b.id, renewalAt: APR });
  ok(
    "a skip extends the fixed term by one renewal",
    (await listUpcomingRenewals(orgId, b.id, G)).length === 3,
  );
  await skipRenewal({ ...common, subscriptionId: c.id, renewalAt: APR });
  await skipRenewal({ ...common, subscriptionId: h.id, renewalAt: MAY });
  // Undo, and the undo cut-off.
  await skipRenewal({ ...common, subscriptionId: d.id, renewalAt: MAY });
  ok(
    "an undo inside 48 hours is refused",
    await refuses(
      unskipRenewal({
        organizationId: orgId,
        subscriptionId: d.id,
        renewalAt: MAY,
        now: new Date(MAY.getTime() - DAY),
      }),
      /48 hours/,
    ),
  );
  await unskipRenewal({ organizationId: orgId, subscriptionId: d.id, renewalAt: MAY, now: G });
  ok(
    "an undone skip leaves nothing scheduled",
    (await listUpcomingRenewals(orgId, d.id, G)).every((u) => u.skip == null),
  );
  // The portal cap: one skip in 12 months.
  await skipRenewal({ ...common, subscriptionId: capped.id, renewalAt: APR, limit: 1 });
  ok(
    "the cap refuses a second skip in 12 months",
    await refuses(
      skipRenewal({ ...common, subscriptionId: capped.id, renewalAt: MAY, limit: 1 }),
      /can skip 1 renewal in 12 months/,
    ),
  );
  ok(
    "operators are not capped",
    !(await refuses(skipRenewal({ ...common, subscriptionId: capped.id, renewalAt: MAY }), /./)),
  );

  // ── What a subscription reports ───────────────────────────────────────────
  const viewA = (await renewalSkipViews(orgId, [await sub(a.id)])).get(a.id);
  ok("skipped_renewals lists the skip", viewA?.skipped[0]?.getTime() === APR.getTime());
  ok(
    "next_billing_at moves to the first renewal not skipped",
    viewA?.nextBillingAt?.getTime() === MAY.getTime(),
  );

  // Usage in the period that ends at the skipped renewal.
  const [usageItem] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(subscriptionItems)
      .where(
        and(
          eq(subscriptionItems.subscriptionId, c.id),
          eq(subscriptionItems.priceId, usagePrice.id),
        ),
      ),
  );
  await recordUsage({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionItemId: usageItem!.id,
    quantity: 7,
    timestamp: new Date(G.getTime() + 10 * DAY),
  });

  // ── The reminder window (5 days before 1 April) ───────────────────────────
  await travelForward({ orgId, bizId: biz.id, toTime: new Date(APR.getTime() - 3 * DAY) });
  ok(
    "no renewal reminder for a skipped renewal",
    (await eventsOf("subscription_renewal_reminder", a.publicId)).length === 0,
  );
  ok(
    "…while the renewal that is not skipped gets one",
    (await eventsOf("subscription_renewal_reminder", d.publicId)).length > 0,
  );

  // ── The skipped renewal ───────────────────────────────────────────────────
  const mrrBefore = (await sub(a.id)).mrr;
  await travelForward({ orgId, bizId: biz.id, toTime: new Date(APR.getTime() + DAY) });
  const a1 = await sub(a.id);
  ok("the skipped renewal raises no invoice", (await invoicesOf(a.id)).length === 1);
  ok(
    "…and the term still moves on",
    a1.currentPeriodStart?.getTime() === APR.getTime() &&
      a1.currentPeriodEnd?.getTime() === MAY.getTime(),
  );
  ok("…and the subscription stays active", a1.status === "active");
  ok("…and MRR does not move", String(a1.mrr) === String(mrrBefore), `${mrrBefore} → ${a1.mrr}`);
  ok(
    "subscription_renewal_skipped is emitted, not subscription_renewed",
    (await eventsOf("subscription_renewal_skipped", a.publicId)).length === 1 &&
      (await eventsOf("subscription_renewed", a.publicId)).length === 0,
  );
  const [skipA] = await withTenant(orgId, (tx) =>
    tx.select().from(renewalSkips).where(eq(renewalSkips.subscriptionId, a.id)),
  );
  ok("the skip is applied", skipA?.status === "applied");
  ok("the control renewed and invoiced", (await invoicesOf(d.id)).length === 2);

  // Usage still bills: one invoice with the usage line and no plan line.
  const cInvoices = await invoicesOf(c.id);
  const usageInvoice = cInvoices.find((i) => i.periodStart?.getTime() === APR.getTime());
  const lines = usageInvoice
    ? await withTenant(orgId, (tx) =>
        tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, usageInvoice.id)),
      )
    : [];
  ok(
    "usage is invoiced at the skipped renewal",
    lines.some((l) => l.kind === "usage" && Number(l.amountMinor) === 700),
  );
  ok(
    "…without the plan",
    lines.every((l) => l.kind !== "recurring"),
    lines.map((l) => l.kind).join(","),
  );
  const [skipC] = await withTenant(orgId, (tx) =>
    tx.select().from(renewalSkips).where(eq(renewalSkips.subscriptionId, c.id)),
  );
  ok(
    "the skip records its usage invoice",
    skipC?.invoiceId === usageInvoice?.id && skipC?.invoiceId != null,
  );

  // ── A skip whose renewal never comes ──────────────────────────────────────
  await systemDb.update(subscriptions).set({ status: "paused" }).where(eq(subscriptions.id, h.id));
  await travelForward({ orgId, bizId: biz.id, toTime: new Date(MAY.getTime() + 2 * DAY) });
  const [skipH] = await withTenant(orgId, (tx) =>
    tx.select().from(renewalSkips).where(eq(renewalSkips.subscriptionId, h.id)),
  );
  ok("a skip whose renewal never came is voided", skipH?.status === "void", skipH?.status);
  ok("the undone skip renewed as normal", (await invoicesOf(d.id)).length === 3);
  ok("the plain skip renews again in May", (await invoicesOf(a.id)).length === 2);

  // ── The fixed term runs its full 3 paid cycles ────────────────────────────
  await travelForward({ orgId, bizId: biz.id, toTime: new Date(JUL.getTime() + DAY) });
  const b1 = await sub(b.id);
  ok(
    "the term bills 3 times despite the skip",
    (await invoicesOf(b.id)).length === 3,
    String((await invoicesOf(b.id)).length),
  );
  ok(
    "…and ends one cycle later, on 1 July",
    b1.status === "cancelled" &&
      b1.canceledAt != null &&
      Math.abs(b1.canceledAt.getTime() - JUL.getTime()) <= DAY,
    `${b1.status} ${b1.canceledAt?.toISOString()}`,
  );
  void JUN;

  // ── The API ───────────────────────────────────────────────────────────────
  const app = await buildApp({ logger: false });
  try {
    const { secret } = await createApiKey(orgId, "test");
    const auth = { authorization: `Bearer ${secret}` };
    const e = await sub(d.id);
    const up = await app.inject({
      method: "GET",
      url: `/v1/businesses/${biz.publicId}/subscriptions/${e.publicId}/upcoming_renewals`,
      headers: auth,
    });
    const next = (up.json() as { data: { renewal_at: string }[] }).data[1]!.renewal_at;
    const res = await app.inject({
      method: "POST",
      url: `/v1/businesses/${biz.publicId}/subscriptions/${e.publicId}/skip_renewal`,
      headers: { ...auth, "content-type": "application/json", "idempotency-key": `skip-${RUN}` },
      payload: JSON.stringify({ renewal_at: next }),
    });
    const body = res.json() as {
      skipped_renewals: string[];
      next_billing_at: string;
      renewal_skip: { source: string };
    };
    ok("POST skip_renewal answers 200", res.statusCode === 200, res.body.slice(0, 200));
    ok("…reports the skip in skipped_renewals", body.skipped_renewals?.[0] === next);
    ok("…and records the API as the source", body.renewal_skip?.source === "api");
    const get = await app.inject({
      method: "GET",
      url: `/v1/businesses/${biz.publicId}/subscriptions/${e.publicId}`,
      headers: auth,
    });
    ok(
      "GET subscription reports the same skipped_renewals",
      (get.json() as { skipped_renewals: string[] }).skipped_renewals?.[0] === next,
    );
  } finally {
    await app.close();
  }
}

try {
  await main();
} catch (e) {
  console.error(`threw: ${e instanceof Error ? e.stack : String(e)}`);
  checks.push(["suite completed", false]);
}

console.log("");
let pass = true;
for (const [n, c, detail] of checks) {
  console.log(`${c ? "✅" : "❌"} ${n}${!c && detail ? `  (${detail})` : ""}`);
  if (!c) pass = false;
}
console.log(pass ? "\n✅ SUBSCRIPTION SKIP: PASS" : "\n❌ SUBSCRIPTION SKIP: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);

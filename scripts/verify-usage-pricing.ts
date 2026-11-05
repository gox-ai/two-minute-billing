/**
 * Tier models on metered usage. What regresses without each check:
 *  - API: a flat/per-unit price takes an aggregation, a usage field changes on PATCH, the
 *    recurring/time-unit rules, the read-only `metered` flag;
 *  - billing: each model's amount on measured usage, free quantity before tiers, a bound
 *    equal to a tier top, zero usage (no line, the minimum still applies);
 *  - `rating` stored on the usage line, its tier rows adding up, and on the invoice read;
 *  - quantity 1 on a metered tier item, MRR, the renewal-skip metered check, config transfer.
 *
 *   pnpm verify:usage-pricing
 */
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice, listPrices } from "@/modules/catalog/service";
import type { PriceTier } from "@/modules/catalog/pricing";
import { createSubscription } from "@/modules/subscriptions/service";
import { skipRenewal, skippedRenewal } from "@/modules/subscriptions/renewal-skips";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { recordUsage } from "@/modules/metering/service";
import { runTransfer } from "@/modules/transfer/service";
import type { LineRating } from "@/modules/metering/rating";
import { invoiceLineItems, subscriptionItems } from "@db/schema";

const checks: [string, boolean, string?][] = [];
const ok = (n: string, c: boolean, detail?: string) => checks.push([n, c, detail]);
const RUN = Math.random().toString(36).slice(2, 8);
const TIERS: PriceTier[] = [
  { upToMinor: 1000, unitAmountMinor: 100 },
  { upToMinor: 5000, unitAmountMinor: 50 },
  { upToMinor: null, unitAmountMinor: 20 },
];

async function main() {
  const org = await createOrganization({ name: `Usage Pricing Org ${RUN}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Usage Pricing Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const ctx = { organizationId: orgId, businessId: biz.id };

  // ── 1. API ──────────────────────────────────────────────────────────────
  const app = await buildApp({ logger: false });
  let n = 0;
  const call = async (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => {
    const res = await app.inject({
      method,
      url: `/v1/businesses/${biz.publicId}${url}`,
      headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": `up-${RUN}-${n++}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  await call("POST", "/products", { id: "calls", name: "Calls", kind: "addon" });
  const base = { product: "calls", currency: "USD", interval: "month" };
  const tiered = await call("POST", "/prices", {
    ...base,
    id: "calls-tiered",
    model: "tiered",
    tiers: TIERS,
    usage_aggregation: "sum",
  });
  ok(
    "a metered tiered price is created and reads metered",
    tiered.status === 201 && tiered.body.metered === true && tiered.body.usage_recurring === false,
    JSON.stringify(tiered.body).slice(0, 300),
  );
  const fixed = await call("POST", "/prices", {
    ...base,
    id: "calls-fixed",
    model: "tiered",
    tiers: TIERS,
  });
  ok("a tiered price without aggregation is not metered", fixed.body.metered === false);
  for (const model of ["flat", "per_unit"]) {
    const r = await call("POST", "/prices", {
      ...base,
      model,
      amount_minor: 100,
      usage_aggregation: "sum",
    });
    ok(
      `${model} + usage_aggregation → 400 on usage_aggregation`,
      r.status === 400 && JSON.stringify(r.body).includes("usage_aggregation"),
      JSON.stringify(r.body).slice(0, 200),
    );
  }
  const countRec = await call("POST", "/prices", {
    ...base,
    model: "usage",
    amount_minor: 1,
    usage_aggregation: "count",
    usage_recurring: true,
  });
  ok(
    "recurring count → 400 on usage_recurring",
    countRec.status === 400 && JSON.stringify(countRec.body).includes("usage_recurring"),
  );
  const unitNoWs = await call("POST", "/prices", {
    ...base,
    model: "usage",
    amount_minor: 1,
    usage_aggregation: "sum",
    usage_time_unit: "day",
  });
  ok("time unit without weighted_sum → 400", unitNoWs.status === 400);
  const ws = await call("POST", "/prices", {
    ...base,
    id: "gb-hours",
    model: "package",
    amount_minor: 100,
    package_size: 100,
    usage_aggregation: "weighted_sum",
    usage_recurring: true,
  });
  ok(
    "weighted_sum defaults to the hour unit",
    ws.status === 201 && ws.body.usage_time_unit === "hour" && ws.body.usage_recurring === true,
    JSON.stringify(ws.body).slice(0, 200),
  );
  for (const field of ["usage_aggregation", "usage_recurring", "usage_time_unit"]) {
    const r = await call("PATCH", "/prices/calls-tiered", {
      [field]: field === "usage_recurring" ? true : field === "usage_time_unit" ? "day" : "max",
    });
    ok(`PATCH ${field} → 400`, r.status === 400, String(r.status));
  }

  // ── 2. Billing each model on measured usage ───────────────────────────────
  const customer = await createCustomer({ ...ctx, email: `usage-pricing-${RUN}@example.com` });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const planProd = await createProduct({ ...ctx, name: "Box", kind: "plan" });
  const plan = await createPrice({
    ...ctx,
    productId: planProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const meterProd = await createProduct({ ...ctx, name: "Meter", kind: "addon" });
  const metered = (over: Partial<Parameters<typeof createPrice>[0]>) =>
    createPrice({
      ...ctx,
      productId: meterProd.id,
      type: "recurring",
      model: "tiered",
      currency: "USD",
      interval: "month",
      usageAggregation: "sum",
      tiers: TIERS,
      ...over,
    });

  /** One subscription per price; bills `usage` in its first period. */
  const billWith = async (price: Awaited<ReturnType<typeof metered>>, usage: number) => {
    const { subscription: sub, items } = await createSubscription({
      ...ctx,
      customerId: customer.id,
      now: new Date(),
      items: [
        { price: plan, quantity: 1 },
        { price, quantity: 1 },
      ],
    });
    const start = sub.currentPeriodStart!;
    const end = sub.currentPeriodEnd!;
    const item = items.find((i) => i.priceId === price.id)!;
    if (usage > 0)
      await recordUsage({
        ...ctx,
        subscriptionItemId: item.id,
        quantity: usage,
        timestamp: new Date(start.getTime() + 60_000),
      });
    const { invoice } = await billSubscriptionPeriod({
      ...ctx,
      subscription: sub,
      periodStart: end,
      periodEnd: new Date(end.getTime() + (end.getTime() - start.getTime())),
      usagePeriod: { start, end },
    });
    const lines = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(invoiceLineItems)
        .where(
          and(eq(invoiceLineItems.invoiceId, invoice.id), eq(invoiceLineItems.priceId, price.id)),
        ),
    );
    // The minimum-spend true-up is a usage line too; the rated one carries `rating`.
    const usageLine = lines.find((l) => l.kind === "usage" && l.rating != null);
    return { invoice, sub, lines, usageLine };
  };

  const graduated = await billWith(await metered({}), 6200);
  ok(
    "tiered: 1,000×100 + 4,000×50 + 1,200×20 = 324,000",
    graduated.usageLine?.amountMinor === 324_000n && graduated.usageLine?.quantity === 6200,
    String(graduated.usageLine?.amountMinor),
  );
  const rating = graduated.usageLine?.rating as LineRating | null | undefined;
  ok(
    "rating is stored and its tier rows add up to the amount",
    rating?.tiers.length === 3 &&
      rating.tiers.reduce((s, t) => s + t.amount_minor, 0) === 324_000 &&
      rating.model === "tiered" &&
      rating.aggregation === "sum" &&
      rating.level === null,
    JSON.stringify(rating),
  );
  const read = await call("GET", `/invoices/${graduated.invoice.publicId}`);
  const readLine = (read.body.lines as Array<{ kind: string; rating: LineRating | null }>)?.find(
    (l) => l.kind === "usage",
  );
  ok("the invoice read returns rating on the usage line", readLine?.rating?.tiers?.length === 3);
  ok(
    "…and null on the plan line",
    (read.body.lines as Array<{ kind: string; rating: unknown }>).some(
      (l) => l.kind === "recurring" && l.rating === null,
    ),
  );
  ok("no fixed line for the metered item", graduated.lines.length === 1);

  const free = await billWith(await metered({ freeQuantity: 200 }), 6200);
  ok("free quantity comes off before the tiers: 320,000", free.usageLine?.amountMinor === 320_000n);
  const volume = await billWith(await metered({ model: "volume" }), 6200);
  ok("volume: 6,200×20 = 124,000", volume.usageLine?.amountMinor === 124_000n);
  const bound = await billWith(await metered({ model: "volume" }), 1000);
  ok(
    "volume at a tier top stays in the lower tier: 100,000",
    bound.usageLine?.amountMinor === 100_000n,
  );
  const pack = await billWith(
    await metered({
      model: "package",
      tiers: undefined,
      amountMinor: 3000,
      packageSize: 100,
      freeUnits: 50,
    }),
    1234,
  );
  ok("package: ceil(1,184/100) = 12 × 3,000 = 36,000", pack.usageLine?.amountMinor === 36_000n);
  const stair = await billWith(
    await metered({
      model: "stairstep",
      tiers: [
        { upToMinor: 10, flatAmountMinor: 9000 },
        { upToMinor: null, flatAmountMinor: 18000 },
      ],
    }),
    11,
  );
  ok("stairstep: the band's flat", stair.usageLine?.amountMinor === 18_000n);

  const firstFlat = await metered({
    tiers: [{ upToMinor: null, unitAmountMinor: 10, flatAmountMinor: 2500 }],
    minimumAmountMinor: 3000,
  });
  const zero = await billWith(firstFlat, 0);
  ok("zero usage: no usage line, no tier flat", zero.usageLine === undefined);
  ok(
    "…but the minimum spend true-up stays",
    zero.lines.length === 1 && zero.lines[0]!.amountMinor === 3000n,
    zero.lines.map((l) => `${l.kind} ${l.amountMinor}`).join("; "),
  );

  // ── 3. Quantity, MRR, renewal skips, transfer ─────────────────────────────
  const qtyRefused = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [
      { price: plan, quantity: 1 },
      { price: await metered({}), quantity: 2 },
    ],
  }).then(
    () => "created",
    (e: Error) => e.message,
  );
  ok(
    "a metered tier item with quantity 2 is refused",
    /quantity must be 1/i.test(qtyRefused),
    qtyRefused,
  );
  ok(
    "MRR leaves the metered tier item out",
    graduated.sub.mrr === 5000n,
    String(graduated.sub.mrr),
  );

  const skipSub = graduated.sub;
  const meteredItem = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, skipSub.id)),
  );
  ok("the subscription has its metered item", meteredItem.length === 2);
  await skipRenewal({
    ...ctx,
    subscriptionId: skipSub.id,
    renewalAt: skipSub.currentPeriodEnd!,
    source: "api",
    now: new Date(),
  });
  const skip = await skippedRenewal(skipSub.id, skipSub.currentPeriodEnd!);
  ok(
    "a skipped renewal sees the metered tier item",
    skip?.meteredUsage === true,
    JSON.stringify(skip),
  );

  const dest = await createBusiness({
    organizationId: orgId,
    name: "Usage Pricing Copy",
    defaultCurrency: "USD",
    livemode: "test",
  });
  await runTransfer({
    organizationId: orgId,
    sourceBusinessId: biz.id,
    destinationBusinessId: dest.id,
  });
  const copied = (await listPrices(orgId, dest.id)).find((p) => p.price.publicId === "gb-hours");
  ok(
    "config transfer copies the usage fields",
    copied?.price.usageAggregation === "weighted_sum" &&
      copied.price.usageRecurring === true &&
      copied.price.usageTimeUnit === "hour",
    JSON.stringify(copied?.price ?? null, (_k, v) => (typeof v === "bigint" ? Number(v) : v)).slice(
      0,
      200,
    ),
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
for (const [n, c, detail] of checks) {
  console.log(`${c ? "✅" : "❌"} ${n}${!c && detail ? `  (${detail})` : ""}`);
  if (!c) pass = false;
}
console.log(pass ? "\n✅ USAGE-PRICING: PASS" : "\n❌ USAGE-PRICING: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);

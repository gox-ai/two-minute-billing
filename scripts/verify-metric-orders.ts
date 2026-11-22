/**
 * Oracle gate for the one-time sales measures (`order-measures.ts`). Hand-worked, June 2026:
 *   A  10 May  mug 1000                     → an order before June: A returns in June
 *   A   5 Jun  mug ×2 2000                  → order; A is in IN, unpaid (gateway none)
 *   B   8 Jun  mug ×3 3000, poster 1000, coupon −300 (225 + 75 on the lines)
 *               → order 3700: mug 2775, poster 925 (the −300 spread 3:1); paid 3700 offline;
 *                 700 refunded 15 Jun → mug 525, poster 175 (by revenue, 2775:925)
 *   C   9 Jun  credit pack 4000 only        → NOT an order (a top-up)
 *   B  20 Jun  setup fee 500 on a subscription invoice → NOT an order
 *   A  25 Jun  mug 999, pending             → NOT billed, NOT an order
 * June: 2 orders, revenue 5700 (mug 4775, poster 925), AOV 2850, 2 buyers, 1 returning (50%),
 * refunds 700 → refund rate 1228 bps (mug 525/4775 = 1099, poster 175/925 = 1892), discount 300,
 * units mug 5 + poster 1. Slices: A's order is returning / IN / gateway none / no coupon;
 * B's is first / no country / offline / the coupon. Revenue per buyer at 30 Jun: (1000 + 2000
 * + 3700) ÷ 2 = 3350. Cohorts (as of 15 Sep): May = A, second order in June → M0 0, M1–M4
 * 100%, revenue per buyer 1000 then 3000; Jun = B, never again → 0%, 3700.
 * Taxed shop (a second business, so the numbers above stay put), June:
 *   D 10 Jun  10000 + 1800 tax = 11800 total; 11800 refunded 16 Jun in full
 *   E 11 Jun   5000, no tax, never refunded
 * → refunds 11800 (tax included), refund numerator 11800 × 10000 ÷ 11800 = 10000 pre-tax,
 * revenue 15000 → rate 6667 bps (the tax-included numerator would read 7867); D alone = 100%.
 *
 *   pnpm verify:metric-orders
 */
import { closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { listCustomersPage } from "@/modules/customers/service";
import { createPrice, createProduct } from "@/modules/catalog/service";
import { assertRegistryImplemented, computeMetricPeriod } from "@/modules/metrics/daily/compute";
import { MEASURES, measureById, ratioValue } from "@/modules/metrics/daily/measures";
import { businessesWithBillingActivity } from "@/modules/metrics/daily/cron";
import { resolveReport } from "@/modules/metrics/reports/resolve";
import {
  appliedCoupons,
  coupons,
  customers,
  invoiceLineDiscounts,
  invoiceLineItems,
  invoices,
  payments,
  refunds,
  subscriptions,
} from "@db/schema";
import { eq } from "drizzle-orm";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const stamp = Date.now();
const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const NOW = new Date("2026-09-15T12:00:00.000Z");

const org = await createOrganization({ name: "Order Measure Oracle Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Order Measure Oracle Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
const bizId = biz.id;
const ids = { organizationId: orgId, businessId: bizId };
const bizIds = ids;
const mk = (k: string) => createCustomer({ ...ids, email: `orders-${k}-${stamp}@example.test` });
const [a, b, c] = [await mk("a"), await mk("b"), await mk("c")];

const mugProduct = await createProduct({ ...ids, name: "Mug", kind: "charge" });
const mug = await createPrice({
  ...ids,
  productId: mugProduct.id,
  id: `mug-${stamp}`,
  type: "one_time",
  model: "flat",
  currency: "USD",
  amountMinor: 1000,
});
const posterProduct = await createProduct({ ...ids, name: "Poster", kind: "charge" });
const poster = await createPrice({
  ...ids,
  productId: posterProduct.id,
  id: `poster-${stamp}`,
  type: "one_time",
  model: "flat",
  currency: "USD",
  amountMinor: 1000,
});
const packProduct = await createProduct({ ...ids, name: "Credit pack", kind: "charge" });
const pack = await createPrice({
  ...ids,
  productId: packProduct.id,
  id: `pack-${stamp}`,
  type: "one_time",
  model: "flat",
  currency: "USD",
  amountMinor: 4000,
  grantsCredit: { kind: "pack", unit: null, amount: 4000, tax_treatment: "taxed_at_purchase" },
});
const [sub] = await withTenant(orgId, (tx) =>
  tx
    .insert(subscriptions)
    .values({
      ...ids,
      customerId: b.id,
      publicId: `sub_orders_${stamp}`,
      status: "active",
      currency: "USD",
    })
    .returning({ id: subscriptions.id }),
);

let seq = 0;
/** `[kind, amountMinor, priceId | null, quantity?, discountMinor?]` per line. */
async function invoice(
  customerId: string,
  day: string,
  lines: Array<[string, number, string | null, number?, number?]>,
  opts: { status?: string; subscriptionId?: string; taxMinor?: number; scope?: typeof ids } = {},
): Promise<string> {
  const subtotal = lines.reduce((s, l) => s + l[1], 0);
  const total = subtotal + (opts.taxMinor ?? 0);
  const ids = opts.scope ?? bizIds;
  return withTenant(orgId, async (tx) => {
    const [inv] = await tx
      .insert(invoices)
      .values({
        ...ids,
        customerId,
        publicId: `inv_orders_${++seq}_${stamp}`,
        status: opts.status ?? "paid",
        currency: "USD",
        subtotalMinor: BigInt(subtotal),
        totalMinor: BigInt(total),
        subscriptionId: opts.subscriptionId ?? null,
        createdAt: at(day),
      })
      .returning({ id: invoices.id });
    let k = 0;
    for (const [kind, amount, priceId, quantity = 1, discount = 0] of lines) {
      await tx.insert(invoiceLineItems).values({
        ...ids,
        invoiceId: inv!.id,
        publicId: `il_orders_${seq}_${++k}_${stamp}`,
        description: kind,
        quantity,
        unitAmountMinor: BigInt(amount),
        amountMinor: BigInt(amount),
        discountMinor: BigInt(discount),
        priceId,
        kind,
        createdAt: at(day),
      });
    }
    return inv!.id;
  });
}
await invoice(a.id, "2026-05-10", [["one_time", 1000, mug.id]]);
await invoice(a.id, "2026-06-05", [["one_time", 2000, mug.id, 2]]);
const bOrder = await invoice(b.id, "2026-06-08", [
  ["one_time", 3000, mug.id, 3, 225],
  ["one_time", 1000, poster.id, 1, 75],
  ["discount", -300, null],
]);
await invoice(c.id, "2026-06-09", [["one_time", 4000, pack.id]]);
await invoice(b.id, "2026-06-20", [["one_time", 500, mug.id]], { subscriptionId: sub!.id });
await invoice(a.id, "2026-06-25", [["one_time", 999, mug.id]], { status: "pending" });

const couponId = await withTenant(orgId, async (tx) => {
  await tx.update(customers).set({ country: "in" }).where(eq(customers.id, a.id));
  const [cp] = await tx
    .insert(coupons)
    .values({
      ...ids,
      code: `SPRING${stamp}`,
      name: "Spring",
      kind: "percentage",
      percentOffBps: 750,
    })
    .returning({ id: coupons.id });
  const [ac] = await tx
    .insert(appliedCoupons)
    .values({
      ...ids,
      couponId: cp!.id,
      customerId: b.id,
      invoiceId: bOrder,
      scope: "invoice",
      publicId: `disc_orders_${stamp}`,
    })
    .returning({ id: appliedCoupons.id });
  const lines = await tx
    .select({ id: invoiceLineItems.id, discount: invoiceLineItems.discountMinor })
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, bOrder));
  for (const l of lines.filter((x) => x.discount > 0n))
    await tx.insert(invoiceLineDiscounts).values({
      ...ids,
      invoiceId: bOrder,
      invoiceLineItemId: l.id,
      appliedCouponId: ac!.id,
      scope: "document_level",
      amountMinor: l.discount,
    });
  return cp!.id;
});

await withTenant(orgId, async (tx) => {
  const [p] = await tx
    .insert(payments)
    .values({
      ...ids,
      customerId: b.id,
      invoiceId: bOrder,
      publicId: `pay_orders_${stamp}`,
      status: "succeeded",
      amountMinor: 3700n,
      currency: "USD",
      providerKey: "offline",
      createdAt: at("2026-06-08"),
    })
    .returning({ id: payments.id });
  await tx.insert(refunds).values({
    ...ids,
    paymentId: p!.id,
    publicId: `re_orders_${stamp}`,
    status: "succeeded",
    amountMinor: 700n,
    currency: "USD",
    providerKey: "offline",
    createdAt: at("2026-06-15"),
  });
});

// A second business: a taxed order refunded in full, and an untaxed one never refunded.
const taxShop = await createBusiness({
  organizationId: orgId,
  name: "Order Measure Taxed Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
const taxIds = { organizationId: orgId, businessId: taxShop.id };
const taxBuyer = await createCustomer({ ...taxIds, email: `orders-tax-${stamp}@example.test` });
const dOrder = await invoice(taxBuyer.id, "2026-06-10", [["one_time", 10000, null]], {
  taxMinor: 1800,
  scope: taxIds,
});
await invoice(taxBuyer.id, "2026-06-11", [["one_time", 5000, null]], { scope: taxIds });
await withTenant(orgId, async (tx) => {
  const [p] = await tx
    .insert(payments)
    .values({
      ...taxIds,
      customerId: taxBuyer.id,
      invoiceId: dOrder,
      publicId: `pay_orders_tax_${stamp}`,
      status: "succeeded",
      amountMinor: 11800n,
      currency: "USD",
      providerKey: "offline",
      createdAt: at("2026-06-10"),
    })
    .returning({ id: payments.id });
  await tx.insert(refunds).values({
    ...taxIds,
    paymentId: p!.id,
    publicId: `re_orders_tax_${stamp}`,
    status: "succeeded",
    amountMinor: 11800n,
    currency: "USD",
    providerKey: "offline",
    createdAt: at("2026-06-16"),
  });
});

let paired = true;
try {
  assertRegistryImplemented();
} catch (e) {
  paired = false;
  console.error(e);
}
ok("registry: the order measures are declared and implemented with their slices", paired);
ok("registry: eleven order measures", MEASURES.filter((m) => m.source === "orders").length === 11);

const rows = await withTenant(orgId, (tx) =>
  computeMetricPeriod(tx, bizId, "month", "2026-06-30", NOW),
);
const g = (m: string, dim = "", v = "") =>
  rows.find((r) => r.measure === m && r.dim === dim && r.dimValue === v && r.currency === "USD");
const val = (m: string, dim = "", v = "") => g(m, dim, v)?.value ?? null;
const rate = (m: string) => {
  const r = g(m);
  return r ? ratioValue(measureById(m)!, r.value, r.denominator ?? null) : null;
};

ok(
  "orders: A on 5 June and B on 8 June; the pack, the subscription fee and the draft are out",
  val("orders") === 2n,
);
ok("order revenue: 2000 + (4000 − 300)", val("order_revenue") === 5700n);
ok(
  "order revenue by product: the coupon spread 3:1 — mug 2000 + 2775, poster 925",
  val("order_revenue", "product", mugProduct.id) === 4775n &&
    val("order_revenue", "product", posterProduct.id) === 925n,
);
ok("average order value: 5700 ÷ 2", rate("average_order_value") === 2850);
ok("buyers: A and B", val("buyers") === 2n);
ok("returning buyers: A ordered in May", val("returning_buyers") === 1n);
ok("returning buyer rate: 1 of 2", rate("returning_buyer_rate") === 5000);
ok("order refunds: 700 on B's order", val("order_refunds") === 700n);
ok(
  "order refunds by product: 700 spread by revenue 2775:925 → mug 525, poster 175",
  val("order_refunds", "product", mugProduct.id) === 525n &&
    val("order_refunds", "product", posterProduct.id) === 175n,
);
ok("order refund rate: 700 ÷ 5700", rate("order_refund_rate") === 1228);
const rateBy = (product: string) => {
  const r = g("order_refund_rate", "product", product);
  return r ? ratioValue(measureById("order_refund_rate")!, r.value, r.denominator ?? null) : null;
};
ok(
  "order refund rate by product: mug 525 ÷ 4775, poster 175 ÷ 925",
  rateBy(mugProduct.id) === 1099 && rateBy(posterProduct.id) === 1892,
);
ok("order discount: the coupon's 225 + 75 on B's lines", val("order_discount") === 300n);
ok(
  "units sold: mug 2 + 3, poster 1; the pack and the subscription fee are out",
  val("units_sold") === 6n &&
    val("units_sold", "product", mugProduct.id) === 5n &&
    val("units_sold", "product", posterProduct.id) === 1n,
);
ok(
  "buyer type: A's order is returning (2000), B's is a first order (3700)",
  val("orders", "buyer_type", "returning") === 1n &&
    val("orders", "buyer_type", "first") === 1n &&
    val("order_revenue", "buyer_type", "returning") === 2000n &&
    val("order_revenue", "buyer_type", "first") === 3700n,
);
ok(
  "country: A's lower-case country reads IN; B has none",
  val("orders", "country", "IN") === 1n &&
    val("order_revenue", "country", "IN") === 2000n &&
    val("order_revenue", "country", "none") === 3700n,
);
ok(
  "gateway: B's order paid offline; A's is unpaid",
  val("orders", "gateway", "offline") === 1n &&
    val("order_revenue", "gateway", "offline") === 3700n &&
    val("order_revenue", "gateway", "none") === 2000n,
);
ok(
  "coupon: B's order carries the coupon; A's carries none",
  val("orders", "coupon", couponId) === 1n &&
    val("order_revenue", "coupon", couponId) === 3700n &&
    val("order_revenue", "coupon", "none") === 2000n,
);
const life = g("buyer_lifetime_revenue");
ok(
  "revenue per buyer: every order to 30 June (1000 + 2000 + 3700) ÷ A and B",
  life?.value === 6700n &&
    life?.denominator === 2n &&
    ratioValue(measureById("buyer_lifetime_revenue")!, life.value, life.denominator) === 3350,
);

const repeat = await resolveReport(orgId, bizId, "repeat_purchase_cohort", { now: NOW });
const may = repeat.matrix?.rows.find((r) => r.group === "May 2026");
const jun = repeat.matrix?.rows.find((r) => r.group === "Jun 2026");
ok(
  "repeat cohort: May is A, who ordered again in June; Oct has not begun",
  may?.base === 1 &&
    JSON.stringify(may.values.slice(0, 6)) ===
      JSON.stringify([0, 10000, 10000, 10000, 10000, null]),
);
ok(
  "repeat cohort: June is B, who never ordered again",
  jun?.base === 1 && JSON.stringify(jun.values.slice(0, 5)) === JSON.stringify([0, 0, 0, 0, null]),
);
const spend = await resolveReport(orgId, bizId, "buyer_revenue_cohort", { now: NOW });
const maySpend = spend.matrix?.rows.find((r) => r.group === "May 2026");
const junSpend = spend.matrix?.rows.find((r) => r.group === "Jun 2026");
ok(
  "revenue cohort: May's buyer is worth 1000, then 3000 from June; June's 3700; cells are money",
  spend.matrix?.value_kind === "money" &&
    JSON.stringify(maySpend?.values.slice(0, 3)) === JSON.stringify([1000, 3000, 3000]) &&
    junSpend?.values[0] === 3700,
);

const taxRows = await withTenant(orgId, (tx) =>
  computeMetricPeriod(tx, taxShop.id, "month", "2026-06-30", NOW),
);
const tg = (m: string, dim = "", v = "") =>
  taxRows.find((r) => r.measure === m && r.dim === dim && r.dimValue === v && r.currency === "USD");
const taxRate = tg("order_refund_rate");
ok(
  "taxed refund: order_refunds keeps the 11800 given back, tax included",
  tg("order_refunds")?.value === 11800n && tg("order_revenue")?.value === 15000n,
);
ok(
  "taxed refund rate: numerator is the pre-tax 10000, so 10000 ÷ 15000 = 6667 bps",
  taxRate?.value === 10000n &&
    taxRate?.denominator === 15000n &&
    ratioValue(measureById("order_refund_rate")!, taxRate.value, taxRate.denominator ?? null) ===
      6667,
);
const taxRateNone = tg("order_refund_rate", "product", "none");
ok(
  "taxed refund rate by product: the product slice sums to the same pre-tax 10000",
  taxRateNone?.value === 10000n && taxRateNone?.denominator === 15000n,
);

const day = await withTenant(orgId, (tx) =>
  computeMetricPeriod(tx, bizId, "day", "2026-06-05", NOW),
);
ok(
  "day grain: 5 June is A's one order, and A is returning",
  day.find((r) => r.measure === "orders")?.value === 1n &&
    day.find((r) => r.measure === "returning_buyers")?.value === 1n,
);

// The customer filters read the same order rule.
const count = async (filters: Array<{ field: string; op: string; value: string }>) =>
  (await listCustomersPage(orgId, bizId, { limit: 10, filters })).total ?? null;
ok(
  "filter: A has two orders",
  (await count([{ field: "order_count", op: "is", value: "2" }])) === 1,
);
ok(
  "filter: C (pack only) has no order",
  (await count([{ field: "order_count", op: "is", value: "0" }])) === 1,
);

// The cron writes a business that sells only one-time orders, and skips one with no activity.
const shopOnly = await createBusiness({
  organizationId: orgId,
  name: "Order Measure One-time Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
const idle = await createBusiness({
  organizationId: orgId,
  name: "Order Measure Idle Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
const shopper = await createCustomer({
  organizationId: orgId,
  businessId: shopOnly.id,
  email: `orders-shop-${stamp}@example.test`,
});
await withTenant(orgId, (tx) =>
  tx.insert(invoices).values({
    organizationId: orgId,
    businessId: shopOnly.id,
    customerId: shopper.id,
    publicId: `inv_orders_shop_${stamp}`,
    status: "paid",
    currency: "USD",
    subtotalMinor: 1000n,
    totalMinor: 1000n,
  }),
);
const cronIds = new Set((await businessesWithBillingActivity()).map((x) => x.id));
ok("cron: a business with only one-time invoices is written", cronIds.has(shopOnly.id));
ok("cron: a business with no billing activity is skipped", !cronIds.has(idle.id));

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log("");
console.log(
  failed === 0
    ? `✅ METRIC-ORDERS: PASS (${checks.length}/${checks.length})`
    : `❌ METRIC-ORDERS: FAIL (${failed}/${checks.length} failed)`,
);
if (failed > 0)
  console.log(
    rows
      .filter((r) => MEASURES.find((m) => m.id === r.measure)?.source === "orders")
      .map((r) => `${r.measure}|${r.dim}|${r.dimValue}=${r.value}/${r.denominator ?? ""}`)
      .join("\n"),
  );
await closeDb();
process.exit(failed === 0 ? 0 : 1);

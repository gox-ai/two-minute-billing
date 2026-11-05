/**
 * Oracle gate for the one-time sales measures (`order-measures.ts`). Hand-worked, June 2026:
 *   A  10 May  mug 1000                     → an order before June: A returns in June
 *   A   5 Jun  mug 2000                     → order
 *   B   8 Jun  mug 3000, discount −300      → order, 2700; paid 2700, 700 refunded 15 Jun
 *   C   9 Jun  credit pack 4000 only        → NOT an order (a top-up)
 *   B  20 Jun  setup fee 500 on a subscription invoice → NOT an order
 *   A  25 Jun  mug 999, pending             → NOT billed, NOT an order
 * June: 2 orders, revenue 4700 (all mug), AOV 2350, 2 buyers, 1 returning (50%), refunds 700.
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
import { invoiceLineItems, invoices, payments, refunds, subscriptions } from "@db/schema";

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
/** `[kind, amountMinor, priceId | null]` per line. */
async function invoice(
  customerId: string,
  day: string,
  lines: Array<[string, number, string | null]>,
  opts: { status?: string; subscriptionId?: string } = {},
): Promise<string> {
  const total = lines.reduce((s, l) => s + l[1], 0);
  return withTenant(orgId, async (tx) => {
    const [inv] = await tx
      .insert(invoices)
      .values({
        ...ids,
        customerId,
        publicId: `inv_orders_${++seq}_${stamp}`,
        status: opts.status ?? "paid",
        currency: "USD",
        subtotalMinor: BigInt(total),
        totalMinor: BigInt(total),
        subscriptionId: opts.subscriptionId ?? null,
        createdAt: at(day),
      })
      .returning({ id: invoices.id });
    let k = 0;
    for (const [kind, amount, priceId] of lines) {
      await tx.insert(invoiceLineItems).values({
        ...ids,
        invoiceId: inv!.id,
        publicId: `il_orders_${seq}_${++k}_${stamp}`,
        description: kind,
        quantity: 1,
        unitAmountMinor: BigInt(amount),
        amountMinor: BigInt(amount),
        priceId,
        kind,
        createdAt: at(day),
      });
    }
    return inv!.id;
  });
}
await invoice(a.id, "2026-05-10", [["one_time", 1000, mug.id]]);
await invoice(a.id, "2026-06-05", [["one_time", 2000, mug.id]]);
const bOrder = await invoice(b.id, "2026-06-08", [
  ["one_time", 3000, mug.id],
  ["discount", -300, null],
]);
await invoice(c.id, "2026-06-09", [["one_time", 4000, pack.id]]);
await invoice(b.id, "2026-06-20", [["one_time", 500, mug.id]], { subscriptionId: sub!.id });
await invoice(a.id, "2026-06-25", [["one_time", 999, mug.id]], { status: "pending" });

await withTenant(orgId, async (tx) => {
  const [p] = await tx
    .insert(payments)
    .values({
      ...ids,
      customerId: b.id,
      invoiceId: bOrder,
      publicId: `pay_orders_${stamp}`,
      status: "succeeded",
      amountMinor: 2700n,
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

let paired = true;
try {
  assertRegistryImplemented();
} catch (e) {
  paired = false;
  console.error(e);
}
ok("registry: the order measures are declared and implemented with their slices", paired);
ok("registry: seven order measures", MEASURES.filter((m) => m.source === "orders").length === 7);

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
ok("order revenue: 2000 + (3000 − 300)", val("order_revenue") === 4700n);
ok("order revenue: all of it is the mug", val("order_revenue", "product", mugProduct.id) === 4700n);
ok("average order value: 4700 ÷ 2", rate("average_order_value") === 2350);
ok("buyers: A and B", val("buyers") === 2n);
ok("returning buyers: A ordered in May", val("returning_buyers") === 1n);
ok("returning buyer rate: 1 of 2", rate("returning_buyer_rate") === 5000);
ok("order refunds: 700 on B's order", val("order_refunds") === 700n);

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

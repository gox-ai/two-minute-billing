/**
 * Oracle gate for the revenue mix: `revenue_billed` and `revenue_collected`.
 *
 * A fixture with every line kind (recurring, a negative proration, usage, a one-time product,
 * a credit pack, a document discount, exclusive tax, rounding), an inclusive-tax invoice, a
 * draft, a second currency and two payments. Figures are worked by hand below.
 *
 *   pnpm verify:revenue-mix
 */
import { sql } from "drizzle-orm";
import { closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createPrice, createProduct } from "@/modules/catalog/service";
import { assertRegistryImplemented, computeMetricPeriod } from "@/modules/metrics/daily/compute";
import { writeMetricDay } from "@/modules/metrics/daily/write";
import { measureById, type Grain } from "@/modules/metrics/daily/measures";
import { appliedTaxes, invoiceLineItems, invoices, metricDaily, payments } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const NOW = new Date("2026-09-15T12:00:00.000Z");
const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const stamp = Date.now();

const org = await createOrganization({ name: "Revenue Mix Oracle Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Revenue Mix Oracle Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
const bizId = biz.id;
const customer = await createCustomer({
  organizationId: orgId,
  businessId: bizId,
  email: `revenue-mix-${stamp}@example.test`,
});

/** A product with one price; `pack` makes the price grant a credit pack. */
async function product(name: string, pack = false) {
  const ids = { organizationId: orgId, businessId: bizId };
  const p = await createProduct({
    ...ids,
    name,
    kind: pack || name !== "plan" ? "charge" : "plan",
  });
  const pr = await createPrice({
    ...ids,
    productId: p.id,
    id: `rm-${name}-${stamp}`,
    type: name === "plan" ? "recurring" : "one_time",
    model: "flat",
    currency: "USD",
    amountMinor: 100,
    ...(name === "plan" ? { interval: "month" } : {}),
    ...(pack
      ? {
          grantsCredit: {
            kind: "pack",
            unit: null,
            amount: 4000,
            tax_treatment: "taxed_at_purchase",
          },
        }
      : {}),
  });
  return { productId: pr.productId, priceId: pr.id };
}
const plan = await product("plan");
const setup = await product("setup");
const pack = await product("pack", true);

let seq = 0;
/** `[kind, amountMinor, priceId | null, appliedTaxMinor]` per line. */
async function invoice(i: {
  currency: string;
  status: string;
  createdAt: string;
  totalMinor: number;
  lines: Array<[string, number, string | null, number]>;
}): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx
      .insert(invoices)
      .values({
        organizationId: orgId,
        businessId: bizId,
        customerId: customer.id,
        publicId: `inv_rm_${++seq}_${stamp}`,
        status: i.status,
        currency: i.currency,
        subtotalMinor: BigInt(i.totalMinor),
        totalMinor: BigInt(i.totalMinor),
        createdAt: at(i.createdAt),
      })
      .returning({ id: invoices.id });
    let n = 0;
    for (const [kind, amount, priceId, tax] of i.lines) {
      const [line] = await tx
        .insert(invoiceLineItems)
        .values({
          organizationId: orgId,
          businessId: bizId,
          invoiceId: row!.id,
          publicId: `il_rm_${seq}_${++n}_${stamp}`,
          description: `${kind} line`,
          quantity: 1,
          unitAmountMinor: BigInt(amount),
          amountMinor: BigInt(amount),
          priceId,
          kind,
          createdAt: at(i.createdAt),
        })
        .returning({ id: invoiceLineItems.id });
      if (tax !== 0) {
        await tx.insert(appliedTaxes).values({
          organizationId: orgId,
          businessId: bizId,
          invoiceId: row!.id,
          invoiceLineItemId: line!.id,
          name: "TAX",
          rateBps: 1800,
          amountMinor: BigInt(tax),
          taxabilityReason: "standard_rated",
          createdAt: at(i.createdAt),
        });
      }
    }
    return row!.id;
  });
}

async function payment(invoiceId: string, currency: string, amountMinor: number, day: string) {
  await withTenant(orgId, (tx) =>
    tx.insert(payments).values({
      organizationId: orgId,
      businessId: bizId,
      customerId: customer.id,
      invoiceId,
      publicId: `pay_rm_${++seq}_${stamp}`,
      status: "succeeded",
      amountMinor: BigInt(amountMinor),
      currency,
      providerKey: "offline",
      createdAt: at(day),
    }),
  );
}

// Invoice 1 (USD, 10 June). Revenue weights 10000 − 2000 + 3000 + 5000 + 4000 = 20000; the
// −2000 document discount is −10% of each: plan 9000, proration −1800, usage 2700, setup
// 4500, pack 3600. Exclusive tax 1800 and rounding 1 are not revenue. Total 19801.
const inv1 = await invoice({
  currency: "USD",
  status: "paid",
  createdAt: "2026-06-10",
  totalMinor: 19801,
  lines: [
    ["recurring", 10000, plan.priceId, 1800],
    ["proration", -2000, null, 0],
    ["usage", 3000, null, 0],
    ["one_time", 5000, setup.priceId, 0],
    ["one_time", 4000, pack.priceId, 0],
    ["discount", -2000, null, 0],
    ["tax", 1800, null, 0],
    ["rounding", 1, null, 0],
  ],
});
// Invoice 2 (USD, 15 June): an inclusive-tax one-time line with no price. 1180 holds 180 tax.
const inv2 = await invoice({
  currency: "USD",
  status: "payment_due",
  createdAt: "2026-06-15",
  totalMinor: 1180,
  lines: [["one_time", 1180, null, 180]],
});
// A pending (draft) invoice is not billing.
await invoice({
  currency: "USD",
  status: "pending",
  createdAt: "2026-06-15",
  totalMinor: 7777,
  lines: [["one_time", 7777, setup.priceId, 0]],
});
// EUR stays EUR.
await invoice({
  currency: "EUR",
  status: "posted",
  createdAt: "2026-06-12",
  totalMinor: 900,
  lines: [["one_time", 900, null, 0]],
});
await payment(inv1, "USD", 19801, "2026-06-10");
// Half of invoice 2: 500 revenue, 90 tax.
await payment(inv2, "USD", 590, "2026-06-15");

type Key = string;
const key = (m: string, dim: string, v: string, cur: string): Key => `${m}|${dim}|${v}|${cur}`;
const WATCHED = new Set([
  "revenue_billed",
  "billed_customers",
  "revenue_per_customer",
  "revenue_collected",
  "billing_non_recurring",
  "taxable_base",
  "cash_collected",
]);

async function materialise(grain: Grain, periodEnd: string): Promise<Map<Key, bigint>> {
  const rows = await withTenant(orgId, (tx) =>
    computeMetricPeriod(tx, bizId, grain, periodEnd, NOW),
  );
  await writeMetricDay({ organizationId: orgId, businessId: bizId, grain, periodEnd, rows });
  const stored = await withTenant(orgId, (tx) =>
    tx
      .select({
        measure: metricDaily.measure,
        dim: metricDaily.dim,
        dimValue: metricDaily.dimValue,
        currency: metricDaily.currency,
        value: metricDaily.value,
      })
      .from(metricDaily)
      .where(
        sql`${metricDaily.businessId} = ${bizId} and ${metricDaily.grain} = ${grain} and ${metricDaily.periodEnd} = ${periodEnd}`,
      ),
  );
  const out = new Map<Key, bigint>();
  for (const r of stored) {
    if (WATCHED.has(r.measure))
      out.set(key(r.measure, r.dim, r.dimValue, r.currency), r.value ?? 0n);
  }
  return out;
}

let registryOk = true;
try {
  assertRegistryImplemented();
} catch (e) {
  registryOk = false;
  console.error(e);
}
ok("registry: both measures are declared and implemented with the same slices", registryOk);
ok(
  "registry: revenue_billed slices by revenue_type and product, revenue_collected by revenue_type",
  measureById("revenue_billed")?.dimensions.includes("product") === true &&
    measureById("revenue_collected")?.dimensions.includes("revenue_type") === true,
);

const june = await materialise("month", "2026-06-30");
const g = (m: string, dim = "", v = "", cur = "USD") => june.get(key(m, dim, v, cur));
const slices = (m: string, dim: string, cur = "USD") =>
  [...june.entries()]
    .filter(([k]) => k.startsWith(`${m}|${dim}|`) && k.endsWith(`|${cur}`))
    .reduce((s, [, v]) => s + v, 0n);

// ── Billed ──
ok(
  "billed: total is 19000 (18000 + the 1000 inside the inclusive line)",
  g("revenue_billed") === 19000n,
);
ok(
  "billed: recurring = plan 9000 + proration −1800 = 7200",
  g("revenue_billed", "revenue_type", "recurring") === 7200n,
);
ok("billed: usage 2700", g("revenue_billed", "revenue_type", "usage") === 2700n);
ok(
  "billed: one-time = setup 4500 + inclusive 1000 (the draft's 7777 is out)",
  g("revenue_billed", "revenue_type", "one_time") === 5500n,
);
ok(
  "billed: the credit pack is its own type, 3600",
  g("revenue_billed", "revenue_type", "credit_pack") === 3600n,
);
ok(
  "billed: the types sum to the total",
  slices("revenue_billed", "revenue_type") === g("revenue_billed"),
);
ok("billed: product plan 9000", g("revenue_billed", "product", plan.productId) === 9000n);
ok("billed: product setup 4500", g("revenue_billed", "product", setup.productId) === 4500n);
ok("billed: product pack 3600", g("revenue_billed", "product", pack.productId) === 3600n);
ok(
  "billed: lines with no price fall under none: −1800 + 2700 + 1000",
  g("revenue_billed", "product", "none") === 1900n,
);
ok(
  "billed: the products sum to the total",
  slices("revenue_billed", "product") === g("revenue_billed"),
);
ok(
  "billed: total = taxable base − rounding (19001 − 1)",
  g("taxable_base") === 19001n && g("revenue_billed") === g("taxable_base")! - 1n,
);
ok(
  "billed: billing_non_recurring keeps its meaning — gross one-time lines, pack included (10180)",
  g("billing_non_recurring") === 10180n,
);
ok(
  "currency: EUR is its own figure, 900 one-time",
  g("revenue_billed", "", "", "EUR") === 900n &&
    g("revenue_billed", "revenue_type", "one_time", "EUR") === 900n,
);

// ── Per customer (one USD customer billed; the pending draft does not count) ──
ok("per customer: one customer billed in USD", g("billed_customers") === 1n);
ok("per customer: the revenue numerator is revenue billed", g("revenue_per_customer") === 19000n);

// ── Collected ──
ok("collected: total 18000 + 500 = 18500", g("revenue_collected") === 18500n);
ok("collected: recurring 7200", g("revenue_collected", "revenue_type", "recurring") === 7200n);
ok("collected: usage 2700", g("revenue_collected", "revenue_type", "usage") === 2700n);
ok("collected: one-time 4500 + 500", g("revenue_collected", "revenue_type", "one_time") === 5000n);
ok("collected: credit pack 3600", g("revenue_collected", "revenue_type", "credit_pack") === 3600n);
ok(
  "collected: the types sum to the total",
  slices("revenue_collected", "revenue_type") === g("revenue_collected"),
);
const bucket = (b: string) => g("cash_collected", "cash_bucket", b) ?? 0n;
ok(
  "collected: total = cash collected − tax − rounding − other − unattributed",
  g("revenue_collected") ===
    g("cash_collected")! -
      bucket("tax") -
      bucket("rounding") -
      bucket("other") -
      bucket("unattributed"),
);

// ── Tiling: a month is the sum of its days ──
const days = await Promise.all(
  ["2026-06-10", "2026-06-12", "2026-06-15"].map((d) => materialise("day", d)),
);
const daySum = (m: string, dim: string, v: string, cur = "USD") =>
  days.reduce((s, d) => s + (d.get(key(m, dim, v, cur)) ?? 0n), 0n);
ok(
  "tiling: revenue billed, month = Σ days",
  daySum("revenue_billed", "", "") === g("revenue_billed"),
);
ok(
  "tiling: one-time billed, month = Σ days",
  daySum("revenue_billed", "revenue_type", "one_time") ===
    g("revenue_billed", "revenue_type", "one_time"),
);
ok(
  "tiling: revenue collected, month = Σ days",
  daySum("revenue_collected", "", "") === g("revenue_collected"),
);

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log("");
console.log(
  failed === 0
    ? `✅ REVENUE-MIX: PASS (${checks.length}/${checks.length})`
    : `❌ REVENUE-MIX: FAIL (${failed}/${checks.length} failed)`,
);
if (failed > 0) console.log([...june.entries()].map(([k, v]) => `${k}=${v}`).join("\n"));
await closeDb();
process.exit(failed === 0 ? 0 : 1);

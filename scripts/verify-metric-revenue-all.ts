/**
 * Oracle gate for the measures over every revenue type (`revenue-measures.ts`).
 * Hand-worked, June 2026 (30 days; the window before it is 2 May–31 May):
 *   A  10 May recurring 5000, 10 Jun recurring 6000 (paid 11 Jun); a pending 700 in June is out
 *   B  20 May one-time 3000; nothing in June
 *   C  15 Jun usage 2000 (paid 16 Jun); 18 Jun INR one-time 50000
 *   D   5 Jun credit pack 4000 (its payment failed)
 *   E  10 Apr recurring 1000 (before both windows)
 *   F1–F11  1 Jun one-time 100 each
 *   X  excluded from reporting: 9999 in June, paid → out everywhere
 * USD, at 30 June:
 *   lifetime   5000 + 6000 + 3000 + 2000 + 4000 + 1000 + 11 × 100 = 22100 ÷ 16 customers = 1381
 *   retention  opening A 5000 + B 3000 = 8000; they were billed 6000 + 0 → 7500 bps
 *   top 10     June: A 6000, D 4000, C 2000, F 11 × 100 = 13100; top ten 12700 → 9695 bps
 *   paid       A and C → 2
 * INR: C's 50000 is the only revenue → lifetime 50000 ÷ 1, top-10 share 10000 bps.
 *
 *   pnpm verify:metric-revenue-all
 */
import { eq } from "drizzle-orm";
import { closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createPrice, createProduct } from "@/modules/catalog/service";
import { assertRegistryImplemented, computeMetricPeriod } from "@/modules/metrics/daily/compute";
import { MEASURES, measureById, ratioValue } from "@/modules/metrics/daily/measures";
import { customers, invoiceLineItems, invoices, payments } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const stamp = Date.now();
const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const NOW = new Date("2026-09-15T12:00:00.000Z");

const org = await createOrganization({ name: "Revenue All Oracle Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Revenue All Oracle Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
const bizId = biz.id;
const ids = { organizationId: orgId, businessId: bizId };
const mk = (k: string) => createCustomer({ ...ids, email: `revall-${k}-${stamp}@example.test` });
const [a, b, c, d, e, x] = [
  await mk("a"),
  await mk("b"),
  await mk("c"),
  await mk("d"),
  await mk("e"),
  await mk("x"),
];
await withTenant(orgId, (tx) =>
  tx.update(customers).set({ excludeFromReporting: true }).where(eq(customers.id, x.id)),
);

const packProduct = await createProduct({ ...ids, name: "Credit pack", kind: "charge" });
const pack = await createPrice({
  ...ids,
  productId: packProduct.id,
  id: `revall-pack-${stamp}`,
  type: "one_time",
  model: "flat",
  currency: "USD",
  amountMinor: 4000,
  grantsCredit: { kind: "pack", unit: null, amount: 4000, tax_treatment: "taxed_at_purchase" },
});

let seq = 0;
async function invoice(
  customerId: string,
  day: string,
  kind: string,
  amount: number,
  opts: { status?: string; currency?: string; priceId?: string } = {},
): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const [inv] = await tx
      .insert(invoices)
      .values({
        ...ids,
        customerId,
        publicId: `inv_revall_${++seq}_${stamp}`,
        status: opts.status ?? "paid",
        currency: opts.currency ?? "USD",
        subtotalMinor: BigInt(amount),
        totalMinor: BigInt(amount),
        createdAt: at(day),
      })
      .returning({ id: invoices.id });
    await tx.insert(invoiceLineItems).values({
      ...ids,
      invoiceId: inv!.id,
      publicId: `il_revall_${seq}_${stamp}`,
      description: kind,
      quantity: 1,
      unitAmountMinor: BigInt(amount),
      amountMinor: BigInt(amount),
      priceId: opts.priceId ?? null,
      kind,
      createdAt: at(day),
    });
    return inv!.id;
  });
}
async function pay(
  customerId: string,
  invoiceId: string,
  day: string,
  amount: number,
  status = "succeeded",
) {
  await withTenant(orgId, (tx) =>
    tx.insert(payments).values({
      ...ids,
      customerId,
      invoiceId,
      publicId: `pay_revall_${++seq}_${stamp}`,
      status,
      amountMinor: BigInt(amount),
      currency: "USD",
      providerKey: "offline",
      createdAt: at(day),
    }),
  );
}

await invoice(a.id, "2026-05-10", "recurring", 5000);
const aJune = await invoice(a.id, "2026-06-10", "recurring", 6000);
await pay(a.id, aJune, "2026-06-11", 6000);
await invoice(a.id, "2026-06-12", "recurring", 700, { status: "pending" });
await invoice(b.id, "2026-05-20", "one_time", 3000);
const cJune = await invoice(c.id, "2026-06-15", "usage", 2000);
await pay(c.id, cJune, "2026-06-16", 2000);
await invoice(c.id, "2026-06-18", "one_time", 50000, { currency: "INR" });
const dJune = await invoice(d.id, "2026-06-05", "one_time", 4000, { priceId: pack.id });
await pay(d.id, dJune, "2026-06-06", 4000, "failed");
await invoice(e.id, "2026-04-10", "recurring", 1000);
for (let i = 1; i <= 11; i++) {
  const f = await mk(`f${i}`);
  await invoice(f.id, "2026-06-01", "one_time", 100);
}
const xJune = await invoice(x.id, "2026-06-20", "recurring", 9999);
await pay(x.id, xJune, "2026-06-21", 9999);

let paired = true;
try {
  assertRegistryImplemented();
} catch (err) {
  paired = false;
  console.error(err);
}
ok("registry: the all-revenue measures are declared and implemented", paired);
ok(
  "registry: four all-revenue measures",
  MEASURES.filter((m) => m.source === "revenue").length === 4,
);

const rows = await withTenant(orgId, (tx) =>
  computeMetricPeriod(tx, bizId, "month", "2026-06-30", NOW),
);
const g = (m: string, cur = "USD") =>
  rows.find((r) => r.measure === m && r.dim === "" && r.currency === cur);
const rate = (m: string, cur = "USD") => {
  const r = g(m, cur);
  return r ? ratioValue(measureById(m)!, r.value, r.denominator ?? null) : null;
};

const life = g("customer_revenue_lifetime");
ok(
  "lifetime revenue per customer: every type to 30 June, 22100 ÷ 16; the pending one and X are out",
  life?.value === 22100n && life?.denominator === 16n && rate("customer_revenue_lifetime") === 1381,
);
const ret = g("revenue_retention_all");
ok(
  "retention: A and B were billed 8000 in May, 6000 in June → 7500 bps; C, D and F are new",
  ret?.value === 6000n && ret?.denominator === 8000n && rate("revenue_retention_all") === 7500,
);
const top = g("revenue_top10_share");
ok(
  "top 10 share: 12700 of 13100 → 9695 bps (one F of 100 is 11th)",
  top?.value === 12700n && top?.denominator === 13100n && rate("revenue_top10_share") === 9695,
);
ok(
  "customers who paid: A and C; D's payment failed; X is out",
  g("paying_customers_all")?.value === 2n,
);
ok(
  "per currency: the INR order is its own figure",
  rate("customer_revenue_lifetime", "INR") === 50000 &&
    rate("revenue_top10_share", "INR") === 10000,
);
ok(
  "lifetime agrees with revenue billed: the same rule over the same invoices",
  rows.find((r) => r.measure === "revenue_billed" && r.dim === "" && r.currency === "USD")
    ?.value ===
    6000n + 2000n + 4000n + 1100n,
);

// The window counts are written per grain: a day is its own answer, not a slice of the month.
const day = await withTenant(orgId, (tx) =>
  computeMetricPeriod(tx, bizId, "day", "2026-06-10", NOW, { onlyNonAdditive: true }),
);
const dayTop = day.find((r) => r.measure === "revenue_top10_share" && r.currency === "USD");
ok(
  "day grain: on 10 June only A was billed, so the top ten hold all of it",
  dayTop?.value === 6000n && dayTop?.denominator === 6000n,
);
ok(
  "day grain: the lifetime ratio is not written by the non-additive pass",
  !day.some((r) => r.measure === "customer_revenue_lifetime"),
);

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log("");
console.log(
  failed === 0
    ? `✅ METRIC-REVENUE-ALL: PASS (${checks.length}/${checks.length})`
    : `❌ METRIC-REVENUE-ALL: FAIL (${failed}/${checks.length} failed)`,
);
if (failed > 0)
  console.log(
    rows
      .filter((r) => MEASURES.find((m) => m.id === r.measure)?.source === "revenue")
      .map((r) => `${r.measure}|${r.currency}=${r.value}/${r.denominator ?? ""}`)
      .join("\n"),
  );
await closeDb();
process.exit(failed === 0 ? 0 : 1);

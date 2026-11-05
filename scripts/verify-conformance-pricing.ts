/**
 * Conformance: tiered / volume / per-unit pricing cases, fixed input → expected
 * output, asserted against computeLineAmount. Expected amounts are major units
 * converted to our integer minor units (×100).
 *
 *   pnpm verify:conformance:pricing
 */
import { computeLineAmount } from "@/modules/catalog/pricing";
import type { prices } from "@db/schema";

type Price = typeof prices.$inferSelect;
function price(model: string, opts: { amountMinor?: number; tiers?: unknown[] }): Price {
  return {
    model,
    amountMinor: opts.amountMinor != null ? BigInt(opts.amountMinor) : null,
    tiers: opts.tiers ?? null,
  } as unknown as Price;
}

const results: Array<{ name: string; qty: number; got: number; want: number; ok: boolean }> = [];
function check(name: string, p: Price, qty: number, wantMinor: number) {
  const got = Number(computeLineAmount(p, qty));
  results.push({ name, qty, got, want: wantMinor, ok: got === wantMinor });
}

// --- Graduated (our `tiered`; tiers in minor units: ×100) ---
// 0-10: unit 10/flat 2 ; 11-20: unit 5/flat 3 ; 21+: unit 5/flat 3
const graduated = price("tiered", {
  tiers: [
    { upToMinor: 10, unitAmountMinor: 1000, flatAmountMinor: 200 },
    { upToMinor: 20, unitAmountMinor: 500, flatAmountMinor: 300 },
    { upToMinor: null, unitAmountMinor: 500, flatAmountMinor: 300 },
  ],
});
check("graduated agg=0", graduated, 0, 0);
check("graduated agg=1", graduated, 1, 1200); // 12
check("graduated agg=10", graduated, 10, 10200); // 102
check("graduated agg=11", graduated, 11, 11000); // 110
check("graduated agg=12", graduated, 12, 11500); // 115
check("graduated agg=21", graduated, 21, 16300); // 163

// --- Volume ---
// 0-100: unit 2/flat 10 ; 101-200: unit 1/flat 0 ; 201+: unit 0.5/flat 50
const volume = price("volume", {
  tiers: [
    { upToMinor: 100, unitAmountMinor: 200, flatAmountMinor: 1000 },
    { upToMinor: 200, unitAmountMinor: 100, flatAmountMinor: 0 },
    { upToMinor: null, unitAmountMinor: 50, flatAmountMinor: 5000 },
  ],
});
check("volume agg=0", volume, 0, 0);
check("volume agg=1", volume, 1, 1200); // 12
check("volume agg=100", volume, 100, 21000); // 210
check("volume agg=101", volume, 101, 10100); // 101
check("volume agg=200", volume, 200, 20000); // 200
check("volume agg=300", volume, 300, 20000); // 200

// --- Standard (our `per_unit`), integer amount case ---
// amount 10 (=1000 minor), agg 10 → 100 (=10000 minor)
const standard = price("per_unit", { amountMinor: 1000 });
check("standard agg=10", standard, 10, 10000); // 100

let pass = true;
for (const r of results) {
  console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}: got ${r.got} want ${r.want}`);
  if (!r.ok) pass = false;
}
console.log("");
console.log("Charge models covered: standard ✓ · graduated ✓ · volume ✓");
console.log(
  "Not supported (documented gaps): package, percentage, fractional aggregation (we use integer qty).",
);
console.log("");
console.log(pass ? "✅ PRICING CONFORMANCE: PASS" : "❌ PRICING CONFORMANCE: FAIL");
process.exit(pass ? 0 : 1);

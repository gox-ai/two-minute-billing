/**
 * Oracle gate for the credit measures (`credit-measures.ts`).
 *
 * Grants, draws and an expiry go through the credits service, so movements AND ledger
 * postings are real. Movements are stamped with the clock, so the fixture lives in today.
 * Hand-worked:
 *   A paid 10000 (cost 8000, bought on an invoice), expires in 10 days; draw 4000 → cost 3200; left 6000 / cost 4800
 *   B promotional 3000, no expiry;              draw 1000;              left 2000
 *   C paid 2000 (cost 2000), expired at once → breakage 2000;           left 0
 *   Prepaid account credit 2500 (customer balance ledger).
 *
 *   pnpm verify:metric-credits
 */
import { and, eq, sql } from "drizzle-orm";
import { closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { addPromotionalCredits } from "@/modules/customers/balances";
import {
  bookGrantRemainder,
  createPromotionalGrant,
  insertCreditGrant,
  postGrantDraws,
} from "@/modules/credits/service";
import { activatePaidCreditGrants } from "@/modules/credits/packs";
import { assertRegistryImplemented, computeMetricPeriod } from "@/modules/metrics/daily/compute";
import { MEASURES } from "@/modules/metrics/daily/measures";
import { CREDIT_LEDGER_ACCOUNTS, invoices, ledgerEntries } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const stamp = Date.now();
const DAY = 86_400_000;

const org = await createOrganization({ name: "Credit Measure Oracle Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Credit Measure Oracle Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
const bizId = biz.id;
const customer = await createCustomer({
  organizationId: orgId,
  businessId: bizId,
  email: `credit-oracle-${stamp}@example.test`,
});
const base = { organizationId: orgId, businessId: bizId, customerId: customer.id, currency: "USD" };

const [inv] = await withTenant(orgId, (tx) =>
  tx
    .insert(invoices)
    .values({
      organizationId: orgId,
      businessId: bizId,
      customerId: customer.id,
      publicId: `inv_credit_oracle_${stamp}`,
      status: "paid",
      currency: "USD",
      subtotalMinor: 5000n,
      totalMinor: 0n,
    })
    .returning({ id: invoices.id, publicId: invoices.publicId }),
);

const [grantA, grantC] = await withTenant(orgId, async (tx) => [
  await insertCreditGrant(tx, {
    ...base,
    unit: null,
    amount: 10000n,
    faceMinor: 10000n,
    costBasisMinor: 8000n,
    category: "paid",
    source: "purchase",
    invoiceId: inv!.id,
    status: "pending",
    taxTreatment: "taxed_at_purchase",
    expiresAt: new Date(Date.now() + 10 * DAY),
  }),
  await insertCreditGrant(tx, {
    ...base,
    unit: null,
    amount: 2000n,
    faceMinor: 2000n,
    costBasisMinor: 2000n,
    category: "paid",
    source: "purchase",
    invoiceId: inv!.id,
    status: "pending",
    taxTreatment: "taxed_at_purchase",
  }),
]);
// Paid credit activates when its invoice is paid: the ledger posting and the movement.
const activated = await withTenant(orgId, (tx) =>
  activatePaidCreditGrants(tx, { organizationId: orgId, invoiceId: inv!.id }),
);
const grantB = await createPromotionalGrant({
  organizationId: orgId,
  businessId: bizId,
  customerPublicId: customer.publicId,
  currency: "USD",
  amount: 3000n,
});

await withTenant(orgId, async (tx) => {
  await postGrantDraws(tx, {
    ...base,
    invoiceId: inv!.id,
    invoicePublicId: inv!.publicId,
    draws: [
      {
        grantId: grantA!.id,
        category: "paid",
        phase: "pre_tax",
        faceMinor: 4000n,
        units: 4000n,
        costMinor: 3200n,
        byLine: [],
      },
      {
        grantId: grantB.id,
        category: "promotional",
        phase: "pre_tax",
        faceMinor: 1000n,
        units: 1000n,
        costMinor: 0n,
        byLine: [],
      },
    ],
  });
  await bookGrantRemainder(tx, { grant: grantC!, kind: "expire" });
});
await addPromotionalCredits({
  organizationId: orgId,
  businessId: bizId,
  customer,
  amountMinor: 2500,
  currency: "USD",
});

const NOW = new Date();
const today = NOW.toISOString().slice(0, 10);
const monthEnd = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + 1, 0))
  .toISOString()
  .slice(0, 10);

ok("fixture: both paid grants activated through the pack path", activated === 2);
let paired = true;
try {
  assertRegistryImplemented();
} catch (e) {
  paired = false;
  console.error(e);
}
ok("registry: every credit measure is declared and implemented with its slices", paired);
ok(
  "registry: ten credit measures plus the expiring reading",
  MEASURES.filter((m) => m.source === "credits").length === 11,
);

async function figures(grain: "day" | "month", periodEnd: string) {
  const rows = await withTenant(orgId, (tx) =>
    computeMetricPeriod(tx, bizId, grain, periodEnd, NOW, {
      measures: new Set(MEASURES.filter((m) => m.source === "credits").map((m) => m.id)),
    }),
  );
  const out = new Map<string, bigint>();
  for (const r of rows) out.set(`${r.measure}|${r.dim}|${r.dimValue}|${r.currency}`, r.value ?? 0n);
  return out;
}
const day = await figures("day", today);
const g = (m: string, dim = "", v = "") => day.get(`${m}|${dim}|${v}|USD`);

ok("granted: 10000 + 3000 + 2000", g("credits_granted") === 15000n);
ok(
  "granted: paid 12000, promotional 3000",
  g("credits_granted", "credit_category", "paid") === 12000n &&
    g("credits_granted", "credit_category", "promotional") === 3000n,
);
ok(
  "granted: bought 12000, by hand 3000",
  g("credits_granted", "credit_source", "purchase") === 12000n &&
    g("credits_granted", "credit_source", "manual") === 3000n,
);
ok("used: 4000 + 1000", g("credits_used") === 5000n);
ok(
  "used: paid 4000, promotional 1000",
  g("credits_used", "credit_category", "paid") === 4000n &&
    g("credits_used", "credit_category", "promotional") === 1000n,
);
ok("used cost: the paid draw's cost, 3200", g("credits_used_cost") === 3200n);
ok(
  "expired: grant C, 2000",
  g("credits_expired") === 2000n && g("credits_expired", "credit_category", "paid") === 2000n,
);
ok("breakage: grant C's cost, 2000", g("credit_breakage") === 2000n);
ok("balance: 6000 + 2000", g("credits_outstanding") === 8000n);
ok(
  "balance: paid 6000, promotional 2000",
  g("credits_outstanding", "credit_category", "paid") === 6000n &&
    g("credits_outstanding", "credit_category", "promotional") === 2000n,
);
ok("balance: all money", g("credits_outstanding", "credit_unit", "money") === 8000n);
ok("liability: 8000 − 3200", g("credits_liability") === 4800n);
ok("customers with credit: 1", g("credit_customers") === 1n);
ok("prepaid account balance: 2500", g("prepaid_balance") === 2500n);
ok("packs sold: none", g("credit_packs_sold") === 0n);
ok("expiring: 8000 held now", g("credits_expiring") === 8000n);
ok("expiring: A's 6000 within 30 days", g("credits_expiring", "horizon", "1_30") === 6000n);
ok("expiring: B's 2000 has no date", g("credits_expiring", "horizon", "undated") === 2000n);

// The stocks reconcile to the ledger accounts the credits service posts.
const ledger = await withTenant(orgId, (tx) =>
  tx
    .select({
      account: ledgerEntries.account,
      bal: sql<string>`sum(case when ${ledgerEntries.direction} = 'credit' then ${ledgerEntries.amountMinor} else -${ledgerEntries.amountMinor} end)`,
    })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.businessId, bizId)))
    .groupBy(ledgerEntries.account),
);
const acct = (a: string) => BigInt(ledger.find((r) => r.account === a)?.bal ?? 0);
ok(
  "ledger: liability = credit_grants_paid balance",
  g("credits_liability") === acct(CREDIT_LEDGER_ACCOUNTS.paid),
);
ok(
  "ledger: breakage = credit_breakage postings",
  g("credit_breakage") === acct(CREDIT_LEDGER_ACCOUNTS.breakage),
);
ok(
  "ledger: promotional balance = credit_grants_promotional balance",
  g("credits_outstanding", "credit_category", "promotional") ===
    acct(CREDIT_LEDGER_ACCOUNTS.promotional),
);

// A month folds flows by summing and stocks by the last day; here both are today.
const month = await figures("month", monthEnd);
ok(
  "month: flows equal the day's (all movement is today)",
  month.get("credits_used|||USD") === 5000n,
);
ok("month: the stock is the period's last value", month.get("credits_outstanding|||USD") === 8000n);

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log("");
console.log(
  failed === 0
    ? `✅ METRIC-CREDITS: PASS (${checks.length}/${checks.length})`
    : `❌ METRIC-CREDITS: FAIL (${failed}/${checks.length} failed)`,
);
if (failed > 0) console.log([...day.entries()].map(([k, v]) => `${k}=${v}`).join("\n"));
await closeDb();
process.exit(failed === 0 ? 0 : 1);

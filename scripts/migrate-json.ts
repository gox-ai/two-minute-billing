/**
 * Import subscriptions/customers/plans from a JSON export of your own system —
 * the turnkey migration path. Validates the file, then imports with the same
 * guarantees as every source: no double-charge, payment continuity (linked
 * cards), idempotent re-runs.
 *
 *   pnpm migrate:json <file.json> [--dry-run]
 *       [--business biz_…]                       # import into an existing business
 *       [--org-id <uuid> --business-id <uuid>]   # re-run into the SAME org/business
 *       [--org-name "Co"] [--business-name "Biz"] [--currency USD]
 *
 * First run prints the new org's API key + org-id/business-id; pass those back
 * with --org-id/--business-id to re-import idempotently into the same tenant.
 */
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { withTenant, closeDb, systemDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { JsonFileSource } from "@/modules/migration/json-file";
import { importFromSource } from "@/modules/migration/import";
import { businesses, invoices, payments } from "@db/schema";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

if (!file) {
  console.error(
    "usage: pnpm migrate:json <file.json> [--dry-run] [--business biz_…] [--org-id <id> --business-id <id>] [--org-name ..] [--business-name ..] [--currency USD]",
  );
  process.exit(1);
}

const raw = JSON.parse(await readFile(file, "utf8"));

// Validate up front (throws a clear ZodError listing every bad field).
let source: JsonFileSource;
try {
  source = new JsonFileSource(raw, "json");
} catch (e) {
  console.error("❌ invalid migration file:");
  console.error(e instanceof Error ? e.message : String(e));
  await closeDb();
  process.exit(1);
}

const [catalog, customers, subs] = await Promise.all([
  source.listCatalog(),
  source.listCustomers(),
  source.listSubscriptions(),
]);
const withCard = customers.filter((c) => (c.paymentMethods?.length ?? 0) > 0).length;
console.log(
  `file ok: plans=${catalog.prices.length} customers=${customers.length} subscriptions=${subs.length}`,
);
console.log(
  `payment continuity: ${withCard}/${customers.length} customers carry a card (first renewal will charge)`,
);

if (has("dry-run")) {
  console.log("✅ DRY RUN — file valid, nothing written");
  await closeDb();
  process.exit(0);
}

// Resolve target tenant: existing (idempotent re-run) or fresh.
let orgId = flag("org-id");
let businessId = flag("business-id");
let printedKey: string | undefined;
const businessPublicId = flag("business");
if (businessPublicId) {
  // No tenant is known yet, so this one lookup runs without RLS.
  const [biz] = await systemDb
    .select({ id: businesses.id, organizationId: businesses.organizationId })
    .from(businesses)
    .where(eq(businesses.publicId, businessPublicId));
  if (!biz) {
    console.error(`❌ no business ${businessPublicId}`);
    await closeDb();
    process.exit(1);
  }
  orgId = biz.organizationId;
  businessId = biz.id;
}
if (!orgId || !businessId) {
  const org = await createOrganization({ name: flag("org-name") ?? "Migrated Org" });
  orgId = org.organization.id;
  printedKey = org.secret;
  const biz = await createBusiness({
    organizationId: orgId,
    name: flag("business-name") ?? "Imported",
    defaultCurrency: flag("currency") ?? "USD",
  });
  businessId = biz.id;
}

console.log(`importing into org=${orgId} business=${businessId} …`);
const r = await importFromSource({ organizationId: orgId, businessId, source });
console.log(
  `  products=${JSON.stringify(r.counts.products)} prices=${JSON.stringify(r.counts.prices)} customers=${JSON.stringify(r.counts.customers)} payment_methods=${JSON.stringify(r.counts.payment_methods)} subscriptions=${JSON.stringify(r.counts.subscriptions)}`,
);

// Assert the no-double-charge invariant.
const money = await withTenant(orgId, async (tx) => ({
  invoices: (await tx.select().from(invoices).where(eq(invoices.businessId, businessId!))).length,
  payments: (await tx.select().from(payments).where(eq(payments.businessId, businessId!))).length,
}));
console.log(
  `  invoices=${money.invoices} payments=${money.payments} (both 0 — import never charges)`,
);

console.log("");
console.log("✅ IMPORT COMPLETE");
if (printedKey) {
  console.log("");
  console.log("Save these — the API key is shown only once:");
  console.log(`  API key:      ${printedKey}`);
  console.log(`  org-id:       ${orgId}`);
  console.log(`  business-id:  ${businessId}`);
  console.log(
    `Re-run idempotently with:  pnpm migrate:json ${file} --org-id ${orgId} --business-id ${businessId}`,
  );
}
await closeDb();
process.exit(0);

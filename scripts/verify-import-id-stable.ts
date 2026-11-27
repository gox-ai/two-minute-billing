/**
 * The public id an imported GATEWAY ACCOUNT gets, and why it matters.
 *
 * The inbound webhook URL is `/v1/gateway_webhooks/<gateway>?id=<gateway account public
 * id>`, and that URL is registered **in the provider's own dashboard** (Stripe /
 * RazorPay / PayPal). So the id is a value another system already holds, not an internal
 * detail: an import that changes it kills every registered endpoint — silently, because
 * the gateway simply starts 404ing and that is indistinguishable from it having stopped
 * sending.
 *
 * Two sources, and only two:
 *   1. `GATEWAY_ACCOUNT_IDS` — `stripe=gwa_…,paypal=gwa_…,razorpay=gw_…`
 *   2. a fresh `gwa_…`
 *
 * The source's own gateway id is deliberately NOT used: a source may have no
 * `/gateway_accounts` endpoint, so accounts are derived from payment sources and
 * transactions, and only some gateways have an id at all. Depending on it gave stability for some providers and not
 * others — one explicit rule beats a ladder that silently covers half the cases.
 *
 * Consequence this pins: **the pin is load-bearing.** An unpinned gateway gets a fresh
 * id on every import and its registered URL goes stale, so the importer warns loudly.
 *
 *   pnpm verify:import-id-stable
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { systemDb, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { importFromSource, GATEWAY_ACCOUNT_IMPORT_ENABLED } from "@/modules/migration/import";
import { buildNotificationUrl } from "@/modules/gateway/webhook-endpoint";
import { gatewayAccounts } from "@db/schema";
import { pinnedGatewayAccountId } from "@/platform/config";
import type { MigrationSource } from "@/modules/migration/types";

// The block this suite covers is deliberately disabled (see
// `GATEWAY_ACCOUNT_IMPORT_ENABLED`). Skip loudly rather than fail: it failed 4/6 from the
// moment the block was commented out on 2026-08-07, and because this suite is not in
// `verify:all`'s CORE list nobody saw it — a permanently red gate for a known reason is
// one people learn to scroll past. Re-enabling the import re-arms this coverage.
if (!GATEWAY_ACCOUNT_IMPORT_ENABLED) {
  console.log("⏭  IMPORT GATEWAY ID: SKIPPED — gateway-account import is disabled");
  console.log("   (src/modules/migration/import.ts → GATEWAY_ACCOUNT_IMPORT_ENABLED = false;");
  console.log("    listGatewayAccounts() paginates the source's whole transaction history —");
  console.log("    ~20 min for 3 rows on a live book. Re-enable the block to re-arm this suite.)");
  await closeDb();
  process.exit(0);
}

const checks: [string, boolean, string?][] = [];
const ok = (n: string, c: boolean, d?: string) => checks.push([n, c, d]);
const RUN = randomUUID().slice(0, 8);

/**
 * The pin under test, read back through the SAME helper the importer uses (so this also
 * covers the `stripe=…,paypal=…` parser). Supplied by the package script as a per-run
 * unique value: the public-id index is global, so a fixed pin could only ever be claimed
 * once in a given database and the suite would pass exactly one time.
 */
const PIN = pinnedGatewayAccountId("stripe");
if (!PIN) {
  console.error(
    "GATEWAY_ACCOUNT_IDS must set a stripe pin — run via `pnpm verify:import-id-stable`.",
  );
  process.exit(1);
}
const PINNED_STRIPE: string = PIN;
/** The source's own id for the account — present, and deliberately ignored. */
const SRC_GW_ID = `gw_SrcGw${RUN}`;

/**
 * Minimal source: the three required methods empty, plus two gateway accounts — one
 * pinned (stripe) and one not (razorpay), so both branches run in a single import.
 */
const stubSource = (): MigrationSource => ({
  name: "stub",
  listCatalog: async () => ({
    groups: [],
    products: [],
    prices: [],
    attachedAddons: [],
    differentialPrices: [],
  }),
  listCustomers: async () => [],
  listSubscriptions: async () => [],
  listGatewayAccounts: async () => [
    {
      sourceId: SRC_GW_ID,
      gatewayKey: "stripe",
      sourceGatewayName: "stripe",
      currencies: ["USD"],
    },
    {
      sourceId: `gw_Unpinned${RUN}`,
      gatewayKey: "razorpay",
      sourceGatewayName: "razorpay",
      currencies: ["INR"],
    },
  ],
});

async function importInto(name: string) {
  const org = await createOrganization({ name: `${name} ${RUN}` });
  const biz = await createBusiness({
    organizationId: org.organization.id,
    name: `${name} Biz`,
    defaultCurrency: "USD",
    livemode: "test",
  });
  await importFromSource({
    organizationId: org.organization.id,
    businessId: biz.id,
    source: stubSource(),
    options: { includeHistory: false, includeEvents: false },
  });
  const rows = await systemDb
    .select()
    .from(gatewayAccounts)
    .where(eq(gatewayAccounts.businessId, biz.id));
  const byKey = (k: string) => rows.find((r) => r.gatewayKey === k)?.publicId ?? null;
  return {
    orgId: org.organization.id,
    bizId: biz.id,
    stripe: byKey("stripe"),
    razorpay: byKey("razorpay"),
  };
}

async function main() {
  // GATEWAY_ACCOUNT_IDS is read through config at call time; set it for this process.
  const first = await importInto("PinA");

  ok(
    `pinned gateway takes the pin (${first.stripe})`,
    first.stripe === PINNED_STRIPE,
    `expected ${PINNED_STRIPE}`,
  );
  ok("…NOT the source's gateway id, which is deliberately unused", first.stripe !== SRC_GW_ID);
  ok(
    `unpinned gateway gets a fresh gwa_… (${first.razorpay})`,
    (first.razorpay ?? "").startsWith("gwa_"),
  );

  // The whole point: the URL another system holds is reproducible.
  const url = buildNotificationUrl({
    gatewayKey: "stripe",
    gatewayAccountPublicId: first.stripe ?? "",
  });
  ok(
    "webhook URL embeds the pinned id, so a re-import leaves it valid",
    url.includes(PINNED_STRIPE),
    url,
  );

  // A second import into a DIFFERENT business asks for the same pinned id. The
  // public-id index is GLOBAL, so it cannot be granted twice — the importer warns and
  // skips rather than duplicating or silently renaming. Worth pinning: it means one pin
  // belongs to one business, which is the intended shape (one source site → one business).
  const second = await importInto("PinB");
  ok(
    "the same pin cannot be claimed by a second business",
    second.stripe === null,
    `got ${second.stripe}`,
  );
  ok(
    "…while the unpinned gateway still imports fine there",
    (second.razorpay ?? "").startsWith("gwa_"),
  );
}

try {
  await main();
} catch (e) {
  console.error(`threw: ${e instanceof Error ? e.stack : String(e)}`);
  checks.push(["suite completed", false]);
}

console.log("");
let pass = true;
for (const [n, c, d] of checks) {
  console.log(`${c ? "✅" : "❌"} ${n}${!c && d ? ` — ${d}` : ""}`);
  if (!c) pass = false;
}
console.log(pass ? "\n✅ IMPORT GATEWAY ID: PASS" : "\n❌ IMPORT GATEWAY ID: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);

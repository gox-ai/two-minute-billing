/**
 * `--catalog-only` import scope — the India-first launch's Phase 1 shape
 * (docs/INDIA-LAUNCH.md §6).
 *
 * The property under test is a NEGATIVE one, which is why it needs a gate: the catalog
 * arriving is visible and obvious, while the book NOT arriving is invisible until the
 * billing clock starts charging customers the source is also charging. `importFromSource`
 * takes over renewals from the current term end, so a subscription that leaks through
 * this scope is a double-bill, not a stray row.
 *
 * Also pins the id-stability the scope exists to deliver: a downstream pricing service builds
 * `item_price_id`s by string concatenation, so a price whose id was normalized on the way
 * in is a price that service can never address.
 *
 *   pnpm verify:catalog-only-import
 */
import { eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { FixtureSource } from "@/modules/migration/fixture";
import { importFromSource } from "@/modules/migration/import";
import {
  customers,
  subscriptions,
  invoices,
  prices,
  products,
  unbilledCharges,
  creditNotes,
  transactions,
  importedEvents,
  webhookEndpoints,
} from "@db/schema";

const SRC_PRICE_ID = "platform-pro-v202604-INR-Monthly"; // mixed case, dashes — a real-world shape

const source = new FixtureSource({
  name: "src-fixture",
  catalog: {
    groups: [{ sourceId: "main-platform", name: "Main Platform" }],
    products: [
      {
        sourceId: "platform-pro",
        name: "Platform Pro",
        kind: "plan",
        groupSourceId: "main-platform",
      },
    ],
    prices: [
      {
        sourceId: SRC_PRICE_ID,
        productSourceId: "platform-pro",
        currency: "INR",
        amountMinor: 5611800,
        model: "flat",
        interval: "month",
        intervalCount: 1,
      },
    ],
  },
  customers: [
    {
      sourceId: "cb-cus-1",
      email: "existing@buyer.example",
      firstName: "Existing",
      lastName: "Buyer",
    },
  ],
  subscriptions: [
    {
      sourceId: "cb-sub-1",
      customerSourceId: "cb-cus-1",
      status: "active",
      currency: "INR",
      items: [{ priceSourceId: SRC_PRICE_ID, quantity: 1 }],
      currentTermStart: new Date("2026-08-01"),
      currentTermEnd: new Date("2026-09-01"),
    },
  ],
  // EVERY per-customer entity type, deliberately. The first version of this fixture held
  // only customers/subscriptions, so the suite passed while five phases — unbilled
  // charges, usage, transactions, credit notes, events — were not scope-gated at all, and
  // the first two THROW on an unmapped subscription. A negative assertion is only worth
  // the fixture behind it: "0 imported" proves nothing when 0 existed at the source.
  unbilledCharges: [
    {
      sourceId: "cb-ubc-1",
      subscriptionSourceId: "cb-sub-1",
      customerSourceId: "cb-cus-1",
      description: "Mid-cycle addon",
      amountMinor: 50000,
      currency: "INR",
    },
  ],
  invoices: [
    {
      sourceId: "cb-inv-1",
      customerSourceId: "cb-cus-1",
      subscriptionSourceId: "cb-sub-1",
      status: "paid",
      currency: "INR",
      subtotalMinor: 5611800,
      totalMinor: 5611800,
      amountDueMinor: 0,
      date: new Date("2026-08-01"),
      lines: [],
    },
  ],
  creditNotes: [
    {
      sourceId: "cb-cn-1",
      customerSourceId: "cb-cus-1",
      invoiceSourceId: "cb-inv-1",
      type: "refundable",
      status: "refund_due",
      totalMinor: 10000,
      amountAvailableMinor: 10000,
      currency: "INR",
      date: new Date("2026-08-02"),
    },
  ],
  transactions: [
    {
      sourceId: "cb-txn-1",
      customerSourceId: "cb-cus-1",
      linkedInvoices: [{ invoiceSourceId: "cb-inv-1", appliedAmountMinor: 5611800 }],
      type: "payment",
      status: "succeeded",
      amountMinor: 5611800,
      currency: "INR",
      date: new Date("2026-08-01"),
    },
  ],
  events: [
    {
      sourceId: "cb-evt-1",
      eventType: "subscription_created",
      occurredAt: new Date("2026-08-01"),
      payload: {},
    },
  ],
});

const org = await createOrganization({ name: "Catalog Only Scope" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Catalog Only Co",
  defaultCurrency: "INR",
  livemode: "test",
});

await importFromSource({
  organizationId: orgId,
  businessId: biz.id,
  source,
  options: { scope: { catalogOnly: true } },
});

const counts = await withTenant(orgId, async (tx) => ({
  products: (await tx.select().from(products).where(eq(products.businessId, biz.id))).length,
  prices: await tx.select().from(prices).where(eq(prices.businessId, biz.id)),
  customers: (await tx.select().from(customers).where(eq(customers.businessId, biz.id))).length,
  subscriptions: (await tx.select().from(subscriptions).where(eq(subscriptions.businessId, biz.id)))
    .length,
  invoices: (await tx.select().from(invoices).where(eq(invoices.businessId, biz.id))).length,
  unbilled: (await tx.select().from(unbilledCharges).where(eq(unbilledCharges.businessId, biz.id)))
    .length,
  creditNotes: (await tx.select().from(creditNotes).where(eq(creditNotes.businessId, biz.id)))
    .length,
  transactions: (await tx.select().from(transactions).where(eq(transactions.businessId, biz.id)))
    .length,
  events: (await tx.select().from(importedEvents).where(eq(importedEvents.businessId, biz.id)))
    .length,
  webhookEndpoints: (
    await tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.businessId, biz.id))
  ).length,
}));

console.log(
  `products=${counts.products} prices=${counts.prices.length} customers=${counts.customers} subscriptions=${counts.subscriptions} invoices=${counts.invoices} unbilled=${counts.unbilled} creditNotes=${counts.creditNotes} transactions=${counts.transactions} events=${counts.events}`,
);
console.log(`price ids: ${JSON.stringify(counts.prices.map((p) => p.publicId))}`);

const checks: Array<[string, boolean]> = [
  ["the catalog DID come over (product)", counts.products >= 1],
  ["the catalog DID come over (price)", counts.prices.length >= 1],
  [
    "price id is id-stable — carried VERBATIM, case preserved",
    counts.prices.some((p) => p.publicId === SRC_PRICE_ID),
  ],
  ["NO customers imported", counts.customers === 0],
  ["NO subscriptions imported — a leak here is a double-bill", counts.subscriptions === 0],
  ["NO invoices imported", counts.invoices === 0],
  // The five phases that were ungated until 2026-08-20. Unbilled charges and usage
  // records did not merely leak — they THREW on an unmapped subscription, so a
  // catalog-only run against any real book failed outright.
  ["NO unbilled charges imported", counts.unbilled === 0],
  ["NO credit notes imported", counts.creditNotes === 0],
  ["NO transactions imported", counts.transactions === 0],
  ["NO imported events", counts.events === 0],
  // Added after a real --catalog-only run imported 5 of these. The
  // fixture had none, so nothing here could have caught it — a gate is only as good as
  // the entities its fixture contains.
  ["NO webhook endpoints imported", counts.webhookEndpoints === 0],
];

// ── CONTROL ARM ────────────────────────────────────────────────────────────────
// Same fixture, NO scope. Without this the negative assertions above are vacuous: they
// would read identically if the fixture were empty, or if the importer silently dropped
// these entity types for some unrelated reason. The migration README already states this
// rule for reconcile ("the unscoped reconcile of a scoped import must be red, or the
// scoped one proves nothing"); it applies just as much to a scoped import.
const org2 = await createOrganization({ name: "Catalog Only Control" });
const orgId2 = org2.organization.id;
const biz2 = await createBusiness({
  organizationId: orgId2,
  name: "Control Co",
  defaultCurrency: "INR",
  livemode: "test",
});
await importFromSource({ organizationId: orgId2, businessId: biz2.id, source });
const control = await withTenant(orgId2, async (tx) => ({
  customers: (await tx.select().from(customers).where(eq(customers.businessId, biz2.id))).length,
  subscriptions: (
    await tx.select().from(subscriptions).where(eq(subscriptions.businessId, biz2.id))
  ).length,
  invoices: (await tx.select().from(invoices).where(eq(invoices.businessId, biz2.id))).length,
  unbilled: (await tx.select().from(unbilledCharges).where(eq(unbilledCharges.businessId, biz2.id)))
    .length,
  creditNotes: (await tx.select().from(creditNotes).where(eq(creditNotes.businessId, biz2.id)))
    .length,
  transactions: (await tx.select().from(transactions).where(eq(transactions.businessId, biz2.id)))
    .length,
}));
console.log(
  `control (unscoped): customers=${control.customers} subscriptions=${control.subscriptions} invoices=${control.invoices} unbilled=${control.unbilled} creditNotes=${control.creditNotes} transactions=${control.transactions}`,
);

checks.push(
  ["CONTROL: unscoped import DOES bring customers", control.customers > 0],
  ["CONTROL: unscoped import DOES bring subscriptions", control.subscriptions > 0],
  ["CONTROL: unscoped import DOES bring invoices", control.invoices > 0],
  ["CONTROL: unscoped import DOES bring unbilled charges", control.unbilled > 0],
  ["CONTROL: unscoped import DOES bring credit notes", control.creditNotes > 0],
);

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
}
console.log("");
console.log(`${checks.length - failed} passed, ${failed} failed`);
console.log(failed === 0 ? "✅ CATALOG-ONLY IMPORT: PASS" : "❌ CATALOG-ONLY IMPORT: FAIL");
await closeDb();
process.exit(failed === 0 ? 0 : 1);

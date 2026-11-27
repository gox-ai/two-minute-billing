/**
 * `--subscription-ids` import scope — the partial-migration shape (docs/MIGRATION.md).
 *
 * The property under test is NEGATIVE, which is why it needs a gate and a control arm:
 * the named subscriptions arriving is obvious, while the unnamed ones NOT arriving is
 * invisible until the billing clock starts charging customers the source system is also
 * charging. `importFromSource` takes over renewals from `currentTermEnd`, so a
 * subscription that leaks through this scope is a double-bill, not a stray row.
 *
 * "Imported the right 34" and "the filter leaked" produce indistinguishable counts unless
 * something at the source was deliberately left behind and then asserted absent. So the
 * fixture holds TWO customers with a full set of per-customer rows each, and the run
 * imports exactly one of them.
 *
 * ── THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL BUG ─────────────────────────
 * `failed === 0` on every resource. The five per-customer phases (unbilled charges,
 * usage, transactions, credit notes, events) read their source lists UNCONDITIONALLY and
 * were gated only by `catalogOnly`; two of them `throw` on an unmapped subscription, and
 * `importOne` catches that and counts it as `failed`. So before those phases were gated
 * on the retained sets, a subset import "succeeded" while flooding `failed` with expected
 * misses — and `failed` is the count an operator reads to decide whether the run was
 * clean, so a real failure would have hidden among them. Out of scope must be SKIPPED.
 *
 * ⚠️ Usage records are gated by the same predicate as unbilled charges but are NOT
 * covered here: `FixtureSource` implements no `listUsageRecords`, so that phase does not
 * run at all against this fixture. Unbilled charges exercise the identical code path.
 *
 *   pnpm verify:subset-import
 */
import { and, eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { FixtureSource } from "@/modules/migration/fixture";
import { importFromSource } from "@/modules/migration/import";
import {
  customers,
  subscriptions,
  invoices,
  unbilledCharges,
  creditNotes,
  transactions,
  importedEvents,
  gatewayAccounts,
  paymentMethods,
  importRecords,
  prices,
  subscriptionItems,
} from "@db/schema";

const PRICE_ID = "platform-pro-v202604-INR-Monthly";
const KEEP = "cb-sub-keep";
const DROP = "cb-sub-drop";

/** One customer we migrate, one we deliberately leave behind, each fully populated. */
const person = (n: "keep" | "drop") => ({
  sourceId: `cb-cus-${n}`,
  email: `${n}@buyer.example`,
  firstName: n === "keep" ? "Migrated" : "LeftBehind",
  lastName: "Buyer",
  // Custom fields exist so the re-import below exercises the DEFINITION path. Without
  // them the importer creates no definitions and the duplicate case is never reached —
  // which is why a bug that failed 13 records on a production import passed this gate
  // and every test-site run: no fixture had a custom field.
  customFields: { signup_source: "fixture", first_source: "fixture" },
});

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
        sourceId: PRICE_ID,
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
      ...person("keep"),
      // A vaulted card, so the gateway-account binding below has a row to act on.
      paymentMethods: [
        {
          sourceId: "cb-ps-keep",
          provider: "stripe",
          providerCustomerId: "cus_keep",
          providerPaymentMethodId: "card_keep",
          type: "card",
          brand: "visa",
          last4: "4242",
          isPrimary: true,
        },
      ],
    },
    person("drop"),
  ],
  subscriptions: (["keep", "drop"] as const).map((n) => ({
    sourceId: n === "keep" ? KEEP : DROP,
    customerSourceId: `cb-cus-${n}`,
    status: "active" as const,
    currency: "INR",
    items: [{ priceSourceId: PRICE_ID, quantity: 1 }],
    currentTermStart: new Date("2026-08-01"),
    currentTermEnd: new Date("2026-09-01"),
  })),
  // Both of these THROW on an unmapped subscription inside importOne, so the dropped
  // customer's row is what proves out-of-scope is skipped rather than failed.
  unbilledCharges: (["keep", "drop"] as const).map((n) => ({
    sourceId: `cb-ubc-${n}`,
    subscriptionSourceId: n === "keep" ? KEEP : DROP,
    customerSourceId: `cb-cus-${n}`,
    description: "Mid-cycle addon",
    amountMinor: 50000,
    currency: "INR",
  })),
  invoices: (["keep", "drop"] as const).map((n) => ({
    sourceId: `cb-inv-${n}`,
    customerSourceId: `cb-cus-${n}`,
    subscriptionSourceId: n === "keep" ? KEEP : DROP,
    status: "paid" as const,
    currency: "INR",
    subtotalMinor: 5611800,
    totalMinor: 5611800,
    amountDueMinor: 0,
    date: new Date("2026-08-01"),
    lines: [],
  })),
  creditNotes: (["keep", "drop"] as const).map((n) => ({
    sourceId: `cb-cn-${n}`,
    customerSourceId: `cb-cus-${n}`,
    invoiceSourceId: `cb-inv-${n}`,
    type: "refundable" as const,
    status: "refund_due" as const,
    totalMinor: 10000,
    amountAvailableMinor: 10000,
    currency: "INR",
    date: new Date("2026-08-02"),
  })),
  transactions: (["keep", "drop"] as const).map((n) => ({
    sourceId: `cb-txn-${n}`,
    customerSourceId: `cb-cus-${n}`,
    linkedInvoices: [{ invoiceSourceId: `cb-inv-${n}`, appliedAmountMinor: 5611800 }],
    type: "payment" as const,
    status: "succeeded" as const,
    amountMinor: 5611800,
    currency: "INR",
    date: new Date("2026-08-01"),
    // Real source transactions carry a gateway, and the gateway-transaction log row
    // is built from it. `verify-catalog-only-import`'s fixture omits this and never
    // notices, because `catalogOnly` skips the transaction phase entirely.
    gateway: "stripe",
    idAtGateway: `ch_${n}`,
  })),
  events: [
    {
      sourceId: "cb-evt-1",
      eventType: "subscription_created",
      occurredAt: new Date("2026-08-01"),
      payload: {},
    },
  ],
});

const checks: Array<[string, boolean]> = [];

// ── THE SCOPED RUN ─────────────────────────────────────────────────────────────
const org = await createOrganization({ name: "Subset Scope" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Subset Co",
  defaultCurrency: "INR",
  livemode: "test",
});

const scoped = await importFromSource({
  organizationId: orgId,
  businessId: biz.id,
  source,
  options: { scope: { subscriptionSourceIds: [KEEP] }, includeEvents: false },
});

const got = await withTenant(orgId, async (tx) => ({
  customers: await tx.select().from(customers).where(eq(customers.businessId, biz.id)),
  subscriptions: await tx.select().from(subscriptions).where(eq(subscriptions.businessId, biz.id)),
  invoices: (await tx.select().from(invoices).where(eq(invoices.businessId, biz.id))).length,
  unbilled: (await tx.select().from(unbilledCharges).where(eq(unbilledCharges.businessId, biz.id)))
    .length,
  creditNotes: (await tx.select().from(creditNotes).where(eq(creditNotes.businessId, biz.id)))
    .length,
  transactions: (await tx.select().from(transactions).where(eq(transactions.businessId, biz.id)))
    .length,
  events: (await tx.select().from(importedEvents).where(eq(importedEvents.businessId, biz.id)))
    .length,
}));

console.log(
  `scoped: customers=${got.customers.length} subscriptions=${got.subscriptions.length} ` +
    `invoices=${got.invoices} unbilled=${got.unbilled} creditNotes=${got.creditNotes} ` +
    `transactions=${got.transactions} events=${got.events}`,
);
const failedResources = Object.entries(scoped.counts).filter(([, c]) => c.failed > 0);
console.log(
  `failed resources: ${failedResources.length === 0 ? "none" : JSON.stringify(Object.fromEntries(failedResources))}`,
);

const keptEmails = got.customers.map((c) => c.email);
checks.push(
  ["exactly ONE subscription imported", got.subscriptions.length === 1],
  ["exactly ONE customer imported", got.customers.length === 1],
  ["the imported customer is the NAMED one", keptEmails.includes("keep@buyer.example")],
  [
    "the left-behind customer is ABSENT — a leak here is a double-bill",
    !keptEmails.includes("drop@buyer.example"),
  ],
  ["only the named subscription's unbilled charge landed", got.unbilled === 1],
  ["only the named customer's invoice landed", got.invoices === 1],
  ["only the named customer's credit note landed", got.creditNotes === 1],
  ["only the named customer's transaction landed", got.transactions === 1],
  ["NO events imported (they cannot be scoped)", got.events === 0],
  // The regression this suite exists for: out of scope is a decision, not a failure.
  ["ZERO failures — out-of-scope rows are SKIPPED, not FAILED", failedResources.length === 0],
  ["the run reports charging nobody", scoped.charges === 0],
);

/**
 * The importer must NOT pin a card onto the subscription.
 *
 * `subscriptions.default_payment_method_id` is a per-subscription OVERRIDE, and
 * `resolveChargeCandidates` prefers it over the customer's primary. The importer used
 * to write the customer's primary into it — the same fact the payment method's own
 * `role: 'primary'` already carries — and nothing updates that copy when the card is
 * replaced (`payment-methods/service.ts` writes the role and never touches the column).
 * So every migrated subscription went on charging the card that was primary at import
 * time. Measured on the live book 2026-09-15: a subscription pinned to a card in status
 * `invalid` while the customer's new primary sat unused beside it, failing a manual
 * "collect now".
 *
 * Both halves are asserted, because the fix is only safe if the fallback still finds the
 * same card: no pin, AND the card carries the primary role that `pickPrimaryCandidate`
 * resolves through. The fixture's `cb-ps-keep` is `isPrimary: true`, so before this
 * change the pin was non-null and equal to that card.
 */
const importedPm = await withTenant(orgId, async (tx) => {
  const [pm] = await tx
    .select()
    .from(paymentMethods)
    .where(eq(paymentMethods.businessId, biz.id))
    .limit(1);
  return pm ?? null;
});
checks.push(
  [
    "the imported subscription is NOT pinned to a card",
    got.subscriptions[0]?.defaultPaymentMethodId == null,
  ],
  // The control: without it "no pin" would also pass on an import that vaulted nothing.
  ["CONTROL: the card DID import", importedPm != null],
  [
    "and it carries role=primary, which is what the charge path falls back to",
    importedPm?.role === "primary",
  ],
);

// ── REFUSALS ───────────────────────────────────────────────────────────────────
// Each of these has a silent wrong answer, so each must throw rather than be reconciled.
const refuses = async (label: string, fn: () => Promise<unknown>) => {
  try {
    await fn();
    checks.push([`REFUSES: ${label}`, false]);
  } catch {
    checks.push([`REFUSES: ${label}`, true]);
  }
};
const throwaway = { organizationId: orgId, businessId: biz.id, source };
await refuses('an empty id list (reads as both "none" and "unset")', () =>
  importFromSource({
    ...throwaway,
    options: { scope: { subscriptionSourceIds: [] }, includeEvents: false },
  }),
);
await refuses("catalogOnly together with an id list (two scopes disagreeing)", () =>
  importFromSource({
    ...throwaway,
    options: { scope: { catalogOnly: true, subscriptionSourceIds: [KEEP] }, includeEvents: false },
  }),
);
await refuses("an id list with events enabled (events cannot be scoped)", () =>
  importFromSource({ ...throwaway, options: { scope: { subscriptionSourceIds: [KEEP] } } }),
);

// ── CONTROL ARM ────────────────────────────────────────────────────────────────
// Without this every negative assertion above is vacuous: they would read identically if
// the fixture held one customer, or if the importer dropped these types for an unrelated
// reason. The control proves the fixture really does carry a second customer and that an
// unscoped import brings it.
const org2 = await createOrganization({ name: "Subset Control" });
const orgId2 = org2.organization.id;
const biz2 = await createBusiness({
  organizationId: orgId2,
  name: "Control Co",
  defaultCurrency: "INR",
  livemode: "test",
});
await importFromSource({
  organizationId: orgId2,
  businessId: biz2.id,
  source,
  options: { includeEvents: false },
});
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
  `control (unscoped): customers=${control.customers} subscriptions=${control.subscriptions} ` +
    `invoices=${control.invoices} unbilled=${control.unbilled} creditNotes=${control.creditNotes} ` +
    `transactions=${control.transactions}`,
);
checks.push(
  ["CONTROL: unscoped import brings BOTH subscriptions", control.subscriptions === 2],
  ["CONTROL: unscoped import brings BOTH customers", control.customers === 2],
  ["CONTROL: unscoped import brings both unbilled charges", control.unbilled === 2],
  ["CONTROL: unscoped import brings both credit notes", control.creditNotes === 2],
  ["CONTROL: unscoped import brings both transactions", control.transactions === 2],
);

// ── RE-IMPORT BINDS A CARD TO A GATEWAY ACCOUNT THAT DID NOT EXIST YET ─────────
/**
 * The import's own gateway warning tells the operator to add credentials in Settings →
 * Gateways and "re-run the import to bind imported cards/refunds to this account".
 *
 * That advice was FALSE. `gatewayAccountId` is written only in the payment-method
 * INSERT, and a re-run finds the `import_records` row and returns `existing` without
 * entering the create callback — so the column stayed NULL forever. And a FIRST import
 * can never bind these rows, because the source's gateway accounts arrive
 * credential-less and `disabled` by design ("a disabled placeholder must not claim
 * ownership of a payment method it cannot charge"). So the re-run was the only path that
 * could ever bind them, and it was the one that did nothing.
 *
 * With NULL there is no gateway override, the charge falls through to the router, and
 * that raises `ambiguous_gateway` as soon as two active accounts match the currency —
 * i.e. renewals for imported customers fail. Hence a gate rather than a comment.
 */
const org3 = await createOrganization({ name: "Subset Rebind" });
const orgId3 = org3.organization.id;
const biz3 = await createBusiness({
  organizationId: orgId3,
  name: "Rebind Co",
  defaultCurrency: "INR",
  livemode: "test",
});
const scopeOpts = { scope: { subscriptionSourceIds: [KEEP] }, includeEvents: false };

const firstRun = await importFromSource({
  organizationId: orgId3,
  businessId: biz3.id,
  source,
  options: scopeOpts,
});
const boundAfterFirst = await withTenant(orgId3, async (tx) => {
  const [pm] = await tx.select().from(paymentMethods).where(eq(paymentMethods.businessId, biz3.id));
  return pm?.gatewayAccountId ?? null;
});

// The operator's action: credentials added, so an ACTIVE account now exists. Inserted
// directly because only `gateway_key`/`status`/`business_id` matter to the binding — the
// test never charges, so the credential blob is a placeholder.
await withTenant(orgId3, async (tx) => {
  await tx.insert(gatewayAccounts).values({
    organizationId: orgId3,
    businessId: biz3.id,
    publicId: `gwa_rebind${Date.now().toString(36)}`,
    gatewayKey: "stripe",
    label: "Stripe (added after the first import)",
    livemode: false,
    credentialsEnc: "test-placeholder-not-decryptable",
    status: "active",
  });
});

/**
 * REPRODUCE PRODUCTION: the definitions exist, their import records do NOT.
 *
 * Deleting these is the whole point of the test. With the records present the second run
 * short-circuits inside `importOne` and never calls `createDefinition`, so the duplicate
 * path is never reached — which is exactly why the first version of this check passed
 * with the fix REMOVED, and why the live cutover failed on 13 records that every
 * previous run had reported clean. On production the definitions had been created by an
 * earlier pass that recorded nothing.
 */
await withTenant(orgId3, async (tx) => {
  await tx
    .delete(importRecords)
    .where(
      and(
        eq(importRecords.businessId, biz3.id),
        eq(importRecords.sourceType, "custom_field_definition"),
      ),
    );
});

const secondRun = await importFromSource({
  organizationId: orgId3,
  businessId: biz3.id,
  source,
  options: scopeOpts,
});
const boundAfterSecond = await withTenant(orgId3, async (tx) => {
  const [pm] = await tx.select().from(paymentMethods).where(eq(paymentMethods.businessId, biz3.id));
  return pm?.gatewayAccountId ?? null;
});
console.log(
  `rebind: gatewayAccountId after first import = ${boundAfterFirst ?? "NULL"}; after re-import = ${boundAfterSecond ?? "NULL"}`,
);

/**
 * A definition that already exists is the DESIRED STATE, not a failure.
 *
 * `createDefinition` throws on a duplicate — correct for an API caller, wrong for an
 * importer whose loop means "ensure this exists". Untreated it reported 13 FAILED
 * records on the live INR cutover and flipped a perfect import to a non-zero exit.
 *
 * The first run is the control: if it created nothing, the second proving nothing failed
 * would be vacuous.
 */
const cfFirst = firstRun.counts["custom_field_definitions"];
const cfSecond = secondRun.counts["custom_field_definitions"];
console.log(
  `custom fields: first run created=${cfFirst?.created ?? 0} failed=${cfFirst?.failed ?? 0}; ` +
    `re-import created=${cfSecond?.created ?? 0} failed=${cfSecond?.failed ?? 0}`,
);

checks.push(
  ["CONTROL: the first import CREATES the custom-field definitions", (cfFirst?.created ?? 0) > 0],
  ["a RE-IMPORT does not fail on definitions that already exist", (cfSecond?.failed ?? 0) === 0],
  // Not "created 0": with the records deleted the importer legitimately re-records them.
  // What must never happen is a FAILURE, which is what the duplicate throw produced.
  ["and re-records them instead of throwing", (cfSecond?.failed ?? 0) === 0],
  // The control for the assertion below: without this, "bound" could mean the first
  // import bound it and the re-run was irrelevant.
  [
    "a FIRST import leaves the card unbound (no active account exists yet)",
    boundAfterFirst === null,
  ],
  [
    "RE-IMPORTING binds it once an active account exists — the documented remedy works",
    boundAfterSecond !== null,
  ],
);

/**
 * ── skipCatalog: a scoped import into a business that ALREADY has the catalog ────────
 *
 * The saving is real — the source catalog read is site-wide and cannot be narrowed, so a
 * one-subscription import was paying ~60 `attached_items` requests plus ten paged
 * `coupon_codes` requests per coupon SET before it reached the subscription. The risk is
 * equally real: `priceRowBySource` and `couponRowBySource` are built ONLY by the catalog
 * phase, and the subscription phase throws `price … not in import set` on a miss. So the
 * skip is only safe if those maps rehydrate from the destination.
 *
 * Two runs against the same business, and the FIRST is the control: it imports the
 * catalog normally, so the second's "created 0 prices" cannot be an artefact of an empty
 * source. Both fixture subscriptions sit on PRICE_ID, so the second run resolving DROP's
 * item at all is the assertion — it can only have come from the database.
 */
const org4 = await createOrganization({ name: "Subset SkipCatalog" });
const orgId4 = org4.organization.id;
const biz4 = await createBusiness({
  organizationId: orgId4,
  name: "SkipCatalog Co",
  defaultCurrency: "INR",
  livemode: "test",
});

const withCatalog = await importFromSource({
  organizationId: orgId4,
  businessId: biz4.id,
  source,
  options: { scope: { subscriptionSourceIds: [KEEP] }, includeEvents: false },
});
const skipped = await importFromSource({
  organizationId: orgId4,
  businessId: biz4.id,
  source,
  options: { scope: { subscriptionSourceIds: [DROP], skipCatalog: true }, includeEvents: false },
});

const after = await withTenant(orgId4, async (tx) => {
  const priceRows = await tx.select().from(prices).where(eq(prices.businessId, biz4.id));
  const [dropSub] = await tx
    .select({ id: subscriptions.id, status: subscriptions.status })
    .from(subscriptions)
    .where(and(eq(subscriptions.businessId, biz4.id), eq(subscriptions.publicId, DROP)))
    .limit(1);
  const items = dropSub
    ? await tx
        .select({ priceId: subscriptionItems.priceId })
        .from(subscriptionItems)
        .where(eq(subscriptionItems.subscriptionId, dropSub.id))
    : [];
  return { priceRows, dropSub, items };
});

const created = (r: typeof skipped, k: string) => r.counts[k]?.created ?? 0;
const failedIn = (r: typeof skipped, k: string) => r.counts[k]?.failed ?? 0;
console.log("");
console.log(
  `skipCatalog: with-catalog run created prices=${created(withCatalog, "prices")} ` +
    `products=${created(withCatalog, "products")}; skipped run created ` +
    `prices=${created(skipped, "prices")} products=${created(skipped, "products")} ` +
    `subscriptions=${created(skipped, "subscriptions")} failed=${failedIn(skipped, "subscriptions")}`,
);

checks.push(
  // Without this the two assertions below would read identically against an empty source.
  ["CONTROL: the normal scoped import DOES create the catalog", created(withCatalog, "prices") > 0],
  ["skipCatalog creates NO prices", created(skipped, "prices") === 0],
  ["skipCatalog creates NO products", created(skipped, "products") === 0],
  ["skipCatalog leaves the catalog the first run built intact", after.priceRows.length > 0],
  // The point of the whole change: the subscription still lands, which it can only do if
  // its price resolved — and the source catalog was never read on this run.
  ["the subscription still imports with the catalog skipped", after.dropSub != null],
  ["and it does not FAIL for a missing price", failedIn(skipped, "subscriptions") === 0],
  [
    "its item resolved to a real price row — the map rehydrated from the DATABASE",
    after.items.length > 0 && after.items.every((i) => i.priceId != null),
  ],
);

await refuses("skipCatalog + catalogOnly is refused as a contradiction", () =>
  importFromSource({
    ...throwaway,
    options: { scope: { catalogOnly: true, skipCatalog: true }, includeEvents: false },
  }),
);

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
}
console.log("");
console.log(`${checks.length - failed} passed, ${failed} failed`);
console.log(failed === 0 ? "✅ SUBSET IMPORT: PASS" : "❌ SUBSET IMPORT: FAIL");
await closeDb();
process.exit(failed === 0 ? 0 : 1);

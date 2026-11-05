/**
 * Customer segments — a saved, named population over customer attributes.
 *
 *   A. TENANT ISOLATION, mutation-tested. A segment saved on one business is invisible
 *      to another, and invisible to another organization. The mutation is run FIRST and
 *      in the script: a copy of the read WITHOUT the business predicate finds the row,
 *      so the real check is proven to bite. Delete the predicate from the service and
 *      this suite goes red on the next assertion rather than passing on a query that
 *      was never scoped.
 *   B. THE STARTER LIBRARY LOADS. All ten are present on a business that has saved
 *      nothing, every one of them validates against the customer list's allow-list, and
 *      every one RESOLVES — which is what proves no starter names an attribute the
 *      engine cannot answer.
 *   C. A SAVED SEGMENT ROUND-TRIPS: create → read → resolve → edit → delete, with the
 *      count and the MRR summary exact and computed over the WHOLE population rather
 *      than the page that happened to load.
 *   D. A REFUSED ATTRIBUTE IS REFUSED BY NAME, with the reason — `ltv`, an unknown
 *      field, a bad operator, and `mrr` on a book that bills in two currencies.
 *
 *   pnpm verify:segments
 */
import { and, eq } from "drizzle-orm";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { businesses, customerSegments } from "@db/schema";
import {
  createSegment,
  deleteSegment,
  getSegment,
  listSegments,
  resolveSegment,
  updateSegment,
  validateSegmentFilters,
  SegmentError,
  SegmentRefusedError,
} from "@/modules/segments/service";
import { STARTER_SEGMENTS } from "@/modules/segments/starters";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

/** Run `fn`, returning the error it threw (or null). */
async function caught(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as Error;
  }
}

const org = await createOrganization({ name: "Segments Org" });
const orgId = org.organization.id;
const other = await createOrganization({ name: "Segments Other Org" });
const otherOrgId = other.organization.id;

const mkBiz = (organizationId: string, name: string, currency = "USD") =>
  createBusiness({ organizationId, name, defaultCurrency: currency, livemode: "test" });

const bizA = await mkBiz(orgId, "Segments A");
const bizB = await mkBiz(orgId, "Segments B");
const bizOther = await mkBiz(otherOrgId, "Segments Elsewhere");
/** Its own business so the multi-currency refusal cannot disturb the figures above. */
const bizMixed = await mkBiz(orgId, "Segments Mixed");

// ── A book with known MRR ─────────────────────────────────────────────────────
const product = await createProduct({ organizationId: orgId, businessId: bizA.id, name: "Plans" });

async function customerWith(amountMinor: number | null, currency = "USD", businessId = bizA.id) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId,
    email: `seg${Math.random()}@a.com`,
    currency,
  });
  if (amountMinor == null) return c;
  const prod =
    businessId === bizA.id
      ? product
      : await createProduct({ organizationId: orgId, businessId, name: "Plans" });
  const p = await createPrice({
    organizationId: orgId,
    businessId,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency,
    amountMinor,
    interval: "month",
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId,
    customer: c,
    token: "tok_4242",
  });
  await createSubscription({
    organizationId: orgId,
    businessId,
    customerId: c.id,
    now: new Date(),
    items: [{ price: p, quantity: 1 }],
  });
  return c;
}

// Two big, one small, one with no subscription at all.
await customerWith(30_000);
await customerWith(26_000);
await customerWith(2_000);
await customerWith(null);

// ── A. Tenant isolation, mutation-tested ─────────────────────────────────────
{
  const mine = await createSegment({
    organizationId: orgId,
    businessId: bizA.id,
    name: "Isolation probe",
    filters: [{ field: "active_subscription_count", op: "gt", value: "0" }],
  });

  /**
   * THE MUTATION. The real read is `organization_id` AND `business_id` AND
   * `public_id`; this is the same query with the business predicate REMOVED — the
   * single edit that would make a segment visible across businesses in one org, which
   * RLS cannot catch because both businesses are the same tenant.
   *
   * It must FIND the row. If it stops finding it, the isolation assertion below has
   * become vacuous and this check says so before the suite can pass for the wrong
   * reason.
   */
  const leaked = await withTenant(orgId, (tx) =>
    tx
      .select({ id: customerSegments.publicId })
      .from(customerSegments)
      .where(
        and(
          eq(customerSegments.organizationId, orgId),
          eq(customerSegments.publicId, mine.publicId),
        ),
      ),
  );
  ok(
    "mutation control: dropping the business predicate DOES reach the row (the check below is not vacuous)",
    leaked.length === 1,
  );

  ok(
    "a segment saved on one business is not readable from another business in the same org",
    (await getSegment(orgId, bizB.id, mine.publicId)) === null,
  );
  ok(
    "…and does not appear in that business's list",
    !(await listSegments(orgId, bizB.id)).some((s) => s.publicId === mine.publicId),
  );
  ok(
    "…and cannot be edited from it",
    (await updateSegment(orgId, bizB.id, mine.publicId, { name: "Stolen" })) === null,
  );
  ok(
    "…and cannot be deleted from it",
    (await deleteSegment(orgId, bizB.id, mine.publicId)) === false,
  );
  ok(
    "another ORGANIZATION cannot read it (RLS, not just the predicate)",
    (await getSegment(otherOrgId, bizOther.id, mine.publicId)) === null,
  );
  ok(
    "…and its list holds only the starters",
    (await listSegments(otherOrgId, bizOther.id)).every((s) => s.isStarter),
  );
  ok(
    "it is still readable from its own business",
    (await getSegment(orgId, bizA.id, mine.publicId)) !== null,
  );
  await deleteSegment(orgId, bizA.id, mine.publicId);
}

// ── B. The starter library loads, and every starter resolves ─────────────────
{
  const list = await listSegments(orgId, bizA.id);
  const starters = list.filter((s) => s.isStarter);
  ok(
    `the starter library loads on a business that has saved nothing (${starters.length} of ${STARTER_SEGMENTS.length})`,
    starters.length === STARTER_SEGMENTS.length && list.length === STARTER_SEGMENTS.length,
  );
  ok(
    "every starter is read-only and carries the key it is defined under",
    starters.every((s) => s.isStarter && s.starterKey != null && s.filters.length > 0),
  );

  let validated = 0;
  let resolved = 0;
  const broken: string[] = [];
  for (const s of starters) {
    const bad = await caught(() => validateSegmentFilters(orgId, bizA.id, s.filters));
    if (bad) broken.push(`${s.name}: ${bad.message}`);
    else validated++;
    const failed = await caught(() => resolveSegment(orgId, bizA.id, s.filters, { limit: 5 }));
    if (failed) broken.push(`${s.name} (resolve): ${failed.message}`);
    else resolved++;
  }
  ok(
    `every starter validates against the customer list's own allow-list (${validated}/${starters.length})`,
    validated === starters.length,
  );
  ok(
    `every starter RESOLVES — none names an attribute the engine cannot answer (${resolved}/${starters.length})`,
    resolved === starters.length,
  );
  if (broken.length) for (const b of broken) console.log(`      ↳ ${b}`);

  // The two that only exist because three attributes were added for them.
  const active = starters.find((s) => s.starterKey === "active")!;
  const high = starters.find((s) => s.starterKey === "high_mrr")!;
  const low = starters.find((s) => s.starterKey === "low_mrr")!;
  const [a, h, l] = await Promise.all([
    resolveSegment(orgId, bizA.id, active.filters),
    resolveSegment(orgId, bizA.id, high.filters),
    resolveSegment(orgId, bizA.id, low.filters),
  ]);
  ok("Active customers finds the three with a subscription", a.totals.customers === 3);
  ok("High MRR (≥ 25,000 minor) finds the two big accounts", h.totals.customers === 2);
  ok("…and totals their MRR exactly, in minor units", h.totals.mrrByCurrency.USD === 56_000);
  ok("Low MRR (paying, under 5,000) finds the small one alone", l.totals.customers === 1);
  ok(
    "…and excludes the customer with no subscription at all",
    l.totals.mrrByCurrency.USD === 2_000,
  );
}

// ── C. A saved segment round-trips ───────────────────────────────────────────
{
  const created = await createSegment({
    organizationId: orgId,
    businessId: bizA.id,
    name: "Big US accounts",
    description: "Over 250.00 a month.",
    filters: [
      { field: "mrr", op: "gte", value: "25000" },
      { field: "currency", op: "is", value: "USD" },
    ],
    starterKey: "high_mrr",
  });
  const read = await getSegment(orgId, bizA.id, created.publicId);
  ok(
    "a saved segment round-trips: name, description, filters and the starter it came from",
    read != null &&
      read.name === "Big US accounts" &&
      read.description === "Over 250.00 a month." &&
      read.starterKey === "high_mrr" &&
      read.isStarter === false &&
      JSON.stringify(read.filters) === JSON.stringify(created.filters),
  );
  ok(
    "it appears in the list, after the starters",
    (await listSegments(orgId, bizA.id)).some((s) => s.publicId === created.publicId),
  );

  const { rows, totals } = await resolveSegment(orgId, bizA.id, read!.filters, { limit: 1 });
  ok("resolving it returns the page asked for", rows.data.length === 1 && rows.hasMore === true);
  ok(
    "…while the count covers the WHOLE population, not the page",
    rows.total === 2 && totals.customers === 2,
  );
  ok(
    "…and the MRR summary is the population's, in minor units",
    totals.mrrByCurrency.USD === 56_000,
  );

  const dup = await caught(() =>
    createSegment({
      organizationId: orgId,
      businessId: bizA.id,
      name: "big us accounts",
      filters: [{ field: "country", op: "is", value: "US" }],
    }),
  );
  ok("a duplicate name is refused, case-insensitively", dup?.name === "SegmentNameTakenError");

  const starterName = await caught(() =>
    createSegment({
      organizationId: orgId,
      businessId: bizA.id,
      name: "Active customers",
      filters: [{ field: "country", op: "is", value: "US" }],
    }),
  );
  ok("a starter's name is taken too", starterName?.name === "SegmentNameTakenError");

  const edited = await updateSegment(orgId, bizA.id, created.publicId, {
    name: "Biggest US accounts",
    filters: [
      { field: "mrr", op: "gte", value: "29000" },
      { field: "currency", op: "is", value: "USD" },
    ],
  });
  ok("an edit re-validates and lands", edited?.name === "Biggest US accounts");
  ok(
    "…and the population moves with it",
    (await resolveSegment(orgId, bizA.id, edited!.filters)).totals.customers === 1,
  );

  const starter = await caught(() =>
    updateSegment(orgId, bizA.id, "seg_starter_active", { name: "Nope" }),
  );
  ok("a starter cannot be edited", starter instanceof SegmentError);
  ok(
    "a starter cannot be deleted",
    (await caught(() => deleteSegment(orgId, bizA.id, "seg_starter_active"))) instanceof
      SegmentError,
  );

  ok("delete removes it", (await deleteSegment(orgId, bizA.id, created.publicId)) === true);
  ok("…and it is gone", (await getSegment(orgId, bizA.id, created.publicId)) === null);
  ok(
    "…and deleting it twice is false, not an error",
    (await deleteSegment(orgId, bizA.id, created.publicId)) === false,
  );
}

// ── D. A refused attribute is refused BY NAME ────────────────────────────────
{
  const ltv = await caught(() =>
    validateSegmentFilters(orgId, bizA.id, [{ field: "ltv", op: "gte", value: "100000" }]),
  );
  ok(
    "`ltv` is refused by name, with the reason — not 'invalid filter'",
    ltv instanceof SegmentRefusedError &&
      ltv.message.includes("'ltv'") &&
      ltv.message.includes("lifetime value"),
  );

  const plan = await caught(() =>
    validateSegmentFilters(orgId, bizA.id, [{ field: "plan", op: "is", value: "pro" }]),
  );
  ok(
    "`plan` is refused by name, and points at what to do instead",
    plan instanceof SegmentRefusedError &&
      plan.message.includes("'plan'") &&
      plan.message.includes("subscription"),
  );

  const unknown = await caught(() =>
    validateSegmentFilters(orgId, bizA.id, [{ field: "moon_phase", op: "is", value: "full" }]),
  );
  ok(
    "an attribute we never heard of is named, and the refusal lists what exists",
    unknown instanceof SegmentRefusedError &&
      unknown.message.includes("'moon_phase'") &&
      unknown.message.includes("country"),
  );

  const badOp = await caught(() =>
    validateSegmentFilters(orgId, bizA.id, [{ field: "country", op: "gt", value: "DE" }]),
  );
  ok(
    "an operator the attribute does not take names the ones it does",
    badOp instanceof SegmentError && badOp.message.includes("Supported:"),
  );

  // A field name that is an Object.prototype key must not resolve through the prototype.
  for (const field of ["constructor", "__proto__", "toString"]) {
    const proto = await caught(() =>
      validateSegmentFilters(orgId, bizA.id, [{ field, op: "is", value: "x" }]),
    );
    ok(`'${field}' is refused as an unknown attribute`, proto instanceof SegmentRefusedError);
  }
  {
    const { buildApp } = await import("@/index");
    const app = await buildApp({ logger: false });
    const preview = await app.inject({
      method: "GET",
      url: `/v1/businesses/${bizA.publicId}/customer_segments/preview?constructor[is]=x`,
      headers: { authorization: `Bearer ${org.secret}` },
    });
    ok(
      `preview with ?constructor[is]=x → 400, not 500 (${preview.statusCode})`,
      preview.statusCode === 400,
    );
    await app.close();
  }

  const badValue = await caught(() =>
    validateSegmentFilters(orgId, bizA.id, [
      { field: "created_at", op: "on", value: "31/08/2026" },
    ]),
  );
  ok(
    "a malformed value is caught here, not by a Postgres cast",
    badValue instanceof SegmentError && badValue.message.includes("YYYY-MM-DD"),
  );

  ok(
    "`mrr` alone is accepted on a single-currency book",
    (await caught(() =>
      validateSegmentFilters(orgId, bizA.id, [{ field: "mrr", op: "gte", value: "1" }]),
    )) === null,
  );

  // Two currencies on one book: the threshold now compares amounts that are not
  // comparable, so it is refused rather than quietly summed.
  await customerWith(30_000, "USD", bizMixed.id);
  await customerWith(30_000, "EUR", bizMixed.id);
  const mixed = await caught(() =>
    validateSegmentFilters(orgId, bizMixed.id, [{ field: "mrr", op: "gte", value: "1" }]),
  );
  ok(
    "`mrr` on a two-currency book is refused, naming the currencies and the fix",
    mixed instanceof SegmentRefusedError &&
      mixed.message.includes("'mrr'") &&
      mixed.message.includes("EUR") &&
      mixed.message.includes("USD"),
  );
  ok(
    "…and is accepted again once the segment pins one",
    (await caught(() =>
      validateSegmentFilters(orgId, bizMixed.id, [
        { field: "mrr", op: "gte", value: "1" },
        { field: "currency", op: "is", value: "USD" },
      ]),
    )) === null,
  );

  const empty = await caught(() => validateSegmentFilters(orgId, bizA.id, []));
  ok(
    "an empty segment is refused — it is 'all customers' wearing a name",
    empty instanceof SegmentError,
  );
}

// ── E · `mrr` compares in the business's default currency ─────────────────────────────
// Stored MRR is each subscription's own minor units; comparing those raw puts ₹200 above $1.
// The filter converts every live subscription at the business's rate first.
{
  const bizFx = await mkBiz(orgId, "Segments FX");
  await systemDb
    .update(businesses)
    .set({ exchangeRates: { INR: "95.5949576900", EUR: "0.8723719794" } })
    .where(eq(businesses.id, bizFx.id));
  const alice = await customerWith(30_000, "USD", bizFx.id); //    $300.00
  const bala = await customerWith(2_000_000, "INR", bizFx.id); // ₹20,000 ≈ $209.22
  const carl = await customerWith(20_000, "INR", bizFx.id); //     ₹200   ≈ $2.09
  const dora = await customerWith(25_000, "EUR", bizFx.id); //     €250   ≈ $286.58
  const ids = async (filters: Parameters<typeof resolveSegment>[2]) =>
    new Set(
      (await resolveSegment(orgId, bizFx.id, filters, { limit: 50 })).rows.data.map((c) => c.id),
    );
  const high = STARTER_SEGMENTS.find((x) => x.key === "high_mrr")!;
  const low = STARTER_SEGMENTS.find((x) => x.key === "low_mrr")!;
  const h = await ids(high.filters);
  ok(
    "fx: High MRR (≥ 250.00 USD) is Alice and Dora — converted, not raw paise",
    h.size === 2 && h.has(alice.id) && h.has(dora.id) && !h.has(bala.id),
  );
  const l = await ids(low.filters);
  ok("fx: Low MRR (under 50.00 USD) is Carl alone", l.size === 1 && l.has(carl.id));
  const pinned = await ids([
    { field: "mrr", op: "gte", value: "25000" },
    { field: "currency", op: "is", value: "INR" },
  ]);
  ok(
    "fx: a pinned currency compares natively — ₹250+ in INR is Bala",
    pinned.size === 1 && pinned.has(bala.id),
  );
  const pinnedIn = await ids([
    { field: "mrr", op: "gte", value: "25000" },
    { field: "currency", op: "in", value: "INR" },
  ]);
  ok("fx: `currency in` one value pins the same way", pinnedIn.size === 1 && pinnedIn.has(bala.id));

  // A currency with no rate is refused by name, never counted at par.
  await customerWith(10_000, "GBP", bizFx.id);
  const noRate = await caught(() => resolveSegment(orgId, bizFx.id, high.filters));
  ok(
    "fx: a held currency with no rate is refused, naming it",
    noRate instanceof SegmentRefusedError && /no usable exchange rate for GBP/.test(noRate.message),
  );
  ok(
    "fx: …and a pinned currency still answers without it",
    (await caught(() =>
      resolveSegment(orgId, bizFx.id, [
        { field: "mrr", op: "gte", value: "1" },
        { field: "currency", op: "is", value: "GBP" },
      ]),
    )) === null,
  );
}

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log(
  failed === 0 ? `\nPASS — ${checks.length} checks` : `\nFAIL — ${failed}/${checks.length} failed`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);

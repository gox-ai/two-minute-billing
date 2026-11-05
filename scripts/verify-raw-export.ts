/**
 * Raw-data export: the rows behind a report figure.
 *
 * A report says the quarter billed $1.44M. This export says WHICH invoices — and it is worth
 * nothing unless those invoices add up to $1.44M. So the central assertion here is not that
 * the route answers: it is the EQUALITY. Every dataset declares the report it reconciles
 * with, and this suite resolves that report and the export over the same window and asserts
 * they are the same integer.
 *
 * Sections:
 *   §1 THE WINDOW — the export takes it from `buildBuckets`, the report layer's own bucket
 *      builder, so the two cannot be cut on different calendars. Asserted per range.
 *   §2 RECONCILIATION, single currency — Σ exported rows = the report headline, exactly, for
 *      all four datasets. Single currency so the equality means something.
 *   §3 MIXED CURRENCY — each row carries its own currency and the rate applied to it; totals
 *      are offered per currency and never across them. A currency-scoped export answers the
 *      currency-scoped report.
 *   §4 TENANCY — another organization exports nothing from this business.
 *   §5 EMPTY WINDOW AND BOUNDING — a header and no rows, never a 500; and a paged walk at
 *      limit=1 returns every row exactly once.
 *
 * ⚠️ Seeds its own org; safe on the dev database.
 *   pnpm verify:raw-export
 */
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness, updateBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod, collectInvoice } from "@/modules/invoicing/service";
import { refundPayment } from "@/modules/refunds/service";
import { resolveReport } from "@/modules/metrics/reports/resolve";
import { buildBuckets, ANALYTICS_RANGES, type AnalyticsRange } from "@/modules/metrics/analytics";
import {
  RAW_DATASETS,
  exportWindow,
  readRawPage,
  streamRawCsv,
  MAX_PAGE,
  type RawDatasetKey,
} from "@/modules/metrics/export/datasets";
import { mrrMovements, payments } from "@db/schema";
import { asc, eq, sql } from "drizzle-orm";

let ok = 0;
let fail = 0;
const check = (label: string, pass: boolean, detail?: string) => {
  if (pass) {
    ok++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
const eq_ = (label: string, actual: unknown, expected: unknown) =>
  check(label, String(actual) === String(expected), `got ${actual}, want ${expected}`);

const NOW = new Date();
const OPTS = { range: "12m", now: NOW };

/** Every row of the export, walked through the cursor the way a client would. */
async function exportAll(
  orgId: string,
  bizId: string,
  dataset: RawDatasetKey,
  opts: { range?: string; currency?: string; limit?: number } = {},
) {
  const first = await readRawPage(orgId, bizId, dataset, { ...OPTS, ...opts });
  const rows = [...first.rows];
  let cursor = first.nextCursor;
  let pages = 1;
  while (cursor) {
    const next = await readRawPage(orgId, bizId, dataset, {
      ...OPTS,
      ...opts,
      startingAfter: cursor,
    });
    rows.push(...next.rows);
    cursor = next.nextCursor;
    pages++;
  }
  const col = (name: string) => first.columns.indexOf(name);
  return { page: first, rows, pages, col };
}

async function collect(gen: AsyncGenerator<string>) {
  let out = "";
  for await (const chunk of gen) out += chunk;
  return out;
}

/** Σ of the converted column — the figure the report summed, row by row. */
const sumReporting = (rows: (string | number | null)[][], idx: number) =>
  rows.reduce((s, r) => s + Number(r[idx] ?? 0), 0);

// ── §1 THE WINDOW ─────────────────────────────────────────────────────────────────────
console.log("\n§1 the window is the report's window");
for (const range of ANALYTICS_RANGES) {
  const buckets = buildBuckets(range as AnalyticsRange, NOW, "back");
  const w = exportWindow(range, NOW);
  eq_(`${range}: start`, w.start.toISOString(), buckets[0]!.start.toISOString());
  eq_(`${range}: end`, w.end.toISOString(), buckets[buckets.length - 1]!.end.toISOString());
}
check(
  "an unknown range is refused, not silently defaulted",
  await (async () => {
    try {
      exportWindow("last_tuesday", NOW);
      return false;
    } catch {
      return true;
    }
  })(),
);

// ── FIXTURE A: one currency, so the equality means something ──────────────────────────
const org = await createOrganization({ name: "Raw Export Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Export Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "export@example.com",
});
await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz.id,
  customer,
  token: "tok_4242",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
const usd = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 12345,
  interval: "month",
});
const subA = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: NOW,
  items: [{ price: usd, quantity: 1 }],
});
const billed = await billSubscriptionPeriod({
  organizationId: orgId,
  businessId: biz.id,
  subscription: subA.subscription,
  periodStart: subA.subscription.currentPeriodStart!,
  periodEnd: subA.subscription.currentPeriodEnd!,
});
if (!billed.payment || billed.payment.status !== "succeeded") {
  console.log("❌ fixture: the renewal did not collect");
  process.exit(1);
}
// A second subscription, so the movement ledger carries more than one row, and a partial
// refund so the refunds dataset is not empty.
const usdB = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 24690,
  interval: "month",
});
const subB = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: NOW,
  items: [{ price: usdB, quantity: 1 }],
});
const billedB = await billSubscriptionPeriod({
  organizationId: orgId,
  businessId: biz.id,
  subscription: subB.subscription,
  periodStart: subB.subscription.currentPeriodStart!,
  periodEnd: subB.subscription.currentPeriodEnd!,
});
await collectInvoice({ organizationId: orgId, businessId: biz.id, invoice: billedB.invoice });
const [pay] = await withTenant(orgId, (tx) =>
  tx
    .select({ publicId: payments.publicId })
    .from(payments)
    .where(eq(payments.invoiceId, billed.invoice.id))
    .limit(1),
);
await refundPayment({
  organizationId: orgId,
  businessId: biz.id,
  paymentPublicId: pay!.publicId,
  amountMinor: 4321,
  reason: "raw export fixture",
});

// ── §2 RECONCILIATION ─────────────────────────────────────────────────────────────────
console.log("\n§2 the rows sum to the figure (single currency)");
for (const def of RAW_DATASETS) {
  const { page, rows, col } = await exportAll(orgId, biz.id, def.key);
  const report = await resolveReport(orgId, biz.id, def.reconciles_with, OPTS);
  const sum = sumReporting(rows, col("reporting_amount_minor"));
  eq_(`${def.key} → ${def.reconciles_with}: Σ rows = headline`, sum, report.headline);
  check(`${def.key}: the export produced rows`, rows.length > 0, `got ${rows.length}`);
  eq_(
    `${def.key}: window matches the report's`,
    page.windowStart.toISOString(),
    exportWindow("12m", NOW).start.toISOString(),
  );
  // In one currency the native column and the converted column must be the same money.
  eq_(
    `${def.key}: nothing was converted, so native = reporting`,
    sumReporting(rows, col(def.amount_column)),
    sum,
  );
  eq_(`${def.key}: one currency, one total row`, page.totalsByCurrency.length, 1);
  eq_(`${def.key}: the currency total is native`, page.totalsByCurrency[0]!.currency, "USD");
}

// A figure with a known value, so this is not just two code paths agreeing with each other:
// two invoices were billed at 12345 and 24690.
{
  const { rows, col } = await exportAll(orgId, biz.id, "invoices");
  eq_("invoices: exactly the two billed documents", rows.length, 2);
  eq_("invoices: Σ = 12345 + 24690", sumReporting(rows, col("total_minor")), 12345 + 24690);
}

// ── §3 MIXED CURRENCY ─────────────────────────────────────────────────────────────────
console.log("\n§3 mixed currency: per row, never across rows");
const mixOrg = await createOrganization({ name: "Raw Export Mixed Org" });
const mixOrgId = mixOrg.organization.id;
const mixBiz = await createBusiness({
  organizationId: mixOrgId,
  name: "Mixed Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
// 80 INR per 1 USD, the direction `analytics.ts` divides by.
await updateBusiness(mixOrgId, mixBiz.publicId, { exchangeRates: { INR: 80 } });
const mixCustomer = await createCustomer({
  organizationId: mixOrgId,
  businessId: mixBiz.id,
  email: "mixed@example.com",
});
await vaultPaymentMethod({
  organizationId: mixOrgId,
  businessId: mixBiz.id,
  customer: mixCustomer,
  token: "tok_4242",
});
const mixProduct = await createProduct({
  organizationId: mixOrgId,
  businessId: mixBiz.id,
  name: "Pro",
});
for (const [currency, amountMinor] of [
  ["USD", 10000],
  ["INR", 800000],
] as const) {
  const price = await createPrice({
    organizationId: mixOrgId,
    businessId: mixBiz.id,
    productId: mixProduct.id,
    type: "recurring",
    model: "flat",
    currency,
    amountMinor,
    interval: "month",
  });
  const sub = await createSubscription({
    organizationId: mixOrgId,
    businessId: mixBiz.id,
    customerId: mixCustomer.id,
    now: NOW,
    items: [{ price, quantity: 1 }],
  });
  await billSubscriptionPeriod({
    organizationId: mixOrgId,
    businessId: mixBiz.id,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
}
{
  const { page, rows, col } = await exportAll(mixOrgId, mixBiz.id, "invoices");
  const report = await resolveReport(mixOrgId, mixBiz.id, "total_billing", OPTS);
  eq_("mixed: two invoices, two currencies", rows.length, 2);
  eq_(
    "mixed: Σ converted rows = the converted headline",
    sumReporting(rows, col("reporting_amount_minor")),
    report.headline,
  );
  const byCcy = new Map(page.totalsByCurrency.map((t) => [t.currency, t.amount_minor]));
  eq_("mixed: a total per currency, not one total", page.totalsByCurrency.length, 2);
  eq_("mixed: the USD total is USD cents", byCcy.get("USD"), 10000);
  eq_("mixed: the INR total is INR paise, unconverted", byCcy.get("INR"), 800000);
  // The point of the rule: 810000 is what a cross-currency sum would print, and it is
  // true of nothing. No field may carry it.
  check(
    "mixed: no field presents a cross-currency total",
    !Object.values(page as unknown as Record<string, unknown>).some(
      (v) => typeof v === "number" && v === 810000,
    ),
  );
  // Every row states the rate it was converted at, beside its own money.
  const inr = rows.find((r) => r[col("currency")] === "INR")!;
  eq_("mixed: the INR row keeps its own amount", inr[col("total_minor")], 800000);
  eq_("mixed: the INR row states the rate used", inr[col("reporting_rate")], 80);
  eq_("mixed: the INR row converts at that rate", inr[col("reporting_amount_minor")], 10000);
  const usdRow = rows.find((r) => r[col("currency")] === "USD")!;
  eq_("mixed: the reporting currency has no rate", usdRow[col("reporting_rate")], null);
}
{
  // Scoped to one currency, the export answers the same question the scoped report does —
  // and converts nothing.
  const { page, rows, col } = await exportAll(mixOrgId, mixBiz.id, "invoices", { currency: "INR" });
  const report = await resolveReport(mixOrgId, mixBiz.id, "total_billing", {
    ...OPTS,
    currency: "INR",
  });
  eq_("scoped: only the INR document", rows.length, 1);
  eq_(
    "scoped: Σ rows = the scoped headline",
    sumReporting(rows, col("reporting_amount_minor")),
    report.headline,
  );
  eq_("scoped: nothing was converted", page.converted, false);
}
{
  // A currency no rate reaches is EXCLUDED — the report excludes it too, and a row the
  // report dropped would break the equality it exists to prove.
  const price = await createPrice({
    organizationId: mixOrgId,
    businessId: mixBiz.id,
    productId: mixProduct.id,
    type: "recurring",
    model: "flat",
    currency: "EUR",
    amountMinor: 9000,
    interval: "month",
  });
  const sub = await createSubscription({
    organizationId: mixOrgId,
    businessId: mixBiz.id,
    customerId: mixCustomer.id,
    now: NOW,
    items: [{ price, quantity: 1 }],
  });
  await billSubscriptionPeriod({
    organizationId: mixOrgId,
    businessId: mixBiz.id,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  const { page, rows, col } = await exportAll(mixOrgId, mixBiz.id, "invoices");
  const report = await resolveReport(mixOrgId, mixBiz.id, "total_billing", OPTS);
  check("unrateable: the EUR row is left out", !rows.some((r) => r[col("currency")] === "EUR"));
  check(
    "unrateable: and out of the per-currency totals",
    !page.totalsByCurrency.some((t) => t.currency === "EUR"),
  );
  eq_(
    "unrateable: the equality still holds",
    sumReporting(rows, col("reporting_amount_minor")),
    report.headline,
  );
}

// ── §4 TENANCY ────────────────────────────────────────────────────────────────────────
console.log("\n§4 tenancy");
{
  const { rows, page } = await exportAll(mixOrgId, biz.id, "invoices");
  eq_("another organization exports no rows from this business", rows.length, 0);
  eq_("…and no totals either", page.totalsByCurrency.length, 0);
  const csv = await collect(streamRawCsv(mixOrgId, biz.id, "invoices", OPTS));
  eq_("…and the CSV is a header and nothing else", csv.trim().split("\n").length, 1);
}

// ── §5 EMPTY WINDOW AND BOUNDING ──────────────────────────────────────────────────────
console.log("\n§5 an empty window, and a bounded read");
{
  const emptyOrg = await createOrganization({ name: "Raw Export Empty Org" });
  const emptyBiz = await createBusiness({
    organizationId: emptyOrg.organization.id,
    name: "Empty Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  for (const def of RAW_DATASETS) {
    const page = await readRawPage(emptyOrg.organization.id, emptyBiz.id, def.key, OPTS);
    eq_(`${def.key}: an empty window is an empty page`, page.rows.length, 0);
    check(`${def.key}: …and no cursor to follow`, page.nextCursor === null && !page.hasMore);
    const csv = await collect(streamRawCsv(emptyOrg.organization.id, emptyBiz.id, def.key, OPTS));
    const lines = csv.trim().split("\n");
    eq_(`${def.key}: the CSV is a header and no rows`, lines.length, 1);
    eq_(
      `${def.key}: the header names every column`,
      lines[0]!.split(",").length,
      def.columns.length,
    );
  }
}
{
  // The bound is real: at one row a page, the walk still returns every row exactly once.
  const whole = await exportAll(orgId, biz.id, "mrr_movements");
  const paged = await exportAll(orgId, biz.id, "mrr_movements", { limit: 1 });
  eq_("paged at limit=1: same row count", paged.rows.length, whole.rows.length);
  eq_("paged at limit=1: one page per row", paged.pages, whole.rows.length);
  const ids = paged.rows.map((r) => String(r[0]));
  eq_("paged at limit=1: no row seen twice", new Set(ids).size, ids.length);
  eq_(
    "paged at limit=1: the sum is unchanged",
    sumReporting(paged.rows, paged.col("reporting_amount_minor")),
    sumReporting(whole.rows, whole.col("reporting_amount_minor")),
  );
  // THE CURSOR CARRIES POSTGRES' OWN PRECISION. A JS `Date` keeps milliseconds and the
  // column keeps microseconds, so a truncated cursor re-reads every row inside that
  // millisecond — on the real book that duplicated invoices across a page boundary and the
  // export came out ABOVE the report it exists to equal.
  {
    const first = await readRawPage(orgId, biz.id, "mrr_movements", { ...OPTS, limit: 1 });
    const [row] = await withTenant(orgId, (tx) =>
      tx
        .select({ at: sql<string>`${mrrMovements.occurredAt}::text`, id: mrrMovements.id })
        .from(mrrMovements)
        .where(eq(mrrMovements.businessId, biz.id))
        .orderBy(asc(mrrMovements.occurredAt), asc(mrrMovements.id))
        .limit(1),
    );
    const decoded = Buffer.from(first.nextCursor!, "base64url").toString("utf8").split("|");
    eq_("the cursor keeps the instant at database precision", decoded[0], row!.at);
    eq_("…and the row it stopped on", decoded[1], row!.id);
  }
  eq_(
    "a page is capped",
    (await readRawPage(orgId, biz.id, "invoices", { ...OPTS, limit: 999999 })).rows.length <=
      MAX_PAGE,
    true,
  );
  // The CSV walks the same cursor, so it carries the same rows as the JSON pages.
  const csv = await collect(streamRawCsv(orgId, biz.id, "mrr_movements", OPTS));
  eq_(
    "the CSV carries one line per row, plus the header",
    csv.trim().split("\n").length,
    whole.rows.length + 1,
  );
}

console.log("");
console.log(`${ok} ok, ${fail} failed`);
console.log(fail === 0 ? "✅ RAW EXPORT: PASS" : "❌ RAW EXPORT: FAIL");
await closeDb();
process.exit(fail === 0 ? 0 : 1);

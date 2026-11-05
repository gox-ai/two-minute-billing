/**
 * Bucket drill-downs: clicking a figure must land on the rows that figure counted.
 *
 * A `buckets` report answers with rows — the ageing ladder's rungs, the dunning states, the
 * codes a gateway gave. Each of those rows is only honest as a link if the list can express
 * the same bucket, so this suite asserts the two ends of every drill-down:
 *
 *   1. the FILTER narrows to the bucket it names, and
 *   2. the filtered list's figure EQUALS the report's figure for that bucket.
 *
 * (2) is the one that matters. A link that lands on a filtered list which happens to
 * disagree with the number clicked is worse than no link: it looks like an answer.
 *
 * The drill triples are not restated here — they are imported from
 * `dashboard/components/reports/report-drills.ts`, which is the same module the dashboard
 * builds its hrefs from. A gate asserting its own copy of the filters would pass while the
 * links sent something else.
 *
 * Sections:
 *   §1 ONE LADDER — the engine's rungs, the rungs the report prints and the rungs the
 *      dashboard offers are the same strings, in the same order. This is the anti-drift
 *      lock: `ar_bucket` compares a rung NAME, so a rename on either side is caught here
 *      rather than as an empty drill-down.
 *   §2 `ar_bucket` NARROWS — one invoice per rung, at both edges of each, plus the
 *      no-due-date case the ladder files as Current. Set membership and negation too.
 *   §3 THE LADDER RECONCILES — per rung, Σ `amount_due_minor` over the drilled list =
 *      the report's figure for that rung, and the rungs sum to the headline.
 *   §4 DUNNING STATUS — per state, the drilled list's row count = the summary's count.
 *   §5 DECLINE CODES, including the NULL bucket — `Unspecified` is a missing code, not a
 *      code spelled that way, and it drills through `error_code[is_present]=false`.
 *   §6 ANOTHER RUNG WIDTH — the ladder rebuilt at 15- and 7-day rungs: the rungs still sum
 *      to the same total, and a rung NO standard ladder has still drills into the invoices
 *      behind its figure. That last one is why the filter parses the rung name instead of
 *      matching a fixed list.
 *   §7 A BAD BUCKET IS AN ERROR — a name that is not a rung at all is refused, never
 *      answered with an empty page under a 200.
 *   §8 TENANCY — the filter is not a way around the org boundary.
 *
 * ⚠️ Seeds its own org; safe on the dev database.
 *   pnpm verify:bucket-drilldowns
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createInvoiceFromLines, listInvoicesPage } from "@/modules/invoicing/service";
import { listTransactionsPage, recordTransaction } from "@/modules/transactions/service";
import {
  AR_AGING_BUCKETS,
  AR_AGING_INTERVALS,
  arAgingBucketSql,
  arAgingIntervalError,
  arAgingLadder,
  arBucketValueError,
} from "@/modules/invoicing/ar-aging";
import { validateFilters } from "@/modules/list-views/service";
import { resolveReport } from "@/modules/metrics/reports/resolve";
import { buildBuckets } from "@/modules/metrics/analytics";
import { invoices } from "@db/schema";
import {
  AR_AGING_BUCKET_LABELS,
  bucketDrill,
  UNSPECIFIED_ERROR,
  type DrillFilter,
} from "../dashboard/components/reports/report-drills";

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

const DAY = 86_400_000;
const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);

// ── Seed ──────────────────────────────────────────────────────────────────────────────
const org = await createOrganization({ name: "Bucket Drilldown Org" });
const orgId = org.organization.id;
/**
 * UTC, deliberately. Report buckets are UTC-anchored and list date filters bucket by the
 * BUSINESS day, so only a UTC business lets the two agree at the edges — the decline-code
 * window is the drill that depends on it.
 */
const biz = await createBusiness({
  organizationId: orgId,
  name: "Drill Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "drill@example.com",
});

/**
 * An unpaid invoice due `overdueDays` ago (negative = due in future, null = no due date).
 *
 * Amounts differ per rung so a rung landing in the wrong bucket shows up as a wrong FIGURE
 * and not only as a wrong count — a count-only assertion passes when two rungs swap.
 */
async function seedInvoice(
  amountMinor: number,
  overdueDays: number | null,
  extra: { dunningStatus?: string; writtenOff?: boolean; status?: string } = {},
): Promise<string> {
  const inv = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    currency: "USD",
    lines: [{ description: "Drill line", quantity: 1, amountMinor: BigInt(amountMinor) }],
  });
  await withTenant(orgId, (tx) =>
    tx
      .update(invoices)
      .set({
        status: extra.status ?? "payment_due",
        // Ageing is measured from the due date; the issue date is irrelevant to the ladder.
        dueDate: overdueDays == null ? null : daysAgo(overdueDays),
        amountDueMinor: BigInt(amountMinor),
        ...(extra.dunningStatus ? { dunningStatus: extra.dunningStatus as "in_progress" } : {}),
        ...(extra.writtenOff ? { writtenOff: true } : {}),
      })
      .where(eq(invoices.id, inv.invoice.id)),
  );
  return inv.invoice.id;
}

/** Run a drill's filters against the real list endpoint's own query path. */
const drillInvoices = (filters: DrillFilter[]) =>
  listInvoicesPage(orgId, biz.id, { filters, limit: 1000 });
const drillTransactions = (filters: DrillFilter[]) =>
  listTransactionsPage(orgId, biz.id, { filters, limit: 1000 });

/**
 * One invoice per rung, placed mid-rung, plus both EDGES of `1–30 days`: day 1 is the first
 * overdue day and day 30 the last one before the next rung. An off-by-one in the ladder's
 * `<=` shows up nowhere else.
 */
const RUNG_SEEDS: Array<{ bucket: string; overdueDays: number | null; amount: number }> = [
  { bucket: "Current", overdueDays: null, amount: 100_00 },
  { bucket: "Current", overdueDays: -5, amount: 200_00 },
  { bucket: "1–30 days", overdueDays: 1, amount: 300_00 },
  { bucket: "1–30 days", overdueDays: 30, amount: 400_00 },
  { bucket: "31–60 days", overdueDays: 31, amount: 500_00 },
  { bucket: "31–60 days", overdueDays: 60, amount: 600_00 },
  { bucket: "61–90 days", overdueDays: 75, amount: 700_00 },
  { bucket: "91–120 days", overdueDays: 100, amount: 800_00 },
  { bucket: "121–150 days", overdueDays: 130, amount: 900_00 },
  { bucket: "151–180 days", overdueDays: 170, amount: 1_000_00 },
  { bucket: "181–365 days", overdueDays: 300, amount: 1_100_00 },
  { bucket: "365+ days", overdueDays: 500, amount: 1_200_00 },
];

const seeded: string[] = [];
for (const s of RUNG_SEEDS) seeded.push(await seedInvoice(s.amount, s.overdueDays));
// Excluded from the ladder but NOT from the table: a written-off invoice owes nothing, and
// a paid one is not receivable. Both are 61–90 days past due, so if the drill's `status` /
// `written_off` rows were dropped the figures would diverge by exactly these.
const writtenOff = await seedInvoice(9_999_00, 75, { writtenOff: true });
const paid = await seedInvoice(8_888_00, 75, { status: "paid" });

// ── §1 ONE LADDER ─────────────────────────────────────────────────────────────────────
console.log("\n§1 one ladder, three readers");
{
  const report = await resolveReport(orgId, biz.id, "receivables_aging_summary", { now });
  const printed = (report.rows ?? []).map((r) => r.group);
  eq_(
    "the engine's ladder = what the report prints",
    printed.join("|"),
    AR_AGING_BUCKETS.join("|"),
  );
  eq_(
    "the engine's ladder = what the list offers",
    AR_AGING_BUCKET_LABELS.join("|"),
    AR_AGING_BUCKETS.join("|"),
  );
  // The drill's own vocabulary, exercised through the validator the route answers 400 from:
  // a rung the report prints must be a rung the filter accepts.
  check(
    "every printed rung is an accepted filter value",
    printed.every((p) => arBucketValueError("is", p) == null),
  );
}

// ── §2 ar_bucket NARROWS ──────────────────────────────────────────────────────────────
console.log("\n§2 ar_bucket narrows to the rung it names");
for (const bucket of AR_AGING_BUCKETS) {
  // The written-off and paid rows are 75 days past due and carry no ageing exemption of
  // their own: `ar_bucket` is about ageing alone, so they belong in this page.
  const expected = new Set(RUNG_SEEDS.flatMap((s, i) => (s.bucket === bucket ? [seeded[i]!] : [])));
  if (bucket === "61\u201390 days") for (const id of [writtenOff, paid]) expected.add(id);

  const page = await drillInvoices([{ field: "ar_bucket", op: "is", value: bucket }]);
  const got = new Set(page.data.map((r) => r.invoice.id));
  eq_(`${bucket}: ${expected.size} rows`, page.total, expected.size);
  check(
    `${bucket}: exactly the invoices of that rung`,
    got.size === expected.size && [...expected].every((id) => got.has(id)),
  );
}
{
  const some = await drillInvoices([{ field: "ar_bucket", op: "in", value: "Current,365+ days" }]);
  eq_("in: Current + 365+ days", some.total, 3);
  const not = await drillInvoices([{ field: "ar_bucket", op: "is_not", value: "Current" }]);
  eq_("is_not Current excludes exactly the Current rows", not.total, RUNG_SEEDS.length + 2 - 2);
  // Case-insensitively, like every other non-numeric filter in the grammar.
  const lower = await drillInvoices([{ field: "ar_bucket", op: "is", value: "current" }]);
  eq_("the comparison is case-insensitive", lower.total, 2);
}

// ── §3 THE LADDER RECONCILES ──────────────────────────────────────────────────────────
console.log("\n§3 the drilled list equals the figure that was clicked");
{
  const report = await resolveReport(orgId, biz.id, "receivables_aging_summary", { now });
  const rows = report.rows ?? [];
  let ladderSum = 0;
  for (const row of rows) {
    const target = bucketDrill("receivables_aging_summary", row.group, {});
    if (!target) {
      check(`${row.group}: has a destination`, false);
      continue;
    }
    const page = await drillInvoices(target.filters);
    const listed = page.data.reduce((s, r) => s + Number(r.invoice.amountDueMinor ?? 0n), 0);
    eq_(`${row.group}: Σ amount due = the report's ${row.value}`, listed, row.value);
    ladderSum += row.value;
  }
  eq_("the rungs sum to the headline", ladderSum, report.headline);
  // The write-off and the paid invoice are the reason the drill carries `status` and
  // `written_off`: without those rows the 61–90 figure would be 9,999 + 8,888 too high.
  const naive = await drillInvoices([{ field: "ar_bucket", op: "is", value: "61–90 days" }]);
  check(
    "dropping the population rows would overstate the rung",
    naive.data.reduce((s, r) => s + Number(r.invoice.amountDueMinor ?? 0n), 0) >
      (rows.find((r) => r.group === "61–90 days")?.value ?? 0),
  );
}

// ── §4 DUNNING STATUS ─────────────────────────────────────────────────────────────────
console.log("\n§4 dunning status");
{
  await seedInvoice(50_00, 10, { dunningStatus: "in_progress" });
  await seedInvoice(60_00, 20, { dunningStatus: "in_progress" });
  await seedInvoice(70_00, 40, { dunningStatus: "parked" });
  await seedInvoice(80_00, 400, { dunningStatus: "exhausted" });

  const report = await resolveReport(orgId, biz.id, "dunning_status_summary", { now });
  const rows = report.rows ?? [];
  check("the summary found the seeded states", rows.length === 3, `rows: ${rows.length}`);
  for (const row of rows) {
    const target = bucketDrill("dunning_status_summary", row.group, {});
    const page = await drillInvoices(target!.filters);
    eq_(`${row.group}: ${row.value} invoices listed`, page.total, row.value);
  }
  eq_(
    "the states sum to the headline",
    rows.reduce((s, r) => s + r.value, 0),
    report.headline,
  );
  // Never-dunned invoices are absent from the summary AND unreachable through its drills,
  // which is right: `dunning_status` is NULL on them, not a state.
  const none = await drillInvoices([{ field: "dunning_status", op: "is_present", value: "false" }]);
  check("never-dunned invoices exist and are not in the summary", (none.total ?? 0) > 0);
}

// ── §5 DECLINE CODES, NULL INCLUDED ───────────────────────────────────────────────────
console.log("\n§5 decline codes, including the unnamed one");
{
  const attempt = (
    type: "payment" | "refund",
    status: "succeeded" | "failed",
    errorCode: string | null,
    occurredAt: Date,
  ) =>
    recordTransaction({
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      type,
      status,
      amountMinor: 1_00n,
      currency: "USD",
      errorCode,
      occurredAt,
    });

  const inWindow = daysAgo(3);
  await attempt("payment", "failed", "card_declined", inWindow);
  await attempt("payment", "failed", "card_declined", inWindow);
  await attempt("payment", "failed", "insufficient_funds", inWindow);
  // The bucket the ladder of codes cannot name: the gateway refused and said nothing.
  await attempt("payment", "failed", null, inWindow);
  await attempt("payment", "failed", null, inWindow);
  // Must not appear: a success, a refund failure, and a failure outside the window.
  await attempt("payment", "succeeded", null, inWindow);
  await attempt("refund", "failed", "refund_not_possible", inWindow);
  await attempt("payment", "failed", "card_declined", daysAgo(800));

  const report = await resolveReport(orgId, biz.id, "payment_error_summary", { range: "12m", now });
  const rows = report.rows ?? [];
  eq_("three payment-error buckets", rows.length, 3);
  const unspecified = rows.find((r) => r.group === UNSPECIFIED_ERROR);
  eq_(`the ${UNSPECIFIED_ERROR} bucket counts the codeless failures`, unspecified?.value, 2);

  /**
   * The window the report answered over — `buildBuckets`, which is the function the resolver
   * builds its buckets from AND the one the route serves `window_start` / `window_end` off.
   * Deriving it any other way here would be a second copy of the range arithmetic, and the
   * gate would then be testing the copy.
   */
  const preset = buildBuckets(report.range, now, "back");
  const span = {
    start: preset[0]!.start.toISOString(),
    end: preset[preset.length - 1]!.end.toISOString(),
  };
  for (const row of rows) {
    const target = bucketDrill("payment_error_summary", row.group, span);
    const page = await drillTransactions(target!.filters);
    eq_(`${row.group}: ${row.value} transactions listed`, page.total, row.value);
  }
  eq_(
    "the codes sum to the headline",
    rows.reduce((s, r) => s + r.value, 0),
    report.headline,
  );

  // A row with no window has no honest destination, so it does not link at all.
  check(
    "no window means no link",
    bucketDrill("payment_error_summary", "card_declined", {}) == null,
  );

  // Refunds drill to refunds. A shared `type` would have put the refund failure in the
  // payment summary's drill-down, where the figure never counted it.
  const refunds = await resolveReport(orgId, biz.id, "refund_error_summary", { range: "12m", now });
  const refundRow = (refunds.rows ?? [])[0];
  eq_("one refund-error bucket", (refunds.rows ?? []).length, 1);
  const refundPage = await drillTransactions(
    bucketDrill("refund_error_summary", refundRow!.group, span)!.filters,
  );
  eq_(
    `${refundRow!.group}: ${refundRow!.value} refunds listed`,
    refundPage.total,
    refundRow!.value,
  );
}

// ── §6 ANOTHER RUNG WIDTH ─────────────────────────────────────────────────────────────
console.log("\n§6 the ladder at another rung width");
{
  const standard = await resolveReport(orgId, biz.id, "receivables_aging_summary", { now });
  eq_(
    "the default ladder is the standard one, rung for rung",
    (standard.rows ?? []).map((r) => r.group).join("|"),
    "Current|1–30 days|31–60 days|61–90 days|91–120 days|121–150 days|151–180 days|181–365 days|365+ days",
  );
  eq_("the default answer says which ladder it used", standard.aging_interval, "standard");

  for (const interval of ["15", "7"] as const) {
    const report = await resolveReport(orgId, biz.id, "receivables_aging_summary", {
      now,
      agingInterval: interval,
    });
    const rows = report.rows ?? [];
    const ladder = arAgingLadder(interval);
    eq_(
      `${interval}-day rungs: the report prints that ladder`,
      rows.map((r) => r.group).join("|"),
      ladder.labels.join("|"),
    );
    // Re-bucketing moves rows between rungs; it cannot change how much is owed.
    eq_(
      `${interval}-day rungs: the rungs sum to the same total`,
      rows.reduce((n, r) => n + r.value, 0),
      standard.headline,
    );
    eq_(`${interval}-day rungs: the answer echoes the interval`, report.aging_interval, interval);

    /**
     * The whole point of the name-derived filter: a rung this ladder invented — no standard
     * ladder has `1–15 days` — still reaches the invoices behind the figure.
     */
    let drilled = 0;
    for (const row of rows.filter((r) => r.value !== 0)) {
      const target = bucketDrill("receivables_aging_summary", row.group, {});
      const page = await drillInvoices(target!.filters);
      const listed = page.data.reduce((s, r) => s + Number(r.invoice.amountDueMinor ?? 0n), 0);
      eq_(
        `${interval}-day rungs — ${row.group}: Σ amount due = the report's ${row.value}`,
        listed,
        row.value,
      );
      drilled++;
      // And the name-derived predicate selects exactly the rows the ladder's own CASE
      // labels with that rung — the two definitions cannot drift apart.
      const labelled = await withTenant(orgId, (tx) =>
        tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(
            and(eq(invoices.businessId, biz.id), sql`${arAgingBucketSql(interval)} = ${row.group}`),
          ),
      );
      const bare = await drillInvoices([{ field: "ar_bucket", op: "is", value: row.group }]);
      eq_(
        `${interval}-day rungs — ${row.group}: the filter selects what the ladder labels`,
        bare.total,
        labelled.length,
      );
    }
    check(
      `${interval}-day rungs: rungs with money in them were drilled`,
      drilled >= 3,
      `drilled ${drilled}`,
    );
  }

  // A width outside the closed set is refused by name, never clamped to the nearest one.
  check("an interval outside the set is refused", arAgingIntervalError("45") != null);
  check(
    "the refusal names the set",
    (arAgingIntervalError("45") ?? "").includes(AR_AGING_INTERVALS.join(", ")),
  );
  eq_("a member of the set is accepted", arAgingIntervalError("15"), null);
}

// ── §7 A BAD BUCKET IS AN ERROR ───────────────────────────────────────────────────────
console.log("\n§7 a rung the ladder does not have");
{
  check("a stale rung name is refused", arBucketValueError("is", "31-60 days") != null);
  // A rung of ANOTHER ladder is a rung: the names carry their own boundaries.
  eq_("a rung from a 15-day ladder is accepted", arBucketValueError("is", "1–15 days"), null);
  eq_("a rung from a 7-day ladder is accepted", arBucketValueError("is", "358–365 days"), null);
  check("a backwards rung is refused", arBucketValueError("is", "90–30 days") != null);
  check("a zero-day rung is refused", arBucketValueError("is", "0–30 days") != null);
  check("a hyphen is not an en dash", arBucketValueError("is", "31-60 days") != null);
  check("one bad member of a set is refused", arBucketValueError("in", "Current,nonsense") != null);
  check("a real rung passes", arBucketValueError("is", "181–365 days") == null);
  check("is_present is exempt", arBucketValueError("is_present", "true") == null);
  // And the refusal names the vocabulary, because a client discovering the filter
  // programmatically has nothing else to go on.
  check(
    "the message names the rungs",
    (arBucketValueError("is", "nope") ?? "").includes("365+ days"),
  );

  // And a SAVED VIEW is refused at save time, not on every later open of it: saving is the
  // only moment the operator is present to be told the rung does not exist.
  check(
    "a saved view naming a stale rung is refused on save",
    validateFilters("invoices", [{ field: "ar_bucket", op: "is", value: "31-60 days" }]) != null,
  );
  eq_(
    "a saved view naming a real rung saves",
    validateFilters("invoices", [{ field: "ar_bucket", op: "is", value: "Current" }]),
    null,
  );
}

// ── §8 TENANCY ────────────────────────────────────────────────────────────────────────
console.log("\n§8 tenancy");
{
  const other = await createOrganization({ name: "Bucket Drilldown Other Org" });
  const otherBiz = await createBusiness({
    organizationId: other.organization.id,
    name: "Other",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const leaked = await listInvoicesPage(other.organization.id, otherBiz.id, {
    filters: [{ field: "ar_bucket", op: "is_not", value: "Current" }],
    limit: 1000,
  });
  eq_("another org sees none of these invoices", leaked.total, 0);
  // Belt and braces: the seeded rows really are readable in their own org.
  const mine = await withTenant(orgId, (tx) =>
    tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(inArray(invoices.id, [writtenOff, paid])),
  );
  eq_("the excluded rows do exist", mine.length, 2);
}

console.log("");
console.log(`${ok} ok, ${fail} failed`);
console.log(fail === 0 ? "✅ BUCKET DRILL-DOWNS: PASS" : "❌ BUCKET DRILL-DOWNS: FAIL");
await closeDb();
process.exit(fail === 0 ? 0 : 1);

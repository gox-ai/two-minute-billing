/**
 * The ORACLE GATE for the money-movement and saved-card measures (Phase 7, groups 3 and 4).
 *
 * Fourteen figures about cash rather than about the book, so they get their own fixture:
 * gateway attempts in two currencies with successes, declines, a timeout and a failed
 * refund; invoices whose lines mix a plan fee, a setup fee and metered usage, paid and
 * partly refunded a month later; and a vault of cards around the expiry horizon. Everything
 * is written through `computeMetricPeriod` → `writeMetricDay` and compared against TWO
 * independent oracles.
 *
 *   1. AN EXPECTED TABLE, worked out by hand from the fixture. It agrees with neither the
 *      writer nor the reports; it is what a person gets with a pencil.
 *   2. THE REPORTS THEMSELVES — eighteen published keys, run over the same window and the
 *      same currency. A measure that quietly redefined its figure fails here.
 *
 * ⚠️ THE ONE THING THIS GATE EXISTS TO PROTECT: `payments_captured` sums the GATEWAY log and
 * `cash_collected` sums the APPLIED cash. They count different populations and the fixture
 * makes them differ on purpose — 12,000 captured against 10,000 applied in the same month.
 * The gate asserts the gap rather than tolerating it, so an "improvement" that made the two
 * agree would fail loudly instead of silently restating one as the other.
 *
 * The properties, in the order a wrong writer breaks them:
 *   1. the hand-worked table is stored, to the minor unit;
 *   2. stored == what each published report already answers;
 *   3. THE WINDOW IS THE MEASURE — a gateway figure is dated by the attempt, a refund by
 *      when the refund happened, an expiry by the card's own date;
 *   4. the two gateway/cash families stay apart, and the gap between them is preserved;
 *   5. the card counts have NO history: only the period containing the run carries them;
 *   6. a flow tiles — a month equals the sum of its days;
 *   7. every declared dimension is emitted, and nothing is emitted that is not declared;
 *   8. slices sum to their totals, and currencies never mix.
 *
 *   pnpm verify:metric-payments
 */
import { and, eq, sql } from "drizzle-orm";
import { closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { assertRegistryImplemented, computeMetricPeriod } from "@/modules/metrics/daily/compute";
import { writeMetricDay } from "@/modules/metrics/daily/write";
import { readMetricSeries } from "@/modules/metrics/daily/query";
import { MEASURES, type Grain } from "@/modules/metrics/daily/measures";
import { resolveReport } from "@/modules/metrics/reports/resolve";
import {
  invoiceLineItems,
  invoices,
  metricDaily,
  paymentMethods,
  payments,
  refunds,
  transactions,
} from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

/**
 * The instant every figure is taken at — FIXED, and passed to both the writer and the
 * reports. The card counts are "now" by definition, so a gate that let them read the wall
 * clock would be comparing two different nows.
 */
const NOW = new Date("2026-09-15T12:00:00.000Z");
const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const org = await createOrganization({ name: "Payment Measure Oracle Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Payment Measure Oracle Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
const bizId = biz.id;
const customer = await createCustomer({
  organizationId: orgId,
  businessId: bizId,
  email: `payment-oracle-${Date.now()}@example.test`,
});

let seq = 0;
const uniq = () => `${++seq}_${Date.now()}`;

/** One gateway attempt, dated exactly. The service path stamps wall clock; a gate cannot. */
async function txn(t: {
  type: "payment" | "refund";
  status: string;
  currency: string;
  amountMinor: number;
  occurredAt: string;
  errorCode?: string | null;
}) {
  await withTenant(orgId, (tx) =>
    tx.insert(transactions).values({
      organizationId: orgId,
      businessId: bizId,
      customerId: customer.id,
      publicId: `txn_oracle_${uniq()}`,
      type: t.type,
      status: t.status,
      amountMinor: BigInt(t.amountMinor),
      currency: t.currency,
      errorCode: t.errorCode ?? null,
      occurredAt: at(t.occurredAt),
    }),
  );
}

/** An invoice with its lines, and the payment that settled it. */
async function paidInvoice(i: {
  currency: string;
  createdAt: string;
  paidAt: string;
  /** `[kind, amountMinor]` per line. The document total is their sum. */
  lines: Array<[string, number]>;
}): Promise<string> {
  const total = i.lines.reduce((n, [, a]) => n + a, 0);
  return withTenant(orgId, async (tx) => {
    const [inv] = await tx
      .insert(invoices)
      .values({
        organizationId: orgId,
        businessId: bizId,
        customerId: customer.id,
        publicId: `inv_pay_oracle_${uniq()}`,
        status: "paid",
        currency: i.currency,
        subtotalMinor: BigInt(total),
        totalMinor: BigInt(total),
        paidAt: at(i.paidAt),
        createdAt: at(i.createdAt),
      })
      .returning({ id: invoices.id });
    for (const [kind, amount] of i.lines) {
      await tx.insert(invoiceLineItems).values({
        organizationId: orgId,
        businessId: bizId,
        invoiceId: inv!.id,
        publicId: `il_pay_oracle_${uniq()}`,
        description: `${kind} line`,
        quantity: 1,
        unitAmountMinor: BigInt(amount),
        amountMinor: BigInt(amount),
        kind,
        createdAt: at(i.createdAt),
      });
    }
    const [pay] = await tx
      .insert(payments)
      .values({
        organizationId: orgId,
        businessId: bizId,
        customerId: customer.id,
        invoiceId: inv!.id,
        publicId: `pay_oracle_${uniq()}`,
        status: "succeeded",
        amountMinor: BigInt(total),
        currency: i.currency,
        providerKey: "mock",
        createdAt: at(i.paidAt),
      })
      .returning({ id: payments.id });
    return pay!.id;
  });
}

async function refund(r: {
  paymentId: string;
  currency: string;
  amountMinor: number;
  createdAt: string;
}) {
  await withTenant(orgId, (tx) =>
    tx.insert(refunds).values({
      organizationId: orgId,
      businessId: bizId,
      paymentId: r.paymentId,
      publicId: `re_oracle_${uniq()}`,
      status: "succeeded",
      amountMinor: BigInt(r.amountMinor),
      currency: r.currency,
      providerKey: "mock",
      createdAt: at(r.createdAt),
    }),
  );
}

async function card(c: { status: string; expMonth: number | null; expYear: number | null }) {
  await withTenant(orgId, (tx) =>
    tx.insert(paymentMethods).values({
      organizationId: orgId,
      businessId: bizId,
      customerId: customer.id,
      publicId: `pm_oracle_${uniq()}`,
      providerKey: "mock",
      providerCustomerId: `cus_oracle_${uniq()}`,
      providerPaymentMethodId: `pm_provider_${uniq()}`,
      type: "card",
      brand: "visa",
      last4: "4242",
      status: c.status,
      expMonth: c.expMonth,
      expYear: c.expYear,
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The fixture.
// ─────────────────────────────────────────────────────────────────────────────
// June, USD: one capture, two declines (one of which named no reason), one timeout, one
// refund and one failed refund. Every status the counts have to tell apart.
await txn({
  type: "payment",
  status: "succeeded",
  currency: "USD",
  amountMinor: 12_000,
  occurredAt: "2026-06-10",
});
await txn({
  type: "payment",
  status: "failed",
  currency: "USD",
  amountMinor: 5000,
  occurredAt: "2026-06-12",
  errorCode: "card_declined",
});
await txn({
  type: "payment",
  status: "failed",
  currency: "USD",
  amountMinor: 5000,
  occurredAt: "2026-06-13",
});
await txn({
  type: "payment",
  status: "timeout",
  currency: "USD",
  amountMinor: 2000,
  occurredAt: "2026-06-25",
});
await txn({
  type: "refund",
  status: "succeeded",
  currency: "USD",
  amountMinor: 3000,
  occurredAt: "2026-06-20",
});
await txn({
  type: "refund",
  status: "failed",
  currency: "USD",
  amountMinor: 1000,
  occurredAt: "2026-06-22",
  errorCode: "refund_failed",
});
// The other currency, which must never be added to the first.
await txn({
  type: "payment",
  status: "succeeded",
  currency: "EUR",
  amountMinor: 8000,
  occurredAt: "2026-06-15",
});
// July: a capture, and a refund of money taken in June — dated by the refund, not the sale.
await txn({
  type: "payment",
  status: "succeeded",
  currency: "USD",
  amountMinor: 6000,
  occurredAt: "2026-07-10",
});
await txn({
  type: "refund",
  status: "succeeded",
  currency: "USD",
  amountMinor: 4000,
  occurredAt: "2026-07-05",
});

// The applied cash. Deliberately NOT the same money as the gateway rows above: the June
// invoice settles 10,000 while the gateway captured 12,000, which is the divergence this
// whole gate exists to keep visible.
const junePayment = await paidInvoice({
  currency: "USD",
  createdAt: "2026-06-05",
  paidAt: "2026-06-10",
  lines: [
    ["recurring", 6000],
    ["one_time", 3000],
    ["usage", 1000],
  ],
});
await paidInvoice({
  currency: "EUR",
  createdAt: "2026-06-12",
  paidAt: "2026-06-15",
  lines: [["recurring", 8000]],
});
await paidInvoice({
  currency: "USD",
  createdAt: "2026-07-08",
  paidAt: "2026-07-10",
  lines: [["recurring", 4000]],
});
// Half of June's invoice given back in July. Pro-rata across its three lines: 3000 of
// recurring, 1500 of the one-off, 500 of usage.
await refund({
  paymentId: junePayment,
  currency: "USD",
  amountMinor: 5000,
  createdAt: "2026-07-05",
});

// The vault, around the ninety-day horizon from NOW (2026-09-15 → 2026-12-14).
await card({ status: "valid", expMonth: 6, expYear: 2026 }); // expired by its own date
await card({ status: "valid", expMonth: 10, expYear: 2026 }); // expiring
await card({ status: "valid", expMonth: 12, expYear: 2026 }); // beyond the horizon
await card({ status: "expired", expMonth: 11, expYear: 2027 }); // expired by verdict only
await card({ status: "valid", expMonth: null, expYear: null }); // prints no date at all
await card({ status: "expired", expMonth: 11, expYear: 2026 }); // BOTH: dead now, dated soon

// ─────────────────────────────────────────────────────────────────────────────
// Materialise.
// ─────────────────────────────────────────────────────────────────────────────
const MINE = new Set(
  MEASURES.filter(
    (m) => m.source === "transactions" || m.source === "payments" || m.source === "payment_methods",
  ).map((m) => m.id),
);
type Key = string;
const key = (measure: string, dim: string, dimValue: string, currency: string) =>
  `${measure}|${dim}|${dimValue}|${currency}`;

const SAMPLED: Array<[Grain, string]> = [
  ["month", "2026-04-30"],
  ["month", "2026-06-30"],
  ["month", "2026-07-31"],
  ["month", "2026-09-30"],
  ["day", "2026-06-10"],
  ["day", "2026-06-12"],
  ["day", "2026-07-05"],
  ["day", "2026-09-15"],
];

async function materialise(grain: Grain, periodEnd: string): Promise<Map<Key, bigint | null>> {
  const rows = await withTenant(orgId, (tx) =>
    computeMetricPeriod(tx, bizId, grain, periodEnd, NOW),
  );
  await writeMetricDay({ organizationId: orgId, businessId: bizId, grain, periodEnd, rows });
  const stored = await withTenant(orgId, (tx) =>
    tx
      .select({
        measure: metricDaily.measure,
        dim: metricDaily.dim,
        dimValue: metricDaily.dimValue,
        currency: metricDaily.currency,
        value: metricDaily.value,
      })
      .from(metricDaily)
      .where(
        sql`${metricDaily.businessId} = ${bizId} and ${metricDaily.grain} = ${grain} and ${metricDaily.periodEnd} = ${periodEnd}`,
      ),
  );
  const out = new Map<Key, bigint | null>();
  for (const r of stored) {
    if (!MINE.has(r.measure)) continue;
    out.set(key(r.measure, r.dim, r.dimValue, r.currency), r.value);
  }
  return out;
}

const materialised = new Map<string, Map<Key, bigint | null>>();
for (const [grain, periodEnd] of SAMPLED) {
  materialised.set(`${grain}|${periodEnd}`, await materialise(grain, periodEnd));
}
const M = (grain: Grain, periodEnd: string) => materialised.get(`${grain}|${periodEnd}`)!;

// ─────────────────────────────────────────────────────────────────────────────
// 0. The registry and its writer agree, measure for measure.
// ─────────────────────────────────────────────────────────────────────────────
{
  let paired = true;
  try {
    assertRegistryImplemented();
  } catch {
    paired = false;
  }
  ok("registry: every declared measure is implemented, with the aggregate it promises", paired);
  ok(
    "registry: seven gateway measures, six cash measures, two card measures",
    MEASURES.filter((m) => m.source === "transactions").length === 7 &&
      MEASURES.filter((m) => m.source === "payments").length === 6 &&
      MEASURES.filter((m) => m.source === "payment_methods").length === 2,
  );
  ok(
    "registry: the gateway log and the applied cash are DIFFERENT sources, so nothing can net them",
    MEASURES.some((m) => m.id === "payments_captured" && m.source === "transactions") &&
      MEASURES.some((m) => m.id === "cash_collected" && m.source === "payments"),
  );
  const cards = MEASURES.filter((m) => m.source === "payment_methods");
  ok(
    "registry: the card counts DECLARE that they are as-of-now, have no currency, and offer no comparison",
    cards.length === 2 &&
      cards.every((m) => m.asOf === "computed_at" && m.currency === "none" && !m.supportsCompare),
  );
  ok(
    "registry: every gateway and cash measure is a flow, summed across its window",
    MEASURES.filter((m) => m.source === "transactions" || m.source === "payments").every(
      (m) => m.kind === "flow" && m.aggregate === "sum" && m.asOf === "period_end",
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE EXPECTED TABLE — worked out from the fixture by hand, not from either side.
// ─────────────────────────────────────────────────────────────────────────────
const EXPECTED: Array<[Grain, string, string, string, string, string, bigint]> = [
  // grain, periodEnd, measure, dim, dimValue, currency, value
  // ── June, the gateway log, USD ──
  ["month", "2026-06-30", "payments_captured", "", "", "USD", 12_000n],
  ["month", "2026-06-30", "refunds_issued", "", "", "USD", 3000n],
  ["month", "2026-06-30", "payments_net", "", "", "USD", 9000n],
  ["month", "2026-06-30", "payment_attempts", "", "", "USD", 4n],
  ["month", "2026-06-30", "refund_attempts", "", "", "USD", 2n],
  ["month", "2026-06-30", "payment_failures", "", "", "USD", 3n],
  ["month", "2026-06-30", "refund_failures", "", "", "USD", 1n],
  ["month", "2026-06-30", "payment_attempts", "transaction_status", "succeeded", "USD", 1n],
  ["month", "2026-06-30", "payment_attempts", "transaction_status", "failed", "USD", 2n],
  ["month", "2026-06-30", "payment_attempts", "transaction_status", "timeout", "USD", 1n],
  ["month", "2026-06-30", "refund_attempts", "transaction_status", "succeeded", "USD", 1n],
  ["month", "2026-06-30", "refund_attempts", "transaction_status", "failed", "USD", 1n],
  // A decline the gateway named, and two it did not — the timeout among them.
  ["month", "2026-06-30", "payment_failures", "failure_reason", "card_declined", "USD", 1n],
  ["month", "2026-06-30", "payment_failures", "failure_reason", "unspecified", "USD", 2n],
  ["month", "2026-06-30", "refund_failures", "failure_reason", "refund_failed", "USD", 1n],
  // ── June, the gateway log, EUR — its own arithmetic, never the first's ──
  ["month", "2026-06-30", "payments_captured", "", "", "EUR", 8000n],
  ["month", "2026-06-30", "refunds_issued", "", "", "EUR", 0n],
  ["month", "2026-06-30", "payment_failures", "", "", "EUR", 0n],
  // ── June, the applied cash ──
  ["month", "2026-06-30", "cash_collected", "", "", "USD", 10_000n],
  ["month", "2026-06-30", "cash_recurring", "", "", "USD", 6000n],
  ["month", "2026-06-30", "cash_non_recurring", "", "", "USD", 3000n],
  ["month", "2026-06-30", "cash_usage", "", "", "USD", 1000n],
  ["month", "2026-06-30", "cash_recurring_net", "", "", "USD", 6000n],
  ["month", "2026-06-30", "cash_collected", "cash_bucket", "recurring", "USD", 6000n],
  ["month", "2026-06-30", "cash_collected", "cash_bucket", "one_time", "USD", 3000n],
  ["month", "2026-06-30", "cash_collected", "cash_bucket", "usage", "USD", 1000n],
  ["month", "2026-06-30", "cash_collected", "", "", "EUR", 8000n],
  ["month", "2026-06-30", "cash_recurring", "", "", "EUR", 8000n],
  ["month", "2026-06-30", "cash_non_recurring", "", "", "EUR", 0n],
  // ── July: the refund lands HERE, on the day it was made ──
  ["month", "2026-07-31", "payments_captured", "", "", "USD", 6000n],
  ["month", "2026-07-31", "refunds_issued", "", "", "USD", 4000n],
  ["month", "2026-07-31", "payments_net", "", "", "USD", 2000n],
  ["month", "2026-07-31", "payment_failures", "", "", "USD", 0n],
  ["month", "2026-07-31", "cash_collected", "", "", "USD", 4000n],
  ["month", "2026-07-31", "cash_recurring", "", "", "USD", 4000n],
  // 4000 collected on the plan line, less the 3000 of the 5000 refund that was recurring.
  ["month", "2026-07-31", "cash_recurring_net", "", "", "USD", 1000n],
  ["month", "2026-07-31", "cash_non_recurring", "", "", "USD", 0n],
  ["day", "2026-07-05", "refunds_issued", "", "", "USD", 4000n],
  ["day", "2026-07-05", "cash_recurring_net", "", "", "USD", -3000n],
  // ── The vault, at the instant the run happens ──
  ["month", "2026-09-30", "cards_expired", "", "", "XXX", 3n],
  ["month", "2026-09-30", "cards_expiring", "", "", "XXX", 2n],
  ["day", "2026-09-15", "cards_expired", "", "", "XXX", 3n],
];
{
  const wrong: string[] = [];
  for (const [grain, periodEnd, measure, dim, dimValue, currency, want] of EXPECTED) {
    const got = M(grain, periodEnd).get(key(measure, dim, dimValue, currency));
    if (got !== want) {
      wrong.push(
        `${grain} ${periodEnd} ${measure}/${dim}:${dimValue} ${currency}: want ${want}, stored ${got}`,
      );
    }
  }
  ok(
    `oracle: all ${EXPECTED.length} hand-worked figures are stored, to the minor unit`,
    wrong.length === 0,
  );
  if (wrong.length) console.log("  ↳ mismatches:", wrong.slice(0, 15));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE REPORTS — the figures already published must not have changed meaning.
// ─────────────────────────────────────────────────────────────────────────────
const report = (reportKey: string, currency: string) =>
  resolveReport(orgId, bizId, reportKey, { currency, now: NOW, range: "12m" });

{
  // June and July are both wholly inside the 12-month window, so each bucket is the calendar
  // month and is directly comparable with the stored month. A clipped edge bucket would not be.
  const SERIES: Array<[string, string]> = [
    ["total_payments", "payments_captured"],
    ["total_refunds", "refunds_issued"],
    ["net_payments", "payments_net"],
    ["total_payment_transactions", "payment_attempts"],
    ["total_refund_transactions", "refund_attempts"],
    ["total_failed_payment_transactions", "payment_failures"],
    ["total_failed_refund_transactions", "refund_failures"],
    ["recurring_payments", "cash_recurring"],
    ["net_recurring_payments", "cash_recurring_net"],
    ["non_recurring_payments", "cash_non_recurring"],
    ["usage_payments", "cash_usage"],
  ];
  const wrong: string[] = [];
  for (const [reportKey, measure] of SERIES) {
    const r = await report(reportKey, "USD");
    for (const [periodEnd, bucketStart] of [
      ["2026-06-30", "2026-06-01"],
      ["2026-07-31", "2026-07-01"],
    ] as const) {
      const point = r.points.find((p) => p.t === bucketStart);
      if (!point) {
        wrong.push(`${reportKey}: no ${bucketStart} bucket in the report's own series`);
        continue;
      }
      const stored = M("month", periodEnd).get(key(measure, "", "", "USD")) ?? 0n;
      if (BigInt(Math.round(point.v)) !== stored) {
        wrong.push(`${reportKey} ${bucketStart}: report ${point.v}, measure ${measure}=${stored}`);
      }
    }
  }
  ok(
    `oracle: all ${SERIES.length} dated figures equal the report that publishes them, in both months`,
    wrong.length === 0,
  );
  if (wrong.length) console.log("  ↳ report disagreements:", wrong.slice(0, 15));
}

{
  // The bucket reports answer over the WHOLE window rather than per month, so the stored
  // side is June plus July — the only two months the fixture puts anything in.
  const june = M("month", "2026-06-30");
  const july = M("month", "2026-07-31");
  const across = (measure: string, dim: string, dimValue: string) =>
    (june.get(key(measure, dim, dimValue, "USD")) ?? 0n) +
    (july.get(key(measure, dim, dimValue, "USD")) ?? 0n);

  const BUCKETED: Array<[string, string, string, Record<string, string>]> = [
    // report key, measure, dimension, report label → stored key
    [
      "payment_transaction_summary",
      "payment_attempts",
      "transaction_status",
      { succeeded: "succeeded", failed: "failed", timeout: "timeout" },
    ],
    [
      "refund_transactions_summary",
      "refund_attempts",
      "transaction_status",
      { succeeded: "succeeded", failed: "failed" },
    ],
    [
      "payment_error_summary",
      "payment_failures",
      "failure_reason",
      { card_declined: "card_declined", Unspecified: "unspecified" },
    ],
    [
      "refund_error_summary",
      "refund_failures",
      "failure_reason",
      { refund_failed: "refund_failed" },
    ],
  ];
  const wrong: string[] = [];
  for (const [reportKey, measure, dim, labels] of BUCKETED) {
    const r = await report(reportKey, "USD");
    const rows = r.rows ?? [];
    if (rows.length !== Object.keys(labels).length) {
      wrong.push(`${reportKey}: ${rows.length} rows, expected ${Object.keys(labels).length}`);
    }
    for (const row of rows) {
      const storedKey = labels[row.group];
      if (!storedKey) {
        wrong.push(`${reportKey}: row '${row.group}' has no stored slice`);
        continue;
      }
      const stored = across(measure, dim, storedKey);
      if (stored !== BigInt(Math.round(row.value))) {
        wrong.push(`${reportKey}/${row.group}: report ${row.value}, measure ${stored}`);
      }
    }
  }
  ok(
    "oracle: every status and every failure reason matches the report, bucket for bucket",
    wrong.length === 0,
  );
  if (wrong.length) console.log("  ↳ bucket disagreements:", wrong.slice(0, 15));

  // The cash composition, likewise across the window. Its rows are labelled in the
  // operator's language and stored under the allocator's keys; the mapping is the contract.
  const composition = await report("cash_composition", "USD");
  const CASH_LABELS: Record<string, string> = {
    "Subscription fees": "recurring",
    "Prorated changes": "proration",
    "Metered usage": "usage",
    "One-off charges": "one_time",
    Discounts: "discount",
    Tax: "tax",
    Rounding: "rounding",
    Other: "other",
    "Not attributable to a line": "unattributed",
  };
  const compWrong = (composition.rows ?? []).filter((row) => {
    const bucket = CASH_LABELS[row.group];
    return (
      !bucket || across("cash_collected", "cash_bucket", bucket) !== BigInt(Math.round(row.value))
    );
  });
  ok("oracle: the cash composition is bucket for bucket the report's", compWrong.length === 0);
  if (compWrong.length) console.log("  ↳ composition rows that differ:", compWrong);
  ok(
    "oracle: the composition's total is the cash collected, and its recurring row is the recurring measure",
    BigInt(Math.round(composition.headline ?? 0)) === across("cash_collected", "", "") &&
      across("cash_collected", "cash_bucket", "recurring") === across("cash_recurring", "", ""),
  );

  // The cards. Both reports answer a headline about NOW and draw no series at all.
  const expired = await report("total_cards_expired", "USD");
  const expiring = await report("total_cards_due_to_expire", "USD");
  const sept = M("month", "2026-09-30");
  ok(
    "oracle: both card counts equal the reports that publish them, at the same instant",
    BigInt(Math.round(expired.headline ?? -1)) === sept.get(key("cards_expired", "", "", "XXX")) &&
      BigInt(Math.round(expiring.headline ?? -1)) ===
        sept.get(key("cards_expiring", "", "", "XXX")),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE WINDOW IS THE MEASURE.
// ─────────────────────────────────────────────────────────────────────────────
{
  const june = M("month", "2026-06-30");
  const july = M("month", "2026-07-31");
  ok(
    "window: a gateway refund is dated by the day the refund happened, not the day of the sale",
    june.get(key("refunds_issued", "", "", "USD")) === 3000n &&
      july.get(key("refunds_issued", "", "", "USD")) === 4000n,
  );
  ok(
    "window: an applied refund reduces the period the REFUND was made in — June's cash is untouched",
    june.get(key("cash_recurring_net", "", "", "USD")) === 6000n &&
      july.get(key("cash_recurring_net", "", "", "USD")) === 1000n,
  );
  ok(
    "window: a failed attempt counts in the month it was attempted, and nowhere else",
    june.get(key("payment_failures", "", "", "USD")) === 3n &&
      july.get(key("payment_failures", "", "", "USD")) === 0n,
  );
  ok(
    "window: gross cash never nets a refund into itself",
    july.get(key("cash_recurring", "", "", "USD")) === 4000n,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE TWO FAMILIES STAY APART. This is the point of the group, not a tolerance.
// ─────────────────────────────────────────────────────────────────────────────
{
  const june = M("month", "2026-06-30");
  const captured = june.get(key("payments_captured", "", "", "USD"));
  const collected = june.get(key("cash_collected", "", "", "USD"));
  ok(
    "apart: both figures are stored — the gateway's 12,000 and the applied 10,000",
    captured === 12_000n && collected === 10_000n,
  );
  ok(
    "apart: neither answers for the other, and the gap is preserved rather than reconciled",
    captured !== collected && captured! - collected! === 2000n,
  );
  // A composition that summed to the GATEWAY total would mean one of them had been made to
  // answer the other's question. The identity is inside the cash family only.
  const buckets = [...june]
    .filter(([k]) => k.startsWith("cash_collected|cash_bucket|") && k.endsWith("|USD"))
    .reduce((n, [, v]) => n + (v ?? 0n), 0n);
  ok(
    "apart: the cash buckets sum to the CASH total, never to the gateway's",
    buckets === collected && buckets !== captured,
  );
  ok(
    "apart: no measure mixes the two — net payments nets inside the gateway log alone",
    june.get(key("payments_net", "", "", "USD")) ===
      captured! - june.get(key("refunds_issued", "", "", "USD"))!,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE CARD COUNTS HAVE NO HISTORY — and say so by being absent.
// ─────────────────────────────────────────────────────────────────────────────
{
  const past = ["2026-06-30", "2026-07-31"] as const;
  const leaked = past.filter(
    (p) =>
      M("month", p).get(key("cards_expired", "", "", "XXX")) !== undefined ||
      M("month", p).get(key("cards_expiring", "", "", "XXX")) !== undefined,
  );
  ok(
    "as-of-now: a past period carries NO card row — unknown, never a fabricated zero",
    leaked.length === 0,
  );
  if (leaked.length) console.log("  ↳ periods that invented a history:", leaked);

  const series = await readMetricSeries({
    organizationId: orgId,
    businessIds: [bizId],
    measure: "cards_expiring",
    grain: "day",
    periods: [
      { start: "2026-06-10", end: "2026-06-10", label: "Jun 10" },
      { start: "2026-09-15", end: "2026-09-15", label: "Sep 15" },
    ],
  });
  ok(
    "as-of-now: the reader reports the unanswerable day as MISSING, not as zero",
    series.missing.includes("2026-06-10") && !series.missing.includes("2026-09-15"),
  );
  ok(
    "as-of-now: a card expired by the engine's verdict AND expiring by its printed date is in both counts",
    M("month", "2026-09-30").get(key("cards_expired", "", "", "XXX")) === 3n &&
      M("month", "2026-09-30").get(key("cards_expiring", "", "", "XXX")) === 2n,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. A FLOW TILES — June equals the sum of its thirty days.
// ─────────────────────────────────────────────────────────────────────────────
{
  const days: string[] = [];
  for (let d = 1; d <= 30; d++) days.push(`2026-06-${String(d).padStart(2, "0")}`);
  const perDay = new Map<string, Map<Key, bigint | null>>();
  for (const d of days) perDay.set(d, await materialise("day", d));

  const TILED = [
    "payments_captured",
    "refunds_issued",
    "payments_net",
    "payment_attempts",
    "refund_attempts",
    "payment_failures",
    "refund_failures",
    "cash_collected",
    "cash_recurring",
    "cash_non_recurring",
    "cash_usage",
    "cash_recurring_net",
  ];
  const wrong: string[] = [];
  for (const measure of TILED) {
    for (const currency of ["USD", "EUR"]) {
      let summed = 0n;
      for (const d of days) summed += perDay.get(d)!.get(key(measure, "", "", currency)) ?? 0n;
      const month = M("month", "2026-06-30").get(key(measure, "", "", currency)) ?? 0n;
      if (summed !== month) wrong.push(`${measure} ${currency}: days ${summed}, month ${month}`);
    }
  }
  ok("flow: every dated figure tiles — the month is the sum of its days", wrong.length === 0);
  if (wrong.length) console.log("  ↳ windows that do not tile:", wrong);

  ok(
    "flow: a day with the currency held but nothing in it is a measured ZERO, not a missing row",
    perDay.get("2026-06-11")!.get(key("payments_captured", "", "", "USD")) === 0n,
  );
  ok(
    "flow: a period before any money moved writes nothing at all",
    M("month", "2026-04-30").size === 0,
  );
  ok(
    "flow: a currency the business had not transacted in yet gets no row",
    perDay.get("2026-06-10")!.get(key("payments_captured", "", "", "EUR")) === undefined &&
      perDay.get("2026-06-15")!.get(key("payments_captured", "", "", "EUR")) === 8000n,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. DECLARED == EMITTED, for every dimension including the ones that are columns.
// ─────────────────────────────────────────────────────────────────────────────
{
  const emitted = new Map<string, Set<string>>();
  const currencies = new Map<string, Set<string>>();
  for (const got of materialised.values()) {
    for (const k of got.keys()) {
      const [measure, dim, , currency] = k.split("|") as [string, string, string, string];
      if (dim !== "")
        (emitted.get(measure) ?? emitted.set(measure, new Set()).get(measure)!).add(dim);
      (currencies.get(measure) ?? currencies.set(measure, new Set()).get(measure)!).add(currency);
    }
  }
  const wrong: string[] = [];
  for (const m of MEASURES) {
    if (!MINE.has(m.id)) continue;
    const declared = m.dimensions.filter((d) => d !== "currency" && d !== "business");
    const seen = emitted.get(m.id) ?? new Set<string>();
    for (const d of declared)
      if (!seen.has(d)) wrong.push(`${m.id}: declares ${d}, never emits it`);
    for (const d of seen) {
      if (!(declared as readonly string[]).includes(d))
        wrong.push(`${m.id}: emits ${d}, undeclared`);
    }
    // `currency` is a column rather than a slice, so it is emitted by being on the row — and
    // it is only a real dimension if more than one currency actually reaches it.
    if (m.dimensions.includes("currency") && (currencies.get(m.id)?.size ?? 0) < 2) {
      wrong.push(`${m.id}: declares currency, but only one ever reached the table`);
    }
    // …and a measure that declares none must never have written anything but `XXX`.
    if (
      !m.dimensions.includes("currency") &&
      [...(currencies.get(m.id) ?? [])].some((c) => c !== "XXX")
    ) {
      wrong.push(`${m.id}: declares no currency, yet wrote one`);
    }
  }
  ok("dimensions: every declared dimension is emitted, and nothing else is", wrong.length === 0);
  if (wrong.length) console.log("  ↳ registry/writer disagreements:", wrong);

  // …and the reader can actually cut by each of them. A declared dimension that answers
  // empty is the same defect one layer up.
  const READABLE: Array<[string, string, string[]]> = [
    ["payment_attempts", "transaction_status", ["succeeded", "failed", "timeout"]],
    ["payment_failures", "failure_reason", ["card_declined", "unspecified"]],
    ["cash_collected", "cash_bucket", ["recurring", "one_time", "usage"]],
  ];
  const unreadable: string[] = [];
  for (const [measure, split, want] of READABLE) {
    const read = await readMetricSeries({
      organizationId: orgId,
      businessIds: [bizId],
      measure,
      grain: "month",
      periods: [{ start: "2026-06-01", end: "2026-06-30", label: "Jun" }],
      split,
    });
    const keys = new Set((read.slices ?? []).map((s) => s.dimValue));
    for (const w of want) if (!keys.has(w)) unreadable.push(`${measure}/${split}: no '${w}' slice`);
  }
  ok("dimensions: every slice is readable as a split, not just writable", unreadable.length === 0);
  if (unreadable.length) console.log("  ↳ splits that answered empty:", unreadable);

  /**
   * A FAILURE REASON IS ONLY EVER A REASON SOMETHING ACTUALLY CARRIED.
   *
   * `failure_reason` is an open set — the decline vocabulary grows with the rails — so the
   * check that matters is not "is this value in a list" but "did an attempt produce it".
   * Every emitted key is compared against the gateway log itself, so a writer that invented
   * a tidy bucket nothing can reach fails here.
   */
  const reasons = await withTenant(orgId, (tx) =>
    tx
      .select({ code: transactions.errorCode })
      .from(transactions)
      .where(and(eq(transactions.businessId, bizId), sql`${transactions.status} <> 'succeeded'`)),
  );
  const reachable = new Set(reasons.map((r) => r.code ?? "unspecified"));
  const invented = new Set<string>();
  for (const got of materialised.values()) {
    for (const k of got.keys()) {
      const [, dim, dimValue] = k.split("|") as [string, string, string];
      if (dim === "failure_reason" && !reachable.has(dimValue)) invented.add(dimValue);
    }
  }
  ok(
    "dimensions: every failure reason emitted is one the gateway log actually carries",
    invented.size === 0,
  );
  if (invented.size) console.log("  ↳ unreachable reasons:", [...invented]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. SLICES SUM TO THEIR TOTALS, AND CURRENCIES NEVER MIX.
// ─────────────────────────────────────────────────────────────────────────────
{
  const june = M("month", "2026-06-30");
  const sumSlice = (measure: string, dim: string, currency: string) =>
    [...june]
      .filter(([k]) => k.startsWith(`${measure}|${dim}|`) && k.endsWith(`|${currency}`))
      .reduce((n, [, v]) => n + (v ?? 0n), 0n);

  ok(
    "count: the outcome slices sum to the attempt count, on both transaction types",
    sumSlice("payment_attempts", "transaction_status", "USD") ===
      june.get(key("payment_attempts", "", "", "USD")) &&
      sumSlice("refund_attempts", "transaction_status", "USD") ===
        june.get(key("refund_attempts", "", "", "USD")),
  );
  ok(
    "count: the failure reasons sum to the failure count — an unnamed failure is bucketed, not dropped",
    sumSlice("payment_failures", "failure_reason", "USD") ===
      june.get(key("payment_failures", "", "", "USD")),
  );
  ok(
    "money: the EUR figures are the EUR arithmetic alone",
    june.get(key("payments_captured", "", "", "EUR")) === 8000n &&
      june.get(key("cash_recurring", "", "", "EUR")) === 8000n &&
      june.get(key("cash_non_recurring", "", "", "EUR")) === 0n,
  );
  ok(
    "money: a count is held per currency too, so a mixed book cannot be summed by accident",
    june.get(key("payment_attempts", "", "", "EUR")) === 1n &&
      june.get(key("payment_attempts", "", "", "USD")) === 4n,
  );
}

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log("");
console.log(
  failed === 0
    ? `✅ METRIC-PAYMENTS: PASS (${checks.length}/${checks.length})`
    : `❌ METRIC-PAYMENTS: FAIL (${failed}/${checks.length} failed)`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);

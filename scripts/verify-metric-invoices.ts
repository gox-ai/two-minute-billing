/**
 * The ORACLE GATE for the invoice and receivables measures (Phase 7, group 2).
 *
 * Fifteen figures about documents rather than about the subscription book, so they get
 * their own fixture: invoices in two currencies with tax, discount, an exemption, a void, a
 * write-off, a late payment and a recovery, written through `computeMetricPeriod` →
 * `writeMetricDay` and then compared against TWO independent oracles.
 *
 *   1. AN EXPECTED TABLE, written out by hand from the fixture. It agrees with neither the
 *      writer nor the reports; it is what a person gets with a pencil.
 *   2. THE REPORTS THEMSELVES. A materialised measure is only worth having if it still
 *      answers what the published report answers, so the report resolver is run over the
 *      same window and the same currency and the two figures must be equal to the minor
 *      unit. A measure that quietly redefined its figure fails here.
 *
 * The properties, in the order a wrong writer breaks them:
 *   1. stored == reconstructed, per measure per dimension per currency, both directions;
 *   2. stored == what the report already publishes, for all twelve dated figures and the
 *      three live ones;
 *   3. THE WINDOW IS THE MEASURE — a void lands in the month it was voided, a write-off in
 *      the month the invoice was ISSUED (nothing records when it was written off), and a
 *      recovery on the day the money landed. Each is checked on a period where the two
 *      dates differ, because that is the only place the difference is visible;
 *   4. the two live figures have NO history: the period containing the run carries them and
 *      a past period carries no row at all — unknown, never a fabricated zero;
 *   5. a flow tiles — a month equals the sum of its days;
 *   6. a stock is not summed, and a measured zero is a row while a period before the first
 *      document is no rows at all;
 *   7. every dimension the registry declares is actually emitted, and nothing is emitted
 *      that it does not declare — including `currency`, which is a column rather than a
 *      slice and is read by grouping;
 *   8. currencies never mix: the EUR figures are the EUR-only arithmetic.
 *
 *   pnpm verify:metric-invoices
 */
import { sql } from "drizzle-orm";
import { closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { assertRegistryImplemented, computeMetricPeriod } from "@/modules/metrics/daily/compute";
import { writeMetricDay } from "@/modules/metrics/daily/write";
import { readMetricSeries } from "@/modules/metrics/daily/query";
import { MEASURES, type Grain } from "@/modules/metrics/daily/measures";
import { resolveReport } from "@/modules/metrics/reports/resolve";
import { computeBusinessAnalytics } from "@/modules/metrics/analytics";
import {
  appliedTaxes,
  creditNotes,
  invoiceLineItems,
  invoices,
  metricDaily,
  payments,
  subscriptions,
} from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

/**
 * The instant every figure is taken at — FIXED, and passed to both the writer and the
 * reports. The two live measures are "now" by definition, so a gate that let them read the
 * wall clock would be comparing two different nows.
 */
const NOW = new Date("2026-09-15T12:00:00.000Z");
const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const org = await createOrganization({ name: "Invoice Measure Oracle Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Invoice Measure Oracle Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
const bizId = biz.id;
const customer = await createCustomer({
  organizationId: orgId,
  businessId: bizId,
  email: `invoice-oracle-${Date.now()}@example.test`,
});

/** Two subscriptions for the dunning count: A owes two chased invoices, B's was recovered. */
const [subA, subB] = await withTenant(orgId, (tx) =>
  tx
    .insert(subscriptions)
    .values(
      ["a", "b"].map((k) => ({
        organizationId: orgId,
        businessId: bizId,
        customerId: customer.id,
        publicId: `sub_oracle_${k}_${Date.now()}`,
        status: "active",
        currency: "USD",
      })),
    )
    .returning({ id: subscriptions.id }),
);

let seq = 0;
/** One invoice, dated exactly. The service path stamps wall clock; a window gate cannot. */
async function invoice(i: {
  currency: string;
  status: string;
  createdAt: string;
  totalMinor: number;
  subtotalMinor?: number;
  amountDueMinor?: number | null;
  dueDate?: string | null;
  paidAt?: string | null;
  voidedAt?: string | null;
  writtenOff?: boolean;
  dunningStatus?: string | null;
  /** When collections gave up (0282). Dates `amount_exhausted`, as `paidAt` dates recovery. */
  dunningExhaustedAt?: string | null;
  subscriptionId?: string;
  /** `[kind, amountMinor, discountMinor, taxMinor, taxabilityReason]` per line. */
  lines: Array<[string, number, number, number, string]>;
}): Promise<string> {
  const id = await withTenant(orgId, async (tx) => {
    const [row] = await tx
      .insert(invoices)
      .values({
        organizationId: orgId,
        businessId: bizId,
        customerId: customer.id,
        publicId: `inv_oracle_${++seq}_${Date.now()}`,
        status: i.status,
        currency: i.currency,
        subtotalMinor: BigInt(i.subtotalMinor ?? i.totalMinor),
        totalMinor: BigInt(i.totalMinor),
        amountDueMinor: i.amountDueMinor == null ? null : BigInt(i.amountDueMinor),
        dueDate: i.dueDate ? at(i.dueDate) : null,
        paidAt: i.paidAt ? at(i.paidAt) : null,
        voidedAt: i.voidedAt ? at(i.voidedAt) : null,
        writtenOff: i.writtenOff ?? false,
        dunningStatus: i.dunningStatus ?? null,
        dunningExhaustedAt: i.dunningExhaustedAt ? at(i.dunningExhaustedAt) : null,
        subscriptionId: i.subscriptionId ?? null,
        createdAt: at(i.createdAt),
      })
      .returning({ id: invoices.id });
    const invoiceId = row!.id;
    let n = 0;
    for (const [kind, amount, discount, tax, reason] of i.lines) {
      const [line] = await tx
        .insert(invoiceLineItems)
        .values({
          organizationId: orgId,
          businessId: bizId,
          invoiceId,
          publicId: `il_oracle_${seq}_${++n}_${Date.now()}`,
          description: `${kind} line`,
          quantity: 1,
          unitAmountMinor: BigInt(amount),
          amountMinor: BigInt(amount),
          discountMinor: BigInt(discount),
          kind,
          createdAt: at(i.createdAt),
        })
        .returning({ id: invoiceLineItems.id });
      if (tax > 0 || reason !== "standard_rated") {
        await tx.insert(appliedTaxes).values({
          organizationId: orgId,
          businessId: bizId,
          invoiceId,
          invoiceLineItemId: line!.id,
          name: "TAX",
          rateBps: 0,
          amountMinor: BigInt(tax),
          taxabilityReason: reason,
          createdAt: at(i.createdAt),
        });
      }
    }
    return invoiceId;
  });
  return id;
}

/** A payment against an invoice. The cash that `amount_due_minor` never sees. */
async function payment(i: {
  invoiceId: string;
  currency: string;
  amountMinor: number;
  status: string;
  createdAt: string;
}) {
  await withTenant(orgId, (tx) =>
    tx.insert(payments).values({
      organizationId: orgId,
      businessId: bizId,
      customerId: customer.id,
      invoiceId: i.invoiceId,
      publicId: `pay_oracle_${++seq}_${Date.now()}`,
      status: i.status,
      amountMinor: BigInt(i.amountMinor),
      currency: i.currency,
      providerKey: "offline",
      createdAt: at(i.createdAt),
    }),
  );
}

async function creditNote(i: {
  invoiceId: string;
  currency: string;
  totalMinor: number;
  createdAt: string;
}) {
  await withTenant(orgId, (tx) =>
    tx.insert(creditNotes).values({
      organizationId: orgId,
      businessId: bizId,
      customerId: customer.id,
      invoiceId: i.invoiceId,
      publicId: `cn_oracle_${++seq}_${Date.now()}`,
      creditMethod: "balance",
      kind: "adjustment",
      status: "adjusted",
      totalMinor: BigInt(i.totalMinor),
      currency: i.currency,
      createdAt: at(i.createdAt),
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The fixture. Every date below is chosen so that one measure's window differs
// from another's on the SAME invoice — that is where a materialisation goes wrong.
// ─────────────────────────────────────────────────────────────────────────────
// Paid on time in June. Carries the tax, the discount and the only one-off line.
const i1 = await invoice({
  currency: "USD",
  status: "paid",
  createdAt: "2026-06-05",
  totalMinor: 12_000,
  subtotalMinor: 10_000,
  dueDate: "2026-06-20",
  paidAt: "2026-06-10",
  lines: [
    ["one_time", 4000, 0, 2000, "standard_rated"],
    ["recurring", 6000, 500, 0, "standard_rated"],
  ],
});
// A 100%-off trial invoice: the coupon took it to zero, so nothing was given up on it and
// its 900 must not reach `discount_given`.
await invoice({
  currency: "USD",
  status: "paid",
  createdAt: "2026-06-06",
  totalMinor: 0,
  subtotalMinor: 0,
  paidAt: "2026-06-06",
  lines: [["recurring", 0, 900, 0, "standard_rated"]],
});
// Still owed, and in collections.
await invoice({
  currency: "USD",
  status: "payment_due",
  createdAt: "2026-06-15",
  totalMinor: 5000,
  amountDueMinor: 5000,
  dueDate: "2026-07-01",
  dunningStatus: "in_progress",
  subscriptionId: subA!.id,
  lines: [["recurring", 5000, 0, 0, "standard_rated"]],
});
// Written off — issued in June, and nothing anywhere records the day it was given up on.
await invoice({
  currency: "USD",
  status: "paid",
  createdAt: "2026-06-20",
  totalMinor: 3000,
  writtenOff: true,
  lines: [["recurring", 3000, 0, 0, "standard_rated"]],
});
// Issued in June, VOIDED in July. The whole point of a separate void window.
await invoice({
  currency: "USD",
  status: "voided",
  createdAt: "2026-06-25",
  totalMinor: 7000,
  voidedAt: "2026-07-03",
  lines: [["recurring", 7000, 0, 0, "standard_rated"]],
});
// Issued in MAY, paid 36 days late in June, after collections chased it.
await invoice({
  currency: "USD",
  status: "paid",
  createdAt: "2026-05-10",
  totalMinor: 9000,
  dueDate: "2026-05-20",
  paidAt: "2026-06-25",
  dunningStatus: "succeeded",
  subscriptionId: subB!.id,
  lines: [["recurring", 9000, 0, 0, "standard_rated"]],
});
/**
 * Issued in MAY, chased, and given up on in June — the counterpart to the recovery above.
 *
 * Dated by `dunning_exhausted_at` and NOT by the status, which is the whole point of the
 * column: this invoice was raised in May and lost in June, and it belongs to June.
 */
await invoice({
  currency: "USD",
  status: "not_paid",
  createdAt: "2026-05-12",
  totalMinor: 4000,
  amountDueMinor: 4000,
  dueDate: "2026-05-22",
  dunningStatus: "exhausted",
  dunningExhaustedAt: "2026-06-18",
  lines: [["recurring", 4000, 0, 0, "standard_rated"]],
});
/**
 * Exhausted BEFORE the column existed: the status, and no date.
 *
 * Absent from every period rather than counted into one — the honesty the migration buys.
 * Without this row the measure would look identical whether it windowed on the date or on
 * the status, and the difference is the entire reason 0282 exists.
 */
await invoice({
  currency: "USD",
  status: "not_paid",
  createdAt: "2026-06-02",
  totalMinor: 6600,
  amountDueMinor: 6600,
  dueDate: "2026-06-12",
  dunningStatus: "exhausted",
  lines: [["recurring", 6600, 0, 0, "standard_rated"]],
});
// PART exempt: one standard-rated line and one reverse-charged. The published exempt base
// is the WHOLE document's line value, not the exempt line — pinned deliberately.
await invoice({
  currency: "USD",
  status: "posted",
  createdAt: "2026-06-28",
  totalMinor: 5400,
  lines: [
    ["recurring", 4000, 0, 400, "standard_rated"],
    ["recurring", 1000, 0, 0, "reverse_charge"],
  ],
});
// September, unpaid, parked by collections — so the live figures have something to say.
await invoice({
  currency: "USD",
  status: "payment_due",
  createdAt: "2026-09-10",
  totalMinor: 2500,
  amountDueMinor: 2500,
  dueDate: "2026-09-14",
  dunningStatus: "parked",
  subscriptionId: subA!.id,
  lines: [["recurring", 2500, 0, 0, "standard_rated"]],
});
// The other currency, which must never be added to the first.
const i8 = await invoice({
  currency: "EUR",
  status: "posted",
  createdAt: "2026-06-12",
  totalMinor: 8000,
  dueDate: "2026-07-12",
  lines: [["recurring", 8000, 0, 0, "standard_rated"]],
});
/**
 * CASH AGAINST AN UNPAID DOCUMENT. `amount_due_minor` is the issue-time collectible and is
 * never decremented by a payment, so these two are the only place the difference between
 * "billed" and "still owed" is visible.
 */
// Settled in full and still sitting in `payment_due`: owes nothing, counts for nothing.
const i9 = await invoice({
  currency: "USD",
  status: "payment_due",
  createdAt: "2026-09-05",
  totalMinor: 4000,
  amountDueMinor: 4000,
  dueDate: "2026-09-12",
  lines: [["recurring", 4000, 0, 0, "standard_rated"]],
});
await payment({
  invoiceId: i9,
  currency: "USD",
  amountMinor: 4000,
  status: "succeeded",
  createdAt: "2026-09-06",
});
// Part paid, with a FAILED attempt beside it that must not be netted off anything.
const i10 = await invoice({
  currency: "USD",
  status: "payment_due",
  createdAt: "2026-09-08",
  totalMinor: 6000,
  amountDueMinor: 6000,
  dueDate: "2026-09-18",
  lines: [["recurring", 6000, 0, 0, "standard_rated"]],
});
await payment({
  invoiceId: i10,
  currency: "USD",
  amountMinor: 2500,
  status: "succeeded",
  createdAt: "2026-09-09",
});
await payment({
  invoiceId: i10,
  currency: "USD",
  amountMinor: 1000,
  status: "failed",
  createdAt: "2026-09-09",
});

await creditNote({ invoiceId: i1, currency: "USD", totalMinor: 1500, createdAt: "2026-06-18" });
await creditNote({ invoiceId: i8, currency: "EUR", totalMinor: 500, createdAt: "2026-07-05" });
// Raised in JULY against a JUNE invoice — the period it belongs to is the one it was raised in.
await creditNote({ invoiceId: i1, currency: "USD", totalMinor: 800, createdAt: "2026-07-20" });

// ─────────────────────────────────────────────────────────────────────────────
// Materialise.
// ─────────────────────────────────────────────────────────────────────────────
const INVOICE_IDS = new Set(MEASURES.filter((m) => m.source === "invoices").map((m) => m.id));
type Key = string;
const key = (measure: string, dim: string, dimValue: string, currency: string) =>
  `${measure}|${dim}|${dimValue}|${currency}`;

const SAMPLED: Array<[Grain, string]> = [
  ["month", "2026-04-30"],
  ["month", "2026-05-31"],
  ["month", "2026-06-30"],
  ["month", "2026-07-31"],
  ["month", "2026-09-30"],
  ["day", "2026-06-05"],
  ["day", "2026-06-18"],
  ["day", "2026-06-25"],
  ["day", "2026-07-03"],
  ["day", "2026-07-20"],
  ["day", "2026-09-15"],
];

async function materialise(grain: Grain, periodEnd: string): Promise<Map<Key, bigint | null>> {
  const rows = await withTenant(orgId, (tx) =>
    computeMetricPeriod(tx, bizId, grain, periodEnd, NOW),
  );
  await writeMetricDay({
    organizationId: orgId,
    businessId: bizId,
    grain,
    periodEnd,
    rows,
  });
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
    if (!INVOICE_IDS.has(r.measure)) continue;
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
// 0. The registry and its writer agree, measure for measure and dimension for dimension.
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
    "registry: the invoice group is twenty-three measures",
    // …plus `mrr_at_risk`, fixtured in verify:metric-new-measures.
    MEASURES.filter((m) => m.source === "invoices" && m.id !== "mrr_at_risk").length === 23,
  );
  /**
   * THE RATE IS STORED AS ITS HALVES, and the halves are the two measures beside it.
   *
   * Checked here rather than trusted: a rate assembled from a numerator that disagreed
   * with the stored `amount_recovered` would be a second answer to the same question, and
   * the whole reason it is computed in the invoice group is that both halves come off one
   * read. June recovered 9000 and gave up on 4000, so the rate is 9000/13000 — and the
   * 6600 exhausted with no date is in NEITHER half, exactly as it is in neither measure.
   */
  {
    const june = M("month", "2026-06-30");
    const rate = june.get(key("dunning_recovery_rate", "", "", "USD"));
    const numerator = june.get(key("amount_recovered", "", "", "USD"));
    const exhausted = june.get(key("amount_exhausted", "", "", "USD"));
    // `materialise` keeps only the value column; the other half needs its own read.
    const [half] = await withTenant(orgId, (tx) =>
      tx
        .select({ denominator: metricDaily.denominator })
        .from(metricDaily)
        .where(
          sql`${metricDaily.businessId} = ${bizId} and ${metricDaily.grain} = 'month'
              and ${metricDaily.periodEnd} = '2026-06-30'
              and ${metricDaily.measure} = 'dunning_recovery_rate'
              and ${metricDaily.currency} = 'USD'`,
        ),
    );
    const denominator = half?.denominator ?? null;
    ok(
      "ratio: the recovery rate's numerator IS the stored amount recovered",
      rate === numerator && rate === 9000n,
    );
    ok(
      "ratio: its denominator is what collections FINISHED with — recovered plus exhausted",
      denominator === 13_000n && numerator! + exhausted! === denominator,
    );
  }
  // Two of THIS GROUP say outright that they describe the live book and not a period. Scoped
  // to the group: other groups have as-of-now measures of their own and this is not a
  // statement about them.
  const live = MEASURES.filter(
    (m) => m.source === "invoices" && m.asOf === "computed_at" && m.id !== "mrr_at_risk",
  ).map((m) => m.id);
  ok(
    "registry: receivables, the open count and the dunning counts DECLARE that they are as-of-now",
    live.length === 4 &&
      live.includes("receivables_outstanding") &&
      live.includes("receivables_invoices") &&
      live.includes("dunning_invoices") &&
      live.includes("dunning_subscriptions"),
  );
  ok(
    "registry: neither as-of-now measure offers a comparison it cannot make",
    MEASURES.filter((m) => m.asOf === "computed_at").every((m) => !m.supportsCompare),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE EXPECTED TABLE — worked out from the fixture by hand, not from either side.
// ─────────────────────────────────────────────────────────────────────────────
const EXPECTED: Array<[Grain, string, string, string, string, string, bigint]> = [
  // grain, periodEnd, measure, dim, dimValue, currency, value
  // June USD: 12000 paid + 5000 owed + 3000 written off + 5400 part-exempt. The voided
  // 7000 is not billing — it was never a live document.
  ["month", "2026-06-30", "billing_gross", "", "", "USD", 32_000n],
  ["month", "2026-06-30", "billing_net", "", "", "USD", 30_500n],
  ["month", "2026-06-30", "credit_notes_issued", "", "", "USD", 1500n],
  ["month", "2026-06-30", "billing_non_recurring", "", "", "USD", 4000n],
  ["month", "2026-06-30", "tax_charged", "", "", "USD", 2400n],
  ["month", "2026-06-30", "taxable_base", "", "", "USD", 29_600n],
  ["month", "2026-06-30", "exempt_base", "", "", "USD", 5000n],
  ["month", "2026-06-30", "discount_given", "", "", "USD", 500n],
  ["month", "2026-06-30", "invoice_voided", "", "", "USD", 0n],
  ["month", "2026-06-30", "invoice_written_off", "", "", "USD", 3000n],
  ["month", "2026-06-30", "amount_recovered", "", "", "USD", 9000n],
  // Collections finished with two invoices in June: it saved the 9000 and lost the 4000.
  // The 6600 exhausted without a date is in NEITHER — see the fixture note.
  ["month", "2026-06-30", "amount_exhausted", "", "", "USD", 4000n],
  ["month", "2026-06-30", "dunning_recovered_invoices", "", "", "USD", 1n],
  ["month", "2026-06-30", "dunning_exhausted_invoices", "", "", "USD", 1n],
  ["month", "2026-06-30", "recovery_paid_late", "", "", "USD", 21_000n],
  ["month", "2026-06-30", "recovery_paid_late", "lateness_band", "on_time", "USD", 12_000n],
  ["month", "2026-06-30", "recovery_paid_late", "lateness_band", "31_60", "USD", 9000n],
  // The other currency keeps its own arithmetic.
  ["month", "2026-06-30", "billing_gross", "", "", "EUR", 8000n],
  ["month", "2026-06-30", "billing_net", "", "", "EUR", 8000n],
  // A currency that raised no note in the window is a measured ZERO, exactly as its billing is.
  ["month", "2026-06-30", "credit_notes_issued", "", "", "EUR", 0n],
  ["month", "2026-07-31", "billing_net", "", "", "EUR", -500n],
  ["month", "2026-07-31", "credit_notes_issued", "", "", "EUR", 500n],
  ["month", "2026-07-31", "credit_notes_issued", "", "", "USD", 800n],
  ["day", "2026-06-18", "credit_notes_issued", "", "", "USD", 1500n],
  ["day", "2026-06-05", "credit_notes_issued", "", "", "USD", 0n],
  // July: the void lands here, on the day it was voided, and nothing was billed.
  ["month", "2026-07-31", "invoice_voided", "", "", "USD", 7000n],
  ["month", "2026-07-31", "billing_gross", "", "", "USD", 0n],
  ["day", "2026-07-03", "invoice_voided", "", "", "USD", 7000n],
  // May: the recovered invoice was ISSUED here, and recovered two months later.
  ["month", "2026-05-31", "billing_gross", "", "", "USD", 13_000n],
  ["month", "2026-05-31", "amount_recovered", "", "", "USD", 0n],
  /**
   * BOTH collections invoices were ISSUED in May and neither is May's.
   *
   * The 9000 recovered in June and the 4000 was given up on in June, so May measures a
   * zero for each — the same statement `amount_recovered` already makes, now made by the
   * other half. A writer that windowed exhaustion on the invoice date instead of on
   * `dunning_exhausted_at` fails exactly here and nowhere else.
   */
  ["month", "2026-05-31", "amount_exhausted", "", "", "USD", 0n],
  ["month", "2026-05-31", "dunning_exhausted_invoices", "", "", "USD", 0n],
  ["month", "2026-05-31", "dunning_recovered_invoices", "", "", "USD", 0n],
  ["month", "2026-05-31", "credit_notes_issued", "", "", "USD", 0n],
  // The live book, at the instant the run happens. USD: 5000 + 5400 + 2500 still wholly
  // owed, plus 6000 billed less 2500 taken (the 1000 that FAILED is not cash), plus a 4000
  // invoice settled in full — which owes nothing although its status still says otherwise.
  ["month", "2026-09-30", "receivables_outstanding", "", "", "USD", 27_000n],
  ["month", "2026-09-30", "receivables_outstanding", "", "", "EUR", 8000n],
  // Four documents still carry a balance. The settled one is not among them.
  ["month", "2026-09-30", "receivables_invoices", "", "", "USD", 6n],
  ["month", "2026-09-30", "receivables_invoices", "", "", "EUR", 1n],
  ["month", "2026-09-30", "dunning_invoices", "", "", "USD", 5n],
  ["month", "2026-09-30", "dunning_invoices", "dunning_status", "parked", "USD", 1n],
  ["month", "2026-09-30", "dunning_invoices", "dunning_status", "in_progress", "USD", 1n],
  ["month", "2026-09-30", "dunning_invoices", "dunning_status", "succeeded", "USD", 1n],
  ["month", "2026-09-30", "dunning_invoices", "", "", "EUR", 0n],
  // Subscriptions, and only while an invoice is owed: A's two chased invoices count once, and
  // B's recovered one not at all — the history `dunning_invoices` keeps is not the headline.
  ["month", "2026-09-30", "dunning_subscriptions", "", "", "USD", 1n],
  ["month", "2026-09-30", "dunning_subscriptions", "dunning_status", "in_progress", "USD", 1n],
  ["month", "2026-09-30", "dunning_subscriptions", "dunning_status", "parked", "USD", 1n],
  ["month", "2026-09-30", "dunning_subscriptions", "", "", "EUR", 0n],
];
{
  const wrong: string[] = [];
  for (const [grain, periodEnd, measure, dim, dimValue, currency, want] of EXPECTED) {
    const got = M(grain, periodEnd).get(key(measure, dim, dimValue, currency));
    if (got !== want)
      wrong.push(
        `${grain} ${periodEnd} ${measure}/${dim}:${dimValue} ${currency}: want ${want}, stored ${got}`,
      );
  }
  ok(
    `oracle: all ${EXPECTED.length} hand-worked figures are stored, to the minor unit`,
    wrong.length === 0,
  );
  if (wrong.length) console.log("  ↳ mismatches:", wrong.slice(0, 12));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE REPORTS — the figures already published must not have changed meaning.
// ─────────────────────────────────────────────────────────────────────────────
/** One report, scoped to ONE currency so the comparison is native minor units, no FX. */
const report = (reportKey: string, currency: string, opts: Record<string, string> = {}) =>
  resolveReport(orgId, bizId, reportKey, { currency, now: NOW, range: "12m", ...opts });

{
  // June is wholly inside the 12-month window, so its bucket is the calendar month and is
  // directly comparable with the stored month. A clipped edge bucket would not be.
  const REPORTED: Array<[string, string]> = [
    ["total_billing", "billing_gross"],
    ["net_billing", "billing_net"],
    ["total_non_recurring_billing", "billing_non_recurring"],
    ["total_taxes", "tax_charged"],
    ["tax_summary", "taxable_base"],
    ["tax_exemption_summary", "exempt_base"],
    ["total_revenue_leakage", "discount_given"],
    ["total_amount_voided", "invoice_voided"],
    ["total_write_off_amount", "invoice_written_off"],
    ["total_amount_recovered", "amount_recovered"],
  ];
  const wrong: string[] = [];
  for (const [reportKey, measure] of REPORTED) {
    for (const [periodEnd, bucketStart] of [
      ["2026-06-30", "2026-06-01"],
      ["2026-07-31", "2026-07-01"],
    ] as const) {
      const r = await report(reportKey, "USD");
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
    "oracle: every dated figure equals the report that already publishes it, in both months",
    wrong.length === 0,
  );
  if (wrong.length) console.log("  ↳ report disagreements:", wrong.slice(0, 12));
}

{
  /**
   * The credit-note amount has no series report of its own; the account summary publishes it
   * as a monthly column, so that column is the oracle. USD-scoped, so the EUR note is not in it.
   */
  const summary = await report("account_summary", "USD");
  const column = (summary.table?.columns ?? []).findIndex((c) => c.key === "credit_notes");
  const monthly = (period: string) =>
    (summary.table?.rows ?? []).find((r) => r.period === period)?.values[column] ?? null;
  const wrong: string[] = [];
  for (const [period, periodEnd] of [
    ["Jun 2026", "2026-06-30"],
    ["Jul 2026", "2026-07-31"],
  ] as const) {
    const reported = monthly(period);
    const stored = M("month", periodEnd).get(key("credit_notes_issued", "", "", "USD")) ?? 0n;
    if (reported == null || BigInt(Math.round(reported)) !== stored)
      wrong.push(`${period}: summary ${reported}, measure ${stored}`);
  }
  ok(
    "oracle: the credit-note amount equals the column the account summary already publishes",
    column >= 0 && wrong.length === 0,
  );
  if (wrong.length) console.log("  ↳ summary disagreements:", wrong);
}

{
  // The two live ones. Their reports ignore the window and read the instant, so they are
  // compared against the period that CONTAINS that instant — which is the only period the
  // writer fills.
  const receivables = await report("total_receivables", "USD");
  const storedAr = M("month", "2026-09-30").get(key("receivables_outstanding", "", "", "USD"));
  const storedOpen = M("month", "2026-09-30").get(key("receivables_invoices", "", "", "USD"));

  /**
   * THE ORACLE FOR RECEIVABLES IS THE HOME PAYLOAD.
   *
   * `amount_due_minor` is the issue-time collectible and is never decremented by cash, so
   * anything summing it raw counts a settled invoice as still owing. The home payload
   * subtracts applied payments (F-18) and is the figure operators are shown, so the stored
   * measure must equal THAT. Both are independent of the writer.
   */
  const home = await computeBusinessAnalytics(orgId, bizId, { currency: "USD", now: NOW });
  ok(
    "oracle: receivables outstanding equals the netted figure the home payload publishes",
    storedAr != null && BigInt(home.kpis.unpaid_invoices.amount_minor) === storedAr,
  );
  ok(
    "oracle: the open-invoice count equals the home payload's, settled documents excluded",
    storedOpen != null && BigInt(home.kpis.unpaid_invoices.count) === storedOpen,
  );

  /**
   * The ageing report nets the same cash, so it is now a PLAIN EQUALITY — three readers of
   * outstanding, one number. The cash is still summed off the payments table here rather than
   * off either implementation's SQL, so the check has a source of its own: it must be a real
   * part-paid book, or the equality would hold for the trivial reason that nothing was paid.
   */
  const [cash] = await withTenant(orgId, (tx) =>
    tx
      .select({ total: sql<string>`coalesce(sum(p.amount_minor), 0)` })
      .from(sql`payments p`)
      .innerJoin(sql`invoices i`, sql`i.id = p.invoice_id`)
      .where(
        sql`p.status = 'succeeded' and p.currency = 'USD' and i.business_id = ${bizId}
            and i.status in ('posted','payment_due','not_paid') and not i.written_off`,
      ),
  );
  ok(
    "oracle: the ageing report nets applied cash too, and equals the stored measure",
    storedAr != null &&
      BigInt(cash?.total ?? 0) > 0n &&
      BigInt(Math.round(receivables.headline ?? 0)) === storedAr,
  );

  const dunning = await report("dunning_status_summary", "USD");
  const storedDunning = M("month", "2026-09-30").get(key("dunning_invoices", "", "", "USD"));
  ok(
    "oracle: the dunning count equals the collections report's total",
    storedDunning != null && BigInt(Math.round(dunning.headline ?? 0)) === storedDunning,
  );
  const byStatus = new Map((dunning.rows ?? []).map((r) => [r.group, Math.round(r.value)]));
  const storedByStatus = [...M("month", "2026-09-30")].filter(([k]) =>
    k.startsWith("dunning_invoices|dunning_status|"),
  );
  ok(
    "oracle: each collections state holds the same invoices in both places",
    storedByStatus.length === byStatus.size &&
      storedByStatus.every(([k, v]) => BigInt(byStatus.get(k.split("|")[2]!) ?? -1) === v),
  );

  // Every paid invoice in the fixture landed in June, so the recovery ladder over the whole
  // window is exactly June's stored bands.
  const recovery = await report("receivables_recovery_summary", "USD");
  const LABEL_TO_BAND: Record<string, string> = {
    "Paid on time": "on_time",
    "1–30 days late": "1_30",
    "31–60 days late": "31_60",
    "60+ days late": "60_plus",
  };
  const june = M("month", "2026-06-30");
  const wrong = (recovery.rows ?? []).filter((r) => {
    const band = LABEL_TO_BAND[r.group];
    const stored = band
      ? (june.get(key("recovery_paid_late", "lateness_band", band, "USD")) ?? 0n)
      : null;
    return stored == null || stored !== BigInt(Math.round(r.value));
  });
  ok("oracle: the lateness ladder is rung for rung the report's", wrong.length === 0);
  if (wrong.length) console.log("  ↳ rungs that differ:", wrong);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE WINDOW IS THE MEASURE.
// ─────────────────────────────────────────────────────────────────────────────
{
  const june = M("month", "2026-06-30");
  const july = M("month", "2026-07-31");
  ok(
    "window: a void is dated by the day it was VOIDED, not the month the invoice was issued",
    june.get(key("invoice_voided", "", "", "USD")) === 0n &&
      july.get(key("invoice_voided", "", "", "USD")) === 7000n,
  );
  ok(
    "window: a write-off is dated by the invoice's ISSUE date — nothing records when it was given up on",
    june.get(key("invoice_written_off", "", "", "USD")) === 3000n &&
      july.get(key("invoice_written_off", "", "", "USD")) === 0n,
  );
  ok(
    "window: a recovery is dated by the day the money LANDED, not when the invoice was raised",
    M("month", "2026-05-31").get(key("amount_recovered", "", "", "USD")) === 0n &&
      june.get(key("amount_recovered", "", "", "USD")) === 9000n,
  );
  ok(
    "window: a credit note reduces the period IT was raised in",
    july.get(key("billing_net", "", "", "EUR")) === -500n,
  );
  ok(
    "window: a credit note is the measure at its OWN issue date, to the day",
    M("day", "2026-06-18").get(key("credit_notes_issued", "", "", "USD")) === 1500n &&
      M("day", "2026-06-05").get(key("credit_notes_issued", "", "", "USD")) === 0n &&
      june.get(key("credit_notes_issued", "", "", "USD")) === 1500n,
  );
  ok(
    "window: a note against an EARLIER period's invoice lands in the period it was RAISED in",
    // Raised in July, against invoices issued in June — in both currencies. June, the period
    // being credited, is untouched by either.
    july.get(key("credit_notes_issued", "", "", "USD")) === 800n &&
      july.get(key("credit_notes_issued", "", "", "EUR")) === 500n &&
      june.get(key("credit_notes_issued", "", "", "EUR")) === 0n &&
      M("day", "2026-07-20").get(key("credit_notes_issued", "", "", "USD")) === 800n,
  );
  ok(
    "window: a currency with no note in the period carries a measured ZERO, not a missing row",
    june.get(key("credit_notes_issued", "", "", "EUR")) === 0n &&
      M("month", "2026-05-31").get(key("credit_notes_issued", "", "", "USD")) === 0n,
  );
  /**
   * The identity the two measures owe each other. It is arithmetic the writer performs, so it
   * is checked on a window where BOTH sides are non-trivial — a period with billing and a note
   * in it, a period with a note and no billing, and a currency with billing and no note.
   */
  {
    const bad: string[] = [];
    for (const [grain, periodEnd] of [
      ["month", "2026-05-31"],
      ["month", "2026-06-30"],
      ["month", "2026-07-31"],
      ["month", "2026-09-30"],
      ["day", "2026-06-18"],
      ["day", "2026-07-20"],
    ] as const) {
      for (const currency of ["USD", "EUR"]) {
        const gross = M(grain, periodEnd).get(key("billing_gross", "", "", currency));
        const credited = M(grain, periodEnd).get(key("credit_notes_issued", "", "", currency));
        const net = M(grain, periodEnd).get(key("billing_net", "", "", currency));
        if (gross == null && credited == null && net == null) continue;
        if (gross == null || credited == null || net == null)
          bad.push(`${grain} ${periodEnd} ${currency}: one of the three is missing`);
        else if (gross - credited !== net)
          bad.push(`${grain} ${periodEnd} ${currency}: ${gross} - ${credited} != ${net}`);
      }
    }
    ok(
      "window: total billing less the notes raised IS net billing, currency for currency",
      bad.length === 0,
    );
    if (bad.length) console.log("  ↳ the identity does not hold:", bad);
  }
  ok(
    "window: a voided document is not billing, in any month",
    june.get(key("billing_gross", "", "", "USD")) === 32_000n &&
      july.get(key("billing_gross", "", "", "USD")) === 0n,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE LIVE FIGURES HAVE NO HISTORY — and say so by being absent.
// ─────────────────────────────────────────────────────────────────────────────
{
  const past = ["2026-05-31", "2026-06-30", "2026-07-31"] as const;
  const leaked = past.filter(
    (p) =>
      M("month", p).get(key("receivables_outstanding", "", "", "USD")) !== undefined ||
      M("month", p).get(key("dunning_invoices", "", "", "USD")) !== undefined,
  );
  ok(
    "as-of-now: a past period carries NO receivables row — unknown, never a fabricated zero",
    leaked.length === 0,
  );
  if (leaked.length) console.log("  ↳ periods that invented a history:", leaked);
  ok(
    "as-of-now: the period containing the run DOES carry them, at both grains",
    M("month", "2026-09-30").get(key("receivables_outstanding", "", "", "USD")) === 27_000n &&
      M("day", "2026-09-15").get(key("receivables_outstanding", "", "", "USD")) === 27_000n,
  );
  // A reader must be told the periods it could not answer rather than plotting them at zero.
  const series = await readMetricSeries({
    organizationId: orgId,
    businessIds: [bizId],
    measure: "receivables_outstanding",
    grain: "day",
    periods: [
      { start: "2026-06-05", end: "2026-06-05", label: "Jun 5" },
      { start: "2026-09-15", end: "2026-09-15", label: "Sep 15" },
    ],
  });
  ok(
    "as-of-now: the reader reports the unanswerable day as MISSING, not as zero",
    series.missing.includes("2026-06-05") && !series.missing.includes("2026-09-15"),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. A FLOW TILES — June equals the sum of its thirty days.
// ─────────────────────────────────────────────────────────────────────────────
{
  const days: string[] = [];
  for (let d = 1; d <= 30; d++) days.push(`2026-06-${String(d).padStart(2, "0")}`);
  const perDay = new Map<string, Map<Key, bigint | null>>();
  for (const d of days) perDay.set(d, await materialise("day", d));

  const TILED = [
    "billing_gross",
    "billing_net",
    "credit_notes_issued",
    "tax_charged",
    "discount_given",
    "invoice_written_off",
    "amount_recovered",
    "recovery_paid_late",
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
    "flow: a day with nothing in it is a measured ZERO, not a missing row",
    perDay.get("2026-06-01")!.get(key("billing_gross", "", "", "USD")) === 0n,
  );
  ok(
    "flow: a period before the first document writes nothing at all",
    M("month", "2026-04-30").size === 0,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. DECLARED == EMITTED, for every dimension including the ones that are columns.
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
    if (m.source !== "invoices") continue;
    const declared = m.dimensions.filter((d) => d !== "currency" && d !== "business");
    const seen = emitted.get(m.id) ?? new Set<string>();
    // Fixtured in verify:metric-usage: this book has no usage lines, so no meter.
    const elsewhere: Record<string, readonly string[]> = { revenue_billed: ["meter"] };
    for (const d of declared)
      if (!seen.has(d) && !elsewhere[m.id]?.includes(d))
        wrong.push(`${m.id}: declares ${d}, never emits it`);
    for (const d of seen) {
      if (!(declared as readonly string[]).includes(d))
        wrong.push(`${m.id}: emits ${d}, undeclared`);
    }
    // `currency` is a column rather than a slice, so it is emitted by being on the row —
    // and it is only a real dimension if more than one currency actually reaches it.
    if (m.dimensions.includes("currency") && (currencies.get(m.id)?.size ?? 0) < 2) {
      wrong.push(`${m.id}: declares currency, but only one ever reached the table`);
    }
  }
  ok("dimensions: every declared dimension is emitted, and nothing else is", wrong.length === 0);
  if (wrong.length) console.log("  ↳ registry/writer disagreements:", wrong);

  // …and the reader can actually cut by it. A declared dimension that answers empty is the
  // same defect one layer up.
  const split = await readMetricSeries({
    organizationId: orgId,
    businessIds: [bizId],
    measure: "billing_gross",
    grain: "month",
    periods: [{ start: "2026-06-01", end: "2026-06-30", label: "Jun" }],
    split: "currency",
  });
  const keys = new Set((split.slices ?? []).map((s) => s.dimValue));
  ok(
    "dimensions: a split by currency returns both currencies, not an empty answer",
    keys.has("USD") && keys.has("EUR"),
  );

  const bands = await readMetricSeries({
    organizationId: orgId,
    businessIds: [bizId],
    measure: "recovery_paid_late",
    grain: "month",
    periods: [{ start: "2026-06-01", end: "2026-06-30", label: "Jun" }],
    split: "lateness_band",
  });
  const bandKeys = new Set((bands.slices ?? []).map((s) => s.dimValue));
  ok(
    "dimensions: the lateness ladder is readable as a split",
    bandKeys.has("on_time") && bandKeys.has("31_60"),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. CURRENCIES NEVER MIX, and the slices add up.
// ─────────────────────────────────────────────────────────────────────────────
{
  const june = M("month", "2026-06-30");
  ok(
    "money: the EUR figure is the EUR arithmetic alone",
    june.get(key("billing_gross", "", "", "EUR")) === 8000n &&
      june.get(key("tax_charged", "", "", "EUR")) === 0n,
  );
  const july = M("month", "2026-07-31");
  ok(
    "money: the notes of one currency are never added to another's",
    july.get(key("credit_notes_issued", "", "", "USD")) === 800n &&
      july.get(key("credit_notes_issued", "", "", "EUR")) === 500n &&
      june.get(key("credit_notes_issued", "", "", "USD")) === 1500n &&
      june.get(key("credit_notes_issued", "", "", "EUR")) === 0n,
  );
  const bands = [...june].filter(([k]) => k.startsWith("recovery_paid_late|lateness_band|"));
  const usd = bands.filter(([k]) => k.endsWith("|USD")).reduce((n, [, v]) => n + (v ?? 0n), 0n);
  ok(
    "money: the lateness bands sum to the unsliced figure",
    usd === june.get(key("recovery_paid_late", "", "", "USD")),
  );
  const sept = M("month", "2026-09-30");
  const states = [...sept]
    .filter(([k]) => k.startsWith("dunning_invoices|dunning_status|") && k.endsWith("|USD"))
    .reduce((n, [, v]) => n + (v ?? 0n), 0n);
  ok(
    "count: the collections states sum to the unsliced count",
    states === sept.get(key("dunning_invoices", "", "", "USD")),
  );
  // A stock is the period's LAST value, never the sum of its days — the ~30x mistake.
  ok(
    "stock: receivables is one figure for the period, not thirty added together",
    sept.get(key("receivables_outstanding", "", "", "USD")) ===
      M("day", "2026-09-15").get(key("receivables_outstanding", "", "", "USD")),
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
    ? `✅ METRIC-INVOICES: PASS (${checks.length}/${checks.length})`
    : `❌ METRIC-INVOICES: FAIL (${failed}/${checks.length} failed)`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);

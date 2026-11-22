/**
 * Oracle gate: revenue net of promotional credit (`revenue_billed`, `revenue_billed_gross`,
 * `revenue_deductions`), and the figures that follow it. One USD customer, one case per day
 * in June 2026, minor units, hand-worked:
 *
 *  A  06-01  one-time 1000, promotional credit 300, tax 18% on 700 = 126. Stored total 1126,
 *            printed 826, paid 826. → gross 1000, promotional 300, net 700. Collected 700, tax
 *            126 (by the gross weights it was 734 / 92). billing_gross 826, taxable_base 700.
 *  B1 06-02  pack 5000 (taxed at purchase), tax 900, paid 5900 → credit_pack 5000.
 *     06-03  usage 1200 paid by the pack: draw face 1200, cost 1200 → gross 1200, prepaid 1200,
 *            net 0. Two days: 5000, not 6200 (the pack is counted once).
 *  B2 06-04  pack 4500 for face 5000 → credit_pack 4500.
 *     06-05  usage 1200, draw face 1200 cost 1080 → prepaid 1080, promotional 120, net 0. The
 *            usage margin keeps the pack's cost: revenue 1080 on that line, cost 400.
 *  C  06-06  one-time 1000 paid 1000, plus 500 paid with no invoice (an overpayment kept).
 *     06-07  one-time 1000, excess 500 applied, cash 500 → net 1000, no deduction.
 *  D  06-08  plan 2000 + add-on 1000, coupon −300 (200 / 100), promotional 500 → 500 × 1800 /
 *            2700 = 333.3 and 500 × 900 / 2700 = 166.7 → 333 / 167 (largest remainder). Tax 18%
 *            on 2200 = 396 (264 + 132). Printed 2596, paid 2596. → recurring 1467, one-time
 *            733, net 2200 = taxable base; collected 1467 / 733, tax 396.
 *  E  06-09  case A again (net 700). 06-10 a full credit note: items 1000, promotional 300
 *            returned, tax 126, total 826 → credit_note 700, revenue_billed −700 that day.
 *  F  06-11  plan 1000 + usage 800, plan credits draw 500 → plan_credit 500, usage 300, net 1300.
 *  G  06-12  inclusive one-time 11800 holding tax 1037, promotional 5000 → gross 10763, net
 *            5763 = taxable base (11800 − 5000 − 1037).
 *  H  06-13  plan 3000 + unused time −1200, promotional 500 → all 500 on the plan line, net 1300.
 *
 * June: gross A 1000 + B1 5000 + 1200 + B2 4500 + 1200 + C 1000 + 1000 + D 3000 + E 1000 +
 * F 1800 + G 10763 + H 1800 = 33263. Deductions: coupon 300; promotional 300 + 120 + 500 +
 * 300 + 5000 + 500 = 6720; plan 500; prepaid 1200 + 1080 = 2280; credit note 700 → 10500.
 * Net 33263 − 10500 = 22763 (= Σ the nets: 700 + 5000 + 0 + 4500 + 0 + 1000 + 1000 + 2200 +
 * 700 − 700 + 1300 + 5763 + 1300).
 *
 * Then the customer and subscription pages: cash (`collectedRevenue`) and net billed revenue
 * (`billedRevenueForRecord`), P, K, O, S below, worked in that section's comment.
 *
 *   pnpm verify:metric-revenue-net
 */
import { sql } from "drizzle-orm";
import { closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createPrice, createProduct } from "@/modules/catalog/service";
import { assertRegistryImplemented, computeMetricPeriod } from "@/modules/metrics/daily/compute";
import { writeMetricDay } from "@/modules/metrics/daily/write";
import type { Grain } from "@/modules/metrics/daily/measures";
import { usageMargin } from "@/modules/metrics/usage-margin";
import { collectedRevenue } from "@/modules/payments/revenue";
import { billedRevenueForRecord } from "@/modules/metrics/record-revenue";
import {
  appliedTaxes,
  creditGrantMovements,
  creditGrants,
  creditNoteDiscounts,
  creditNoteItems,
  creditNotes,
  invoiceLineItems,
  invoices,
  meters,
  metricDaily,
  payments,
  refunds,
  subscriptions,
} from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const NOW = new Date("2026-09-15T12:00:00.000Z");
const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const stamp = Date.now();

const org = await createOrganization({ name: "Revenue Net Oracle Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Revenue Net Oracle Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
const bizId = biz.id;
const ids = { organizationId: orgId, businessId: bizId };
const customer = await createCustomer({ ...ids, email: `revenue-net-${stamp}@example.test` });
/** The customer the fixture helpers write for; the cash section switches it. */
let who: { id: string } = customer;

async function product(name: string, kind: "plan" | "setup" | "pack") {
  const p = await createProduct({ ...ids, name, kind: kind === "plan" ? "plan" : "charge" });
  const pr = await createPrice({
    ...ids,
    productId: p.id,
    id: `rn-${name}-${stamp}`,
    type: kind === "plan" ? "recurring" : "one_time",
    model: "flat",
    currency: "USD",
    amountMinor: 100,
    ...(kind === "plan" ? { interval: "month" } : {}),
    ...(kind === "pack"
      ? {
          grantsCredit: {
            kind: "pack",
            unit: null,
            amount: 5000,
            tax_treatment: "taxed_at_purchase",
          },
        }
      : {}),
  });
  return { productId: pr.productId, priceId: pr.id };
}
const plan = await product("plan", "plan");
const setup = await product("setup", "setup");
const pack = await product("pack", "pack");
const [meter] = await withTenant(orgId, (tx) =>
  tx
    .insert(meters)
    .values({
      ...ids,
      key: `rn-calls-${stamp}`,
      name: "Calls",
      eventName: "calls",
      aggregation: "count",
    })
    .returning({ id: meters.id }),
);

let seq = 0;
type Line = {
  kind: string;
  amount: number;
  priceId?: string | null;
  tax?: number;
  cost?: number;
};
/** One billed invoice. Returns its id and its line ids in order. */
async function invoice(i: {
  day: string;
  total: number;
  promo?: number;
  grantPreTax?: number;
  excess?: number;
  subscriptionId?: string;
  lines: Line[];
}): Promise<{ id: string; lines: string[] }> {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx
      .insert(invoices)
      .values({
        ...ids,
        customerId: who.id,
        publicId: `inv_rn_${++seq}_${stamp}`,
        status: "paid",
        currency: "USD",
        subtotalMinor: BigInt(i.total),
        totalMinor: BigInt(i.total),
        promotionalCreditsAppliedMinor: BigInt(i.promo ?? 0),
        grantCreditsPreTaxMinor: BigInt(i.grantPreTax ?? 0),
        excessPaymentsAppliedMinor: BigInt(i.excess ?? 0),
        subscriptionId: i.subscriptionId ?? null,
        createdAt: at(i.day),
      })
      .returning({ id: invoices.id });
    const lines: string[] = [];
    let n = 0;
    for (const l of i.lines) {
      const [line] = await tx
        .insert(invoiceLineItems)
        .values({
          ...ids,
          invoiceId: row!.id,
          publicId: `il_rn_${seq}_${++n}_${stamp}`,
          description: `${l.kind} line`,
          quantity: 1,
          unitAmountMinor: BigInt(l.amount),
          amountMinor: BigInt(l.amount),
          priceId: l.priceId ?? null,
          kind: l.kind,
          ...(l.kind === "usage"
            ? { rating: { meter: meter!.id }, costMinor: BigInt(l.cost ?? 0), costBasis: "event" }
            : {}),
          createdAt: at(i.day),
        })
        .returning({ id: invoiceLineItems.id });
      lines.push(line!.id);
      if (l.tax) {
        await tx.insert(appliedTaxes).values({
          ...ids,
          invoiceId: row!.id,
          invoiceLineItemId: line!.id,
          name: "TAX",
          rateBps: 1800,
          amountMinor: BigInt(l.tax),
          taxabilityReason: "standard_rated",
          createdAt: at(i.day),
        });
      }
    }
    return { id: row!.id, lines };
  });
}

async function pay(invoiceId: string | null, amount: number, day: string) {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx
      .insert(payments)
      .values({
        ...ids,
        customerId: who.id,
        invoiceId,
        publicId: `pay_rn_${++seq}_${stamp}`,
        status: "succeeded",
        amountMinor: BigInt(amount),
        currency: "USD",
        providerKey: "offline",
        createdAt: at(day),
      })
      .returning({ id: payments.id });
    return row!.id;
  });
}

/** A grant and one draw of it on `invoiceId`. */
async function grantDraw(g: {
  category: "paid" | "promotional";
  source: "purchase" | "plan_cycle" | "manual";
  face: number;
  cost: number;
  soldOn?: string;
  invoiceId: string;
  drawFace: number;
  drawCost: number;
  day: string;
}) {
  await withTenant(orgId, async (tx) => {
    const [grant] = await tx
      .insert(creditGrants)
      .values({
        ...ids,
        publicId: `cgr_rn_${++seq}_${stamp}`,
        customerId: who.id,
        currency: "USD",
        amount: BigInt(g.face),
        faceMinor: BigInt(g.face),
        costBasisMinor: BigInt(g.cost),
        category: g.category,
        source: g.source,
        invoiceId: g.soldOn ?? null,
        taxTreatment: g.category === "paid" ? "taxed_at_purchase" : null,
        effectiveAt: at("2026-05-01"),
      })
      .returning({ id: creditGrants.id });
    await tx.insert(creditGrantMovements).values({
      ...ids,
      publicId: `cgm_rn_${++seq}_${stamp}`,
      customerId: who.id,
      grantId: grant!.id,
      kind: "draw",
      units: BigInt(-g.drawFace),
      faceMinor: BigInt(-g.drawFace),
      costMinor: BigInt(-g.drawCost),
      invoiceId: g.invoiceId,
      createdAt: at(g.day),
    });
  });
}

// A
const a = await invoice({
  day: "2026-06-01",
  total: 1126,
  promo: 300,
  lines: [
    { kind: "one_time", amount: 1000, priceId: setup.priceId, tax: 126 },
    { kind: "tax", amount: 126 },
  ],
});
await pay(a.id, 826, "2026-06-01");
// B1
const b1Pack = await invoice({
  day: "2026-06-02",
  total: 5900,
  lines: [
    { kind: "one_time", amount: 5000, priceId: pack.priceId, tax: 900 },
    { kind: "tax", amount: 900 },
  ],
});
await pay(b1Pack.id, 5900, "2026-06-02");
const b1Use = await invoice({
  day: "2026-06-03",
  total: 1200,
  grantPreTax: 1200,
  lines: [{ kind: "usage", amount: 1200, cost: 300 }],
});
await grantDraw({
  category: "paid",
  source: "purchase",
  face: 5000,
  cost: 5000,
  soldOn: b1Pack.id,
  invoiceId: b1Use.id,
  drawFace: 1200,
  drawCost: 1200,
  day: "2026-06-03",
});
// B2
const b2Pack = await invoice({
  day: "2026-06-04",
  total: 4500,
  lines: [{ kind: "one_time", amount: 4500, priceId: pack.priceId }],
});
await pay(b2Pack.id, 4500, "2026-06-04");
const b2Use = await invoice({
  day: "2026-06-05",
  total: 1200,
  grantPreTax: 1200,
  lines: [{ kind: "usage", amount: 1200, cost: 400 }],
});
await grantDraw({
  category: "paid",
  source: "purchase",
  face: 5000,
  cost: 4500,
  soldOn: b2Pack.id,
  invoiceId: b2Use.id,
  drawFace: 1200,
  drawCost: 1080,
  day: "2026-06-05",
});
// C
const c1 = await invoice({
  day: "2026-06-06",
  total: 1000,
  lines: [{ kind: "one_time", amount: 1000, priceId: setup.priceId }],
});
await pay(c1.id, 1000, "2026-06-06");
await pay(null, 500, "2026-06-06");
const c2 = await invoice({
  day: "2026-06-07",
  total: 1000,
  excess: 500,
  lines: [{ kind: "one_time", amount: 1000, priceId: setup.priceId }],
});
await pay(c2.id, 500, "2026-06-07");
// D
const d = await invoice({
  day: "2026-06-08",
  total: 3096,
  promo: 500,
  lines: [
    { kind: "recurring", amount: 2000, priceId: plan.priceId, tax: 264 },
    { kind: "one_time", amount: 1000, priceId: setup.priceId, tax: 132 },
    { kind: "discount", amount: -300 },
    { kind: "tax", amount: 396 },
  ],
});
await pay(d.id, 2596, "2026-06-08");
// E
const e = await invoice({
  day: "2026-06-09",
  total: 1126,
  promo: 300,
  lines: [
    { kind: "one_time", amount: 1000, priceId: setup.priceId, tax: 126 },
    { kind: "tax", amount: 126 },
  ],
});
await withTenant(orgId, async (tx) => {
  const [note] = await tx
    .insert(creditNotes)
    .values({
      ...ids,
      customerId: customer.id,
      invoiceId: e.id,
      publicId: `cn_rn_${stamp}`,
      creditMethod: "balance",
      kind: "adjustment",
      status: "adjusted",
      reasonCode: "other",
      currency: "USD",
      subtotalMinor: 1000n,
      totalMinor: 826n,
      createdAt: at("2026-06-10"),
    })
    .returning({ id: creditNotes.id });
  await tx.insert(creditNoteItems).values([
    {
      ...ids,
      creditNoteId: note!.id,
      publicId: `cni_rn_1_${stamp}`,
      description: "one-time line",
      amountMinor: 1000n,
      kind: "one_time",
      invoiceLineItemId: e.lines[0]!,
    },
    {
      ...ids,
      creditNoteId: note!.id,
      publicId: `cni_rn_2_${stamp}`,
      description: "Tax reversal on credited time",
      amountMinor: 126n,
      kind: "tax",
    },
  ]);
  await tx.insert(creditNoteDiscounts).values({
    ...ids,
    creditNoteId: note!.id,
    type: "promotional_credits",
    amountMinor: 300n,
  });
});
// F
const f = await invoice({
  day: "2026-06-11",
  total: 1800,
  grantPreTax: 500,
  lines: [
    { kind: "recurring", amount: 1000, priceId: plan.priceId },
    { kind: "usage", amount: 800, cost: 100 },
  ],
});
await grantDraw({
  category: "promotional",
  source: "plan_cycle",
  face: 500,
  cost: 0,
  invoiceId: f.id,
  drawFace: 500,
  drawCost: 0,
  day: "2026-06-11",
});
// G
await invoice({
  day: "2026-06-12",
  total: 11800,
  promo: 5000,
  lines: [{ kind: "one_time", amount: 11800, tax: 1037 }],
});
// H
await invoice({
  day: "2026-06-13",
  total: 1800,
  promo: 500,
  lines: [
    { kind: "recurring", amount: 3000, priceId: plan.priceId },
    { kind: "proration", amount: -1200 },
  ],
});

type Key = string;
const key = (m: string, dim: string, v: string): Key => `${m}|${dim}|${v}`;
async function materialise(grain: Grain, periodEnd: string): Promise<Map<Key, bigint>> {
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
        sql`${metricDaily.businessId} = ${bizId} and ${metricDaily.grain} = ${grain} and ${metricDaily.periodEnd} = ${periodEnd} and ${metricDaily.currency} = 'USD'`,
      ),
  );
  return new Map(stored.map((r) => [key(r.measure, r.dim, r.dimValue), r.value ?? 0n]));
}
const day = async (d: string) => {
  const m = await materialise("day", d);
  return (measure: string, dim = "", v = "") => m.get(key(measure, dim, v)) ?? 0n;
};

let registryOk = true;
try {
  assertRegistryImplemented();
} catch (err) {
  registryOk = false;
  console.error(err);
}
ok("registry: the new measures are declared and implemented with the same slices", registryOk);

// A
let g = await day("2026-06-01");
ok("A: gross 1000", g("revenue_billed_gross") === 1000n);
ok(
  "A: promotional credit 300",
  g("revenue_deductions", "revenue_deduction", "promotional_credit") === 300n,
);
ok("A: net 700", g("revenue_billed") === 700n);
ok("A: collected 700 (not 734)", g("revenue_collected") === 700n);
ok("A: cash tax bucket 126 (not 92)", g("cash_collected", "cash_bucket", "tax") === 126n);
ok("A: billing_gross is the printed 826", g("billing_gross") === 826n);
ok("A: taxable_base 700", g("taxable_base") === 700n);
// B1
g = await day("2026-06-02");
ok(
  "B1: the pack is revenue when sold, 5000",
  g("revenue_billed", "revenue_type", "credit_pack") === 5000n,
);
g = await day("2026-06-03");
ok("B1: pack-paid usage gross 1200", g("revenue_billed_gross") === 1200n);
ok("B1: prepaid 1200", g("revenue_deductions", "revenue_deduction", "prepaid_credit") === 1200n);
ok(
  "B1: net 0, usage 0",
  g("revenue_billed") === 0n && g("revenue_billed", "revenue_type", "usage") === 0n,
);
// B2
g = await day("2026-06-05");
ok(
  "B2: prepaid at cost 1080",
  g("revenue_deductions", "revenue_deduction", "prepaid_credit") === 1080n,
);
ok(
  "B2: the bonus 120 is promotional",
  g("revenue_deductions", "revenue_deduction", "promotional_credit") === 120n,
);
ok("B2: net 0", g("revenue_billed") === 0n);
// C
g = await day("2026-06-07");
ok(
  "C: an applied overpayment is no deduction: net 1000",
  g("revenue_billed") === 1000n && g("revenue_deductions") === 0n,
);
ok("C: collected 500 that day", g("revenue_collected") === 500n);
// D
g = await day("2026-06-08");
ok("D: gross 3000", g("revenue_billed_gross") === 3000n);
ok("D: coupon 300", g("revenue_deductions", "revenue_deduction", "coupon") === 300n);
ok(
  "D: promotional 500",
  g("revenue_deductions", "revenue_deduction", "promotional_credit") === 500n,
);
ok("D: recurring 1467", g("revenue_billed", "revenue_type", "recurring") === 1467n);
ok("D: one-time 733", g("revenue_billed", "revenue_type", "one_time") === 733n);
ok("D: net 2200 = taxable base", g("revenue_billed") === 2200n && g("taxable_base") === 2200n);
ok(
  "D: collected 1467 / 733, tax 396",
  g("revenue_collected", "revenue_type", "recurring") === 1467n &&
    g("revenue_collected", "revenue_type", "one_time") === 733n &&
    g("cash_collected", "cash_bucket", "tax") === 396n,
);
ok(
  "D: deductions by type: recurring 200 + 333, one-time 100 + 167",
  g("revenue_deductions", "revenue_type", "recurring") === 533n &&
    g("revenue_deductions", "revenue_type", "one_time") === 267n,
);
// E
g = await day("2026-06-09");
ok("E: the invoice nets 700", g("revenue_billed") === 700n);
g = await day("2026-06-10");
ok(
  "E: the credit note is a 700 deduction (1000 − 300 returned)",
  g("revenue_deductions", "revenue_deduction", "credit_note") === 700n,
);
ok(
  "E: revenue that day is −700",
  g("revenue_billed") === -700n && g("revenue_billed_gross") === 0n,
);
ok(
  "E: the note is placed on the one-time type",
  g("revenue_billed", "revenue_type", "one_time") === -700n,
);
// F
g = await day("2026-06-11");
ok("F: plan credit 500", g("revenue_deductions", "revenue_deduction", "plan_credit") === 500n);
ok(
  "F: usage 300, plan 1000, net 1300",
  g("revenue_billed", "revenue_type", "usage") === 300n &&
    g("revenue_billed", "revenue_type", "recurring") === 1000n &&
    g("revenue_billed") === 1300n,
);
// G
g = await day("2026-06-12");
ok(
  "G: gross 10763, net 5763",
  g("revenue_billed_gross") === 10763n && g("revenue_billed") === 5763n,
);
ok("G: taxable base 5763", g("taxable_base") === 5763n);
// H
g = await day("2026-06-13");
ok(
  "H: net 1300, promotional 500",
  g("revenue_billed") === 1300n &&
    g("revenue_deductions", "revenue_deduction", "promotional_credit") === 500n,
);

// June, and the identity per slice.
const june = await materialise("month", "2026-06-30");
const m = (measure: string, dim = "", v = "") => june.get(key(measure, dim, v)) ?? 0n;
ok("June: gross 33263", m("revenue_billed_gross") === 33263n);
ok("June: deductions 10500", m("revenue_deductions") === 10500n);
ok("June: net 22763", m("revenue_billed") === 22763n);
ok(
  "June: deductions by kind 300 / 6720 / 500 / 2280 / 700",
  m("revenue_deductions", "revenue_deduction", "coupon") === 300n &&
    m("revenue_deductions", "revenue_deduction", "promotional_credit") === 6720n &&
    m("revenue_deductions", "revenue_deduction", "plan_credit") === 500n &&
    m("revenue_deductions", "revenue_deduction", "prepaid_credit") === 2280n &&
    m("revenue_deductions", "revenue_deduction", "credit_note") === 700n,
);
const values = (measure: string, dim: string) =>
  new Set(
    [...june.keys()].filter((k) => k.startsWith(`${measure}|${dim}|`)).map((k) => k.split("|")[2]!),
  );
for (const dim of ["revenue_type", "product"]) {
  const vs = new Set([
    ...values("revenue_billed", dim),
    ...values("revenue_billed_gross", dim),
    ...values("revenue_deductions", dim),
  ]);
  const bad = [...vs].filter(
    (v) =>
      m("revenue_billed_gross", dim, v) - m("revenue_deductions", dim, v) !==
      m("revenue_billed", dim, v),
  );
  ok(`identity: gross − deductions = net for every ${dim}`, bad.length === 0);
}
ok(
  "identity: gross − deductions = net",
  m("revenue_billed_gross") - m("revenue_deductions") === m("revenue_billed"),
);
ok("per customer: the numerator is net revenue", m("revenue_per_customer") === m("revenue_billed"));

// Usage margin keeps the pack's cost as revenue, takes off the bonus and the plan credit.
const margin = await usageMargin({
  organizationId: orgId,
  businessId: bizId,
  from: at("2026-06-01"),
  to: at("2026-07-01"),
  groupBy: "meter",
});
const usd = margin.totals.find((t) => t.currency === "USD");
// B1 1200 − 0 + B2 1200 − 120 + F 800 − 500 = 2580; cost 300 + 400 + 100 = 800.
ok("usage margin: revenue 1200 + 1080 + 300 = 2580", usd?.revenueMinor === 2580n);
ok("usage margin: cost 800, margin 1780", usd?.costMinor === 800n && usd?.marginMinor === 1780n);

// ── Revenue and cash on the customer and subscription pages ───────────────────────────
// Cash, tax included; never credit. Revenue is net, before tax, less every credit note.
// Fresh customers, so nothing above is counted.
//  P  invoice 1000 + tax 126, promotional credit 300, paid 826 → cash 826, not 1126.
//  K  pack 5000 + tax 900 paid 5900; usage 1200 paid by the pack (no payment) → 5900, one
//     paid invoice: the pack counts once, when its own invoice is paid.
//  O  invoice 1000 paid 1000, plus 500 overpaid with no invoice, then an invoice of 1000
//     paid 500 + the 500 excess → cash 2000: the overpayment is cash once.
//  S  a subscription: two invoices of 1000 paid; a credit note on the second refunded as
//     money (refund 400) → 1600; a second note kept as balance (no refund) → still 1600.
const cashOf = async (scope: { customerId: string } | { subscriptionId: string }) =>
  (await collectedRevenue(orgId, scope)).find((r) => r.currency === "USD");
const revenueOf = async (scope: { customerId: string } | { subscriptionId: string }) =>
  (await billedRevenueForRecord(orgId, bizId, scope)).find((r) => r.currency === "USD");
const mk = (k: string) =>
  createCustomer({ ...ids, email: `revenue-net-${k}-${stamp}@example.test` });

who = await mk("p");
const p1 = await invoice({
  day: "2026-07-01",
  total: 1126,
  promo: 300,
  lines: [
    { kind: "one_time", amount: 1000, priceId: setup.priceId, tax: 126 },
    { kind: "tax", amount: 126 },
  ],
});
await pay(p1.id, 826, "2026-07-01");
const pCash = await cashOf({ customerId: who.id });
ok("cash P: promotional credit is not cash: 826", pCash?.amount_minor === 826);
ok(
  "record revenue P: promotional credit and tax are not revenue: 700",
  (await revenueOf({ customerId: who.id }))?.amount_minor === 700,
);

who = await mk("k");
const kPack = await invoice({
  day: "2026-07-02",
  total: 5900,
  lines: [
    { kind: "one_time", amount: 5000, priceId: pack.priceId, tax: 900 },
    { kind: "tax", amount: 900 },
  ],
});
await pay(kPack.id, 5900, "2026-07-02");
const kUse = await invoice({
  day: "2026-07-03",
  total: 1200,
  grantPreTax: 1200,
  lines: [{ kind: "usage", amount: 1200, cost: 0 }],
});
await grantDraw({
  category: "paid",
  source: "purchase",
  face: 5000,
  cost: 5000,
  soldOn: kPack.id,
  invoiceId: kUse.id,
  drawFace: 1200,
  drawCost: 1200,
  day: "2026-07-03",
});
const kCash = await cashOf({ customerId: who.id });
ok(
  "cash K: a pack counts once, when paid: 5900 over one invoice",
  kCash?.amount_minor === 5900 && kCash?.paid_invoices_count === 1,
);
ok(
  "record revenue K: pack revenue counts once, before tax: 5000",
  (await revenueOf({ customerId: who.id }))?.amount_minor === 5000,
);

who = await mk("o");
const o1 = await invoice({
  day: "2026-07-04",
  total: 1000,
  lines: [{ kind: "one_time", amount: 1000, priceId: setup.priceId }],
});
await pay(o1.id, 1000, "2026-07-04");
await pay(null, 500, "2026-07-04");
const o2 = await invoice({
  day: "2026-07-05",
  total: 1000,
  excess: 500,
  lines: [{ kind: "one_time", amount: 1000, priceId: setup.priceId }],
});
await pay(o2.id, 500, "2026-07-05");
ok(
  "cash O: an overpayment is cash once: 2000",
  (await cashOf({ customerId: who.id }))?.amount_minor === 2000,
);
ok(
  "record revenue O: both billed invoices count: 2000",
  (await revenueOf({ customerId: who.id }))?.amount_minor === 2000,
);

who = await mk("s");
const [sub] = await withTenant(orgId, (tx) =>
  tx
    .insert(subscriptions)
    .values({
      ...ids,
      customerId: who.id,
      publicId: `sub_rn_${stamp}`,
      status: "active",
      currency: "USD",
    })
    .returning({ id: subscriptions.id }),
);
const s1 = await invoice({
  day: "2026-07-06",
  total: 1000,
  subscriptionId: sub!.id,
  lines: [{ kind: "recurring", amount: 1000, priceId: plan.priceId }],
});
await pay(s1.id, 1000, "2026-07-06");
const s2 = await invoice({
  day: "2026-07-07",
  total: 1000,
  subscriptionId: sub!.id,
  lines: [{ kind: "recurring", amount: 1000, priceId: plan.priceId }],
});
const s2Pay = await pay(s2.id, 1000, "2026-07-07");
await withTenant(orgId, async (tx) => {
  const note = (n: number, refunded: boolean) =>
    tx.insert(creditNotes).values({
      ...ids,
      customerId: who.id,
      invoiceId: s2.id,
      publicId: `cn_rn_s${n}_${stamp}`,
      creditMethod: refunded ? "refund" : "balance",
      kind: "refundable",
      status: refunded ? "refunded" : "refund_due",
      reasonCode: "other",
      currency: "USD",
      subtotalMinor: 400n,
      totalMinor: 400n,
      createdAt: at("2026-07-08"),
    });
  await note(1, true);
  await tx.insert(refunds).values({
    ...ids,
    paymentId: s2Pay,
    publicId: `re_rn_${stamp}`,
    status: "succeeded",
    amountMinor: 400n,
    currency: "USD",
    providerKey: "offline",
    createdAt: at("2026-07-08"),
  });
  await note(2, false);
});
const sCash = await cashOf({ subscriptionId: sub!.id });
ok(
  "cash S: a credit note refunded as money lowers it, one kept as balance does not: 1600",
  sCash?.amount_minor === 1600 && sCash?.paid_invoices_count === 2,
);
ok(
  "record revenue S: both credit notes lower subscription revenue: 1200",
  (await revenueOf({ subscriptionId: sub!.id }))?.amount_minor === 1200,
);
ok(
  "record revenue S: the customer total has the same credit notes: 1200",
  (await revenueOf({ customerId: who.id }))?.amount_minor === 1200,
);

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log("");
console.log(
  failed === 0
    ? `✅ METRIC-REVENUE-NET: PASS (${checks.length}/${checks.length})`
    : `❌ METRIC-REVENUE-NET: FAIL (${failed}/${checks.length} failed)`,
);
if (failed > 0) console.log([...june.entries()].map(([k, v]) => `${k}=${v}`).join("\n"));
await closeDb();
process.exit(failed === 0 ? 0 : 1);

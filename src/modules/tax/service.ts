import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { normalizeStateCode, requireStateCode } from "@/platform/geo";
import {
  businesses,
  taxProfiles,
  taxRateComponents,
  taxRegions,
  taxStateRegistrations,
} from "@db/schema";
import { DEFAULT_TAX_ROUNDING, resolveTaxSettings, type TaxRounding } from "./settings";
import { createLogger } from "@/platform/logger";

const log = createLogger("tax");

export class TaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaxError";
  }
}

/** Tax regimes. Only `gst` splits by place of supply. */
export const TAX_REGIMES = ["gst", "vat", "sales_tax", "flat"] as const;
export type TaxRegime = (typeof TAX_REGIMES)[number];

/** Where a component applies relative to the seller's own state. */
export const APPLIES_TO = ["intra", "inter", "both"] as const;
export type AppliesTo = (typeof APPLIES_TO)[number];

/**
 * How a customer is treated inside their region's regime. `default` resolves from
 * place of supply; the rest are the region-gated special treatments.
 */
export const TAX_TREATMENTS = [
  "default",
  "sez_igst",
  "sez_zero_rated",
  "export_igst",
  "export_zero_rated",
  "reverse_charge",
] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];

/** One resolved tax component: what to charge and what to call it on the invoice. */
export interface TaxComponent {
  name: string;
  rateBps: number;
  /** Internal id of the component row, snapshotted onto `applied_taxes`. */
  taxComponentId: string | null;
}

/**
 * The complete tax determination for one (customer, tax profile) pair — everything
 * needed to compute AND to explain the result on an invoice.
 *
 * `components` empty means zero tax, and `taxabilityReason` says why. That distinction
 * matters legally: a zero-rated export and an unconfigured country both produce 0, but
 * only one of them is a statement about the supply.
 */
export interface TaxResolution {
  /** Stable identity — lines sharing a key share a rounding pool. */
  key: string;
  /** Components to apply to a taxable line, in print order. Empty = zero tax. */
  components: TaxComponent[];
  /** Σ component rates. The effective rate, used to back out inclusive tax. */
  totalRateBps: number;
  /** standard_rated · zero_rated · reverse_charge · customer_exempt · no_rate */
  taxabilityReason: string;
  /** The seller's state at determination time — snapshotted onto the invoice. */
  sellerStateCode: string | null;
  /** The customer's place of supply used — snapshotted onto the invoice. */
  placeOfSupplyCode: string | null;
  treatment: TaxTreatment;
  /** Note to print (reverse-charge / SEZ / export text). Null = nothing to print. */
  taxNote: string | null;
  /** Region-level tax-inclusive pricing, or null when no region matched. */
  priceType: "exclusive" | "inclusive" | null;
  regime: TaxRegime | null;
  regionId: string | null;
  /** Was this an intra-state supply? Null outside a `gst` regime. */
  intraState: boolean | null;
  /** The seller's registration number for the supplying state, for the invoice header. */
  registrationNumber: string | null;
  registrationLabel: string | null;
  /** The business's tax rounding rule (`tax_settings.rounding`). */
  rounding: TaxRounding;
  /** `customers.tax_behavior`: set = every taxed line is this, whatever the price says. */
  customerBehavior: "inclusive" | "exclusive" | null;
}

/** A determination that taxes nothing, with an honest reason. */
function zeroResolution(reason: string, over: Partial<TaxResolution> = {}): TaxResolution {
  return {
    key: `zero:${reason}:${over.regionId ?? "-"}:${over.treatment ?? "default"}`,
    components: [],
    totalRateBps: 0,
    taxabilityReason: reason,
    sellerStateCode: null,
    placeOfSupplyCode: null,
    treatment: "default",
    taxNote: null,
    priceType: null,
    regime: null,
    regionId: null,
    intraState: null,
    registrationNumber: null,
    registrationLabel: null,
    rounding: DEFAULT_TAX_ROUNDING,
    customerBehavior: null,
    ...over,
  };
}

/**
 * Whether a taxed line's amount already includes tax. The customer's override wins; else a
 * tax-inclusive region; else the price's own `tax_behavior`.
 */
export function lineIsInclusive(resolution: TaxResolution, priceInclusive: boolean): boolean {
  if (resolution.customerBehavior) return resolution.customerBehavior === "inclusive";
  return resolution.priceType === "inclusive" || priceInclusive;
}

/** A prepaid money voucher is taxed when spent, so its sale is zero-rated (design G3 §3.6). */
export const PREPAID_CREDIT_REASON = "prepaid_credit";

/** `r` with no components and the `prepaid_credit` reason; the place-of-supply snapshot stays. */
export function prepaidCreditResolution(r: TaxResolution): TaxResolution {
  const { components: _c, totalRateBps: _t, key: _k, taxabilityReason: _r, ...keep } = r;
  return zeroResolution(PREPAID_CREDIT_REASON, keep);
}

export interface TaxInput {
  organizationId: string;
  businessId: string;
  /** Customer billing country (ISO alpha-2). */
  country?: string | null;
  /** Customer place of supply — ISO-3166-2 subdivision code, e.g. 'KA'. */
  stateCode?: string | null;
  /** `customers.tax_treatment`. */
  treatment?: TaxTreatment | null;
  /** `products.tax_profile_id`; null → the business's default profile. */
  taxProfileId?: string | null;
  /** `customers.tax_exempt` — short-circuits everything. */
  customerExempt?: boolean;
  /** `customers.tax_behavior`. Null/absent = each price decides. */
  customerTaxBehavior?: string | null;
}

/**
 * Tax provider contract. `resolve` performs the DETERMINATION (which components apply
 * and why); the arithmetic lives in the pure functions below so it is testable without
 * a database. `record`/`revert`/`backfill` commit or reverse the tax transaction at an
 * external provider; the built-in rate-table provider treats them as no-ops.
 */
export interface TaxProvider {
  readonly key: string;
  resolve(input: TaxInput): Promise<TaxResolution>;
  /** Commit a tax transaction (external providers). No-op for the rate table. */
  record?(ref: string, calculationId: string): Promise<string>;
  /** Reverse a committed transaction on refund/credit-note (full or partial). */
  revert?(transactionId: string, ref: string, revertedTaxMinor?: bigint): Promise<string>;
  /** Backfill a historical tax transaction. */
  backfill?(ref: string, taxMinor: bigint, when: Date): Promise<string>;
}

/** A candidate invoice line for tax computation. */
export interface TaxableLine {
  id: string;
  amountMinor: bigint;
  taxable: boolean;
  /** Price (or region) says the amount already INCLUDES tax. */
  inclusive: boolean;
  /**
   * CAT-2: line-level (each_specified_item) coupon discount attributed EXACTLY to this
   * line — subtracted from the line's taxable base before the proportional
   * (invoice-level + promo) discount is spread. Defaults to 0.
   */
  lineDiscountMinor?: bigint;
  /**
   * Credit grants drawn on this line before tax (design G3 §3.4). Comes off the line's base
   * AFTER the invoice-level coupon share and BEFORE the promotional bucket's share, so a
   * covered line is never discounted below 0 and an uncovered line keeps its own tax.
   */
  preTaxCreditMinor?: bigint;
  /**
   * The determination for THIS line. Lines can differ when products carry different
   * tax profiles (a profile is assigned per plan/addon), so the resolution is
   * per-line rather than per-invoice.
   */
  resolution: TaxResolution;
}

/** One applied_taxes row to persist (per invoice line, per component). */
export interface AppliedTaxSpec {
  lineId: string;
  name: string;
  rateBps: number;
  taxComponentId: string | null;
  amountMinor: bigint;
  taxabilityReason: string;
  /**
   * Was this row's tax already INSIDE the line amount? Not persisted — it exists so the
   * caller can build the synthetic tax LINE ITEMS from exclusive rows only. Inclusive
   * tax is inside the product lines and must never become a line of its own, or the
   * invoice would total to more than the customer agreed to pay.
   */
  inclusive: boolean;
}

export interface InvoiceTax {
  /** Exclusive tax — ADDED to the invoice total and shown as tax line items. */
  additiveTaxMinor: bigint;
  /** Inclusive tax — already inside the line amounts; backed out for revenue/ledger. */
  inclusiveTaxMinor: bigint;
  /** additive + inclusive — the full tax liability (tax_payable + applied_taxes). */
  totalTaxMinor: bigint;
  /** applied_taxes rows: one per component per positive line, plus zero-rated reasons. */
  rows: AppliedTaxSpec[];
}

/**
 * Compute an invoice's tax the industry-standard per-line way, now over a COMPONENT
 * VECTOR rather than a single rate — an India GST line yields CGST + SGST rows
 * intra-state, or one IGST row inter-state.
 *
 * Handles exclusive vs inclusive pricing, product- and customer-level exemption, and
 * two composing discount kinds (CAT-2):
 *   - per-line `lineDiscountMinor` (each_specified_item coupons) is subtracted EXACTLY
 *     from the line it hit — line-accurate, so a discount on a non-taxable line never
 *     erodes a taxable line's base;
 *   - `discountMinor` (invoice-level coupons + promotional credit) reduces each pool's
 *     post-line-level base PROPORTIONALLY.
 *
 * ROUNDING: tax is pooled per (resolution, component) and then allocated across that
 * pool's lines by largest remainder, so the per-line rows sum EXACTLY to the pooled
 * figure — never off by a minor unit from the tax shown. Summing independently-rounded
 * per-line amounts would not hold that. Pure + deterministic.
 */
export function computeInvoiceTax(input: {
  lines: TaxableLine[];
  discountMinor: bigint;
  subtotalMinor: bigint;
  customerExempt: boolean;
  /** The promotional-bucket part of `discountMinor`. Read only when a line has a pre-tax credit. */
  promoMinor?: bigint;
}): InvoiceTax {
  const { lines, discountMinor, subtotalMinor, customerExempt } = input;
  const positive = lines.filter((l) => l.amountMinor > 0n);
  const rows: AppliedTaxSpec[] = [];

  // Whole-customer exemption: every positive line zero-rated with the reason.
  if (customerExempt) {
    for (const l of positive)
      rows.push({
        lineId: l.id,
        name: "Exempt",
        rateBps: 0,
        taxComponentId: null,
        amountMinor: 0n,
        taxabilityReason: "customer_exempt",
        inclusive: false,
      });
    return { additiveTaxMinor: 0n, inclusiveTaxMinor: 0n, totalTaxMinor: 0n, rows };
  }

  // Non-taxable lines → product_exempt (zero) rows regardless of any rate.
  for (const l of positive.filter((l) => !l.taxable)) {
    rows.push({
      lineId: l.id,
      name: "Exempt",
      rateBps: 0,
      taxComponentId: null,
      amountMinor: 0n,
      taxabilityReason: "product_exempt",
      inclusive: false,
    });
  }
  // A taxable line whose resolution taxes nothing still records WHY (zero_rated
  // export, reverse charge, no configured rate) — the reason is the audit trail.
  for (const l of positive.filter((l) => l.taxable && l.resolution.components.length === 0)) {
    // A taxable line that resolved to NO components is either a legitimate
    // zero-rating or a missing region configuration, and the invoice cannot tell
    // them apart later. `no_configured_rate` is the one that costs the merchant money.
    if (l.resolution.taxabilityReason === "no_configured_rate") {
      log.error("taxable line has no configured rate — invoiced with zero tax", {
        event: "tax_no_configured_rate",
        line: l.id,
        amountMinor: l.amountMinor.toString(),
      });
    }
    rows.push({
      lineId: l.id,
      name: l.resolution.taxabilityReason === "reverse_charge" ? "Reverse charge" : "Zero-rated",
      rateBps: 0,
      taxComponentId: null,
      amountMinor: 0n,
      taxabilityReason: l.resolution.taxabilityReason,
      inclusive: false,
    });
  }
  if (subtotalMinor <= 0n) {
    return { additiveTaxMinor: 0n, inclusiveTaxMinor: 0n, totalTaxMinor: 0n, rows };
  }

  // ── THE BASE IS SIGNED (2026-08-26) ────────────────────────────────────────────
  // A NEGATIVE line is a real supply being REVERSED — "Unused time on <plan>" on a
  // proration invoice — so it reduces the taxable base. Taxing the positive lines alone
  // charged tax on a base that appears nowhere on the document: measured on an India GST
  // invoice, base 31828 (positive lines only) instead of 28219, GST 5728 instead of 5078
  // — 650 over-collected, 12.8% too much. And the total still reconciled exactly
  // (28219 + 5728 = 33947), which is why no arithmetic check ever caught it.
  //
  // Under GST that is worse than an over-charge: CGST/SGST/IGST collected is REMITTED, so
  // the business pays tax it never owed and its GSTR-1 return cannot tie to its own
  // invoice lines. `recordLineTaxes` was fixed for this exact shape (see its comment about
  // INV-4) and computes the SIGNED set; this function is the other half of that fix, and
  // until now the two disagreed by exactly the negative line's tax.
  const signed = lines.filter((l) => l.amountMinor !== 0n);
  const net = (l: TaxableLine): bigint => {
    const n = l.amountMinor - (l.lineDiscountMinor ?? 0n);
    // A DISCOUNT cannot turn a charge into a credit — that stays clamped, as before. A
    // line that is ITSELF negative keeps its sign; it is a reversal, not a discount.
    if (l.amountMinor > 0n) return n > 0n ? n : 0n;
    return n;
  };
  const postLineSubtotal = signed.reduce((s, l) => s + net(l), 0n);
  const credit = (l: TaxableLine): bigint =>
    l.amountMinor > 0n && (l.preTaxCreditMinor ?? 0n) > 0n ? l.preTaxCreditMinor! : 0n;
  const creditTotal = signed.reduce((s, l) => s + credit(l), 0n);
  // Proportional (invoice-level + promo) discount reduces each pool's net base. With grant
  // credits on some lines the coupon share is taken first (on the uncredited base), then the
  // pool's credits, then the promo share spread over what is left after both.
  const promo = creditTotal > 0n ? (input.promoMinor ?? 0n) : 0n;
  const coupon = discountMinor - promo;
  const afterCredits = postLineSubtotal - coupon - creditTotal;
  const poolBase = (sum: bigint, poolCredit = 0n) => {
    if (creditTotal === 0n)
      return postLineSubtotal !== 0n ? sum - (discountMinor * sum) / postLineSubtotal : sum;
    const b1 =
      (postLineSubtotal !== 0n ? sum - (coupon * sum) / postLineSubtotal : sum) - poolCredit;
    const b2 = b1 > 0n || sum <= 0n ? b1 : 0n;
    return afterCredits > 0n ? b2 - (promo * b2) / afterCredits : b2;
  };

  // Sign-symmetric rounding. `(x + 5000)/10000` is half-up only for x >= 0; bigint
  // division truncates TOWARD ZERO, so on a negative base it would round the wrong way
  // and leave the components disagreeing with `taxMinorFor`.
  const halfUpAt = (b: bigint, rateBps: number): bigint => {
    const r = BigInt(rateBps);
    return b >= 0n ? (b * r + 5000n) / 10000n : -((-b * r + 5000n) / 10000n);
  };

  const taxed = signed.filter((l) => l.taxable && l.resolution.components.length > 0);
  // Pool by (resolution, inclusive): lines sharing a determination AND a price type
  // share a rounding pool, so mixed-profile invoices each round exactly.
  const pools = new Map<
    string,
    { resolution: TaxResolution; inclusive: boolean; lines: TaxableLine[] }
  >();
  for (const l of taxed) {
    const k = `${l.resolution.key}|${l.inclusive ? "in" : "ex"}`;
    const p = pools.get(k) ?? { resolution: l.resolution, inclusive: l.inclusive, lines: [] };
    p.lines.push(l);
    pools.set(k, p);
  }

  let additiveTaxMinor = 0n;
  let inclusiveTaxMinor = 0n;

  for (const pool of pools.values()) {
    const { resolution, inclusive } = pool;
    const asNet = pool.lines.map((l) => ({ id: l.id, amountMinor: net(l) - credit(l) }));
    const base = poolBase(
      pool.lines.reduce((s, l) => s + net(l), 0n),
      pool.lines.reduce((s, l) => s + credit(l), 0n),
    );
    // `=== 0` rather than `<= 0`: a pool whose reversals outweigh its charges owes
    // NEGATIVE tax, and skipping it would strand that credit's tax on the invoice.
    if (base === 0n) continue;

    // Per-line rounding: each line's tax is rounded on its own base and the total is the
    // sum of the lines, so no allocation step is needed.
    const lineBases =
      resolution.rounding === "per_line"
        ? perLineBases(
            asNet.map((l) => l.amountMinor),
            base,
          )
        : null;
    if (lineBases) {
      const weights = resolution.components.map((c) => BigInt(c.rateBps));
      const r = BigInt(resolution.totalRateBps);
      lineBases.forEach((lb, li) => {
        if (lb === 0n) return;
        let parts: bigint[];
        if (inclusive) {
          const mag = lb >= 0n ? lb : -lb;
          const split = splitByWeight(r > 0n ? (mag * r) / (10000n + r) : 0n, weights);
          parts = lb >= 0n ? split : split.map((v) => -v);
        } else {
          parts = resolution.components.map((c) => halfUpAt(lb, c.rateBps));
        }
        resolution.components.forEach((c, i) => {
          const amt = parts[i] ?? 0n;
          if (amt === 0n) return;
          if (inclusive) inclusiveTaxMinor += amt;
          else additiveTaxMinor += amt;
          rows.push({
            lineId: asNet[li]!.id,
            name: c.name,
            rateBps: c.rateBps,
            taxComponentId: c.taxComponentId,
            amountMinor: amt,
            taxabilityReason: "standard_rated",
            inclusive,
          });
        });
      });
      continue;
    }

    // Per-component pool totals.
    let componentTotals: bigint[];
    if (inclusive) {
      // Back the whole tax out of the gross at the COMBINED rate, then split it across
      // components by their share of that rate. Backing each component out separately
      // (base*r/(10000+r) per component) would overstate the total, because each
      // component's gross already contains the others' tax.
      const r = BigInt(resolution.totalRateBps);
      const mag = base >= 0n ? base : -base;
      const poolMag = r > 0n ? (mag * r) / (10000n + r) : 0n;
      // `splitByWeight` is defined for a non-negative total, so split the MAGNITUDE and
      // re-sign — that keeps its largest-remainder guarantee (parts sum exactly) intact
      // in both directions rather than reimplementing it for negatives.
      const weights = resolution.components.map((c) => BigInt(c.rateBps));
      componentTotals =
        base >= 0n
          ? splitByWeight(poolMag, weights)
          : splitByWeight(poolMag, weights).map((v) => -v);
      inclusiveTaxMinor += componentTotals.reduce((s, v) => s + v, 0n);
    } else {
      // Half-up, matching `taxMinorFor` — the two must agree or applied_taxes drifts.
      componentTotals = resolution.components.map((c) => halfUpAt(base, c.rateBps));
      additiveTaxMinor += componentTotals.reduce((s, v) => s + v, 0n);
    }

    // Allocate each component's pool total across the pool's lines.
    resolution.components.forEach((c, i) => {
      const total = componentTotals[i] ?? 0n;
      if (total === 0n) return;
      // SIGNED allocator — the same one `recordLineTaxes` uses, so the per-line rows this
      // returns and the rows that table stores are produced by one algorithm. The
      // positive-only `allocateTaxAcrossLines` dropped the reversal line entirely and then
      // could not make the remaining pieces sum to a total that included its tax.
      for (const a of allocateTaxAcrossSignedLines(asNet, total, c.rateBps)) {
        rows.push({
          lineId: a.lineId,
          name: c.name,
          rateBps: c.rateBps,
          taxComponentId: c.taxComponentId,
          amountMinor: a.amountMinor,
          taxabilityReason: "standard_rated",
          inclusive,
        });
      }
    });
  }

  return {
    additiveTaxMinor,
    inclusiveTaxMinor,
    totalTaxMinor: additiveTaxMinor + inclusiveTaxMinor,
    rows,
  };
}

/**
 * Each line's share of a pool's taxable base, for per-line rounding. The gap between the
 * lines' own amounts and the pool base (a proportional discount or promotional credit) is
 * taken off the CHARGE lines by weight, largest remainder, so the shares sum exactly to
 * `base`. Null when there is no charge line to carry it — the caller then rounds on the
 * pooled total.
 */
export function perLineBases(amounts: bigint[], base: bigint): bigint[] | null {
  const sum = amounts.reduce((s, a) => s + a, 0n);
  const reduction = sum - base;
  if (reduction === 0n) return [...amounts];
  const charges = amounts.map((a) => (a > 0n ? a : 0n));
  if (reduction < 0n || charges.every((a) => a === 0n)) return null;
  const shares = splitByWeight(reduction, charges);
  return amounts.map((a, i) => a - (shares[i] ?? 0n));
}

/**
 * Split `total` into parts proportional to `weights`, using largest-remainder rounding
 * so the parts sum EXACTLY to `total`. All-bigint. Used to divide an inclusive pool's
 * backed-out tax among its components by rate.
 */
export function splitByWeight(total: bigint, weights: bigint[]): bigint[] {
  const sum = weights.reduce((s, w) => s + w, 0n);
  if (total <= 0n || sum <= 0n) return weights.map(() => 0n);
  const parts = weights.map((w, i) => {
    const exact = w * total;
    const floor = exact / sum;
    return { i, amount: floor, frac: exact - floor * sum };
  });
  let remainder = total - parts.reduce((s, p) => s + p.amount, 0n);
  // Hand out the remaining minor units to the largest fractional parts first; ties
  // break by index so the result is deterministic.
  const order = [...parts].sort((a, b) => (b.frac > a.frac ? 1 : b.frac < a.frac ? -1 : a.i - b.i));
  for (let k = 0; k < order.length && remainder > 0n; k++) {
    order[k]!.amount += 1n;
    remainder -= 1n;
  }
  return parts.map((p) => p.amount);
}

/**
 * Allocate an aggregate tax across taxable lines, proportional to each line's amount,
 * using **largest-remainder** rounding so the per-line pieces sum EXACTLY to
 * `totalTaxMinor` (no drift, always reconciles to the shown tax). Only positive-amount
 * lines are taxed. Returns `{ lineId, amountMinor }` per line that gets a non-zero share.
 */
export function allocateTaxAcrossLines(
  lines: Array<{ id: string; amountMinor: bigint }>,
  totalTaxMinor: bigint,
): Array<{ lineId: string; amountMinor: bigint }> {
  const taxable = lines.filter((l) => l.amountMinor > 0n);
  const base = taxable.reduce((s, l) => s + l.amountMinor, 0n);
  if (totalTaxMinor <= 0n || base <= 0n) return [];
  // floor share + fractional remainder (all bigint; frac in [0, base))
  const parts = taxable.map((l, i) => {
    const exact = l.amountMinor * totalTaxMinor;
    const floor = exact / base;
    return { lineId: l.id, i, amount: floor, frac: exact - floor * base };
  });
  let remainder = totalTaxMinor - parts.reduce((s, p) => s + p.amount, 0n);
  // hand out the remaining minor units to the largest fractional parts first
  const order = [...parts].sort((a, b) => (b.frac > a.frac ? 1 : b.frac < a.frac ? -1 : a.i - b.i));
  for (let k = 0; k < order.length && remainder > 0n; k++) {
    order[k]!.amount += 1n;
    remainder -= 1n;
  }
  return parts
    .filter((p) => p.amount > 0n)
    .map((p) => ({ lineId: p.lineId, amountMinor: p.amount }));
}

/**
 * Allocate an aggregate tax across lines whose amounts may be **negative**, so the
 * pieces still sum EXACTLY to `totalTaxMinor` — the sibling of
 * `allocateTaxAcrossLines` for an invoice that both charges and credits.
 *
 * ── WHY A SIBLING RATHER THAN A FLAG ────────────────────────────────────────────
 * `allocateTaxAcrossLines` drops non-positive lines on purpose: on a period invoice a
 * zero or negative row is an artifact (a discount, a rounding delta) that classifies no
 * supply, and taxing it would be wrong. But a PRORATION invoice's negative line is a
 * real supply being reversed — "Unused time on …", −₹7,277.42 — and it must carry
 * negative tax or the per-line rows stop reconciling with the invoice's own tax total.
 * Two different meanings for a negative line, so two functions rather than a boolean
 * that a caller has to reason about.
 *
 * ── EACH LINE AT ITS OWN RATE, then sweep ──────────────────────────────────────
 * The per-line figure is `amount × rateBps`, NOT a proportional slice of the header
 * total, because a tax invoice has to state what each line was taxed (`IGST @18 on
 * 27,918.00 = 5,025.24`). Slicing the header instead inherits
 * the header's own rounding loss and redistributes it, which for lines
 * +8,732.90 / −7,277.42 at 18% reads 1,571.88 / −1,309.90 where the rate says
 * 1,571.92 / −1,309.94. Both sum to 261.98; only the second is a defensible line.
 *
 * Any drift between the sum of the per-line figures and `totalTaxMinor` is then swept
 * onto the largest |remainder| first, so the rows still reconcile to the invoice's tax
 * exactly. Signed throughout: the direction of the sweep follows the shortfall.
 */
export function allocateTaxAcrossSignedLines(
  lines: Array<{ id: string; amountMinor: bigint }>,
  totalTaxMinor: bigint,
  rateBps: number,
): Array<{ lineId: string; amountMinor: bigint }> {
  if (totalTaxMinor === 0n || lines.length === 0) return [];
  const rate = BigInt(rateBps);
  const parts = lines.map((l, i) => {
    const exact = l.amountMinor * rate;
    const share = exact / 10000n; // bigint division truncates TOWARD ZERO, both signs
    return { lineId: l.id, i, amount: share, rem: exact - share * 10000n };
  });
  let remainder = totalTaxMinor - parts.reduce((s, p) => s + p.amount, 0n);
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const order = [...parts].sort((a, b) => {
    const A = abs(a.rem);
    const B = abs(b.rem);
    return B > A ? 1 : B < A ? -1 : a.i - b.i;
  });
  // Each per-line figure is under one unit out, so the drift is small; the modulo keeps
  // the sweep exact even when it exceeds one pass (many lines, or a coarse rate).
  for (let k = 0; remainder !== 0n && order.length > 0; k++) {
    const step = remainder > 0n ? 1n : -1n;
    order[k % order.length]!.amount += step;
    remainder -= step;
  }
  return parts
    .filter((p) => p.amount !== 0n)
    .map((p) => ({ lineId: p.lineId, amountMinor: p.amount }));
}

/**
 * How one tax COMPONENT is named on a printed document: `IGST (18.00%)`.
 *
 * The single spelling for the whole product. It lives here, next to the component
 * vector it names, because three documents now print it — the invoice's synthetic tax
 * LINE ITEMS (both writers in `invoicing/service.ts`) and the credit note's derived tax
 * rows (`credit-notes/document.ts`) — and a customer holding an invoice and the credit
 * note that reverses it must not see two spellings of the same tax.
 *
 * Two decimals ALWAYS, even on a whole-number rate. Rates are stored in basis points, so
 * 2.25% and 18.5% are representable and do occur (cess, and several non-GST regimes);
 * a format that trims trailing zeros would print `IGST (18%)` beside `Cess (2.25%)` on
 * the same ladder and read as two different conventions. The `Name (rate%)` form is
 * deliberate: our invoices have printed it since India GST shipped, and changing it on
 * one of our two documents would guarantee the two disagree.
 */
export function taxComponentLabel(name: string, rateBps: number): string {
  return `${name} (${(rateBps / 100).toFixed(2)}%)`;
}

/**
 * One component's exclusive tax on a flat base. The single place the estimate path's
 * rounding lives, so the total and the per-component breakdown cannot disagree — see the
 * half-up note in `taxMinorFor`.
 */
function componentTaxMinor(baseMinor: bigint, rateBps: number): bigint {
  return (baseMinor * BigInt(rateBps) + 5000n) / 10000n;
}

/**
 * Each component's total on a flat base. Under per-line rounding with the line amounts in
 * `lineAmounts`, each line is rounded on its own share of the base, as `computeInvoiceTax`
 * does, so an estimate equals the invoice it predicts.
 */
function componentTotalsFor(
  resolution: TaxResolution,
  baseMinor: bigint,
  lineAmounts?: bigint[],
): bigint[] {
  const bases =
    resolution.rounding === "per_line" && lineAmounts && lineAmounts.length > 1
      ? perLineBases(lineAmounts, baseMinor)
      : null;
  return resolution.components.map((c) =>
    bases
      ? bases.reduce((s, b) => s + (b > 0n ? componentTaxMinor(b, c.rateBps) : 0n), 0n)
      : componentTaxMinor(baseMinor, c.rateBps),
  );
}

/**
 * The tax ROWS a flat base produces, labelled as the invoice labels them — CGST + SGST
 * intra-state, one IGST row inter-state, a single row elsewhere.
 *
 * The twin of `taxMinorFor`, and exact by construction rather than by re-splitting: both
 * call `componentTaxMinor`, so these rows always sum to that total. Estimates used to
 * carry only the total and every buyer-facing preview rendered one row called "Tax" — on
 * an Indian invoice that is not what the document says, and the buyer comparing the two
 * has no way to see that the ₹6,531.12 they were quoted is the same money as the CGST and
 * SGST lines they are later sent.
 *
 * Zero components (a zero-rated export, an unconfigured region) yields no rows: a "Tax 0"
 * row is a claim about the supply that `taxabilityReason` is the right place to make.
 */
export function taxLinesForBase(
  resolution: TaxResolution,
  baseMinor: bigint,
  lineAmounts?: bigint[],
): Array<{ label: string; amountMinor: bigint }> {
  if (baseMinor <= 0n) return [];
  const totals = componentTotalsFor(resolution, baseMinor, lineAmounts);
  return resolution.components
    .map((c, i) => ({
      label: taxComponentLabel(c.name, c.rateBps),
      amountMinor: totals[i] ?? 0n,
    }))
    .filter((l) => l.amountMinor !== 0n);
}

/**
 * The same rows from a computed `InvoiceTax` — grouped by component, EXCLUSIVE rows only.
 * Inclusive tax is already inside the line amounts and must never become a row of its own
 * (see `AppliedTaxSpec.inclusive`), or the preview would total above what the buyer agreed
 * to pay.
 */
export function taxLinesFromRows(
  rows: AppliedTaxSpec[],
): Array<{ label: string; amountMinor: bigint }> {
  const byComponent = new Map<string, { label: string; amountMinor: bigint }>();
  for (const r of rows) {
    if (r.inclusive || r.amountMinor === 0n) continue;
    const key = `${r.name}|${r.rateBps}`;
    const at = byComponent.get(key);
    if (at) at.amountMinor += r.amountMinor;
    else
      byComponent.set(key, {
        label: taxComponentLabel(r.name, r.rateBps),
        amountMinor: r.amountMinor,
      });
  }
  return [...byComponent.values()].filter((l) => l.amountMinor !== 0n);
}

/**
 * Tax INSIDE a gross amount, as `computeInvoiceTax` backs it out: once on the gross at the
 * combined rate (floored), or per line under per-line rounding. The estimate path's twin of
 * the inclusive branch, so a preview states the tax the invoice books.
 */
export function inclusiveTaxMinorFor(
  resolution: TaxResolution,
  grossMinor: bigint,
  lineAmounts?: bigint[],
): bigint {
  const r = BigInt(resolution.totalRateBps);
  if (grossMinor <= 0n || r <= 0n) return 0n;
  const out = (b: bigint) => (b > 0n ? (b * r) / (10000n + r) : 0n);
  const bases =
    resolution.rounding === "per_line" && lineAmounts && lineAmounts.length > 1
      ? perLineBases(lineAmounts, grossMinor)
      : null;
  return bases ? bases.reduce((s, b) => s + out(b), 0n) : out(grossMinor);
}

/** Total exclusive tax for a flat base under a resolution — the estimate path. */
export function taxMinorFor(
  resolution: TaxResolution,
  baseMinor: bigint,
  lineAmounts?: bigint[],
): bigint {
  if (baseMinor <= 0n) return 0n;
  // ROUND HALF-UP, not truncate. BigInt division floors, so 10965 × 18% = 1973.7 came out
  // 1973 where the answer is 1974 — a systematic 1-minor-unit shortfall on every taxed
  // invoice. Matches the half-up convention already used by catalog/pricing.ts and the MRR
  // maths in subscriptions/service.ts.
  // NB the evidence is one .7 case, which any nearest-rounding satisfies; half-up vs
  // half-even would need a case landing exactly on .5 to distinguish.
  return componentTotalsFor(resolution, baseMinor, lineAmounts).reduce((s, v) => s + v, 0n);
}

/**
 * Which components apply, given the regime and whether the supply is intra-state.
 * Outside a `gst` regime `appliesTo` is meaningless, so only `both` components count —
 * the API refuses to store intra/inter components on a non-GST region, so this cannot
 * silently drop a configured rate.
 */
function selectComponents<T extends { appliesTo: string }>(
  rows: T[],
  regime: TaxRegime,
  intra: boolean,
): T[] {
  if (regime !== "gst") return rows.filter((c) => c.appliesTo === "both");
  const want = intra ? "intra" : "inter";
  return rows.filter((c) => c.appliesTo === want || c.appliesTo === "both");
}

/**
 * Built-in provider: resolve the component vector from the configured regions.
 *
 * The decision, in order:
 *   1. customer exempt                        → zero, `customer_exempt`
 *   2. no country, or no enabled region       → zero, `no_rate`
 *   3. treatment `*_zero_rated`               → zero, `zero_rated` + region note
 *   4. treatment `reverse_charge`             → zero, `reverse_charge` + region note
 *   5. treatment `*_igst`                     → force INTER-state components
 *   6. otherwise, GST regime                  → intra when seller state === place of
 *      supply, else inter; non-GST regimes take their `both` components
 *
 * Steps 3–5 honour the customer's explicit classification even if the region has since
 * disabled that treatment. Write-time validation is what prevents the inconsistent
 * state; silently re-taxing a classified SEZ customer at the standard rate because a
 * config toggle flipped would change money without anyone asking for it.
 */
export class RateTableTaxProvider implements TaxProvider {
  readonly key = "rate_table";

  async resolve(input: TaxInput): Promise<TaxResolution> {
    if (input.customerExempt) return zeroResolution("customer_exempt");
    if (!input.country) return zeroResolution("no_rate");
    const country = input.country.toUpperCase();
    const treatment: TaxTreatment = (input.treatment as TaxTreatment) ?? "default";
    // Fold to the canonical code before comparing. An imported customer carries the
    // source's Indian codes (`OD` Odisha, `TS` Telangana, …) while a rate configured
    // through our own picker stores ISO (`OR`, `TG`). Without the fold
    // they never match, the component never applies, and the tax is silently 0.
    const placeOfSupply = normalizeStateCode(country, input.stateCode);

    const cb = input.customerTaxBehavior;
    const customerBehavior: TaxResolution["customerBehavior"] =
      cb === "inclusive" || cb === "exclusive" ? cb : null;

    return withTenant(input.organizationId, async (tx) => {
      const [biz] = await tx
        .select({ taxSettings: businesses.taxSettings })
        .from(businesses)
        .where(eq(businesses.id, input.businessId))
        .limit(1);
      const rounding = resolveTaxSettings(biz?.taxSettings).rounding;
      // The region for this country under the line's profile; fall back to the
      // business default profile when the product names none.
      const regionRows = await tx
        .select({ region: taxRegions, profileIsDefault: taxProfiles.isDefault })
        .from(taxRegions)
        .innerJoin(taxProfiles, eq(taxProfiles.id, taxRegions.taxProfileId))
        .where(
          and(
            eq(taxRegions.businessId, input.businessId),
            eq(taxRegions.country, country),
            eq(taxRegions.enabled, true),
            eq(taxProfiles.active, true),
            input.taxProfileId
              ? eq(taxRegions.taxProfileId, input.taxProfileId)
              : eq(taxProfiles.isDefault, true),
          ),
        )
        // A profile-specific region wins over the default profile's.
        .orderBy(asc(taxProfiles.isDefault));

      const region = regionRows[0]?.region;
      if (!region) return zeroResolution("no_rate", { rounding, customerBehavior });

      const regime = (region.regime as TaxRegime) ?? "flat";
      const priceType =
        region.priceType === "inclusive" ? ("inclusive" as const) : ("exclusive" as const);
      const sellerState = normalizeStateCode(country, region.homeStateCode);

      // The seller's registration for the supplying state, else the region-wide one.
      // India requires the GSTIN of the state making the supply on the invoice.
      const stateReg = sellerState
        ? (
            await tx
              .select()
              .from(taxStateRegistrations)
              .where(
                and(
                  eq(taxStateRegistrations.taxRegionId, region.id),
                  eq(taxStateRegistrations.stateCode, sellerState),
                ),
              )
              .limit(1)
          )[0]
        : undefined;

      const common = {
        sellerStateCode: sellerState,
        placeOfSupplyCode: placeOfSupply,
        treatment,
        // The invoice snapshots this, so it states what the lines actually were.
        priceType: customerBehavior ?? priceType,
        rounding,
        customerBehavior,
        regime,
        regionId: region.id,
        registrationNumber: stateReg?.registrationNumber ?? region.registrationNumber ?? null,
        registrationLabel: region.registrationLabel ?? null,
      };

      // Zero-rating treatments: no components, an explicit reason, and the note the
      // region configured for exactly this case.
      if (treatment === "sez_zero_rated" || treatment === "export_zero_rated") {
        const note =
          treatment === "sez_zero_rated" ? region.sezZeroRatedNote : region.exportZeroRatedNote;
        return zeroResolution("zero_rated", { ...common, intraState: null, taxNote: note ?? null });
      }
      if (treatment === "reverse_charge") {
        // The note prints only when the region asks for it — the switch is separate
        // from the text — so an enabled reverse charge with the note hidden
        // still zero-rates — it just says nothing on the invoice.
        const note = region.showReverseChargeNote ? region.reverseChargeNote : null;
        return zeroResolution("reverse_charge", {
          ...common,
          intraState: null,
          taxNote: note ?? null,
        });
      }

      // IGST treatments force an inter-state supply regardless of the addresses.
      const forcedInter = treatment === "sez_igst" || treatment === "export_igst";
      const intra = forcedInter
        ? false
        : regime === "gst" && !!sellerState && !!placeOfSupply && sellerState === placeOfSupply;

      // A per-state override vector wins over the region default; keyed on the PLACE
      // OF SUPPLY, which is the state whose rate the supply attracts.
      const all = await tx
        .select()
        .from(taxRateComponents)
        .where(eq(taxRateComponents.taxRegionId, region.id))
        .orderBy(asc(taxRateComponents.sortOrder), asc(taxRateComponents.name));
      // Compare folded on BOTH sides: a component row may predate the validation
      // below and still hold a non-ISO code.
      const override = placeOfSupply
        ? all.filter((c) => normalizeStateCode(country, c.stateCode) === placeOfSupply)
        : [];
      const vector = override.length > 0 ? override : all.filter((c) => c.stateCode === null);

      const chosen = selectComponents(vector, regime, intra);
      const components: TaxComponent[] = chosen.map((c) => ({
        name: c.name,
        rateBps: c.rateBps,
        taxComponentId: c.id,
      }));
      const totalRateBps = components.reduce((s, c) => s + c.rateBps, 0);

      if (components.length === 0 || totalRateBps <= 0) {
        return zeroResolution("no_rate", {
          ...common,
          intraState: regime === "gst" ? intra : null,
        });
      }

      const note =
        treatment === "sez_igst"
          ? region.sezIgstNote
          : treatment === "export_igst"
            ? region.exportIgstNote
            : null;
      return {
        key: [
          region.id,
          treatment,
          intra ? "intra" : "inter",
          components.map((c) => `${c.taxComponentId}`).join("+"),
          rounding,
        ].join("|"),
        components,
        totalRateBps,
        taxabilityReason: "standard_rated",
        taxNote: note ?? null,
        intraState: regime === "gst" ? intra : null,
        ...common,
      };
    });
  }

  // Rate table owns the math — nothing to commit/reverse at an external provider.
  async record(ref: string): Promise<string> {
    return `rate_table:${ref}`;
  }
  async revert(transactionId: string): Promise<string> {
    return transactionId;
  }
  async backfill(ref: string): Promise<string> {
    return `rate_table:${ref}`;
  }
}

/**
 * External-provider scaffolds (Stripe Tax, Avalara). Real calls need credentials; until
 * configured they throw a clear error — the seam + interface are in place so the engine
 * never changes when a live provider is wired (like the payment providers).
 */
export class StripeTaxProvider implements TaxProvider {
  readonly key = "stripe_tax";
  async resolve(): Promise<TaxResolution> {
    throw new TaxError(
      "Stripe Tax is not configured. Set the Stripe Tax credentials on the business.",
    );
  }
}
export class AvalaraTaxProvider implements TaxProvider {
  readonly key = "avalara";
  async resolve(): Promise<TaxResolution> {
    throw new TaxError("Avalara is not configured. Set the Avalara credentials on the business.");
  }
}

// Provider registry — factory selects by key; default is the built-in rate table.
const PROVIDERS: Record<string, TaxProvider> = {
  rate_table: new RateTableTaxProvider(),
  stripe_tax: new StripeTaxProvider(),
  avalara: new AvalaraTaxProvider(),
};

/**
 * Resolve the tax provider for a business. Defaults to the built-in `rate_table`. A
 * business can opt into an external provider by passing its key (only `rate_table` is
 * live today; others are scaffolded).
 */
export function getTaxProvider(key?: string | null): TaxProvider {
  return PROVIDERS[key ?? "rate_table"] ?? PROVIDERS.rate_table!;
}

/**
 * Regimes of each business's LIVE tax regions (enabled region under an active profile, the
 * same filter the engine resolves with). Drives the address field locks (0334).
 */
export async function liveTaxRegimesTx(
  tx: Tx,
  businessIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(businessIds.map((id) => [id, []]));
  if (businessIds.length === 0) return out;
  const rows = await tx
    .selectDistinct({ businessId: taxRegions.businessId, regime: taxRegions.regime })
    .from(taxRegions)
    .innerJoin(taxProfiles, eq(taxProfiles.id, taxRegions.taxProfileId))
    .where(
      and(
        inArray(taxRegions.businessId, [...businessIds]),
        eq(taxRegions.enabled, true),
        eq(taxProfiles.active, true),
      ),
    );
  for (const r of rows) out.get(r.businessId)?.push(r.regime);
  return out;
}

export async function liveTaxRegimes(
  organizationId: string,
  businessIds: readonly string[],
): Promise<Map<string, string[]>> {
  return withTenant(organizationId, (tx) => liveTaxRegimesTx(tx, businessIds));
}

/* ────────────────────────────── configuration CRUD ────────────────────────────── */

/** The business's default profile, created on first use so callers never see null. */
export async function ensureDefaultTaxProfile(
  organizationId: string,
  businessId: string,
): Promise<typeof taxProfiles.$inferSelect> {
  return withTenant(organizationId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(taxProfiles)
      .where(and(eq(taxProfiles.businessId, businessId), eq(taxProfiles.isDefault, true)))
      .limit(1);
    if (existing) return existing;
    const [row] = await tx
      .insert(taxProfiles)
      .values({
        organizationId,
        businessId,
        publicId: publicId("txp"),
        name: "Primary",
        isDefault: true,
      })
      .returning();
    return row!;
  });
}

export async function createTaxProfile(input: {
  organizationId: string;
  businessId: string;
  name: string;
  isDefault?: boolean;
}): Promise<typeof taxProfiles.$inferSelect> {
  return withTenant(input.organizationId, async (tx) => {
    // Only one default per business (partial unique index); demote the incumbent
    // rather than letting the insert fail with a constraint error.
    if (input.isDefault) {
      await tx
        .update(taxProfiles)
        .set({ isDefault: false })
        .where(and(eq(taxProfiles.businessId, input.businessId), eq(taxProfiles.isDefault, true)));
    }
    const [row] = await tx
      .insert(taxProfiles)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        publicId: publicId("txp"),
        name: input.name,
        isDefault: input.isDefault ?? false,
      })
      .returning();
    return row!;
  });
}

export async function listTaxProfiles(
  organizationId: string,
  businessId: string,
): Promise<Array<typeof taxProfiles.$inferSelect>> {
  return withTenant(organizationId, async (tx) =>
    tx
      .select()
      .from(taxProfiles)
      .where(eq(taxProfiles.businessId, businessId))
      .orderBy(desc(taxProfiles.isDefault), asc(taxProfiles.name)),
  );
}

/** A region with its components and state registrations — what the config screen reads. */
export interface TaxRegionDetail {
  region: typeof taxRegions.$inferSelect;
  profile: typeof taxProfiles.$inferSelect;
  components: Array<typeof taxRateComponents.$inferSelect>;
  stateRegistrations: Array<typeof taxStateRegistrations.$inferSelect>;
}

export async function listTaxRegions(
  organizationId: string,
  businessId: string,
): Promise<TaxRegionDetail[]> {
  return withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select({ region: taxRegions, profile: taxProfiles })
      .from(taxRegions)
      .innerJoin(taxProfiles, eq(taxProfiles.id, taxRegions.taxProfileId))
      .where(eq(taxRegions.businessId, businessId))
      .orderBy(asc(taxRegions.country));
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.region.id);
    const comps = await tx
      .select()
      .from(taxRateComponents)
      .where(inArray(taxRateComponents.taxRegionId, ids))
      .orderBy(asc(taxRateComponents.sortOrder), asc(taxRateComponents.name));
    const regs = await tx
      .select()
      .from(taxStateRegistrations)
      .where(inArray(taxStateRegistrations.taxRegionId, ids))
      .orderBy(asc(taxStateRegistrations.stateCode));
    return rows.map((r) => ({
      region: r.region,
      profile: r.profile,
      components: comps.filter((c) => c.taxRegionId === r.region.id),
      stateRegistrations: regs.filter((s) => s.taxRegionId === r.region.id),
    }));
  });
}

export async function getTaxRegion(
  organizationId: string,
  businessId: string,
  regionPublicId: string,
): Promise<TaxRegionDetail | null> {
  const all = await listTaxRegions(organizationId, businessId);
  return all.find((r) => r.region.publicId === regionPublicId) ?? null;
}

export async function createTaxRegion(input: {
  organizationId: string;
  businessId: string;
  country: string;
  regime?: TaxRegime;
  priceType?: "exclusive" | "inclusive";
  taxProfileId?: string | null;
  homeStateCode?: string | null;
  registrationLabel?: string | null;
  registrationNumber?: string | null;
}): Promise<typeof taxRegions.$inferSelect> {
  const country = input.country.toUpperCase();
  // Validated, not merely upper-cased: an unrecognised home state means the seller
  // has no place of supply, so every GST supply silently resolves inter-state.
  const homeStateCode = requireStateCode(country, input.homeStateCode);
  const profile = input.taxProfileId
    ? { id: input.taxProfileId }
    : await ensureDefaultTaxProfile(input.organizationId, input.businessId);
  return withTenant(input.organizationId, async (tx) => {
    const [row] = await tx
      .insert(taxRegions)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        taxProfileId: profile.id,
        publicId: publicId("txg"),
        country,
        regime: input.regime ?? "flat",
        priceType: input.priceType ?? "exclusive",
        homeStateCode,
        registrationLabel: input.registrationLabel ?? null,
        registrationNumber: input.registrationNumber ?? null,
      })
      .returning();
    return row!;
  });
}

/** Region-level settings edit. Only the keys present are written. */
export async function updateTaxRegion(input: {
  organizationId: string;
  businessId: string;
  regionPublicId: string;
  patch: Partial<{
    regime: TaxRegime;
    priceType: "exclusive" | "inclusive";
    homeStateCode: string | null;
    registrationLabel: string | null;
    registrationNumber: string | null;
    collectRegistrationNumber: boolean;
    reverseChargeEnabled: boolean;
    showReverseChargeNote: boolean;
    reverseChargeNote: string | null;
    sezIgstEnabled: boolean;
    sezIgstNote: string | null;
    sezZeroRatedEnabled: boolean;
    sezZeroRatedNote: string | null;
    exportIgstEnabled: boolean;
    exportIgstNote: string | null;
    exportZeroRatedEnabled: boolean;
    exportZeroRatedNote: string | null;
    enabled: boolean;
  }>;
}): Promise<typeof taxRegions.$inferSelect | null> {
  const set: Record<string, unknown> = { ...input.patch };
  return withTenant(input.organizationId, async (tx) => {
    const where = and(
      eq(taxRegions.businessId, input.businessId),
      eq(taxRegions.publicId, input.regionPublicId),
    );
    // The home state is validated against the REGION's country, so it has to be
    // read first — the patch never carries a country of its own.
    if (typeof set.homeStateCode === "string" || set.homeStateCode === null) {
      const [current] = await tx.select().from(taxRegions).where(where).limit(1);
      if (!current) return null;
      set.homeStateCode = requireStateCode(current.country, set.homeStateCode as string | null);
    }
    if (Object.keys(set).length === 0) {
      const [r] = await tx.select().from(taxRegions).where(where).limit(1);
      return r ?? null;
    }
    const [r] = await tx.update(taxRegions).set(set).where(where).returning();
    return r ?? null;
  });
}

/**
 * Replace a region's component vector for one state scope in a single transaction —
 * the config screen edits the whole vector at once (CGST + SGST + Cess), and a
 * partial write would leave a region taxing at a rate nobody chose.
 *
 * `stateCode` null = the region default vector; a value = that state's override.
 * Non-GST regimes may only carry `both` components: `selectComponents` ignores
 * intra/inter outside a GST regime, so storing one would silently tax nothing.
 */
export async function setTaxRateComponents(input: {
  organizationId: string;
  businessId: string;
  regionPublicId: string;
  stateCode?: string | null;
  components: Array<{ name: string; rateBps: number; appliesTo?: AppliesTo }>;
}): Promise<Array<typeof taxRateComponents.$inferSelect>> {
  const names = input.components.map((c) => c.name.trim());
  if (names.some((n) => n.length === 0)) throw new TaxError("component name cannot be blank");
  if (new Set(names).size !== names.length)
    throw new TaxError("component names must be unique within a state scope");
  for (const c of input.components) {
    if (!Number.isInteger(c.rateBps) || c.rateBps < 0 || c.rateBps > 100_00)
      throw new TaxError(
        `rate_bps must be an integer from 0 to 10000 (0–100%). The value is ${c.rateBps}.`,
      );
    if (c.appliesTo && !APPLIES_TO.includes(c.appliesTo))
      throw new TaxError(`applies_to must be one of ${APPLIES_TO.join(" | ")}`);
  }

  return withTenant(input.organizationId, async (tx) => {
    const [region] = await tx
      .select()
      .from(taxRegions)
      .where(
        and(
          eq(taxRegions.businessId, input.businessId),
          eq(taxRegions.publicId, input.regionPublicId),
        ),
      )
      .limit(1);
    if (!region) throw new TaxError(`no such tax region: ${input.regionPublicId}`);
    // Validated against the REGION's country — an override scoped to a state that
    // country does not have can never be selected, so it would be a rate nobody
    // is ever charged, sitting in the UI looking configured.
    const stateCode = requireStateCode(region.country, input.stateCode ?? null);
    const regime = (region.regime as TaxRegime) ?? "flat";
    if (regime !== "gst" && input.components.some((c) => (c.appliesTo ?? "both") !== "both")) {
      throw new TaxError(
        `A ${regime} region can have only 'both' components. intra and inter are GST place-of-supply concepts, so we would never apply them.`,
      );
    }

    await tx
      .delete(taxRateComponents)
      .where(
        and(
          eq(taxRateComponents.taxRegionId, region.id),
          stateCode === null
            ? isNull(taxRateComponents.stateCode)
            : eq(taxRateComponents.stateCode, stateCode),
        ),
      );
    if (input.components.length === 0) return [];
    return tx
      .insert(taxRateComponents)
      .values(
        input.components.map((c, i) => ({
          organizationId: input.organizationId,
          businessId: input.businessId,
          taxRegionId: region.id,
          publicId: publicId("txc"),
          stateCode,
          name: c.name.trim(),
          rateBps: c.rateBps,
          appliesTo: c.appliesTo ?? "both",
          sortOrder: i,
        })),
      )
      .returning();
  });
}

/** Upsert one state's seller registration — the "Add State tax" registration-number half. */
export async function upsertTaxStateRegistration(input: {
  organizationId: string;
  businessId: string;
  regionPublicId: string;
  stateCode: string;
  stateName?: string | null;
  registrationNumber?: string | null;
}): Promise<typeof taxStateRegistrations.$inferSelect> {
  return withTenant(input.organizationId, async (tx) => {
    const [region] = await tx
      .select()
      .from(taxRegions)
      .where(
        and(
          eq(taxRegions.businessId, input.businessId),
          eq(taxRegions.publicId, input.regionPublicId),
        ),
      )
      .limit(1);
    if (!region) throw new TaxError(`no such tax region: ${input.regionPublicId}`);
    // A GSTIN filed against a state the country does not have is unusable: it would
    // never be picked as the supplying state's registration, so the invoice would
    // show the region-wide number instead and nobody would know why.
    const stateCode = requireStateCode(region.country, input.stateCode);
    if (!stateCode) throw new TaxError("state_code is required for a state registration");
    const [row] = await tx
      .insert(taxStateRegistrations)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        taxRegionId: region.id,
        publicId: publicId("txs"),
        stateCode,
        stateName: input.stateName ?? null,
        registrationNumber: input.registrationNumber ?? null,
      })
      .onConflictDoUpdate({
        target: [taxStateRegistrations.taxRegionId, taxStateRegistrations.stateCode],
        set: {
          stateName: input.stateName ?? null,
          registrationNumber: input.registrationNumber ?? null,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return row!;
  });
}

export async function deleteTaxStateRegistration(
  organizationId: string,
  businessId: string,
  regionPublicId: string,
  registrationPublicId: string,
): Promise<boolean> {
  return withTenant(organizationId, async (tx) => {
    // The region in the path must be the registration's own parent.
    const region = tx
      .select({ id: taxRegions.id })
      .from(taxRegions)
      .where(and(eq(taxRegions.businessId, businessId), eq(taxRegions.publicId, regionPublicId)));
    const rows = await tx
      .delete(taxStateRegistrations)
      .where(
        and(
          eq(taxStateRegistrations.businessId, businessId),
          eq(taxStateRegistrations.publicId, registrationPublicId),
          inArray(taxStateRegistrations.taxRegionId, region),
        ),
      )
      .returning();
    return rows.length > 0;
  });
}

/** Enable/disable (archive) a region — the engine skips disabled regions entirely. */
export async function setTaxRegionEnabled(
  organizationId: string,
  businessId: string,
  regionPublicId: string,
  enabled: boolean,
): Promise<typeof taxRegions.$inferSelect | null> {
  return withTenant(organizationId, async (tx) => {
    const [r] = await tx
      .update(taxRegions)
      .set({ enabled })
      .where(and(eq(taxRegions.businessId, businessId), eq(taxRegions.publicId, regionPublicId)))
      .returning();
    return r ?? null;
  });
}

/**
 * Configure ONE flat component for a country under the business's default profile —
 * the shape almost every fixture and seed wants ("this business charges 20% VAT in
 * GB"). Replaces the old `createTaxRate`, which could only express a single scalar.
 *
 * Idempotent: reuses the region for (default profile, country) if it exists and
 * replaces that state scope's vector, so repeated calls cannot accumulate duplicate
 * components — the exact failure migration 0147 had to clean up.
 *
 * Deliberately NOT for India GST: a flat component taxes intra- and inter-state supply
 * identically, which is the very thing GST does not do. Use `configureIndiaGst`.
 */
export async function createFlatTaxRate(input: {
  organizationId: string;
  businessId: string;
  name: string;
  country: string;
  /**
   * Subdivision CODE, not a name — this becomes `tax_rate_components.state_code`
   * and is matched against the customer's `state_code`. Passing 'California' here
   * silently configures a rate no customer can ever match; `requireStateCode`
   * rejects it for countries we ship a list for.
   */
  state?: string | null;
  rateBps: number;
}): Promise<{
  publicId: string;
  regionPublicId: string;
  name: string;
  country: string;
  state: string | null;
  rateBps: number;
}> {
  const country = input.country.toUpperCase();
  const profile = await ensureDefaultTaxProfile(input.organizationId, input.businessId);
  const existing = await withTenant(input.organizationId, async (tx) =>
    tx
      .select()
      .from(taxRegions)
      .where(
        and(
          eq(taxRegions.businessId, input.businessId),
          eq(taxRegions.taxProfileId, profile.id),
          eq(taxRegions.country, country),
        ),
      )
      .limit(1),
  );
  const region =
    existing[0] ??
    (await createTaxRegion({
      organizationId: input.organizationId,
      businessId: input.businessId,
      country,
      regime: "flat",
      taxProfileId: profile.id,
    }));
  const [component] = await setTaxRateComponents({
    organizationId: input.organizationId,
    businessId: input.businessId,
    regionPublicId: region.publicId,
    stateCode: input.state ?? null,
    components: [{ name: input.name, rateBps: input.rateBps, appliesTo: "both" }],
  });
  return {
    publicId: component!.publicId,
    regionPublicId: region.publicId,
    name: component!.name,
    country,
    state: component!.stateCode,
    rateBps: component!.rateBps,
  };
}

/**
 * Configure a country as India-style GST in one call: a `gst` region whose default
 * vector is CGST + SGST/UTGST for intra-state supply and IGST for inter-state, plus an
 * optional Cess that applies to both.
 *
 * `cgstBps`/`sgstBps` are the intra-state halves; IGST is their SUM, which is what the
 * law requires — an inter-state supply attracts the same total, collected as one tax.
 * Deriving it rather than accepting it separately makes the two branches impossible to
 * configure inconsistently.
 */
export async function configureIndiaGst(input: {
  organizationId: string;
  businessId: string;
  country?: string;
  homeStateCode: string;
  cgstBps: number;
  sgstBps: number;
  cessBps?: number;
  registrationNumber?: string | null;
  priceType?: "exclusive" | "inclusive";
}): Promise<{
  region: typeof taxRegions.$inferSelect;
  components: Array<typeof taxRateComponents.$inferSelect>;
}> {
  const country = (input.country ?? "IN").toUpperCase();
  const profile = await ensureDefaultTaxProfile(input.organizationId, input.businessId);
  const existing = await withTenant(input.organizationId, async (tx) =>
    tx
      .select()
      .from(taxRegions)
      .where(
        and(
          eq(taxRegions.businessId, input.businessId),
          eq(taxRegions.taxProfileId, profile.id),
          eq(taxRegions.country, country),
        ),
      )
      .limit(1),
  );
  let region =
    existing[0] ??
    (await createTaxRegion({
      organizationId: input.organizationId,
      businessId: input.businessId,
      country,
      regime: "gst",
      taxProfileId: profile.id,
    }));
  const updated = await updateTaxRegion({
    organizationId: input.organizationId,
    businessId: input.businessId,
    regionPublicId: region.publicId,
    patch: {
      regime: "gst",
      homeStateCode: input.homeStateCode.toUpperCase(),
      registrationLabel: "gstin",
      registrationNumber: input.registrationNumber ?? null,
      priceType: input.priceType ?? "exclusive",
    },
  });
  region = updated ?? region;

  const cess = input.cessBps ?? 0;
  const components = await setTaxRateComponents({
    organizationId: input.organizationId,
    businessId: input.businessId,
    regionPublicId: region.publicId,
    stateCode: null,
    components: [
      { name: "CGST", rateBps: input.cgstBps, appliesTo: "intra" },
      { name: "SGST/UTGST", rateBps: input.sgstBps, appliesTo: "intra" },
      { name: "IGST", rateBps: input.cgstBps + input.sgstBps, appliesTo: "inter" },
      ...(cess > 0 ? [{ name: "Cess", rateBps: cess, appliesTo: "both" as const }] : []),
    ],
  });
  // The home state is itself a place of business, so it needs a registration row —
  // that GSTIN is what an intra-state invoice must show.
  if (input.registrationNumber) {
    await upsertTaxStateRegistration({
      organizationId: input.organizationId,
      businessId: input.businessId,
      regionPublicId: region.publicId,
      stateCode: input.homeStateCode,
      registrationNumber: input.registrationNumber,
    });
  }
  return { region, components };
}

/**
 * Which treatments a customer in this region may be given, derived from the region's
 * own gates. The customer form must render exactly these — offering a treatment the
 * region has not enabled would be a control that cannot be honoured.
 */
export function allowedTreatments(region: typeof taxRegions.$inferSelect): TaxTreatment[] {
  const out: TaxTreatment[] = ["default"];
  if (region.sezIgstEnabled) out.push("sez_igst");
  if (region.sezZeroRatedEnabled) out.push("sez_zero_rated");
  if (region.exportIgstEnabled) out.push("export_igst");
  if (region.exportZeroRatedEnabled) out.push("export_zero_rated");
  if (region.reverseChargeEnabled) out.push("reverse_charge");
  return out;
}

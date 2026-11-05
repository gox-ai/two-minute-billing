import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import { planPage, finishPage, type CatalogPageRequest } from "@/modules/catalog/paging";
import { customAlphabet } from "nanoid";
import { withTenant, withTenantTx, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { businessWallClock } from "@/platform/clock";
import { emitEvent, emitOrDefer, type DeferredEvents } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import {
  coupons,
  appliedCoupons,
  couponItemConstraints,
  subscriptionItems,
  couponSets,
  couponSetCodes,
  prices,
  products,
  customers,
  invoiceLineDiscounts,
  invoiceLineItems,
  invoices,
  creditNotes,
  creditNoteItems,
  creditNoteDiscounts,
  subscriptions,
} from "@db/schema";
import {
  clampLimit,
  countExpr,
  keysetCondition,
  parseCursor,
  toPage,
  type FilterSpec,
  type ListPage,
} from "@/platform/list-query";
import { slugify, validateSlug, insertOrSlugConflict } from "@/modules/catalog/service";
import { recomputeSubscriptionMrr } from "@/modules/subscriptions/service";
import type { StoredSubscriptionStatus } from "@/modules/subscriptions/serialize";
import { createLogger } from "@/platform/logger";
import { auditRowChange, writeAuditLog } from "@/modules/audit/service";

const log = createLogger("coupons");

export class CouponError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CouponError";
  }
}

/**
 * A term fraction expressed as an exact bigint ratio (never a float — money is
 * integer minor units, and a `number` factor would reintroduce the rounding drift
 * this codebase's other proration math (`subscriptions/proration.ts#prorate`)
 * deliberately avoids by staying in milliseconds-as-bigint throughout).
 */
export interface ProrationFactor {
  /** The part of the full term this invoice actually covers (e.g. ms remaining). */
  numerator: bigint;
  /** The full term (e.g. ms in the whole period). Must be > 0 to take effect. */
  denominator: bigint;
}

/**
 * Pure discount math. Percentage = floor(subtotal × bps / 10000); fixed = the
 * amount off. Always clamped to [0, subtotal] (never negative, never more than
 * the bill). Exported for unit tests.
 *
 * `invoiceCurrency` guards fixed-amount coupons: a fixed coupon only applies when
 * its currency matches the invoice currency (a $10 coupon must NOT subtract €10).
 * Percentage coupons are currency-agnostic.
 *
 * `prorationFactor` (0243 — business opt-in via
 * `businesses.prorate_fixed_amount_coupons`) scales a FIXED coupon's amount-off to
 * the fraction of the full term an invoice actually covers, so a mid-term proration
 * invoice doesn't take the whole coupon off a partial bill. Applied ONLY to the
 * fixed_amount branch — a percentage coupon already scales naturally with
 * `subtotalMinor`, which is why the toggle is fixed-amount-only. Rounds half-up,
 * same convention as `prorate`. Omitted (the
 * default) → today's behaviour exactly: the full amount, unscaled. The caller
 * computes the factor; this function stays pure and knows nothing about terms.
 */
export function computeDiscount(
  coupon: {
    kind: string;
    percentOffBps?: number | null;
    amountOffMinor?: bigint | null;
    currency?: string | null;
  },
  subtotalMinor: bigint,
  invoiceCurrency?: string,
  prorationFactor?: ProrationFactor,
): bigint {
  if (subtotalMinor <= 0n) return 0n;
  let d: bigint;
  if (coupon.kind === "percentage") {
    d = (subtotalMinor * BigInt(coupon.percentOffBps ?? 0)) / 10000n;
  } else {
    // Fixed-amount: currency must match (when both are known), else no discount.
    if (
      invoiceCurrency != null &&
      coupon.currency != null &&
      coupon.currency.toUpperCase() !== invoiceCurrency.toUpperCase()
    ) {
      return 0n;
    }
    d = coupon.amountOffMinor ?? 0n;
    if (prorationFactor != null && prorationFactor.denominator > 0n) {
      const num = prorationFactor.numerator > 0n ? prorationFactor.numerator : 0n;
      const den = prorationFactor.denominator;
      // Round half-up (never over-scale down to 0 on a tiny remainder), mirroring
      // `subscriptions/proration.ts#prorate`'s rounding so the two agree.
      d = (d * num + den / 2n) / den;
    }
  }
  if (d < 0n) return 0n;
  return d > subtotalMinor ? subtotalMinor : d;
}

// ── CAT-1/CAT-2: coupon stacking (many coupons per subscription) ──────────────

/** CAT-2: per-item-kind scoping row for an each_specified_item coupon. */
export interface CouponConstraint {
  itemKind: string; // plan | addon | charge
  constraintType: string; // all | specific | none
  productIds?: string[] | null; // product slug ids (for 'specific')
  /** Price slug ids (for 'specific'); a line matches on its product OR its price. */
  priceIds?: string[] | null;
}

/** A coupon in a stack, with the fields the ordering + math need. */
export interface StackCoupon {
  appliedCouponId: string;
  couponPublicId: string;
  kind: string;
  percentOffBps?: number | null;
  amountOffMinor?: bigint | null;
  currency?: string | null;
  /** CAT-2: invoice_amount (whole invoice) | each_specified_item (matched lines only). */
  applyOn?: string;
  /** CAT-2: item constraints (only consulted for each_specified_item coupons). */
  constraints?: CouponConstraint[];
  /** CAT-5: invoice-line label (falls back to the code). */
  invoiceName?: string | null;
  createdAt: Date;
}
/** One invoice line, for discount matching + per-line attribution. */
export interface DiscountLine {
  index: number;
  amountMinor: bigint; // positive line subtotal contribution
  productKind?: string | null; // plan | addon | charge
  productPublicId?: string | null; // product slug id
  pricePublicId?: string | null; // price slug id, for price-scoped constraints
}
export interface DiscountRow {
  appliedCouponId: string;
  couponPublicId: string;
  /** CAT-5: display label for the invoice discount line (invoice_name ?? code). */
  label: string;
  discountMinor: bigint;
  /**
   * The part of `discountMinor` that came from the DOCUMENT-level stage.
   *
   * One coupon can contribute to both stages, so this is not derivable from the coupon's
   * `applyOn`: only the document-level part still needs an aggregate `kind='discount'`
   * line, because the item-level part is already inside `invoices.subtotalMinor` (0169).
   * Emitting a row for the whole `discountMinor` would subtract the item-level part twice.
   */
  documentLevelMinor: bigint;
}

/**
 * One coupon's discount attributed to one line, tagged with the waterfall stage —
 * the shape `invoice_line_discounts` stores.
 *
 * `lineIndex` is the caller's index into the `lines` array it passed in; the caller owns
 * the mapping to real line-item ids, since it is the one inserting them.
 */
export interface DiscountShare {
  lineIndex: number;
  appliedCouponId: string;
  label: string;
  /** item_level nets INTO the subtotal; document_level applies TO it. */
  scope: "item_level" | "document_level";
  /** Always positive. */
  amountMinor: bigint;
}

/**
 * The full result of stacking coupons over an invoice's lines.
 *
 * Named rather than inlined because `peekDiscounts` spreads it straight through: two
 * hand-copied structural types drifted the moment one of them gained a field.
 */
export interface DiscountStack {
  rows: DiscountRow[];
  /** Every coupon's discount, both stages — what gets BOOKED. */
  totalMinor: bigint;
  /** The document-level stage: applied TO the subtotal, so it still needs its own line. */
  invoiceLevelMinor: bigint;
  /**
   * The item-level stage: `Σ lineDiscountByIndex`, and the amount that comes OFF the
   * stored `invoices.subtotalMinor` (0169). Returned rather than
   * re-summed per call site so the subtotal has exactly one definition.
   */
  itemLevelMinor: bigint;
  /** Item-level attribution per line — line-accurate, drives both tax and the subtotal. */
  lineDiscountByIndex: bigint[];
  /**
   * Invoice-level discount attributed per line — the proportional spread this function
   * has always computed (it drives the tax base) but used to throw away.
   *
   * Document-level discounts are attributed down to lines too — but they leave the
   * SUBTOTAL untouched. So this is NOT part of `lineDiscountByIndex` (which is what nets
   * into the subtotal); the two are separate questions and the invoice document needs
   * both.
   */
  invoiceLevelByIndex: bigint[];
  /** Every share, keyed to its coupon and stage — the `invoice_line_discounts` rows (0169). */
  shares: DiscountShare[];
}

/** Does an each_specified_item coupon apply to this line? (kind + product match) */
function couponMatchesLine(c: StackCoupon, line: DiscountLine): boolean {
  const kind = line.productKind;
  if (!kind) return false;
  const con = (c.constraints ?? []).find((k) => k.itemKind === kind);
  if (!con) return false; // no rule for this kind → not eligible (implicit 'none')
  if (con.constraintType === "all") return true;
  if (con.constraintType === "specific") {
    const ids = Array.isArray(con.productIds) ? con.productIds : [];
    const priceIds = Array.isArray(con.priceIds) ? con.priceIds : [];
    return (
      (line.productPublicId != null && ids.includes(line.productPublicId)) ||
      (line.pricePublicId != null && priceIds.includes(line.pricePublicId))
    );
  }
  return false; // 'none'
}

/**
 * Distribute `amount` across `weights` proportionally (largest-remainder), never
 * exceeding a bucket's weight, summing EXACTLY to min(amount, Σweights). Used to
 * spread a fixed-amount / invoice-level discount across the lines it reduces.
 */
function distributeProportional(amount: bigint, weights: bigint[]): bigint[] {
  const out = weights.map(() => 0n);
  const total = weights.reduce((s, w) => s + (w > 0n ? w : 0n), 0n);
  if (amount <= 0n || total <= 0n) return out;
  const capped = amount > total ? total : amount;
  const parts = weights.map((w, i) => {
    const wpos = w > 0n ? w : 0n;
    const exact = wpos * capped;
    const floor = exact / total;
    return { i, amount: floor, frac: exact - floor * total, cap: wpos };
  });
  let remainder = capped - parts.reduce((s, p) => s + p.amount, 0n);
  parts.sort((a, b) => (b.frac > a.frac ? 1 : b.frac < a.frac ? -1 : 0));
  for (let k = 0; k < parts.length && remainder > 0n; k++) {
    if (parts[k]!.amount < parts[k]!.cap) {
      parts[k]!.amount += 1n;
      remainder -= 1n;
    }
  }
  for (const p of parts) out[p.i] = p.amount;
  return out;
}

/**
 * Coupon-application order (deterministic): line-level fixed → line-level % →
 * invoice-level fixed → invoice-level %, and within a class OLDEST applied first.
 * Each coupon discounts the RUNNING already-reduced amount (sequential — a % after
 * a fixed takes its cut of the reduced balance).
 *
 * `each_specified_item` (line-level) coupons discount ONLY their matched lines,
 * per line (line-accurate). `invoice_amount` coupons discount the whole running
 * invoice and are spread proportionally across all lines. The result carries both
 * a per-coupon total (for the discount line item + redemption) and the per-line
 * line-level attribution + the invoice-level total, so the tax pass can be
 * line-accurate for line-level discounts while keeping invoice-level proportional.
 *
 * ── THE TWO STAGES ARE A REPORTING DISTINCTION TOO (0169) ─────────────────────
 * The split above was internal, for tax. It is now also what `invoices.subtotalMinor`
 * means: the ITEM-level stage nets INTO the subtotal, the DOCUMENT-level stage applies
 * TO it. So `itemLevelMinor` comes off the stored subtotal while `invoiceLevelMinor`
 * remains an aggregate discount line beneath it. `shares` carries every (line, coupon,
 * stage) triple — both stages are attributed to lines; attribution and stage are
 * independent questions.
 *
 * None of this moves money: `totalMinor` is unchanged, and the total, tax and every
 * ledger posting derive from it.
 */
export function computeStackedDiscounts(
  coupons: StackCoupon[],
  lines: DiscountLine[],
  invoiceCurrency?: string,
): DiscountStack {
  const running = lines.map((l) => (l.amountMinor > 0n ? l.amountMinor : 0n));
  const lineDisc = lines.map(() => 0n); // line-level (each_specified_item) attribution only
  const invoiceLevelDisc = lines.map(() => 0n); // invoice-level, spread proportionally
  const shares: DiscountShare[] = [];
  let invoiceLevelMinor = 0n;
  const perCoupon = new Map<string, bigint>();
  const addShare = (
    lineIndex: number,
    c: StackCoupon,
    scope: DiscountShare["scope"],
    amountMinor: bigint,
  ) => {
    // Zero shares are not recorded: a line a coupon did not touch gets no row, and a table
    // full of 0s would make "did this coupon reduce this line" a comparison rather than a
    // lookup.
    if (amountMinor <= 0n) return;
    shares.push({
      lineIndex,
      appliedCouponId: c.appliedCouponId,
      label: c.invoiceName || c.couponPublicId,
      scope,
      amountMinor,
    });
  };

  const isLine = (c: StackCoupon) => (c.applyOn ?? "invoice_amount") === "each_specified_item";
  // Class order: line-fixed(0) → line-%(1) → invoice-fixed(2) → invoice-%(3).
  const cls = (c: StackCoupon) => (isLine(c) ? 0 : 2) + (c.kind === "percentage" ? 1 : 0);
  const ordered = [...coupons].sort(
    (a, b) => cls(a) - cls(b) || a.createdAt.getTime() - b.createdAt.getTime(),
  );

  for (const c of ordered) {
    let couponDiscount = 0n;
    if (isLine(c)) {
      const matched = lines
        .map((l, i) => i)
        .filter((i) => running[i]! > 0n && couponMatchesLine(c, lines[i]!));
      if (c.kind === "percentage") {
        for (const i of matched) {
          const d = computeDiscount(c, running[i]!, invoiceCurrency);
          running[i]! -= d;
          lineDisc[i]! += d;
          couponDiscount += d;
          addShare(i, c, "item_level", d);
        }
      } else {
        // Fixed line-level: apply to the matched subset total, distributed per line.
        const weights = matched.map((i) => running[i]!);
        const matchedTotal = weights.reduce((s, w) => s + w, 0n);
        const perLine = distributeProportional(
          computeDiscount(c, matchedTotal, invoiceCurrency),
          weights,
        );
        matched.forEach((i, k) => {
          running[i]! -= perLine[k]!;
          lineDisc[i]! += perLine[k]!;
          couponDiscount += perLine[k]!;
          addShare(i, c, "item_level", perLine[k]!);
        });
      }
    } else {
      // Invoice-level: discount the whole remaining invoice, spread proportionally.
      const weights = running.slice();
      const invoiceRunning = weights.reduce((s, w) => s + w, 0n);
      const d = invoiceRunning > 0n ? computeDiscount(c, invoiceRunning, invoiceCurrency) : 0n;
      const perLine = distributeProportional(d, weights);
      for (let i = 0; i < running.length; i++) {
        running[i]! -= perLine[i]!;
        // Attributed to the line, but NOT into `lineDisc` — this stage applies to the
        // subtotal rather than inside it. See `invoiceLevelByIndex`.
        invoiceLevelDisc[i]! += perLine[i]!;
        addShare(i, c, "document_level", perLine[i]!);
      }
      couponDiscount = d;
      invoiceLevelMinor += d;
    }
    perCoupon.set(c.appliedCouponId, (perCoupon.get(c.appliedCouponId) ?? 0n) + couponDiscount);
  }

  const docLevelPerCoupon = new Map<string, bigint>();
  for (const s of shares) {
    if (s.scope !== "document_level") continue;
    docLevelPerCoupon.set(
      s.appliedCouponId,
      (docLevelPerCoupon.get(s.appliedCouponId) ?? 0n) + s.amountMinor,
    );
  }
  const rows: DiscountRow[] = coupons.map((c) => ({
    appliedCouponId: c.appliedCouponId,
    couponPublicId: c.couponPublicId,
    label: c.invoiceName || c.couponPublicId,
    discountMinor: perCoupon.get(c.appliedCouponId) ?? 0n,
    documentLevelMinor: docLevelPerCoupon.get(c.appliedCouponId) ?? 0n,
  }));
  const itemLevelMinor = lineDisc.reduce((s, d) => s + d, 0n);
  const totalMinor = invoiceLevelMinor + itemLevelMinor;
  return {
    rows,
    totalMinor,
    invoiceLevelMinor,
    itemLevelMinor,
    lineDiscountByIndex: lineDisc,
    invoiceLevelByIndex: invoiceLevelDisc,
    shares,
  };
}

export async function createCoupon(input: {
  organizationId: string;
  businessId: string;
  code: string;
  name?: string;
  kind: "percentage" | "fixed_amount";
  percentOffBps?: number;
  amountOffMinor?: number;
  currency?: string;
  durationType?: "once" | "forever" | "repeating";
  durationInPeriods?: number;
  maxRedemptions?: number;
  /** Redemptions allowed per customer, across their subscriptions. */
  maxRedemptionsPerCustomer?: number;
  redeemBy?: Date;
  validFrom?: Date;
  invoiceName?: string;
  /** CAT-2: invoice_amount (default) | each_specified_item. */
  applyOn?: "invoice_amount" | "each_specified_item";
  /** Caller's own key/values, stored verbatim and returned by the API. */
  metadata?: Record<string, unknown> | null;
  /** CAT-2: per-item-kind constraints (required for each_specified_item to match). */
  itemConstraints?: ItemConstraintInput[];
}): Promise<typeof coupons.$inferSelect> {
  if (input.kind === "percentage" && input.percentOffBps == null) {
    throw new CouponError("percentage coupon requires percent_off_bps");
  }
  if (input.kind === "fixed_amount" && input.amountOffMinor == null) {
    throw new CouponError("fixed_amount coupon requires amount_off_minor");
  }
  if (input.durationType === "repeating" && !input.durationInPeriods) {
    throw new CouponError("repeating coupon requires duration_in_periods");
  }
  return withTenant(input.organizationId, async (tx) => {
    await validatePriceScope(tx, input.businessId, input.itemConstraints);
    const [c] = await insertOrSlugConflict(
      () =>
        tx
          .insert(coupons)
          .values({
            organizationId: input.organizationId,
            businessId: input.businessId,
            code: input.code,
            name: input.name ?? null,
            kind: input.kind,
            percentOffBps: input.percentOffBps ?? null,
            amountOffMinor: input.amountOffMinor != null ? BigInt(input.amountOffMinor) : null,
            currency: input.currency?.toUpperCase() ?? null,
            durationType: input.durationType ?? "once",
            durationInPeriods: input.durationInPeriods ?? null,
            maxRedemptions: input.maxRedemptions ?? null,
            maxRedemptionsPerCustomer: input.maxRedemptionsPerCustomer ?? null,
            redeemBy: input.redeemBy ?? null,
            validFrom: input.validFrom ?? null,
            invoiceName: input.invoiceName ?? null,
            applyOn: input.applyOn ?? "invoice_amount",
            metadata: input.metadata ?? null,
          })
          .returning(),
      "Coupon",
    );
    // CAT-2: persist item constraints (one row per item kind).
    if (input.itemConstraints && input.itemConstraints.length > 0) {
      await tx.insert(couponItemConstraints).values(
        input.itemConstraints.map((k) => ({
          organizationId: input.organizationId,
          businessId: input.businessId,
          couponId: c!.id,
          itemKind: k.itemKind,
          constraintType: k.constraintType,
          productIds: k.constraintType === "specific" ? (k.productIds ?? []) : null,
          priceIds: k.constraintType === "specific" && k.priceIds?.length ? k.priceIds : null,
        })),
      );
    }
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "coupon_created",
      data: buildEventData("coupon_created", { id: c!.code, kind: c!.kind }, c!.resourceVersion),
    });
    await auditRowChange(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      action: "coupon.create",
      resourceType: "coupon",
      resourceId: c!.code,
      before: null,
      after: c!,
      extra: { id: c!.code },
    });
    return c!;
  });
}

/** One item-kind scoping row as callers pass it. */
export interface ItemConstraintInput {
  itemKind: "plan" | "addon" | "charge";
  constraintType: "all" | "specific" | "none";
  productIds?: string[];
  priceIds?: string[];
}

/**
 * `price_ids` must name prices of this business whose product is of the row's item kind —
 * a matching line needs both, so any other id could never match.
 */
async function validatePriceScope(
  tx: Tx,
  businessId: string,
  constraints?: ItemConstraintInput[],
): Promise<void> {
  for (const k of constraints ?? []) {
    if (!k.priceIds?.length) continue;
    if (k.constraintType !== "specific")
      throw new CouponError(
        `price_ids require constraint_type 'specific'. The item_kind is ${k.itemKind}.`,
      );
    const rows = await tx
      .select({ id: prices.publicId, kind: products.kind })
      .from(prices)
      .innerJoin(products, eq(prices.productId, products.id))
      .where(and(eq(prices.businessId, businessId), inArray(prices.publicId, k.priceIds)));
    const kindById = new Map(rows.map((r) => [r.id, r.kind]));
    for (const id of k.priceIds) {
      const kind = kindById.get(id);
      if (!kind) throw new CouponError(`We could not find the price ${id}.`);
      if (kind !== k.itemKind)
        throw new CouponError(`Price ${id} belongs to a ${kind}, not a ${k.itemKind}`);
    }
  }
}

// Uppercase, unambiguous alphabet for human-typeable promo codes (no 0/O/1/I).
const codeGen = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 10);

async function uniqueSetSlug(tx: any, businessId: string, base: string): Promise<string> {
  let slug = base;
  let n = 1;
  while (true) {
    const [existing] = await tx
      .select({ id: couponSets.id })
      .from(couponSets)
      .where(and(eq(couponSets.businessId, businessId), eq(couponSets.publicId, slug)))
      .limit(1);
    if (!existing) return slug;
    n++;
    slug = `${base}-${n}`;
  }
}

export interface CouponSetWithCounts {
  set: typeof couponSets.$inferSelect;
  couponPublicId: string;
  totalCount: number;
  redeemedCount: number;
  /**
   * Codes withdrawn via `archiveCouponCode` — spent, but not by a customer.
   * Counted separately because `total - redeemed` is NOT what is still
   * redeemable: `coupon_set_codes.status` has three values, and lumping
   * `archived` in with `not_redeemed` advertised withdrawn codes as available.
   */
  archivedCount: number;
  /** Still redeemable. Counted directly, never derived by subtraction. */
  notRedeemedCount: number;
}

/**
 * Create a coupon set: `count` unique single-use codes that inherit a parent
 * coupon's discount rules. Codes look like `<PREFIX->AB23CD45EF` (uppercase,
 * unambiguous). Unique per business (retries a fresh batch on the rare collision).
 */
export async function createCouponSet(input: {
  organizationId: string;
  businessId: string;
  couponId: string;
  name: string;
  count: number;
  id?: string;
  codePrefix?: string;
  metadata?: Record<string, unknown> | null;
}): Promise<CouponSetWithCounts> {
  if (input.count < 1 || input.count > 10000) {
    throw new CouponError("count must be between 1 and 10000");
  }
  const prefix = (input.codePrefix ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return withTenant(input.organizationId, async (tx) => {
    const [parent] = await tx
      .select()
      .from(coupons)
      .where(and(eq(coupons.businessId, input.businessId), eq(coupons.code, input.couponId)))
      .limit(1);
    if (!parent) throw new CouponError(`We could not find the coupon ${input.couponId}.`);
    if (!parent.active) throw new CouponError("Parent coupon is archived");

    let slug: string;
    if (input.id) {
      if (!validateSlug(input.id)) throw new CouponError(`Invalid slug format: ${input.id}`);
      slug = input.id;
    } else {
      slug = await uniqueSetSlug(tx, input.businessId, slugify(input.name));
    }

    const [set] = await insertOrSlugConflict(
      () =>
        tx
          .insert(couponSets)
          .values({
            organizationId: input.organizationId,
            businessId: input.businessId,
            couponId: parent.id,
            publicId: slug,
            name: input.name,
            metadata: input.metadata ?? null,
          })
          .returning(),
      "Coupon set",
    );

    // Generate a unique batch (dedup within the batch; DB unique index is the backstop).
    const codes = new Set<string>();
    while (codes.size < input.count) codes.add(prefix ? `${prefix}-${codeGen()}` : codeGen());
    await tx.insert(couponSetCodes).values(
      [...codes].map((code) => ({
        organizationId: input.organizationId,
        businessId: input.businessId,
        couponSetId: set!.id,
        code,
      })),
    );
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "coupon_set_created",
      data: buildEventData("coupon_set_created", {
        id: set!.publicId,
        coupon: parent.code,
        count: input.count,
      }),
    });
    await auditRowChange(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      action: "coupon_set.create",
      resourceType: "coupon_set",
      resourceId: set!.publicId,
      before: null,
      after: set!,
      extra: { coupon: parent.code, count: input.count },
    });
    return {
      set: set!,
      couponPublicId: parent.code,
      totalCount: input.count,
      redeemedCount: 0,
      archivedCount: 0,
      notRedeemedCount: input.count,
    };
  });
}

/** List a business's coupon sets with redemption counts (newest first). */
export async function listCouponSets(
  organizationId: string,
  businessId: string,
  /** false → archived sets are left out. Default true (every set). */
  opts: { includeArchived?: boolean } = {},
): Promise<CouponSetWithCounts[]> {
  const includeArchived = opts.includeArchived ?? true;
  return withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select({
        set: couponSets,
        couponPublicId: coupons.code,
        totalCount: sql<number>`count(${couponSetCodes.id})::int`,
        redeemedCount: sql<number>`(count(${couponSetCodes.id}) filter (where ${couponSetCodes.status} = 'redeemed'))::int`,
        archivedCount: sql<number>`(count(${couponSetCodes.id}) filter (where ${couponSetCodes.status} = 'archived'))::int`,
        notRedeemedCount: sql<number>`(count(${couponSetCodes.id}) filter (where ${couponSetCodes.status} = 'not_redeemed'))::int`,
      })
      .from(couponSets)
      .innerJoin(coupons, eq(couponSets.couponId, coupons.id))
      .leftJoin(couponSetCodes, eq(couponSetCodes.couponSetId, couponSets.id))
      .where(
        includeArchived
          ? eq(couponSets.businessId, businessId)
          : and(eq(couponSets.businessId, businessId), isNull(couponSets.archivedAt)),
      )
      .groupBy(couponSets.id, coupons.code)
      .orderBy(desc(couponSets.createdAt));
    return rows.map((r) => ({
      ...r,
      totalCount: Number(r.totalCount),
      redeemedCount: Number(r.redeemedCount),
      archivedCount: Number(r.archivedCount),
      notRedeemedCount: Number(r.notRedeemedCount),
    }));
  });
}

export async function getCouponSet(
  organizationId: string,
  businessId: string,
  setPublicId: string,
): Promise<CouponSetWithCounts | null> {
  const all = await listCouponSets(organizationId, businessId);
  return all.find((s) => s.set.publicId === setPublicId) ?? null;
}

/**
 * List the codes in a coupon set (optionally filtered by status), each with the public
 * id of the subscription its redemption landed on (null until redeemed).
 */
export async function listCouponSetCodes(
  organizationId: string,
  businessId: string,
  setPublicId: string,
  opts?: { status?: "not_redeemed" | "redeemed" | "archived" },
): Promise<Array<
  typeof couponSetCodes.$inferSelect & { subscriptionPublicId: string | null }
> | null> {
  return withTenant(organizationId, async (tx) => {
    const [set] = await tx
      .select()
      .from(couponSets)
      .where(and(eq(couponSets.businessId, businessId), eq(couponSets.publicId, setPublicId)))
      .limit(1);
    if (!set) return null;
    const where = opts?.status
      ? and(eq(couponSetCodes.couponSetId, set.id), eq(couponSetCodes.status, opts.status))
      : eq(couponSetCodes.couponSetId, set.id);
    return tx
      .select({ ...getTableColumns(couponSetCodes), subscriptionPublicId: subscriptions.publicId })
      .from(couponSetCodes)
      .leftJoin(appliedCoupons, eq(appliedCoupons.id, couponSetCodes.appliedCouponId))
      .leftJoin(subscriptions, eq(subscriptions.id, appliedCoupons.subscriptionId))
      .where(where)
      .orderBy(desc(couponSetCodes.createdAt));
  });
}

/**
 * CAT-6: add codes to an existing set — either `count` freshly generated codes
 * (optionally prefixed) or an explicit `codes` list. Codes are business-unique;
 * collisions are skipped. Returns the number actually inserted (null if no set).
 */
export async function addCouponSetCodes(input: {
  organizationId: string;
  businessId: string;
  setPublicId: string;
  count?: number;
  codes?: string[];
  codePrefix?: string;
}): Promise<{ added: number } | null> {
  return withTenant(input.organizationId, async (tx) => {
    const [set] = await tx
      .select()
      .from(couponSets)
      .where(
        and(
          eq(couponSets.businessId, input.businessId),
          eq(couponSets.publicId, input.setPublicId),
        ),
      )
      .limit(1);
    if (!set) return null;
    if (set.archivedAt) throw new CouponError(`Coupon set ${set.publicId} is archived`);
    let toAdd: string[];
    if (input.codes && input.codes.length > 0) {
      toAdd = [...new Set(input.codes.map((c) => c.trim()).filter(Boolean))];
    } else {
      const n = input.count ?? 0;
      if (n < 1 || n > 10000) throw new CouponError("count must be between 1 and 10000");
      const prefix = (input.codePrefix ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const gen = new Set<string>();
      while (gen.size < n) gen.add(prefix ? `${prefix}-${codeGen()}` : codeGen());
      toAdd = [...gen];
    }
    if (toAdd.length === 0) throw new CouponError("There are no codes to add");
    // Business-wide unique code index is the backstop; skip collisions.
    const inserted = await tx
      .insert(couponSetCodes)
      .values(
        toAdd.map((code) => ({
          organizationId: input.organizationId,
          businessId: input.businessId,
          couponSetId: set.id,
          code,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: couponSetCodes.id });
    await auditSetCodes(tx, input, set.publicId, "coupon_set.add_codes", {
      added: inserted.length,
    });
    return { added: inserted.length };
  });
}

/**
 * CAT-6: archive a single (not-yet-redeemed) code so it can no longer be redeemed.
 * Returns false if the code doesn't exist or was already redeemed/archived.
 */
export async function archiveCouponCode(input: {
  organizationId: string;
  businessId: string;
  code: string;
}): Promise<boolean> {
  return withTenant(input.organizationId, async (tx) => {
    const [row] = await tx
      .update(couponSetCodes)
      .set({ status: "archived" })
      .where(
        and(
          eq(couponSetCodes.businessId, input.businessId),
          eq(couponSetCodes.code, input.code),
          eq(couponSetCodes.status, "not_redeemed"),
        ),
      )
      .returning({ id: couponSetCodes.id, couponSetId: couponSetCodes.couponSetId });
    if (row) {
      const [set] = await tx
        .select({ publicId: couponSets.publicId })
        .from(couponSets)
        .where(eq(couponSets.id, row.couponSetId))
        .limit(1);
      if (set)
        await auditSetCodes(tx, input, set.publicId, "coupon_set.archive_code", {
          code: input.code,
        });
    }
    return !!row;
  });
}

/**
 * CAT-6: delete all UNUSED (not_redeemed) codes in a set. Redeemed + archived codes
 * are kept (they carry history). Returns the count deleted (null if no set).
 */
export async function deleteUnusedCodes(input: {
  organizationId: string;
  businessId: string;
  setPublicId: string;
}): Promise<number | null> {
  return withTenant(input.organizationId, async (tx) => {
    const [set] = await tx
      .select()
      .from(couponSets)
      .where(
        and(
          eq(couponSets.businessId, input.businessId),
          eq(couponSets.publicId, input.setPublicId),
        ),
      )
      .limit(1);
    if (!set) return null;
    const deleted = await tx
      .delete(couponSetCodes)
      .where(and(eq(couponSetCodes.couponSetId, set.id), eq(couponSetCodes.status, "not_redeemed")))
      .returning({ id: couponSetCodes.id });
    await auditSetCodes(tx, input, set.publicId, "coupon_set.delete_unused_codes", {
      deleted: deleted.length,
    });
    return deleted.length;
  });
}

/** A code-level change on a set: an audit row on the SET, carrying what moved. */
async function auditSetCodes(
  tx: Tx,
  ids: { organizationId: string; businessId: string },
  setPublicId: string,
  action: string,
  after: Record<string, unknown>,
): Promise<void> {
  await writeAuditLog(
    {
      organizationId: ids.organizationId,
      businessId: ids.businessId,
      action,
      resourceType: "coupon_set",
      resourceId: setPublicId,
      after,
    },
    tx,
  );
}

/**
 * Resolve a code to its coupon WITHOUT redeeming anything — a plain coupon by
 * code, or a coupon-set code's parent coupon. Returns null if no such code.
 *
 * `applyCouponToSubscription` deliberately CLAIMS a coupon-set code as part of
 * applying it, so it can never be used to pre-validate a code: doing so would
 * burn a single-use code on a mere existence check. Callers that need to check a
 * code up-front (hosted checkout validates every coupon at mint, so a bad code 404s
 * at page creation) use this instead.
 *
 * Read-only: no claim, no redemption-count change, no ledger effect.
 */
export async function findCouponByCode(input: {
  organizationId: string;
  businessId: string;
  code: string;
}): Promise<typeof coupons.$inferSelect | null> {
  return withTenant(input.organizationId, async (tx) => {
    const [setCode] = await tx
      .select()
      .from(couponSetCodes)
      .where(
        and(eq(couponSetCodes.businessId, input.businessId), eq(couponSetCodes.code, input.code)),
      )
      .limit(1);
    if (setCode) {
      const [set] = await tx
        .select()
        .from(couponSets)
        .where(eq(couponSets.id, setCode.couponSetId))
        .limit(1);
      if (!set) return null;
      const [parent] = await tx.select().from(coupons).where(eq(coupons.id, set.couponId)).limit(1);
      return parent ?? null;
    }
    const [c] = await tx
      .select()
      .from(coupons)
      .where(and(eq(coupons.businessId, input.businessId), eq(coupons.code, input.code)))
      .limit(1);
    return c ?? null;
  });
}

/**
 * Why `coupon` cannot be redeemed at `now` (the business clock), or null when it can:
 * inactive, not yet valid, expired, or out of redemptions. Shared by apply, every
 * estimate and checkout, so a preview never prices a code the apply would refuse. The
 * per-customer cap is `customerLimitRefusal`. Coupons already attached are not
 * re-checked: an attached coupon keeps discounting after its redeem-by date.
 */
export function couponUsableRefusal(
  coupon: Pick<
    typeof coupons.$inferSelect,
    "code" | "active" | "validFrom" | "redeemBy" | "maxRedemptions" | "timesRedeemed"
  >,
  now: Date,
): string | null {
  if (!coupon.active) return `No active coupon: ${coupon.code}`;
  if (coupon.validFrom && coupon.validFrom > now) return `Coupon ${coupon.code} is not yet valid`;
  if (coupon.redeemBy && coupon.redeemBy < now) return `Coupon ${coupon.code} has expired`;
  if (coupon.maxRedemptions != null && coupon.timesRedeemed >= coupon.maxRedemptions)
    return `Coupon ${coupon.code} has reached its redemption limit`;
  return null;
}

/**
 * Why this customer may not redeem `coupon` again, or null when they may. Every
 * `applied_coupons` row counts, removed or exhausted included: a redemption that happened
 * stays spent, as it does for `times_redeemed`. Shared by apply and every estimate, so
 * the preview and the booking cannot disagree.
 */
export async function customerLimitRefusal(
  tx: Tx,
  coupon: Pick<typeof coupons.$inferSelect, "id" | "code" | "maxRedemptionsPerCustomer">,
  customerId: string,
): Promise<string | null> {
  const cap = coupon.maxRedemptionsPerCustomer;
  if (cap == null) return null;
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(appliedCoupons)
    .innerJoin(subscriptions, eq(subscriptions.id, appliedCoupons.subscriptionId))
    .where(and(eq(appliedCoupons.couponId, coupon.id), eq(subscriptions.customerId, customerId)));
  const used = Number(row?.n ?? 0);
  return used >= cap
    ? `Coupon ${coupon.code} allows ${cap} redemption(s) per customer, and this customer has used it ${used} time(s)`
    : null;
}

/**
 * Resolve the codes an estimate is about to price, refusing (`CouponError`) any the apply
 * would refuse: `couponUsableRefusal`, then the payer's per-customer cap. Unknown and
 * inactive codes are skipped, not refused — the create/apply call is where a typo 400s.
 */
export async function refusePendingCouponCodes(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    codes: string[];
    /** The business clock; defaults to `businessWallClock` (time-travel aware). */
    now?: Date;
    customerId?: string | null;
    /** Codes already attached to the subscription: priced as invoicing prices them, unchecked. */
    attached?: string[];
  },
): Promise<Array<typeof coupons.$inferSelect>> {
  const out: Array<typeof coupons.$inferSelect> = [];
  let now = input.now;
  for (const code of input.codes) {
    const c = await findCouponByCode({
      organizationId: input.organizationId,
      businessId: input.businessId,
      code,
    });
    if (c && input.attached?.includes(code)) {
      out.push(c);
      continue;
    }
    if (!c || c.active === false) continue;
    now ??= await businessWallClock(input.businessId);
    const refusal =
      couponUsableRefusal(c, now) ??
      (input.customerId ? await customerLimitRefusal(tx, c, input.customerId) : null);
    if (refusal) throw new CouponError(refusal);
    out.push(c);
  }
  return out;
}

/**
 * Refuse a redemption that would take one customer past the coupon's per-customer cap.
 * The advisory lock serialises two applies for the same (coupon, customer) so they cannot
 * both see the last free slot.
 */
async function assertUnderCustomerLimit(
  tx: Tx,
  coupon: typeof coupons.$inferSelect,
  subscriptionId: string,
): Promise<void> {
  const [sub] = await tx
    .select({ customerId: subscriptions.customerId })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId))
    .limit(1);
  if (!sub) return;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${coupon.id}:${sub.customerId}`}::text, 7404))`,
  );
  const refusal = await customerLimitRefusal(tx, coupon, sub.customerId);
  if (refusal) throw new CouponError(refusal);
}

/** Apply a coupon (by code) to a subscription, with validity checks. */
/** An item-scoped coupon must match at least one current item, by the rule billing uses. */
async function assertCouponMatchesAnItem(
  tx: Tx,
  coupon: typeof coupons.$inferSelect,
  subscriptionId: string,
): Promise<void> {
  const cons = await tx
    .select()
    .from(couponItemConstraints)
    .where(eq(couponItemConstraints.couponId, coupon.id));
  const items = await tx
    .select({
      productKind: products.kind,
      productPublicId: products.publicId,
      pricePublicId: prices.publicId,
    })
    .from(subscriptionItems)
    .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
    .innerJoin(products, eq(prices.productId, products.id))
    .where(eq(subscriptionItems.subscriptionId, subscriptionId));
  const probe: StackCoupon = {
    appliedCouponId: "",
    couponPublicId: coupon.code,
    kind: coupon.kind,
    applyOn: coupon.applyOn,
    constraints: cons.map((c) => ({
      itemKind: c.itemKind,
      constraintType: c.constraintType,
      productIds: (c.productIds as string[] | null) ?? null,
      priceIds: (c.priceIds as string[] | null) ?? null,
    })),
    createdAt: new Date(0),
  };
  const matches = items.some((it, index) =>
    couponMatchesLine(probe, { index, amountMinor: 0n, ...it }),
  );
  if (!matches)
    throw new CouponError(
      `We could not apply the coupon. Coupon ${coupon.code} applies to none of the items on ` +
        `this subscription. Select a coupon for its plan, an add-on or a charge.`,
    );
}

export async function applyCouponToSubscription(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  code: string;
  now: Date;
  /** True when called from the signup flow — signup coupons are folded into
   * subscription_created, so no subscription_changed is emitted there. */
  atSignup?: boolean;
  /**
   * Opt-in deferral (see `createSubscription`): append coupon_applied /
   * subscription_changed to this buffer instead of emitting them, so the
   * auto-collect-ON signup can withhold every event until its first charge is
   * known good. Omit it and this function behaves exactly as before.
   */
  deferEventsTo?: DeferredEvents;
  /**
   * The CALLER will emit the one `subscription_changed` for this edit, so don't emit one here.
   *
   * `atSignup` above already expresses this for the signup flow (those coupons fold into
   * `subscription_created`); this is the same idea for a COMPOSITE edit. A hosted change
   * checkout applies N coupons and then moves items, and each of those emitted its own
   * summary: measured 2026-08-27, one press of "Confirm change" with two coupons and a plan
   * swap produced THREE `subscription_changed` events, for the same reason
   * `applyItemOperations` buffers its three legs into one — three identical events differing
   * only by which internal step raised them tell a consumer nothing it can act on and invite
   * it to react three times.
   *
   * `coupon_applied` is NOT suppressed. The per-coupon fact is real and unduplicated; it is
   * only the subscription-level summary that has to be single.
   */
  suppressSubscriptionChanged?: boolean;
  /**
   * Join the caller's transaction so the discount commits — or rolls back — WITH the
   * change that owes it. `changeSubscription` passes its item-operations handle: the
   * discount has to be live BEFORE that change's proration invoice is raised, or the
   * proration is billed at list price. Omit it and
   * this opens its own transaction, exactly as before.
   */
  tx?: Tx | null;
  /** The customer entered this code (portal or checkout): it counts toward the business's cap. */
  enteredByCustomer?: boolean;
  /**
   * Refuse an item-scoped coupon that matches none of the subscription's current items.
   * Off for a plan change: there the coupon is applied before the items move.
   */
  requireItemMatch?: boolean;
}): Promise<typeof appliedCoupons.$inferSelect> {
  return withTenantTx(input.organizationId, input.tx, async (tx) => {
    // Resolve the code: a coupon-set code (single-use) resolves to its parent
    // coupon's rules; otherwise a plain coupon by code. Set codes are CLAIMED
    // atomically (guarded update) so the same code can't be redeemed twice.
    let coupon: typeof coupons.$inferSelect | undefined;
    let claimedSetCodeId: string | null = null;
    const [setCode] = await tx
      .select()
      .from(couponSetCodes)
      .where(
        and(eq(couponSetCodes.businessId, input.businessId), eq(couponSetCodes.code, input.code)),
      )
      .limit(1);
    if (setCode) {
      const claimed = await tx
        .update(couponSetCodes)
        .set({ status: "redeemed", redeemedAt: input.now })
        .where(and(eq(couponSetCodes.id, setCode.id), eq(couponSetCodes.status, "not_redeemed")))
        .returning({ id: couponSetCodes.id });
      if (claimed.length === 0) throw new CouponError("The coupon code is already redeemed");
      claimedSetCodeId = setCode.id;
      const [set] = await tx
        .select()
        .from(couponSets)
        .where(eq(couponSets.id, setCode.couponSetId))
        .limit(1);
      const [parent] = set
        ? await tx.select().from(coupons).where(eq(coupons.id, set.couponId)).limit(1)
        : [];
      coupon = parent;
    } else {
      const [c] = await tx
        .select()
        .from(coupons)
        .where(and(eq(coupons.businessId, input.businessId), eq(coupons.code, input.code)))
        .limit(1);
      coupon = c;
    }
    if (!coupon) throw new CouponError(`No active coupon: ${input.code}`);
    const unusable = couponUsableRefusal(coupon, input.now);
    if (unusable) throw new CouponError(unusable);
    if (coupon.maxRedemptionsPerCustomer != null) {
      await assertUnderCustomerLimit(tx, coupon, input.subscriptionId);
    }
    // Fixed-amount coupon currency must match the subscription's currency.
    if (coupon.kind === "fixed_amount") {
      const [sub] = await tx
        .select({ currency: subscriptions.currency })
        .from(subscriptions)
        .where(eq(subscriptions.id, input.subscriptionId))
        .limit(1);
      if (sub && coupon.currency && coupon.currency.toUpperCase() !== sub.currency.toUpperCase()) {
        throw new CouponError(
          `Coupon currency ${coupon.currency} does not match subscription currency ${sub.currency}`,
        );
      }
    }
    if (input.requireItemMatch && coupon.applyOn === "each_specified_item") {
      await assertCouponMatchesAnItem(tx, coupon, input.subscriptionId);
    }
    // CAT-1: coupons STACK — a subscription may carry many active coupons. Guard
    // only against applying the SAME coupon twice concurrently.
    const [dup] = await tx
      .select({ id: appliedCoupons.id })
      .from(appliedCoupons)
      .where(
        and(
          eq(appliedCoupons.subscriptionId, input.subscriptionId),
          eq(appliedCoupons.couponId, coupon.id),
          eq(appliedCoupons.status, "active"),
        ),
      )
      .limit(1);
    if (dup) throw new CouponError("The coupon is already applied to this subscription");

    const remaining =
      coupon.durationType === "forever"
        ? null
        : coupon.durationType === "repeating"
          ? coupon.durationInPeriods!
          : 1; // once
    // Atomic redemption-limit bump (G backlog: read-modify-write raced the cap).
    // Guarded on max_redemptions so concurrent applies can't exceed it; a losing
    // apply throws and its whole tx (insert + set-code claim) rolls back.
    const bumped = await tx
      .update(coupons)
      .set({ timesRedeemed: sql`${coupons.timesRedeemed} + 1` })
      .where(
        coupon.maxRedemptions != null
          ? and(eq(coupons.id, coupon.id), sql`${coupons.timesRedeemed} < ${coupon.maxRedemptions}`)
          : eq(coupons.id, coupon.id),
      )
      .returning({ id: coupons.id });
    if (bumped.length === 0)
      throw new CouponError(`Coupon ${coupon.code} has reached its redemption limit`);
    let applied: typeof appliedCoupons.$inferSelect;
    try {
      const [row] = await tx
        .insert(appliedCoupons)
        .values({
          organizationId: input.organizationId,
          businessId: input.businessId,
          couponId: coupon.id,
          subscriptionId: input.subscriptionId,
          publicId: publicId("disc"),
          status: "active",
          remainingPeriods: remaining,
          // At apply time the span and what remains of it are the same number;
          // only `remainingPeriods` counts down from here.
          totalPeriods: remaining,
          enteredByCustomer: input.enteredByCustomer === true,
        })
        .returning();
      applied = row!;
    } catch (e: any) {
      // The applied_coupons_active_uq partial index is the concurrency backstop for
      // the dup check above (two applies of the same coupon racing the SELECT).
      if (
        e?.code === "23505" &&
        String(e?.constraint ?? "").includes("applied_coupons_active_uq")
      ) {
        // The unique index caught a race the SELECT above could not — worth a line,
        // because it means two applies arrived for the same subscription at once.
        log.debug("duplicate coupon apply stopped by the unique index", {
          subscription: input.subscriptionId,
          coupon: coupon.code,
        });
        throw new CouponError("The coupon is already applied to this subscription");
      }
      throw e;
    }
    if (claimedSetCodeId) {
      await tx
        .update(couponSetCodes)
        .set({ appliedCouponId: applied!.id })
        .where(eq(couponSetCodes.id, claimedSetCodeId));
    }
    await emitOrDefer(
      tx,
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "coupon_applied",
        data: buildEventData("coupon_applied", { id: coupon.code }, coupon.resourceVersion, {
          applied_coupon: applied!.publicId,
        }),
      },
      input.deferEventsTo,
    );
    // The coupon list is part of the subscription, so a post-signup apply also fires
    // subscription_changed (signup-time coupons are folded into subscription_created
    // instead).
    if (!input.atSignup && !input.suppressSubscriptionChanged) {
      const [sub] = await tx
        .select({
          publicId: subscriptions.publicId,
          status: subscriptions.status,
          resourceVersion: subscriptions.resourceVersion,
        })
        .from(subscriptions)
        .where(eq(subscriptions.id, input.subscriptionId))
        .limit(1);
      if (sub) {
        await emitOrDefer(
          tx,
          {
            organizationId: input.organizationId,
            businessId: input.businessId,
            type: "subscription_changed",
            data: buildEventData(
              "subscription_changed",
              { id: sub.publicId, status: sub.status, coupon_applied: coupon.code },
              sub.resourceVersion,
            ),
          },
          input.deferEventsTo,
        );
      }
    }
    // Any discount that spans more than one billing period is netted, so a `repeating`
    // coupon restates MRR just as a `forever` one does (`discountsForMrr` owns the rule).
    // Only a `once` coupon — which reduces exactly one invoice — leaves the recurring
    // rate alone.
    if (coupon.durationType !== "once") {
      await recomputeSubscriptionMrr(tx, input.subscriptionId, input.now);
    }
    return applied!;
  });
}

/**
 * Manual discount: apply a %/amount discount directly to a
 * subscription, with no coupon object. Stored in the SAME `applied_coupons`
 * table as coupon-sourced discounts (`source = 'manual'`, `coupon_id = null`,
 * self-contained manual_* fields) so invoicing/stacking (`peekDiscounts`,
 * `consumeDiscount`, `restoreDiscountPeriod`) works unchanged.
 *
 * Same "one discount at a time" rule as coupons — `sub.discount` is
 * serialized as a single object, so we reject if ANY discount (coupon or
 * manual) is already active on the subscription, not just another manual one.
 */
/**
 * Statuses a manual discount may be applied to. Future/paused/cancelled are refused:
 * there is no live term to discount.
 *
 * ⚠️ TYPED, not two string literals, and that is the whole point. This used to read
 * `sub.status !== 'active' && sub.status !== 'trialing'` — and `'trialing'` is a value
 * the column NEVER holds. Our stored vocabulary is `in_trial` (see
 * `StoredSubscriptionStatus`); `trialing` is Stripe's spelling, correct only inside
 * `modules/migration/*` where source statuses are mapped on the way in. The
 * column is `text`, so nothing type-checked the comparison and it silently narrowed the
 * rule to "active only": EVERY manual discount on an in-trial subscription was refused.
 *
 * It failed quietly, which is why it survived — the change flow reports the refusal as a
 * warning ("Subscription updated (0 step(s)) — warnings: manual discount failed"), so the
 * operator sees a success banner with the failure inside it, on a screen whose own status
 * chip says "In Trial". Note the coupon path (`applyCouponToSubscription`) has no status
 * guard at all, so coupons always worked in trial — the two disagreed.
 *
 * Annotating the array with `StoredSubscriptionStatus[]` makes the next such typo a build
 * failure instead of a warning nobody reads.
 */
const DISCOUNTABLE_STATUSES: readonly StoredSubscriptionStatus[] = ["active", "in_trial"];

export async function applyManualDiscount(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  kind: "percentage" | "fixed_amount";
  percentOffBps?: number;
  amountOffMinor?: number;
  currency?: string;
  durationType: "once" | "forever";
  note?: string;
  now: Date;
  /**
   * Join the caller's transaction — same reason as `applyCouponToSubscription`'s: the
   * discount must be live before `changeSubscription` raises its proration invoice, and
   * must roll back with the change if anything downstream refuses.
   */
  tx?: Tx | null;
}): Promise<typeof appliedCoupons.$inferSelect> {
  if (input.kind === "percentage") {
    if (input.percentOffBps == null || input.percentOffBps <= 0 || input.percentOffBps > 10000) {
      throw new CouponError("Percent discount must be between 1 and 100");
    }
  } else {
    if (input.amountOffMinor == null || input.amountOffMinor <= 0) {
      throw new CouponError("Amount discount must be a positive amount");
    }
  }
  return withTenantTx(input.organizationId, input.tx, async (tx) => {
    const [sub] = await tx
      .select({ status: subscriptions.status, currency: subscriptions.currency })
      .from(subscriptions)
      .where(eq(subscriptions.id, input.subscriptionId))
      .limit(1);
    if (!sub) throw new CouponError("Subscription not found");
    if (!DISCOUNTABLE_STATUSES.includes(sub.status as StoredSubscriptionStatus)) {
      throw new CouponError("You can apply a discount only to an active or in-trial subscription");
    }
    const currency = (input.currency ?? sub.currency).toUpperCase();
    if (input.kind === "fixed_amount" && currency !== sub.currency.toUpperCase()) {
      throw new CouponError(
        `Discount currency ${currency} does not match subscription currency ${sub.currency}`,
      );
    }
    // Same rule as coupon apply: reject if a discount already exists (coupon
    // OR manual — sub.discount is surfaced as a single object).
    const [dup] = await tx
      .select({ id: appliedCoupons.id })
      .from(appliedCoupons)
      .where(
        and(
          eq(appliedCoupons.subscriptionId, input.subscriptionId),
          eq(appliedCoupons.status, "active"),
        ),
      )
      .limit(1);
    if (dup) throw new CouponError("A discount is already applied to this subscription");

    const remaining = input.durationType === "forever" ? null : 1; // once
    let applied: typeof appliedCoupons.$inferSelect;
    try {
      const [row] = await tx
        .insert(appliedCoupons)
        .values({
          organizationId: input.organizationId,
          businessId: input.businessId,
          couponId: null,
          subscriptionId: input.subscriptionId,
          publicId: publicId("disc"),
          status: "active",
          remainingPeriods: remaining,
          totalPeriods: remaining,
          source: "manual",
          manualKind: input.kind,
          manualPercentOffBps: input.kind === "percentage" ? input.percentOffBps : null,
          manualAmountOffMinor:
            input.kind === "fixed_amount" ? BigInt(input.amountOffMinor!) : null,
          manualCurrency: input.kind === "fixed_amount" ? currency : null,
          manualNote: input.note ?? null,
        })
        .returning();
      applied = row!;
    } catch (e: any) {
      // applied_coupons_active_manual_uq is the concurrency backstop for the
      // dup check above (two applies racing the SELECT).
      if (e?.code === "23505" && String(e?.constraint ?? "").includes("applied_coupons_active")) {
        log.debug("duplicate manual discount stopped by the unique index", {
          subscription: input.subscriptionId,
        });
        throw new CouponError("A discount is already applied to this subscription");
      }
      throw e;
    }
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "manual_discount_applied",
      data: buildEventData("manual_discount_applied", {
        id: applied.publicId,
        kind: input.kind,
        duration: input.durationType,
      }),
    });
    // Same rule as a coupon apply: a `forever` discount restates steady-state
    // recurring revenue, so the cached mrr column has to follow it. `once` never
    // nets (see netMrrForDiscounts), so it needs no recompute.
    if (input.durationType === "forever") {
      await recomputeSubscriptionMrr(tx, input.subscriptionId, input.now);
    }
    return applied!;
  });
}

/**
 * Read ALL active discounts for a subscription and compute the stacked discounts
 * over the invoice's lines (CAT-1 stacking + CAT-2 line-level constraints; no
 * mutation). Returns one row per coupon (each discount line shows separately),
 * the summed total, the invoice-level (proportional) portion + the per-line
 * line-level attribution (for line-accurate tax), and every active applied-coupon
 * id so the caller can consume a period on each at billing time.
 */
export async function peekDiscounts(
  tx: Tx,
  subscriptionId: string,
  lines: DiscountLine[],
  invoiceCurrency?: string,
  /**
   * A discount the caller is ABOUT to apply but has not yet — the change screen's
   * `Add Coupon` / `Add manual discount`, which the dashboard posts as its own call
   * (`POST …/discount`, `POST …/manual_discount`) AFTER the change.
   *
   * Priced in the SAME `computeStackedDiscounts` pass as the stored ones, never in a
   * second pass over the remainder: stacking is ordered (line-fixed → line-% →
   * invoice-fixed → invoice-%), so two 10% coupons priced separately take 10% + 10% of
   * different bases and do not equal the same pair priced together.
   *
   * `pendingOnly` is returned so a caller can say what the NEW discount is worth on its
   * own, without re-deriving it by subtraction.
   */
  pending?: {
    /** Required to resolve a CODE — `peekDiscounts` otherwise needs no tenant scope. */
    organizationId: string;
    businessId: string;
    codes?: string[];
    /** The business clock; defaults to `businessWallClock` (time-travel aware). */
    now?: Date;
    manual?: {
      kind: "percentage" | "fixed_amount";
      percentOffBps?: number;
      amountOffMinor?: bigint;
    };
    /**
     * The change screen's `remove_discount`: price as if every ACTIVE discount were
     * already removed, the way `changeSubscription` removes them before it bills.
     */
    removeActive?: boolean;
    /** Coupon codes a plan change removes before it bills (`plan_change_coupons`). */
    dropCodes?: string[];
  },
  /**
   * The START of the billing period this invoice belongs to (0247). When given, a
   * FIXED-AMOUNT discount is clamped to what remains of that period's allowance:
   * `amount_off - period_used_minor` for the period already anchored, or the full amount
   * when this invoice opens a new one.
   *
   * Once that fixed amount is fully used in the period, later invoices in the same period
   * do not get the coupon again — which is what stops a renewal and a proration in one
   * period from each taking the whole amount.
   *
   * OMITTED reproduces the pre-0247 behaviour exactly: every invoice sees the full amount.
   * Callers that only ESTIMATE may omit it, but an estimate that omits it will overstate
   * the discount on a second invoice in the same period — pass it wherever the period is
   * known. Percentage discounts are unaffected either way; they scale to the subtotal.
   */
  periodStart?: Date | null,
): Promise<DiscountStack & { appliedCouponIds: string[]; pendingOnlyMinor: bigint }> {
  // leftJoin (not innerJoin): manual discounts (source='manual') have no
  // coupon_id, so `c` is null for those rows — projected from their
  // self-contained manual_* columns below instead.
  const active = pending?.removeActive
    ? []
    : (
        await tx
          .select({ ac: appliedCoupons, c: coupons })
          .from(appliedCoupons)
          .leftJoin(coupons, eq(appliedCoupons.couponId, coupons.id))
          .where(
            and(
              eq(appliedCoupons.subscriptionId, subscriptionId),
              eq(appliedCoupons.status, "active"),
            ),
          )
          .orderBy(appliedCoupons.createdAt)
      ).filter((r) => !(r.c && pending?.dropCodes?.includes(r.c.code)));
  // Load item constraints only for each_specified_item coupons.
  const constrainedIds = active
    .filter((r) => r.c?.applyOn === "each_specified_item")
    .map((r) => r.c!.id);
  const byCoupon = new Map<string, CouponConstraint[]>();
  if (constrainedIds.length > 0) {
    const cons = await tx
      .select()
      .from(couponItemConstraints)
      .where(inArray(couponItemConstraints.couponId, constrainedIds));
    for (const con of cons) {
      const list = byCoupon.get(con.couponId) ?? [];
      list.push({
        itemKind: con.itemKind,
        constraintType: con.constraintType,
        productIds: (con.productIds as string[] | null) ?? null,
        priceIds: (con.priceIds as string[] | null) ?? null,
      });
      byCoupon.set(con.couponId, list);
    }
  }
  // Manual discounts always apply invoice-wide (no CAT-2 item constraints —
  // that's a coupon-only feature) and project from their manual_* columns.
  /**
   * What is LEFT of this period's allowance for a stored discount.
   *
   * Same period (anchor equals this invoice's period start) → face amount minus what the
   * period already spent, floored at 0 so an exhausted allowance contributes nothing. A
   * different period, or none yet → the full face amount, because a new period resets.
   *
   * `periodStart` absent → no clamping at all, which is the pre-0247 behaviour.
   */
  const allowance = (row: (typeof active)[number], face: bigint | null): bigint | null => {
    if (periodStart == null || face == null) return face;
    const anchor = row.ac.periodAnchor;
    const samePeriod = anchor != null && anchor.getTime() === periodStart.getTime();
    if (!samePeriod) return face;
    const left = face - (row.ac.periodUsedMinor ?? 0n);
    return left > 0n ? left : 0n;
  };

  const stack: StackCoupon[] = active.map((r) =>
    r.c
      ? {
          appliedCouponId: r.ac.id,
          couponPublicId: r.c.code,
          kind: r.c.kind,
          percentOffBps: r.c.percentOffBps,
          amountOffMinor: allowance(r, r.c.amountOffMinor),
          currency: r.c.currency,
          applyOn: r.c.applyOn,
          constraints: byCoupon.get(r.c.id) ?? [],
          invoiceName: r.c.invoiceName,
          createdAt: r.ac.createdAt,
        }
      : {
          appliedCouponId: r.ac.id,
          couponPublicId: r.ac.publicId,
          kind: r.ac.manualKind === "fixed_amount" ? "fixed_amount" : "percentage",
          percentOffBps: r.ac.manualPercentOffBps,
          amountOffMinor: allowance(r, r.ac.manualAmountOffMinor),
          currency: r.ac.manualCurrency,
          applyOn: "invoice_amount",
          constraints: [],
          invoiceName: "Discount",
          createdAt: r.ac.createdAt,
        },
  );
  // The pending discount joins the stack BEFORE it is priced, ordered last so an
  // existing coupon keeps its precedence — the same order the apply produces, since
  // `applyCouponToSubscription` appends and the stack sorts by `createdAt`.
  const pendingStack: StackCoupon[] = [];
  if (pending?.codes?.length) {
    const [owner] = await tx
      .select({ customerId: subscriptions.customerId })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    const usable = await refusePendingCouponCodes(tx, {
      organizationId: pending.organizationId,
      businessId: pending.businessId,
      codes: pending.codes,
      now: pending.now,
      customerId: owner?.customerId,
    });
    for (const c of usable) {
      pendingStack.push({
        appliedCouponId: `pending:${c.id}`,
        couponPublicId: c.code,
        kind: c.kind,
        percentOffBps: c.percentOffBps,
        amountOffMinor: c.amountOffMinor,
        currency: c.currency,
        applyOn: c.applyOn,
        constraints:
          c.applyOn === "each_specified_item"
            ? (
                await tx
                  .select()
                  .from(couponItemConstraints)
                  .where(eq(couponItemConstraints.couponId, c.id))
              ).map((con) => ({
                itemKind: con.itemKind,
                constraintType: con.constraintType,
                productIds: (con.productIds as string[] | null) ?? null,
                priceIds: (con.priceIds as string[] | null) ?? null,
              }))
            : [],
        invoiceName: c.invoiceName,
        createdAt: new Date(8640000000000000),
      });
    }
  }
  if (pending?.manual) {
    pendingStack.push({
      appliedCouponId: "pending:manual",
      couponPublicId: "manual",
      kind: pending.manual.kind,
      percentOffBps: pending.manual.percentOffBps ?? null,
      amountOffMinor: pending.manual.amountOffMinor ?? null,
      currency: invoiceCurrency ?? null,
      applyOn: "invoice_amount",
      constraints: [],
      invoiceName: "Discount",
      createdAt: new Date(8640000000000000),
    } as StackCoupon);
  }
  const res = computeStackedDiscounts([...stack, ...pendingStack], lines, invoiceCurrency);
  // What the pending slice alone is worth = the whole stack less the stored stack.
  const stored =
    pendingStack.length > 0 ? computeStackedDiscounts(stack, lines, invoiceCurrency) : res;
  return {
    ...res,
    appliedCouponIds: active.map((r) => r.ac.id),
    pendingOnlyMinor: res.totalMinor - stored.totalMinor,
  };
}

/**
 * Price coupon CODES against a set of lines with no subscription in existence.
 *
 * `peekDiscounts` reads `applied_coupons` for a subscription, which a NEW-subscription
 * estimate does not have: at signup the create route makes the subscription first, then
 * applies each `coupon_ids[]` entry, and only then plans the first invoice. So the
 * estimate had nothing to read and quoted the undiscounted total — the rail contradicted
 * the discount the line list was already showing, and the tax figure was computed on the
 * full subtotal too, so the quote was wrong in two directions at once.
 *
 * Deliberately shares `computeStackedDiscounts` with `peekDiscounts` rather than
 * approximating it here — the stacking order (line-fixed → line-% → invoice-fixed →
 * invoice-%) and the item-constraint matching are the behaviour under test in
 * verify:coupons, and a second implementation would drift from it.
 *
 * PEEK ONLY: resolves and prices, never redeems. An unknown code is skipped rather than
 * thrown — the estimate's job is to preview, and the create call is where a bad code must
 * refuse the signup (it does, with a 400). A preview that 500s on a typo is worse than one
 * that shows no discount for it. A code the apply would refuse (not yet valid, expired,
 * out of redemptions, or used up by this customer) throws `CouponError` with its words.
 */
export async function peekCouponCodes(
  tx: Tx,
  organizationId: string,
  businessId: string,
  codes: string[],
  lines: DiscountLine[],
  invoiceCurrency?: string,
  /**
   * A signup MANUAL discount, priced alongside the codes. Projected exactly as
   * `peekDiscounts` projects a stored one from its `manual_*` columns: invoice-wide,
   * no item constraints, label "Discount".
   */
  manual?: { kind: "percentage" | "fixed_amount"; percentOffBps?: number; amountOffMinor?: bigint },
  /** The payer, when one exists: a code they have used up is refused, as the apply would. */
  customerId?: string | null,
  /** The business clock; defaults to `businessWallClock` (time-travel aware). */
  now?: Date,
  /** Codes in `codes` already attached to the subscription — see `refusePendingCouponCodes`. */
  attached?: string[],
): Promise<DiscountStack> {
  if (codes.length === 0 && !manual) return computeStackedDiscounts([], lines, invoiceCurrency);
  const resolved = await refusePendingCouponCodes(tx, {
    organizationId,
    businessId,
    codes,
    now,
    customerId,
    attached,
  });
  const constrainedIds = resolved
    .filter((c) => c.applyOn === "each_specified_item")
    .map((c) => c.id);
  const byCoupon = new Map<string, CouponConstraint[]>();
  if (constrainedIds.length > 0) {
    const cons = await tx
      .select()
      .from(couponItemConstraints)
      .where(inArray(couponItemConstraints.couponId, constrainedIds));
    for (const con of cons) {
      const list = byCoupon.get(con.couponId) ?? [];
      list.push({
        itemKind: con.itemKind,
        constraintType: con.constraintType,
        productIds: (con.productIds as string[] | null) ?? null,
        priceIds: (con.priceIds as string[] | null) ?? null,
      });
      byCoupon.set(con.couponId, list);
    }
  }
  // `appliedCouponId` is the coupon's own id here: nothing is applied yet, and the field
  // is only an attribution handle for the shares this returns.
  const stack: StackCoupon[] = resolved.map((c) => ({
    appliedCouponId: c.id,
    couponPublicId: c.code,
    kind: c.kind,
    percentOffBps: c.percentOffBps,
    amountOffMinor: c.amountOffMinor,
    currency: c.currency,
    applyOn: c.applyOn,
    constraints: byCoupon.get(c.id) ?? [],
    invoiceName: c.invoiceName,
    createdAt: c.createdAt,
  }));
  if (manual) {
    stack.push({
      appliedCouponId: "manual",
      couponPublicId: "manual",
      kind: manual.kind,
      percentOffBps: manual.percentOffBps ?? null,
      amountOffMinor: manual.amountOffMinor ?? null,
      currency: invoiceCurrency ?? null,
      applyOn: "invoice_amount",
      constraints: [],
      invoiceName: "Discount",
      // Ordered last among equals. Irrelevant in practice — the engine refuses a second
      // discount, so a manual one never coexists with a coupon on a real subscription.
      createdAt: new Date(0),
    });
  }
  return computeStackedDiscounts(stack, lines, invoiceCurrency);
}

/** List a business's coupons (newest first). */
export async function listCoupons(
  organizationId: string,
  businessId: string,
  opts?: { includeArchived?: boolean },
): Promise<Array<typeof coupons.$inferSelect>> {
  return withTenant(organizationId, async (tx) => {
    const base = eq(coupons.businessId, businessId);
    const where = opts?.includeArchived ? base : and(base, eq(coupons.active, true));
    return tx.select().from(coupons).where(where).orderBy(desc(coupons.createdAt));
  });
}

/**
 * CAT-2 scoping rows for a set of coupons, keyed by `coupons.id` — the READ side of what
 * `createCoupon`/`updateCoupon` write and `couponMatchesLine` enforces.
 *
 * Constraints were writable and enforced from the start but never readable: no serializer
 * emitted them, so the dashboard could set a coupon's plan/addon/charge scope at create and
 * then never see it again (and its Edit/Clone form silently re-defaulted to "all"). One query
 * for the whole page rather than per row.
 *
 * A coupon with no row for a kind is NOT the same as `all` — `couponMatchesLine` treats a
 * missing row as an implicit `none`, so callers must render absence, not assume breadth.
 */
export async function listCouponConstraints(
  organizationId: string,
  couponIds: string[],
): Promise<Map<string, CouponConstraint[]>> {
  const byCoupon = new Map<string, CouponConstraint[]>();
  if (couponIds.length === 0) return byCoupon;
  const rows = await withTenant(organizationId, async (tx) =>
    tx
      .select()
      .from(couponItemConstraints)
      .where(inArray(couponItemConstraints.couponId, couponIds)),
  );
  for (const r of rows) {
    const list = byCoupon.get(r.couponId) ?? [];
    list.push({
      itemKind: r.itemKind,
      constraintType: r.constraintType,
      productIds: (r.productIds as string[] | null) ?? null,
      priceIds: (r.priceIds as string[] | null) ?? null,
    });
    byCoupon.set(r.couponId, list);
  }
  return byCoupon;
}

/**
 * The columns the redeemed gate protects — everything deciding what a coupon is worth and
 * which lines it lands on. Named once so `updateCoupon` and the route cannot drift about
 * what counts as "the discount".
 */
const RULE_FIELDS = [
  "kind",
  "percentOffBps",
  "amountOffMinor",
  "currency",
  "durationType",
  "durationInPeriods",
  "applyOn",
] as const satisfies ReadonlyArray<keyof typeof coupons.$inferInsert>;

/**
 * Edit a coupon. Name / invoice name / validity / max redemptions / metadata are always
 * editable; the discount rules only while the coupon has never been redeemed.
 */
/**
 * CAT-5: derived coupon status:
 *   archived (active=false) > future (before valid_from) > expired (past redeem_by
 *   OR max_redemptions reached) > active.
 */
export function couponStatus(
  c: Pick<
    typeof coupons.$inferSelect,
    "active" | "validFrom" | "redeemBy" | "maxRedemptions" | "timesRedeemed"
  >,
  now: Date = new Date(),
): "archived" | "future" | "expired" | "active" {
  if (!c.active) return "archived";
  if (c.validFrom && c.validFrom > now) return "future";
  if (c.redeemBy && c.redeemBy < now) return "expired";
  if (c.maxRedemptions != null && c.timesRedeemed >= c.maxRedemptions) return "expired";
  return "active";
}

export async function updateCoupon(input: {
  organizationId: string;
  businessId: string;
  couponPublicId: string;
  name?: string | null;
  redeemBy?: Date | null;
  maxRedemptions?: number | null;
  /** A cap, not a rule: editable after redemption, like `maxRedemptions`. */
  maxRedemptionsPerCustomer?: number | null;
  validFrom?: Date | null;
  invoiceName?: string | null;
  /** Replaced wholesale, not merged — same contract as `updateProduct`. */
  metadata?: Record<string, unknown> | null;
  /**
   * The discount MATH — editable ONLY while `times_redeemed === 0`: once a coupon has
   * been redeemed, name / invoice name / valid-till / max-redemptions are all that
   * remain editable.
   *
   * The gate is not bureaucracy. An `applied_coupons` row with `source='coupon'` keeps no
   * snapshot of the discount — `peekDiscounts` re-reads `kind`/`percent_off_bps`/
   * `amount_off_minor`/`apply_on` off `coupons` every time an invoice is priced — so
   * editing these on a redeemed coupon silently re-prices the future invoices of every
   * subscription still carrying it. `times_redeemed` never decreases (removing a discount
   * does not decrement it), which is what makes it the right signal: "has this ever been
   * used", not "is it in use right now".
   *
   * Validated against the RESULTING row, not the patch: `{kind: 'fixed_amount'}` on its
   * own would otherwise store a fixed coupon with no amount, i.e. one that discounts
   * nothing.
   */
  kind?: "percentage" | "fixed_amount";
  percentOffBps?: number | null;
  amountOffMinor?: number | null;
  currency?: string | null;
  durationType?: "once" | "forever" | "repeating";
  durationInPeriods?: number | null;
  applyOn?: "invoice_amount" | "each_specified_item";
  /**
   * CAT-2 scoping, replaced WHOLESALE: the array is the complete desired state, so a kind
   * you omit loses its row and becomes an implicit `none` (`couponMatchesLine`). Same
   * convention as `createCoupon`, which is what lets the dashboard post only the kinds an
   * operator left switched on.
   *
   * Editable even though the discount MATH is not: narrowing which line items a coupon
   * reaches changes future invoices only, and already-issued ones are immutable documents.
   * Rejected outright on an `invoice_amount` coupon, where the rows would be stored and
   * then ignored by the matcher.
   */
  itemConstraints?: ItemConstraintInput[];
}): Promise<typeof coupons.$inferSelect | null> {
  const set: Partial<typeof coupons.$inferInsert> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.redeemBy !== undefined) set.redeemBy = input.redeemBy;
  if (input.maxRedemptions !== undefined) set.maxRedemptions = input.maxRedemptions;
  if (input.maxRedemptionsPerCustomer !== undefined)
    set.maxRedemptionsPerCustomer = input.maxRedemptionsPerCustomer;
  if (input.validFrom !== undefined) set.validFrom = input.validFrom;
  if (input.invoiceName !== undefined) set.invoiceName = input.invoiceName;
  if (input.metadata !== undefined) set.metadata = input.metadata;
  if (input.kind !== undefined) set.kind = input.kind;
  if (input.percentOffBps !== undefined) set.percentOffBps = input.percentOffBps;
  if (input.amountOffMinor !== undefined)
    set.amountOffMinor = input.amountOffMinor == null ? null : BigInt(input.amountOffMinor);
  if (input.currency !== undefined) set.currency = input.currency?.toUpperCase() ?? null;
  if (input.durationType !== undefined) set.durationType = input.durationType;
  if (input.durationInPeriods !== undefined) set.durationInPeriods = input.durationInPeriods;
  if (input.applyOn !== undefined) set.applyOn = input.applyOn;
  return withTenant(input.organizationId, async (tx) => {
    const where = and(
      eq(coupons.businessId, input.businessId),
      eq(coupons.code, input.couponPublicId),
    );
    // Read BEFORE writing: the discount rules are validated against the row this patch
    // would produce, not against the patch. `{kind: 'fixed_amount'}` alone would
    // otherwise store a fixed coupon with no amount, i.e. one that discounts nothing.
    const [existing] = await tx.select().from(coupons).where(where).limit(1);
    if (!existing) return null;
    if (Object.keys(set).length === 0 && input.itemConstraints === undefined) return existing;
    await validatePriceScope(tx, input.businessId, input.itemConstraints);

    // Once a coupon has been REDEEMED its discount is frozen, because nothing snapshots
    // it — `peekDiscounts` re-reads these columns on every invoice, so an edit would
    // silently re-price live subscriptions. `times_redeemed` never decreases (removing a
    // discount does not decrement it), which is why the gate asks "has this ever been
    // used", not "is it in use now".
    const touchesRules =
      RULE_FIELDS.some((k) => set[k] !== undefined) || input.itemConstraints !== undefined;
    if (touchesRules && existing.timesRedeemed > 0)
      throw new CouponError(
        `Coupon ${existing.code} has ${existing.timesRedeemed} redemption(s), so its discount is fixed. You can change only name, invoice_name, redeem_by and max_redemptions. Clone it to change the discount.`,
      );

    const next = { ...existing, ...set };
    if (next.kind === "percentage" && next.percentOffBps == null)
      throw new CouponError("a percentage coupon requires percent_off_bps");
    if (next.kind === "fixed_amount" && next.amountOffMinor == null)
      throw new CouponError("a fixed_amount coupon requires amount_off_minor");
    if (next.kind === "fixed_amount" && !next.currency)
      throw new CouponError("a fixed_amount coupon requires a currency");
    if (next.durationType === "repeating" && !next.durationInPeriods)
      throw new CouponError("a repeating coupon requires duration_in_periods");
    // Switching kinds leaves the other kind's column populated, and `computeDiscount`
    // branches on `kind` alone — a stale sibling column is dead data that reads as a
    // contradiction in the API response. Clear it unless the caller set it explicitly.
    if (set.kind === "percentage" && input.amountOffMinor === undefined) {
      set.amountOffMinor = null;
      if (input.currency === undefined) set.currency = null;
    }
    if (set.kind === "fixed_amount" && input.percentOffBps === undefined) set.percentOffBps = null;
    if (next.durationType !== "repeating" && input.durationInPeriods === undefined)
      set.durationInPeriods = null;

    const [c] = Object.keys(set).length
      ? await tx.update(coupons).set(set).where(where).returning()
      : [existing];
    if (c && input.itemConstraints !== undefined) {
      if (c.applyOn !== "each_specified_item")
        throw new CouponError(
          "item_constraints require apply_on='each_specified_item'. An invoice-amount coupon discounts the whole invoice.",
        );
      await tx.delete(couponItemConstraints).where(eq(couponItemConstraints.couponId, c.id));
      const keep = input.itemConstraints.filter((k) => k.constraintType !== "none");
      if (keep.length > 0)
        await tx.insert(couponItemConstraints).values(
          keep.map((k) => ({
            organizationId: input.organizationId,
            businessId: input.businessId,
            couponId: c.id,
            itemKind: k.itemKind,
            constraintType: k.constraintType,
            productIds: k.constraintType === "specific" ? (k.productIds ?? []) : null,
            priceIds: k.constraintType === "specific" && k.priceIds?.length ? k.priceIds : null,
          })),
        );
    }
    if (c && c.applyOn !== "each_specified_item" && input.itemConstraints === undefined) {
      // Switched to invoice_amount: the scoping rows can never be consulted again, so
      // leaving them would make the API report a scope the coupon does not have.
      await tx.delete(couponItemConstraints).where(eq(couponItemConstraints.couponId, c.id));
    }
    if (c) {
      await emitEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "coupon_updated",
        data: buildEventData("coupon_updated", { id: c.code, name: c.name }, c.resourceVersion),
      });
      await auditRowChange(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        action: "coupon.update",
        resourceType: "coupon",
        resourceId: c.code,
        before: existing,
        after: c,
        extra: { id: c.code },
      });
    }
    return c ?? null;
  });
}

/** Soft-archive (active=false) or restore a coupon. Archived coupons can't be applied. */
export async function setCouponActive(
  organizationId: string,
  businessId: string,
  couponPublicId: string,
  active: boolean,
): Promise<typeof coupons.$inferSelect | null> {
  return withTenant(organizationId, async (tx) => {
    const where = and(eq(coupons.businessId, businessId), eq(coupons.code, couponPublicId));
    const [before] = await tx.select().from(coupons).where(where).limit(1);
    const [c] = await tx.update(coupons).set({ active }).where(where).returning();
    if (c) {
      await auditRowChange(tx, {
        organizationId,
        businessId,
        action: active ? "coupon.restore" : "coupon.archive",
        resourceType: "coupon",
        resourceId: c.code,
        before: before ?? null,
        after: c,
        extra: { id: c.code },
      });
      const type = active ? "coupon_updated" : "coupon_archived";
      await emitEvent(tx, {
        organizationId,
        businessId,
        type,
        data: buildEventData(type, { id: c.code, active: c.active }, c.resourceVersion),
      });
    }
    return c ?? null;
  });
}

/**
 * Remove active discount(s) from a subscription (status → 'removed'). With
 * `couponPublicId` set (CAT-1 stacking: many coupons per sub), removes only that
 * one; without it, removes all active coupons. Emits ONE `coupon.removed` per
 * coupon actually removed (G backlog: don't collapse a whole-stack removal into a
 * single ambiguous event). Returns the count removed. Future invoices bill at the
 * remaining stack (or full price when the last is gone).
 */
export async function removeDiscount(
  organizationId: string,
  subscriptionId: string,
  couponPublicId?: string,
  opts: { suppressSubscriptionChanged?: boolean } = {},
): Promise<number> {
  return withTenant(organizationId, (tx) =>
    removeDiscountInTx(tx, { organizationId, subscriptionId, couponPublicId, ...opts }),
  );
}

/**
 * `removeDiscount` on the caller's transaction, so a removal commits or rolls back WITH
 * the edit it belongs to (the change screen's `remove_discount`).
 *
 * A removal changes the price, like an apply, so it announces `subscription_changed`
 * (NOT `settings_only`) once when anything was removed. `suppressSubscriptionChanged`:
 * the caller emits the one summary event for its edit, or is undoing its own apply.
 */
export async function removeDiscountInTx(
  tx: Tx,
  input: {
    organizationId: string;
    subscriptionId: string;
    couponPublicId?: string;
    suppressSubscriptionChanged?: boolean;
    deferEventsTo?: DeferredEvents;
  },
): Promise<number> {
  const { organizationId, subscriptionId, couponPublicId } = input;
  {
    let couponIdFilter: string | null | undefined;
    // Resolve the coupon id (if a specific coupon was named).
    if (couponPublicId != null) {
      const [ac] = await tx
        .select({ couponId: appliedCoupons.couponId })
        .from(appliedCoupons)
        .innerJoin(coupons, eq(appliedCoupons.couponId, coupons.id))
        .where(
          and(
            eq(appliedCoupons.subscriptionId, subscriptionId),
            eq(appliedCoupons.status, "active"),
            eq(coupons.code, couponPublicId),
          ),
        )
        .limit(1);
      if (!ac) return 0;
      couponIdFilter = ac.couponId;
    }
    const where = couponIdFilter
      ? and(
          eq(appliedCoupons.subscriptionId, subscriptionId),
          eq(appliedCoupons.status, "active"),
          eq(appliedCoupons.couponId, couponIdFilter),
        )
      : and(eq(appliedCoupons.subscriptionId, subscriptionId), eq(appliedCoupons.status, "active"));
    const removed = await tx
      .update(appliedCoupons)
      .set({ status: "removed" })
      .where(where)
      .returning({
        id: appliedCoupons.id,
        businessId: appliedCoupons.businessId,
        couponId: appliedCoupons.couponId,
        publicId: appliedCoupons.publicId,
        source: appliedCoupons.source,
        remainingPeriods: appliedCoupons.remainingPeriods,
        totalPeriods: appliedCoupons.totalPeriods,
      });
    // One event per removed discount (resolve each coupon code; manual rows
    // have no coupon to resolve and emit their own event type).
    let recomputeMrr = false;
    const removedCodes: Array<string | null> = [];
    for (const r of removed) {
      if (r.source === "manual" || r.couponId == null) {
        // A manual discount nets into mrr whenever it spans more than one billing
        // period (unlimited included) — removing one must recompute too.
        if (r.totalPeriods == null || r.totalPeriods > 1) recomputeMrr = true;
        await emitEvent(tx, {
          organizationId,
          businessId: r.businessId,
          type: "manual_discount_removed",
          data: buildEventData("manual_discount_removed", {
            id: r.publicId,
            subscription: subscriptionId,
          }),
        });
        continue;
      }
      const [c] = await tx
        .select({ code: coupons.code, durationType: coupons.durationType })
        .from(coupons)
        .where(eq(coupons.id, r.couponId))
        .limit(1);
      // Any discount spanning more than one billing period is netted into mrr
      // (see `discountsForMrr`), so removing one requires recomputing. Only a
      // `once` coupon never netted, making its removal a no-op for mrr.
      if (c?.durationType !== "once") recomputeMrr = true;
      removedCodes.push(c?.code ?? null);
      await emitEvent(tx, {
        organizationId,
        businessId: r.businessId,
        type: "coupon_removed",
        data: buildEventData("coupon_removed", {
          id: c?.code ?? null,
          subscription: subscriptionId,
        }),
      });
    }
    if (recomputeMrr) await recomputeSubscriptionMrr(tx, subscriptionId);
    if (removed.length > 0 && !input.suppressSubscriptionChanged) {
      const [sub] = await tx
        .select({
          publicId: subscriptions.publicId,
          status: subscriptions.status,
          resourceVersion: subscriptions.resourceVersion,
          businessId: subscriptions.businessId,
        })
        .from(subscriptions)
        .where(eq(subscriptions.id, subscriptionId))
        .limit(1);
      if (sub) {
        await emitOrDefer(
          tx,
          {
            organizationId,
            businessId: sub.businessId,
            type: "subscription_changed",
            data: buildEventData(
              "subscription_changed",
              {
                id: sub.publicId,
                status: sub.status,
                coupon_removed: removedCodes.find((x) => x != null) ?? null,
              },
              sub.resourceVersion,
            ),
          },
          input.deferEventsTo,
        );
      }
    }
    return removed.length;
  }
}

/**
 * Consume one period of a repeating/once discount; exhaust when used up.
 *
 * Post-H (#1): a single ATOMIC guarded UPDATE — no read-compute-write window. The
 * WHERE requires status='active' (a concurrent removeDiscount wins) AND a non-null
 * remaining_periods (a `forever` coupon never consumes / never exhausts), and the
 * new status is computed in-SQL from the decremented value. A 0-row result means
 * the coupon was removed/exhausted/forever between peek and consume — a correct
 * no-op, never a resurrection.
 *
 * EXHAUSTION RESTATES MRR. A discount spanning more than one billing period is
 * netted into the cached `subscriptions.mrr` for as long as it is active, so the
 * renewal that burns its last period is when the subscription goes back to its
 * undiscounted rate. Nothing recomputed here until 2026-08-08, which is one half
 * of why the netting rule used to be `forever`-only: without this the column
 * would keep a lapsed discount forever. The intermediate decrements need no
 * recompute — the rule reads `total_periods`, which does not move.
 */
/**
 * Record what an invoice took from a discount, and spend a PERIOD only if this invoice
 * opened one (0247).
 *
 * The replacement for calling `consumeDiscount` on every invoice. Two cases, decided by
 * comparing the stored anchor to the period this invoice belongs to:
 *
 *   NEW period  → anchor moves, `period_used_minor` becomes this invoice's discount, and
 *                 one period is spent (the same decrement + exhaust + MRR recompute
 *                 `consumeDiscount` does).
 *   SAME period → `period_used_minor` accumulates and NO period is spent. This is the
 *                 whole fix: a mid-term proration is an adjustment inside a period the
 *                 coupon has already paid for, so it must not cost another one.
 *
 * A period therefore never gives more than the coupon's face amount (peekDiscounts
 * clamped the amount to what was left) and no period is ever spent on a part-period
 * charge. Both failure modes of the reverted 0246 are structurally impossible here rather
 * than merely avoided.
 *
 * `appliedMinor` is what the invoice ACTUALLY discounted for this row — the caller reads
 * it off `DiscountStack.rows[].discountMinor`, so the ledger and this counter cannot
 * disagree about the same application.
 */
export async function settlePeriodDiscount(
  tx: Tx,
  appliedCouponId: string,
  opts: { periodStart: Date; appliedMinor: bigint },
): Promise<void> {
  const [row] = await tx
    .select({
      periodAnchor: appliedCoupons.periodAnchor,
      periodUsedMinor: appliedCoupons.periodUsedMinor,
    })
    .from(appliedCoupons)
    .where(and(eq(appliedCoupons.id, appliedCouponId), eq(appliedCoupons.status, "active")))
    .limit(1);
  // Already exhausted or gone: nothing to record, and nothing to spend.
  if (!row) return;

  const samePeriod =
    row.periodAnchor != null && row.periodAnchor.getTime() === opts.periodStart.getTime();
  const used = opts.appliedMinor > 0n ? opts.appliedMinor : 0n;

  await tx
    .update(appliedCoupons)
    .set({
      periodAnchor: opts.periodStart,
      periodUsedMinor: samePeriod ? (row.periodUsedMinor ?? 0n) + used : used,
    })
    .where(eq(appliedCoupons.id, appliedCouponId));

  // Only a NEW period costs a period. `consumeDiscount` also handles the exhaust edge and
  // the MRR recompute, so it is reused rather than reimplemented.
  if (!samePeriod) await consumeDiscount(tx, appliedCouponId, opts.periodStart);
}

export async function consumeDiscount(
  tx: Tx,
  appliedCouponId: string,
  /** The period this discount was spent on — the instant the rate goes back up. */
  occurredAt?: Date,
): Promise<void> {
  const [row] = await tx
    .update(appliedCoupons)
    .set({
      remainingPeriods: sql`${appliedCoupons.remainingPeriods} - 1`,
      status: sql`CASE WHEN ${appliedCoupons.remainingPeriods} - 1 <= 0 THEN 'exhausted' ELSE 'active' END`,
    })
    .where(
      and(
        eq(appliedCoupons.id, appliedCouponId),
        eq(appliedCoupons.status, "active"),
        isNotNull(appliedCoupons.remainingPeriods),
      ),
    )
    .returning({
      status: appliedCoupons.status,
      subscriptionId: appliedCoupons.subscriptionId,
      totalPeriods: appliedCoupons.totalPeriods,
    });
  // Only the active → exhausted edge changes the rate, and only for a discount
  // that was being netted in the first place.
  if (row && row.status === "exhausted" && (row.totalPeriods == null || row.totalPeriods > 1)) {
    await recomputeSubscriptionMrr(tx, row.subscriptionId, occurredAt);
  }
}

/**
 * Void-restore (G backlog): give back one consumed period to an applied coupon
 * when the invoice that consumed it is voided/credited, so a regenerate re-applies
 * the coupon. `forever` coupons (remaining_periods = null) never consumed and are
 * skipped. An exhausted coupon reactivates; an explicitly-removed one stays removed.
 */
export async function restoreDiscountPeriod(
  tx: Tx,
  appliedCouponId: string,
  /** When the void that restores the period took effect. */
  occurredAt?: Date,
): Promise<void> {
  // Post-H (#1): atomic increment — no read-compute-write window. The isNotNull
  // guard skips `forever` coupons (nothing to restore); the status CASE reactivates
  // ONLY an auto-exhausted coupon (a merchant-removed one stays removed).
  //
  // Post-H (#6): we deliberately do NOT decrement coupons.times_redeemed here. That
  // counter is per-APPLICATION (bumped once in applyCouponToSubscription), not per
  // billed period; voiding one invoice restores the discount PERIOD for a later
  // re-bill but does not un-redeem the coupon from the subscription. A monotonic
  // redemption count is deliberate — a redemption is reversed only if the whole
  // application is removed, which is a separate operation.
  const [row] = await tx
    .update(appliedCoupons)
    .set({
      remainingPeriods: sql`${appliedCoupons.remainingPeriods} + 1`,
      status: sql`CASE WHEN ${appliedCoupons.status} = 'exhausted' THEN 'active' ELSE ${appliedCoupons.status} END`,
    })
    .where(and(eq(appliedCoupons.id, appliedCouponId), isNotNull(appliedCoupons.remainingPeriods)))
    .returning({
      status: appliedCoupons.status,
      subscriptionId: appliedCoupons.subscriptionId,
      totalPeriods: appliedCoupons.totalPeriods,
    });
  // The mirror of `consumeDiscount`: a resurrected netting discount is back in the
  // active set, so the cached rate has to pick it up again. (An already-active row
  // getting a period back never left the set — recomputing is a harmless no-op.)
  if (row && row.status === "active" && (row.totalPeriods == null || row.totalPeriods > 1)) {
    await recomputeSubscriptionMrr(tx, row.subscriptionId, occurredAt);
  }
}

// ── Retrieve, set lifecycle, codes, opt-in paging ────────────────────────────

/** One coupon by its code (the coupon id). */
export async function getCouponByCode(
  organizationId: string,
  businessId: string,
  code: string,
): Promise<typeof coupons.$inferSelect | null> {
  return withTenant(organizationId, async (tx) => {
    const [c] = await tx
      .select()
      .from(coupons)
      .where(and(eq(coupons.businessId, businessId), eq(coupons.code, code)))
      .limit(1);
    return c ?? null;
  });
}

/** Rename a set / replace its metadata. Null when there is no such set. */
export async function updateCouponSet(input: {
  organizationId: string;
  businessId: string;
  setPublicId: string;
  name?: string;
  metadata?: Record<string, unknown> | null;
}): Promise<CouponSetWithCounts | null> {
  const patch: Partial<typeof couponSets.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new CouponError("name cannot be empty");
    patch.name = name;
  }
  if (input.metadata !== undefined) patch.metadata = input.metadata;
  const found = await withTenant(input.organizationId, async (tx) => {
    const where = and(
      eq(couponSets.businessId, input.businessId),
      eq(couponSets.publicId, input.setPublicId),
    );
    const [before] = await tx.select().from(couponSets).where(where).limit(1);
    if (!before) return false;
    if (patch.name === before.name) delete patch.name;
    if (!Object.keys(patch).length) return true;
    const [after] = await tx.update(couponSets).set(patch).where(where).returning();
    await auditRowChange(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      action: patch.metadata === undefined ? "coupon_set.rename" : "coupon_set.update",
      resourceType: "coupon_set",
      resourceId: before.publicId,
      before,
      after: after!,
    });
    return true;
  });
  if (!found) return null;
  return getCouponSet(input.organizationId, input.businessId, input.setPublicId);
}

/**
 * Archive a set: stamp `archived_at` and archive every unredeemed code, so nothing in it
 * can be redeemed and no codes can be added. Redeemed codes keep their history.
 * Idempotent. Null when there is no such set.
 */
export async function archiveCouponSet(input: {
  organizationId: string;
  businessId: string;
  setPublicId: string;
  now: Date;
}): Promise<CouponSetWithCounts | null> {
  const found = await withTenant(input.organizationId, async (tx) => {
    const [set] = await tx
      .select()
      .from(couponSets)
      .where(
        and(
          eq(couponSets.businessId, input.businessId),
          eq(couponSets.publicId, input.setPublicId),
        ),
      )
      .limit(1);
    if (!set) return false;
    if (!set.archivedAt) {
      await tx.update(couponSets).set({ archivedAt: input.now }).where(eq(couponSets.id, set.id));
      await tx
        .update(couponSetCodes)
        .set({ status: "archived" })
        .where(
          and(eq(couponSetCodes.couponSetId, set.id), eq(couponSetCodes.status, "not_redeemed")),
        );
      await auditSetCodes(tx, input, set.publicId, "coupon_set.archive", {
        archived_at: input.now,
      });
    }
    return true;
  });
  if (!found) return null;
  return getCouponSet(input.organizationId, input.businessId, input.setPublicId);
}

/** A set code with the set and coupon it belongs to. */
export interface CouponCodeRow {
  code: typeof couponSetCodes.$inferSelect;
  setPublicId: string;
  couponPublicId: string;
  /** The subscription the redemption landed on; null until redeemed. */
  subscriptionPublicId: string | null;
}

const codeSelection = {
  code: couponSetCodes,
  setPublicId: couponSets.publicId,
  couponPublicId: coupons.code,
  subscriptionPublicId: subscriptions.publicId,
};

/** One set code by its code string. */
export async function getCouponCode(
  organizationId: string,
  businessId: string,
  code: string,
): Promise<CouponCodeRow | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select(codeSelection)
      .from(couponSetCodes)
      .innerJoin(couponSets, eq(couponSetCodes.couponSetId, couponSets.id))
      .innerJoin(coupons, eq(couponSets.couponId, coupons.id))
      .leftJoin(appliedCoupons, eq(appliedCoupons.id, couponSetCodes.appliedCouponId))
      .leftJoin(subscriptions, eq(subscriptions.id, appliedCoupons.subscriptionId))
      .where(and(eq(couponSetCodes.businessId, businessId), eq(couponSetCodes.code, code)))
      .limit(1);
    return row ?? null;
  });
}

/** Filter/sort columns for the paged coupon list. `status` is the derived status. */
function couponSpecs(now: Date): Record<string, FilterSpec> {
  return {
    id: { column: coupons.code, kind: "text" },
    name: { column: coupons.name, kind: "text" },
    kind: { column: coupons.kind, kind: "enum" },
    apply_on: { column: coupons.applyOn, kind: "enum" },
    duration_type: { column: coupons.durationType, kind: "enum" },
    currency: { column: coupons.currency, kind: "enum" },
    status: { column: couponStatusSql(now), kind: "enum" },
    max_redemptions: { column: coupons.maxRedemptions, kind: "number" },
    times_redeemed: { column: coupons.timesRedeemed, kind: "number" },
    valid_from: { column: coupons.validFrom, kind: "date" },
    redeem_by: { column: coupons.redeemBy, kind: "date" },
    created_at: { column: coupons.createdAt, kind: "date" },
    updated_at: { column: coupons.updatedAt, kind: "date" },
  };
}
export const COUPON_PAGE_SPECS = couponSpecs(new Date(0));
export const COUPON_SORT_FIELDS = [
  "created_at",
  "updated_at",
  "name",
  "id",
  "times_redeemed",
  "redeem_by",
] as const;

/** `couponStatus` in SQL. The instant is bound as text: a raw Date breaks the driver. */
function couponStatusSql(now: Date): SQL {
  const t = sql`${now.toISOString()}::timestamptz`;
  return sql`(CASE WHEN NOT ${coupons.active} THEN 'archived'
    WHEN ${coupons.validFrom} > ${t} THEN 'future'
    WHEN ${coupons.redeemBy} < ${t} THEN 'expired'
    WHEN ${coupons.maxRedemptions} IS NOT NULL AND ${coupons.timesRedeemed} >= ${coupons.maxRedemptions} THEN 'expired'
    ELSE 'active' END)`;
}

/** Paged coupon list; the flat `kind`/`status`/`include_archived` params mean what they do unpaged. */
export async function pageCoupons(
  organizationId: string,
  businessId: string,
  opts: { includeArchived?: boolean; kind?: string; status?: string; now: Date },
  page: CatalogPageRequest,
): Promise<ListPage<typeof coupons.$inferSelect>> {
  return withTenant(organizationId, async (tx) => {
    const specs = couponSpecs(opts.now);
    const plan = await planPage(tx, businessId, page, {
      specs,
      sorts: {
        created_at: coupons.createdAt,
        updated_at: coupons.updatedAt,
        name: coupons.name,
        id: coupons.code,
        times_redeemed: coupons.timesRedeemed,
        redeem_by: coupons.redeemBy,
      },
      defaultSort: "created_at",
      tiebreak: coupons.code,
      searchColumns: [coupons.code, coupons.name],
      base: [
        eq(coupons.businessId, businessId),
        opts.includeArchived || opts.status === "archived" ? undefined : eq(coupons.active, true),
        opts.kind ? eq(coupons.kind, opts.kind) : undefined,
        opts.status ? sql`${couponStatusSql(opts.now)} = ${opts.status}` : undefined,
      ],
    });
    const rows = await tx
      .select()
      .from(coupons)
      .where(plan.where)
      .orderBy(...plan.orderBy)
      .limit(plan.limit + 1)
      .offset(plan.offset);
    const total =
      plan.offset === 0
        ? Number((await tx.select({ n: countExpr }).from(coupons).where(plan.where))[0]?.n ?? 0)
        : null;
    return finishPage(rows, plan, total);
  });
}

export const COUPON_SET_PAGE_SPECS: Record<string, FilterSpec> = {
  id: { column: couponSets.publicId, kind: "text" },
  name: { column: couponSets.name, kind: "text" },
  coupon: { column: coupons.code, kind: "text" },
  created_at: { column: couponSets.createdAt, kind: "date" },
  archived_at: { column: couponSets.archivedAt, kind: "date" },
};
export const COUPON_SET_SORT_FIELDS = ["created_at", "name", "id"] as const;

/** Paged coupon-set list, with the same counts as `listCouponSets`. */
export async function pageCouponSets(
  organizationId: string,
  businessId: string,
  opts: { includeArchived?: boolean },
  page: CatalogPageRequest,
): Promise<ListPage<CouponSetWithCounts>> {
  return withTenant(organizationId, async (tx) => {
    const plan = await planPage(tx, businessId, page, {
      specs: COUPON_SET_PAGE_SPECS,
      sorts: { created_at: couponSets.createdAt, name: couponSets.name, id: couponSets.publicId },
      defaultSort: "created_at",
      tiebreak: couponSets.publicId,
      searchColumns: [couponSets.publicId, couponSets.name],
      base: [
        eq(couponSets.businessId, businessId),
        opts.includeArchived ? undefined : isNull(couponSets.archivedAt),
      ],
    });
    const rows = await tx
      .select({
        set: couponSets,
        couponPublicId: coupons.code,
        totalCount: sql<number>`count(${couponSetCodes.id})::int`,
        redeemedCount: sql<number>`(count(${couponSetCodes.id}) filter (where ${couponSetCodes.status} = 'redeemed'))::int`,
        archivedCount: sql<number>`(count(${couponSetCodes.id}) filter (where ${couponSetCodes.status} = 'archived'))::int`,
        notRedeemedCount: sql<number>`(count(${couponSetCodes.id}) filter (where ${couponSetCodes.status} = 'not_redeemed'))::int`,
      })
      .from(couponSets)
      .innerJoin(coupons, eq(couponSets.couponId, coupons.id))
      .leftJoin(couponSetCodes, eq(couponSetCodes.couponSetId, couponSets.id))
      .where(plan.where)
      .groupBy(couponSets.id, coupons.code)
      .orderBy(...plan.orderBy)
      .limit(plan.limit + 1)
      .offset(plan.offset);
    const total =
      plan.offset === 0
        ? Number(
            (
              await tx
                .select({ n: countExpr })
                .from(couponSets)
                .innerJoin(coupons, eq(couponSets.couponId, coupons.id))
                .where(plan.where)
            )[0]?.n ?? 0,
          )
        : null;
    return finishPage(
      rows.map((r) => ({
        ...r,
        totalCount: Number(r.totalCount),
        redeemedCount: Number(r.redeemedCount),
        archivedCount: Number(r.archivedCount),
        notRedeemedCount: Number(r.notRedeemedCount),
      })),
      plan,
      total,
    );
  });
}

export const COUPON_CODE_PAGE_SPECS: Record<string, FilterSpec> = {
  code: { column: couponSetCodes.code, kind: "text" },
  status: { column: couponSetCodes.status, kind: "enum" },
  coupon_set: { column: couponSets.publicId, kind: "text" },
  coupon: { column: coupons.code, kind: "text" },
  redeemed_at: { column: couponSetCodes.redeemedAt, kind: "date" },
  created_at: { column: couponSetCodes.createdAt, kind: "date" },
};
export const COUPON_CODE_SORT_FIELDS = ["created_at", "redeemed_at", "code"] as const;

/**
 * Set codes across every set, or one set's. `page` absent → the whole matching set,
 * newest first. Null when `setPublicId` names no set.
 */
export async function pageCouponCodes(
  organizationId: string,
  businessId: string,
  opts: { setPublicId?: string; status?: string },
  page?: CatalogPageRequest,
): Promise<ListPage<CouponCodeRow> | null> {
  return withTenant(organizationId, async (tx) => {
    if (opts.setPublicId) {
      const [set] = await tx
        .select({ id: couponSets.id })
        .from(couponSets)
        .where(
          and(eq(couponSets.businessId, businessId), eq(couponSets.publicId, opts.setPublicId)),
        )
        .limit(1);
      if (!set) return null;
    }
    const base = [
      eq(couponSetCodes.businessId, businessId),
      opts.setPublicId ? eq(couponSets.publicId, opts.setPublicId) : undefined,
      opts.status ? eq(couponSetCodes.status, opts.status) : undefined,
    ];
    const from = () =>
      tx
        .select(codeSelection)
        .from(couponSetCodes)
        .innerJoin(couponSets, eq(couponSetCodes.couponSetId, couponSets.id))
        .innerJoin(coupons, eq(couponSets.couponId, coupons.id))
        .leftJoin(appliedCoupons, eq(appliedCoupons.id, couponSetCodes.appliedCouponId))
        .leftJoin(subscriptions, eq(subscriptions.id, appliedCoupons.subscriptionId));
    if (!page) {
      const rows = await from()
        .where(and(...base))
        .orderBy(desc(couponSetCodes.createdAt));
      return { data: rows, hasMore: false, nextCursor: null, total: rows.length };
    }
    const plan = await planPage(tx, businessId, page, {
      specs: COUPON_CODE_PAGE_SPECS,
      sorts: {
        created_at: couponSetCodes.createdAt,
        redeemed_at: couponSetCodes.redeemedAt,
        code: couponSetCodes.code,
      },
      defaultSort: "created_at",
      tiebreak: couponSetCodes.code,
      searchColumns: [couponSetCodes.code],
      base,
    });
    const rows = await from()
      .where(plan.where)
      .orderBy(...plan.orderBy)
      .limit(plan.limit + 1)
      .offset(plan.offset);
    const total =
      plan.offset === 0
        ? Number(
            (
              await tx
                .select({ n: countExpr })
                .from(couponSetCodes)
                .innerJoin(couponSets, eq(couponSetCodes.couponSetId, couponSets.id))
                .innerJoin(coupons, eq(couponSets.couponId, coupons.id))
                .where(plan.where)
            )[0]?.n ?? 0,
          )
        : null;
    return finishPage(rows, plan, total);
  });
}

// ── Coupon usage: stats + redemption history ────────────────────────────────────

export interface CouponStats {
  /** Every application of the coupon (set codes included), removed/exhausted too. */
  redemptions: number;
  /** Per invoice currency, non-voided invoices only. given = gross − reversed. */
  discountGiven: Array<{
    currency: string;
    amountMinor: bigint;
    grossMinor: bigint;
    reversedMinor: bigint;
  }>;
}

/** a × n / d, rounded half-up; 0 when d ≤ 0. */
const mulDivHalfUp = (a: bigint, n: bigint, d: bigint): bigint =>
  d > 0n ? (a * n * 2n + d) / (2n * d) : 0n;

/**
 * The coupon's discount reversed by non-voided credit notes, per invoice line.
 *  - A note item linked to a line reverses that line's coupon discount × item / line net
 *    (amount − discount, both pre-tax). Its unlinked items are the tax reversal: ignored.
 *  - A note with no linked item reverses every discounted line of its invoice by its gross
 *    share, (total + returned credits) / invoice total.
 * Each contribution rounds half-up to the minor unit; a line never reverses more than it got.
 */
async function couponDiscountReversed(
  tx: Tx,
  lines: ReadonlyArray<{ invoiceId: string; lineId: string; discount: bigint }>,
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (lines.length === 0) return out;
  const invoiceIds = [...new Set(lines.map((l) => l.invoiceId))];
  const notes = await tx
    .select({
      id: creditNotes.id,
      invoiceId: creditNotes.invoiceId,
      total: creditNotes.totalMinor,
      returned: sql<string>`coalesce((select sum(${creditNoteDiscounts.amountMinor})
        from ${creditNoteDiscounts} where ${creditNoteDiscounts.creditNoteId} = ${creditNotes.id}), 0)::text`,
      invoiceTotal: invoices.totalMinor,
    })
    .from(creditNotes)
    .innerJoin(invoices, eq(invoices.id, creditNotes.invoiceId))
    .where(and(inArray(creditNotes.invoiceId, invoiceIds), ne(creditNotes.status, "voided")));
  if (notes.length === 0) return out;
  const items = await tx
    .select({
      creditNoteId: creditNoteItems.creditNoteId,
      lineId: creditNoteItems.invoiceLineItemId,
      amount: creditNoteItems.amountMinor,
      lineAmount: invoiceLineItems.amountMinor,
      lineDiscount: invoiceLineItems.discountMinor,
    })
    .from(creditNoteItems)
    .leftJoin(invoiceLineItems, eq(invoiceLineItems.id, creditNoteItems.invoiceLineItemId))
    .where(
      inArray(
        creditNoteItems.creditNoteId,
        notes.map((n) => n.id),
      ),
    );
  const linkedNotes = new Set(items.filter((i) => i.lineId).map((i) => i.creditNoteId));
  const byLine = new Map(lines.map((l) => [l.lineId, l]));
  const add = (lineId: string, v: bigint) => out.set(lineId, (out.get(lineId) ?? 0n) + v);
  for (const it of items) {
    const l = it.lineId ? byLine.get(it.lineId) : undefined;
    if (!l) continue;
    add(
      l.lineId,
      mulDivHalfUp(l.discount, it.amount, (it.lineAmount ?? 0n) - (it.lineDiscount ?? 0n)),
    );
  }
  for (const n of notes) {
    if (linkedNotes.has(n.id)) continue;
    const gross = n.total + BigInt(n.returned);
    for (const l of lines)
      if (l.invoiceId === n.invoiceId)
        add(l.lineId, mulDivHalfUp(l.discount, gross, n.invoiceTotal));
  }
  for (const l of lines) {
    const r = out.get(l.lineId);
    if (r !== undefined && r > l.discount) out.set(l.lineId, l.discount);
  }
  return out;
}

/** Null when the coupon is not in this business. */
export async function couponStats(
  organizationId: string,
  businessId: string,
  couponCode: string,
): Promise<CouponStats | null> {
  return withTenant(organizationId, async (tx) => {
    const [c] = await tx
      .select({ id: coupons.id })
      .from(coupons)
      .where(and(eq(coupons.businessId, businessId), eq(coupons.code, couponCode)))
      .limit(1);
    if (!c) return null;
    const [r] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(appliedCoupons)
      .where(and(eq(appliedCoupons.businessId, businessId), eq(appliedCoupons.couponId, c.id)));
    const rows = await tx
      .select({
        invoiceId: invoiceLineDiscounts.invoiceId,
        lineId: invoiceLineDiscounts.invoiceLineItemId,
        currency: invoices.currency,
        amount: sql<string>`sum(${invoiceLineDiscounts.amountMinor})::text`,
      })
      .from(invoiceLineDiscounts)
      .innerJoin(appliedCoupons, eq(appliedCoupons.id, invoiceLineDiscounts.appliedCouponId))
      .innerJoin(invoices, eq(invoices.id, invoiceLineDiscounts.invoiceId))
      .where(
        and(
          eq(appliedCoupons.couponId, c.id),
          eq(invoices.businessId, businessId),
          ne(invoices.status, "voided"),
        ),
      )
      .groupBy(
        invoiceLineDiscounts.invoiceId,
        invoiceLineDiscounts.invoiceLineItemId,
        invoices.currency,
      );
    const lines = rows.map((x) => ({ ...x, discount: BigInt(x.amount ?? "0") }));
    const reversed = await couponDiscountReversed(tx, lines);
    const byCurrency = new Map<string, { gross: bigint; reversed: bigint }>();
    for (const l of lines) {
      const cur = l.currency.toUpperCase();
      const acc = byCurrency.get(cur) ?? { gross: 0n, reversed: 0n };
      acc.gross += l.discount;
      acc.reversed += reversed.get(l.lineId) ?? 0n;
      byCurrency.set(cur, acc);
    }
    return {
      redemptions: Number(r?.n ?? 0),
      discountGiven: [...byCurrency]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([currency, v]) => ({
          currency,
          amountMinor: v.gross - v.reversed,
          grossMinor: v.gross,
          reversedMinor: v.reversed,
        })),
    };
  });
}

export interface CouponRedemption {
  publicId: string;
  status: string;
  remainingPeriods: number | null;
  customerPublicId: string;
  subscriptionPublicId: string;
  /** The first non-voided invoice this redemption discounted; null until one has. */
  invoicePublicId: string | null;
  redeemedAt: Date;
  /** Total taken off non-voided invoices by this redemption. */
  discountMinor: bigint;
  currency: string;
}

/**
 * One page of a coupon's redemptions, newest first. Keyset on (created_at, public_id).
 * Null when the coupon is not in this business. Invoice + discount are hydrated for the
 * page only.
 */
export async function listCouponRedemptionsPage(
  organizationId: string,
  businessId: string,
  couponCode: string,
  opts: { limit?: number; startingAfter?: string } = {},
): Promise<ListPage<CouponRedemption> | null> {
  const limit = clampLimit(opts.limit);
  return withTenant(organizationId, async (tx) => {
    const [c] = await tx
      .select({ id: coupons.id })
      .from(coupons)
      .where(and(eq(coupons.businessId, businessId), eq(coupons.code, couponCode)))
      .limit(1);
    if (!c) return null;
    const conds: SQL[] = [
      eq(appliedCoupons.businessId, businessId),
      eq(appliedCoupons.couponId, c.id),
    ];
    let total: number | null = null;
    if (!opts.startingAfter) {
      const [row] = await tx
        .select({ n: countExpr })
        .from(appliedCoupons)
        .where(and(...conds));
      total = row?.n ?? 0;
    }
    const { keysetId } = parseCursor(opts.startingAfter);
    if (keysetId) {
      const [cursor] = await tx
        .select({
          createdAt: sql<string>`${appliedCoupons.createdAt}::text`,
          publicId: appliedCoupons.publicId,
        })
        .from(appliedCoupons)
        .where(and(eq(appliedCoupons.couponId, c.id), eq(appliedCoupons.publicId, keysetId)))
        .limit(1);
      const seek = keysetCondition(
        appliedCoupons.createdAt,
        appliedCoupons.publicId,
        cursor ? { sortValue: cursor.createdAt, tiebreak: cursor.publicId } : undefined,
        true,
      );
      if (seek) conds.push(seek);
    }
    const rows = await tx
      .select({
        id: appliedCoupons.id,
        publicId: appliedCoupons.publicId,
        status: appliedCoupons.status,
        remainingPeriods: appliedCoupons.remainingPeriods,
        createdAt: appliedCoupons.createdAt,
        subscriptionPublicId: subscriptions.publicId,
        currency: subscriptions.currency,
        customerPublicId: customers.publicId,
      })
      .from(appliedCoupons)
      .innerJoin(subscriptions, eq(subscriptions.id, appliedCoupons.subscriptionId))
      .innerJoin(customers, eq(customers.id, subscriptions.customerId))
      .where(and(...conds))
      .orderBy(desc(appliedCoupons.createdAt), desc(appliedCoupons.publicId))
      .limit(limit + 1);
    const page = toPage(rows, limit, {
      keyset: true,
      offset: 0,
      keyOf: (r) => r.publicId,
      total,
    });
    const ids = page.data.map((r) => r.id);
    const byRedemption = new Map<string, { amount: bigint; invoice: string | null }>();
    if (ids.length > 0) {
      const shares = await tx
        .select({
          appliedCouponId: invoiceLineDiscounts.appliedCouponId,
          amount: sql<string>`sum(${invoiceLineDiscounts.amountMinor})::text`,
          firstInvoice: sql<
            string | null
          >`(array_agg(${invoices.publicId} order by ${invoices.createdAt}, ${invoices.publicId}))[1]`,
        })
        .from(invoiceLineDiscounts)
        .innerJoin(invoices, eq(invoices.id, invoiceLineDiscounts.invoiceId))
        .where(
          and(inArray(invoiceLineDiscounts.appliedCouponId, ids), ne(invoices.status, "voided")),
        )
        .groupBy(invoiceLineDiscounts.appliedCouponId);
      for (const s of shares)
        if (s.appliedCouponId)
          byRedemption.set(s.appliedCouponId, {
            amount: BigInt(s.amount ?? "0"),
            invoice: s.firstInvoice,
          });
    }
    return {
      ...page,
      data: page.data.map((r) => ({
        publicId: r.publicId,
        status: r.status,
        remainingPeriods: r.remainingPeriods,
        customerPublicId: r.customerPublicId,
        subscriptionPublicId: r.subscriptionPublicId,
        invoicePublicId: byRedemption.get(r.id)?.invoice ?? null,
        redeemedAt: r.createdAt,
        discountMinor: byRedemption.get(r.id)?.amount ?? 0n,
        currency: r.currency.toUpperCase(),
      })),
    };
  });
}

import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { assertTestBusinessRoom } from "@/modules/tenancy/test-limits";
import { recordExchangeRateObservations } from "@/platform/fx/history";
import { publicId } from "@/platform/ids";
// Used by the gateway-accounts import block (GATEWAY_ACCOUNT_IMPORT_ENABLED, below).
import { pinnedGatewayAccountId } from "@/platform/config";
import { encryptCredentials } from "@/platform/secrets";
import { internationalCurrencies } from "@/modules/gateway/service";
import { enterEventContext } from "@/platform/event-context";
import { enterTraceContext, newTraceId } from "@/platform/trace";
import {
  createProduct,
  createPrice,
  createProductGroup,
  setItemApplicablePlans,
  setDifferentialPrice,
  slugify,
  validateSlug,
  type Applicability,
  type AttachedItemConfig,
} from "@/modules/catalog/service";
import { snapshotPrice, isOverridable } from "@/modules/catalog/pricing";
import { createCustomer, changeBillingDate } from "@/modules/customers/service";
import { createDefinition, listDefinitions } from "@/modules/custom-fields/service";
import { listTaxRegions } from "@/modules/tax/service";
import { createCoupon } from "@/modules/coupons/service";
import { topUpWallet } from "@/modules/wallet/service";
import {
  addInterval,
  computeSubscriptionMrr,
  discountsForMrr,
  netMrrForDiscounts,
  type ActiveDiscountForMrr,
  type Interval,
} from "@/modules/subscriptions/service";
import {
  alignTermStart,
  loadBillingMode,
  normalizeTermEnd,
} from "@/modules/subscriptions/billing-mode";
import { scheduleChange } from "@/modules/subscriptions/scheduled-changes";
import { importArchivalInvoice } from "@/modules/invoicing/import";
import { inheritedInvoiceRate } from "@/modules/invoicing/exchange-rate";
import { postEntries } from "@/modules/ledger/service";
import {
  importRecords,
  importedEvents,
  subscriptions,
  subscriptionItems,
  appliedCoupons,
  prices,
  products,
  customers,
  paymentMethods,
  productGroups,
  coupons,
  couponSets,
  couponSetCodes,
  contacts,
  unbilledCharges,
  creditNotes,
  creditNoteItems,
  creditNoteAllocations,
  transactions,
  payments,
  refunds,
  businesses,
  gatewayAccounts,
  usageRecords,
  providerCustomers,
  invoices as invoicesTable,
} from "@db/schema";
import { OPEN_INVOICE_STATUSES, discountScope } from "./types";
import type {
  MigrationSource,
  SourceCatalog,
  SourceSubscription,
  SourceSubscriptionDiscount,
  SourceSubStatus,
  SourceNonPortablePaymentMethod,
} from "./types";
import { createLogger } from "@/platform/logger";

const log = createLogger("migration.import");

/**
 * Normalize a source id to a slug, DEDUPED within this import run: two ids like
 * `Foo-Bar` and `foo_bar` normalize to the same slug;
 * without a suffix the second insert dies on SlugConflictError mid-import.
 */
function makeSlugger(): (sourceId: string) => string {
  const used = new Set<string>();
  return (sourceId: string) => {
    const base = validateSlug(sourceId) ? sourceId : slugify(sourceId);
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base.slice(0, 96)}-${n++}`;
    used.add(slug);
    return slug;
  };
}

export interface ResourceCounts {
  created: number;
  skipped: number;
  failed: number;
}

/**
 * A source feature the importer deliberately did NOT import, because tmbilling can
 * express nothing equivalent and approximating it would be worse than omitting it.
 *
 * Deliberately NOT a `failed` count. A failure means "this should have imported and
 * something went wrong" — it is actionable, it exits the run non-zero, and re-running
 * might fix it. None of that is true here: the refusal is the correct outcome, it is
 * identical on every re-run, and nothing the operator does to the source will change
 * it. Counted as a failure it turns a clean import red forever, which trains people to
 * ignore the failure count — the same reasoning that puts non-portable payment methods
 * in their own list (`nonPortablePaymentMethods`) instead of among the failures.
 *
 * It is still REPORTED, loudly and per record: silently dropping a discount is how the
 * subscription-`discounts[]` billing bug survived (see 2026-08-07 in the module README).
 */
export interface UnsupportedSourceFeature {
  /** What kind of source object was refused. */
  kind: "subscription_discount";
  /** The refused object's own source id. */
  sourceId: string;
  /** The source object it hangs off (the subscription, for a discount). */
  ownerSourceId: string;
  /** Why we cannot express it — written for an operator, not a stack trace. */
  reason: string;
}

export interface ImportResult {
  source: string;
  counts: Record<string, ResourceCounts>;
  warnings: string[];
  nonPortablePaymentMethods: SourceNonPortablePaymentMethod[];
  /** Known-unsupported source features, skipped on purpose — see the type. */
  unsupported: UnsupportedSourceFeature[];
  /** Invariant we assert: importing NEVER charges anyone. */
  charges: number;
}

/**
 * Narrow WHAT gets imported. Default (absent) is the whole site.
 *
 * A parallel/shadow run only needs the book the clock will actually act on, and
 * every customer imported beyond that is production personal data copied onto
 * another host for no analytical gain — so the scope is deliberately explicit
 * rather than "everything, it's inert anyway".
 *
 * Exported because **`reconcileWithSource` must be given the same value**. Reconcile
 * pulls the source and diffs it against what landed here; run against the whole site
 * after a scoped import, every deliberately-excluded record reads as a mismatch, so
 * the reconcile gate can never pass by construction — and a permanently-red gate is
 * one people stop reading.
 */
export interface ImportScope {
  /**
   * Keep only subscriptions in these source statuses. Omitted → all.
   * Billable set = active, trialing, future, paused, non_renewing (i.e. all but
   * `canceled`).
   */
  subscriptionStatuses?: SourceSubStatus[];
  /**
   * Drop customers left with no retained subscription. Their invoices and other
   * per-customer rows are skipped with them (counted, not silently lost).
   *
   * Trade-off: a customer whose only subscription was cancelled is absent, so a
   * later reactivation at the source has nothing here to reactivate. That surfaces
   * as an unmapped source id downstream — a visible gap, which is the right
   * failure mode for a run whose whole purpose is measuring differences.
   */
  dropCustomersWithoutSubscriptions?: boolean;
  /**
   * Import the CATALOG (product groups, products, prices, attached items,
   * differential prices) and coupons, and nothing per-customer: no customers, no
   * subscriptions, no invoices, transactions, credit notes or usage.
   *
   * This is the India-first launch's shape (docs/INDIA-LAUNCH.md §6 Phase 1): new
   * customers are billed here while the existing book stays on the source. Importing
   * that book would be actively wrong, not merely wasteful — `importFromSource` takes
   * over renewals from the current term end, so a subscription that lands here is one
   * this engine will start billing while the source system also bills it.
   *
   * ⚠️ The empty retained id-sets are NOT sufficient on their own. They gate customers,
   * subscriptions and invoices — the three phases that filter against them — but the
   * unbilled-charge, usage, transaction, credit-note and event phases read their source
   * lists unconditionally. The first two then `throw` on an unmapped subscription, so a
   * catalog-only run against any real book FAILED rather than skipping. Each of those
   * phases is now guarded explicitly; a new per-customer phase must add itself here too.
   *
   * ── WHY A FLAG AND NOT `subscriptionStatuses: []` ──────────────────────────────
   * The empty array does produce the same retained sets, and that is the trap: an
   * OMITTED `subscriptionStatuses` means "all" while an EMPTY one means "none", so the
   * two spellings look nearly identical at a call site and mean opposites. A reader
   * cannot tell an intentional "none" from a mistakenly-emptied filter.
   *
   * ⚠️ It does NOT save the source read, despite an earlier version of this comment
   * claiming so. Scope resolution skips its own `listSubscriptions`, but the import
   * phases call it again and are filtered locally — a real catalog-only run still
   * fetched 219 subscriptions and 375 invoices before discarding all of them. The flag
   * is about what LANDS, not about what is transferred. Making it skip the fetch too
   * means gating those phases before their `source.list*` call, which is a separate
   * change.
   */
  catalogOnly?: boolean;
  /**
   * Skip the CATALOG phase entirely — items, prices, add-on applicability,
   * differential prices, coupons and coupon SETS/CODES — because the destination
   * business already has them.
   *
   * For a partial migration this is the difference between a handful of requests and
   * several hundred. The catalog read is site-wide and cannot be scoped: `/attached_items`
   * has no top-level collection so it fans out one request per plan item, and
   * `/coupon_codes` is walked once per coupon set (ten paged requests each on a large book).
   * A subset import of ONE subscription was paying all of it to re-derive a catalog the
   * business already held.
   *
   * Only two things the catalog phase builds are read by later phases — the price rows
   * and the coupon rows the subscription phase resolves its items and applied coupons
   * against. Both are re-read from THIS business instead, joined through `import_records`,
   * so skipping the source read changes what is transferred and nothing about what lands.
   * If a price or coupon a subscription needs is genuinely absent here, the existing
   * `not in import set` error still fires — the guarantee is preserved, not waived.
   *
   * Mutually exclusive with `catalogOnly`, which means the exact opposite.
   */
  skipCatalog?: boolean;
  /**
   * Import ONLY these subscriptions, by source id, and only the customers holding
   * one. Everything else on the source is left alone.
   *
   * This is the partial-migration shape (docs/MIGRATION.md): a source site that keeps
   * serving customers we are NOT moving. `catalogOnly` leaves the whole book behind and
   * an unscoped import takes all of it; neither can express "these 34 and nothing else",
   * and the gap matters because `importFromSource` takes over renewals from
   * `currentTermEnd` — so a subscription that lands here by accident is one this engine
   * bills while the source system also bills it.
   *
   * ── WHY AN EXPLICIT ID LIST AND NOT A CURRENCY FILTER ─────────────────────────
   * A currency filter cannot express the real requirement. The INR cutover has to move
   * 34 subscriptions and deliberately LEAVE 4 behind that are also INR and also active —
   * our own test accounts. A predicate that selects on an attribute they share with the
   * customers we are migrating selects them too. An id list is also auditable: the set
   * is decided and reviewed before the run rather than recomputed inside it, so a
   * subscription created between the review and the run cannot silently widen the scope.
   *
   * ⚠️ An EMPTY array is refused rather than treated as "none" — the exact trap
   * `catalogOnly`'s own comment describes. If you mean "no subscriptions", say
   * `catalogOnly`.
   *
   * ⚠️ Scoping customers is NOT optional here, and it is not the same decision as
   * `dropCustomersWithoutSubscriptions`. Importing every customer alongside 34
   * subscriptions would copy hundreds of uninvolved people's names, emails and
   * addresses onto this host for no operational benefit, so the retained customer set
   * is always derived from the retained subscriptions.
   *
   * ⚠️ Refused together with `includeEvents`. `SourceEvent` carries no customer or
   * subscription reference at all (id, type, timestamp, payload), so the event log
   * cannot be filtered to a subset — importing it would put the ENTIRE source site's
   * history into a business holding 34 subscriptions. Pass `--no-events`.
   */
  subscriptionSourceIds?: string[];
}

export interface ImportOptions {
  scope?: ImportScope;
  /** Import settled invoices/credit-notes/transactions as archival rows (default true). */
  includeHistory?: boolean;
  /** Import the source's raw event log into imported_events (default true). */
  includeEvents?: boolean;
  /**
   * Skip the gateway-account discovery phase (default false).
   *
   * That phase is a CENSUS: to catch a gateway seen only on a settled transaction it
   * reads the source's whole transaction history — 47,965 rows on a production book, ~480
   * pages, the single largest cost of a subset import. What it produces is `disabled`
   * placeholder rows with no credentials.
   *
   * Pointless when the destination business already has its gateways configured, which
   * is the partial-migration case. Safe there too, and not by luck: card binding reads
   * ACTIVE accounts from our own database, so a phase that only ever writes disabled
   * rows cannot change which account a card binds to.
   */
  skipGatewayAccounts?: boolean;
  /**
   * Emit no domain events for anything this import writes (default: emit).
   *
   * ⚠️ NOT the same as `includeEvents`, which is about the SOURCE's event log. This one
   * is about OURS. A subset import of 34 customers emits ~6,000 events on a first run —
   * almost all of them catalog rows — and every one enqueues a webhook delivery.
   *
   * What it does NOT silence: the billing clock. Once imported, the clock treats these
   * as ordinary subscriptions and will mail renewal reminders. Suppressing here does not
   * change that, and expecting it to is the easy mistake.
   */
  suppressEmittedEvents?: boolean;
  /** Called after each phase with the running counts (drives run progress). */
  onProgress?: (phase: string, counts: Record<string, ResourceCounts>) => void | Promise<void>;
  /** The file import run this import belongs to: stamped on each import record it writes. */
  runId?: string;
  /** Called once per source object with what happened to it (a file import's row results). */
  onRecord?: (rec: ImportRecordOutcome) => void | Promise<void>;
}

export interface ImportRecordOutcome {
  sourceType: string;
  sourceId: string;
  /** `skipped`: imported before, or the phase chose not to write it. */
  outcome: "created" | "skipped" | "failed";
  targetId?: string;
  error?: string;
}

/**
 * The start of an imported subscription's current term when the source reports none —
 * the usual case for a cancelled or trialing subscription. Never later than `periodEnd`.
 *
 * - A term that ends with the trial WAS the trial: start at `trialStart`.
 * - Otherwise it was one billing interval long, but not before the subscription began.
 */
export function importedTermStart(
  s: Pick<
    SourceSubscription,
    "currentTermStart" | "trialStart" | "trialEnd" | "startDate" | "startedAt"
  >,
  periodEnd: Date,
  interval: Interval,
  intervalCount: number,
  now: Date,
): Date {
  if (s.currentTermStart) return s.currentTermStart;
  const DAY_MS = 86_400_000;
  if (s.trialStart && s.trialEnd && periodEnd.getTime() <= s.trialEnd.getTime() + DAY_MS) {
    return s.trialStart;
  }
  const lastTerm = addInterval(periodEnd, interval, -intervalCount);
  const began = s.startDate ?? s.startedAt ?? s.trialStart;
  const start = began && began.getTime() > lastTerm.getTime() ? began : lastTerm;
  // `now` only bounds a source that reports no dates at all.
  const bounded = began ? start : new Date(Math.min(start.getTime(), now.getTime()));
  return bounded.getTime() > periodEnd.getTime() ? periodEnd : bounded;
}

/**
 * Map an external subscription status to our state machine.
 *
 * `scheduledCancel` carries a cancellation the source has already accepted but not yet
 * applied — a trial the buyer cancelled that lapses at trial end reads `trialing` with a
 * FUTURE cancel date, not `non_renewing`. Without it that intent is dropped and we convert
 * and bill someone who cancelled, while the source quietly cancels on its own schedule.
 */
function mapStatus(
  s: SourceSubscription["status"],
  scheduledCancel = false,
): {
  status: string;
  cancelAtPeriodEnd: boolean;
} {
  if (scheduledCancel && s !== "canceled" && s !== "paused") {
    return { status: s === "trialing" ? "in_trial" : "active", cancelAtPeriodEnd: true };
  }
  switch (s) {
    case "non_renewing":
      return { status: "active", cancelAtPeriodEnd: true };
    case "trialing":
      return { status: "in_trial", cancelAtPeriodEnd: false };
    case "future":
      // Imported future subs are brought in as `active` with a future period so
      // the billing clock first-bills them at term (import sets no start_date to
      // drive the SUB-1 future→start pass); avoids stranding them in `future`.
      return { status: "active", cancelAtPeriodEnd: false };
    case "paused":
      return { status: "paused", cancelAtPeriodEnd: false };
    case "canceled":
      return { status: "cancelled", cancelAtPeriodEnd: false };
    default:
      return { status: "active", cancelAtPeriodEnd: false };
  }
}

/** The subscription's billing cadence, as the discount span has to be measured against. */
export interface DiscountCadence {
  interval: "day" | "week" | "month" | "year";
  intervalCount: number;
}

/** Months per unit — exact. `day`/`week` have none, which is the whole difficulty. */
const MONTHS_PER_UNIT: Record<string, number | null> = {
  day: null,
  week: null,
  month: 1,
  year: 12,
};
/** Days per unit — exact for day/week; the month/year entries are the CALENDAR AVERAGE. */
const DAYS_PER_UNIT: Record<string, number> = { day: 1, week: 7, month: 365 / 12, year: 365 };

/**
 * How many BILLING PERIODS does a source discount span cover?
 *
 * A source expresses a `limited_period` discount as `period` + `period_unit` — a
 * WALL-CLOCK window ("10% off for 12 months"). We consume a discount once per invoice,
 * so `applied_coupons.total_periods` counts INVOICES. Mirroring the source therefore
 * means asking how many invoices fall inside its window.
 *
 * Invoices land at t = 0, B, 2B, … (B = one billing period), and the window is [0, W).
 * The count of those instants is **ceil(W / B)**, which is also exact when W divides B:
 *
 *   W=12mo on a 1mo cadence  → 12 invoices  (unchanged from the old reading)
 *   W=12mo on a 12mo cadence →  1 invoice   (was 12 — twelve YEARS of discount)
 *   W=18mo on a 12mo cadence →  2 invoices  (months 0 and 12; month 24 is outside)
 *   W=1mo  on a 12mo cadence →  1 invoice   (the signup invoice is inside the window)
 *
 * **Units.** month↔year are exact in months, and day↔week are exact in days, so those
 * pairs need no approximation. Only a MIXED pair (a day/week span against a month/year
 * cadence, or the reverse) has no exact answer — a "month" is 28–31 days — so those go
 * through a 365/12-day month and are reported by `approximate`, for the caller to warn
 * about. Every real subscription discount we have seen is month- or year-spanned
 * against a month- or year-cadence, i.e. exact.
 */
export function discountSpanInBillingPeriods(
  span: { periods: number; unit: "day" | "week" | "month" | "year" },
  cadence: DiscountCadence,
): { periods: number; approximate: boolean } {
  const spanMonths = MONTHS_PER_UNIT[span.unit];
  const cadenceMonths = MONTHS_PER_UNIT[cadence.interval];
  const exactInMonths = spanMonths != null && cadenceMonths != null;
  const w = exactInMonths ? span.periods * spanMonths! : span.periods * DAYS_PER_UNIT[span.unit]!;
  const b = exactInMonths
    ? cadence.intervalCount * cadenceMonths!
    : cadence.intervalCount * DAYS_PER_UNIT[cadence.interval]!;
  // A cadence of zero length is not representable, but never trust it into a divide.
  if (!(b > 0)) return { periods: Math.max(1, Math.round(span.periods)), approximate: true };
  // Both-day/week is exact too (a week is exactly 7 days); only a MIXED pair approximates.
  const approximate = !exactInMonths && (spanMonths != null || cadenceMonths != null);
  // Guard the float: 12/12 must be 1, not 0.9999999 rounding up to 2.
  const ratio = w / b;
  const periods = Math.max(1, Math.ceil(Number(ratio.toFixed(6))));
  return { periods, approximate };
}

/**
 * A source subscription-level discount → our `applied_coupons.remaining_periods`
 * (null = unlimited, i.e. `forever`; 0 = already used up → the row imports
 * `exhausted`). Mid-life state is carried over verbatim: a `limited_period`
 * discount that has already applied 3 of its 6 periods resumes with 3 left.
 */
export function discountRemainingPeriods(
  d: SourceSubscriptionDiscount,
  cadence: DiscountCadence | null,
): number | null {
  switch (d.durationType) {
    case "forever":
      return null;
    case "limited_period":
      // `timesApplied` is the source's `applied_count` — how many INVOICES it has discounted,
      // so it is subtracted from the converted (invoice-denominated) span.
      return Math.max(0, limitedPeriodBillingPeriods(d, cadence) - (d.timesApplied ?? 0));
    default: // one_time
      return (d.timesApplied ?? 0) > 0 ? 0 : 1;
  }
}

/**
 * A `limited_period` discount's span, in BILLING PERIODS — the unit our
 * `total_periods`/`remaining_periods` count in.
 *
 * `cadence: null`, or a source that reported no `period_unit`, falls back to reading
 * the source's number as billing periods. That is the honest fallback for a source that never told us the unit; it
 * is NOT a silent approximation, because a discount whose unit we do know is always
 * converted.
 */
function limitedPeriodBillingPeriods(
  d: SourceSubscriptionDiscount,
  cadence: DiscountCadence | null,
): number {
  const raw = Math.max(1, d.periods ?? 1);
  if (d.periodUnit == null || cadence == null) return raw;
  return discountSpanInBillingPeriods({ periods: raw, unit: d.periodUnit }, cadence).periods;
}

/**
 * A source subscription-level discount → our `applied_coupons.total_periods`
 * (null = unlimited). This is the ORIGINAL span, not what is left of it: it is
 * what the MRR rule reads (`discountsForMrr`), and a 6-period discount already
 * 5 periods in still restates the recurring rate for its final period.
 *
 * The source expresses this span as `period` + `period_unit` — a WALL-CLOCK window —
 * while we consume a discount once per invoice. It is converted
 * (`discountSpanInBillingPeriods`) against the subscription's cadence, so "12 months"
 * is 12 periods on a monthly plan and ONE on a yearly one.
 *
 * A source that reports no `period_unit` keeps the old reading (its number IS billing
 * periods) — the honest fallback when the unit was never told to us, and not an
 * approximation, since a known unit is always converted.
 */
export function discountTotalPeriods(
  d: SourceSubscriptionDiscount,
  cadence: DiscountCadence | null,
): number | null {
  switch (d.durationType) {
    case "forever":
      return null;
    case "limited_period":
      return limitedPeriodBillingPeriods(d, cadence);
    default: // one_time
      return 1;
  }
}

/** A source coupon → `applied_coupons.total_periods` (null = `forever`). */
export function couponTotalPeriods(c: typeof coupons.$inferSelect): number | null {
  switch (c.durationType) {
    case "forever":
      return null;
    case "repeating":
      return Math.max(1, c.durationInPeriods ?? 1);
    default: // once
      return 1;
  }
}

/**
 * `apply_on: specific_item_price` scopes a discount to ONE item price. Our
 * manual-discount row has no such scope — `peekDiscounts` projects every manual
 * row as `applyOn: 'invoice_amount'` — so importing one would discount the WHOLE
 * invoice and over-discount the customer. The importer refuses these instead
 * (loud failure in the import report), rather than approximating them.
 */
export function discountIsImportable(d: SourceSubscriptionDiscount): boolean {
  return (d.applyOn ?? "invoice_amount") !== "specific_item_price";
}

/**
 * Project a source subscription's coupons + standalone discounts onto the
 * netting shape, so the imported `mrr` column matches what the engine's own
 * `recomputeSubscriptionMrr` would produce for the same composition.
 *
 * Imported gross, this column read 10.2× the source's own figure on a production book
 * ($499.94K vs $48.95K) — and, worse, hid that the discounts behind the
 * difference were not imported at all.
 */
export function discountsForImportedMrr(
  s: SourceSubscription,
  couponBySource: Map<string, typeof coupons.$inferSelect>,
  /** The subscription's billing cadence — a discount's span is measured against it. */
  cadence: DiscountCadence | null,
): ActiveDiscountForMrr[] {
  const blank = {
    manualKind: null,
    manualPercentOffBps: null,
    manualAmountOffMinor: null,
    manualCurrency: null,
  };
  const fromCoupons: ActiveDiscountForMrr[] = (s.appliedCoupons ?? []).flatMap((ac) => {
    const c = couponBySource.get(ac.couponSourceId);
    if (!c) return [];
    return [
      {
        source: "coupon",
        remainingPeriods: null,
        totalPeriods: couponTotalPeriods(c),
        ...blank,
        coupon: {
          kind: c.kind,
          percentOffBps: c.percentOffBps,
          amountOffMinor: c.amountOffMinor,
          currency: c.currency,
          durationType: c.durationType,
        },
      },
    ];
  });
  const fromDiscounts: ActiveDiscountForMrr[] = (s.discounts ?? [])
    .filter(discountIsImportable)
    .map((d) => ({
      source: "manual",
      remainingPeriods: discountRemainingPeriods(d, cadence),
      totalPeriods: discountTotalPeriods(d, cadence),
      manualKind: d.kind,
      manualPercentOffBps: d.percentOffBps ?? null,
      manualAmountOffMinor: d.amountOffMinor != null ? BigInt(d.amountOffMinor) : null,
      manualCurrency: d.currency ?? null,
      coupon: null,
    }));
  return [...fromCoupons, ...fromDiscounts];
}

/**
 * Refuse an import whose org-scoped idempotency ledger already belongs to a
 * DIFFERENT business, naming the owner.
 *
 * The ledger is ORG-scoped by constraint (`import_records_uq` is
 * (organization_id, source, source_type, source_id) — deliberately without
 * business_id), so one org holds one import of one source. Importing the same source
 * into a SECOND business of the same org used to skip every row as "already imported"
 * while those rows lived in the other business: the run produced an EMPTY business,
 * then failed with a pile of `No such product` warnings from the applicability step
 * and no indication of the real cause (2026-08-03 — it cost an hour to diagnose, and
 * the misleading symptom was that products showed `0+77`, i.e. 77 SKIPPED, which reads
 * like 77 created unless you know the counter format). Refuse up front rather than
 * writing nothing and reporting a lie.
 *
 * `importFromSource` calls this itself, so no caller can skip it. It is ALSO exported
 * so a CLI can run it **before** provisioning the destination: the import CLI
 * used to create the fresh business first, so a refusal left an empty business row
 * behind — the exact artefact the guard exists to prevent. Omit `businessId` for that
 * pre-provision check: with no destination yet, ANY prior import of this source in the
 * org is a conflict.
 */
export async function assertImportLedgerFree(input: {
  organizationId: string;
  sourceName: string;
  /** Intended destination. Omit when it does not exist yet (pre-provision check). */
  businessId?: string;
}): Promise<void> {
  const { organizationId, sourceName, businessId } = input;
  const foreign = await withTenant(organizationId, async (tx) => {
    const sameSource = eq(importRecords.source, sourceName);
    const [row] = await tx
      .select({ businessId: importRecords.businessId })
      .from(importRecords)
      .where(businessId ? and(sameSource, ne(importRecords.businessId, businessId)) : sameSource)
      .limit(1);
    return row?.businessId ?? null;
  });
  if (!foreign) return;
  throw new Error(
    `This organization has already imported source '${sourceName}' into business ${foreign}. ` +
      `The import ledger is org-scoped, so importing it into ` +
      `${businessId ? `business ${businessId}` : "a new business of this organization"} as well ` +
      `would skip every row and leave that business empty. Re-run against the business that owns ` +
      `the import (--business-id ${foreign}) to continue idempotently, or import into a fresh org.`,
  );
}

/**
 * Import an external billing system into a tmbilling business.
 *
 * CRITICAL invariants:
 *  - Importing NEVER charges: subscriptions keep their already-paid term
 *    (currentPeriodEnd = source term end, in the future); tmbilling takes over
 *    at the next natural renewal, so nobody is double-billed.
 *  - Idempotent: every object is recorded in import_records (unique per
 *    org+source+type+id); re-running skips what's already imported.
 *  - History is ARCHIVAL (Option A): settled invoices/payments/refunds/credit
 *    notes carry no ledger postings; the ledger opens with entries only for
 *    live money (open AR, promo credits, refundable credit-note balances).
 */
/**
 * Is the gateway-account import block below live?
 *
 * Deriving accounts can mean paginating the SOURCE'S ENTIRE transaction +
 * payment_source history (some sources have no gateway-accounts API), which took ~20
 * minutes on a mature live book to produce 3 rows. The cost is scoped: a source adapter's
 * `listGatewayAccounts` may skip the `/transactions` walk under `includeHistory: false`,
 * and every caller that needs the exhaustive set (`inventory()`, a real cutover import)
 * already pages transactions for its own reasons and pays nothing extra.
 *
 * It is a constant rather than a comment because `verify:import-id-stable` exists to
 * cover that block, and nothing disabled the gate when the block was disabled — so it
 * failed 4/6 permanently, and, not being in `verify:all`'s CORE list, failed where
 * nobody was looking. A gate that is red for a known reason teaches people to ignore it.
 * The suite SKIPS on this flag and says why, so disabling the block again (should the
 * scoping above prove insufficient) re-disarms its own coverage the same way.
 */
export const GATEWAY_ACCOUNT_IMPORT_ENABLED = true;

/** Every array the catalog phase iterates, empty. See ImportScope.skipCatalog. */
const EMPTY_CATALOG: SourceCatalog = {
  groups: [],
  products: [],
  prices: [],
  attachedAddons: [],
  differentialPrices: [],
};

export async function importFromSource(input: {
  organizationId: string;
  businessId: string;
  source: MigrationSource;
  options?: ImportOptions;
}): Promise<ImportResult> {
  const { organizationId, businessId, source } = input;
  const opts = input.options ?? {};
  // Stamp everything the importer emits as source='migration' (EV-2). Safe here:
  // the importer runs from a standalone script, not inside a request context.
  enterEventContext({
    source: "migration",
    actor: `import:${source.name}`,
    suppressEvents: opts.suppressEmittedEvents === true,
  });
  // One `mig-` trace for the whole import, so every row it touches and every
  // warning it emits can be pulled up as a single run.
  enterTraceContext({ traceId: newTraceId("mig") });
  const includeHistory = opts.includeHistory ?? true;
  const includeEvents = opts.includeEvents ?? true;

  const result: ImportResult = {
    source: source.name,
    counts: {},
    warnings: [],
    nonPortablePaymentMethods: [],
    unsupported: [],
    charges: 0, // never incremented — importing does not charge
  };
  const count = (key: string): ResourceCounts =>
    (result.counts[key] ??= { created: 0, skipped: 0, failed: 0 });
  const warn = (msg: string) => result.warnings.push(msg);
  // Hoisted: the catalog-only early return (below, after coupons) needs this before the
  // scope block that used to declare it.
  const catalogOnly = opts.scope?.catalogOnly === true;
  const skipCatalog = opts.scope?.skipCatalog === true;
  if (catalogOnly && skipCatalog) {
    throw new Error(
      "ImportScope.catalogOnly and .skipCatalog are mutually exclusive: the first imports " +
        "ONLY the catalog, the second imports everything BUT the catalog.",
    );
  }

  /**
   * Subscription-subset validation, up front and fatal.
   *
   * These three are refused rather than reconciled because every one of them has a
   * silent wrong answer: an empty list reads as "none" to one person and "unset" to the
   * next, `catalogOnly` plus a list is two scopes disagreeing, and events cannot be
   * filtered to a subset at all. A run that guesses here is a run whose scope nobody
   * can reconstruct afterwards.
   */
  const subsetIds = opts.scope?.subscriptionSourceIds;
  if (subsetIds) {
    if (subsetIds.length === 0) {
      throw new Error(
        "ImportScope.subscriptionSourceIds is an empty array. An empty list is refused because " +
          'it reads as both "none" and "unset" — pass `catalogOnly: true` to import no subscriptions.',
      );
    }
    if (catalogOnly) {
      throw new Error(
        "ImportScope.catalogOnly and .subscriptionSourceIds are mutually exclusive: the first " +
          "imports no subscriptions at all, the second names which ones to import.",
      );
    }
    if (opts.includeEvents !== false) {
      throw new Error(
        "A subscription-scoped import cannot include the source event log: SourceEvent carries no " +
          "customer or subscription reference, so events cannot be filtered to the subset and the " +
          "ENTIRE source site's history would be imported. Pass includeEvents: false (--no-events).",
      );
    }
    const dupes = subsetIds.length - new Set(subsetIds).size;
    if (dupes > 0) {
      warn(`subscriptionSourceIds contained ${dupes} duplicate id(s); they are de-duplicated.`);
    }
  }

  await assertImportLedgerFree({ organizationId, sourceName: source.name, businessId });

  const progress = async (phase: string) => {
    await opts.onProgress?.(phase, result.counts);
  };

  // --- site config (currencies + FX) -----------------------------------------
  // Clone the source's enabled currencies and manual FX rates onto the business.
  // Only structural config the source API exposes; feature toggles/gateways/timezone
  // are UI-only and not imported. Best-effort: a failure here must not abort the import.
  if (source.readSiteConfig) {
    // Idempotent like every other phase: recorded under a synthetic
    // ('site_config','site') import key so a RE-import SKIPS (created stays 0)
    // instead of re-applying the clone and re-counting it as created — which
    // otherwise trips the importer's "nothing re-created" idempotency assertion.
    // importOne is hoisted (function declaration) so it's callable here.
    await importOne("site_config", "site_config", "site", async () => {
      const cfg = await source.readSiteConfig!();
      // Derive the billing-frequency allow-list from the catalog's distinct recurring
      // (interval, count) combos — the frequencies actually in use on the source site.
      const freqSet = new Map<string, { interval: string; count: number }>();
      try {
        const cat = await source.listCatalog();
        for (const pr of cat.prices) {
          if (pr.interval) {
            const count = pr.intervalCount ?? 1;
            freqSet.set(`${pr.interval}:${count}`, { interval: pr.interval, count });
          }
        }
      } catch (e) {
        // Unrestricted frequencies are a safe default, but they are NOT what the
        // source site had — say so, or the imported business silently allows
        // billing frequencies the merchant never offered.
        log.warn("source catalog unavailable — billing frequencies left unrestricted", {
          error: (e as Error)?.message,
        });
      }
      const billingFrequencies = freqSet.size ? [...freqSet.values()] : null;
      await withTenant(organizationId, async (tx) => {
        await tx
          .update(businesses)
          .set({
            defaultCurrency: cfg.baseCurrency,
            currencies: cfg.currencies,
            exchangeRates: Object.keys(cfg.exchangeRates).length ? cfg.exchangeRates : null,
            billingFrequencies,
          })
          .where(eq(businesses.id, businessId));
        // The imported rates are this business's first observation.
        await recordExchangeRateObservations(tx, { organizationId, businessId });
      });
      // The "target" of the site-config clone is the business itself.
      return { targetType: "business", targetId: businessId };
    });
    await progress("site_config");
  }

  // --- idempotency helpers ---------------------------------------------------

  function findImport(sourceType: string, sourceId: string): Promise<string | null> {
    return withTenant(organizationId, async (tx) => {
      const [row] = await tx
        .select({ targetId: importRecords.targetId })
        .from(importRecords)
        .where(
          and(
            eq(importRecords.source, source.name),
            eq(importRecords.sourceType, sourceType),
            eq(importRecords.sourceId, sourceId),
          ),
        )
        .limit(1);
      return row?.targetId ?? null;
    });
  }

  function recordImport(input2: {
    sourceType: string;
    sourceId: string;
    targetType: string;
    targetId: string;
  }): Promise<void> {
    return withTenant(organizationId, async (tx) => {
      await tx.insert(importRecords).values({
        organizationId,
        businessId,
        source: source.name,
        sourceType: input2.sourceType,
        sourceId: input2.sourceId,
        targetType: input2.targetType,
        targetId: input2.targetId,
        runId: opts.runId ?? null,
      });
    });
  }

  /**
   * Import one object idempotently: skip if recorded, else create + record.
   * Any thrown error becomes a `failed` count + warning instead of aborting the run.
   */
  async function importOne(
    key: string,
    sourceType: string,
    sourceId: string,
    create: () => Promise<{ targetType: string; targetId: string } | "skip">,
  ): Promise<{ existing: string | null; created: string | null }> {
    try {
      const existing = await findImport(sourceType, sourceId);
      if (existing) {
        count(key).skipped++;
        await opts.onRecord?.({ sourceType, sourceId, outcome: "skipped", targetId: existing });
        return { existing, created: null };
      }
      const out = await create();
      if (out === "skip") {
        count(key).skipped++;
        await opts.onRecord?.({ sourceType, sourceId, outcome: "skipped" });
        return { existing: null, created: null };
      }
      await recordImport({ sourceType, sourceId, ...out });
      count(key).created++;
      await opts.onRecord?.({ sourceType, sourceId, outcome: "created", targetId: out.targetId });
      return { existing: null, created: out.targetId };
    } catch (e) {
      count(key).failed++;
      warn(`${sourceType} ${sourceId}: ${(e as Error).message}`);
      await opts.onRecord?.({
        sourceType,
        sourceId,
        outcome: "failed",
        error: (e as Error).message,
      });
      // The report keeps the message; the log keeps the stack, so a failed row in a
      // 40-minute import is diagnosable after the fact rather than only countable.
      log.error(e, { event: "import_record_failed", sourceType, sourceId });
      return { existing: null, created: null };
    }
  }

  const stamp = (sourceId: string, extra?: Record<string, unknown> | null) => ({
    ...(extra ?? {}),
    source: source.name,
    source_id: sourceId,
  });

  /**
   * Carry the SOURCE's created/updated timestamps onto a row that was written
   * through a create* service.
   *
   * Rows we insert directly take their timestamps inline; these can't — the
   * public services stamp `now()` and deliberately expose no createdAt input
   * (an API caller must not be able to forge history). So migration corrects it
   * afterwards: an imported customer has to read as created when the source
   * created it, not when the import ran. One extra UPDATE per row is a fine
   * price on a one-shot batch job.
   *
   * Whichever timestamp the source omits mirrors the other; if it reports
   * neither, the row keeps its import time.
   */
  const backdate = async (
    table:
      | typeof productGroups
      | typeof products
      | typeof prices
      | typeof coupons
      | typeof customers,
    id: string,
    src: { createdAt?: Date; updatedAt?: Date },
  ) => {
    const createdAt = src.createdAt ?? src.updatedAt;
    const updatedAt = src.updatedAt ?? src.createdAt;
    if (!createdAt || !updatedAt) return;
    await withTenant(organizationId, async (tx) => {
      await tx.update(table).set({ createdAt, updatedAt }).where(eq(table.id, id));
    });
  };

  // ===========================================================================
  // 1) Catalog: groups → products → prices → applicability → differential
  // ===========================================================================

  /**
   * The whole site-wide read, or nothing. `EMPTY_CATALOG` leaves every loop below
   * iterating an empty array rather than restructuring the phase into a conditional —
   * the phase's writes are all driven off these arrays, so there is nothing to guard
   * individually and no path that can half-run.
   */
  const catalog = skipCatalog ? EMPTY_CATALOG : await source.listCatalog();

  // Catalog backdates are deferred to the END of the catalog section: add-on
  // applicability and differential prices UPDATE products/prices after they are
  // created, and each of those bumps updated_at. The source's value must win.
  const catalogBackdates: Array<() => Promise<void>> = [];

  const groupPidBySource = new Map<string, string>();
  // Per-kind slug dedupers: normalized source ids can collide.
  const groupSlug = makeSlugger();
  const productSlug = makeSlugger();
  const priceSlug = makeSlugger();
  for (const g of catalog.groups) {
    const r = await importOne("product_groups", "product_group", g.sourceId, async () => {
      const group = await createProductGroup({
        organizationId,
        businessId,
        name: g.name,
        // Normalize the source id to a valid slug (verbatim when it already fits):
        // ids may contain uppercase (e.g. "-BF"), which the lowercase slug validator rejects. Lookups are keyed by sourceId, so
        // normalizing the stored slug doesn't break child resolution.
        id: groupSlug(g.sourceId),
        description: g.description,
      });
      groupPidBySource.set(g.sourceId, group.publicId);
      catalogBackdates.push(() => backdate(productGroups, group.id, g));
      return { targetType: "product_group", targetId: group.id };
    });
    if (r.existing) {
      const pid = await withTenant(organizationId, async (tx) => {
        const [row] = await tx
          .select({ publicId: productGroups.publicId })
          .from(productGroups)
          .where(eq(productGroups.id, r.existing!))
          .limit(1);
        return row?.publicId;
      });
      if (pid) groupPidBySource.set(g.sourceId, pid);
    }
  }

  const productBySource = new Map<string, { id: string; publicId: string; kind: string }>();
  for (const p of catalog.products) {
    const r = await importOne("products", "product", p.sourceId, async () => {
      const product = await createProduct({
        organizationId,
        businessId,
        name: p.name,
        kind: p.kind,
        // Normalize the source id to a valid slug (verbatim when it fits). Source
        // product ids may contain uppercase (e.g. "…-BF",
        // "Custom-Report-Development") — carried raw they failed the slug validator,
        // cascading their prices + differential prices to "not in import set". The
        // productBySource map is keyed by sourceId, so this doesn't break lookups.
        id: productSlug(p.sourceId),
        externalName: p.externalName,
        description: p.description,
        unitOfMeasure: p.unit,
        metered: p.metered ?? false,
        productGroupPublicId: p.groupSourceId ? groupPidBySource.get(p.groupSourceId) : undefined,
        metadata: stamp(p.sourceId, p.metadata ?? null),
      });
      productBySource.set(p.sourceId, {
        id: product.id,
        publicId: product.publicId,
        kind: product.kind,
      });
      if (p.active === false) {
        await withTenant(organizationId, async (tx) => {
          await tx.update(products).set({ active: false }).where(eq(products.id, product.id));
        });
      }
      catalogBackdates.push(() => backdate(products, product.id, p));
      return { targetType: "product", targetId: product.id };
    });
    if (r.existing) {
      const row = await withTenant(organizationId, async (tx) => {
        const [x] = await tx
          .select({ id: products.id, publicId: products.publicId, kind: products.kind })
          .from(products)
          .where(eq(products.id, r.existing!))
          .limit(1);
        return x;
      });
      if (row) productBySource.set(p.sourceId, row);
    }
  }
  await progress("catalog");

  const priceRowBySource = new Map<string, typeof prices.$inferSelect>();
  for (const pr of catalog.prices) {
    const r = await importOne("prices", "price", pr.sourceId, async () => {
      const product = productBySource.get(pr.productSourceId);
      if (!product) {
        throw new Error(`price ${pr.sourceId}: product ${pr.productSourceId} not in import set`);
      }
      const price = await createPrice({
        organizationId,
        businessId,
        productId: product.id,
        // Carry the source item_price id verbatim (slug-normalized only if the
        // source id doesn't fit our slug rule) — id-stable migration is the point.
        id: priceSlug(pr.sourceId),
        type: pr.interval ? "recurring" : "one_time",
        model: pr.model,
        currency: pr.currency,
        name: pr.name,
        amountMinor: pr.amountMinor,
        interval: pr.interval,
        intervalCount: pr.intervalCount ?? 1,
        tiers: pr.tiers?.map((t) => ({
          upToMinor: t.upTo,
          unitAmountMinor: t.unitAmountMinor,
          flatAmountMinor: t.flatAmountMinor,
        })),
        trialPeriod: pr.trialPeriod,
        trialPeriodUnit: pr.trialPeriodUnit,
        externalName: pr.externalName,
        description: pr.description,
        billingCycles: pr.billingCycles ?? null,
        freeQuantity: pr.freeQuantity ?? null,
        // Always explicit: an import reproduces the source and must not follow the
        // business's per-currency price type (`tax_settings.behavior_by_currency`).
        taxBehavior: pr.taxBehavior ?? "exclusive",
        metadata: stamp(pr.sourceId, pr.metadata ?? null),
      });
      if (pr.active === false) {
        await withTenant(organizationId, async (tx) => {
          await tx.update(prices).set({ active: false }).where(eq(prices.id, price.id));
        });
      }
      catalogBackdates.push(() => backdate(prices, price.id, pr));
      // The cached row is only read for amount/model/interval when rating
      // subscriptions, so the pre-backdate copy is fine to keep.
      priceRowBySource.set(pr.sourceId, price);
      return { targetType: "price", targetId: price.id };
    });
    if (r.existing) {
      const row = await withTenant(organizationId, async (tx) => {
        const [x] = await tx.select().from(prices).where(eq(prices.id, r.existing!)).limit(1);
        return x;
      });
      if (row) priceRowBySource.set(pr.sourceId, row);
    }
  }

  // Add-on applicability: group attachments per addon, then set the full list
  // (a replace-set operation — safe to re-apply, converges on the source truth).
  const attachmentsByAddon = new Map<
    string,
    {
      planPids: string[];
      applicability: Record<string, Applicability>;
      config: Record<string, AttachedItemConfig>;
    }
  >();
  for (const att of catalog.attachedAddons) {
    const addon = productBySource.get(att.addonProductSourceId);
    const plan = productBySource.get(att.planProductSourceId);
    if (!addon || !plan || addon.kind !== "addon" || plan.kind !== "plan") {
      count("addon_applicability").skipped++;
      continue;
    }
    const entry = attachmentsByAddon.get(att.addonProductSourceId) ?? {
      planPids: [],
      applicability: {},
      config: {},
    };
    entry.planPids.push(plan.publicId);
    entry.applicability[plan.publicId] = att.applicability;
    // CAT-4 charge semantics come over too — the source knows them, and
    // defaulting silently would misprice a mandatory once-only attachment.
    entry.config[plan.publicId] = {
      ...(att.chargeOnEvent ? { chargeOnEvent: att.chargeOnEvent } : {}),
      ...(att.chargeOnce != null ? { chargeOnce: att.chargeOnce } : {}),
      ...(att.defaultQuantity != null ? { defaultQuantity: att.defaultQuantity } : {}),
      ...(att.billingCycles != null ? { billingCycles: att.billingCycles } : {}),
    };
    attachmentsByAddon.set(att.addonProductSourceId, entry);
  }
  for (const [addonSourceId, entry] of attachmentsByAddon) {
    try {
      const addon = productBySource.get(addonSourceId)!;
      await setItemApplicablePlans({
        organizationId,
        businessId,
        itemPublicId: addon.publicId,
        planPublicIds: entry.planPids,
        applicability: entry.applicability,
        config: entry.config,
      });
      const existing = await findImport("addon_applicability", addonSourceId);
      if (existing) {
        count("addon_applicability").skipped++;
      } else {
        await recordImport({
          sourceType: "addon_applicability",
          sourceId: addonSourceId,
          targetType: "product",
          targetId: addon.id,
        });
        count("addon_applicability").created++;
      }
    } catch (e) {
      count("addon_applicability").failed++;
      log.error(e, { event: "import_addon_applicability_failed", addonSourceId });
      warn(`addon_applicability ${addonSourceId}: ${(e as Error).message}`);
    }
  }

  for (const dp of catalog.differentialPrices) {
    const key = `${dp.addonPriceSourceId}:${dp.planProductSourceId}`;
    await importOne("differential_prices", "differential_price", key, async () => {
      const addonPrice = priceRowBySource.get(dp.addonPriceSourceId);
      const plan = productBySource.get(dp.planProductSourceId);
      if (!addonPrice || !plan) throw new Error("addon price or plan not in import set");
      const addonProduct = await withTenant(organizationId, async (tx) => {
        const [x] = await tx
          .select({ publicId: products.publicId })
          .from(products)
          .where(eq(products.id, addonPrice.productId))
          .limit(1);
        return x;
      });
      if (!addonProduct) throw new Error("addon product missing");
      const row = await setDifferentialPrice({
        organizationId,
        businessId,
        addonPublicId: addonProduct.publicId,
        planPublicId: plan.publicId,
        currency: dp.currency,
        interval: dp.interval ?? (addonPrice.interval as any),
        amountMinor: dp.amountMinor,
      });
      return { targetType: "differential_price", targetId: row.id };
    });
  }
  // Catalog fully written — now restore the source's own row timestamps.
  for (const apply of catalogBackdates) await apply();
  await progress("catalog");

  // ===========================================================================
  // 2) Coupons + coupon sets (with redemption state)
  // ===========================================================================

  const couponRowBySource = new Map<string, typeof coupons.$inferSelect>();
  if (source.listCoupons && !skipCatalog) {
    const { coupons: srcCoupons, couponSets: srcSets } = await source.listCoupons();
    for (const c of srcCoupons) {
      const r = await importOne("coupons", "coupon", c.sourceId, async () => {
        const coupon = await createCoupon({
          organizationId,
          businessId,
          code: c.code,
          name: c.name,
          kind: c.kind,
          percentOffBps: c.percentOffBps,
          amountOffMinor: c.amountOffMinor,
          currency: c.currency,
          durationType: c.durationType,
          durationInPeriods: c.durationInPeriods,
          maxRedemptions: c.maxRedemptions,
          redeemBy: c.redeemBy,
          applyOn: c.applyOn,
          itemConstraints: c.itemConstraints,
        });
        // Carry the source's live state: redemption count + archived/expired
        // flag, and the source's own row timestamps (createCoupon stamps now()).
        const [updated] = await withTenant(organizationId, async (tx) =>
          tx
            .update(coupons)
            .set({
              timesRedeemed: c.timesRedeemed ?? 0,
              active: c.active ?? true,
              metadata: stamp(c.sourceId, c.metadata ?? null),
              ...(c.createdAt || c.updatedAt
                ? {
                    createdAt: c.createdAt ?? c.updatedAt!,
                    updatedAt: c.updatedAt ?? c.createdAt!,
                  }
                : {}),
            })
            .where(eq(coupons.id, coupon.id))
            .returning(),
        );
        couponRowBySource.set(c.sourceId, updated ?? coupon);
        return { targetType: "coupon", targetId: coupon.id };
      });
      if (r.existing) {
        const row = await withTenant(organizationId, async (tx) => {
          const [x] = await tx.select().from(coupons).where(eq(coupons.id, r.existing!)).limit(1);
          return x;
        });
        if (row) couponRowBySource.set(c.sourceId, row);
      }
    }

    for (const s of srcSets) {
      await importOne("coupon_sets", "coupon_set", s.sourceId, async () => {
        const coupon = couponRowBySource.get(s.couponSourceId);
        if (!coupon) throw new Error(`parent coupon ${s.couponSourceId} not in import set`);
        const setId = await withTenant(organizationId, async (tx) => {
          const [set] = await tx
            .insert(couponSets)
            .values({
              organizationId,
              businessId,
              couponId: coupon.id,
              // Coupon-set id = source id (slug-normalized), not a nanoid.
              publicId: validateSlug(s.sourceId) ? s.sourceId : slugify(s.sourceId),
              name: s.name,
            })
            .returning();
          if (s.codes.length > 0) {
            // Direct insert (NOT createCouponSet, which generates fresh random
            // codes): the source's exact code strings + redeemed state must
            // round-trip so already-distributed codes keep working.
            await tx.insert(couponSetCodes).values(
              s.codes.map((code) => ({
                organizationId,
                businessId,
                couponSetId: set!.id,
                code: code.code,
                status: code.redeemed ? "redeemed" : "not_redeemed",
                redeemedAt: code.redeemed ? new Date() : null,
              })),
            );
          }
          return set!.id;
        });
        return { targetType: "coupon_set", targetId: setId };
      });
    }
  }
  await progress("coupons");

  // ===========================================================================
  // CATALOG-ONLY STOPS HERE
  // ===========================================================================
  // Everything above is the catalog: site config, product groups, products, prices,
  // attached items, differential prices and coupons. Everything below is the BOOK.
  //
  // An early return rather than a `!catalogOnly &&` on each phase below, and the
  // difference is not style. Per-phase guards were the first implementation and they
  // leaked twice: webhook endpoints were imported because that phase had no guard, and
  // customers/subscriptions/invoices were still FETCHED because their guards filtered
  // after the read instead of before it. A guard has to be remembered by whoever adds
  // the next phase; a return cannot be forgotten.
  //
  // That fetch is the reason this matters beyond tidiness. A live source can be throttled
  // to 400ms per request at 100 records a page, so pulling a production book only to
  // discard every row costs tens of minutes and reads real customer data — names,
  // emails, addresses — into this process for no purpose whatsoever. Catalog-only must
  // not touch it at all.
  //
  // ⚠️ `custom_field_definitions` is NOT importable here, and that is not an oversight:
  // definitions are derived from the custom-field KEYS present on customer and
  // subscription payloads (there is no definitions endpoint to read). With no entities
  // fetched there are no keys, so the count is legitimately zero.
  if (catalogOnly) {
    log.info("catalog-only import complete — the customer book was never read", {
      event: "import_catalog_only_complete",
      ...Object.fromEntries(Object.entries(result.counts).map(([k, v]) => [k, v.created])),
    });
    return result;
  }

  /**
   * `skipCatalog` did not run the phase above, so the two maps the phases BELOW read
   * from it are empty. Rehydrate them from THIS business.
   *
   * Joined through `import_records`, not by matching ids: `prices.publicId` is
   * `priceSlug(sourceId)`, which normalizes an id that does not fit our slug rule, so
   * publicId equals the source id in the common case and not always. The import
   * record is the exact inverse and it is the same table that makes a re-import
   * idempotent in the first place. A publicId match is then applied as a fallback for
   * anything the records do not cover.
   *
   * Two queries per map, no fan-out — a business holds hundreds of prices, not
   * thousands. The whole business is loaded rather than only the ids the in-scope
   * subscriptions need, because the invoice, usage and credit-note phases resolve prices
   * too and reading them all once is cheaper than threading a needed-id set through
   * four phases.
   */
  if (skipCatalog) {
    const [priceRows, priceRecs] = await Promise.all([
      withTenant(organizationId, (tx) =>
        tx.select().from(prices).where(eq(prices.businessId, businessId)),
      ),
      withTenant(organizationId, (tx) =>
        tx
          .select({ sourceId: importRecords.sourceId, targetId: importRecords.targetId })
          .from(importRecords)
          .where(
            and(
              eq(importRecords.organizationId, organizationId),
              eq(importRecords.businessId, businessId),
              eq(importRecords.source, source.name),
              eq(importRecords.sourceType, "price"),
            ),
          ),
      ),
    ]);
    const priceById = new Map(priceRows.map((r) => [r.id, r]));
    for (const rec of priceRecs) {
      const row = priceById.get(rec.targetId);
      if (row) priceRowBySource.set(rec.sourceId, row);
    }
    for (const row of priceRows) {
      if (!priceRowBySource.has(row.publicId)) priceRowBySource.set(row.publicId, row);
    }

    const [couponRows, couponRecs] = await Promise.all([
      withTenant(organizationId, (tx) =>
        tx.select().from(coupons).where(eq(coupons.businessId, businessId)),
      ),
      withTenant(organizationId, (tx) =>
        tx
          .select({ sourceId: importRecords.sourceId, targetId: importRecords.targetId })
          .from(importRecords)
          .where(
            and(
              eq(importRecords.organizationId, organizationId),
              eq(importRecords.businessId, businessId),
              eq(importRecords.source, source.name),
              eq(importRecords.sourceType, "coupon"),
            ),
          ),
      ),
    ]);
    const couponById = new Map(couponRows.map((r) => [r.id, r]));
    for (const rec of couponRecs) {
      const row = couponById.get(rec.targetId);
      if (row) couponRowBySource.set(rec.sourceId, row);
    }
    // `coupons` has no publicId — the code IS its identity, and a source may reuse the
    // coupon id as the code (SourceCoupon.code), so that is the right fallback key.
    for (const row of couponRows) {
      if (!couponRowBySource.has(row.code)) couponRowBySource.set(row.code, row);
    }

    log.info("catalog phase skipped — price and coupon maps rehydrated from the business", {
      event: "import_catalog_skipped",
      prices: priceRowBySource.size,
      coupons: couponRowBySource.size,
    });
  }

  // ===========================================================================
  // 3) Customers (+ contacts, payment methods, promo credits)
  // ===========================================================================

  const customerBySource = new Map<string, string>(); // source id → internal id
  // internal customer id → provider key → pm id (so imported payments/refunds can be
  // linked to the exact vaulted card, not just "the customer's primary method").
  const pmByCustomerAndProvider = new Map<string, Map<string, string>>();

  // Gateway accounts the SOURCE transacts on. Credentials are never exportable
  // from another billing system, so these import as `status: 'disabled'`
  // placeholders carrying an empty credential blob: they record which gateway +
  // which source gateway-account every imported card and charge belongs to, so
  // the operator pastes credentials once and re-runs to link everything. A
  // placeholder is NEVER left 'active' — an active account with no credentials
  // would make the engine attempt real charges through a client that cannot work.
  //
  // `source.listGatewayAccounts()` may have no endpoint to call — deriving it can mean
  // paginating source data, and the whole `/transactions` collection took ~20 minutes
  // for 3 resulting rows on a mature live book. That cost is now scoped by
  // `includeHistory`: a real cutover import keeps `includeHistory` at its default of
  // `true` and pays nothing extra (the transaction walk already happens below, for
  // real transaction import), while an `includeHistory: false` caller — a scoped
  // dry-run or a verify suite, never the actual cutover — gets a faster, visibly
  // less-complete derivation instead of forcing the walk it would otherwise have no
  // other reason to pay for. `!catalogOnly` for the same reason every other
  // per-customer phase carries it: a catalog-only import touches no customers, so
  // there is nothing here for a gateway account to bind to.
  // These imported as `status: 'disabled'` placeholders anyway (no exportable
  // credentials), so `gatewayAccountByKey` below — which only picks up ACTIVE accounts —
  // is unaffected either way.
  if (!catalogOnly && source.listGatewayAccounts && !opts.skipGatewayAccounts) {
    if (!includeHistory) {
      warn(
        "gateway accounts derived from payment methods only (--no-history): an account " +
          "seen only on a settled transaction with no payment method on file will not " +
          "surface here. Re-run with full history before cutover for the exhaustive set.",
      );
    }
    // Pins already consumed this run: a site with two accounts on one gateway must not
    // hand the same pinned id to both (the public-id index is global — the second would
    // just fail). First wins; the rest get a fresh id.
    const usedPins = new Set<string>();
    for (const ga of await source.listGatewayAccounts({ includeHistory })) {
      await importOne("gateway_accounts", "gateway_account", ga.sourceId, async () => {
        // ── Which public id? Two sources, and only two:
        //
        //   1. `GATEWAY_ACCOUNT_IDS` — the operator pinning what the PROVIDER dashboards
        //      already point at. The inbound webhook URL is `…?id=<this>`, so the id is a
        //      value another system holds, not an internal detail: a re-import that
        //      changes it kills every registered endpoint silently (the gateway keeps
        //      POSTing an id that no longer exists, and 404s look exactly like it having
        //      stopped sending).
        //   2. a fresh `gwa_…`.
        //
        // So **the pin is load-bearing**: for any gateway whose webhook endpoint is
        // registered, an unpinned import WILL break it. The source's own gateway id is
        // deliberately NOT used — it only exists for some gateways anyway, so relying on it gave stability
        // for some providers and not others, which is worse than one explicit rule.
        const pin = pinnedGatewayAccountId(ga.gatewayKey);
        const publicIdToUse = pin && !usedPins.has(ga.gatewayKey) ? pin : publicId("gwa");
        if (pin && publicIdToUse === pin) usedPins.add(ga.gatewayKey);
        else if (!pin) {
          warn(
            `gateway account ${ga.sourceId} (${ga.gatewayKey}) got a FRESH id ` +
              `${publicIdToUse} — no GATEWAY_ACCOUNT_IDS pin for '${ga.gatewayKey}'. If a ` +
              `webhook endpoint is registered for this gateway, its URL is now stale: pin ` +
              `the id and re-import, or re-register at the provider.`,
          );
        }

        const id = await withTenant(organizationId, async (tx) => {
          const [row] = await tx
            .insert(gatewayAccounts)
            .values({
              organizationId,
              businessId,
              publicId: publicIdToUse,
              gatewayKey: ga.gatewayKey,
              label: `${ga.sourceGatewayName} (imported ${ga.sourceId})`,
              livemode: false,
              // Empty credentials, encrypted like any other — the operator fills
              // these in. Not a fake default: the account stays disabled until then.
              credentialsEnc: encryptCredentials({}),
              currencies: ga.currencies ?? null,
              // The source already charged these currencies through this gateway account, so
              // the gateway enabled international payments there. Dropping them instead would
              // leave the imported subscriptions in those currencies with no account.
              internationalEnabled:
                internationalCurrencies(ga.gatewayKey, ga.currencies).length > 0,
              methodTypes: null,
              status: "disabled",
            })
            .returning({ id: gatewayAccounts.id });
          return row!.id;
        });
        return { targetType: "gateway_account", targetId: id };
      });
      warn(
        `gateway account ${ga.sourceId} (${ga.sourceGatewayName} → ${ga.gatewayKey}, ` +
          `${ga.paymentSourceCount ?? 0} card(s), ${ga.transactionCount ?? 0} txn(s)) imported DISABLED: ` +
          `${source.name} cannot export gateway credentials. Add them in Settings → Gateways and ` +
          `re-run the import to bind imported cards/refunds to this account.`,
      );
    }
    await progress("gateway_accounts");
  } else if (!catalogOnly && opts.skipGatewayAccounts) {
    warn(
      "gateway-account discovery SKIPPED (--no-gateway-accounts): no placeholder rows were " +
        "created for the source's gateways. Card binding is unaffected — it uses this " +
        "business's own ACTIVE accounts — but if this business had none configured, imported " +
        "cards will be unbound.",
    );
  }

  // Resolve this business's gateway accounts (gateway key → account id) so
  // imported payment methods carry gatewayAccountId — without it, refunds fall back to
  // the env-default provider client instead of the business's configured account (GW-2).
  // Only ACTIVE accounts can bind a card: a disabled credential-less placeholder
  // (see above) must not claim ownership of a payment method it cannot charge.
  const gatewayAccountByKey = new Map<string, string>();
  await withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select({ id: gatewayAccounts.id, gatewayKey: gatewayAccounts.gatewayKey })
      .from(gatewayAccounts)
      .where(and(eq(gatewayAccounts.businessId, businessId), eq(gatewayAccounts.status, "active")));
    for (const row of rows) {
      if (!gatewayAccountByKey.has(row.gatewayKey)) gatewayAccountByKey.set(row.gatewayKey, row.id);
    }
  });

  /**
   * Resolve the import scope BEFORE customers, because "which customers" depends on
   * "which subscriptions". `listSubscriptions` is memoized per source instance, so
   * pulling it early costs nothing — the later pass reuses the same result.
   */
  const scope = opts.scope;
  // Catalog-only retains nothing per-customer. Expressed as EMPTY retained sets below
  // rather than as a condition threaded through ten import phases: the sets already gate
  // customers, subscriptions and invoices, so reusing them keeps one mechanism instead
  // of adding a second that could disagree with it.
  const wantedStatuses = catalogOnly
    ? new Set<SourceSubStatus>()
    : scope?.subscriptionStatuses
      ? new Set<SourceSubStatus>(scope.subscriptionStatuses)
      : null;
  // Passed to every `listSubscriptions()` call below (here and at the subscription-import
  // phase) so both hit the same memo key on the source adapter — passing it only once would
  // make the second call re-fetch the WHOLE book under the unfiltered cache key.
  const subscriptionListOpts =
    scope?.subscriptionStatuses || subsetIds
      ? {
          ...(scope?.subscriptionStatuses ? { statuses: scope.subscriptionStatuses } : {}),
          // Named ids belong HERE, not at one call site: the two calls must agree or the
          // second re-fetches the whole book under a different memo key — exactly what
          // the note above warns about, and exactly the mistake made once already.
          ...(subsetIds ? { ids: subsetIds } : {}),
        }
      : undefined;
  let retainedSubSourceIds: Set<string> | null = null;
  let retainedCustomerSourceIds: Set<string> | null = null;
  if (catalogOnly) {
    // No source read at all — this is the saving the empty-array spelling cannot make.
    retainedSubSourceIds = new Set();
    retainedCustomerSourceIds = new Set();
  } else if (
    (wantedStatuses || scope?.dropCustomersWithoutSubscriptions || subsetIds) &&
    source.listSubscriptions
  ) {
    const all = await source.listSubscriptions(subscriptionListOpts);
    let kept = wantedStatuses ? all.filter((s) => wantedStatuses.has(s.status)) : all;
    if (subsetIds) {
      /**
       * The named set is the CONTRACT, so a miss is reported rather than shrugged off.
       * An id that matches nothing means the list and the source disagree — the
       * subscription was cancelled, renamed, or the list came from a different site —
       * and silently importing 33 of 34 while reporting success is the failure mode
       * this whole scope exists to prevent. Warned, not thrown: the operator may well
       * have a legitimate reason (a customer who churned since the list was drawn), and
       * the warning names each one so the decision is theirs.
       */
      const wanted = new Set(subsetIds);
      const present = new Set(all.map((s) => s.sourceId));
      const missing = [...wanted].filter((id) => !present.has(id));
      if (missing.length > 0) {
        warn(
          `${missing.length} of ${wanted.size} scoped subscription id(s) were not found on the source ` +
            `and cannot be imported: ${missing.join(", ")}`,
        );
      }
      const droppedByStatus = [...wanted].filter(
        (id) => present.has(id) && !kept.some((s) => s.sourceId === id),
      );
      if (droppedByStatus.length > 0) {
        warn(
          `${droppedByStatus.length} scoped subscription id(s) exist on the source but were excluded by ` +
            `the status filter: ${droppedByStatus.join(", ")}`,
        );
      }
      kept = kept.filter((s) => wanted.has(s.sourceId));
    }
    retainedSubSourceIds = new Set(kept.map((s) => s.sourceId));
    // A subscription subset ALWAYS scopes customers with it — see the field's comment.
    // `dropCustomersWithoutSubscriptions` remains the way to ask for that on its own.
    if (scope?.dropCustomersWithoutSubscriptions || subsetIds) {
      retainedCustomerSourceIds = new Set(kept.map((s) => s.customerSourceId));
    }
  }

  const allSourceCustomers = await source.listCustomers(
    retainedCustomerSourceIds ? { ids: [...retainedCustomerSourceIds] } : undefined,
  );
  const sourceCustomers = retainedCustomerSourceIds
    ? allSourceCustomers.filter((c) => retainedCustomerSourceIds!.has(c.sourceId))
    : allSourceCustomers;
  if (retainedCustomerSourceIds) {
    count("customers").skipped += allSourceCustomers.length - sourceCustomers.length;
  }

  // Custom-field definitions FIRST: createCustomer's validateAndCoerce rejects
  // any cf key without a matching definition, so every distinct bare key across
  // all source customers must have a 'customer' definition before values are set.
  const customerCfKeys = new Set<string>();
  for (const c of sourceCustomers)
    for (const k of Object.keys(c.customFields ?? {})) customerCfKeys.add(k);
  /**
   * ENSURE, not create. `createDefinition` throws on a duplicate, which is right for an
   * API caller — "a field with that name already exists" is a real 409 — but wrong here:
   * this loop means "make sure the definition exists", and a definition that is already
   * there is the desired state, not a failure.
   *
   * Untreated it reported 13 FAILED records on the live INR cutover and flipped the run
   * to a non-zero exit with every customer, subscription and invoice imported perfectly.
   * A gate that cries failure over an already-satisfied precondition is a gate people
   * learn to override, which is worse than not having it.
   *
   * The existing row is RECORDED rather than skipped, so `import_records` gains the
   * mapping and later runs never re-attempt it. Skipping alone would have left every
   * future import repeating the same 13 throws — the definitions were created by an
   * earlier run that had no record of them either.
   */
  const existingCfDefs = new Map(
    (await listDefinitions(organizationId, businessId, { entityType: "customer" })).map((d) => [
      d.apiName,
      d.id,
    ]),
  );
  for (const key of customerCfKeys) {
    await importOne(
      "custom_field_definitions",
      "custom_field_definition",
      `customer:${key}`,
      async () => {
        const already = existingCfDefs.get(key);
        if (already) return { targetType: "custom_field_definition", targetId: already };
        const def = await createDefinition({
          organizationId,
          businessId,
          entityType: "customer",
          apiName: key,
          label: key,
          dataType: "string",
        });
        return { targetType: "custom_field_definition", targetId: def.id };
      },
    );
  }
  await progress("custom_field_definitions");

  // The source has ONE field for two different ids. `vat_number` carries an EU VIES id in
  // Europe, and the buyer's OWN registration number — the GSTIN — in India.
  // We keep those in separate columns deliberately: `vat_number` has a validation lifecycle
  // (`vat_number_status`, a VIES round-trip) that a GSTIN must never be put through, and the
  // India invoice reads `tax_registration_number` FIRST. Filing a GSTIN under `vat_number`
  // still printed it — `assembleInvoiceDocument` falls back — so this was invisible on the
  // document while leaving the India column empty and the number queued for a validator that
  // would reject it.
  //
  // 'IN' is seeded unconditionally rather than read only from the configured regions, because
  // an import routinely runs BEFORE tax is set up: a region-only rule would silently do
  // nothing on exactly the first import that needs it.
  const ownRegistrationCountries = new Set(["IN"]);
  for (const d of await listTaxRegions(organizationId, businessId)) {
    if (d.region.collectRegistrationNumber)
      ownRegistrationCountries.add(d.region.country.toUpperCase());
  }

  for (const c of sourceCustomers) {
    const isOwnRegistration =
      !!c.vatNumber &&
      ownRegistrationCountries.has((c.billingAddress?.country ?? "").toUpperCase());
    const r = await importOne("customers", "customer", c.sourceId, async () => {
      const customer = await createCustomer({
        fillFromPostal: false,
        organizationId,
        businessId,
        // Id-stable migration: carry the source customer id verbatim as the
        // public id so downstream systems keep matching without a remap.
        publicId: c.sourceId,
        email: c.email,
        firstName: c.firstName,
        lastName: c.lastName,
        company: c.company,
        phone: c.phone,
        currency: c.currency,
        locale: c.locale,
        autoCollection: c.autoCollection,
        netTermDays: c.netTermDays,
        invoiceNotes: c.invoiceNotes,
        taxExempt: c.taxExempt,
        // Route the source's single field to whichever of our two columns it actually is.
        vatNumber: isOwnRegistration ? undefined : c.vatNumber,
        taxRegistrationNumber: isOwnRegistration ? c.vatNumber : undefined,
        address: c.billingAddress
          ? {
              line1: c.billingAddress.line1,
              line2: c.billingAddress.line2,
              line3: c.billingAddress.line3,
              city: c.billingAddress.city,
              state: c.billingAddress.state,
              stateCode: c.billingAddress.stateCode,
              postalCode: c.billingAddress.postalCode,
              country: c.billingAddress.country,
              firstName: c.billingAddress.firstName,
              lastName: c.billingAddress.lastName,
              company: c.billingAddress.company,
              phone: c.billingAddress.phone,
            }
          : undefined,
        shippingAddress: c.shippingAddress as Record<string, any> | undefined,
        metadata: stamp(c.sourceId, c.metadata ?? null),
        // Imported verbatim: the source's metadata predates this business's rules.
        metadataRules: "off",
        customFields: c.customFields ?? undefined,
      });
      customerBySource.set(c.sourceId, customer.id);
      return { targetType: "customer", targetId: customer.id };
    });
    if (r.existing) customerBySource.set(c.sourceId, r.existing);
    const internalCustomerId = customerBySource.get(c.sourceId);
    if (!internalCustomerId) continue;

    // Calendar billing anchor (CUST-5): set only when the source PINNED one.
    // createCustomer has no billingDate param, so this is a follow-up write —
    // and only on first import (r.created), so a re-run does not re-apply it.
    if (r.created && c.billingDateMode === "manually_set" && c.billingDate != null) {
      try {
        const row = await withTenant(organizationId, async (tx) => {
          const [x] = await tx
            .select({ publicId: customers.publicId })
            .from(customers)
            .where(eq(customers.id, internalCustomerId))
            .limit(1);
          return x;
        });
        if (row) {
          await changeBillingDate(organizationId, businessId, row.publicId, {
            billingDate: c.billingDate,
            billingDateMode: "manually_set",
          });
        }
      } catch (e) {
        log.warn("customer billing_date could not be imported", {
          sourceId: c.sourceId,
          error: (e as Error).message,
        });
        warn(`customer ${c.sourceId} billing_date: ${(e as Error).message}`);
      }
    }

    // Contacts
    for (const ct of c.contacts ?? []) {
      const key = ct.sourceId ?? `${c.sourceId}:${ct.email}`;
      await importOne("contacts", "contact", key, async () => {
        const id = await withTenant(organizationId, async (tx) => {
          const [row] = await tx
            .insert(contacts)
            .values({
              organizationId,
              businessId,
              customerId: internalCustomerId,
              publicId: publicId("con"),
              firstName: ct.firstName ?? null,
              lastName: ct.lastName ?? null,
              email: ct.email,
              phone: ct.phone ?? null,
              label: ct.label ?? null,
              enabled: ct.enabled ?? true,
              sendAccountEmail: ct.sendAccountEmail ?? false,
              sendBillingEmail: ct.sendBillingEmail ?? false,
              // The source carries no per-contact timestamp; the parent customer's
              // creation date is the tightest bound we have and keeps a contact
              // from looking newer than the customer that owns it.
              ...(c.createdAt
                ? { createdAt: c.createdAt, updatedAt: c.updatedAt ?? c.createdAt }
                : {}),
            })
            .returning();
          return row!.id;
        });
        return { targetType: "contact", targetId: id };
      });
    }

    // Payment methods — link the existing provider tokens directly (NO
    // re-vaulting: the cards already live at the provider; the tokens stay
    // valid because tmbilling charges through the same provider account).
    for (const pm of c.paymentMethods ?? []) {
      const key = pm.sourceId ?? pm.providerPaymentMethodId;
      const r2 = await importOne("payment_methods", "payment_method", key, async () => {
        const pmId = await withTenant(organizationId, async (tx) => {
          const [row] = await tx
            .insert(paymentMethods)
            .values({
              organizationId,
              businessId,
              customerId: internalCustomerId,
              publicId: publicId("pm"),
              providerKey: pm.provider,
              providerCustomerId: pm.providerCustomerId,
              providerPaymentMethodId: pm.providerPaymentMethodId,
              type: pm.type ?? "card",
              brand: pm.brand ?? null,
              last4: pm.last4 ?? null,
              expMonth: pm.expMonth ?? null,
              expYear: pm.expYear ?? null,
              // The source's own lifecycle state. Defaulting to "valid" would tell every
              // collection path that an expired card is chargeable.
              status: pm.status ?? "valid",
              // Every non-primary card is a backup by default (C6).
              role: pm.isPrimary ? "primary" : "backup",
              gatewayAccountId: gatewayAccountByKey.get(pm.provider) ?? null,
              metadata: stamp(key, pm.metadata ?? null),
              // When the card was vaulted at the source (source payment_source.created_at).
              ...(pm.createdAt ? { createdAt: pm.createdAt } : {}),
            })
            .returning();
          return row!.id;
        });
        return { targetType: "payment_method", targetId: pmId };
      });
      const pmId = r2.existing ?? r2.created;
      /**
       * Bind an ALREADY-IMPORTED card to the gateway account that now exists.
       *
       * The gateway-account warning above tells the operator to add credentials in
       * Settings → Gateways and "re-run the import to bind imported cards/refunds to this
       * account". Until this block that advice was FALSE: `gatewayAccountId` is set only
       * in the INSERT above, and a re-run finds the `import_records` row and returns
       * `existing` without ever entering the create callback — so the column stayed NULL
       * forever and the documented remedy did nothing. A first import necessarily has no
       * active account for the source's gateways (they arrive credential-less and
       * disabled, deliberately), which makes the re-run the ONLY path that can ever bind
       * these rows, and it was the one that did not.
       *
       * Why it matters: `selectGatewayAccount` treats this column as an override and
       * short-circuits on it. With NULL there is no override, the charge falls through to
       * the router, and that raises `ambiguous_gateway` whenever more than one active
       * account matches the currency and no business default is set — i.e. renewals for
       * imported customers simply fail.
       *
       * Fills NULL only, never re-points a bound card. Moving an instrument between
       * gateway accounts on a re-import would silently change which merchant account
       * charges it, and a token is only valid at the account that vaulted it.
       */
      const nowBindable = gatewayAccountByKey.get(pm.provider);
      if (r2.existing && nowBindable) {
        await withTenant(organizationId, async (tx) => {
          const bound = await tx
            .update(paymentMethods)
            .set({ gatewayAccountId: nowBindable })
            .where(
              and(eq(paymentMethods.id, r2.existing!), isNull(paymentMethods.gatewayAccountId)),
            )
            .returning({ id: paymentMethods.id });
          if (bound.length > 0) count("payment_methods_bound").created++;
        });
      }
      // Seed the provider_customers mapping from the source's existing gateway
      // customer id (e.g. a reference_id "cus_…/pm_…") so post-import
      // vault/setup flows REUSE that provider customer instead of minting a new
      // one. Idempotent (unique on customer × provider × gateway account).
      if (pm.providerCustomerId) {
        const mappedGateway = gatewayAccountByKey.get(pm.provider) ?? null;
        await withTenant(organizationId, async (tx) => {
          // Explicit exists-check (not just onConflictDoNothing): the unique
          // index treats NULL gateway_account_id rows as distinct, so a bare
          // insert would duplicate on re-import for env-provider rows.
          const [exists] = await tx
            .select({ id: providerCustomers.id })
            .from(providerCustomers)
            .where(
              and(
                eq(providerCustomers.customerId, internalCustomerId),
                eq(providerCustomers.providerKey, pm.provider),
                mappedGateway
                  ? eq(providerCustomers.gatewayAccountId, mappedGateway)
                  : isNull(providerCustomers.gatewayAccountId),
              ),
            )
            .limit(1);
          if (exists) return;
          await tx
            .insert(providerCustomers)
            .values({
              organizationId,
              businessId,
              customerId: internalCustomerId,
              providerKey: pm.provider,
              gatewayAccountId: mappedGateway,
              providerCustomerId: pm.providerCustomerId,
            })
            .onConflictDoNothing();
        });
      }
      if (pmId) {
        let byProvider = pmByCustomerAndProvider.get(internalCustomerId);
        if (!byProvider) pmByCustomerAndProvider.set(internalCustomerId, (byProvider = new Map()));
        // First one wins per provider (primary is imported first in practice); good enough
        // for refund routing, which only needs *a* valid vaulted method on the right gateway.
        if (!byProvider.has(pm.provider)) byProvider.set(pm.provider, pmId);
      }
    }

    // Promotional credits → granted wallet top-up (opening ledger entry; never charges).
    for (const bal of c.promoCreditBalances ?? []) {
      if (bal.amountMinor <= 0) continue;
      const key = `${c.sourceId}:${bal.currency.toUpperCase()}`;
      await importOne("promo_credits", "promo_credit", key, async () => {
        const customerRow = await withTenant(organizationId, async (tx) => {
          const [x] = await tx
            .select()
            .from(customers)
            .where(eq(customers.id, internalCustomerId))
            .limit(1);
          return x;
        });
        if (!customerRow) throw new Error("customer row missing");
        const topup = await topUpWallet({
          organizationId,
          businessId,
          customer: customerRow,
          amountMinor: bal.amountMinor,
          currency: bal.currency,
          type: "granted",
        });
        return { targetType: "wallet_topup", targetId: topup.id };
      });
    }

    // LAST, after every follow-up write above (billing anchor, contacts, cards,
    // promo credits): each of those UPDATEs the customer or bumps its row, and
    // the source's updated_at has to be what survives.
    await backdate(customers, internalCustomerId, c);
  }
  if (source.listNonPortablePaymentMethods) {
    result.nonPortablePaymentMethods = await source.listNonPortablePaymentMethods(
      retainedCustomerSourceIds ? { customerIds: [...retainedCustomerSourceIds] } : undefined,
    );
    if (result.nonPortablePaymentMethods.length > 0) {
      warn(
        `${result.nonPortablePaymentMethods.length} payment source(s) could not be linked — those customers need a card-update campaign or send-invoice collection.`,
      );
    }
  }
  await progress("customers");

  // --- outbound webhook endpoints: DELIBERATELY NOT IMPORTED ------------------
  // Removed 2026-08-20, in every mode. It used to copy the source's endpoints in as
  // `enabled: 'false'` with a freshly minted signing secret, which sounds harmless and
  // is not worth the footgun: it leaves a set of URLs pointing at the SOURCE system's
  // receivers, one toggle away from POSTing this engine's billing traffic to someone
  // else's integration — with a secret their receiver has never seen, so the first
  // thing it would do is reject every signature.
  //
  // A migration has no business deciding who gets notified. Endpoints are cheap to
  // create deliberately (`POST /v1/webhook_endpoints`) and expensive to discover by
  // accident. `pnpm verify:catalog-only-import` asserts none arrive.
  //
  // The source-side reader (`listWebhookEndpoints`) stays: the inventory/discovery
  // report COUNTS endpoints at the source so no zero in that report is a false zero.
  // Counting is not importing.

  // ===========================================================================
  // 4) Subscriptions — mirror state, keep paid-through period, DO NOT charge
  // ===========================================================================

  const subBySource = new Map<string, string>(); // source id → internal id
  const now = new Date();

  const allSourceSubscriptions = await source.listSubscriptions(subscriptionListOpts);
  const sourceSubscriptions = retainedSubSourceIds
    ? allSourceSubscriptions.filter((s) => retainedSubSourceIds!.has(s.sourceId))
    : allSourceSubscriptions;
  if (retainedSubSourceIds) {
    count("subscriptions").skipped += allSourceSubscriptions.length - sourceSubscriptions.length;
  }

  // Subscription custom-field definitions before any subscription row is written
  // (parity with the customer phase; the value lives in the raw jsonb column).
  const subCfKeys = new Set<string>();
  for (const s of sourceSubscriptions)
    for (const k of Object.keys(s.customFields ?? {})) subCfKeys.add(k);
  for (const key of subCfKeys) {
    await importOne(
      "custom_field_definitions",
      "custom_field_definition",
      `subscription:${key}`,
      async () => {
        const def = await createDefinition({
          organizationId,
          businessId,
          entityType: "subscription",
          apiName: key,
          label: key,
          dataType: "string",
        });
        return { targetType: "custom_field_definition", targetId: def.id };
      },
    );
  }
  await progress("custom_field_definitions");

  // Read AFTER the business-config phase above, which is what sets the anchor
  // granularity from the source site's billing mode.
  const bizMode = await loadBillingMode(organizationId, businessId);

  for (const s of sourceSubscriptions) {
    const r = await importOne("subscriptions", "subscription", s.sourceId, async () => {
      const customerId = customerBySource.get(s.customerSourceId);
      if (!customerId) throw new Error(`customer ${s.customerSourceId} not in import set`);
      if (s.items.length === 0) throw new Error("subscription has no items");

      const resolvedItems = s.items.map((it) => {
        const priceRow = priceRowBySource.get(it.priceSourceId);
        if (!priceRow) throw new Error(`price ${it.priceSourceId} not in import set`);
        const catalogAmount = priceRow.amountMinor != null ? Number(priceRow.amountMinor) : null;
        const override =
          it.unitPriceMinor != null &&
          isOverridable(priceRow.model) &&
          it.unitPriceMinor !== catalogAmount
            ? it.unitPriceMinor
            : undefined;
        return { it, priceRow, override };
      });

      // A future cancel date is an accepted cancellation the source has not applied yet.
      const scheduledCancel = s.canceledAt != null && s.canceledAt.getTime() > now.getTime();
      const { status, cancelAtPeriodEnd } = mapStatus(s.status, scheduledCancel);
      const recurring = resolvedItems.find(({ priceRow }) => priceRow.type === "recurring");

      // Cached MRR from the EFFECTIVE amounts (overrides included), NETTED against
      // the discounts that permanently restate recurring revenue — `forever`
      // coupons and unlimited subscription-level discounts alike. Writing the
      // gross figure here (the bug until 2026-08-07) diverged from every other
      // path in the engine, all of which go through `recomputeSubscriptionMrr`.
      const grossMrr = computeSubscriptionMrr(
        resolvedItems.map(({ it, priceRow, override }) => ({
          price: override != null ? { ...priceRow, amountMinor: BigInt(override) } : priceRow,
          quantity: it.quantity,
          freeQuantity: it.freeQuantity ?? null,
        })),
      );
      const netMrr = netMrrForDiscounts(
        grossMrr,
        discountsForMrr(
          discountsForImportedMrr(
            s,
            couponRowBySource,
            recurring?.priceRow
              ? {
                  interval: (recurring.priceRow.interval ?? "month") as DiscountCadence["interval"],
                  intervalCount: recurring.priceRow.intervalCount ?? 1,
                }
              : null,
          ),
        ),
        recurring?.priceRow.interval ?? "month",
        recurring?.priceRow.intervalCount ?? 1,
      );
      // A TRIALING subscription stores 0, exactly as `recomputeSubscriptionMrr`
      // does for one the engine created — a trial counts $0.00 MRR,
      // and the trial→active conversion in `renewal.ts` restates the real rate.
      // Importing the plan rate here made an imported book disagree with an
      // engine-grown one, and inflated the dashboard by the whole trial cohort.
      const mrr = status === "in_trial" ? 0n : netMrr;

      // A day-anchored (legacy day-based) business keeps its terms on local midnights,
      // but the source reports a term end INCLUSIVELY — `current_term_end` is the last
      // second of the final day (…T23:59:59), where we store the EXCLUSIVE next
      // boundary (…T00:00 of the following day; all the period arithmetic depends on
      // `next_period_start === current_period_end`). Imported verbatim it landed a
      // second short of midnight, so the timeline read "Next billing on 03-Aug-2027
      // 23:59" where it should read 04-Aug-2027 00:00 — and every later renewal inherited the
      // offset. `normalizeTermEnd` rounds it up to the boundary it is a hair short of;
      // an exact midnight, and every instant-anchored business, passes through untouched.
      const periodEnd = normalizeTermEnd(s.currentTermEnd, bizMode);
      // Same grid for the start, derived when the source reports none (a trialing or
      // cancelled subscription) — never the import's wall clock, which put a 2026 start
      // on a term that ended in 2025.
      const periodStart = alignTermStart(
        importedTermStart(
          s,
          periodEnd,
          (recurring?.priceRow.interval ?? "month") as Interval,
          recurring?.priceRow.intervalCount ?? 1,
          now,
        ),
        bizMode,
      );
      const subId = await withTenant(organizationId, async (tx) => {
        await assertTestBusinessRoom(tx, businessId, "subscriptions");
        const [sub] = await tx
          .insert(subscriptions)
          .values({
            organizationId,
            businessId,
            customerId,
            // Id-stable migration: carry the source subscription id verbatim so
            // downstream systems keep matching without a remap.
            publicId: s.sourceId,
            status,
            currency: s.currency.toUpperCase(),
            // Keep the already-paid term: we take over at currentTermEnd.
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            trialEnd: s.trialEnd ?? null,
            cancelAtPeriodEnd,
            canceledAt: status === "cancelled" ? (s.canceledAt ?? now) : null,
            startDate: s.startDate ?? null,
            startedAt: s.startedAt ?? (s.status === "future" ? null : periodStart),
            activatedAt: s.activatedAt ?? null,
            trialStart: s.trialStart ?? null,
            billingPeriod: recurring?.priceRow.intervalCount ?? 1,
            billingPeriodUnit: recurring?.priceRow.interval ?? "month",
            remainingBillingCycles: s.remainingBillingCycles ?? null,
            autoCollection: s.autoCollection ?? null,
            netTermDays: s.netTermDays ?? null,
            poNumber: s.poNumber ?? null,
            invoiceNotes: s.invoiceNotes ?? null,
            cancelReason: s.cancelReason ?? null,
            // PAUSED zeroes too (2026-08-26). The engine's pause path calls
            // `recomputeSubscriptionMrr`, which has zeroed a paused subscription since the
            // 2026-08-19 operator ruling — it raises no invoices, so it earns nothing while
            // paused. The importer zeroed `in_trial` and `cancelled` but never learned about
            // `paused`, so an IMPORTED pause carried its full rate while an ENGINE pause
            // carried 0: the same disagreement between an imported book and an engine-grown
            // one that the `cancelled` case above exists to prevent, and it inflated MRR by
            // the whole imported paused cohort. Found by repairing
            // `stored_mrr_matches_recomputed`, which was reporting every paused subscription
            // and so hid these two real ones in 158 false positives.
            mrr: status === "cancelled" || status === "paused" ? 0n : mrr,
            // The rate it last carried while earning (0271). `netMrr` is the netted figure
            // for the composition as imported — including for a row that arrives already
            // cancelled or paused, where the source still tells us what it was billing and
            // the zeroed column above cannot. That is the whole point of the column: once
            // the discounts are gone, nothing can reconstruct it. A trialling row has
            // earned nothing, so it records nothing.
            lastEarningMrr: status === "in_trial" ? null : netMrr,
            metadata: stamp(s.sourceId, s.metadata ?? null),
            customFields: s.customFields ?? null,
            /**
             * NOT PINNED. `default_payment_method_id` is a per-subscription OVERRIDE, and
             * the importer has nothing to put in it: `SourceSubscription` carries no
             * payment method at all, so the value this used to write was just
             * `defaultPmByCustomer` — the customer's primary card, which the row above
             * already records as `role: 'primary'`.
             *
             * Storing that fact twice was the bug. `resolveChargeCandidates` prefers the
             * subscription pin over the customer's primary, and nothing updates the pin
             * when the primary changes (`payment-methods/service.ts` writes the role and
             * never touches this column) — so replacing a customer's card left every
             * migrated subscription charging the old one, for renewals and for a manual
             * "collect now" alike. Measured on the live book 2026-09-15: a subscription
             * pinned to a card in status `invalid` while the customer's new primary sat
             * unused beside it.
             *
             * Dropping it costs nothing at import time — `pickPrimaryCandidate` resolves
             * the very same card through `role: 'primary'` — and it stays correct
             * afterwards. A pin now means what it says: somebody chose this card FOR this
             * subscription.
             */
            defaultPaymentMethodId: null,
            // The source's row timestamps — NOT startedAt/activatedAt above,
            // which are lifecycle dates. Omitted → the column default (now).
            ...(s.createdAt ? { createdAt: s.createdAt } : {}),
            ...((s.updatedAt ?? s.createdAt) ? { updatedAt: s.updatedAt ?? s.createdAt! } : {}),
          })
          .returning();
        await tx.insert(subscriptionItems).values(
          resolvedItems.map(({ it, priceRow, override }) => ({
            organizationId,
            businessId,
            subscriptionId: sub!.id,
            publicId: publicId("si"),
            priceId: priceRow.id,
            quantity: it.quantity,
            freeQuantity: it.freeQuantity ?? null,
            billingCycles: it.billingCycles ?? null,
            priceSnapshot: snapshotPrice(priceRow, override),
            // Source items carry no timestamp of their own; they came into being
            // with the subscription (or earlier than the import, at worst).
            ...(s.createdAt ? { createdAt: s.createdAt } : {}),
          })),
        );
        return sub!.id;
      });
      subBySource.set(s.sourceId, subId);
      return { targetType: "subscription", targetId: subId };
    });
    if (r.existing) subBySource.set(s.sourceId, r.existing);
    const subId = subBySource.get(s.sourceId);
    if (!subId) continue;

    // Applied coupons — DIRECT insert carrying the mid-life state. A fresh
    // applyCouponToSubscription would restart the discount clock and re-count
    // the redemption.
    for (const ac of s.appliedCoupons ?? []) {
      const key = `${s.sourceId}:${ac.couponSourceId}`;
      await importOne("applied_coupons", "applied_coupon", key, async () => {
        const coupon = couponRowBySource.get(ac.couponSourceId);
        if (!coupon) throw new Error(`coupon ${ac.couponSourceId} not in import set`);
        let remainingPeriods: number | null;
        if (ac.remainingPeriods != null) {
          remainingPeriods = ac.remainingPeriods;
        } else {
          switch (coupon.durationType) {
            case "forever":
              remainingPeriods = null;
              break;
            case "repeating":
              remainingPeriods = Math.max(
                0,
                (coupon.durationInPeriods ?? 1) - (ac.timesApplied ?? 0),
              );
              break;
            default: // once
              remainingPeriods = (ac.timesApplied ?? 0) > 0 ? 0 : 1;
          }
        }
        const id = await withTenant(organizationId, async (tx) => {
          const [row] = await tx
            .insert(appliedCoupons)
            .values({
              organizationId,
              businessId,
              couponId: coupon.id,
              subscriptionId: subId,
              customerId: sql`(select customer_id from subscriptions where id = ${subId})`,
              publicId: publicId("disc"),
              status: remainingPeriods === 0 ? "exhausted" : "active",
              remainingPeriods,
              // The ORIGINAL span, not the mid-life remainder above — this is what
              // the MRR rule reads, and it must not shrink as the discount burns.
              totalPeriods: couponTotalPeriods(coupon),
              // The source's subscription.coupons[] has no applied_at, so the
              // subscription's own creation date is the closest honest anchor.
              ...(s.createdAt ? { createdAt: s.createdAt } : {}),
            })
            .returning();
          return row!.id;
        });
        return { targetType: "applied_coupon", targetId: id };
      });
    }

    // Subscription-level DISCOUNTS — standalone reductions with no catalog coupon
    // behind them (source `subscription.discounts[]`). They land in the SAME
    // `applied_coupons` table as coupon discounts, as `source='manual'` rows with
    // `coupon_id = null` and self-contained `manual_*` columns — exactly what
    // `applyManualDiscount` writes — so invoicing, stacking, consume/restore and
    // the estimate path all pick them up unchanged (`peekDiscounts` left-joins).
    //
    // Skipping these is a BILLING bug, not a reporting one: a `forever` $22,714.00-off
    // discount against a $22,714.00/yr composition bills 0 — imported without it, the
    // first renewal after cut-over would charge the customer the full $22,714.
    // A discount's span is expressed in the source's own unit (`period` + `period_unit`) and we
    // count BILLING PERIODS, so the span is converted against this subscription's
    // cadence — see `discountSpanInBillingPeriods`. Resolved once per subscription.
    const recurringPrice = s.items
      ?.map((it) => priceRowBySource.get(it.priceSourceId))
      .find((pr) => pr?.type === "recurring");
    const cadence: DiscountCadence | null = recurringPrice
      ? {
          interval: (recurringPrice.interval ?? "month") as DiscountCadence["interval"],
          intervalCount: recurringPrice.intervalCount ?? 1,
        }
      : null;
    for (const d of s.discounts ?? []) {
      // month↔year and day↔week convert exactly; only a MIXED pair has no exact answer
      // (a month is 28-31 days), and those are warned rather than silently rounded — an
      // off-by-one here is a free or a missing discount period on a real invoice.
      if (d.durationType === "limited_period" && d.periodUnit != null && cadence != null) {
        const conv = discountSpanInBillingPeriods(
          { periods: Math.max(1, d.periods ?? 1), unit: d.periodUnit },
          cadence,
        );
        if (conv.approximate) {
          warn(
            `subscription ${s.sourceId}: discount ${d.sourceId} runs for ${d.periods ?? 1} ${d.periodUnit}(s) ` +
              `against a ${cadence.intervalCount} ${cadence.interval}(s) cadence — those units do not divide ` +
              `exactly (a month is 28-31 days), so the span was converted to ${conv.periods} billing period(s) ` +
              "using a 365/12-day month. Check it against the source before this subscription renews.",
          );
        }
      }
      // Refused BEFORE importOne, not thrown inside it. `apply_on=specific_item_price`
      // is a permanent capability gap, not a transient error: it is the same on every
      // re-run, no operator action clears it, and counting it `failed` exits the import
      // non-zero forever. It lands in `result.unsupported` instead, which the report
      // prints separately — visible, but not masquerading as data loss.
      if (!discountIsImportable(d)) {
        count("subscription_discounts").skipped++;
        result.unsupported.push({
          kind: "subscription_discount",
          sourceId: d.sourceId,
          ownerSourceId: s.sourceId,
          reason:
            `apply_on=specific_item_price (item ${d.itemPriceSourceId ?? "unknown"}) — our manual ` +
            "discounts are invoice-wide, so importing it would discount the whole invoice and " +
            "over-credit the customer. NOT imported: this subscription will bill HIGHER here than " +
            "at the source.",
        });
        continue;
      }
      await importOne(
        "subscription_discounts",
        "applied_coupon",
        `${s.sourceId}:discount:${d.sourceId}`,
        async () => {
          if (d.kind === "percentage" ? d.percentOffBps == null : d.amountOffMinor == null) {
            throw new Error(`discount ${d.sourceId} (${d.kind}) carries no amount`);
          }
          const remainingPeriods = discountRemainingPeriods(d, cadence);
          const id = await withTenant(organizationId, async (tx) => {
            try {
              const [row] = await tx
                .insert(appliedCoupons)
                .values({
                  organizationId,
                  businessId,
                  couponId: null,
                  subscriptionId: subId,
                  customerId: sql`(select customer_id from subscriptions where id = ${subId})`,
                  publicId: publicId("disc"),
                  status: remainingPeriods === 0 ? "exhausted" : "active",
                  remainingPeriods,
                  totalPeriods: discountTotalPeriods(d, cadence),
                  source: "manual",
                  manualKind: d.kind,
                  manualPercentOffBps: d.kind === "percentage" ? (d.percentOffBps ?? null) : null,
                  manualAmountOffMinor:
                    d.kind === "fixed_amount" ? BigInt(d.amountOffMinor!) : null,
                  manualCurrency:
                    d.kind === "fixed_amount" ? (d.currency ?? s.currency).toUpperCase() : null,
                  // The source's `invoice_name` is the customer-facing label. We keep it in
                  // the note so nothing is lost; the invoice discount line still
                  // reads "Discount" (peekDiscounts labels every manual row that
                  // way) — a cosmetic gap, not a money one.
                  manualNote: d.label ?? null,
                  ...((d.createdAt ?? s.createdAt)
                    ? { createdAt: d.createdAt ?? s.createdAt! }
                    : {}),
                })
                .returning();
              return row!.id;
            } catch (e: any) {
              // `applied_coupons_active_manual_uq` allows ONE active manual discount
              // per subscription; the source allows several. Name the constraint so
              // the import report says what happened instead of leaking a PG code —
              // the extra discounts are NOT imported and the subscription will bill
              // short of the source.
              if (
                e?.code === "23505" &&
                String(e?.constraint ?? "").includes("applied_coupons_active_manual")
              ) {
                throw new Error(
                  `discount ${d.sourceId}: this subscription already has an active manual discount — ` +
                    "we allow only one (applied_coupons_active_manual_uq) and the source has several. NOT imported",
                );
              }
              throw e;
            }
          });
          return { targetType: "applied_coupon", targetId: id };
        },
      );
    }

    // Paused with a scheduled resume → durable clock resumes it on time.
    if (s.status === "paused" && s.resumeDate && s.resumeDate > now) {
      await importOne("scheduled_changes", "scheduled_change", `${s.sourceId}:resume`, async () => {
        const change = await scheduleChange({
          organizationId,
          businessId,
          subscriptionId: subId,
          type: "resume",
          effectiveAt: s.resumeDate!,
        });
        return { targetType: "scheduled_change", targetId: change.id };
      });
    }
  }
  if (result.unsupported.length > 0) {
    warn(
      `${result.unsupported.length} source feature(s) could not be expressed here and were NOT imported ` +
        `(see result.unsupported) — the affected subscriptions will bill differently from the source.`,
    );
  }
  await progress("subscriptions");

  // Unbilled charges → folded into the next renewal invoice.
  if (!catalogOnly && source.listUnbilledCharges) {
    for (const u of await source.listUnbilledCharges(
      retainedSubSourceIds ? { subscriptionIds: [...retainedSubSourceIds] } : undefined,
    )) {
      // Out of scope is a DECISION, not the integrity error the `throw` below reports.
      // Without this the source's whole unbilled-charge list is walked and every row
      // belonging to a subscription we deliberately left behind lands in `failed` —
      // which is the count an operator reads to decide whether the run was clean, so
      // expected misses there would mask a real one.
      if (retainedSubSourceIds && !retainedSubSourceIds.has(u.subscriptionSourceId)) {
        count("unbilled_charges").skipped++;
        continue;
      }
      await importOne("unbilled_charges", "unbilled_charge", u.sourceId, async () => {
        const subId = subBySource.get(u.subscriptionSourceId);
        if (!subId) throw new Error(`subscription ${u.subscriptionSourceId} not in import set`);
        const id = await withTenant(organizationId, async (tx) => {
          const [row] = await tx
            .insert(unbilledCharges)
            .values({
              organizationId,
              businessId,
              subscriptionId: subId,
              publicId: publicId("uch"),
              description: u.description,
              amountMinor: BigInt(u.amountMinor),
              currency: u.currency.toUpperCase(),
              status: "pending",
            })
            .returning();
          return row!.id;
        });
        return { targetType: "unbilled_charge", targetId: id };
      });
    }
    await progress("unbilled_charges");
  }

  // Metered usage for the OPEN period. Usage is rated in arrears at period close,
  // so the open period's events must come across or the first post-migration
  // invoice under-bills. Settled periods are already reflected in the archival
  // invoices and are deliberately not replayed (that would double-bill).
  /**
   * Only ask if the catalog can answer. `/usages` refuses `subscription_id[in]`, so this
   * costs ONE REQUEST PER SUBSCRIPTION — 1,633 of them, ~11 minutes paced against a live
   * site, to read nothing at all when no price is metered.
   *
   * The check reads the BUSINESS's catalog, not the prices this run created: a scoped
   * import skips the catalog phase and rehydrates its price map from the business, so
   * counting only new rows would report zero on a metered site and silently drop its
   * usage.
   */
  const meteredPriceCount = catalogOnly
    ? 0
    : await withTenant(organizationId, async (tx) => {
        const [row] = await tx
          .select({ n: sql<number>`count(*)` })
          .from(prices)
          .where(and(eq(prices.businessId, businessId), eq(prices.model, "usage")));
        return Number(row?.n ?? 0);
      });
  if (!catalogOnly && source.listUsageRecords && meteredPriceCount === 0) {
    log.log("usage phase skipped — no metered price in this business", { businessId });
  }
  if (!catalogOnly && source.listUsageRecords && meteredPriceCount > 0) {
    const usage = await source.listUsageRecords(
      retainedSubSourceIds ? { subscriptionIds: [...retainedSubSourceIds] } : undefined,
    );
    // (subscription, price) → subscription_item, resolved once for the whole batch.
    const itemBySubAndPrice = new Map<string, string>();
    if (usage.length > 0) {
      await withTenant(organizationId, async (tx) => {
        const rows = await tx
          .select({
            id: subscriptionItems.id,
            subscriptionId: subscriptionItems.subscriptionId,
            priceId: subscriptionItems.priceId,
          })
          .from(subscriptionItems)
          .where(eq(subscriptionItems.businessId, businessId));
        for (const row of rows)
          itemBySubAndPrice.set(`${row.subscriptionId}:${row.priceId}`, row.id);
      });
    }
    for (const u of usage) {
      // See the unbilled-charge phase above: out of scope is skipped, not failed.
      if (retainedSubSourceIds && !retainedSubSourceIds.has(u.subscriptionSourceId)) {
        count("usage_records").skipped++;
        continue;
      }
      await importOne("usage_records", "usage_record", u.sourceId, async () => {
        const subId = subBySource.get(u.subscriptionSourceId);
        if (!subId) throw new Error(`subscription ${u.subscriptionSourceId} not in import set`);
        const priceRow = priceRowBySource.get(u.priceSourceId);
        if (!priceRow) throw new Error(`price ${u.priceSourceId} not in import set`);
        const itemId = itemBySubAndPrice.get(`${subId}:${priceRow.id}`);
        if (!itemId)
          throw new Error(
            `subscription ${u.subscriptionSourceId} has no item for price ${u.priceSourceId}`,
          );
        const id = await withTenant(organizationId, async (tx) => {
          const [row] = await tx
            .insert(usageRecords)
            .values({
              organizationId,
              businessId,
              subscriptionItemId: itemId,
              publicId: publicId("ur"),
              quantity: BigInt(Math.trunc(u.quantity)),
              timestamp: u.timestamp,
              // Source id doubles as the dedup key so a re-import cannot
              // double-count usage even outside the import_records path.
              idempotencyKey: `${source.name}:${u.sourceId}`,
            })
            .returning({ id: usageRecords.id });
          return row!.id;
        });
        return { targetType: "usage_record", targetId: id };
      });
    }
    await progress("usage_records");
  }

  // ===========================================================================
  // 5) History (archival, Option A)
  // ===========================================================================

  const invoiceBySource = new Map<string, { id: string; publicId: string; customerId: string }>();

  /**
   * Invoices import even with `--no-history`, narrowed to the OPEN ones.
   *
   * `includeHistory` is about settled documents — money that has already moved and
   * that a forward-looking run does not need. Open invoices are not history: they are
   * live AR, and they carry the source's in-flight dunning position
   * (`SourceInvoice.dunning`). Skipping them leaves every customer who is mid-dunning
   * at cutover with nothing to dun, which is exactly the population whose behaviour
   * matters most in a parallel run.
   */
  if (source.listInvoices) {
    let maxImportedNumber = 0;
    // Scoped: unscoped this pages the whole site's invoice history to keep the handful a
    // subset import wants. The local filter below still runs — a source may ignore filters
    // it does not support, so the server-side one is an optimisation, never the guard.
    const invoiceScope = retainedCustomerSourceIds ? [...retainedCustomerSourceIds] : undefined;
    for (const inv of await source.listInvoices({
      ...(includeHistory ? {} : { openOnly: true }),
      ...(invoiceScope ? { customerIds: invoiceScope } : {}),
    })) {
      if (inv.status === "pending") {
        count("invoices").skipped++;
        continue;
      }
      // `openOnly` is a source HINT — types.ts: "a source that ignores the flag just
      // returns everything, which is safe — only slower". Safe for the row count, but
      // NOT for the meaning of `--no-history`: against an uncooperative source the
      // import silently widens to the full invoice history, which is the one thing the
      // flag exists to prevent (settled history is bulk production data we chose not to
      // copy onto the shadow host). Enforce it here so the flag means the same thing
      // whatever the source does — and so `reconcileWithSource`, which filters the same
      // way, agrees with the importer by construction rather than by coincidence.
      if (!includeHistory && !OPEN_INVOICE_STATUSES.includes(inv.status)) {
        count("invoices").skipped++;
        continue;
      }
      // A scoped import deliberately leaves some customers out; their invoices go
      // with them. Skipped and counted, never fatal — out of scope is a decision,
      // not the "customer missing from the import set" integrity error below.
      if (retainedCustomerSourceIds && !retainedCustomerSourceIds.has(inv.customerSourceId)) {
        count("invoices").skipped++;
        continue;
      }
      const r = await importOne("invoices", "invoice", inv.sourceId, async () => {
        const customerId = customerBySource.get(inv.customerSourceId);
        if (!customerId) throw new Error(`customer ${inv.customerSourceId} not in import set`);
        const row = await importArchivalInvoice({
          organizationId,
          businessId,
          customerId,
          subscriptionId: inv.subscriptionSourceId
            ? subBySource.get(inv.subscriptionSourceId)
            : null,
          number: inv.number ?? inv.sourceId,
          status: inv.status as "paid" | "posted" | "payment_due" | "not_paid" | "voided",
          currency: inv.currency,
          subtotalMinor: inv.subtotalMinor,
          totalMinor: inv.totalMinor,
          amountDueMinor: inv.amountDueMinor,
          writtenOff: (inv.writeOffMinor ?? 0) > 0,
          issue: inv.issue,
          date: inv.date,
          dueDate: inv.dueDate,
          paidAt: inv.paidAt,
          periodStart: inv.periodStart,
          periodEnd: inv.periodEnd,
          // The source's own issue-time FX rate (0228), or nothing — never today's.
          exchangeRate: inv.exchangeRate ?? null,
          exchangeRateBase: inv.exchangeRateBase ?? null,
          // Resume the source's ladder rather than restarting it — see
          // SourceInvoice.dunning.
          dunning: inv.dunning,
          lines: [
            ...inv.lines.map((l) => ({
              description: l.description,
              priceId: l.priceSourceId ? priceRowBySource.get(l.priceSourceId)?.id : null,
              quantity: l.quantity,
              unitAmountMinor: l.unitAmountMinor,
              amountMinor: l.amountMinor,
              // Per-line attribution, both stages (0169).
              discountMinor: l.discountMinor,
              discounts: l.discounts,
              periodStart: l.periodStart,
              periodEnd: l.periodEnd,
              kind: l.kind,
            })),
            // DOCUMENT-level discounts only, as NEGATIVE lines: those apply BETWEEN the
            // source's `subtotalMinor` and its total, so without them Σ(lines) overshoots
            // the total by the coupon amount.
            //
            // ⚠️ Item-level discounts are deliberately EXCLUDED. `subtotalMinor` is
            // the source's `sub_total`, which already has them off it (see
            // `discountScope`) — importing them here as well subtracted them twice and
            // produced an imported invoice that did not add up: a 12900 plan with a 15%
            // item-level coupon landed as subtotal 10965 against a 12900 line and a 1935
            // discount, netting 9030 against a total of 10965. They survive as per-line
            // attribution on the lines above, which is where the source puts them too.
            ...(inv.discounts ?? [])
              .filter((d) => discountScope(d.entityType) === "document_level")
              .map((d) => ({
                description: d.description,
                priceId: null,
                quantity: 1,
                unitAmountMinor: -Math.abs(d.amountMinor),
                amountMinor: -Math.abs(d.amountMinor),
                kind: "discount" as const,
              })),
            // Tax lines close the remaining gap to the total.
            ...(inv.taxes ?? []).map((t) => ({
              description: t.description ?? (t.rate != null ? `${t.name} @ ${t.rate}%` : t.name),
              priceId: null,
              quantity: 1,
              unitAmountMinor: t.amountMinor,
              amountMinor: t.amountMinor,
              kind: "tax" as const,
            })),
          ],
          metadata: stamp(inv.sourceId, { source_payload: inv.rawPayload ?? null }),
        });
        invoiceBySource.set(inv.sourceId, { id: row.id, publicId: row.publicId, customerId });
        return { targetType: "invoice", targetId: row.id };
      });
      if (r.existing) {
        const row = await withTenant(organizationId, async (tx) => {
          const [x] = await tx
            .select({
              id: invoicesTable.id,
              publicId: invoicesTable.publicId,
              customerId: invoicesTable.customerId,
            })
            .from(invoicesTable)
            .where(eq(invoicesTable.id, r.existing!))
            .limit(1);
          return x;
        });
        if (row) invoiceBySource.set(inv.sourceId, row);
      }
      const numeric = Number(String(inv.number ?? inv.sourceId).replace(/\D/g, ""));
      if (Number.isFinite(numeric) && numeric > maxImportedNumber) maxImportedNumber = numeric;
    }

    // Bump the business's invoice sequence past the imported max so newly
    // issued numbers never collide with source history.
    if (maxImportedNumber > 0) {
      await withTenant(organizationId, async (tx) => {
        await tx
          .update(businesses)
          .set({
            invoiceNextNumber: sql`GREATEST(${businesses.invoiceNextNumber}, ${maxImportedNumber + 1})`,
          })
          .where(eq(businesses.id, businessId));
      });
    }
    await progress("invoices");
  }

  // Source txn id → our gateway-log transactions.id (CN import links refunds to it).
  const txnRowBySource = new Map<string, string>();

  if (!catalogOnly && includeHistory && source.listTransactions) {
    const paymentBySource = new Map<string, { id: string }>();
    const refundBySource = new Map<string, { id: string }>();
    const allTxns = await source.listTransactions(
      retainedCustomerSourceIds ? { customerIds: [...retainedCustomerSourceIds] } : undefined,
    );
    /**
     * Scope filter, applied to payments AND refunds together so the two cannot
     * disagree — a refund whose payment was filtered out would fail to resolve its
     * parent, and since both belong to the same customer they are always in or out
     * together.
     *
     * `customerSourceId` is OPTIONAL on a source transaction, so a row without one is
     * judged by whether any invoice it settles actually landed. `invoiceBySource` holds
     * only imported invoices, which makes it exactly the right test.
     */
    const txns = retainedCustomerSourceIds
      ? allTxns.filter((t) =>
          t.customerSourceId
            ? retainedCustomerSourceIds!.has(t.customerSourceId)
            : (t.linkedInvoices ?? []).some((l) => invoiceBySource.has(l.invoiceSourceId)),
        )
      : allTxns;
    if (retainedCustomerSourceIds) {
      const dropped = allTxns.length - txns.length;
      count("payments").skipped += dropped;
    }
    // Payments first (refunds reference them). Voided attempts moved no money —
    // they appear only in the gateway transaction log below, too.
    for (const t of txns.filter((t) => t.type === "payment" && t.gatewayStatus !== "voided")) {
      const r = await importOne("payments", "transaction", t.sourceId, async () => {
        const linked = t.linkedInvoices?.[0];
        const invoice = linked ? invoiceBySource.get(linked.invoiceSourceId) : undefined;
        const customerId =
          (t.customerSourceId ? customerBySource.get(t.customerSourceId) : undefined) ??
          invoice?.customerId;
        if (!customerId) throw new Error("no importable customer for transaction");
        // t.gateway is already normalized to a tmbilling provider key ('stripe' | 'razorpay' |
        // 'paypal') by the source (see the source adapter's gateway mapping); unmapped/unknown source
        // gateways come through as undefined so refunds fail loudly instead of silently
        // resolving to the wrong provider. Only stamp a charge id when the gateway resolved —
        // an orphaned charge id on an unrefundable provider is a footgun for later code.
        const refundable = Boolean(t.gateway);
        const id = await withTenant(organizationId, async (tx) => {
          const [row] = await tx
            .insert(payments)
            .values({
              organizationId,
              businessId,
              customerId,
              invoiceId: invoice?.id ?? null,
              paymentMethodId: refundable
                ? (pmByCustomerAndProvider.get(customerId)?.get(t.gateway!) ?? null)
                : null,
              publicId: publicId("pay"),
              status: t.status,
              /**
               * The amount APPLIED to this invoice, not the transaction total.
               *
               * A source transaction can settle several invoices and carries the split
               * in `linked_invoices[].applied_amount`. Writing `t.amountMinor` attached the
               * whole payment to whichever invoice came first: on the live INR book
               * one transaction of 6,724.82 and applied 5,699.00 to one invoice,
               * which then read as collected for 1,025.82 more than it was ever
               * collectible for and broke `invoice_not_overpaid` on the cutover.
               *
               * The gateway-transaction row below keeps `t.amountMinor` — that log records
               * what the gateway moved, which IS the whole transaction.
               *
               * STILL INCOMPLETE, deliberately: only `linkedInvoices[0]` gets a row, so a
               * transaction spanning several invoices leaves the others without one. Those
               * read as settled-but-uncollected, indistinguishable from the legitimate
               * credit-note case, so no invariant fires. Splitting into one row per linked
               * invoice needs a composite idempotency key — importOne is keyed on the
               * transaction id alone — and is not a mid-cutover change.
               */
              amountMinor: BigInt(linked?.appliedAmountMinor ?? t.amountMinor),
              currency: t.currency.toUpperCase(),
              providerKey: t.gateway ?? "imported",
              providerChargeId: refundable ? (t.gatewayTransactionId ?? null) : null,
              imported: true,
              metadata: stamp(t.sourceId, { source_payload: t.rawPayload ?? null }),
              createdAt: t.date,
            })
            .returning();
          return row!.id;
        });
        paymentBySource.set(t.sourceId, { id });
        return { targetType: "payment", targetId: id };
      });
      if (r.existing) paymentBySource.set(t.sourceId, { id: r.existing });
    }
    for (const t of txns.filter((t) => t.type === "refund" && t.gatewayStatus !== "voided")) {
      const r = await importOne("refunds", "transaction", t.sourceId, async () => {
        /**
         * Two different situations, and only one is a defect.
         *
         * No original transaction named at the source. Measured case: a CREDIT-NOTE
         * refund paid by bank transfer (CN-2061, ₹40,824, Feb 2024) — the money never
         * went back through a gateway payment, so the source has no transaction to reference.
         * Our refunds hang off a payment, so there is nothing to attach it to.
         *
         * The AMOUNT is not lost: the credit note carries `refunded`, and that is
         * imported (verified — the note landed `total=refunded=4082400, status=refunded`).
         * What is absent is the transaction-level row. Worth saying precisely, because
         * "refund history missing" would send someone looking for money that is right
         * there on the credit note.
         */
        if (!t.refundedTransactionSourceId) {
          warn(
            `refund ${t.sourceId} names no original transaction at the source (typically a ` +
              `credit-note refund paid offline), so no refund row was created. Check the ` +
              `related credit note — its refunded amount carries this ${t.amountMinor} ` +
              `${t.currency ?? ""}`.trim(),
          );
          return "skip";
        }
        /**
         * The source DOES name one and we do not have it. That is our scope dropping a
         * payment we should have taken, and it stays fatal — a refund pointing at nothing
         * is a hole in the money trail, and a re-run with the right scope fixes it.
         */
        const payment = paymentBySource.get(t.refundedTransactionSourceId);
        if (!payment) throw new Error("refunded payment not in import set");
        // See payments block above: t.gateway is already normalized, undefined = unmapped.
        const refundable = Boolean(t.gateway);
        const id = await withTenant(organizationId, async (tx) => {
          const [row] = await tx
            .insert(refunds)
            .values({
              organizationId,
              businessId,
              paymentId: payment.id,
              publicId: publicId("re"),
              status: t.status === "succeeded" ? "succeeded" : t.status,
              amountMinor: BigInt(t.amountMinor),
              currency: t.currency.toUpperCase(),
              providerKey: t.gateway ?? "imported",
              providerRefundId: refundable ? (t.gatewayTransactionId ?? null) : null,
              imported: true,
              metadata: stamp(t.sourceId, { source_payload: t.rawPayload ?? null }),
              createdAt: t.date,
            })
            .returning();
          return row!.id;
        });
        refundBySource.set(t.sourceId, { id });
        return { targetType: "refund", targetId: id };
      });
      if (r.existing) refundBySource.set(t.sourceId, { id: r.existing });
    }
    // Gateway transaction log — EVERY source attempt (incl. authorizations and
    // voided ones) becomes an archival transactions row, mirroring the source's
    // transactions view 1:1. Money truth stays in payments/refunds above.
    for (const t of txns) {
      const r = await importOne(
        "gateway_transactions",
        "gateway_transaction",
        t.sourceId,
        async () => {
          const linked = t.linkedInvoices?.[0];
          const invoice = linked ? invoiceBySource.get(linked.invoiceSourceId) : undefined;
          const customerId =
            (t.customerSourceId ? customerBySource.get(t.customerSourceId) : undefined) ??
            invoice?.customerId ??
            null;
          const id = await withTenant(organizationId, async (tx) => {
            const [row] = await tx
              .insert(transactions)
              .values({
                organizationId,
                businessId,
                customerId,
                publicId: publicId("txn"),
                type: t.type,
                status:
                  t.gatewayStatus ??
                  (t.status === "succeeded"
                    ? "succeeded"
                    : t.status === "pending"
                      ? "in_progress"
                      : "failed"),
                amountMinor: BigInt(t.amountMinor),
                currency: t.currency.toUpperCase(),
                gatewayKey: t.gateway ?? null,
                idAtGateway: t.gatewayTransactionId ?? null,
                errorCode: t.errorCode ?? null,
                errorText: t.errorText ?? null,
                invoiceId: invoice?.id ?? null,
                paymentId:
                  t.type === "payment" ? (paymentBySource.get(t.sourceId)?.id ?? null) : null,
                refundId: t.type === "refund" ? (refundBySource.get(t.sourceId)?.id ?? null) : null,
                occurredAt: t.date,
                settledAt: t.gatewayStatus === "succeeded" ? t.date : null,
                createdAt: t.date,
                updatedAt: t.updatedAt ?? t.date,
              })
              .returning();
            return row!.id;
          });
          txnRowBySource.set(t.sourceId, id);
          return { targetType: "gateway_transaction", targetId: id };
        },
      );
      if (r.existing) txnRowBySource.set(t.sourceId, r.existing);
    }
    await progress("transactions");
  }

  if (!catalogOnly && includeHistory && source.listCreditNotes) {
    for (const cn of await source.listCreditNotes(
      retainedCustomerSourceIds ? { customerIds: [...retainedCustomerSourceIds] } : undefined,
    )) {
      // See the unbilled-charge phase: out of scope is skipped, not failed.
      if (retainedCustomerSourceIds && !retainedCustomerSourceIds.has(cn.customerSourceId)) {
        count("credit_notes").skipped++;
        continue;
      }
      await importOne("credit_notes", "credit_note", cn.sourceId, async () => {
        const invoice = invoiceBySource.get(cn.invoiceSourceId);
        const customerId = customerBySource.get(cn.customerSourceId);
        if (!invoice || !customerId)
          throw new Error("referenced invoice/customer not in import set");
        const id = await withTenant(organizationId, async (tx) => {
          const [row] = await tx
            .insert(creditNotes)
            .values({
              organizationId,
              businessId,
              customerId,
              invoiceId: invoice.id,
              publicId: publicId("cn"),
              // The source's credit-note id IS its document number, as for invoices.
              number: cn.sourceId,
              // Literal, not `currentChannel()` — see the same note in
              // invoicing/import.ts: archival rows must read as imported.
              channel: "import",
              creditMethod: cn.type === "refundable" ? "refund" : "balance",
              // E4 model: adjustment CNs are fully allocated to their invoice;
              // refundable CNs split into allocated (drawn against invoices) vs
              // refunded (paid back to the customer at the source) vs available.
              kind: cn.type,
              // A voided refundable note opened no credit (its available is mapped to 0),
              // which the amount test below would read as "fully refunded".
              status:
                cn.type === "adjustment"
                  ? "adjusted"
                  : cn.status === "voided"
                    ? "voided"
                    : cn.amountAvailableMinor > 0
                      ? "refund_due"
                      : "refunded",
              voidedAt:
                cn.type === "refundable" && cn.status === "voided"
                  ? (cn.voidedAt ?? cn.date)
                  : null,
              reasonCode:
                cn.type === "adjustment"
                  ? cn.reason === "write_off"
                    ? "write_off"
                    : "other"
                  : null,
              totalMinor: BigInt(cn.totalMinor),
              allocatedMinor:
                cn.type === "adjustment"
                  ? BigInt(cn.totalMinor)
                  : BigInt(
                      cn.amountAllocatedMinor ??
                        cn.totalMinor - cn.amountAvailableMinor - (cn.amountRefundedMinor ?? 0),
                    ),
              refundedMinor: cn.type === "refundable" ? BigInt(cn.amountRefundedMinor ?? 0) : 0n,
              // Already paid out at the source — the payout sweep must not re-pay it.
              paidOutMinor: cn.type === "refundable" ? BigInt(cn.amountRefundedMinor ?? 0) : 0n,
              currency: cn.currency.toUpperCase(),
              reason: cn.reason ?? null,
              // FX snapshot (0228) inherited from the imported invoice this note
              // credits, so a migrated reversal converts at the same rate as the
              // document it reverses. Read from the row rather than the source payload:
              // the invoice is the one that decided what was kept.
              ...(await inheritedInvoiceRate(tx, invoice.id)),
              imported: true,
              metadata: stamp(cn.sourceId, {
                source_status: cn.status,
                source_type: cn.type,
                source_payload: cn.rawPayload ?? null,
              }),
              createdAt: cn.date,
            })
            .returning();
          if (cn.lines && cn.lines.length > 0) {
            await tx.insert(creditNoteItems).values(
              cn.lines.map((l) => ({
                organizationId,
                businessId,
                creditNoteId: row!.id,
                publicId: publicId("cni"),
                description: l.description,
                amountMinor: BigInt(l.amountMinor),
                createdAt: cn.date,
              })),
            );
          }
          // Allocation history → credit_note_allocations (only invoices in the
          // import set can be referenced; others stay in the raw payload).
          const allocRows = (cn.allocations ?? []).flatMap((a) => {
            const inv = invoiceBySource.get(a.invoiceSourceId);
            return inv ? [{ a, inv }] : [];
          });
          if (allocRows.length > 0) {
            await tx.insert(creditNoteAllocations).values(
              allocRows.map(({ a, inv }) => ({
                organizationId,
                businessId,
                creditNoteId: row!.id,
                invoiceId: inv.id,
                amountMinor: BigInt(a.amountMinor),
                createdAt: a.date ?? cn.date,
              })),
            );
          }
          // Refunds drawn from this CN: stamp the already-imported gateway-log
          // row with this CN's id (the CN detail timeline reads transactions
          // with credit_note_id). Fall back to inserting an archival row when
          // the source didn't expose the transaction itself (e.g. JSON files).
          for (const lr of cn.linkedRefunds ?? []) {
            const txnId = txnRowBySource.get(lr.transactionSourceId);
            if (txnId) {
              await tx
                .update(transactions)
                .set({ creditNoteId: row!.id })
                .where(eq(transactions.id, txnId));
            } else {
              await tx.insert(transactions).values({
                organizationId,
                businessId,
                customerId,
                publicId: publicId("txn"),
                type: "refund",
                status: "succeeded",
                amountMinor: BigInt(lr.amountMinor),
                currency: cn.currency.toUpperCase(),
                gatewayKey: lr.gateway ?? null,
                idAtGateway: lr.gatewayTransactionId ?? null,
                invoiceId: invoice.id,
                creditNoteId: row!.id,
                occurredAt: lr.date ?? cn.date,
                settledAt: lr.date ?? cn.date,
                createdAt: lr.date ?? cn.date,
                updatedAt: lr.date ?? cn.date,
              });
            }
          }
          // A still-refundable balance is live money the customer can spend: open
          // it as refundable_credit_balance credit (D1 balance split; funded from
          // opening_balance).
          if (cn.type === "refundable" && cn.amountAvailableMinor > 0) {
            await postEntries(
              {
                organizationId,
                businessId,
                customerId,
                sourceType: "import",
                sourceId: row!.publicId,
                lines: [
                  {
                    account: "opening_balance",
                    direction: "debit",
                    amountMinor: BigInt(cn.amountAvailableMinor),
                    currency: cn.currency.toUpperCase(),
                    memo: "Opening credit (imported refundable credit note)",
                  },
                  {
                    account: "refundable_credit_balance",
                    direction: "credit",
                    amountMinor: BigInt(cn.amountAvailableMinor),
                    currency: cn.currency.toUpperCase(),
                    memo: "Opening credit (imported refundable credit note)",
                  },
                ],
              },
              tx,
            );
          }
          return row!.id;
        });
        return { targetType: "credit_note", targetId: id };
      });
    }
    await progress("credit_notes");
  }

  // ===========================================================================
  // 6) Events — raw archive (the source's history can't be regenerated later)
  // ===========================================================================

  if (!catalogOnly && includeEvents && source.listEvents) {
    const events = await source.listEvents();
    const CHUNK = 500;
    for (let i = 0; i < events.length; i += CHUNK) {
      const chunk = events.slice(i, i + CHUNK);
      try {
        const inserted = await withTenant(organizationId, async (tx) =>
          tx
            .insert(importedEvents)
            .values(
              chunk.map((e) => ({
                organizationId,
                businessId,
                publicId: publicId("ievt"),
                source: source.name,
                sourceId: e.sourceId,
                eventType: e.eventType,
                occurredAt: e.occurredAt,
                payload: e.payload ?? {},
              })),
            )
            .onConflictDoNothing({
              target: [
                importedEvents.organizationId,
                importedEvents.source,
                importedEvents.sourceId,
              ],
            })
            .returning({ id: importedEvents.id }),
        );
        count("events").created += inserted.length;
        count("events").skipped += chunk.length - inserted.length;
      } catch (e) {
        count("events").failed += chunk.length;
        warn(`events chunk @${i}: ${(e as Error).message}`);
        log.error(e, { event: "import_events_chunk_failed", offset: i, chunkSize: chunk.length });
      }
    }
    await progress("events");
  }

  return result;
}

import { shipToSnapshot } from "@/modules/customers/addresses";
import { presentationBlock, RAIL_LIMIT_CODE, RAIL_SPACING_CODE } from "./representment";
import { CARD_LIMIT_CODE, CARD_LIMIT_MESSAGE, isCardInstrument, overCardLimit } from "./card-limit";
import {
  loadEffectiveDunningConfig,
  planPolicyConfigSql,
  priorFailedMethods,
} from "@/modules/dunning-policies/effective";
import { and, desc, eq, gt, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { afterCommit, withTenant, type Tx } from "@/platform/db";
import { requestInvoiceNumbering } from "./number-queue";
import {
  clampLimit,
  documentNumberSortKey,
  filterConditions,
  keysetCondition,
  kindsFromSpecs,
  opsFromSpecs,
  pageOrder,
  parseCursor,
  searchCondition,
  toPage,
  type FilterSpec,
  type ListFilter,
  type ListPage,
  cappedTotal,
} from "@/platform/list-query";
import { businessTimezone } from "@/platform/business-tz";
import { zonedDayString } from "@/platform/timezones";
import { resolveInvoiceCustomization, composeDocumentNumber } from "./customization";
import {
  exchangeRateColumns,
  loadIssueRate,
  resolveIssueRate,
  type IssueExchangeRate,
} from "./exchange-rate";
import { billingModeFor } from "@/modules/subscriptions/billing-mode";
import { publicId } from "@/platform/ids";
import { currentChannel } from "@/platform/event-context";
import { withSpan } from "@/platform/trace";
import { businessNow, businessWallClock, stampNow } from "@/platform/clock";
import { postEntries } from "@/modules/ledger/service";
import {
  bucketBalancesForCurrency,
  planCreditApplication,
  lockCustomerBalances,
  emitPromotionalCreditMovement,
  PROMOTIONAL_CREDIT,
  REFUNDABLE_CREDIT,
  EXCESS_PAYMENT,
  type CustomerBalances,
} from "@/modules/customers/balances";
import {
  creditApplicationLimits,
  loadCreditApplicationLimits,
  resolveCreditsFlexibility,
  UNLIMITED_CREDIT_LIMITS,
  type CreditApplicationLimits,
} from "@/modules/customers/credits-flexibility";
import { accountHolderName } from "@/modules/customers/names";
import { accountHolderNameSql } from "@/modules/customers/name-sql";
import { arAgingBucketCondition, arAgingBucketSql } from "./ar-aging";
import {
  computeLineAmount,
  snapshotPrice,
  ratableFromSnapshot,
  unitRate,
  priceLabel,
  isCycleCapExhausted,
  isMeteredPrice,
  minimumTrueUp,
  PERCENT_OF_BASE_MODELS,
  type PriceSnapshot,
} from "@/modules/catalog/pricing";
import { addInterval, type Interval } from "@/modules/subscriptions/interval";
import {
  MANDATE_REVOKED_CODES,
  resolveBillingRulesConfig,
} from "@/modules/subscriptions/billing-rules-config";
import {
  COMMITMENT_CHARGE,
  commitmentDescription,
  countedCommitmentFees,
  countsTowardCommitment,
  fullTermEnd,
  planPriceFor,
  proratedCommitment,
  type CommitmentSegment,
} from "@/modules/subscriptions/commitment";
import {
  nextRetryAt,
  planFailureRearm,
  heldRetry,
  nextParkedReminderAt,
  retryDaysForMethod,
  dunningAppliesTo,
  dunningPeriodEndsAt,
  nextOfflineReminderAt,
  dunningHoldReason,
  type DunningConfig,
  type DunningHold,
  dunningAnchor,
} from "@/modules/subscriptions/dunning-schedule";
import { lineRating, rateMeteredItem, type LineRating } from "@/modules/metering/rating";
import {
  commitMeterRating,
  FOLD_GRACE_MS,
  fixedToNumber,
  meterLineDescription,
  meterLineRatingJson,
  peekMeterCutoff,
  rateMeterItem,
  takeMeterCutoff,
  type LevelSnapshot,
  type MeterCutoff,
  type MeterItemRating,
  type MeterLineRating,
  type MeterLineRatingJson,
} from "@/modules/metering/meter-rating";
import { divFixed12, divHalfUp, fixed12FromInt, formatFixed12 } from "@/platform/fixed";
import {
  getTaxProvider,
  allocateTaxAcrossSignedLines,
  computeInvoiceTax,
  lineIsInclusive,
  prepaidCreditResolution,
  taxMinorFor,
  taxComponentLabel,
  type InvoiceTax,
  type TaxableLine,
  type TaxResolution,
  type TaxTreatment,
} from "@/modules/tax/service";
import { peekDiscounts, consumeDiscount, settlePeriodDiscount } from "@/modules/coupons/service";
import { DUNNING_STATUS_ALIASES, isLiveDunning, isOpenInvoiceStatus } from "./status";
import {
  emitEvent,
  emitDeferred,
  insertPreparedEvent,
  prepareEvent,
  type EmitEventInput,
  type PreparedEvent,
} from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { invoiceChargeDescription } from "./charge-description";
import { GatewayRouterError } from "@/modules/gateway/router";
import { allocateRefundableDraw } from "@/modules/credit-notes/service";
import { recordTransaction } from "@/modules/transactions/service";
import {
  chargeWithMethod,
  lostChargeHandle,
  type LostChargeHandle,
  intentForOnSessionChallenge,
  isHardDecline,
  isDeadMandateDecline,
  mandatePendingBackoff,
  MANDATE_PENDING_CODE,
  shouldTryBackup,
  collectionRank,
  loadChargeContact,
  markPaymentMethodInvalid,
  resolveChargeCandidates,
  chargeOrder,
  tmtestOutcome,
  type ChargeAttempt,
  type CollectionSession,
  type CompletedCharge,
  type Pm,
} from "./collection";
import { methodTypeOf } from "@/modules/payments/method-type";
import type { MethodType } from "@/providers/method-types";
import type { PaymentAttempt, PaymentIntent } from "@/modules/payment-intents/service";
import { liveIntentForInvoice } from "@/modules/payment-intents/service";
import {
  debitAwaitsBuyerAuthentication,
  AWAITING_AUTHENTICATION_CODE,
  AUTHENTICATION_NOT_REQUIRED_CODE,
} from "@/modules/payment-methods/service";
import {
  subscriptions,
  subscriptionItems,
  prices,
  products,
  invoices,
  invoiceLineItems,
  invoiceLineDiscounts,
  appliedCoupons,
  coupons,
  couponSetCodes,
  appliedTaxes,
  payments,
  paymentMethods,
  refunds,
  countries,
  paymentIntents,
  transactions,
  customers,
  unbilledCharges,
  businesses,
} from "@db/schema";
import { createLogger } from "@/platform/logger";
import { dunningFieldsOnSettle } from "@/modules/invoicing/status";
import { payerDeclineMessage } from "@/providers/decline-codes";
import { formatMoney, minorScale } from "@/platform/currency";
import {
  billedOnInterims,
  foldBilledDiscount,
  groupKey,
  netMeterLines,
  thresholdEligible,
  type ItemBilled,
} from "@/modules/usage-controls/interim-lines";
import { ProviderIndeterminateError, strandedObjectId } from "@/providers/types";
import {
  customerBillingAddress,
  customerTaxIdOf,
  frozen,
  invoiceNotesOf,
} from "./billing-snapshot";
import { sellerAtIssue, type SellerAtIssue } from "./document";
import { loadInvoiceRelations, type InvoiceRelations } from "./relations";
import { loadPlannerGrants, postGrantDraws } from "@/modules/credits/service";
import {
  activatePaidCreditGrants,
  createPendingPackGrants,
  packLinesMinor,
} from "@/modules/credits/packs";
import { applyPlanCredits } from "@/modules/credits/plan-credits";
import { ensureCreditWindows } from "@/modules/credits/credit-clock";
import { withGrantSlices } from "@/modules/credits/slices";
import type { LineSlice } from "@/modules/credits/planner";
import {
  grantPhase,
  planGrantApplication,
  type GrantDraw,
  type PlannerGrant,
  type PlannerLine,
} from "@/modules/credits/planner";

const log = createLogger("invoicing");

type Invoice = typeof invoices.$inferSelect;
type Payment = typeof payments.$inferSelect;

/**
 * Draw the customer's credit buckets down against an invoice's AR (D1 balance
 * split). Each nonzero bucket posts dr `<bucket>_balance` / cr accounts_receivable
 * — reducing the liability we hold and what the customer owes. Promotional was
 * already applied pre-tax by the caller (it reduced the taxable base); refundable
 * and excess are applied post-tax. Amounts are computed by the caller so the tax
 * base and totals stay consistent.
 */
export async function postCreditApplications(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    customerId: string;
    invoicePublicId: string;
    currency: string;
    promotional: bigint;
    refundable: bigint;
    excess: bigint;
  },
): Promise<void> {
  const buckets: Array<[string, bigint]> = [
    [PROMOTIONAL_CREDIT, input.promotional],
    [REFUNDABLE_CREDIT, input.refundable],
    [EXCESS_PAYMENT, input.excess],
  ];
  for (const [account, amount] of buckets) {
    if (amount <= 0n) continue;
    await postEntries(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: input.customerId,
        sourceType: "credit_applied",
        sourceId: input.invoicePublicId,
        lines: [
          { account, direction: "debit", amountMinor: amount, currency: input.currency },
          {
            account: "accounts_receivable",
            direction: "credit",
            amountMinor: amount,
            currency: input.currency,
          },
        ],
      },
      tx,
    );
  }
  // A promotional DRAW is one of the four ways the promo balance moves, and until
  // now the only silent one: the ledger moved but no event said so, so a consumer
  // tracking the balance over webhooks saw the grant and the manual deduct and
  // nothing else. So `promotional_credits_deducted` is emitted here too.
  // NOT emitted for the refundable/excess buckets — those have no per-bucket event
  // type; their movement is reported by the customer_changed that allocateRefundableDraw
  // emits, and inventing new types is a separate decision.
  await emitPromotionalCreditMovement(tx, {
    organizationId: input.organizationId,
    businessId: input.businessId,
    customerId: input.customerId,
    amountMinor: input.promotional,
    currency: input.currency,
    direction: "deducted",
    description: `Applied to invoice ${input.invoicePublicId}`,
    invoicePublicId: input.invoicePublicId,
  });
}

/**
 * Round-off (E6/INV-5): round a post-tax total to the nearest whole currency unit when
 * the business enables it. `unit` is one major unit in minor units — `minorScale(currency)`:
 * 100 for USD, 1000 for KWD, 1 for JPY (a no-op). Returns the signed delta to add to the
 * total (rounded − original); 0 when rounding is off. Half rounds up.
 */
export function roundingDeltaFor(
  mode: string | null | undefined,
  totalMinor: bigint,
  unit: bigint,
): bigint {
  if (mode !== "nearest_unit" || unit <= 1n || totalMinor <= 0n) return 0n;
  const rounded = ((totalMinor + unit / 2n) / unit) * unit;
  return rounded - totalMinor;
}

/**
 * Bring an event snapshot built before the invoice was numbered up to the numbered row: the
 * number, and the version and timestamp its UPDATE moved. Nothing else in the snapshot depends
 * on it.
 */
function patchInvoiceSnapshot(content: Record<string, unknown>, inv: Invoice): void {
  const snap = content.invoice as Record<string, unknown> | undefined;
  if (!snap || snap.id !== inv.publicId) return;
  snap.number = inv.number;
  snap.updated_at = inv.updatedAt;
  snap.resource_version = inv.resourceVersion;
}

/**
 * Assign the next human-readable invoice number. Runs inside the invoice txn.
 *
 * TWO statements, and the split is deliberate: only the COUNTER is contended.
 *
 *   1. Read the business's number FORMAT (prefix, timezone, customization). Uncontended —
 *      two concurrent billing runs reading the same config both compose correctly, and a
 *      config read one invoice stale changes the shape of a number, never its uniqueness.
 *   2. `UPDATE … SET n = n + $increment RETURNING n` — atomic on its own. Postgres holds
 *      the row lock for the statement, so concurrent runs serialise and cannot be handed
 *      the same counter no matter where `$increment` came from.
 *
 * Composing the number in SQL instead would mean re-implementing the resolver's clamps
 * and defaults as jsonb casts, i.e. a second source of truth for the format — and a
 * malformed stored `increment` would raise a cast error on the billing path rather than
 * falling back the way `resolveInvoiceCustomization` does.
 *
 * The counter is strictly MONOTONIC: there is no periodic reset (see NumberingConfig in
 * ./customization.ts), so no prefix or format change can reproduce a number this business
 * has already issued.
 */
async function nextInvoiceNumber(
  tx: Tx,
  businessId: string,
  at: Date = businessNow(businessId),
): Promise<string> {
  const [cfg] = await tx
    .select({
      customization: businesses.invoiceCustomization,
      timezone: businesses.timezone,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  const numbering = resolveInvoiceCustomization({
    invoiceCustomization: cfg?.customization,
  }).invoiceNumbering;

  const [b] = await tx
    .update(businesses)
    .set({ invoiceNextNumber: sql`${businesses.invoiceNextNumber} + ${numbering.increment}` })
    .where(eq(businesses.id, businessId))
    .returning({ prefix: businesses.invoicePrefix, next: businesses.invoiceNextNumber });
  return composeDocumentNumber({
    prefix: b!.prefix,
    // RETURNING on an UPDATE yields the POST-bump value, so step back by the increment
    // that was actually applied rather than by a hardcoded 1.
    counter: b!.next - BigInt(numbering.increment),
    numbering,
    at,
    timezone: cfg?.timezone ?? "UTC",
  });
}

/**
 * `nextInvoiceNumber` for several invoices with ONE counter update: the batch numbering path.
 * `ats[i]` dates number i, so a dated prefix follows when each invoice was raised.
 */
export async function nextInvoiceNumbers(
  tx: Tx,
  businessId: string,
  ats: Date[],
): Promise<string[]> {
  const count = ats.length;
  if (count === 0) return [];
  const [cfg] = await tx
    .select({
      customization: businesses.invoiceCustomization,
      timezone: businesses.timezone,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  const numbering = resolveInvoiceCustomization({
    invoiceCustomization: cfg?.customization,
  }).invoiceNumbering;
  const step = BigInt(numbering.increment);
  const [b] = await tx
    .update(businesses)
    .set({ invoiceNextNumber: sql`${businesses.invoiceNextNumber} + ${step * BigInt(count)}` })
    .where(eq(businesses.id, businessId))
    .returning({ prefix: businesses.invoicePrefix, next: businesses.invoiceNextNumber });
  const first = b!.next - step * BigInt(count);
  return ats.map((at, i) =>
    composeDocumentNumber({
      prefix: b!.prefix,
      counter: first + step * BigInt(i),
      numbering,
      at,
      timezone: cfg?.timezone ?? "UTC",
    }),
  );
}

/**
 * CP-1 auto-collection resolution: 'off' → leave the invoice open (send-invoice),
 * don't attempt a charge. The subscription's setting overrides the customer's;
 * default is 'on' (charge automatically, the historical behavior).
 */
export function isAutoCollectOn(
  subAuto: string | null,
  custAuto: string | null | undefined,
): boolean {
  return (subAuto ?? custAuto ?? "on") !== "off";
}

/**
 * SQL form of `isAutoCollectOn`, for the clock scans that must SELECT by collection
 * mode instead of filtering row by row.
 *
 * Requires the query to join `customers` on `invoices.customer_id` and LEFT JOIN
 * `subscriptions` on `invoices.subscription_id`; the coalesce order is the same
 * override order the function above applies — subscription wins, else customer, else
 * 'on'.
 *
 * ── Why a SQL predicate and not a per-row check (2026-08-31) ──────────────────
 * An offline invoice in dunning is column-for-column identical to a retried one
 * (`payment_due` + `dunning_status: 'in_progress'` + a `next_attempt_at`) — deliberate.
 * So `runInvoiceDueTransitions`' offline scan and
 * `runDunningPass`' retry scan match the SAME rows, and each must exclude the other's.
 *
 * Doing it per row was not merely wasteful, it was WRONG: both scans are
 * LIMIT-bounded and ordered by `next_attempt_at`, so on a real backlog the offline
 * rows fall off the end of the page and are never processed at all. Measured on the
 * dev DB while writing this: 1163 ordinary dunning rows sorted ahead of the one
 * offline invoice under test, whose reminder therefore never advanced and whose
 * dunning window never closed. The filter has to be in the WHERE clause.
 */
export function autoCollectionOffSql(): SQL {
  return sql`coalesce(${subscriptions.autoCollection}, ${customers.autoCollection}, 'on') = 'off'`;
}

/** The complement of {@link autoCollectionOffSql} — same join requirement. */
export function autoCollectionOnSql(): SQL {
  return sql`coalesce(${subscriptions.autoCollection}, ${customers.autoCollection}, 'on') <> 'off'`;
}

/**
 * SQL form of `dunningHoldFor`: true when neither the customer's exclusion nor the
 * per-currency minimum (customer's policy, else business) holds this invoice. Needs no join. In the WHERE clause
 * of every dunning scan, so held rows never fill a LIMIT-bounded page.
 */
export function dunningNotHeldSql(): SQL {
  // The customer's dunning policy, else the plan's, owns the minimum (0386, 2.48).
  const min = sql`(coalesce((select hpol.config from customers hpc
      join dunning_policies hpol on hpol.id = hpc.dunning_policy_id
      where hpc.id = ${invoices.customerId}),
      ${planPolicyConfigSql(sql`${invoices.subscriptionId}`, sql`hb.dunning_config`)},
      hb.dunning_config)
    -> 'minimum_amounts' ->> ${invoices.currency}::text)`;
  return sql`(
    ${invoices.purpose} is distinct from 'credit_purchase'
    and not exists (select 1 from customers hc
                where hc.id = ${invoices.customerId} and hc.dunning_excluded)
    and coalesce((select case
        when ${min} ~ '^[1-9][0-9]{0,14}$'
        then ${min}::bigint <= coalesce(${invoices.amountDueMinor}, ${invoices.totalMinor})
          - coalesce((select sum(hp.amount_minor) from payments hp
                      where hp.invoice_id = ${invoices.id} and hp.status = 'succeeded'), 0)
          - coalesce((select sum(hr.amount_minor) from refunds hr
                      join payments hrp on hrp.id = hr.payment_id
                      where hrp.invoice_id = ${invoices.id} and hrp.status = 'failed'
                        and hr.status <> 'failed'), 0)
        else true end
      from businesses hb where hb.id = ${invoices.businessId}), true))`;
}

/**
 * Put a freshly raised AUTO-COLLECT-OFF invoice into dunning — at RAISE, not at its
 * due date.
 *
 * ── The shape, AS RAISED ──────────────────────────────────────────────────────
 * An `auto_collection: off` unpaid invoice reports:
 *
 *   status = payment_due   ·  dunning_status = in_progress
 *   next_retry_at = invoice date + the first retry interval (5d)
 *   dunning_attempts = []  ·  amount_paid = 0, no paid_at
 *   due_date = the invoice date exactly (zero net terms)
 *
 * and the proration invoice a mid-term plan change raises on the same customer is
 * identical. It used to report `payment_due` with `dunning_status: null` on the renewal
 * path and `not_paid` / `attempt_count: 1` on the plan-change path — two offline
 * unpaid invoices on ONE customer carrying different statuses.
 *
 * Dunning is "in progress" on an invoice nothing will ever charge because for a
 * send-invoice bill dunning means REMINDERS. So this arms `next_attempt_at` as a
 * reminder instant (`nextOfflineReminderAt`) and leaves `attempt_count` at 0 —
 * nothing is presented to a gateway, ever. `runDunningPass` and
 * `sweepStrandedRetries` skip auto-collect-off rows precisely so that stays true.
 *
 * Only for an invoice that is due NOW (`payment_due`). A Net-D offline invoice is
 * born `posted`, and every dunning offset is measured FROM the due date, so there is
 * nothing to count from yet — `runInvoiceDueTransitions` enrols it when the due date
 * arrives. Arming `next_attempt_at` on a `posted` row would also collide with the
 * collection LEASE that pass takes on the same column.
 *
 * Best-effort and idempotent: guarded on the invoice still being `payment_due` with
 * no dunning state, so a concurrent payment, a merchant stop, or a second call
 * changes nothing. Returns the invoice as it now stands.
 */
async function enrolOfflineInvoiceInDunning(input: {
  organizationId: string;
  businessId: string;
  invoice: Invoice;
  subscriptionStatus?: string | null;
  now?: Date;
}): Promise<Invoice> {
  const { organizationId, businessId, invoice } = input;
  if (invoice.status !== "payment_due" || invoice.dunningStatus != null) return invoice;
  const now = input.now ?? businessNow(businessId);
  return withTenant(organizationId, async (tx) => {
    const cfg = await loadEffectiveDunningConfig(tx, {
      businessId,
      customerId: invoice.customerId,
      subscriptionId: invoice.subscriptionId,
    });
    // Excluded customer or below the minimum: dunning does not start.
    if ((await dunningHoldFor(tx, invoice, cfg)) !== null) return invoice;
    const reminder = nextOfflineReminderAt(cfg, dunningAnchor(invoice), now, {
      hasSubscription: invoice.subscriptionId != null,
      subscriptionStatus: input.subscriptionStatus ?? null,
    });
    if (!reminder) return invoice;
    const [upd] = await tx
      .update(invoices)
      .set({ dunningStatus: "in_progress", nextAttemptAt: reminder })
      .where(
        and(
          eq(invoices.id, invoice.id),
          eq(invoices.status, "payment_due"),
          isNull(invoices.dunningStatus),
          isNull(invoices.nextAttemptAt),
        ),
      )
      .returning();
    return upd ?? invoice;
  });
}

export interface ComputedLine {
  description: string;
  priceId: string | null;
  quantity: number;
  unitAmountMinor: bigint;
  amountMinor: bigint;
  kind: "recurring" | "one_time" | "usage";
  periodStart: Date;
  periodEnd: Date;
  /** Whether this line is subject to tax (from the price's is_taxable). */
  taxable: boolean;
  /** Whether the price is tax-inclusive (tax is inside the amount, backed out). */
  inclusive: boolean;
  /** CAT-2: product kind (plan|addon|charge) + slug id, for coupon item matching. */
  productKind?: string | null;
  productPublicId?: string | null;
  /** Price slug id, for price-scoped coupon constraints. */
  pricePublicId?: string | null;
  /** How a `usage` line was rated (0380); a meter line's rating (0454). */
  rating?: LineRating | MeterLineRatingJson;
  /** A true-up line (0385). */
  adjustment?: "minimum_spend" | "commitment";
  /** 0454: the true quantity and rate (minor units), ≤ 12 dp. Unset = the trigger copies the integers. */
  quantityDecimal?: string;
  unitAmountDecimal?: string;
  /** 0458: a usage line's cost in its currency, fixed at rating. Unset = no cost measured. */
  costMinor?: bigint | null;
  costBasis?: string | null;
  /** G3b: the line's usage split at reset-window grant edges, for the grant planner only. */
  grantSlices?: LineSlice[];
}

/**
 * A meter settlement keeps its line cost in its rating until it becomes a line (an unbilled
 * charge has no cost columns). Splits it back out; the line's rating never carries it.
 */
export function takeSettlementCost(rating: MeterLineRatingJson): {
  rating: MeterLineRatingJson;
  costMinor: bigint | null;
  costBasis: string | null;
} {
  const { settlement_cost: c, ...rest } = rating as MeterLineRatingJson & {
    settlement_cost?: { minor: string | null; basis: string };
  };
  return {
    rating: rest as MeterLineRatingJson,
    costMinor: c?.minor != null ? BigInt(c.minor) : null,
    costBasis: c?.basis ?? null,
  };
}

/** `unbilled_charges.entity_type` of usage rated before its period ended (`settleMeteredUsage`). */
export const USAGE_SETTLEMENT = "usage_settlement";

/** An invoice line's quantity is an `integer` column. */
const MAX_LINE_QUANTITY = 2_147_483_647n;

/** Measured usage too large for one invoice line. */
export class UsageQuantityTooLargeError extends Error {
  constructor(pricePublicId: string, quantity: bigint) {
    super(
      `We could not bill the usage for price ${pricePublicId}. The measured quantity ${quantity} is more than one invoice line can hold (${MAX_LINE_QUANTITY}). Use a package price or a larger unit.`,
    );
    this.name = "UsageQuantityTooLargeError";
  }
}

/**
 * A line this document-ordering rule can sort. Both line shapes we write —
 * `ComputedLine` (the period planner) and `InvoiceLineInput` (`createInvoiceFromLines`)
 * — structurally satisfy it, which is why the rule can be stated once.
 */
export interface OrderableDocumentLine {
  description: string;
  amountMinor: bigint;
}

/**
 * THE ORDER LINES APPEAR ON A DOCUMENT: plan first, then charges by AMOUNT ASCENDING.
 *
 * ── Why not the order the items were added ──────────────────────────────────────
 * Two bugs shared one cause (2026-08-29).
 *
 * 1. IT WAS NOT STABLE ACROSS RUNS. The period planner ordered its items
 *    `plan-first, createdAt, id` — and two add-ons attached in the SAME transaction
 *    share a `createdAt`, so a random uuid decided. Deterministic within a run, a coin
 *    flip across them: three identical offline replays returned 0 fail, 8 fail,
 *    0 fail with no code change between them. (The sibling site, proration's
 *    `rows.sort`, tie-broke on `price.publicId` — stable, but alphabetical.)
 *
 * 2. IT WAS NOT THE ORDER A DOCUMENT READS IN. An invoice lists the plan, then the
 *    add-ons CHEAPEST-FIRST by line amount. Insertion order and alphabetical are both
 *    ruled out by the real case that lists the item added first LAST while its handle
 *    sorts before the other's either way; unit amount is ruled out too (902400/unit × 10
 *    against 5527200 × 1). Line amount ascending is the only rule that fits.
 *
 * Amount is what both bugs want: it is stable across runs (killing the flap) and it is
 * the order the document should read in. It cannot live in the ORDER BY / `rows.sort`
 * that used to decide this — those sort ITEMS, before any amount is computed — so it
 * belongs here, on the computed lines, just before they are written.
 *
 * ── What this deliberately does NOT reorder ─────────────────────────────────────
 * CREDIT lines keep their exact index. Unused time is booked onto credit notes, so an
 * invoice carrying a negative line is rare enough that ascending amount would sweep
 * every credit to the front of the document on a guess. A zero-amount line IS a charge
 * and does sort: a free `Additional Connections` at 0 goes first among the add-ons.
 *
 * Callers apply this to the SUBSCRIPTION-ITEM lines only. Ad-hoc `unbilled_charges`
 * folded onto a renewal stay appended after them — they are not part of the recurring
 * composition the customer is reading.
 *
 * The tiebreak after amount is `description`, then the caller's own stable key — never a
 * row uuid, which is the thing that flapped. Two charge lines with the same amount and
 * the same description are indistinguishable on the document anyway.
 */
export function orderDocumentLines<T extends OrderableDocumentLine>(
  lines: T[],
  opts: { isPlan: (line: T) => boolean; tiebreak?: (line: T) => string },
): T[] {
  const slots: number[] = [];
  const charges: T[] = [];
  lines.forEach((line, i) => {
    if (line.amountMinor >= 0n) {
      slots.push(i);
      charges.push(line);
    }
  });
  if (charges.length < 2) return lines;
  const key = opts.tiebreak ?? (() => "");
  charges.sort(
    (a, b) =>
      (opts.isPlan(a) ? 0 : 1) - (opts.isPlan(b) ? 0 : 1) ||
      (a.amountMinor < b.amountMinor ? -1 : a.amountMinor > b.amountMinor ? 1 : 0) ||
      a.description.localeCompare(b.description) ||
      key(a).localeCompare(key(b)),
  );
  // Written back into the SAME slots the charges occupied, so every credit line keeps
  // the index it had.
  const ordered = [...lines];
  slots.forEach((slot, i) => {
    // Parallel by construction — `slots` and `charges` were filled in one pass.
    const line = charges[i];
    if (line !== undefined) ordered[slot] = line;
  });
  return ordered;
}

/** One item a period invoice rates, with its price and product. */
export interface PeriodItemRow {
  item: typeof subscriptionItems.$inferSelect;
  price: typeof prices.$inferSelect;
  productName: string;
  productKind: string | null;
  productPublicId: string;
}

export interface BillSubscriptionPeriodInput {
  organizationId: string;
  businessId: string;
  subscription: typeof subscriptions.$inferSelect;
  periodStart: Date;
  periodEnd: Date;
  /**
   * If set, bill metered usage in ARREARS for this just-ended window: aggregate
   * each usage-model item's usage over [start, end) and rate it. Fixed recurring
   * charges still bill in advance for [periodStart, periodEnd].
   */
  usagePeriod?: { start: Date; end: Date };
  /**
   * A skipped renewal (`renewal_skips`): rate only the metered items and pending one-time
   * charges. Fixed items are not charged, and their `cycles_billed` does not count it.
   */
  skipFixed?: boolean;
  /**
   * Pending-invoice mode (E2/INV-1): create the invoice as `pending` with just its
   * recurring lines — NO tax/credit/ledger/collection. Usage accretes over the
   * period and the invoice is finalized later by `closeInvoice` (which re-invokes
   * this with `existingInvoiceId`). Ignored when `existingInvoiceId` is set.
   */
  createAsPending?: boolean;
  /**
   * With `createAsPending`: the usage-arrears window this draft must bill when it
   * is CLOSED (persisted on the row). Normally the draft's own period; at the
   * transition INTO pending mode it also covers the just-ended period, whose
   * usage would otherwise never be invoiced by anyone.
   */
  pendingUsageWindow?: { start: Date; end: Date };
  /**
   * Finalize an existing `pending` draft (from `closeInvoice`) instead of inserting
   * a new invoice: the row's number is kept, its draft lines + applied taxes are
   * replaced, and the ledger/credit/collection run for the first time.
   */
  existingInvoiceId?: string;
  /**
   * When finalizing a pending draft via `closeInvoice`, emit `invoice.closed`
   * inside the finalize transaction (outbox invariant: state change + event are
   * atomic — review fix; previously emitted in a separate post-commit tx).
   */
  emitClosedEvent?: boolean;
  /**
   * P4: write ONE audit row inside the finalize transaction, describing the
   * operator action that caused this billing run (`invoice.close`,
   * `invoice.regenerate`). A callback rather than a plain payload because the
   * `after` side of the diff is only knowable here — the finalized status, and for
   * a regenerate the freshly minted invoice id.
   *
   * Absent for the two callers that are NOT operator actions (the billing clock's
   * renewal and a signup's first invoice); those are already events, and audit
   * rows exist to answer "who did this", which for a scheduled renewal is nobody.
   */
  auditWrite?: (invoice: typeof invoices.$inferSelect) => {
    action: string;
    /** Defaults to the finalized invoice; a regenerate points at the VOIDED one. */
    resourceId?: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  };
  /**
   * PREVIEW-ONLY variations for the renewal estimate. A plan built with either set is not
   * the invoice the clock would raise, so `commitSubscriptionPeriodInvoice` refuses it.
   *  - `excludePendingCharges`: leave queued unbilled charges off the plan;
   *  - `ignoreCreditBalances`: plan as though every credit bucket were empty.
   */
  preview?: { excludePendingCharges?: boolean; ignoreCreditBalances?: boolean };
  /**
   * Preview only: rate these item rows instead of the stored ones. The renewal estimate
   * passes the item set a scheduled change leaves, ordered plan first.
   */
  items?: PeriodItemRow[];
  /** Stored on a fresh invoice (a sub-period invoice's `sub_period` and `usage_window`). */
  metadata?: Record<string, unknown>;
  /**
   * Raise the minimum-commitment true-up for the term that closes with this invoice:
   * `segments` over `[term.start, endedAt)`, against the term's counted fees plus this
   * invoice's own counted lines.
   */
  commitment?: CommitmentInput;
  /**
   * Threshold invoicing (design G5 §3.7): an interim usage invoice over `usagePeriod`, up to
   * `usagePeriod.end`. Eligible metered items only, less what earlier interim invoices billed;
   * no fixed charges, coupons, minimum or pending charges; meter pointers do not move.
   * Meter usage is read to now, with no fold grace.
   */
  interim?: { originToken: string };
}

export interface CommitmentInput {
  term: { start: Date; end: Date };
  endedAt: Date;
  segments: CommitmentSegment[];
  /** The cadence the term was prorated against (`fullTermEnd`). */
  cadence: { billingPeriodUnit: string | null; billingPeriod: number | null };
}

/** The commitment counted outside this invoice moved between plan and commit; retried next tick. */
export class CommitmentMovedError extends Error {
  constructor() {
    super(
      "We could not raise the commitment true-up. The counted fees changed while it was planned. The next billing run tries again.",
    );
    this.name = "CommitmentMovedError";
  }
}

/** The coupon stack `peekDiscounts` resolves for a subscription (read-only). */
export type PeriodDiscountStack = Awaited<ReturnType<typeof peekDiscounts>>;

/**
 * The money outcome for one period invoice. A pure function of the plan's
 * read-derived inputs plus the customer's credit balances — see
 * `resolvePeriodInvoiceMoney`. Nothing here touches the DB.
 */
export interface PeriodInvoiceMoney {
  /** The credit buckets this outcome was derived from. */
  balances: CustomerBalances;
  invoiceTax: InvoiceTax;
  /** Post-tax, post-rounding invoice face total. */
  total: bigint;
  withholdingMinor: bigint;
  /** total − withholding: what can actually be collected/credited against. */
  collectible: bigint;
  roundingDelta: bigint;
  promoApplied: bigint;
  /** Credit grants drawn before tax (promotional, taxed at purchase) and after it (taxed at use). */
  grantPreTaxApplied: bigint;
  grantPostTaxApplied: bigint;
  grantDraws: GrantDraw[];
  refundableApplied: bigint;
  excessApplied: bigint;
  creditApplied: bigint;
  amountDue: bigint;
  fullyPaid: boolean;
  status: "paid" | "posted" | "payment_due";
}

/** Fields shared by both plan shapes: identity, window, and the computed lines. */
export interface PeriodInvoicePlanBase {
  organizationId: string;
  businessId: string;
  subscription: typeof subscriptions.$inferSelect;
  periodStart: Date;
  periodEnd: Date;
  usagePeriod?: { start: Date; end: Date };
  existingInvoiceId?: string;
  emitClosedEvent?: boolean;
  /** P4: audit-row builder for an operator-driven run — see BillSubscriptionPeriodInput. */
  auditWrite?: BillSubscriptionPeriodInput["auditWrite"];
  /** Set when built with `BillSubscriptionPeriodInput.preview` — never committable. */
  previewOnly?: true;
  /** Product/usage/ad-hoc lines to write (discount/tax/rounding lines are derived). */
  lines: ComputedLine[];
  /**
   * Usage aggregated for this window → one usage.recorded event per metered item
   * (per aggregation window, NOT per raw record — locked decision).
   */
  usageEvents: Array<{ slug: string; qty: number }>;
  /**
   * Fixed items billed on THIS invoice — their cycles_billed is incremented in the
   * finalize tx (never for pending drafts; the close re-runs this and increments).
   */
  billedItemIds: string[];
  /** Pending ad-hoc charges folded onto this invoice, marked billed on commit. */
  pendingChargeIds: string[];
  /** Sum of `lines` before discount/tax. */
  subtotal: bigint;
  /** See `BillSubscriptionPeriodInput.metadata`. */
  metadata?: Record<string, unknown>;
  /** Meter lines: the billing pointers and level snapshots the finalize transaction writes. */
  meterCommit?: { pointers: MeterItemRating["pointer"][]; levels: LevelSnapshot[] };
  /** Threshold invoicing: what this invoice is for, and its idempotency token (0474). */
  purpose?: "usage_interim";
  originToken?: string;
  /** Runs inside the invoice transaction, after the lines (threshold invoicing). */
  inTx?: (tx: Tx, invoice: Invoice) => Promise<void>;
  /** The counted fees the commitment line was planned on, rechecked at commit. */
  commitmentCheck?: {
    subscriptionId: string;
    term: { start: Date; end: Date };
    countedMinor: bigint;
  };
}

/** Pending-draft plan (E2): recurring lines only, no money math. */
export interface PeriodInvoiceDraftPlan extends PeriodInvoicePlanBase {
  mode: "pending_draft";
  pendingUsageWindow?: { start: Date; end: Date };
}

/** Full plan: everything needed to finalize the invoice without recomputing money. */
export interface PeriodInvoiceFinalizePlan extends PeriodInvoicePlanBase {
  mode: "finalize";
  discStack: PeriodDiscountStack;
  /** Only the coupons that actually discounted — one invoice line each. */
  discountRows: PeriodDiscountStack["rows"];
  discountMinor: bigint;
  discountedSubtotal: bigint;
  /** Customer-level tax exemption. */
  exempt: boolean;
  /**
   * The tax determination for this invoice's lines — the component vector plus the
   * place-of-supply snapshot. Replaces the old single `rateInfo` scalar, which could
   * not express India's CGST+SGST split.
   */
  taxResolution: TaxResolution;
  /** The bill-to address and buyer tax id at issue, from the row the tax was decided on. */
  billingSnapshot: ReturnType<typeof customerBillingAddress> | null;
  customerTaxId: string;
  /** The rest of what the document prints, frozen at issue (0336). */
  seller: SellerAtIssue;
  notes: string;
  netTermDays: number | null;
  withholdingRateBps: number;
  /** Business round-off mode (E6), e.g. 'nearest_unit'. */
  invoiceRounding: string | null;
  /**
   * The invoice's OWN date — what `due_date` defaults to, and what decides
   * `payment_due` vs `posted`.
   *
   * Carried explicitly rather than re-read off `periodStart` because `periodStart` is
   * typed `Date` and is NULL at runtime for a trialing subscription's first bill
   * (`sub.currentPeriodStart!`). It is also the
   * only instant `resolvePeriodInvoiceMoney`, which is pure and must stay so, can
   * compare the due date against.
   */
  invoiceDate: Date;
  dueDate: Date | null;
  /**
   * Credits Flexibility ceilings for this invoice (0219) — resolved ONCE at plan time
   * from the business config + this subscription's own maxima, and carried on the plan so
   * that `commitSubscriptionPeriodInvoice`'s second, under-the-lock call to
   * `resolvePeriodInvoiceMoney` uses the identical ceilings. Resolving it twice would let
   * a settings save between plan and commit change the amount charged from the amount
   * quoted, which is exactly the divergence `InvoiceMoneyMovedError` exists to catch.
   *
   * A renewal / proration invoice is a RECURRING invoice, so this is
   * always the `recurring` half of the config.
   */
  creditLimits: CreditApplicationLimits;
  /**
   * FX SNAPSHOT (0228) — the rate to stamp on this document, or null when none is
   * recorded. Resolved ONCE here, for the same reason `creditLimits` is: a settings
   * save between plan and commit would otherwise stamp a rate other than the one the
   * numbers were quoted at. Finalize-only on purpose — a `pending` draft is not yet a
   * claim, and the close re-runs this plan, so a draft that accreted usage for a week
   * is stamped at CLOSE, not with a week-old rate.
   */
  exchangeRate: IssueExchangeRate | null;
  money: PeriodInvoiceMoney;
}

export type PeriodInvoicePlan = PeriodInvoiceDraftPlan | PeriodInvoiceFinalizePlan;

/**
 * Derive the whole money outcome (tax, rounding, withholding, credit application,
 * amount due, invoice status) from a plan's read-derived inputs and a snapshot of
 * the customer's credit buckets. PURE — no DB, no events, deterministic.
 *
 * Called once by `planSubscriptionPeriodInvoice` (so callers can see the numbers
 * before anything is written) and once again by `commitSubscriptionPeriodInvoice`
 * with the buckets re-read under the per-customer lock. With no concurrent draw
 * both calls return identical numbers; the second call is what preserves the
 * over-draw guard (see `commitSubscriptionPeriodInvoice`).
 */
export function resolvePeriodInvoiceMoney(
  plan: Omit<PeriodInvoiceFinalizePlan, "money">,
  balances: CustomerBalances,
  /** The customer's active credit grants in the invoice currency (design G3 §3.4). */
  grants: readonly PlannerGrant[] = [],
): PeriodInvoiceMoney {
  const { lines, subtotal, discStack, discountedSubtotal, taxResolution, exempt } = plan;
  // Credit grants, phase 1 (pre-tax): promotional and taxed-at-purchase grants pay usage
  // lines at their value after coupons, and lower each line's tax base.
  const grantLines: PlannerLine[] = lines.map((l, i) => ({
    key: String(i),
    kind: l.kind,
    pricePublicId: l.pricePublicId ?? null,
    adjustment: l.adjustment ?? null,
    valueMinor:
      l.amountMinor -
      (discStack.lineDiscountByIndex[i] ?? 0n) -
      (discStack.invoiceLevelByIndex[i] ?? 0n),
    window: { start: l.periodStart, end: l.periodEnd },
    ...(l.grantSlices ? { slices: l.grantSlices } : {}),
  }));
  const preTax =
    grants.length > 0
      ? planGrantApplication({ phase: "pre_tax", grants, lines: grantLines })
      : { draws: [], byLine: new Map<string, bigint>(), totalMinor: 0n, grants: [...grants] };
  const grantPreTaxApplied = preTax.totalMinor;
  // Balance split (D1): promotional credit is applied PRE-tax — it reduces the
  // taxable base (capped at the discounted subtotal), so tax is computed on
  // (discountedSubtotal − promoApplied). Refundable + excess are post-tax.
  // Given a promo amount, derive tax / total / withholding / collectible. Pure —
  // reused by the clamp loop below.
  const computeTotals = (promo: bigint) => {
    const invoiceTax = computeInvoiceTax({
      // CAT-2: line-level coupon discount is attributed per-line (line-accurate);
      // only the invoice-level coupon portion + promo are spread proportionally.
      lines: lines.map((l, i) => ({
        id: String(i),
        amountMinor: l.amountMinor,
        taxable: l.taxable,
        // The customer's override, then a tax-inclusive region, then the price itself.
        inclusive: lineIsInclusive(taxResolution, l.inclusive),
        lineDiscountMinor: discStack.lineDiscountByIndex[i] ?? 0n,
        preTaxCreditMinor: preTax.byLine.get(String(i)) ?? 0n,
        resolution: taxResolution,
      })),
      discountMinor: discStack.invoiceLevelMinor + promo,
      promoMinor: promo,
      subtotalMinor: subtotal,
      customerExempt: exempt,
    });
    // Only EXCLUSIVE (additive) tax increases the total; inclusive tax is already inside.
    const preRoundTotal = discountedSubtotal + invoiceTax.additiveTaxMinor;
    // Round-off (E6): nudge the post-tax total to the nearest currency unit; the
    // delta is booked to a `rounding` line so the ledger stays balanced.
    const roundingDelta = roundingDeltaFor(
      plan.invoiceRounding,
      preRoundTotal,
      minorScale(plan.subscription.currency),
    );
    const total = preRoundTotal + roundingDelta;
    // Withholding tax (TDS): the payer withholds a % of the NET base (revenue excl.
    // all tax) and remits it to the authority — it reduces the collectible amount
    // and is booked as a withholding_receivable asset. Invoice face total stays gross.
    const withholdingBase = discountedSubtotal - invoiceTax.inclusiveTaxMinor;
    const whRateBps = plan.withholdingRateBps;
    const withholdingMinor =
      whRateBps > 0 && withholdingBase > 0n ? (withholdingBase * BigInt(whRateBps)) / 10000n : 0n;
    const collectible = total - withholdingMinor;
    return { invoiceTax, total, withholdingMinor, collectible, roundingDelta };
  };

  // The promotional bucket comes after the pre-tax grants (§3.3), on what they left.
  const promoBase = discountedSubtotal - grantPreTaxApplied;
  const promoCap = promoBase > 0n ? promoBase : 0n;
  let promoApplied = balances.promotional < promoCap ? balances.promotional : promoCap;
  let totals = computeTotals(promoApplied);
  // Promo may never exceed the COLLECTIBLE amount either (withholding can make
  // collectible < discountedSubtotal; unclamped, amountDue would go negative).
  // Shrinking promo only grows tax → grows collectible, so this converges in
  // one pass; the loop is defensive.
  const promoRoom = (c: bigint) => (c - grantPreTaxApplied > 0n ? c - grantPreTaxApplied : 0n);
  for (let i = 0; i < 4 && promoApplied > promoRoom(totals.collectible); i++) {
    promoApplied = promoRoom(totals.collectible);
    totals = computeTotals(promoApplied);
  }
  const { invoiceTax, total, withholdingMinor, collectible, roundingDelta } = totals;
  // Credit grants, phase 2 (post-tax): taxed-at-use money grants pay what is left of their
  // lines plus the tax charged on them, as money. No gross-up.
  let postTax: ReturnType<typeof planGrantApplication> | null = null;
  if (preTax.grants.some((g) => grantPhase(g) === "post_tax" && g.remainingFace > 0n)) {
    const additiveTax = new Map<string, bigint>();
    for (const r of invoiceTax.rows)
      if (!r.inclusive)
        additiveTax.set(r.lineId, (additiveTax.get(r.lineId) ?? 0n) + r.amountMinor);
    const promoDenominator = discountedSubtotal - grantPreTaxApplied;
    const postLines = grantLines.map((l) => {
      const left = l.valueMinor - (preTax.byLine.get(l.key) ?? 0n);
      const promoShare =
        promoApplied > 0n && promoDenominator > 0n && left > 0n
          ? (promoApplied * left) / promoDenominator
          : 0n;
      return { ...l, valueMinor: left - promoShare + (additiveTax.get(l.key) ?? 0n) };
    });
    postTax = planGrantApplication({
      phase: "post_tax",
      grants: preTax.grants,
      lines: postLines,
      capMinor: collectible - promoApplied - grantPreTaxApplied,
    });
  }
  const grantPostTaxApplied = postTax?.totalMinor ?? 0n;
  // Application order: pre-tax grants → promotional (pre-tax, above) → tax → post-tax
  // grants → refundable → excess, then charge the remainder.
  const postTaxRemaining = collectible - promoApplied - grantPreTaxApplied - grantPostTaxApplied;
  const { refundable: refundableApplied, excess: excessApplied } = planCreditApplication({
    balances,
    discountedSubtotal,
    postTaxRemaining,
    limits: plan.creditLimits,
  });
  const creditApplied =
    promoApplied + grantPreTaxApplied + grantPostTaxApplied + refundableApplied + excessApplied;
  const amountDue = collectible - creditApplied;
  const fullyPaid = total === 0n || amountDue === 0n;

  // `posted` means "finalized but not yet DUE" — due.ts flips it to `payment_due`
  // when the due date arrives, and it only ever scans invoices that HAVE one. So an
  // invoice with no due date was due immediately yet sat at `posted` forever, with
  // nothing able to move it. Such an invoice is `payment_due` from the moment it is
  // raised. Net-D invoices, which genuinely are not due yet, still start `posted`; a
  // backdated one whose terms have already lapsed remains due.ts's job, as before.
  //
  // ⚠️ The test is now "is the due date at or before the invoice date", not "is there
  // a due date at all". `due_date` defaults to the INVOICE DATE with no net terms
  // (2026-08-31 — `due_date` is the invoice date exactly for a 0-net-term invoice,
  // never null), so `!plan.dueDate` would have made every ordinary invoice
  // `posted` and stranded it there. Same statement as before, expressed against a
  // date instead of a null.
  const dueNow = !plan.dueDate || plan.dueDate.getTime() <= plan.invoiceDate.getTime();
  return {
    balances,
    invoiceTax,
    total,
    withholdingMinor,
    collectible,
    roundingDelta,
    promoApplied,
    grantPreTaxApplied,
    grantPostTaxApplied,
    grantDraws: [...preTax.draws, ...(postTax?.draws ?? [])],
    refundableApplied,
    excessApplied,
    creditApplied,
    amountDue,
    fullyPaid,
    status: fullyPaid ? "paid" : dueNow ? "payment_due" : "posted",
  };
}

/**
 * NET TERMS, one rule for every invoice.
 *
 * Precedence: the SUBSCRIPTION's terms override the CUSTOMER's, which override the
 * business default. `0` and null both mean "no terms at THIS level" and fall through —
 * which is why this is `||` and not `??`: a stored `0` is how "same as the level above"
 * is expressed, not a demand to be due immediately.
 *
 * Pure, and separate from the loader below, because the two callers arrive with different
 * things in hand: the subscription-period path has already read all three rows for its own
 * reasons, while `createInvoiceFromLines` has only ids. Sharing the RULE without forcing
 * either to re-read is the whole point — before 2026-09-01 the second path had no rule at
 * all, and a Net-30 customer was dunned immediately on any proration invoice.
 */
export function netTermDaysFrom(rows: {
  subscription?: { netTermDays?: number | null } | null;
  customer?: { netTermDays?: number | null } | null;
  business?: { defaultDueDays?: number | null } | null;
}): number | null {
  return (
    rows.subscription?.netTermDays ||
    rows.customer?.netTermDays ||
    rows.business?.defaultDueDays ||
    null
  );
}

/** {@link netTermDaysFrom} for a caller holding only ids. */
async function resolveNetTermDays(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string | null;
  customerId: string;
}): Promise<number | null> {
  return withTenant(input.organizationId, async (tx) => {
    const [biz] = await tx
      .select({ defaultDueDays: businesses.defaultDueDays })
      .from(businesses)
      .where(eq(businesses.id, input.businessId))
      .limit(1);
    const [cus] = await tx
      .select({ netTermDays: customers.netTermDays })
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .limit(1);
    const [sub] = input.subscriptionId
      ? await tx
          .select({ netTermDays: subscriptions.netTermDays })
          .from(subscriptions)
          .where(eq(subscriptions.id, input.subscriptionId))
          .limit(1)
      : [undefined];
    return netTermDaysFrom({ subscription: sub, customer: cus, business: biz });
  });
}

/**
 * READ-ONLY half of `billSubscriptionPeriod`: work out everything a period
 * invoice would be — lines, coupon stack, tax, credit application, totals, due
 * date, resulting status — WITHOUT writing anything or emitting any event.
 *
 * Lets a caller inspect (or veto) the money before it is persisted; hand the
 * returned plan to `commitSubscriptionPeriodInvoice` to actually write it.
 */
/**
 * An interim invoice's meter lines: one per value combination, the window to the cut less what
 * earlier interim invoices billed. `period` is the whole term, so late usage of the term later
 * counts interim and final lines together.
 */
function interimMeterLines(
  snap: PriceSnapshot,
  rated: MeterItemRating,
  prior: ItemBilled | undefined,
  lineBase: Pick<
    ComputedLine,
    "priceId" | "taxable" | "inclusive" | "productKind" | "productPublicId" | "pricePublicId"
  >,
  label: string,
  itemId: string,
  term: { start: Date; end: Date },
): ComputedLine[] {
  const out: ComputedLine[] = [];
  const groups = new Map<string, MeterLineRating[]>();
  for (const l of rated.lines)
    if (!l.late) groups.set(groupKey(l.group), [...(groups.get(groupKey(l.group)) ?? []), l]);
  for (const [k, ls] of groups) {
    const cumulative = ls.reduce((a, l) => a + l.amountMinor, 0n);
    const quantity = ls.reduce((a, l) => a + l.quantity, 0n);
    const before = prior?.groups.get(k);
    const amount = cumulative - (before?.amountMinor ?? 0n);
    const qty = quantity - (before?.quantity ?? 0n);
    if (amount <= 0n) continue;
    const first = ls[0]!;
    const window = { start: first.period.start, end: first.period.end };
    const cur = snap.currency;
    const units = qty > 0n ? qty : 0n;
    out.push({
      ...lineBase,
      description: `${meterLineDescription(label, rated, first)} · Usage to date ${formatMoney(cumulative, cur)} · billed before ${formatMoney(before?.amountMinor ?? 0n, cur)} · this invoice ${formatMoney(amount, cur)}`,
      quantity: 1,
      unitAmountMinor: amount,
      amountMinor: amount,
      // The units this invoice bills, and their average rate (tiers price them unevenly),
      // to a hundredth of a minor unit: it is shown, never multiplied.
      quantityDecimal: formatFixed12(units),
      unitAmountDecimal: formatFixed12(
        units > 0n
          ? divHalfUp(divFixed12(fixed12FromInt(amount), units), 10n ** 10n) * 10n ** 10n
          : 0n,
      ),
      kind: "usage",
      periodStart: window.start,
      periodEnd: window.end,
      rating: {
        ...meterLineRatingJson(snap, rated, first, false),
        quantity: formatFixed12(qty > 0n ? qty : 0n),
        window: { start: window.start.toISOString(), end: window.end.toISOString() },
        period: { start: term.start.toISOString(), end: term.end.toISOString() },
        interim: true,
        item_id: itemId,
        cumulative_minor: Number(cumulative),
        billed_before_minor: Number(before?.amountMinor ?? 0n),
      },
    });
  }
  return out;
}

export async function planSubscriptionPeriodInvoice(
  input: BillSubscriptionPeriodInput,
): Promise<PeriodInvoicePlan> {
  const { organizationId, businessId, subscription } = input;

  // Usage aggregated for this window → one usage.recorded event per metered item
  // (per aggregation window, NOT per raw record — locked decision).
  const usageEvents: Array<{ slug: string; qty: number }> = [];
  // Fixed items billed on THIS invoice — their cycles_billed is incremented in the
  // finalize tx (never for pending drafts; the close re-runs this and increments).
  const billedItemIds: string[] = [];

  // Meter prices: one cutoff per meter, committed in its own short transaction BEFORE rating,
  // so rollups folded from here on carry the next generation (a preview only peeks).
  const meterCutoffs = new Map<string, MeterCutoff>();
  const meterRatings: MeterItemRating[] = [];
  if (input.usagePeriod) {
    const meterIds = input.items
      ? [...new Set(input.items.flatMap((r) => (r.price.meterId ? [r.price.meterId] : [])))]
      : await withTenant(organizationId, async (tx) =>
          (
            await tx
              .selectDistinct({ meterId: prices.meterId })
              .from(subscriptionItems)
              .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
              .where(
                and(
                  eq(subscriptionItems.subscriptionId, subscription.id),
                  sql`${prices.meterId} is not null`,
                ),
              )
          ).map((r) => r.meterId!),
        );
    for (const meterId of meterIds) {
      const key = { customerId: subscription.customerId, meterId };
      meterCutoffs.set(
        meterId,
        await withTenant(organizationId, (tx) =>
          input.interim
            ? // An interim invoice cuts at now, with no fold grace: it re-rates the window and
              // bills less what earlier ones billed, so an event that arrives later with an
              // earlier time is billed once, by the next interim or the final invoice.
              peekMeterCutoff(tx, { ...key, businessId }).then((p) => ({
                ...p,
                at: new Date(Date.now() + FOLD_GRACE_MS + 1_000),
              }))
            : input.preview
              ? peekMeterCutoff(tx, { ...key, businessId })
              : takeMeterCutoff(tx, {
                  ...key,
                  organizationId,
                  businessId,
                  subscriptionId: subscription.id,
                }),
        ),
      );
    }
  }

  // Threshold invoicing (design G5 §3.7): a final invoice bills what interim invoices did not.
  // `billedVirtual` prices the period's coupons over the whole period; a remainder or a
  // discount larger than this invoice is credited on the interim invoices.
  let interimExcessMinor = 0n;
  const billedVirtual: Array<{
    amountMinor: bigint;
    productKind?: string | null;
    productPublicId?: string | null;
    pricePublicId?: string | null;
  }> = [];
  const addBilledVirtual = (
    amountMinor: bigint,
    l: {
      productKind?: string | null;
      productPublicId?: string | null;
      pricePublicId?: string | null;
    },
  ) => {
    if (amountMinor > 0n)
      billedVirtual.push({
        amountMinor,
        productKind: l.productKind,
        productPublicId: l.productPublicId,
        pricePublicId: l.pricePublicId,
      });
  };

  // 1) Load items + their prices, compute line amounts. Fixed charges bill in
  //    advance; usage-model items are rated in arrears over usagePeriod (if given).
  const lines = await withTenant(organizationId, async (tx) => {
    const rows: PeriodItemRow[] =
      input.items ??
      (await tx
        .select({
          item: subscriptionItems,
          price: prices,
          productName: products.name,
          productKind: products.kind,
          productPublicId: products.publicId,
        })
        .from(subscriptionItems)
        .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
        .innerJoin(products, eq(prices.productId, products.id))
        .where(eq(subscriptionItems.subscriptionId, subscription.id))
        // PLAN FIRST, then the order items were added. Without this the query had NO
        // `ORDER BY` at all, so Postgres returned the items in whatever order it liked and
        // the loop below stamped `seq` from it — two identical subscriptions billed
        // differently-ordered invoices, and the same journey did too, run to run.
        //
        // 3e30952 ("an invoice's lines had no order, so the document didn't hold still")
        // added `seq` and made a written document stable, but the SOURCE feeding seq was
        // still unordered, so the document held still only after the fact. Three identical
        // offline runs, no code change between them: [plan, addon] → 0 fail, [addon, plan]
        // → 4 fail, [plan, addon] → 0 fail. That is a customer-visible invoice reordering
        // itself, and it also made several suites flaky.
        //
        // Plan-first is the order a document reads in, so determinism and presentation
        // want the same thing here.
        //
        // ⚠ THIS QUERY NO LONGER DECIDES THE DOCUMENT'S LINE ORDER — `orderDocumentLines`
        // does, below, once the amounts exist. The `createdAt`/`id` tiebreak here was the
        // 2026-08-29 flap: two add-ons attached in the SAME transaction share a `createdAt`,
        // so a random uuid decided, and a replay went 0/8/0 fail with no code change. It is
        // kept only to make the ITERATION below deterministic (usage aggregation, the
        // `billedItemIds` it accumulates), which is worth having and costs nothing.
        .orderBy(
          sql`case when ${products.kind} = 'plan' then 0 else 1 end`,
          subscriptionItems.createdAt,
          subscriptionItems.id,
        ));

    const computed: ComputedLine[] = [];
    // Threshold invoicing: what interim invoices already billed in this window, per item.
    const billed: Map<string, ItemBilled> = input.usagePeriod
      ? await billedOnInterims(tx, subscription.id, input.usagePeriod)
      : new Map();
    for (const { item, price, productName, productKind, productPublicId } of rows) {
      // Rate from the item's frozen price snapshot (immutability) — falling back
      // to the live price row for any legacy item without one.
      const snap = (item.priceSnapshot as PriceSnapshot | null) ?? snapshotPrice(price);
      // Item-level cycle cap (G review blocker): an item whose billing_cycles is
      // exhausted stops billing — cycles_billed is incremented in the finalize tx
      // for every fixed item actually billed. Without this, a mandatory addon
      // capped at N cycles billed forever.
      //
      // 🔴 A `one_time` price carries an IMPLICIT cap of ONE cycle (bug, 2026-08-03).
      // This loop rates every non-metered item from its snapshot EVERY period, and
      // the cap below was the only thing that could stop it — but neither
      // `addSubscriptionItem` nor `createSubscription` sets `billing_cycles`, so a
      // one-off fee attached as a subscription item (a ₹5,000 onboarding setup) was
      // re-billed by every single renewal, forever. A one-time price is by
      // definition billed once; "how many cycles does it bill for" has exactly one
      // honest answer, so the cap is derived from the price TYPE rather than left to
      // a column nobody sets. Deriving it here (instead of writing
      // `billing_cycles = 1` at attach time) is what makes it retroactive: an item
      // already attached and already billed stops re-billing without a data
      // migration, and there is one source of truth rather than a column that can
      // disagree with the price it snapshots.
      //
      // The item STAYS ATTACHED and visible on the subscription — it is part of the
      // composition, it is just not re-rated. `cyclesBilled` still counts the one
      // invoice that billed it, so this cannot skip a fee that was never charged:
      //   · attached at create → first invoice bills it (0 < 1), renewals skip it;
      //   · attached during a trial → the trial-end conversion invoice bills it in
      //     full (nothing has billed yet, so cycles_billed is still 0), and every
      //     renewal after that skips it — which is exactly what `addSubscriptionItem`
      //     promises when it defers a one-time add in trial;
      //   · attached mid-term → `addSubscriptionItem` charges it in full OUTSIDE this
      //     planner and records the cycle via `createInvoiceFromLines(markItemsBilled)`,
      //     so the next renewal skips it.
      // An EXPLICIT `billing_cycles` still wins (the caller asked for something
      // specific); the implicit 1 only fills the gap it left. Reads the shared
      // helper (`catalog/pricing.ts`) rather than re-deriving the rule here — the
      // reset branch of `changeSubscription` (proration.ts) and the in-trial branch
      // of `estimateChange` (estimate.ts) now call the same one, so this stops being
      // the third independent copy (2026-08-03).
      if (isCycleCapExhausted(item.billingCycles, snap.type, item.cyclesBilled)) continue;
      // An interim invoice bills eligible metered items only (design G5 §3.7).
      if (input.interim && !snap.meter && !(isMeteredPrice(snap) && thresholdEligible(snap)))
        continue;
      const ratable = ratableFromSnapshot(snap, item.freeQuantity);
      const lineBase = {
        priceId: price.id,
        taxable: price.isTaxable,
        inclusive: price.taxBehavior === "inclusive",
        productKind,
        productPublicId,
        pricePublicId: price.publicId,
      };
      /**
       * Minimum spend: lift the line to the snapshot's minimum with a separate true-up line.
       * Prorated when the billed window is shorter than one full period of the price's
       * cycle. One-time prices have no period, so no minimum.
       */
      const addMinimumTrueUp = (
        amount: bigint,
        kind: ComputedLine["kind"],
        window: { start: Date; end: Date },
      ) => {
        if (input.interim) return;
        if (snap.minimumAmountMinor == null || snap.type === "one_time" || !snap.interval) return;
        const fullEnd = addInterval(window.start, snap.interval as Interval, snap.intervalCount);
        const trueUp = minimumTrueUp(
          BigInt(snap.minimumAmountMinor),
          amount,
          window.end.getTime() - window.start.getTime(),
          fullEnd.getTime() - window.start.getTime(),
        );
        if (trueUp <= 0n) return;
        computed.push({
          ...lineBase,
          description: `Minimum spend adjustment: ${priceLabel(price, { name: productName })}`,
          quantity: 1,
          unitAmountMinor: trueUp,
          amountMinor: trueUp,
          kind,
          periodStart: window.start,
          periodEnd: window.end,
          adjustment: "minimum_spend",
        });
      };
      // A meter price: one line per value combination (and rate segment), plus late usage of
      // earlier windows ("Usage from <period>"). The minimum lifts this window's lines only.
      if (snap.meter) {
        if (!input.usagePeriod) continue;
        const cutoff = meterCutoffs.get(snap.meter.id);
        if (!cutoff) continue;
        const rated = await rateMeterItem(tx, {
          item: { ...item, priceSnapshot: snap },
          subscription,
          window: input.usagePeriod,
          cutoff,
          // An interim invoice keeps the period-end pointer where it is.
          ...(input.interim ? { usageThrough: cutoff.previous.usageThrough ?? undefined } : {}),
        });
        const label = priceLabel(price, { name: productName });
        if (input.interim) {
          if (
            !thresholdEligible({
              ...snap,
              meterAggregation: rated.meter.aggregation,
              meterRecurring: rated.meter.recurring,
            })
          )
            continue;
          computed.push(
            ...interimMeterLines(snap, rated, billed.get(item.id), lineBase, label, item.id, {
              start: input.usagePeriod.start,
              end: subscription.currentPeriodEnd ?? input.usagePeriod.end,
            }),
          );
          continue;
        }
        meterRatings.push(rated);
        const prior = billed.get(item.id);
        const netted = prior ? netMeterLines(rated, prior) : null;
        let windowAmount = 0n;
        let windowQuantity = 0n;
        for (const [i, line] of rated.lines.entries()) {
          const toDate = netted?.lines.get(line);
          const cur = subscription.currency;
          computed.push({
            ...lineBase,
            description: toDate
              ? `${meterLineDescription(label, rated, line)} · Usage this period ${formatMoney(toDate.cumulative, cur)} · billed on interim invoices ${formatMoney(toDate.billedBefore, cur)} · this invoice ${formatMoney(line.amountMinor, cur)}`
              : meterLineDescription(label, rated, line),
            quantity: 1,
            unitAmountMinor: line.amountMinor,
            amountMinor: line.amountMinor,
            // A late line's quantity and rate are its own delta (`lateLines`).
            quantityDecimal: formatFixed12(line.quantity),
            unitAmountDecimal: formatFixed12(line.unitAmount),
            kind: "usage",
            periodStart: line.window.start,
            periodEnd: line.window.end,
            // The window's first line keeps its pricing, for late usage re-rated later.
            rating: {
              ...meterLineRatingJson(snap, rated, line, i === 0),
              ...(netted?.lines.has(line)
                ? {
                    item_id: item.id,
                    cumulative_minor: Number(netted.lines.get(line)!.cumulative),
                    billed_before_minor: Number(netted.lines.get(line)!.billedBefore),
                  }
                : {}),
            },
            ...(line.cost ? { costMinor: line.cost.minor, costBasis: line.cost.basis } : {}),
          });
          if (!line.late) {
            windowAmount += line.amountMinor + (netted?.taken.get(line) ?? 0n);
            windowQuantity += line.quantity + (netted?.takenQty.get(line) ?? 0n);
          }
        }
        if (prior && netted) {
          interimExcessMinor += netted.excessMinor;
          addBilledVirtual(prior.amountMinor, lineBase);
        }
        if (windowQuantity > 0n)
          usageEvents.push({ slug: snap.publicId, qty: fixedToNumber(windowQuantity) });
        addMinimumTrueUp(windowAmount, "usage", input.usagePeriod);
        continue;
      }
      // Metered: usage, or a percentage model over a usage stream ("2.9% of summed
      // transaction volume"). Without an aggregation a percentage price is a fixed charge
      // on item.quantity (a % of a fixed base).
      if (isMeteredPrice(snap)) {
        if (!input.usagePeriod) continue; // no window to bill (e.g. first invoice)
        const rated = await rateMeteredItem(tx, {
          item: { ...item, priceSnapshot: snap },
          window: input.usagePeriod,
        });
        const qty = rated.quantity;
        // No usage still owes the minimum, so a zero window is not skipped outright.
        const amount = rated.amountMinor;
        // Threshold invoicing: bill the whole window less what interim invoices billed.
        const prior = billed.get(item.id);
        const before = prior?.amountMinor ?? 0n;
        const net = amount - before;
        const netQty = qty - (prior?.quantity ?? 0n);
        if (net < 0n && !input.interim) interimExcessMinor -= net;
        if (prior && !input.interim) addBilledVirtual(before, lineBase);
        if (prior || input.interim ? net > 0n : qty > 0n) {
          if (qty > MAX_LINE_QUANTITY) throw new UsageQuantityTooLargeError(snap.publicId, qty);
          if (!input.interim) usageEvents.push({ slug: snap.publicId, qty: Number(qty) });
          const lineQty = prior || input.interim ? (netQty > 0n ? netQty : 0n) : qty;
          const label = PERCENT_OF_BASE_MODELS.has(snap.model)
            ? `${lineQty} base`
            : `${lineQty} units`;
          const cur = subscription.currency;
          computed.push({
            ...lineBase,
            description:
              prior || input.interim
                ? `usage (${snap.publicId}) ${label} · ${input.interim ? "Usage to date" : "Usage this period"} ${formatMoney(amount, cur)} · ${input.interim ? "billed before" : "billed on interim invoices"} ${formatMoney(before, cur)} · this invoice ${formatMoney(net, cur)}`
                : `usage (${snap.publicId}) ${label}`,
            quantity: Number(lineQty),
            unitAmountMinor: rated.unitAmountMinor,
            amountMinor: prior || input.interim ? net : amount,
            kind: "usage",
            periodStart: input.usagePeriod.start,
            periodEnd: input.usagePeriod.end,
            rating: {
              ...lineRating(snap, rated, ratable.freeQuantity ?? 0),
              ...(prior || input.interim
                ? {
                    item_id: item.id,
                    cumulative_minor: Number(amount),
                    billed_before_minor: Number(before),
                    ...(input.interim ? { interim: true } : {}),
                  }
                : {}),
            },
          });
        }
        addMinimumTrueUp(amount, "usage", input.usagePeriod);
        continue;
      }
      if (input.skipFixed) continue;
      const amount = computeLineAmount(ratable, item.quantity);
      /**
       * The CONTRACTED RATE, stated rather than derived.
       *
       * On a FULL-period line the two coincide — `amount` is rate × quantity, so dividing
       * gets the rate back — and this is the reference case the column is documented
       * against (`db/schema/invoices.ts`). Asking `computeLineAmount` for one unit says
       * what we mean and keeps the tiered/percentage models honest: for those, "one unit"
       * is what the pricing model says it is, not an average of the whole line.
       */
      const unit = unitRate(ratable);
      billedItemIds.push(item.id);
      computed.push({
        // Human-readable line label: the price's customer-facing external_name (e.g.
        // "PRO plan"). Fall back to the internal price name, then the slug. Quantity
        // lives in the structured `quantity` field, so it is not repeated inline.
        description: priceLabel(price, { name: productName }),
        priceId: price.id,
        quantity: item.quantity,
        unitAmountMinor: unit,
        amountMinor: amount,
        kind: snap.type === "one_time" ? "one_time" : "recurring",
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        taxable: price.isTaxable,
        inclusive: price.taxBehavior === "inclusive",
        productKind,
        productPublicId,
        pricePublicId: price.publicId,
      });
      addMinimumTrueUp(amount, "recurring", { start: input.periodStart, end: input.periodEnd });
    }
    // The document's order, decided on the AMOUNTS this loop just computed — see
    // `orderDocumentLines`. Ad-hoc unbilled charges are folded in after this and stay
    // appended, deliberately.
    return orderDocumentLines(computed, {
      isPlan: (l) => l.productKind === "plan",
      tiebreak: (l) => l.productPublicId ?? "",
    });
  });

  // Fold in any pending ad-hoc charges queued against this subscription (they ride
  // on this renewal invoice, then get marked billed inside the invoice txn below).
  const pendingChargeIds: string[] = [];
  if (!input.preview?.excludePendingCharges && !input.interim) {
    const charges = await withTenant(organizationId, (tx) =>
      tx
        .select({
          charge: unbilledCharges,
          price: prices,
          productKind: products.kind,
          productPublicId: products.publicId,
        })
        .from(unbilledCharges)
        .leftJoin(prices, eq(unbilledCharges.priceId, prices.id))
        .leftJoin(products, eq(prices.productId, products.id))
        .where(
          and(
            eq(unbilledCharges.subscriptionId, subscription.id),
            eq(unbilledCharges.status, "pending"),
          ),
        ),
    );
    for (const { charge: ch, price, productKind, productPublicId } of charges) {
      // Usage settled early (item removal, term reset): a usage line with its price's tax.
      if (ch.entityType === USAGE_SETTLEMENT && price) {
        // A meter settlement carries its line rating (window, combination, pricing).
        const settled = ch.rating ? takeSettlementCost(ch.rating as MeterLineRatingJson) : null;
        const meterRating = settled?.rating ?? null;
        lines.push({
          description: ch.description,
          priceId: ch.priceId,
          quantity: ch.quantity,
          unitAmountMinor: ch.quantity > 0 ? ch.amountMinor / BigInt(ch.quantity) : ch.amountMinor,
          amountMinor: ch.amountMinor,
          ...(meterRating
            ? {
                rating: meterRating,
                quantityDecimal: String(meterRating.quantity),
                unitAmountDecimal: String(meterRating.unit_amount),
                costMinor: settled!.costMinor,
                costBasis: settled!.costBasis,
              }
            : {}),
          kind: "usage",
          periodStart: ch.periodStart ?? input.periodStart,
          periodEnd: ch.periodEnd ?? input.periodEnd,
          taxable: price.isTaxable,
          inclusive: price.taxBehavior === "inclusive",
          productKind,
          productPublicId,
          pricePublicId: price.publicId,
        });
        pendingChargeIds.push(ch.id);
        continue;
      }
      // An early-end commitment true-up: a plan line, so plan coupons and the plan's tax apply.
      if (ch.entityType === COMMITMENT_CHARGE && price) {
        lines.push({
          description: ch.description,
          priceId: ch.priceId,
          quantity: 1,
          unitAmountMinor: ch.amountMinor,
          amountMinor: ch.amountMinor,
          kind: "recurring",
          periodStart: ch.periodStart ?? input.periodStart,
          periodEnd: ch.periodEnd ?? input.periodEnd,
          taxable: price.isTaxable,
          inclusive: price.taxBehavior === "inclusive",
          productKind,
          productPublicId,
          pricePublicId: price.publicId,
          adjustment: "commitment",
        });
        pendingChargeIds.push(ch.id);
        continue;
      }
      lines.push({
        // Carry the charge's OWN price + service period onto the line. Both used to
        // be dropped here (priceId hardcoded null, period forced to the renewal's),
        // so a catalog-picked charge lost its origin and a charge covering a
        // different span was mis-reported for revenue recognition.
        description: ch.description,
        priceId: ch.priceId,
        quantity: ch.quantity,
        unitAmountMinor: ch.quantity > 0 ? ch.amountMinor / BigInt(ch.quantity) : ch.amountMinor,
        amountMinor: ch.amountMinor,
        kind: "one_time",
        periodStart: ch.periodStart ?? input.periodStart,
        periodEnd: ch.periodEnd ?? input.periodEnd,
        taxable: true,
        inclusive: false, // ad-hoc charges are taxable + exclusive
        productKind: "charge",
        productPublicId: null, // ad-hoc → 'charge' kind, no product
        pricePublicId: null,
      });
      pendingChargeIds.push(ch.id);
    }
  }

  // Minimum commitment: lift the closing term's counted fees to the prorated commitment.
  let commitmentCheck: PeriodInvoicePlanBase["commitmentCheck"];
  const commitment = input.commitment;
  if (commitment && commitment.segments.length > 0 && !input.createAsPending && !input.interim) {
    const { term, endedAt } = commitment;
    const trueUp = await withTenant(organizationId, async (tx) => {
      const counted = await countedCommitmentFees(tx, subscription.id, term);
      commitmentCheck = { subscriptionId: subscription.id, term, countedMinor: counted };
      const planned = lines
        .filter((l) => countsTowardCommitment(l, term))
        .reduce((s, l) => s + l.amountMinor, 0n);
      const owed = proratedCommitment(
        commitment.segments,
        term.start,
        endedAt,
        fullTermEnd(term.start, commitment.cadence),
      );
      const short = owed - counted - planned;
      if (short <= 0n) return null;
      const plan = await planPriceFor(tx, subscription.id);
      if (!plan) return null;
      const mode = await billingModeFor(tx, businessId);
      return { short, plan, mode };
    });
    if (trueUp) {
      const { short, plan, mode } = trueUp;
      lines.push({
        description: commitmentDescription(
          priceLabel(plan.price, { name: plan.productName }),
          { start: term.start, end: endedAt },
          mode,
        ),
        priceId: plan.price.id,
        quantity: 1,
        unitAmountMinor: short,
        amountMinor: short,
        kind: "recurring",
        periodStart: term.start,
        periodEnd: endedAt,
        taxable: plan.price.isTaxable,
        inclusive: plan.price.taxBehavior === "inclusive",
        productKind: "plan",
        productPublicId: plan.productPublicId,
        pricePublicId: plan.price.publicId,
        adjustment: "commitment",
      });
    }
  }

  const subtotal = lines.reduce((s, l) => s + l.amountMinor, 0n);

  const base: PeriodInvoicePlanBase = {
    organizationId,
    businessId,
    subscription,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    usagePeriod: input.usagePeriod,
    existingInvoiceId: input.existingInvoiceId,
    emitClosedEvent: input.emitClosedEvent,
    auditWrite: input.auditWrite,
    ...(input.preview ? { previewOnly: true as const } : {}),
    lines,
    usageEvents,
    billedItemIds,
    pendingChargeIds,
    subtotal,
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(commitmentCheck ? { commitmentCheck } : {}),
    ...(input.interim
      ? {
          purpose: "usage_interim" as const,
          originToken: input.interim.originToken,
          inTx: async (tx: Tx, inv: Invoice) => {
            // The mark the usage views and the event void rule read (design G5 §3.7).
            await tx
              .update(subscriptionItems)
              .set({ usageBilledThrough: input.usagePeriod!.end })
              .where(eq(subscriptionItems.subscriptionId, subscription.id));
            void inv;
          },
        }
      : interimExcessMinor > 0n
        ? {
            inTx: async (tx: Tx, inv: Invoice) => {
              // Credited on the interim invoices by the `usage_threshold_invoices` pass.
              await tx
                .update(invoices)
                .set({
                  metadata: sql`coalesce(${invoices.metadata}, '{}'::jsonb) || ${JSON.stringify({
                    interim_excess_minor: String(interimExcessMinor),
                    interim_window_start: input.usagePeriod?.start.toISOString() ?? null,
                  })}::jsonb`,
                })
                .where(eq(invoices.id, inv.id));
            },
          }
        : {}),
    ...(meterRatings.length
      ? {
          meterCommit: {
            pointers: meterRatings.map((r) => r.pointer),
            levels: meterRatings.flatMap((r) => r.levels),
          },
        }
      : {}),
  };

  // Pending-invoice mode (E2): write a DRAFT — recurring lines only, no tax /
  // credit / ledger / collection. It stays `pending` (accreting usage) until
  // `closeInvoice` finalizes it. Money math runs only at close, so pre-tax
  // discounts + promo credit see the complete line set.
  if (input.createAsPending && !input.existingInvoiceId) {
    return { ...base, mode: "pending_draft", pendingUsageWindow: input.pendingUsageWindow };
  }

  // Discounts (coupons) — applied to the subtotal BEFORE tax.
  // CAT-1: coupons STACK — many active coupons per sub, applied in order
  // sequentially over the running amount. CAT-2: each_specified_item coupons hit
  // only their matched lines (line-accurate), invoice_amount coupons hit the whole
  // running invoice (proportional). One discount LINE per coupon, shown separately;
  // the summed total feeds booking, invoice-level + line-level split
  // feeds tax.
  // Threshold invoicing: no coupon on an interim invoice; a final invoice prices its coupons
  // over the whole period (its lines plus what interim invoices billed) and carries them all.
  const peeked: PeriodDiscountStack = input.interim
    ? {
        rows: [],
        totalMinor: 0n,
        invoiceLevelMinor: 0n,
        itemLevelMinor: 0n,
        lineDiscountByIndex: lines.map(() => 0n),
        invoiceLevelByIndex: lines.map(() => 0n),
        shares: [],
        appliedCouponIds: [],
        pendingOnlyMinor: 0n,
      }
    : await withTenant(organizationId, async (tx) =>
        peekDiscounts(
          tx,
          subscription.id,
          [...lines, ...billedVirtual].map((l, i) => ({
            index: i,
            amountMinor: l.amountMinor,
            productKind: l.productKind,
            productPublicId: l.productPublicId,
            pricePublicId: l.pricePublicId,
          })),
          subscription.currency,
          undefined,
          // 0247. The period this invoice bills, so a fixed amount is clamped to what that
          // period's allowance has left. The READ and the settle below must always agree on
          // the period — clamping here without recording there would under-discount.
          input.periodStart,
        ),
      );
  let discStack = peeked;
  if (billedVirtual.length > 0) {
    const folded = foldBilledDiscount(
      peeked,
      lines.map((l) => l.amountMinor),
    );
    discStack = folded.stack;
    if (folded.excessMinor > 0n) {
      interimExcessMinor += folded.excessMinor;
      if (!base.inTx)
        base.inTx = async (tx: Tx, inv: Invoice) => {
          await tx
            .update(invoices)
            .set({
              metadata: sql`coalesce(${invoices.metadata}, '{}'::jsonb) || ${JSON.stringify({
                interim_excess_minor: String(interimExcessMinor),
                interim_window_start: input.usagePeriod?.start.toISOString() ?? null,
              })}::jsonb`,
            })
            .where(eq(invoices.id, inv.id));
        };
    }
  }
  const discountRows = discStack.rows.filter((r) => r.discountMinor > 0n);
  const discountMinor = discStack.totalMinor; // total coupon discount (line + invoice level)
  const discountedSubtotal = subtotal - discountMinor;

  // Tax: computed on the DISCOUNTED subtotal, from the customer's billing country.
  const [customer] = await withTenant(organizationId, async (tx) =>
    tx.select().from(customers).where(eq(customers.id, subscription.customerId)).limit(1),
  );
  // Per-line tax: resolve the COMPONENT VECTOR once, then split per line honoring
  // product exemption (is_taxable), customer exemption, and inclusive vs exclusive
  // pricing. Place of supply comes from `stateCode` (an ISO-3166-2 code), not the
  // free-text `state` the scalar engine used — intra-vs-inter has to compare codes.
  const exempt = customer?.taxExempt === true;
  const taxableGross = lines.filter((l) => l.taxable).reduce((s, l) => s + l.amountMinor, 0n);
  const taxResolution =
    exempt || taxableGross <= 0n
      ? await getTaxProvider().resolve({ organizationId, businessId, customerExempt: true })
      : await getTaxProvider().resolve({
          organizationId,
          businessId,
          country: customer?.country,
          stateCode: customer?.stateCode,
          treatment: customer?.taxTreatment as TaxTreatment | undefined,
          customerTaxBehavior: customer?.taxBehavior,
        });

  // Net-D due date: subscription terms override customer's, which override the
  // business default.
  const [bizRow] = await withTenant(organizationId, (tx) =>
    tx.select().from(businesses).where(eq(businesses.id, businessId)).limit(1),
  );
  // `0`/null both mean "no terms here" — fall through to the next level. The rule itself
  // is `netTermDaysFrom`, shared with `createInvoiceFromLines` so the two cannot drift.
  const dueDays = netTermDaysFrom({ subscription, customer, business: bizRow });
  const sellerOrigin = await withTenant(organizationId, (tx) =>
    sellerAtIssue(tx, organizationId, bizRow, customer?.country),
  );
  /**
   * No terms anywhere → due ON THE INVOICE DATE, not null.
   *
   * An invoice raised with zero net terms carries `due_date` = its own date exactly.
   * Ours carried NULL on every invoice, which read on the API and the invoice PDF as
   * "no due date" — a bill with no due date is not a bill anyone is late on, and it
   * also left every downstream dunning anchor (`nextRetryAt`, `dunningPeriodEndsAt`,
   * `parkedDunningDeadline`, `nextOfflineReminderAt`) with nothing to measure from,
   * silently falling back to "now" or to no deadline at all.
   *
   * `payment_due` vs `posted` is decided by `resolvePeriodInvoiceMoney` comparing the
   * two dates, so a due-on-issue invoice is still born `payment_due` exactly as
   * before — see the `dueNow` comment there. The column stays nullable: imported
   * invoices keep whatever the source said, including nothing.
   */
  //
  // ⚠️ `periodStart` is typed `Date` and LIES: every caller passes
  // `sub.currentPeriodStart!`, which is genuinely null on a trialing subscription's
  // first bill. The old expression only survived that because the no-terms branch
  // returned `null` without touching it. Falling back to now — the invoice IS being
  // raised now — rather than propagating the null.
  const invoiceDate = input.interim
    ? input.usagePeriod!.end
    : ((input.periodStart as Date | null) ?? stampNow());
  const dueDate =
    dueDays && dueDays > 0
      ? new Date(invoiceDate.getTime() + dueDays * 86_400_000)
      : new Date(invoiceDate.getTime());

  const moneyInputs: Omit<PeriodInvoiceFinalizePlan, "money"> = {
    ...base,
    mode: "finalize",
    discStack,
    discountRows,
    discountMinor,
    discountedSubtotal,
    exempt,
    taxResolution,
    billingSnapshot: customer ? customerBillingAddress(customer) : null,
    customerTaxId: frozen(customerTaxIdOf(customer)),
    seller: sellerOrigin,
    notes: frozen(invoiceNotesOf(customer, bizRow)),
    netTermDays: dueDays,
    withholdingRateBps: customer?.withholdingRateBps ?? 0,
    invoiceRounding: bizRow?.invoiceRounding ?? null,
    invoiceDate,
    dueDate,
    // `bizRow` is already loaded, so the FX snapshot costs no read. Null when the
    // business has no default currency or no usable rate for this currency — reported
    // as null rather than 1 (see `resolveIssueRate`).
    exchangeRate: resolveIssueRate(bizRow, subscription.currency),
    // Credits Flexibility (0219). `bizRow` and `subscription` are both already in hand,
    // so this costs no read; unconfigured resolves to unlimited, i.e. what this path did
    // before the setting existed.
    creditLimits: creditApplicationLimits({
      config: resolveCreditsFlexibility(bizRow),
      invoiceClass: "recurring",
      subscription,
    }),
  };
  // Provisional credit application, from the buckets as they stand right now.
  // `commit` re-resolves under the per-customer lock so a concurrent draw can't
  // spend the same credit twice (the numbers match when nothing else moved).
  const loaded = input.preview?.ignoreCreditBalances
    ? { balances: { promotional: 0n, refundable: 0n, excess: 0n }, grants: [] }
    : await withTenant(organizationId, async (tx) => {
        // Reset windows due by now are granted before the grants are read (G3b §3.3).
        await ensureCreditWindows(tx, {
          customerId: subscription.customerId,
          now: stampNow(businessId),
        });
        const grants = await loadPlannerGrants(tx, {
          businessId,
          customerId: subscription.customerId,
          currency: subscription.currency,
        });
        return {
          balances: await bucketBalancesForCurrency(
            organizationId,
            subscription.customerId,
            subscription.currency,
            tx,
          ),
          grants,
          sliced: await withGrantSlices(tx, subscription.customerId, moneyInputs.lines, grants),
        };
      });
  const { balances, grants } = loaded;
  const sliced = "sliced" in loaded ? loaded.sliced : moneyInputs.lines;
  return {
    ...moneyInputs,
    money: resolvePeriodInvoiceMoney({ ...moneyInputs, lines: sliced }, balances, grants),
  };
}

/**
 * Thrown when a pre-invoice charge no longer matches what the invoice actually
 * bills: `commit` re-resolves the money against the customer-balance lock, so a
 * concurrent credit draw can move `amountDue` between plan and commit. Charging
 * one amount and invoicing another is never acceptable — the commit transaction
 * rolls back untouched and the caller must refund the charge.
 */
/** `opts.claim` found the period already taken (a concurrent cancel or renewal); nothing was written. */
export class PeriodClaimLostError extends Error {
  constructor() {
    super("the subscription period was claimed by someone else");
    this.name = "PeriodClaimLostError";
  }
}

/**
 * `opts.opensPeriod`: another live invoice already opens this subscription period
 * (`invoices_opens_period_uq`, 0370). Nothing was written; the period is billed.
 */
export class PeriodAlreadyBilledError extends Error {
  constructor() {
    super("another invoice already bills this subscription period");
    this.name = "PeriodAlreadyBilledError";
  }
}

/** Drizzle wraps the driver error, and postgres-js names the field `constraint_name`. */
function isOpensPeriodConflict(e: unknown): boolean {
  type PgError = { code?: string; constraint?: string; constraint_name?: string; cause?: unknown };
  for (let cur = e as PgError | undefined, depth = 0; cur && depth < 4; depth++) {
    const constraint = cur.constraint ?? cur.constraint_name;
    if (cur.code === "23505" && constraint === "invoices_opens_period_uq") return true;
    cur = cur.cause as PgError | undefined;
  }
  return false;
}

function rethrowOpensPeriodConflict(e: unknown): never {
  throw isOpensPeriodConflict(e) ? new PeriodAlreadyBilledError() : e;
}

export class ChargeAmountMismatchError extends Error {
  constructor(
    readonly chargedMinor: bigint,
    readonly committedMinor: bigint,
  ) {
    super(
      `Pre-invoice charge of ${chargedMinor} does not match the invoice amount due of ${committedMinor} ` +
        `— the customer's credit balance moved between planning and committing; the charge must be refunded`,
    );
    this.name = "ChargeAmountMismatchError";
  }
}

/**
 * The PO number an invoice raised for a subscription should carry (0243).
 *
 * The subscription's own `po_number` travels onto every invoice it raises — the
 * whole point of collecting it at checkout — UNLESS the invoice
 * already carries one of its own, which always wins (`existingPoNumber`). Nothing
 * that calls this today actually has a per-invoice override to pass (neither
 * `billSubscriptionPeriod` nor `createInvoiceFromLines` takes a `poNumber` input),
 * so every current call omits it and gets the subscription's straight through —
 * the parameter exists so that invariant is explicit, not implicit in which
 * fields happen to get merged where. A `null` subscription PO stays `null`,
 * never `""`.
 */
export function inheritedPoNumber(
  subscription: { poNumber: string | null } | null | undefined,
  /**
   * The business's `inherit_subscription_po_number` (0246). REQUIRED rather than
   * defaulted on purpose: a default here would let a new call site silently start
   * stamping PO numbers on a business that opted out, which is the exact change 0246's
   * migration exists to prevent. `poInheritanceEnabled` resolves it.
   */
  enabled: boolean,
  existingPoNumber?: string | null,
): string | null {
  // An explicit value always wins — it is either the draft's PO from creation time or an
  // operator's manual override, and neither may be clobbered by a re-read.
  if (existingPoNumber != null) return existingPoNumber;
  if (!enabled) return null;
  return subscription?.poNumber ?? null;
}

/**
 * The business's PO-inheritance setting. One indexed read on a path that already does
 * several; `true` is the column default and `false` is what 0246 pinned every
 * pre-existing business to.
 */
export async function poInheritanceEnabled(tx: Tx, businessId: string): Promise<boolean> {
  const [row] = await tx
    .select({ on: businesses.inheritSubscriptionPoNumber })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  return row?.on ?? false;
}

/**
 * WRITE half of `billSubscriptionPeriod`: persist the planned invoice (+ line
 * items, discount/tax/rounding lines, applied taxes), post the ledger entries and
 * credit applications, emit the events, and — unless `opts.collect` is false —
 * attempt collection through the provider adapter.
 *
 * Every amount comes from the plan; nothing is re-derived here except the credit
 * application, which is re-resolved from the buckets read INSIDE the write txn
 * (over-draw guard, see below).
 */
export async function commitSubscriptionPeriodInvoice(
  plan: PeriodInvoicePlan,
  opts: {
    collect?: boolean;
    /**
     * Events buffered by an earlier step that must only become visible if this
     * invoice commits (the auto-collect-ON signup defers subscription_created /
     * coupon_applied until its first charge is known good). Emitted at the TOP of
     * the invoice transaction, so ordering matches the un-deferred path and the
     * whole set commits atomically with the invoice.
     */
    preEvents?: readonly EmitEventInput[];
    /**
     * A charge already made against the gateway for this exact invoice (the
     * pre-invoice signup charge). Books the money instead of charging again; the
     * amount is asserted against the committed `amountDue` first.
     */
    charge?: CompletedCharge;
    /**
     * Commit the invoice unnumbered (`awaiting_number`) and stop: `number_invoices` numbers it,
     * emits `invoice_generated` and queues its collection. Applies only to a fresh invoice with
     * no credit draw that this call would collect; anything else is numbered here as before.
     */
    deferNumber?: boolean;
    /**
     * Run first inside the invoice transaction: a renewal's period advance, so the advance and
     * its invoice commit together and a crash between them cannot leave a period unbilled.
     * False rolls everything back and throws `PeriodClaimLostError`.
     */
    claim?: (tx: Tx) => Promise<boolean>;
    /**
     * Mark a fresh invoice as the one that opens its period (`invoices.opens_period`). A
     * second live one for the same (subscription, period_start) rolls back and throws
     * `PeriodAlreadyBilledError`. Billing-clock paths only; see the column note.
     */
    opensPeriod?: boolean;
  } = {},
): Promise<{ invoice: Invoice; payment: Payment | null; numberDeferred?: boolean }> {
  const { organizationId, businessId, subscription, lines } = plan;

  if (plan.previewOnly) {
    throw new Error("commitSubscriptionPeriodInvoice: a preview plan cannot be committed");
  }
  if (opts.charge && plan.mode !== "finalize") {
    throw new Error(
      "commitSubscriptionPeriodInvoice: a pre-invoice charge cannot be applied to a pending draft",
    );
  }

  // Pending-invoice mode (E2): write a DRAFT — recurring lines only, no tax /
  // credit / ledger / collection. It stays `pending` (accreting usage) until
  // `closeInvoice` finalizes it. Money math runs only at close, so pre-tax
  // discounts + promo credit see the complete line set.
  if (plan.mode === "pending_draft") {
    const draftSubtotal = plan.subtotal;
    const draft = await withTenant(organizationId, async (tx) => {
      if (opts.claim && !(await opts.claim(tx))) throw new PeriodClaimLostError();
      if (opts.preEvents?.length) await emitDeferred(tx, opts.preEvents);
      const [inv] = await tx
        .insert(invoices)
        .values({
          organizationId,
          businessId,
          customerId: subscription.customerId,
          subscriptionId: subscription.id,
          publicId: publicId("inv"),
          number: await nextInvoiceNumber(tx, businessId),
          channel: currentChannel(),
          status: "pending",
          currency: subscription.currency,
          poNumber: inheritedPoNumber(subscription, await poInheritanceEnabled(tx, businessId)),
          subtotalMinor: draftSubtotal,
          totalMinor: draftSubtotal,
          amountDueMinor: draftSubtotal,
          periodStart: plan.periodStart,
          periodEnd: plan.periodEnd,
          opensPeriod: opts.opensPeriod === true,
          // Persist the arrears window `closeInvoice` must bill (B5 fix: at the
          // transition into pending mode this includes the just-ended period).
          ...(plan.pendingUsageWindow
            ? {
                metadata: {
                  usage_window: {
                    start: plan.pendingUsageWindow.start.toISOString(),
                    end: plan.pendingUsageWindow.end.toISOString(),
                  },
                },
              }
            : {}),
        })
        .returning();
      if (lines.length > 0) {
        const pendingTaxCodes = await resolveLineTaxCodes(tx, businessId, lines);
        await tx.insert(invoiceLineItems).values(
          lines.map((l, i) => ({
            organizationId,
            businessId,
            invoiceId: inv!.id,
            publicId: publicId("il"),
            description: l.description,
            priceId: l.priceId,
            quantity: l.quantity,
            unitAmountMinor: l.unitAmountMinor,
            amountMinor: l.amountMinor,
            kind: l.kind,
            taxCode: pendingTaxCodes[i] ?? null,
            periodStart: l.periodStart,
            periodEnd: l.periodEnd,
            rating: l.rating ?? null,
            adjustment: l.adjustment ?? null,
            quantityDecimal: l.quantityDecimal ?? null,
            unitAmountDecimal: l.unitAmountDecimal ?? null,
            costMinor: l.costBasis ? (l.costMinor ?? null) : null,
            costBasis: l.costBasis ?? null,
          })),
        );
      }
      await emitEvent(tx, {
        organizationId,
        businessId,
        type: "invoice_pending_created",
        data: buildEventData("invoice_pending_created", {
          id: inv!.publicId,
          total_minor: Number(draftSubtotal),
          currency: subscription.currency,
          status: "pending",
        }),
      });
      return inv!;
    }).catch(rethrowOpensPeriodConflict);
    return { invoice: draft, payment: null };
  }

  const {
    subtotal,
    discountRows,
    discountMinor,
    dueDate,
    usageEvents,
    billedItemIds,
    pendingChargeIds,
  } = plan;

  // 2) Create invoice + line items (+ tax line) + ledger, atomically.
  const committed = await withTenant(organizationId, async (tx) => {
    if (opts.claim && !(await opts.claim(tx))) throw new PeriodClaimLostError();
    // The claim holds the subscription row, so the counted fees are stable from here.
    const check = plan.commitmentCheck;
    if (
      check &&
      (await countedCommitmentFees(tx, check.subscriptionId, check.term)) !== check.countedMinor
    )
      throw new CommitmentMovedError();
    // Over-draw guard (review fix 2026-07-04): serialize per customer, then read
    // the buckets INSIDE this transaction so a concurrent draw can't spend the
    // same credit twice.
    await lockCustomerBalances(tx, subscription.customerId);
    const balances = await bucketBalancesForCurrency(
      organizationId,
      subscription.customerId,
      subscription.currency,
      tx,
    );
    await ensureCreditWindows(tx, {
      customerId: subscription.customerId,
      now: stampNow(businessId),
    });
    const grants = await loadPlannerGrants(tx, {
      businessId,
      customerId: subscription.customerId,
      currency: subscription.currency,
    });
    // Re-resolve the planned money against the locked buckets — identical to
    // `plan.money` unless another draw landed between plan and commit.
    const money = resolvePeriodInvoiceMoney(
      { ...plan, lines: await withGrantSlices(tx, subscription.customerId, plan.lines, grants) },
      balances,
      grants,
    );
    const {
      invoiceTax,
      total,
      withholdingMinor,
      collectible,
      roundingDelta,
      promoApplied,
      grantPreTaxApplied,
      grantPostTaxApplied,
      refundableApplied,
      excessApplied,
      creditApplied,
      amountDue,
      fullyPaid,
    } = money;
    const deferNumber =
      opts.deferNumber === true &&
      !plan.existingInvoiceId &&
      creditApplied === 0n &&
      !opts.charge &&
      opts.collect !== false;
    // What the API and the printed document call `total_minor`: the stored column less the
    // promotional slice, which both present as a pre-tax discount (`serializeInvoice`,
    // 2026-08-25). The event payload names the SAME field, so it has to carry the
    // same number — a webhook and a GET that disagree about `total_minor` for one invoice
    // is a reconciliation bug waiting to be written by a consumer.
    const reportedTotal = total - promoApplied - grantPreTaxApplied;

    // Amount-mismatch guard: the caller charged `opts.charge.amountMinor` off the
    // PLANNED numbers; the locked re-resolve above is what actually gets invoiced.
    // A concurrent credit draw can move them apart — fail loudly and let the whole
    // transaction roll back (nothing written, nothing emitted) rather than invoice
    // an amount we did not charge.
    if (opts.charge && opts.charge.amountMinor !== amountDue) {
      throw new ChargeAmountMismatchError(opts.charge.amountMinor, amountDue);
    }
    // Deferred events (subscription_created, coupon_applied, …) become visible
    // here — atomically with the invoice, and only now that the money is settled.
    if (opts.preEvents?.length) await emitDeferred(tx, opts.preEvents);

    // Finalizing a pending draft (E2): update the SAME row (keep its number) and
    // replace its draft lines/taxes; else insert a fresh invoice.
    const invoiceValues = {
      dueDate,
      status: money.status,
      currency: subscription.currency,
      // `sub_total`: gross MINUS the item-level discount stage only. The
      // document-level stage stays below the subtotal as its own line (0169).
      subtotalMinor: subtotal - plan.discStack.itemLevelMinor,
      totalMinor: total,
      amountDueMinor: amountDue,
      withholdingMinor,
      promotionalCreditsAppliedMinor: promoApplied,
      refundableCreditsAppliedMinor: refundableApplied,
      excessPaymentsAppliedMinor: excessApplied,
      grantCreditsPreTaxMinor: grantPreTaxApplied,
      grantCreditsPostTaxMinor: grantPostTaxApplied,
      periodStart: plan.periodStart,
      periodEnd: plan.periodEnd,
      paidAt: fullyPaid
        ? plan.purpose === "usage_interim"
          ? plan.invoiceDate
          : plan.periodStart
        : null,
      // Freeze the tax determination. `sellerStateCode` is what decided CGST+SGST vs
      // IGST, so re-deriving it later — after the business re-registers in another
      // state — would silently restate this invoice's tax breakdown.
      sellerStateCode: plan.taxResolution.sellerStateCode,
      placeOfSupplyCode: plan.taxResolution.placeOfSupplyCode,
      taxTreatment: plan.taxResolution.treatment,
      taxNote: plan.taxResolution.taxNote,
      customerTaxId: plan.customerTaxId,
      sellerName: plan.seller.name,
      sellerAddress: plan.seller.address,
      sellerTaxId: plan.seller.id,
      sellerTaxCountry: plan.seller.country,
      priceType: frozen(plan.taxResolution.priceType),
      notes: plan.notes,
      netTermDays: plan.netTermDays,
      finalizedAt: sql`app_now()`,
      // FX snapshot (0228). In `invoiceValues` rather than at the insert because the
      // close path UPDATEs a pending draft with this same object — which is what makes
      // a closed draft carry its close-time rate instead of its draft-time one.
      ...exchangeRateColumns(plan.exchangeRate),
    };
    const shipTo = await shipToSnapshot(tx, {
      customerId: subscription.customerId,
      shippingAddressId: subscription.shippingAddressId,
    });
    let inv: Invoice;
    if (plan.existingInvoiceId) {
      await tx.delete(appliedTaxes).where(eq(appliedTaxes.invoiceId, plan.existingInvoiceId));
      await tx
        .delete(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, plan.existingInvoiceId));
      // ATOMIC CLAIM: only a still-`pending` row can be finalized. A concurrent
      // close (manual close racing auto-close) loses here and this whole
      // transaction — ledger postings, credit draws, line rewrite — rolls back.
      const [row] = await tx
        .update(invoices)
        .set({
          ...invoiceValues,
          // An address an operator set on the draft while it was pending wins.
          ...(plan.billingSnapshot
            ? {
                billingAddress: sql`coalesce(${invoices.billingAddress}, ${JSON.stringify(plan.billingSnapshot)}::jsonb)`,
              }
            : {}),
          ...(shipTo
            ? {
                shippingAddress: sql`coalesce(${invoices.shippingAddress}, ${JSON.stringify(shipTo)}::jsonb)`,
              }
            : {}),
        })
        .where(and(eq(invoices.id, plan.existingInvoiceId), eq(invoices.status, "pending")))
        .returning();
      if (!row) throw new Error("Invoice is no longer pending — it was already closed");
      inv = row;
    } else {
      const [row] = await tx
        .insert(invoices)
        .values({
          organizationId,
          businessId,
          customerId: subscription.customerId,
          subscriptionId: subscription.id,
          publicId: publicId("inv"),
          // Numbered just before the first event below, to keep the counter lock short.
          number: null,
          channel: currentChannel(),
          // Inherited on a FRESH row only — never folded into `invoiceValues` above,
          // which the `existingInvoiceId` branch also uses to UPDATE a pending draft:
          // that draft already got its PO at creation time (or an operator overrode
          // it via `updateInvoiceFields` while it sat pending), and finalize must
          // not clobber either.
          poNumber: inheritedPoNumber(subscription, await poInheritanceEnabled(tx, businessId)),
          billingAddress: plan.billingSnapshot,
          shippingAddress: shipTo,
          ...(deferNumber ? { awaitingNumber: true } : {}),
          ...(opts.opensPeriod ? { opensPeriod: true } : {}),
          ...(plan.metadata ? { metadata: plan.metadata } : {}),
          ...(plan.originToken ? { originToken: plan.originToken, purpose: plan.purpose } : {}),
          ...invoiceValues,
        })
        .returning();
      inv = row!;
    }

    // Count this finalized period against each billed item's cycle cap (G review
    // blocker: attached_items.billing_cycles was carried but never enforced).
    if (billedItemIds.length > 0) {
      await tx
        .update(subscriptionItems)
        .set({ cyclesBilled: sql`${subscriptionItems.cyclesBilled} + 1` })
        .where(inArray(subscriptionItems.id, billedItemIds));
    }

    // Resolved BEFORE the insert so every supply line is stamped in the same
    // statement — see `resolveLineTaxCodes`. This is the recurring-billing path and
    // therefore the one that matters most: the manual-invoice path goes through
    // `insertLines`, and covering only that left every RENEWAL invoice uncoded.
    const billTaxCodes = lines.length > 0 ? await resolveLineTaxCodes(tx, businessId, lines) : [];
    const insertedLines =
      lines.length > 0
        ? await tx
            .insert(invoiceLineItems)
            .values(
              lines.map((l, i) => ({
                organizationId,
                businessId,
                invoiceId: inv!.id,
                publicId: publicId("il"),
                description: l.description,
                priceId: l.priceId,
                quantity: l.quantity,
                unitAmountMinor: l.unitAmountMinor,
                amountMinor: l.amountMinor,
                // `line_items[].discount_amount` — BOTH stages, since document-level
                // discounts are attributed to lines too. Only the item-level part is inside
                // `subtotalMinor` above; this column is for display and reconciliation.
                discountMinor:
                  (plan.discStack.lineDiscountByIndex[i] ?? 0n) +
                  (plan.discStack.invoiceLevelByIndex[i] ?? 0n),
                kind: l.kind,
                taxCode: billTaxCodes[i] ?? null,
                periodStart: l.periodStart,
                periodEnd: l.periodEnd,
                rating: l.rating ?? null,
                adjustment: l.adjustment ?? null,
                quantityDecimal: l.quantityDecimal ?? null,
                unitAmountDecimal: l.unitAmountDecimal ?? null,
                costMinor: l.costBasis ? (l.costMinor ?? null) : null,
                costBasis: l.costBasis ?? null,
              })),
            )
            .returning({ id: invoiceLineItems.id, amountMinor: invoiceLineItems.amountMinor })
        : [];
    // Meter lines: advance each billing pointer and record recurring levels, atomically with
    // the invoice. A rollback leaves the pointer where it was, so nothing is lost.
    if (plan.meterCommit)
      await commitMeterRating(tx, { organizationId, businessId, ...plan.meterCommit });
    // `line_item_discounts[]`: the (line, coupon, stage) attribution. Inserted from
    // the SAME `insertedLines` order the values above were built from, which is the only
    // thing tying `share.lineIndex` back to a real row id.
    if (plan.discStack.shares.length > 0 && insertedLines.length > 0) {
      await tx.insert(invoiceLineDiscounts).values(
        plan.discStack.shares
          .filter((s) => insertedLines[s.lineIndex] != null)
          .map((s) => ({
            organizationId,
            businessId,
            invoiceId: inv!.id,
            invoiceLineItemId: insertedLines[s.lineIndex]!.id,
            appliedCouponId: s.appliedCouponId,
            label: s.label,
            scope: s.scope,
            amountMinor: s.amountMinor,
          })),
      );
    }
    // One discount line PER coupon that actually discounted, shown separately —
    // but for its DOCUMENT-LEVEL portion only. The item-level portion is already inside
    // `subtotalMinor` (0169), so a line for the full `discountMinor` would subtract it a
    // second time and the invoice would not add up. A coupon can straddle both stages, so
    // this is a per-row amount and not a filter on the coupon's `applyOn`.
    //
    // ⚠️ REDEMPTION IS NOT GATED ON THAT LINE EXISTING. A redemption counts whenever the
    // coupon reduced the bill, which an item-level-only coupon does without producing any
    // line here — so `consumeDiscount` runs over `discountRows` (discountMinor > 0), not
    // over the rows that got a line. Gating it would let a `once` item-level coupon
    // discount every renewal forever.
    for (const row of discountRows) {
      if (row.documentLevelMinor > 0n) {
        await tx.insert(invoiceLineItems).values({
          organizationId,
          businessId,
          invoiceId: inv!.id,
          publicId: publicId("il"),
          description: `Discount (${row.label})`,
          priceId: null,
          quantity: 1,
          unitAmountMinor: -row.documentLevelMinor,
          amountMinor: -row.documentLevelMinor,
          kind: "discount",
          appliedCouponId: row.appliedCouponId,
          periodStart: plan.periodStart,
          periodEnd: plan.periodEnd,
        });
      }
      // 0247. This invoice bills `plan.periodStart`, so that is the period whose
      // allowance it drew from and the period it spends.
      await settlePeriodDiscount(tx, row.appliedCouponId, {
        periodStart: plan.periodStart,
        appliedMinor: row.discountMinor,
      });
    }
    // Additive (exclusive) tax is shown as synthetic tax line items — ONE PER
    // COMPONENT, because an India GST invoice must show CGST and SGST/UTGST separately.
    // Inclusive tax is inside the product lines, so it is never a line of its own.
    // Amounts are summed from the exclusive `applied_taxes` rows, so the lines and the
    // per-line breakdown are the same numbers by construction and
    // Σ(tax lines) === additiveTaxMinor exactly.
    //
    // ⚠️ A COMPONENT'S ROWS ARE SUMMED SIGNED. A negative exclusive row is the tax on a
    // reversal — a netted "Unused time" proration credit here — and `additiveTaxMinor` (and
    // therefore `total_minor`) already nets it, so dropping it would print more tax than was
    // charged. The 36 invoices that were measured with that defect all came from
    // `createInvoiceFromLines` (see the note there); this path is corrected to the same rule
    // because its own `lines` can carry a negative amount, and two writers must not disagree
    // about what the tax line on one document means.
    if (invoiceTax.additiveTaxMinor !== 0n) {
      const byComponent = new Map<string, { name: string; rateBps: number; amountMinor: bigint }>();
      for (const r of invoiceTax.rows) {
        if (r.inclusive) continue;
        const k = `${r.name}|${r.rateBps}`;
        const acc = byComponent.get(k) ?? { name: r.name, rateBps: r.rateBps, amountMinor: 0n };
        acc.amountMinor += r.amountMinor;
        byComponent.set(k, acc);
      }
      for (const c of byComponent.values()) {
        // A component whose charges and reversals cancel exactly owes nothing and gets no
        // line; a component with a net amount gets one, whatever its sign.
        if (c.amountMinor === 0n) continue;
        await tx.insert(invoiceLineItems).values({
          organizationId,
          businessId,
          invoiceId: inv!.id,
          publicId: publicId("il"),
          description: taxComponentLabel(c.name, c.rateBps),
          priceId: null,
          quantity: 1,
          unitAmountMinor: c.amountMinor,
          amountMinor: c.amountMinor,
          kind: "tax",
          periodStart: plan.periodStart,
          periodEnd: plan.periodEnd,
        });
      }
    }
    // Round-off line (E6): shows the ±delta that rounded the total to a whole unit.
    if (roundingDelta !== 0n) {
      await tx.insert(invoiceLineItems).values({
        organizationId,
        businessId,
        invoiceId: inv!.id,
        publicId: publicId("il"),
        description: "Rounding",
        priceId: null,
        quantity: 1,
        unitAmountMinor: roundingDelta,
        amountMinor: roundingDelta,
        kind: "rounding",
        periodStart: plan.periodStart,
        periodEnd: plan.periodEnd,
      });
    }
    // Per-line tax breakdown. computeInvoiceTax keyed rows by line index (as string);
    // map those back to the inserted line-item ids (insertedLines is in `lines` order).
    if (invoiceTax.rows.length > 0) {
      await tx.insert(appliedTaxes).values(
        invoiceTax.rows.map((r) => ({
          organizationId,
          businessId,
          invoiceId: inv!.id,
          invoiceLineItemId: insertedLines[Number(r.lineId)]!.id,
          taxComponentId: r.taxComponentId,
          name: r.name,
          rateBps: r.rateBps,
          amountMinor: r.amountMinor,
          taxabilityReason: r.taxabilityReason,
        })),
      );
    }

    if (subtotal > 0n) {
      // Double-entry: revenue credited NET of inclusive tax (inclusive tax is inside
      // the line amounts); discount booked as a contra-revenue debit; the FULL tax
      // liability (additive + inclusive) → tax_payable; AR = what's actually owed.
      //   credits: revenue(subtotal − inclusiveTax) + tax_payable(totalTax)
      //   debits:  discounts(discount) + AR(total)   → both sides = subtotal + additiveTax
      const ledgerLines: Array<{
        account: string;
        direction: "debit" | "credit";
        amountMinor: bigint;
        currency: string;
      }> = [
        {
          account: "revenue",
          direction: "credit",
          amountMinor: subtotal - invoiceTax.inclusiveTaxMinor,
          currency: subscription.currency,
        },
      ];
      if (discountMinor > 0n) {
        ledgerLines.push({
          account: "discounts",
          direction: "debit" as const,
          amountMinor: discountMinor,
          currency: subscription.currency,
        });
      }
      if (invoiceTax.totalTaxMinor > 0n) {
        ledgerLines.push({
          account: "tax_payable",
          direction: "credit" as const,
          amountMinor: invoiceTax.totalTaxMinor,
          currency: subscription.currency,
        });
      }
      // TDS withheld: an asset (reclaimable) that reduces AR by the same amount.
      if (withholdingMinor > 0n) {
        ledgerLines.push({
          account: "withholding_receivable",
          direction: "debit" as const,
          amountMinor: withholdingMinor,
          currency: subscription.currency,
        });
      }
      if (collectible > 0n) {
        ledgerLines.push({
          account: "accounts_receivable",
          direction: "debit" as const,
          amountMinor: collectible,
          currency: subscription.currency,
        });
      }
      // Round-off (E6): AR carries the rounded total; the delta lands in `rounding`
      // so revenue + tax stay exact and the entry balances.
      if (roundingDelta !== 0n) {
        const amt = roundingDelta > 0n ? roundingDelta : -roundingDelta;
        ledgerLines.push({
          account: "rounding",
          direction: roundingDelta > 0n ? "credit" : "debit",
          amountMinor: amt,
          currency: subscription.currency,
        });
      }
      await postEntries(
        {
          organizationId,
          businessId,
          customerId: inv!.customerId,
          sourceType: "invoice",
          sourceId: inv!.publicId,
          lines: ledgerLines,
        },
        tx,
      );
    }

    // The business's invoice counter is locked from its UPDATE until commit, and every renewal
    // in the business queues on it — so the lock must cover milliseconds, not the snapshots.
    // A fresh invoice with no credit draw (a plain renewal) builds its events first, then takes
    // the number and patches it into them. A credit draw emits its own events reading the
    // invoice, so that path is numbered before it.
    const numberLate = !plan.existingInvoiceId && creditApplied === 0n;
    const takeNumber = async () => {
      const number = await nextInvoiceNumber(tx, businessId);
      const [numbered] = await tx
        .update(invoices)
        .set({ number })
        .where(eq(invoices.id, inv!.id))
        .returning();
      inv = numbered!;
    };
    if (!plan.existingInvoiceId && !numberLate) await takeNumber();

    if (creditApplied > 0n) {
      await postCreditApplications(tx, {
        organizationId,
        businessId,
        customerId: subscription.customerId,
        invoicePublicId: inv!.publicId,
        currency: subscription.currency,
        promotional: promoApplied,
        refundable: refundableApplied,
        excess: excessApplied,
      });
      if (money.grantDraws.length > 0)
        await postGrantDraws(tx, {
          organizationId,
          businessId,
          customerId: subscription.customerId,
          invoiceId: inv!.id,
          invoicePublicId: inv!.publicId,
          currency: subscription.currency,
          draws: money.grantDraws,
        });
      // Attribute the refundable-bucket draw to the funding credit notes (FIFO).
      if (refundableApplied > 0n)
        await allocateRefundableDraw(tx, {
          organizationId,
          businessId,
          customerId: subscription.customerId,
          invoiceId: inv!.id,
          invoicePublicId: inv!.publicId,
          currency: subscription.currency,
          drawMinor: refundableApplied,
        });
    }

    const prepared: PreparedEvent[] = [];
    const emitOrPrepare = async (input: EmitEventInput) => {
      // Deferred: `number_invoices` emits these once the invoice has its number.
      if (deferNumber) return;
      if (!numberLate) return void (await emitEvent(tx, input));
      const p = await prepareEvent(tx, input);
      if (p) prepared.push(p);
    };
    // Fully covered by credit (total>0 but nothing left to charge) → notify now.
    if (total > 0n && amountDue === 0n) {
      await emitOrPrepare({
        organizationId,
        businessId,
        type: "invoice_paid",
        data: buildEventData(
          "invoice_paid",
          { id: inv!.publicId, amount_minor: Number(total), currency: subscription.currency },
          null,
          { paid_with_credit: true },
        ),
      });
      await activatePaidCreditGrants(tx, { organizationId, invoiceId: inv!.id });
    }
    // Mark any folded-in ad-hoc charges as billed on this invoice.
    if (pendingChargeIds.length > 0) {
      await tx
        .update(unbilledCharges)
        .set({ status: "billed", invoiceId: inv!.id })
        .where(inArray(unbilledCharges.id, pendingChargeIds));
    }
    await emitOrPrepare({
      organizationId,
      businessId,
      type: "invoice_generated",
      data: buildEventData("invoice_generated", {
        id: inv!.publicId,
        total_minor: Number(reportedTotal),
        currency: subscription.currency,
        status: inv!.status,
      }),
    });
    if (deferNumber) {
      if (!afterCommit(async () => requestInvoiceNumbering(organizationId, businessId)))
        requestInvoiceNumbering(organizationId, businessId);
    } else if (numberLate) {
      await takeNumber();
      for (const p of prepared) {
        patchInvoiceSnapshot(p.content, inv!);
        await insertPreparedEvent(tx, p);
      }
    }
    // Close event in the SAME tx as the finalize (outbox invariant).
    if (plan.emitClosedEvent && plan.existingInvoiceId) {
      await emitEvent(tx, {
        organizationId,
        businessId,
        type: "invoice_closed",
        data: buildEventData("invoice_closed", {
          id: inv!.publicId,
          status: inv!.status,
          total_minor: Number(reportedTotal),
          currency: subscription.currency,
        }),
      });
    }
    // P4: the operator action that triggered this run (close / regenerate), audited
    // in the SAME tx as the state change — exactly like `invoice.void`, so an
    // aborted finalize can never leave an audit row claiming it happened.
    if (plan.auditWrite) {
      const a = plan.auditWrite(inv!);
      const { writeAuditLog } = await import("@/modules/audit/service");
      await writeAuditLog(
        {
          organizationId,
          businessId,
          action: a.action,
          resourceType: "invoice",
          resourceId: a.resourceId ?? inv!.publicId,
          before: a.before,
          after: a.after,
        },
        tx,
      );
    }
    for (const u of usageEvents) {
      await emitEvent(tx, {
        organizationId,
        businessId,
        type: "usage_recorded",
        data: buildEventData("usage_recorded", {
          id: u.slug,
          quantity: u.qty,
          period_start: plan.usagePeriod?.start ?? null,
          period_end: plan.usagePeriod?.end ?? null,
          invoice: inv!.publicId,
        }),
      });
    }

    // Prepaid commit: the money for this invoice already moved (the signup charged
    // before anything was persisted). Book it here — payment row, cash/AR ledger,
    // gateway transaction, paid status — in the SAME transaction as the invoice, in
    // the same order collectInvoice would have produced (invoice_generated, then
    // payment_succeeded, then invoice_paid). Never charges again.
    let prepaidPayment: Payment | null = null;
    if (opts.charge) {
      const c = opts.charge;
      if (c.outcome === "succeeded") {
        const [pay] = await tx
          .insert(payments)
          .values({
            organizationId,
            businessId,
            customerId: subscription.customerId,
            invoiceId: inv!.id,
            paymentMethodId: c.pm.id,
            publicId: publicId("pay"),
            status: "succeeded",
            amountMinor: c.amountMinor,
            currency: subscription.currency,
            providerKey: c.gatewayKey,
            providerChargeId: c.result.providerChargeId,
            methodType: methodTypeOf(c.result, c.pm),
          })
          .returning();
        await postEntries(
          {
            organizationId,
            businessId,
            customerId: pay!.customerId,
            sourceType: "payment",
            sourceId: pay!.publicId,
            lines: [
              {
                account: "cash",
                direction: "debit",
                amountMinor: c.amountMinor,
                currency: subscription.currency,
              },
              {
                account: "accounts_receivable",
                direction: "credit",
                amountMinor: c.amountMinor,
                currency: subscription.currency,
              },
            ],
          },
          tx,
        );
        const [paidRow] = await tx
          .update(invoices)
          .set({
            status: "paid",
            paidAt: stampNow(),
            attemptCount: inv!.attemptCount + 1,
            nextAttemptAt: null,
            ...dunningFieldsOnSettle(inv!),
          })
          .where(eq(invoices.id, inv!.id))
          .returning();
        inv = paidRow ?? inv!;
        await recordTransaction(
          {
            organizationId,
            businessId,
            customerId: subscription.customerId,
            type: "payment",
            status: "succeeded",
            amountMinor: c.amountMinor,
            currency: subscription.currency,
            gatewayAccountId: c.account?.id ?? null,
            gatewayKey: c.gatewayKey,
            idAtGateway: c.result.providerChargeId,
            paymentMethodId: c.pm.id,
            invoiceId: inv!.id,
            paymentId: pay!.id,
          },
          tx,
        );
        await emitEvent(tx, {
          organizationId,
          businessId,
          type: "payment_succeeded",
          data: buildEventData("payment_succeeded", {
            id: pay!.publicId,
            status: "succeeded",
            amount_minor: Number(c.amountMinor),
            currency: subscription.currency,
            invoice: inv!.publicId,
          }),
        });
        await emitEvent(tx, {
          organizationId,
          businessId,
          type: "invoice_paid",
          data: buildEventData("invoice_paid", {
            id: inv!.publicId,
            amount_minor: Number(total),
            currency: subscription.currency,
          }),
        });
        await activatePaidCreditGrants(tx, { organizationId, invoiceId: inv!.id });
        prepaidPayment = pay!;
      } else {
        // Unknown gateway outcome: park the invoice (attempt consumed, no dunning
        // armed) and leave the inbound reconciler / manual reconcile to settle it —
        // exactly what collectInvoice's bookPending does.
        const [pay] = await tx
          .insert(payments)
          .values({
            organizationId,
            businessId,
            customerId: subscription.customerId,
            invoiceId: inv!.id,
            paymentMethodId: c.pm.id,
            publicId: publicId("pay"),
            status: "pending",
            amountMinor: c.amountMinor,
            currency: subscription.currency,
            providerKey: c.gatewayKey,
            providerChargeId: c.result.providerChargeId,
            methodType: methodTypeOf(c.result, c.pm),
          })
          .returning();
        await recordTransaction(
          {
            organizationId,
            businessId,
            customerId: subscription.customerId,
            type: "payment",
            status: c.pendingStatus ?? "timeout",
            amountMinor: c.amountMinor,
            currency: subscription.currency,
            gatewayAccountId: c.account?.id ?? null,
            gatewayKey: c.gatewayKey,
            idAtGateway: c.result.providerChargeId,
            paymentMethodId: c.pm.id,
            invoiceId: inv!.id,
            paymentId: pay!.id,
            errorCode: c.result.failure?.code ?? null,
            errorText: c.result.failure?.message ?? null,
          },
          tx,
        );
        const [parked] = await tx
          .update(invoices)
          .set({ attemptCount: inv!.attemptCount + 1, nextAttemptAt: null })
          .where(eq(invoices.id, inv!.id))
          .returning();
        inv = parked ?? inv!;
        prepaidPayment = pay!;
      }
    }
    if (plan.inTx) await plan.inTx(tx, inv!);
    // Credits per cycle, after this period's usage drew on the closing grant (design G3 §3.6).
    // Only for the subscription's own term; a re-run of the period grants once.
    if (isOwnTermInvoice(plan, subscription))
      await applyPlanCredits(tx, {
        organizationId,
        businessId,
        subscription,
        periodStart: plan.periodStart,
        periodEnd: plan.periodEnd,
      });
    return { inv: inv!, prepaidPayment, deferNumber };
  }).catch(rethrowOpensPeriodConflict);

  const invoice = committed.inv;

  // The charge already happened — never collect again.
  if (committed.prepaidPayment) return { invoice, payment: committed.prepaidPayment };

  if (opts.collect === false) return { invoice, payment: null };
  if (committed.deferNumber) return { invoice, payment: null, numberDeferred: true };

  return collectPeriodInvoice({ organizationId, businessId, subscription, invoice });
}

/**
 * True when the invoice bills the subscription's current term. The period columns are typed
 * `Date` but are null on a trialing subscription's first bill, which has no term: false then.
 */
export function isOwnTermInvoice(
  period: { periodStart: Date | null; periodEnd: Date | null },
  sub: { currentPeriodStart: Date | null; currentPeriodEnd: Date | null },
): boolean {
  const { periodStart: ps, periodEnd: pe } = period;
  const { currentPeriodStart: cs, currentPeriodEnd: ce } = sub;
  if (!ps || !pe || !cs || !ce) return false;
  return ps.getTime() === cs.getTime() && pe.getTime() === ce.getTime();
}

/**
 * Collect a committed period invoice: skip a paid one, put an auto-collection-off one into
 * dunning, else charge it. The tail of `commitSubscriptionPeriodInvoice`, and the whole of a
 * batch-numbered renewal's collection job.
 */
export async function collectPeriodInvoice(input: {
  organizationId: string;
  businessId: string;
  subscription: typeof subscriptions.$inferSelect;
  invoice: Invoice;
}): Promise<{ invoice: Invoice; payment: Payment | null }> {
  const { organizationId, businessId, subscription, invoice } = input;
  // Nothing to charge (zero invoice, or fully covered by credit). The invoice row
  // is the source of truth — fullyPaid was computed inside the invoice tx.
  if (invoice.status === "paid") return { invoice, payment: null };

  // CP-1: honor auto_collection — 'off' leaves the invoice open (send-invoice), no charge.
  const [custAc] = await withTenant(organizationId, async (tx) =>
    tx
      .select({ ac: customers.autoCollection })
      .from(customers)
      .where(eq(customers.id, subscription.customerId))
      .limit(1),
  );
  if (!isAutoCollectOn(subscription.autoCollection, custAc?.ac)) {
    // Send-invoice, so nothing is charged — but the invoice is not simply parked
    // either: it goes straight into dunning, which for an offline bill means
    // reminders. See `enrolOfflineInvoiceInDunning`.
    return {
      invoice: await enrolOfflineInvoiceInDunning({
        organizationId,
        businessId,
        invoice,
        subscriptionStatus: subscription.status,
      }),
      payment: null,
    };
  }

  // 3) Collect via the provider adapter (outside any DB txn — network I/O).
  // Auto-collect charges at generation (Net-D sets the due
  // date but doesn't defer the auto-charge). Only send-invoice (auto-collect off)
  // invoices stay `posted`; the clock transitions THOSE at their due date.
  let payment: Payment | null;
  try {
    payment = await collectInvoice({ organizationId, businessId, invoice, subscription });
  } catch (e) {
    // The renewal stands; the clock collects once the gateway's notice period ends.
    if (!(e instanceof CollectionDeferredError)) throw e;
    payment = null;
  }
  // Re-read the invoice for its true post-collection state — collectInvoice may
  // have set it to paid, payment_due (retry scheduled), or not_paid (non-retriable
  // failure / exhausted). Don't infer from the payment alone.
  const finalInvoice = await withTenant(organizationId, async (tx) => {
    const [row] = await tx.select().from(invoices).where(eq(invoices.id, invoice.id)).limit(1);
    return row ?? invoice;
  });
  return { invoice: finalInvoice, payment };
}

/**
 * Bill one subscription period: generate an invoice from the subscription's
 * items, post the AR/revenue ledger entries atomically, then attempt collection
 * via the provider adapter (recording a payment + cash/AR ledger on success).
 *
 * This is the engine's core money operation — used both at creation (bill in
 * advance) and at renewal (from the billing clock). Provider does only the charge.
 *
 * Thin composition of the two halves above: `plan` (read-only money math) then
 * `commit` (all the writes). Callers that need to inspect or gate the money
 * before it is persisted can call the two directly.
 */
export async function billSubscriptionPeriod(
  input: BillSubscriptionPeriodInput,
  opts: Parameters<typeof commitSubscriptionPeriodInvoice>[1] = {},
): Promise<{ invoice: Invoice; payment: Payment | null; numberDeferred?: boolean }> {
  return commitSubscriptionPeriodInvoice(await planSubscriptionPeriodInvoice(input), opts);
}

/**
 * A queued charge was billed or deleted while an invoice for it was being raised.
 * Carries its HTTP answer, so any route it escapes (cancel, pause, …) replies 409 via the
 * app's error handler.
 */
export class UnbilledChargesChangedError extends Error {
  readonly statusCode = 409;
  readonly errorType = "conflict_error";
  constructor() {
    super(
      "The pending charges changed while we created the invoice. We invoiced nothing. Retry the request.",
    );
    this.name = "UnbilledChargesChangedError";
  }
}

export interface InvoiceLineInput {
  description: string;
  amountMinor: bigint;
  priceId?: string | null;
  quantity?: number;
  /**
   * The CONTRACTED RATE per unit, when the caller knows it — `amount` is the slice actually
   * charged, and on a prorated line the two differ by design (the period columns explain it).
   *
   * Omit it and `createLineItems` falls back to `amount ÷ quantity`, which is what the
   * column held for most of this table before 2026-09-01 and is still the honest answer for
   * a line with no price behind it. See `db/schema/invoices.ts`.
   */
  contractedUnitMinor?: bigint;
  kind?: string;
  /**
   * Service period for THIS line — the per-charge `date_from`/`date_to`, used for
   * revenue recognition. Overrides the invoice-level period passed to `insertLines`,
   * so a manual invoice can carry several charges each covering a different span.
   */
  periodStart?: Date | null;
  periodEnd?: Date | null;
  /** A true-up line (0385). */
  adjustment?: "minimum_spend" | "commitment" | null;
  /**
   * A line that sells credit with no pack price behind it (a manual paid grant): takes no
   * promotional credit, and `taxed_at_use` zero-rates it (`prepaid_credit`).
   */
  creditPack?: "taxed_at_purchase" | "taxed_at_use";
}

/**
 * Create an invoice from arbitrary line items (not derived from a subscription's
 * recurring items). The shared engine behind ad-hoc charges, add-on adds, and
 * manual/one-off invoices. Handles tax, customer-balance credit, the AR/revenue/
 * tax_payable ledger, Net-D due dates, and optional immediate collection.
 *
 * Negative subtotal → a credit memo (revenue debit / customer_balance credit),
 * e.g. crediting unused time when an add-on is removed mid-period.
 */
export async function createInvoiceFromLines(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  subscriptionId?: string;
  currency: string;
  lines: InvoiceLineInput[];
  applyTax?: boolean;
  country?: string | null;
  /**
   * Free-text state name. Kept for callers that pass it, but NOT used for tax: place of
   * supply is decided by comparing subdivision CODES against the seller's own state, and
   * a display name ("Karnataka") cannot be compared to a code ("KA"). Pass `stateCode`.
   */
  state?: string | null;
  /** ISO-3166-2 subdivision code — the place of supply. Falls back to the customer's. */
  stateCode?: string | null;
  applyCredit?: boolean;
  /** Suppress the credit-draw customer_changed + invoice_updated: set when
   *  a credit note was CREATED in this same request (its create already emitted them —
   *  e.g. plan-change term reset). Leave false when drawing a PRE-EXISTING credit
   *  (renewal / subscribe-after-cancel), where the draw is the only balance event. */
  suppressCreditDrawEvents?: boolean;
  /**
   * Discount these lines with the subscription's active coupons. A plan change is
   * billed with the SAME coupons that discounted the original term — a 10% forever
   * coupon turns a 64900 upgrade into 58410 — but this shared engine had no coupon
   * step at all, so every proration invoice charged list price.
   *
   * Opt-in, and requires `subscriptionId`: the other callers (ad-hoc charges,
   * add-on adds, manual/one-off invoices) must stay list-priced, and leaving the
   * default off keeps them byte-identical.
   *
   * Consumes the redemption when the coupon actually discounts, same rule as
   * billSubscriptionPeriod — otherwise a `once` coupon applied mid-term (still
   * `active`, since only billing consumes it) would discount the change invoice AND
   * the next renewal. The cost is that a term-reset change spends one period of a
   * limited-period coupon; that is defensible (a reset IS a new billing cycle) and is
   * the decision that stands.
   *
   * Silently skipped when any line is negative — see `hasCreditLines` below.
   */
  applyCoupons?: boolean;
  dueDate?: Date | null;
  collect?: boolean;
  subscription?: typeof subscriptions.$inferSelect;
  periodStart?: Date;
  periodEnd?: Date;
  /**
   * Post-H (#5): a per-operation idempotency token stamped on the invoice atomically
   * at creation (unique per business). Used by delta operations (change_term_end
   * extension) so a crash-retry reuses the invoice instead of double-charging. On a
   * unique collision the existing invoice for the token is returned unchanged.
   */
  originToken?: string | null;
  /**
   * Subscription-item ids (internal uuids) whose billing cycle THIS invoice
   * consumes — `cycles_billed` is incremented for each, inside the invoice
   * transaction (bug, 2026-08-03).
   *
   * The period planner increments `cycles_billed` itself for every item it bills;
   * an item billed OUTSIDE that planner (a mid-term one-time add, charged in full
   * by `addSubscriptionItem`) has to say so, or the cap sees an item that has
   * never been billed and the next renewal bills it again. In-transaction with the
   * invoice on purpose: the record "this item has been billed" must land with the
   * invoice that bills it, or a crash in between re-bills the customer.
   *
   * Only pass ids for items this invoice's lines actually cover, and only when the
   * charge is a WHOLE cycle — a prorated add is a slice of a cycle the renewal
   * still bills, so the recurring add path deliberately passes nothing.
   */
  markItemsBilled?: string[];
  /**
   * Unbilled-charge ids (internal uuids) these lines invoice. Each must still be `pending`;
   * they flip to `billed` inside the invoice transaction, and if any was billed or deleted
   * meanwhile the whole invoice rolls back with `UnbilledChargesChangedError`.
   */
  markUnbilledChargesBilled?: string[];
  /** Buyer's PO reference. Set → wins over the subscription-inherited one. */
  poNumber?: string;
  /** With `collect`: charge this saved method (`pm_…`) only. */
  paymentMethodOverrideId?: string;
  /** A failed charge holds its first retry until this instant (`failed_change_charge`). */
  retryHoldUntil?: Date | null;
  /** Runs last inside the invoice transaction (a manual paid credit grant books its grant here). */
  inTx?: (
    tx: Tx,
    created: { invoice: Invoice; lines: Array<{ id: string; amountMinor: bigint }> },
  ) => Promise<void>;
}): Promise<{ invoice: Invoice; payment: Payment | null }> {
  const { organizationId, businessId, customerId, currency } = input;
  // Fast path for the idempotency token: if an invoice already carries it, reuse it.
  if (input.originToken) {
    const [existing] = await withTenant(organizationId, (tx) =>
      tx
        .select()
        .from(invoices)
        .where(
          and(eq(invoices.businessId, businessId), eq(invoices.originToken, input.originToken!)),
        )
        .limit(1),
    );
    if (existing) {
      // OWNERSHIP CHECK (finale review blocker): a reused Idempotency-Key across
      // different customers/subscriptions must be an error, never another
      // customer's invoice handed back (cross-customer leak + free operation).
      if (
        existing.customerId !== customerId ||
        (input.subscriptionId ?? null) !== (existing.subscriptionId ?? null)
      ) {
        throw new Error(
          "Idempotency token was already used for a different customer/subscription — use a fresh key",
        );
      }
      // A voided token-invoice means the prior operation was undone — a reused
      // key must not silently ride the dead invoice into a free operation.
      if (existing.status === "voided") {
        throw new Error("Idempotency token belongs to a voided invoice — use a fresh key");
      }
      // Crash-retry resume: the prior run created the invoice but may have died
      // before collection. Finish the job instead of returning it stranded open.
      if (input.collect && isOpenInvoiceStatus(existing.status)) {
        const [subRow] = input.subscriptionId
          ? await withTenant(organizationId, (tx) =>
              tx
                .select()
                .from(subscriptions)
                .where(eq(subscriptions.id, input.subscriptionId!))
                .limit(1),
            )
          : [undefined];
        const payment = await collectInvoice({
          organizationId,
          businessId,
          invoice: existing,
          subscription: subRow,
          ...(input.paymentMethodOverrideId
            ? { paymentMethodOverrideId: input.paymentMethodOverrideId }
            : {}),
        });
        const fresh = await withTenant(
          organizationId,
          async (tx) =>
            (await tx.select().from(invoices).where(eq(invoices.id, existing.id)).limit(1))[0]!,
        );
        return { invoice: fresh, payment };
      }
      return { invoice: existing, payment: null };
    }
  }
  const now = stampNow(businessId);
  /**
   * Due on the INVOICE DATE unless the caller set a Net-D date (2026-08-31).
   *
   * Same rule as `planSubscriptionPeriodInvoice`: `due_date` = the invoice date for a
   * zero-net-term invoice, and the proration invoice a mid-term plan change raises is
   * no exception — its own date, with `next_retry_at` = that date + the first retry
   * interval. Ours wrote NULL here for every ad-hoc, proration, item-add and manual
   * invoice, so nothing had an anchor to dun from.
   *
   * ── AND IT NOW RESOLVES THE NET-D CHAIN (2026-09-01) ─────────────────────────
   * It did not, and only an explicit `input.dueDate` deferred anything — so a Net-30
   * customer got 30 days on their renewal and ZERO on the proration invoice a mid-term
   * change raised, then was dunned on it immediately. That contradicts the terms they were
   * sold, on the one invoice they did not expect.
   *
   * Same precedence as `planSubscriptionPeriodInvoice`: subscription overrides customer,
   * which overrides the business default, with `0`/null meaning "no terms here, fall
   * through". Resolved by the shared `resolveNetTermDays` so the two paths cannot answer
   * the question differently.
   *
   * ⚠️ It is a real behaviour change, not a null being defaulted: such an invoice is now
   * born `posted` (not yet due) and `due.ts` moves it to `payment_due` when the date
   * arrives — which is what `posted` has always meant, and why the offline-dunning work
   * made that transition emit `invoice_payment_due`. An explicit `input.dueDate` still
   * wins, so a caller that has already decided is untouched.
   */
  const netDays = await resolveNetTermDays({
    organizationId,
    businessId,
    subscriptionId: input.subscriptionId ?? null,
    customerId: input.customerId,
  });
  const dueDate = input.dueDate ?? (netDays ? new Date(now.getTime() + netDays * 86_400_000) : now);
  const subtotal = input.lines.reduce((s, l) => s + l.amountMinor, 0n);

  /**
   * Credits Flexibility ceilings (0219), resolved OUTSIDE the invoice transaction for the
   * same reason the tax determination is: it is a read, and it does not depend on the
   * amount. Only when credit is actually being drawn — with `applyCredit` off the buckets
   * are handed in as zeroes and no ceiling could change the outcome.
   *
   * ── Invoice class: `subscriptionId` decides it ────────────────────────────────
   * This one function raises three different kinds of bill: a proration or item-add for a
   * subscription, a manual/ad-hoc invoice for a customer, and a one-off charge. RECURRING
   * and ONE-TIME invoices are configured separately, and the line drawn is whether the
   * invoice belongs to a subscription — a mid-term proration is part of that
   * subscription's recurring billing, not a one-off. So an invoice with a
   * `subscriptionId` reads the `recurring` slots (and picks up that subscription's own
   * maxima); one without reads `one_time`.
   */
  const creditLimits = input.applyCredit
    ? await loadCreditApplicationLimits({
        organizationId,
        businessId,
        subscriptionId: input.subscriptionId ?? null,
      })
    : UNLIMITED_CREDIT_LIMITS;

  // Credits are NEVER negative invoices (ADR-009): a customer credit must be a
  // real credit note issued against a source invoice. Callers that owe the
  // customer (downgrade, item removal, term shortening) go through
  // issueCurrentTermCredit / the credit-notes service instead.
  if (subtotal < 0n) {
    throw new Error(
      "createInvoiceFromLines: negative subtotal — issue a credit note, not a negative invoice",
    );
  }

  // Honor customer tax-exemption + withholding (TDS) on manual invoices too.
  const [cust] = await withTenant(organizationId, async (tx) =>
    tx.select().from(customers).where(eq(customers.id, customerId)).limit(1),
  );
  const exempt = cust?.taxExempt === true;
  const taxReason = exempt ? "customer_exempt" : "standard_rated";
  // Resolve the component vector ONCE, outside the promo clamp loop below — it is a
  // DB read now, and the determination does not depend on the amount. Explicit
  // country/state on the input win over the customer's own address (a manual invoice
  // may be raised for a different place of supply); `stateCode` is preferred over the
  // legacy free-text `state`, which cannot be compared to the seller's state code.
  const manualResolution: TaxResolution =
    input.applyTax && !exempt
      ? await getTaxProvider().resolve({
          organizationId,
          businessId,
          country: input.country ?? cust?.country,
          stateCode: input.stateCode ?? cust?.stateCode,
          treatment: cust?.taxTreatment as TaxTreatment | undefined,
          customerTaxBehavior: cust?.taxBehavior,
        })
      : await getTaxProvider().resolve({ organizationId, businessId, customerExempt: true });
  // ── TAXABILITY IS PER LINE (Q-1 / F-4, 2026-08-26) ──────────────────────────────
  // This function used to tax the WHOLE subtotal with one invoice-level determination and
  // add it on top, whatever the lines said. Two consequences, both measured:
  //   Q-1 — a price marked `is_taxable = false` is exempt on renewal invoices and taxed
  //         anyway on every proration, item-add, manual, resume and unbilled invoice, with
  //         `applied_taxes` stamping the line `standard_rated`.
  //   F-4 — a tax-INCLUSIVE price is billed exclusively here, so the customer pays the rate
  //         on top of an amount that already contained it.
  // `billSubscriptionPeriod` had neither, because it goes through `computeInvoiceTax`,
  // which resolves per line and pools by (resolution, inclusive). Two invoice builders, one
  // of them correct — the same shape as every other finding in this audit. This one now
  // asks the same function instead of re-deriving a second, simpler answer.
  //
  // Read once, outside the promo clamp loop, for the reason `manualResolution` is: it is a
  // DB read and the determination does not depend on the amount.
  const linePriceIds = [
    ...new Set(input.lines.map((l) => l.priceId).filter((v): v is string => !!v)),
  ];
  const priceTaxById = new Map<string, { isTaxable: boolean; inclusive: boolean }>();
  // Credit packs taxed at use: the sale is zero-rated, the credit is taxed when spent.
  const prepaidPriceIds = new Set<string>();
  if (linePriceIds.length > 0) {
    const rows = await withTenant(organizationId, async (tx) =>
      tx
        .select({
          id: prices.id,
          isTaxable: prices.isTaxable,
          taxBehavior: prices.taxBehavior,
          grantsCredit: prices.grantsCredit,
        })
        .from(prices)
        .where(inArray(prices.id, linePriceIds)),
    );
    for (const r of rows) {
      priceTaxById.set(r.id, { isTaxable: r.isTaxable, inclusive: r.taxBehavior === "inclusive" });
      if (r.grantsCredit?.kind === "pack" && r.grantsCredit.tax_treatment === "taxed_at_use")
        prepaidPriceIds.add(r.id);
    }
  }
  /**
   * A line with NO price — manual text, an ad-hoc charge, a rounding line — stays taxable
   * and exclusive, which is exactly what this path has always assumed. Only a line that
   * names a price can carry a different answer, and now it does.
   */
  const taxableLinesFor = (): TaxableLine[] =>
    input.lines.map((l, i) => {
      const pt = l.priceId ? priceTaxById.get(l.priceId) : undefined;
      return {
        id: String(i),
        amountMinor: l.amountMinor,
        taxable: pt ? pt.isTaxable : true,
        // The same precedence `resolvePeriodInvoiceMoney` applies.
        inclusive: lineIsInclusive(manualResolution, pt?.inclusive ?? false),
        resolution:
          l.creditPack === "taxed_at_use" || (l.priceId && prepaidPriceIds.has(l.priceId))
            ? prepaidCreditResolution(manualResolution)
            : manualResolution,
      };
    });

  // D1 balance split: promo reduces the tax base (pre-tax), capped at the subtotal
  // (no coupon here) AND at the collectible amount (withholding). Same clamp logic
  // as billSubscriptionPeriod.
  // Coupons come off the subtotal BEFORE tax (same order as billSubscriptionPeriod).
  // `discountMinor` is 0 unless the caller opted in, so every other path keeps its
  // exact previous arithmetic — including the withholding base, which now reads
  // discountedSubtotal (identical when nothing is discounted, and the right base
  // when something is: TDS applies to what is actually billed).
  const computeTotals = async (promo: bigint, discountMinor: bigint) => {
    const discountedSubtotal = subtotal - discountMinor;
    const taxBase = discountedSubtotal - promo;
    // Per line, pooled by (resolution, inclusive) — one function, shared with the renewal
    // path, so the two builders cannot drift. With every line taxable and exclusive the
    // pool base resolves to `discountedSubtotal - promo` and each component rounds half-up
    // on it, which is byte-identical to the `taxMinorFor` call this replaced.
    const invoiceTax: InvoiceTax = input.applyTax
      ? computeInvoiceTax({
          lines: taxableLinesFor(),
          discountMinor: discountMinor + promo,
          subtotalMinor: subtotal,
          customerExempt: exempt,
        })
      : { additiveTaxMinor: 0n, inclusiveTaxMinor: 0n, totalTaxMinor: 0n, rows: [] };
    const tax = { taxMinor: invoiceTax.totalTaxMinor, resolution: manualResolution };
    // Only EXCLUSIVE tax increases the total; inclusive tax is already inside the amounts.
    const total = discountedSubtotal + invoiceTax.additiveTaxMinor;
    const whRateBps = cust?.withholdingRateBps ?? 0;
    const withholdingMinor =
      whRateBps > 0 && discountedSubtotal > 0n
        ? (discountedSubtotal * BigInt(whRateBps)) / 10000n
        : 0n;
    return {
      tax,
      invoiceTax,
      total,
      withholdingMinor,
      collectible: total - withholdingMinor,
      discountedSubtotal,
    };
  };

  let invoice: Invoice;
  let fullyPaid: boolean;
  try {
    const r = await withTenant(organizationId, async (tx) => {
      // Over-draw guard (review fix 2026-07-04): lock + read the buckets inside the tx.
      if (input.applyCredit) await lockCustomerBalances(tx, customerId);
      const balances: CustomerBalances = input.applyCredit
        ? await bucketBalancesForCurrency(organizationId, customerId, currency, tx)
        : { promotional: 0n, refundable: 0n, excess: 0n };

      // Resolve each line's product so `each_specified_item` coupons can match it
      // (invoice-level coupons ignore this). Lines with no priceId — tax, manual
      // text — simply match nothing.
      // A line set containing CREDIT lines (the non-reset proration path nets "Unused
      // time on X" against "Remaining time on Y" in one invoice) cannot be discounted
      // here: computeStackedDiscounts floors every line at 0, so it would take the
      // coupon off the GROSS charge while `subtotal` is already NET. On 10→11 seats at
      // 1000/seat with a 10% coupon that is a 550 discount on a 500 subtotal — a
      // negative total whose AR line is skipped, leaving revenue 500 against discounts
      // 550 and an UNBALANCED ledger entry, thrown after the item updates have already
      // committed in an earlier transaction (upgraded subscription, no invoice).
      // Netting the coupon across credit lines correctly is real work and is not done
      // yet. Until then these invoices stay list-priced, exactly as they were before.
      const hasCreditLines = input.lines.some((l) => l.amountMinor < 0n);
      const discStack =
        input.applyCoupons && input.subscriptionId && !hasCreditLines
          ? await (async () => {
              const priceIds = [
                ...new Set(input.lines.map((l) => l.priceId).filter((p): p is string => !!p)),
              ];
              const prodRows = priceIds.length
                ? await tx
                    .select({
                      priceId: prices.id,
                      kind: products.kind,
                      productPublicId: products.publicId,
                      pricePublicId: prices.publicId,
                    })
                    .from(prices)
                    .innerJoin(products, eq(prices.productId, products.id))
                    .where(inArray(prices.id, priceIds))
                : [];
              const byPrice = new Map(prodRows.map((r) => [r.priceId, r]));
              // 0247. The same anchor the settle below uses — the subscription's CURRENT
              // period, because these lines are an adjustment inside it. Null only for an
              // ad-hoc invoice with no period behind it, where there is no allowance.
              const allowancePeriod = input.subscription?.currentPeriodStart ?? null;
              return peekDiscounts(
                tx,
                input.subscriptionId!,
                input.lines.map((l, i) => {
                  const p = l.priceId ? byPrice.get(l.priceId) : undefined;
                  return {
                    index: i,
                    amountMinor: l.amountMinor,
                    productKind: p?.kind,
                    productPublicId: p?.productPublicId,
                    pricePublicId: p?.pricePublicId,
                  };
                }),
                currency,
                undefined,
                allowancePeriod,
              );
            })()
          : null;
      const discountRows = (discStack?.rows ?? []).filter((r) => r.discountMinor > 0n);
      const discountMinor = discStack?.totalMinor ?? 0n;

      // Credit packs take no promotional credit: free credit never buys paid credit.
      const packMinor = await packLinesMinor(tx, input.lines);
      const promoCap =
        subtotal - discountMinor - packMinor > 0n ? subtotal - discountMinor - packMinor : 0n;
      let promoApplied = balances.promotional < promoCap ? balances.promotional : promoCap;
      let totals = await computeTotals(promoApplied, discountMinor);
      for (
        let i = 0;
        i < 4 && promoApplied > (totals.collectible > 0n ? totals.collectible : 0n);
        i++
      ) {
        promoApplied = totals.collectible > 0n ? totals.collectible : 0n;
        totals = await computeTotals(promoApplied, discountMinor);
      }
      const { tax, invoiceTax, total, withholdingMinor, collectible, discountedSubtotal } = totals;
      const { refundable: refundableApplied, excess: excessApplied } = planCreditApplication({
        balances,
        discountedSubtotal,
        postTaxRemaining: collectible - promoApplied,
        limits: creditLimits,
      });
      const creditApplied = promoApplied + refundableApplied + excessApplied;
      const amountDue = collectible - creditApplied;
      const fullyPaid = total === 0n || amountDue === 0n;

      const [inv] = await tx
        .insert(invoices)
        .values({
          organizationId,
          businessId,
          customerId,
          subscriptionId: input.subscriptionId ?? null,
          // This function raises prorations and item-adds for a subscription too;
          // every caller that passes `subscriptionId` also passes the row itself.
          // No `subscriptionId` (a manual/ad-hoc customer invoice) → no `subscription`
          // → `null`, never an inherited value from an unrelated read.
          poNumber:
            input.poNumber ??
            inheritedPoNumber(input.subscription, await poInheritanceEnabled(tx, businessId)),
          // Same due-now rule as billSubscriptionPeriod above: a due date at or before
          // the invoice date means due immediately, i.e. `payment_due`, not `posted`.
          // Compared as dates rather than tested for null
          // because `dueDate` now defaults to `now` — see its declaration.
          publicId: publicId("inv"),
          number: await nextInvoiceNumber(tx, businessId),
          channel: currentChannel(),
          status: fullyPaid ? "paid" : dueDate.getTime() > now.getTime() ? "posted" : "payment_due",
          currency,
          originToken: input.originToken ?? null,
          retryHoldUntil: input.retryHoldUntil ?? null,
          // `sub_total` — gross less the ITEM-level stage only (0169).
          subtotalMinor: subtotal - (discStack?.itemLevelMinor ?? 0n),
          totalMinor: total,
          amountDueMinor: amountDue,
          withholdingMinor,
          promotionalCreditsAppliedMinor: promoApplied,
          refundableCreditsAppliedMinor: refundableApplied,
          excessPaymentsAppliedMinor: excessApplied,
          periodStart: input.periodStart ?? null,
          periodEnd: input.periodEnd ?? null,
          dueDate,
          paidAt: fullyPaid ? now : null,
          // Same frozen determination as the subscription path (see above).
          billingAddress: cust ? customerBillingAddress(cust) : null,
          // Ship-to at issue: the subscription's own address, else the customer's default.
          shippingAddress: await shipToSnapshot(tx, {
            customerId,
            shippingAddressId: input.subscription?.shippingAddressId ?? null,
          }),
          customerTaxId: frozen(customerTaxIdOf(cust)),
          ...(await (async () => {
            const [bizRow] = await tx
              .select()
              .from(businesses)
              .where(eq(businesses.id, businessId))
              .limit(1);
            const seller = await sellerAtIssue(
              tx,
              organizationId,
              bizRow,
              input.country ?? cust?.country,
            );
            return {
              sellerName: seller.name,
              sellerAddress: seller.address,
              sellerTaxId: seller.id,
              sellerTaxCountry: seller.country,
              notes: frozen(invoiceNotesOf(cust, bizRow)),
            };
          })()),
          priceType: frozen(manualResolution.priceType),
          // The terms behind `due_date`; none when the caller fixed the date itself.
          netTermDays: input.dueDate ? null : netDays,
          finalizedAt: sql`app_now()`,
          sellerStateCode: manualResolution.sellerStateCode,
          placeOfSupplyCode: manualResolution.placeOfSupplyCode,
          taxTreatment: manualResolution.treatment,
          taxNote: manualResolution.taxNote,
          // FX snapshot (0228). This path holds no business row — unlike the
          // subscription path, which resolves it at plan time from a row it already
          // loaded — so it costs one two-column read, inside the same tx as the insert.
          ...exchangeRateColumns(await loadIssueRate(tx, businessId, currency)),
        })
        .returning();
      const lineDiscounts = input.lines.map(
        (_, i) =>
          (discStack?.lineDiscountByIndex[i] ?? 0n) + (discStack?.invoiceLevelByIndex[i] ?? 0n),
      );
      const insertedLines = await insertLines(
        tx,
        organizationId,
        businessId,
        inv!.id,
        input.lines,
        input.periodStart,
        input.periodEnd,
        lineDiscounts,
      );
      // A credit pack line sells a pending grant; it activates when this invoice is paid.
      if (packMinor > 0n)
        await createPendingPackGrants(tx, {
          organizationId,
          businessId,
          invoice: inv!,
          lines: insertedLines.map((l, i) => ({
            id: l.id,
            priceId: input.lines[i]?.priceId ?? null,
            quantity: input.lines[i]?.quantity ?? 1,
            amountMinor: l.amountMinor,
            discountMinor: lineDiscounts[i] ?? 0n,
            inclusiveTaxMinor: invoiceTax.rows
              .filter((r) => r.inclusive && r.lineId === String(i))
              .reduce((a, r) => a + r.amountMinor, 0n),
          })),
        });
      // `line_item_discounts[]` — same (line, coupon, stage) attribution as the
      // subscription path. `share.lineIndex` indexes `input.lines`, which is the order
      // `insertLines` inserted and returned.
      if (discStack && discStack.shares.length > 0 && insertedLines.length > 0) {
        await tx.insert(invoiceLineDiscounts).values(
          discStack.shares
            .filter((s) => insertedLines[s.lineIndex] != null)
            .map((s) => ({
              organizationId,
              businessId,
              invoiceId: inv!.id,
              invoiceLineItemId: insertedLines[s.lineIndex]!.id,
              appliedCouponId: s.appliedCouponId,
              label: s.label,
              scope: s.scope,
              amountMinor: s.amountMinor,
            })),
        );
      }
      // Count this invoice against the cycle cap of the items it bills outside the
      // period planner (see `markItemsBilled`) — same increment the planner's
      // finalize tx does, in the same transaction as the invoice that earns it.
      if (input.markItemsBilled?.length) {
        await tx
          .update(subscriptionItems)
          .set({ cyclesBilled: sql`${subscriptionItems.cyclesBilled} + 1` })
          .where(inArray(subscriptionItems.id, input.markItemsBilled));
      }
      if (input.markUnbilledChargesBilled?.length) {
        const marked = await tx
          .update(unbilledCharges)
          .set({ status: "billed", invoiceId: inv!.id })
          .where(
            and(
              inArray(unbilledCharges.id, input.markUnbilledChargesBilled),
              eq(unbilledCharges.status, "pending"),
            ),
          )
          .returning({ id: unbilledCharges.id });
        if (marked.length !== input.markUnbilledChargesBilled.length) {
          throw new UnbilledChargesChangedError();
        }
      }
      // One discount line PER coupon that actually discounted, mirroring
      // billSubscriptionPeriod, shown separately — including consuming the
      // redemption, on the same rule: a period is burned only when the coupon actually
      // reduced the bill. Skipping consumption here would let a `once` coupon discount
      // twice: applied mid-term it is still `active` (only billing consumes it), so an
      // upgrade would take it AND the next renewal would take it again.
      // DOCUMENT-LEVEL portion only — the item-level portion is inside `subtotalMinor`
      // (0169) and a line for the full amount would subtract it twice. Redemption is
      // deliberately NOT gated on the line: see the subscription path's note.
      for (const row of discountRows) {
        if (row.documentLevelMinor > 0n) {
          await tx.insert(invoiceLineItems).values({
            organizationId,
            businessId,
            invoiceId: inv!.id,
            publicId: publicId("il"),
            description: `Discount (${row.label})`,
            priceId: null,
            quantity: 1,
            unitAmountMinor: -row.documentLevelMinor,
            amountMinor: -row.documentLevelMinor,
            kind: "discount",
            appliedCouponId: row.appliedCouponId,
            periodStart: input.periodStart ?? null,
            periodEnd: input.periodEnd ?? null,
          });
        }
        // 0247. These invoices are adjustments INSIDE the subscription's current
        // period, so they draw on that period's remaining allowance and — being the
        // same period — spend none of it. That is the reported defect, fixed at the
        // model rather than by skipping the consume.
        const periodAnchor = input.subscription?.currentPeriodStart ?? null;
        if (periodAnchor != null) {
          await settlePeriodDiscount(tx, row.appliedCouponId, {
            periodStart: periodAnchor,
            appliedMinor: row.discountMinor,
          });
        } else {
          // No current period (an ad-hoc customer invoice with no subscription behind
          // it) means there is no allowance to draw on, so the old path stands.
          await consumeDiscount(tx, row.appliedCouponId);
        }
      }
      // ONE amount per component, computed ONCE. It drives both the synthetic tax LINE
      // ITEMS below and the per-line `applied_taxes` rows, so the two cannot disagree.
      // They used to: this base is the invoice's own (`discountedSubtotal - promoApplied`),
      // while `recordLineTaxes` re-derived its own from the POSITIVE lines only. On an
      // invoice carrying a negative proration line the two differ by that line's tax —
      // measured on INV-4, ₹261.98 on the invoice against ₹1,571.92 in `applied_taxes`.
      // The tax LINE ITEMS and the per-line `applied_taxes` rows both come from the one
      // `computeInvoiceTax` result, so they cannot disagree — which is the property the
      // previous comment here claimed and got by re-deriving a second base that agreed only
      // while every line was taxable and exclusive.
      {
        const byComponent = new Map<
          string,
          { name: string; rateBps: number; amountMinor: bigint }
        >();
        for (const r of invoiceTax.rows) {
          // `r.inclusive` SKIPPED, exactly as the renewal path above does. Inclusive tax is
          // already inside the product line, so emitting a tax line for it adds a second copy to
          // the document: a GBP 120.00 inclusive invoice came out with a 120.00 product line AND
          // a 20.00 "VAT (20.00%)" line against a 120.00 total, so the lines sum to 140.00.
          // `total_minor` was right and no money moved — but the document contradicts itself, and
          // `invoice_total_consistent` (critical) reports every such invoice. Its description
          // already states the rule: "Inclusive tax is inside the product lines and correctly has
          // no [tax line]". Routing this path through `computeInvoiceTax` was right; it just did
          // not carry over the skip that the path it was aligned to has. The breakdown a legal
          // invoice needs is not lost — it lives in `applied_taxes`, written for every row
          // regardless, which is where an inclusive invoice has always shown its components.
          //
          // ⚠️ NEGATIVE rows are NOT skipped, and skipping them was a second, separate bug on
          // this path. `taxableLinesFor()` passes EVERY line, so a reversal line — an "Unused
          // time" proration credit, or the document-level discount line the plan-change path
          // sends here — carries a NEGATIVE exclusive row, and `additiveTaxMinor` nets it into
          // `total_minor`. Summing only the positives printed more tax than was charged:
          // measured on INV-3213, rows −164124/+164124/−16920/+33840 netted to ₹169.20 of IGST
          // against a LINE that said ₹1,979.64; on INV-4317, ₹5,455.01 printed against
          // ₹5,390.71 charged. No money moved — the totals were right — but the document does
          // not add up, and on an Indian GST invoice it states an input credit the buyer
          // cannot claim. `invoice_total_consistent` (critical) reported 36 such invoices.
          if (r.inclusive) continue;
          const k = `${r.name}|${r.rateBps}`;
          const acc = byComponent.get(k) ?? { name: r.name, rateBps: r.rateBps, amountMinor: 0n };
          acc.amountMinor += r.amountMinor;
          byComponent.set(k, acc);
        }
        // An India GST invoice must show CGST and SGST/UTGST separately — a single merged
        // "GST (18.00%)" line is not a valid tax invoice.
        for (const c of byComponent.values()) {
          // Net zero ⇒ no line; net negative ⇒ a negative line, so the lines still sum to
          // the total.
          if (c.amountMinor === 0n) continue;
          await tx.insert(invoiceLineItems).values({
            organizationId,
            businessId,
            invoiceId: inv!.id,
            publicId: publicId("il"),
            description: taxComponentLabel(c.name, c.rateBps),
            priceId: null,
            quantity: 1,
            unitAmountMinor: c.amountMinor,
            amountMinor: c.amountMinor,
            kind: "tax",
            periodStart: input.periodStart ?? null,
            periodEnd: input.periodEnd ?? null,
          });
        }
        // `computeInvoiceTax` keys rows by line INDEX (as a string); `insertedLines` is in
        // `lines` order, so the index maps straight back — the same mapping the renewal path
        // uses. A non-taxable line simply has no row, instead of one stamped standard_rated.
        if (invoiceTax.rows.length > 0) {
          await tx.insert(appliedTaxes).values(
            invoiceTax.rows
              .filter((r) => insertedLines[Number(r.lineId)] != null)
              .map((r) => ({
                organizationId,
                businessId,
                invoiceId: inv!.id,
                invoiceLineItemId: insertedLines[Number(r.lineId)]!.id,
                taxComponentId: r.taxComponentId,
                name: r.name,
                rateBps: r.rateBps,
                amountMinor: r.amountMinor,
                taxabilityReason: r.taxabilityReason,
              })),
          );
        }
      }
      if (subtotal > 0n) {
        // Revenue NET of inclusive tax — that portion was never revenue, it was always the
        // authority's. Identical to the old `subtotal` on every exclusive invoice, which is
        // every invoice this path produced before today.
        const ledgerLines: Array<{
          account: string;
          direction: "debit" | "credit";
          amountMinor: bigint;
          currency: string;
        }> = [
          {
            account: "revenue",
            direction: "credit",
            amountMinor: subtotal - invoiceTax.inclusiveTaxMinor,
            currency,
          },
        ];
        // Contra-revenue, same account + direction billSubscriptionPeriod books, so a
        // later issueCurrentTermCredit can read this invoice's own discount back off
        // the ledger when it credits unused time.
        if (discountMinor > 0n)
          ledgerLines.push({
            account: "discounts",
            direction: "debit",
            amountMinor: discountMinor,
            currency,
          });
        if (tax.taxMinor > 0n)
          ledgerLines.push({
            account: "tax_payable",
            direction: "credit",
            amountMinor: tax.taxMinor,
            currency,
          });
        if (withholdingMinor > 0n)
          ledgerLines.push({
            account: "withholding_receivable",
            direction: "debit",
            amountMinor: withholdingMinor,
            currency,
          });
        if (collectible > 0n)
          ledgerLines.push({
            account: "accounts_receivable",
            direction: "debit",
            amountMinor: collectible,
            currency,
          });
        await postEntries(
          {
            organizationId,
            businessId,
            customerId: inv!.customerId,
            sourceType: "invoice",
            sourceId: inv!.publicId,
            lines: ledgerLines,
          },
          tx,
        );
      }
      if (creditApplied > 0n) {
        await postCreditApplications(tx, {
          organizationId,
          businessId,
          customerId,
          invoicePublicId: inv!.publicId,
          currency,
          promotional: promoApplied,
          refundable: refundableApplied,
          excess: excessApplied,
        });
        if (refundableApplied > 0n)
          await allocateRefundableDraw(tx, {
            organizationId,
            businessId,
            customerId,
            invoiceId: inv!.id,
            invoicePublicId: inv!.publicId,
            currency,
            drawMinor: refundableApplied,
            suppressBalanceInvoiceEvents: input.suppressCreditDrawEvents,
          });
      }
      await emitEvent(tx, {
        organizationId,
        businessId,
        type: "invoice_generated",
        // Same `total_minor` the API and the document report — net of the promotional slice,
        // which is presented as a pre-tax discount (see `serializeInvoice`, 2026-08-25).
        data: buildEventData("invoice_generated", {
          id: inv!.publicId,
          total_minor: Number(total - promoApplied),
          currency,
          status: inv!.status,
        }),
      });
      if (total > 0n && amountDue === 0n) {
        await emitEvent(tx, {
          organizationId,
          businessId,
          type: "invoice_paid",
          data: buildEventData(
            "invoice_paid",
            { id: inv!.publicId, amount_minor: Number(total), currency },
            null,
            { paid_with_credit: true },
          ),
        });
        await activatePaidCreditGrants(tx, { organizationId, invoiceId: inv!.id });
      }
      if (input.inTx) await input.inTx(tx, { invoice: inv!, lines: insertedLines });
      return { invoice: inv!, fullyPaid };
    });
    invoice = r.invoice;
    fullyPaid = r.fullyPaid;
  } catch (e: any) {
    // Post-H (#5): a concurrent op stamped the same idempotency token first — reuse
    // its invoice instead of leaving an orphan or double-charging.
    if (
      input.originToken &&
      e?.code === "23505" &&
      String(e?.constraint ?? "").includes("invoices_origin_token_uq")
    ) {
      const [existing] = await withTenant(organizationId, (tx) =>
        tx
          .select()
          .from(invoices)
          .where(
            and(eq(invoices.businessId, businessId), eq(invoices.originToken, input.originToken!)),
          )
          .limit(1),
      );
      if (existing) return { invoice: existing, payment: null };
    }
    throw e;
  }

  /**
   * CP-1, on the ad-hoc/proration path too: an auto-collect-off invoice enters
   * dunning at raise. On a mid-term plan change the proration invoice must come out
   * `payment_due` + `in_progress` with `next_retry_at = its own date + the first retry
   * interval`, exactly like the renewal invoice beside it.
   *
   * Before the collect below, deliberately.
   *
   * ⚠ AND THE COLLECT IS NOW GATED ON IT TOO (2026-09-01). This paragraph used to end by
   * explaining why gating was unnecessary: "an offline invoice with `collect: true` still
   * walks into `collectInvoice`, finds no chargeable instrument and records a failed
   * payment", which `planFailureRearm` absorbs as `send_invoice`. That reasoning holds only
   * while an auto-collect-off customer has NO usable instrument — and "pays by invoice, card
   * on file for backup" is an ordinary configuration, not a corner.
   *
   * The defect: a subscription with `auto_collection: off` and a vaulted card, changed
   * mid-term, was CHARGED 20,184.00 for the proration invoice, which should have been left
   * `payment_due`. The money is the customer's and they had opted out of automatic
   * collection, so this is not a harmless extra attempt — it is a charge nobody asked for.
   *
   * CP-1 is a rule about COLLECTION, and this file's own `isAutoCollectOn` docblock says so
   * in the first line: "'off' → leave the invoice open (send-invoice), don't attempt a
   * charge." The enrolment half was implemented and the charge half was not.
   */
  const offlineHere = !isAutoCollectOn(
    input.subscription?.autoCollection ?? null,
    cust?.autoCollection ?? null,
  );
  const raised = offlineHere
    ? await enrolOfflineInvoiceInDunning({
        organizationId,
        businessId,
        invoice,
        subscriptionStatus: input.subscription?.status ?? null,
        now,
      })
    : invoice;

  // `offlineHere` gates the CHARGE as well as the enrolment above — see the note there for
  // what the ungated version cost. A caller that means "charge this now regardless" has a
  // different door: the operator's `collect_payment`, or the portal's pay route, neither of
  // which comes through here.
  if (fullyPaid || !input.collect || offlineHere) return { invoice: raised, payment: null };
  let payment: Payment | null;
  try {
    payment = await collectInvoice({
      organizationId,
      businessId,
      invoice: raised,
      subscription: input.subscription,
      ...(input.paymentMethodOverrideId
        ? { paymentMethodOverrideId: input.paymentMethodOverrideId }
        : {}),
    });
  } catch (e) {
    // As at renewal: the invoice stands and the clock collects once the notice period
    // ends. It used to escape as a 500 after the invoice was already raised.
    if (!(e instanceof CollectionDeferredError)) throw e;
    payment = null;
  }
  const finalInvoice = await withTenant(organizationId, async (tx) => {
    const [row] = await tx.select().from(invoices).where(eq(invoices.id, invoice.id)).limit(1);
    return row ?? invoice;
  });
  return { invoice: finalInvoice, payment };
}

/**
 * What `createInvoiceFromLines` would raise for these lines with `applyTax` and
 * `applyCredit` on and no coupons — read-only, nothing locked or written. The steps are
 * the ones above in the same order (tax per line, promo pre-tax with its clamp,
 * withholding, then refundable/excess post-tax); a change there must be made here too.
 * `verify:usage-api` asserts the two agree.
 */
export async function previewInvoiceFromLines(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  subscriptionId?: string;
  currency: string;
  lines: InvoiceLineInput[];
  /** Balances to draw from instead of the stored ones — for previewing several invoices in turn. */
  balances?: CustomerBalances;
}): Promise<{
  subtotalMinor: bigint;
  taxMinor: bigint;
  taxLines: Array<{ description: string; amountMinor: bigint }>;
  totalMinor: bigint;
  withholdingMinor: bigint;
  promotionalCreditsAppliedMinor: bigint;
  creditsAppliedMinor: bigint;
  amountDueMinor: bigint;
  /** What remains in each bucket after this invoice's draw. */
  balancesAfter: CustomerBalances;
}> {
  const { organizationId, businessId, customerId, currency } = input;
  const subtotal = input.lines.reduce((s, l) => s + l.amountMinor, 0n);
  const creditLimits = await loadCreditApplicationLimits({
    organizationId,
    businessId,
    subscriptionId: input.subscriptionId ?? null,
  });
  const [cust] = await withTenant(organizationId, async (tx) =>
    tx.select().from(customers).where(eq(customers.id, customerId)).limit(1),
  );
  const exempt = cust?.taxExempt === true;
  const resolution: TaxResolution = !exempt
    ? await getTaxProvider().resolve({
        organizationId,
        businessId,
        country: cust?.country,
        stateCode: cust?.stateCode,
        treatment: cust?.taxTreatment as TaxTreatment | undefined,
        customerTaxBehavior: cust?.taxBehavior,
      })
    : await getTaxProvider().resolve({ organizationId, businessId, customerExempt: true });
  const linePriceIds = [
    ...new Set(input.lines.map((l) => l.priceId).filter((v): v is string => !!v)),
  ];
  const priceTaxById = new Map<string, { isTaxable: boolean; inclusive: boolean }>();
  // Credit packs: no promotional credit; taxed at use = zero-rated (as `createInvoiceFromLines`).
  const packPriceIds = new Set<string>();
  const prepaidPriceIds = new Set<string>();
  if (linePriceIds.length > 0) {
    const rows = await withTenant(organizationId, async (tx) =>
      tx
        .select({
          id: prices.id,
          isTaxable: prices.isTaxable,
          taxBehavior: prices.taxBehavior,
          grantsCredit: prices.grantsCredit,
        })
        .from(prices)
        .where(inArray(prices.id, linePriceIds)),
    );
    for (const r of rows) {
      priceTaxById.set(r.id, { isTaxable: r.isTaxable, inclusive: r.taxBehavior === "inclusive" });
      if (r.grantsCredit?.kind === "pack") {
        packPriceIds.add(r.id);
        if (r.grantsCredit.tax_treatment === "taxed_at_use") prepaidPriceIds.add(r.id);
      }
    }
  }
  const taxableLines: TaxableLine[] = input.lines.map((l, i) => {
    const pt = l.priceId ? priceTaxById.get(l.priceId) : undefined;
    return {
      id: String(i),
      amountMinor: l.amountMinor,
      taxable: pt ? pt.isTaxable : true,
      inclusive: lineIsInclusive(resolution, pt?.inclusive ?? false),
      resolution:
        l.creditPack === "taxed_at_use" || (l.priceId && prepaidPriceIds.has(l.priceId))
          ? prepaidCreditResolution(resolution)
          : resolution,
    };
  });
  const computeTotals = (promo: bigint) => {
    const invoiceTax = computeInvoiceTax({
      lines: taxableLines,
      discountMinor: promo,
      subtotalMinor: subtotal,
      customerExempt: exempt,
    });
    const total = subtotal + invoiceTax.additiveTaxMinor;
    const whRateBps = cust?.withholdingRateBps ?? 0;
    const withholdingMinor =
      whRateBps > 0 && subtotal > 0n ? (subtotal * BigInt(whRateBps)) / 10000n : 0n;
    return { invoiceTax, total, withholdingMinor, collectible: total - withholdingMinor };
  };
  const balances =
    input.balances ?? (await bucketBalancesForCurrency(organizationId, customerId, currency));
  const packMinor = input.lines.reduce(
    (s, l) => s + (l.creditPack || (l.priceId && packPriceIds.has(l.priceId)) ? l.amountMinor : 0n),
    0n,
  );
  const promoCap = subtotal - packMinor > 0n ? subtotal - packMinor : 0n;
  let promoApplied = balances.promotional < promoCap ? balances.promotional : promoCap;
  let totals = computeTotals(promoApplied);
  for (
    let i = 0;
    i < 4 && promoApplied > (totals.collectible > 0n ? totals.collectible : 0n);
    i++
  ) {
    promoApplied = totals.collectible > 0n ? totals.collectible : 0n;
    totals = computeTotals(promoApplied);
  }
  const { refundable, excess } = planCreditApplication({
    balances,
    discountedSubtotal: subtotal,
    postTaxRemaining: totals.collectible - promoApplied,
    limits: creditLimits,
  });
  const byComponent = new Map<string, { description: string; amountMinor: bigint }>();
  for (const r of totals.invoiceTax.rows) {
    if (r.inclusive) continue;
    const k = `${r.name}|${r.rateBps}`;
    const acc = byComponent.get(k) ?? {
      description: taxComponentLabel(r.name, r.rateBps),
      amountMinor: 0n,
    };
    acc.amountMinor += r.amountMinor;
    byComponent.set(k, acc);
  }
  return {
    subtotalMinor: subtotal,
    taxMinor: totals.invoiceTax.totalTaxMinor,
    taxLines: [...byComponent.values()].filter((c) => c.amountMinor !== 0n),
    totalMinor: totals.total,
    withholdingMinor: totals.withholdingMinor,
    promotionalCreditsAppliedMinor: promoApplied,
    creditsAppliedMinor: refundable + excess,
    amountDueMinor: totals.collectible - promoApplied - refundable - excess,
    balancesAfter: {
      ...balances,
      promotional: balances.promotional - promoApplied,
      refundable: balances.refundable - refundable,
      excess: balances.excess - excess,
    },
  };
}

/**
 * Record the per-line tax breakdown into `applied_taxes`, one row PER COMPONENT per
 * line — so an India GST line yields CGST + SGST/UTGST rows, and the invoice can print
 * the breakdown the law requires.
 *
 * Each component's total is allocated across taxable lines by largest remainder, so
 * every component reconciles exactly to its own share; the components are computed on
 * the same base and in the same order as the tax line items, so the two agree.
 *
 * When tax is zero but there is an explicit non-standard reason (customer_exempt,
 * zero_rated export, reverse_charge) it writes a zero-rate row per taxable line, so a
 * zero-tax invoice still says WHY rather than looking unconfigured.
 */
async function recordLineTaxes(
  tx: Tx,
  ctx: { organizationId: string; businessId: string; invoiceId: string },
  lines: Array<{ id: string; amountMinor: bigint; taxable: boolean }>,
  tax: { taxMinor: bigint; resolution: TaxResolution },
  reason: string,
  /**
   * The component totals the INVOICE used, in `resolution.components` order — the same
   * array its tax line items were built from. Supplied so the rows reconcile to the
   * invoice by construction instead of being re-derived here from a different base.
   */
  componentAmounts: bigint[],
): Promise<void> {
  const base = {
    organizationId: ctx.organizationId,
    businessId: ctx.businessId,
    invoiceId: ctx.invoiceId,
    taxComponentId: null as string | null,
  };
  const positive = lines.filter((l) => l.amountMinor > 0n);
  type Row = typeof appliedTaxes.$inferInsert;
  const rows: Row[] = [];
  const { resolution } = tax;
  if (reason === "customer_exempt") {
    // Whole-customer exemption: every positive line is zero-rated with the reason.
    for (const l of positive) {
      rows.push({
        ...base,
        invoiceLineItemId: l.id,
        name: "Exempt",
        rateBps: 0,
        amountMinor: 0n,
        taxabilityReason: "customer_exempt",
      });
    }
  } else if (tax.taxMinor > 0n && resolution.components.length > 0) {
    // SIGNED, not `positive`. A negative line here is a real supply being REVERSED
    // ("Unused time on …" on a proration invoice), so it owes negative tax; dropping it
    // left the rows summing to the tax on the positive side alone while the invoice
    // header taxed the net. Measured on INV-4: Σ applied_taxes 1,571.92 against
    // total−subtotal 261.98, a ₹1,309.94 overstatement in the one table a GSTR-1 export
    // reads. Zero-amount lines still carry no row — nothing was supplied.
    const taxableLines = lines.filter((l) => l.taxable && l.amountMinor !== 0n);
    for (const [i, c] of resolution.components.entries()) {
      const componentTotal = componentAmounts[i] ?? 0n;
      if (componentTotal === 0n) continue;
      for (const a of allocateTaxAcrossSignedLines(taxableLines, componentTotal, c.rateBps)) {
        rows.push({
          ...base,
          taxComponentId: c.taxComponentId,
          invoiceLineItemId: a.lineId,
          name: c.name,
          rateBps: c.rateBps,
          amountMinor: a.amountMinor,
          taxabilityReason: "standard_rated",
        });
      }
    }
    for (const l of lines.filter((l) => !l.taxable && l.amountMinor > 0n)) {
      rows.push({
        ...base,
        invoiceLineItemId: l.id,
        name: "Exempt",
        rateBps: 0,
        amountMinor: 0n,
        taxabilityReason: "product_exempt",
      });
    }
  } else if (
    resolution.taxabilityReason === "zero_rated" ||
    resolution.taxabilityReason === "reverse_charge"
  ) {
    // Zero-rated export / SEZ, or reverse charge: no money, but a legally meaningful
    // statement about the supply. Recording it is the whole point.
    const label =
      resolution.taxabilityReason === "reverse_charge" ? "Reverse charge" : "Zero-rated";
    for (const l of positive.filter((l) => l.taxable)) {
      rows.push({
        ...base,
        invoiceLineItemId: l.id,
        name: label,
        rateBps: 0,
        amountMinor: 0n,
        taxabilityReason: resolution.taxabilityReason,
      });
    }
  }
  if (rows.length > 0) await tx.insert(appliedTaxes).values(rows);
}

/**
 * Line kinds that classify no supply, so they carry no HSN/SAC.
 *
 * A discount, a tax line or a rounding adjustment is an arithmetic artifact of the
 * invoice, not a service anyone sold. Stamping the business's default code onto one
 * would assert that ₹-500 of "998314" changed hands, which is worse than a blank.
 */
const NON_SUPPLY_LINE_KINDS: ReadonlySet<string> = new Set(["discount", "tax", "rounding"]);

/**
 * The precedence rule itself, separated from the two queries that feed it: the PRICE
 * POINT's own code, else the product's, else the business default, else nothing — and
 * never anything on a line that classifies no supply.
 *
 * The price level is the finest — an HSN belongs on the price.
 * It is not redundant with the product's: one product sold as a hosted subscription
 * (SAC 998314, a service) and as a downloadable licence (a goods HSN) has two codes and
 * one product row.
 *
 * Pure and exported so the rule can be pinned by a unit test. It decides what a legal
 * document asserts about what was sold, and the four-way precedence is exactly the kind
 * of thing that survives a refactor by accident rather than by test.
 */
export function __taxCodeForLine(
  kind: string,
  priceTaxCode: string | null | undefined,
  productTaxCode: string | null | undefined,
  businessDefault: string | null,
): string | null {
  if (NON_SUPPLY_LINE_KINDS.has(kind)) return null;
  // `??` and not `||` at every step: a row whose code is null falls THROUGH to the next
  // level rather than terminating the chain, and a line with no price behind it (a manual
  // charge on an Indian invoice) still reaches the business default rather than shipping
  // blank.
  return priceTaxCode ?? productTaxCode ?? businessDefault;
}

/**
 * The HSN/SAC code to stamp on each line, by index — the price's own, else the
 * product's, else the business default, else null.
 *
 * Resolved HERE rather than at read time because the column is a snapshot: see the
 * comment on `invoice_line_items.tax_code`. Two queries regardless of line count (one
 * business row, one batched price→product join that reads BOTH codes), and both are
 * skipped for the kinds that can never carry a code.
 */
async function resolveLineTaxCodes(
  tx: Tx,
  businessId: string,
  lines: InvoiceLineInput[],
): Promise<Array<string | null>> {
  const classifiable = lines.filter((l) => !NON_SUPPLY_LINE_KINDS.has(l.kind ?? "one_time"));
  if (classifiable.length === 0) return lines.map(() => null);

  const [biz] = await tx
    .select({ defaultTaxCode: businesses.defaultTaxCode })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  const fallback = biz?.defaultTaxCode ?? null;

  const priceIds = [...new Set(classifiable.map((l) => l.priceId).filter((v): v is string => !!v))];
  // Both codes in the one join — the precedence rule needs the price's own and the
  // product's, and reading them separately would be a second query for the same row.
  const byPrice = new Map<string, { price: string | null; product: string | null }>();
  if (priceIds.length > 0) {
    const rows = await tx
      .select({
        priceId: prices.id,
        priceTaxCode: prices.taxCode,
        productTaxCode: products.taxCode,
      })
      .from(prices)
      .innerJoin(products, eq(prices.productId, products.id))
      .where(inArray(prices.id, priceIds));
    for (const r of rows)
      byPrice.set(r.priceId, { price: r.priceTaxCode, product: r.productTaxCode });
  }

  return lines.map((l) => {
    const codes = l.priceId ? byPrice.get(l.priceId) : undefined;
    return __taxCodeForLine(l.kind ?? "one_time", codes?.price, codes?.product, fallback);
  });
}

async function insertLines(
  tx: Tx,
  organizationId: string,
  businessId: string,
  invoiceId: string,
  lines: InvoiceLineInput[],
  periodStart?: Date,
  periodEnd?: Date,
  /**
   * Discount attributed to each line, by index — BOTH waterfall stages, matching
   * `line_items[].discount_amount` (0169). Omitted where no coupon stack applies (credit
   * memos, reversals), which leaves the column at its 0 default.
   */
  discountByIndex?: bigint[],
): Promise<Array<{ id: string; amountMinor: bigint }>> {
  if (lines.length === 0) return [];
  const taxCodes = await resolveLineTaxCodes(tx, businessId, lines);
  return tx
    .insert(invoiceLineItems)
    .values(
      lines.map((l, i) => ({
        organizationId,
        businessId,
        invoiceId,
        publicId: publicId("il"),
        description: l.description,
        priceId: l.priceId ?? null,
        quantity: l.quantity ?? 1,
        /**
         * The CONTRACTED RATE when the caller knows it, else `amount ÷ quantity`.
         *
         * This one expression is where every proration, ad-hoc and manual line's unit came
         * from — the ~20 `unitAmountMinor:` values proration.ts computes were DISCARDED
         * here, which is how a single division came to define the column for most of the
         * table. See `db/schema/invoices.ts` for what the column means and why it drifted.
         *
         * The fallback is kept deliberately rather than made mandatory: a line with no
         * price behind it (a document-level discount row, a rounding delta) has no
         * contracted rate to state, and inventing one would be a fourth convention. A
         * caller that DOES know the rate now passes `contractedUnitMinor` and it wins.
         */
        unitAmountMinor:
          l.contractedUnitMinor ??
          (l.quantity && l.quantity > 0 ? l.amountMinor / BigInt(l.quantity) : l.amountMinor),
        amountMinor: l.amountMinor,
        discountMinor: discountByIndex?.[i] ?? 0n,
        kind: l.kind ?? "one_time",
        taxCode: taxCodes[i] ?? null,
        // Per-line period wins; the invoice-level args stay the default so every
        // existing caller (subscription periods, prorations) is unaffected.
        periodStart: l.periodStart ?? periodStart ?? null,
        periodEnd: l.periodEnd ?? periodEnd ?? null,
        adjustment: l.adjustment ?? null,
      })),
    )
    .returning({ id: invoiceLineItems.id, amountMinor: invoiceLineItems.amountMinor });
}

/**
 * How long a collection claim stays valid before another collector may take it.
 *
 * Longer than any gateway call we make (the HTTP clients cap well under a minute), so a
 * live attempt is never stolen mid-charge — that would produce exactly the double charge
 * the claim exists to prevent. Short enough that a worker killed between claiming and
 * releasing does not strand the invoice for a billing cycle.
 */
const COLLECTION_CLAIM_STALE_MS = 15 * 60 * 1000;

/**
 * Another collector is already charging this invoice.
 *
 * Thrown rather than returning some stand-in Payment: at the moment the claim is lost the
 * winner is mid-gateway-call, so there IS no outcome to report, and inventing one (the
 * previous attempt, an empty failure) would be read as this attempt's result. Automated
 * callers treat it as "skip, the other collector owns this pass"; operator-facing ones
 * surface it.
 */
export class CollectionInFlightError extends Error {
  constructor(public readonly invoicePublicId: string) {
    super(`A collection attempt is already in flight for invoice ${invoicePublicId}`);
    this.name = "CollectionInFlightError";
  }
}

/**
 * The debit must wait for a gateway pre-debit notice (`preDebitGate`). Nothing was booked
 * and `next_attempt_at` is set to `until`, so the clock collects then. A subclass of
 * {@link CollectionInFlightError} so every automated caller already backs off on it; a
 * caller with a person waiting shows `message` instead.
 */
export class CollectionDeferredError extends CollectionInFlightError {
  constructor(
    invoicePublicId: string,
    public readonly until: Date,
    now: Date,
  ) {
    super(invoicePublicId);
    const hours = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 3_600_000));
    this.message =
      "This payment method needs an advance notice to the bank before each payment. " +
      `We sent the notice, and we will collect this invoice automatically in about ${hours} ` +
      `${hours === 1 ? "hour" : "hours"}. You do not need to do anything.`;
    this.name = "CollectionDeferredError";
  }
}

/**
 * Take the invoice's collection claim, or report that someone else holds it.
 *
 * The conditional UPDATE is the whole mechanism: Postgres serialises the two writers on
 * the row, so exactly one sees `collecting_at` free and the loser's WHERE matches nothing.
 * Same idiom the due pass already uses to claim on `next_attempt_at` (`due.ts`), applied
 * one level down so EVERY collection path is covered rather than just that one. Several
 * callers reach `collectInvoice` by different routes — the due pass, an operator's
 * "collect now", the customer-level collect, and (until its removal) the shadow poller's
 * replay — and only this chokepoint sees all of them.
 */
export async function claimCollection(
  organizationId: string,
  invoiceId: string,
  now: Date,
): Promise<boolean> {
  const stale = new Date(now.getTime() - COLLECTION_CLAIM_STALE_MS);
  return withTenant(organizationId, async (tx) => {
    const claimed = await tx
      .update(invoices)
      .set({ collectingAt: now })
      .where(
        and(
          eq(invoices.id, invoiceId),
          or(isNull(invoices.collectingAt), lt(invoices.collectingAt, stale)),
        ),
      )
      .returning({ id: invoices.id });
    return claimed.length > 0;
  });
}

/**
 * Release the claim.
 *
 * Unconditional, and deliberately not scoped to "the value I wrote": if our claim already
 * aged out and someone else re-claimed, we have been charging concurrently anyway and the
 * invariant is broken regardless — clearing is what lets the next pass proceed. Never
 * throws: a release that fails must not mask the collection's real outcome.
 */
export async function releaseCollection(organizationId: string, invoiceId: string): Promise<void> {
  try {
    await withTenant(organizationId, (tx) =>
      tx.update(invoices).set({ collectingAt: null }).where(eq(invoices.id, invoiceId)),
    );
  } catch (e) {
    // Stale claims age out on their own (COLLECTION_CLAIM_STALE_MS), so a lost release
    // costs one delayed retry, not a stuck invoice — but a release failing every time
    // means every collection on this box is waiting out the stale window.
    log.warn("collection claim release failed", { invoiceId, error: (e as Error)?.message });
  }
}

/**
 * Thrown by an ON-SESSION collection whose gateway wants the buyer to
 * authenticate. Nothing was recorded: no failed payment, no failure transaction,
 * no dunning — the invoice is untouched and still collectible, and the buyer
 * finishes by completing `intent`'s `next_action` and consuming it.
 *
 * Only reachable when the caller passed `session: 'on_session'`; the billing
 * clock, the dunning pass and every renewal never see it.
 */
export class PaymentActionRequiredError extends Error {
  constructor(
    readonly intent: PaymentIntent,
    readonly attempt: PaymentAttempt | null,
    readonly invoicePublicId: string,
  ) {
    super(
      `Invoice ${invoicePublicId} needs buyer authentication. Complete payment intent ${intent.publicId}.`,
    );
    this.name = "PaymentActionRequiredError";
  }
}

/**
 * The ONE definition of "a payment is a live attempt in flight" — a `payments` row that
 * has not yet reached a terminal state, so charging again would take the money twice.
 *
 * `pendingPaymentForInvoice` and `pendingPaymentsForInvoices` both build their `payments`
 * query on this condition; the invariant checks restate it as raw SQL
 * (`p.status = 'pending'`) because they live outside this module — keep that copy in sync
 * by hand if this one ever changes.
 */
export function paymentInFlightCondition() {
  return eq(payments.status, "pending");
}

/** Attempt to charge an open invoice once; record the payment + ledger. */
/**
 * The still-PENDING payment on this invoice, if any — the double-charge guard, named so
 * more than one caller can ask the question.
 *
 * A pending payment is a LIVE attempt on an async rail (UPI Autopay, a netbanking
 * e-mandate, a card mandate debit) that will settle by webhook, possibly days later. It
 * is neither a success to build on nor a failure to retry, and charging again while one
 * is outstanding takes the money twice.
 *
 * `collectInvoice` has always honoured this inline. It became shared when the portal's
 * "Pay now" was added: that route creates its own intent rather than going through
 * `collectInvoice`, so it bypassed the guard entirely — measured 2026-08-14, a netbanking
 * mandate debit sat `pending` on INV-2142 and Pay-now cheerfully opened a second
 * checkout for the same money.
 */
export async function pendingPaymentForInvoice(
  organizationId: string,
  invoiceId: string,
): Promise<Payment | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.invoiceId, invoiceId), paymentInFlightCondition()))
      .limit(1);
    return row ?? null;
  });
}

/**
 * How many payment attempts this invoice has already BOOKED — the counter behind the
 * gateway idempotency key.
 *
 * Deliberately NOT `invoices.attempt_count`, which the key used to carry. That column is
 * the DUNNING counter and a manual attempt holds it still on purpose (M12), so two
 * presses of "Collect now" / "Pay now" on the same invoice and card rebuilt the SAME key
 * — and a gateway that honours idempotency replayed the first outcome instead of
 * charging. Measured 2026-08-17: three manual collects produced ONE gateway charge and
 * three `payments` rows recording a failure that never happened, so a buyer who topped up
 * their account kept being shown the original decline until the clock's automatic retry
 * moved the counter. (tmtest replays by design — `TmtestProvider.charge` — precisely to
 * catch engine-side key bugs like this one.)
 *
 * Counting the invoice's `payments` rows is the honest measure of "attempts made": every
 * terminal outcome books exactly one (succeeded, failed, or pending awaiting a webhook),
 * rows are never deleted, so the count only ever climbs and no key can repeat. Two
 * properties worth keeping in mind:
 *
 *  - Offline/recorded payments count too. They inflate N without a gateway call, which
 *    costs nothing — the key needs to be UNIQUE per attempt, not to equal the attempt
 *    number an operator sees.
 *  - An attempt that reached the gateway and crashed before booking leaves the count
 *    unmoved, so the retry reuses the key and replays. That is the behaviour we want:
 *    when our own record of the outcome is missing, one charge is strictly better than
 *    two.
 *
 * The KEY FORMAT is unchanged (`inv_<id>_attempt_<N>_<pm>`), and the sequence it produces
 * on the automatic path is the same one as before (first attempt 1, first dunning retry
 * 2, …). It was held fixed because `providers/shadow` PARSED it to identify the invoice;
 * that parser is gone, so no reader constrains the format any more — but it reaches the
 * gateway as an idempotency key, so changing it still needs its own migration story.
 */
export async function bookedAttemptsForInvoice(
  organizationId: string,
  invoiceId: string,
): Promise<number> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select({ n: sql<string>`count(*)` })
      .from(payments)
      .where(eq(payments.invoiceId, invoiceId));
    return Number(row?.n ?? 0);
  });
}

/** What a buyer needs to know about the debit already working on their invoice. */
export interface InFlightPayment {
  /**
   * Which gateway holds it — `payments.provider_key`, or null for a shape that has no
   * payment row (an intent).
   *
   * Here so the portal can tell the buyer the truth about CANCELLING the bank's pending
   * request, which is a per-gateway fact rather than a general one. Measured 2026-09-10:
   * a Stripe India e-mandate debit sits at `requires_action` while its pre-debit
   * notification runs and cancels cleanly from there; RazorPay declares
   * `capabilities.intentVoid: false` and will not void a recurring payment at all. Telling
   * every buyer "we will try, but banks often refuse" was wrong for the Stripe majority.
   */
  gatewayKey: string | null;
  /**
   * The rail has paused this debit for the payer's additional-factor authentication —
   * so it is waiting on THEM, not on us. At any amount: RBI's ₹15,000 is where AFA is
   * compulsory, not where an issuer may ask, and one asked at ₹885 in production.
   *
   * The distinction is the whole reason this field exists: both states look identical
   * from the gateway (RazorPay says `created` for each), but one resolves itself in
   * minutes and the other never resolves unless the buyer acts. Rendering "Payment
   * processing…" over the second one tells someone to wait for something that is
   * waiting for them.
   *
   * For an INTENT (`kind: 'intent'`) it carries the same meaning derived from the
   * intent's own status: `in_progress` is a buyer sitting in the gateway's sheet, and
   * `authorized` is money already held with nothing left for them to do.
   */
  awaitingAuthentication: boolean;
  /**
   * WHICH KIND of thing is in flight — and it is here because the REMEDY differs, not
   * for decoration.
   *
   * A `payment` is a booked debit: the buyer can end it from the portal ("I won't
   * approve this" → `abandonAuthenticationPendingDebit`, which keys on the invoice's
   * `in_progress` transaction), and the operator can tell them so.
   *
   * An `intent` is a checkout the buyer opened. It has NO payments row and NO
   * transaction row until its capture settles, so that same portal control cannot see
   * it and cannot act on it — advising "ask them to release it" would send an operator
   * to a button that does nothing. Measured 2026-09-03 on INV-7824: intent
   * `pi_XXXXXXXXXXXXXXXXXXXXXX05`, ₹22,184.00, live at RazorPay with zero rows in
   * `payments` or `transactions` for the whole 47 seconds before a downgrade credited
   * the invoice to zero underneath it.
   */
  kind: "payment" | "intent";
}

/** The intent statuses that mean money is genuinely moving on an invoice right now.
 *
 * `inited` is deliberately excluded and that is the same call the portal's resume guard
 * makes: a REFUSED authorization leaves the intent open and marks its ATTEMPT failed
 * (`attemptOutcomeOf`), so nothing is held at the gateway and there is no checkout to
 * return to. Counting it as in flight would warn about a decline.
 */
const LIVE_INTENT_STATUSES = ["in_progress", "authorized"] as const;

/**
 * Which of these invoices already have a payment in flight, and what KIND of wait it
 * is — the batched twin of `pendingPaymentForInvoice`, for a list.
 *
 * One `IN (...)` rather than a query per row: the portal renders every invoice a
 * customer has ever had, and asking per row would be an N+1 on the buyer's first paint.
 * The payment-method join rides along for free and is what tells the two waits apart.
 *
 * ── `includeIntents`, and why it is OPT-IN rather than always on (2026-09-03) ──
 * A buyer-initiated checkout is in flight in every sense that matters — INV-7824 proves
 * it cost a customer ₹22,184.00 of round trip — but it writes NO `payments` row, so this
 * query could not see one and the change screen's warning never fired. Callers that
 * decide whether to CREDIT an invoice must see intents; that is what the flag is for.
 *
 * It is not the default because two existing readers branch on the answer in ways an
 * intent breaks, and both live in files this change does not own:
 *
 *  · the portal invoice list (`payment_in_flight`) hides "Pay now" and renders
 *    "Payment processing…" — but the collect route RESUMES a live `in_progress` intent
 *    (200 `action_required`, the same gateway order), so unioning intents in there would
 *    take away the button for the one state where pressing it is the correct next step,
 *    leaving the buyer with no way back into their own checkout;
 *  · that list also offers `AbandonAuthenticationButton` on `awaiting_authentication`,
 *    and that control keys on the invoice's `in_progress` TRANSACTION, of which an
 *    intent has none — a control that cannot do what it says.
 *
 * So the shared definition of "in flight" now covers both shapes, and each caller opts
 * in when its own copy and controls can honestly act on an intent. `dashboard/app/
 * (storefront)/portal/(session)/page.tsx` and the operator invoice page are the two that
 * still need an intent-aware branch before they can.
 */
export async function pendingPaymentsForInvoices(
  organizationId: string,
  invoiceIds: string[],
  opts?: { includeIntents?: boolean },
): Promise<Map<string, InFlightPayment>> {
  const out = new Map<string, InFlightPayment>();
  if (invoiceIds.length === 0) return out;
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({
        invoiceId: payments.invoiceId,
        amountMinor: payments.amountMinor,
        currency: payments.currency,
        mandateRail: paymentMethods.mandateRail,
        methodType: paymentMethods.type,
        // The gateway's own statement about what this attempt waits for. It lives on
        // the TRANSACTION — `payments` has no column that means this — so the join is
        // what lets a challenge below the AFA ceiling be described honestly here.
        // `bookPending` writes exactly one transaction per payment.
        errorCode: transactions.errorCode,
        // Already on the row — no extra query. The portal needs it because whether the
        // bank's request can be CANCELLED is a per-gateway fact (`capabilities.intentVoid`:
        // Stripe and PayPal yes, RazorPay no), and the buyer is promised one or the other.
        gatewayKey: payments.providerKey,
      })
      .from(payments)
      .leftJoin(paymentMethods, eq(paymentMethods.id, payments.paymentMethodId))
      .leftJoin(transactions, eq(transactions.paymentId, payments.id))
      .where(and(inArray(payments.invoiceId, invoiceIds), paymentInFlightCondition())),
  );
  for (const r of rows) {
    if (r.invoiceId == null) continue;
    out.set(r.invoiceId, {
      kind: "payment",
      gatewayKey: r.gatewayKey ?? null,
      awaitingAuthentication: debitAwaitsBuyerAuthentication(
        r,
        { mandateRail: r.mandateRail, type: r.methodType },
        r.currency,
        r.amountMinor,
      ),
    });
  }
  if (!opts?.includeIntents) return out;
  /**
   * The same live-intent predicate `liveIntentForInvoice` uses, batched — `voided_at`
   * null, a status that means something is really happening, and an unexpired deadline.
   *
   * Wall clock rather than `businessNow`: `expires_at` is STAMPED from the wall clock at
   * create time (`ttl.ts`), so a time-travelled business must be compared against the
   * clock that wrote it. That is the same reason the portal's own resume guard passes
   * `new Date()` and says so.
   */
  const now = new Date();
  const intents = await withTenant(organizationId, (tx) =>
    tx
      .select({
        invoiceId: paymentIntents.invoiceId,
        status: paymentIntents.status,
      })
      .from(paymentIntents)
      .where(
        and(
          inArray(paymentIntents.invoiceId, invoiceIds),
          eq(paymentIntents.purpose, "payment"),
          inArray(paymentIntents.status, [...LIVE_INTENT_STATUSES]),
          isNull(paymentIntents.voidedAt),
          or(isNull(paymentIntents.expiresAt), gt(paymentIntents.expiresAt, now)),
        ),
      ),
  );
  for (const r of intents) {
    if (r.invoiceId == null) continue;
    // A booked debit WINS over an intent on the same invoice, deliberately: it is the
    // one with a release action behind it (the portal's abandon control), so reporting
    // the intent instead would replace actionable advice with none.
    if (out.has(r.invoiceId)) continue;
    out.set(r.invoiceId, {
      kind: "intent",
      // No `payments` row exists for an intent, so there is no provider key to report.
      // Null means UNKNOWN here, never "no gateway" — the portal's cancel copy must fall
      // back to the cautious wording rather than promise a cancellation it cannot judge.
      gatewayKey: null,
      // `in_progress` = the buyer is in the gateway's sheet, so the wait is theirs.
      // `authorized` = the money is already held and there is nothing for them to do;
      // the authorize writer clears `next_action` for exactly that reason, and the
      // portal refuses to re-open such an intent rather than hand back a dead action.
      awaitingAuthentication: r.status === "in_progress",
    });
  }
  return out;
}

/**
 * What the payer is told when the adapter reports a failure with NO message of its own.
 *
 * Used by the payment row, its transaction and — the one that matters most — the
 * `payment_failed` event payload, whose `message` becomes `declineMessage` in the mail the
 * payer receives. It said "Card was declined", which blames their instrument for what may
 * equally be a network fault, a malformed provider response or a bug of ours. The failure
 * CODE stays `card_declined`, because that feeds the decline ladder and dunning; only the
 * sentence changes. One constant, so the three copies cannot drift apart.
 */
const NO_REASON_FROM_PROVIDER =
  "We could not complete the payment, and the payment provider gave no reason.";

export async function collectInvoice(input: {
  organizationId: string;
  businessId: string;
  invoice: Invoice;
  /** Subscription (if any) — used for its default PM. Manual invoices omit it. */
  subscription?: typeof subscriptions.$inferSelect;
  /** Explicit payment-method public id to charge (D3 ad-hoc collect override). */
  paymentMethodOverrideId?: string;
  /**
   * Defaults to `off_session`. Every automated caller (the due pass, renewals,
   * collect-on-payment-method-update, the operator "Collect now") omits it and
   * keeps today's behaviour exactly, `requires_action` dunning included. Only a
   * caller that KNOWS the buyer is present passes `on_session`, which turns a
   * `requires_action` into a `PaymentActionRequiredError` carrying the intent.
   */
  session?: CollectionSession;
  /** Redirect targets for an on-session challenge (redirect-mode gateways). */
  returnUrl?: string;
  cancelUrl?: string;
  /**
   * This attempt was asked for BY A HUMAN — an operator's "Collect now" or the
   * buyer's "Pay now" — rather than by the dunning clock.
   *
   * Manual collections are excluded from the dunning attempt count: `attempt_count`
   * indexes the retry schedule, so letting a manual attempt bump it silently CONSUMES
   * one of the customer's scheduled retries. Click "Collect now" three times on a
   * 1/3/5 schedule and the invoice has spent its whole schedule without the clock ever
   * running.
   *
   * The failed payment row is still written — the attempt really happened and has to
   * be visible — it just does not advance dunning.
   */
  manualAttempt?: boolean;
}): Promise<Payment> {
  const { organizationId, businessId, invoice } = input;

  // Claimed BEFORE the first guard reads anything, because the guards are the race:
  // `invoiceOutstanding` and the pending-attempt check are read-then-act, and two
  // collectors inside the same window each read "nothing collected yet". Everything below therefore runs under the claim, and the `finally`
  // is what makes a thrown gateway error release rather than pin the invoice.
  if (!(await claimCollection(organizationId, invoice.id, new Date()))) {
    throw new CollectionInFlightError(invoice.publicId);
  }
  try {
    // A span per collection: a clock tick charges many invoices under one trace, and the
    // transaction's link to its gateway calls must show this charge's calls only.
    return await withSpan(() => collectClaimedInvoice(input));
  } finally {
    await releaseCollection(organizationId, invoice.id);
  }
}

/** The collection itself. Runs under the caller's claim — never call it directly. */
async function collectClaimedInvoice(input: {
  organizationId: string;
  businessId: string;
  invoice: Invoice;
  subscription?: typeof subscriptions.$inferSelect;
  paymentMethodOverrideId?: string;
  session?: CollectionSession;
  returnUrl?: string;
  cancelUrl?: string;
  manualAttempt?: boolean;
}): Promise<Payment> {
  const { organizationId, businessId, invoice } = input;
  // Charge what's actually due: gross total, minus applied customer credit (the
  // stored column), minus cash already collected (`invoiceOutstanding`). Without
  // the last term a part-paid invoice gets charged its FULL total again.
  const { paidMinor, remainingMinor: due } = await withTenant(organizationId, (tx) =>
    invoiceOutstanding(tx, invoice),
  );

  // Cash already covers it (e.g. offline part-payments that add up to the total)
  // — settle from what we hold instead of charging the card a second time.
  if (paidMinor > 0n && due <= 0n) {
    return withTenant(organizationId, async (tx) => {
      const [last] = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.invoiceId, invoice.id), eq(payments.status, "succeeded")))
        .orderBy(desc(payments.createdAt))
        .limit(1);
      if (invoice.status !== "paid") {
        await tx
          .update(invoices)
          .set({
            status: "paid",
            paidAt: stampNow(),
            nextAttemptAt: null,
            ...dunningFieldsOnSettle(invoice),
          })
          .where(eq(invoices.id, invoice.id));
        await emitEvent(tx, {
          organizationId,
          businessId,
          type: "invoice_paid",
          data: buildEventData(
            "invoice_paid",
            {
              id: invoice.publicId,
              amount_minor: Number(invoice.totalMinor),
              currency: invoice.currency,
            },
            null,
            { already_collected: true },
          ),
        });
        await activatePaidCreditGrants(tx, { organizationId, invoiceId: invoice.id });
      }
      return last!;
    });
  }

  // Whether auto-collection is on (sub overrides customer). A failed charge on an
  // auto-collect-OFF invoice must not arm automatic dunning (review fix).
  // Email + phone ride along for gateways that require buyer contact on the charge
  // call itself (RazorPay off-session refuses a charge without them).
  const cust = await loadChargeContact(organizationId, invoice.customerId);
  const autoCollectOn = isAutoCollectOn(
    input.subscription?.autoCollection ?? null,
    cust?.autoCollection ?? null,
  );

  // Double-charge guard: if a prior attempt is still PENDING (gateway timeout /
  // unknown outcome), do NOT charge again — the inbound reconciler or the manual
  // reconcile op must resolve it first. Return the in-flight payment as-is.
  const inFlight = await pendingPaymentForInvoice(organizationId, invoice.id);
  if (inFlight) return inFlight;

  // The same guard, for a buyer who is MID-CHECKOUT. They have no `payments` row yet —
  // only a live intent — so the check above cannot see them, and collection would debit
  // the mandate underneath someone who is in the middle of paying by hand. Both settle
  // and they are charged twice. Measured 2026-08-14 on INV-2143.
  //
  // Throws rather than returning a payment: there is nothing to return (no charge was
  // made and none should be), and every caller already handles
  // `CollectionInFlightError` as "someone else is on this invoice, try later" — which is
  // exactly true. The dunning pass leaves the schedule alone and comes back.
  const liveIntent = await liveIntentForInvoice(organizationId, invoice.id, new Date());
  if (liveIntent) throw new CollectionInFlightError(invoice.publicId);

  // Resolve the ordered collection candidates (C6): the subscription PM (or the
  // customer's primary) first, then each backup in turn on a decline. No saved card →
  // dunning.
  const candidates = chargeOrder(
    await resolveChargeCandidates({
      organizationId,
      customerId: invoice.customerId,
      subscription: input.subscription,
      paymentMethodOverrideId: input.paymentMethodOverrideId,
      currency: invoice.currency,
    }),
  );

  // NPCI rail rules bind every path; a blocked mandate is skipped for the next candidate.
  // Automatic attempts also respect the per-card caps, but never when that would leave
  // nothing to charge.
  let order: Pm[] = candidates;
  if (candidates.length > 0) {
    const checkedAt = new Date();
    const blocks = await Promise.all(
      candidates.map((pm) =>
        presentationBlock({
          organizationId,
          pm,
          now: checkedAt,
          applyCaps: !input.manualAttempt,
          invoiceId: invoice.id,
        }),
      ),
    );
    order = candidates.filter((_, i) => !blocks[i] || blocks[i]!.reason === "card_cap");
    const uncapped = order.filter((pm) => !blocks[candidates.indexOf(pm)]);
    if (uncapped.length > 0) order = uncapped;
    const railRefusal = blocks[0];
    // Every candidate is a revoked mandate: refuse without a gateway call, under the same
    // code, so dunning reaches the same disposition (billing_rules_config.mandate_revoked).
    if (order.length === 0 && railRefusal?.reason === "mandate_revoked") {
      return recordFailedPayment({
        organizationId,
        businessId,
        invoice,
        paymentMethodId: candidates[0]!.id,
        methodType: methodTypeOf(null, candidates[0]),
        providerKey: "none",
        amountMinor: due,
        failureCode: "revocation_of_authorization",
        failureMessage:
          "The customer cancelled the authorization for this payment method. Add a new payment method to pay this invoice.",
        retriable: false,
        autoCollectOn,
        subscriptionStatus: input.subscription?.status ?? null,
        manualAttempt: input.manualAttempt,
      });
    }
    if (order.length === 0 && railRefusal && railRefusal.reason !== "card_cap") {
      return recordFailedPayment({
        organizationId,
        businessId,
        invoice,
        paymentMethodId: candidates[0]!.id,
        methodType: methodTypeOf(null, candidates[0]),
        // Refused here, before any network was asked.
        providerKey: "none",
        amountMinor: due,
        failureCode: railRefusal.reason === "rail_limit" ? RAIL_LIMIT_CODE : RAIL_SPACING_CODE,
        failureMessage:
          railRefusal.reason === "rail_limit"
            ? "Automatic debits for this invoice reached the limit that the payment network allows. Pay the invoice directly, or authorize a new payment method."
            : "The last debit on this payment method is too recent for a new attempt now. Pay the invoice directly, or wait for the next attempt.",
        retriable: true,
        autoCollectOn,
        subscriptionStatus: input.subscription?.status ?? null,
        manualAttempt: input.manualAttempt,
      });
    }
  }
  // Card limit (0482): above it no card is charged; other instruments still are.
  if (order.some(isCardInstrument)) {
    const [bizLimits] = await withTenant(organizationId, (tx) =>
      tx
        .select({ cardPaymentLimits: businesses.cardPaymentLimits })
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .limit(1),
    );
    if (overCardLimit(bizLimits, invoice.currency, due)) {
      const refusedCard = order.find(isCardInstrument)!;
      order = order.filter((pm) => !isCardInstrument(pm));
      if (order.length === 0) {
        return recordFailedPayment({
          organizationId,
          businessId,
          invoice,
          paymentMethodId: refusedCard.id,
          methodType: methodTypeOf(null, refusedCard),
          // Refused here, before any network was asked.
          providerKey: "none",
          amountMinor: due,
          failureCode: CARD_LIMIT_CODE,
          failureMessage: CARD_LIMIT_MESSAGE,
          // Treated like `no_payment_method`: no card can pay it, another method can.
          retriable: false,
          autoCollectOn,
          subscriptionStatus: input.subscription?.status ?? null,
          manualAttempt: input.manualAttempt,
        });
      }
    }
  }
  const primary = order[0];

  // No saved card → record a failed attempt; invoice stays open for dunning.
  if (!primary) {
    return recordFailedPayment({
      organizationId,
      businessId,
      invoice,
      paymentMethodId: null,
      methodType: null,
      providerKey: "none",
      amountMinor: due,
      failureCode: "no_payment_method",
      // Reaches the payer verbatim. The old wording ("Customer has no saved payment
      // method") reads as an accusation and fires identically whether the buyer never
      // added one, an operator detached it, or an import failed to carry it over.
      failureMessage: "There is no saved payment method to charge. Add one to settle this invoice.",
      /**
       * `retriable: false` since 2026-09-21, and it is not a downgrade.
       *
       * It said `true` on the reasoning that "the customer can add a card during
       * dunning" — which is right about the RECOVERY and wrong about the RETRY. There is
       * no instrument to present, so every rung was a charge refused before a gateway was
       * asked, and at the end of the ladder the customer was cancelled: about a week,
       * against the thirty days a merely-declined card gets.
       *
       * Non-retriable routes it to `park` in both modes (`PARK_EVEN_IN_FIXED_MODE`),
       * which is where the recovery machinery already lives — the reminder ladder asks
       * for an instrument, `collect_on_payment_method_update` charges the moment one
       * arrives, and the deadline attempt covers the case where that is switched off.
       */
      retriable: false,
      autoCollectOn,
      subscriptionStatus: input.subscription?.status ?? null,
      manualAttempt: input.manualAttempt,
    });
  }

  // One number for every charge this call makes: the primary and the backup card share
  // it and are told apart by `pm.publicId`, which is what makes the backup a distinct
  // charge rather than a replay of the card that just declined.
  const attemptNumber = (await bookedAttemptsForInvoice(organizationId, invoice.id)) + 1;

  // Selection + the charge call itself live in ./collection so the pre-invoice
  // signup charge uses exactly the same gateway account, PM order and ChargeInput.
  // A scheduling gateway collects on the due date; the operator's Collect now means now.
  // The business's calendar day: a UTC day lands a day early east of UTC.
  const invoiceDueDay =
    !input.manualAttempt && invoice.dueDate
      ? zonedDayString(
          invoice.dueDate,
          await withTenant(organizationId, (tx) => businessTimezone(tx, businessId)),
        )
      : undefined;
  const attempt = async (pm: Pm) =>
    chargeWithMethod({
      organizationId,
      businessId,
      currency: invoice.currency,
      pm,
      amountMinor: due,
      idempotencyKey: `inv_${invoice.publicId}_attempt_${attemptNumber}_${pm.publicId}`,
      // #31: the gateway object's tag. The invoice is the row this money settles, and
      // it is the bare public id — the key above prepends `inv_` to an id that already
      // starts with it, which is how a live PayPal capture came back reading
      // `custom_id: "tmbilling_ref:inv_inv_EMZpKKX…"` (2026-09-04). Both cards this call
      // may try share it, deliberately: the backup card's charge settles the same
      // invoice, and `pm.publicId` already tells the two attempts apart in the key.
      ownershipRef: invoice.publicId,
      description: await invoiceChargeDescription({
        // The boundary already exists — `manualAttempt` is set only by `collectInvoiceNow`,
        // i.e. the dashboard's Collect now. Everything else here is the billing clock.
        flow: input.manualAttempt ? "manual_collection" : "renewal",
        organizationId,
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        invoicePublicId: invoice.publicId,
        customerId: invoice.customerId,
      }),
      contact: cust,
      preDebit: { invoiceId: invoice.id, subscriptionId: invoice.subscriptionId ?? null },
      // Clock and operator collections alike: no buyer present.
      initiator: { by: "merchant", recurring: invoice.subscriptionId != null },
      ...(invoiceDueDay ? { invoiceDueDate: invoiceDueDay } : {}),
    });

  type Attempt = ChargeAttempt;

  const bookSuccess = async (pm: Pm, a: Attempt) =>
    withTenant(organizationId, async (tx) => {
      const [pay] = await tx
        .insert(payments)
        .values({
          organizationId,
          businessId,
          customerId: invoice.customerId,
          invoiceId: invoice.id,
          paymentMethodId: pm.id,
          publicId: publicId("pay"),
          status: "succeeded",
          amountMinor: due,
          currency: invoice.currency,
          providerKey: a.gatewayKey,
          providerChargeId: a.result.providerChargeId,
          methodType: methodTypeOf(a.result, pm),
        })
        // `payments_provider_charge_uq` (0162): this gateway charge is already booked, so
        // the row we were about to write is a duplicate of it. Returning the ORIGINAL is
        // the only correct answer — the money moved once, so there is one payment. Falling
        // through would post a second cash/AR pair and emit a second `invoice_paid`, which
        // is precisely the $30-paid-on-a-$15-invoice this guards.
        //
        // Reachable despite the claim: a gateway that deduplicates on our idempotency key
        // can replay a charge booked by an ATTEMPT THAT ALREADY FINISHED (same key, same
        // charge), which no amount of mutual exclusion between live collectors prevents.
        //
        // `where` is NOT a filter here — it is the index-inference predicate, and it is
        // required: `payments_provider_charge_uq` is PARTIAL, and Postgres refuses to
        // infer a partial index from a bare column list ("no unique or exclusion
        // constraint matching the ON CONFLICT specification"). Dropping it turns every
        // successful collection into a runtime error.
        .onConflictDoNothing({
          target: [payments.businessId, payments.providerChargeId],
          where: sql`provider_charge_id IS NOT NULL AND provider_charge_id <> '' AND provider_key <> 'offline'`,
        })
        .returning();
      if (!pay) {
        const [existing] = await tx
          .select()
          .from(payments)
          .where(
            and(
              eq(payments.businessId, businessId),
              eq(payments.providerChargeId, a.result.providerChargeId),
            ),
          )
          .limit(1);
        // The insert was refused, so a row with this charge id exists — unless it was
        // deleted between the two statements, which nothing does. Loud rather than a
        // non-null assertion: a silent undefined here would surface as a broken payment
        // far from its cause.
        if (!existing) {
          throw new Error(
            `payment for charge ${a.result.providerChargeId} was refused as a duplicate but cannot be found`,
          );
        }
        return existing;
      }
      await postEntries(
        {
          organizationId,
          businessId,
          customerId: pay!.customerId,
          sourceType: "payment",
          sourceId: pay!.publicId,
          lines: [
            { account: "cash", direction: "debit", amountMinor: due, currency: invoice.currency },
            {
              account: "accounts_receivable",
              direction: "credit",
              amountMinor: due,
              currency: invoice.currency,
            },
          ],
        },
        tx,
      );
      await tx
        .update(invoices)
        .set({
          status: "paid",
          paidAt: stampNow(),
          nextAttemptAt: null,
          // A manual "Collect now" / "Pay now" is not a dunning attempt, so it does not
          // advance the counter here either — otherwise an invoice settled on the first
          // manual click reports attempt_count 1 and reads as a recovered dunning case.
          ...(input.manualAttempt ? {} : { attemptCount: invoice.attemptCount + 1 }),
          // Keyed on dunning_status as well as the counter: a manual collect on an
          // invoice already in dunning (attempt_count 0) must still close the chase.
          ...dunningFieldsOnSettle(invoice),
        })
        .where(eq(invoices.id, invoice.id));
      // Gateway-facing transaction (C5/C10).
      await recordTransaction(
        {
          organizationId,
          businessId,
          customerId: invoice.customerId,
          type: "payment",
          status: "succeeded",
          amountMinor: due,
          currency: invoice.currency,
          gatewayAccountId: a.account?.id ?? null,
          gatewayKey: a.gatewayKey,
          idAtGateway: a.result.providerChargeId,
          paymentMethodId: pm.id,
          invoiceId: invoice.id,
          paymentId: pay!.id,
        },
        tx,
      );
      await emitEvent(tx, {
        organizationId,
        businessId,
        type: "payment_succeeded",
        data: buildEventData("payment_succeeded", {
          id: pay!.publicId,
          status: "succeeded",
          amount_minor: Number(due),
          currency: invoice.currency,
          invoice: invoice.publicId,
        }),
      });
      await emitEvent(tx, {
        organizationId,
        businessId,
        type: "invoice_paid",
        data: buildEventData("invoice_paid", {
          id: invoice.publicId,
          amount_minor: Number(invoice.totalMinor),
          currency: invoice.currency,
        }),
      });
      await activatePaidCreditGrants(tx, { organizationId, invoiceId: invoice.id });
      return pay!;
    });

  // Timeout / needs_attention: the gateway outcome is unknown — record a pending
  // payment + an unsettled transaction and leave the invoice open for the inbound
  // reconciler (C8) or the manual reconcile op to resolve. No dunning yet.
  const bookPending = async (
    pm: Pm,
    a: Attempt,
    status: "in_progress" | "timeout" | "needs_attention",
    /** A lost answer: what the gateway can find the charge by. */
    lost?: LostChargeHandle | null,
  ) => {
    /**
     * WHAT this attempt is waiting for, in the gateway's own words.
     *
     * `requires_action` on its own is too coarse to answer that, and India is the proof:
     * Stripe parks EVERY e-mandate debit there to serve the RBI pre-debit notification,
     * whether or not a person has to authenticate it. Reading the status alone stamped
     * `AWAITING_AUTHENTICATION_CODE` on debits that needed nobody — measured 2026-09-10,
     * a ₹100 debit that Stripe explicitly flagged `customer_approval_required: false`
     * settled on its own five minutes later, while the portal offered its buyer a
     * Pay-now approval CTA the whole time. `stale-pending.ts` already names this exact
     * conflation for the webhook shape; this is the same bug on the booking path.
     *
     * The negative has to be WRITTEN, not merely left unwritten: with no statement on the
     * row, `debitAwaitsBuyerAuthentication` falls back to the rail+amount prediction,
     * which says "yes" on its own above the AFA-free ceiling. Silence is not a "no".
     */
    const waitStatement =
      a.result.status !== "requires_action"
        ? null
        : a.result.nextAction?.data?.approvalRequired === false
          ? AUTHENTICATION_NOT_REQUIRED_CODE
          : AWAITING_AUTHENTICATION_CODE;
    return withTenant(organizationId, async (tx) => {
      const [pay] = await tx
        .insert(payments)
        .values({
          organizationId,
          businessId,
          customerId: invoice.customerId,
          invoiceId: invoice.id,
          paymentMethodId: pm.id,
          publicId: publicId("pay"),
          status: "pending",
          amountMinor: due,
          currency: invoice.currency,
          providerKey: a.gatewayKey,
          providerChargeId: a.result.providerChargeId,
          methodType: methodTypeOf(a.result, pm),
        })
        .returning();
      await recordTransaction(
        {
          organizationId,
          businessId,
          customerId: invoice.customerId,
          type: "payment",
          status,
          amountMinor: due,
          currency: invoice.currency,
          gatewayAccountId: a.account?.id ?? null,
          gatewayKey: a.gatewayKey,
          idAtGateway: a.result.providerChargeId,
          ...(lost ? { ownershipRef: lost.ownershipRef, idempotencyKey: lost.idempotencyKey } : {}),
          paymentMethodId: pm.id,
          invoiceId: invoice.id,
          paymentId: pay!.id,
          /**
           * A `requires_action` carries no failure object, so without this the row
           * that IS waiting on the buyer is the only one with nothing recorded about
           * what it waits for. `AWAITING_AUTHENTICATION_CODE` on an in-flight row is
           * the gateway's statement, not a verdict — the sweep already writes
           * `afa_not_completed` into this same column before flipping the status, and
           * no consumer reads a non-null `errorCode` as "failed".
           */
          errorCode: a.result.failure?.code ?? waitStatement,
          errorText: a.result.failure?.message ?? null,
          retriable: a.result.failure?.retriable ?? null,
        },
        tx,
      );
      // Park the invoice while the outcome is unknown: consume the attempt slot
      // and CLEAR nextAttemptAt so the dunning pass cannot re-collect it. The
      // settlement path (inbound webhook / reconcile op) schedules the next
      // retry if the attempt turns out to have failed.
      await tx
        .update(invoices)
        .set({ attemptCount: invoice.attemptCount + 1, nextAttemptAt: null })
        .where(eq(invoices.id, invoice.id));
      // An RBI/NPCI additional-factor debit looks EXACTLY like an ordinary slow
      // settlement from here — RazorPay reports both as `created`, so nothing
      // downstream can tell them apart by asking the gateway. The difference is
      // that this one will never move on its own: it is waiting on a person who
      // has not been told. Parking it silently is how a renewal becomes churn.
      //
      // The gateway's statement first, the amount+rail prediction only as the
      // fallback for a shape that carries no statement (RazorPay parks an AFA debit
      // as a plain `pending`). Only the statement is persisted — see
      // `debitAwaitsBuyerAuthentication`; the prediction stays derived so the sweep
      // and this emit still cannot disagree about it.
      if (
        status === "in_progress" &&
        debitAwaitsBuyerAuthentication({ errorCode: waitStatement }, pm, invoice.currency, due)
      ) {
        await emitEvent(tx, {
          organizationId,
          businessId,
          type: "payment_authentication_required",
          data: buildEventData("payment_authentication_required", {
            id: pay!.publicId,
            status: "pending",
            amount_minor: Number(due),
            currency: invoice.currency,
            invoice: invoice.publicId,
            mandate_rail: pm.mandateRail ?? pm.type,
          }),
        });
      }
      return pay!;
    });
  };

  const markInvalid = async (pm: Pm) => markPaymentMethodInvalid(organizationId, pm.id);

  // Record a superseded declined attempt (plan: 1 attempt → 1 transaction).
  // The primary can decline and then a backup card succeed; without this the
  // declined attempt would leave no payments/transactions row at all. This books a
  // failed payment + failure transaction for the declined instrument but does NOT
  // touch the invoice or dunning — the loop falls through to the next candidate.
  const recordSupersededDecline = async (pm: Pm, a: Attempt) =>
    withTenant(organizationId, async (tx) => {
      const [pay] = await tx
        .insert(payments)
        .values({
          organizationId,
          businessId,
          customerId: invoice.customerId,
          invoiceId: invoice.id,
          paymentMethodId: pm.id,
          publicId: publicId("pay"),
          status: "failed",
          amountMinor: due,
          currency: invoice.currency,
          providerKey: a.gatewayKey,
          methodType: methodTypeOf(a.result, pm),
          failureCode: a.result.failure?.code ?? "card_declined",
          /**
           * The FALLBACK, used only when the adapter hands us a failure with no message —
           * which can be a network fault, a malformed provider response or an adapter bug,
           * not an issuer decision. It is buyer-facing (it rides `payment_failed` into the
           * payer's mail), so it must not blame their card for something that may be ours.
           *
           * The CODE stays `card_declined`: it feeds the decline ladder and dunning
           * classification, and changing it would alter behaviour rather than wording.
           */
          failureMessage: a.result.failure?.message ?? NO_REASON_FROM_PROVIDER,
        })
        .returning();
      await recordTransaction(
        {
          organizationId,
          businessId,
          customerId: invoice.customerId,
          type: "payment",
          status: "failed",
          amountMinor: due,
          currency: invoice.currency,
          gatewayAccountId: a.account?.id ?? null,
          gatewayKey: a.gatewayKey,
          idAtGateway: a.result.providerChargeId ?? null,
          paymentMethodId: pm.id,
          invoiceId: invoice.id,
          paymentId: pay!.id,
          errorCode: a.result.failure?.code ?? "card_declined",
          // Same sentence as the payment row above, for the same reason.
          errorText: a.result.failure?.message ?? NO_REASON_FROM_PROVIDER,
          // The provider's own classification, persisted so the Retries screen can
          // state Hard vs Soft failure as fact rather than infer it from whether a
          // retry happened to get scheduled.
          retriable: a.result.failure?.retriable ?? null,
        },
        tx,
      );
      await emitEvent(tx, {
        organizationId,
        businessId,
        type: "payment_failed",
        // status + amount_minor + currency mirror payment_succeeded: a consumer must be
        // able to tell HOW MUCH failed straight off the webhook (dunning emails, retry
        // UIs, reconciliation). Ours carried neither, so an integration lost the amount.
        data: buildEventData("payment_failed", {
          id: pay!.publicId,
          status: "failed",
          amount_minor: Number(due),
          currency: invoice.currency,
          invoice: invoice.publicId,
          code: a.result.failure?.code ?? "card_declined",
          /**
           * ⚠️ THE ONE FIELD A STRANGER READS. It becomes `declineMessage` in the payer's
           * mail, so a failure that is OURS must not describe itself here — on 2026-09-04
           * a Stripe API complaint about our own malformed request ("The parameter
           * `mandate` is not provided or invalid") travelled this path to an operator's
           * screen, and the same path ends in a customer's inbox.
           *
           * Only codes a rule marks internal are swapped, unless the business's override
           * says otherwise (`payerDeclineMessage`); everything else keeps the gateway's
           * reason. The full text stays on the payment row and the transaction.
           */
          message: payerDeclineMessage(
            {
              code: a.result.failure?.code ?? "card_declined",
              message: a.result.failure?.message,
              exposedToPayer: a.result.failure?.exposedToPayer,
            },
            NO_REASON_FROM_PROVIDER,
          ),
          retriable: false,
        }),
      });
    });

  // Try primary, then each backup on any decline (`shouldTryBackup`).
  let last: { pm: Pm; a: Attempt } | null = null;
  // Declines held back until we know which one governs dunning — the most recoverable
  // (`collectionRank`), so one dead backup cannot cancel what a retry or a new card
  // could still collect. The rest are booked as superseded.
  const declined: Array<{ pm: Pm; a: Attempt }> = [];
  const flushDeclined = async () => {
    for (const d of declined.splice(0)) await recordSupersededDecline(d.pm, d.a);
  };
  for (let i = 0; i < order.length; i++) {
    const pm = order[i]!;
    let a: Attempt;
    try {
      a = await attempt(pm);
    } catch (e) {
      await flushDeclined();
      if (e instanceof GatewayRouterError) {
        /**
         * The PM's gateway account is disabled / mode-mismatched.
         *
         * `retriable: false` since this is not a transient condition: nothing changes
         * until an operator re-enables the account, and every attempt until then is
         * spent on a router that refuses before a gateway is even called. It was
         * `true`, which ran the full ladder and then exhausted — cancelling the
         * subscription over our own configuration.
         *
         * Non-retriable does NOT mean the debt is abandoned: the code is classified
         * `park` in both modes (`PARK_EVEN_IN_FIXED_MODE`), so the invoice stays open,
         * `MERCHANT_SIDE_PARK` raises the ops alert while the window counts down, and
         * the deadline attempt collects once the account is back. No instrument is
         * marked invalid either — this throws before the charge, so `isHardDecline`
         * never sees a result.
         */
        return recordFailedPayment({
          organizationId,
          businessId,
          invoice,
          paymentMethodId: pm.id,
          methodType: methodTypeOf(null, pm),
          providerKey: pm.providerKey,
          amountMinor: due,
          failureCode: "gateway_account_unavailable",
          failureMessage: e.message,
          retriable: false,
          autoCollectOn,
          subscriptionStatus: input.subscription?.status ?? null,
          manualAttempt: input.manualAttempt,
        });
      }
      /**
       * WE DO NOT KNOW WHAT HAPPENED — so we must not write that it failed. Money may
       * have moved. A failure row hands the invoice straight back to dunning and the
       * next pass debits the buyer a second time; pending + `timeout` is the one shape
       * that says "unresolved" and leaves the settlement path (webhook / reconcile op)
       * in charge of the verdict. Reading this error as a fact about the money is
       * defect #21 with the sign flipped — see `ProviderIndeterminateError`.
       *
       * A throw carries no result, so the Attempt is synthesized: the stranded object id
       * is the only handle we have on whatever the gateway kept.
       */
      if (e instanceof ProviderIndeterminateError) {
        log.error(e, {
          event: "gateway_charge_indeterminate",
          invoice: invoice.publicId,
          payment_method: pm.publicId,
          gateway: pm.providerKey,
        });
        const lost = lostChargeHandle(e);
        return bookPending(
          pm,
          {
            result: { status: "pending", providerChargeId: strandedObjectId(e) ?? "" },
            account: lost?.account ?? null,
            gatewayKey: lost?.gatewayKey ?? pm.providerKey,
          },
          "timeout",
          lost,
        );
      }
      /**
       * THE ATTEMPT REACHED THE GATEWAY AND WE DO NOT KNOW WHY IT FAILED.
       *
       * `throw e` here booked NOTHING: on 2026-09-10 Stripe answered INV-100004 with
       * "Only active mandates can be used with PaymentIntents", the adapter threw, and the
       * invoice ended with no transaction, no payment row, `attempt_count` 0 and a NULL
       * `next_attempt_at` — invisible to `runDunningPass` and to
       * `sweepExpiredParkedDunning` alike, while the subscription kept serving. An attempt
       * that reached a gateway must always leave a row, whichever gateway it was.
       *
       * ⚠️ RETRIABLE, and that is a deliberate correction. This branch first booked
       * `gateway_request_rejected` — "we sent a bad request" — which was true of the
       * incident but is an over-claim here: a catch-all fires on EVERY unrecognised throw,
       * and an unknown fault is just as likely a timeout or a gateway outage as a
       * malformed request. Parking those stops collection on money that the next tick
       * would have taken. The user put it plainly (2026-09-10): an unknown reason follows
       * the dunning config and is not a hard failure.
       *
       * `gateway_error` is the token that already means exactly this — `technical` family,
       * classified `retry`, in neither `PARK` nor `TERMINATE`. It is the same principle
       * `charge_failed` carries for an adapter failure with no code: unclassified is not
       * the same as hard, and marking a working instrument invalid on our own ignorance is
       * the worse error.
       *
       * A recognised refusal never reaches here — the adapter books it from its own rule
       * table, so `gateway_request_rejected` still means what it says and still parks.
       * The `log.error` stays: the stack belongs in the error feed, it is just no longer
       * the ONLY place the failure exists, and a rising `gateway_error` rate is the signal
       * that something systematic is wrong.
       */
      log.error(e as Error, {
        event: "gateway_charge_threw",
        invoice: invoice.publicId,
        payment_method: pm.publicId,
        gateway: pm.providerKey,
      });
      return recordFailedPayment({
        organizationId,
        businessId,
        invoice,
        paymentMethodId: pm.id,
        methodType: methodTypeOf(null, pm),
        providerKey: pm.providerKey,
        amountMinor: due,
        failureCode: "gateway_error",
        failureMessage: e instanceof Error ? e.message : String(e),
        retriable: true,
        autoCollectOn,
        subscriptionStatus: input.subscription?.status ?? null,
        manualAttempt: input.manualAttempt,
      });
    }
    if (a.deferredUntil) {
      // Waiting out a gateway pre-debit notice: nothing reached the gateway, so nothing
      // is booked. The primary defers the whole invoice; a backup yields to the next
      // candidate, or hands the governing decline back when it was the last one.
      if (i === 0) {
        await withTenant(organizationId, (tx) =>
          tx
            .update(invoices)
            .set({ nextAttemptAt: a.deferredUntil })
            .where(eq(invoices.id, invoice.id)),
        );
        log.info("collection deferred for a gateway pre-debit notice", {
          event: "collection_deferred_pre_debit",
          invoice: invoice.publicId,
          until: a.deferredUntil.toISOString(),
        });
        throw new CollectionDeferredError(
          invoice.publicId,
          a.deferredUntil,
          await businessWallClock(businessId),
        );
      }
      if (i < order.length - 1) continue;
      last = declined.pop()!;
      break;
    }
    if (a.result.status !== "failed") await flushDeclined();
    const outcome = tmtestOutcome(a.result);
    if (a.result.status === "succeeded") return bookSuccess(pm, a);
    // Unknown-outcome paths → pending + reconcile (not dunning).
    // A gateway `pending` is a LIVE attempt that will settle by webhook (async rails:
    // UPI Autopay, a card mandate debit, ACH/SEPA) — that is `in_progress`, not
    // `timeout`. The distinction is load-bearing, not cosmetic: reconcileTransaction
    // deliberately refuses `in_progress` so an operator verdict cannot race a live
    // attempt, and booking these as `timeout` opened exactly that race. `timeout`
    // stays what it says — we never learned the outcome.
    // Order matters: tmtest's timeout instrument ALSO returns status 'pending'
    // (with raw.tmtest_outcome='timeout'), so the explicit outcome must be tested
    // first or the timeout simulation — and the reconcile path it exercises —
    // silently becomes in_progress.
    if (outcome === "timeout") return bookPending(pm, a, "timeout");
    if (a.result.status === "pending") return bookPending(pm, a, "in_progress");
    if (outcome === "needs_attention") return bookPending(pm, a, "needs_attention");
    /**
     * AN INDIA AFA DEBIT IS PENDING, NOT FAILED — and this is where the two gateways
     * stopped agreeing.
     *
     * Above `INR_AFA_FREE_CEILING_MINOR` the cardholder authenticating is the DESIGNED
     * path, not an exception: RazorPay parks the debit (measured — ₹28,215 sat in
     * `created` awaiting the issuer's AFA link) and Stripe answers `requires_action`
     * with the intent alive and the bank notifying the buyer. RazorPay's shape reaches
     * `bookPending` above because it arrives as `pending`; Stripe's did not, so an
     * ordinary Indian renewal was recorded as a FAILURE — it burned a dunning attempt,
     * told the operator the card had failed, and abandoned an intent the buyer could
     * still complete. Reported from the portal 2026-09-05: Stripe showed the intent
     * "Incomplete — the cardholder began 3D Secure authentication but has not completed
     * it" while we showed "Failure · requires_action".
     *
     * ⚠️ AND IT SILENCED THE ONE WEBHOOK THAT WOULD HAVE TOLD THE BUYER.
     * `applyActionRequired` handles `intent.requires_action` for exactly this case and
     * emits `payment_authentication_required` with the gateway's own `authenticate_by`
     * — but it refuses a TERMINAL transaction ("the window closed while this delivery
     * was in flight"). Booking the failure made the transaction terminal, so both
     * deliveries for that debit landed `Ignored`. Recording it pending is therefore the
     * whole fix: the handler then finds `in_progress` and the notice goes out.
     *
     * ⚠️ THE AMOUNT GATE IS GONE, and this is the correction that matters most.
     * Until 2026-09-09 this also required `debitNeedsBuyerAuthentication` — INR above
     * ₹15,000 on a card/UPI rail — on the argument that a challenge below the ceiling
     * has no bank notification behind it, so "pending" would be a lie. Production
     * disproved it: `txn_XXXXXXXXXXXXXXXXXXXXXX03` (INV-100001) was ₹885 against a
     * `confirmed` card mandate whose own ceiling was ₹15,000, and the issuer asked for
     * the cardholder regardless. ₹15,000 is where AFA is COMPULSORY, not where it
     * becomes possible; no amount is a safe assumption about what an issuer will do.
     *
     * The deeper error was one of authority. `requires_action` IS the gateway stating
     * that the buyer has to act — the same authority `webhooks/inbound.ts`
     * (`applyActionRequired`) is preferred over this module's prediction for. Letting
     * an amount+rail inference veto a statement inverts that, and the cost is not a
     * mislabelled row: the failure booking made the transaction terminal, which
     * silenced `applyActionRequired` (it refuses a non-open attempt), so the one email
     * that would have told the buyer to authenticate never went. Then `retriable ?? true`
     * armed a dunning ladder in which every rung re-asks a question only the buyer can
     * answer.
     *
     * Off-session only — an ON-session challenge still throws
     * `PaymentActionRequiredError` below so the buyer completes it in-page.
     *
     * ⚠️ Booking pending is safe ONLY because the abandon paths were widened with it.
     * A pending debit that nobody authenticates must still end: `stale-pending.ts`
     * clamps the grace window and books `afa_not_completed` (park, non-retriable), and
     * `abandonAuthenticationPendingDebit` lets the buyer release the invoice they are
     * blocked on. Both used to be gated on the SAME amount rule — widening this one
     * alone would have converted a wrong failure into a permanently stuck invoice.
     */
    if (input.session !== "on_session" && a.result.status === "requires_action")
      return bookPending(pm, a, "in_progress");
    last = { pm, a };
    if (isDeadMandateDecline(a.result, pm))
      await markPaymentMethodInvalid(organizationId, pm.id, "mandate");
    if (shouldTryBackup(a.result) && i < order.length - 1) {
      // A decline with a backup still to try. `isHardDecline` (not `shouldTryBackup`)
      // gates the INVALID marking: a soft decline or a mandate-ceiling refusal moves on
      // without blaming this card.
      if (isHardDecline(a.result)) await markInvalid(pm);
      declined.push({ pm, a });
      continue;
    }
    if (isHardDecline(a.result)) await markInvalid(pm);
    break; // decline on the last candidate, or no fallback allowed → dunning path
  }

  // Rows are booked in CHARGE order — those before the governing decline, then it, then
  // the rest — so the payment history reads as the cards were actually tried.
  let bookAfter: Array<{ pm: Pm; a: Attempt }> = [];
  if (last!.a.result.status === "failed" && declined.length > 0) {
    const pool = [...declined, last!];
    // Stable: on a tie the earlier card (the primary) governs.
    const governing = pool.reduce((best, d) =>
      collectionRank(d.a.result) < collectionRank(best.a.result) ? d : best,
    );
    const at = pool.indexOf(governing);
    declined.splice(0, declined.length, ...pool.slice(0, at));
    bookAfter = pool.slice(at + 1);
    last = governing;
  }
  await flushDeclined();

  const { pm: failedPm, a } = last!;
  // ON-SESSION 3DS: the buyer is present, so the challenge is completable —
  // record NOTHING and hand back the intent that carries it. The invoice keeps its
  // attempt count, its dunning state and its `next_attempt_at`, because no attempt
  // has failed; consuming the intent settles it.
  //
  // Off-session (the default, and every automated path) falls straight through to
  // the dunning failure below — unchanged.
  if (input.session === "on_session" && a.result.status === "requires_action") {
    const challenge = await intentForOnSessionChallenge({
      organizationId,
      businessId,
      pm: failedPm,
      amountMinor: due,
      currency: invoice.currency,
      invoicePublicId: invoice.publicId,
      ...(input.subscription ? { subscriptionPublicId: input.subscription.publicId } : {}),
      ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
      ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
    });
    if (challenge)
      throw new PaymentActionRequiredError(challenge.intent, challenge.attempt, invoice.publicId);
  }
  /**
   * A `requires_action` reaching HERE is now the narrow residue: off-session books
   * pending above, and on-session throws — so this is an on-session challenge whose
   * intent could not be minted.
   *
   * It must still be classified, and `requires_action` is not a token anything knows.
   * It is the gateway's STATUS, and it appeared in none of `STRIPE_CODE_TABLE`,
   * `ALL_DECLINE_RULES`, `TERMINATE` or `PARK` — so `classifyDecline` fell to its
   * liberal default and RETRIED an unauthenticated debit, which is what armed the
   * ladder on INV-100001. `authentication_required` is the canonical token both
   * gateway tables already normalise every authentication code onto, and the policy
   * parks it: "3DS/SCA — customer action recovers it". That is the true remedy.
   */
  const failureCode =
    a.result.failure?.code ??
    (a.result.status === "requires_action" ? AWAITING_AUTHENTICATION_CODE : "charge_failed");
  const failureMessage =
    a.result.failure?.message ??
    (a.result.status === "requires_action"
      ? "The payment needs additional authentication."
      : "Charge failed");
  // `?? true` is the right default for an unclassified failure — it keeps a working
  // instrument from being marked invalid. But an authentication challenge is not
  // unclassified: retrying it re-asks a question only the buyer can answer.
  const retriable =
    a.result.failure?.retriable ?? (a.result.status === "requires_action" ? false : true);
  const pay = await recordFailedPayment({
    organizationId,
    businessId,
    invoice,
    paymentMethodId: failedPm.id,
    methodType: methodTypeOf(a.result, failedPm),
    providerKey: a.gatewayKey,
    amountMinor: due,
    failureCode,
    failureMessage,
    exposedToPayer: a.result.failure?.exposedToPayer,
    retriable,
    autoCollectOn,
    subscriptionStatus: input.subscription?.status ?? null,
    manualAttempt: input.manualAttempt,
    retryAfterMs: a.result.failure?.retryAfterMs,
  });
  // Gateway-facing failure transaction.
  await recordTransaction({
    organizationId,
    businessId,
    customerId: invoice.customerId,
    type: "payment",
    status: "failed",
    amountMinor: due,
    currency: invoice.currency,
    gatewayAccountId: a.account?.id ?? null,
    gatewayKey: a.gatewayKey,
    idAtGateway: a.result.providerChargeId ?? null,
    paymentMethodId: failedPm.id,
    invoiceId: invoice.id,
    paymentId: pay.id,
    // `retriable` is already in scope here — it is what decided whether dunning
    // got armed above. Persisting it makes the Retries screen's Hard/Soft column
    // a fact rather than an inference from `attempt_count`.
    errorCode: failureCode,
    errorText: failureMessage,
    retriable,
  });
  for (const d of bookAfter) await recordSupersededDecline(d.pm, d.a);
  if (MANDATE_REVOKED_CODES.has(failureCode) && invoice.dunningStatus !== "parked")
    await requestNewMandate(organizationId, businessId, invoice);
  return pay;
}

/**
 * `mandate_revoked: request_new_mandate`: the decline just parked the invoice, so ask the
 * customer for a new payment method once. Best-effort: the park stands whether or not the
 * email goes out, and collect-on-payment-method-update recovers the invoice.
 */
async function requestNewMandate(
  organizationId: string,
  businessId: string,
  invoice: Invoice,
): Promise<void> {
  try {
    const ctx = await withTenant(organizationId, async (tx) => {
      const [biz] = await tx
        .select({ billingRulesConfig: businesses.billingRulesConfig })
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .limit(1);
      const [inv] = await tx
        .select({ dunningStatus: invoices.dunningStatus })
        .from(invoices)
        .where(eq(invoices.id, invoice.id))
        .limit(1);
      const [cus] = await tx
        .select({ publicId: customers.publicId })
        .from(customers)
        .where(eq(customers.id, invoice.customerId))
        .limit(1);
      return { rule: resolveBillingRulesConfig(biz).mandateRevoked, inv, cus };
    });
    if (ctx.rule !== "request_new_mandate" || ctx.inv?.dunningStatus !== "parked" || !ctx.cus)
      return;
    const { sendAdhocEmail } = await import("@/modules/emails/adhoc-service");
    const sent = await sendAdhocEmail(organizationId, businessId, {
      type: "payment_method_request",
      customerId: ctx.cus.publicId,
    });
    if (!sent.ok)
      log.warn("payment method request after a revoked mandate was not sent", {
        invoice: invoice.publicId,
        error: sent.error,
      });
  } catch (e) {
    log.warn("payment method request after a revoked mandate failed", {
      invoice: invoice.publicId,
      error: (e as Error)?.message,
    });
  }
}

/**
 * Billing LogIQ — "Collect Invoice on Payment Method Update".
 * When a customer adds/updates a payment method, immediately attempt to collect
 * their open `payment_due` invoices (oldest-first) against the new card, so a
 * dunning / no-card invoice recovers the moment a chargeable method appears.
 *
 * Gated per-business by `dunningConfig.collectOnPaymentMethodUpdate` (default on);
 * `collectOpenInvoices` overrides it for one call (omitted = the business rule).
 * Only auto-collect-ON invoices are charged — offline (auto-collect-off) invoices
 * are left alone. Best-effort: a per-invoice failure is isolated (the caller must
 * not fail the vault because a recovery charge declined).
 */
export async function collectOutstandingForNewPaymentMethod(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  paymentMethodPublicId: string;
  /** Per-call override of `collectOnPaymentMethodUpdate`. */
  collectOpenInvoices?: boolean;
}): Promise<{ enabled: boolean; collected: Array<{ invoice: string; status: string }> }> {
  const { organizationId, businessId, customerId } = input;

  const enabled =
    input.collectOpenInvoices ??
    (
      await withTenant(organizationId, (tx) =>
        loadEffectiveDunningConfig(tx, { businessId, customerId }),
      )
    ).collectOnPaymentMethodUpdate;
  if (!enabled) return { enabled: false, collected: [] };

  // Customer's open dues, oldest-first (same ordering as manual collect).
  const due = await withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.customerId, customerId), eq(invoices.status, "payment_due")))
      .orderBy(invoices.createdAt),
  );

  const collected: Array<{ invoice: string; status: string }> = [];
  for (const inv of due) {
    try {
      const sub = inv.subscriptionId
        ? await withTenant(
            organizationId,
            async (tx) =>
              (
                await tx
                  .select()
                  .from(subscriptions)
                  .where(eq(subscriptions.id, inv.subscriptionId!))
                  .limit(1)
              )[0] ?? undefined,
          )
        : undefined;
      // Only auto-collect-ON invoices are charged automatically.
      const custAuto = await withTenant(organizationId, async (tx) => {
        const [c] = await tx
          .select({ ac: customers.autoCollection })
          .from(customers)
          .where(eq(customers.id, customerId))
          .limit(1);
        return c?.ac ?? null;
      });
      if (!isAutoCollectOn(sub?.autoCollection ?? null, custAuto)) continue;
      // Credit on file before the card, as every collection path does.
      const { applyCreditBeforeCharge } = await import("@/modules/customers/collect");
      const credit = await applyCreditBeforeCharge({ organizationId, businessId, invoice: inv });
      if (credit.settled) {
        collected.push({ invoice: inv.publicId, status: "paid_with_credit" });
        continue;
      }
      const payment = await collectInvoice({
        organizationId,
        businessId,
        invoice: credit.invoice,
        subscription: sub,
        paymentMethodOverrideId: input.paymentMethodPublicId,
      });
      collected.push({ invoice: inv.publicId, status: payment.status });
    } catch (e) {
      // Isolate: one invoice's collection failure must not abort the rest / the vault.
      log.error(e, {
        event: "post_vault_collect_failed",
        invoice: inv.publicId,
        businessId: businessId,
      });
    }
  }
  return { enabled: true, collected };
}

async function recordFailedPayment(input: {
  organizationId: string;
  businessId: string;
  invoice: Invoice;
  /**
   * WHAT WAS ACTUALLY ATTEMPTED — `due` from `invoiceOutstanding`: the gross total minus
   * customer credit already applied minus cash already collected.
   *
   * This read `invoice.totalMinor` until 2026-09-03, which overstates every attempt on an
   * invoice carrying credit. Measured on two real rows: ₹41,816.84 booked where ₹31,057.60
   * was owed, ₹10,041.95 where ₹2,070.50 was owed — each overstatement exactly the credit
   * applied. 3,025 rows database-wide disagree with the `transactions` row written for the
   * SAME attempt, which correctly carries `due`.
   *
   * Not a display nit: `payment_failed` is emitted from this function with the row's
   * amount, `emailTypeForEvent` maps every such event to the payer's mail unconditionally,
   * and the template prints it — so the customer is told we tried to take a number we never
   * asked for. REQUIRED rather than optional, so a new call site cannot quietly inherit the
   * gross again: the compiler asks the question instead.
   */
  amountMinor: bigint;
  paymentMethodId: string | null;
  /** `payments.method_type`: what was tried. Required so a new caller cannot skip it. */
  methodType: MethodType | null;
  providerKey: string;
  failureCode: string;
  /** Operator text, stored as-is. The payer's copy is derived via `payerDeclineMessage`. */
  failureMessage: string;
  /** A merchant override's "Tell the customer" answer, off the adapter failure. */
  exposedToPayer?: boolean;
  /** Whether a retry could plausibly succeed. false (e.g. expired_card) → stop now. */
  retriable: boolean;
  /**
   * Whether automatic collection is on for this invoice (sub overrides customer).
   * When off (offline invoice), a failed charge must NOT arm automatic dunning.
   * Defaults to `true` for the auto-collect renewal/dunning paths.
   */
  autoCollectOn?: boolean;
  /**
   * Status of the subscription behind the invoice, or null for a one-time invoice.
   * Feeds the two dunning scope toggles via `dunningAppliesTo`.
   */
  subscriptionStatus?: string | null;
  /** Human-initiated attempt — excluded from the dunning count. See `collectInvoice`. */
  manualAttempt?: boolean;
  /** A wait the network or gateway stated (`failure.retryAfterMs`); floors the next attempt. */
  retryAfterMs?: number;
}): Promise<Payment> {
  const { organizationId, invoice } = input;
  return withTenant(organizationId, async (tx) => {
    const [pay] = await tx
      .insert(payments)
      .values({
        organizationId,
        businessId: input.businessId,
        customerId: invoice.customerId,
        invoiceId: invoice.id,
        paymentMethodId: input.paymentMethodId,
        publicId: publicId("pay"),
        status: "failed",
        amountMinor: input.amountMinor,
        currency: invoice.currency,
        providerKey: input.providerKey,
        methodType: input.methodType,
        failureCode: input.failureCode,
        failureMessage: input.failureMessage,
      })
      .returning();
    // A manual attempt does not advance the dunning schedule — manual collections are
    // excluded from the attempt count. Holding the count still is
    // enough on its own: `attempt_count` is the INDEX into the retry offsets, so
    // re-planning with an unchanged count recomputes the SAME `next_attempt_at` — the
    // schedule is left exactly where the clock put it. (That is only true now the
    // offsets anchor on the invoice due date; while they compounded from the previous
    // failure, every manual attempt also shoved the next retry further out.)
    //
    // ── The OTHER attempt that must not advance it (F-11) ────────────────────────────
    // A `mandate_pending` refusal never reached a gateway: the instrument is registered
    // under a mandate the bank has not confirmed yet (`initiated`, typically until T+1 on
    // netbanking), so `chargeWithMethod` refused it locally. Nothing about the invoice,
    // the amount or the instrument is wrong and the very same debit will succeed once the
    // bank confirms — spending one of the customer's scheduled retries on it is the whole
    // cost the guard exists to avoid. Held still for the same reason a manual attempt is,
    // and the payment row above still records that the attempt happened.
    //
    // The count hold alone is NOT sufficient here, unlike for a manual attempt: the clock
    // has already passed this slot's offset, `nextRetryAt` clamps a past candidate to
    // `now`, and the next pass would collect again immediately — one mail to the payer per
    // tick. `mandatePendingBackoff` supplies the explicit wait that goes with the hold,
    // and caps how long we are willing to keep waiting.
    //
    // TL-4: dunning retry scheduling is a time DECISION (nextAttemptAt = now +
    // retryDays). It has no threaded `now` (it's the collection failure path, not a
    // clock pass), so it must resolve through businessNow — under time travel
    // travel step this is the simulated instant, so the retry lands on the right
    // simulated day; real time otherwise.
    const now = businessNow(input.businessId);
    // Counted only for the code that can defer — every OTHER failure on this path (every
    // ordinary decline, on every dunning tick) would otherwise pay for a round trip whose
    // answer it cannot use. Derived from the rows rather than stored, and the payment for
    // THIS attempt is already inserted above, so a first refusal counts 1. Same discipline
    // as `bookedAttemptsForInvoice`: counting what happened beats a column kept true by hand.
    const deferralsSoFar =
      input.failureCode === MANDATE_PENDING_CODE
        ? Number(
            (
              await tx
                .select({ n: sql<string>`count(*)` })
                .from(payments)
                .where(
                  and(
                    eq(payments.invoiceId, invoice.id),
                    eq(payments.failureCode, MANDATE_PENDING_CODE),
                  ),
                )
            )[0]?.n ?? 0,
          )
        : 0;
    const mandateDeferral = mandatePendingBackoff({
      failureCode: input.failureCode,
      deferralsSoFar,
      now,
    });
    const newAttemptCount =
      input.manualAttempt || mandateDeferral ? invoice.attemptCount : invoice.attemptCount + 1;
    // Business-configurable retry offsets (Settings → Dunning); default [1,3,5,7].
    const [bizDunning] = await tx
      .select({
        retryDays: businesses.dunningRetryDays,
        dunningConfig: businesses.dunningConfig,
        timezone: businesses.timezone,
        billingRulesConfig: businesses.billingRulesConfig,
      })
      .from(businesses)
      .where(eq(businesses.id, input.businessId))
      .limit(1);
    // Re-read the invoice's live dunning state so a concurrent stop/pause isn't
    // clobbered by a stale snapshot passed in by the caller.
    const [live] = await tx
      .select({
        dunningStatus: invoices.dunningStatus,
        nextAttemptAt: invoices.nextAttemptAt,
        dunningHeldMs: invoices.dunningHeldMs,
      })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);
    // Due date moved later by any time an exclusion froze this invoice's dunning.
    const anchor = dunningAnchor({
      dueDate: invoice.dueDate,
      dunningHeldMs: live?.dunningHeldMs ?? invoice.dunningHeldMs,
    });
    const dunningCfg = await loadEffectiveDunningConfig(tx, {
      businessId: input.businessId,
      customerId: invoice.customerId,
      subscriptionId: invoice.subscriptionId,
    });
    // Exclusion and the minimum stop dunning from STARTING. An invoice already in dunning
    // keeps its schedule; the passes hold it.
    const liveDunningStatus = live ? live.dunningStatus : invoice.dunningStatus;
    const startHeld =
      liveDunningStatus == null && (await dunningHoldFor(tx, invoice, dunningCfg)) !== null;
    // On this transaction, not a second one: a nested `withTenant` holds this connection while
    // waiting for another, and a decline wave that fills the pool deadlocks it (D4).
    const [failedRailRow] = input.paymentMethodId
      ? await tx
          .select({
            rail: paymentMethods.mandateRail,
            type: paymentMethods.type,
            issuerZones: countries.timezones,
          })
          .from(paymentMethods)
          .leftJoin(countries, eq(countries.code, paymentMethods.issuerCountry))
          .where(eq(paymentMethods.id, input.paymentMethodId))
          .limit(1)
      : [];
    const failedRail = failedRailRow?.rail ?? null;
    const failedIssuerZones = failedRailRow?.issuerZones ?? null;
    const plan = planFailureRearm({
      dunningStatus: live?.dunningStatus ?? invoice.dunningStatus,
      currentNextAttemptAt: live?.nextAttemptAt ?? invoice.nextAttemptAt,
      autoCollectOn: input.autoCollectOn ?? true,
      retriable: input.retriable,
      newAttemptCount,
      retryDays: dunningCfg.retryDays,
      now,
      mode: dunningCfg.mode,
      skipRetriesForHardFailures: dunningCfg.skipRetriesForHardFailures,
      parkHardDeclines: dunningCfg.parkHardDeclines,
      // Normalized decline code from the charge failure at THIS site.
      declineCode: input.failureCode,
      // Master switch + the trial/future and one-time-invoice scope toggles.
      dunningApplies:
        !startHeld &&
        dunningAppliesTo(dunningCfg, {
          hasSubscription: invoice.subscriptionId != null,
          subscriptionStatus: input.subscriptionStatus,
        }),
      periodEndsAt: dunningPeriodEndsAt(dunningCfg, anchor),
      // Every retry offset is measured from the DUE DATE, not from the last
      // failure — same anchor the period above already uses. See `nextRetryAt`.
      dueDate: anchor,
      // NPCI caps presentations per RAIL (3 retries on UPI / e-NACH) while the
      // merchant's schedule is per business, so the instrument that just failed
      // decides how much of that schedule can actually run. Null for a card or a
      // non-mandate instrument — those are uncapped.
      mandateRail: failedRail,
      adaptiveTiming: dunningCfg.adaptiveTiming,
      timezone: bizDunning?.timezone ?? null,
      issuerZones: failedIssuerZones,
      networkRetryAfterMs: input.retryAfterMs,
      mandateRevoked: resolveBillingRulesConfig(bizDunning).mandateRevoked,
      methodType: failedRailRow?.type ?? null,
      retriesByMethod: dunningCfg.retriesByMethod,
      adaptiveCadence: dunningCfg.adaptiveCadence,
      priorMethods: await priorFailedMethods(tx, invoice.id, pay!.id),
    });

    /**
     * Always record the attempt; the rest of the update depends on the plan.
     *
     * `send_invoice` is the THIRD case that must not move the counter (2026-08-31).
     * Auto-collection is off, so this charge should never have been presented — the
     * only caller that gets here is `createInvoiceFromLines` with `collect: true`,
     * which does not gate on auto-collection. Such an invoice reports
     * `dunning_attempts: []`, i.e. `attempt_count` 0. Booking it as attempt 1 also shifted
     * the whole retry schedule by one offset for an invoice with no schedule, and made
     * two offline invoices on one customer report different states.
     */
    const set: Partial<typeof invoices.$inferInsert> =
      input.manualAttempt || mandateDeferral || plan.action === "send_invoice"
        ? {}
        : { attemptCount: newAttemptCount };
    // The next retry as written (deferral or hold included), for the events below.
    let retryAt: Date | null = null;
    if (plan.action === "retry") {
      set.status = "payment_due";
      set.dunningStatus = "in_progress";
      // A pending-mandate deferral only ever REPLACES the retry instant, and only on this
      // branch. Deliberately not applied to the others: `stopped`, `paused`, `offline`,
      // `parked` and `exhausted` are dispositions someone chose (a merchant halt, a pause
      // window, auto-collect off, a spent schedule), and a mandate waiting on a bank is no
      // reason to overrule any of them — a deferral must never resurrect dunning that was
      // deliberately halted. Past the deferral cap `mandateDeferral` is null and this is
      // an ordinary retriable failure that takes `plan.nextAttempt`, so an abandoned
      // mandate reaches the schedule, the dunning period and the final action as usual.
      if (mandateDeferral) set.nextAttemptAt = mandateDeferral;
      else Object.assign(set, heldRetry(plan.nextAttempt, invoice.retryHoldUntil));
      retryAt = set.nextAttemptAt ?? plan.nextAttempt;
    } else if (plan.action === "parked") {
      // Smart mode, hard-recoverable decline: invoice stays open (payment_due),
      // dunning parked, NO auto-retry; the subscription is NOT cancelled. Recovered
      // when the customer updates their card (collect-on-PM-update).
      set.status = "payment_due";
      set.dunningStatus = "parked";
      set.nextAttemptAt = null;
      /**
       * THE ANCHOR IS SET ON THE WAY IN, ONCE — not on every park.
       *
       * It was written unconditionally, so anything that re-parked an already-parked
       * invoice restarted its thirty-day window: a portal Pay-now that failed, a
       * customer adding a second bad card, any manual collect. A determined customer
       * could hold an invoice open indefinitely without ever paying it, and the window
       * that `sweepExpiredParkedDunning` exists to close would never close.
       *
       * Leaving BOTH columns alone on a re-park is deliberate: the reminder ladder is
       * derived from the original anchor, so not touching it keeps the rungs where they
       * were rather than replaying the ladder from the top. Nothing is lost — the park is
       * already the state, and the refusal that caused the re-park is on the payment row.
       */
      const alreadyParked = (live?.dunningStatus ?? invoice.dunningStatus) === "parked";
      if (!alreadyParked) {
        // The window's anchor: a park has no retry to count down from (0232).
        set.dunningParkedAt = now;
        // …and the contact ladder that runs inside the window (0283). NOT `nextAttemptAt`:
        // a parked invoice is auto-collect-ON, so a rung written there would be CHARGED.
        set.dunningNextReminderAt = nextParkedReminderAt(
          dunningCfg,
          now,
          now,
          retryDaysForMethod(dunningCfg, failedRailRow?.type, failedRail),
        );
      }
    } else if (plan.action === "exhausted") {
      set.status = "not_paid";
      set.dunningStatus = "exhausted";
      set.nextAttemptAt = null;
      // When dunning gave up (0282) — the dated half of the recovery rate.
      set.dunningExhaustedAt = now;
      set.dunningExhaustedCode = input.failureCode;
    } else if (plan.action === "offline") {
      // Dunning switched off for this business (or excluded for this invoice's class)
      // while auto-collection is ON: a charge really was attempted and really failed,
      // so the debt stands as not_paid, with no automatic retry.
      set.status = "not_paid";
      set.nextAttemptAt = null;
      // A live dunning state on a not_paid invoice is a claim no sweep will act on.
      if (isLiveDunning(live?.dunningStatus ?? invoice.dunningStatus)) set.dunningStatus = null;
    }
    /**
     * `send_invoice` (auto-collect off) writes NOTHING — no status, no dunning_status,
     * no next_attempt_at, and no attempt (above).
     *
     * An `auto_collection: off` unpaid invoice is `payment_due` + `dunning_status:
     * in_progress` + `next_retry_at = date + first retry interval` +
     * `dunning_attempts: []`. This branch used to set `not_paid` and
     * `next_attempt_at = null`, which was wrong three ways at once — a wrong status, a
     * destroyed reminder schedule, and (with the counter above) a phantom attempt.
     *
     * A charge that auto-collection rules out must leave no trace on the invoice. The
     * `payments` row inserted above is still the record that someone tried.
     */
    // 'stopped' / 'paused': leave status, dunning_status and nextAttemptAt as-is
    // (only the attempt counter moves) — the merchant's halt/pause is preserved.
    //
    // A MANUAL attempt against a stopped/paused invoice leaves `set` genuinely empty —
    // it moves no counter and the plan touches nothing — and Drizzle rejects an update
    // with no values ("No values to set"). Skipping the write is the correct expression
    // of "this attempt changed nothing about the invoice"; the payment row above is
    // still the record that it happened.
    if (Object.keys(set).length > 0) {
      await tx.update(invoices).set(set).where(eq(invoices.id, invoice.id));
    }

    await emitEvent(tx, {
      organizationId,
      businessId: input.businessId,
      type: "payment_failed",
      // Same amount/status contract as the synchronous failure above.
      data: buildEventData("payment_failed", {
        id: pay!.publicId,
        status: "failed",
        amount_minor: Number(pay!.amountMinor),
        currency: invoice.currency,
        invoice: invoice.publicId,
        code: input.failureCode,
        // Payer-facing: it becomes `declineMessage` in their mail.
        message: payerDeclineMessage(
          {
            code: input.failureCode,
            message: input.failureMessage,
            exposedToPayer: input.exposedToPayer,
          },
          NO_REASON_FROM_PROVIDER,
        ),
        retriable: input.retriable,
        /**
         * When we will try again — the value actually WRITTEN above, deferral included,
         * not `plan.nextAttempt`. The two differ on a pending mandate, and an email that
         * named a date the clock was not going to honour would be its own defect.
         *
         * Null on every other disposition: a park, an exhaustion, a merchant's stop and
         * an offline invoice have no next attempt, and the facts card drops the row
         * rather than promising one.
         */
        next_attempt_at: retryAt ? retryAt.toISOString() : null,
      }),
    });
    if (plan.action === "exhausted") {
      await emitEvent(tx, {
        organizationId,
        businessId: input.businessId,
        type: "invoice_dunning_exhausted",
        data: buildEventData("invoice_dunning_exhausted", {
          id: invoice.publicId,
          attempts: newAttemptCount,
        }),
      });
      await emitEvent(tx, {
        organizationId,
        businessId: input.businessId,
        type: "invoice_not_paid",
        data: buildEventData("invoice_not_paid", { id: invoice.publicId }),
      });
    } else if (plan.action === "offline") {
      await emitEvent(tx, {
        organizationId,
        businessId: input.businessId,
        type: "invoice_not_paid",
        data: buildEventData("invoice_not_paid", { id: invoice.publicId }),
      });
      // `send_invoice` deliberately emits NOTHING beyond payment.failed above: the
      // invoice did not change state, and `invoice_not_paid` would announce a
      // transition that did not happen (and, on an offline invoice, never will until
      // its dunning window exhausts).
    } else if (plan.action === "parked") {
      // Parked: invoice stays open with no next attempt. Emit invoice_payment_due
      // (keeps the payment_failed customer email + downstream firing) but NOT
      // dunning_exhausted / not_paid — the debt is retained, not terminal.
      await emitEvent(tx, {
        organizationId,
        businessId: input.businessId,
        type: "invoice_payment_due",
        data: buildEventData(
          "invoice_payment_due",
          { id: invoice.publicId, next_attempt_at: null },
          null,
          { dunning: "parked" },
        ),
      });
    } else if (plan.action === "retry") {
      await emitEvent(tx, {
        organizationId,
        businessId: input.businessId,
        type: "invoice_payment_due",
        data: buildEventData("invoice_payment_due", {
          id: invoice.publicId,
          next_attempt_at: retryAt,
        }),
      });
      if (newAttemptCount === 1) {
        await emitEvent(tx, {
          organizationId,
          businessId: input.businessId,
          type: "invoice_dunning_started",
          data: buildEventData("invoice_dunning_started", { id: invoice.publicId }),
        });
      }
    }
    // 'stopped' / 'paused' emit only payment.failed — the schedule is untouched.
    return pay!;
  });
}

/** List a business's payments (newest first) — for the ops portal. */
export async function listPaymentsForBusiness(
  organizationId: string,
  businessId: string,
): Promise<Array<Payment>> {
  return withTenant(organizationId, async (tx) =>
    tx
      .select()
      .from(payments)
      .where(eq(payments.businessId, businessId))
      .orderBy(desc(payments.createdAt))
      .limit(200),
  );
}

export interface InvoiceListRow {
  invoice: Invoice;
  customerPublicId: string | null;
  /**
   * Display name/email for the index's Customer column. The name is already
   * RESOLVED (`accountHolderName`) — never a single column, so the list and the
   * `customer_name` filter agree on what this customer is called.
   */
  customerName?: string | null;
  customerEmail?: string | null;
  subscriptionPublicId: string | null;
  /** Sum of succeeded payments against this invoice (cash actually collected). */
  paidMinor: bigint;
}

/**
 * What each invoice has settled, in TWO queries: succeeded payments, plus the refunds of
 * payments the gateway later reversed. A late reversal takes back only what the payment still
 * held (`postLateReversal`), so the refunded part stays settled and the invoice reopens for
 * amount − refunds. Exported so a reporting path can subtract payments without either N
 * round-trips or a second hand-rolled sum of its own — the stored `amount_due_minor` column
 * never has cash taken off it, so every reader of that column owes this subtraction.
 */
export async function paidTotals(tx: Tx, invoiceIds: string[]): Promise<Map<string, bigint>> {
  if (invoiceIds.length === 0) return new Map();
  const rows = await tx
    .select({
      invoiceId: payments.invoiceId,
      paid: sql<string>`coalesce(sum(${payments.amountMinor}), 0)`,
    })
    .from(payments)
    .where(and(inArray(payments.invoiceId, invoiceIds), eq(payments.status, "succeeded")))
    .groupBy(payments.invoiceId);
  const reversedRefunds = await tx
    .select({
      invoiceId: payments.invoiceId,
      refunded: sql<string>`coalesce(sum(${refunds.amountMinor}), 0)`,
    })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .where(
      and(
        inArray(payments.invoiceId, invoiceIds),
        eq(payments.status, "failed"),
        ne(refunds.status, "failed"),
      ),
    )
    .groupBy(payments.invoiceId);
  const out = new Map<string, bigint>();
  for (const r of rows) if (r.invoiceId != null) out.set(r.invoiceId, BigInt(r.paid));
  for (const r of reversedRefunds)
    if (r.invoiceId != null)
      out.set(r.invoiceId, (out.get(r.invoiceId) ?? 0n) + BigInt(r.refunded));
  return out;
}

/**
 * What one invoice has actually collected, and what is STILL collectible.
 *
 * The stored `amount_due_minor` column is the issue-time collectible, net of
 * CREDIT applications only — it is deliberately never decremented by cash
 * payments (`serializeInvoice` subtracts `paidMinor` from it for display, so
 * decrementing it here would double-count every payment). Which means any path
 * that decides "how much money to take now" MUST subtract prior payments itself.
 *
 * Skipping that is how INV-2309 got collected twice (2026-08-04): three offline
 * part-payments added up to the total, none of them moved the stored column, so
 * the next "mark as paid" read the FULL total as outstanding and took it again.
 * Every collection path now goes through this one function.
 */
export async function invoiceOutstanding(
  tx: Tx,
  inv: { id: string; amountDueMinor: bigint | null; totalMinor: bigint },
): Promise<{ paidMinor: bigint; remainingMinor: bigint }> {
  const paidMinor = (await paidTotals(tx, [inv.id])).get(inv.id) ?? 0n;
  const remaining = (inv.amountDueMinor ?? inv.totalMinor) - paidMinor;
  return { paidMinor, remainingMinor: remaining > 0n ? remaining : 0n };
}

/**
 * Whether dunning is held for this invoice: its customer is excluded from dunning, or what
 * is left to pay is below the business's minimum for the currency. Null = dunning may run.
 * Nothing is written: the invoice keeps its schedule, so lifting the hold resumes it.
 */
export async function dunningHoldFor(
  tx: Tx,
  inv: {
    id: string;
    customerId: string;
    currency: string;
    amountDueMinor: bigint | null;
    totalMinor: bigint;
  },
  config: DunningConfig,
): Promise<DunningHold | null> {
  const [cust] = await tx
    .select({ excluded: customers.dunningExcluded })
    .from(customers)
    .where(eq(customers.id, inv.customerId))
    .limit(1);
  const customerExcluded = cust?.excluded === true;
  // Only read payments when a minimum could apply.
  const outstandingMinor =
    customerExcluded || config.minimumAmounts[inv.currency.toUpperCase()] === undefined
      ? 0n
      : (await invoiceOutstanding(tx, inv)).remainingMinor;
  return dunningHoldReason(config, { customerExcluded, currency: inv.currency, outstandingMinor });
}

// ── Paginated list (see docs/GUIDE.md §3.4 for the shared contract) ────────────

/**
 * `period_end` as the API REPORTS it, for filtering.
 *
 * A filter must narrow on the value the caller can see. `serializeInvoice` reports a
 * day-anchored period end inclusively (`inclusivePeriodEnd` → `inclusiveBoundary`), so a
 * list showing "25 Aug" is backed by a row storing 26-Aug 00:00 — and filtering the raw
 * column for the 25th matched nothing at all. The dashboard offers exactly that filter.
 *
 * Mirrors the reporting rule term for term, INCLUDING its local-midnight guard: only a
 * true day boundary is backed off, because only for one is "the last instant of the final
 * day" a statement about the same moment. A caller-chosen mid-day period end is compared
 * as stored, which is also how it is reported.
 */
function reportedPeriodEnd(tz: string): SQL {
  return sql`
    CASE WHEN (${invoices.periodEnd} AT TIME ZONE ${tz})::time = TIME '00:00:00'
         THEN ${invoices.periodEnd} - INTERVAL '1 second'
         ELSE ${invoices.periodEnd} END`;
}

/**
 * Filterable columns — customer/subscription come off the joined rows.
 *
 * A function of the business's convention rather than a constant, because `period_end`'s
 * comparable expression depends on it. `dayAnchoredTz` is the business timezone when this
 * business reports period ends inclusively, and null when it reports them raw.
 */
function listFilters(dayAnchoredTz: string | null): Record<string, FilterSpec> {
  return {
    ...LIST_FILTERS,
    ...(dayAnchoredTz
      ? { period_end: { column: reportedPeriodEnd(dayAnchoredTz), kind: "date" as const } }
      : {}),
  };
}

/**
 * The REPORTED `total_minor` — the stored gross claim less the promotional slice, which
 * the document and the API present as a pre-tax discount (see `serializeInvoice`). Filter
 * and sort have to use the same expression the response prints, or `?total_minor[gt]=…`
 * answers a question about a number the caller never saw.
 */
const reportedTotalMinor: SQL = sql`(${invoices.totalMinor} - ${invoices.promotionalCreditsAppliedMinor} - ${invoices.grantCreditsPreTaxMinor})`;

/**
 * The REPORTED `credits_applied_minor` — the POST-tax balance buckets only.
 *
 * `serializeInvoice` sums exactly `refundable + excess` and deliberately leaves the
 * promotional bucket out, because that one is reported as a pre-tax DISCOUNT
 * (`promotional_discount_minor`). Adding it back here would filter on a figure the
 * document never states and double-count the promo — the same mistake the response itself
 * made until 2026-08-25.
 */
const reportedCreditsAppliedMinor: SQL = sql`(${invoices.refundableCreditsAppliedMinor} + ${invoices.excessPaymentsAppliedMinor} + ${invoices.grantCreditsPostTaxMinor})`;

/**
 * The REPORTED `amount_paid_minor` — cash actually collected.
 *
 * Not a column: `paidTotals` aggregates `payments` for the page AFTER the page is fetched,
 * so a filter has to re-express that aggregate. Same table and same status predicate as
 * `paidTotals`, or the filter and the printed number disagree. Costs one
 * `payments_invoice_idx` lookup per candidate row, and only when the filter is asked for.
 */
const reportedAmountPaidMinor: SQL = sql`coalesce((SELECT sum(${payments.amountMinor}) FROM ${payments} WHERE ${payments.invoiceId} = ${invoices.id} AND ${payments.status} = ${"succeeded"}), 0)`;

/**
 * The REPORTED `amount_due_minor` — what is STILL collectible.
 *
 * ⚠️ The COLUMN is the issue-time collectible and is never decremented as cash lands
 * (`invoiceOutstanding`, and the column comment in db/schema/invoices.ts): the majority of
 * `paid` rows still carry a non-zero value there. This map filtered the raw column until
 * 2026-08-31, so `?amount_due_minor[gt]=0` — "show me what is owed" — answered with every
 * settled invoice in the business. Exactly the failure the raw `period_end` filter had.
 *
 * Mirrors `serializeInvoice` term for term, including the two zeroing cases (written-off
 * and voided owe nothing) and the floor at zero (an overpaid invoice is not owed a
 * negative amount).
 */
const reportedAmountDueMinor: SQL = sql`
  CASE WHEN ${invoices.writtenOff} OR ${invoices.status} = 'voided' THEN 0
       ELSE greatest(coalesce(${invoices.amountDueMinor}, ${reportedTotalMinor}) - ${reportedAmountPaidMinor}, 0) END`;

const LIST_FILTERS: Record<string, FilterSpec> = {
  id: { column: invoices.publicId, kind: "text" },
  number: { column: invoices.number, kind: "text" },
  status: { column: invoices.status, kind: "enum" },
  // Dunning sub-state, the other half of "why is this unpaid": `payment_due` covers both a
  // Net-D invoice not yet chased and one three retries into dunning, and only this
  // separates them. Vocabulary + NULL enforced by `invoices_dunning_status_ck` (0218,
  // renamed in 0321); the old `success` still matches as a deprecated alias.
  dunning_status: { column: invoices.dunningStatus, kind: "enum", aliases: DUNNING_STATUS_ALIASES },
  /**
   * Which rung of the ageing ladder, so "£40k is 61–90 days overdue" reaches the invoices
   * behind it. A derived range over `due_date` relative to now, not a column.
   *
   * ⚠ Its condition does NOT come from this column. The rung name carries its own
   * boundaries, and `arAgingBucketCondition` derives the predicate from the name, so the
   * filter answers at whatever interval the report printed its rungs at. The entry stays
   * here for its KIND — which is what gives the field its operator table — and
   * `listInvoicesPage` routes the value past `filterConditions`. Says nothing about status
   * or write-off; the drill-down carries the report's population in its own `status` /
   * `written_off` rows.
   */
  ar_bucket: { column: arAgingBucketSql(), kind: "enum" },
  currency: { column: invoices.currency, kind: "enum" },
  // How the invoice came to exist (api | dashboard | system | import) — the "Channel"
  // column. Null on rows predating the column, so `is_present` is how to find those.
  channel: { column: invoices.channel, kind: "enum" },
  imported: { column: invoices.imported, kind: "bool" },
  // Bad debt: `status` reads `paid` on these because a write-off CN zeroed the balance
  // (INV-4), so nothing in `status` tells them apart from money that actually arrived.
  written_off: { column: invoices.writtenOff, kind: "bool" },

  // ── Money. Each of these compares the number the response PRINTS, never the raw column,
  // wherever the two differ — see the `reported*` expressions above.
  subtotal_minor: { column: invoices.subtotalMinor, kind: "number" },
  total_minor: { column: reportedTotalMinor, kind: "number" },
  // Field id is the SERIALIZED name, not the column's: the response calls this bucket
  // `promotional_discount_minor` because it presents it as a pre-tax discount.
  promotional_discount_minor: { column: invoices.promotionalCreditsAppliedMinor, kind: "number" },
  credits_applied_minor: { column: reportedCreditsAppliedMinor, kind: "number" },
  amount_paid_minor: { column: reportedAmountPaidMinor, kind: "number" },
  amount_due_minor: { column: reportedAmountDueMinor, kind: "number" },
  withholding_minor: { column: invoices.withholdingMinor, kind: "number" },
  attempt_count: { column: invoices.attemptCount, kind: "number" },

  // ── Dates. All of them bucket by the BUSINESS day (`filterConditions`'s tz argument).
  created_at: { column: invoices.createdAt, kind: "date" },
  period_start: { column: invoices.periodStart, kind: "date" },
  period_end: { column: invoices.periodEnd, kind: "date" },
  due_date: { column: invoices.dueDate, kind: "date" },
  paid_at: { column: invoices.paidAt, kind: "date" },
  voided_at: { column: invoices.voidedAt, kind: "date" },
  next_attempt_at: { column: invoices.nextAttemptAt, kind: "date" },
  // When dunning gave up — narrows "unpaid after retries" to a recent window.
  dunning_exhausted_at: { column: invoices.dunningExhaustedAt, kind: "date" },
  // A collections FORECAST, deliberately not a payment term — nothing in the engine reads
  // it, so narrowing on it can never be mistaken for narrowing on when we dun.
  expected_payment_date: { column: invoices.expectedPaymentDate, kind: "date" },

  // Buyer's PO reference: free text, printed on the document, no engine behaviour.
  po_number: { column: invoices.poNumber, kind: "text" },

  // FX SNAPSHOT (0228) — filterable for the same reason the tax snapshot below is: it is
  // frozen at issue, so a filtered export does not change under the operator's feet when
  // today's rate moves. `exchange_rate[is_present]=false` is the useful one — "which
  // invoices carry no rate", i.e. what a converted report cannot account for — and the
  // numeric comparisons accept decimals (`kind: "number"` validates any finite number,
  // not just integers), so `exchange_rate[gt]=95` works on a rate as well as on money.
  exchange_rate: { column: invoices.exchangeRate, kind: "number" },
  exchange_rate_base: { column: invoices.exchangeRateBase, kind: "enum" },

  // ── Tax determination SNAPSHOT (frozen at issue, which is what makes it filterable at
  // all: re-deriving from current config would move historical rows in and out of a
  // result set the operator already exported).
  seller_state_code: { column: invoices.sellerStateCode, kind: "enum" },
  place_of_supply_code: { column: invoices.placeOfSupplyCode, kind: "enum" },
  tax_treatment: { column: invoices.taxTreatment, kind: "enum" },
  tax_note: { column: invoices.taxNote, kind: "text" },

  customer: { column: customers.publicId, kind: "text" },
  // The RESOLVED account-holder name, not the legacy `customers.name` column — the
  // same chain the row's `customer_name` is rendered from (`customers/name-sql.ts`).
  // Against the bare column this filter answered "no invoices" for every customer
  // created through the API with first/last names, which is most of them.
  customer_name: { column: accountHolderNameSql, kind: "text" },
  customer_email: { column: customers.email, kind: "text" },
  subscription: { column: subscriptions.publicId, kind: "text" },
  // Recurring = raised for a subscription; one-off = not. Reads the invoice's own FK, the
  // same fact `subscription[is_present]` answers through the join.
  recurring: { column: sql`(${invoices.subscriptionId} IS NOT NULL)`, kind: "bool" },
};

/**
 * Both allow-lists come from `listFilters`, not from `LIST_FILTERS` directly: the business
 * convention decides `period_end`'s comparable EXPRESSION and never the field set or its
 * kind, so any zone yields the same maps — and a field living only in the conditional half
 * stays covered, instead of being one the route accepts but cannot validate.
 */
export const INVOICE_FILTER_OPS = opsFromSpecs(listFilters("UTC"));
export const INVOICE_FILTER_KINDS = kindsFromSpecs(listFilters("UTC"));

/**
 * Sortable columns. `created_at` is the keyset path (`invoices_business_created_idx`) and
 * `status` is indexed; the rest are plain single columns, cheap enough for the offset path.
 * Deliberately NOT here: `amount_due_minor` and `amount_paid_minor`, whose reported
 * expressions carry a correlated `payments` subquery — sorting a whole business by one
 * would do an index lookup per invoice on the fastest-growing table in the product.
 */
const LIST_SORTS = {
  created_at: invoices.createdAt,
  number: documentNumberSortKey(invoices.number),
  status: invoices.status,
  subtotal_minor: invoices.subtotalMinor,
  total_minor: reportedTotalMinor,
  period_start: invoices.periodStart,
  period_end: invoices.periodEnd,
  due_date: invoices.dueDate,
  paid_at: invoices.paidAt,
} as const;

export type InvoiceSortField = keyof typeof LIST_SORTS;
export const INVOICE_SORT_FIELDS = Object.keys(LIST_SORTS) as InvoiceSortField[];

export interface InvoiceListFilters {
  customerId?: string;
  /** Tenant-scoped internal id — resolve `?subscription=sub_…` before calling in. */
  subscriptionId?: string;
  search?: string;
  filters?: ListFilter[];
  sortField?: string;
  sortDesc?: boolean;
  startingAfter?: string;
  limit?: number;
}

/**
 * One page of a business's invoices, newest-first.
 *
 * Invoices are the fastest-growing table in the product (~12 per subscription per
 * year), so this must never be an unbounded read: keyset on
 * `(created_at DESC, public_id DESC)` via `invoices_business_created_idx`, and the
 * succeeded-payment totals are summed for **the page only** — the unpaginated
 * version ran that aggregate across every invoice in the business.
 */
export async function listInvoicesPage(
  organizationId: string,
  businessId: string,
  f: InvoiceListFilters = {},
): Promise<ListPage<InvoiceListRow>> {
  const limit = clampLimit(f.limit);
  const sortField = (f.sortField ?? "created_at") as InvoiceSortField;
  const descending = f.sortDesc ?? true;
  const keyset = sortField === "created_at";

  return withTenant(organizationId, async (tx) => {
    const conds: SQL[] = [eq(invoices.businessId, businessId)];
    if (f.customerId) conds.push(eq(invoices.customerId, f.customerId));
    if (f.subscriptionId) conds.push(eq(invoices.subscriptionId, f.subscriptionId));
    const search = searchCondition(
      // Every name column the list can DISPLAY: the q box has to find a customer by
      // the name shown for them, whichever column it came from. The deprecated
      // `customers.name` is excluded (2026-08-23) — it is not displayed any more, so
      // matching on it would return rows whose visible name does not contain the query.
      [
        invoices.publicId,
        invoices.number,
        invoices.status,
        customers.publicId,
        customers.firstName,
        customers.lastName,
        customers.company,
        customers.email,
      ],
      f.search,
    );
    if (search) conds.push(search);
    // Date filters bucket by the BUSINESS day, not the UTC day (business-tz.ts).
    const tz = await businessTimezone(tx, businessId);
    const mode = await billingModeFor(tx, businessId);
    // `ar_bucket` is name-derived (see `LIST_FILTERS`), so it is built here and the rest go
    // through the shared column path.
    const filters = f.filters ?? [];
    for (const bucket of filters.filter((x) => x.field === "ar_bucket")) {
      const c = arAgingBucketCondition(bucket.op, bucket.value);
      if (c) conds.push(c);
    }
    conds.push(
      ...filterConditions(
        listFilters(mode.anchor === "day" ? tz : null),
        filters.filter((x) => x.field !== "ar_bucket"),
        tz,
      ),
    );

    let total: number | null = null;
    if (!f.startingAfter) {
      total = await cappedTotal(
        tx,
        tx
          .select({ one: sql`1` })
          .from(invoices)
          .leftJoin(customers, eq(invoices.customerId, customers.id))
          .leftJoin(subscriptions, eq(invoices.subscriptionId, subscriptions.id))
          .where(and(...conds)),
      );
    }

    const { keysetId, offset } = parseCursor(f.startingAfter);
    const pageConds = [...conds];
    if (keyset && keysetId) {
      const [cursor] = await tx
        .select({
          createdAt: sql<string>`${invoices.createdAt}::text`,
          publicId: invoices.publicId,
        })
        .from(invoices)
        .where(and(eq(invoices.businessId, businessId), eq(invoices.publicId, keysetId)))
        .limit(1);
      const seek = keysetCondition(
        invoices.createdAt,
        invoices.publicId,
        cursor ? { sortValue: cursor.createdAt, tiebreak: cursor.publicId } : undefined,
        descending,
      );
      if (seek) pageConds.push(seek);
    }

    const rows = await tx
      // Name/email ride along so the index can show a "Customer" column — it leads
      // the row, and we showed nothing. The customers table is already joined for
      // filtering, so this costs no extra query.
      .select({
        inv: invoices,
        cusPid: customers.publicId,
        // Four columns for one displayed name: `accountHolderName` resolves them
        // below. The legacy `name` alone left the column blank for every customer
        // created with first/last through the API.
        cusFirstName: customers.firstName,
        cusLastName: customers.lastName,
        cusCompany: customers.company,
        cusEmail: customers.email,
        subPid: subscriptions.publicId,
      })
      .from(invoices)
      .leftJoin(customers, eq(invoices.customerId, customers.id))
      .leftJoin(subscriptions, eq(invoices.subscriptionId, subscriptions.id))
      .where(and(...pageConds))
      .orderBy(...pageOrder(LIST_SORTS[sortField], invoices.publicId, descending, keyset))
      .limit(limit + 1)
      .offset(keyset ? 0 : offset);

    const page = toPage(rows, limit, { keyset, offset, keyOf: (r) => r.inv.publicId, total });
    const paid = await paidTotals(
      tx,
      page.data.map((r) => r.inv.id),
    );
    return {
      ...page,
      data: page.data.map((r) => ({
        invoice: r.inv,
        customerPublicId: r.cusPid ?? null,
        customerName: accountHolderName({
          firstName: r.cusFirstName,
          lastName: r.cusLastName,
          company: r.cusCompany,
          email: r.cusEmail,
        }),
        customerEmail: r.cusEmail ?? null,
        subscriptionPublicId: r.subPid ?? null,
        paidMinor: paid.get(r.inv.id) ?? 0n,
      })),
    };
  });
}

/**
 * Every invoice of a business (or one customer), unpaginated. **Internal use
 * only** — API routes use `listInvoicesPage`.
 */
export async function listInvoices(
  organizationId: string,
  businessId: string,
  /**
   * `limit` is OPTIONAL and unset means "every row", which is what every existing caller
   * relies on. It exists for the buyer portal, which used to read a customer's entire
   * invoice history — plus a `paidTotals` and an in-flight lookup across all of it — on
   * every page open. Pass it wherever the caller only renders a page.
   */
  opts?: {
    customerId?: string;
    limit?: number;
    /** Portal "hide" settings (Phase 4). In the query, so a page stays a full page. */
    hideVoided?: boolean;
    /** Zero total and nothing due. An invoice with an amount due is never hidden. */
    hideZeroTotal?: boolean;
  },
): Promise<Array<InvoiceListRow>> {
  return withTenant(organizationId, async (tx) => {
    const conds: SQL[] = [eq(invoices.businessId, businessId)];
    if (opts?.customerId) conds.push(eq(invoices.customerId, opts.customerId));
    if (opts?.hideVoided) conds.push(sql`${invoices.status} <> 'voided'`);
    if (opts?.hideZeroTotal)
      conds.push(
        sql`NOT (${invoices.totalMinor} = 0 AND COALESCE(${invoices.amountDueMinor}, 0) = 0)`,
      );
    const where = and(...conds);
    const base = tx
      .select({ inv: invoices, cusPid: customers.publicId, subPid: subscriptions.publicId })
      .from(invoices)
      .leftJoin(customers, eq(invoices.customerId, customers.id))
      .leftJoin(subscriptions, eq(invoices.subscriptionId, subscriptions.id))
      .where(where)
      .orderBy(desc(invoices.createdAt));
    const rows = opts?.limit === undefined ? await base : await base.limit(opts.limit);
    const paid = await paidTotals(
      tx,
      rows.map((r) => r.inv.id),
    );
    return rows.map((r) => ({
      invoice: r.inv,
      customerPublicId: r.cusPid ?? null,
      subscriptionPublicId: r.subPid ?? null,
      paidMinor: paid.get(r.inv.id) ?? 0n,
    }));
  });
}

export interface InvoiceDetail extends InvoiceListRow {
  lines: Array<{ line: typeof invoiceLineItems.$inferSelect; price: string | null }>;
  /**
   * The full customer row, joined on the detail read. The screen needs the name
   * (we showed a raw `cus_…`) and the address, and the
   * invoice's own address snapshot is nullable — the serializer falls back to
   * this rather than a second round-trip per view.
   */
  customer: typeof customers.$inferSelect | null;
  /**
   * Per-(line, coupon, stage) discount attribution — `line_item_discounts[]`
   * (0169). Empty for an invoice with no coupons, and for invoices raised before this
   * table existed that the backfill has not reached.
   */
  discountShares: Array<typeof invoiceLineDiscounts.$inferSelect>;
  /** Taxes, credit notes, applied credit and the money log — see `relations.ts`. */
  relations: InvoiceRelations;
  /**
   * What each of those shares came from — `coupon` or `manual`, plus the coupon's own
   * code. Kept apart from `discountShares` because `invoice_line_discounts` cannot answer
   * it: a manual discount is labelled "Discount" only by default, and a coupon may be too.
   */
  discountSources: Array<{ appliedCouponId: string; source: string; code: string | null }>;
}

export async function getInvoiceWithLines(
  organizationId: string,
  businessId: string,
  invoicePublicId: string,
): Promise<InvoiceDetail | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      // Name/email come along for the ride: the detail screen shows the customer
      // by name, and re-fetching the customer just for
      // two strings would be a second round-trip on every invoice view.
      .select({ inv: invoices, cus: customers, subPid: subscriptions.publicId })
      .from(invoices)
      .leftJoin(customers, eq(invoices.customerId, customers.id))
      .leftJoin(subscriptions, eq(invoices.subscriptionId, subscriptions.id))
      .where(and(eq(invoices.businessId, businessId), eq(invoices.publicId, invoicePublicId)))
      .limit(1);
    if (!row) return null;
    const lineRows = await tx
      .select({ line: invoiceLineItems, pricePid: prices.publicId })
      .from(invoiceLineItems)
      .leftJoin(prices, eq(invoiceLineItems.priceId, prices.id))
      .where(eq(invoiceLineItems.invoiceId, row.inv.id))
      .orderBy(invoiceLineItems.seq); // insertion order — see serialize.ts
    const paid = await paidTotals(tx, [row.inv.id]);
    // The per-(line, coupon, stage) attribution behind the discount — the
    // `line_item_discounts[]`, and what makes `subtotal_minor` reproducible from the
    // document rather than something the reader has to take on trust (0169).
    const shareRows = await tx
      .select()
      .from(invoiceLineDiscounts)
      .where(eq(invoiceLineDiscounts.invoiceId, row.inv.id));
    // What each of those shares came FROM — a coupon or a hand-entered manual discount.
    // leftJoin `coupons`, exactly as `peekDiscounts` does: a manual row has no couponId.
    const acIds = [...new Set(shareRows.map((s) => s.appliedCouponId).filter((x) => x != null))];
    const sourceRows =
      acIds.length > 0
        ? await tx
            .select({
              id: appliedCoupons.id,
              source: appliedCoupons.source,
              code: coupons.code,
              // The code the customer actually REDEEMED, when the coupon was reached
              // through a set. `coupons.code` is the parent's — the same string for every
              // code in the set — so an invoice that printed it could not answer "which
              // code did this customer use", which is the whole point of issuing a set.
              // No migration needed: `coupon_set_codes` already points back at the
              // applied_coupons row it created.
              setCode: couponSetCodes.code,
            })
            .from(appliedCoupons)
            .leftJoin(coupons, eq(appliedCoupons.couponId, coupons.id))
            .leftJoin(couponSetCodes, eq(couponSetCodes.appliedCouponId, appliedCoupons.id))
            .where(inArray(appliedCoupons.id, acIds as string[]))
        : [];
    return {
      invoice: row.inv,
      customerPublicId: row.cus?.publicId ?? null,
      customer: row.cus ?? null,
      subscriptionPublicId: row.subPid ?? null,
      paidMinor: paid.get(row.inv.id) ?? 0n,
      lines: lineRows.map((l) => ({ line: l.line, price: l.pricePid ?? null })),
      discountShares: shareRows,
      relations: await loadInvoiceRelations(tx, row.inv),
      discountSources: sourceRows.map((r) => ({
        appliedCouponId: r.id,
        source: r.source,
        // The redeemed set code wins over the parent's: it is the string the customer
        // was given and the one they will quote back.
        code: r.setCode ?? r.code,
      })),
    };
  });
}

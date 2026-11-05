import { syncMeterBilling } from "./meter-billing";
import { and, asc, eq, ne } from "drizzle-orm";
import { enforceMetadataRules, type MetadataRuleScope } from "@/modules/metadata-rules/service";
import { withTenant, withTenantTx, type Tx } from "@/platform/db";
// TYPE-ONLY, and it must stay that way: this module reaches the credit-note service
// through `await import(…)` so the two never form a static cycle. `import type` is
// erased at compile time, so it adds no runtime edge.
import type { CreditRefundOutcome } from "./downgrade-credit";
import type { CreditNoteDiscountInput } from "@/modules/credit-notes/service";
import { auditSubscription, subscriptionSnapshot } from "./audit";
import { resolveUnbilledChargesConfig } from "./unbilled-charges-config";
import {
  loadBillingRulesRow,
  resolveBillingRulesConfig,
  type FailedChangeCharge,
} from "./billing-rules-config";
import type { PlanChangeCoupons } from "./lifecycle-config";
import type { ResetOverrides } from "@/modules/credits/reset-settings";
import { publicId } from "@/platform/ids";
import { isOpenInvoiceStatus } from "@/modules/invoicing/status";
// The arithmetic of WHERE a term credit goes — distribution across invoices and the
// per-invoice split — lives in one pure module so `estimate.ts` can predict what this
// file will book instead of modelling it a second time. See its header.
import { distributeCreditAcrossInvoices, planOpenInvoiceCreditRouting } from "./credit-routing";
import {
  computeLineAmount,
  fixedChargeMinor,
  snapshotPrice,
  ratableFromSnapshot,
  ratableForItem,
  isOverridable,
  isCycleCapExhausted,
  priceLabel,
  makePriceLabeller,
  alignSnapshotToCycle,
  realignSnapshotToCycle,
  deAlignSnapshotFromCycle,
  type PriceSnapshot,
  isMeteredPrice,
} from "@/modules/catalog/pricing";
import { resolveMandatoryAttachedItems, findMandatoryItemIds } from "@/modules/catalog/service";
import {
  // `addInterval` is deliberately NOT imported here: every date this module derives
  // lives on the business calendar, so `advancePeriod` is the only correct helper.
  advancePeriod,
  cadenceMismatch,
  computeSubscriptionMrr,
  recomputeSubscriptionMrr,
  requireTerm,
  termOrNull,
  type Interval,
} from "./service";
import {
  resolveDifferentialAgainstPlanTx,
  resolveDifferentialForAddTx,
  snapshotWithDifferential,
} from "./items";
import {
  alignTermStart,
  billingModeFor,
  prorationWindowStart,
} from "@/modules/subscriptions/billing-mode";
import { localDatePartsInTz } from "@/platform/clock";
import { createLogger } from "@/platform/logger";
import { emitEvent, emitOrDefer, type DeferredEvents } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { settleMeteredUsage } from "./usage-settlement";
import { subPeriodFields } from "./sub-periods";
import { appendSegment, bookEarlyEndCommitment, freshSegments, termSegments } from "./commitment";
import {
  subscriptions,
  subscriptionItems,
  prices,
  products,
  invoices,
  payments,
  customers,
  creditNotes,
  businesses,
  ledgerEntries,
  unbilledCharges as unbilledChargesTable,
  invoiceLineItems,
} from "@db/schema";
import { inArray } from "drizzle-orm";

const prorationLog = createLogger("proration");

type Invoice = typeof invoices.$inferSelect;
type Payment = typeof payments.$inferSelect;
type CreditNote = typeof creditNotes.$inferSelect;

export interface ItemChange {
  /** Public id of the subscription item to change (si_…). */
  itemId: string;
  /** New price public id (plan change). Omit to keep the current price. */
  newPriceId?: string;
  /** New quantity. Omit to keep current. */
  newQuantity?: number;
  /** Subscription-level custom price (overrides the flat/per-unit catalog amount). */
  customAmountMinor?: number | null;
}

/**
 * An item the caller wants ADDED by the same call — the `POST …/items` half of a
 * composition edit, expressed as a list so ONE `/change` can carry the whole edit.
 * Field-for-field the shape `estimateChange` already previews (`adds`), because a
 * preview and the booking it previews must describe the same request.
 */
export interface ItemAdd {
  /** Public id of the price to attach (price_…). */
  priceId: string;
  /** Defaults to 1, like `POST …/items`. */
  quantity?: number;
  /** Subscription-level custom price (overrides the flat/per-unit catalog amount). */
  customAmountMinor?: number | null;
  /**
   * A mandatory add-on the caller names explicitly so its preview prices it (the portal).
   * Stamped `auto_included` like the CAT-3 expansion, so a later plan swap still removes it.
   */
  autoIncluded?: boolean;
  /** Cycle cap carried onto the item (the attached item's `billing_cycles`). */
  billingCycles?: number | null;
}

type RatedItem = {
  price: typeof prices.$inferSelect;
  quantity: number;
  snapshot: PriceSnapshot | null;
};

/**
 * What one composition edit would do to monthly recurring revenue, priced now.
 *
 * Written onto `scheduled_changes.mrr_delta_minor` when a change is SCHEDULED, so
 * "scheduled upgrade MRR" is a SUM over pending rows instead of an estimate re-run per row
 * on every page load. Positive = upgrade.
 *
 * GROSS, and deliberately not a promise:
 *  - no coupons or manual discounts — this is the rate, not the invoice;
 *  - added and repriced items are rated from the catalog price of THIS moment, not from
 *    the snapshot apply time will freeze, so a plan-scoped differential add-on price is
 *    not applied;
 *  - one-time and usage prices contribute nothing, as everywhere else in MRR;
 *  - the subscription's status is ignored — a trialing or paused subscription reports 0
 *    today, so the movement the ledger eventually records will differ;
 *  - nothing restates it if the subscription or the catalog moves before the change lands.
 *
 * An unknown price id contributes 0 rather than throwing: `preflightItemWork` already
 * refuses those, and a report figure must never be the reason a schedule fails.
 */
export async function estimateScheduledMrrDeltaMinor(
  tx: Tx,
  input: {
    subscriptionId: string;
    businessId: string;
    changes?: ItemChange[];
    adds?: ItemAdd[];
    removes?: string[];
  },
): Promise<bigint> {
  const rows = await tx
    .select({
      itemPublicId: subscriptionItems.publicId,
      price: prices,
      quantity: subscriptionItems.quantity,
      snapshot: subscriptionItems.priceSnapshot,
    })
    .from(subscriptionItems)
    .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
    .where(eq(subscriptionItems.subscriptionId, input.subscriptionId));

  const wanted = [
    ...new Set([
      ...(input.changes ?? []).map((c) => c.newPriceId).filter((id): id is string => Boolean(id)),
      ...(input.adds ?? []).map((a) => a.priceId),
    ]),
  ];
  const catalog = new Map<string, typeof prices.$inferSelect>();
  if (wanted.length > 0) {
    const found = await tx
      .select()
      .from(prices)
      .where(and(eq(prices.businessId, input.businessId), inArray(prices.publicId, wanted)));
    for (const p of found) catalog.set(p.publicId, p);
  }
  const overridden = (price: typeof prices.$inferSelect, customAmountMinor?: number | null) =>
    customAmountMinor == null ? price : { ...price, amountMinor: BigInt(customAmountMinor) };

  const before: RatedItem[] = rows.map((r) => ({
    price: r.price,
    quantity: r.quantity,
    snapshot: r.snapshot as PriceSnapshot | null,
  }));

  const changeByItem = new Map((input.changes ?? []).map((c) => [c.itemId, c]));
  const removed = new Set(input.removes ?? []);
  const after: RatedItem[] = [];
  for (const r of rows) {
    if (removed.has(r.itemPublicId)) continue;
    const change = changeByItem.get(r.itemPublicId);
    const snapshot = r.snapshot as PriceSnapshot | null;
    if (!change) {
      after.push({ price: r.price, quantity: r.quantity, snapshot });
      continue;
    }
    const quantity = change.newQuantity ?? r.quantity;
    // Quantity only: keep the snapshot, so a sub-level custom price still rates. Any
    // reprice drops it — the snapshot describes the price being replaced.
    if (!change.newPriceId && change.customAmountMinor === undefined) {
      after.push({ price: r.price, quantity, snapshot });
      continue;
    }
    const base = change.newPriceId ? catalog.get(change.newPriceId) : r.price;
    if (!base) continue;
    after.push({ price: overridden(base, change.customAmountMinor), quantity, snapshot: null });
  }
  for (const add of input.adds ?? []) {
    const base = catalog.get(add.priceId);
    if (!base) continue;
    after.push({
      price: overridden(base, add.customAmountMinor),
      quantity: add.quantity ?? 1,
      snapshot: null,
    });
  }

  return computeSubscriptionMrr(after) - computeSubscriptionMrr(before);
}

export class ProrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProrationError";
  }
}

/**
 * Post-H (#3 / Bugs #8): a CONCURRENT write to the subscription invalidated the
 * proration this call computed, so the call was abandoned before any money moved.
 * A subclass of ProrationError so existing `instanceof ProrationError` handlers
 * keep working; the API maps it to 409 (retry) rather than 400.
 */
export class ProrationConflictError extends ProrationError {
  constructor(message: string) {
    super(message);
    this.name = "ProrationConflictError";
  }
}

/**
 * A subscription IN TRIAL has been billed nothing, so there is
 * no charged term to prorate against and a composition change must move NO money
 * — no proration invoice, no credit note, no payment. The full new composition is
 * billed once, when the trial converts (`renewSubscription` → `billSubscriptionPeriod`,
 * which reads the CURRENT item set).
 *
 * This is not a cosmetic rule. A trialling subscription has NO TERM AT ALL since
 * 2026-08-25 (trial and term are mutually exclusive), so the
 * arithmetic below has nothing to slice — `requireTerm` throws rather than inventing a
 * window. Before that the trial was stored AS the term (`currentPeriodEnd = trialEnd`) and
 * the failure was worse than an error: `prorate(amount, now, start, end)` sliced the new
 * price across TRIAL days and charged that slice immediately — money taken during a free
 * trial, for a fraction of unpaid time. Found 2026-08-03 on a live in-trial INR
 * subscription, and the reason this gate exists at all.
 *
 * Every money-moving subscription-composition path shares this gate:
 * `changeSubscription` + `estimateChange` (its preview twin, which must agree
 * exactly) and `addSubscriptionItem` / `removeSubscriptionItem`. The only
 * exception is an explicit one-time charge with `invoice_immediately`, which goes
 * through `addAdHocCharges`, not through here.
 */
export function billsAtTrialEnd(sub: { status: string }): boolean {
  return sub.status === "in_trial";
}

/** Time-prorate an amount by the fraction of the current period remaining. Exported for unit tests. */
export function prorate(
  amountMinor: bigint,
  now: Date,
  periodStart: Date,
  periodEnd: Date,
): bigint {
  const total = periodEnd.getTime() - periodStart.getTime();
  const remaining = periodEnd.getTime() - now.getTime();
  if (total <= 0 || remaining <= 0) return 0n;
  const rem = BigInt(Math.floor(remaining));
  const tot = BigInt(Math.floor(total));
  // Round half-up to the nearest minor unit. BigInt division
  // truncates toward zero, which systematically under-credits/under-charges a
  // prorated amount by up to 1 minor unit; rounding it means the
  // credit for e.g. 12900 × 30/31 = 12483.87 is 12484, not a floored 12483.
  return (amountMinor * rem + tot / 2n) / tot;
}

/**
 * The money ONE changed item owes on the NON-RESET proration path, in integer
 * minor units. The single decision `changeSubscription` books and `estimateChange`
 * previews — shared so the pair can never drift (that drift is the defect this
 * module keeps re-opening).
 *
 * ── A ONE-TIME item is charged ONCE, prorated NEVER, credited NEVER (bug, 2026-08-04).
 * The non-reset branch used to time-slice BOTH sides for every item, keyed on
 * nothing but "is this an item" — the same defect already closed on the term-reset
 * branch, the add path and the removal path (see the README invariant "A `one_time`
 * item is charged once, prorated never, and credited never"; this was the fifth
 * path and the last one still deciding for itself). A one-time fee buys no span of
 * time, so there is no fraction of it to slice:
 *  - the OLD side is credited NOTHING — unconditional on `cycles_billed`, because an
 *    already-paid fee is not unused time and a never-billed one has nothing paid to
 *    hand back (identical wording to the reset credit loop, deliberately);
 *  - the NEW side is charged in FULL while the item's single cycle is unspent, and
 *    nothing once it is spent — gated on the SHARED cap rule `isCycleCapExhausted`
 *    (`catalog/pricing.ts`), never on the price type alone, so a fee attached but not
 *    yet billed is still legitimately owed in full.
 *
 * `chargeIsOneTime` carries the three obligations that come with billing a one-off
 * outside `planSubscriptionPeriodInvoice`: label the line plainly (never
 * "… - Prorated Charges"), book it `kind: 'one_time'`, and hand the item id to
 * `createInvoiceFromLines({ markItemsBilled })` so the cycle it consumes is recorded
 * INSIDE the invoice's transaction — without which the next renewal sees a
 * never-billed one-off and bills it again.
 *
 * Edge worth naming: a price SWAP that changes an item's TYPE is decided by the
 * POST-change type against the item's existing `cycles_billed`, so a recurring item
 * that has already billed a cycle and is swapped onto a `one_time` price is charged
 * nothing. That is the term-reset charge loop's rule verbatim — identical by
 * construction rather than reasoned about twice.
 */
/**
 * WAS THIS BASIS EVER ACTUALLY CHARGED? — the gate that makes `prorate: false` safe to
 * change away from, and a DELIBERATE behavioural choice.
 *
 * `nonResetItemProration` credits the unused time of the item's `price_snapshot`, which is
 * the right basis for every change that BILLS ITS OWN RE-RATE — and that is why the
 * "credit from the billed line instead" candidate was measured and REVERTED (PROGRESS: "an
 * unused-time credit is rated from a snapshot that the plan change has already moved"). It
 * over-credited by ₹45,120-against-₹28,200 precisely because the snapshot IS what the
 * customer holds once the change has paid for the move.
 *
 * `prorate: false` is the one change that moves the snapshot and bills NOTHING. So the next
 * prorated change rated its credit from a rate nobody was ever invoiced at, and the
 * invoice-capacity clamp then landed it on the whole term — measured as a FREE TERM
 * (`scripts/probe-prorate-false-then-prorated.ts`; gated by `verify:rerate-accounting` S13).
 *
 * ⚠️ THIS IS NOT THAT REVERTED CANDIDATE. It does not change the credit's AMOUNT — every
 * shape where a line exists keeps the snapshot basis and the same figure to the paisa, which
 * is what the other twelve scenarios pin. It changes only WHETHER a credit exists at all,
 * and the answer is that it does not: NOTHING is credited for a composition that was never
 * invoiced, and the incoming one is charged prorated regardless. That bills two terms for
 * one term of service, and is accepted ON PURPOSE at the user's explicit instruction.
 *
 * BIASED TOWARDS PERMISSIVE, deliberately. A false negative here SUPPRESSES a credit the
 * customer is owed — a new money bug of the same family we just closed — so a credit is
 * withheld only when nothing anywhere ever charged this price: no invoice line on any of the
 * subscription's invoices, and no pending `unbilled_charge` (the DEFERRED shapes S5/S6/S9
 * have a real charge with no invoice line, and gating on lines alone would zero their
 * credits). Nothing is stored and nothing needs clearing: after a renewal bills the basis
 * the line exists, so the credit resumes on its own. A flag on the snapshot would have
 * needed a renewal hook that does not exist today — no writer touches `price_snapshot` at
 * renewal — and a missed clear would suppress that credit forever.
 */
export async function basisWasEverCharged(tx: Tx, subscriptionId: string, priceId: string) {
  const [line] = await tx
    .select({ id: invoiceLineItems.id })
    .from(invoiceLineItems)
    .innerJoin(invoices, eq(invoiceLineItems.invoiceId, invoices.id))
    .where(and(eq(invoices.subscriptionId, subscriptionId), eq(invoiceLineItems.priceId, priceId)))
    .limit(1);
  if (line) return true;
  /**
   * NOTHING BILLED AT ALL ⇒ NOT THIS DEFECT, so do not gate.
   *
   * "No line for this price" has two very different causes, and only one of them is the
   * suppressed change this gate exists for:
   *   · a `prorate: false` change installed a basis without billing it — the term IS billed,
   *     just not at this basis. That is the case to suppress.
   *   · the term was never invoiced at all (a subscription created and changed before any
   *     billing run). Then there is no suppressed movement, and the change's own netting —
   *     prorated new MINUS unused old, inside one invoice — is the established behaviour that
   *     `verify:proration-matrix` pins to the paisa.
   * Conflating them cost two matrix assertions on the first cut of this gate (`net=5000`
   * where 2500 is contracted, because `mkSub` never calls `billSubscriptionPeriod`). So the
   * gate requires POSITIVE evidence that this term was billed at something else.
   */
  const [anyLine] = await tx
    .select({ id: invoiceLineItems.id })
    .from(invoiceLineItems)
    .innerJoin(invoices, eq(invoiceLineItems.invoiceId, invoices.id))
    .where(eq(invoices.subscriptionId, subscriptionId))
    .limit(1);
  if (!anyLine) return true;
  const [queued] = await tx
    .select({ id: unbilledChargesTable.id })
    .from(unbilledChargesTable)
    .where(
      and(
        eq(unbilledChargesTable.subscriptionId, subscriptionId),
        eq(unbilledChargesTable.priceId, priceId),
        ne(unbilledChargesTable.status, "voided"),
      ),
    )
    .limit(1);
  return Boolean(queued);
}

export function nonResetItemProration(input: {
  /** Price type the item was rated at BEFORE the change (its snapshot's, not the catalog's). */
  oldSnapshotType: string;
  /** Price type the item is rated at AFTER the change. */
  newSnapshotType: string;
  /** Full-term amount of the OLD snapshot × the OLD quantity. */
  oldFullMinor: bigint;
  /** Full-term amount of the NEW snapshot × the NEW quantity. */
  newFullMinor: bigint;
  billingCycles: number | null;
  cyclesBilled: number;
  /** The proration window start (see billing-mode.prorationWindowStart), not raw `now`. */
  now: Date;
  periodStart: Date;
  periodEnd: Date;
}): { creditMinor: bigint; chargeMinor: bigint; chargeIsOneTime: boolean } {
  const { now, periodStart, periodEnd } = input;
  const creditMinor =
    input.oldSnapshotType === "one_time"
      ? 0n
      : prorate(input.oldFullMinor, now, periodStart, periodEnd);
  if (input.newSnapshotType === "one_time") {
    const spent = isCycleCapExhausted(
      input.billingCycles,
      input.newSnapshotType,
      input.cyclesBilled,
    );
    return { creditMinor, chargeMinor: spent ? 0n : input.newFullMinor, chargeIsOneTime: !spent };
  }
  return {
    creditMinor,
    chargeMinor: prorate(input.newFullMinor, now, periodStart, periodEnd),
    chargeIsOneTime: false,
  };
}

/**
 * The `unbilled_charges.entity_type` values written ONLY by a subscription-ITEM
 * booking — `addSubscriptionItem`'s deferred branch and `changeSubscription`'s
 * deferred branch, both of which resolve the type from the price's product kind.
 *
 * The allowlist is the ownership test. `unbilled_charges` has no `subscription_item_id`
 * (a column that would make this exact rather than inferred — worth adding, but this
 * fix must not carry a migration), so an item's queued charges are identified by
 * `price_id` + this entity type. A Quick Charge from the catalogue is always `adhoc`
 * (typed) or `charge_item_price` (picked), and a deferred first period is `adhoc`, so
 * neither can be mistaken for an item booking even if it happens to name the same
 * price. Erring toward MISSING a row rather than clawing back a charge that is genuinely
 * owed is deliberate: dropping owed money is the same defect in the opposite direction.
 */
const ITEM_BOOKED_ENTITY_TYPES = ["plan_item_price", "addon_item_price"];

/** One pending deferred charge, re-cut to the span the customer actually held the item. */
export interface UnbilledChargeSettlement {
  row: typeof unbilledChargesTable.$inferSelect;
  /** The slice covering [heldUntil, periodEnd] — time the customer will never have. */
  droppedMinor: bigint;
  /** What survives: the slice covering [periodStart, heldUntil), re-queued as a fresh row. */
  keptMinor: bigint;
  /** `heldUntil`, clamped into the charge's own window. */
  keptPeriodEnd: Date;
}

/**
 * ── THE CHARGE SIDE OF A REMOVAL (money bug, 2026-08-24) ──────────────────────
 *
 * An item added WITHOUT `invoice_immediately` is not invoiced: its prorated charge is
 * QUEUED as a pending `unbilled_charge` covering `[added .. currentPeriodEnd]`, and the
 * next renewal folds it in (invoicing/service.ts). Migration 0109 made deferral the
 * DEFAULT, so that is the ordinary path for an add, not an edge case.
 *
 * Remove the item before that renewal and the row was simply left behind. Measured
 * (scripts/probe-remove-item-unbilled-orphan.ts): a ₹600/mo add-on added 11-Aug and
 * removed 21-Aug on an Aug term queued ₹406.45 for `11-Aug..1-Sep`; the customer held
 * it for ten days, owed ₹193.55, and the 1-Sep renewal invoiced the full ₹406.45 —
 * a line for an add-on they no longer had, over a window running eleven days past the
 * day they gave it up.
 *
 * That the arithmetic sometimes still landed right was an accident, not a mechanism.
 * `removeSubscriptionItem` credits the unused remainder, and with no invoice having
 * charged this price `issueCurrentTermCredit` falls back to "the newest live invoice"
 * — the PLAN's — and issues a REFUNDABLE note there for the same tail. Equal amounts,
 * so the net cancelled. It stops cancelling the moment either half moves: with the term
 * itself deferred there is no live invoice at all and nothing was credited (₹212.90
 * over-billed), and on a cheap plan the fallback note is capped at that invoice's cash
 * (₹100 of the ₹212.90 owed back, ₹112.90 over-billed). And even when it cancelled, it
 * cancelled by handing the customer refundable cash drawn from a payment that never
 * charged the add-on — money they can withdraw, leaving the renewal charge standing.
 *
 * ── THE LINE ─────────────────────────────────────────────────────────────────
 * A charge for time the customer DID hold is owed and is still billed. A queued charge
 * is therefore RE-CUT, never blanket-voided: the slice up to the removal survives, the
 * slice beyond it does not. Same rule the immediate path already obeys by a different
 * route (charge the whole slice, credit the unused remainder), so a deferred add and an
 * invoiced one net to the same money — which is what makes the Invoicing Option a
 * timing choice rather than a pricing one.
 *
 * Only a charge that NAMES a service window can be re-cut by time. A one-time fee
 * carries none (`addSubscriptionItem` deliberately stamps no period on it), so it is
 * untouched here — matching the standing ruling that a `one_time` item is charged once,
 * prorated never and credited never, whether it was invoiced or queued.
 *
 * Read-only: it computes the settlements so a caller can subtract the clawback from the
 * credit it is about to issue for the SAME span (or the customer is paid twice for one
 * remainder). `applyUnbilledChargeSettlements` performs the writes.
 */
export async function planRemovedItemUnbilledSettlements(
  tx: Tx,
  input: {
    subscriptionId: string;
    /** The removed items' price ids. */
    priceIds: string[];
    /** The proration window start of the removal — the instant the item stopped being held. */
    heldUntil: Date;
  },
): Promise<UnbilledChargeSettlement[]> {
  if (input.priceIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(unbilledChargesTable)
    .where(
      and(
        eq(unbilledChargesTable.subscriptionId, input.subscriptionId),
        eq(unbilledChargesTable.status, "pending"),
        inArray(unbilledChargesTable.priceId, input.priceIds),
        inArray(unbilledChargesTable.entityType, ITEM_BOOKED_ENTITY_TYPES),
      ),
    );
  const settlements: UnbilledChargeSettlement[] = [];
  for (const row of rows) {
    const { periodStart, periodEnd } = row;
    if (!periodStart || !periodEnd) continue; // a one-time fee: no span to re-cut.
    // Clamp into the charge's own window. `prorate` does not: a `heldUntil` BEFORE the
    // charge's start would return more than the charge is worth (remaining > total) and
    // claw back money that was never queued.
    const heldUntil = input.heldUntil < periodStart ? periodStart : input.heldUntil;
    if (heldUntil >= periodEnd) continue; // fully earned before the removal — nothing to cut.
    const droppedMinor = prorate(row.amountMinor, heldUntil, periodStart, periodEnd);
    if (droppedMinor === 0n) continue;
    settlements.push({
      row,
      droppedMinor,
      keptMinor: row.amountMinor - droppedMinor,
      keptPeriodEnd: heldUntil,
    });
  }
  return settlements;
}

/**
 * Book the settlements `planRemovedItemUnbilledSettlements` computed, on the caller's
 * transaction — so the re-cut charge, the item's deletion and the credit that removal
 * owes commit (or roll back) together.
 *
 * The original row is VOIDED and the surviving slice RE-QUEUED as a new pending row
 * rather than having its amount edited in place. `deleteUnbilledCharges` already uses
 * `voided` for exactly this ("this queued charge will not be billed"), and it leaves an
 * operator able to see what was queued and that it was cut back, instead of a money
 * figure that silently changed value.
 *
 * ── A QUEUED ROW CAN BE NEGATIVE, AND ITS SURVIVING SLICE IS THE CUSTOMER'S (money bug,
 *    2026-09-01) ───────────────────────────────────────────────────────────────────────
 * The re-queue used to be gated on `keptMinor <= 0n`, which reads as "nothing survived".
 * That is only true while every queued row is a CHARGE. It is not: a change applied with
 * `invoice_immediately: false` whose net is POSITIVE leaves its unused-time CREDIT lines in
 * `billableLines`, and the deferred branch queues them verbatim — as `unbilled_charges` rows
 * with a NEGATIVE `amount_minor`. Measured (`probe-settle-queued-semantics.ts` §B, PRO →
 * BUSINESS deferred): the queue holds `-45120.00 "Unused time on Additional Connections ×60"`
 * beside `+28200.00 "Remaining time on …"`.
 *
 * Re-cut one of those PARTWAY through its window and the guard threw the customer's half
 * away. Measured (`verify-rerate-accounting.ts` S4 — deferred downgrade at day 10, the
 * add-on removed at day 20): the queue held `-30080.00` and `+18800.00`; the removal voided
 * both, re-queued the `+9400.00` survivor and DROPPED the `-15040.00` one. The subscription's
 * net booked position came to ₹86,198.01 against ₹71,158.00 owed for the time actually held —
 * **₹15,040 over-billed**, silently, with no document naming it.
 *
 * So the skip is now exactly zero: a slice worth nothing is not worth a row, and a slice worth
 * anything — either sign — belongs to whoever it is worth it to. With this, S4 closes to the
 * paisa (₹71,158.00 vs ₹71,158.00) and every other shape in that sweep is unchanged.
 *
 * A re-queued negative CAN drag the pending set below zero, which the next renewal folds into
 * an invoice. That is the pre-existing shape, not a new one — the change queued the negative
 * row in the first place — and the deferred branch of `changeSubscription` already refuses a
 * net-negative queue at the moment it is created. Keeping the money is not the safer failure:
 * it is the same defect with the sign the house likes.
 */
export async function applyUnbilledChargeSettlements(
  tx: Tx,
  input: { organizationId: string; businessId: string; settlements: UnbilledChargeSettlement[] },
): Promise<void> {
  for (const s of input.settlements) {
    await tx
      .update(unbilledChargesTable)
      .set({ status: "voided" })
      .where(eq(unbilledChargesTable.id, s.row.id));
    // ZERO, not `<= 0` — see the negative-row note above. A negative survivor is money the
    // customer is owed; dropping it over-bills them by exactly its amount.
    if (s.keptMinor === 0n) continue;
    await tx.insert(unbilledChargesTable).values({
      organizationId: input.organizationId,
      businessId: input.businessId,
      subscriptionId: s.row.subscriptionId,
      publicId: publicId("uch"),
      description: s.row.description,
      amountMinor: s.keptMinor,
      currency: s.row.currency,
      // The window is the point: the surviving slice covers only what was held, so the
      // renewal that folds it in recognises it over that span and not the original one.
      periodStart: s.row.periodStart,
      periodEnd: s.keptPeriodEnd,
      priceId: s.row.priceId,
      quantity: s.row.quantity,
      entityType: s.row.entityType,
    });
  }
}

/**
 * Issue a real credit note for a subscription's CURRENT term — replaces minting
 * a negative "credited" invoice on a downgrade / item-removal. Mirrors the change_term_end shortening path: find the
 * invoice that billed the current term (period-matched; excludes
 * voided/credited/pending), then issue an ADJUSTMENT credit note against the
 * unpaid slice and a REFUNDABLE credit note for the already-paid remainder.
 * Returns the primary credit note (adjustment if any, else refundable), or null
 * when there is nothing to credit or no eligible source invoice (nothing was
 * billed for this term — matches change_term_end, which also credits nothing).
 */
export async function issueCurrentTermCredit(input: {
  organizationId: string;
  businessId: string;
  subscription: typeof subscriptions.$inferSelect;
  /**
   * Positive per-item credit amounts → "… Prorated Credits" lines.
   *
   * `priceId` is what the item credits, and it exists to recover the SOURCE INVOICE LINE:
   * a credit-note line carries `reference_line_item_id` pointing at the invoice line it
   * reverses, and our items reached the writer with
   * `invoice_line_item_id` NULL because nothing connected them to a line. Optional, and
   * matched only where the answer is unambiguous — see `linkItemsToLines`.
   */
  items: { description: string; amountMinor: bigint; priceId?: string | null }[];
  reasonCode?: string;
  reason?: string;
  /**
   * The window this credit HANDS BACK — `[change instant, old term end)` — stamped on
   * every item the note carries, in preference to the source line's billed period.
   *
   * Exactly this window and nothing else: a change on day 6 of a 31-day term billed
   * 31-Aug → 25-Sep produces a credit-note line with `date_from` = the change date and
   * `date_to` = 25-Sep. The billed window (31-Aug → 25-Sep) is on the INVOICE; the
   * credit note's job is to say which part came back.
   *
   * Optional so the cancellation and manual paths compile unchanged, but every caller
   * that prorates should pass it — omitted, the item falls back to the source line's
   * billed period (whole term) or to nothing at all, which is the pair of defects this
   * parameter exists to close. See `CreditNoteItemInput.periodStart`.
   */
  creditedPeriod?: { start: Date; end: Date } | null;
  /**
   * The price ids the credit is FOR — the removed item's price, the old price of a
   * downgraded item. The credit is then booked against the invoices that actually
   * charged those prices: all of them, each from its own lines, instead of the
   * newest-live heuristic.
   *
   * Why the whole set and not one invoice. A term routinely bills an item across
   * several invoices — an add-on subscribed at qty 1 is charged on one invoice and
   * scaled to qty 40 on a second, which collects only the DELTA. Crediting "the
   * invoice that charged it", singular, capped the credit at that one invoice's cash
   * and dropped the rest in silence: measured 2026-08-24, removing that add-on owed
   * 20000 and issued ONE note for 19500, keeping 500 of the customer's money with no
   * error and no log.
   *
   * So EVERY invoice that billed the item is credited. With an add-on at 560/unit,
   * qty 1 → invoice 2189 charged 560 and scaling to qty 40 → invoice 2190 charged the
   * delta 21840, removing it produces CN-202 560.00 against 2189 (line qty 1 × 560)
   * and CN-203 21840.00 against 2190 (line qty 39 × 560), summing to the full 22400
   * the 40-unit term was worth. Not a refusal, not one capped note.
   *
   * That is the same rule `wholeTerm` applies to a term reset (D1) — the only
   * difference is WHICH invoices are eligible and which of their lines the credit is
   * spelled out on. Here it is the invoices that charged THESE prices, credited from
   * THEIR lines for them, so no note ever carries a line for something its invoice
   * never billed (the reason an item credit must not simply be spread across the term).
   */
  targetPriceIds?: string[] | null;
  /**
   * True when `items` credit the WHOLE current term — a term reset (a frequency change,
   * or a forced reset), where every item's unused time is being handed back.
   *
   * Only then may the credit be spread across every invoice in the term. A credit for
   * SPECIFIC items — one unit of a quantity downgrade, one removed add-on — must not be:
   * spreading it proportionally puts a line on an invoice that never charged the thing
   * being credited. Measured 2026-08-23 while fixing D1: downgrading one plan unit (200.00)
   * on a term whose second invoice was a 5.00 add-on proration produced CN-1 199.17
   * "Unused time on <plan>" (right) plus CN-2 0.83 "Unused time on <add-on>" (wrong — the
   * add-on was untouched and still active). The total reconciled; the document lied.
   * Defaults false, so every item-specific caller keeps the single-invoice behaviour.
   */
  wholeTerm?: boolean;
  /**
   * Join the caller's transaction so the credit note commits — or rolls back —
   * WITH the change that owes it. `changeSubscription` passes its apply-phase
   * handle: before that, the item change committed in one transaction and this
   * helper opened its own, so a rejected credit (the refundable cap below) left
   * the subscription downgraded with nothing credited. Omit it and each read
   * plus the credit-note write get their own transaction, exactly as before.
   */
  tx?: Tx | null;
}): Promise<CreditNote[]> {
  const { organizationId, businessId, subscription: sub } = input;
  const total = input.items.reduce((s, i) => s + i.amountMinor, 0n);
  if (total <= 0n) return [];
  const tx = input.tx ?? null;

  const live = await withTenantTx(organizationId, input.tx, async (t) => {
    /**
     * ORDERED IN THE QUERY as well as in JS (hardened 2026-09-02).
     *
     * The `.sort()` below was the ONLY thing guaranteeing oldest→newest, and two things now
     * depend on that order rather than merely benefiting from it: `live[live.length - 1]` is
     * taken as "the newest live invoice" a few lines down, and
     * `distributeCreditAcrossInvoices` places credit NEWEST FIRST since the allocator stopped
     * being proportional. A refactor that dropped the sort would break both silently and still
     * compile — so the guarantee lives in the query too, where the rows come from. The JS sort
     * is kept rather than replaced: belt and braces on money ordering costs nothing, and it
     * documents the requirement at the point that consumes it. `estimate.ts` reads the same
     * order for the same reason; the preview and the booking agree only while they do.
     */
    const rows = await t
      .select()
      .from(invoices)
      .where(and(eq(invoices.businessId, businessId), eq(invoices.subscriptionId, sub.id)))
      .orderBy(asc(invoices.createdAt));
    return rows
      .filter((r) => !["voided", "pending"].includes(r.status) && r.totalMinor > 0n)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  });
  if (live.length === 0) return [];

  // ── THE TWO SINGLE-INVOICE PATHS BELOW BYPASS THE ALLOCATOR ENTIRELY ─────────────
  // `creditAcrossInvoices` owns capacity — the cumulative-credit ceiling, the pre-tax
  // conversion, the clamp-and-re-place pass — and neither of the paths that credit ONE
  // invoice goes through it. They took the caller's items at face value and wrote whatever
  // those grossed to, so an invoice already credited in full could be credited again with
  // no check of any kind.
  //
  // MEASURED, not argued (`scripts/probe-single-invoice-credit-cap.ts`, 2026-09-01), because
  // the first version of this guard was placed on the structural argument alone and that is
  // the weakest kind of claim to ship into this file:
  //
  //   path A  targetPriceIds → ONE invoice   INV-1 38843.24 carrying 41900.00  (+3056.76)
  //   path B  newest-live fallback           INV-3 32943.24 carrying 35900.00  (+2956.76)
  //
  // ⚠ AND THE FIRST ATTEMPT AT THAT FIXTURE WAS GREEN, which is the instructive half. A
  // manual note simply eating the invoice's value is NOT enough: `creditOneInvoice`'s paid
  // branch caps its cashable slice at `refundableCapacityForInvoice`, so the note came out
  // at exactly the ceiling. That cap answers the PAYOUT question and subtracts only a note's
  // OUTSTANDING claim on cash — so ALLOCATE the prior note onto another invoice and its
  // claim becomes zero, and the same invoice reports its entire value available again. That
  // is precisely the gap `creditableCapacityForInvoice` exists for (the INV-3288 shape), and
  // it is the only thing that was standing between these paths and an overshoot.
  //
  // Clamping the ITEMS rather than the note keeps `creditOneInvoice`'s arithmetic untouched
  // — `rescaleCreditItems` is the same largest-remainder scale-down it already applies for a
  // coupon and for a refund.
  /**
   * Clamp a credit to what this invoice can still take, and REPORT WHETHER IT BOUND.
   *
   * `boundCeiling` is the gross ceiling when the clamp actually bit, and null otherwise.
   * `creditOneInvoice` needs it because the pre-tax cap is quantised: the forward map's
   * image is coarse, so the gross rebuilt from that cap can land BELOW the ceiling with no
   * base value in between, and the remaining headroom is credited exactly. Returned
   * alongside the items rather than stashed in a scalar — two call sites clamp and credit
   * in sequence today, and a third that clamped twice before crediting would silently read
   * the wrong invoice's ceiling.
   */
  const clampToCapacity = async (
    inv: typeof invoices.$inferSelect,
    items: { description: string; amountMinor: bigint; priceId?: string | null }[],
  ): Promise<{ items: typeof items; boundCeiling: bigint | null }> => {
    const { remainingCreditableAgainstInvoice } = await import("@/modules/credit-notes/service");
    const want = items.reduce((s, i) => s + i.amountMinor, 0n);
    if (want <= 0n) return { items, boundCeiling: null };
    const ceiling = await withTenantTx(organizationId, tx, (t) =>
      remainingCreditableAgainstInvoice(t, inv),
    );
    const cap = preTaxCreditFitting(
      ceiling,
      await readInvoiceCreditBasis(organizationId, businessId, inv, tx),
    );
    if (cap <= 0n) return { items: [], boundCeiling: ceiling };
    /**
     * ASKING FOR AT LEAST EVERYTHING THAT FITS ⇒ THE NOTE SETTLES THE REMAINDER.
     *
     * The trigger is `want >= cap`, NOT `want > cap`, and the difference is the whole bug.
     * `cap` is the largest PRE-TAX value whose gross still fits `ceiling`; the forward map's
     * image is coarse, so `gross(cap)` can land strictly BELOW the ceiling with no base value
     * in between. When the caller asks for at least `cap`, it is reversing everything the
     * invoice can still give — and **crediting everything should return everything**.
     *
     * The first cut of this fix used `want > cap`, so it only fired when the clamp actually
     * bit, and it did not fire on the shape it was written for: measured on
     * `scripts/probe-capped-credit-lands-on-cap.ts`, `want` is 911800 and `cap` is ALSO
     * 911800 (because `gross(911801) = 215925` overshoots the 215924 ceiling), so
     * `cap >= want` returned early and the note stayed five paise short. The equality case
     * IS the common one: a full unused-term credit asks for exactly the base that fits.
     *
     * `cap === want` needs no rescale — `rescaleCreditItems(items, cap, want)` would be the
     * identity — so the items pass through untouched and only the ceiling travels.
     */
    if (cap > want) return { items, boundCeiling: null };
    return {
      items: cap < want ? rescaleCreditItems(items, cap, want) : items,
      boundCeiling: ceiling,
    };
  };

  // ── ITEM-SPECIFIC (a removal, a quantity downgrade, a price swap): credit EVERY
  // invoice that charged these prices, each from its own lines — see `targetPriceIds`.
  if (input.targetPriceIds && input.targetPriceIds.length > 0) {
    const parts = await invoicesChargingPrices(organizationId, live, input.targetPriceIds, tx);
    // ONE invoice charged it: the caller's own item descriptions, against that invoice.
    // Byte-identical to the pre-2026-08-24 targeted path, which is every single-invoice
    // term — the split below only ever changes a term billed across several invoices.
    if (parts.length === 1) {
      const capped = await clampToCapacity(parts[0]!.invoice, input.items);
      if (capped.items.length === 0) return [];
      return creditOneInvoice(
        organizationId,
        businessId,
        parts[0]!.invoice,
        // Same items, now pointing at the lines they reverse where that is knowable.
        linkItemsToLines(capped.items, parts[0]!.lines),
        input.reasonCode,
        input.reason,
        tx,
        input.creditedPeriod ?? null,
        capped.boundCeiling,
      );
    }
    if (parts.length > 1) {
      return creditAcrossInvoices({
        organizationId,
        businessId,
        total,
        parts,
        reasonCode: input.reasonCode,
        reason: input.reason,
        tx,
        creditedPeriod: input.creditedPeriod ?? null,
      });
    }
    // Nothing on this term ever charged these prices (an item added and removed inside
    // one term without being invoiced, a credit whose lines carry no price). There is no
    // attribution to make, so fall through to the term default below.
  }

  // ── ITEM-SPECIFIC with no attribution: the newest live invoice, as before. The
  // term-wide split below is only sound when the whole term is being credited — see
  // `wholeTerm`.
  if (!input.wholeTerm) {
    const newest = live[live.length - 1]!;
    const capped = await clampToCapacity(newest, input.items);
    if (capped.items.length === 0) return [];
    return creditOneInvoice(
      organizationId,
      businessId,
      newest,
      capped.items,
      input.reasonCode,
      input.reason,
      tx,
      input.creditedPeriod ?? null,
      capped.boundCeiling,
    );
  }

  // ── TERM-WIDE (a term reset): ONE CREDIT NOTE PER INVOICE IN THE TERM.
  //
  // This used to credit a single invoice — "the newest live" one — and cap at ITS cash.
  // A term billed across several invoices then could not be credited at all: after a
  // mid-term quantity change the newest invoice is the small proration one, and the
  // whole-term credit trivially exceeds it. Measured 2026-08-23: "Refundable credit
  // 4902646 exceeds refundable paid amount 171746", and the plan change was refused
  // outright — no plan change was possible for the rest of the term. Tracked as D1.
  //
  // So the credit is SPLIT per invoice. With multiple invoices present for the billing
  // cycle, one credit note is created per invoice for the unused period — CN-182
  // ₹47,251.92 against invoice #2165 and CN-183 ₹1,774.72 against #2166 — each invoice
  // credited its OWN amount, then both applied to the new invoice.
  //
  // So each invoice is credited from ITS OWN LINES rather than from a slice of the
  // caller's item list. That is what makes the documents honest: the proration invoice
  // charged only the add-on delta, and a credit note against it must not carry a line for
  // a plan it never billed. It also means the per-invoice discount scaling and tax
  // reversal in `creditOneInvoice` each read the ledger of the invoice they belong to.
  //
  // `fraction` carries how much of the term is being credited — 100% on a same-day
  // change, 16/31 mid-term — applied to every invoice alike, largest-remainder so the
  // parts sum to the requested total exactly.
  // Every live invoice in the term, shared out by its own subtotal and credited from
  // its own chargeable lines. Tax / discount / rounding rows are artifacts of the
  // document, not supplies — `creditOneInvoice` reverses the tax from the ledger, so
  // carrying a tax line here would double it.
  //
  // The placement itself — capacity, the largest-remainder split, the clamp — is
  // `creditAcrossInvoices`, shared with the item-specific split above so the two can
  // never disagree about how a credit is spread.
  const parts: InvoiceCreditPart[] = [];
  for (const inv of live) {
    const rawLines = await withTenantTx(organizationId, input.tx, async (t) =>
      t.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, inv.id)),
    );
    const chargeable = rawLines.filter(
      (l) => !["tax", "discount", "rounding"].includes(l.kind ?? "") && l.amountMinor > 0n,
    );
    if (chargeable.length === 0 || inv.subtotalMinor <= 0n) continue;
    parts.push({
      invoice: inv,
      base: inv.subtotalMinor,
      lines: chargeable.map((l) => ({
        description: l.description,
        amountMinor: l.amountMinor,
        publicId: l.publicId,
        priceId: l.priceId,
      })),
    });
  }
  return creditAcrossInvoices({
    organizationId,
    businessId,
    total,
    parts,
    reasonCode: input.reasonCode,
    reason: input.reason,
    tx,
    creditedPeriod: input.creditedPeriod ?? null,
  });
}

/**
 * Attach each credit item to the invoice line it reverses (`reference_line_item_id`).
 *
 * ONLY WHERE THE ANSWER IS UNAMBIGUOUS: exactly one positive line on this invoice charged
 * that price. An invoice can legitimately carry two lines for one price (a quantity
 * scale-up bills the delta beside the original), and guessing between them would stamp a
 * document with a link to the wrong supply — worse than the NULL it replaces, because a
 * NULL is honest about not knowing. Items with no `priceId`, no match, or an ambiguous
 * match keep their existing value (usually none) and still carry the credited PERIOD,
 * which is the field that was actually misreporting.
 *
 * Not a money path: nothing here changes an amount, only which line a note points at.
 */
function linkItemsToLines<T extends { amountMinor: bigint; priceId?: string | null }>(
  items: T[],
  lines: { publicId: string; priceId: string | null }[],
): (T & { invoiceLineItemPublicId?: string })[] {
  const byPrice = new Map<string, string[]>();
  for (const l of lines) {
    if (l.priceId == null) continue;
    const seen = byPrice.get(l.priceId);
    if (seen) seen.push(l.publicId);
    else byPrice.set(l.priceId, [l.publicId]);
  }
  return items.map((it) => {
    const candidates = it.priceId != null ? byPrice.get(it.priceId) : undefined;
    return candidates?.length === 1 ? { ...it, invoiceLineItemPublicId: candidates[0]! } : it;
  });
}

/**
 * The window a subscription CHANGE hands back: `[the instant it prorates as of, the old
 * term's end)`.
 *
 * One derivation, used by all three change-path credit builders (downgrade, upgrade-side,
 * term reset), because the three must agree — and because it is the same pair of instants
 * the AMOUNTS were cut on, so a credit note cannot claim a window its own money does not
 * match. `prorationWindowStart` has already floored the start to the local day on a
 * whole-day business, which is why the raw `now` never appears here.
 *
 * The END is the OLD term end even on a term reset. A reset charges the NEW term
 * (`newPeriodEnd`) and credits the OLD one; using the charge's boundary for the credit
 * would describe a period the credited invoices never billed. A reset's credit-note line
 * runs `date_from` = change date → `date_to` = old term end, while the same change's
 * proration invoice runs to the new end.
 */
function changeCreditedPeriod(plan: {
  resetTerm: boolean;
  resetStart: Date;
  prorationNow: Date;
  sub: typeof subscriptions.$inferSelect;
}): { start: Date; end: Date } | null {
  // A subscription with no term has no unused time to hand back — and `requireTerm` would
  // throw. Every caller is past the trial early-out, so this is belt and braces.
  const term = termOrNull(plan.sub);
  if (term == null) return null;
  return { start: plan.resetTerm ? plan.resetStart : plan.prorationNow, end: term.end };
}

/**
 * Re-point a CHARGE line's wording at the credit that reverses it.
 *
 * A credit note issued by a term reset is spelled out from the source invoice's OWN line
 * descriptions (see `issueCurrentTermCredit`), so this has to cope with every phrasing a
 * charge line can carry — and there are two, because a proration charge is named one way
 * by our own generator and another by an imported source, which the importer preserves
 * verbatim:
 *
 *   "Remaining time on BUSINESS plan ×1"   ← ours (non-reset proration pair)
 *   "BUSINESS plan - Prorated Charges"     ← imported, and ours for a same-cadence proration
 *
 * Only the PREFIX form was handled. Blind prefixing had already produced "Unused time on
 * Remaining time on X" once and been fixed; the suffix form then survived the rewrite and
 * shipped as **"Unused time on BUSINESS plan - Prorated Charges"** on real credit notes —
 * a credit for the unused portion of some *charges*, which is not a thing. Measured on
 * CN-1324 (2026-08-30), whose three lines all read that way.
 *
 * Both affixes are stripped independently rather than as an either/or: nothing in the
 * generator emits both today, but a line that ever did would otherwise keep one of them,
 * and the cost of being thorough here is a second `replace`.
 *
 * Our proration wording deliberately names the quantity and says which side of the
 * proration a line is. This is about that wording being coherent.
 */
export function creditedDescription(d: string): string {
  // ── IDEMPOTENT (2026-08-31) ──────────────────────────────────────────────────
  // A line that already says "Unused time on X" is already credit-worded, and
  // re-wording it produced "Unused time on Unused time on BUSINESS ×1" the moment the
  // change path started routing through here (measured by
  // `scripts/probe-unpaid-plan-change.ts` the same day). The change path's negative
  // lines are named by the proration generator, which already uses this exact phrasing —
  // so this function's input is sometimes a CHARGE line to re-point and sometimes a
  // credit line that needs nothing done to it, and it has to be safe on both.
  //
  // That double prefix is also the shape the docblock above records shipping once before,
  // from blind prefixing; the guard is here rather than at the call site so a third caller
  // cannot reintroduce it.
  if (d.startsWith("Unused time on ")) return d;
  const base = d.replace(/^Remaining time on /, "").replace(/ - Prorated Charges$/, "");
  return `Unused time on ${base}`;
}

/** One invoice's share of a credit: the basis it is allotted by, and the lines it is spelled out on. */
interface InvoiceCreditPart {
  invoice: typeof invoices.$inferSelect;
  /** Share basis — the invoice's own subtotal (term-wide) or what it billed for the credited prices. */
  base: bigint;
  /**
   * The POSITIVE lines the share is written against, scaled down to it.
   *
   * `publicId` is the SOURCE invoice line's `il_…`, threaded through so the credit-note
   * item can inherit that line's SERVICE PERIOD (`CreditNoteItemInput.invoiceLineItemPublicId`
   * → `resolveCreditedLines`). Without it every credit-note item was written with
   * `period_start`, `period_end` and `invoice_line_item_id` NULL — the columns 0188/0189 added
   * for exactly this — so a credit note could not say which period it reversed. That period
   * can be spelled out in the line TEXT ("… - Prorated Credits for 31-Aug-2026 -
   * 29-Sep-2026"); we carry it structurally instead, but only if it is passed.
   */
  lines: { description: string; amountMinor: bigint; publicId: string; priceId: string | null }[];
}

/**
 * The live invoices that charged any of `priceIds`, oldest first, with what each one
 * actually billed for them.
 *
 * `base` is the NET of that invoice's lines for those prices, negatives included: a
 * quantity upgrade bills "Remaining time on X ×40" (+20000) alongside "Unused time on
 * X ×1" (−500) on one invoice, and 19500 is both what that invoice collected for the
 * item and what it can fund. The lines the credit is SPELLED OUT on are the positive
 * ones — a credit note cannot carry a negative supply, and the netting is already in
 * the share.
 */
async function invoicesChargingPrices(
  organizationId: string,
  live: (typeof invoices.$inferSelect)[],
  priceIds: string[],
  tx: Tx | null,
): Promise<InvoiceCreditPart[]> {
  const wanted = new Set(priceIds);
  const parts: InvoiceCreditPart[] = [];
  for (const inv of live) {
    const rawLines = await withTenantTx(organizationId, tx, async (t) =>
      t.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, inv.id)),
    );
    const mine = rawLines.filter(
      (l) =>
        l.priceId != null &&
        wanted.has(l.priceId) &&
        !["tax", "discount", "rounding"].includes(l.kind ?? ""),
    );
    if (mine.length === 0) continue;
    const base = mine.reduce((sum, l) => sum + l.amountMinor, 0n);
    const positive = mine.filter((l) => l.amountMinor > 0n);
    if (base <= 0n || positive.length === 0) continue;
    parts.push({
      invoice: inv,
      base,
      lines: positive.map((l) => ({
        description: l.description,
        amountMinor: l.amountMinor,
        publicId: l.publicId,
        priceId: l.priceId,
      })),
    });
  }
  return parts;
}

/**
 * Place ONE credit across SEVERAL invoices — one credit note per invoice, each credited
 * from its own lines, the parts summing to `total` exactly.
 *
 * Split out of `issueCurrentTermCredit` when the item-specific path became multi-invoice
 * too (2026-08-24). A term reset and an item removal differ only in WHICH invoices are
 * eligible and which lines the share is written against; how the money is placed is one
 * rule, and it lives here so the two paths cannot drift apart.
 *
 * ── ONLY INVOICES THAT CAN STILL ABSORB CREDIT ────────────────────────────────
 * A `live` invoice — right status, non-zero total — is not the same as one with room
 * left. An invoice whose cash was already fully refunded AND fully credited is still
 * `paid` with a non-zero total, so it stayed in the set, was allocated a share, and then
 * `issueRefundableCreditNote` REFUSED that share — rolling back the entire subscription
 * change. Measured 2026-08-24 on sub_XXXXXXXXXXXXXXXXXXXXXX02: two ₹373,800.40 invoices
 * for one term (the second raised by an earlier attempt), the first fully refunded and
 * fully credited (capacity ₹0), so the even split handed it ₹186,900.20 — exactly the
 * "Refundable credit 18690020 exceeds refundable paid amount 0" the operator saw on a
 * change that was otherwise fine.
 *
 * Capacity is asked with `refundableCapacityForInvoice`, the SAME function the guard
 * enforces, so the allocator and the refusal cannot disagree. An OPEN invoice can also
 * absorb up to its amount due through the adjustment path (`creditOneInvoice`), so its
 * capacity is due + refundable headroom.
 */
async function creditAcrossInvoices(input: {
  organizationId: string;
  businessId: string;
  /** The whole credit to place. Callers have already checked it is > 0. */
  total: bigint;
  parts: InvoiceCreditPart[];
  reasonCode?: string;
  reason?: string;
  tx: Tx | null;
  /** The window handed back — passed straight through to every part's note. */
  creditedPeriod?: { start: Date; end: Date } | null;
}): Promise<CreditNote[]> {
  const { organizationId, businessId, total, tx } = input;
  if (input.parts.length === 0 || total <= 0n) return [];

  // THE CREDIT QUESTION, not the payout one. `refundableCapacityForInvoice` subtracts only
  // a note's OUTSTANDING claim on cash, so an invoice whose whole value was already credited
  // — its note allocated onto a later invoice — still reported its full amount available and
  // absorbed a second credit that had nothing to offset. That note then landed as
  // `refund_due`: a cash liability instead of a reduction of the live invoice, leaving a real
  // subscriber ₹2,717.54 out of pocket against a refund nobody had actioned (PROGRESS :146).
  // `refundableCapacityForInvoice` is deliberately NOT changed — doing so re-breaks the
  // promo-funded refund case that produced its rule.
  const { creditableCapacityForInvoice, remainingCreditableAgainstInvoice } =
    await import("@/modules/credit-notes/service");
  const capacity = new Map<string, bigint>();
  for (const { invoice: inv } of input.parts) {
    const { available } = await withTenantTx(organizationId, tx, (t) =>
      creditableCapacityForInvoice(t, inv.id),
    );
    const due = await invoiceOutstandingDue(organizationId, inv, tx);
    const room = (due > 0n ? due : 0n) + (available > 0n ? available : 0n);
    // Credit-funded invoices count too: `creditOneInvoice` returns the bucket-funded
    // slice to its buckets instead of refusing, so an invoice paid with the customer's
    // own credit CAN absorb a credit even with zero cash behind it.
    const recycled =
      (inv.promotionalCreditsAppliedMinor ?? 0n) +
      (inv.excessPaymentsAppliedMinor ?? 0n) +
      (inv.refundableCreditsAppliedMinor ?? 0n);
    // ── BUT NEVER PAST WHAT THE INVOICE IS WORTH (M1, 2026-09-01) ─────────────────
    // `recycled` was added RAW, so it re-offered exactly the value a full-value note had
    // already reversed: `creditableCapacityForInvoice` reports 0 for a fully credited
    // invoice and this term overrode it. 52 invoices on the dev database carried notes
    // summing past their total, ₹1,23,250.81 over — see
    // `remainingCreditableAgainstInvoice`, which is the ceiling, and
    // `probe-estimate-vs-booked-change-chain`, which reproduces the chained shape that
    // gets there (each change crediting an invoice the previous change funded with
    // credit, so every source invoice carries `refundable_credits_applied_minor > 0`).
    // On a first credit the ceiling IS the invoice total, so nothing else moves.
    const ceiling = await withTenantTx(organizationId, tx, (t) =>
      remainingCreditableAgainstInvoice(t, inv),
    );
    const grossPlaceable = room + recycled < ceiling ? room + recycled : ceiling;
    // ── AND IN THE UNITS BEING DISTRIBUTED (2026-09-01) ───────────────────────────
    // Everything above is GROSS money the invoice can give back; `distributeCreditAcross
    // Invoices` is handed the PRE-TAX list total, because that is what `creditOneInvoice`
    // takes. Comparing the two directly let a share be clamped AT the gross cap and then
    // grossed up past it — over-crediting by exactly the invoice's tax fraction, every
    // time. Measured by `scripts/verify-credit-cap-invariant.ts`: INV-4's ceiling of
    // 220731 admitted a 220731 pre-tax share that was written as 260463, +39732 = 18%.
    //
    // So the cap is converted ONCE, here, by inverting the exact map `creditOneInvoice`
    // will apply — see `preTaxCreditFitting`. This also corrects the same mismatch on
    // `room + recycled`, which had it from the beginning and was simply too permissive to
    // notice until the ceiling made a cap bind at all.
    const placeable = preTaxCreditFitting(
      grossPlaceable,
      await readInvoiceCreditBasis(organizationId, businessId, inv, tx),
    );
    // Nothing at all behind this invoice — money already returned, or already credited.
    // Skipping is correct.
    if (placeable > 0n) capacity.set(inv.id, placeable);
  }
  // Nothing left anywhere: the money was already returned, so there is nothing further
  // to credit. Returning [] lets the change proceed — refusing it would block a change
  // for a credit the customer has ALREADY had.
  const fundable = input.parts.filter((p) => capacity.has(p.invoice.id));
  if (fundable.length === 0) return [];

  // Pro-rata by base with largest-remainder, then clamped to each invoice's capacity and
  // re-placed onto invoices with headroom, with whatever cannot be placed dropped. The
  // arithmetic — and the reasons for every step of it — is `credit-routing.ts`; it is
  // pure so `estimate.ts` can ask the same question without re-deriving the answer.
  const distributed = distributeCreditAcrossInvoices({
    totalMinor: total,
    parts: fundable.map((p) => ({
      id: p.invoice.id,
      baseMinor: p.base,
      capacityMinor: capacity.get(p.invoice.id)!,
    })),
  });
  if (distributed.shares.length === 0) return [];
  const shares = distributed.shares.map((s) => s.shareMinor);

  const notes: CreditNote[] = [];
  for (const [k, part] of fundable.entries()) {
    const share = shares[k]!;
    if (share <= 0n) continue;
    // This invoice's own lines, scaled to its share — largest remainder, so the note's
    // lines sum to its total exactly.
    const lineBase = part.lines.reduce((sum, l) => sum + l.amountMinor, 0n);
    if (lineBase <= 0n) continue;
    const amounts = part.lines.map((l) => (l.amountMinor * share) / lineBase);
    let short = share - amounts.reduce((sum, v) => sum + v, 0n);
    const byRem = part.lines
      .map((l, j) => ({ j, rem: l.amountMinor * share - amounts[j]! * lineBase }))
      .sort((a, b) => (a.rem === b.rem ? a.j - b.j : a.rem > b.rem ? -1 : 1));
    for (const o of byRem) {
      if (short <= 0n) break;
      amounts[o.j] = amounts[o.j]! + 1n;
      short -= 1n;
    }
    const items = part.lines
      .map((l, j) => ({
        description: creditedDescription(l.description),
        invoiceLineItemPublicId: l.publicId,
        amountMinor: amounts[j]!,
      }))
      .filter((i) => i.amountMinor > 0n);
    const written = await creditOneInvoice(
      organizationId,
      businessId,
      part.invoice,
      items,
      input.reasonCode,
      input.reason,
      tx,
      // Overrides the source line each item names: that line billed the whole term, and
      // the note is handing back only the unused tail of it (see
      // `issueCurrentTermCredit.creditedPeriod`). This is the path whose items DID carry
      // a period and carried the wrong one.
      input.creditedPeriod ?? null,
    );
    notes.push(...written);
  }
  return notes;
}

/**
 * Could the invoices `issueCurrentTermCredit` would target absorb a credit worth
 * `preTaxMinor` — in the SAME units its `items` are in (list price, before each
 * invoice's own coupon discount and before the tax gross-up)?
 *
 * The mapping from those units to the gross figure that actually has to be funded is
 * the exact inverse of what `creditOneInvoice` does to them:
 *   discounted = preTax × netBase / listBase   then   gross = discounted × total / netBase
 *   ⇒ gross = preTax × inv.total / listBase
 * and the funding available is the same expression the split itself uses — the invoice's
 * refundable headroom, plus its still-open due, plus whatever of the customer's own
 * credit settled it (which `creditOneInvoice` returns to its bucket).
 *
 * Asked of the WHOLE target set, not one invoice: the credit is placed across every
 * invoice that charged the credited prices, and `creditAcrossInvoices` moves a share
 * freely from an invoice that is full to one with headroom. Summing both sides is
 * therefore the same question the allocator will answer.
 *
 * Deliberately a BOOLEAN, not a residual: a caller that only needs to choose between
 * two whole shapes cannot be made wrong by a rounding unit, whereas trimming a charge
 * by a derived remainder can.
 */
async function termInvoiceCanAbsorb(input: {
  organizationId: string;
  businessId: string;
  subscription: typeof subscriptions.$inferSelect;
  /** The prices being credited — same meaning as `issueCurrentTermCredit.targetPriceIds`. */
  targetPriceIds?: string[] | null;
  preTaxMinor: bigint;
  tx?: Tx | null;
}): Promise<boolean> {
  const { organizationId, businessId } = input;
  if (input.preTaxMinor <= 0n) return true;
  // The same `live` set, filter and ordering `issueCurrentTermCredit` picks from, so
  // the two cannot disagree about which invoice is being asked about.
  const live = await withTenantTx(organizationId, input.tx, async (t) => {
    const rows = await t
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.businessId, businessId),
          eq(invoices.subscriptionId, input.subscription.id),
        ),
      );
    return rows
      .filter((r) => !["voided", "pending"].includes(r.status) && r.totalMinor > 0n)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  });
  if (live.length === 0) return false;
  // The same target set `issueCurrentTermCredit` resolves, and the same fallback when
  // nothing on this term charged those prices — so the two cannot disagree about which
  // invoices are being asked about.
  const targeted =
    input.targetPriceIds && input.targetPriceIds.length > 0
      ? await invoicesChargingPrices(organizationId, live, input.targetPriceIds, input.tx ?? null)
      : [];
  const parts =
    targeted.length > 0 ? targeted : [{ invoice: live[live.length - 1]!, base: 1n, lines: [] }];

  // Each invoice's share of the credit, by the same basis and the same largest-remainder
  // rule the allocator uses. One invoice ⇒ share = the whole credit, i.e. the single-target
  // arithmetic this function has always done, unrounded.
  const totalBase = parts.reduce((sum, p) => sum + p.base, 0n);
  if (totalBase <= 0n) return false;
  const shares = parts.map((p) => (p.base * input.preTaxMinor) / totalBase);
  let leftover = input.preTaxMinor - shares.reduce((sum, v) => sum + v, 0n);
  const order = parts
    .map((p, k) => ({ k, rem: p.base * input.preTaxMinor - shares[k]! * totalBase }))
    .sort((a, b) => (a.rem === b.rem ? a.k - b.k : a.rem > b.rem ? -1 : 1));
  for (const o of order) {
    if (leftover <= 0n) break;
    shares[o.k] = shares[o.k]! + 1n;
    leftover -= 1n;
  }

  const { refundableCapacityForInvoice, remainingCreditableAgainstInvoice } =
    await import("@/modules/credit-notes/service");
  let needed = 0n;
  let available = 0n;
  for (const [k, part] of parts.entries()) {
    const inv = part.invoice;
    if (inv.totalMinor <= 0n) return false;
    const booked = await withTenantTx(organizationId, input.tx, async (t) => {
      const entries = await t
        .select()
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.businessId, businessId),
            eq(ledgerEntries.sourceType, "invoice"),
            eq(ledgerEntries.sourceId, inv.publicId),
          ),
        );
      const signed = (account: string, positive: "debit" | "credit") =>
        entries
          .filter((e) => e.account === account)
          .reduce((s, e) => s + (e.direction === positive ? e.amountMinor : -e.amountMinor), 0n);
      return { tax: signed("tax_payable", "credit"), discount: signed("discounts", "debit") };
    });
    const netBase = inv.totalMinor - booked.tax;
    const listBase = netBase + booked.discount;
    if (listBase <= 0n) return false;
    const cap = await withTenantTx(organizationId, input.tx, (t) =>
      refundableCapacityForInvoice(t, inv.id),
    );
    const due = await invoiceOutstandingDue(organizationId, inv, input.tx);
    const room = (due > 0n ? due : 0n) + (cap.available > 0n ? cap.available : 0n);
    const recycled =
      (inv.promotionalCreditsAppliedMinor ?? 0n) +
      (inv.excessPaymentsAppliedMinor ?? 0n) +
      (inv.refundableCreditsAppliedMinor ?? 0n);
    // SCALED BY WHAT WAS REFUNDED, exactly as `creditOneInvoice` scales the credit it
    // actually issues. This gate asks "will the gross credit fit?", so it has to weigh
    // the figure that will really be booked — and since 2026-08-28 that figure is
    // reduced by any cash already handed back.
    //
    // Without it the two sides of the comparison used different definitions and a refund
    // subtracted from `available` while leaving `needed` at full value. The gap is the
    // refund, so ANY refund at all, however small, could tip the gate — and tipping it is
    // not a rounding difference, it collapses the whole change from its intended shape
    // (credit the old term gross + invoice the new plan) to a single netted credit note.
    //
    // Measured: invoice 3114324, ONE 500 refund. available = 2113824 cash +
    // 1000000 recycled promo = 3113824; needed stood at 3114324. Short by exactly the
    // 500. A five-rupee refund moved 104937 of value and changed the document shape the
    // customer sees.
    /**
     * ── THE ONE FORWARD MAP, NOT A SECOND COPY OF IT (2026-09-01) ────────────────
     *
     * This was the closed form `(share × total / listBase) × (total − refunded) / total`,
     * with truncating division — which is exactly what `grossCreditOnInvoice`'s docblock
     * forbids: *"⚠ NOT the closed form `preTax × total / listBase`. That identity is exact
     * only in real arithmetic"*. It was measured as a real preview-vs-booking divergence
     * (a booked note of ₹10,400.61 quoted as ₹10,400.60) and fixed at the allocator; this
     * gate kept its own copy.
     *
     * Worse than a paisa here, because it also omitted the `creditsAmountDue` branch. On an
     * OPEN invoice carrying promotional credit the real tax basis is `netBase − promo` — a
     * higher effective rate — so this gate systematically UNDER-stated `needed` on exactly
     * the promo-funded shape. Under-state `needed` and the gate answers
     * "it fits", the allocator then cannot place the surplus, and per this function's own
     * docblock the surplus is silently dropped while the new term is billed in full.
     *
     * So it calls the same function the allocator does. `readInvoiceCreditBasis` reads the
     * ledger tax, the booked coupon, the refund and the promotional applied — everything
     * the hand-rolled arithmetic above was reconstructing from a subset of them.
     */
    const basis = await readInvoiceCreditBasis(organizationId, businessId, inv, input.tx ?? null);
    needed += grossCreditOnInvoice(shares[k]!, basis);
    // ── THE SAME CEILING THE ALLOCATOR NOW APPLIES (M1, 2026-09-01) ───────────────
    // This gate and `creditAcrossInvoices` have to answer with one definition of "will it
    // fit", or the gate chooses the GROSSED shape and the allocator then drops the surplus
    // — the exact hazard this function's own docblock describes ("the surplus is silently
    // dropped, while the new term's charge is billed in full"). Same `min`, same reason.
    const ceiling = await withTenantTx(organizationId, input.tx, (t) =>
      remainingCreditableAgainstInvoice(t, inv),
    );
    available += room + recycled < ceiling ? room + recycled : ceiling;
  }
  return needed <= available;
}

/**
 * Read one invoice's `InvoiceCreditBasis` — its ledger tax and coupon discount, the cash
 * already refunded, the promotional credit that settled it, and its status.
 *
 * The SAME reads `creditOneInvoice` makes when it books, and `termInvoiceCanAbsorb` makes
 * when it gates, so a capacity computed from this and a note written from those cannot
 * disagree about what an invoice is worth.
 */
/**
 * THE LIVE OUTSTANDING on an invoice, for capacity arithmetic — not the stored column.
 *
 * ── WHY THIS EXISTS (2026-09-01) ─────────────────────────────────────────────────
 * Both capacity sites here read `inv.amountDueMinor ?? inv.totalMinor` directly, and
 * `db/schema/invoices.ts` warns about exactly that in as many words: the column is the
 * ISSUE-TIME collectible, *"**Never decremented as payments land**… Read this column and
 * you will conclude a settled invoice is still owed; that misreading has happened."*
 *
 * So on a PARTLY CASH-PAID open invoice the booking's capacity exceeded the preview's by
 * exactly the amount paid — and it counted that cash twice, because
 * `creditableCapacityForInvoice` already contains it. The preview
 * (`estimate.ts`) has always derived the live figure through `invoiceOutstanding`. A
 * preview and a booking that resolve capacity differently is the same class of defect this
 * module spent 2026-09-01 closing; this is the last site where the two still disagreed.
 *
 * The status gate is KEPT: only an open invoice contributes due, which is what the callers
 * meant. The preview omits it because its own eligible-set filter (`voided`/`pending`
 * excluded) already does that job, and a settled invoice's remaining is 0 either way — so
 * the two are equivalent, not merely similar.
 *
 * Dynamic import: `proration.ts` has no static dependency on `invoicing/service` and must
 * not gain one (cycle).
 */
async function invoiceOutstandingDue(
  organizationId: string,
  inv: typeof invoices.$inferSelect,
  tx: Tx | null | undefined,
): Promise<bigint> {
  if (!isOpenInvoiceStatus(inv.status)) return 0n;
  const { invoiceOutstanding } = await import("@/modules/invoicing/service");
  const { remainingMinor } = await withTenantTx(organizationId, tx, (t) =>
    invoiceOutstanding(t, inv),
  );
  return remainingMinor;
}

async function readInvoiceCreditBasis(
  organizationId: string,
  businessId: string,
  inv: typeof invoices.$inferSelect,
  tx: Tx | null,
): Promise<InvoiceCreditBasis> {
  const { refundableCapacityForInvoice } = await import("@/modules/credit-notes/service");
  const booked = await withTenantTx(organizationId, tx, async (t) => {
    const entries = await t
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.businessId, businessId),
          eq(ledgerEntries.sourceType, "invoice"),
          eq(ledgerEntries.sourceId, inv.publicId),
        ),
      );
    const signed = (account: string, positive: "debit" | "credit") =>
      entries
        .filter((e) => e.account === account)
        .reduce((s, e) => s + (e.direction === positive ? e.amountMinor : -e.amountMinor), 0n);
    return { tax: signed("tax_payable", "credit"), discount: signed("discounts", "debit") };
  });
  const cap = await withTenantTx(organizationId, tx, (t) =>
    refundableCapacityForInvoice(t, inv.id),
  );
  return {
    totalMinor: inv.totalMinor,
    bookedTaxMinor: booked.tax,
    bookedDiscountMinor: booked.discount,
    refundedMinor: cap.refundedMinor,
    promoAppliedMinor: inv.promotionalCreditsAppliedMinor ?? 0n,
    open: isOpenInvoiceStatus(inv.status),
  };
}

/**
 * Everything about ONE invoice that decides what a credit against it is WORTH.
 *
 * Read once per invoice and passed around, because three call sites now need the same
 * facts (`creditAcrossInvoices`'s capacity, `issueCurrentTermCredit`'s two single-invoice
 * paths, and `estimate.ts`'s preview of all of them) and a fourth re-derivation is how
 * they drift.
 */
export interface InvoiceCreditBasis {
  /** `invoices.total_minor` — GROSS, tax included. */
  totalMinor: bigint;
  /** Tax this invoice actually booked, from its ledger. Never a re-derived rate. */
  bookedTaxMinor: bigint;
  /** Coupon discount it booked. Promotional credit is NOT a discount — see `creditOneInvoice`. */
  bookedDiscountMinor: bigint;
  /** Cash already handed back. */
  refundedMinor: bigint;
  /** Promotional credit that settled it, applied PRE-tax. */
  promoAppliedMinor: bigint;
  /** Open (payment-due / not-paid) — it selects the tax basis. */
  open: boolean;
}

/**
 * THE GROSS `creditOneInvoice` WILL ACTUALLY WRITE for `preTaxMinor` of list-price credit.
 *
 * The same three rounded steps, in the same order, that function applies:
 *
 *   1 · scale to the invoice's booked COUPON discount   (netBase / listBase)
 *   2 · scale by what has NOT been refunded             ((total − refunded) / total)
 *   3 · add the tax reversal on the released base       (round half-up)
 *
 * ⚠ NOT the closed form `preTax × total / listBase`. That identity is exact only in real
 * arithmetic; each step above rounds half-up, and collapsing the three into one truncated
 * division is a paisa out on any amount whose fraction sits either side. That was measured
 * as a real preview-vs-booking divergence on 2026-08-31 (a booked note of ₹10,400.61 quoted
 * at ₹10,400.60), which is why this is a function and not a multiplication.
 *
 * Extracted 2026-09-01 so that `preTaxCreditFitting` below can invert it EXACTLY, rather
 * than approximately — see the falsification measured there.
 */
export function grossCreditOnInvoice(preTaxMinor: bigint, b: InvoiceCreditBasis): bigint {
  if (preTaxMinor <= 0n) return 0n;
  const netBase = b.totalMinor - b.bookedTaxMinor;
  const listBase = netBase + b.bookedDiscountMinor;
  // round half-up, integer minor units — `rescaleCreditItems`'s `target`
  const scale = (v: bigint, num: bigint, den: bigint) => (v * num + den / 2n) / den;
  let discounted = preTaxMinor;
  if (b.bookedDiscountMinor > 0n && netBase > 0n && listBase > 0n)
    discounted = scale(discounted, netBase, listBase);
  if (b.refundedMinor > 0n && b.totalMinor > b.refundedMinor)
    discounted = scale(discounted, b.totalMinor - b.refundedMinor, b.totalMinor);
  const taxedBase = netBase - b.promoAppliedMinor;
  const creditsAmountDue = b.open && b.promoAppliedMinor > 0n && taxedBase > 0n;
  const taxBasis = creditsAmountDue ? taxedBase : netBase;
  let taxItem = 0n;
  if (b.bookedTaxMinor > 0n && taxBasis > 0n) {
    const released = creditsAmountDue && discounted > taxBasis ? taxBasis : discounted;
    taxItem = scale(released, b.bookedTaxMinor, taxBasis);
  }
  return discounted + taxItem;
}

/**
 * THE LARGEST PRE-TAX CREDIT WHOSE GROSS STILL FITS `grossCapMinor` — the inverse of
 * `grossCreditOnInvoice`, and the reason it exists.
 *
 * ── THE DEFECT THIS CLOSES (2026-09-01) ──────────────────────────────────────────
 * `creditAcrossInvoices` distributes a PRE-TAX list total but clamped each share against a
 * GROSS capacity (`due + creditable headroom + recycled`, and since the M1 fix also the
 * cumulative-credit ceiling). Mixed units: a share clamped AT the gross cap was then
 * grossed up by `creditOneInvoice`, so the placement legally overshot by its own tax
 * fraction — every time, not as a rounding artefact.
 *
 * Measured by `scripts/verify-credit-cap-invariant.ts` (a chained shape ending in two
 * `resetTerm: true` changes), on the tree that already had the M1 ceiling:
 *
 *   INV-4  ceiling 220731 gross → share clamped to 220731 PRE-TAX → written 260463
 *          overshoot 39732 = exactly 18% of 220731
 *   INV-7  ceiling 260463 gross → share clamped to 260463 PRE-TAX → written 307346
 *          overshoot 46883 = exactly 18% of 260463
 *
 * ₹866.15 over two invoices, both of which then carried more credit than they were worth.
 * The M1 ceiling was right and its UNITS were wrong; adding a fifth clamped site would not
 * have touched it.
 *
 * ⚠ THE MISMATCH PREDATES M1, and this is the part worth carrying forward. `capacityMinor`
 * has ALWAYS been gross while the distributed total has always been pre-tax, so this
 * capacity was ~15% too permissive from the day it was written. It never bound, because
 * nothing capped anything: `due + creditable headroom + recycled` on a healthy invoice
 * comfortably exceeds any share, so the error had no way to show. Adding the cumulative
 * ceiling did not introduce the bug — it made a cap bind for the first time and so made an
 * existing one reachable. A guard that has never bound has never been tested either.
 *
 * ── AND WHAT HAPPENS TO WHAT DOES NOT FIT ────────────────────────────────────────
 * Returning less than the caller wanted does NOT leave the remainder owed. The allocator's
 * clamp-and-re-place pass moves it to another invoice with headroom first, and anything
 * still unplaced becomes `CreditDistribution.unplacedMinor`, which `creditAcrossInvoices`
 * DROPS — deliberately, since it is credit the customer has already had, and refusing the
 * change over it would block a change for money already handed back. That was always the
 * contract; what is new is that this function makes it REACHABLE where the gross capacity
 * never bound. `estimate.ts` reports the same quantity as the `stranded` leg of
 * `credit_destinations`, so a preview does say it out loud.
 *
 * ── WHY IT ITERATES INSTEAD OF DIVIDING ──────────────────────────────────────────
 * The closed form `grossCap × listBase / total` is the right neighbourhood and not the
 * right answer: `grossCreditOnInvoice` rounds half-up up to three times, so the forward map
 * is a step function whose inverse a single division can miss by a unit or two. Since the
 * map is monotone, the honest inverse is to correct against the map itself.
 *
 * DOWN is unbounded and UP is not, deliberately: descending always terminates (the map
 * sends 0 to 0, so p = 0 always satisfies the cap) and can only ever under-credit, while an
 * unbounded ascent on a flat stretch of the map is the one direction that could run long.
 * Eight steps is far more than the closed form is ever out by; if it somehow were, the
 * result is a minor unit or two of credit withheld at the exact moment an invoice is
 * exhausted, which is the safe side of a cap.
 */
export function preTaxCreditFitting(grossCapMinor: bigint, b: InvoiceCreditBasis): bigint {
  if (grossCapMinor <= 0n) return 0n;
  /**
   * ── EXACT BINARY SEARCH, NOT A SEED PLUS A BOUNDED WALK (2026-09-01) ─────────
   *
   * The first cut seeded with the closed form `grossCap × listBase / total` and then
   * corrected against the real map — unbounded DOWNWARD but capped at eight steps UPWARD.
   * That asymmetry was exactly backwards. The seed inverts the discount and tax steps but
   * OMITS `grossCreditOnInvoice`'s refund rescale `× (total − refunded) / total`, which
   * makes the gross smaller — so the true pre-tax answer is LARGER than the seed, in the
   * one direction eight steps could not reach. The seed error is
   * `listBase × refunded / (total − refunded)`, which scales with the prior REFUND and not
   * with the invoice, so the bound was not conservative, it was unrelated.
   *
   * Measured (subtotal 2,867,000, total 3,383,060, IGST 516,060, 500 already refunded):
   * seed 2,866,576, eight steps recovered 8, answer 2,866,584 against a true 2,867,000 —
   * **416 pre-tax units short, 491 gross**. Two whole scenarios returned to their
   * pre-clamp signature the moment this became exact. And under-crediting here is not the safe side of a cap: the shortfall
   * becomes `unplacedMinor`, which `creditAcrossInvoices` DROPS rather than owes, so the
   * invoice simply collects more cash — 491 minor units charged that should not have been.
   *
   * `grossCreditOnInvoice` is monotone non-decreasing in `p`, so a binary search for the
   * largest `p` whose gross still fits is exact — and, unlike a tuned seed, it cannot be
   * falsified by someone adding a fourth rounded step to the forward map.
   */
  /**
   * ── THE UPPER BOUND HAS TO BE FOUND, NOT GUESSED (2026-09-01, second correction) ──
   *
   * This was `hi = grossCapMinor * 2n + 1000n`, and that is only a valid bound if
   * `gross(hi) > cap` — which nothing established. The forward map SHRINKS `p`, by the
   * coupon ratio `netBase/listBase` and by the refund ratio `(total − refunded)/total`, so
   * the true inverse is roughly `cap × listBase / (total − refunded)`. The guess therefore
   * held only while `listBase / (total − refunded) <= 2 + 1000/cap` — it breaks past about
   * a 58% coupon, or an invoice about 58% refunded, and then the search SATURATES at `hi`
   * and returns far less than fits.
   *
   * Measured on the two pure functions (no fixture needed — both are pure):
   *
   *   70% coupon + 18% GST, cap 35,400   guessed 71,800 -> gross 25,417   TRUE 100,001 -> 35,400
   *   80% refunded,         cap 20,000   guessed 41,000 -> gross  9,676   TRUE  84,747 -> 20,000
   *   100% coupon,          cap 11,800   guessed 24,600 -> gross  2,638   TRUE 110,005 -> 11,800
   *
   * 28%, 52% and 78% of the ceiling unreachable. And under-crediting here is NOT the safe
   * side: the shortfall becomes `unplacedMinor`, which `creditAcrossInvoices` DROPS rather
   * than owes, so the invoice collects the difference. This is the same over-collection
   * class the binary search was written to close, with a different cause and a larger
   * magnitude. `percent_off_bps` accepts up to 10000 (100% off) at the API, so it is
   * reachable rather than theoretical.
   *
   * ⚠️ **Every gate was green on it** — the invariant tests, the falsification fixture and
   * every end-to-end scenario uses undiscounted, unrefunded invoices, so `hi` never bound.
   * Verifying a fix against the one shape that motivated it is how this shipped; the unit
   * test beside it now pins the coupon and refund shapes specifically.
   *
   * So the bound is DISCOVERED: double until the gross overshoots the cap. That terminates
   * in ~60 iterations at bigint scale, cannot be falsified by a future change to the
   * forward map, and removes the class rather than retuning a constant.
   */
  let hi = 1n;
  while (grossCreditOnInvoice(hi, b) <= grossCapMinor) hi *= 2n;
  let lo = 0n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (grossCreditOnInvoice(mid, b) <= grossCapMinor) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/**
 * Scale every credit item by `num/den`, exactly.
 *
 * Round the TOTAL once, then hand the remainder out largest-first, so the parts sum to
 * the whole. Rounding each item half-up independently overshoots: two 6450 items under a
 * 15% coupon each land on exactly .5 → 5483, summing to 10966 against a netBase of 10965
 * — re-tripping the very refundable-credit guard the scaling exists to satisfy, on a
 * subscription with a plan plus one add-on.
 *
 * Extracted when a SECOND scale appeared (the refund proportion beside the coupon one).
 * The two compose, so the rounding rule has to be identical on both passes or the same
 * off-by-one comes back on whichever ran second.
 */
function rescaleCreditItems<T extends { amountMinor: bigint }>(
  items: T[],
  num: bigint,
  den: bigint,
): T[] {
  const total = items.reduce((s, i) => s + i.amountMinor, 0n);
  const target = (total * num + den / 2n) / den;
  const floors = items.map((i) => (i.amountMinor * num) / den);
  // remainder = the truncated fraction, kept exact in integer arithmetic
  const order = items
    .map((i, k) => ({ k, rem: i.amountMinor * num - floors[k]! * den }))
    .sort((a, b) => (a.rem === b.rem ? a.k - b.k : a.rem > b.rem ? -1 : 1));
  let leftover = target - floors.reduce((s, f) => s + f, 0n);
  const bumped = new Set<number>();
  for (const o of order) {
    if (leftover <= 0n) break;
    bumped.add(o.k);
    leftover -= 1n;
  }
  return items.map((i, k) => ({ ...i, amountMinor: floors[k]! + (bumped.has(k) ? 1n : 0n) }));
}

/**
 * Credit ONE invoice: scale for its own booked coupon discount and for any cash already
 * refunded, reverse the tax it actually booked, then choose adjustment vs refundable
 * from its status. Split out of
 * `issueCurrentTermCredit` when that became multi-invoice — every rule in here is
 * per-invoice (it reads that invoice's ledger), so it had to move as a unit rather than
 * be generalised.
 */
async function creditOneInvoice(
  organizationId: string,
  businessId: string,
  inv: typeof invoices.$inferSelect,
  /**
   * `invoiceLineItemPublicId` is optional because two callers cannot supply it: the
   * item-specific path with no attribution credits the newest live invoice from a
   * caller-supplied item list, and the synthetic tax-reversal line below reverses a
   * proportional slice of the whole invoice rather than any one line. Both are correctly
   * left without a period.
   */
  items: { description: string; amountMinor: bigint; invoiceLineItemPublicId?: string }[],
  reasonCodeIn: string | undefined,
  reasonIn: string | undefined,
  txIn: Tx | null,
  /**
   * The window handed back, stamped on every item written below — including the
   * synthetic tax-reversal line, which reverses tax on that same window and so is not
   * one of the "correctly left without a period" cases named above. Null keeps the
   * pre-2026-08-31 inheritance.
   */
  creditedPeriod: { start: Date; end: Date } | null = null,
  /**
   * THE GROSS CEILING THIS CREDIT WAS CLAMPED TO, or null when nothing clamped it.
   *
   * `clampToCapacity` fits a PRE-TAX cap through `preTaxCreditFitting`, and this function
   * then rebuilds the gross from it — discount rescale, refund rescale, tax line — which is
   * exactly the map `grossCreditOnInvoice` models. That map's IMAGE IS COARSE: consecutive
   * pre-tax values can skip gross values entirely, so when the ceiling falls in a gap the
   * largest base that fits produces a gross strictly BELOW it, and no base produces the
   * ceiling. Measured as a one-paisa shortfall and reproduced end-to-end by
   * `scripts/probe-capped-credit-lands-on-cap.ts` (2159.19 against a 2159.24 headroom, five
   * paise — the shortfall is the map's local step, not a fixed amount).
   *
   * The remaining headroom must be credited EXACTLY: ₹2.00 against ₹1.00 of room is a
   * refusal naming the remaining amount, and exactly ₹1.00 is accepted. So the last note
   * against an invoice settles the remainder rather than re-deriving it.
   *
   * ⚠️ THE RESIDUAL GOES ON THE TAX LINE, and it can go nowhere else. The base is quantised
   * by the map — that is the whole defect — so there is no base value that would close the
   * gap; only the tax component can absorb it. And the residual is bounded BY CONSTRUCTION
   * rather than by a threshold: `preTaxCreditFitting` guarantees `gross(cap + 1) > ceiling`,
   * so `ceiling − gross(cap)` is always smaller than one step of the map. No magic number,
   * and nothing here can inflate a credit to an arbitrary target.
   *
   * ⚠️ AND IT DOES NOT CHANGE WHAT `grossCreditOnInvoice` COMPUTES. That is the direction the
   * reverted billed-line candidate went (PROGRESS: "an unused-time credit is rated from a
   * snapshot the plan change has already moved"), and `test/unit/credit-gross-cap-granularity.test.ts`
   * pins why the map itself is right. This changes only what happens when the cap BINDS.
   */
  grossTarget: bigint | null = null,
  // ── WHY AN ARRAY, AND NOT `CreditNote | null` (2026-09-01) ──────────────────────
  // The open branch below can write TWO documents for one invoice — an ADJUSTMENT note
  // for the debt it relieves and a REFUNDABLE note for the cashable overflow — and this
  // function used to answer `return adj ?? refundable`, handing back only the first. The
  // second note was still written to the database; every caller of `changeSubscription`
  // simply never heard about it.
  //
  // MEASURED on `verify:credit-chain-gateway` § 9 (the term reset), 2026-09-01: the
  // booking raised FIVE credit notes — the suite's own DB count says "business went from
  // 5 to 10 notes" — and `changeSubscription().creditNotes` reported FOUR, omitting a
  // ₹9,420.18 refundable note. That is what D3 actually was, and it had been filed for a
  // day as an ESTIMATE defect ("the term-reset preview over-quotes the booking by
  // ₹9,420.18") on the strength of comparing the preview against this under-reported
  // list. The preview was right the whole time, share for share: 990639 / 1935484 /
  // 1537507 / 5802047 pre-tax and 1168954 / 2283871 / 1814258 / 6846415 gross on BOTH
  // sides, with the open invoice routing to adjustment 4992614 + freedExcess 911783 +
  // cashable 942018 — and 942018 is exactly the note that went missing.
  //
  // The harm is not only a red suite: the `/change` response and every surface built on
  // it told the customer about the adjustment and not about the refundable credit the
  // same change had just granted them.
): Promise<CreditNote[]> {
  const total = items.reduce((s, i) => s + i.amountMinor, 0n);
  if (total <= 0n) return [];
  const input = { items, reasonCode: reasonCodeIn, reason: reasonIn, tx: txIn };

  // ── SERIALIZE THE READ-THEN-ACT, CUSTOMER THEN INVOICE (2026-08-31) ──────────────
  // Everything below is read-then-act on money: this function reads the invoice's booked
  // tax, its outstanding, its refundable and creditable capacity, decides a split against
  // them, and only then writes notes and ledger entries. Two transactions at READ
  // COMMITTED cannot see each other's uncommitted `credit_notes` rows, so without a lock
  // both read the full capacity and both pass their caps — the defect
  // `verify:concurrent-credit-note` measured on the manual path, where five concurrent
  // full-amount notes minted 7500 of cash-refundable credit on 1500 of collected cash.
  //
  // `proration.ts` took NEITHER lock. The paid branch has been that way since ad8c149,
  // and the 2026-08-31 open-invoice fix made it worse by routing BOTH branches through
  // `createRefundableCreditNote` — around `issueRefundableCreditNote`, the only place
  // `lockInvoiceCredit` was ever taken. Worse, `lockInvoiceCredit`'s own docblock asserted
  // that "`cancellation-credit.ts` and `proration.ts` take `lockCustomerBalances` and then
  // call these functions": true of the former (it does, twice), FALSE of this file. The
  // race left open was a CHANGE (no locks) against a concurrent MANUAL credit note (invoice
  // lock only) — no lock in common, so nothing serialised them. `changeSubscription`'s
  // optimistic lock does not close it: that serialises changes to the SUBSCRIPTION, not
  // credits against the INVOICE.
  //
  // ORDER IS THE DOCUMENTED ONE, and it is the order `cancellation-credit.ts` already runs
  // in production: customer, then invoice. Verified before adding it — no path anywhere
  // takes the invoice lock and then a customer lock (the credit-note issue functions take
  // only the invoice one; `voidCreditNote` / `refundCreditNote` / the promotional-credit
  // mutators take only the customer one), so there is no cycle to deadlock on. Advisory
  // locks are re-entrant within a transaction, so a caller already holding either is
  // unaffected, and both are released at commit or rollback.
  //
  // THE CUSTOMER LOCK ALSO MAKES THE MULTI-INVOICE LOOP SAFE. `creditAcrossInvoices` calls
  // this once per invoice, so two concurrent changes would otherwise acquire a SEQUENCE of
  // invoice locks; they take them in the same order (`live` sorted by `createdAt`), but the
  // customer lock removes the question by serialising the two changes outright.
  //
  // ⚠ REQUIRES THE CALLER'S TRANSACTION to be worth anything — an advisory *xact* lock taken
  // in a transaction of its own is released immediately. Every call site passes one
  // (`changeSubscription`'s apply phase opens it at `withTenant` above; `items.ts` the same),
  // which the atomicity contract already required: "the item change and any credit note it
  // owes commit together". If a future caller passes `null`, it loses this protection
  // silently — pass the transaction.
  await withTenantTx(organizationId, input.tx, async (t) => {
    const { lockCustomerBalances } = await import("@/modules/customers/balances-read");
    const { lockInvoiceCredit } = await import("@/modules/credit-notes/service");
    await lockCustomerBalances(t, inv.customerId);
    await lockInvoiceCredit(t, inv.publicId);
  });

  // Audit M2 (tax on credited time): the per-item credit amounts are the PRE-TAX
  // prorated base of the old plan. The proportional tax on the credited time is
  // reversed too, so the credit-note total must be tax-INCLUSIVE (base + the
  // GST/VAT that was originally charged on that base). Gross up by the tax that was
  // actually booked on the source invoice's ledger (drift-proof — same basis the
  // credit-note ledger split in credit-notes/service.ts uses), NOT by re-deriving a
  // rate. Untaxed invoices book zero tax_payable → the
  // gross-up is a no-op and those credit totals stay byte-identical.
  //
  // We compute the reversal from the invoice's PRE-TAX base so it round-trips through
  // the adjustment-CN split: taxItem = round(base × bookedTax / (invoiceTotal −
  // bookedTax)); then issueAdjustmentCreditNote's invoice-rule taxShare = round(grossTotal ×
  // bookedTax / invoiceTotal) recovers exactly taxItem and leaves net = base, so the
  // ledger books net→credit_adjustments + taxItem→tax_payable (no double reversal).
  const booked = await withTenantTx(organizationId, input.tx, async (tx) => {
    const entries = await tx
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.businessId, businessId),
          eq(ledgerEntries.sourceType, "invoice"),
          eq(ledgerEntries.sourceId, inv.publicId),
        ),
      );
    const signed = (account: string, positive: "debit" | "credit") =>
      entries
        .filter((e) => e.account === account)
        .reduce((s, e) => s + (e.direction === positive ? e.amountMinor : -e.amountMinor), 0n);
    // tax_payable is a liability (credit-positive); discounts is contra-revenue
    // (debit-positive) and covers coupon discount only — promotional credit is
    // booked as a credit APPLICATION, not a price reduction, so it stays out.
    return { tax: signed("tax_payable", "credit"), discount: signed("discounts", "debit") };
  });
  const bookedTax = booked.tax;
  const netBase = inv.totalMinor - bookedTax;
  // Work on a LOCAL copy — never mutate the caller-owned input.items array.
  let creditItems = [...input.items];

  // A DISCOUNTED term must be credited at what the customer actually paid, not at
  // list. The per-item amounts arrive as a fraction of the LIST price, but a coupon
  // means the invoice only ever collected `netBase` of a `netBase + discount` list
  // base — so an unscaled credit exceeds the cash collected and the refundable-CN
  // guard rejects the whole change ("Refundable credit N exceeds refundable paid
  // amount M"), making ANY upgrade/downgrade of a coupon-bearing subscription fail.
  // This closes the coupon case only. `netBase` is the invoice's FACE value, while
  // the guard caps at cash actually collected, so a term paid partly with
  // promotional credit, reduced by TDS withholding, or already partly refunded can
  // still exceed it. Clamping to cash would under-credit (credit funded by a promo
  // balance should return AS promo balance) — the real answer is a split credit,
  // tracked with the D1 balance work.
  // The DISCOUNTED figure is credited: on a 12900 plan with a 10% forever coupon
  // (paid 11610), a same-day upgrade credits exactly 11610.
  // Scaled off the invoice's OWN booked discount for the same reason the tax
  // reversal below reads the ledger — no re-deriving a coupon rate that may have
  // been stacked, capped, or partly consumed. Undiscounted invoices book zero, so
  // the ratio is 1 and every existing fixture stays byte-identical.
  const listBase = netBase + booked.discount;
  if (booked.discount > 0n && netBase > 0n && listBase > 0n) {
    creditItems = rescaleCreditItems(creditItems, netBase, listBase);
  }

  // ── AND BY WHAT WAS REFUNDED (2026-08-28) ─────────────────────────────────────────
  // A customer refunded part of an invoice cannot then be credited the whole of it. The
  // note above already names this as the gap the coupon scaling did NOT close ("a term
  // paid partly with promotional credit, reduced by TDS withholding, or already partly
  // refunded can still exceed it").
  //
  // So the later credit scales by the proportion of the invoice still held. Measured
  // on invoice 34700 (plan 29700 + add-on 5000), 500 refunded, then a mid-term upgrade:
  //
  //     29700 x (34700 - 500) / 34700  =  29272   ← correct
  //                                       29700   ← us, before this
  //
  // Ours over-credited by the refunded proportion: money handed back at the gateway was
  // handed back a second time as credit. Composes with the discount rescale above rather
  // than replacing it — the two denominators are independent (list-vs-collected, then
  // collected-vs-still-held), so a discounted AND partly refunded term scales by both.
  // An invoice with no refunds scales by 1 and every existing fixture stays identical.
  const { refundedMinor } = await withTenantTx(organizationId, input.tx, async (t) => {
    const { refundableCapacityForInvoice } = await import("@/modules/credit-notes/service");
    return refundableCapacityForInvoice(t, inv.id);
  });
  if (refundedMinor > 0n && inv.totalMinor > refundedMinor) {
    creditItems = rescaleCreditItems(creditItems, inv.totalMinor - refundedMinor, inv.totalMinor);
  }
  const discountedTotal = creditItems.reduce((s, i) => s + i.amountMinor, 0n);

  // Which line is the tax reversal, and how much of it — remembered rather than
  // re-derived, because the cashable rescale below must treat it differently from the
  // supply lines it sits beside (see the note there). -1 when the invoice booked no tax.
  //
  // ── WHICH BASE THE REVERSAL IS PROPORTIONAL TO DEPENDS ON WHERE THE CREDIT LANDS ──
  // (D-cn-cap, 2026-08-25.) On a PAID invoice the credit is a reversal of the whole
  // gross and the bucket-funded slices go back to their buckets below, so the promo
  // slice is credited too — at its own (untaxed) value — and the note's tax must be the
  // BLENDED share `bookedTax / netBase`. On an OPEN invoice the note is an ADJUSTMENT:
  // it reduces amount DUE and hands nothing back to the promotional bucket, so the promo
  // goes on funding the supply the customer KEEPS and every unit credited comes off the
  // taxed slice. There the reversal is the STATUTORY rate `bookedTax / (netBase − promo)`
  // on the base actually released — 18% on the probe's invoice, where the blended figure
  // is 11.5525% and leaves 92903 of tax standing on cancelled time
  // (`scripts/probe-adjust-unpaid-promo-tax.ts`).
  //
  // Either way this round-trips with the credit-note ledger split by construction,
  // because the pair of denominators composes: writing (base, tax, base + tax) for
  // whichever basis applies, `taxItem = c × tax/base` makes `total = c × (base+tax)/base`
  // and the note's `total × tax/(base+tax)` recovers exactly `taxItem`, leaving
  // `net = c`. Open notes now use (netBase − promo, bookedTax, taxedGross) against
  // `issueAdjustmentCreditNote`'s taxed-gross denominator; paid ones keep
  // (netBase, bookedTax, invoiceTotal) against the funding split below. Move one and the
  // other must move with it.
  //
  // This holds only on the note's INVOICE rule, so every note written here passes
  // `taxAtInvoiceRate`: our linked items are pre-tax, and the line rule would read them
  // as tax-inclusive. Two known limits: the tax item uses the invoice's average rate, so
  // on a mixed-rate invoice it is not each line's own tax; and a note that brings the
  // invoice to fully credited reverses all remaining tax, which can differ from the tax
  // item by the rounding earlier notes left (2026-10-24).
  //
  // With no promotional credit applied the two bases are the SAME number, so every
  // existing fixture books byte-identically.
  const promoApplied = inv.promotionalCreditsAppliedMinor ?? 0n;
  const taxedBase = netBase - promoApplied;
  const creditsAmountDue = isOpenInvoiceStatus(inv.status) && promoApplied > 0n && taxedBase > 0n;
  const taxBasis = creditsAmountDue ? taxedBase : netBase;
  let taxItemMinor = 0n;
  let taxLineIndex = -1;
  if (bookedTax > 0n && taxBasis > 0n) {
    // No more taxable base can be released than the invoice ever had — a credit larger
    // than the taxed slice is one that must also free promotional credit, which the
    // adjustment path cannot do (it overflows into the excess branch instead).
    const releasedBase =
      creditsAmountDue && discountedTotal > taxBasis ? taxBasis : discountedTotal;
    // round half up, integer minor units (mirrors the credit-notes taxShare rounding)
    const taxItem = (releasedBase * bookedTax + taxBasis / 2n) / taxBasis;
    if (taxItem > 0n) {
      taxItemMinor = taxItem;
      taxLineIndex = creditItems.length;
      creditItems.push({ description: "Tax reversal on credited time", amountMinor: taxItem });
    }
  }
  let total2 = creditItems.reduce((s, i) => s + i.amountMinor, 0n);
  /**
   * SETTLE THE REMAINDER — see `grossTarget`. Only when a clamp actually bound, only
   * upwards, and only onto an existing tax line: with no booked tax the gross IS the base,
   * the map has no rounding steps to skip, and a shortfall would mean something else is
   * wrong rather than a quantisation gap — so it is left alone and stays visible.
   */
  if (grossTarget !== null && taxLineIndex >= 0 && total2 < grossTarget) {
    const residual = grossTarget - total2;
    taxItemMinor += residual;
    creditItems[taxLineIndex]!.amountMinor += residual;
    total2 = grossTarget;
  }

  const reasonCode = input.reasonCode ?? "subscription_change";
  const reason = input.reason ?? "Prorated credit for reduced items";
  const itemsNum = creditItems.map((i) => ({
    description: i.description,
    amountMinor: Number(i.amountMinor),
    // The CREDITED window, not the billed one — `issueCurrentTermCredit.creditedPeriod`
    // carries it. Undefined when the caller has no window to give, which
    // leaves the source line's period to fill in as it did before.
    periodStart: creditedPeriod?.start ?? undefined,
    periodEnd: creditedPeriod?.end ?? undefined,
    // Undefined on the tax-reversal line, and on any caller that had no source line to
    // name. `resolveCreditedLines` scopes the lookup to THIS invoice, which is sound
    // because every part is built from its own invoice's lines.
    invoiceLineItemPublicId: i.invoiceLineItemPublicId ?? null,
  }));
  const { issueAdjustmentCreditNote, createRefundableCreditNote, refundableCapacityForInvoice } =
    await import("@/modules/credit-notes/service");
  const { invoiceOutstanding } = await import("@/modules/invoicing/service");
  const tx = input.tx ?? null;

  if (isOpenInvoiceStatus(inv.status)) {
    // Unpaid term → adjustment CN reduces what's still owed; any excess (already
    // paid) becomes a refundable CN.
    // WHAT IS STILL OWED, not what the column says. The column is the issue-time
    // collectible net of CREDITS only (`invoiceOutstanding` owns that rule), so on a
    // part-paid invoice it overstates the debt by exactly the cash collected. Splitting on
    // it pushed that cash into the ADJUSTMENT bucket — relieving a debt that was not there
    // and quietly keeping money the customer had already handed over. Past the debt the
    // credit IS cash, and the `excess` branch below already returns cash as a refundable
    // note; only the boundary was wrong.
    const due = (await withTenantTx(organizationId, tx, (t) => invoiceOutstanding(t, inv)))
      .remainingMinor;
    if (total2 <= due) {
      return [
        await issueAdjustmentCreditNote({
          organizationId,
          businessId,
          invoicePublicId: inv.publicId,
          items: itemsNum,
          reasonCode,
          reason,
          tx,
          taxAtInvoiceRate: true,
        }),
      ];
    }
    // ── WHERE THIS CREDIT GOES ────────────────────────────────────────────────────
    // The arithmetic — the promo slice's non-pro-rata rate, the cap-before-split, and why
    // each funding source gets its own money back — is `credit-routing.ts`, together with
    // the measurements behind every step. It lives there because it is PURE: `estimate.ts`
    // calls the same function, so the checkout preview and this booking agree by
    // construction instead of by two derivations being kept in step by hand. That is the
    // defect this split has produced twice now (the preview promising ₹17,010.12 of balance
    // credit a change cannot deliver; `freedExcess` restoring 2400265 against 2000000 ever
    // drawn), and both were arithmetic a unit test can hold.
    //
    // The one input that cannot move into a pure function: cash STILL RETAINED on this
    // invoice, from the function that owns that rule. `refundableCapacityForInvoice`
    // subtracts refunds and prior notes, so a slice already handed back is not handed back
    // twice. Read on `total2 > due` — marginally wider than the old `overflowRest > 0n`
    // gate (it also reads when promotional credit absorbs the whole overflow), which costs
    // one query in that narrow case and cannot change the answer, since the routing then
    // caps the cashable leg at zero regardless.
    const cashAvailable =
      total2 > due
        ? (await withTenantTx(organizationId, tx, (t) => refundableCapacityForInvoice(t, inv.id)))
            .available
        : 0n;
    const routed = planOpenInvoiceCreditRouting({
      creditMinor: total2,
      outstandingMinor: due,
      discountedTotalMinor: discountedTotal,
      taxedBaseMinor: taxedBase,
      promoAppliedMinor: promoApplied,
      excessAppliedMinor: inv.excessPaymentsAppliedMinor ?? 0n,
      refundableAppliedMinor: inv.refundableCreditsAppliedMinor ?? 0n,
      cashAvailableMinor: cashAvailable,
    });
    const freedPromo = routed.freedPromoMinor;
    const freedExcess = routed.freedExcessMinor;
    const cashPortion = routed.cashableMinor;
    // ── WHAT THIS CALL SITE STILL OWNS (booking, not arithmetic) ──────────────────
    // `createRefundableCreditNote` below, NOT `issueRefundableCreditNote`: that entry
    // point guards on `paidMinor <= 0` ("Refundable credit notes require a paid invoice")
    // BEFORE its cap, and an invoice part-settled from the customer's own refundable
    // balance with a FAILED cash leg has a cashable slice while `paidMinor` is 0 — which is
    // how a real subscription change 500'd on 2026-08-31 (INV-4705: total 9161992,
    // refundable applied 6952179, one failed payment, 2209813 due, 6656631 overflowing).
    // Bypassing it is safe because both of its remaining jobs are done: the routing has
    // capped the cashable leg at `refundableApplied + cashAvailable` (the cancellation cap),
    // and `issueCurrentTermCredit`'s `live` filter has already excluded voided, credited and
    // pending invoices.
    //
    // ⚠ NOT covered, and pre-existing: that entry point's FOURTH job, `lockInvoiceCredit`.
    // `proration.ts` takes NEITHER that lock nor `lockCustomerBalances`, so the read-then-act
    // above runs unserialised against a concurrent manual credit note on the same invoice —
    // and the lock-order docblock (`credit-notes/service.ts:238`) claims this file takes the
    // customer lock, which is false. `changeSubscription`'s optimistic lock does not close
    // it: that serialises changes to the SUBSCRIPTION, not credits against the INVOICE.
    // Filed in docs/PROGRESS.md with the fix (customer-then-invoice, the order
    // `cancellation-credit.ts` already runs in production).
    if (freedPromo > 0n || freedExcess > 0n) {
      const { restoreBucketFundedSlices } = await import("./cancellation-credit");
      await withTenantTx(organizationId, tx, (t) =>
        restoreBucketFundedSlices(t, {
          organizationId,
          businessId,
          customerId: inv.customerId,
          currency: inv.currency,
          invoicePublicId: inv.publicId,
          promotional: freedPromo,
          excess: freedExcess,
          // NOT cancellation's marker — see the paid branch below for why.
          sourceType: "change_credit_restore",
          reasonCode,
        }),
      );
    }
    const adj =
      due > 0n
        ? await issueAdjustmentCreditNote({
            organizationId,
            businessId,
            invoicePublicId: inv.publicId,
            items: [{ description: `${reason} (adjustment)`, amountMinor: Number(due) }],
            // Same identity the paid branch's note satisfies (`total = sub_total −
            // discounts + tax`): the gross this note documents is the debt it relieves
            // PLUS every slice handed back to a bucket, each named as its own discount
            // row. Left undefined when nothing was returned, which keeps the column NULL
            // ("gross not recorded; it equals total_minor") on every existing shape.
            subtotalMinor:
              freedPromo + freedExcess > 0n ? due + freedPromo + freedExcess : undefined,
            discounts:
              freedPromo + freedExcess > 0n
                ? [
                    ...(freedPromo > 0n
                      ? [
                          {
                            type: "promotional_credits" as const,
                            amountMinor: freedPromo,
                            description: "Promotional Credits Returned",
                          },
                        ]
                      : []),
                    ...(freedExcess > 0n
                      ? [
                          {
                            type: "excess_payments" as const,
                            amountMinor: freedExcess,
                            description: "Excess Payments Returned",
                          },
                        ]
                      : []),
                  ]
                : undefined,
            reasonCode,
            reason,
            tx,
          })
        : null;
    // Nothing cashable left over → the adjustment plus the bucket restore IS the whole
    // credit. Calling the refundable path with zero would throw ("must be positive").
    if (cashPortion <= 0n) return adj ? [adj] : [];
    const refundable = await withTenantTx(organizationId, tx, (t) =>
      createRefundableCreditNote(t, {
        organizationId,
        businessId,
        customerId: inv.customerId,
        invoiceId: inv.id,
        invoicePublicId: inv.publicId,
        currency: inv.currency,
        items: [{ description: `${reason} (paid portion)`, amountMinor: Number(cashPortion) }],
        reasonCode,
        reason,
      }),
    );
    // BOTH, in the order they were written. `adj ?? refundable` was here, and the
    // refundable note it dropped is D3 — see the note on this function's signature.
    return adj ? [adj, refundable] : [refundable];
  }
  // ── PAID TERM → SPLIT BY HOW THE INVOICE WAS ACTUALLY FUNDED ─────────────────
  // This used to issue a refundable CN for the WHOLE credit regardless of funding, which
  // meant an invoice settled with the customer's own credit hit the cash-only cap in
  // `issueRefundableCreditNote` and threw — refusing the ENTIRE subscription change with
  // "Refundable credit N exceeds refundable paid amount 0".
  //
  // The change must still apply. An invoice funded entirely by promotional credit and
  // changed mid-term issues a `refundable` note with sub_total ₹41,899.00 / total ₹0.00,
  // returning ₹41,899.00 to the PROMOTIONAL balance. So: never refuse for want of cash,
  // return bucket-funded slices to their own
  // buckets (promotional must never become cashable), and let only the cash + recycled
  // refundable slice be a cashable refundable CN.
  //
  // Same split as `cancellation-credit.ts`, which is why it lives there and is imported
  // here rather than written twice — the two paths owe the customer the same money.
  const { splitCreditByFunding, restoreBucketFundedSlices } = await import("./cancellation-credit");
  // `refundableCapacityForInvoice` is destructured once at the top of the function — the
  // open branch above needs the same read, and two `const`s of one name in one scope is a
  // redeclaration.
  // Cash STILL RETAINED, from the function that owns the rule. A raw payments sum here was
  // the twin of the cancellation-path defect: refund 1000.00 in full, then a same-cadence
  // downgrade on day 16 of 31 still minted a 412.90 cashable note and left the capacity
  // function reporting AVAILABLE -412.90.
  //
  // This does not fight the allocation taken upstream — it agrees with it for the first
  // time. `creditAcrossInvoices` and `termInvoiceCanAbsorb` already pre-select invoices on
  // `available`; only this split was still permitting the larger `paid`, so the promise made
  // when the invoice was chosen and the cap applied when it was credited disagreed.
  const capForSplit = await withTenantTx(organizationId, tx, (t) =>
    refundableCapacityForInvoice(t, inv.id),
  );
  const cashAvailable = capForSplit.available;
  // What this invoice has already given back to the promotional bucket. Every restore
  // path posts through `restoreBucketFundedSlices`, which stamps the INVOICE's public id
  // as `sourceId` whatever the caller's `sourceType` — so one read covers the cash
  // refund's proportional restore and any earlier credit alike.
  const { promoRestoredForInvoice } = await import("./cancellation-credit");
  const promoAlreadyRestoredMinor = await withTenantTx(organizationId, tx, (t) =>
    promoRestoredForInvoice(t, businessId, inv.publicId),
  );
  // BASE NET OF REFUNDS, to match the numerator. `total2` has already been scaled down by
  // cash handed back (see the refund rescale above), so measuring it against the invoice's
  // FULL total reduces the promotional share by the refund a second time — the same
  // mismatched-denominator mistake `termInvoiceCanAbsorb` made, one function along.
  //
  // Measured: promo pool 1000000, a 500 refund that already returned 236. Against the
  // full base the change restored 999603 (total returned 999839, short of the 1000000
  // consumed); against the refund-net base it restores 999764, so 236 + 999764 = exactly
  // the 1000000 that was consumed, and the balance lands on 88200 after the new invoice
  // draws 911800.
  const baseForSplit =
    inv.totalMinor > capForSplit.refundedMinor
      ? inv.totalMinor - capForSplit.refundedMinor
      : inv.totalMinor;
  const { grantDrawnOutstanding, restoreGrantDraws } = await import("@/modules/credits/service");
  const split = splitCreditByFunding({
    creditMinor: total2,
    baseMinor: baseForSplit,
    invoice: inv,
    cashAvailable,
    promoAlreadyRestoredMinor,
    grantOutstandingMinor: await withTenantTx(organizationId, tx, (t) =>
      grantDrawnOutstanding(t, businessId, inv.id),
    ),
  });
  // Credit grants the invoice drew go back to the grants (G3), capped at what is still drawn.
  const grantReturned =
    split.grants > 0n
      ? await withTenantTx(organizationId, tx, (t) =>
          restoreGrantDraws(t, {
            organizationId,
            businessId,
            customerId: inv.customerId,
            invoiceId: inv.id,
            invoicePublicId: inv.publicId,
            faceMinor: split.grants,
            ledger: true,
            sourceType: "change_credit_restore",
          }),
        )
      : 0n;

  if (split.promotional > 0n || split.excess > 0n) {
    await withTenantTx(organizationId, tx, (t) =>
      restoreBucketFundedSlices(t, {
        organizationId,
        businessId,
        customerId: inv.customerId,
        currency: inv.currency,
        invoicePublicId: inv.publicId,
        promotional: split.promotional,
        excess: split.excess,
        // NOT cancellation's marker: a subscription can be changed many times in one
        // term, and that marker is read as a one-per-invoice idempotency guard.
        sourceType: "change_credit_restore",
        reasonCode,
      }),
    );
  }
  // ── WHAT THE NOTE SAYS ABOUT ITS OWN GROSS (0186 populate, 2026-08-25) ───────────
  // The identity is `total = sub_total − discounts + tax`. CN-190: 2162529 − 973140 +
  // 214090 = 1403479. CN-188 (an invoice funded entirely by promotional credit):
  // sub_total 4189900, one `promotional_credits` discount of 4189900, total 0 — a note
  // where we used to write nothing at all.
  //
  // `subtotal_minor` is therefore the DELIVERED gross, pre-tax: the cashable slice plus
  // everything handed back to a bucket, less the tax line the note carries. Whenever the
  // funding cap in `splitCreditByFunding` does not bind, that is exactly `discountedTotal`
  // — the pre-tax gross credit computed above — because `promotional + excess +
  // refundable = total2 = discountedTotal + taxItemMinor`. Writing it this way rather
  // than writing `discountedTotal` directly keeps the identity EXACT in the one case
  // where it otherwise would not hold: a term invoice part-funded by TDS withholding,
  // where the cap clamps `refundable` below its pro-rata share and the withheld residual
  // is credited to nobody. The note then reports the gross it actually delivered instead
  // of claiming a reversal that never reached the customer.
  const bucketReturned = split.promotional + split.excess + grantReturned;
  // Nothing cashable AND nothing returned to a bucket → nothing happened; no document.
  // (Reachable only when the invoice was settled by neither cash nor credit — e.g. fully
  // withheld or written off — so there is genuinely nothing to reverse.)
  if (split.refundable <= 0n && bucketReturned <= 0n) return [];

  // Scale the caller's line items down to the cashable slice so the note's lines still
  // sum to its total — LARGEST REMAINDER, not per-item truncation. Truncating each item
  // independently silently loses the fractions: measured 2026-08-24, a 3114324 credit
  // split 1000000 promotional / 2114324 cashable rescaled its two items to 1895361 +
  // 218962 = 2114323, so the customer got one minor unit less than the split said they
  // were owed and the note's lines no longer summed to the cashable slice. Same
  // technique the discount scaling above and the per-invoice split in
  // `issueCurrentTermCredit` already use, for the same reason.
  //
  // ── THE TAX LINE IS NOT PRO-RATED WITH THE SUPPLY LINES (2026-08-24) ──────────
  // Promotional credit is applied PRE-tax (db/schema/invoices.ts), so the promo-funded
  // slice of the term never bore any tax: ALL of the credited tax belongs to the
  // cashable slice. Rescaling the tax line alongside the supply lines spreads it across
  // a slice that was never taxed, and the document then disagrees with its own ledger —
  // `createRefundableCreditNote` reverses `total × bookedTax / (invoiceTotal −
  // promotionalApplied)`, i.e. the WHOLE of it. Measured on the promo scenario
  // (scripts/probe-change-promo-tax-retention.ts): note total 2114324 with the ledger
  // reversing all 322524 of IGST, while the pro-rated item said 218963 — 103561
  // misattributed from tax to time on a document that is otherwise correct. The credited
  // tax lands entirely on the refundable side and the promotional share receives none.
  //
  // So the tax line is carried over WHOLE and only the supply lines are rescaled, to
  // `refundable − tax`. The two layers then agree by construction, because the amounts
  // are the same expression: with `taxedGross = invoiceTotal − promo` the funding split
  // gives `refundable = total2 × taxedGross / invoiceTotal` and `total2 = discountedTotal
  // × invoiceTotal / netBase`, so the ledger's `refundable × bookedTax / taxedGross`
  // reduces to `discountedTotal × bookedTax / netBase` — this line's `taxItemMinor`.
  // The clamp is for the one case that can still bind: the ledger's own `remainingTax`
  // cap, when an earlier note on this invoice already reversed part of the tax.
  //
  // Hoisted out of the rescale: how much TAX the note itself carries. `subtotal_minor`
  // is defined net of it (tax is added back after the discounts), so the two must be the
  // same number, and re-deriving it a second time is how they would drift apart.
  const taxOnNote =
    taxLineIndex < 0
      ? 0n
      : split.refundable === total2
        ? taxItemMinor
        : taxItemMinor < split.refundable
          ? taxItemMinor
          : split.refundable;
  const cashableItems =
    split.refundable === total2
      ? itemsNum
      : (() => {
          const taxPart = taxOnNote;
          const supplyTarget = split.refundable - taxPart;
          const supplyIdx = itemsNum.map((_, k) => k).filter((k) => k !== taxLineIndex);
          const supplyTotal = supplyIdx.reduce((s, k) => s + BigInt(itemsNum[k]!.amountMinor), 0n);
          const out = itemsNum.map((i) => ({ ...i, amountMinor: 0 }));
          if (taxLineIndex >= 0) out[taxLineIndex]!.amountMinor = Number(taxPart);
          if (supplyTarget > 0n && supplyTotal > 0n) {
            const floors = supplyIdx.map(
              (k) => (BigInt(itemsNum[k]!.amountMinor) * supplyTarget) / supplyTotal,
            );
            let leftover = supplyTarget - floors.reduce((s, f) => s + f, 0n);
            const order = supplyIdx
              .map((k, j) => ({
                j,
                rem: BigInt(itemsNum[k]!.amountMinor) * supplyTarget - floors[j]! * supplyTotal,
              }))
              .sort((a, b) => (a.rem === b.rem ? a.j - b.j : a.rem > b.rem ? -1 : 1));
            for (const o of order) {
              if (leftover <= 0n) break;
              floors[o.j] = floors[o.j]! + 1n;
              leftover -= 1n;
            }
            supplyIdx.forEach((k, j) => {
              out[k]!.amountMinor = Number(floors[j]!);
            });
          }
          return out.filter((i) => i.amountMinor > 0);
        })();
  // NO `return null` when there is no cashable line left: that is precisely the
  // zero-total note, and it is now representable (gross in `subtotal_minor`, the
  // returned slices as `credit_note_discounts`). The note's ITEMS stay the cashable
  // lines, so a fully bucket-funded reversal has none.

  // `createRefundableCreditNote`, NOT `issueRefundableCreditNote` — the same call
  // `cancellation-credit.ts` makes, and for the same reason.
  //
  // `issueRefundableCreditNote` guards on `paidMinor <= 0` ("Refundable credit notes
  // require a paid invoice") BEFORE it reaches its cap. An invoice settled entirely from
  // the customer's own REFUNDABLE balance has zero cash, so `split.refundable` is > 0
  // (the recycled slice) while `paidMinor` is 0, and the guard threw — refusing the whole
  // subscription change. Measured: with ₹350.07 of cash topped up the change must apply;
  // we refused it. That is the ad8c149 failure one guard
  // earlier: that commit routed the promo/excess slices to their buckets but left the
  // recycled REFUNDABLE slice going through the cash-gated entry point.
  //
  // Bypassing the guard is safe here because BOTH of its jobs are already done:
  //  - the cap: `splitCreditByFunding` has already clamped this to
  //    `cashPaid + refundableApplied`, which is exactly the cancellation cap.
  //  - the status check: `issueCurrentTermCredit` filters `live` to exclude voided /
  //    credited / pending invoices, and this is the non-open branch, so the invoice is
  //    paid or partially paid by construction.
  //
  // The discount rows are DOCUMENTARY ONLY — `restoreBucketFundedSlices` above has
  // already posted the promotional/excess movement to the ledger, and
  // `createRefundableCreditNote` posts nothing for them. Writing them is what lets the
  // document say where the gross went; it is not a second credit.
  const bucketDiscounts: CreditNoteDiscountInput[] = [];
  if (split.promotional > 0n)
    bucketDiscounts.push({
      type: "promotional_credits",
      amountMinor: split.promotional,
      description: "Promotional Credits Returned",
    });
  if (split.excess > 0n)
    bucketDiscounts.push({
      type: "excess_payments",
      amountMinor: split.excess,
      description: "Excess Payments Returned",
    });
  if (grantReturned > 0n)
    bucketDiscounts.push({
      type: "credit_grants",
      amountMinor: grantReturned,
      description: "Credit Grants Returned",
    });
  return [
    await withTenantTx(organizationId, tx, (t) =>
      createRefundableCreditNote(t, {
        organizationId,
        businessId,
        customerId: inv.customerId,
        invoiceId: inv.id,
        invoicePublicId: inv.publicId,
        currency: inv.currency,
        items: cashableItems,
        // Credit grants returned: print the lines as credited, when they add up to the
        // gross this note documents; the discount rows take the returned parts off.
        ...(grantReturned > 0n &&
        itemsNum.reduce((s, i) => s + BigInt(i.amountMinor), 0n) ===
          cashableItems.reduce((s, i) => s + BigInt(i.amountMinor), 0n) + bucketReturned
          ? { documentItems: itemsNum }
          : {}),
        reasonCode,
        reason,
        taxAtInvoiceRate: true,
        // Off the LINES THE NOTE WILL CARRY, not off `split.refundable` — the note's
        // `total_minor` is Σ items, so deriving the subtotal from anything else is how the
        // identity would silently stop holding for a shape the rescale rounds differently.
        subtotalMinor:
          cashableItems.reduce((s, i) => s + BigInt(i.amountMinor), 0n) +
          bucketReturned -
          taxOnNote,
        discounts: bucketDiscounts,
      }),
    ),
  ];
}

/**
 * A credit note the engine REFUSED to issue is a validatable condition — today
 * only the refundable cap ("Refundable credit N exceeds refundable paid amount M",
 * the residual hole documented in `issueCurrentTermCredit` and tracked as D1) —
 * not an internal fault. Re-raised inside this module's taxonomy so the `/change`
 * route answers **400 with the reason** instead of the bare 500 it used to, which
 * invited a retry of a change that can never succeed. Everything else propagates
 * untouched. `CreditNoteError` is imported dynamically for the same reason the
 * credit-note service itself is — proration.ts must not statically depend on it.
 */
// Exported because `removeSubscriptionItem` (items.ts) owes the same credit through
// the same helper and therefore has the same refusal to translate — ONE converter, so
// `/change`, `DELETE …/items/:id`, the scheduled-change applier and the dashboard all
// report a refused credit identically. `actionPrefix` lets each caller phrase the
// leading clause for what it actually attempted (a plan/quantity CHANGE vs an item
// REMOVAL) without forking the converter — only the prefix varies; the reason,
// error class and status mapping stay identical for every caller.
export async function rethrowCreditNoteErrorAsProration(
  e: unknown,
  actionPrefix = "We cannot apply this change",
): Promise<never> {
  const { CreditNoteError } = await import("@/modules/credit-notes/service");
  if (e instanceof CreditNoteError) {
    throw new ProrationError(
      `${actionPrefix}. We could not issue the prorated credit that it owes: ${e.message}`,
    );
  }
  throw e;
}

/**
 * Apply a whole COMPOSITION EDIT — item changes, adds and removes — in one call, and
 * settle its proration immediately. The three lists are applied in ONE transaction and
 * every line they produce folds into ONE invoice (or ONE credit note) — what a single
 * `update_for_items` does and what four sequential requests could not: see the read
 * phase's ADDS/REMOVES note for the five-document edit that
 * motivated it, and `estimateChange` for the preview that must agree with it.
 *
 *  - credit the unused portion of the old price (time-remaining),
 *  - charge the prorated new price for the time remaining,
 *  - net > 0 (upgrade/add seats) → invoice + charge now,
 *  - net < 0 (downgrade) → credit the customer balance (applied to future invoices),
 *  - net = 0 → no invoice.
 * Returns the proration invoice (or null if nothing to settle).
 *
 * ATOMICITY: the item change and any credit note it owes commit together (one
 * transaction, see the apply phase). Either the change lands WITH its credit, or
 * neither does and the caller gets a `ProrationError` — there is deliberately no
 * outcome where a downgrade is applied and the credit is missing. The CHARGE side
 * (proration invoice + collection) is necessarily outside that transaction, since
 * it talks to a payment gateway.
 */
/**
 * Where a charge lands when the caller does not say: invoiced now, or retained as an
 * unbilled charge. Resolves `unbilled_charges_config[event]` (0242), which INHERITS
 * `businesses.default_invoice_immediately` for both events that reach here.
 *
 * Its own settings row claims to govern exactly this operation, so it is read here
 * rather than defaulted in code. `changeTermEnd` (`service.ts`) and `addSubscriptionItem`
 * (`items.ts`) resolve the same column the same way — which is what makes a composition
 * edit applied as up to three calls (`/change`, `POST …/items`, `DELETE …/items/:id`)
 * land on ONE answer instead of three. The `?? false` tail is only for a business row
 * that cannot be read, and matches the column's own NOT NULL DEFAULT false rather than
 * inventing a different answer for a missing row.
 */
export async function defaultInvoiceImmediately(
  organizationId: string,
  businessId: string,
  /**
   * Which lifecycle event is asking (0242). `unbilled_charges_config` answers per event;
   * both events wired here INHERIT `default_invoice_immediately` when their key is unset,
   * so an unconfigured business resolves exactly the column it always did.
   */
  event: "onChange" | "onOneTimeCharge" = "onChange",
): Promise<boolean> {
  const [biz] = await withTenant(organizationId, (tx) =>
    tx
      // The alias MUST match the resolver's field name. It read `defaultInvoiceImmediately`
      // while this said `invoiceImmediately`, and because every field on the resolver's
      // parameter is optional `unknown`, the compiler accepted it: the inheritance then
      // always fell through to `add_to_unbilled`, so a business with the flag ON began
      // DEFERRING charges it used to invoice. verify:proration caught it; the unit tests
      // could not, because they hand the resolver an object and never exercise this read.
      .select({
        defaultInvoiceImmediately: businesses.defaultInvoiceImmediately,
        unbilledChargesConfig: businesses.unbilledChargesConfig,
      })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1),
  );
  // A row we cannot read keeps the column's own NOT NULL DEFAULT false rather than
  // inventing a different answer — unchanged from before this event split.
  if (!biz) return false;
  return resolveUnbilledChargesConfig(biz)[event] === "invoice_immediately";
}

/**
 * Apply a change, then send its credit where `downgrade_credit` says. `creditHandling` is
 * the customer's choice, read only when the rule is `customer_chooses`; `downgradeCredit`
 * is the operator's choice for this call and replaces the rule.
 */
export async function changeSubscription(
  input: Parameters<typeof applyChange>[0] & {
    creditHandling?: "credit_balance" | "refund";
    downgradeCredit?: "credit_balance" | "refund";
  },
): Promise<Awaited<ReturnType<typeof applyChange>> & { creditRefunds?: CreditRefundOutcome[] }> {
  const result = await applyChange(input);
  if (result.creditNotes.length === 0) return result;
  const { refundChangeCredit } = await import("./downgrade-credit");
  const creditRefunds = await refundChangeCredit({
    organizationId: input.organizationId,
    businessId: input.businessId,
    creditNotes: result.creditNotes,
    choice: input.creditHandling,
    ...(input.downgradeCredit ? { override: input.downgradeCredit } : {}),
  });
  return creditRefunds ? { ...result, creditRefunds } : result;
}

async function applyChange(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  now: Date;
  /** Items already on the subscription whose price/quantity/custom amount moves. */
  changes: ItemChange[];
  /**
   * Items to ATTACH by this same call — the `POST …/items` third of a composition edit.
   *
   * `changes`, `adds` and `removes` are applied in ONE transaction and every line they
   * produce folds into ONE invoice (or ONE credit note), which is the whole reason this
   * parameter exists. See the long note at the read phase's ADDS/REMOVES block for the
   * five-document edit that came of sending them as four requests.
   */
  adds?: ItemAdd[];
  /**
   * Public ids (`si_…`) of items to DETACH by this same call — the `DELETE …/items/:id`
   * third. Each credits its unused time, into the same document as everything else.
   */
  removes?: string[];
  /**
   * TERM RESET: instead of prorating just the changed items, credit the unused
   * time of EVERY current item and charge the FULL new-term price for every
   * post-change item, restarting the period from `now`.
   * Auto-triggered by default when any change swaps a price whose
   * interval/interval_count differs from the subscription's current cadence
   * (e.g. monthly → yearly) — `resetTerm: true` forces it even without a
   * frequency change (e.g. a same-cadence plan swap the merchant still wants
   * to treat as a fresh term).
   *
   * This is `force_term_reset`, and by default a SAME-CADENCE plan swap does NOT
   * reset. Measured 15 days into a 31-day term, $7 → $24 same cadence:
   *   default            → term unchanged, charge 1239 (prorated new), credit 361 (unused old)
   *   force_term_reset   → term restarts, charge 2400 (FULL new), credit 361
   * A DIFFERENT cadence always resets, `force_term_reset` or not.
   */
  resetTerm?: boolean;
  /**
   * `prorate` — whether prorated credits and charges are created for the change.
   * Default true.
   *
   * ONE rule covers both paths:
   * **`prorate: false` suppresses the PRORATED artefacts, nothing else.**
   *   · NON-RESET (same cadence): both sides of the movement are prorated, so
   *     nothing moves — the composition changes and no money is booked.
   *   · RESET (frequency change, or forced): the full new-term charge is NOT a
   *     prorated artefact, so it still happens; only the prorated unused-time
   *     CREDIT is suppressed.
   *
   * Measured, not inferred (same 15-day fixture):
   *   same cadence + prorate=false → no term reset, NO invoice, NO credit note
   *   freq change  + prorate=false → term resets, charge 6000 (full), NO credit note
   *
   * ⚠️ The old note in docs/PROGRESS.md — that suppressing proration on a reset
   * "restarts the term while charging and crediting nothing, a free term" — was
   * WRONG, and is why this sat unbuilt. The reset still charges.
   */
  prorate?: boolean;
  /**
   * `invoice_immediately` on the change screen's **Invoicing Options**: where the
   * proration CHARGE lands.
   *   · true  → raise the proration invoice now and collect it (what this function
   *             has always done, unconditionally).
   *   · false → book the same lines as `unbilled_charges` against the subscription;
   *             they fold into the next renewal invoice, where tax, coupons and the
   *             customer's credit balances are applied. No money moves now.
   *
   * OMITTED resolves `businesses.default_invoice_immediately` (2026-08-19 ruling),
   * the way `changeTermEnd` already did. Before that, omission always invoiced, and
   * the settings row advertising that column as *"Invoice plan-change charges
   * immediately"* governed nothing — a decorative control on a money-moving setting,
   * promising in its own help text that OFF meant charges accumulate as unbilled.
   *
   * The column ships FALSE, so this DID flip the default for a caller that omits the
   * field: what used to raise a proration invoice now books unbilled charges unless
   * the business turned the setting on. Callers that mean "invoice now" regardless of
   * the business preference must say so — every `verify:*` suite asserting on
   * `prorationInvoice` now pass `invoiceImmediately: true` explicitly.
   * That is the honest split: the suites test proration mechanics, not the settings
   * default, and the default has its own coverage in `verify:proration`.
   *
   * The dashboard always sends this explicitly, so no screen depends on the default —
   * though the change form still PRESELECTS "Immediately" rather than the business
   * preference, which is now a resolvable default it should preview instead. Filed.
   *
   * The CREDIT side is unaffected: a downgrade's credit note and a term reset's
   * unused-time credit note are issued immediately either way (the credit is money
   * already owed, not a charge being scheduled). On the deferred
   * branch the reset credit simply stays on the customer's balance until the renewal
   * draws it, instead of being drawn onto a proration invoice raised now.
   */
  invoiceImmediately?: boolean;
  /**
   * Free-form metadata to REPLACE as part of this same change.
   *
   * Here, rather than left to a second PATCH, because a caller whose edit moves items
   * AND a flag that depends on them needs both or neither. It is written by the
   * optimistic-lock claim below — the FIRST statement of the write transaction — so it
   * commits with the item operations and the proration document, and is rolled back with
   * them if anything downstream refuses.
   *
   * The motivating case is a destination switch: the items decide what the customer is
   * BILLED for and the metadata decides what they are SERVED. Apply one without the other
   * and they pay for gds while still getting gs.
   */
  metadata?: Record<string, unknown> | null;
  /** How this business's metadata key rules apply to `metadata`. Default `enforce`. */
  metadataRules?: MetadataRuleScope;
  /**
   * A coupon / manual discount to apply AS PART OF this change.
   *
   * ── WHY THIS IS NOT A SEPARATE CALL ──────────────────────────────────────────
   * The dashboard used to post `/change` and THEN `POST …/discount`, so the coupon
   * reached the subscription after the proration invoice had already been raised — and
   * that invoice was billed at list price. It must be discounted: a 10% coupon added on
   * the change screen turns a ₹752 proration into `Subtotal ₹752.00 · Coupon A −₹75.20 ·
   * CGST ₹60.91 · SGST ₹60.91 · Total ₹798.62` before you confirm. The new charge must be
   * discounted 10%, because the coupon is active by the time the change invoice is
   * raised.
   *
   * Applied inside the item-operations transaction, after the optimistic lock, so it
   * commits or rolls back WITH the change rather than leaving a discount on a
   * subscription whose change was refused. Reordering the two HTTP calls would have got
   * the arithmetic right and re-opened exactly the partial-failure window that collapsing
   * this route's four calls into one transaction closed (see the note on `changes`).
   *
   * The CREDIT side is deliberately unaffected: `issueCurrentTermCredit` scales by the
   * SOURCE invoice's booked discount, which is what the customer actually paid, and a
   * coupon added today was not part of it — full credit for the undiscounted term,
   * discounted new charge.
   */
  couponCode?: string;
  manualDiscount?: {
    kind: "percentage" | "fixed_amount";
    percentOffBps?: number;
    amountOffMinor?: number;
    durationType?: "once" | "forever";
  };
  /**
   * Remove the subscription's active discount (coupon or manual) in this transaction,
   * BEFORE `couponCode`/`manualDiscount` and before the proration invoice — so the
   * proration bills undiscounted, and a remove + add swaps the discount in one edit.
   * `estimateChange`'s `removeDiscount` prices the same order.
   */
  removeDiscount?: boolean;
  /** `failed_change_charge` for this call only. Omitted = the business rule. */
  failedChangeCharge?: FailedChangeCharge;
  /** `plan_change_coupons` for this call only. Omitted = the business rule. */
  planChangeCoupons?: PlanChangeCoupons;
  /** `plan_credits` / `allowances` rules for this call only (`applyPlanChangeCredits`). */
  resetOverrides?: ResetOverrides;
  /**
   * Refuse when the engine would add a mandatory add-on or remove an auto-included one that
   * the request did not name. For callers that showed the customer a price for exactly
   * this request; they name those items in `adds` / `removes` instead.
   */
  refuseUnrequestedItems?: boolean;
  /**
   * Buffer this change's `subscription_changed` instead of emitting it. Supplied by
   * `applyItemOperations` — see the coalescing note there.
   */
  deferEventsTo?: DeferredEvents;
}): Promise<{
  prorationInvoice: Invoice | null;
  /** The FIRST credit note raised, kept for callers that expect one. */
  creditNote: CreditNote | null;
  /**
   * Every credit note this change raised. A term billed across several invoices is
   * credited once PER INVOICE, so this can hold more than one.
   */
  creditNotes: CreditNote[];
  payment: Payment | null;
  /** Set only on the deferred branch — the rows queued instead of an invoice. */
  unbilledCharges?: Array<typeof unbilledChargesTable.$inferSelect>;
}> {
  const { organizationId, businessId, subscriptionId, now } = input;

  // Load sub + items + their prices, resolve any new prices, compute proration.
  const plan = await withTenant(organizationId, async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    if (!sub) throw new ProrationError("Subscription not found");
    // A cancelled sub has no live term to prorate against — editing it is a
    // reactivation (reactivateSubscriptionWithOptions), not a change.
    if (sub.status === "cancelled") {
      throw new ProrationError(
        "You cannot change a cancelled subscription. Reactivate it instead.",
      );
    }

    // The two independent axes (see billing-mode.ts):
    //  - resetStart:   the reset term's start — floored to the local day start when the
    //    business is DAY-ANCHORED, else the exact instant.
    //  - prorationNow: the instant a mid-term change prorates AS OF, for BOTH the credit
    //    and the charge. `prorationWindowStart` — the start of the CURRENT billing day,
    //    not `prorationBoundary`'s next one.
    // Both reduce to `now` on a default (instant + exact) business.
    //
    // ── WHY THE CURRENT DAY, measured rather than reasoned ─────────────────────────
    // The change day counts as still-to-be-served. Measured at
    // day 16 of a 31-day term (08-Aug → 08-Sep, connections 10→12): ONE delta line, qty 2,
    // period **23-Aug → 07-Sep**, ₹776.26 = 1504 × **16/31**. The line's own period starts
    // on the change day, and the amount agrees. We used `prorationBoundary` and produced
    // ₹727.74 = 1504 × 15/31 — one day of the added units short, on every immediate upgrade.
    //
    // Both sides of a change share this one window, so the net is `(new − old) × window` —
    // algebraically the same shape as a single delta line, which is why matching the
    // window is the whole fix and the credit-and-rebill structure is not the problem.
    //
    // An earlier day-1 measurement could not distinguish this: on the term's first day
    // the answer is 31/31 either way.
    //
    // NOT changed: `cancellation-credit.ts` keeps `prorationBoundary`. On a cancellation the
    // customer genuinely keeps the day they cancel in, so the credit must start tomorrow —
    // that is the case the boundary was written for, and it stays right.
    const bizMode = await billingModeFor(tx, businessId);
    const resetStart = alignTermStart(now, bizMode);
    const prorationNow = prorationWindowStart(now, sub.currentPeriodStart, bizMode);

    // THE WINDOW EVERY PRORATED FIGURE BELOW IS A SLICE OF.
    //
    // A TRIALLING subscription has no term (2026-08-25), and `billsAtTrialEnd` at the end
    // of this block discards every money artefact computed here for one — no proration
    // lines, no unused-term credit. So the money math still has to RUN without a term, and
    // asking `requireTerm` for one threw on precisely the subscriptions whose figures were
    // about to be thrown away.
    //
    // A zero-length window is the honest stand-in rather than an invented date: `prorate`
    // returns 0 for it, which is exactly the rule for a trial — nothing has been billed,
    // so no slice of it is owed in either direction. It cannot leak a wrong number into a
    // real charge, because a subscription with a term never takes this branch.
    const term = termOrNull(sub) ?? { start: prorationNow, end: prorationNow };

    const rows = await tx
      .select({ item: subscriptionItems, price: prices })
      .from(subscriptionItems)
      .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
      .where(eq(subscriptionItems.subscriptionId, sub.id));

    // Kind (plan/addon) of every product currently on the subscription — needed
    // to spot a PLAN item's frequency change (auto term-reset trigger) and to
    // find the post-change plan price for the reset term's new length.
    // A price's customer-facing label, with the PRODUCT name as the fallback our platform
    // prices actually depend on — they carry no `external_name` and no `name`, so without
    // it every proration line on a buyer's invoice PDF read as the internal handle
    // ("Remaining time on platform-lite-v202607-INR-Monthly ×1") rather than the plan's
    // name. Shared with `estimateChange`, which must name a line identically.
    const labelFor = makePriceLabeller(tx);

    const existingProductIds = [...new Set(rows.map((r) => r.price.productId))];
    const existingKinds = await tx
      .select({ id: products.id, kind: products.kind })
      .from(products)
      .where(inArray(products.id, existingProductIds));
    const kindById = new Map(existingKinds.map((k) => [k.id, k.kind]));

    // DETERMINISTIC ORDER, plan first. The query above has no ORDER BY, so Postgres returned
    // this subscription's items in whatever order it liked — and the invoice lines are built by
    // walking `rows`, so the DOCUMENT's line order inherited it. One run read
    // [plan, addon] and the next [addon, plan] for the same change. Storing an
    // insertion sequence (migration 0191) made the order STABLE ONCE WRITTEN; it could not make
    // the writing order itself deterministic, which is what this does.
    //
    // Plan first, then add-ons, then a stable tiebreak — the order a reader expects:
    // what they subscribed to, then what was added to it.
    //
    // ⚠ 2026-08-29: this no longer decides the INVOICE's line order. `orderDocumentLines`
    // does, in the apply phase, on the computed amounts — the publicId tiebreak below is
    // alphabetical rather than amount-ascending. This sort still decides the order the
    // lines are BUILT in, which is what makes the walk deterministic and equal-amount lines
    // reproducible under a stable sort.
    rows.sort((a, b) => {
      const rank = (r: typeof a) => (kindById.get(r.price.productId) === "plan" ? 0 : 1);
      return rank(a) - rank(b) || a.price.publicId.localeCompare(b.price.publicId);
    });

    const lines: Array<{
      description: string;
      priceId: string;
      quantity: number;
      unitAmountMinor: bigint;
      amountMinor: bigint;
      /**
       * Post-H (#3): set on the proration line of an AUTO-INCLUDED mandatory
       * add-on, so the apply phase can drop it when the matching item insert lost
       * a race (the add-on already exists — billing it again double-charges).
       * A description prefix can't carry this: the line is labelled with the
       * customer-facing price label, which is not distinguishable from a plan's.
       */
      /**
       * The CONTRACTED RATE per unit, set ONLY where this site genuinely has it.
       *
       * `unitAmountMinor` above is not that for most of these lines — some carry
       * `prorated ÷ quantity`, some carry the whole prorated amount — and
       * `createInvoiceFromLines` discarded all of them anyway, deriving the column from
       * `amount ÷ quantity`. This field is the honest half: absent means "this site cannot
       * state a rate", and the insert falls back to the old division and says so. Passed
       * through at the single `lines:` mapping into `createInvoiceFromLines`.
       *
       * See `db/schema/invoices.ts` for what the column means and why it drifted.
       */
      contractedUnitMinor?: bigint;
      autoIncludedAddon?: boolean;
      /**
       * Set on the CREDIT line of an item whose RATE moved without its price row moving —
       * an add-on re-rated by a plan change, where the differential for the incoming plan
       * differs from the outgoing one.
       *
       * `upgradeCreditLines` decides what goes to the credit note by asking whether the
       * line's `priceId` is also being charged, which distinguishes a genuine price swap
       * (credit price X, charge price Y) from a quantity change (same price both sides,
       * which nets). A re-rate defeats that test: same price on both sides, but it is a
       * swap in every way that matters. Without this flag the credit stays netted onto the
       * change invoice, which must never happen — the change invoice is CHARGES ONLY at the
       * new rates (`credits_applied 0.00`) and the entire old invoice is reversed by a
       * separate adjustment note carrying the OLD rate.
       */
      rerated?: boolean;
      /**
       * Set (to the subscription-item id) on any line that charges a `one_time`
       * item's single, still-unspent cycle — the TERM-RESET charge loop and, since
       * 2026-08-04, the NON-RESET one too. Two things key off it: the
       * line is labelled and booked as a one-time fee rather than a prorated slice,
       * and the item id is handed to `createInvoiceFromLines({ markItemsBilled })`
       * so the cycle this invoice consumes is recorded IN the invoice's transaction —
       * without which the next renewal would see a never-billed one-off and bill it
       * again. Null on every recurring line.
       */
      oneTimeItemId?: string | null;
      /**
       * Set on a line raised for a REQUESTED ADD (`input.adds`), keyed to the item row
       * the apply phase inserts for it. Two things need it: the line is dropped if that
       * insert does not land (a charge for an item the subscription does not have), and
       * a one-time add's item id — which does not exist while these lines are built —
       * is resolved from it AFTER the transaction, for `markItemsBilled`.
       */
      requestedAddKey?: string | null;
      /** True when the requested add above is a `one_time` fee (see `requestedAddKey`). */
      requestedAddIsOneTime?: boolean;
    }> = [];
    // On a term-reset UPGRADE the unused-old-term credit is booked
    // as a CREDIT NOTE (not negative invoice lines) so the new invoice charges the
    // full new plan and the CN applies to it (creditsApplied). Accumulated here,
    // issued in the net>0 branch below.
    const resetCreditItems: Array<{
      description: string;
      amountMinor: bigint;
      priceId: string;
      quantity: number;
    }> = [];
    // Pending deferred charges belonging to items this call REMOVES or CHANGES, re-cut
    // to the span the customer actually held them at the OLD price/quantity (see
    // planRemovedItemUnbilledSettlements). Resolved here with every other money
    // decision; written in the apply transaction, so the re-cut charge lands with the
    // deletion or update that owes it.
    const unbilledSettlements: UnbilledChargeSettlement[] = [];
    /**
     * Re-cut the pending deferred charges booked under `priceId` to end at `heldUntil`,
     * and return what that clawed back — for the caller to subtract from the credit it
     * was about to issue for the SAME span, so the remainder is handed back exactly once.
     *
     * Deduplicated by charge id. One subscription holds at most one item per price (the
     * partial unique index the insert's conflict clause relies on), so two callers cannot
     * legitimately claim the same row — but settling one twice would void it twice and
     * re-queue the surviving slice twice, i.e. bill it twice. Cheap guard, expensive miss.
     */
    const settleQueued = async (priceId: string, heldUntil: Date): Promise<bigint> => {
      const found = await planRemovedItemUnbilledSettlements(tx, {
        subscriptionId: sub.id,
        priceIds: [priceId],
        heldUntil,
      });
      const fresh = found.filter((s) => !unbilledSettlements.some((x) => x.row.id === s.row.id));
      unbilledSettlements.push(...fresh);
      return fresh.reduce((acc, s) => acc + s.droppedMinor, 0n);
    };
    const updates: Array<{
      itemId: string;
      priceId: string;
      quantity: number;
      snapshot: PriceSnapshot;
    }> = [];
    // CAT-3: product id each existing item resolves to AFTER the change (updated
    // price wins) — used to expand the post-change plan set's mandatory add-ons.
    const postProductByItem = new Map<string, string>();

    // Resolve every change first (no lines yet) so we can detect a frequency
    // change across ALL changes before deciding proration vs. term-reset.
    let frequencyChanged = false;
    // ⚠️ There was an `isPlanSwap` flag here, set below and READ NOWHERE, under a comment
    // claiming "ANY plan SWAP books as a term reset". That is not what this engine does:
    // `resetTerm`'s own doc comment records the measurement (15 days into a 31-day term,
    // $7 → $24 same cadence) showing a
    // same-cadence swap does NOT reset — it prorates, charging the new plan and crediting
    // the unused old. Only a FREQUENCY change resets, which is what `frequencyChanged`
    // above tracks. Both removed 2026-08-28: the flag was vestigial from an earlier belief,
    // and the comment outlived the measurement that disproved it.
    let newInterval = (sub.billingPeriodUnit ?? "month") as Interval;
    let newIntervalCount = sub.billingPeriod ?? 1;
    const resolved: Array<{
      current: (typeof rows)[number];
      newPrice: typeof prices.$inferSelect;
      newQty: number;
      newSnapshot: PriceSnapshot;
    }> = [];

    // ── FIRST PASS: which cycle are these items landing on? ─────────────────────
    // `cadenceMismatch` and `alignSnapshotToCycle` both need THE subscription's
    // cycle, and both used to be handed the cycle the subscription has RIGHT NOW.
    // That is the wrong cycle whenever the same call also moves the plan: an edit
    // that swaps a monthly plan for its yearly price AND moves each add-on onto its
    // yearly price was refused item-by-item ("price …-Yearly bills every year, but
    // the subscription bills every month") even though the END STATE is legal — once
    // the change lands, no yearly item sits on a monthly cycle. The guard's rule is
    // right (see `cadenceMismatch`); the cycle it was checking against was stale.
    //
    // So resolve the post-change PLAN cadence up front. The plan item's own interval
    // IS the subscription's cycle — that is exactly what the frequency-change
    // detection in the loop below reads it for — so a plan price sitting anywhere in
    // `changes` decides the cycle every OTHER item in the same call must divide.
    // With no plan price change the cycle does not move and this resolves to the
    // subscription's current cadence, i.e. to what the old code passed.
    //
    // A SEPARATE pass is what makes ARRAY ORDER stop mattering. Resolved inline,
    // `[{addon→yearly}, {plan→yearly}]` refused the add-on before it had seen the
    // plan, while the same two changes in the other order went through: one end
    // state, two answers, decided by the order of a JSON array.
    //
    // The prices are looked up once here and reused by the loop below, so the extra
    // pass costs no extra queries. It deliberately raises NOTHING: a bad item id, an
    // unknown price and a currency clash are all still reported by the main loop, in
    // array order, with the messages callers already match on.
    const priceByPublicId = new Map<string, typeof prices.$inferSelect>();
    for (const change of input.changes) {
      if (!change.newPriceId || priceByPublicId.has(change.newPriceId)) continue;
      const [p] = await tx
        .select()
        .from(prices)
        .where(and(eq(prices.businessId, businessId), eq(prices.publicId, change.newPriceId)))
        .limit(1);
      if (!p) continue; // the main loop raises `No such price`, in the caller's order
      priceByPublicId.set(change.newPriceId, p);
      if (!kindById.has(p.productId)) {
        const [prod] = await tx
          .select({ kind: products.kind })
          .from(products)
          .where(eq(products.id, p.productId))
          .limit(1);
        if (prod) kindById.set(p.productId, prod.kind);
      }
    }
    // ── ONE CYCLE, AND ARRAY ORDER MUST NOT DECIDE IT (2026-08-26) ─────────────────
    // This pass used to ASSIGN on every plan-kind change, so the LAST plan in the array
    // won. The comment above promises the opposite, and for a single plan item it
    // delivers — but `items.ts` states plainly that a sub can carry several plans, and 103
    // of 5,624 subscriptions in the local book have two. Measured: two monthly plans moved
    // to yearly and quarterly in ONE call estimated 175000 or 400000 depending on array
    // order — 2.3x, a different resulting cycle, and in one order the quarterly plan item
    // itself folded x4.
    //
    // A subscription HAS one billing cycle, so two plan items landing on different
    // cadences has no correct answer to pick — which is why `createSubscription` already
    // refuses exactly this, for the reason it states: "picking the cadence off the first
    // recurring price only makes sense once they all match: otherwise the subscription's
    // cycle depends on the order the caller happened to list its items in, and every item
    // that disagrees is silently re-cadenced to it." This is that rule, on the change path.
    const planCadences = new Map<string, { interval: Interval; intervalCount: number }>();
    // Which plan product the subscription LANDS on, for differential resolution below.
    const planProductIds = new Set<string>();
    // The plan price this change lands on, when it swaps one (monthly usage, commitment).
    let postPlanPrice: (typeof rows)[number]["price"] | undefined;
    /** The plan price this change moves onto, for `plan_change_coupons`. */
    let movedPlan: (typeof rows)[number]["price"] | null = null;
    for (const change of input.changes) {
      const current = rows.find((r) => r.item.publicId === change.itemId);
      if (!current) continue;
      const candidate = change.newPriceId ? priceByPublicId.get(change.newPriceId) : undefined;
      if (change.newPriceId && !candidate) continue;
      if (kindById.get((candidate ?? current.price).productId) !== "plan") continue;
      planProductIds.add((candidate ?? current.price).productId);
      if (candidate) postPlanPrice = candidate;
      if (candidate && candidate.id !== current.price.id) movedPlan = candidate;
      // Mirror the snapshot the loop below will freeze, cadence-wise: a new price
      // (with or without a custom amount on it) carries its own interval, while a
      // quantity-only change PRESERVES the item's snapshot and therefore its cadence.
      const preserved = current.item.priceSnapshot as PriceSnapshot | null;
      const cadence = candidate
        ? { interval: candidate.interval, intervalCount: candidate.intervalCount }
        : preserved
          ? { interval: preserved.interval, intervalCount: preserved.intervalCount }
          : { interval: current.price.interval, intervalCount: current.price.intervalCount };
      const resolved = {
        interval: (cadence.interval ?? "month") as Interval,
        intervalCount: cadence.intervalCount ?? 1,
      };
      // Keyed by the cadence itself, so two plan items moving to the SAME cadence collapse
      // to one entry and remain legal — it is disagreement that is refused, not plurality.
      planCadences.set(`${resolved.interval}:${resolved.intervalCount}`, resolved);
    }
    if (planCadences.size > 1) {
      // SORTED, so the message is order-independent too. The decision already was; the
      // text was not, and a caller matching on it would have seen two spellings of one
      // refusal depending on how it happened to order its array.
      const shown = [...planCadences.keys()]
        .sort()
        .map((k) => planCadences.get(k)!)
        .map((c) => `${c.intervalCount} ${c.interval}`)
        .join(" and ");
      throw new ProrationError(
        `A subscription has one billing cycle, but this change puts its plan items on ${shown}. ` +
          `Move them to the same cadence, or apply the changes in separate calls.`,
      );
    }
    let postCycleInterval = (sub.billingPeriodUnit ?? "month") as Interval;
    let postCycleIntervalCount = sub.billingPeriod ?? 1;
    const resolvedPlanCadence = [...planCadences.values()][0];
    if (resolvedPlanCadence) {
      postCycleInterval = resolvedPlanCadence.interval;
      postCycleIntervalCount = resolvedPlanCadence.intervalCount;
    }
    // The plan an add-on's differential is priced against, AFTER this change. Only when the
    // change lands on exactly one plan product; otherwise null, and the resolver falls back
    // to the plan the subscription has now — which is the right answer whenever this call
    // leaves the plan alone, and that is the case F-16 was measured on.
    const postPlanProductId = planProductIds.size === 1 ? [...planProductIds][0]! : null;
    // The cycle every non-plan item in this change is rated and validated against.
    const postCycle = { interval: postCycleInterval, intervalCount: postCycleIntervalCount };
    const postMonthlyUsage = postPlanPrice ? postPlanPrice.billUsageMonthly : sub.billUsageMonthly;
    const monthlyUsage = { monthlyUsage: postMonthlyUsage };

    for (const change of input.changes) {
      const current = rows.find((r) => r.item.publicId === change.itemId);
      if (!current)
        throw new ProrationError(`We could not find the subscription item ${change.itemId}.`);

      let newPrice = current.price;
      if (change.newPriceId) {
        // Resolved (with its product's kind) in the first pass above.
        const p = priceByPublicId.get(change.newPriceId);
        if (!p) throw new ProrationError(`We could not find the price ${change.newPriceId}.`);
        if (p.currency !== sub.currency) {
          throw new ProrationError("You cannot change to a price in a different currency");
        }
        newPrice = p;
      }
      const newQty = change.newQuantity ?? current.item.quantity;

      // Quantity guard, mirroring createSubscription: a quantity-INVARIANT price bills
      // the same regardless of quantity, so quantity ≠ 1 is nonsense. `percentage` is
      // excluded on purpose — quantity is its BASE, not a multiplier (see the longer
      // note in subscriptions/service.ts) — except when the base comes from metered
      // usage instead.
      const newQtyInvariant =
        newPrice.model === "flat" || (newPrice.model !== "usage" && isMeteredPrice(newPrice));
      if (newQtyInvariant && newQty !== 1) {
        throw new ProrationError(
          `quantity must be 1 for ${newPrice.model} price ${newPrice.publicId}. Quantity applies only to per-unit, tiered, volume and package items.`,
        );
      }

      if (change.customAmountMinor != null) {
        if (!isOverridable(newPrice.model)) {
          throw new ProrationError(
            `You can set a custom price only on a flat or per_unit price. This price is ${newPrice.model}.`,
          );
        }
        if (change.customAmountMinor < 0)
          throw new ProrationError("unit_price_minor must be 0 or more");
      }

      // The new snapshot to freeze onto the item:
      //  - custom price provided → override the (new or current) catalog price;
      //  - new price provided     → re-snapshot from the new catalog price (resets any override);
      //  - quantity-only change   → PRESERVE the current snapshot (keeps a prior override,
      //                             and never silently re-rates from an edited catalog price).
      // ── RESOLVE THE DIFFERENTIAL, don't re-snapshot the catalog (F-16, 2026-08-26) ──
      // A "differential" add-on carries a catalog list price of 0, with the real rate held
      // per (add-on, plan, currency, interval). Bare `snapshotPrice(newPrice)` froze the 0:
      // measured, the add-on then billed NOTHING for the life of the subscription (3000/mo),
      // and in the reverse direction charged twice. The `adds` branch below already resolves
      // it — this branch is the half that fix stopped short of, in the same function.
      //
      // NOT `effectiveAddSnapshotTx`, which the adds branch uses: it folds onto the
      // subscription's CURRENT cadence internally, while this branch folds onto `postCycle`
      // a few lines down. Substituting it would fold against the outgoing cadence AND fold
      // twice. `snapshotWithDifferential` is the shared half — the rate, without the cycle.
      const differential = change.newPriceId
        ? postPlanProductId
          ? await resolveDifferentialAgainstPlanTx(tx, postPlanProductId, newPrice)
          : await resolveDifferentialForAddTx(tx, sub.id, newPrice)
        : null;
      const rawSnapshot: PriceSnapshot =
        change.customAmountMinor != null
          ? snapshotPrice(newPrice, change.customAmountMinor)
          : change.newPriceId
            ? snapshotWithDifferential(newPrice, differential)
            : ((current.item.priceSnapshot as PriceSnapshot | null) ?? snapshotPrice(newPrice));
      // If this item is (or becomes) the PLAN item, its post-change interval is
      // the candidate new term length; a mismatch with the current cadence is an
      // auto frequency-change reset (monthly→yearly resets the term).
      const postKind = change.newPriceId
        ? kindById.get(newPrice.productId)
        : kindById.get(current.price.productId);
      // A NON-plan item is folded into the subscription's cycle (monthly add-on on a
      // yearly plan → ×12), exactly as at create. The PLAN item is left un-aligned on
      // purpose: its own interval IS the candidate new cycle, and the frequency-change
      // detection just below reads `newSnapshot.interval` to spot a term reset.
      // `postCycle`, not the subscription's stored cadence: on a plan cadence change
      // the item is joining the NEW cycle, and folding it into the old one first only
      // works because the reset branch re-folds it (`realignSnapshotToCycle`) later.
      // Aligning straight to the post-change cycle lands on the same amount and makes
      // the guard below answerable — see the first pass. Same-cadence changes resolve
      // `postCycle` to the current cycle, so they are unaffected.
      const newSnapshot: PriceSnapshot =
        postKind === "plan" ? rawSnapshot : alignSnapshotToCycle(rawSnapshot, postCycle);
      // A NON-plan item has no such privilege: it cannot redefine the term, so a
      // recurring add-on/charge swapped onto a different cadence would just be
      // billed its own amount at the subscription's frequency. Only guard an actual
      // price swap — a quantity-only change preserves the existing snapshot, and
      // re-validating there would reject items that predate this rule.
      if (postKind !== "plan" && change.newPriceId) {
        const reason = cadenceMismatch(
          newPrice,
          postCycle.interval,
          postCycle.intervalCount,
          monthlyUsage,
        );
        if (reason) throw new ProrationError(reason);
      }
      if (postKind === "plan") {
        const effInterval = (newSnapshot.interval ?? "month") as Interval;
        const effIntervalCount = newSnapshot.intervalCount ?? 1;
        if (
          effInterval !== (sub.billingPeriodUnit ?? "month") ||
          effIntervalCount !== (sub.billingPeriod ?? 1)
        ) {
          frequencyChanged = true;
        }
        newInterval = effInterval;
        newIntervalCount = effIntervalCount;
      }

      resolved.push({ current, newPrice, newQty, newSnapshot });
      updates.push({
        itemId: current.item.id,
        priceId: newPrice.id,
        quantity: newQty,
        snapshot: newSnapshot,
      });
      postProductByItem.set(current.item.id, newPrice.productId);
    }

    // ── REQUESTED ADDS / REMOVES — the other two thirds of a composition edit ──────
    // Until 2026-08-24 this function took `changes` only, so ONE operator edit ("move the
    // plan to its yearly price, drop this add-on, add that one on its yearly price") went
    // out as FOUR requests — `/change`, then `POST …/items`, then a `DELETE …/items/:id`
    // per removal — and produced FIVE documents. Measured on real data: an invoice that
    // billed a full YEAR of two lines the very next request removed (₹279,296.56), two
    // credit notes handing them straight back (−₹65,220.96, −₹106,483.20), a second invoice
    // for the added line (₹110,920.00), and the unused-term credit (−₹47,251.92). The net,
    // ₹171,260.48, was arithmetically correct and the outcome was still wrong twice over:
    //   · it CANNOT COLLECT. The ₹110,920 invoice alone exceeded the customer's ₹97,572
    //     per-debit e-mandate ceiling, so the bank refused it. Splitting one collectable
    //     charge into two turns a payable edit into a dunning case.
    //   · the whole edit belongs in ONE `update_for_items` (`replace_items_list=true`)
    //     raising ONE invoice. Billing a year for lines we
    //     are about to remove, then crediting them back, is an artefact of the order our
    //     requests went out in — not of anything the customer owes.
    //
    // So all three lists are resolved here, applied in the SAME transaction as each
    // other, and every line they produce folds into the SAME `createInvoiceFromLines`
    // call at the end of this function. The money rules are NOT re-invented: an add is
    // priced exactly as `addSubscriptionItem` prices it, a removal credited exactly as
    // `removeSubscriptionItem` credits it — which is also what `estimateChange` already
    // previews, and `estimate == booked` on a MIXED edit is the gate this pair lives
    // under (`verify:estimates` § 5).
    const cycleMoved =
      postCycle.interval !== (sub.billingPeriodUnit ?? "month") ||
      postCycle.intervalCount !== (sub.billingPeriod ?? 1);
    const removedRows = (input.removes ?? []).map((pid) => {
      const row = rows.find((r) => r.item.publicId === pid);
      if (!row) throw new ProrationError(`We could not find the subscription item ${pid}.`);
      return row;
    });
    const removedItemIds = new Set(removedRows.map((r) => r.item.id));

    // ── THE DIFFERENTIAL RE-RATE, HOISTED (money bug, 2026-08-31) ──────────────────
    // F-17 re-rates an add-on that STAYS when the plan changes: a differential price is
    // scoped to (add-on, plan, currency, interval), so the contracted rate moves with the
    // plan. That computation used to sit ~800 lines below, next to its two consumers — the
    // snapshot merge and the credit/charge pair. It is hoisted here because a THIRD consumer
    // needs it and runs first: the TERM RESET's charge loop.
    //
    // The bug: the reset charge loop bills "the FULL new-term price for every POST-change
    // item" from `realignedByItemId.get(item) ?? (chg ? chg.newSnapshot : item.priceSnapshot)`.
    // An add-on merely SITTING there has no `chg`, so it fell through to the PRE-re-rate
    // snapshot and the reset billed the rate the subscription was LEAVING. Off by exactly one
    // change. `realignedByItemId` is the cadence realign, not the rate.
    //
    // Measured by `scripts/probe-reset-differential-lag.ts` (PRO ⇒ ₹752/unit,
    // BUSINESS ⇒ ₹470/unit, ×10, PRO → BUSINESS → PRO with `resetTerm: true`, no operator
    // input anywhere):
    //   snapshot after each change :  752 → 470 → 752      ← the re-rate was always CORRECT
    //   invoice on the BUSINESS plan:  billed 752          ← should be 470
    //   invoice back on PRO:           billed 470          ← should be 752
    //
    // ⚠ A comment at the old site claimed the merge "is what makes the reset charge the new
    // contracted rate rather than the old one". Half of that was true — the merge does run on
    // the reset path, so RENEWAL was always right — and half was false, purely because of
    // statement order: the charge read its snapshot hundreds of lines before the merge
    // computed one. That sentence is corrected there rather than left to be re-derived.
    //
    // Computed ONCE and read by all three consumers. Resolving the differential a second
    // time for the reset would be a second definition of the contracted rate.
    const handledUpstream = new Set(
      input.changes.filter((c) => c.newPriceId || c.customAmountMinor != null).map((c) => c.itemId),
    );
    const rerated = new Map<string, PriceSnapshot>();
    if (postPlanProductId) {
      for (const r of rows) {
        if (removedItemIds.has(r.item.id)) continue;
        // Items whose PRICE moved, or that carry an explicit custom amount from this call,
        // already got their deliberate snapshot upstream. A quantity-only change did not.
        if (handledUpstream.has(r.item.publicId)) continue;
        if (kindById.get(r.price.productId) !== "addon") continue;
        const diff = await resolveDifferentialAgainstPlanTx(tx, postPlanProductId, r.price);
        if (!diff || (diff.amountMinor == null && diff.tiers == null)) continue;
        const before = (r.item.priceSnapshot as PriceSnapshot | null) ?? snapshotPrice(r.price);
        if (before.type !== "recurring") continue;
        // Rate first, then cycle — the same order `effectiveAddSnapshotTx` uses, and the
        // reason the rate half is extracted: folding here and again below would square the
        // cadence multiple.
        const after = alignSnapshotToCycle(snapshotWithDifferential(r.price, diff), {
          interval: newInterval as string,
          intervalCount: newIntervalCount,
        });
        if (
          after.amountMinor === before.amountMinor &&
          JSON.stringify(after.tiers ?? null) === JSON.stringify(before.tiers ?? null)
        )
          continue;
        rerated.set(r.item.id, after);
      }
    }
    // One item cannot be both edited and detached by one call: the two ask for opposite
    // money (a change bills the new price for the rest of the term, a removal credits the
    // term back), and whichever loop below happened to reach it first would decide which.
    // Refuse rather than pick.
    for (const r of resolved) {
      if (removedItemIds.has(r.current.item.id)) {
        throw new ProrationError(
          `You cannot change and remove the same subscription item: ${r.current.item.publicId}`,
        );
      }
    }
    const addResolved: Array<{
      price: typeof prices.$inferSelect;
      qty: number;
      snapshot: PriceSnapshot;
      /** Ties this add's invoice line to the item row the apply phase inserts for it. */
      key: string;
      autoIncluded: boolean;
      billingCycles: number | null;
    }> = [];
    if ((input.adds ?? []).length > 0) {
      // Dynamic, and it has to be: `items.ts` imports THIS module statically
      // (`issueCurrentTermCredit`, `prorate`, `billsAtTrialEnd`…), so a static edge in
      // this direction is a cycle. Same reason `addAdHocCharges` is imported this way.
      const { effectiveAddSnapshotTx } = await import("./items");
      for (const [i, add] of (input.adds ?? []).entries()) {
        const [p] = await tx
          .select()
          .from(prices)
          .where(and(eq(prices.businessId, businessId), eq(prices.publicId, add.priceId)))
          .limit(1);
        if (!p) throw new ProrationError(`We could not find the price ${add.priceId}.`);
        // Every guard `addSubscriptionItem` applies, in its own words, so a caller gets
        // the same refusal whichever surface it used — and so the preview, which mirrors
        // these too, cannot quote a change the apply then rejects.
        if (p.currency !== sub.currency)
          throw new ProrationError("Item currency must match the subscription currency");
        // …except CADENCE, which is checked against the POST-change cycle rather than the
        // subscription's stored one. That is the point of an atomic composition edit: an
        // added yearly add-on on a plan that becomes yearly in the SAME call is legal, and
        // checking it against the outgoing monthly cadence refused exactly the edit this
        // work exists to support. `postCycle` resolves to the current cadence when no plan
        // price moves, so every other add is validated exactly as before.
        const cadenceReason = cadenceMismatch(
          p,
          postCycle.interval,
          postCycle.intervalCount,
          monthlyUsage,
        );
        if (cadenceReason) throw new ProrationError(cadenceReason);
        if (add.customAmountMinor != null) {
          if (!isOverridable(p.model)) {
            throw new ProrationError(
              `You can set a custom price only on a flat or per_unit price. This price is ${p.model}.`,
            );
          }
          if (add.customAmountMinor < 0)
            throw new ProrationError("unit_price_minor must be 0 or more");
        }
        // The booking's OWN resolver, never a parallel calculation: a differential add-on
        // carries a catalog list price of 0 with the real amount held per (add-on, plan,
        // currency, interval), so anything that re-derives it here bills ₹0.00. It folds
        // the item into the cycle it reads from the DB — the OUTGOING one — so when this
        // same call moves the plan's cadence the snapshot is re-expressed on the new one.
        // `realign`, not `align`: the forward scale is not idempotent across a change of
        // cycle (it rewinds through the recorded `cadenceMultiple` first). Gated on
        // `cycleMoved` so a same-cadence add freezes byte-identically to what
        // `addSubscriptionItem` freezes. Mirrors `estimateChange` line for line.
        // POST-CHANGE PLAN, not the stored one: this same call may be moving the plan, and
        // the differential must resolve against the plan the item will actually live under.
        // Passing nothing here priced an add-on added in the same edit at the OUTGOING plan's
        // rate — `verify:proration` § G, both directions, and it recurred through the frozen
        // snapshot. Null when the plan is not moving, which restores the stored-plan lookup.
        const rawAddSnapshot = await effectiveAddSnapshotTx(
          tx,
          sub.id,
          p,
          add.customAmountMinor,
          postPlanProductId,
        );
        const snapshot = cycleMoved
          ? realignSnapshotToCycle(rawAddSnapshot, postCycle)
          : rawAddSnapshot;
        if (!kindById.has(p.productId)) {
          const [prod] = await tx
            .select({ kind: products.kind })
            .from(products)
            .where(eq(products.id, p.productId))
            .limit(1);
          if (prod) kindById.set(p.productId, prod.kind);
        }
        addResolved.push({
          price: p,
          qty: add.quantity ?? 1,
          snapshot,
          key: `add#${i}`,
          autoIncluded: add.autoIncluded === true,
          billingCycles: add.billingCycles ?? null,
        });
      }
    }

    // A frequency change moves the cycle every OTHER item is rated against, and an item
    // folded into the OLD cycle holds a per-cycle amount the new cycle invalidates: a
    // ₹475/month add-on folded ×12 onto a yearly plan holds ₹5,700, which billed monthly
    // would be a 12× overcharge. This used to REFUSE the combination outright — "re-deriving
    // all of them mid-change is real work (the snapshots are immutable by design), so refuse
    // ... rather than mis-bill it. Tracked in PROGRESS as follow-up."
    //
    // That follow-up is done: `realignSnapshotToCycle` (catalog/pricing.ts) rewinds each
    // item through its recorded `cadenceMultiple` and re-scales it onto the new cycle, in
    // the reset branch below. ₹5,700/year rewinds to ₹475/month and re-scales to ₹475 on a
    // monthly cycle — the exact overcharge the refusal existed to prevent. The snapshots
    // stay immutable in the sense that mattered: a new one is written, never edited.
    // What CANNOT be re-derived is a model with no single scalable amount (tiered, package,
    // percentage) — those are still refused, per-item and by name, in the reset branch.

    const resetTerm = input.resetTerm === true || frequencyChanged;
    // Monthly usage billing follows the plan price, but changes only at a term start.
    if (
      postMonthlyUsage !== sub.billUsageMonthly &&
      !resetTerm &&
      sub.currentPeriodEnd != null &&
      sub.currentPeriodEnd.getTime() > now.getTime()
    )
      throw new ProrationError(
        "We could not change the plan now. The new plan price bills usage on a different schedule. Schedule the change for the end of the term, or reset the term.",
      );
    // The commitment follows the plan unless an operator set one of its own.
    const prePlanPrice = rows.find((r) => kindById.get(r.price.productId) === "plan")?.price;
    const followsPlan =
      postPlanPrice != null &&
      String(sub.commitmentAmountMinor) === String(prePlanPrice?.commitmentAmountMinor ?? null);
    const postCommitmentMinor = followsPlan
      ? (postPlanPrice!.commitmentAmountMinor ?? null)
      : sub.commitmentAmountMinor;
    /**
     * ── THE ANCHOR A RESET TERM IS MEASURED FROM (money bug, 2026-08-31) ──────────────
     * A reset moves the term START, so the day-of-month it is anchored to moves with it:
     * `createSubscription` anchors a fresh term to its own start (service.ts:742) and a
     * reset term is anchored the same way. Defined once, HERE, because two places need it
     * and they had drifted — the boundary computation immediately below, and the row write
     * ~1000 lines down that persists `billing_anchor_day`.
     *
     * That row write already re-anchors (see its own comment, and the 351-day year it fixed
     * on 2026-08-23). The boundary computation was left on `sub.billingAnchorDay` — the
     * PRE-reset day — and `advancePeriod` takes day-of-month ENTIRELY from that argument, so
     * the new term end landed on the OLD day of the month.
     *
     * Measured on `verify:renewal-matrix`'s 08→23 monthly→yearly swap: the reset minted
     * 2026-08-23 → 2027-08-08, a **350-day "year"**, and the first renewal was then 381 days
     * (366 + the 15-day realign back onto the 23rd). `renewal.ts` was innocent throughout —
     * it read the persisted anchor 23 correctly, and `advancePeriod(2027-08-08, year, 1, 23)`
     * → 2028-08-23 is the right answer to the wrong question it was handed. Diagnosed by the
     * `tmbilling-e1` session; half of this fix shipped 2026-08-23, this is the other half.
     *
     * `null` outside month/year mirrors the row write exactly — a day-of-month anchor means
     * nothing to a day- or week-cadence term, and `advancePeriod` must get the same value
     * from both sites or they drift again.
     */
    const resetAnchorDay =
      newInterval === "month" || newInterval === "year"
        ? localDatePartsInTz(resetStart, bizMode.timezone).day
        : null;
    const newPeriodEnd = resetTerm
      ? // ⚠ `advancePeriod`, NOT `addInterval` — see `createSubscription`. Both clamp, but
        // `addInterval` clamps on the UTC calendar while the term lives on the BUSINESS
        // calendar, so a month-end reset on a non-UTC business lands a day late.
        //
        // MUST STAY IN LOCKSTEP WITH `estimate.ts`'s copy of this line: one computes the
        // reset's new term end, the other PREVIEWS it. Changing one alone reintroduces
        // exactly the preview-vs-booking divergence this branch exists to remove.
        advancePeriod(resetStart, newInterval, newIntervalCount, resetAnchorDay, bizMode)
      : sub.currentPeriodEnd;

    // `prorate: false` suppresses the PRORATED artefacts.
    // On the non-reset path both sides are prorated, so the whole money movement goes
    // and only the composition changes; on the reset path the full new-term charge
    // survives and only the unused-time credit is dropped. See the field's doc.
    const prorate_ = input.prorate !== false;

    if (!resetTerm) {
      // Standard immediate proration: credit the unused old price, charge the
      // prorated new price — only for CHANGED items.
      for (const { current, newPrice, newQty, newSnapshot } of resolved) {
        // `prorate: false`: the item still changes (the updates/inserts/removals are
        // built above and applied regardless), it just books no money. Measured:
        // a same-cadence swap with prorate=false raises no invoice at all.
        if (!prorate_) continue;
        // Credit the OLD price from the item's snapshot (what it was actually
        // charged at), not the live catalog price which may have since been edited.
        const oldSnap = current.item.priceSnapshot as PriceSnapshot | null;
        const oldRatable = ratableForItem(current.item, current.price);
        const oldFull = fixedChargeMinor(
          oldSnap ?? current.price,
          oldRatable,
          current.item.quantity,
        );
        // The item keeps its own free quantity across a price or quantity change.
        const newFull = fixedChargeMinor(
          newSnapshot,
          ratableFromSnapshot(newSnapshot, current.item.freeQuantity),
          newQty,
        );
        // A `one_time` item is charged once and credited never — the shared decider
        // (nonResetItemProration) owns that rule for both this booking and
        // estimateChange's preview. Recurring items are byte-identical to before.
        // Credit nothing for a basis that was never charged. `oldFull` is rated from the
        // snapshot, which is correct wherever the change that set it also billed the move
        // — and `prorate: false` is the one change that does not. Passing 0 here zeroes the
        // CREDIT and leaves the charge untouched. Full reasoning, and why this is not the
        // reverted billed-line candidate, at `basisWasEverCharged`.
        // ONLY WHEN THE PRICE ACTUALLY SWAPS. A quantity-only move keeps the same price, so
        // its basis was self-evidently charged, and zeroing the credit there destroys the
        // added-units decomposition — measured: it broke 5 `verify:estimates` assertions and
        // three suites before this narrowing. The defect this gate exists for needs a price
        // swap to arise at all: it is the OUTGOING PRICE whose basis may never have been
        // billed.
        const oldBasisCharged =
          newPrice.id === current.price.id ||
          (await basisWasEverCharged(tx, sub.id, current.price.id));
        const { creditMinor, chargeMinor, chargeIsOneTime } = nonResetItemProration({
          oldSnapshotType: oldSnap?.type ?? current.price.type,
          newSnapshotType: newSnapshot.type,
          oldFullMinor: oldBasisCharged ? oldFull : 0n,
          newFullMinor: newFull,
          billingCycles: current.item.billingCycles,
          cyclesBilled: current.item.cyclesBilled,
          now: prorationNow,
          periodStart: term.start,
          periodEnd: term.end,
        });

        // ── THE PARTIAL CASE (money bug, 2026-08-24) ─────────────────────────────
        // A quantity REDUCED rather than removed: the item survives, so part of its
        // still-queued deferred charge is genuinely owed and part is not. This pair of
        // lines already settles that — credit the OLD rate's whole remainder, charge the
        // NEW rate's — but only if the credit can actually be issued. With the charge
        // still merely QUEUED, no invoice ever charged this price, so
        // `issueCurrentTermCredit` falls back to the newest live invoice and caps at ITS
        // cash. Measured (probe scenario F): an add-on ×10 queued at ₹4,064.52 and cut to
        // ×4 mid-term owed a net ₹1,277.42 back and issued ₹1,000.00 — the plan invoice's
        // entire cash — silently keeping ₹277.42 the customer never owed, while the
        // queued ×10 charge stood in full.
        //
        // So the queued charge is re-cut to the span held at the OLD rate, and the credit
        // netted by what that cancelled. ×10 for [added .. now) survives, the ×4 remainder
        // is charged by `chargeMinor` below, no credit note is needed at all, and the
        // outcome no longer depends on some unrelated invoice having enough cash on it.
        // Targeted at the OLD price — the one the queued charge was booked under (for a
        // quantity-only change they are the same price).
        const netCreditMinor = creditMinor - (await settleQueued(current.price.id, prorationNow));
        const priceSwapped = newPrice.id !== current.price.id;
        const qtyDelta = newQty - current.item.quantity;
        /** What the movement is actually worth once its credit and its charge meet. */
        const netMinor = chargeMinor - netCreditMinor;

        // ── SHAPE: a same-price QUANTITY move bills the ADDED UNITS ───────────────────
        // ONE line for the units gained, not an unused/remaining pair. Measured: a per-unit
        // add-on moved ×1 → ×4 produces one invoice line `150.00 qty=3 "… - Prorated
        // Charges"`, no credit note, no negative line. The same rule holds at ×1 → ×2 —
        // `qty=1 94000` against our `-94000 / +188000`.
        //
        // The TOTAL was already right; only the decomposition differed. 4b7b5be established
        // why that distinction matters and must be kept narrow: it moved PRICE SWAPS off
        // netting because a lump sum leaves a percentage coupon nothing to land on (measured
        // overcharges of +3000, +5970 and +96000). That argument is specific to a swap,
        // where credit and charge are DIFFERENT prices. Here they are the SAME price, so a
        // percentage distributes across the pair and across the net identically — which is
        // why the same commit deliberately left quantity changes netted, and why this
        // reshapes the lines WITHOUT touching how the money is computed: `netMinor` is
        // exactly what the two lines summed to.
        //
        // ── AND NOW DECREASES TOO: THE PROBE THIS COMMENT ASKED FOR WAS RUN ───────────
        // This block used to read "Scoped to INCREASES. A decrease nets negative, and the
        // shape there is unmeasured; it also runs through the `settleQueued`
        // partial-quantity money fix above (the 2026-08-24 ×10 → ×4 bug), which is not
        // worth disturbing on a guess. Probe first." The probe was written, so the guess
        // is gone and the scope opens symmetrically.
        //
        // CREDIT THE REMOVED UNITS ONLY AND RAISE NO INVOICE: prorated refundable credits
        // of $5 × 1 = $5 on a paid term, and `unused service = plan price × UNUSED QUANTITY
        // × fraction = $30 × 1 × 0.5` on a partially paid one. Measured with an add-on at
        // qty 4 → 2 mid-term against a `payment_due` invoice:
        //     NEW invoices raised by the change : 0
        //     credit notes issued              : 1 → CN-722 adjustment USD 100.00, qty=2
        //     original invoice                 : total stays 215.00, due 215.00 → 115.00
        // The exact mirror of the INCREASE measured above, so the "PRICE SWAPS ONLY"
        // limit holds in BOTH directions.
        //
        // WHAT WE DID INSTEAD, measured by `scripts/probe-qty-downgrade-shape.ts` on a
        // $30/unit qty 3 → 2 fixture — and the shape was decided by `invoice_immediately`,
        // NOT by the payment state:
        //     paid   / invoiceImmediately=T → refundable 48.00 + a 32.00 invoice   (GROSS)
        //     unpaid / invoiceImmediately=T → adjustment 48.00 + a 32.00 invoice   (GROSS)
        //     paid   / invoiceImmediately=F → refundable 16.00, no invoice         (DELTA ✓)
        //     unpaid / invoiceImmediately=F → adjustment 16.00, no invoice         (DELTA ✓)
        // The unused/remaining PAIR is what produced the gross shape: with both lines on
        // the term, `net < 0` and the downgrade builder credits the negatives gross and
        // invoices the positives. Collapsing the pair the way an increase already is
        // collapsed removes the positive line entirely, so `hasCharges` is false, the
        // credit note IS the whole outcome and no invoice is raised — the right shape,
        // reached through the machinery that already existed rather than a new branch.
        //
        // ⚠ NOT a widening of the price-swap credit-note branch. That direction is already
        // measured as wrong (it would also have "fixed" `verify-change-atomicity`'s
        // 19500-delta fixture, which is right as written). This is the same narrow
        // same-price rule the increase uses, and the same argument licenses it: a
        // percentage coupon distributes across a same-price pair and across their net
        // identically, which is false for a swap and is why swaps must stay two documents.
        //
        // NET MONEY IS UNTOUCHED, deliberately: `netMinor` is exactly what the two lines
        // summed to, `settleQueued` is already inside `netCreditMinor`, and the
        // 2026-08-24 ×10 → ×4 fix therefore keeps working unchanged. What moves is the
        // number of DOCUMENTS — which is not cosmetic, because a re-charge is a taxed
        // supply whose credit reverses tax separately, and because a coupon applied AFTER
        // the term was billed lands on a re-charge that must never be raised: measured on
        // `verify:estimates`' "coupon applied AFTER billing" fixture (qty 10 → 6, 10%),
        // the gross shape handed the customer 542800 where the delta shape hands back
        // 472000 — 70800 of coupon on an invoice that should not exist.
        //
        // `chargeMinor > 0n` is required on this side where the increase gets it for free
        // from `netMinor > 0n`: with no charge at all there is no pair to collapse (a
        // quantity cut to zero), and that case keeps the plain credit line it already had.
        const billsAddedUnitsOnly =
          !priceSwapped && !chargeIsOneTime && qtyDelta > 0 && netCreditMinor > 0n && netMinor > 0n;
        const creditsRemovedUnitsOnly =
          !priceSwapped &&
          !chargeIsOneTime &&
          qtyDelta < 0 &&
          netCreditMinor > 0n &&
          chargeMinor > 0n &&
          netMinor < 0n;

        // A change that moved NOTHING books nothing. Sending `planPrice` for the plan the
        // subscription is already on put the plan into `changes` unmoved and we emitted
        // `-911800 Unused time` + `+911800 Remaining time` — a cancelling pair on the
        // customer's invoice for an item that never changed. Nothing should be emitted.
        // Tested on the NET rather than on the inputs so an item carrying a queued
        // settlement (where the pair does not cancel) still takes the normal path.
        const isNoOpChange = !priceSwapped && !chargeIsOneTime && qtyDelta === 0 && netMinor === 0n;

        if (isNoOpChange) {
          // No lines: the item is still updated by `updates` above, it just books no money.
        } else if (billsAddedUnitsOnly) {
          lines.push({
            description: `${await labelFor(newPrice)} - Prorated Charges`,
            priceId: newPrice.id,
            quantity: qtyDelta,
            unitAmountMinor: netMinor / BigInt(qtyDelta),
            amountMinor: netMinor,
          });
        } else if (creditsRemovedUnitsOnly) {
          // The REMOVED units, named as such: the note carries the removed quantity
          // (`qty=2` on the 4 → 2 measurement above), not the old total.
          //
          // Deliberately worded `Unused time on …` rather than a "- Prorated Credits"
          // suffix. Two reasons, and the second is load-bearing: our proration wording
          // names the quantity and says which side of the proration a line is, and
          // `creditedDescription`
          // strips only `- Prorated Charges` — a `- Prorated Credits` suffix would come
          // out of the credit-note builder as "Unused time on X - Prorated Credits",
          // which is the exact defect CN-1324 shipped with (see that function's docblock).
          // This phrasing is already credit-worded, so that function is a no-op on it.
          const removedUnits = BigInt(-qtyDelta);
          lines.push({
            description: `Unused time on ${await labelFor(current.price)} ×${-qtyDelta}`,
            priceId: current.price.id,
            quantity: -qtyDelta,
            unitAmountMinor: netMinor / removedUnits,
            amountMinor: netMinor,
          });
        } else {
          if (netCreditMinor > 0n) {
            lines.push({
              description: `Unused time on ${await labelFor(current.price)} ×${current.item.quantity}`,
              priceId: current.price.id,
              quantity: current.item.quantity,
              unitAmountMinor: -netCreditMinor,
              amountMinor: -netCreditMinor,
            });
          }
          // A ZERO charge still gets a line when the item's PRICE CHANGED. Every item the
          // term carries is documented, priced or free: moving a plan AND a per-unit add-on
          // monthly → yearly in one edit must write
          // `line 118800 "PRO plan"` + `line 0 "Additional Connections"` where we wrote only
          // the plan. The connections add-on is priced at 0 (a free
          // item), and the invoice is a statement of what the customer HAS, not only of what
          // they were charged for. Dropping it leaves the customer unable to verify the
          // entitlement moved with the plan.
          //
          // Gated on a genuine price swap, not on every zero: a quantity change or an
          // untouched item must not start emitting empty rows.
          if (chargeMinor > 0n || priceSwapped) {
            lines.push({
              // Same three obligations the term-reset branch's one-time line carries:
              // the plain label, `kind: 'one_time'` (derived from oneTimeItemId at the
              // invoice call), and the item id so the cycle is recorded in the invoice's
              // transaction — or the next renewal bills the fee a second time.
              description: chargeIsOneTime
                ? await labelFor(newPrice)
                : `Remaining time on ${await labelFor(newPrice)} ×${newQty}`,
              priceId: newPrice.id,
              quantity: newQty,
              unitAmountMinor: chargeIsOneTime ? chargeMinor / BigInt(newQty || 1) : chargeMinor,
              amountMinor: chargeMinor,
              oneTimeItemId: chargeIsOneTime ? current.item.id : null,
            });
          }
        }
      }
      // ── REQUESTED ADDS, priced exactly as `addSubscriptionItem` prices them ────────
      // On the SAME window as the changed items above (`prorationNow`). Both are
      // `prorationWindowStart(now, currentPeriodStart, bizMode)` — which is also what
      // `items.ts` computes via `itemProrationWindowStart`, and what `estimateChange`
      // keeps as a separate `itemWindowStart` local so a future divergence stays visible.
      // The two were genuinely different boundaries until 2026-08-23; today they are the
      // same instant, so folding adds into this call moves NO number.
      //
      // Deliberately NOT gated on `prorate_`: neither `addSubscriptionItem` nor
      // `removeSubscriptionItem` has such a flag and `estimateChange` previews these
      // lines unconditionally. `prorate` describes the CHANGE's prorated credit/charge
      // pair; making it also swallow an add's charge here would quote one
      // number and book another.
      for (const a of addResolved) {
        const full = fixedChargeMinor(a.snapshot, ratableFromSnapshot(a.snapshot, null), a.qty);
        // A `one_time` price buys no span of time, so the whole fee is due — the same rule
        // and the same plain label `addSubscriptionItem` applies. The three obligations of
        // billing a one-off outside the period planner are carried by
        // `requestedAddIsOneTime`: the plain label here, `kind: 'one_time'` at the invoice
        // call, and the inserted item id handed to `markItemsBilled` so the cycle it
        // spends is recorded inside the invoice's transaction.
        const isOneTime = a.snapshot.type === "one_time";
        const charge = isOneTime ? full : prorate(full, prorationNow, term.start, term.end);
        if (charge > 0n) {
          lines.push({
            description: isOneTime
              ? await labelFor(a.price)
              : `${await labelFor(a.price)} - Prorated Charges`,
            priceId: a.price.id,
            quantity: a.qty,
            unitAmountMinor: charge / BigInt(a.qty || 1),
            amountMinor: charge,
            requestedAddKey: a.key,
            requestedAddIsOneTime: isOneTime,
          });
        }
      }
      // ── REQUESTED REMOVES, credited exactly as `removeSubscriptionItem` credits them ──
      for (const r of removedRows) {
        // A ONE-TIME item is credited NOTHING on removal, billed or not: it bought no span
        // of time, so there is no unused remainder to hand back, and an invoiced one-off
        // is returned by an explicit credit note — not as a side effect of editing the
        // composition. Unconditional on `cycles_billed`, mirroring both the booking
        // (items.ts) and the preview (estimate.ts).
        const snap = r.item.priceSnapshot as PriceSnapshot | null;
        if ((snap?.type ?? r.price.type) === "one_time") continue;
        // No frozen rate to credit from — `removeSubscriptionItem` credits nothing either
        // (its `ratable` is null, so `fullAmount` is 0).
        if (!snap) continue;
        const credit = prorate(
          fixedChargeMinor(snap, ratableFromSnapshot(snap, r.item.freeQuantity), r.item.quantity),
          prorationNow,
          term.start,
          term.end,
        );
        // …and the CHARGE side of the same removal, exactly as `removeSubscriptionItem`
        // settles it (money bug, 2026-08-24): an add made without `invoice_immediately`
        // queued its prorated charge as a pending `unbilled_charge` running to the term
        // end, and the next renewal folds it in. Re-cut it to the span actually held, and
        // take what was clawed back off the credit — the remainder is handed back once,
        // either by cancelling a charge not yet raised or by crediting one that was, never
        // by both. See planRemovedItemUnbilledSettlements.
        const netCredit = credit - (await settleQueued(r.price.id, prorationNow));
        if (netCredit > 0n) {
          lines.push({
            description: `Unused time on ${await labelFor(r.price)} ×${r.item.quantity}`,
            priceId: r.price.id,
            quantity: r.item.quantity,
            unitAmountMinor: -netCredit,
            amountMinor: -netCredit,
          });
        }
      }
    } else {
      // TERM RESET: credit the unused (prorated to the
      // proration boundary → the OLD currentPeriodEnd) time of ALL current items.
      // The credit is booked as a CREDIT NOTE (resetCreditItems → issued in the
      // net>0 branch), NOT as negative invoice lines, so the new invoice charges
      // the full new plan and the CN applies to it.
      for (const r of rows) {
        // ── A ONE-TIME item has NO unused time (bug, 2026-08-03) ────────────────
        // This loop credited every item on the subscription, keyed on nothing but
        // "is this an item". A `one_time` fee bought no span of time, so there is no
        // remainder of it left to hand back: a 3000 setup fee turned a plain
        // monthly→yearly swap into a 3000 credit the customer was never owed (and,
        // paired with the charge loop below re-billing the same fee, two wrong money
        // lines from one plan change). Neither is credited. Unconditional on
        // `cycles_billed`: an ALREADY-PAID fee is not unused time, and a NEVER-BILLED
        // one has nothing paid to credit — the charge loop below is where the
        // never-billed case is settled, in full.
        const oldSnap = r.item.priceSnapshot as PriceSnapshot | null;
        if ((oldSnap?.type ?? r.price.type) === "one_time") continue;
        const oldRatable = ratableForItem(r.item, r.price);
        const oldFull = fixedChargeMinor(oldSnap ?? r.price, oldRatable, r.item.quantity);
        // Term reset: the new term starts at `resetStart`, so the OLD term's unused
        // portion runs [resetStart, oldPeriodEnd] — credit from resetStart (not the
        // next-midnight cancel boundary). Same-day upgrade ⇒ full credit (0 days used).
        // Anniversary businesses: resetStart === now (prorated).
        // `prorate: false` on a RESET drops the unused-time credit and keeps the full
        // new-term charge below — the charge is a whole term's list price, not a
        // prorated artefact. Measured: freq change + prorate=false → term resets,
        // 6000 charged, no credit note.
        const creditUnused = prorate_ ? prorate(oldFull, resetStart, term.start, term.end) : 0n;
        // An item this call REMOVES or CHANGES settles its still-queued deferred charge
        // here too (money bug, 2026-08-24) — the reset's boundary is `resetStart`, so
        // that is the instant it stopped being held at the old price/quantity. The credit
        // is then netted by what that cancelled, so the old term's remainder is handed
        // back exactly once, and by cancelling an unraised charge rather than by a credit
        // note capped at some unrelated invoice's cash. Unconditional on `prorate_`:
        // suppressing the prorated CREDIT is a choice about this change's artefacts, but
        // a charge covering time at a price the customer no longer holds is never owed —
        // and with `prorate: false` the credit is already 0, so there is nothing to net.
        //
        // Items this call did NOT touch keep their credit untouched. Their queued charges
        // are a separate question (a term reset re-bills a whole new term while an old
        // term's deferred charge is still pending) — real, but not this defect, and not
        // settled by a rule about the item that changed.
        const touched =
          removedItemIds.has(r.item.id) || resolved.some((x) => x.current.item.id === r.item.id);
        const netCreditUnused = touched
          ? creditUnused - (await settleQueued(r.price.id, resetStart))
          : creditUnused;
        if (netCreditUnused > 0n) {
          resetCreditItems.push({
            description: `Unused time on ${await labelFor(r.price)} ×${r.item.quantity}`,
            amountMinor: netCreditUnused,
            priceId: r.price.id,
            quantity: r.item.quantity,
          });
        }
      }
      // Charge the FULL (not prorated) new-term price for every POST-change
      // item: updated items at their new snapshot/qty, unchanged items at
      // their current snapshot/qty. Removed items are excluded below.
      const changedByItemId = new Map(resolved.map((r) => [r.current.item.id, r]));
      // ── ANNUALISE every item onto the NEW cycle ─────────────────────────────────
      // A term reset changes the subscription's cadence but leaves the other items
      // where they were, so a monthly add-on ends up on a yearly plan. We charged it
      // ONE MONTH for the whole year: measured, a ₹752/mo connections add-on ×12 and a
      // ₹4,606/mo destination add-on came to ₹9,024 + ₹4,606 where the correct charge is
      // ₹108,288 + ₹55,272 (the monthly price multiplied by 12) — ₹149,930 short per
      // subscription-year, ex-tax. `alignSnapshotToCycle` already implements that rule and
      // its own doc comment describes this case; the reset path simply never called it.
      //
      // `realignSnapshotToCycle` rather than `alignSnapshotToCycle`: the forward scale is
      // not idempotent across a CHANGE of cycle, so it rewinds via the snapshot's
      // recorded `cadenceMultiple` before re-scaling. Without that, yearly→monthly leaves
      // a ×12 amount billing monthly.
      //
      // Persisted, not just charged. Probe 2 confirmed the renewal repeats the shortfall
      // (the renewal invoice billed the add-on one month for a yearly term), so the
      // snapshot has to move too or the leak recurs every year.
      const newCycle = { interval: newInterval as string, intervalCount: newIntervalCount };
      const realignedByItemId = new Map<string, PriceSnapshot>();
      for (const r of rows) {
        // An item this call REMOVES is not joining the new cycle: nothing to re-rate, and
        // nothing to persist onto a row that is about to be deleted.
        if (removedItemIds.has(r.item.id)) continue;
        const chg = changedByItemId.get(r.item.id);
        const before = chg
          ? chg.newSnapshot
          : ((r.item.priceSnapshot as PriceSnapshot | null) ?? snapshotPrice(r.price));
        if (before.type !== "recurring") continue;
        const after = realignSnapshotToCycle(before, newCycle);
        if (after.amountMinor === before.amountMinor && after.interval === before.interval)
          continue;
        realignedByItemId.set(r.item.id, after);
      }
      // Persist it. An item NOT in `changes` has no `updates` row at all, which is why
      // both add-ons kept their monthly snapshot through the change; one is added here so
      // the renewal rates the new cycle. An item that IS being changed already has a row —
      // rewrite its snapshot in place rather than queueing a second update for the same id.
      for (const [itemId, snapshot] of realignedByItemId) {
        const existing = updates.find((u) => u.itemId === itemId);
        if (existing) {
          existing.snapshot = snapshot;
          continue;
        }
        const row = rows.find((r) => r.item.id === itemId)!;
        updates.push({ itemId, priceId: row.item.priceId, quantity: row.item.quantity, snapshot });
      }
      // Refuse rather than under-bill: any recurring item whose cadence is SHORTER than
      // the new cycle but whose model cannot be scaled would be billed one period for the
      // whole term. Checked after the loop so the message names the offending price.
      if (frequencyChanged) {
        for (const r of rows) {
          // A REMOVED item cannot be under-billed on the new cycle — it will not be on it.
          // Refusing the whole change over an unscalable model that is leaving in the same
          // call would block an edit whose end state is perfectly legal.
          if (removedItemIds.has(r.item.id)) continue;
          const chg = changedByItemId.get(r.item.id);
          const snap = chg
            ? chg.newSnapshot
            : ((r.item.priceSnapshot as PriceSnapshot | null) ?? snapshotPrice(r.price));
          if (snap.type !== "recurring" || isOverridable(snap.model)) continue;
          const own = deAlignSnapshotFromCycle(snap);
          const reason = cadenceMismatch(
            {
              type: own.type,
              interval: own.interval,
              intervalCount: own.intervalCount,
              publicId: own.publicId,
              model: own.model,
              usageAggregation: own.usageAggregation ?? null,
            },
            newCycle.interval,
            newCycle.intervalCount,
            monthlyUsage,
          );
          if (reason) throw new ProrationError(reason);
        }
      }
      for (const r of rows) {
        // A REMOVED item's unused OLD term is credited above (a reset credits the whole
        // term, this item included) and it must NOT be charged for the new one — it will
        // not exist in the post-change composition. This single line is what stops the
        // five-document edit from billing a year of something it removes in the same call.
        if (removedItemIds.has(r.item.id)) continue;
        const chg = changedByItemId.get(r.item.id);
        const priceForCharge = chg ? chg.newPrice : r.price;
        const qtyForCharge = chg ? chg.newQty : r.item.quantity;
        // `rerated` FIRST — the contracted rate for the plan being moved TO. Without it this
        // fell through to `item.priceSnapshot` for any add-on that merely SITS here (no
        // `chg`), and the reset billed the OUTGOING plan's differential: measured 752 where
        // 470 was contracted, and 470 where 752 was, one change behind throughout
        // (`scripts/probe-reset-differential-lag.ts`). It outranks `realignedByItemId`
        // because it already carries the cycle alignment — `rerated` is rate-then-cycle,
        // while the realign only rewinds and re-scales the rate the item already had.
        const snapshotForCharge =
          rerated.get(r.item.id) ??
          realignedByItemId.get(r.item.id) ??
          (chg
            ? chg.newSnapshot
            : ((r.item.priceSnapshot as PriceSnapshot | null) ?? snapshotPrice(r.price)));
        // ── A ONE-TIME item is charged ONCE, EVER (bug, 2026-08-03) ──────────────
        // "Charge the FULL new-term price for every post-change item" is right for a
        // recurring item — a reset term is a whole new term — and wrong for a
        // `one_time` fee, which does not belong to a term at all. A 3000 setup fee
        // paid at signup was re-charged by every plan swap. The gate is the SHARED cap
        // rule (`isCycleCapExhausted`, catalog/pricing.ts — the same single source of
        // truth `planSubscriptionPeriodInvoice` and the in-trial estimate use), NOT the
        // price type alone: a fee that is attached but NOT yet billed (a signup that
        // deferred its first invoice) is legitimately still owed, and this reset is a
        // real invoice — it charges the full fee and, below, records the cycle it
        // spends so no later renewal bills it a second time.
        const oneTimeItemId = snapshotForCharge.type === "one_time" ? r.item.id : null;
        if (
          oneTimeItemId &&
          isCycleCapExhausted(r.item.billingCycles, snapshotForCharge.type, r.item.cyclesBilled)
        )
          continue;
        // A metered item bills its usage in arrears, never a new-term charge.
        if (isMeteredPrice(snapshotForCharge)) continue;
        const fullNewTerm = computeLineAmount(
          ratableFromSnapshot(snapshotForCharge, r.item.freeQuantity),
          qtyForCharge,
        );
        // A term reset re-bills the WHOLE new term, so every item carried onto it belongs
        // on the document — including one priced at 0. The zero line must be written:
        // moving a plan and a per-unit add-on monthly → yearly in one edit must produce
        // `line 118800 "PRO plan"` + `line 0 "Additional Connections"`, where the
        // `> 0n` gate here dropped the second. The add-on really is free (measured: every
        // `platform-additional-connections-*` price is amount 0), and an invoice is a
        // statement of what the customer HAS for the term, not only of what they were
        // charged — without the line they cannot verify the entitlement moved with the plan.
        // Negative can't arise here (`computeLineAmount` of a non-negative price).
        if (fullNewTerm >= 0n) {
          lines.push({
            oneTimeItemId,
            // A TERM RESET charges the FULL new-term price, so "Prorated Charges" is
            // simply wrong on it — a full $1188 annual charge is not a prorated slice of
            // anything. This branch is the `else` of `if (!resetTerm)`, so the label is
            // unconditional here; it used to be gated on `frequencyChanged`, which is
            // only ONE of the two ways `resetTerm` becomes true (`input.resetTerm === true
            // || frequencyChanged`). A FORCED same-cadence reset — what the hosted
            // checkout sends — therefore charged a whole new term and still called it
            // "Prorated Charges".
            //
            // MEASURED 15 days into a 31-day term, lite-monthly-7 → basic-monthly-24:
            //   force_term_reset=true  → term RESTARTS, invoice 2400 (full),
            //                            line "BASIC … Monthly Plan"          ← no suffix
            //   no reset (control)     → term unchanged, invoice 1239 (prorated),
            //                            line "BASIC … Monthly Plan - Prorated Charges"
            // The amounts reproduce the earlier matrix (1239 / 2400) exactly, so the
            // probe was measuring the right two cells. It is the RESET that drops the
            // suffix, not the frequency change.
            // A one-time fee is never a prorated slice either — the same plain label
            // `addSubscriptionItem` gives it — so it needs no separate arm any more.
            description: await labelFor(priceForCharge),
            priceId: priceForCharge.id,
            quantity: qtyForCharge,
            unitAmountMinor: fullNewTerm / BigInt(qtyForCharge || 1),
            // A reset charges a WHOLE new term, so `fullNewTerm ÷ qty` IS the contracted
            // rate here — not a prorated average. Stated so the invoice line records it.
            contractedUnitMinor: fullNewTerm / BigInt(qtyForCharge || 1),
            amountMinor: fullNewTerm,
          });
        }
      }
      // ── REQUESTED ADDS join the RESET term at their FULL new-term price. The term
      // starts today, so prorating from the item window would land on the same number —
      // `estimateChange`'s reset branch says exactly that. Labelled by the same rule as
      // the sibling lines above: a reset charges a whole new term, which is not a prorated
      // slice of anything, and neither is a one-time fee. See the measurement recorded
      // there for why this is unconditional rather than gated on `frequencyChanged`.
      for (const a of addResolved) {
        const fullNewTerm = fixedChargeMinor(
          a.snapshot,
          ratableFromSnapshot(a.snapshot, null),
          a.qty,
        );
        const isOneTime = a.snapshot.type === "one_time";
        if (fullNewTerm > 0n) {
          lines.push({
            description: await labelFor(a.price),
            priceId: a.price.id,
            quantity: a.qty,
            unitAmountMinor: fullNewTerm / BigInt(a.qty || 1),
            // Same as the sibling above: a requested add joins the reset term at its FULL
            // new-term price, so this is the contracted rate.
            contractedUnitMinor: fullNewTerm / BigInt(a.qty || 1),
            amountMinor: fullNewTerm,
            requestedAddKey: a.key,
            requestedAddIsOneTime: isOneTime,
          });
        }
      }
    }

    // CAT-3: after these changes, expand the plan set's MANDATORY add-ons and
    // auto-include any not already present. This covers plan swaps that bring a
    // different plan's mandatory add-ons. Prorated for the remaining term, or
    // charged in full when this change is a term reset.
    // The POST-change product set: every item that SURVIVES this call, at the product its
    // (possibly changed) prices at, plus every product this call ADDS. Both halves
    // matter — the plan set decides which add-ons are mandatory, and a product already
    // present, or arriving in this same call, must not also be auto-included.
    const postProductIds = [
      ...new Set([
        ...rows
          .filter((r) => !removedItemIds.has(r.item.id))
          .map((r) => postProductByItem.get(r.item.id) ?? r.price.productId),
        ...addResolved.map((a) => a.price.productId),
      ]),
    ];
    const kinds = await tx
      .select({ id: products.id, kind: products.kind })
      .from(products)
      .where(inArray(products.id, postProductIds));
    const planIds = kinds.filter((k) => k.kind === "plan").map((k) => k.id);
    // CAT-3 for the REQUESTED removes, against the POST-change plan set.
    // `removeSubscriptionItem` refuses to detach an add-on the plan makes mandatory and
    // this path owes the same refusal — measured against the plan the customer is MOVING
    // TO, which is what lets one atomic call do what three could not: an add-on mandatory
    // for the OUTGOING plan and not for the incoming one is removable in the same call
    // that swaps the plan, and one the NEW plan requires is refused even if the old plan
    // did not. `reconcile.ts` gets the same property by running its removals last.
    if (removedRows.length > 0) {
      const mandatoryRemoved = await findMandatoryItemIds(tx, businessId, planIds, [
        ...new Set(removedRows.map((r) => r.price.productId)),
      ]);
      for (const r of removedRows) {
        if (mandatoryRemoved.has(r.price.productId)) {
          throw new ProrationError(`You cannot remove a mandatory add-on: ${r.item.publicId}`);
        }
      }
    }
    const mandatory = await resolveMandatoryAttachedItems(tx, {
      businessId,
      planProductIds: planIds,
      currency: sub.currency,
      interval: sub.billingPeriodUnit,
      intervalCount: sub.billingPeriod ?? 1,
      existingProductIds: postProductIds,
      // Post-H (#13): durable audit on a skip (non-strict change path).
      organizationId,
      subscriptionId: sub.id,
    });
    const inserts: Array<{
      priceId: string;
      quantity: number;
      snapshot: PriceSnapshot;
      billingCycles: number | null;
      /**
       * Set for a REQUESTED add (`input.adds`), null/absent for the CAT-3 mandatory
       * expansion. It decides two things at insert time: whether the row is stamped
       * `auto_included: 'mandatory'` metadata (an operator's add is not an auto-inclusion,
       * and stamping it as one would let a later plan swap silently remove it), and where
       * the resulting item id is recorded for the one-time cycle bookkeeping.
       */
      requestKey?: string | null;
      /** A requested add that is a mandatory add-on named by the caller (`ItemAdd.autoIncluded`). */
      autoIncluded?: boolean;
    }> = [];
    for (const m of mandatory) {
      if (m.chargeOnce) continue; // one-time attached items aren't added as recurring items on change
      // ── Why no `one_time` cycle bookkeeping is owed here (verified 2026-08-04).
      // PROGRESS.md carried an open note claiming a `one_time` mandatory add-on with
      // `chargeOnce = false` reaches this loop, is charged in full, and has its cycle
      // recorded nowhere (its item id only exists in the apply transaction, after the
      // lines are built) — so a renewal would bill it again. That state is
      // unreachable: `resolveMandatoryAttachedItems` (catalog/service.ts) selects a
      // one_time price ONLY on the `chargeOnce` branch; with `chargeOnce = false` the
      // match comes from `recurringRows`, which is filtered to `type === 'recurring'`,
      // and resolves to nothing at all when the add-on has no recurring price (skipped
      // + audited). So every snapshot inserted below is recurring, has no implicit
      // one-cycle cap, and is legitimately re-rated by each renewal. If that selection
      // ever changes, this loop owes the one-time line the same three things the
      // charge loop above gives it — plain label, `kind: 'one_time'`, and the inserted
      // item id threaded to `createInvoiceFromLines({ markItemsBilled })`.
      // ── ALIGN TO THE POST-CHANGE CYCLE (F-23, 2026-08-26) ───────────────────────
      // A newly-mandatory add-on attached during a CADENCE change was snapshotted on its
      // own interval and never folded onto the new cycle, so a monthly add-on billed once
      // per YEAR at its monthly rate. Measured: two subscriptions reaching an identical end
      // state billed 180000 and 125000 — 55000/yr lost, permanently, because the snapshot
      // is frozen and every later renewal re-reads it.
      //
      // `postCycle`, not `sub.*`: on a monthly to yearly change the subscription row still
      // holds the OUTGOING cadence, and folding against it would multiply by 1. Every other
      // snapshot in this function is already aligned this way — this was the one that was
      // not. Safe to fold here only because `postCycle` is now order-independent; before
      // that it would have inherited the multi-plan non-determinism.
      const snapshot = alignSnapshotToCycle(
        snapshotPrice(
          m.price,
          m.differentialAmountMinor ?? undefined,
          m.differentialTiers ?? undefined,
        ),
        postCycle,
      );
      inserts.push({
        priceId: m.price.id,
        quantity: m.quantity,
        snapshot,
        billingCycles: m.billingCycles,
      });
      const fullAmount = fixedChargeMinor(
        snapshot,
        ratableFromSnapshot(snapshot, null),
        m.quantity,
      );
      const charge = resetTerm ? fullAmount : prorate(fullAmount, now, term.start, term.end);
      if (charge > 0n) {
        lines.push({
          // Same rule as the plan line above: on a cadence change this is a full
          // new-term charge, not a prorated one.
          description:
            resetTerm && frequencyChanged
              ? await labelFor(m.price)
              : `${await labelFor(m.price)} - Prorated Charges`,
          priceId: m.price.id,
          quantity: m.quantity,
          unitAmountMinor: charge / BigInt(m.quantity || 1),
          amountMinor: charge,
          autoIncludedAddon: true,
        });
      }
    }

    // Plan-swap REMOVAL (G backlog): an auto-included mandatory add-on that is no
    // longer mandatory for the NEW plan set is removed (the old plan's mandatory add-ons
    // go with it on a downgrade), crediting its unused (prorated) time.
    // The requested ADDS become item rows on the SAME insert pass as the mandatory
    // expansion above — one transaction, so a credit refused anywhere in this change rolls
    // every insert back with it.
    for (const a of addResolved) {
      inserts.push({
        priceId: a.price.id,
        quantity: a.qty,
        snapshot: a.snapshot,
        billingCycles: a.billingCycles,
        requestKey: a.key,
        autoIncluded: a.autoIncluded,
      });
    }

    const removals: Array<{ itemId: string }> = [];
    const autoIncludedAddons = rows.filter(
      (r) =>
        (r.item.metadata as { auto_included?: string } | null)?.auto_included === "mandatory" &&
        !updates.find((u) => u.itemId === r.item.id) &&
        // Already leaving by the caller's own request — queueing it again would delete it
        // twice and, worse, credit its unused time a second time.
        !removedItemIds.has(r.item.id),
    );
    if (autoIncludedAddons.length > 0) {
      const addonProductIds = [...new Set(autoIncludedAddons.map((r) => r.price.productId))];
      const stillMandatory = await findMandatoryItemIds(tx, businessId, planIds, addonProductIds);
      for (const r of autoIncludedAddons) {
        if (stillMandatory.has(r.price.productId)) continue;
        removals.push({ itemId: r.item.id });
        // A metered add-on's usage is settled in the apply phase (`settleMeteredUsage`).
        const snap = r.item.priceSnapshot as PriceSnapshot | null;
        if (isMeteredPrice(snap ?? r.price)) continue;
        const ratable = ratableForItem(r.item, r.price);
        const credit = prorate(
          computeLineAmount(ratable, r.item.quantity),
          now,
          term.start,
          term.end,
        );
        if (credit > 0n)
          lines.push({
            description: `Remove mandatory add-on ${r.price.publicId} (unused time)`,
            priceId: r.price.id,
            quantity: r.item.quantity,
            unitAmountMinor: -credit,
            amountMinor: -credit,
          });
      }
    }

    // The caller priced this exact request (the portal's preview): an add-on the engine
    // would add or remove on its own is a charge the customer was not shown. Refuse before
    // anything is written or collected.
    if (
      input.refuseUnrequestedItems &&
      (inserts.some((i) => i.requestKey == null) || removals.length > 0)
    )
      throw new ProrationError(
        "This change includes items that the price shown did not include. Check the new price and confirm again.",
      );

    // The requested REMOVES, on the same list the plan-swap removal above uses, so every
    // deletion is one DELETE pass inside the apply transaction. Their credit is already in
    // `lines` (non-reset) or in `resetCreditItems` (a reset credits the whole term, removed
    // items included) — never in both.
    for (const r of removedRows) removals.push({ itemId: r.item.id });

    // (Which invoices a downgrade/removal credit lands on is no longer decided here.
    // It is decided from the CREDIT LINES themselves in the apply phase — every line
    // carries the price it credits, so the notes book against the invoices that charged
    // those prices, all of them. See `issueCurrentTermCredit.targetPriceIds`; this used
    // to resolve ONE invoice, for a removes-only call detaching exactly one item.)

    // ── A PLAN SWAP RE-PRICES THE ADD-ONS THAT STAY (F-17, 2026-08-28) ─────────────
    // A differential price is scoped to (add-on, plan, currency, interval), so changing the
    // plan changes what every attached add-on is CONTRACTED at. Nothing re-resolved them:
    // the differential-aware re-snapshot covered add-ons the new plan introduces and
    // add-ons named in `changes`, never the ones already sitting there untouched.
    //
    // Two subscriptions in an identical end state therefore billed differently. Measured:
    // both on plan P2 with the same add-on at qty 5 — created directly on P2 → 900/unit,
    // subtotal 24500; created on P1 then swapped to P2 → 600/unit, subtotal 23000. 1500 a
    // month apart, permanently, and `mrr` faithfully stored the wrong one.
    //
    // The engine already re-priced on `add` and grandfathered on `change`, so it implemented
    // neither policy consistently. RULED 2026-08-28: RE-PRICE. It is what `add` already
    // does, and it is what "the price of this add-on ON THIS PLAN" means.
    //
    // ONLY when a differential actually exists for the new plan. A differential add-on
    // carries a catalog list price of 0, so falling back to the catalog when the new plan
    // has no row would re-rate a contracted 600 down to 0 and bill nothing for the life of
    // the subscription — F-16 in reverse. No row for the new plan means no contracted
    // re-price, so the existing snapshot stands.
    if (postPlanProductId) {
      // `changes` addresses items by PUBLIC id; the branch-local `changedByItemId` map is
      // out of scope here, and rebuilding it from the input is the same fact.
      //
      // ── ONLY THE ITEMS THAT ACTUALLY GOT A DELIBERATE SNAPSHOT UPSTREAM ──────────────
      // This used to exclude every item named in `changes`, on the stated grounds that they
      // "already got a differential-aware snapshot upstream". Two of the three upstream
      // branches do: a PRICE change resolves the differential, and an explicit
      // `customAmountMinor` snapshots that amount on purpose and must not be overwritten
      // here. The third — a QUANTITY-ONLY change — deliberately PRESERVES the current
      // snapshot (see the branch above), so it got nothing, and excluding it from this pass
      // too meant it fell through both.
      //
      // Measured on a live subscription: PRO → BUSINESS with the connections add-on going
      // 21 → 2 in one call kept the PRO differential (₹752/unit) on a BUSINESS plan whose
      // contracted rate is ₹470 — ₹564/month overcharged, and billed. An untouched add-on
      // on the same change would have been re-rated correctly by this very loop, so the
      // quantity was silently deciding the price.
      //
      // The invariant this restores: on a plan change, an add-on with a differential for the
      // new plan is re-rated to it — whether or not its quantity moved in the same call.
      // COMPUTED EARLIER, not here — see the hoist note where `rerated` is built. It has to
      // exist before the RESET charge loop, several hundred lines above, because that loop
      // needs it to bill the new contracted rate. This site keeps only the two consumers:
      // the snapshot merge below, and the credit/charge pair after it.
      // Same merge the cadence realign uses: an untouched item has no `updates` row at all,
      // so one is added; an item that already has a row is rewritten in place rather than
      // queued twice for the same id.
      for (const [itemId, snapshot] of rerated) {
        const existing = updates.find((u) => u.itemId === itemId);
        if (existing) {
          existing.snapshot = snapshot;
          continue;
        }
        const row = rows.find((r) => r.item.id === itemId)!;
        updates.push({ itemId, priceId: row.item.priceId, quantity: row.item.quantity, snapshot });
      }

      // ── AND BILL THE MOVE ─────────────────────────────────────────────────────────
      // Storing the new snapshot changes what RENEWS; it books nothing for the term the
      // customer is in. So an add-on re-rated by a plan change silently dropped off the
      // change entirely — its old rate never credited, its new rate never charged, while
      // the item sat at a price no document mentioned.
      //
      // The shape, measured (PRO → BUSINESS with the connections differential moving
      // 752 → 470):
      //
      //   CREDIT NOTE  27918.00 PRO plan + 752.00 Additional Connections   ← OLD rates
      //   INVOICE      56118.00 BUSINESS + 470.00 Additional Connections   ← NEW rates
      //
      // i.e. the add-on is treated exactly like the plan: credited at the old rate and
      // charged at the new one, as two documents. `rerated` on the credit line is what
      // routes it to the note — without it `upgradeCreditLines` keeps it netted onto the
      // change invoice, because a re-rate is charged under the SAME price it is credited
      // under and the priceId test cannot tell it from a quantity change.
      //
      // `settleQueued` for the same reason the changed-items loop applies it: a charge
      // already queued for this price is cancelled by the credit rather than counted twice.
      //
      // ── NOT ON A TERM RESET (money bug, 2026-08-29) ───────────────────────────────
      // A reset ALREADY bills the move, by construction: it credits the unused time of every
      // current item and charges the full new-term price for every item that survives —
      // using the snapshot just written above, so the reset's own line already carries the
      // NEW differential rate. Emitting the pair here as well bills the same add-on twice.
      //
      // Measured (PRO monthly + 10 connections + destination → PRO YEARLY, INR):
      //
      //   [1] Additional Connections ×10      9024000   ← the reset's own annualised line
      //   [3] Unused time on … ×10            -752000   ← this loop
      //   [4] Remaining time on … ×10        +9024000   ← this loop
      //
      // subtotal 50741200 against a correct 42469200 — 8272000 over, and `amountPaid`
      // confirms the customer was charged it. The reset line is right to the unit; the
      // pair is pure duplication.
      //
      // The SNAPSHOT merge above is deliberately outside this guard. It must run either way —
      // it is what makes the subscription RENEW at the new contracted rate afterwards. Only
      // the BILLING is redundant here, and only because the reset path has already done it.
      //
      // ⚠ CORRECTED 2026-08-31. This used to add "it is what makes the reset charge the new
      // contracted rate rather than the old one". It did not, and could not: the reset's
      // charge loop reads its snapshot hundreds of lines ABOVE this merge, so on the reset
      // path the charge saw the pre-re-rate value and billed the outgoing plan's differential
      // — while renewal, which reads the persisted row, was correct all along. That is why
      // the halves of the sentence disagreed. `rerated` is now computed before the reset
      // branch and the charge loop reads it directly; the merge here is unchanged.
      //
      // ── NOR WHEN `prorate: false` (2026-09-01) ───────────────────────────────────
      // One flag, and it used to get two answers: the PLAN's prorated pair was suppressed
      // (`creditUnused` above is gated on `prorate_`) while this loop billed the add-on's
      // re-rate anyway. `verify:rerate-accounting` S7 measured a change promising no
      // prorated artefacts still booking `+₹18,800 "Remaining time on Additional
      // Connections"` and crediting `₹30,080 "Unused time on …"`.
      //
      // BOTH SIDES ARE ARITHMETICALLY CONSISTENT, so it was measured rather than reasoned
      // about — two identical subscriptions differing only in `prorate`:
      //
      //   prorate=true    invoice 3193  BUSINESS 56118.00 + connections 470.00
      //                   CN-727        PRO      27918.00 + connections 752.00
      //   prorate=false   NO invoice raised, NO credit note, NO add-on line anywhere
      //
      // The differential re-rate is suppressed along with everything else, so the flag
      // means "book no prorated artefacts for this change", full stop. Ours did not.
      //
      // The SNAPSHOT merge above stays outside this guard, for the same reason it stays
      // outside the reset one: it is what makes the subscription RENEW at the new
      // contracted rate, and the re-rate applies on renewal too — arm B's subscription is
      // on BUSINESS with the add-on at the BUSINESS differential from the next term. Only the
      // BILLING of the move is a prorated artefact.
      /**
       * THE ADD-ON HALF OF THE SAME GATE (2026-09-01) — see `basisWasEverCharged`.
       *
       * `before` is the add-on's snapshot, and the snapshot MERGE above deliberately runs even
       * under `prorate: false` (it is what makes the subscription renew at the new contracted
       * rate). So a suppressed change installs a differential nobody was ever invoiced at, and
       * this loop then credits the unused time of it — the plan path's defect, one loop over,
       * worth ₹28,200 on `verify:rerate-accounting` S13.
       *
       * WHY THE PLAN IS THE RIGHT PROXY. The price-level question cannot answer this: a
       * differential add-on keeps ONE price row and only its RATE moves, so "was this price
       * charged?" says yes (the term invoice charged it at the old plan's rate). Matching on a
       * line's unit amount is not a safe substitute either — a PRORATED line carries a prorated
       * unit, so that test yields false negatives, and a false negative here withholds a credit
       * the customer is owed. But an add-on's differential is derived from the PLAN, so if the
       * outgoing plan's own price was never charged, no rate derived from it ever was. That
       * reuses the same helper, and it inherits its unbilled-term carve-out: a subscription
       * with nothing invoiced at all is not this defect.
       */
      const outgoingPlanPriceIds = rows
        .filter((r) => kindById.get(r.price.productId) === "plan")
        .map((r) => r.price.id);
      let outgoingPlanCharged = true;
      if (!resetTerm && prorate_ && rerated.size > 0 && outgoingPlanPriceIds.length > 0) {
        const checks = await Promise.all(
          outgoingPlanPriceIds.map((id) => basisWasEverCharged(tx, sub.id, id)),
        );
        outgoingPlanCharged = checks.some(Boolean);
      }
      for (const [itemId, after] of resetTerm || !prorate_ ? [] : rerated) {
        const row = rows.find((r) => r.item.id === itemId)!;
        const before = (row.item.priceSnapshot as PriceSnapshot | null) ?? snapshotPrice(row.price);
        const qty = row.item.quantity;
        const { creditMinor, chargeMinor } = nonResetItemProration({
          oldSnapshotType: before.type,
          newSnapshotType: after.type,
          oldFullMinor: outgoingPlanCharged
            ? fixedChargeMinor(before, ratableFromSnapshot(before, row.item.freeQuantity), qty)
            : 0n,
          newFullMinor: fixedChargeMinor(
            after,
            ratableFromSnapshot(after, row.item.freeQuantity),
            qty,
          ),
          billingCycles: row.item.billingCycles,
          cyclesBilled: row.item.cyclesBilled,
          now: prorationNow,
          periodStart: term.start,
          periodEnd: term.end,
        });
        const netCredit = creditMinor - (await settleQueued(row.price.id, prorationNow));
        if (netCredit > 0n) {
          lines.push({
            description: `Unused time on ${await labelFor(row.price)} ×${qty}`,
            priceId: row.price.id,
            quantity: qty,
            unitAmountMinor: -netCredit,
            amountMinor: -netCredit,
            rerated: true,
          });
        }
        if (chargeMinor > 0n) {
          lines.push({
            description: `Remaining time on ${await labelFor(row.price)} ×${qty}`,
            priceId: row.price.id,
            quantity: qty,
            unitAmountMinor: chargeMinor,
            amountMinor: chargeMinor,
          });
        }
      }
    }

    // ── TRIAL GATE (see billsAtTrialEnd) ────────────────────────────────────
    // Everything above is still resolved — the item updates/inserts/removals and
    // the post-change cadence all apply — but every MONEY artefact is dropped:
    // no proration lines, no unused-term credit. With both lists empty the apply
    // phase below books the composition change and then returns
    // { prorationInvoice: null, creditNote: null, payment: null }.
    //
    // `unbilledSettlements` passes through rather than being emptied: it is not a money
    // artefact this change is creating, it is the cancellation of a charge queued
    // EARLIER for an item that is being detached. (In practice it is always empty on a
    // trial — `addSubscriptionItem` bills nothing during one, so there is nothing queued
    // to re-cut — but leaving an orphan here would be the same defect this closes.)
    if (billsAtTrialEnd(sub)) {
      return {
        sub,
        lines: [],
        updates,
        inserts,
        removals,
        resetTerm,
        newPeriodEnd,
        newInterval,
        newIntervalCount,
        resetCreditItems: [],
        resetStart,
        resetAnchorDay,
        prorationNow,
        allItemIds: rows.map((r) => r.item.id),
        inTrial: true,
        bizMode,
        unbilledSettlements,
        postMonthlyUsage,
        postCommitmentMinor,
        movedPlan,
      };
    }
    return {
      sub,
      lines,
      updates,
      inserts,
      removals,
      resetTerm,
      newPeriodEnd,
      newInterval,
      newIntervalCount,
      resetCreditItems,
      resetStart,
      resetAnchorDay,
      prorationNow,
      allItemIds: rows.map((r) => r.item.id),
      inTrial: false,
      bizMode,
      unbilledSettlements,
      postMonthlyUsage,
      postCommitmentMinor,
      movedPlan,
    };
  });

  // Apply the item changes (always — even if net is 0, the plan/qty changed) AND,
  // when this change owes the customer money, issue that credit note on the SAME
  // handle.
  //
  // ── ATOMICITY (2026-08-03). The credit used to be issued AFTER this transaction
  // committed, in a transaction of its own. `issueCurrentTermCredit` can legitimately
  // REFUSE — the refundable-CN cap rejects a full-term credit whose source invoice
  // only ever collected a small prior proration — and when it did, the subscription
  // was already downgraded with NOTHING credited: the customer silently lost money
  // they were owed, and the caller got a 500 that invited a retry. Both credit paths
  // (net<0 downgrade, term-reset unused-term credit) therefore run inside this
  // transaction now, so the item change and the credit it owes are one unit: a
  // refused credit rolls the item change back and surfaces as a 400.
  // The CHARGE side deliberately stays outside — `createInvoiceFromLines` collects
  // from the gateway, and a network call must never be held open inside a DB tx.
  //
  // ── INVOICING OPTION: invoice now, or book to unbilled charges ───────────────
  // `invoice_immediately` on the change screen. Decided here rather than
  // at the route so every caller obeys one rule — the `/change` route, the dashboard
  // action, and the scheduled-change applier (which carries no per-change choice of
  // its own: `scheduled_changes` has no column for one, so a change deferred to a
  // date always invoices when it lands, and the change page says so instead of
  // offering a control the schedule cannot carry).
  //
  // OMITTED resolves to `businesses.default_invoice_immediately` (2026-08-19,
  // operator ruling). Until then this read `input.invoiceImmediately === false` and
  // an omission always invoiced — while Settings › Billing LogIQ › Update
  // subscription advertised that very column as *"Invoice plan-change charges
  // immediately"*, with help text promising that OFF meant "change charges accumulate
  // as unbilled and are billed at the next renewal". The column ships `false`, so the
  // screen was describing the opposite of what the engine did, on a money-moving
  // setting.
  //
  // Resolved HERE, before the apply transaction, and not at its use site below,
  // because the downgrade branch inside that transaction has to know the answer: what
  // shape a credit may take depends on whether the charge that offsets it is going to
  // be invoiced in this same request. See the gross-vs-net note there.
  const invoiceImmediately =
    input.invoiceImmediately ??
    (await defaultInvoiceImmediately(organizationId, businessId, "onChange"));
  const applied = await withTenant(organizationId, async (tx) => {
    // ── Bugs #8: OPTIMISTIC LOCK on the subscription (CP-0 idiom, `bump_row_version`).
    // The read phase above computed this whole change — the credit for the old term,
    // the charge for the new one, the mandatory add-ons to auto-include — from a
    // SNAPSHOT of the subscription and its items. If another writer changed the
    // subscription in between, that arithmetic describes a state that no longer
    // exists, and applying it bills the customer for a change that was already made.
    // Two concurrent identical plan swaps used to BOTH apply and BOTH invoice
    // (verify:hardening-h H3: one add-on item, but two add-on charges — plus a
    // duplicate full plan charge nobody had noticed).
    //
    // This is a conditional write, not a read-then-check: exactly one UPDATE can
    // match `resource_version = <version we read>`, because the BEFORE UPDATE
    // trigger bumps it. Under READ COMMITTED the loser blocks on the winner's row
    // lock, re-evaluates the predicate after it commits, matches 0 rows, and throws
    // — as the FIRST statement of this transaction, so nothing is applied and no
    // invoice is ever created. A later (fully serialized) retry re-reads the new
    // state and correctly computes a no-op.
    // Checked before the claim, so a refused key applies nothing.
    await enforceMetadataRules(tx, input.businessId, "subscription", input.metadata, {
      mode: "update",
      existing: plan.sub.metadata as Record<string, unknown> | null,
      scope: input.metadataRules,
    });
    const claimed = await tx
      .update(subscriptions)
      .set({
        updatedAt: now,
        // Folded into the CLAIM rather than written as a later statement, so it inherits
        // the same optimistic lock: a concurrent change makes this match 0 rows and the
        // metadata is not written either. `!== undefined` keeps `null` (an explicit
        // clear) distinct from omission (leave it alone).
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      })
      .where(
        and(
          eq(subscriptions.id, plan.sub.id),
          eq(subscriptions.resourceVersion, plan.sub.resourceVersion),
        ),
      )
      .returning({ id: subscriptions.id });
    if (claimed.length === 0) {
      throw new ProrationConflictError(
        "Another request changed the subscription at the same time. We did not apply the change. Retry the request.",
      );
    }
    // 0149: the record BEFORE any item write below. A plan or quantity change IS an
    // item change, so a snapshot taken after the loops would report no change at all —
    // and this is the action an operator most often needs to see the old value of.
    // Taken after the optimistic lock so it reflects the state the change is applied
    // to, and inside this transaction so a conflict leaves no audit row behind.
    const beforeFull = await subscriptionSnapshot(tx, plan.sub);

    // AFTER the snapshot (so the event diff still reports the discount as a change) and
    // BEFORE the item operations and the invoice below — see the `couponCode` note above.
    // `suppressSubscriptionChanged`: this change emits ONE summary event; a discount that
    // announced its own would make a single operator press produce two.
    if (input.removeDiscount) {
      const { removeDiscountInTx } = await import("@/modules/coupons/service");
      await removeDiscountInTx(tx, {
        organizationId,
        subscriptionId: plan.sub.id,
        suppressSubscriptionChanged: true,
      });
    }
    // `plan_change_coupons`: coupons the new plan leaves behind, before the change bills.
    if (plan.movedPlan) {
      const { couponsLeftBehind } = await import("./plan-change-coupons");
      const drop = await couponsLeftBehind(tx, {
        businessId,
        subscriptionId: plan.sub.id,
        newPlan: { productId: plan.movedPlan.productId, pricePublicId: plan.movedPlan.publicId },
        ...(input.planChangeCoupons ? { rule: input.planChangeCoupons } : {}),
      });
      if (drop.length) {
        const { removeDiscountInTx } = await import("@/modules/coupons/service");
        for (const code of drop)
          await removeDiscountInTx(tx, {
            organizationId,
            subscriptionId: plan.sub.id,
            couponPublicId: code,
            suppressSubscriptionChanged: true,
          });
      }
    }
    if (input.couponCode) {
      const { applyCouponToSubscription } = await import("@/modules/coupons/service");
      await applyCouponToSubscription({
        organizationId,
        businessId,
        subscriptionId: plan.sub.id,
        code: input.couponCode,
        now,
        tx,
        suppressSubscriptionChanged: true,
        ...(input.deferEventsTo ? { deferEventsTo: input.deferEventsTo } : {}),
      });
    }
    if (input.manualDiscount) {
      const { applyManualDiscount } = await import("@/modules/coupons/service");
      await applyManualDiscount({
        organizationId,
        businessId,
        subscriptionId: plan.sub.id,
        kind: input.manualDiscount.kind,
        percentOffBps: input.manualDiscount.percentOffBps,
        amountOffMinor: input.manualDiscount.amountOffMinor,
        currency: plan.sub.currency,
        durationType: input.manualDiscount.durationType ?? "forever",
        now,
        tx,
      });
    }

    // Usage this change stops measuring: a removed item's open window, or every metered
    // item's window up to a term reset (the new term measures from `resetStart`).
    await settleMeteredUsage(
      tx,
      plan.sub,
      plan.resetTerm ? plan.allItemIds : plan.removals.map((r) => r.itemId),
      plan.resetTerm ? plan.resetStart : now,
    );
    // The prices the changed items leave, for the plan credits' change rules (G3b §3.6).
    const before = plan.updates.length
      ? await tx
          .select({
            itemId: subscriptionItems.id,
            oldPriceId: subscriptionItems.priceId,
            oldQuantity: subscriptionItems.quantity,
          })
          .from(subscriptionItems)
          .where(
            inArray(
              subscriptionItems.id,
              plan.updates.map((u) => u.itemId),
            ),
          )
      : [];
    for (const u of plan.updates) {
      await tx
        .update(subscriptionItems)
        .set({ priceId: u.priceId, quantity: u.quantity, priceSnapshot: u.snapshot })
        .where(eq(subscriptionItems.id, u.itemId));
    }
    // Plan-swap: remove auto-included mandatory add-ons no longer required.
    for (const rem of plan.removals) {
      await tx.delete(subscriptionItems).where(eq(subscriptionItems.id, rem.itemId));
    }
    // The charge side of those removals: re-cut each detached item's still-pending
    // deferred charge to the span it was actually held (money bug, 2026-08-24). On this
    // handle, so the re-cut charge, the deletion and the netted credit commit together —
    // a credit the refundable cap refuses must not leave a charge already trimmed.
    await applyUnbilledChargeSettlements(tx, {
      organizationId,
      businessId,
      settlements: plan.unbilledSettlements,
    });
    // CAT-3: insert auto-included mandatory add-on items (immutable snapshot).
    // onConflictDoNothing on the (subscription_id, price_id) unique index makes a
    // concurrent change / retried apply idempotent (G backlog: no double-insert).
    // Post-H (#3): if the insert is SKIPPED by the conflict (the item already
    // exists — a concurrent change won the race), we must NOT bill this call's
    // proration line for it, or one item gets charged twice. Track the skipped
    // price ids and drop their lines below.
    const skipped = new Set<string>();
    // Where each REQUESTED add landed, keyed by its line's `requestedAddKey`. Needed once
    // this transaction has committed: the item id does not exist while the lines are built,
    // and a one-off billed outside the period planner must hand its id to
    // `createInvoiceFromLines({ markItemsBilled })` or the next renewal bills the fee again.
    const insertedByRequestKey = new Map<string, string>();
    const skippedRequestKeys = new Set<string>();
    for (const ins of plan.inserts) {
      const res = await tx
        .insert(subscriptionItems)
        .values({
          organizationId,
          businessId,
          subscriptionId: plan.sub.id,
          publicId: publicId("si"),
          priceId: ins.priceId,
          quantity: ins.quantity,
          priceSnapshot: ins.snapshot,
          billingCycles: ins.billingCycles ?? null,
          // An operator's add carries no metadata at all — exactly what `addSubscriptionItem`
          // writes. Only the CAT-3 expansion stamps `auto_included`, which is also the
          // predicate of the partial unique index the conflict clause relies on (so the
          // clause is inert for a requested add, and its row is never silently dropped).
          ...(ins.requestKey && !ins.autoIncluded
            ? {}
            : { metadata: { auto_included: "mandatory" } }),
        })
        .onConflictDoNothing()
        .returning({ id: subscriptionItems.id });
      if (res.length === 0) {
        if (ins.requestKey) skippedRequestKeys.add(ins.requestKey);
        else skipped.add(ins.priceId);
      } else if (ins.requestKey) insertedByRequestKey.set(ins.requestKey, res[0]!.id);
    }
    // Plan change and scheduled-change apply: freeze meter rate cards, guard the meters.
    await syncMeterBilling(tx, plan.sub.id);
    // TERM RESET: restart the period from now, re-align billingPeriod(Unit) to
    // the post-change plan cadence. The billing clock renews off current_period_end
    // (a scan, not a per-subscription job — see README "Billing-clock tick order"),
    // so moving this column IS the reschedule; nothing else to touch.
    if (plan.resetTerm) {
      await tx
        .update(subscriptions)
        .set({
          // IN TRIAL the "current term" IS the trial window (currentPeriodEnd =
          // trialEnd), so re-anchoring it hands the customer a whole extra free
          // period: a monthly→yearly swap during a 14-day trial moved
          // current_period_end a YEAR out and the sub stayed `in_trial` until then,
          // because the billing clock renews off current_period_end. Keep the trial
          // window exactly as promised and only re-cadence — the post-trial term is
          // then one NEW interval from trial end (renewSubscription reads the
          // SUBSCRIPTION's cadence, which the two lines below keep correct).
          // Found by verify:trial-change, 2026-08-03.
          ...(plan.inTrial
            ? {}
            : {
                currentPeriodStart: plan.resetStart,
                currentPeriodEnd: plan.newPeriodEnd,
                // The anchor has to follow the term it anchors. `billing_anchor_day` was
                // written once at create and never again, so after a reset moved the term
                // start it still named the OLD day of the month — and `advancePeriod`
                // dutifully re-aligned every later renewal onto it. Measured 2026-08-23: a
                // term reset from an 08-Aug subscription to 23-Aug renewed 2027-08-23 →
                // 2028-08-**08**, a 351-day "year", and every renewal after it stayed on
                // the 8th. Re-anchoring to the new term start's LOCAL day of the month is
                // what `createSubscription` does for a fresh term (service.ts:742), so a
                // reset term is anchored the same way a new one is.
                // The SAME value the boundary computation used — see `resetAnchorDay`. These
                // were two copies of one expression and they drifted, which is the whole
                // defect: the term end was computed from the old anchor while the new one
                // was persisted here.
                billingAnchorDay: plan.resetAnchorDay,
              }),
          billingPeriod: plan.newIntervalCount,
          billingPeriodUnit: plan.newInterval,
        })
        .where(eq(subscriptions.id, plan.sub.id));
    }
    // Monthly usage billing and the commitment: a reset term starts fresh; otherwise a
    // commitment change is a new segment from now.
    {
      const newTerm = plan.resetTerm && !plan.inTrial;
      const termStart = newTerm ? plan.resetStart : plan.sub.currentPeriodStart;
      const termEnd = newTerm ? plan.newPeriodEnd : plan.sub.currentPeriodEnd;
      const commitmentChanged =
        String(plan.postCommitmentMinor) !== String(plan.sub.commitmentAmountMinor);
      const subPeriod = subPeriodFields(
        {
          billUsageMonthly: plan.postMonthlyUsage,
          billingPeriodUnit: plan.newInterval,
          billingPeriod: plan.newIntervalCount,
          billingAnchorDay: newTerm ? plan.resetAnchorDay : plan.sub.billingAnchorDay,
        },
        termStart,
        termEnd,
        plan.bizMode,
      );
      if (newTerm || commitmentChanged || plan.postMonthlyUsage !== plan.sub.billUsageMonthly) {
        await tx
          .update(subscriptions)
          .set({
            billUsageMonthly: plan.postMonthlyUsage,
            // A flag flipped at the term end takes effect at the renewal claim.
            ...(newTerm ? subPeriod : {}),
            commitmentAmountMinor: plan.postCommitmentMinor,
            commitmentSegments: newTerm
              ? freshSegments(plan.postCommitmentMinor, termStart)
              : commitmentChanged && termStart
                ? appendSegment(termSegments(plan.sub, termStart), now, plan.postCommitmentMinor)
                : plan.sub.commitmentSegments,
          })
          .where(eq(subscriptions.id, plan.sub.id));
      }
    }
    // CACHED MRR (bug, 2026-08-03): `subscriptions.mrr` is the figure the
    // subscriptions list shows, sorts and filters on — and NOTHING on this path
    // ever recomputed it, so every quantity / price / cadence change left it
    // reporting the pre-change revenue (measured: an addon 6→7 at 20000 left mrr
    // 20000 low). Runs HERE, after the item updates/inserts/removals AND the
    // term-reset cadence write, because `computeSubscriptionMrr` normalizes each
    // item's snapshot interval to a monthly figure — a monthly→yearly swap
    // restates MRR and must be read post-write. Same recompute the add/remove
    // paths call (items.ts), on this transaction, so a rolled-back change can
    // never leave the cached column describing items that were never applied.
    // Dated where the money is: a reset takes effect at the new term's start, a
    // mid-term change at the instant it prorates from.
    await recomputeSubscriptionMrr(
      tx,
      plan.sub.id,
      plan.resetTerm ? plan.resetStart : plan.prorationNow,
    );
    {
      const { applyPlanChangeCredits } = await import("@/modules/credits/credit-clock");
      await applyPlanChangeCredits(tx, {
        subscriptionId: plan.sub.id,
        now: plan.resetTerm ? plan.resetStart : plan.prorationNow,
        termReset: !!plan.resetTerm && !plan.inTrial,
        changes: before,
        ...(input.resetOverrides ? { overrides: input.resetOverrides } : {}),
      });
    }
    await emitOrDefer(
      tx,
      {
        organizationId,
        businessId,
        type: "subscription_changed",
        data: buildEventData(
          "subscription_changed",
          { id: plan.sub.publicId, status: plan.sub.status },
          plan.sub.resourceVersion,
        ),
      },
      input.deferEventsTo,
    );
    // Re-read rather than reusing `plan.sub`: this path writes the term reset, the
    // cadence and the cached MRR above, none of which are on the row we planned from.
    const [current] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, plan.sub.id))
      .limit(1);
    if (current) {
      await auditSubscription(tx, {
        organizationId,
        businessId,
        action: "subscription.change",
        before: beforeFull,
        after: current,
      });
    }

    // ── The money, decided INSIDE this transaction so a refused credit vetoes
    // the writes above rather than stranding them.
    //
    // Post-H (#3): drop the mandatory-addon proration lines whose insert conflicted
    // (already present) — otherwise a change bills the same add-on twice. Second line
    // of defence behind the optimistic lock above: it also covers an add-on inserted
    // by a DIFFERENT path (e.g. addSubscriptionItem) between our read and apply.
    // Keys off the line's `autoIncludedAddon` tag — the previous version matched on a
    // `'Mandatory add-on '` description prefix that this code has never emitted, so
    // the guard was dead and every skipped insert was still billed.
    const billableLines = plan.lines.filter(
      (l) =>
        !(l.autoIncludedAddon === true && skipped.has(l.priceId)) &&
        // An ADD whose insert did not land must not be billed either — the same second line
        // of defence, for the same reason: a line with no item behind it charges for
        // something the subscription does not have.
        !(l.requestedAddKey != null && skippedRequestKeys.has(l.requestedAddKey)),
    );
    const net = billableLines.reduce((s, l) => s + l.amountMinor, 0n);

    // In trial the read phase emptied both money lists, so this is the exit taken —
    // the composition change is applied and NOTHING is billed or credited. Asserted
    // rather than implied: a future line-producing branch must not leak a charge into
    // a free trial (verify:trial-change A2/D1).
    // A reset ends the old term early: its prorated commitment true-up rides the next invoice.
    if (plan.resetTerm && !plan.inTrial && (billableLines.length === 0 || net === 0n))
      await bookEarlyEndCommitment(tx, plan.sub, plan.resetStart, plan.bizMode);
    if (plan.inTrial || billableLines.length === 0 || net === 0n) {
      return {
        billableLines,
        net,
        downgradeCreditNote: [] as CreditNote[],
        resetCreditNote: [] as CreditNote[],
        insertedByRequestKey,
      };
    }

    // ── Downgrade (net < 0): we owe the customer. Issue a real credit note against
    // the current-term invoice — NOT a negative "credited" invoice (ADR-009 style,
    // matches change_term_end + cancellation). Per-item "Prorated Credits" lines.
    // Adjustment vs refundable split is handled by the helper.
    //
    // ── CREDIT GROSS, THEN BILL THE NEW TERM (2026-08-24) ────────────────────────
    // This used to NET the two sides when the change also produced a charge: the
    // unused-old and the new-term lines collapsed into ONE credit item worth `-net`,
    // and no invoice was raised for the new term at all. That is the wrong shape, and
    // on a tax-plus-promotional-credit term it is not even the same money.
    //
    // Measured (scripts/probe-change-promo-tax-retention.ts), day-anchored INR
    // business, IGST 18%, promo grant 1000000, pro 2791800 → lite 911800 same day.
    // Invoice #1 books subtotal 2791800, promo applied PRE-tax so the taxable base is
    // 1791800, IGST 322524, total 3114324, cash 2114324.
    //   netted   → one credit item of 1880000. `creditOneInvoice` reverses tax at the
    //              invoice's BLENDED effective rate (322524/2791800 = 11.5525%, low
    //              because the promo already shrank the base) on only the credited
    //              FRACTION → 217188, credit 2097188, split 673400 promo /
    //              1423787 refundable. Customer holds 2097187.
    //   grossed  → the WHOLE term is credited (2791800 + all 322524 of tax = 3114324,
    //              split 1000000 promo / 2114324 refundable) and the new term is
    //              billed as its own invoice, where the returned promotional credit
    //              re-applies PRE-tax: subtotal 911800, taxable base 0, tax 0.
    //              Customer holds 88200 promo + 2114324 refundable = 2202524.
    // 105337 of the customer's money, and 618990 of it in the wrong bucket, purely
    // because netting hid a taxable supply inside a credit.
    //
    // So: credit the credit lines GROSS, and let the charge lines fall through to the
    // ordinary invoice path below (the credit note commits with this transaction, so
    // its restored balances are visible to that invoice's `applyCredit` draw — the
    // same ordering the term-reset branch relies on).
    //
    // ── ONLY WHEN THE TERM'S INVOICE CAN ACTUALLY ABSORB IT ──────────────────────
    // Grossing up is safe exactly while the gross credit is placeable. It is not
    // always: `issueCurrentTermCredit` books an ITEM-SPECIFIC credit against ONE
    // invoice (see its `wholeTerm` note — spreading an item credit across a term's
    // invoices puts lines on invoices that never charged the item), and
    // `splitCreditByFunding` then clamps the cashable slice to that invoice's own
    // funding. Where the gross credit exceeds it the surplus is silently dropped —
    // while the new term's charge is billed in full, so the customer pays for time
    // they were just credited for. Measured 2026-08-24 on a term billed across two
    // invoices (a 1000 term bill + a 1000 qty-upgrade proration, then a downgrade
    // whose unused old quantity is worth 1500): the gross credit clamped to the
    // newest invoice's 1000, the 500 new-term charge was billed anyway, and the
    // customer was left 500 out of pocket against the netted result.
    //
    // ── AND ONLY WHEN THE OFFSETTING CHARGE IS INVOICED IN THE SAME REQUEST ─────
    // Grossing splits one net credit into a full-term credit NOW plus a charge for the
    // time being kept. That charge becomes an invoice only when this change invoices
    // immediately. When `invoice_immediately` resolves FALSE — and it does by default,
    // `businesses.default_invoice_immediately` ships `false` — the charge is queued as
    // an UNBILLED CHARGE for the next renewal instead, and grossing then hands the
    // customer the whole unused term back as cashable refundable credit while the time
    // they are keeping is not billed at all.
    //
    // Measured 2026-08-24 (verify:credit, the scenario that caught this): a 3000/mo
    // term for 3 seats, invoiced and collected in cash, downgraded to 1 seat at
    // mid-term. Grossed with no immediate invoice → credit note 1500 and a 500 unbilled
    // charge, refundable balance 1500. Netted → credit note 1000, nothing outstanding,
    // refundable balance 1000. The two agree on the customer's NET position only once
    // the unbilled charge is actually billed (at renewal it was: a 1500 renewal
    // invoice, fully covered, balance 0) — but refundable credit is cashable ON DEMAND
    // before then, so the grossed shape leaves 500 of money we are still owed sitting
    // in a bucket the customer can ask back in cash. That is the same hazard as the
    // clamp above, with the signs swapped.
    //
    // And there is nothing to trade away for it: the bucket + tax fix grossing buys is
    // earned entirely ON the second INVOICE (the returned promotional credit has to
    // re-apply to it PRE-tax). No second invoice, no gain — only the exposure.
    //
    // So the shape is chosen, not assumed: gross when the money can be returned AND
    // the offsetting charge is billed now; otherwise the pre-2026-08-24 netting, byte
    // for byte. Both leave the customer in the same net position; only the gross one
    // can also fix the bucket + tax split.
    if (net < 0n) {
      const creditLines = billableLines.filter((l) => l.amountMinor < 0n);
      const hasCharges = billableLines.some((l) => l.amountMinor > 0n);
      // The prices this credit is FOR — every credit line carries the price whose unused
      // time it hands back (the OLD price on a swap). The notes therefore book against
      // the invoices that actually charged them, all of them, each from its own lines:
      // see `issueCurrentTermCredit.targetPriceIds`. This replaces a rule that only
      // attributed a removes-only call detaching exactly one item, and only to ONE
      // invoice — every other downgrade fell back to "the newest live invoice", which on
      // a term billed across several invoices is the wrong document AND the wrong cap.
      // Measured 2026-08-24: a 6→5 downgrade of a 20000/unit plan whose term also
      // carried a 500 add-on proration credited 500 against the ADD-ON's invoice and
      // silently dropped the other 19500.
      const creditTargetPriceIds = [...new Set(creditLines.map((l) => l.priceId))];
      // ── ONE WORDING FOR A CREDIT LINE, AND ONE WINDOW ───────────────────────────
      // `creditedDescription` is the single phrasing for "this hands back the unused
      // part of X" and every other credit path already uses it. This builder instead
      // appended "— prorated credit" to the CHARGE line's own wording, so the same
      // operation produced three different strings depending on which path ran:
      // "Unused time on BUSINESS plan ×1" (multi-invoice split), "Unused time on PRO
      // plan" (reset), "Unused time on BUSINESS plan ×1 — prorated credit" (here).
      // Measured on sub_XXXXXXXXXXXXXXXXXXXXXX01, CN-1689 vs CN-1703 vs CN-1668.
      //
      // Our wording deliberately names the quantity and the side of the proration,
      // rather than a bare "… - Prorated Credits for 31-Aug-2026 - 25-Sep-2026". Being
      // INTERNALLY inconsistent was never part of the decision.
      const grossItems = creditLines.map((l) => ({
        description: creditedDescription(l.description),
        amountMinor: -l.amountMinor,
        priceId: l.priceId,
      }));
      const grossTotal = grossItems.reduce((s, i) => s + i.amountMinor, 0n);
      // With no charge to separate out, gross IS the netted shape (`-net` equals the
      // credit lines), so the question does not arise and no extra read is made.
      const grossed =
        !hasCharges ||
        (invoiceImmediately &&
          (await termInvoiceCanAbsorb({
            organizationId,
            businessId,
            subscription: plan.sub,
            targetPriceIds: creditTargetPriceIds,
            preTaxMinor: grossTotal,
            tx,
          })));
      const items = grossed
        ? grossItems
        : [{ description: "Prorated credit for subscription change", amountMinor: -net }];
      const downgradeCreditNote = await issueCurrentTermCredit({
        organizationId,
        businessId,
        subscription: plan.sub,
        items,
        reasonCode: "subscription_change",
        reason: "Prorated credit for subscription change",
        targetPriceIds: creditTargetPriceIds,
        creditedPeriod: changeCreditedPeriod(plan),
        tx,
      });
      return {
        billableLines,
        net,
        downgradeCreditNote,
        downgradeGrossed: grossed,
        resetCreditNote: [] as CreditNote[],
        insertedByRequestKey,
      };
    }

    // ── Upgrade (net > 0), SAME-CADENCE (no term reset) ─────────────────────────
    // Root 2 of the 2026-08-25 full-suite run (49 failures). Without this the
    // `Unused time on …` line — NEGATIVE, built at :1806 — stayed in `billableLines`
    // and was netted onto the new invoice. The correct report is
    // `lines=1 · total=59700 · creditsApplied=29700 · creditNotes=1`; we reported
    // `lines=2 · lines[0]=-29700 · total=30000 · creditsApplied=0`.
    //
    // NOT a presentation difference — netting LOSES A DISCOUNT. With a 10% coupon the
    // customer owes (59700 × 0.9) − 26730 = 27000, but `59700 − 29700 = 30000` never
    // lets the percentage reach the new charge, because by then the two are one lump.
    // Measured overcharges: +3000, +5970 and +96000.
    //
    // Same mechanism as the `net < 0` branch above: credit the old term FIRST, inside
    // this transaction, so `createInvoiceFromLines(applyCredit)` draws it onto the new
    // FULL-PRICE invoice as `creditsApplied` — and the coupon lands on the charge before
    // the credit does. Also emits credit_note_created / customer_changed /
    // invoice_updated, the event set for this shape.
    //
    // ⚠ PRICE SWAPS ONLY. A QUANTITY change must keep the netted shape — measured:
    // moving a per-unit add-on from ×1 to ×4 raises ONE invoice for
    // `USD 150.00 qty=3 "… - Prorated Charges"` with NO credit note, NO negative line
    // and NO credits_applied. It bills the ADDED UNITS, it does not credit the old
    // quantity and re-bill the new one. Our netting already lands on the identical
    // total, so generalising the credit-note shape here would have been WRONG — and
    // would have "fixed" `verify-change-atomicity`'s 19500-delta fixture, which is
    // right as written.
    //
    // The two are separable from the lines alone: a swap credits price X and charges
    // price Y, while a quantity/rate change credits and charges the SAME price. So only
    // a negative line whose price is NOT among the charges becomes a credit note.
    let upgradeCreditNote: CreditNote[] = [];
    let upgradeGrossed = false;
    const chargedPriceIds = new Set(
      billableLines.filter((l) => l.amountMinor > 0n).map((l) => l.priceId),
    );
    // `rerated` overrides the priceId test: a re-rated add-on is charged under the SAME
    // price it is credited under, so the test alone would keep its credit netted onto the
    // change invoice — see the flag's own note.
    const upgradeCreditLines = billableLines.filter(
      (l) => l.amountMinor < 0n && (l.rerated === true || !chargedPriceIds.has(l.priceId)),
    );
    const upgradeCreditedPriceIds = upgradeCreditLines.map((l) => l.priceId);
    if (plan.resetCreditItems.length === 0 && upgradeCreditLines.length > 0 && invoiceImmediately) {
      const upgradeTargetPriceIds = [...new Set(upgradeCreditLines.map((l) => l.priceId))];
      upgradeCreditNote = await issueCurrentTermCredit({
        organizationId,
        businessId,
        subscription: plan.sub,
        // Same single wording and same credited window as the downgrade builder above.
        items: upgradeCreditLines.map((l) => ({
          description: creditedDescription(l.description),
          amountMinor: -l.amountMinor,
          priceId: l.priceId,
        })),
        reasonCode: "subscription_change",
        reason: "Prorated credit for subscription change",
        targetPriceIds: upgradeTargetPriceIds,
        creditedPeriod: changeCreditedPeriod(plan),
        tx,
      });
      // No creditable invoice to attach to (pending / voided / zero-total, or the term
      // was never billed): keep the pre-2026-08-25 netting byte for byte rather than
      // drop a credit the customer is owed. Only a note that actually exists may remove
      // the negative lines from the invoice.
      upgradeGrossed = upgradeCreditNote.length > 0;
    }

    // ── Upgrade (net > 0), TERM RESET only — the unused old term
    // is booked as a credit note (issued against the paid old-term invoice →
    // refundable balance) BEFORE the new invoice is created, so
    // createInvoiceFromLines(applyCredit) draws it onto the new invoice
    // (creditsApplied) instead of netting it as invoice lines. The CN create +
    // allocation also fire credit_note_created / customer_changed / invoice_updated
    // (via credit-notes/service emitters).
    // A plan DOWNGRADE swap lands here too (term reset charges the full new plan, so
    // net > 0) — which is exactly why this credit belongs in the transaction: its
    // refusal used to leave the sub swapped onto the cheaper plan with the old term's
    // money neither credited nor charged.
    let resetCreditNote: Awaited<ReturnType<typeof issueCurrentTermCredit>> = [];
    if (plan.resetCreditItems.length > 0) {
      resetCreditNote = await issueCurrentTermCredit({
        organizationId,
        businessId,
        subscription: plan.sub,
        items: plan.resetCreditItems,
        reasonCode: "subscription_change",
        reason: "Unused time credited on plan change",
        // A reset credits EVERY item's unused time, so this is the one caller whose
        // credit may be spread across the term's invoices (D1).
        wholeTerm: true,
        // The reset's window starts at `resetStart` (the new term's start), which is
        // exactly the boundary the amounts were cut on — see `creditUnused` in the plan
        // phase — and ends at the OLD term end, because that is what the credited
        // invoices billed. NOT `newPeriodEnd`: the new term is what gets CHARGED.
        creditedPeriod: changeCreditedPeriod(plan),
        tx,
      });
    }

    // No credit note could be attached (`issueCurrentTermCredit` found no live
    // invoice to credit against). The caller then falls back to booking the
    // unused-term credit as NEGATIVE invoice lines — which is fine while the credit
    // is smaller than the new charge, and catastrophic when it is not.
    //
    // On any plan-swap DOWNGRADE it is not: the old term's unused time (3000) exceeds
    // the full new-plan charge (1000), the fallback lines drive the invoice subtotal
    // negative, and `createInvoiceFromLines` throws a bare `Error` — AFTER this
    // transaction has committed. Measured: the subscription came out swapped onto the
    // cheaper plan with its MRR restated, no invoice, no credit note, and a 500 to the
    // caller. Silent corruption, and the retry re-runs a change that has already been
    // applied.
    //
    // Decided HERE, inside the transaction, so a rejection rolls the item change back
    // instead of stranding it.
    if (plan.resetTerm && !plan.inTrial)
      await bookEarlyEndCommitment(tx, plan.sub, plan.resetStart, plan.bizMode);
    let resetCreditDropped = false;
    if (plan.resetCreditItems.length > 0 && resetCreditNote.length === 0) {
      const [everBilled] = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(eq(invoices.businessId, businessId), eq(invoices.subscriptionId, plan.sub.id)))
        .limit(1);
      const creditTotal = plan.resetCreditItems.reduce((s, i) => s + i.amountMinor, 0n);
      if (!everBilled) {
        // The term was never invoiced, so no money was ever taken for it and there is
        // nothing to give back. Crediting unused time on a term the customer was never
        // charged for invents money. Drop it and bill the new plan alone — this is the
        // never-billed subscription (an import with no invoice history, an offline
        // subscription whose first invoice has not been raised).
        resetCreditDropped = true;
      } else if (creditTotal > net) {
        // An invoice EXISTS but no credit note could be attached to the term, so the
        // money is real and in flight — dropping the credit would keep money the
        // customer is owed. We cannot net it onto this invoice either. Refuse, in this
        // module's taxonomy so the caller gets a 400 naming the reason rather than a
        // 500 that invites a retry.
        //
        // ── THE MESSAGE HAS TO NAME THE CONDITION THAT ACTUALLY FAILED (2026-09-01) ──
        // It used to read "the term's invoice cannot be credited (it is pending or
        // voided). Settle or void that invoice first, or cancel and re-subscribe." Both
        // halves were wrong, and an operator acts on this text.
        //
        // WRONG CONDITION. Pending/voided is only ONE of the ways `issueCurrentTermCredit`
        // returns nothing. Reading it: no live invoice at all (every row voided, pending,
        // or zero-total → `live.length === 0`); or a live invoice whose credit
        // `creditOneInvoice` declined because the split had nothing cashable AND nothing
        // to hand back to a bucket — "reachable only when the invoice was settled by
        // neither cash nor credit — e.g. fully withheld or written off", and equally when
        // its capacity has already been spent by earlier notes; or, on this whole-term
        // path, an invoice with no chargeable lines / a non-positive subtotal. A PAID,
        // fully-credited invoice lands here and is told it is "pending or voided".
        //
        // WRONG ADVICE, and actively harmful. "Void that invoice" GUARANTEES the failure
        // forever: `issueCurrentTermCredit` filters `voided` out of `live` before it looks
        // at anything, so voiding removes the only document the credit could ever attach
        // to. "Settle it" does nothing for the already-paid case and is not even the
        // operation a `pending` invoice needs (pending is "open, still accreting lines" —
        // it has to be CLOSED, not paid). And "cancel and re-subscribe" throws away the
        // term, the schedule and the subscription id to work around a proration artefact.
        //
        // WHAT ACTUALLY WORKS, and is why the actions below are the ones named:
        //   · `prorate: false` — measured in the reset branch of the plan phase above:
        //     "freq change + prorate=false → term resets, 6000 charged, no credit note".
        //     `creditUnused` becomes 0, `resetCreditItems` comes out empty, this guard is
        //     never reached, and the change applies charging the full new term. The
        //     unused time is then not handed back, which is the trade the operator is
        //     being asked to make knowingly rather than have it silently dropped.
        //   · schedule it for the term end — no unused time exists at the boundary, so
        //     there is nothing to credit and nothing to refuse.
        // Neither destroys a document, which is the property the old advice lacked.
        throw new ProrationError(
          "We cannot apply this plan change. The unused time on the current term is worth " +
            `${creditTotal} against the new term's charge of ${net} (minor units). No ` +
            "invoice on that term can carry the credit. Each invoice is voided, pending or " +
            "zero-total, or its collected amount is already credited or withheld. " +
            "Apply the change again with prorate: false to charge the new term in full " +
            "without a credit for the " +
            "unused time. Or schedule the change for the end of the current term. Do NOT void the " +
            "invoice of the term. You can never credit a voided invoice, so the problem becomes " +
            "permanent.",
        );
      }
    }
    return {
      billableLines,
      net,
      downgradeCreditNote: [] as CreditNote[],
      resetCreditNote,
      resetCreditDropped,
      upgradeCreditNote,
      upgradeGrossed,
      upgradeCreditedPriceIds,
      insertedByRequestKey,
    };
  }).catch((e: unknown) => {
    // 1a: a refused credit is a VALIDATABLE condition, not an internal fault, and
    // nothing was written (the transaction above rolled back). Re-raise it inside
    // this module's error taxonomy so every caller — the `/change` route, the
    // scheduled-change applier, the dashboard action — gets a 400 with the real
    // reason instead of a bare 500 that invites a retry of a change that cannot
    // succeed. `CreditNoteError` is imported dynamically for the same reason the
    // credit-note service is: proration.ts must not statically depend on it.
    return rethrowCreditNoteErrorAsProration(e);
  });

  const { net } = applied;
  // A requested ADD's line could not carry its item id in the read phase — the row did not
  // exist yet. It does now, so a one-time add's line becomes a `one_time` line carrying the
  // id `markItemsBilled` needs, exactly like the change path's own one-time lines.
  const allBillableLines = applied.billableLines.map((l) =>
    l.requestedAddKey != null && l.requestedAddIsOneTime === true
      ? { ...l, oneTimeItemId: applied.insertedByRequestKey.get(l.requestedAddKey) ?? null }
      : l,
  );
  // Term reset moves the period boundaries even when net settles to 0 (the item/
  // period updates above already landed); a non-reset zero-net change is likewise
  // a no-op on money but still a fully-applied item change.
  if (plan.inTrial || allBillableLines.length === 0 || net === 0n) {
    return { prorationInvoice: null, creditNote: null, creditNotes: [], payment: null };
  }

  // Read the term only PAST the trial early-out. A trialling subscription has no term
  // (2026-08-25) and raises no invoice from a change, so asking for one above threw on
  // exactly the subscriptions this branch exists to let through untouched — `plan.inTrial`
  // was already the guard, it just sat one statement too late.
  const invoicePeriodEnd: Date | null = plan.resetTerm
    ? plan.newPeriodEnd
    : requireTerm(plan.sub).end;
  if (invoicePeriodEnd == null) {
    throw new Error(`subscription ${plan.sub.publicId}: a term reset produced no new period end`);
  }

  // ── What is left to INVOICE ─────────────────────────────────────────────────
  // A downgrade (net < 0) that credited its negative lines GROSS inside the
  // transaction above must not bill them again — netted onto an invoice they would
  // credit the same unused time twice. What remains is the new term's own charge,
  // which is raised as its own invoice and is the only way the returned
  // promotional credit gets to re-apply PRE-tax to it (see the apply phase's note,
  // and scripts/probe-change-promo-tax-retention.ts).
  //
  // A downgrade that could NOT be grossed (`downgradeGrossed` false — the term's
  // invoice cannot fund the whole credit) took the netted shape instead: its credit
  // note already carries `charge − credit`, so billing the charge on top would charge
  // the customer twice. Nothing is left to invoice at all.
  const chargeableLines =
    net < 0n
      ? applied.downgradeGrossed === true
        ? allBillableLines.filter((l) => l.amountMinor > 0n)
        : []
      : // An upgrade whose unused time became a CREDIT NOTE bills the new term at full
        // price; the negatives it replaced must not also appear as lines, or the customer
        // is credited twice. Only the SWAPPED prices' negatives go — a quantity change in
        // the same mixed edit keeps its netted delta line, which is the right shape for it.
        applied.upgradeGrossed === true
        ? allBillableLines.filter(
            (l) =>
              l.amountMinor > 0n || !(applied.upgradeCreditedPriceIds ?? []).includes(l.priceId),
          )
        : allBillableLines;

  // ── THE DOCUMENT'S LINE ORDER (2026-08-29) ──────────────────────────────────────
  // Plan first, then charges by AMOUNT ASCENDING — the single rule, stated and argued in
  // `orderDocumentLines` (invoicing/service.ts), that the period planner also applies.
  //
  // The `rows.sort` in the read phase already put the plan first, but tie-broke on
  // `price.publicId`: stable across runs, but alphabetical rather than amount-ascending.
  // The correct order is [plan, gds 5527200, connections
  // 9024000] on the term-reset invoice built HERE, where publicId sorts
  // "platform-additional-connections…" before "platform-destination-gds…". Amount is not
  // knowable when items are sorted; it is knowable now, so the decision moves here and
  // `rows.sort` keeps only the job it can do (a deterministic walk).
  //
  // Dynamically imported for the same reason `createInvoiceFromLines` below is: this
  // module must not form a static cycle with the invoicing service.
  const { orderDocumentLines } = await import("@/modules/invoicing/service");
  const planPriceIds = await withTenant(organizationId, async (tx) => {
    const ids = [
      ...new Set(chargeableLines.map((l) => l.priceId).filter((id): id is string => id != null)),
    ];
    if (ids.length === 0) return new Set<string>();
    const planRows = await tx
      .select({ id: prices.id })
      .from(prices)
      .innerJoin(products, eq(prices.productId, products.id))
      .where(and(inArray(prices.id, ids), eq(products.kind, "plan")));
    return new Set(planRows.map((r) => r.id));
  });
  // No `tiebreak`: `Array.prototype.sort` is stable, so equal-amount lines keep the
  // publicId order `rows.sort` gave them — deterministic, and never a row uuid.
  const billableLines = orderDocumentLines(chargeableLines, {
    isPlan: (l) => l.priceId != null && planPriceIds.has(l.priceId),
  });
  // The credit note(s) this request issued — a downgrade's gross credit, or a term
  // reset's unused-term credit. Both were committed by the apply transaction, so both
  // are visible to the invoice below when it draws the customer's balances.
  const issuedCreditNotes =
    net < 0n
      ? applied.downgradeCreditNote
      : [...applied.resetCreditNote, ...(applied.upgradeCreditNote ?? [])];
  if (billableLines.length === 0) {
    // A pure downgrade with nothing to charge (a removal, a quantity cut): the credit
    // note IS the whole outcome, exactly as before.
    return {
      prorationInvoice: null,
      creditNote: issuedCreditNotes[0] ?? null,
      creditNotes: issuedCreditNotes,
      payment: null,
    };
  }

  const resetCreditNote = applied.resetCreditNote;
  const fallbackCreditLines: Array<{
    description: string;
    priceId: string;
    quantity: number;
    unitAmountMinor: bigint;
    amountMinor: bigint;
    /** Never set here — a fallback credit line states no rate. Declared so the two line
     *  arrays share a shape at the mapping below. */
    contractedUnitMinor?: bigint;
    oneTimeItemId: string | null;
  }> = [];
  // `resetCreditDropped` — the apply phase established that this term was never
  // invoiced, so there is no money to return and these lines must not be booked (they
  // would drive the subtotal negative on any downgrade). See the note there; the
  // alternative outcome, an uncreditable invoice, threw and rolled back.
  if (
    plan.resetCreditItems.length > 0 &&
    resetCreditNote.length === 0 &&
    !applied.resetCreditDropped
  ) {
    // Reached ONLY when an invoice exists but was not CREDITABLE (pending / voided /
    // zero-total, so `issueCurrentTermCredit` returned null) AND the credit is
    // smaller than the new charge. Book it as NEGATIVE invoice lines so real money
    // is never lost — the pre-term-reset behaviour.
    //
    // The other two ways in are already closed above, and reading this guard as
    // "no prior invoice" (as its previous comment said) is wrong in both:
    //   • never invoiced      → `resetCreditDropped`; there is no money to return.
    //   • creditable invoice  → `resetCreditNote`; the CN carries it.
    // That misreading is worth spelling out: it makes this branch look unreachable,
    // and deleting it would silently swallow a credit the customer is genuinely owed.
    for (const it of plan.resetCreditItems) {
      fallbackCreditLines.push({
        description: it.description,
        priceId: it.priceId,
        quantity: it.quantity,
        unitAmountMinor: -it.amountMinor,
        amountMinor: -it.amountMinor,
        oneTimeItemId: null,
      });
    }
  }

  const [customer] = await withTenant(organizationId, async (tx) =>
    tx.select().from(customers).where(eq(customers.id, plan.sub.customerId)).limit(1),
  );

  // Bug fix (credits ignored on immediate proration invoices): route through
  // createInvoiceFromLines — the SAME shared engine billSubscriptionPeriod's
  // second call site and prorateTermChange's extension path use — instead of
  // hand-rolling the invoice/ledger. This applies the customer's promotional /
  // refundable / excess credit balances (D1 order: promo pre-tax capped at
  // subtotal → refundable/excess post-tax) before charging the card, so an
  // upgrade with held credits matches what /estimate already previews, and
  // marks the invoice paid (no charge attempted) when credits cover it fully.
  // Either branch can charge a `one_time` item whose single cycle is still unspent —
  // the term-reset charge loop, and (2026-08-04) a non-reset change to the item's own
  // price/quantity. It is the same shape as `addSubscriptionItem`'s one-time
  // branch — a full fee raised OUTSIDE the period planner — so it carries the same
  // obligation: record the cycle inside the invoice's transaction, or the next
  // renewal sees a never-billed one-off and bills it again. Only the lines that
  // SURVIVED the mandatory-addon drop above are billed, so the ids are read off
  // `billableLines`, never off the pre-filter list.
  const oneTimeItemIds = billableLines
    .map((l) => l.oneTimeItemId ?? null)
    .filter((id): id is string => id != null);

  // ── INVOICING OPTION: invoice now, or book to unbilled charges ───────────────
  // `invoiceImmediately` was resolved before the apply transaction (see the note
  // there) because the downgrade branch inside it needs the same answer.
  if (!invoiceImmediately) {
    // Same lines, queued instead of invoiced. They fold into the next renewal
    // invoice (invoicing/service.ts), which is where tax, coupons and the
    // customer's credit balances are then applied — so nothing is applied twice
    // and nothing is lost.
    const deferredLines = [...billableLines, ...fallbackCreditLines];
    const deferredTotal = deferredLines.reduce((s, l) => s + l.amountMinor, 0n);
    // `net` is already > 0 here, but the fallback credit lines are NOT part of it
    // (they exist only when a term reset found no invoice to credit against), so the
    // combined set can still come out negative. The immediate branch refuses that
    // outright — `createInvoiceFromLines` throws on a negative subtotal rather than
    // mint a negative invoice (ADR-009) — and deferring it would be worse than a
    // throw: a queued net credit can drag the NEXT renewal invoice negative, where
    // the same guard fires far from the change that caused it.
    if (deferredTotal < 0n) {
      throw new ProrationError(
        "This change gives a net credit for the unused term. We cannot queue a credit as an unbilled charge. Apply the change with invoice_immediately: true to settle the credit on an invoice now.",
      );
    }
    // The `entity_type` on the unbilled charge, resolved from the line's product
    // kind. These lines carry PLAN and ADD-ON price ids, so the ad-hoc default
    // (`charge_item_price` for anything with a price) would file a plan proration
    // under the wrong entity in the API payload.
    const priceIds = [...new Set(deferredLines.map((l) => l.priceId))];
    const kindByPriceId = new Map(
      (
        await withTenant(organizationId, async (tx) =>
          tx
            .select({ priceId: prices.id, kind: products.kind })
            .from(prices)
            .innerJoin(products, eq(prices.productId, products.id))
            .where(inArray(prices.id, priceIds)),
        )
      ).map((r) => [r.priceId, r.kind]),
    );
    const entityTypeFor = (priceId: string): string => {
      const kind = kindByPriceId.get(priceId);
      return kind === "plan"
        ? "plan_item_price"
        : kind === "addon"
          ? "addon_item_price"
          : kind === "charge"
            ? "charge_item_price"
            : "adhoc";
    };
    const { addAdHocCharges } = await import("./items");
    const booked = await addAdHocCharges({
      organizationId,
      businessId,
      subscriptionId: plan.sub.id,
      invoiceNow: false,
      now,
      lines: deferredLines.map((l) => ({
        description: l.description,
        amountMinor: Number(l.amountMinor),
        quantity: l.quantity,
        priceId: l.priceId,
        entityType: entityTypeFor(l.priceId),
        // The service window the immediate invoice would have carried, so a deferred
        // slice is still recognised over the period it covers rather than over
        // whichever renewal happens to bill it (migration 0134's whole point).
        // The proration WINDOW start, not the raw instant. On a day-anchored,
        // whole-day business the window began at local midnight; stamping 19:50:52
        // recorded a service period that started ~4h into a day the customer was
        // billed for in full — and every later proration off this line inherited the
        // sliver (measured: at cancel a full day should be withheld, we withheld 4h).
        // `prorationWindowStart` is the same helper the AMOUNTS already use (see the
        // plan phase), and it returns `now` unchanged for exact-proration businesses,
        // so instant-anchored callers are untouched.
        periodStart: plan.resetTerm ? plan.resetStart : plan.prorationNow,
        periodEnd: invoicePeriodEnd,
      })),
      // Deferring does not un-charge a one-time fee: the cycle is consumed by this
      // booking, or the renewal folds the queued charge in AND rates the item again.
      ...(oneTimeItemIds.length > 0 ? { markItemsBilled: oneTimeItemIds } : {}),
    });
    return {
      prorationInvoice: null,
      creditNote: issuedCreditNotes[0] ?? null,
      creditNotes: issuedCreditNotes,
      payment: null,
      unbilledCharges: booked.object === "unbilled_charges" ? booked.charges : [],
    };
  }

  const { createInvoiceFromLines } = await import("@/modules/invoicing/service");
  // failed_change_charge = next_renewal: a failed charge waits for the term end before
  // dunning retries it. Not after a term reset: the old boundary is no renewal any more,
  // and the new one is a full term away (a monthly → yearly upgrade would wait a year).
  const holdToTermEnd =
    !plan.resetTerm &&
    plan.sub.currentPeriodEnd != null &&
    (input.failedChangeCharge ??
      resolveBillingRulesConfig(await loadBillingRulesRow(organizationId, businessId))
        .failedChangeCharge) === "next_renewal";
  const { invoice: prorationInvoice, payment } = await createInvoiceFromLines({
    organizationId,
    businessId,
    customerId: plan.sub.customerId,
    subscriptionId: plan.sub.id,
    currency: plan.sub.currency,
    lines: [...billableLines, ...fallbackCreditLines].map((l) => ({
      description: l.description,
      amountMinor: l.amountMinor,
      priceId: l.priceId,
      quantity: l.quantity,
      // Only where the producing site could state it — see `contractedUnitMinor` on the
      // line type. Absent, the insert falls back to `amount ÷ quantity`.
      ...(l.contractedUnitMinor != null ? { contractedUnitMinor: l.contractedUnitMinor } : {}),
      // A one-time fee is booked as one, not as a prorated slice of a term.
      kind: (l.oneTimeItemId ? "one_time" : "proration") as "one_time" | "proration",
    })),
    ...(oneTimeItemIds.length > 0 ? { markItemsBilled: oneTimeItemIds } : {}),
    applyTax: true,
    country: customer?.country,
    state: customer?.state,
    applyCredit: true,
    // The subscription's coupons discount the change invoice too — a 64900 upgrade on
    // a 10%-forever sub bills as 58410. Peek-only: a mid-term change is
    // not a billing cycle, so it burns no limited-period redemption.
    applyCoupons: true,
    // A credit note was created this request (issueCurrentTermCredit above — a term
    // reset's unused-term credit, or a downgrade's gross credit) and already emitted
    // customer_changed + old-invoice invoice_updated; suppress the draw's duplicate
    // pair (both fold into invoice_generated). Not suppressed when no credit note
    // was created (nothing to be redundant with).
    suppressCreditDrawEvents: issuedCreditNotes.length > 0,
    collect: true,
    subscription: plan.sub,
    periodStart: plan.resetTerm ? plan.resetStart : plan.prorationNow,
    periodEnd: invoicePeriodEnd,
    ...(holdToTermEnd ? { retryHoldUntil: plan.sub.currentPeriodEnd } : {}),
  });
  return {
    prorationInvoice,
    creditNote: issuedCreditNotes[0] ?? null,
    creditNotes: issuedCreditNotes,
    payment,
  };
}

/**
 * Proration for change_term_end (SUB-9): the current term's recurring charge was
 * for [periodStart, oldPeriodEnd]; moving the boundary to newPeriodEnd bills (or
 * credits) the recurring amount for the day-delta at the same daily rate.
 *  - extension (delta > 0) → a proration charge invoice (collected if asked),
 *  - shortening (delta < 0) → a refundable credit note (paid term) or adjustment
 *    credit note (unpaid term) for the removed time,
 *  - delta = 0 → null.
 */
export async function prorateTermChange(input: {
  organizationId: string;
  businessId: string;
  subscription: typeof subscriptions.$inferSelect;
  oldPeriodEnd: Date;
  newPeriodEnd: Date;
  invoiceImmediately: boolean;
  now: Date;
  /** Post-H (#5): per-operation idempotency token (from the request Idempotency-Key). */
  originToken?: string | null;
}): Promise<Invoice | null> {
  const { organizationId, businessId, subscription: sub } = input;
  const startMs = requireTerm(sub).start.getTime();
  const deltaMs = input.newPeriodEnd.getTime() - input.oldPeriodEnd.getTime();
  if (deltaMs === 0) return null;

  // Full recurring amount billed for the current term (from item snapshots so an
  // edited catalog price never retroactively re-rates), plus the LENGTH of the
  // period that amount was billed for — read from the term's own invoice
  // (period_start = current_period_start). That billed length is the correct daily-
  // rate denominator: using oldPeriodEnd−start diluted the rate on repeated
  // change_term_end calls (review blocker — oldPeriodEnd grows with each extension
  // while fullAmount stays one term), and the nominal interval is wrong for
  // custom-length / calendar terms. Falls back to the nominal interval if unbilled.
  const { fullAmount, customer, billedLenMs, bizMode } = await withTenant(
    organizationId,
    async (tx) => {
      const rows = await tx
        .select({ item: subscriptionItems, price: prices })
        .from(subscriptionItems)
        .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
        .where(eq(subscriptionItems.subscriptionId, sub.id));
      let total = 0n;
      for (const r of rows) {
        const ratable = ratableForItem(r.item, r.price);
        if (
          (r.item.priceSnapshot as PriceSnapshot | null)?.type === "recurring" ||
          r.price.type === "recurring"
        ) {
          total += fixedChargeMinor(
            (r.item.priceSnapshot as PriceSnapshot | null) ?? r.price,
            ratable,
            r.item.quantity,
          );
        }
      }
      const [cust] = await tx
        .select({ country: customers.country, state: customers.state })
        .from(customers)
        .where(eq(customers.id, sub.customerId))
        .limit(1);
      const termBills = await tx
        .select({
          periodStart: invoices.periodStart,
          periodEnd: invoices.periodEnd,
          createdAt: invoices.createdAt,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.businessId, businessId),
            eq(invoices.subscriptionId, sub.id),
            eq(invoices.periodStart, requireTerm(sub).start),
          ),
        );
      const bill =
        termBills
          .filter((b) => b.periodEnd != null && b.periodStart != null)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
      const len =
        bill?.periodEnd && bill.periodStart
          ? bill.periodEnd.getTime() - bill.periodStart.getTime()
          : null;
      // The daily-rate denominator below needs the BUSINESS calendar, not UTC — read it
      // here rather than with a second round trip.
      const mode = await billingModeFor(tx, businessId);
      return { fullAmount: total, customer: cust ?? null, billedLenMs: len, bizMode: mode };
    },
  );
  if (fullAmount <= 0n) return null;

  // Denominator: billed term length, else the nominal interval.
  //
  // ⚠ `advancePeriod`, NOT `addInterval`, for the fallback — the same UTC-vs-business
  // calendar split as the term boundaries themselves (see `createSubscription`). This
  // is the DENOMINATOR of the daily rate, so getting the calendar wrong moves MONEY,
  // not just a date: a term running 31 Oct → 30 Nov IST is 30 days, but `addInterval`
  // measured it from UTC day 30 and clamped to 30 Nov, calling it 31 days. A one-day
  // extension of a 30000/mo plan then billed 967 instead of 1000 — the customer is
  // charged a 30-day term's day at a 31-day term's rate. Now the fallback measures the
  // interval on the same calendar, with the same anchor, that produced the stored
  // boundary it is standing in for, so the two can no longer disagree.
  //
  // Unchanged whenever the term WAS billed (`billedLenMs` wins, as before), on a UTC
  // business, with a null anchor day, or for a non-month/year cadence — `advancePeriod`
  // returns `addInterval` verbatim in the last two cases.
  const unit = (sub.billingPeriodUnit ?? "month") as Interval;
  const count = sub.billingPeriod ?? 1;
  const intervalLen =
    billedLenMs && billedLenMs > 0
      ? billedLenMs
      : advancePeriod(
          requireTerm(sub).start,
          unit,
          count,
          sub.billingAnchorDay,
          bizMode,
        ).getTime() - startMs;
  if (intervalLen <= 0) return null;

  // Daily-rate proration of the moved boundary (integer minor units).
  const magnitude = (fullAmount * BigInt(Math.abs(deltaMs))) / BigInt(intervalLen);
  if (magnitude <= 0n) return null;

  if (deltaMs > 0) {
    // Extension → charge the extra time.
    const desc = `Term extension (${new Date(input.oldPeriodEnd).toISOString().slice(0, 10)} → ${new Date(input.newPeriodEnd).toISOString().slice(0, 10)})`;
    // Post-H (#5): idempotency is now keyed on a dedicated per-operation token
    // (from the request Idempotency-Key), NOT the human-readable line description.
    // The old description-match false-matched on extend→shrink→extend-again to the
    // SAME boundary and reused the first invoice, moving the term without charging.
    // createInvoiceFromLines reuses an invoice that already carries the token and is
    // race-safe via the unique index; a genuinely-new operation has a new token and
    // raises a fresh charge. (No token → no dedup, matching a direct internal call.)
    const { createInvoiceFromLines } = await import("@/modules/invoicing/service");
    const { invoice } = await createInvoiceFromLines({
      organizationId,
      businessId,
      customerId: sub.customerId,
      subscriptionId: sub.id,
      currency: sub.currency,
      lines: [{ description: desc, amountMinor: magnitude, kind: "one_time" }],
      applyTax: true,
      country: customer?.country,
      state: customer?.state,
      applyCredit: true,
      collect: input.invoiceImmediately,
      subscription: sub,
      originToken: input.originToken ?? null,
    });
    return invoice;
  }

  // Shortening → credit the removed time against the latest term invoice.
  const { issueRefundableCreditNote, issueAdjustmentCreditNote } =
    await import("@/modules/credit-notes/service");
  const { invoiceOutstanding } = await import("@/modules/invoicing/service");
  const { isOpenInvoiceStatus } = await import("@/modules/invoicing/status");
  const termInv = await withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.businessId, businessId), eq(invoices.subscriptionId, sub.id)));
    return (
      rows
        .filter((r) => r.status !== "voided" && r.status !== "pending")
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null
    );
  });
  if (!termInv) return null;
  // NO swallow (review blocker: `catch { return null }` returned 200 with no credit,
  // silently losing the customer's money). Errors propagate to the caller.
  if (isOpenInvoiceStatus(termInv.status)) {
    // Reduce the unpaid balance by the adjustable slice; any excess beyond the due
    // is time the customer ALREADY PAID (cash) for — return it as a refundable CN,
    // don't drop it (review blocker: credit beyond the invoice due was dropped).
    // Cash-net, for the reason `creditOneInvoice` documents above: the column has had no
    // payments taken off it, so adjusting against it returns the customer's own cash as
    // debt relief instead of as refundable credit. `excess` below already routes the cash
    // portion correctly — it was computed from the wrong boundary.
    const due = (await withTenant(organizationId, (t) => invoiceOutstanding(t, termInv)))
      .remainingMinor;
    const adjustable = magnitude < due ? magnitude : due;
    if (adjustable > 0n) {
      await issueAdjustmentCreditNote({
        organizationId,
        businessId,
        invoicePublicId: termInv.publicId,
        items: [{ description: "Term shortening credit", amountMinor: Number(adjustable) }],
        reasonCode: "term_change",
        reason: "change_term_end shortening",
      });
    }
    const excess = magnitude - adjustable;
    if (excess > 0n) {
      await issueRefundableCreditNote({
        organizationId,
        businessId,
        invoicePublicId: termInv.publicId,
        items: [
          { description: "Term shortening credit (paid portion)", amountMinor: Number(excess) },
        ],
        reasonCode: "term_change",
        reason: "change_term_end shortening",
      });
    }
  } else {
    await issueRefundableCreditNote({
      organizationId,
      businessId,
      invoicePublicId: termInv.publicId,
      items: [{ description: "Term shortening credit", amountMinor: Number(magnitude) }],
      reasonCode: "term_change",
      reason: "change_term_end shortening",
    });
  }
  return null;
}

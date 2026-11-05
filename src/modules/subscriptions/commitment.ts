import { and, eq, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import {
  businesses,
  prices,
  products,
  subscriptionItems,
  subscriptions,
  unbilledCharges,
} from "@db/schema";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { auditSubscription, subscriptionSnapshot } from "./audit";
import { priceLabel } from "@/modules/catalog/pricing";
import type { BillingMode } from "./billing-mode";
import { addInterval, type Interval } from "./interval";

/**
 * Minimum commitment per term. Counted fees: every recurring, proration and usage line of
 * the term, before discounts and tax; plan-change and cancellation credit notes subtract.
 * The shortfall bills as one "Minimum commitment adjustment" line on the plan's price.
 */

/** `unbilled_charges.entity_type` of an early-end true-up (immediate cancel, term reset). */
export const COMMITMENT_CHARGE = "commitment";

/** One stretch of the term at one commitment amount, from `from` to the next segment. */
export interface CommitmentSegment {
  from: string;
  amount_minor: string;
}

export function commitmentSegment(from: Date, amountMinor: bigint): CommitmentSegment {
  return { from: from.toISOString(), amount_minor: amountMinor.toString() };
}

/** The current term's segments. A row with an amount and no segments committed at its start. */
export function termSegments(
  sub: { commitmentAmountMinor: bigint | null; commitmentSegments: unknown },
  termStart: Date,
): CommitmentSegment[] {
  const raw = sub.commitmentSegments;
  if (Array.isArray(raw)) return raw as CommitmentSegment[];
  return sub.commitmentAmountMinor != null
    ? [commitmentSegment(termStart, sub.commitmentAmountMinor)]
    : [];
}

/** Segments for a new term: one, at the term start. Empty when there is no commitment. */
export function freshSegments(
  amountMinor: bigint | null,
  termStart: Date | null,
): CommitmentSegment[] | null {
  return amountMinor != null && termStart ? [commitmentSegment(termStart, amountMinor)] : null;
}

/** Add a change at `at`; a later change at the same instant replaces it. */
export function appendSegment(
  segments: CommitmentSegment[],
  at: Date,
  amountMinor: bigint | null,
): CommitmentSegment[] {
  const iso = at.toISOString();
  return [
    ...segments.filter((s) => new Date(s.from).getTime() < at.getTime()),
    { from: iso, amount_minor: (amountMinor ?? 0n).toString() },
  ];
}

/**
 * The commitment owed for `[termStart, endedAt)`: Σ amount_i × overlap_i ÷ full term, one
 * half-up rounding at the end. `fullTermEnd` is one whole interval after the term start, so
 * a short first term and an early end both prorate.
 */
export function proratedCommitment(
  segments: readonly CommitmentSegment[],
  termStart: Date,
  endedAt: Date,
  fullTermEnd: Date,
): bigint {
  const den = BigInt(fullTermEnd.getTime() - termStart.getTime());
  if (den <= 0n || endedAt.getTime() <= termStart.getTime()) return 0n;
  const sorted = [...segments].sort(
    (a, b) => new Date(a.from).getTime() - new Date(b.from).getTime(),
  );
  let num = 0n;
  sorted.forEach((s, i) => {
    const from = Math.max(new Date(s.from).getTime(), termStart.getTime());
    const next = sorted[i + 1];
    const to = Math.min(next ? new Date(next.from).getTime() : Infinity, endedAt.getTime());
    if (to > from) num += BigInt(s.amount_minor) * BigInt(to - from);
  });
  return (num + den / 2n) / den;
}

/** The whole-interval end the commitment is prorated against. */
export function fullTermEnd(
  termStart: Date,
  sub: { billingPeriodUnit: string | null; billingPeriod: number | null },
): Date {
  return addInterval(
    termStart,
    (sub.billingPeriodUnit ?? "month") as Interval,
    sub.billingPeriod ?? 1,
  );
}

/**
 * Fees counted toward the term `[start, end)`, from what is already on the books:
 * invoice lines of the term, less plan-change and cancellation credit notes on its
 * invoices (scaled back to the pre-discount, pre-tax supply they reverse). With
 * `includePendingSettlements`, usage settled but not yet invoiced counts too; leave it off
 * when the invoice being planned folds those charges in.
 */
export async function countedCommitmentFees(
  tx: Tx,
  subscriptionId: string,
  term: { start: Date; end: Date },
  opts: { includePendingSettlements?: boolean } = {},
): Promise<bigint> {
  const s = term.start.toISOString();
  const e = term.end.toISOString();
  const rows = (await tx.execute(sql`
    with lines as (
      select coalesce(sum(l.amount_minor), 0) n
      from invoice_line_items l join invoices i on i.id = l.invoice_id
      where i.subscription_id = ${subscriptionId}
        and i.status not in ('voided', 'pending')
        and l.kind in ('recurring', 'proration', 'usage')
        and l.adjustment is distinct from 'commitment'
        and l.period_start >= ${s}::timestamptz and l.period_start < ${e}::timestamptz
    ),
    notes as (
      select cn.id, i.id invoice_id, i.total_minor inv_total,
        (select coalesce(sum(it.amount_minor), 0) from credit_note_items it where it.credit_note_id = cn.id)
          + (select coalesce(sum(d.amount_minor), 0) from credit_note_discounts d where d.credit_note_id = cn.id) gross,
        (select min(it.period_start) from credit_note_items it where it.credit_note_id = cn.id) at
      from credit_notes cn join invoices i on i.id = cn.invoice_id
      where i.subscription_id = ${subscriptionId}
        and cn.status <> 'voided'
        and cn.reason_code in ('subscription_change', 'subscription_cancellation')
    ),
    credited as (
      select coalesce(sum(
        case when n.inv_total > 0
          then div(n.gross * (select coalesce(sum(l.amount_minor), 0) from invoice_line_items l
                               where l.invoice_id = n.invoice_id
                                 and l.kind in ('recurring', 'proration', 'usage', 'one_time'))
                   * 2 + n.inv_total, 2 * n.inv_total)
          else 0 end), 0) n
      from notes n
      where n.at >= ${s}::timestamptz and n.at < ${e}::timestamptz
    ),
    settled as (
      select coalesce(sum(u.amount_minor), 0) n from unbilled_charges u
      where u.subscription_id = ${subscriptionId} and u.status = 'pending'
        and u.entity_type = 'usage_settlement'
        and u.period_start >= ${s}::timestamptz and u.period_start < ${e}::timestamptz
    )
    select (lines.n - credited.n ${opts.includePendingSettlements ? sql`+ settled.n` : sql``})::bigint::text total
    from lines, credited, settled`)) as unknown as Array<{ total: string }>;
  return BigInt(rows[0]?.total ?? "0");
}

/** Whether a line counts toward the commitment of `[start, end)`. */
export function countsTowardCommitment(
  line: { kind: string; adjustment?: string | null; periodStart: Date },
  term: { start: Date; end: Date },
): boolean {
  return (
    (line.kind === "recurring" || line.kind === "proration" || line.kind === "usage") &&
    line.adjustment !== "commitment" &&
    line.periodStart.getTime() >= term.start.getTime() &&
    line.periodStart.getTime() < term.end.getTime()
  );
}

/** The plan item's price and label, which the true-up line bills under. */
export async function planPriceFor(tx: Tx, subscriptionId: string) {
  const [row] = await tx
    .select({ price: prices, productName: products.name, productPublicId: products.publicId })
    .from(subscriptionItems)
    .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
    .innerJoin(products, eq(prices.productId, products.id))
    .where(and(eq(subscriptionItems.subscriptionId, subscriptionId), eq(products.kind, "plan")))
    .orderBy(subscriptionItems.createdAt, subscriptionItems.id)
    .limit(1);
  return row ?? null;
}

/** "Minimum commitment adjustment: Pro annual (1 Jan 2027 – 1 Jan 2028)", dates in the business zone. */
export function commitmentDescription(
  planLabel: string,
  term: { start: Date; end: Date },
  mode: BillingMode,
): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: mode.timezone,
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `Minimum commitment adjustment: ${planLabel} (${fmt.format(term.start)} – ${fmt.format(term.end)})`;
}

export interface CommitmentStatus {
  segments: CommitmentSegment[];
  proratedMinor: bigint;
  countedMinor: bigint;
  shortfallMinor: bigint;
}

/** Commitment owed, counted and short for `[termStart, endedAt)`. */
export async function commitmentStatus(
  tx: Tx,
  sub: Pick<
    typeof subscriptions.$inferSelect,
    "id" | "commitmentAmountMinor" | "commitmentSegments" | "billingPeriodUnit" | "billingPeriod"
  >,
  term: { start: Date; end: Date },
  endedAt: Date,
  opts: { includePendingSettlements?: boolean; plannedMinor?: bigint } = {},
): Promise<CommitmentStatus> {
  const segments = termSegments(sub, term.start);
  const proratedMinor = proratedCommitment(
    segments,
    term.start,
    endedAt,
    fullTermEnd(term.start, sub),
  );
  const countedMinor =
    (await countedCommitmentFees(tx, sub.id, term, opts)) + (opts.plannedMinor ?? 0n);
  const shortfallMinor = proratedMinor > countedMinor ? proratedMinor - countedMinor : 0n;
  return { segments, proratedMinor, countedMinor, shortfallMinor };
}

/**
 * A term that ends early (immediate cancel, term reset): queue the prorated true-up as a
 * `commitment` unbilled charge on the plan price. One per term (unique index). Returns it,
 * or null when nothing is owed.
 */
export async function bookEarlyEndCommitment(
  tx: Tx,
  sub: typeof subscriptions.$inferSelect,
  endedAt: Date,
  mode: BillingMode,
): Promise<typeof unbilledCharges.$inferSelect | null> {
  // Trials and paused terms carry no commitment.
  if (sub.status !== "active" || !sub.currentPeriodStart || !sub.currentPeriodEnd) return null;
  const start = sub.currentPeriodStart;
  const end = new Date(Math.min(endedAt.getTime(), sub.currentPeriodEnd.getTime()));
  if (end.getTime() <= start.getTime()) return null;
  const status = await commitmentStatus(tx, sub, { start, end: sub.currentPeriodEnd }, end, {
    includePendingSettlements: true,
  });
  if (status.shortfallMinor <= 0n) return null;
  const plan = await planPriceFor(tx, sub.id);
  if (!plan) return null;
  const [row] = await tx
    .insert(unbilledCharges)
    .values({
      organizationId: sub.organizationId,
      businessId: sub.businessId,
      subscriptionId: sub.id,
      publicId: publicId("uch"),
      description: commitmentDescription(
        priceLabel(plan.price, { name: plan.productName }),
        { start, end },
        mode,
      ),
      amountMinor: status.shortfallMinor,
      currency: sub.currency,
      priceId: plan.price.id,
      quantity: 1,
      entityType: COMMITMENT_CHARGE,
      periodStart: start,
      periodEnd: end,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** Thrown when a commitment cannot be set on this subscription (→ 400). */
export class CommitmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommitmentError";
  }
}

/** The commitment for the current term, as the true-up at its natural end would count it. */
export async function getCommitment(
  organizationId: string,
  sub: typeof subscriptions.$inferSelect,
): Promise<{ term: { start: Date; end: Date } | null } & CommitmentStatus> {
  const term =
    sub.currentPeriodStart && sub.currentPeriodEnd && sub.status !== "in_trial"
      ? { start: sub.currentPeriodStart, end: sub.currentPeriodEnd }
      : null;
  if (!term) return { term, segments: [], proratedMinor: 0n, countedMinor: 0n, shortfallMinor: 0n };
  return withTenant(organizationId, async (tx) => ({
    term,
    ...(await commitmentStatus(tx, sub, term, term.end, { includePendingSettlements: true })),
  }));
}

/**
 * Set (or with null, remove) the subscription's commitment. Takes effect now: the current
 * term gets a new segment, so the true-up weighs each amount by the time it applied.
 */
export async function setCommitment(input: {
  organizationId: string;
  businessId: string;
  sub: typeof subscriptions.$inferSelect;
  amountMinor: bigint | null;
  now: Date;
}): Promise<typeof subscriptions.$inferSelect> {
  const { organizationId, businessId, sub } = input;
  if (sub.status === "cancelled")
    throw new CommitmentError("We could not change the commitment. The subscription is cancelled.");
  return withTenant(organizationId, async (tx) => {
    if (input.amountMinor != null) {
      const [biz] = await tx
        .select({ pending: businesses.createPendingInvoices })
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .limit(1);
      if (sub.createPendingInvoices ?? biz?.pending ?? false)
        throw new CommitmentError(
          "We could not set the commitment. It does not work with pending invoices.",
        );
    }
    const termStart = sub.status === "in_trial" ? null : sub.currentPeriodStart;
    const segments = termStart
      ? appendSegment(termSegments(sub, termStart), input.now, input.amountMinor)
      : null;
    const before = await subscriptionSnapshot(tx, sub);
    const [updated] = await tx
      .update(subscriptions)
      .set({ commitmentAmountMinor: input.amountMinor, commitmentSegments: segments })
      .where(
        and(eq(subscriptions.id, sub.id), eq(subscriptions.resourceVersion, sub.resourceVersion)),
      )
      .returning();
    if (!updated)
      throw new CommitmentError(
        "We could not change the commitment. The subscription changed at the same time. Try again.",
      );
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "subscription_changed",
      data: buildEventData(
        "subscription_changed",
        { id: updated.publicId, status: updated.status },
        updated.resourceVersion,
      ),
    });
    await auditSubscription(tx, {
      organizationId,
      businessId,
      action: "subscription.commitment_change",
      before,
      after: updated,
    });
    return updated;
  });
}

/** The minimum commitment of the term that closes at its natural end, for the planner. */
export function closingCommitment(sub: typeof subscriptions.$inferSelect):
  | {
      term: { start: Date; end: Date };
      endedAt: Date;
      segments: CommitmentSegment[];
      cadence: { billingPeriodUnit: string | null; billingPeriod: number | null };
    }
  | undefined {
  if (sub.status !== "active" || !sub.currentPeriodStart || !sub.currentPeriodEnd) return undefined;
  const term = { start: sub.currentPeriodStart, end: sub.currentPeriodEnd };
  const segments = termSegments(sub, term.start);
  if (segments.length === 0) return undefined;
  return { term, endedAt: term.end, segments, cadence: sub };
}

/**
 * What a subscription change may do, decided in ONE place for every source.
 *
 * The portal, the dashboard, the API and scheduled changes ask the same function, so a
 * gate or a timing rule cannot be enforced on one surface and skipped on another. The
 * business rules live in `billing_rules_config` (billing-rules-config.ts): proration,
 * gate and timing, each per direction.
 *
 * Unset keys keep each source's behaviour from before the rules existed: every change
 * prorates and nothing is refused; the portal changes an upgrade now and a downgrade at the
 * end of the term, the dashboard and the API apply a change now unless the caller schedules
 * it. A scheduled change is gated and timed when it is scheduled, not when it lands.
 */
import { and, eq, gt, inArray } from "drizzle-orm";
import { resolveStorefrontConfig } from "@/modules/checkout/storefront-config";
import { OPEN_INVOICE_STATUSES } from "@/modules/invoicing/status";
import {
  resolveBillingRulesConfig,
  type ChangeTimingRule,
} from "@/modules/subscriptions/billing-rules-config";
import type { PriceSnapshot } from "@/modules/catalog/pricing";
import {
  resetTermFor,
  resolveLifecycleConfig,
  type PlanChangeTerm,
} from "@/modules/subscriptions/lifecycle-config";
import type { ItemAdd, ItemChange } from "@/modules/subscriptions/proration";
import { withTenant, type Tx } from "@/platform/db";
import { invoices, prices, products, subscriptionItems } from "@db/schema";

/** `checkout` = a hosted checkout in change mode: a buyer at a payment page, applied now. */
export type ChangeSource = "portal" | "checkout" | "dashboard" | "api" | "scheduled";

/** Sources where the buyer reads the refusal. */
const buyerFacing = (source: ChangeSource) => source === "portal" || source === "checkout";
export type ChangeDirection = "upgrade" | "downgrade" | "same";
export type ChangeTiming = "now" | "end_of_term";

export interface ChangePolicy {
  /** The timings this change may use. More than one = the caller (or the customer) chooses. */
  timings: ChangeTiming[];
  defaultTiming: ChangeTiming;
  /** Set when the change may not happen at all; the message is safe to show the caller. */
  blocked: null | { code: string; message: string };
  prorate: { upgrade: boolean; downgrade: boolean };
  /** Invoice the change now (true), on the next invoice (false), or null = the business rule. */
  invoiceImmediately: boolean | null;
  /** Whether a plan change restarts the term (`billing_rules_config.plan_change_term`). */
  planChangeTerm: PlanChangeTerm;
}

/**
 * Upgrade or downgrade. A move to a longer billing period is an upgrade (a bigger commitment,
 * paid up front) and to a shorter one a downgrade, whatever the monthly amount; on the same
 * period, the recurring amount per month decides.
 */
export function changeDirection(
  beforeMonthlyMinor: number,
  afterMonthlyMinor: number,
  periodMonths?: { before: number; after: number },
): ChangeDirection {
  if (periodMonths && periodMonths.after > periodMonths.before) return "upgrade";
  if (periodMonths && periodMonths.after < periodMonths.before) return "downgrade";
  if (afterMonthlyMinor > beforeMonthlyMinor) return "upgrade";
  if (afterMonthlyMinor < beforeMonthlyMinor) return "downgrade";
  return "same";
}

export const GATE_CODE = "invoices_unpaid";

/** The refusal, worded for who reads it: the buyer, or the operator. */
export function gateMessage(source: ChangeSource, direction: "upgrade" | "downgrade"): string {
  if (buyerFacing(source)) return "Pay your open invoices before you change your plan.";
  return `We could not change the subscription. This business requires paid invoices before ${
    direction === "upgrade" ? "an upgrade" : "a downgrade"
  }, and this customer has unpaid invoices. Collect the open invoices, then try again.`;
}

/** Pure part of the policy: everything but the open-invoice read. */
export function changeTimings(input: {
  rule: ChangeTimingRule | null;
  direction: ChangeDirection;
  source: ChangeSource;
  inTrial: boolean;
}): { timings: ChangeTiming[]; defaultTiming: ChangeTiming } {
  const { rule, source } = input;
  if (source === "scheduled") return { timings: ["now"], defaultTiming: "now" };
  const down = input.direction === "downgrade";
  // Unset: the portal changes an upgrade now and a downgrade at term end; a hosted
  // checkout applies now; the dashboard and the API let the caller pick, and apply now
  // when it does not.
  const mode: ChangeTimingRule =
    rule ??
    (source === "portal"
      ? down
        ? "end_of_term"
        : "now"
      : source === "checkout"
        ? "now"
        : "customer_chooses");
  const both: ChangeTiming[] = ["now", "end_of_term"];
  // In a trial nothing is billed until it ends, so every change applies now. Only an
  // operator who may pick (customer_chooses) can still defer one to the activation.
  if (input.inTrial)
    return {
      timings: mode === "customer_chooses" && !buyerFacing(source) ? both : ["now"],
      defaultTiming: "now",
    };
  if (mode === "customer_chooses")
    return {
      timings: both,
      defaultTiming: rule === null ? "now" : down ? "end_of_term" : "now",
    };
  return { timings: [mode], defaultTiming: mode };
}

/**
 * The refusal for a surface that can only apply a change now (`POST …/items`,
 * `DELETE …/items/:id`, `update_for_items`, a hosted checkout) when the rule says term end.
 */
export function nowNotAllowedMessage(source: ChangeSource, direction: ChangeDirection): string {
  const what = direction === "downgrade" ? "a downgrade" : "an upgrade";
  if (buyerFacing(source))
    return `This change starts at the end of the term, and you cannot schedule it here. Contact us to change your plan.`;
  return `We could not apply the change now. This business applies ${what} at the end of the term. Send it to POST …/change with timing: end_of_term, or schedule it.`;
}

/** Whether the customer owes on any finalized invoice of this business. */
export async function hasUnpaidInvoices(
  tx: Tx,
  sub: { businessId: string; customerId: string },
): Promise<boolean> {
  const [row] = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        eq(invoices.businessId, sub.businessId),
        eq(invoices.customerId, sub.customerId),
        inArray(invoices.status, [...OPEN_INVOICE_STATUSES]),
        gt(invoices.amountDueMinor, 0n),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Async with an optional `tx`: the gate reads open invoices. */
export async function resolveChangePolicy(input: {
  business: { billingRulesConfig?: unknown; storefrontConfig?: unknown };
  subscription: {
    status: string;
    cancelAtPeriodEnd: boolean;
    organizationId: string;
    businessId: string;
    customerId: string;
  };
  direction: ChangeDirection;
  source: ChangeSource;
  tx?: Tx;
}): Promise<ChangePolicy> {
  const rules = resolveBillingRulesConfig(input.business);
  const down = input.direction === "downgrade";
  const prorate = {
    upgrade: rules.upgradeProration === "prorated",
    downgrade: rules.downgradeProration === "prorated",
  };
  const { timings, defaultTiming } = changeTimings({
    rule: down ? rules.downgradeTiming : rules.upgradeTiming,
    direction: input.direction,
    source: input.source,
    inTrial: input.subscription.status === "in_trial",
  });

  let blocked: ChangePolicy["blocked"] = null;
  const gate = down ? rules.downgradeGate : rules.upgradeGate;
  if (gate === "invoices_paid" && input.direction !== "same" && input.source !== "scheduled") {
    const read = (tx: Tx) => hasUnpaidInvoices(tx, input.subscription);
    const unpaid = input.tx
      ? await read(input.tx)
      : await withTenant(input.subscription.organizationId, read);
    if (unpaid)
      blocked = {
        code: GATE_CODE,
        message: gateMessage(input.source, down ? "downgrade" : "upgrade"),
      };
  }

  let invoiceImmediately: boolean | null = null;
  if (input.source === "portal") {
    const charge = resolveStorefrontConfig(input.business).chargeUpgrade;
    invoiceImmediately = charge === "now" ? true : charge === "next_invoice" ? false : null;
  }
  const planChangeTerm = resolveLifecycleConfig(input.business).planChangeTerm;
  return { timings, defaultTiming, blocked, prorate, invoiceImmediately, planChangeTerm };
}

/**
 * The `resetTerm` a change gets: the caller's `reset_term` wins, else the business rule
 * when the plan's price moves. Undefined = the engine's own rule (a new billing period resets).
 */
export function resetTermForPolicy(
  policy: ChangePolicy,
  direction: ChangeDirection,
  planMoves: boolean,
  explicit?: boolean,
): boolean | undefined {
  return resetTermFor(policy.planChangeTerm, direction, planMoves, explicit);
}

/** Whether an item edit moves the subscription's plan item onto another price. */
export async function planMovesInEdit(
  tx: Tx,
  subscriptionId: string,
  changes: ItemChange[],
): Promise<boolean> {
  const moving = changes.filter((c) => c.newPriceId);
  if (moving.length === 0) return false;
  const rows = await tx
    .select({ id: subscriptionItems.publicId, price: prices.publicId, kind: products.kind })
    .from(subscriptionItems)
    .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
    .innerJoin(products, eq(products.id, prices.productId))
    .where(eq(subscriptionItems.subscriptionId, subscriptionId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return moving.some((c) => {
    const row = byId.get(c.itemId);
    return row?.kind === "plan" && row.price !== c.newPriceId;
  });
}

/** The proration a change gets: the caller's `prorate` wins, else the rule for its direction. */
export function prorateFor(
  policy: ChangePolicy,
  direction: ChangeDirection,
  explicit?: boolean,
): boolean {
  if (explicit !== undefined) return explicit;
  return direction === "downgrade" ? policy.prorate.downgrade : policy.prorate.upgrade;
}

const MONTHS: Record<string, number> = { day: 12 / 365, week: 12 / 52, month: 1, year: 12 };
const monthsOf = (p: { interval: string | null; intervalCount: number | null }) =>
  (MONTHS[p.interval ?? "month"] ?? 1) * (p.intervalCount || 1);

/**
 * The direction of an item edit as `changeSubscription` takes it (public ids). Same rule
 * as the portal: the plan's billing period first, then the recurring amount per month.
 *
 * Every line is rated from a price snapshot with the engine's own MRR rating
 * (`computeSubscriptionMrr`), so a cycle-aligned add-on (its snapshot already ×12 on a
 * yearly plan), a tiered or volume price at its quantity, and a differential add-on at its
 * per-plan rate all count at what they bill. New snapshots follow the booking's rules:
 * a custom amount overrides, a new price takes the differential for the plan the
 * subscription lands on, and an add-on that stays is re-rated to that plan.
 * Unknown ids are skipped; the change itself refuses them.
 */
export async function directionOfItemEdit(
  tx: Tx,
  sub: { id: string; businessId: string },
  edit: { changes: ItemChange[]; adds?: ItemAdd[]; removes?: string[] },
): Promise<ChangeDirection> {
  // Imported here: the engine modules import this one's callers.
  const { snapshotPrice } = await import("@/modules/catalog/pricing");
  const { computeSubscriptionMrr } = await import("./service");
  const {
    resolveDifferentialAgainstPlanTx,
    resolveDifferentialForAddTx,
    snapshotWithDifferential,
  } = await import("./items");

  const rows = await tx
    .select({ item: subscriptionItems, price: prices, kind: products.kind })
    .from(subscriptionItems)
    .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
    .innerJoin(products, eq(products.id, prices.productId))
    .where(eq(subscriptionItems.subscriptionId, sub.id));
  const wanted = [
    ...edit.changes.map((c) => c.newPriceId),
    ...(edit.adds ?? []).map((a) => a.priceId),
  ].filter((x): x is string => !!x);
  const catalog = wanted.length
    ? await tx
        .select({ price: prices, kind: products.kind })
        .from(prices)
        .innerJoin(products, eq(products.id, prices.productId))
        .where(and(eq(prices.businessId, sub.businessId), inArray(prices.publicId, wanted)))
    : [];
  const byPublic = new Map(catalog.map((r) => [r.price.publicId, r]));

  type Price = typeof prices.$inferSelect;
  type Line = { price: Price; snap: PriceSnapshot; q: number; free: number | null; kind: string };
  const before: Array<Line & { id: string }> = rows.map((r) => ({
    id: r.item.publicId,
    price: r.price,
    snap: (r.item.priceSnapshot as PriceSnapshot | null) ?? snapshotPrice(r.price),
    q: r.item.quantity,
    free: r.item.freeQuantity,
    kind: r.kind,
  }));
  const after = new Map<string, Line>(before.map((l) => [l.id, { ...l }]));

  // The plan product the subscription lands on, as `changeSubscription` resolves it.
  const planProducts = new Set<string>();
  for (const c of edit.changes) {
    const was = after.get(c.itemId);
    if (!was) continue;
    const cand = c.newPriceId ? byPublic.get(c.newPriceId) : undefined;
    if ((cand?.kind ?? was.kind) === "plan") planProducts.add((cand?.price ?? was.price).productId);
  }
  const postPlan = planProducts.size === 1 ? [...planProducts][0]! : null;
  const rateFor = async (price: Price, custom?: number | null) =>
    custom != null
      ? snapshotPrice(price, custom)
      : snapshotWithDifferential(
          price,
          postPlan
            ? await resolveDifferentialAgainstPlanTx(tx, postPlan, price)
            : await resolveDifferentialForAddTx(tx, sub.id, price),
        );

  const repriced = new Set<string>();
  for (const c of edit.changes) {
    const was = after.get(c.itemId);
    if (!was) continue;
    const cand = c.newPriceId ? byPublic.get(c.newPriceId) : undefined;
    if (c.newPriceId && !cand) continue;
    const price = cand?.price ?? was.price;
    if (cand || c.customAmountMinor != null) repriced.add(c.itemId);
    after.set(c.itemId, {
      price,
      snap:
        cand || c.customAmountMinor != null ? await rateFor(price, c.customAmountMinor) : was.snap,
      q: c.newQuantity ?? was.q,
      free: was.free,
      kind: cand?.kind ?? was.kind,
    });
  }
  for (const id of edit.removes ?? []) after.delete(id);
  // An add-on that stays moves to the new plan's differential rate (F-17 in the booking).
  if (postPlan)
    for (const [id, l] of after) {
      if (l.kind !== "addon" || repriced.has(id)) continue;
      const diff = await resolveDifferentialAgainstPlanTx(tx, postPlan, l.price);
      if (diff && (diff.amountMinor != null || diff.tiers != null))
        l.snap = snapshotWithDifferential(l.price, diff);
    }
  let n = 0;
  for (const a of edit.adds ?? []) {
    const cand = byPublic.get(a.priceId);
    if (!cand) continue;
    after.set(`add:${n++}`, {
      price: cand.price,
      snap: await rateFor(cand.price, a.customAmountMinor),
      q: a.quantity ?? 1,
      free: null,
      kind: cand.kind,
    });
  }

  const mrr = (ls: Iterable<Line>) =>
    Number(
      computeSubscriptionMrr(
        [...ls].map((l) => ({
          price: l.price,
          quantity: l.q,
          snapshot: l.snap,
          freeQuantity: l.free,
        })),
      ),
    );
  const planBefore = before.find((l) => l.kind === "plan");
  const planAfter = [...after.values()].find((l) => l.kind === "plan");
  return changeDirection(
    mrr(before),
    mrr(after.values()),
    planBefore && planAfter
      ? { before: monthsOf(planBefore.snap), after: monthsOf(planAfter.snap) }
      : undefined,
  );
}

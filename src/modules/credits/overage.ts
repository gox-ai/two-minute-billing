/**
 * Usage beyond the credits of a unit with no money rate (0530), after the gate split an
 * event's units (`splitEventUnits`):
 *  - billed units become a `credit_overage` charge on the period invoice (`chargeCreditOverage`);
 *  - an overshoot part (`source` overdraft) is repaid by the next grant (settlement), written
 *    off (`forgiveOvershoot`) or, with no subscription, billed on a one-off invoice
 *    (`billCreditOverage`);
 *  - a voided event that was settled gets a correcting settlement (`correctSettledUsage`);
 *  - a full pack refund draws the used units again (`redrawForFullRefund`).
 * Lock order as in `usage-settlement.ts`: the customer lock, grant rows, the balance row, then
 * `credit_usage_events` rows.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { scanBusinessFilter } from "@/platform/clock";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createLogger } from "@/platform/logger";
import { writeAuditLog } from "@/modules/audit/service";
import { lockCustomerBalances } from "@/modules/customers/balances-read";
import { postEntries } from "@/modules/ledger/service";
import { rowsOf } from "@/modules/metering/usage-sql";
import { currencyExponent } from "@/platform/currency";
import { fixed12FromNumeric, formatFixed12 } from "@/platform/fixed";
import {
  rateMeterCombination,
  resolveMeterRate,
  snapshotPrice,
  type PriceSnapshot,
} from "@/modules/catalog/pricing";
import {
  businesses,
  CREDIT_LEDGER_ACCOUNTS as A,
  creditGrants,
  creditUnitBalances,
  creditUnits,
  creditUsageEvents,
  creditUsageSettlements,
  prices,
  unbilledCharges,
  type CreditZeroReason,
} from "@db/schema";
import { drawRestoreCost } from "./credit-cost";
import { groupDigits } from "./grant-limits";
import { NO_SUBSCRIPTION_INVOICE_DAYS, restoreExpiresAt } from "./policy";
import { overageMinorFor } from "./settings-rules";
import { unitPoliciesFor } from "./unit-policies";
import { formatRateE12, formatSteps } from "./units";

const log = createLogger("credits.overage");

/** `unbilled_charges.entity_type` of usage beyond the credits, billed at the unit's price. */
export const CREDIT_OVERAGE_CHARGE = "credit_overage";

/** SQL: days before the overshoot of a customer with no subscription is invoiced (`b` = businesses). */
const invoiceAfterDays = () =>
  sql.raw(`coalesce(case
  when jsonb_typeof(b.credit_config -> 'no_subscription_invoice_after_days') = 'number'
    and (b.credit_config ->> 'no_subscription_invoice_after_days')::numeric
      between ${NO_SUBSCRIPTION_INVOICE_DAYS.min} and ${NO_SUBSCRIPTION_INVOICE_DAYS.max}
  then (b.credit_config ->> 'no_subscription_invoice_after_days')::numeric::int end,
  ${NO_SUBSCRIPTION_INVOICE_DAYS.default})`);

type UsageRow = typeof creditUsageEvents.$inferSelect;

interface UnitInfo {
  organization_id: string;
  business_id: string;
  key: string;
  name: string;
  plural_name: string;
  decimals: number;
  currency: string;
  customer_public_id: string;
}

async function unitInfo(tx: Tx, customerId: string, unitId: string): Promise<UnitInfo> {
  const [r] = rowsOf<UnitInfo>(
    await tx.execute(sql`
      select u.organization_id, u.business_id, u.key, u.name, u.plural_name, u.decimals,
        u.currency, c.public_id as customer_public_id
      from credit_units u join customers c on c.id = ${customerId}
      where u.id = ${unitId}`),
  );
  return r!;
}

async function lockBalance(tx: Tx, customerId: string, unitId: string) {
  const [row] = await tx
    .select({ id: creditUnitBalances.id, available: creditUnitBalances.availableSteps })
    .from(creditUnitBalances)
    .where(
      and(eq(creditUnitBalances.customerId, customerId), eq(creditUnitBalances.unitId, unitId)),
    )
    .for("update")
    .limit(1);
  return row ?? null;
}

const addToBalance = (tx: Tx, rowId: string, steps: bigint) =>
  tx
    .update(creditUnitBalances)
    .set({
      availableSteps: sql`${creditUnitBalances.availableSteps} + ${steps}`,
      updatedAt: sql`app_now()`,
    })
    .where(eq(creditUnitBalances.id, rowId));

/** The audit row of units that were written off or zeroed out, with the reason code. */
export async function recordZeroOut(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    customer: string;
    unit: string;
    units: string;
    reason: CreditZeroReason;
    resourceType: string;
    resourceId: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await writeAuditLog(
    {
      organizationId: input.organizationId,
      businessId: input.businessId,
      action: "credit.zero_out",
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      after: {
        customer: input.customer,
        unit: input.unit,
        units: input.units,
        reason: input.reason,
        ...input.detail,
      },
    },
    tx,
  );
}

/** Units the customer is below zero by and that no one has billed, in steps. */
export async function unbilledOvershoot(
  tx: Tx,
  input: { customerId: string; unitId: string },
): Promise<bigint> {
  const [r] = rowsOf<{ units: string }>(
    await tx.execute(sql`
      select coalesce(sum(units), 0)::text as units from credit_usage_events
      where customer_id = ${input.customerId} and unit_id = ${input.unitId}
        and source = 'overdraft' and status = 'taken'`),
  );
  return BigInt(r?.units ?? "0");
}

/**
 * Write off the overshoot that no one has billed: the parts become `forgiven` and the
 * balance row returns to where it was without them. Returns the units written off.
 */
export async function forgiveOvershoot(
  tx: Tx,
  input: { customerId: string; unitId: string; reason: CreditZeroReason; reference?: string },
): Promise<bigint> {
  await lockCustomerBalances(tx, input.customerId);
  const bal = await lockBalance(tx, input.customerId, input.unitId);
  if (!bal) return 0n;
  const rows = await tx
    .select({ id: creditUsageEvents.id, units: creditUsageEvents.units })
    .from(creditUsageEvents)
    .where(
      and(
        eq(creditUsageEvents.customerId, input.customerId),
        eq(creditUsageEvents.unitId, input.unitId),
        eq(creditUsageEvents.source, "overdraft"),
        eq(creditUsageEvents.status, "taken"),
      ),
    )
    .for("update");
  const total = rows.reduce((s, r) => s + r.units, 0n);
  if (total <= 0n) return 0n;
  await tx
    .update(creditUsageEvents)
    .set({ status: "forgiven", zeroReason: input.reason })
    .where(
      inArray(
        creditUsageEvents.id,
        rows.map((r) => r.id),
      ),
    );
  await addToBalance(tx, bal.id, total);
  const u = await unitInfo(tx, input.customerId, input.unitId);
  await recordZeroOut(tx, {
    organizationId: u.organization_id,
    businessId: u.business_id,
    customer: u.customer_public_id,
    unit: u.key,
    units: formatSteps(total, u.decimals),
    reason: input.reason,
    resourceType: "credit_balance",
    resourceId: input.reference ?? u.customer_public_id,
  });
  log.info("credit overshoot written off", {
    event: "credit_overshoot_forgiven",
    reason: input.reason,
    units: total.toString(),
  });
  return total;
}

/** A plan grant starts: with the `forgive` rule, the overshoot is written off before it. */
export async function forgiveAtPlanReset(
  tx: Tx,
  g: { customerId: string; unitId: string; reference: string | null },
): Promise<bigint> {
  const at = { customerId: g.customerId, unitId: g.unitId };
  if ((await unbilledOvershoot(tx, at)) <= 0n) return 0n;
  const rule = (await unitPoliciesFor(tx, [g.unitId])).get(g.unitId)?.negativeAtReset;
  if (rule !== "forgive") return 0n;
  return forgiveOvershoot(tx, { ...at, reason: "plan_reset", reference: g.reference ?? undefined });
}

// In-app text (ASD-STE100).
const overageText = (meterName: string, amount: string) =>
  `${meterName}: ${groupDigits(amount)}. Usage more than the credit balance.`;

/** Uncovered units of one meter that one money price bills (the unit's, or the meter's). */
interface OverageGroup {
  basis: "meter" | "unit";
  meter_id: string;
  unit_id: string;
  meter: string;
  meter_name: string;
  /** `unit` basis: money per credit, fixed-12 minor units. */
  rate: string | null;
  /** `meter` basis: the price. */
  price_id: string | null;
  units: string;
  /** Fixed-12 text: Σ quantity × uncovered ÷ due. */
  quantity: string;
  first_at: Date;
  ids: string[];
}

/**
 * Uncovered units that a money price bills and that no charge or invoice carries yet. `from`
 * and `charged` (spend): every such unit received in `[from, before)`, billed or not.
 */
async function overageGroups(
  tx: Tx,
  input: {
    customerId: string;
    unitId?: string;
    before: Date;
    lock: boolean;
    from?: Date;
    charged?: boolean;
    meterIds?: string[] | null;
  },
): Promise<OverageGroup[]> {
  return rowsOf<OverageGroup>(
    await tx.execute(sql`
      with rows as (
        select c.id, c.meter_id, c.unit_id, c.overage_basis, c.overage_rate_e12,
          c.overage_price_id, c.units_uncovered, c.quantity, c.units_due, c.received_at
        from credit_usage_events c
        where c.customer_id = ${input.customerId} and c.overage_basis is not null
          ${input.charged ? sql`` : sql`and c.overage_charge_id is null and c.overage_invoice_id is null`}
          and c.units_uncovered > 0 and c.status in ('taken', 'pending', 'settled')
          and c.received_at < ${input.before.toISOString()}::timestamptz
          ${input.from ? sql`and c.received_at >= ${input.from.toISOString()}::timestamptz` : sql``}
          ${
            input.meterIds
              ? sql`and c.meter_id in (${sql.join(
                  input.meterIds.map((m) => sql`${m}`),
                  sql`, `,
                )})`
              : sql``
          }
          ${input.unitId ? sql`and c.unit_id = ${input.unitId}` : sql``}
        order by c.id
        ${input.lock ? sql`for update of c` : sql``})
      select r.overage_basis as basis, r.meter_id, r.unit_id, m.key as meter, m.name as meter_name,
        r.overage_rate_e12::text as rate, r.overage_price_id as price_id,
        sum(r.units_uncovered)::text as units,
        trunc(sum(r.quantity * r.units_uncovered / nullif(r.units_due, 0)), 12)::text as quantity,
        min(r.received_at) as first_at, array_agg(r.id::text order by r.id) as ids
      from rows r join meters m on m.id = r.meter_id
      group by r.overage_basis, r.meter_id, r.unit_id, m.key, m.name, r.overage_rate_e12,
        r.overage_price_id
      order by m.key, r.overage_basis, r.overage_rate_e12, r.overage_price_id`),
  );
}

interface RatedOverage {
  description: string;
  amountMinor: bigint;
  currency: string;
  priceId: string | null;
  quantity: string;
  rating: { credit_overage: Record<string, unknown> };
}

/**
 * The money of one group. `unit`: the units × the unit's price per credit, half up. `meter`:
 * the uncovered quantity rated by the meter price (its rate, tiers, package and free units),
 * with the snapshot of the subscription item that carries the price. Null: nothing to bill
 * yet (less than one minor unit at the unit's price), or the price cannot bill it.
 */
async function rateOverage(
  tx: Tx,
  g: OverageGroup,
  ctx: { customerId: string; subscriptionId: string | null },
): Promise<RatedOverage | null> {
  const units = BigInt(g.units);
  const quantity = fixed12FromNumeric(g.quantity);
  if (g.basis === "unit") {
    const u = await unitInfo(tx, ctx.customerId, g.unit_id);
    const rate = BigInt(g.rate!);
    const amountMinor = overageMinorFor(units, rate, u.decimals);
    if (amountMinor <= 0n) return null;
    const credits = formatSteps(units, u.decimals);
    return {
      description: overageText(
        g.meter_name,
        `${credits} ${credits === "1" ? u.name : u.plural_name}`,
      ),
      amountMinor,
      currency: u.currency,
      priceId: null,
      quantity: formatFixed12(quantity),
      rating: {
        credit_overage: {
          basis: "unit",
          meter: g.meter,
          unit: u.key,
          quantity: formatFixed12(quantity),
          credit_units: credits,
          minor_per_credit: formatRateE12(rate),
        },
      },
    };
  }
  const [p] = await tx.select().from(prices).where(eq(prices.id, g.price_id!)).limit(1);
  if (!p) return null;
  const [item] = rowsOf<{ snap: PriceSnapshot | null; free: number | null }>(
    await tx.execute(sql`
      select si.price_snapshot as snap, si.free_quantity as free
      from subscription_items si join subscriptions s on s.id = si.subscription_id
      where si.price_id = ${p.id} and s.customer_id = ${ctx.customerId}
      order by (s.id = ${ctx.subscriptionId ?? null}::uuid) desc nulls last, s.created_at desc
      limit 1`),
  );
  const snap = item?.snap ?? snapshotPrice(p);
  if ((snap.amountSource ?? "rate") !== "rate") return null;
  const currency = snap.currency || p.currency;
  const rated = rateMeterCombination({
    model: snap.model,
    amountSource: "rate",
    quantity,
    freeQuantity: Math.max(0, item?.free ?? snap.freeQuantity ?? 0),
    rate: resolveMeterRate(snap, {}),
    quantityDivisor: BigInt(snap.quantityDivisor ?? "1"),
    packageSize: snap.packageSize,
    markupPercent: snap.markupPercent != null ? fixed12FromNumeric(snap.markupPercent) : null,
    currencyExponent: currencyExponent(currency),
  });
  return {
    description: overageText(g.meter_name, formatFixed12(quantity)),
    amountMinor: rated.amountMinor,
    currency,
    priceId: p.id,
    quantity: formatFixed12(quantity),
    rating: {
      credit_overage: {
        basis: "meter",
        meter: g.meter,
        price: p.publicId,
        quantity: formatFixed12(quantity),
        billable_quantity: formatFixed12(rated.billableQuantity),
        unit_amount: formatFixed12(rated.unitAmount),
        credit_units: formatSteps(units, (await unitInfo(tx, ctx.customerId, g.unit_id)).decimals),
      },
    },
  };
}

/** The customer's oldest live subscription: the one that carries the credit lines. */
/**
 * The subscription that carries a customer's credit usage (their oldest live one), or null
 * when the customer has none. A page uses it to show usage paid with credits or billed past them.
 */
export async function creditUsageSubscriptionId(
  tx: Tx,
  customerId: string,
): Promise<string | null> {
  const [any] = rowsOf<{ x: number }>(
    await tx.execute(
      sql`select 1 as x from credit_usage_events where customer_id = ${customerId} limit 1`,
    ),
  );
  return any ? primarySubscriptionId(tx, customerId) : null;
}

async function primarySubscriptionId(tx: Tx, customerId: string): Promise<string | null> {
  const [s] = rowsOf<{ id: string }>(
    await tx.execute(sql`
      select id from subscriptions where customer_id = ${customerId} and status <> 'cancelled'
      order by created_at, id limit 1`),
  );
  return s?.id ?? null;
}

/** One charge the period invoice would queue: the rated group and the events it carries. */
export interface PlannedOverage extends RatedOverage {
  periodStart: Date;
  periodEnd: Date;
  ids: string[];
}

interface OverageInput {
  customerId: string;
  subscriptionId: string;
  currency: string;
  before: Date;
}

/**
 * The charges of usage beyond the credits for the period invoice of `subscriptionId`: per meter
 * and price, the uncovered units received before `before` that nothing billed yet, rated. Empty
 * unless that subscription is the customer's oldest live one. `lock` takes the customer lock
 * and the event rows (the write path); without it nothing is locked or written.
 */
async function planOverage(
  tx: Tx,
  input: OverageInput & { lock: boolean },
): Promise<PlannedOverage[]> {
  const [any] = rowsOf<{ x: number }>(
    await tx.execute(sql`
      select 1 as x from credit_usage_events
      where customer_id = ${input.customerId} and overage_basis is not null
        and overage_charge_id is null and overage_invoice_id is null
        and units_uncovered > 0 limit 1`),
  );
  if (!any) return [];
  if ((await primarySubscriptionId(tx, input.customerId)) !== input.subscriptionId) return [];
  if (input.lock) await lockCustomerBalances(tx, input.customerId);
  const out: PlannedOverage[] = [];
  for (const g of await overageGroups(tx, input)) {
    const r = await rateOverage(tx, g, input);
    if (!r) continue;
    if (r.currency !== input.currency) {
      if (input.lock)
        log.error(
          new Error("credit overage not billed: the price and the subscription differ in currency"),
          { event: "credit_overage_currency_mismatch", customerId: input.customerId },
        );
      continue;
    }
    out.push({ ...r, periodStart: new Date(g.first_at), periodEnd: input.before, ids: g.ids });
  }
  return out;
}

/**
 * Usage beyond the credits that a money price bills, for a subscriber: one pending charge per
 * meter and price for the events received before `before`. The period invoice planned next
 * takes it as a usage line (taxed as its price, or as a charge when the unit's price bills
 * it). Runs in its own transaction before that invoice is planned. An event is charged once
 * (`overage_charge_id`). Only the customer's oldest live subscription carries it, as it
 * carries the information lines.
 */
export async function chargeCreditOverage(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  subscriptionId: string;
  currency: string;
  before: Date;
}): Promise<number> {
  return withTenant(input.organizationId, async (tx) => {
    const planned = await planOverage(tx, { ...input, lock: true });
    for (const r of planned) {
      const [charge] = await tx
        .insert(unbilledCharges)
        .values({
          organizationId: input.organizationId,
          businessId: input.businessId,
          subscriptionId: input.subscriptionId,
          publicId: publicId("uch"),
          description: r.description,
          amountMinor: r.amountMinor,
          currency: input.currency,
          periodStart: r.periodStart,
          periodEnd: r.periodEnd,
          quantity: 1,
          priceId: r.priceId,
          entityType: CREDIT_OVERAGE_CHARGE,
          rating: r.rating,
        })
        .returning({ id: unbilledCharges.id });
      await tx
        .update(creditUsageEvents)
        .set({ overageChargeId: charge!.id })
        .where(inArray(creditUsageEvents.id, r.ids));
    }
    return planned.length;
  });
}

/**
 * What `chargeCreditOverage` would queue now, rated the same way, with nothing locked or
 * written: the renewal estimate shows it as the usage lines the invoice will bill.
 */
export function previewCreditOverage(tx: Tx, input: OverageInput): Promise<PlannedOverage[]> {
  return planOverage(tx, { ...input, lock: false });
}

/**
 * Money billed for usage beyond the credits, pre-tax: the spend measure's share of a
 * credit-cost meter. `window` null = the term of the customer's oldest live subscription (the
 * one whose invoice bills it); spend is read up to `now`. Rated as the period invoice rates
 * it: inside that term it is rated(term start → to) − rated(term start → from), so free units
 * and tiers land where the invoice puts them. Leaves out an overshoot (not billed yet).
 * Null: nothing to measure.
 */
export async function overageSpend(
  tx: Tx,
  q: {
    customerId: string;
    currency: string;
    now: Date;
    window: { start: Date; end: Date } | null;
    meterIds?: string[] | null;
    subscriptionId?: string | null;
  },
): Promise<{ amountMinor: bigint; window: { start: Date; end: Date } } | null> {
  if (q.meterIds?.length === 0) return null;
  const [any] = rowsOf<{ x: number }>(
    await tx.execute(sql`
      select 1 as x from credit_usage_events
      where customer_id = ${q.customerId} and overage_basis is not null and units_uncovered > 0
      limit 1`),
  );
  if (!any) return null;
  const primary = await primarySubscriptionId(tx, q.customerId);
  if (q.subscriptionId && primary !== q.subscriptionId) return null;
  const [sub] = primary
    ? rowsOf<{ start: Date | null; end: Date | null }>(
        await tx.execute(sql`
          select current_period_start as start, current_period_end as "end"
          from subscriptions where id = ${primary}`),
      )
    : [];
  const term = sub?.start ? new Date(sub.start) : null;
  const window = q.window ?? (term && sub?.end ? { start: term, end: new Date(sub.end) } : null);
  if (!window) return null;
  const from = window.start;
  const to = new Date(Math.min(q.now.getTime(), window.end.getTime()));
  const rate = async (a: Date, b: Date) => {
    if (b.getTime() <= a.getTime()) return 0n;
    let total = 0n;
    const groups = await overageGroups(tx, {
      customerId: q.customerId,
      from: a,
      before: b,
      lock: false,
      charged: true,
      meterIds: q.meterIds ?? null,
    });
    for (const g of groups) {
      const r = await rateOverage(tx, g, { customerId: q.customerId, subscriptionId: primary });
      if (r && r.currency.toUpperCase() === q.currency.toUpperCase()) total += r.amountMinor;
    }
    return total;
  };
  let total: bigint;
  if (!term || term.getTime() >= to.getTime()) total = await rate(from, to);
  else if (from.getTime() < term.getTime())
    total = (await rate(from, term)) + (await rate(term, to));
  else total = (await rate(term, to)) - (await rate(term, from));
  return { amountMinor: total > 0n ? total : 0n, window };
}

/** One credit-cost meter in the current usage of the primary subscription. */
export interface CreditMeterUsage {
  meter: string;
  name: string;
  unit: string;
  unitName: string;
  unitPluralName: string;
  /** Fixed-12 text: the quantity that credits paid, and the credits it took (unit text). */
  paidQuantity: string;
  paidUnits: string;
  /** What the next period invoice bills in money, per price: rated as that invoice rates it. */
  billed: Array<{
    basis: "meter" | "unit";
    pricePublicId: string | null;
    quantity: string;
    units: string;
    amountMinor: bigint;
    priceId: string | null;
  }>;
  /** Units taken below zero that no grant repaid and no invoice billed (unit text). */
  overshootUnits: string;
  /** Fixed-12 text: this meter's quantity used below a zero balance, not settled yet. */
  belowZeroQuantity: string;
}

/**
 * The credit-cost meters of the next period invoice, read-only: per meter, the quantity that
 * credits paid since the last information line, the money part `chargeCreditOverage` would
 * queue (`previewCreditOverage`) and the open overshoot. Empty unless `subscriptionId` is the
 * customer's oldest live subscription.
 */
export async function creditUsageSoFar(
  tx: Tx,
  input: OverageInput & { subscriptionStart: Date },
): Promise<CreditMeterUsage[]> {
  const [any] = rowsOf<{ x: number }>(
    await tx.execute(
      sql`select 1 as x from credit_usage_events where customer_id = ${input.customerId} limit 1`,
    ),
  );
  if (!any) return [];
  if ((await primarySubscriptionId(tx, input.customerId)) !== input.subscriptionId) return [];
  const { coveredCreditUsage, creditLinesFrom } = await import("./usage-settlement");
  const from = await creditLinesFrom(tx, input);
  const covered =
    from.getTime() < input.before.getTime()
      ? await coveredCreditUsage(tx, { customerId: input.customerId, from, before: input.before })
      : [];
  const planned = await previewCreditOverage(tx, input);
  // An event that crosses zero keeps its quantity on its first part only: the overdraft part's
  // share is the event's quantity × its units / the units due, as covered usage counts it.
  const over = rowsOf<{ meter: string; units: string; quantity: string }>(
    await tx.execute(sql`
      with r as (
        select c.meter_id, c.part, c.units, c.source, c.status,
          first_value(c.quantity) over w as q0, first_value(c.units_due) over w as d0
        from credit_usage_events c
        where c.customer_id = ${input.customerId}
        window w as (partition by c.event_id, c.meter_id order by c.part))
      select m.key as meter, sum(r.units)::text as units,
        trunc(sum(case when r.d0 > 0 then r.q0 * r.units / r.d0
          when r.part = 0 then r.q0 else 0 end), 12)::text as quantity
      from r join meters m on m.id = r.meter_id
      where r.source = 'overdraft' and r.status = 'taken'
      group by m.key`),
  );
  const meta = rowsOf<{
    meter: string;
    name: string;
    unit: string;
    unit_name: string;
    plural: string;
    decimals: number;
  }>(
    await tx.execute(sql`
      select distinct m.key as meter, m.name, u.key as unit, u.name as unit_name,
        u.plural_name as plural, u.decimals
      from credit_usage_events c
      join meters m on m.id = c.meter_id join credit_units u on u.id = c.unit_id
      where c.customer_id = ${input.customerId}`),
  );
  const out = new Map<string, CreditMeterUsage>();
  const entry = (meter: string): CreditMeterUsage | null => {
    const m = meta.find((x) => x.meter === meter);
    if (!m) return null;
    let e = out.get(meter);
    if (!e) {
      e = {
        meter,
        name: m.name,
        unit: m.unit,
        unitName: m.unit_name,
        unitPluralName: m.plural,
        paidQuantity: "0",
        paidUnits: "0",
        billed: [],
        overshootUnits: "0",
        belowZeroQuantity: "0",
      };
      out.set(meter, e);
    }
    return e;
  };
  for (const c of covered) {
    const e = entry(c.meter);
    if (!e) continue;
    e.paidQuantity = formatFixed12(fixed12FromNumeric(c.quantity));
    e.paidUnits = formatSteps(BigInt(c.units), c.decimals);
  }
  for (const p of planned) {
    const r = p.rating.credit_overage as {
      basis: "meter" | "unit";
      meter: string;
      price?: string;
      credit_units: string;
    };
    const e = entry(r.meter);
    if (!e) continue;
    e.billed.push({
      basis: r.basis,
      pricePublicId: r.price ?? null,
      quantity: p.quantity,
      units: r.credit_units,
      amountMinor: p.amountMinor,
      priceId: p.priceId,
    });
  }
  for (const o of over) {
    const e = entry(o.meter);
    if (e) e.belowZeroQuantity = formatFixed12(fixed12FromNumeric(o.quantity));
  }
  // The negative balance belongs to the unit, and the balance row has it now (a top-up
  // repays it at once there, before the hourly settlement): shown once, on the unit's
  // first meter.
  const negative = new Map(
    rowsOf<{ unit: string; steps: string }>(
      await tx.execute(sql`
        select u.key as unit, (-b.available_steps)::text as steps
        from credit_unit_balances b join credit_units u on u.id = b.unit_id
        where b.customer_id = ${input.customerId} and b.available_steps < 0`),
    ).map((r) => [r.unit, BigInt(r.steps)]),
  );
  const sorted = [...out.values()].sort((a, b) => a.meter.localeCompare(b.meter));
  const shown = new Set<string>();
  for (const e of sorted) {
    const steps = negative.get(e.unit);
    if (!steps || shown.has(e.unit)) continue;
    shown.add(e.unit);
    e.overshootUnits = formatSteps(steps, meta.find((x) => x.meter === e.meter)!.decimals);
  }
  return sorted;
}

/**
 * Bill what a customer with no live subscription owes for usage beyond the credits, on a
 * one-off invoice: the overshoot that no grant repaid, at the unit's overage price (those
 * parts become `billed` and leave the balance row), and uncovered units that a money price
 * billed at the gate and no period invoice carried. With no unit price the overshoot is not
 * billed and waits for the next grant. Returns the invoice's public id, or null.
 */
export async function billCreditOverage(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  unitId: string;
  now: Date;
}): Promise<string | null> {
  const plan = await withTenant(input.organizationId, async (tx) => {
    await lockCustomerBalances(tx, input.customerId);
    // A grant that arrived since repays first.
    const { settleCreditUsage } = await import("./usage-settlement");
    await settleCreditUsage(tx, { ...input, cutoff: null });
    const price = (await unitPoliciesFor(tx, [input.unitId])).get(
      input.unitId,
    )?.overageMinorPerUnitE12;
    const u = await unitInfo(tx, input.customerId, input.unitId);
    const over = price
      ? rowsOf<{ meter: string; meter_name: string; units: string; ids: string[] }>(
          await tx.execute(sql`
            select m.key as meter, m.name as meter_name, sum(c.units)::text as units,
              array_agg(c.id::text order by c.id) as ids
            from credit_usage_events c join meters m on m.id = c.meter_id
            where c.customer_id = ${input.customerId} and c.unit_id = ${input.unitId}
              and c.source = 'overdraft' and c.status = 'taken'
            group by m.key, m.name order by m.key`),
        )
      : [];
    const rest: Array<RatedOverage & { ids: string[] }> = [];
    for (const g of await overageGroups(tx, { ...input, before: input.now, lock: false })) {
      const r = await rateOverage(tx, g, { customerId: input.customerId, subscriptionId: null });
      if (r && r.currency === u.currency) rest.push({ ...r, ids: g.ids });
    }
    return { price: price ?? null, u, over, rest };
  });
  const { u } = plan;
  const lines: Array<{
    description: string;
    amountMinor: bigint;
    priceId: string | null;
    rating: RatedOverage["rating"];
    ids: string[];
    units: bigint;
    overshoot: boolean;
  }> = [];
  for (const o of plan.over) {
    const units = BigInt(o.units);
    const amountMinor = overageMinorFor(units, plan.price!, u.decimals);
    if (amountMinor <= 0n) continue;
    const credits = formatSteps(units, u.decimals);
    lines.push({
      description: overageText(
        o.meter_name,
        `${credits} ${credits === "1" ? u.name : u.plural_name}`,
      ),
      amountMinor,
      priceId: null,
      rating: {
        credit_overage: {
          basis: "unit",
          meter: o.meter,
          unit: u.key,
          credit_units: credits,
          minor_per_credit: formatRateE12(plan.price!),
          overdrawn: true,
        },
      },
      ids: o.ids,
      units,
      overshoot: true,
    });
  }
  for (const r of plan.rest)
    lines.push({
      description: r.description,
      amountMinor: r.amountMinor,
      priceId: r.priceId,
      rating: r.rating,
      ids: r.ids,
      units: 0n,
      overshoot: false,
    });
  if (!lines.length) return null;
  const allIds = lines.flatMap((l) => l.ids).sort();
  const { createInvoiceFromLines } = await import("@/modules/invoicing/service");
  const { invoice } = await createInvoiceFromLines({
    organizationId: input.organizationId,
    businessId: input.businessId,
    customerId: input.customerId,
    currency: u.currency,
    lines: lines.map((l) => ({
      description: l.description,
      amountMinor: l.amountMinor,
      quantity: 1,
      kind: "usage",
      priceId: l.priceId,
    })),
    applyTax: true,
    applyCredit: true,
    oneOff: true,
    collect: true,
    // The same events are never billed twice: a second run reuses the invoice.
    originToken: `credit-overage:${allIds[0]}:${allIds.length}`,
    inTx: async (tx, created) => {
      await lockCustomerBalances(tx, input.customerId);
      const bal = await lockBalance(tx, input.customerId, input.unitId);
      const overIds = lines.filter((l) => l.overshoot).flatMap((l) => l.ids);
      const restIds = lines.filter((l) => !l.overshoot).flatMap((l) => l.ids);
      const moved = overIds.length
        ? await tx
            .update(creditUsageEvents)
            .set({ status: "billed", overageInvoiceId: created.invoice.id })
            .where(
              and(
                inArray(creditUsageEvents.id, overIds),
                eq(creditUsageEvents.status, "taken"),
                eq(creditUsageEvents.source, "overdraft"),
              ),
            )
            .returning({ units: creditUsageEvents.units })
        : [];
      const marked = restIds.length
        ? await tx
            .update(creditUsageEvents)
            .set({ overageInvoiceId: created.invoice.id })
            .where(
              and(
                inArray(creditUsageEvents.id, restIds),
                sql`${creditUsageEvents.overageChargeId} is null`,
                sql`${creditUsageEvents.overageInvoiceId} is null`,
                inArray(creditUsageEvents.status, ["taken", "pending", "settled"]),
              ),
            )
            .returning({ id: creditUsageEvents.id })
        : [];
      const movedUnits = moved.reduce((s, r) => s + r.units, 0n);
      const want = lines.filter((l) => l.overshoot).reduce((s, l) => s + l.units, 0n);
      // A grant, a void or another run changed the parts since the plan: bill nothing.
      if (
        moved.length !== overIds.length ||
        movedUnits !== want ||
        marked.length !== restIds.length
      )
        throw new OverageChangedError();
      // Billed in money now: the units leave the balance, so no grant repays them.
      if (bal && movedUnits > 0n) await addToBalance(tx, bal.id, movedUnits);
      for (const [i, l] of lines.entries())
        await tx.execute(sql`
          update invoice_line_items set rating = ${JSON.stringify(l.rating)}::jsonb
          where id = ${created.lines[i]!.id}`);
    },
  }).catch((e) => {
    if (e instanceof OverageChangedError) return { invoice: null };
    throw e;
  });
  if (!invoice) return null;
  log.info("credit overage invoiced", {
    event: "credit_overage_invoiced",
    invoice: invoice.publicId,
    lines: lines.length,
  });
  return invoice.publicId;
}

class OverageChangedError extends Error {
  constructor() {
    super("The credit overage changed while we created the invoice.");
    this.name = "OverageChangedError";
  }
}

/**
 * The invoice of an overshoot is voided: the debt is written off. The units left the balance
 * when the invoice was raised, so only the parts and the audit row change.
 */
export async function forgiveVoidedOverageInvoice(
  tx: Tx,
  input: { invoiceId: string; invoicePublicId: string },
): Promise<void> {
  const rows = await tx
    .update(creditUsageEvents)
    .set({ status: "forgiven", zeroReason: "invoice_voided" })
    .where(
      and(
        eq(creditUsageEvents.overageInvoiceId, input.invoiceId),
        eq(creditUsageEvents.status, "billed"),
      ),
    )
    .returning({
      customerId: creditUsageEvents.customerId,
      unitId: creditUsageEvents.unitId,
      units: creditUsageEvents.units,
    });
  if (!rows.length) return;
  const u = await unitInfo(tx, rows[0]!.customerId!, rows[0]!.unitId);
  await recordZeroOut(tx, {
    organizationId: u.organization_id,
    businessId: u.business_id,
    customer: u.customer_public_id,
    unit: u.key,
    units: formatSteps(
      rows.reduce((s, r) => s + r.units, 0n),
      u.decimals,
    ),
    reason: "invoice_voided",
    resourceType: "invoice",
    resourceId: input.invoicePublicId,
  });
}

/**
 * The overage invoice pass, for a customer with no live subscription. Bills once the oldest
 * unbilled item is `no_subscription_invoice_after_days` old (30 when unset), and at once when the customer was archived or their last
 * subscription was cancelled after the usage (closure).
 */
export async function runBillCreditOverage(
  now: Date,
  opts: { limit?: number } = {},
): Promise<{ invoiced: number; failed: number }> {
  const limit = opts.limit ?? 200;
  const due = rowsOf<{
    organization_id: string;
    business_id: string;
    customer_id: string;
    unit_id: string;
  }>(
    await systemDb.execute(sql`
      select distinct c.organization_id, c.business_id, c.customer_id, c.unit_id
      from credit_usage_events c join customers cu on cu.id = c.customer_id
        join businesses b on b.id = c.business_id
      where ((c.source = 'overdraft' and c.status = 'taken')
          or (c.overage_basis is not null and c.overage_charge_id is null
              and c.overage_invoice_id is null and c.units_uncovered > 0
              and c.status in ('taken', 'pending', 'settled')))
        and c.received_at <= ${now.toISOString()}::timestamptz
        and c.business_id in (
          select id from businesses where ${scanBusinessFilter(businesses.id) ?? sql`true`})
        and not exists (
          select 1 from subscriptions s
          where s.customer_id = c.customer_id and s.status in ('active', 'in_trial'))
        and (c.received_at <= ${now.toISOString()}::timestamptz - make_interval(days => ${invoiceAfterDays()})
          or not cu.active
          or exists (
            select 1 from subscriptions s
            where s.customer_id = c.customer_id and s.canceled_at >= c.received_at))
      limit ${limit}`),
  );
  const out = { invoiced: 0, failed: 0 };
  for (const d of due) {
    try {
      const id = await billCreditOverage({
        organizationId: d.organization_id,
        businessId: d.business_id,
        customerId: d.customer_id,
        unitId: d.unit_id,
        now,
      });
      if (id) out.invoiced++;
    } catch (e) {
      out.failed++;
      log.error(e, { event: "credit_overage_invoice_failed", customerId: d.customer_id });
    }
  }
  return out;
}

/**
 * A voided event whose credits a settlement drew: give the units back and reverse the
 * revenue. Per settlement and meter, one `correction` row; a `restore` movement on each
 * grant it drew (a grant that is closed gets a new restore grant, drawn first, that expires
 * after `restore_expiry_months`), and Dr revenue / Cr credit_grants_paid at the cost returned. Caller holds the
 * customer lock and the event's rows.
 */
export async function correctSettledUsage(
  tx: Tx,
  input: { businessId: string; eventId: string; rows: readonly UsageRow[]; now: Date },
): Promise<void> {
  const settled = input.rows.filter((r) => r.status === "settled" && r.units > 0n);
  const groups = new Map<string, UsageRow[]>();
  for (const r of settled) {
    const k = `${r.settlementId}|${r.meterId}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const rows of groups.values()) {
    const first = rows[0]!;
    const settlementId = first.settlementId!;
    const units = rows.reduce((s, r) => s + r.units, 0n);
    const [orig] = await tx
      .select()
      .from(creditUsageSettlements)
      .where(eq(creditUsageSettlements.id, settlementId))
      .limit(1);
    const draws = rowsOf<{ grant_id: string; units: string; cost: string }>(
      await tx.execute(sql`
        select grant_id, (-sum(units))::text as units, (-sum(cost_minor))::text as cost
        from credit_grant_movements
        where settlement_id = ${settlementId} and kind = 'draw'
        group by grant_id order by grant_id`),
    );
    const returned = rowsOf<{ grant_id: string; units: string; cost: string }>(
      await tx.execute(sql`
        select (case when exists (
            select 1 from credit_grant_movements d
            where d.settlement_id = ${settlementId} and d.kind = 'draw' and d.grant_id = g.id)
          then g.id else g.restored_from_id end) as grant_id, sum(m.units)::text as units,
          sum(m.cost_minor)::text as cost
        from credit_grant_movements m
        join credit_grants g on g.id = m.grant_id
        join credit_usage_settlements c on c.id = m.settlement_id
        where c.kind = 'correction' and c.corrects_settlement_id = ${settlementId}
          and m.kind = 'restore'
        group by 1`),
    );
    const backOf = new Map(returned.map((r) => [r.grant_id, r]));
    const [prev] = rowsOf<{ seq: number }>(
      await tx.execute(sql`
        select seq from credit_usage_settlements
        where customer_id = ${first.customerId} and meter_id = ${first.meterId}
        order by seq desc limit 1`),
    );
    // The share of each grant, in the order the settlement drew them.
    const plan: Array<{ grantId: string; units: bigint; costMinor: bigint }> = [];
    let left = units;
    for (const d of draws) {
      if (left <= 0n) break;
      const draw = { units: BigInt(d.units), costMinor: BigInt(d.cost) };
      const b = backOf.get(d.grant_id);
      const back = { units: BigInt(b?.units ?? "0"), costMinor: BigInt(b?.cost ?? "0") };
      const room = draw.units - back.units;
      const take = left < room ? left : room;
      if (take <= 0n) continue;
      plan.push({ grantId: d.grant_id, units: take, costMinor: drawRestoreCost(draw, back, take) });
      left -= take;
    }
    const given = plan.reduce((s, p) => s + p.units, 0n);
    const revenue = plan.reduce((s, p) => s + p.costMinor, 0n);
    const head = rows.find((r) => r.part === 0);
    const [correction] = await tx
      .insert(creditUsageSettlements)
      .values({
        organizationId: first.organizationId,
        businessId: first.businessId,
        publicId: publicId("cst"),
        customerId: first.customerId!,
        meterId: first.meterId,
        unitId: first.unitId,
        subscriptionId: orig?.subscriptionId ?? null,
        seq: (prev?.seq ?? 0) + 1,
        kind: "correction",
        correctsEventId: input.eventId,
        correctsSettlementId: settlementId,
        windowStart: input.now,
        windowEnd: input.now,
        events: 1,
        quantity: head?.quantity ?? "0",
        unitsDue: units,
        unitsDrawn: given,
        currency: orig!.currency,
        revenueMinor: revenue,
      })
      .returning();
    const { insertCreditGrant, recordGrantMovement } = await import("./service");
    for (const p of plan) {
      const [g] = await tx
        .select()
        .from(creditGrants)
        .where(eq(creditGrants.id, p.grantId))
        .for("update")
        .limit(1);
      if (!g) continue;
      let ledgerTx: string | null = null;
      if (p.costMinor > 0n) {
        const r = await postEntries(
          {
            organizationId: g.organizationId,
            businessId: g.businessId,
            customerId: g.customerId,
            sourceType: "credit_usage",
            sourceId: correction!.publicId,
            lines: [
              {
                account: "revenue",
                direction: "debit",
                amountMinor: p.costMinor,
                currency: g.currency,
              },
              {
                account: A.paid,
                direction: "credit",
                amountMinor: p.costMinor,
                currency: g.currency,
              },
            ],
          },
          tx,
        );
        ledgerTx = r.transactionId;
      }
      const [closed] = rowsOf<{ x: number }>(
        await tx.execute(
          sql`select 1 as x from credit_grant_grace where grant_id = ${g.id} limit 1`,
        ),
      );
      const live =
        g.status === "active" &&
        !closed &&
        (g.expiresAt === null || g.expiresAt.getTime() > input.now.getTime());
      if (live) {
        await recordGrantMovement(tx, {
          grant: g,
          kind: "restore",
          units: p.units,
          faceMinor: 0n,
          costMinor: p.costMinor,
          settlementId: correction!.id,
          ledgerTransactionId: ledgerTx,
        });
        continue;
      }
      const [unit] = await tx.select().from(creditUnits).where(eq(creditUnits.id, g.unitId!));
      const [biz] = await tx
        .select({ cfg: businesses.creditConfig })
        .from(businesses)
        .where(eq(businesses.id, g.businessId));
      const expiresAt = restoreExpiresAt(biz?.cfg, input.now);
      await insertCreditGrant(tx, {
        organizationId: g.organizationId,
        businessId: g.businessId,
        customerId: g.customerId,
        currency: g.currency,
        unit: unit!,
        amount: p.units,
        costBasisMinor: p.costMinor,
        category: g.category as "paid" | "promotional",
        priority: g.priority,
        effectiveAt: input.now,
        expiresAt,
        applicability: g.applicability ?? { kind: "metered" },
        source: "restore",
        invoiceId: g.invoiceId,
        restoredFromId: g.id,
        taxTreatment: g.taxTreatment,
        onExhausted: g.onExhausted,
        opening: {
          kind: "restore",
          ledger: false,
          settlementId: correction!.id,
          ledgerTransactionId: ledgerTx,
        },
      });
    }
    if (given !== units)
      log.error(new Error("credit usage correction gave back less than the event took"), {
        event: "credit_usage_correction_short",
        settlement: correction!.publicId,
      });
  }
}

/**
 * A full refund of a pack in a unit with no rate: the usage the pack paid is drawn again from
 * the customer's other grants in the unit, as far as the balance row offers (holds keep
 * theirs), with revenue at their cost; what no grant can pay is written off (reason
 * `full_refund`). The pack's own revenue for that usage is reversed by the credit note.
 * Caller holds the customer lock and has settled the unit. Returns the units drawn again.
 */
export async function redrawForFullRefund(
  tx: Tx,
  input: { grantId: string; units: bigint; creditNotePublicId: string; now: Date },
): Promise<{ redrawn: bigint; writtenOff: bigint }> {
  const [g] = await tx.select().from(creditGrants).where(eq(creditGrants.id, input.grantId));
  if (!g?.unitId || input.units <= 0n) return { redrawn: 0n, writtenOff: 0n };
  const [last] = rowsOf<{ settlement_id: string; meter_id: string; meter_key: string }>(
    await tx.execute(sql`
      select m.settlement_id, s.meter_id, me.key as meter_key
      from credit_grant_movements m
      join credit_usage_settlements s on s.id = m.settlement_id
      join meters me on me.id = s.meter_id
      where m.grant_id = ${g.id} and m.kind = 'draw'
      order by m.created_at desc, m.id desc limit 1`),
  );
  const bal = await lockBalance(tx, g.customerId, g.unitId);
  const [row] = bal
    ? rowsOf<{ offered: string }>(
        await tx.execute(sql`
          select (available_steps - greatest(held_steps - pinned_steps, 0))::text as offered
          from credit_unit_balances where id = ${bal.id}`),
      )
    : [];
  const offered = BigInt(row?.offered ?? "0");
  const { loadDrawGrants } = await import("./usage-settlement");
  const { allocateUnitDraws } = await import("./credit-cost");
  const { grants, unitGrants } = await loadDrawGrants(tx, g.customerId, g.unitId);
  const others = unitGrants.filter((x) => x.id !== g.id);
  const room = others.reduce((s, x) => s + x.remainingUnits, 0n);
  let want = input.units;
  if (want > offered) want = offered > 0n ? offered : 0n;
  if (want > room) want = room;
  let redrawn = 0n;
  if (want > 0n && last) {
    const plan = allocateUnitDraws(others, [
      { meterId: last.meter_id, meterKey: last.meter_key, payAt: input.now, units: want },
    ]);
    redrawn = plan.draws.reduce((s, d) => s + d.units, 0n);
    const revenue = plan.draws.reduce((s, d) => s + d.costMinor, 0n);
    const [prev] = rowsOf<{ seq: number }>(
      await tx.execute(sql`
        select seq from credit_usage_settlements
        where customer_id = ${g.customerId} and meter_id = ${last.meter_id}
        order by seq desc limit 1`),
    );
    const [s] = await tx
      .insert(creditUsageSettlements)
      .values({
        organizationId: g.organizationId,
        businessId: g.businessId,
        publicId: publicId("cst"),
        customerId: g.customerId,
        meterId: last.meter_id,
        unitId: g.unitId,
        seq: (prev?.seq ?? 0) + 1,
        kind: "redraw",
        correctsSettlementId: last.settlement_id,
        windowStart: input.now,
        windowEnd: input.now,
        unitsDue: input.units,
        unitsDrawn: redrawn,
        currency: g.currency,
        revenueMinor: revenue,
      })
      .returning();
    const byId = new Map(grants.map((x) => [x.id, x]));
    const { recordGrantMovement } = await import("./service");
    for (const d of plan.draws) {
      const og = byId.get(d.grantId)!;
      let ledgerTx: string | null = null;
      if (d.costMinor > 0n)
        ledgerTx = (
          await postEntries(
            {
              organizationId: og.organizationId,
              businessId: og.businessId,
              customerId: og.customerId,
              sourceType: "credit_usage",
              sourceId: s!.publicId,
              lines: [
                {
                  account: A.paid,
                  direction: "debit",
                  amountMinor: d.costMinor,
                  currency: og.currency,
                },
                {
                  account: "revenue",
                  direction: "credit",
                  amountMinor: d.costMinor,
                  currency: og.currency,
                },
              ],
            },
            tx,
          )
        ).transactionId;
      await recordGrantMovement(tx, {
        grant: og,
        kind: "draw",
        units: -d.units,
        faceMinor: 0n,
        costMinor: -d.costMinor,
        settlementId: s!.id,
        ledgerTransactionId: ledgerTx,
      });
    }
  }
  const writtenOff = input.units - redrawn;
  if (writtenOff > 0n) {
    const u = await unitInfo(tx, g.customerId, g.unitId);
    await recordZeroOut(tx, {
      organizationId: g.organizationId,
      businessId: g.businessId,
      customer: u.customer_public_id,
      unit: u.key,
      units: formatSteps(writtenOff, u.decimals),
      reason: "full_refund",
      resourceType: "credit_note",
      resourceId: input.creditNotePublicId,
      detail: { grant: g.publicId },
    });
  }
  return { redrawn, writtenOff };
}

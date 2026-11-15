/**
 * The credit cost of a meter (0526): what one unit of it costs in credits of a unit with no
 * rate, with an override per plan and per subscription. Rules: `credit-cost.ts`.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import {
  creditUnits,
  creditUsageEvents,
  meterCreditCosts,
  meters,
  products,
  subscriptions,
} from "@db/schema";
import { formatCostE6, parseCostE6 } from "./credit-cost";
import { CreditConflictError, CreditNotFoundError, CreditRuleError } from "./service";
import { isUnrated } from "./units";

const log = createLogger("credits.meter-costs");

type CostRow = typeof meterCreditCosts.$inferSelect;

export interface MeterCreditCostInput {
  unit: string;
  creditsPerUnit: string;
  overrides?: Array<{ product?: string; subscription?: string; creditsPerUnit: string }>;
}

export interface MeterCreditCostView {
  unit: string;
  credits_per_unit: string;
  overrides: Array<
    | { product: string; credits_per_unit: string }
    | { subscription: string; credits_per_unit: string }
  >;
}

const costText = (numeric: string) => formatCostE6(parseCostE6(numeric) ?? 0n);

async function viewOf(tx: Tx, rows: CostRow[]): Promise<MeterCreditCostView | null> {
  const base = rows.find((r) => r.active && !r.productId && !r.subscriptionId);
  if (!base) return null;
  const [unit] = await tx
    .select({ key: creditUnits.key })
    .from(creditUnits)
    .where(eq(creditUnits.id, base.unitId))
    .limit(1);
  const live = rows.filter((r) => r.active && (r.productId || r.subscriptionId));
  const productIds = live.flatMap((r) => (r.productId ? [r.productId] : []));
  const subIds = live.flatMap((r) => (r.subscriptionId ? [r.subscriptionId] : []));
  const prods = productIds.length
    ? await tx
        .select({ id: products.id, publicId: products.publicId })
        .from(products)
        .where(inArray(products.id, productIds))
    : [];
  const subs = subIds.length
    ? await tx
        .select({ id: subscriptions.id, publicId: subscriptions.publicId })
        .from(subscriptions)
        .where(inArray(subscriptions.id, subIds))
    : [];
  const prodOf = new Map(prods.map((p) => [p.id, p.publicId]));
  const subOf = new Map(subs.map((s) => [s.id, s.publicId]));
  const overrides: MeterCreditCostView["overrides"] = [];
  for (const r of live.sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const credits_per_unit = costText(r.creditsPerUnit);
    if (r.productId) overrides.push({ product: prodOf.get(r.productId)!, credits_per_unit });
    else overrides.push({ subscription: subOf.get(r.subscriptionId!)!, credits_per_unit });
  }
  return { unit: unit!.key, credits_per_unit: costText(base.creditsPerUnit), overrides };
}

async function meterByKey(tx: Tx, businessId: string, key: string) {
  const [m] = await tx
    .select()
    .from(meters)
    .where(and(eq(meters.businessId, businessId), eq(meters.key, key)))
    .limit(1);
  if (!m) throw new CreditNotFoundError(`No such meter: ${key}`);
  return m;
}

/** The credit cost of each meter that has one, by meter id. */
export async function meterCreditCostViews(
  tx: Tx,
  meterIds: readonly string[],
): Promise<Map<string, MeterCreditCostView>> {
  const out = new Map<string, MeterCreditCostView>();
  if (!meterIds.length) return out;
  const rows = await tx
    .select()
    .from(meterCreditCosts)
    .where(
      and(inArray(meterCreditCosts.meterId, [...meterIds]), eq(meterCreditCosts.active, true)),
    );
  const byMeter = new Map<string, CostRow[]>();
  for (const r of rows) byMeter.set(r.meterId, [...(byMeter.get(r.meterId) ?? []), r]);
  for (const [meterId, list] of byMeter) {
    const v = await viewOf(tx, list);
    if (v) out.set(meterId, v);
  }
  return out;
}

export async function getMeterCreditCost(input: {
  organizationId: string;
  businessId: string;
  meterKey: string;
}): Promise<MeterCreditCostView | null> {
  return withTenant(input.organizationId, async (tx) => {
    const m = await meterByKey(tx, input.businessId, input.meterKey);
    return (await meterCreditCostViews(tx, [m.id])).get(m.id) ?? null;
  });
}

const REFUSED = "We could not set the credit cost.";

function parsePositiveCost(text: string, where: string): string {
  const e6 = parseCostE6(text);
  if (e6 === null || e6 <= 0n)
    throw new CreditRuleError(
      `${REFUSED} ${where} must be a number more than 0, with at most 6 decimal places.`,
    );
  return formatCostE6(e6);
}

/**
 * Set a meter's credit cost: the meter's own cost and the full list of overrides. An override
 * that is not in the list is removed.
 */
export async function putMeterCreditCost(input: {
  organizationId: string;
  businessId: string;
  meterKey: string;
  cost: MeterCreditCostInput;
}): Promise<MeterCreditCostView> {
  return withTenant(input.organizationId, async (tx) => {
    const m = await meterByKey(tx, input.businessId, input.meterKey);
    if (m.status !== "active") throw new CreditConflictError(`${REFUSED} The meter is archived.`);
    // Each event must have its own quantity: a count, or a sum that only grows.
    const perEvent = m.aggregation === "count" || (m.aggregation === "sum" && !m.recurring);
    if (!perEvent)
      throw new CreditRuleError(
        `${REFUSED} Only a meter that counts events or adds a value can have a credit cost.`,
      );
    const [unit] = await tx
      .select()
      .from(creditUnits)
      .where(
        and(eq(creditUnits.businessId, input.businessId), eq(creditUnits.key, input.cost.unit)),
      )
      .limit(1);
    if (!unit) throw new CreditNotFoundError(`No such credit unit: ${input.cost.unit}`);
    if (!unit.active)
      throw new CreditRuleError(`${REFUSED} The credit unit ${unit.key} is archived.`);
    if (!isUnrated(unit))
      throw new CreditRuleError(
        `${REFUSED} The credit unit ${unit.key} has a money rate. Add a usage price to the meter instead.`,
      );
    // A price that already bills this meter's whole usage on a subscription would stop
    // billing usage not yet invoiced. A price on no subscription is kept: from now on it
    // bills only what credits do not pay, so it must use a rate (0530).
    if (!(await meterHasCreditCost(tx, m.id))) {
      const [priced] = await tx.execute<{ price: string }>(sql`
        select p.public_id as price from prices p
        where p.business_id = ${input.businessId} and p.meter_id = ${m.id}
          and exists (
            select 1 from subscription_items si join subscriptions s on s.id = si.subscription_id
            where si.price_id = p.id and s.status <> 'cancelled')
        order by p.created_at limit 1`);
      if (priced)
        throw new CreditConflictError(
          `${REFUSED} The price ${priced.price} bills this meter in money on a subscription. Archive that price first.`,
        );
      const [notRate] = await tx.execute<{ price: string }>(sql`
        select p.public_id as price from prices p
        where p.business_id = ${input.businessId} and p.meter_id = ${m.id} and p.active
          and p.amount_source <> 'rate'
        order by p.created_at limit 1`);
      if (notRate)
        throw new CreditConflictError(
          `${REFUSED} The price ${notRate.price} bills this meter from event amounts. Archive that price first.`,
        );
    }
    const existing = await tx
      .select()
      .from(meterCreditCosts)
      .where(eq(meterCreditCosts.meterId, m.id))
      .for("update");
    const oldUnit = existing[0]?.unitId;
    if (oldUnit && oldUnit !== unit.id) {
      const [used] = await tx
        .select({ id: creditUsageEvents.id })
        .from(creditUsageEvents)
        .where(eq(creditUsageEvents.meterId, m.id))
        .limit(1);
      if (used)
        throw new CreditConflictError(
          `${REFUSED} Usage of this meter was paid in a different credit unit. A meter keeps its unit.`,
        );
    }

    const base = parsePositiveCost(input.cost.creditsPerUnit, "credits_per_unit");
    const wanted: Array<{ productId: string | null; subscriptionId: string | null; cost: string }> =
      [];
    const seen = new Set<string>();
    for (const [i, o] of (input.cost.overrides ?? []).entries()) {
      const where = `overrides[${i}]`;
      if ((o.product == null) === (o.subscription == null))
        throw new CreditRuleError(`${REFUSED} ${where}: send product or subscription, not both.`);
      const cost = parsePositiveCost(o.creditsPerUnit, `${where}.credits_per_unit`);
      let productId: string | null = null;
      let subscriptionId: string | null = null;
      if (o.product != null) {
        const [p] = await tx
          .select({ id: products.id, kind: products.kind })
          .from(products)
          .where(and(eq(products.businessId, input.businessId), eq(products.publicId, o.product)))
          .limit(1);
        if (!p) throw new CreditNotFoundError(`No such product: ${o.product}`);
        if (p.kind !== "plan")
          throw new CreditRuleError(`${REFUSED} ${where}: the product ${o.product} is not a plan.`);
        productId = p.id;
      } else {
        const [s] = await tx
          .select({ id: subscriptions.id })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.businessId, input.businessId),
              eq(subscriptions.publicId, o.subscription!),
            ),
          )
          .limit(1);
        if (!s) throw new CreditNotFoundError(`No such subscription: ${o.subscription}`);
        subscriptionId = s.id;
      }
      const key = productId ?? subscriptionId!;
      if (seen.has(key))
        throw new CreditRuleError(`${REFUSED} ${where}: this override is in the list twice.`);
      seen.add(key);
      wanted.push({ productId, subscriptionId, cost });
    }

    // Replace: the unique indexes are partial, so write by hand instead of ON CONFLICT.
    const keep = new Set<string>();
    const write = async (
      productId: string | null,
      subscriptionId: string | null,
      creditsPerUnit: string,
    ) => {
      const old = existing.find(
        (r) => r.productId === productId && r.subscriptionId === subscriptionId,
      );
      if (old) {
        keep.add(old.id);
        await tx
          .update(meterCreditCosts)
          .set({ unitId: unit.id, creditsPerUnit, active: true, updatedAt: sql`app_now()` })
          .where(eq(meterCreditCosts.id, old.id));
        return;
      }
      await tx.insert(meterCreditCosts).values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        meterId: m.id,
        unitId: unit.id,
        creditsPerUnit,
        productId,
        subscriptionId,
      });
    };
    await write(null, null, base);
    for (const w of wanted) await write(w.productId, w.subscriptionId, w.cost);
    const drop = existing.filter((r) => !keep.has(r.id)).map((r) => r.id);
    if (drop.length) await tx.delete(meterCreditCosts).where(inArray(meterCreditCosts.id, drop));
    log.info("meter credit cost set", { event: "meter_credit_cost_set", meter: m.key });
    return (await meterCreditCostViews(tx, [m.id])).get(m.id)!;
  });
}

/** Remove a meter's credit cost. Events from then on spend no credits. */
export async function deleteMeterCreditCost(input: {
  organizationId: string;
  businessId: string;
  meterKey: string;
}): Promise<boolean> {
  return withTenant(input.organizationId, async (tx) => {
    const m = await meterByKey(tx, input.businessId, input.meterKey);
    const rows = await tx
      .select({
        id: meterCreditCosts.id,
        base: sql<boolean>`product_id is null and subscription_id is null`,
        active: meterCreditCosts.active,
      })
      .from(meterCreditCosts)
      .where(eq(meterCreditCosts.meterId, m.id))
      .for("update");
    const base = rows.find((r) => r.base);
    if (!base?.active) return false;
    // Its price would then bill the whole usage, also the part credits paid (0530).
    const [priced] = await tx.execute<{ price: string }>(sql`
      select p.public_id as price from prices p
      where p.meter_id = ${m.id} and exists (
        select 1 from subscription_items si join subscriptions s on s.id = si.subscription_id
        where si.price_id = p.id and s.status <> 'cancelled')
      order by p.created_at limit 1`);
    if (priced)
      throw new CreditConflictError(
        `We could not remove the credit cost. The price ${priced.price} bills this meter on a subscription. Archive that price first.`,
      );
    // The meter's row stays, inactive: it keeps the unit the meter was paid in.
    await tx
      .update(meterCreditCosts)
      .set({ active: false, updatedAt: sql`app_now()` })
      .where(eq(meterCreditCosts.id, base.id));
    const overrides = rows.filter((r) => !r.base).map((r) => r.id);
    if (overrides.length)
      await tx.delete(meterCreditCosts).where(inArray(meterCreditCosts.id, overrides));
    log.info("meter credit cost removed", { event: "meter_credit_cost_removed", meter: m.key });
    return true;
  });
}

/** A meter with an active credit cost cannot also be billed in money (see `putMeterCreditCost`). */
export async function meterHasCreditCost(tx: Tx, meterId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: meterCreditCosts.id })
    .from(meterCreditCosts)
    .where(
      and(
        eq(meterCreditCosts.meterId, meterId),
        eq(meterCreditCosts.active, true),
        sql`${meterCreditCosts.productId} is null and ${meterCreditCosts.subscriptionId} is null`,
      ),
    )
    .limit(1);
  return !!row;
}

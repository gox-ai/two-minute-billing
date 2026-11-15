/**
 * The overdraft limit of a unit with no rate (0528): how far below 0 the balance may go, in the
 * unit's smallest step. Three layers, the most specific wins: customer → plan → the unit's
 * own limit → 0. A floor on the balance, not an amount per window. The usage gate reads
 * `resolveOverdraftLimit` inside its take (0530).
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { creditOverdraftLimits, creditUnits, customers, products } from "@db/schema";
import {
  CreditNotFoundError,
  CreditRuleError,
  customerByPublicId,
  type CreditUnit,
} from "./service";
import { formatSteps, isUnrated } from "./units";
import { unitForPolicies, writeOverdraftRow } from "./unit-policies";
import { pickOverdraftLimit, type OverdraftLayers, type OverdraftSource } from "./settings-rules";

export { pickOverdraftLimit, type OverdraftSource };

/** The customer's live subscriptions with their products, oldest first. */
async function liveSubscriptionProducts(
  tx: Tx,
  customerId: string,
): Promise<Array<{ productIds: string[] }>> {
  const rows = (await tx.execute(sql`
    select array(select distinct p.product_id::text from subscription_items si
                 join prices p on p.id = si.price_id where si.subscription_id = s.id) as product_ids
    from subscriptions s
    where s.customer_id = ${customerId} and s.status in ('active', 'in_trial')
      and s.deleted_at is null
    order by s.created_at, s.id`)) as unknown as Array<{ product_ids: string[] | null }>;
  return rows.map((r) => ({ productIds: r.product_ids ?? [] }));
}

/** The limit that applies to a customer in a unit, with the layer it came from. */
export async function resolveOverdraftLimit(
  tx: Tx,
  input: { customerId: string; unitId: string },
): Promise<{ steps: bigint; source: OverdraftSource }> {
  const rows = await tx
    .select()
    .from(creditOverdraftLimits)
    .where(eq(creditOverdraftLimits.unitId, input.unitId));
  // Only the rows that can apply: the unit's own, every plan row, this customer's.
  const layers: OverdraftLayers = { byProduct: new Map() };
  const byProduct = new Map<string, bigint>();
  for (const r of rows) {
    if (r.customerId) {
      if (r.customerId === input.customerId) layers.customer = r.limitSteps;
    } else if (r.productId) byProduct.set(r.productId, r.limitSteps);
    else layers.unit = r.limitSteps;
  }
  const subs = byProduct.size ? await liveSubscriptionProducts(tx, input.customerId) : [];
  return pickOverdraftLimit({ ...layers, byProduct }, subs);
}

// ── Plan layer ──────────────────────────────────────────────────────────────

async function rateLessUnit(tx: Tx, businessId: string, key: string): Promise<CreditUnit> {
  const u = await unitForPolicies(tx, businessId, key);
  if (!u) throw new CreditNotFoundError(`No such credit unit: ${key}`);
  if (!isUnrated(u))
    throw new CreditRuleError(
      "We could not save the overdraft limit. An overdraft limit is for a unit with no money value.",
    );
  return u;
}

async function planByPublicId(tx: Tx, businessId: string, id: string) {
  const [p] = await tx
    .select({
      id: products.id,
      publicId: products.publicId,
      name: products.name,
      kind: products.kind,
    })
    .from(products)
    .where(and(eq(products.businessId, businessId), eq(products.publicId, id)))
    .limit(1);
  if (!p) throw new CreditNotFoundError(`No such product: ${id}`);
  if (p.kind !== "plan")
    throw new CreditRuleError(
      `We could not save the overdraft limit. ${id} is not a plan. Select a plan.`,
    );
  return p;
}

export interface OverdraftLimitView {
  object: "credit_overdraft_limit";
  unit: string;
  level: "unit" | "plan" | "customer";
  product: string | null;
  product_name: string | null;
  customer: string | null;
  customer_name: string | null;
  overdraft_limit: number;
  overdraft_limit_decimal: string;
  updated_at: string;
}

/** Every override of a unit: its plan rows, then its customer rows. Paged by row id. */
export async function listOverdraftLimits(input: {
  organizationId: string;
  businessId: string;
  unitKey: string;
  level?: "plan" | "customer";
  limit: number;
  startingAfter?: string;
}): Promise<{ data: OverdraftLimitView[]; hasMore: boolean; cursor: string | null }> {
  return withTenant(input.organizationId, async (tx) => {
    const u = await unitForPolicies(tx, input.businessId, input.unitKey);
    if (!u) throw new CreditNotFoundError(`No such credit unit: ${input.unitKey}`);
    const conds = [
      eq(creditOverdraftLimits.unitId, u.id),
      input.level === "plan"
        ? isNotNull(creditOverdraftLimits.productId)
        : input.level === "customer"
          ? isNotNull(creditOverdraftLimits.customerId)
          : sql`(${creditOverdraftLimits.productId} is not null or ${creditOverdraftLimits.customerId} is not null)`,
    ];
    if (input.startingAfter) conds.push(gt(creditOverdraftLimits.id, input.startingAfter));
    const rows = await tx
      .select({
        r: creditOverdraftLimits,
        productPublicId: products.publicId,
        productName: products.name,
        customerPublicId: customers.publicId,
        customerName: customers.name,
      })
      .from(creditOverdraftLimits)
      .leftJoin(products, eq(products.id, creditOverdraftLimits.productId))
      .leftJoin(customers, eq(customers.id, creditOverdraftLimits.customerId))
      .where(and(...conds))
      .orderBy(asc(creditOverdraftLimits.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    return {
      data: page.map((x) => viewOf(u, x)),
      hasMore: rows.length > input.limit,
      cursor: page.at(-1)?.r.id ?? null,
    };
  });
}

function viewOf(
  u: CreditUnit,
  x: {
    r: typeof creditOverdraftLimits.$inferSelect;
    productPublicId: string | null;
    productName: string | null;
    customerPublicId: string | null;
    customerName: string | null;
  },
): OverdraftLimitView {
  return {
    object: "credit_overdraft_limit",
    unit: u.key,
    level: x.r.customerId ? "customer" : x.r.productId ? "plan" : "unit",
    product: x.productPublicId,
    product_name: x.productName,
    customer: x.customerPublicId,
    customer_name: x.customerName,
    overdraft_limit: Number(x.r.limitSteps),
    overdraft_limit_decimal: formatSteps(x.r.limitSteps, u.decimals),
    updated_at: x.r.updatedAt.toISOString(),
  };
}

/** Set or remove (`steps: null`) a plan's limit in a unit. */
export async function setPlanOverdraftLimit(input: {
  organizationId: string;
  businessId: string;
  unitKey: string;
  productPublicId: string;
  steps: bigint | null;
}): Promise<OverdraftLimitView | null> {
  return withTenant(input.organizationId, async (tx) => {
    const u = await rateLessUnit(tx, input.businessId, input.unitKey);
    const p = await planByPublicId(tx, input.businessId, input.productPublicId);
    if (input.steps === null) {
      await tx
        .delete(creditOverdraftLimits)
        .where(
          and(eq(creditOverdraftLimits.unitId, u.id), eq(creditOverdraftLimits.productId, p.id)),
        );
      return null;
    }
    await writeOverdraftRow(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      unitId: u.id,
      productId: p.id,
      customerId: null,
      steps: input.steps,
    });
    const [r] = await tx
      .select()
      .from(creditOverdraftLimits)
      .where(
        and(eq(creditOverdraftLimits.unitId, u.id), eq(creditOverdraftLimits.productId, p.id)),
      );
    return viewOf(u, {
      r: r!,
      productPublicId: p.publicId,
      productName: p.name,
      customerPublicId: null,
      customerName: null,
    });
  });
}

// ── Customer layer ──────────────────────────────────────────────────────────

export interface CustomerOverdraftView {
  object: "customer_credit_overdraft_limit";
  unit: string;
  unit_name: string;
  decimals: number;
  /** The limit that applies now, from `source`. */
  overdraft_limit: number;
  overdraft_limit_decimal: string;
  source: OverdraftSource;
  /** The customer's own override; null = none. */
  customer_override: number | null;
}

/** For each active unit with no rate: the limit that applies to the customer, and its layer. */
export async function customerOverdraftLimits(input: {
  organizationId: string;
  businessId: string;
  customerPublicId: string;
}): Promise<CustomerOverdraftView[]> {
  return withTenant(input.organizationId, async (tx) => {
    const c = await customerByPublicId(tx, input.businessId, input.customerPublicId);
    return customerViews(tx, input.businessId, c.id);
  });
}

/** Active units with no rate; `alsoUnitId` adds that one even when archived. */
async function customerViews(
  tx: Tx,
  businessId: string,
  customerId: string,
  alsoUnitId?: string,
): Promise<CustomerOverdraftView[]> {
  const units = await tx
    .select()
    .from(creditUnits)
    .where(
      and(
        eq(creditUnits.businessId, businessId),
        alsoUnitId
          ? sql`(${creditUnits.active} or ${creditUnits.id} = ${alsoUnitId})`
          : eq(creditUnits.active, true),
        isNull(creditUnits.minorPerUnitE12),
      ),
    )
    .orderBy(asc(creditUnits.key));
  if (units.length === 0) return [];
  const own = await tx
    .select({ unitId: creditOverdraftLimits.unitId, steps: creditOverdraftLimits.limitSteps })
    .from(creditOverdraftLimits)
    .where(
      and(
        eq(creditOverdraftLimits.customerId, customerId),
        inArray(
          creditOverdraftLimits.unitId,
          units.map((u) => u.id),
        ),
      ),
    );
  const out: CustomerOverdraftView[] = [];
  for (const u of units) {
    const r = await resolveOverdraftLimit(tx, { customerId, unitId: u.id });
    const o = own.find((x) => x.unitId === u.id);
    out.push({
      object: "customer_credit_overdraft_limit",
      unit: u.key,
      unit_name: u.pluralName,
      decimals: u.decimals,
      overdraft_limit: Number(r.steps),
      overdraft_limit_decimal: formatSteps(r.steps, u.decimals),
      source: r.source,
      customer_override: o ? Number(o.steps) : null,
    });
  }
  return out;
}

/** Set or remove (`steps: null`) the customer's own limit in a unit. */
export async function setCustomerOverdraftLimit(input: {
  organizationId: string;
  businessId: string;
  customerPublicId: string;
  unitKey: string;
  steps: bigint | null;
}): Promise<CustomerOverdraftView> {
  return withTenant(input.organizationId, async (tx) => {
    const c = await customerByPublicId(tx, input.businessId, input.customerPublicId);
    const u = await rateLessUnit(tx, input.businessId, input.unitKey);
    if (input.steps === null)
      await tx
        .delete(creditOverdraftLimits)
        .where(
          and(eq(creditOverdraftLimits.unitId, u.id), eq(creditOverdraftLimits.customerId, c.id)),
        );
    else
      await writeOverdraftRow(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        unitId: u.id,
        productId: null,
        customerId: c.id,
        steps: input.steps,
      });
    const views = await customerViews(tx, input.businessId, c.id, u.id);
    return views.find((v) => v.unit === u.key)!;
  });
}

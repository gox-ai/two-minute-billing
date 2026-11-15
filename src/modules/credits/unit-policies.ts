/**
 * Credit unit policies for usage past the credits (0528): the overage price per credit, the
 * unit's own overdraft limit and what a plan reset does with an unbilled negative balance.
 * The gate, settlement and the plan reset read them (0530). No row = the defaults.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import {
  creditOverdraftLimits,
  creditUnitPolicies,
  creditUnits,
  type NegativeAtReset,
} from "@db/schema";
import {
  CreditConflictError,
  CreditRuleError,
  serializeCreditUnit,
  type CreditUnit,
} from "./service";
import { formatRateE12, formatSteps } from "./units";
import { overageMinorFor, pickOveragePrice, policiesIssue } from "./settings-rules";

export { overageMinorFor, pickOveragePrice, policiesIssue };

export interface UnitPolicies {
  /** Minor units × 10^12 for one credit. Null = no overage price. */
  overageMinorPerUnitE12: bigint | null;
  negativeAtReset: NegativeAtReset;
  /** The unit's own overdraft limit, in its smallest step. */
  overdraftSteps: bigint;
}

export const DEFAULT_POLICIES: UnitPolicies = {
  overageMinorPerUnitE12: null,
  negativeAtReset: "carry",
  overdraftSteps: 0n,
};

export interface UnitPoliciesPatch {
  overageMinorPerUnitE12?: bigint | null;
  negativeAtReset?: NegativeAtReset;
  overdraftSteps?: bigint;
}

/** Policies of each unit, by unit id. A unit with no row reads the defaults. */
export async function unitPoliciesFor(
  tx: Tx,
  unitIds: readonly string[],
): Promise<Map<string, UnitPolicies>> {
  const out = new Map<string, UnitPolicies>();
  if (unitIds.length === 0) return out;
  const ids = [...new Set(unitIds)];
  for (const id of ids) out.set(id, { ...DEFAULT_POLICIES });
  const rows = await tx
    .select()
    .from(creditUnitPolicies)
    .where(inArray(creditUnitPolicies.unitId, ids));
  for (const r of rows)
    out.set(r.unitId, {
      ...out.get(r.unitId)!,
      overageMinorPerUnitE12: r.overageMinorPerUnitE12,
      negativeAtReset: r.negativeAtReset,
    });
  const limits = await tx
    .select({ unitId: creditOverdraftLimits.unitId, steps: creditOverdraftLimits.limitSteps })
    .from(creditOverdraftLimits)
    .where(
      and(
        inArray(creditOverdraftLimits.unitId, ids),
        isNull(creditOverdraftLimits.productId),
        isNull(creditOverdraftLimits.customerId),
      ),
    );
  for (const l of limits) out.set(l.unitId, { ...out.get(l.unitId)!, overdraftSteps: l.steps });
  return out;
}

/** The fields this module adds to the credit unit object. */
export function policyFields(u: CreditUnit, p: UnitPolicies) {
  return {
    overage_minor_per_unit:
      p.overageMinorPerUnitE12 == null ? null : formatRateE12(p.overageMinorPerUnitE12),
    overdraft_limit: Number(p.overdraftSteps),
    overdraft_limit_decimal: formatSteps(p.overdraftSteps, u.decimals),
    negative_balance_at_reset: p.negativeAtReset,
  };
}

/** The credit unit object with its policies. */
export function serializeUnitWithPolicies(u: CreditUnit, p: UnitPolicies | undefined) {
  return { ...serializeCreditUnit(u), ...policyFields(u, p ?? DEFAULT_POLICIES) };
}

export async function serializeUnits(tx: Tx, units: readonly CreditUnit[]) {
  const policies = await unitPoliciesFor(
    tx,
    units.map((u) => u.id),
  );
  return units.map((u) => serializeUnitWithPolicies(u, policies.get(u.id)));
}

export const hasPolicyPatch = (p: UnitPoliciesPatch): boolean =>
  p.overageMinorPerUnitE12 !== undefined ||
  p.negativeAtReset !== undefined ||
  p.overdraftSteps !== undefined;

/**
 * Write a unit's policies and emit `credit_unit_updated` with the whole unit when something
 * changed. A unit with a rate refuses an overage price.
 */
export async function setUnitPolicies(
  tx: Tx,
  input: { organizationId: string; businessId: string; unit: CreditUnit; patch: UnitPoliciesPatch },
): Promise<UnitPolicies> {
  const { unit: u, patch: p } = input;
  const issue = policiesIssue(u, p);
  if (issue) throw new CreditRuleError(issue);
  const before = (await unitPoliciesFor(tx, [u.id])).get(u.id)!;
  const next: UnitPolicies = {
    overageMinorPerUnitE12:
      p.overageMinorPerUnitE12 !== undefined
        ? p.overageMinorPerUnitE12
        : before.overageMinorPerUnitE12,
    negativeAtReset: p.negativeAtReset ?? before.negativeAtReset,
    overdraftSteps: p.overdraftSteps ?? before.overdraftSteps,
  };
  const same =
    next.overageMinorPerUnitE12 === before.overageMinorPerUnitE12 &&
    next.negativeAtReset === before.negativeAtReset &&
    next.overdraftSteps === before.overdraftSteps;
  if (same) return before;
  await tx
    .insert(creditUnitPolicies)
    .values({
      organizationId: input.organizationId,
      businessId: input.businessId,
      unitId: u.id,
      overageMinorPerUnitE12: next.overageMinorPerUnitE12,
      negativeAtReset: next.negativeAtReset,
    })
    .onConflictDoUpdate({
      target: creditUnitPolicies.unitId,
      set: {
        overageMinorPerUnitE12: next.overageMinorPerUnitE12,
        negativeAtReset: next.negativeAtReset,
      },
    });
  if (next.overdraftSteps !== before.overdraftSteps)
    await writeOverdraftRow(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      unitId: u.id,
      productId: null,
      customerId: null,
      steps: next.overdraftSteps,
    });
  await emitEvent(tx, {
    organizationId: input.organizationId,
    businessId: input.businessId,
    type: "credit_unit_updated",
    data: buildEventData(
      "credit_unit_updated",
      serializeUnitWithPolicies(u, next),
      u.resourceVersion,
    ),
  });
  return next;
}

/** Upsert one overdraft row; 0 at the unit's own layer deletes it (0 is the default). */
export async function writeOverdraftRow(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    unitId: string;
    productId: string | null;
    customerId: string | null;
    steps: bigint;
  },
): Promise<void> {
  if (input.steps < 0n)
    throw new CreditRuleError("We could not save the overdraft limit. It must be 0 or more.");
  const layer = and(
    eq(creditOverdraftLimits.unitId, input.unitId),
    input.productId
      ? eq(creditOverdraftLimits.productId, input.productId)
      : isNull(creditOverdraftLimits.productId),
    input.customerId
      ? eq(creditOverdraftLimits.customerId, input.customerId)
      : isNull(creditOverdraftLimits.customerId),
  );
  const [cur] = await tx.select().from(creditOverdraftLimits).where(layer).for("update").limit(1);
  if (!input.productId && !input.customerId && input.steps === 0n) {
    if (cur) await tx.delete(creditOverdraftLimits).where(eq(creditOverdraftLimits.id, cur.id));
    return;
  }
  if (cur) {
    if (cur.limitSteps !== input.steps)
      await tx
        .update(creditOverdraftLimits)
        .set({ limitSteps: input.steps })
        .where(eq(creditOverdraftLimits.id, cur.id));
    return;
  }
  await tx.insert(creditOverdraftLimits).values({
    organizationId: input.organizationId,
    businessId: input.businessId,
    unitId: input.unitId,
    productId: input.productId,
    customerId: input.customerId,
    limitSteps: input.steps,
  });
}

/** A unit by key, for a policy write; 404 when missing. */
export async function unitForPolicies(
  tx: Tx,
  businessId: string,
  key: string,
): Promise<CreditUnit | null> {
  const [u] = await tx
    .select()
    .from(creditUnits)
    .where(and(eq(creditUnits.businessId, businessId), eq(creditUnits.key, key)))
    .limit(1);
  return u ?? null;
}

/** Policies of one unit, outside a request's own transaction. */
export async function getUnitPolicies(
  organizationId: string,
  unitId: string,
): Promise<UnitPolicies> {
  return withTenant(organizationId, async (tx) =>
    (await unitPoliciesFor(tx, [unitId])).get(unitId)!,
  );
}

export { CreditConflictError };

import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { publicId as newPublicId } from "@/platform/ids";
import { createLogger } from "@/platform/logger";
import { businessNow } from "@/platform/clock";
import { businesses, customers, dunningPolicies, products } from "@db/schema";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { writeAuditLog } from "@/modules/audit/service";
import { dunningPolicyConfigJson } from "@/modules/subscriptions/dunning-schedule";
export { dunningPolicyPublicIds } from "./effective";
import { VersionConflictError } from "@/api/helpers";

const log = createLogger("dunning-policies");

export type DunningPolicy = typeof dunningPolicies.$inferSelect;

export class DunningPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DunningPolicyError";
  }
}
export class DunningPolicyConflictError extends DunningPolicyError {}

const CODE_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function serializeDunningPolicy(p: DunningPolicy, customerCount?: number) {
  return {
    object: "dunning_policy",
    id: p.publicId,
    name: p.name,
    code: p.code,
    description: p.description,
    config: p.config,
    archived: p.archivedAt != null,
    archived_at: p.archivedAt,
    ...(customerCount !== undefined ? { customer_count: customerCount } : {}),
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    resource_version: p.resourceVersion,
  };
}

async function emitPolicyEvent(
  tx: Tx,
  type: "dunning_policy_created" | "dunning_policy_updated" | "dunning_policy_archived",
  p: DunningPolicy,
): Promise<void> {
  await emitEvent(tx, {
    organizationId: p.organizationId,
    businessId: p.businessId,
    type,
    data: buildEventData(
      type,
      { id: p.publicId, name: p.name, code: p.code, config: p.config },
      p.resourceVersion,
    ),
  });
}

async function codeTaken(tx: Tx, businessId: string, code: string, exceptId?: string) {
  const rows = await tx
    .select({ id: dunningPolicies.id })
    .from(dunningPolicies)
    .where(
      and(
        eq(dunningPolicies.businessId, businessId),
        eq(dunningPolicies.code, code),
        isNull(dunningPolicies.archivedAt),
      ),
    );
  return rows.some((r) => r.id !== exceptId);
}

export async function createDunningPolicy(input: {
  organizationId: string;
  businessId: string;
  name: string;
  code: string;
  description?: string | null;
  config: unknown;
}): Promise<DunningPolicy> {
  const code = input.code.trim();
  if (!CODE_RE.test(code))
    throw new DunningPolicyError(
      "We could not create the dunning policy. The code must use lower-case letters, digits, '-' or '_'. Change the code and try again.",
    );
  return withTenant(input.organizationId, async (tx) => {
    if (await codeTaken(tx, input.businessId, code))
      throw new DunningPolicyConflictError(
        `We could not create the dunning policy. The code ${code} is in use. Use a different code.`,
      );
    const [row] = await tx
      .insert(dunningPolicies)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        publicId: newPublicId("dpol"),
        name: input.name.trim(),
        code,
        description: input.description ?? null,
        config: dunningPolicyConfigJson(input.config),
      })
      .returning();
    await writeAuditLog(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        action: "dunning_policy.create",
        resourceType: "dunning_policy",
        resourceId: row!.publicId,
        beforeFull: null,
        afterFull: serializeDunningPolicy(row!),
      },
      tx,
    );
    await emitPolicyEvent(tx, "dunning_policy_created", row!);
    return row!;
  });
}

export async function listDunningPolicies(
  organizationId: string,
  businessId: string,
  opts?: { includeArchived?: boolean },
): Promise<Array<{ policy: DunningPolicy; customerCount: number }>> {
  return withTenant(organizationId, async (tx) => {
    const base = eq(dunningPolicies.businessId, businessId);
    const rows = await tx
      .select()
      .from(dunningPolicies)
      .where(opts?.includeArchived ? base : and(base, isNull(dunningPolicies.archivedAt)))
      .orderBy(asc(dunningPolicies.name), asc(dunningPolicies.publicId));
    const counts = rows.length
      ? await tx
          .select({ id: customers.dunningPolicyId, n: count() })
          .from(customers)
          .where(
            inArray(
              customers.dunningPolicyId,
              rows.map((r) => r.id),
            ),
          )
          .groupBy(customers.dunningPolicyId)
      : [];
    const byId = new Map(counts.map((c) => [c.id, Number(c.n)]));
    return rows.map((policy) => ({ policy, customerCount: byId.get(policy.id) ?? 0 }));
  });
}

async function loadPolicy(tx: Tx, businessId: string, publicId: string) {
  const [row] = await tx
    .select()
    .from(dunningPolicies)
    .where(and(eq(dunningPolicies.businessId, businessId), eq(dunningPolicies.publicId, publicId)))
    .limit(1);
  return row ?? null;
}

async function customersOn(tx: Tx, policyId: string): Promise<number> {
  const [r] = await tx
    .select({ n: count() })
    .from(customers)
    .where(eq(customers.dunningPolicyId, policyId));
  return Number(r?.n ?? 0);
}

export async function getDunningPolicy(
  organizationId: string,
  businessId: string,
  publicId: string,
): Promise<{ policy: DunningPolicy; customerCount: number } | null> {
  return withTenant(organizationId, async (tx) => {
    const policy = await loadPolicy(tx, businessId, publicId);
    if (!policy) return null;
    return { policy, customerCount: await customersOn(tx, policy.id) };
  });
}

/** Change a policy. `config` replaces the whole stored set. Applies to every assigned customer. */
export async function updateDunningPolicy(input: {
  organizationId: string;
  businessId: string;
  publicId: string;
  name?: string;
  code?: string;
  description?: string | null;
  config?: unknown;
  expectedVersion?: number;
}): Promise<DunningPolicy | null> {
  return withTenant(input.organizationId, async (tx) => {
    const cur = await loadPolicy(tx, input.businessId, input.publicId);
    if (!cur) return null;
    if (input.expectedVersion !== undefined && input.expectedVersion !== cur.resourceVersion)
      throw new VersionConflictError(input.expectedVersion, cur.resourceVersion);
    if (cur.archivedAt)
      throw new DunningPolicyError(
        "We could not change the dunning policy. It is archived. Create a new policy.",
      );
    const set: Partial<typeof dunningPolicies.$inferInsert> = {};
    if (input.name !== undefined) set.name = input.name.trim();
    if (input.description !== undefined) set.description = input.description;
    if (input.code !== undefined) {
      const code = input.code.trim();
      if (!CODE_RE.test(code))
        throw new DunningPolicyError(
          "We could not change the dunning policy. The code must use lower-case letters, digits, '-' or '_'. Change the code and try again.",
        );
      if (await codeTaken(tx, input.businessId, code, cur.id))
        throw new DunningPolicyConflictError(
          `We could not change the dunning policy. The code ${code} is in use. Use a different code.`,
        );
      set.code = code;
    }
    if (input.config !== undefined) set.config = dunningPolicyConfigJson(input.config);
    if (Object.keys(set).length === 0) return cur;
    const [row] = await tx
      .update(dunningPolicies)
      .set(set)
      .where(eq(dunningPolicies.id, cur.id))
      .returning();
    await writeAuditLog(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        action: "dunning_policy.update",
        resourceType: "dunning_policy",
        resourceId: cur.publicId,
        beforeFull: serializeDunningPolicy(cur),
        afterFull: serializeDunningPolicy(row!),
      },
      tx,
    );
    await emitPolicyEvent(tx, "dunning_policy_updated", row!);
    return row!;
  });
}

/** Archive a policy. Refused while a customer is assigned to it. */
export async function archiveDunningPolicy(input: {
  organizationId: string;
  businessId: string;
  publicId: string;
}): Promise<DunningPolicy | null> {
  return withTenant(input.organizationId, async (tx) => {
    // Lock the row so a concurrent assignment cannot slip in between count and archive.
    const [cur] = await tx
      .select()
      .from(dunningPolicies)
      .where(
        and(
          eq(dunningPolicies.businessId, input.businessId),
          eq(dunningPolicies.publicId, input.publicId),
        ),
      )
      .for("update")
      .limit(1);
    if (!cur) return null;
    if (cur.archivedAt) return cur;
    const n = await customersOn(tx, cur.id);
    if (n > 0)
      throw new DunningPolicyConflictError(
        `We could not archive the dunning policy. ${n} ${n === 1 ? "customer uses" : "customers use"} it. Assign a different policy to ${n === 1 ? "that customer" : "those customers"} first.`,
      );
    const plans = await plansOn(tx, input.businessId, cur.publicId);
    if (plans.length > 0)
      throw new DunningPolicyConflictError(
        `We could not archive the dunning policy. ${plans.length === 1 ? "A plan uses" : `${plans.length} plans use`} it. Remove it from ${plans.length === 1 ? "that plan" : "those plans"} in the dunning settings first.`,
      );
    const [row] = await tx
      .update(dunningPolicies)
      .set({ archivedAt: businessNow(input.businessId) })
      .where(eq(dunningPolicies.id, cur.id))
      .returning();
    await writeAuditLog(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        action: "dunning_policy.archive",
        resourceType: "dunning_policy",
        resourceId: cur.publicId,
        beforeFull: serializeDunningPolicy(cur),
        afterFull: serializeDunningPolicy(row!),
      },
      tx,
    );
    await emitPolicyEvent(tx, "dunning_policy_archived", row!);
    log.info("dunning policy archived", { policy: cur.publicId });
    return row!;
  });
}

/** Plan product ids whose `dunning_config.plan_policies` entry names this policy. */
export async function plansOn(
  tx: Tx,
  businessId: string,
  policyPublicId: string,
): Promise<string[]> {
  const [b] = await tx
    .select({ cfg: businesses.dunningConfig })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  const map = (b?.cfg as { plan_policies?: unknown } | null)?.plan_policies;
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  return Object.entries(map as Record<string, unknown>)
    .filter(([, v]) => v === policyPublicId)
    .map(([k]) => k);
}

/**
 * Check a `plan_policies` map against the stored one. New or changed entries must name a
 * plan of this business and a live policy (else `error`); unchanged entries whose plan or
 * policy has since gone are dropped from `cleaned`, so a stale entry never blocks a save.
 */
export async function planPoliciesViolation(
  organizationId: string,
  businessId: string,
  map: Record<string, string>,
  stored: unknown,
): Promise<{ error: string | null; cleaned: Record<string, string> }> {
  const old =
    stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const planIds = Object.keys(map);
  if (!planIds.length) return { error: null, cleaned: {} };
  return withTenant(organizationId, async (tx) => {
    const plans = await tx
      .select({ publicId: products.publicId })
      .from(products)
      .where(
        and(
          eq(products.businessId, businessId),
          eq(products.kind, "plan"),
          inArray(products.publicId, planIds),
        ),
      );
    const knownPlans = new Set(plans.map((p) => p.publicId));
    const pols = await tx
      .select({ publicId: dunningPolicies.publicId })
      .from(dunningPolicies)
      .where(
        and(
          eq(dunningPolicies.businessId, businessId),
          inArray(dunningPolicies.publicId, [...new Set(Object.values(map))]),
          isNull(dunningPolicies.archivedAt),
        ),
      );
    const livePols = new Set(pols.map((p) => p.publicId));
    const cleaned: Record<string, string> = {};
    for (const [plan, pol] of Object.entries(map)) {
      const ok = knownPlans.has(plan) && livePols.has(pol);
      if (ok) cleaned[plan] = pol;
      else if (old[plan] !== pol)
        return {
          error: !knownPlans.has(plan)
            ? `We could not save the plan dunning policies. ${plan} is not a plan of this business. Select a plan from the list.`
            : `We could not save the plan dunning policies. The policy ${pol} does not exist or is archived. Select a different policy.`,
          cleaned,
        };
    }
    return { error: null, cleaned };
  });
}

/**
 * A customer write's `dunning_policy` → the internal id. Null clears it. Refuses an
 * unknown or archived policy. An archive racing this assignment leaves the customer on
 * an archived policy, which still resolves (`loadEffectiveDunningConfig` ignores archive).
 */
export async function resolveDunningPolicyRef(
  organizationId: string,
  businessId: string,
  ref: string | null | undefined,
): Promise<string | null | undefined> {
  if (ref === undefined) return undefined;
  if (ref === null) return null;
  return withTenant(organizationId, async (tx) => {
    const p = await loadPolicy(tx, businessId, ref);
    if (!p)
      throw new DunningPolicyError(
        `We could not find the dunning policy ${ref}. Check the id and try again.`,
      );
    if (p.archivedAt)
      throw new DunningPolicyError(
        `We could not assign the dunning policy ${ref}. It is archived. Select a different policy.`,
      );
    return p.id;
  });
}

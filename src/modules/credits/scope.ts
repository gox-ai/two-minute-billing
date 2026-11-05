/**
 * Credit scope (setting 2.55). A grant pays every usage line (`metered`), the usage lines of
 * named prices, or those of named meters. Before a draw, `meters` becomes the prices that bill
 * those meters now, and a `metered` grant takes the business's `credit_config.credit_scope`
 * when one is set. The planner and the access check then only ever see `metered` or `prices`.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import {
  businesses,
  customers,
  meters,
  prices,
  type BusinessCreditConfig,
  type CreditApplicability,
} from "@db/schema";

/** `metered` or `prices`: what the planner reads. */
export type ResolvedApplicability = Exclude<CreditApplicability, { kind: "meters" }>;

/** The business's credit scope, or null (no narrowing). */
export function businessCreditScope(
  cfg: BusinessCreditConfig | null | undefined,
): Exclude<CreditApplicability, { kind: "metered" }> | null {
  const s = cfg?.credit_scope;
  if (!s || typeof s !== "object") return null;
  if (s.kind === "prices" && Array.isArray(s.prices) && s.prices.length) return s;
  if (s.kind === "meters" && Array.isArray(s.meters) && s.meters.length) return s;
  return null;
}

/**
 * Resolve each grant's scope for a draw. `businessId` or `customerId` names the business.
 * A meter with no price, or an unknown key, covers nothing.
 */
export async function resolveGrantScopes<T extends { applicability: CreditApplicability }>(
  tx: Tx,
  where: { businessId?: string; customerId?: string },
  grants: T[],
): Promise<Array<T & { applicability: ResolvedApplicability }>> {
  if (grants.length === 0) return [];
  let businessId = where.businessId;
  if (!businessId && where.customerId) {
    const [c] = await tx
      .select({ businessId: customers.businessId })
      .from(customers)
      .where(eq(customers.id, where.customerId))
      .limit(1);
    businessId = c?.businessId;
  }
  const [biz] = businessId
    ? await tx
        .select({ creditConfig: businesses.creditConfig })
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .limit(1)
    : [];
  const fallback = businessCreditScope(biz?.creditConfig as BusinessCreditConfig | null);
  const scoped = grants.map((g) =>
    !g.applicability || g.applicability.kind === "metered"
      ? (fallback ?? ({ kind: "metered" } as const))
      : g.applicability,
  );
  const keys = [...new Set(scoped.flatMap((a) => (a.kind === "meters" ? (a.meters ?? []) : [])))];
  const byMeter = new Map<string, string[]>();
  if (keys.length && businessId) {
    const rows = await tx
      .select({ key: meters.key, price: prices.publicId })
      .from(prices)
      .innerJoin(meters, eq(meters.id, prices.meterId))
      .where(and(eq(meters.businessId, businessId), inArray(meters.key, keys)));
    for (const r of rows) byMeter.set(r.key, [...(byMeter.get(r.key) ?? []), r.price]);
  }
  return grants.map((g, i) => {
    const a = scoped[i]!;
    const applicability: ResolvedApplicability =
      a.kind === "meters"
        ? { kind: "prices", prices: a.meters.flatMap((k) => byMeter.get(k) ?? []) }
        : a;
    return { ...g, applicability };
  });
}

/** The keys this business has no meter for (empty = all exist). */
export async function missingMeters(
  tx: Tx,
  businessId: string,
  keys: readonly string[],
): Promise<string[]> {
  const found = await tx
    .select({ key: meters.key })
    .from(meters)
    .where(and(eq(meters.businessId, businessId), inArray(meters.key, [...keys])));
  const have = new Set(found.map((m) => m.key));
  return keys.filter((k) => !have.has(k));
}

/** The 400 for a credit scope naming a price or meter this business lacks; null when valid. */
export async function creditScopeMissing(
  organizationId: string,
  businessId: string,
  scope: Exclude<CreditApplicability, { kind: "metered" }>,
): Promise<string | null> {
  const { withTenant } = await import("@/platform/db");
  return withTenant(organizationId, async (tx) => {
    if (scope.kind === "meters") {
      const missing = await missingMeters(tx, businessId, scope.meters);
      return missing.length
        ? `We could not save the credit scope. No such meter: ${missing.join(", ")}.`
        : null;
    }
    const found = await tx
      .select({ publicId: prices.publicId })
      .from(prices)
      .where(and(eq(prices.businessId, businessId), inArray(prices.publicId, scope.prices)));
    const have = new Set(found.map((p) => p.publicId));
    const missing = scope.prices.filter((p) => !have.has(p));
    return missing.length
      ? `We could not save the credit scope. No such price: ${missing.join(", ")}.`
      : null;
  });
}

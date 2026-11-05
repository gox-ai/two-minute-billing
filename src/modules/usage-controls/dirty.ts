/**
 * The dirty set (design G5 §3.1): customers whose usage, grants, holds or controls changed
 * since the last check. Insert-only (ON CONFLICT DO NOTHING), so an existing mark is never a
 * hot row; the `usage_controls_check` cron claims marks with DELETE … RETURNING.
 */
import { sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";

/** Per-process cache of `businesses.usage_controls_active`. A miss costs one indexed read. */
const ACTIVE_TTL_MS = 30_000;
const activeCache = new Map<string, { active: boolean; at: number }>();

/** For tests: forget the cached flags. */
export function clearUsageControlsActiveCache(): void {
  activeCache.clear();
}

/** Whether the business has any usage control. Cached for 30 s; the fold backstop covers the gap. */
export async function usageControlsActive(tx: Tx, businessId: string): Promise<boolean> {
  const hit = activeCache.get(businessId);
  if (hit && Date.now() - hit.at < ACTIVE_TTL_MS) return hit.active;
  const rows = (await tx.execute(
    sql`select usage_controls_active as a from businesses where id = ${businessId}`,
  )) as unknown as Array<{ a: boolean }>;
  const active = rows[0]?.a === true;
  activeCache.set(businessId, { active, at: Date.now() });
  return active;
}

/** Set `businesses.usage_controls_active` (first control created). Never cleared. */
export async function setUsageControlsActive(tx: Tx, businessId: string): Promise<void> {
  await tx.execute(
    sql`update businesses set usage_controls_active = true
      where id = ${businessId} and not usage_controls_active`,
  );
  activeCache.set(businessId, { active: true, at: Date.now() });
}

/** Mark customers dirty (inside withTenant). One statement; existing marks are left alone. */
export async function markDirty(
  tx: Tx,
  input: { businessId: string; customerIds: Array<string | null | undefined> },
): Promise<void> {
  const ids = [...new Set(input.customerIds.filter((c): c is string => !!c))];
  if (!ids.length) return;
  // Inside withTenant: the org comes from the transaction's own setting.
  await tx.execute(sql`
    insert into usage_control_dirty (customer_id, organization_id, business_id)
    select u.id, current_setting('app.org_id', true)::uuid, ${input.businessId}::uuid
    from unnest(${`{${ids.join(",")}}`}::uuid[]) as u(id)
    on conflict (customer_id) do nothing`);
}

/** The ingest fast mark: only when the business has a usage control. */
export async function markDirtyOnIngest(
  tx: Tx,
  input: { businessId: string; customerIds: Array<string | null | undefined> },
): Promise<void> {
  if (!input.customerIds.some(Boolean)) return;
  if (!(await usageControlsActive(tx, input.businessId))) return;
  await markDirty(tx, input);
}

/**
 * The fold backstop (`registerFoldHook`): re-marks the customers each fold transaction
 * touched, so a mark lost to the claim race comes back within the fold lag.
 */
export async function foldBackstop(
  tx: Tx,
  input: { businessId: string; customerIds: string[]; watermark: Date },
): Promise<void> {
  await markDirtyOnIngest(tx, { businessId: input.businessId, customerIds: input.customerIds });
}

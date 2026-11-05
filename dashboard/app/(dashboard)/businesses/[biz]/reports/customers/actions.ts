"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { createSegment, deleteSegment, type SegmentFilter } from "@/lib/api/segments";

/**
 * Save the chips on screen as a named segment.
 *
 * The engine's refusal is returned VERBATIM. It names the attribute and says why —
 * "Customers cannot be segmented by 'ltv': no per-customer lifetime value is stored…"
 * — and flattening that into "Could not save" throws away the only part of the answer
 * an operator can act on.
 */
export async function createSegmentAction(
  biz: string,
  draft: { name: string; description: string | null; filters: SegmentFilter[] },
): Promise<{ ok: boolean; error?: string }> {
  await requirePermission("customers:manage", "ops");
  const res = await createSegment(biz, draft);
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath(`/businesses/${biz}/reports/customers`);
  return { ok: true };
}

export async function deleteSegmentAction(
  biz: string,
  seg: string,
): Promise<{ ok: boolean; error?: string }> {
  await requirePermission("customers:manage", "ops");
  const res = await deleteSegment(biz, seg);
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath(`/businesses/${biz}/reports/customers`);
  return { ok: true };
}

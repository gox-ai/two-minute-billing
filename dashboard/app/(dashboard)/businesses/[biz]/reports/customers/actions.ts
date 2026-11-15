"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import {
  createSegment,
  deleteSegment,
  previewSegment,
  type SegmentCustomer,
  type SegmentFilter,
} from "@/lib/api/segments";

/** Rows per page on the Customers report, first page and every "Load more". */
const SEGMENT_PAGE = 50;

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

/** The next page of a segment's customers, for "Load more". Same filters, same page size. */
export async function loadSegmentPageAction(
  biz: string,
  filters: SegmentFilter[],
  cursor: string,
): Promise<
  | { ok: true; data: SegmentCustomer[]; has_more: boolean; next_cursor: string | null }
  | { ok: false; error: string }
> {
  await requirePermission("customers:view", "ops");
  try {
    const page = await previewSegment(biz, filters, { limit: SEGMENT_PAGE, startingAfter: cursor });
    return { ok: true, data: page.data, has_more: page.has_more, next_cursor: page.next_cursor };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

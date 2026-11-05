"use server";

import { revalidatePath } from "next/cache";
import { actionOk, actionError } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-result";
import {
  listTransferJobs,
  previewTransfer,
  runTransfer,
  seedSampleData,
  removeSampleData,
} from "@/lib/api/transfer";
import type {
  TransferHistoryPage,
  TransferJob,
  TransferPreview,
  TransferRequest,
} from "@/lib/api/transfer";
import { requirePermission } from "@/lib/session";
import { apiDelete } from "@/lib/api";

const errorOf = (result: { data?: unknown; error?: string }, fallback: string) =>
  (result.data as { error?: { message?: string } } | undefined)?.error?.message ??
  result.error ??
  fallback;

/** What a transfer from :biz would write, field by field. Writes nothing. */
export async function previewTransferAction(
  biz: string,
  body: TransferRequest,
): Promise<{ ok: true; preview: TransferPreview } | { ok: false; message: string }> {
  await requirePermission("transfers:manage", "admin");
  if (!body.destination_business) return { ok: false, message: "Select a destination business." };
  const result = await previewTransfer(biz, body);
  if (!result.ok)
    return { ok: false, message: errorOf(result, "We could not preview the transfer.") };
  return { ok: true, preview: result.data as TransferPreview };
}

/** One page of past transfers: this business's, or the whole organization's. */
export async function listTransfersAction(
  biz: string,
  scope: "business" | "organization",
  cursor?: string,
): Promise<TransferHistoryPage | null> {
  await requirePermission("transfers:manage", "admin");
  try {
    return await listTransferJobs(biz, scope, cursor);
  } catch {
    return null;
  }
}

/** Run a transfer from :biz. A failed job (422) still returns the job, with its error. */
export async function runTransferAction(
  biz: string,
  body: TransferRequest,
): Promise<{ ok: boolean; job?: TransferJob; message?: string }> {
  await requirePermission("transfers:manage", "admin");
  const result = await runTransfer(biz, body);
  const job = result.data as TransferJob | undefined;
  revalidatePath(`/businesses/${biz}/transfer`);
  if (job?.object === "transfer_configuration")
    return { ok: job.status !== "failed", job, message: job.error ?? undefined };
  return { ok: false, message: errorOf(result, "We could not run the transfer.") };
}

export async function seedSampleDataAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("transfers:manage", "admin");

  const biz = formData.get("biz") as string;
  const result = await seedSampleData(biz);
  if (!result.ok) {
    const msg = (result.data as { error?: { message?: string } } | undefined)?.error?.message;
    return actionError(msg ?? result.error ?? "We could not seed the sample data.");
  }
  const summary = result.data as
    | { products?: number; prices?: number; coupons?: number; customers?: number }
    | undefined;
  revalidatePath(`/businesses/${biz}/transfer`);
  return actionOk(
    `Sample data seeded: ${summary?.products ?? 0} products, ${summary?.prices ?? 0} prices, ${summary?.coupons ?? 0} coupons, ${summary?.customers ?? 0} customers.`,
  );
}

export async function removeSampleDataAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("transfers:manage", "admin");

  const biz = formData.get("biz") as string;
  const result = await removeSampleData(biz);
  if (!result.ok) {
    const msg = (result.data as { error?: { message?: string } } | undefined)?.error?.message;
    return actionError(msg ?? result.error ?? "We could not delete the sample data.");
  }
  revalidatePath(`/businesses/${biz}/transfer`);
  return actionOk("Sample data deleted.");
}

/** Delete every customer of this test business and everything under them. */
export async function deleteTestDataAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("test_tools:manage", "admin");
  const biz = formData.get("biz") as string;
  const result = await apiDelete(`/v1/businesses/${encodeURIComponent(biz)}/test_data`);
  if (!result.ok) return actionError(result.error ?? "We could not delete the test data.");
  revalidatePath(`/businesses/${biz}`, "layout");
  return actionOk("Test data deleted.");
}

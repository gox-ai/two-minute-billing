"use server";

import { revalidatePath } from "next/cache";
import { actionOk, actionError } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-result";
import {
  applyTransferRun,
  cancelTransferRun,
  createTransferPlan,
  getTransferRun,
  listTransferItems,
  listTransferJobs,
  retryTransferRun,
  seedSampleData,
  removeSampleData,
  setTransferItems,
} from "@/lib/api/transfer";
import type {
  ItemQuery,
  PlanRequest,
  TransferHistoryPage,
  TransferItemPage,
  TransferRun,
} from "@/lib/api/transfer";
import { requirePermission } from "@/lib/session";
import { apiDelete, apiPost } from "@/lib/api";

export type RunResult =
  | { ok: true; run: TransferRun }
  | {
      ok: false;
      message: string;
      /** The set-up changed after the check: the client checks again. */
      drift?: boolean;
    };

type Write = { ok: boolean; status: number; error?: string; data?: unknown };

const errorOf = (result: { data?: unknown; error?: string }, fallback: string) =>
  (result.data as { error?: { message?: string } } | undefined)?.error?.message ??
  result.error ??
  fallback;

function runResult(result: Write, fallback: string): RunResult {
  const run = result.data as TransferRun | undefined;
  if (result.ok && run?.object === "transfer_configuration") return { ok: true, run };
  const message = errorOf(result, fallback);
  const code = (result.data as { error?: { code?: string } } | undefined)?.error?.code;
  return { ok: false, message, drift: result.status === 409 && code === "transfer_drift" };
}

/** Build and store a plan. Writes no configuration. */
export async function planTransferAction(biz: string, body: PlanRequest): Promise<RunResult> {
  await requirePermission("transfers:manage", "admin");
  if (!body.destination_business) return { ok: false, message: "Select a destination business." };
  return runResult(await createTransferPlan(biz, body), "We could not check the changes.");
}

/** One run with its counts, for the poll and for a link from the history. */
export async function getRunAction(biz: string, run: string): Promise<TransferRun | null> {
  await requirePermission("transfers:manage", "admin");
  try {
    return await getTransferRun(biz, run);
  } catch {
    return null;
  }
}

/** One page of a run's items; null when the engine refuses. */
export async function listItemsAction(
  biz: string,
  run: string,
  query: ItemQuery,
): Promise<TransferItemPage | null> {
  await requirePermission("transfers:manage", "admin");
  try {
    return await listTransferItems(biz, run, query);
  } catch {
    return null;
  }
}

/** Every left-out item key, for a new check that keeps them out. Null when a page fails. */
export async function excludedKeysAction(biz: string, run: string): Promise<string[] | null> {
  await requirePermission("transfers:manage", "admin");
  const keys: string[] = [];
  let after: string | undefined;
  try {
    do {
      const page = await listTransferItems(biz, run, {
        result: "left_out",
        limit: 500,
        starting_after: after,
      });
      keys.push(...page.data.map((i) => i.key));
      after = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    } while (after);
  } catch {
    return null;
  }
  return keys;
}

/** Leave items out of an open plan, or put them back. */
export async function setItemsAction(
  biz: string,
  run: string,
  change: { exclude?: string[]; include?: string[] },
): Promise<RunResult> {
  await requirePermission("transfers:manage", "admin");
  return runResult(await setTransferItems(biz, run, change), "We could not change the plan.");
}

/** Queue the plan. `confirm` is the destination's name when the plan changes a live business. */
export async function applyTransferAction(
  biz: string,
  run: string,
  confirm?: string,
): Promise<RunResult> {
  await requirePermission("transfers:manage", "admin");
  return runResult(await applyTransferRun(biz, run, confirm), "We could not start the copy.");
}

/** Queue again the failed items and the items they held back. */
export async function retryTransferAction(
  biz: string,
  run: string,
  confirm?: string,
): Promise<RunResult> {
  await requirePermission("transfers:manage", "admin");
  return runResult(
    await retryTransferRun(biz, run, confirm),
    "We could not start the failed items again.",
  );
}

/** Stop the run after its current item. */
export async function cancelTransferAction(biz: string, run: string): Promise<RunResult> {
  await requirePermission("transfers:manage", "admin");
  return runResult(await cancelTransferRun(biz, run), "We could not stop the copy.");
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

export async function seedSampleDataAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("transfers:manage", "admin");

  const biz = formData.get("biz") as string;
  const result = await seedSampleData(biz);
  if (!result.ok) {
    const msg = (result.data as { error?: { message?: string } } | undefined)?.error?.message;
    return actionError(msg ?? result.error ?? "We could not create the sample data.");
  }
  const summary = result.data as
    | { products?: number; prices?: number; coupons?: number; customers?: number }
    | undefined;
  revalidatePath(`/businesses/${biz}/transfer`);
  return actionOk(
    `Sample data created: ${summary?.products ?? 0} products, ${summary?.prices ?? 0} prices, ${summary?.coupons ?? 0} coupons, ${summary?.customers ?? 0} customers.`,
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

/** Reset this test business to a new test mode of its live business. The ids stay. */
export async function resetTestBusinessAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("test_tools:manage", "admin");
  const biz = formData.get("biz") as string;
  const result = await apiPost(`/v1/businesses/${encodeURIComponent(biz)}/test_data/reset`, {});
  if (!result.ok) return actionError(result.error ?? "We could not reset the test business.");
  revalidatePath(`/businesses/${biz}`, "layout");
  return actionOk("Test business reset.");
}

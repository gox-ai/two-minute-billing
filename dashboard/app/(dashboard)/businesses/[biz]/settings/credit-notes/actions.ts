"use server";

import type { ActionResult } from "@/lib/action-result";
import { requirePermission } from "@/lib/session";
import { saveCreditNoteDocumentAction, saveCreditNotesAction } from "../actions";

/**
 * The Credit notes page is one form over two actions: the prefix and counter are
 * business columns, the rest is `invoice_customization`. Same order and version rule
 * as the Invoices page.
 */
export async function saveCreditNotePageAction(
  prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const columns = await saveCreditNotesAction(prev, fd);
  if (!columns.ok) return columns;
  fd.delete("expected_version");
  const doc = await saveCreditNoteDocumentAction(prev, fd);
  if (!doc.ok)
    return { ...doc, message: `We saved the number but not the other settings: ${doc.message}` };
  return { ok: true, message: "Credit note settings saved" };
}

"use server";

import type { ActionResult } from "@/lib/action-result";
import { requirePermission } from "@/lib/session";
import { saveInvoiceDocumentAction, saveInvoicingAction } from "../actions";

/**
 * The Invoices page is one form, but its fields live behind two actions: the prefix,
 * counter and note are business columns, the rest is `invoice_customization`. The
 * column save runs first because it validates the prefix and counter; the second write
 * re-reads and merges, so it drops the version the first write already consumed.
 */
export async function saveInvoicePageAction(
  prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const columns = await saveInvoicingAction(prev, fd);
  if (!columns.ok) return columns;
  fd.delete("expected_version");
  const doc = await saveInvoiceDocumentAction(prev, fd);
  if (!doc.ok)
    return {
      ...doc,
      message: `We saved the number and the note but not the other settings: ${doc.message}`,
    };
  return { ok: true, message: "Invoice settings saved" };
}

"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionOk, actionError, type ActionResult } from "@/lib/action-result";
import { resendEmail, sendAdhocEmail, type AdhocEmailBody } from "@/lib/api/emails";

/**
 * Re-send a billing email from the message log.
 *
 * Exists because `lib/api/emails` is a SERVER-ONLY module — it reaches `next/headers`
 * for the session — and `emails-table.tsx` is a `'use client'` component. Importing
 * the fetcher directly across that boundary pulls a server module into the client
 * bundle and fails the production build outright, which is what it was doing. Every
 * other screen already routes its writes through a `'use server'` action for exactly
 * this reason; the emails screen was the one that never got one.
 */
export async function resendEmailAction(biz: string, id: string): Promise<ActionResult> {
  // Matches emails/page.tsx, the screen this is invoked from. Was missing entirely while
  // sendAdhocEmailAction below it checked 'admin' — an oversight, not a decision, and one
  // the audit's file list did not cover. Re-sending a billing document to a customer is a
  // real outbound side effect.
  await requirePermission("emails:manage", "ops");
  try {
    await resendEmail(biz, id);
    revalidatePath(`/businesses/${biz}/emails`);
    return actionOk("Email re-sent");
  } catch (e) {
    return actionError(e instanceof Error ? e.message : "We could not re-send the email.");
  }
}

/**
 * Send one operator-initiated billing email, from the invoice or credit-note detail page.
 * Same server-only boundary reason as above: `SendEmailDialog` is a client component and
 * cannot call the fetcher itself.
 *
 * Returns the dialog's `SendEmailResult` rather than an `ActionResult` — it needs the
 * TRANSPORT back, not just a message, so it can say "written to the dev sink, nothing was
 * delivered" instead of a green "Sent" for mail that never left.
 */
export async function sendAdhocEmailAction(
  biz: string,
  body: AdhocEmailBody,
): Promise<{ ok: boolean; error?: string | null; transport?: string | null }> {
  await requirePermission("emails:manage", "admin");
  try {
    const res = await sendAdhocEmail(biz, body);
    // The message is now in the log whether it succeeded or failed, and a failed send is
    // exactly when someone goes looking for it.
    revalidatePath(`/businesses/${biz}/emails`);
    return { ok: res.ok, error: res.error, transport: res.transport };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "We could not send the email." };
  }
}

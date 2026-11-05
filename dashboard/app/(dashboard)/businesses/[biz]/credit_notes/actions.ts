"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/session";
import { actionError, actionOk, type ActionResult } from "@/lib/action-result";
import {
  createCreditNote,
  refundCreditNote,
  recordOfflineCnRefund,
  voidCreditNote,
  resolveCreditNotePayout,
  type CreatedCreditNote,
  type OfflineRefundMethod,
} from "@/lib/api/credit-notes";
import { createComment } from "@/lib/api/comments";
import { money } from "@/lib/format";
import { getInvoice, listInvoices } from "@/lib/api";
import type { InvoiceExtras } from "@/lib/api/invoices";
import { listCreditNotes } from "@/lib/api";
import type { CreditNoteKind } from "@/lib/api/credit-notes";
import {
  CREDITABLE_STATUSES,
  type InvoiceChoice,
  type PickInvoice,
} from "@/components/credit-notes/invoice-choice";
import { allocateAcrossLines, invoiceCreditableMinor } from "@/lib/credit-allocation";

// Server actions for the Credit Notes surface (own module — actions never live
// in the app-wide actions.ts). Each re-checks the operator's permission because
// the org API key carries no per-user role; the UI gating is presentational.

const REASON_CODES = [
  "write_off",
  "subscription_change",
  "subscription_cancellation",
  "chargeback",
  "other",
] as const;

const path = (biz: string) => `/businesses/${biz}/credit_notes`;

/**
 * Optional "Add a comment" on a rail dialog — distinct from the refund's own
 * `reason`, this is a free note dropped on the credit note's Comments timeline.
 * Best-effort: the primary action already succeeded by
 * the time this runs, so a failed comment post never fails the dialog —
 * it just doesn't get silently discarded, either.
 */
async function postDialogComment(biz: string, cn: string, comment: string): Promise<boolean> {
  if (!comment) return true;
  const res = await createComment(biz, "credit_note", cn, comment);
  return res.ok;
}

/**
 * Create a credit note. Line items are posted from the client form as parallel
 * arrays `item_description[]` / `item_amount_minor[]` (a row is included only if
 * it has a positive amount). The form lands on the new note's detail on success.
 */
export async function createCreditNoteAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("credit_notes:manage", "manager");
  const biz = String(formData.get("biz") ?? "");
  if (!biz) return actionError("The business ID is missing. Reload the page.");

  const invoice = String(formData.get("invoice") ?? "").trim();
  const kind = String(formData.get("kind") ?? "");
  const reasonCode = String(formData.get("reason_code") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();

  const descriptions = formData.getAll("item_description").map((v) => String(v));
  const amounts = formData.getAll("item_amount_minor").map((v) => String(v));
  const lineIds = formData.getAll("item_line").map((v) => String(v));
  const items: Array<{ description: string; amount_minor: number; invoice_line_item?: string }> =
    [];
  for (let i = 0; i < amounts.length; i++) {
    const raw = (amounts[i] ?? "").trim();
    if (raw === "") continue;
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (!Number.isInteger(amount)) {
      return {
        ok: false,
        message: "Correct the highlighted fields",
        errors: { items: "Enter credit amounts as whole minor units. Do not use decimals." },
      };
    }
    const description = (descriptions[i] ?? "").trim() || `Credit line ${i + 1}`;
    const line = (lineIds[i] ?? "").trim();
    items.push({ description, amount_minor: amount, ...(line ? { invoice_line_item: line } : {}) });
  }

  const parsed = z
    .object({
      invoice: z.string().min(1, "Select an invoice"),
      kind: z.enum(["adjustment", "refundable"]),
      reason_code: z.enum(REASON_CODES).optional(),
      items: z
        .array(
          z.object({
            description: z.string(),
            amount_minor: z.number().int().positive(),
            invoice_line_item: z.string().optional(),
          }),
        )
        .min(1, "Add at least one line with a positive amount"),
    })
    .safeParse({
      invoice,
      kind,
      reason_code: reasonCode || undefined,
      items,
    });

  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues)
      errors[issue.path.join(".") || "_form"] = issue.message;
    return { ok: false, message: "Correct the highlighted fields", errors };
  }

  const res = await createCreditNote(biz, {
    invoice: parsed.data.invoice,
    kind: parsed.data.kind,
    reason_code: parsed.data.reason_code,
    reason: reason || undefined,
    items: parsed.data.items,
  });

  if (!res.ok) {
    if (res.status === 409) return actionError(res.error ?? "Conflict", { code: "conflict" });
    return actionError(res.error ?? "We could not create the credit note.");
  }

  revalidatePath(path(biz));
  const created = res.data as CreatedCreditNote;
  return actionOk(`Credit note ${created.id} created`, `${path(biz)}/${created.id}`);
}

/** Refund (part of) a refundable credit note's available credit to the card. */
export async function refundCreditNoteAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("credit_notes:manage", "manager");
  const biz = String(formData.get("biz") ?? "");
  const cn = String(formData.get("cn") ?? "");
  if (!biz || !cn)
    return actionError("The business or credit note ID is missing. Reload the page.");

  const raw = String(formData.get("amount_minor") ?? "").trim();
  let amount_minor: number | undefined;
  if (raw !== "") {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      return {
        ok: false,
        message: "Correct the highlighted fields",
        errors: { amount_minor: "Enter a positive whole number of minor units" },
      };
    }
    amount_minor = n;
  }

  const reason = String(formData.get("reason") ?? "").trim();
  const comment = String(formData.get("comment") ?? "").trim();
  // Carried by the dialog purely so the partial-refund message below can render real
  // money rather than minor units.
  const currency = String(formData.get("currency") ?? "").trim() || "USD";
  const res = await refundCreditNote(biz, cn, { amount_minor, reason: reason || undefined });
  if (!res.ok) {
    if (res.status === 409) return actionError(res.error ?? "Conflict", { code: "conflict" });
    return actionError(res.error ?? "We could not issue the refund.");
  }
  const commentSaved = await postDialogComment(biz, cn, comment);
  revalidatePath(`${path(biz)}/${cn}`);
  revalidatePath(path(biz));

  // SAY SO WHEN ONLY PART WENT OUT. `refundCreditNote` pays what the gateway can still
  // reverse on the note's invoice and un-earmarks the rest, so a request larger than the
  // traceable cash succeeds having paid LESS than asked — and this used to answer a flat
  // "Refund issued" either way. Reaching the same end state over two calls is fine;
  // silently reporting the first as complete is not. The API already returned both
  // numbers; only this message was hiding them.
  const d = res.data as { refunded_minor?: number; available_minor?: number } | undefined;
  const left = d?.available_minor ?? 0;
  const paid = d?.refunded_minor;
  const head =
    left > 0 && paid != null
      ? `Refund issued for ${money(paid, currency)}. ${money(left, currency)} is still available on this credit note.`
      : "Refund issued.";
  return actionOk(commentSaved ? head : `${head} We could not save the comment.`);
}

/** Record an offline refund (cash/check/bank transfer) made outside any gateway. */
export async function recordOfflineRefundAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("credit_notes:manage", "manager");
  const biz = String(formData.get("biz") ?? "");
  const cn = String(formData.get("cn") ?? "");
  if (!biz || !cn)
    return actionError("The business or credit note ID is missing. Reload the page.");

  const method = String(formData.get("method") ?? "");
  if (!["cash", "check", "bank_transfer", "other"].includes(method)) {
    return {
      ok: false,
      message: "Correct the highlighted fields",
      errors: { method: "Select a refund method" },
    };
  }
  const raw = String(formData.get("amount_minor") ?? "").trim();
  let amount_minor: number | undefined;
  if (raw !== "") {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      return {
        ok: false,
        message: "Correct the highlighted fields",
        errors: { amount_minor: "Enter a positive whole number of minor units" },
      };
    }
    amount_minor = n;
  }
  const reference = String(formData.get("reference") ?? "").trim();
  const dateRaw = String(formData.get("date") ?? "").trim();
  let date: string | undefined;
  if (dateRaw !== "") {
    const d = new Date(dateRaw);
    if (Number.isNaN(d.getTime())) {
      return {
        ok: false,
        message: "Correct the highlighted fields",
        errors: { date: "Enter a valid date and time" },
      };
    }
    date = d.toISOString();
  }
  const reason = String(formData.get("reason") ?? "").trim();
  const comment = String(formData.get("comment") ?? "").trim();

  const res = await recordOfflineCnRefund(biz, cn, {
    amount_minor,
    method: method as OfflineRefundMethod,
    reference: reference || undefined,
    date,
    reason: reason || undefined,
  });
  if (!res.ok) {
    if (res.status === 409) return actionError(res.error ?? "Conflict", { code: "conflict" });
    return actionError(res.error ?? "We could not record the offline refund.");
  }
  const commentSaved = await postDialogComment(biz, cn, comment);
  revalidatePath(`${path(biz)}/${cn}`);
  revalidatePath(path(biz));
  return actionOk(
    commentSaved
      ? "Offline refund recorded"
      : "Offline refund recorded. We could not save the comment.",
  );
}

/** Void a credit note (reverses its ledger; reopens the invoice for adjustments). */
/** An unconfirmed payout refund: mark it paid, or return it to the note as credit. */
export async function resolvePayoutAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("credit_notes:manage", "manager");
  const biz = String(formData.get("biz") ?? "");
  const cn = String(formData.get("cn") ?? "");
  const resolution = String(formData.get("resolution") ?? "");
  if (!biz || !cn || (resolution !== "return_as_credit" && resolution !== "mark_paid"))
    return actionError("The credit note or the selection is missing. Reload the page.");
  const res = await resolveCreditNotePayout(biz, cn, resolution);
  if (!res.ok) return actionError(res.error ?? "We could not resolve the refund.");
  revalidatePath(`${path(biz)}/${cn}`);
  return actionOk(
    resolution === "mark_paid" ? "Refund marked paid." : "Amount returned as credit.",
  );
}

export async function voidCreditNoteAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("credit_notes:manage", "manager");
  const biz = String(formData.get("biz") ?? "");
  const cn = String(formData.get("cn") ?? "");
  if (!biz || !cn)
    return actionError("The business or credit note ID is missing. Reload the page.");

  // No `comment` read here on purpose: the void dialog is a `ConfirmDialog`, which has
  // no slot for a field — its only text prop is `description`, and an input rendered
  // there would sit OUTSIDE the hidden ActionForm, so the typed value would never be
  // submitted. Reading a field no dialog can post would just be dead code. To close
  // this properly, ConfirmDialog needs an optional children/extra-content slot; then
  // wire it the way the two refund dialogs are wired (see postDialogComment).
  const res = await voidCreditNote(biz, cn);
  if (!res.ok) {
    if (res.status === 409) return actionError(res.error ?? "Conflict", { code: "conflict" });
    return actionError(res.error ?? "We could not void the credit note.");
  }
  revalidatePath(`${path(biz)}/${cn}`);
  revalidatePath(path(biz));
  return actionOk("Credit note voided");
}

// ─────────────────────────────────────────────────────────────────────────────
// INVOICE-LEVEL credit + refund actions — the "Payment and Credit
// Actions" rail, which offers three dialogs straight off the invoice:
// "Create a Credit note", "Record an offline refund" and "Issue a refund".
//
// Ours had only a link to the full line-by-line takeover, so the cheap case (credit
// or refund the whole thing) cost an operator a page load and four line inputs. These
// dialogs ask for ONE amount and put the line editor behind an "Advanced ›" link.
//
// Two of them are COMPOSITES, because a refund in this engine is a property of a
// credit note, not of an invoice: mint the refundable credit note, then pay it out
// (gateway) or record it (offline). That ordering matters — if the payout fails the
// credit note still exists and stays visible as `refund_due`, which is exactly the
// state the credit-note rail is built to finish. Silently rolling it back would
// leave the operator with a failed dialog and no artifact to retry from.
//
// A `refund_due` credit note already on the invoice is REUSED rather than joined by a
// second one: an invoice has one refundable capacity, and stacking credit notes for
// one economic event is hard to read.
// ─────────────────────────────────────────────────────────────────────────────

/** Shared parse for the amount box every one of these dialogs carries. */
function parseAmountMinor(formData: FormData): { amount?: number } | { error: ActionResult } {
  const raw = String(formData.get("amount_minor") ?? "").trim();
  if (raw === "") return {};
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    return {
      error: {
        ok: false,
        message: "Correct the highlighted fields",
        errors: { amount_minor: "Enter a positive amount" },
      },
    };
  }
  return { amount: n };
}

/**
 * Turn the dialog's single amount into the `items[]` the credit-note API wants, by
 * reading the invoice's own lines and apportioning across them.
 *
 * The lines are read SERVER-SIDE here rather than posted from the client so the
 * allocation cannot be tampered with and cannot go stale against an invoice that
 * changed since the page rendered.
 */
async function invoiceCreditItems(
  biz: string,
  invoiceId: string,
  amountMinor: number | undefined,
): Promise<
  { items: Array<{ description: string; amount_minor: number }> } | { error: ActionResult }
> {
  const inv = await getInvoice(biz, invoiceId).catch(() => null);
  if (!inv) return { error: actionError("We could not load the invoice.") };
  const lines = (inv.lines ?? []).map((l) => ({
    description: l.description,
    amount_minor: l.amount_minor,
  }));
  // Blank amount = credit everything still creditable, which is what the dialogs
  // pre-fill.
  const target = amountMinor ?? invoiceCreditableMinor(inv, []);
  const items = allocateAcrossLines(lines, target);
  if (items.length === 0) {
    return { error: actionError("You cannot credit any amount on this invoice.") };
  }
  return { items };
}

/** Find a credit note on this invoice that still owes the customer money. */
async function existingRefundDue(biz: string, invoiceId: string): Promise<string | null> {
  const list = await listCreditNotes(biz, undefined, { limit: 100 }).catch(() => null);
  if (!list) return null;
  const hit = list.data.find((cn) => cn.invoice === invoiceId && cn.status === "refund_due");
  return hit?.id ?? null;
}

/** Invoice-level "Create a Credit note" dialog. */
export async function createInvoiceCreditNoteAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("credit_notes:manage", "manager");
  const biz = String(formData.get("biz") ?? "");
  const invoice = String(formData.get("invoice") ?? "");
  if (!biz || !invoice)
    return actionError("The business or invoice ID is missing. Reload the page.");

  const kind = String(formData.get("kind") ?? "");
  if (kind !== "adjustment" && kind !== "refundable") {
    return {
      ok: false,
      message: "Correct the highlighted fields",
      errors: { kind: "Select what this credit note does" },
    };
  }
  const amt = parseAmountMinor(formData);
  if ("error" in amt) return amt.error;
  const built = await invoiceCreditItems(biz, invoice, amt.amount);
  if ("error" in built) return built.error;

  const reasonCode = String(formData.get("reason_code") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  const res = await createCreditNote(biz, {
    invoice,
    kind,
    reason_code: reasonCode ? (reasonCode as (typeof REASON_CODES)[number]) : undefined,
    reason: reason || undefined,
    items: built.items,
  });
  if (!res.ok) {
    if (res.status === 409) return actionError(res.error ?? "Conflict", { code: "conflict" });
    return actionError(res.error ?? "We could not create the credit note.");
  }
  const created = res.data as CreatedCreditNote;
  await postDialogComment(biz, created.id, String(formData.get("comment") ?? "").trim());
  revalidatePath(`/businesses/${biz}/invoices/${invoice}`);
  revalidatePath(path(biz));
  return actionOk("Credit note created");
}

/** Invoice-level "Issue a refund" — refundable credit note, then a gateway payout. */
export async function refundInvoiceAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("credit_notes:manage", "manager");
  const biz = String(formData.get("biz") ?? "");
  const invoice = String(formData.get("invoice") ?? "");
  if (!biz || !invoice)
    return actionError("The business or invoice ID is missing. Reload the page.");

  const amt = parseAmountMinor(formData);
  if ("error" in amt) return amt.error;
  const reason = String(formData.get("reason") ?? "").trim();
  const comment = String(formData.get("comment") ?? "").trim();

  let cn = await existingRefundDue(biz, invoice);
  if (!cn) {
    const built = await invoiceCreditItems(biz, invoice, amt.amount);
    if ("error" in built) return built.error;
    const created = await createCreditNote(biz, {
      invoice,
      kind: "refundable",
      reason_code: (String(formData.get("reason_code") ?? "").trim() || undefined) as
        | (typeof REASON_CODES)[number]
        | undefined,
      reason: reason || undefined,
      items: built.items,
    });
    if (!created.ok) {
      if (created.status === 409)
        return actionError(created.error ?? "Conflict", { code: "conflict" });
      return actionError(created.error ?? "We could not create the credit note for this refund.");
    }
    cn = (created.data as CreatedCreditNote).id;
  }

  const res = await refundCreditNote(biz, cn, {
    amount_minor: amt.amount,
    reason: reason || undefined,
  });
  if (!res.ok) {
    // The credit note is intentionally left standing — it shows as `refund_due` on
    // the invoice so the payout can be retried without re-crediting.
    return actionError(
      res.error ??
        "We created the credit note, but we could not issue the refund. Retry the refund from the credit note.",
    );
  }
  await postDialogComment(biz, cn, comment);
  revalidatePath(`/businesses/${biz}/invoices/${invoice}`);
  revalidatePath(`${path(biz)}/${cn}`);
  revalidatePath(path(biz));
  return actionOk("Refund issued");
}

/** Invoice-level "Record an offline refund" — refundable credit note, then recorded. */
export async function recordInvoiceOfflineRefundAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("credit_notes:manage", "manager");
  const biz = String(formData.get("biz") ?? "");
  const invoice = String(formData.get("invoice") ?? "");
  if (!biz || !invoice)
    return actionError("The business or invoice ID is missing. Reload the page.");

  const method = String(formData.get("method") ?? "");
  if (!["cash", "check", "bank_transfer", "other"].includes(method)) {
    return {
      ok: false,
      message: "Correct the highlighted fields",
      errors: { method: "Select a refund method" },
    };
  }
  const amt = parseAmountMinor(formData);
  if ("error" in amt) return amt.error;

  const dateRaw = String(formData.get("date") ?? "").trim();
  let date: string | undefined;
  if (dateRaw !== "") {
    const d = new Date(dateRaw);
    if (Number.isNaN(d.getTime())) {
      return {
        ok: false,
        message: "Correct the highlighted fields",
        errors: { date: "Enter a valid date and time" },
      };
    }
    date = d.toISOString();
  }
  const reference = String(formData.get("reference") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  const comment = String(formData.get("comment") ?? "").trim();

  let cn = await existingRefundDue(biz, invoice);
  if (!cn) {
    const built = await invoiceCreditItems(biz, invoice, amt.amount);
    if ("error" in built) return built.error;
    const created = await createCreditNote(biz, {
      invoice,
      kind: "refundable",
      reason_code: (String(formData.get("reason_code") ?? "").trim() || undefined) as
        | (typeof REASON_CODES)[number]
        | undefined,
      reason: reason || undefined,
      items: built.items,
    });
    if (!created.ok) {
      if (created.status === 409)
        return actionError(created.error ?? "Conflict", { code: "conflict" });
      return actionError(created.error ?? "We could not create the credit note for this refund.");
    }
    cn = (created.data as CreatedCreditNote).id;
  }

  const res = await recordOfflineCnRefund(biz, cn, {
    amount_minor: amt.amount,
    method: method as OfflineRefundMethod,
    reference: reference || undefined,
    date,
    reason: reason || undefined,
  });
  if (!res.ok) {
    return actionError(
      res.error ??
        "We created the credit note, but we could not record the refund. Record the refund from the credit note.",
    );
  }
  await postDialogComment(biz, cn, comment);
  revalidatePath(`/businesses/${biz}/invoices/${invoice}`);
  revalidatePath(`${path(biz)}/${cn}`);
  revalidatePath(path(biz));
  return actionOk("Offline refund recorded");
}

/**
 * The credit-note form's invoice search. Server-side, so every invoice is reachable:
 * the form used to offer only the newest page, which left older invoices uncreditable.
 * The engine's `q` matches the number, invoice id and the customer's name and email.
 */
export async function searchCreditableInvoicesAction(
  biz: string,
  kind: CreditNoteKind,
  q: string,
): Promise<InvoiceChoice[]> {
  await requirePermission("credit_notes:manage", "manager");
  try {
    const page = await listInvoices(biz, undefined, {
      q: q.trim() || undefined,
      limit: 20,
      filters: [{ field: "status", op: "in", value: CREDITABLE_STATUSES[kind].join(",") }],
    });
    return page.data.map((i) => {
      const row = i as typeof i & { customer_name?: string | null; customer_email?: string | null };
      return {
        id: i.id,
        number: i.number ?? null,
        status: i.status,
        currency: i.currency,
        total_minor: i.total_minor,
        customer: row.customer_name || row.customer_email || null,
        created_at: i.created_at ?? null,
      };
    });
  } catch {
    return [];
  }
}

/** One invoice with its lines, loaded when the picker selects it. */
export async function loadCreditableInvoiceAction(
  biz: string,
  invoice: string,
): Promise<PickInvoice | null> {
  await requirePermission("credit_notes:manage", "manager");
  const i = await getInvoice(biz, invoice).catch(() => null);
  return i ? toPickInvoice(i) : null;
}

function toPickInvoice(i: Awaited<ReturnType<typeof getInvoice>>): PickInvoice {
  return {
    id: i.id,
    number: i.number ?? null,
    status: i.status,
    currency: i.currency,
    total_minor: i.total_minor,
    amount_due_minor: i.amount_due_minor ?? null,
    grant_credits_minor:
      ((i as InvoiceExtras).grant_credits_pre_tax_minor ?? 0) +
      ((i as InvoiceExtras).grant_credits_post_tax_minor ?? 0),
    lines: (i.lines ?? []).map((l) => ({
      id: l.id,
      description: l.description,
      amount_minor: l.amount_minor,
      // Older engines omit it; the line amount was the form's cap before.
      creditable_minor: l.creditable_minor ?? l.amount_minor,
    })),
  };
}

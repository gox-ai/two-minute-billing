"use server";

// Rich subscription lifecycle actions (full option sets). The frozen
// app/actions.ts keeps the original simple ops; these expose every field the
// backend accepts (src/api/subscription-routes.ts): cancel/pause/resume option
// sets, change_term_end, remove_scheduled_cancellation, trigger_charge, and
// the batched change-flow apply + estimate used by the /change page.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { apiPost, apiWrite, apiPatch } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { actionOk, actionError, parseForm, type ActionResult } from "@/lib/action-result";
import { assertUtc, optUtcDateTime, utcDateTime } from "@/lib/zod-utc";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { businessTz } from "@/lib/business-tz-server";
import { checkMetadata } from "@/lib/metadata-form";
import type {
  CancelEstimate,
  ChangeEstimate,
  SubscriptionChangeLine,
} from "@/lib/api/subscriptions";

const subUrl = (biz: string, sub: string) => `/businesses/${biz}/subscriptions/${sub}`;

function fail(
  res: { status: number; error?: string; requestId?: string },
  fallback: string,
): ActionResult {
  return res.status === 409
    ? actionError(res.error ?? fallback, { code: "conflict" })
    : actionError(res.error ?? fallback, { requestId: res.requestId });
}

const QUOTE_MOVED =
  "The price changed after the estimate. We changed nothing. Check the new estimate and confirm again.";

/** Like `fail`, but the message is ours in full (it names what did or didn't land). */
function refused(res: { status: number; param?: string }, message: string): ActionResult {
  if (res.status === 409) return actionError(message, { code: "conflict" });
  // A metadata rule names the field it refused, so the message lands on the metadata box.
  if (res.param === "metadata") return actionError(message, { errors: { metadata_text: message } });
  return actionError(message);
}

/** '' → undefined for optional enum/text fields coming from <select>/<input>. */
const opt = z.preprocess((v) => (v === "" || v == null ? undefined : v), z.string().optional());
const optEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((v) => (v === "" || v == null ? undefined : v), z.enum(values).optional());
const optInt = z.preprocess(
  (v) => (v === "" || v == null ? undefined : Number(v)),
  z.number().int().positive().optional(),
);

// ─── Cancel (full option set — SUB-5/SUB-8) ──────────────────────────────────

const cancelSchema = z.object({
  biz: z.string().min(1),
  sub: z.string().min(1),
  cancel_option: optEnum(["immediately", "end_of_term", "specific_date"] as const),
  cancel_at: optUtcDateTime,
  credit_option_for_current_term_charges: optEnum(["none", "prorate", "full"] as const),
  unbilled_charges_option: optEnum(["invoice", "delete"] as const),
  // Mirrors the engine's enum (`subscription-routes.ts`); "void" was missing, so every
  // "Void them" cancel was refused here before reaching the engine.
  account_receivables_handling: optEnum([
    "no_action",
    "schedule_payment_collection",
    "write_off",
    "void",
  ] as const),
  refundable_credits_handling: optEnum(["no_action", "schedule_refund"] as const),
  cancel_reason_code: opt,
  cancel_reason: opt,
  // Per-call overrides; the dialog posts them only when they differ from the business rule.
  final_period: optEnum(["full_period", "prorated", "nothing"] as const),
  plan_credits_on_cancel_at_period_end: optEnum([
    "grant_started_window",
    "stop_at_request",
  ] as const),
});

export async function cancelSubscriptionFullAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("subscriptions:lifecycle", "ops");
  const { data, error } = parseForm(cancelSchema, formData);
  if (error) return error;
  if (data.cancel_option === "specific_date" && !data.cancel_at) {
    return actionError("Select the cancellation date", {
      errors: { cancel_at: "Required for a specific-date cancel" },
    });
  }
  const res = await apiPost(`/v1/businesses/${data.biz}/subscriptions/${data.sub}/cancel`, {
    // Omitted cancel_option → the business default applies (H1/SET-1).
    ...(data.cancel_option ? { cancel_option: data.cancel_option } : {}),
    ...(data.cancel_option === "specific_date" && data.cancel_at
      ? { cancel_at: new Date(data.cancel_at).toISOString() }
      : {}),
    ...(data.credit_option_for_current_term_charges
      ? { credit_option_for_current_term_charges: data.credit_option_for_current_term_charges }
      : {}),
    ...(data.unbilled_charges_option
      ? { unbilled_charges_option: data.unbilled_charges_option }
      : {}),
    ...(data.account_receivables_handling
      ? { account_receivables_handling: data.account_receivables_handling }
      : {}),
    ...(data.refundable_credits_handling
      ? { refundable_credits_handling: data.refundable_credits_handling }
      : {}),
    ...(data.cancel_reason_code ? { cancel_reason_code: data.cancel_reason_code } : {}),
    ...(data.cancel_reason ? { cancel_reason: data.cancel_reason } : {}),
    ...(data.final_period ? { final_period: data.final_period } : {}),
    ...(data.plan_credits_on_cancel_at_period_end
      ? { plan_credits: { on_cancel_at_period_end: data.plan_credits_on_cancel_at_period_end } }
      : {}),
  });
  revalidatePath(subUrl(data.biz, data.sub));
  if (!res.ok) return fail(res, "We could not cancel the subscription.");
  const creditNote = (res.data as { credit_note?: { id?: string } | null } | undefined)
    ?.credit_note;
  const scheduled = (res.data as { scheduled_change?: unknown } | undefined)?.scheduled_change;
  const done = scheduled
    ? "Cancellation scheduled"
    : creditNote?.id
      ? `Subscription canceled. Credit note ${creditNote.id} issued`
      : "Subscription canceled";
  // The cancel stands even when a follow-up (voiding, writing off, collecting an open
  // invoice) failed; say so rather than reporting a clean success.
  const warnings = (res.data as { warnings?: string[] } | undefined)?.warnings ?? [];
  return warnings.length
    ? {
        ok: true,
        warning: true,
        message: `${done}, but some steps failed: ${warnings.join("; ")}`,
      }
    : actionOk(done);
}

// ─── Pause / Resume (SUB-6) ──────────────────────────────────────────────────

const pauseSchema = z.object({
  biz: z.string().min(1),
  sub: z.string().min(1),
  pause_option: z.enum(["immediately", "end_of_term", "specific_date", "billing_cycles"]),
  pause_date: optUtcDateTime,
  skip_billing_cycles: optInt,
  unbilled_charges_handling: optEnum(["invoice", "delete", "no_action"] as const),
  dunning_handling: optEnum(["continue", "stop"] as const),
  plan_credits_on_pause: optEnum(["skip", "keep_granting", "shift"] as const),
});

export async function pauseSubscriptionFullAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("subscriptions:lifecycle", "ops");
  const { data, error } = parseForm(pauseSchema, formData);
  if (error) return error;
  if (data.pause_option === "specific_date" && !data.pause_date) {
    return actionError("Select the pause date", {
      errors: { pause_date: "Required for a specific-date pause" },
    });
  }
  if (data.pause_option === "billing_cycles" && !data.skip_billing_cycles) {
    return actionError("Enter the number of billing cycles to skip", {
      errors: { skip_billing_cycles: "Required when pausing for N billing cycles" },
    });
  }
  const res = await apiPost(`/v1/businesses/${data.biz}/subscriptions/${data.sub}/pause`, {
    pause_option: data.pause_option,
    ...(data.pause_option === "specific_date" && data.pause_date
      ? { pause_date: new Date(data.pause_date).toISOString() }
      : {}),
    ...(data.pause_option === "billing_cycles" && data.skip_billing_cycles
      ? { skip_billing_cycles: data.skip_billing_cycles }
      : {}),
    ...(data.unbilled_charges_handling
      ? { unbilled_charges_handling: data.unbilled_charges_handling }
      : {}),
    ...(data.dunning_handling ? { dunning_handling: data.dunning_handling } : {}),
    ...(data.plan_credits_on_pause
      ? { plan_credits: { on_pause: data.plan_credits_on_pause } }
      : {}),
  });
  revalidatePath(subUrl(data.biz, data.sub));
  if (!res.ok) return fail(res, "We could not pause the subscription.");
  const resumeAt = (res.data as { resume_scheduled_at?: string | null } | undefined)
    ?.resume_scheduled_at;
  const scheduled = (res.data as { scheduled_change?: unknown } | undefined)?.scheduled_change;
  return actionOk(
    scheduled
      ? "Pause scheduled"
      : resumeAt
        ? `Subscription paused. It resumes automatically on ${fmtDate(resumeAt, await businessTz(data.biz))}`
        : "Subscription paused",
  );
}

const resumeSchema = z.object({
  biz: z.string().min(1),
  sub: z.string().min(1),
  charges_handling: optEnum(["invoice_immediately", "add_to_unbilled_charges"] as const),
  unpaid_invoices_handling: optEnum(["no_action", "schedule_payment_collection"] as const),
});

export async function resumeSubscriptionFullAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("subscriptions:lifecycle", "ops");
  const { data, error } = parseForm(resumeSchema, formData);
  if (error) return error;
  const res = await apiPost(`/v1/businesses/${data.biz}/subscriptions/${data.sub}/resume`, {
    ...(data.charges_handling ? { charges_handling: data.charges_handling } : {}),
    ...(data.unpaid_invoices_handling
      ? { unpaid_invoices_handling: data.unpaid_invoices_handling }
      : {}),
  });
  revalidatePath(subUrl(data.biz, data.sub));
  if (!res.ok) return fail(res, "We could not resume the subscription.");
  // `latest_invoice` is the invoice's public id (a string), or null when nothing was raised.
  const inv = (res.data as { latest_invoice?: string | null } | undefined)?.latest_invoice;
  return actionOk(inv ? `Subscription resumed. Invoice: ${inv}` : "Subscription resumed");
}

// ─── Remove scheduled cancellation (SUB-2) ───────────────────────────────────

export async function removeScheduledCancellationAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission(["subscriptions:lifecycle", "subscriptions:manage"], "ops");
  const biz = String(formData.get("biz") ?? "").trim();
  const sub = String(formData.get("sub") ?? "").trim();
  if (!biz || !sub) return actionError("The subscription ID is missing. Reload the page.");
  const res = await apiPost(
    `/v1/businesses/${biz}/subscriptions/${sub}/remove_scheduled_cancellation`,
    {},
  );
  // No revalidatePath here: it re-rendered the page inside the action and unmounted the
  // button before its toast. The form refreshes the page and the status strip on success.
  if (!res.ok) return fail(res, "We could not remove the scheduled cancellation.");
  return actionOk("Scheduled cancellation removed.");
}

// ─── Skip a renewal / undo a skip ────────────────────────────────────────────

const renewalSchema = z.object({
  biz: z.string().min(1),
  sub: z.string().min(1),
  renewal_at: utcDateTime("Select a renewal to skip"),
});

async function postRenewalSkip(
  formData: FormData,
  route: "skip_renewal" | "unskip_renewal",
): Promise<ActionResult> {
  const { data, error } = parseForm(renewalSchema, formData);
  if (error) return error;
  // Sent exactly as listed: the engine matches the instant, not the day.
  const res = await apiPost(`/v1/businesses/${data.biz}/subscriptions/${data.sub}/${route}`, {
    renewal_at: data.renewal_at,
  });
  revalidatePath(subUrl(data.biz, data.sub));
  if (!res.ok)
    return fail(
      res,
      route === "skip_renewal" ? "We could not skip the renewal." : "We could not remove the skip.",
    );
  return actionOk(route === "skip_renewal" ? "Renewal skipped." : "Skip removed.");
}

export async function skipRenewalAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // Ops, like pause: one cycle, undoable, and a customer may do it in the portal.
  await requirePermission("subscriptions:manage", "ops");
  return postRenewalSkip(formData, "skip_renewal");
}

export async function unskipRenewalAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("subscriptions:manage", "ops");
  return postRenewalSkip(formData, "unskip_renewal");
}

// ─── Change term end (SUB-9) ─────────────────────────────────────────────────

const termEndSchema = z.object({
  biz: z.string().min(1),
  sub: z.string().min(1),
  term_ends_at: utcDateTime("Select the new term end"),
  prorate: opt,
  invoice_immediately: opt,
});

export async function changeTermEndAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("subscriptions:lifecycle", "manager");
  const { data, error } = parseForm(termEndSchema, formData);
  if (error) return error;
  const res = await apiPost(
    `/v1/businesses/${data.biz}/subscriptions/${data.sub}/change_term_end`,
    {
      term_ends_at: new Date(data.term_ends_at).toISOString(),
      prorate: data.prorate === "on",
      invoice_immediately: data.invoice_immediately === "on",
    },
  );
  revalidatePath(subUrl(data.biz, data.sub));
  if (!res.ok) return fail(res, "We could not change the term end.");
  const pinv = (res.data as { proration_invoice?: { id?: string } | null } | undefined)
    ?.proration_invoice;
  return actionOk(
    pinv?.id ? `Term end changed. Proration invoice: ${pinv.id}` : "Term end changed",
  );
}

// ─── Edit trial end date ──────────────────────────────────

const editTrialEndSchema = z.object({
  biz: z.string().min(1),
  sub: z.string().min(1),
  trial_end: optUtcDateTime,
  immediately: opt,
});

export async function editTrialEndAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("subscriptions:lifecycle", "manager");
  const { data, error } = parseForm(editTrialEndSchema, formData);
  if (error) return error;
  const immediately = data.immediately === "on";
  if (!immediately && !data.trial_end) {
    return actionError("Select a new trial end date", {
      errors: { trial_end: "Required if you do not end the trial immediately" },
    });
  }
  const res = await apiPost(`/v1/businesses/${data.biz}/subscriptions/${data.sub}/edit_trial_end`, {
    ...(immediately
      ? { immediately: true }
      : { trial_end: new Date(data.trial_end!).toISOString() }),
  });
  revalidatePath(subUrl(data.biz, data.sub));
  if (!res.ok) return fail(res, "We could not change the trial end date.");
  return actionOk(
    immediately ? "Trial ended. The first term is invoiced" : "Trial end date changed",
  );
}

// ─── Manual discount (%/amount discount, no coupon) ──────

const manualDiscountSchema = z
  .object({
    biz: z.string().min(1),
    sub: z.string().min(1),
    type: optEnum(["percent", "amount"] as const),
    value: z.string().min(1, "Enter a discount value"),
    duration: optEnum(["one_time", "forever"] as const),
    note: opt,
  })
  .refine((d) => d.type === "percent" || d.type === "amount", {
    message: "Select percent or amount",
    path: ["type"],
  })
  .refine((d) => d.duration === "one_time" || d.duration === "forever", {
    message: "Select a duration",
    path: ["duration"],
  });

export async function applyManualDiscountAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("subscriptions:lifecycle", "manager");
  const { data, error } = parseForm(manualDiscountSchema, formData);
  if (error) return error;
  const value = Number(data.value);
  if (!Number.isFinite(value) || value <= 0) {
    return actionError("Enter a positive discount value", {
      errors: { value: "Must be a positive number" },
    });
  }
  if (data.type === "percent" && (value < 1 || value > 100)) {
    return actionError("Percent must be between 1 and 100", {
      errors: { value: "Must be between 1 and 100" },
    });
  }
  const res = await apiPost(
    `/v1/businesses/${data.biz}/subscriptions/${data.sub}/manual_discount`,
    {
      type: data.type,
      value,
      duration: data.duration,
      ...(data.note ? { note: data.note } : {}),
    },
  );
  revalidatePath(subUrl(data.biz, data.sub));
  if (!res.ok) return fail(res, "We could not apply the manual discount.");
  return actionOk("Manual discount applied");
}

// ─── Trigger an on-demand attached charge (CAT-4) ────────────────────────────

const triggerChargeSchema = z.object({
  biz: z.string().min(1),
  sub: z.string().min(1),
  attached_item: z.string().min(1),
  quantity: optInt,
});

export async function triggerChargeAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("subscriptions:manage", "ops");
  const { data, error } = parseForm(triggerChargeSchema, formData);
  if (error) return error;
  const res = await apiPost(`/v1/businesses/${data.biz}/subscriptions/${data.sub}/trigger_charge`, {
    attached_item: data.attached_item,
    ...(data.quantity != null ? { quantity: data.quantity } : {}),
  });
  revalidatePath(subUrl(data.biz, data.sub));
  if (!res.ok) return fail(res, "We could not trigger the charge.");
  const d = res.data as { invoice?: { id?: string }; paid?: boolean } | undefined;
  return actionOk(
    `Charge invoiced (${d?.invoice?.id ?? "invoice created"})${d?.paid ? " and paid" : ""}`,
  );
}

// ─── Change flow (/change page): estimate + batched apply ────────────────────

/**
 * Live dry-run of a composition edit for the estimate rail (no writes).
 *
 * Covers modified lines AND adds AND removes, because the apply is up to three API
 * calls and a preview of only the first understated the total — a removal previewed
 * as "no immediate charge" while `DELETE /items/:id` credited unused time.
 *
 * Every option that changes the MONEY has to be forwarded here too, or the rail quotes
 * a figure the apply will not book: `reset_term` and `prorate` both do.
 */
export async function estimateSubscriptionChangeAction(
  biz: string,
  sub: string,
  changes: SubscriptionChangeLine[],
  reset_term?: boolean,
  adds: Array<{ price: string; quantity: number; unit_price_minor?: number }> = [],
  removes: string[] = [],
  prorate?: boolean,
  /** `Add Coupon` / `Add Coupon Code` on the change screen, not yet applied. */
  couponCode?: string,
  /** `+ Add manual discount`, same body shape as `POST …/manual_discount` takes. */
  manualDiscount?: { type: "percent" | "amount"; value: number },
  /** The applied discount is marked for removal on this screen. */
  removeDiscount?: boolean,
  /** `end_of_term`: price the edit as the scheduled change books it at the term end. */
  changeOption?: "end_of_term",
  /** This change's own rules that move money; omitted = the business rule. */
  rules?: Pick<ChangeRuleOverrides, "coupons" | "downgrade_credit">,
): Promise<{ ok: true; estimate: ChangeEstimate } | { ok: false; error: string }> {
  await requirePermission("subscriptions:estimate", "manager");
  if (!biz || !sub) return { ok: false, error: "No changes to estimate" };
  // A DISCOUNT ALONE IS AN EDIT. Gating on the three item lists refused to preview the
  // one shape whose entire effect is the discount, so adding a coupon and nothing else
  // left the rail showing the stale figure with no indication it was stale.
  if (
    changes.length === 0 &&
    adds.length === 0 &&
    removes.length === 0 &&
    !couponCode &&
    !manualDiscount &&
    !removeDiscount
  ) {
    return { ok: false, error: "No changes to estimate" };
  }
  const res = await apiPost(`/v1/businesses/${biz}/subscriptions/${sub}/estimate`, {
    changes,
    ...(adds.length ? { adds } : {}),
    ...(removes.length ? { removes } : {}),
    // `typeof`: an operator's `false` overrides the business rule.
    ...(typeof reset_term === "boolean" ? { reset_term } : {}),
    // The SAME flag the apply sends, so the rail previews what will be booked rather
    // than what would be booked with proration on. `estimateSubBody` gained the field
    // on 2026-08-24; before that the change screen's editable prorate checkbox had a
    // preview that ignored it, and the screen carried three notices apologising for it.
    ...(typeof prorate === "boolean" ? { prorate } : {}),
    // The pair the apply already sent and the preview did not — see `estimateSubBody`.
    ...(couponCode ? { coupon_code: couponCode } : {}),
    ...(manualDiscount ? { manual_discount: manualDiscount } : {}),
    ...(removeDiscount ? { remove_discount: true } : {}),
    ...(changeOption ? { change_option: changeOption } : {}),
    ...(rules?.coupons ? { coupons: rules.coupons } : {}),
    ...(rules?.downgrade_credit ? { downgrade_credit: rules.downgrade_credit } : {}),
  });
  return res.ok
    ? { ok: true, estimate: res.data as ChangeEstimate }
    : { ok: false, error: res.error ?? "We could not get an estimate." };
}

/**
 * Live dry-run of a CANCELLATION for the cancel dialog's outcome rail (no writes).
 *
 * Sends exactly the option set the dialog would submit, so the preview and the
 * confirm cannot disagree. Omitted options resolve from the business cancellation
 * defaults server-side — the same resolution the cancel itself does.
 */
export async function estimateSubscriptionCancelAction(
  biz: string,
  sub: string,
  options: {
    cancel_option?: string;
    cancel_at?: string;
    credit_option_for_current_term_charges?: string;
    unbilled_charges_option?: string;
    account_receivables_handling?: string;
    refundable_credits_handling?: string;
    final_period?: string;
    plan_credits_on_cancel_at_period_end?: string;
  },
): Promise<{ ok: true; estimate: CancelEstimate } | { ok: false; error: string }> {
  await requirePermission("subscriptions:estimate", "manager");
  if (!biz || !sub) return { ok: false, error: "Nothing to estimate" };
  // Empty strings mean "the dialog is not posting this option" — send nothing, so
  // the service resolves the business default rather than reading '' as a value.
  const { plan_credits_on_cancel_at_period_end: creditsOnCancel, ...flat } = options;
  const body: Record<string, unknown> = Object.fromEntries(
    Object.entries(flat).filter(([, v]) => v !== "" && v != null),
  );
  if (creditsOnCancel) body.plan_credits = { on_cancel_at_period_end: creditsOnCancel };
  const res = await apiPost(`/v1/businesses/${biz}/subscriptions/${sub}/cancel_estimate`, body);
  return res.ok
    ? { ok: true, estimate: res.data as CancelEstimate }
    : { ok: false, error: res.error ?? "We could not get an estimate." };
}

/** Business rules one change may override (`POST …/change`). Each is sent only when it differs. */
export interface ChangeRuleOverrides {
  on_charge_failure?: "start_dunning" | "next_renewal";
  coupons?: "keep" | "drop" | "keep_if_valid";
  downgrade_credit?: "credit_balance" | "refund";
  plan_credits?: "full" | "prorated" | "next_window";
  allowances?: "new_window" | "keep_used" | "prorated";
}

export interface ChangePayload extends ChangeRuleOverrides {
  changes: SubscriptionChangeLine[];
  adds: Array<{ price: string; quantity: number; unit_price_minor?: number }>;
  removes: string[]; // subscription item ids
  apply?: { immediately?: boolean; at?: string };
  settings?: {
    auto_collection?: "on" | "off" | "";
    po_number?: string;
    invoice_notes?: string;
    /**
     * Renewals remaining AFTER the current term; `null` clears the cap (renews
     * forever), `0` makes this term the last. `Billing Cycles` on the edit screen's
     * Billing Info. Rides the settings PATCH rather than /change: it is a property of
     * the subscription, not of this edit.
     */
    remaining_billing_cycles?: number | null;
    /** The metadata textarea's raw text; blank clears. Parsed by the action. */
    metadata?: string;
  };
  coupon_code?: string;
  manual_discount?: { type: "percent" | "amount"; value: number; duration: "one_time" | "forever" };
  /** Remove the applied discount; rides `/change` with item work, else its own DELETE first. */
  remove_discount?: boolean;
  trial_end?: string;
  /** POST …/edit_trial_end {immediately:true} — ends the trial today and bills the first term. */
  end_trial_now?: boolean;
  reset_term?: boolean;
  /**
   * Invoicing Options on the change screen — where the proration CHARGE
   * lands: an invoice raised and collected now (true), or `unbilled_charges` folded
   * into the next renewal (false). Rides on POST …/:sub/change only, so it is absent
   * on a scheduled apply (the schedule stores no invoicing option) and on an in-trial
   * change (nothing is prorated). The form sends it EXPLICITLY whenever it applies;
   * the route treats an omitted field as "invoice now".
   */
  invoice_immediately?: boolean;
  /**
   * `prorate`. False suppresses the PRORATED credit and charge — on a term
   * reset the full new-term charge survives and only the unused-time credit is dropped
   * (proration.ts:544-558). Same three exclusions as `invoice_immediately`: it rides
   * POST …/:sub/change only, so it is absent on a scheduled apply and on an in-trial
   * change.
   */
  prorate?: boolean;
  /** From the estimate the operator confirmed: `/change` books those amounts or refuses (409). */
  priced_at?: string;
  quote?: string;
}

/**
 * Apply the change-page line builder as up to three calls, in THIS order:
 *   1. modified existing lines — POST /change (one prorated batch), or POST /schedule
 *      when a future apply date is chosen;
 *   2. removals — DELETE /items/:id (credits unused time);
 *   3. additions — POST /items (prorated per item).
 * Then optional billing-info settings (PATCH), coupon, manual discount and trial end.
 * A refusal keeps the operator on /change with the edit intact; success lands on the detail.
 *
 * ── WHY CHANGES GO FIRST ────────────────────────────────────────────────────────
 * The order was removes → adds → change, and it made a legal edit impossible. An
 * all-yearly edit — plan monthly→yearly plus each add-on onto its yearly price — is
 * refused item by item under that order: `POST …/items` validates the added yearly line
 * against the subscription's cadence, which is STILL MONTHLY because the plan change is
 * queued behind it, so the add comes back "Billing period mismatch" and the edit dies
 * having applied nothing (or worse, having already removed lines). Landing the plan
 * cadence FIRST means every later call is validated against the composition the operator
 * actually asked for.
 *
 * Removes before adds within that: a removal only ever credits, so if an add is going to
 * fail it fails before any new money is charged, and the failure message can name a
 * consistent state.
 *
 * These are separate API calls with no shared transaction, so a mid-sequence failure
 * leaves the earlier steps applied. That is why every failure branch reports what DID
 * land, by name, instead of a bare error.
 */
export async function applySubscriptionChangeAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission(["subscriptions:lifecycle", "subscriptions:manage"], "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const sub = String(formData.get("sub") ?? "").trim();
  const back = subUrl(biz, sub);
  if (!biz || !sub) return actionError("The subscription ID is missing. Reload the page.");

  let payload: ChangePayload;
  try {
    payload = JSON.parse(String(formData.get("payload") ?? "{}")) as ChangePayload;
  } catch {
    return actionError("Invalid change payload");
  }
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const adds = Array.isArray(payload.adds) ? payload.adds : [];
  const removes = Array.isArray(payload.removes) ? payload.removes : [];
  const scheduleAt = payload.apply?.at;
  const hasSettings = payload.settings && Object.keys(payload.settings).length > 0;
  const nothingToDo =
    changes.length === 0 &&
    adds.length === 0 &&
    removes.length === 0 &&
    !hasSettings &&
    !payload.coupon_code &&
    !payload.manual_discount &&
    !payload.remove_discount &&
    !payload.trial_end &&
    !payload.end_trial_now;
  if (nothingToDo) return actionError("Nothing to change");
  // Before any step runs: a bad value must not leave the item change half-applied.
  let metadata: Record<string, unknown> | null | undefined;
  if (payload.settings && "metadata" in payload.settings) {
    const md = checkMetadata(payload.settings.metadata);
    if (!md.ok) return actionError(md.error, { errors: { metadata_text: md.error } });
    metadata = md.value;
  }

  const done: string[] = [];
  /** A proration invoice the change raised and could not collect yet. */
  let unpaidInvoice: string | null = null;
  /** Whether `/change` will run at all — it is what carries the discount. */
  const hasItemWork = changes.length > 0 || adds.length > 0 || removes.length > 0;

  if (scheduleAt) {
    // A DEFERRED composition edit — all three lists, one row.
    //
    // This branch used to refuse `adds`/`removes` outright ("Scheduled changes can only
    // modify existing lines"). The limit was never the engine's: `changeSubscription`
    // has applied all three lists in one transaction since 2026-08-24 and
    // `estimateChange` previewed all three, but POST …/schedule
    // stored `payload.changes` only, so the applier had nothing else to replay. The
    // schedule carries the whole edit as of 2026-08-31 and this guard is gone with it.
    if (!hasItemWork) return actionError("Change, add or remove at least one line to schedule");
    const res = await apiPost(`/v1/businesses/${biz}/subscriptions/${sub}/schedule`, {
      type: "change",
      effective_at: assertUtc(scheduleAt, "apply.at"),
      ...(changes.length > 0 ? { changes } : {}),
      ...(adds.length > 0 ? { adds } : {}),
      ...(removes.length > 0 ? { removes } : {}),
    });
    if (!res.ok) return refused(res, `We could not schedule the item change: ${res.error}`);
    // Describe the EDIT that was deferred, same wording as the immediate branch below —
    // "scheduled 1 change(s)" said nothing about the line the operator removed.
    const parts = [
      changes.length > 0 ? `${changes.length} line(s) changed` : null,
      removes.length > 0 ? `${removes.length} removed` : null,
      adds.length > 0 ? `${adds.length} added` : null,
    ].filter(Boolean);
    done.push(
      `scheduled ${parts.join(", ")} for ${fmtDateTime(scheduleAt, await businessTz(biz))}`,
    );
  } else {
    // ONE call, ONE transaction, ONE invoice.
    //
    // `/change` used to accept only `changes`, so a composition edit went out as
    // `/change` + `DELETE …/items/:id`×N + `POST …/items`×N, and every money-moving step
    // raised its own document. Measured on a real edit (plan monthly→yearly, two lines
    // removed, one added): FIVE documents — and the first invoice billed a full YEAR for
    // the two lines the same edit removed, which the next two steps credited straight
    // back, purely because of the order the requests went out in. Worse, the add's own
    // ₹110,920 invoice was over the customer's ₹97,572 per-debit mandate ceiling on its
    // own, so the bank refused a charge that was collectable as a single document.
    //
    // The route takes all three lists now (2026-08-24) and applies them in one
    // transaction, folding every line onto the same invoice / credit note. Verified:
    // the same edit that produced 5 documents produces 1 invoice + 1 credit note, for
    // the identical net money.
    if (hasItemWork) {
      const res = await apiPost(`/v1/businesses/${biz}/subscriptions/${sub}/change`, {
        // Sent WITH the edit so the proration is discounted — see the note further down.
        ...(payload.coupon_code ? { coupon_code: payload.coupon_code } : {}),
        ...(payload.manual_discount ? { manual_discount: payload.manual_discount } : {}),
        ...(payload.remove_discount ? { remove_discount: true } : {}),
        ...(changes.length > 0 ? { changes } : {}),
        ...(adds.length > 0 ? { adds } : {}),
        ...(removes.length > 0 ? { removes } : {}),
        // The operator picked "Immediately"; without it the business timing rule decides.
        timing: "now",
        ...(typeof payload.reset_term === "boolean" ? { reset_term: payload.reset_term } : {}),
        // `typeof`, not truthiness, for both of these: `false` IS the interesting value.
        // Dropping it would silently invoice a change the operator chose to defer, or
        // prorate one they chose not to.
        ...(typeof payload.invoice_immediately === "boolean"
          ? { invoice_immediately: payload.invoice_immediately }
          : {}),
        ...(typeof payload.prorate === "boolean" ? { prorate: payload.prorate } : {}),
        // With the items, in the same transaction: a metadata value the business's rules refuse
        // then applies nothing, instead of leaving the items changed and the metadata not.
        ...(metadata !== undefined ? { metadata } : {}),
        ...(payload.priced_at && payload.quote
          ? { priced_at: payload.priced_at, quote: payload.quote }
          : {}),
        ...(payload.on_charge_failure ? { on_charge_failure: payload.on_charge_failure } : {}),
        ...(payload.coupons ? { coupons: payload.coupons } : {}),
        ...(payload.downgrade_credit ? { downgrade_credit: payload.downgrade_credit } : {}),
        ...(payload.plan_credits ? { plan_credits: payload.plan_credits } : {}),
        ...(payload.allowances ? { allowances: payload.allowances } : {}),
      });
      if (!res.ok) {
        revalidatePath(back);
        // The amounts moved since the estimate: the form re-checks it.
        if (res.status === 409 && res.param === "quote")
          return actionError(QUOTE_MOVED, { code: "conflict", errors: { quote: QUOTE_MOVED } });
        // One transaction: it all landed or none of it did. There is no partial state to
        // describe any more, which is the point — the old sequence could leave a
        // subscription half-edited, with an invoice raised for a step that then failed.
        return refused(res, `We could not apply the change, so nothing changed: ${res.error}`);
      }
      const data = res.data as
        | {
            proration_invoice?: { id?: string; status?: string } | null;
            credit_note?: { id?: string } | null;
            unbilled_charges?: Array<{ id?: string }> | null;
          }
        | undefined;
      // Describe the EDIT, not the call: an operator who removed a line and added
      // another wants to read that back, not "item change applied".
      const parts = [
        changes.length > 0 ? `${changes.length} line(s) changed` : null,
        removes.length > 0 ? `${removes.length} removed` : null,
        adds.length > 0 ? `${adds.length} added` : null,
      ].filter(Boolean);
      // Upgrade → proration invoice; downgrade → credit note; deferred → unbilled charges.
      if (data?.proration_invoice?.id && data.proration_invoice.status === "payment_due")
        unpaidInvoice = data.proration_invoice.id;
      const outcome = data?.proration_invoice?.id
        ? `proration invoice ${data.proration_invoice.id}`
        : data?.unbilled_charges?.length
          ? `${data.unbilled_charges.length} unbilled charge(s) queued for the next renewal`
          : data?.credit_note?.id
            ? `credit note ${data.credit_note.id} issued`
            : "no money moved";
      done.push(`${parts.join(", ")}: ${outcome}`);
    }
  }

  const warnings: string[] = [];

  // Metadata already went with `/change` when items moved; only the other settings remain.
  const metadataWithChange = !scheduleAt && hasItemWork && metadata !== undefined;
  const settingsLeft =
    hasSettings &&
    Object.keys(payload.settings!).some((k) => !(metadataWithChange && k === "metadata"));
  if (metadataWithChange) done.push("metadata updated");

  if (settingsLeft) {
    const s = payload.settings!;
    const res = await apiPatch(`/v1/businesses/${biz}/subscriptions/${sub}`, {
      ...("auto_collection" in s
        ? { auto_collection: s.auto_collection === "" ? null : s.auto_collection }
        : {}),
      ...("po_number" in s ? { po_number: s.po_number === "" ? null : s.po_number } : {}),
      ...("invoice_notes" in s
        ? { invoice_notes: s.invoice_notes === "" ? null : s.invoice_notes }
        : {}),
      // `in`, not truthiness: `null` CLEARS the cap (renews forever) and `0` makes the
      // current term the last — both are real instructions and both are falsy.
      ...("remaining_billing_cycles" in s
        ? { remaining_billing_cycles: s.remaining_billing_cycles ?? null }
        : {}),
      ...(metadata !== undefined && !metadataWithChange ? { metadata } : {}),
    });
    if (!res.ok) {
      revalidatePath(back);
      if (done.length === 0)
        return refused(
          res,
          `We could not change the billing info: ${res.error}. Nothing else was applied.`,
        );
      // The item change already landed, so this is a success with a caveat.
      return {
        ...actionOk(
          `We could not change the billing info: ${res.error}. Applied: ${done.join("; ")}.`,
          back,
        ),
        warning: true,
      };
    }
    done.push(
      Object.keys(s).length === 1 && "remaining_billing_cycles" in s
        ? "billing cycles updated"
        : Object.keys(s).length === 1 && "metadata" in s
          ? "metadata updated"
          : "billing info updated",
    );
  }

  // ── THE DISCOUNT RIDES ON /change NOW, NOT A CALL AFTER IT ───────────────────
  // These two used to post here, AFTER `/change` had already raised and collected the
  // proration invoice — so the coupon could not discount it and the customer was billed
  // the list-price proration. The proration MUST carry the discount.
  //
  // `/change` takes both fields as of 2026-08-30 and applies them inside its own
  // transaction, before billing — so the discount and the change now commit or roll back
  // together, instead of leaving a discount on a subscription whose change was refused.
  // Reordering these two calls would have fixed the arithmetic and re-opened that window.
  //
  // A discount with NO item change still needs a call: `/change` refuses an empty edit,
  // so that shape keeps its own endpoint below.
  const discountRodeOnChange = hasItemWork && !scheduleAt;
  // Removal before any replacement: the engine allows one discount at a time.
  if (payload.remove_discount && !discountRodeOnChange) {
    const res = await apiWrite(`/v1/businesses/${biz}/subscriptions/${sub}/discount`, {}, "DELETE");
    if (res.ok) done.push("discount removed");
    else warnings.push(`could not remove the discount: ${res.error}`);
  }
  if (payload.coupon_code && !discountRodeOnChange) {
    const res = await apiPost(`/v1/businesses/${biz}/subscriptions/${sub}/discount`, {
      code: payload.coupon_code,
    });
    if (res.ok) done.push(`coupon ${payload.coupon_code} applied`);
    else warnings.push(`could not apply the coupon: ${res.error}`);
  }

  if (payload.manual_discount && !discountRodeOnChange) {
    const res = await apiPost(
      `/v1/businesses/${biz}/subscriptions/${sub}/manual_discount`,
      payload.manual_discount,
    );
    if (res.ok) done.push("manual discount applied");
    else warnings.push(`could not apply the manual discount: ${res.error}`);
  }

  if (payload.trial_end) {
    const res = await apiPost(`/v1/businesses/${biz}/subscriptions/${sub}/edit_trial_end`, {
      trial_end: assertUtc(payload.trial_end, "trial_end"),
    });
    if (res.ok) done.push("trial end changed");
    else warnings.push(`could not change the trial end: ${res.error}`);
  }

  if (payload.end_trial_now) {
    const res = await apiPost(`/v1/businesses/${biz}/subscriptions/${sub}/edit_trial_end`, {
      immediately: true,
    });
    if (res.ok) done.push("trial ended and first term invoiced");
    else warnings.push(`could not end the trial: ${res.error}`);
  }

  revalidatePath(back);
  const unpaid = unpaidInvoice ? `. Invoice ${unpaidInvoice} is not paid yet` : "";
  const msg = `Subscription updated (${done.length} step(s))${unpaid}${warnings.length ? `. Warnings: ${warnings.join("; ")}` : ""}`;
  return { ...actionOk(msg, back), ...(warnings.length ? { warning: true } : {}) };
}

// ─── Reactivation (edit a cancelled subscription) ────────────────────────────

export interface ReactivationPayload {
  items: Array<{ price: string; quantity: number; unit_price_minor?: number }>;
  billing_cycles?: number | null;
  trial_end?: string;
  charges_handling?: "invoice_immediately" | "add_to_unbilled_charges";
  /** Sent only when the screen offered the choice; omitted = continue when eligible. */
  term?: "continue" | "new";
  /** What a failed charge does for this reactivation; omitted = the business rule. */
  on_charge_failure?: "refuse" | "dun";
  /** Applied before the fresh term is invoiced, so its first invoice is discounted. */
  coupon_code?: string;
  manual_discount?: ReactivationManualDiscount;
  /** The Billing section's edits; saved before reactivating, so the first charge honours them. */
  settings?: {
    auto_collection?: "on" | "off" | "";
    po_number?: string;
    invoice_notes?: string;
  };
}

/** Same shape `/change` takes: percent 1–100, or an amount in minor units. */
export interface ReactivationManualDiscount {
  type: "percent" | "amount";
  value: number;
  duration?: "one_time" | "forever";
}

/**
 * Live dry-run of a REACTIVATION for the confirm dialog (no writes).
 *
 * The dialog had no estimate at all until this existed: it summed its own line items and
 * printed the result as "Chargeable immediately" (#56), so for an Indian customer it named
 * the pre-tax subtotal — ₹10,998.00 against an invoice of ₹12,977.64 which, after that
 * customer's own ₹9,661.13 of refundable credit, collected ₹3,316.51.
 *
 * ⚠ NOT `…/subscriptions/:sub/estimate`. That one is `estimateChange` and prorates against
 * a CURRENT TERM; a cancelled subscription has none, so it 400s. Reactivation is a fresh
 * full term, which is `reactivate_estimate`.
 *
 * Only the money-bearing half of the reactivate payload is sent: `billing_cycles` caps the
 * SECOND cycle onward and `charges_handling` decides whether this composition is invoiced or
 * parked as an unbilled charge — neither changes the composition itself, and the endpoint
 * does not accept them. `trial_end` DOES change it (nothing is collected today), so it goes.
 */
export async function estimateSubscriptionReactivationAction(
  biz: string,
  sub: string,
  items: Array<{ price: string; quantity: number; unit_price_minor?: number }>,
  trialEnd?: string,
  couponCode?: string,
  manualDiscount?: ReactivationManualDiscount,
  term?: "continue" | "new",
  onChargeFailure?: "refuse" | "dun",
): Promise<{ ok: true; estimate: ChangeEstimate } | { ok: false; error: string }> {
  await requirePermission("subscriptions:manage", "manager");
  if (!biz || !sub) return { ok: false, error: "Nothing to estimate" };
  if (items.length === 0) return { ok: false, error: "Add at least one line to preview" };
  const res = await apiPost(`/v1/businesses/${biz}/subscriptions/${sub}/reactivate_estimate`, {
    items,
    ...(trialEnd ? { trial_end: assertUtc(trialEnd, "trial_end") } : {}),
    ...(couponCode ? { coupon_code: couponCode } : {}),
    ...(manualDiscount ? { manual_discount: manualDiscount } : {}),
    ...(term ? { term } : {}),
    ...(onChargeFailure ? { on_charge_failure: onChargeFailure } : {}),
  });
  return res.ok
    ? { ok: true, estimate: res.data as ChangeEstimate }
    : { ok: false, error: res.error ?? "We could not get an estimate." };
}

/**
 * Edit a CANCELLED subscription = reactivation: a fresh term
 * starts today with the given item set. POSTs the full desired line set to
 * /reactivate (which rebuilds items + bills the new term per the invoicing
 * option). A refusal stays on /change; success lands on the detail.
 */
export async function applySubscriptionReactivationAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("subscriptions:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const sub = String(formData.get("sub") ?? "").trim();
  const back = subUrl(biz, sub);
  if (!biz || !sub) return actionError("The subscription ID is missing. Reload the page.");

  let payload: ReactivationPayload;
  try {
    payload = JSON.parse(String(formData.get("payload") ?? "{}")) as ReactivationPayload;
  } catch {
    return actionError("Invalid reactivation payload");
  }
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length === 0) return actionError("Add at least one line before reactivating");

  // Reactivation reads auto-collection off the stored subscription to decide whether to charge,
  // so the Billing edits must land first.
  const s = payload.settings;
  if (s && Object.keys(s).length > 0) {
    const set = await apiPatch(`/v1/businesses/${biz}/subscriptions/${sub}`, {
      ...("auto_collection" in s
        ? { auto_collection: s.auto_collection === "" ? null : s.auto_collection }
        : {}),
      ...("po_number" in s ? { po_number: s.po_number === "" ? null : s.po_number } : {}),
      ...("invoice_notes" in s
        ? { invoice_notes: s.invoice_notes === "" ? null : s.invoice_notes }
        : {}),
    });
    if (!set.ok)
      return refused(
        set,
        `We could not change the billing info: ${set.error}. The subscription is not reactivated.`,
      );
  }

  const res = await apiPost(`/v1/businesses/${biz}/subscriptions/${sub}/reactivate`, {
    items,
    ...(payload.billing_cycles != null ? { billing_cycles: payload.billing_cycles } : {}),
    ...(payload.trial_end ? { trial_end: assertUtc(payload.trial_end, "trial_end") } : {}),
    ...(payload.charges_handling ? { charges_handling: payload.charges_handling } : {}),
    ...(payload.term ? { term: payload.term } : {}),
    ...(payload.on_charge_failure ? { on_charge_failure: payload.on_charge_failure } : {}),
    ...(payload.coupon_code ? { coupon_code: payload.coupon_code } : {}),
    ...(payload.manual_discount ? { manual_discount: payload.manual_discount } : {}),
  });
  revalidatePath(back);
  // The form's banner title already says "We could not reactivate the subscription", and the
  // engine's refusal names the outcome itself — a prefix here printed it twice.
  if (!res.ok) return refused(res, res.error ?? "We could not reactivate the subscription.");
  const data = res.data as
    | { latest_invoice?: { id?: string } | null; payment_error?: { code?: string } }
    | undefined;
  const inv = data?.latest_invoice;
  // `on_charge_failure: dun`: reactivated, but the invoice is still open.
  if (data?.payment_error && inv?.id)
    return actionOk(
      `Subscription reactivated. The payment failed (${data.payment_error.code ?? "declined"}). Dunning will collect invoice ${inv.id}.`,
      back,
    );
  return actionOk(
    inv?.id ? `Subscription reactivated. Invoice: ${inv.id}` : "Subscription reactivated",
    back,
  );
}

// ─── Richer scheduled change: cancel supports at-date via schedule ───────────

/** Reactivate wrapper returning ActionResult (frozen action redirects instead). */
export async function reactivateSubscriptionResultAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("subscriptions:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const sub = String(formData.get("sub") ?? "").trim();
  if (!biz || !sub) return actionError("The subscription ID is missing. Reload the page.");
  const res = await apiWrite(`/v1/businesses/${biz}/subscriptions/${sub}/reactivate`, {}, "POST");
  revalidatePath(subUrl(biz, sub));
  if (!res.ok) return fail(res, "We could not reactivate the subscription.");
  const inv = (res.data as { latest_invoice?: { id?: string } } | undefined)?.latest_invoice;
  return actionOk(
    inv?.id ? `Subscription reactivated. Invoice: ${inv.id}` : "Subscription reactivated",
  );
}

// ─── Ship to ─────────────────────────────────────────────────────────────────

/** `shipping_address_id` "" → null: the subscription follows the customer's default. */
export async function setSubscriptionShippingAddressAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("subscriptions:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const sub = String(formData.get("sub") ?? "").trim();
  if (!biz || !sub)
    return actionError("The business or subscription ID is missing. Reload the page.");
  const addr = String(formData.get("shipping_address_id") ?? "").trim();
  const res = await apiPatch(`/v1/businesses/${biz}/subscriptions/${sub}`, {
    shipping_address_id: addr || null,
  });
  revalidatePath(subUrl(biz, sub));
  return res.ok
    ? actionOk("Shipping address changed.")
    : actionError(res.error ?? "We could not change the shipping address.");
}

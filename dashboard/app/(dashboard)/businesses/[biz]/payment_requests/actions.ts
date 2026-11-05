"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionError, actionOk, type ActionResult } from "@/lib/action-result";
import { money } from "@/lib/format";
import { isZoneQualified } from "@/lib/tz";
import {
  cancelPaymentRequest,
  chargePaymentRequest,
  createPaymentRequest,
  recordPaymentRequestPayment,
  sendPaymentRequest,
  type PaymentRequest,
} from "@/lib/api/payment-requests";

// Payment requests: the same `ops` permission as Collect payment on a customer.

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const RECORD_METHODS = ["cash", "cheque", "bank_transfer", "other"] as const;

function revalidate(biz: string, preq?: string, cus?: string) {
  revalidatePath(`/businesses/${biz}/payment_requests`);
  if (preq) revalidatePath(`/businesses/${biz}/payment_requests/${preq}`);
  if (cus) revalidatePath(`/businesses/${biz}/customers/${cus}`);
}

const declineText = (r: PaymentRequest) =>
  r.last_payment_error?.message ?? r.last_payment_error?.code ?? "The gateway declined the charge.";

export async function createPaymentRequestAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("payments:collect", "ops");
  const biz = str(fd, "biz");
  const cus = str(fd, "cus");
  if (!biz || !cus) return actionError("The business or customer ID is missing. Reload the page.");
  const invoices = fd
    .getAll("invoice_ids")
    .map((v) => String(v).trim())
    .filter(Boolean);
  if (invoices.length === 0) return actionError("Select at least one invoice.");
  if (invoices.length > 50) return actionError("Select 50 invoices or fewer.");
  const mode = str(fd, "mode");
  if (mode !== "charge" && mode !== "link") return actionError("Select how to request payment.");
  const pm = str(fd, "payment_method");
  const email = str(fd, "email");
  if (mode === "link" && email && !EMAIL_RE.test(email))
    return actionError("Correct the highlighted fields.", {
      errors: { email: "Enter a valid email address." },
    });

  const res = await createPaymentRequest(biz, cus, {
    invoices,
    mode,
    ...(mode === "charge" && pm ? { payment_method: pm } : {}),
    ...(mode === "link" && email ? { email } : {}),
  });
  revalidate(biz, undefined, cus);
  if (!res.ok) return actionError(res.error ?? "We could not create the payment request.");
  const r = res.data as PaymentRequest | undefined;
  const to = r ? `/businesses/${biz}/payment_requests/${r.id}` : undefined;
  if (mode === "link") return actionOk("Payment request sent.", to);
  if (!r || r.status === "paid") return actionOk("Payment request created and paid.", to);
  if (r.status === "processing")
    return actionOk("Payment request created. The payment is in progress.", to);
  // The request exists either way; a decline leaves it open with the error on it.
  if (r.last_payment_error)
    return {
      ok: true,
      warning: true,
      message: `Payment request created. The charge failed: ${declineText(r)} The request stays open.`,
      ...(to ? { redirectTo: to } : {}),
    };
  return actionOk("Payment request created.", to);
}

export async function chargePaymentRequestAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("payments:collect", "ops");
  const biz = str(fd, "biz");
  const preq = str(fd, "preq");
  if (!biz || !preq) return actionError("The business or request ID is missing. Reload the page.");
  const pm = str(fd, "payment_method");
  const res = await chargePaymentRequest(biz, preq, pm ? { payment_method: pm } : {});
  revalidate(biz, preq, str(fd, "cus") || undefined);
  if (!res.ok) return actionError(res.error ?? "We could not charge the payment request.");
  const r = res.data as PaymentRequest | undefined;
  if (!r || r.status === "paid") return actionOk("Payment request paid.");
  if (r.status === "processing")
    return actionOk("Payment started. We update the request when the payment settles.");
  // A decline is a 2xx: keep the dialog open so that another method can be selected.
  return actionError(
    `We could not charge the payment request. ${declineText(r)} Select a different payment method, or send the request again.`,
  );
}

export async function recordPaymentRequestPaymentAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("payments:collect", "ops");
  const biz = str(fd, "biz");
  const preq = str(fd, "preq");
  if (!biz || !preq) return actionError("The business or request ID is missing. Reload the page.");
  // MoneyInput posts integer MINOR units.
  const rawAmount = str(fd, "amount_minor");
  const amount = Number(rawAmount);
  if (!rawAmount || !Number.isSafeInteger(amount) || amount <= 0)
    return actionError("Correct the highlighted fields.", {
      errors: { amount_minor: "Enter an amount that is more than zero." },
    });
  const method = str(fd, "method");
  if (method && !(RECORD_METHODS as readonly string[]).includes(method))
    return actionError("Select a payment method.");
  const reference = str(fd, "reference");
  if (reference.length > 200)
    return actionError("Correct the highlighted fields.", {
      errors: { reference: "Use 200 characters or fewer." },
    });
  // DateTimeField posts a UTC instant; the API takes unix seconds.
  const rawDate = str(fd, "date");
  let date: number | undefined;
  if (rawDate) {
    if (!isZoneQualified(rawDate))
      return actionError("Correct the highlighted fields.", {
        errors: { date: "Select the date with the date field." },
      });
    date = Math.floor(Date.parse(rawDate) / 1000);
  }

  const res = await recordPaymentRequestPayment(biz, preq, {
    amount_minor: amount,
    ...(method ? { method: method as (typeof RECORD_METHODS)[number] } : {}),
    ...(reference ? { reference } : {}),
    ...(date ? { date } : {}),
  });
  revalidate(biz, preq, str(fd, "cus") || undefined);
  if (!res.ok) return actionError(res.error ?? "We could not record the payment.");
  const r = res.data as PaymentRequest | undefined;
  return actionOk(
    r && r.status !== "paid" && r.amount_minor > 0
      ? `Payment recorded. ${money(r.amount_minor, r.currency)} is still due.`
      : "Payment recorded.",
  );
}

export async function cancelPaymentRequestAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("payments:collect", "ops");
  const biz = str(fd, "biz");
  const preq = str(fd, "preq");
  if (!biz || !preq) return actionError("The business or request ID is missing. Reload the page.");
  const reason = str(fd, "reason");
  if (reason.length > 200)
    return actionError("Correct the highlighted fields.", {
      errors: { reason: "Use 200 characters or fewer." },
    });
  const res = await cancelPaymentRequest(biz, preq, reason ? { reason } : {});
  revalidate(biz, preq, str(fd, "cus") || undefined);
  // 409 while a payment is in progress: the message says so.
  if (!res.ok) return actionError(res.error ?? "We could not cancel the payment request.");
  return actionOk("Payment request canceled.");
}

export async function sendPaymentRequestAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("payments:collect", "ops");
  const biz = str(fd, "biz");
  const preq = str(fd, "preq");
  if (!biz || !preq) return actionError("The business or request ID is missing. Reload the page.");
  const to = str(fd, "to");
  const note = str(fd, "note");
  if (to && !EMAIL_RE.test(to))
    return actionError("Correct the highlighted fields.", {
      errors: { to: "Enter a valid email address." },
    });
  if (note.length > 2000)
    return actionError("Correct the highlighted fields.", {
      errors: { note: "Use 2,000 characters or fewer." },
    });
  const res = await sendPaymentRequest(biz, preq, {
    ...(to ? { to } : {}),
    ...(note ? { note } : {}),
  });
  revalidate(biz, preq);
  if (!res.ok) return actionError(res.error ?? "We could not send the payment request.");
  return actionOk("Payment request sent.");
}

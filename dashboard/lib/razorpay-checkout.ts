/**
 * RazorPay embedded Checkout, for the buyer surfaces (portal add-card, hosted
 * checkout, and the "Pay now" / first-charge authentication challenge). Card and UPI
 * mandates — and a 3DS challenge on a charge — are authorized in their modal, which we
 * open over our own page.
 *
 * ⚠️ This is NOT every rail. The netbanking e-mandate never reaches this file:
 * `checkout/embedded` offers no methods for that rail, so the adapter registers it
 * through a hosted auth link and answers `mode: 'redirect'` instead — the caller
 * navigates away and the return leg completes it, exactly like a PayPal approval.
 * See the rail table and `createEmandateAuthLink` in `src/providers/razorpay.ts`.
 *
 * The card fields live inside RazorPay's iframe — the PAN never reaches us
 * (PCI SAQ-A), exactly like Stripe Elements on the other branch.
 *
 * What comes back is a PAYMENT id (`pay_…`), not the `token_…` the vault stores;
 * the adapter resolves one to the other server-side (see
 * `src/providers/razorpay.ts:tokenIdForMandatePayment`).
 */

/** `checkout` block of a vault_setup response (mode: 'checkout'). */
export interface RazorpayCheckoutDescriptor {
  provider: string;
  keyId: string;
  orderId: string;
  customerId: string;
  recurring: boolean;
  /** Rail the auth order is already bound to (card | upi | emandate). */
  method?: string;
}

export type RazorpayResult =
  | { status: "authorized"; paymentId: string }
  | { status: "dismissed" }
  | { status: "failed"; message: string };

interface RazorpayInstance {
  open(): void;
  on(event: string, handler: (payload: { error?: { description?: string } }) => void): void;
}
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

const SCRIPT_SRC = "https://checkout.razorpay.com/v1/checkout.js";
let loading: Promise<void> | null = null;

function loadCheckoutScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = SCRIPT_SRC;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      loading = null; // let a later attempt retry the load
      reject(new Error("We could not connect to RazorPay. Check your connection. Then try again."));
    };
    document.head.appendChild(el);
  });
  return loading;
}

/**
 * The caption RazorPay prints under the business name for a VAULT SETUP, per rail.
 *
 * Exported so the two setup call sites (portal add-card, hosted checkout) say the same
 * honest thing without a third copy of the string. A charge — "Pay now", a first-charge
 * 3DS challenge — is not a setup and must pass its own caption instead.
 */
export function vaultSetupDescription(method?: string): string {
  if (method === "upi") return "Approve UPI Autopay for future payments";
  if (method === "emandate") return "Approve auto-debit for future payments";
  return "Save this card for future payments";
}

export async function openRazorpayCheckout(
  descriptor: RazorpayCheckoutDescriptor,
  context: {
    businessName: string;
    /**
     * The line RazorPay prints under the business name, inside their sheet.
     *
     * OPTIONAL, and omitted means RazorPay prints nothing — deliberately, because the
     * only wrong answer here is a confident one. This file used to hardcode "Save this
     * card for future payments" for every caller, so a buyer clearing an invoice through
     * "Pay now" read a caption about saving a card at the moment they paid. Setup callers
     * pass `vaultSetupDescription(...)`; a charge passes its own.
     */
    description?: string;
    prefill?: { name?: string | null; email?: string | null; contact?: string | null };
  },
): Promise<RazorpayResult> {
  await loadCheckoutScript();
  const Razorpay = window.Razorpay;
  if (!Razorpay) return { status: "failed", message: "We could not start RazorPay Checkout." };

  return new Promise<RazorpayResult>((resolve) => {
    let settled = false;
    const done = (r: RazorpayResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    /**
     * The last refusal RazorPay reported, HELD rather than resolved.
     *
     * `payment.failed` is not the end of the sheet. We pass no `retry: { enabled: false }`,
     * so RazorPay keeps its modal open on a failure and offers the buyer another go —
     * which is the right behaviour and the reason it is left on. Resolving the promise
     * there made the retry unreachable: a buyer whose second attempt SUCCEEDED hit a
     * `handler` whose `done()` was already a no-op, so the authorization never reached our
     * code and the caller had, one failure earlier, thrown away the setup stash it needed.
     * That is the mechanism behind "it succeeds inside the sheet, nothing happens, only a
     * manual refresh shows it" (reported 2026-08-28; the refresh works because
     * `harvestSetupIntent` vaulted it server-side).
     *
     * So a failure only records its reason. The sheet decides when it is over — via
     * `handler` (a later attempt succeeded) or `ondismiss` (the buyer closed it) — and the
     * dismissal reports this message when there is one, so a genuine failure still reads
     * as a failure rather than as a shrug.
     */
    let lastFailure: string | null = null;
    const rzp = new Razorpay({
      key: descriptor.keyId,
      order_id: descriptor.orderId,
      customer_id: descriptor.customerId,
      // Registers a mandate instead of a one-off charge. Without it RazorPay
      // authorizes the small auth amount and mints NO recurring token — which
      // reads as a success that vaulted nothing.
      ...(descriptor.recurring ? { recurring: 1 } : {}),
      name: context.businessName,
      ...(context.description ? { description: context.description } : {}),
      // The rail is fixed by the auth order server-side, so Checkout offers only
      // what that order allows — we deliberately don't re-specify it here.
      prefill: {
        ...(context.prefill?.name ? { name: context.prefill.name } : {}),
        ...(context.prefill?.email ? { email: context.prefill.email } : {}),
        ...(context.prefill?.contact ? { contact: context.prefill.contact } : {}),
      },
      handler: (response: { razorpay_payment_id?: string }) =>
        response.razorpay_payment_id
          ? done({ status: "authorized", paymentId: response.razorpay_payment_id })
          : done({ status: "failed", message: "RazorPay returned no payment reference" }),
      // The sheet closed. That is the ONLY terminal signal short of a success, and it
      // carries the last refusal when there was one — otherwise the buyer simply left.
      modal: {
        ondismiss: () =>
          done(lastFailure ? { status: "failed", message: lastFailure } : { status: "dismissed" }),
      },
    });
    rzp.on("payment.failed", (e) => {
      lastFailure = e?.error?.description ?? "We could not authorize the card.";
    });
    rzp.open();
  });
}

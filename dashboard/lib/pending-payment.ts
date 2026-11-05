/**
 * A redirect-mode PAYMENT challenge on the customer portal — the money-side twin of
 * `pending-vault-setup.ts`.
 *
 * "Pay now" mints a payment intent and, when the gateway answers `mode: 'redirect'`
 * (a PayPal approval, a bank auth link), sends the buyer off-site. Leg 2 re-posts
 * `portal/v1/invoices/:inv/collect` carrying that intent so it is consumed against the
 * invoice — and it can only do that if it still knows WHICH intent and WHICH invoice.
 * Before this existed the portal sent `return_url: …?pay=return` and nothing on the
 * portal read it: the buyer came back, no leg 2 ran, and the payment settled only
 * because `harvestInvoiceIntent` picks the same intent up from the webhook. That made
 * the redirect leg decorative and left a buyer staring at an unchanged invoice whenever
 * the webhook was slow.
 *
 * ── WHY THIS IS NOT `PendingVaultSetup`, AND NOT THE CHECKOUT'S COPY EITHER ──────
 * Three redirect legs exist on the buyer surfaces and they carry different payloads,
 * so one shape would be a union pretending to be a type:
 *   - vault setup (both surfaces) — a setup token + gateway account to exchange;
 *   - checkout first-charge — the whole `/complete` body, because leg 2 re-posts it
 *     verbatim (its `PendingPaymentChallenge` is local to `checkout-flow.tsx`);
 *   - THIS — an invoice id and an intent, because leg 2 is `(invoice, intent)`.
 * What they share is the sessionStorage discipline below, not the payload.
 *
 * sessionStorage is per-tab and per-origin: it survives a top-level hop out and back
 * and dies with the tab. Keyed on the customer's PUBLIC id — never the session token —
 * so two buyers sharing a browser cannot read each other's, and reading the key
 * discloses nothing. Same rule `pending-vault-setup.ts` records.
 */
import { readPaymentReturn } from "./return-params";

export interface PendingPayment {
  /** `inv_…` the intent must be consumed against. */
  invoice: string;
  /** `pi_…` the buyer is away authorizing. */
  paymentIntent: string;
}

const storageKey = (scope: string) => `tmb:pending-payment:${scope}`;

export function savePendingPayment(scope: string, pending: PendingPayment): void {
  try {
    sessionStorage.setItem(storageKey(scope), JSON.stringify(pending));
  } catch {
    /* storage blocked — the return leg reports an orphan rather than guessing */
  }
}

export function readPendingPayment(scope: string): PendingPayment | null {
  try {
    const raw = sessionStorage.getItem(storageKey(scope));
    return raw ? (JSON.parse(raw) as PendingPayment) : null;
  } catch {
    return null;
  }
}

export function clearPendingPayment(scope: string): void {
  try {
    sessionStorage.removeItem(storageKey(scope));
  } catch {
    /* nothing to clear */
  }
}

/**
 * An invoice the buyer just approved a payment for. Its "Pay now" stays hidden while the
 * server catches up: the gateway's webhook can be mid-capture, with no payment row yet,
 * when the list re-renders. Bounded, so a capture the gateway later refuses is payable
 * again from the server's own state.
 */
const processingKey = (scope: string) => `tmb:payment-processing:${scope}`;
const PROCESSING_HOLD_MS = 2 * 60_000;
export const PAYMENT_PROCESSING_EVENT = "tmb:payment-processing";

function readProcessing(scope: string): Record<string, number> {
  try {
    return JSON.parse(sessionStorage.getItem(processingKey(scope)) ?? "{}") as Record<
      string,
      number
    >;
  } catch {
    return {};
  }
}

export function markPaymentProcessing(scope: string, invoice: string, on = true): void {
  try {
    const all = readProcessing(scope);
    if (on) all[invoice] = Date.now() + PROCESSING_HOLD_MS;
    else delete all[invoice];
    sessionStorage.setItem(processingKey(scope), JSON.stringify(all));
  } catch {
    /* storage blocked — the server's own state still hides the button once it lands */
  }
  window.dispatchEvent(new Event(PAYMENT_PROCESSING_EVENT));
}

/** Milliseconds the hold has left for this invoice; 0 when there is none. */
export function paymentProcessingLeft(scope: string, invoice: string): number {
  return Math.max(0, (readProcessing(scope)[invoice] ?? 0) - Date.now());
}

/**
 * Read the payment return-leg params, then strip them so a reload cannot re-post leg 2.
 *
 * ⚠️ Matches `?pay=` ONLY, and that is load-bearing rather than tidy. `consumeSetupReturn`
 * in `pending-vault-setup.ts` fires on a bare `razorpay_payment_id` / `approval_token_id`
 * with no `?setup=` at all — RazorPay echoes the former when 3DS redirects the main
 * window, and a PAYMENT redirect carries it just as a vault one does. Both return
 * components mount on the portal page, so without a discriminator the vault leg would eat
 * a payment return and try to exchange a payment id for an instrument. The guard added to
 * `consumeSetupReturn` (it now stands down when `?pay=` is present) is the other half of
 * this pair; neither is safe alone.
 */
export function consumePaymentReturn(cleanPath: string): "return" | "cancel" | null {
  const pay = readPaymentReturn(window.location.search);
  if (!pay) return null;
  window.history.replaceState({}, "", cleanPath);
  return pay;
}

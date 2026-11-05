/**
 * Redirect-mode vault setups (a PayPal wallet approval) send the buyer off-site,
 * so the two things completion needs — the setup token we just created and the
 * gateway account the buyer picked — have to survive the round trip.
 *
 * sessionStorage is per-tab and per-origin: it outlives the hop out to the
 * provider and back (a top-level navigation in the same tab) and is gone when the
 * tab closes. If it's unavailable (private mode, storage blocked) the return leg
 * falls back to the `approval_token_id` PayPal echoes on the return URL.
 *
 * Shared by both buyer surfaces — the portal (add a payment method) and hosted
 * checkout (pay for a subscription).
 *
 * KEYED ON A NON-SECRET SCOPE. It used to be keyed on the surface plus the session
 * TOKEN, which put a live credential into sessionStorage for the length of a PayPal
 * round trip — reachable by any script on the page, for no benefit. The scope is now
 * the customer's or checkout session's PUBLIC id: it distinguishes two buyers sharing
 * a browser, which is all this key was ever doing, and discloses nothing if read.
 */
import { readSetupReturn } from "./return-params";

export interface PendingVaultSetup {
  /** Provider setup token to exchange for a vaulted method once approved. */
  setupToken: string;
  /** gwa_… the setup ran on. Completion MUST vault on the same account. */
  gateway?: string;
  provider: string;
  /**
   * `pi_…` for the setup intent this add-card was recorded as. The return leg completes
   * THROUGH it rather than exchanging the provider token, so the buyer coming back and
   * the gateway's webhook harvest contend for one atomic claim instead of each vaulting
   * the instrument. Absent for a legacy ENV-configured provider, which has no intent.
   */
  paymentIntent?: string;
}

const storageKey = (scope: string) => `tmb:pending-setup:${scope}`;

export function savePendingVaultSetup(scope: string, pending: PendingVaultSetup): void {
  try {
    sessionStorage.setItem(storageKey(scope), JSON.stringify(pending));
  } catch {
    /* storage blocked — the approval_token_id fallback covers this */
  }
}

export function readPendingVaultSetup(scope: string): PendingVaultSetup | null {
  try {
    const raw = sessionStorage.getItem(storageKey(scope));
    return raw ? (JSON.parse(raw) as PendingVaultSetup) : null;
  } catch {
    return null;
  }
}

export function clearPendingVaultSetup(scope: string): void {
  try {
    sessionStorage.removeItem(storageKey(scope));
  } catch {
    /* nothing to clear */
  }
}

/**
 * Read the provider's return-leg query params, then strip them so a reload can't
 * re-run the exchange. `approval_token_id` is PayPal's echo of the setup token;
 * `razorpay_payment_id` is RazorPay's echo when 3DS redirects the main window.
 */
export function consumeSetupReturn(cleanPath: string): ReturnType<typeof readSetupReturn> {
  const ret = readSetupReturn(window.location.search);
  if (!ret) return null;
  window.history.replaceState({}, "", cleanPath);
  return ret;
}

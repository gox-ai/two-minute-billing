/**
 * Which return leg owns a `/portal` (or `/checkout`) URL — the two readers, side by side,
 * because the only way to get this right is to see them together.
 *
 * Pure string-in, verdict-out. No `window`, no `sessionStorage`: the DOM half (stripping
 * the query with `history.replaceState`) stays in the modules that wrap these, so the
 * RULE can be unit-tested from the root suite, whose tsconfig is `lib: ["ES2023"]` and has
 * no DOM at all.
 *
 * ── THE COLLISION ────────────────────────────────────────────────────────────
 * Both the add-a-card leg and the Pay-now leg send the buyer off-site and bring them back
 * to ONE page, where both return components are mounted. Whichever reader claims the URL
 * strips the params, so the other never sees them — silently.
 *
 * `readSetupReturn` fires on a BARE `razorpay_payment_id` / `approval_token_id` with no
 * `?setup=` at all, and that is deliberate: when RazorPay redirects the main window for
 * 3DS, that echo is the only signal a vault return has. But a redirect-mode PAYMENT return
 * carries the identical echo — so without a discriminator the vault leg swallows a payment
 * return and tries to exchange a payment id for an instrument.
 *
 * `?pay=` is the discriminator. `readPaymentReturn` matches it and nothing else;
 * `readSetupReturn` stands down whenever it is present. Neither half is safe alone.
 */

/**
 * What an `sdk` gateway echoes when its own 3DS step sends the whole page back: Checkout.com
 * Flow appends `cko-payment-id` (measured 2026-10-25). Leg 2 needs it as the client result,
 * or the engine consumes an intent that has no card yet.
 */
export function readSdkReturnResult(search: string): Record<string, string> | null {
  const id = new URLSearchParams(search).get("cko-payment-id");
  return id ? { "cko-payment-id": id } : null;
}

/** A redirect-mode PAYMENT challenge coming back. Matches `?pay=` only. */
export function readPaymentReturn(search: string): "return" | "cancel" | null {
  const pay = new URLSearchParams(search).get("pay");
  return pay === "return" || pay === "cancel" ? pay : null;
}

/**
 * A redirect-mode VAULT approval coming back. `approvalToken` is the provider's echo of
 * the setup token — PayPal's `approval_token_id`, or RazorPay's `razorpay_payment_id` when
 * 3DS redirects the main window.
 */
export function readSetupReturn(search: string): {
  outcome: "return" | "cancel";
  approvalToken: string | null;
  clientResult: Record<string, string> | null;
} | null {
  const params = new URLSearchParams(search);
  // Stand down for a payment return — see the collision note above.
  if (params.get("pay")) return null;
  const setup = params.get("setup");
  const approvalToken = params.get("approval_token_id") ?? params.get("razorpay_payment_id");
  if (setup !== "return" && setup !== "cancel" && !approvalToken) return null;
  return {
    outcome: setup === "cancel" ? "cancel" : "return",
    approvalToken,
    clientResult: readSdkReturnResult(search),
  };
}

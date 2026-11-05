/**
 * Which gateways can void an in-flight debit, in a module with NO `'use client'` on
 * purpose: the server-rendered page decides per invoice whether to offer "pay another
 * way", and React refuses at runtime a call into a client module's export (see
 * `portal-tabs.ts`). The client dialog imports the same definition.
 */

/**
 * Gateways that can cancel a mandate debit already in flight — mirrors the adapters'
 * `capabilities.intentVoid`.
 *
 * A COPY decision: the engine reports which gateway holds the
 * debit and this decides what the buyer is promised. Unknown keys fall to the cautious
 * wording, which is why the map is consulted with `=== true` rather than defaulted.
 *
 * MEASURED 2026-09-10, correcting the belief this dialog shipped with: a Stripe India
 * e-mandate debit rests at `requires_action` while the pre-debit notification runs, and
 * cancels cleanly from there (`pi_…` → `canceled`). The old blanket "banks often won't
 * allow it once sent" came from RazorPay's behaviour and was wrong for the Stripe case.
 *
 * ⚠️ Still only the LIKELY outcome, never a guarantee: cancellability is time-dependent,
 * and once the gateway presents the debit it leaves the cancellable state. That is why
 * the warning below stays for both branches and why the toast reports what actually
 * happened (`voided_at_gateway`) instead of repeating this prediction.
 */
export const CAN_CANCEL_AT_GATEWAY: Record<string, boolean> = {
  stripe: true,
  paypal: true,
  razorpay: false,
};

/**
 * May we offer this buyer a DIFFERENT way to pay while a debit is still in flight?
 *
 * ⚠️ ONLY WHERE WE CAN KILL THE FIRST ATTEMPT. Releasing our own hold is not enough: if
 * the gateway can still take the money afterwards, "pay another way" is a double-charge
 * button. RazorPay is exactly that case — `capabilities.intentVoid` is false, and their
 * Late Authorisation behaviour means a payment sitting in `created` can be authorised
 * RETROACTIVELY for up to three days while they poll the bank. The buyer cannot prevent
 * it either, which is why the dialog's "decline the request if it arrives" is no
 * safeguard there: under late authorisation there is no request to decline.
 *
 * Stripe can, and it was measured rather than assumed (2026-09-10): an India e-mandate
 * debit rests at `requires_action` while its pre-debit notification runs and cancels
 * cleanly from there.
 *
 * Unknown gateways fall to NO — the safe direction, since the cost of withholding the
 * button is a wait and the cost of offering it wrongly is charging someone twice.
 */
export function canCancelAtGateway(gateway?: string | null): boolean {
  return CAN_CANCEL_AT_GATEWAY[(gateway ?? "").toLowerCase()] === true;
}

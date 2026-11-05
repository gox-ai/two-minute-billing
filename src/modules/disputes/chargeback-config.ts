/**
 * Chargeback management — what happens to the invoice and the customer's subscriptions
 * when a dispute is lost.
 *
 * ── We book a chargeback as an EXPENSE, not a revenue reversal ───────────────────
 * `handleDisputeEvent` (`./service.ts`) posts:
 *   · `funds_withdrawn` → dr `disputed_funds` / cr `cash`        (cash gone, asset held)
 *   · `lost`            → dr `dispute_losses` / cr `disputed_funds`  (loss realised)
 *   · `won`              → the reverse (cash reinstated)
 * The invoice stays **paid** throughout — the customer did pay and the bank clawed it
 * back. This config decides what ELSE happens (to the invoice's paper trail, and to the
 * subscription); it does not touch that ledger treatment.
 *
 * ── Three options are deliberately ABSENT ────────────────────────────────────────
 * 1. "Mark invoice as Not Paid and record refund" — would resurrect `accounts_receivable`
 *    with no matching ledger entry; the ledger says the cash arrived.
 * 2. A credit note on *initiated* — at initiation the money may still be with us, and a
 *    WIN reinstates it. The invoice action here is LOST-only.
 * 3. Chargeback notification rules — out of scope.
 *
 * `on_lost_invoice: 'credit_note'` is safe precisely because `createRefundedCreditNote`
 * (`modules/credit-notes/service.ts`) books **no ledger entries** — its own docblock:
 * "The CN is a DOCUMENT of money returned, not a balance." The `dispute_losses` posting
 * remains the accounting treatment; the credit note is only a reconciliation document.
 *
 * ── Shape and style ───────────────────────────────────────────────────────────────
 * Modelled on `resolveCreditsFlexibility` (`modules/customers/credits-flexibility.ts`) and
 * `resolveInvoiceCustomization` (`modules/invoicing/customization.ts`): one nullable jsonb
 * column on `businesses`, a PURE resolver, a docblock per field naming its default, and the
 * house rule that **only an explicit, valid value opts out of the default** — checked
 * against the literal union, never by truthiness. That matters more here than usual: a
 * hand-edited or half-written config must never silently start cancelling subscriptions.
 * A null / absent / malformed stored value resolves to DEFAULT_CHARGEBACK_CONFIG, which is
 * exactly today's behaviour — record disputes, act on none of them.
 */

/** What happens to the invoice once the dispute is LOST. Default: no_action. */
export type ChargebackInvoiceAction = "credit_note" | "no_action";

/**
 * What happens to a subscription on a chargeback event. The same five values apply to
 * both `on_initiated_subscription` and `on_lost_subscription`. Default for both: no_action.
 */
export type ChargebackSubscriptionAction =
  | "cancel_immediately"
  | "cancel_end_of_term"
  | "pause_indefinitely"
  | "pause_end_of_term"
  | "no_action";

const INVOICE_ACTIONS = ["credit_note", "no_action"] as const;

const SUBSCRIPTION_ACTIONS = [
  "cancel_immediately",
  "cancel_end_of_term",
  "pause_indefinitely",
  "pause_end_of_term",
  "no_action",
] as const;

export interface ChargebackConfig {
  /** The invoice's paper trail once a dispute is LOST. Default `'no_action'`. */
  onLostInvoice: ChargebackInvoiceAction;
  /**
   * Subscription action taken as soon as a dispute is INITIATED (before the outcome is
   * known — a WIN reinstates whatever was withdrawn, but a pause/cancel already taken here
   * is not automatically undone). Default `'no_action'`.
   */
  onInitiatedSubscription: ChargebackSubscriptionAction;
  /** Subscription action taken once a dispute is LOST. Default `'no_action'`. */
  onLostSubscription: ChargebackSubscriptionAction;
  /**
   * Apply the subscription action (initiated/lost, whichever fired) to the customer's
   * OTHER subscriptions too, not just the one the disputed invoice belongs to. Default
   * `false`. One disputed payment is not evidence about a customer's other subscriptions,
   * and cancelling them is not undone by re-running anything.
   */
  cascadeToOtherSubscriptions: boolean;
  /**
   * Stop attempting collection on the customer's other unpaid invoices and unbilled
   * charges. Default `false`.
   */
  stopCollectingAll: boolean;
}

/**
 * Today's behaviour: record every dispute, act on none of them. `businesses.chargeback_config`
 * is jsonb with no column default, so this is exactly what every business gets until it
 * saves the settings screen — including every business that has disputes in flight today.
 */
export const DEFAULT_CHARGEBACK_CONFIG: ChargebackConfig = {
  onLostInvoice: "no_action",
  onInitiatedSubscription: "no_action",
  onLostSubscription: "no_action",
  cascadeToOtherSubscriptions: false,
  stopCollectingAll: false,
};

/** The stored jsonb shape (snake_case, like `pause_config` / `backdating_config`). */
interface StoredChargebackConfig {
  on_lost_invoice?: unknown;
  on_initiated_subscription?: unknown;
  on_lost_subscription?: unknown;
  cascade_to_other_subscriptions?: unknown;
  stop_collecting_all?: unknown;
}

/** An explicit member of `allowed`, else `fallback`. Checked by value, never truthiness. */
function oneOf<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}

/** An explicit boolean, else `fallback`. A truthy non-boolean (e.g. `"false"`) is malformed, not opt-in. */
function flag(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/**
 * Resolve a business's effective chargeback policy. Pure; a null / absent / malformed
 * stored value resolves to {@link DEFAULT_CHARGEBACK_CONFIG} field by field — a config
 * that sets one key does not affect resolution of the others.
 */
export function resolveChargebackConfig(
  biz: { chargebackConfig?: unknown } | null | undefined,
): ChargebackConfig {
  const raw = (biz?.chargebackConfig ?? null) as StoredChargebackConfig | null;
  return {
    onLostInvoice: oneOf(
      raw?.on_lost_invoice,
      INVOICE_ACTIONS,
      DEFAULT_CHARGEBACK_CONFIG.onLostInvoice,
    ),
    onInitiatedSubscription: oneOf(
      raw?.on_initiated_subscription,
      SUBSCRIPTION_ACTIONS,
      DEFAULT_CHARGEBACK_CONFIG.onInitiatedSubscription,
    ),
    onLostSubscription: oneOf(
      raw?.on_lost_subscription,
      SUBSCRIPTION_ACTIONS,
      DEFAULT_CHARGEBACK_CONFIG.onLostSubscription,
    ),
    cascadeToOtherSubscriptions: flag(
      raw?.cascade_to_other_subscriptions,
      DEFAULT_CHARGEBACK_CONFIG.cascadeToOtherSubscriptions,
    ),
    stopCollectingAll: flag(raw?.stop_collecting_all, DEFAULT_CHARGEBACK_CONFIG.stopCollectingAll),
  };
}

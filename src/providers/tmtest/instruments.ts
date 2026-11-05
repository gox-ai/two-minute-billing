/**
 * TM Billing Test Gateway — deterministic instruments (C4 / plan §C4).
 *
 * A token presented to the gateway is classified by the card number it carries
 * into one of a fixed set of behaviors. A few widely-used classic test cards are
 * accepted as ALIASES of our magic PANs, so existing tests port over unchanged.
 */

/** The behavior a magic instrument drives. */
export type InstrumentBehavior =
  | "success" // vault ok, charge succeeds
  | "hard_decline" // card_declined, non-retriable
  | "expired_card" // expired_card, non-retriable — a code smart mode parks on the first failure
  | "insufficient_funds" // retriable → exercises dunning
  | "mandate_revoked" // revocation_of_authorization, non-retriable: the payer withdrew consent
  | "requires_action" // 3DS challenge (intent flow, C7)
  | "vault_ok_charge_fails" // vaults ok, every charge fails
  | "late_failure" // succeeds, async charge.failed reversal → late_failure
  | "timeout" // responds slowly → timeout → reconcile
  /**
   * Accepted by the gateway and still in flight — a LIVE attempt that will settle
   * by webhook, which is what every RazorPay INR rail returns and what
   * `bookPending(…, 'in_progress')` exists to model.
   *
   * Distinct from `timeout`, and the distinction is the point: `timeout` means the
   * outcome is UNKNOWN (we may not have reached the gateway at all), so it books
   * `timeout` and waits for a reconcile. This one means the gateway said yes, it is
   * working on it. Before it existed the `in_progress` branch could not be reached
   * offline at all, so the AFA notice — which fires only on that branch — passed
   * every unit test while emitting nothing on the real path.
   *
   * Deliberately never settles on its own: the rails that return this are waiting on
   * a bank or a person. A suite that wants it settled drives the webhook itself.
   */
  | "async_pending"
  /** `async_pending`, but already submitted to the bank: `cancelPendingCharge` refuses it. */
  | "async_pending_submitted"
  /**
   * FIRST attempt fails retriably, the NEXT attempt on the same intent (or the
   * same vaulted instrument) succeeds — the multi-attempt intent (C7): a payment
   * intent shows a "Payment Attempts" count and real rows reach 2, which no
   * single-shot behaviour above can produce. An intent survives the
   * failure (it stays `authorized`, not consumed), so the engine can retry it and
   * land on attempt_count = 2.
   */
  | "retry_then_success"
  /** The charge is made, then the answer is lost: `charge()` throws indeterminate. */
  | "lost_answer_charged"
  /** The answer is lost and nothing was made. `locateCharge` finds nothing. */
  | "lost_answer_not_created";

export interface InstrumentSpec {
  behavior: InstrumentBehavior;
  /** Canonical PAN this token maps to (post-alias). */
  pan: string;
}

/** Our canonical magic PANs → behavior. */
const MAGIC_PANS: Record<string, InstrumentBehavior> = {
  "4242424242424242": "success",
  "4000000000000002": "hard_decline",
  "4000000000000069": "expired_card",
  "4000000000009995": "insufficient_funds",
  "4000000000000150": "mandate_revoked",
  "4000000000003155": "requires_action",
  "4000000000000341": "vault_ok_charge_fails",
  "4000000000005126": "late_failure",
  "4000000000000077": "timeout",
  "4000000000000101": "async_pending",
  "4000000000000119": "async_pending_submitted",
  // ⚑ RETRY CARD — the trigger for the multi-attempt intent simulation.
  //   charge():        the first charge on this vault fails (`card_declined`,
  //                    retriable); every later charge on it succeeds.
  //   consumeIntent(): the first consume of an intent fails retriably and LEAVES
  //                    THE INTENT AUTHORIZED; the second consume captures. That
  //                    is how a verify suite drives one intent to attempt_count 2.
  //   createIntent():  unaffected — the intent authorizes normally, so the
  //                    failure lands on the attempt, not on the intent's birth.
  "4000000000002008": "retry_then_success",
  // Lost answers: `charge()` throws `ProviderIndeterminateError`; `locateCharge` resolves it.
  "4000000000000127": "lost_answer_charged",
  "4000000000000135": "lost_answer_not_created",
};

/** Widely-used classic test cards → our canonical PAN (aliases). */
const CLASSIC_TEST_CARD_ALIASES: Record<string, string> = {
  "4111111111111111": "4242424242424242", // success
  "4005519200000004": "4000000000009995", // insufficient funds
  "4556761029983886": "4000000000003155", // amount-selected 3DS
};

/** Extract the card number (a 12–19 digit run) from an arbitrary token string. */
export function extractPan(token: string): string | null {
  const digits = token.replace(/[^0-9]/g, "");
  if (digits.length >= 12 && digits.length <= 19) return digits;
  // Otherwise look for an embedded canonical/alias PAN.
  const m = token.match(/\d{12,19}/);
  return m ? m[0] : null;
}

/** Classify a token into an instrument spec (defaults to success). */
export function classifyToken(token: string): InstrumentSpec {
  const raw = extractPan(token);
  if (!raw) return { behavior: "success", pan: "4242424242424242" };
  const pan = CLASSIC_TEST_CARD_ALIASES[raw] ?? raw;
  return { behavior: MAGIC_PANS[pan] ?? "success", pan };
}

export interface ExpiryHint {
  status: "valid" | "expiring" | "expired";
  expMonth: number;
  expYear: number;
}

/**
 * Derive the vaulted card's expiry + status from the token (C6 sweep fixture).
 * Tokens carrying `expired` vault as an already-past card; `expiring` vault as a
 * card lapsing at the end of the current month; everything else is far-future.
 */
export function expiryFromToken(token: string, now: Date): ExpiryHint {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 1-based
  if (/expired/i.test(token)) {
    // Last month.
    const d = new Date(Date.UTC(y, now.getUTCMonth() - 1, 1));
    return { status: "expired", expMonth: d.getUTCMonth() + 1, expYear: d.getUTCFullYear() };
  }
  if (/expiring/i.test(token)) {
    return { status: "expiring", expMonth: m, expYear: y };
  }
  return { status: "valid", expMonth: 12, expYear: y + 5 };
}

/** Amount ending in 13 (any instrument) → gateway 500 → needs_attention. */
export function isNeedsAttentionAmount(amountMinor: bigint): boolean {
  return amountMinor % 100n === 13n;
}

/**
 * Amount ending in 17 → the provider ACCEPTS the refund but does not settle it.
 *
 * The real-world default on cards and bank rails, and unreachable here before: the test
 * gateway settled every refund synchronously, so the entire accepted-then-settled path —
 * the `refund_initiated` email, the ledger booking on acceptance, and the settlement
 * webhook — had no way to be exercised. `verify:refund-settlement` drives it with this.
 */
export function isPendingRefundAmount(amountMinor: bigint): boolean {
  return amountMinor % 100n === 17n;
}

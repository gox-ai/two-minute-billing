/**
 * Card limit per currency (0482, `businesses.card_payment_limits`): `{ "<CUR>": <minor> }`.
 *
 * An invoice whose amount due is ABOVE the limit for its currency is not paid by card:
 *  - automatic and operator collection skip card instruments and try the rest; with none
 *    left the attempt is booked as `card_limit_exceeded` with no gateway call. Dunning treats
 *    it like `no_payment_method`: the invoice stays open, reminders go out, and a parking
 *    business parks it, so the customer pays another way;
 *  - the portal does not open a checkout for it, because the gateway's sheet offers cards.
 *
 * Equal to the limit is allowed. An absent currency, a null column or a malformed value means
 * no limit, which is every business until it sets one.
 */

export const CARD_LIMIT_CODE = "card_limit_exceeded";

/** Payer-facing: it rides `payment_failed` into the customer's email. */
export const CARD_LIMIT_MESSAGE =
  "This invoice is more than the amount that we accept by card. Pay it by another method, for example a bank transfer. The invoice shows how to pay.";

/** The upper bound an operator may store: well inside bigint and JSON-safe as a number. */
export const MAX_CARD_LIMIT_MINOR = Number.MAX_SAFE_INTEGER;

/** Resolve the stored map. Pure; keys are upper-cased, invalid entries are dropped. */
export function resolveCardPaymentLimits(
  biz: { cardPaymentLimits?: unknown } | null | undefined,
): Record<string, bigint> {
  const raw = biz?.cardPaymentLimits;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, bigint> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z]{3}$/.test(k)) continue;
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (!Number.isSafeInteger(n) || n < 0) continue;
    out[k.toUpperCase()] = BigInt(n);
  }
  return out;
}

/** The limit for one currency, or null when there is none. */
export function cardLimitFor(
  biz: { cardPaymentLimits?: unknown } | null | undefined,
  currency: string,
): bigint | null {
  return resolveCardPaymentLimits(biz)[currency.toUpperCase()] ?? null;
}

/** True when this amount may not be paid by card. */
export function overCardLimit(
  biz: { cardPaymentLimits?: unknown } | null | undefined,
  currency: string,
  amountMinor: bigint,
): boolean {
  const limit = cardLimitFor(biz, currency);
  return limit !== null && amountMinor > limit;
}

/** The instruments the limit applies to. */
export function isCardInstrument(pm: { type: string | null }): boolean {
  return pm.type === "card";
}

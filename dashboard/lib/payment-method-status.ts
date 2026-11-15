// Which saved payment methods a charge can use. Pure, relative imports only.

/** Every lifecycle status the payment methods API returns. */
export const PAYMENT_METHOD_STATUSES = [
  "valid",
  "expiring",
  "expired",
  "invalid",
  "pending_verification",
] as const;

/**
 * True when we can charge a saved method: `valid`, or `expiring` (it still charges until it
 * expires). The engine counts the same two as live. A row with no status is an older
 * response, and counts as valid.
 */
export const canChargeMethod = (status: string | null | undefined): boolean =>
  status == null || status === "" || status === "valid" || status === "expiring";

/**
 * Whether an automatic top-up has a method to charge, for a customer with no top-up yet:
 * its own method when it names one, else any method of the customer. The engine's rule
 * (`autoTopupCanCharge`): only an invalid method does not count. A saved top-up reads
 * `has_payment_method` from the API, which is that rule itself.
 */
export function topupCanCharge(
  pinned: string | null | undefined,
  methods: ReadonlyArray<{ id: string; status?: string | null }>,
): boolean {
  const live = methods.filter((m) => m.status !== "invalid");
  return pinned ? live.some((m) => m.id === pinned) : live.length > 0;
}

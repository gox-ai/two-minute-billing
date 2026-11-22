/**
 * Every Mollie code our decline rules key on, as Mollie documents them (captured 2026-11-17 in
 * docs/references/MOLLIE_ERROR_CODES.md): the 15 card `details.failureReason` values and the
 * 25 SEPA `details.bankReasonCode` values (https://docs.mollie.com/reference/extra-payment-parameters;
 * Mollie defers to the EPC's R-transaction codes), plus the three failure statuses that reach
 * the rules when a payment carries no reason (https://docs.mollie.com/docs/handling-payment-status).
 * HTTP errors carry no code (the adapter classifies them by status and `detail`), and
 * point-of-sale `statusReason` codes are out of scope.
 *
 * test/unit/mollie-error-code-coverage.test.ts fails if one has neither a rule nor an entry in
 * `MOLLIE_CODES_OUR_CALLS_NEVER_RAISE`.
 */
const CODES = `
  authentication_abandoned authentication_failed authentication_required
  authentication_unavailable_acs card_declined card_expired inactive_card insufficient_funds
  invalid_cvv invalid_card_holder_name invalid_card_number invalid_card_type possible_fraud
  refused_by_issuer unknown_reason
  AC01 AC04 AC06 AC13 AG01 AG02 AM04 AM05 BE05 CNOR DNOR ED05 FF01 MD01 MD02 MD06 MD07 MS02
  MS03 RC01 RR01 RR02 RR03 RR04 SL01
  canceled expired failed
`;

export const MOLLIE_DOCUMENTED_ERROR_CODES: readonly string[] = CODES.split(/\s+/).filter(Boolean);

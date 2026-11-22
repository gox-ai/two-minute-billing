/**
 * Every GoCardless code our decline rules key on, as GoCardless documents them (captured
 * 2026-11-17 in docs/references/GOCARDLESS_ERROR_CODES.md): the 43 `details.cause` values on
 * failure-type event actions (https://docs.gocardless.com/docs/api-reference/events/payment,
 * …/mandate, …/refund, …/billing-request) and the 49 API error reasons
 * (https://docs.gocardless.com/docs/api-reference/responses-and-errors). Scheme `reason_code`s
 * are not keyed on: GoCardless says to branch on the cause.
 *
 * test/unit/gocardless-error-code-coverage.test.ts fails if one has neither a rule nor an entry
 * in `GOCARDLESS_CODES_OUR_CALLS_NEVER_RAISE`.
 */
const CODES = `
  refer_to_payer bank_account_closed invalid_bank_details authorisation_disputed
  return_on_odfi_request other test_failure direct_debit_not_enabled
  account_blocked_for_any_financial_transaction insufficient_funds mandate_cancelled
  bank_account_transferred payment_stopped closed_debtor_account_number
  account_details_changed blocked_account unsuccessful_direct_debit limit_exceeded
  mandate_expired bank_system_processing_error maximum_number_of_dd_transactions_exceeded
  maximum_dd_transaction_amount_exceeded payment_violated_mandate_parameters no_status_update
  bank_declined_payment daily_payment_limit_reached insufficient_payment_permissions
  instalment_schedule_cancelled initial_one_off_payment_failed payment_cancelled
  mandate_suspended_by_payer refund_requested customer_approval_denied mandate_blocked
  mandate_blocked_by_gocardless refund_failed billing_request_failed billing_request_cancelled
  billing_request_bank_authorisation_denied billing_request_bank_authorisation_expired
  billing_request_bank_authorisation_failed billing_request_flow_exited payer_geo_blocked
  internal_server_error request_timed_out query_timed_out invalid_type path_not_found
  resource_not_found link_not_found unauthorized forbidden feature_disabled not_acceptable
  request_entity_too_large unsupported_media_type rate_limit_exceeded access_token_not_found
  access_token_not_active access_token_revoked missing_authorization_header
  invalid_authorization_header insufficient_permissions
  insufficient_permissions_continue_on_dashboard method_not_allowed bad_request
  idempotency_key_too_long invalid_document_structure invalid_content_type tls_required
  missing_version_header version_not_found invalid_filters request_body_not_allowed
  customer_data_removed payout_items_data_archived cancellation_failed retry_failed
  disable_failed mandate_is_inactive mandate_replaced bank_account_disabled
  mandate_not_inactive refund_is_unreachable refund_payment_invalid_state
  total_amount_confirmation_invalid number_of_refunds_exceeded idempotent_creation_conflict
  customer_bank_account_token_used billing_request_must_be_ready_to_fulfil bank_account_exists
  available_refund_amount_insufficient
`;

export const GOCARDLESS_DOCUMENTED_ERROR_CODES: readonly string[] =
  CODES.split(/\s+/).filter(Boolean);

/**
 * Every Checkout.com code our decline rules key on, as Checkout.com documents them (captured
 * 2026-11-17 in docs/references/CHECKOUTCOM_ERROR_CODES.md): the 258 API response codes
 * (https://www.checkout.com/docs/developer-resources/codes/api-response-codes) and the 155
 * distinct `error_codes` (https://www.checkout.com/docs/developer-resources/codes/error-codes).
 * Two are documented as patterns and listed by example: `{CURRENCY}_currency_not_configured`
 * as `usd_…`, `{SCHEME}_scheme_not_configured` as `visa_…`.
 *
 * test/unit/checkoutcom-error-code-coverage.test.ts fails if one has neither a rule nor an
 * entry in `CHECKOUTCOM_CODES_OUR_CALLS_NEVER_RAISE`.
 */
const CODES = `
  10000 10008 10010 10011 10076 10077 10081 10100 10200 20001 20002 20003 20004 20005 20006
  20009 20012 20013 20014 20015 20016 20017 20018 20019 20020 20021 20022 20023 20024 20025
  20026 20027 20028 20029 20030 20031 20032 20033 20038 20039 20040 20042 20044 20045 20046
  20051 20052 20053 20054 20055 20056 20057 20058 20059 20060 20061 20062 20063 20064 20065
  20066 20067 20068 20070 20072 20075 20078 20081 20082 20083 20084 20085 20086 20087 20088
  20089 20090 20091 20092 20093 20094 20095 20096 20097 20098 20099 20197 2005C 2006P 2009G
  200A4 200A5 200A6 200E0 200E2 200E3 200N0 200N7 200P1 200P9 200R1 200R3 200S4 200T2 200T3
  200T5 20100 20101 20102 20103 20104 20105 20106 20107 20108 20109 20110 20111 20112 20113
  20114 20115 20116 20117 20118 20119 20120 20121 20122 20123 20124 20150 20151 20152 20153
  20154 20155 20156 20157 20158 20159 20179 20182 20183 20193 20199 30004 30007 30015 30016
  30017 30018 30019 30020 30021 30022 30033 30034 30035 30036 30037 30038 30041 30043 30044
  30045 30046 30401 30402 30403 30404 30405 41101 41201 41202 41203 41204 41205 41206 41301
  42101 42201 42202 42203 42204 42205 42206 42301 43101 43102 43201 43202 43203 43204 43205
  43206 43301 43401 50001 50002 50003 50004 50005 50020 50021 50022 50023 50025 50026 50027
  50030 50070 50100 50101 50102 50103 50104 50105 50106 50150 50180 50200 50240 50260 50280
  50399 50401 50402 50403 50404 50405 50406 50407 50408 50409 50410 50441 50451 50452 50453
  50454 50466 50471 50481 50490 50491 50492 50494 50499 50501 50511 50512 50513 50514 50515
  50517 50531 50599 usd_currency_not_configured visa_scheme_not_configured 3ds_malfunction
  3ds_not_configured 3ds_not_enabled_for_card 3ds_not_supported 3ds_payment_required
  3ds_version_invalid 3ds_version_not_supported action_failure_limit_exceeded address_invalid
  aft_processor_not_matched amount_exceeds_balance amount_invalid amount_limit_exceeded
  api_calls_quota_exceeded billing_descriptor_city_invalid billing_descriptor_city_required
  billing_descriptor_name_invalid billing_descriptor_name_required business_invalid
  business_settings_missing capture_value_greater_than_authorized
  capture_value_greater_than_remaining_authorized card_authorization_failed card_disabled
  card_expired card_expiry_month_invalid card_expiry_month_required card_expiry_year_invalid
  card_expiry_year_required card_holder_invalid card_not_eligible_domestic_money_transfer
  card_not_eligible_cross_border_money_transfer card_not_eligible_domestic_non_money_transfer
  card_not_eligible_cross_border_non_money_transfer card_not_eligible_domestic_online_gambling
  card_not_eligible_cross_border_online_gambling card_not_found card_number_invalid
  card_number_required channel_details_invalid channel_url_missing charge_details_invalid
  city_invalid country_address_invalid country_invalid country_phone_code_invalid
  country_phone_code_length_invalid currency_invalid currency_required customer_already_exists
  customer_email_invalid customer_id_invalid customer_not_found customer_number_invalid
  customer_plan_edit_failed customer_plan_id_invalid cvv_invalid destination_bank_not_found
  destination_bank_details_invalid email_in_use email_invalid email_required endpoint_invalid
  estimated_authorization_not_supported expiry_date_format_invalid fail_url_invalid
  first_name_required last_name_required ip_address_invalid issuer_network_unavailable
  metadata_key_invalid no_authorization_enabled_processors_available parameter_invalid
  password_invalid payment_expired payment_invalid payment_method_not_supported
  payment_source_required payment_type_invalid phone_number_invalid
  phone_number_length_invalid previous_payment_id_invalid processing_error
  processing_key_required processing_value_required recipient_account_number_invalid
  recipient_account_number_required recipient_bank_details_invalid recipient_bank_not_found
  recipient_dob_invalid recipient_dob_required recipient_last_name_required
  recipient_zip_invalid recipient_zip_required recurring_plan_exists recurring_plan_not_exist
  recurring_plan_removal_failed request_invalid request_json_invalid risk_enabled_required
  server_api_not_allowed source_email_invalid source_email_required source_id_invalid
  source_id_or_email_required source_id_required source_id_unknown source_invalid
  source_or_destination_required source_token_invalid source_token_required
  source_token_type_required source_token_type_invalid source_type_required
  sub_entities_count_invalid success_url_invalid token_expired token_in_use token_invalid
  token_required token_type_required token_used velocity_amount_limit_exceeded
  velocity_count_limit_exceeded void_amount_invalid wallet_id_invalid zip_invalid
  profile_mccs_invalid_for_processing_scope
  principal_address_country_invalid_for_processing_scope
  client_entity_cannot_onboard_subentities <field_name>_required <field_name>_invalid
  service_unavailable token_type_invalid token_data_invalid too_many_metadata_items
  metadata_key_too_long metadata_value_too_long metadata_value_invalid
  metadata_only_supported_for_token_type_card identification_type_invalid
  issuing_country_invalid date_of_birth_invalid country_of_birth_invalid country_required
  residential_status_invalid account_type_invalid account_holder_type_invalid iban_invalid
  swift_bic_invalid token_data_required instrument_already_has_customer entity_id_invalid
`;

export const CHECKOUTCOM_DOCUMENTED_ERROR_CODES: readonly string[] =
  CODES.split(/\s+/).filter(Boolean);

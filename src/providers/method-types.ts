/**
 * The payment-method vocabulary every gateway maps onto. One list, so a new rail is added
 * once — capabilities, routing, the API enums and the bank-debit checks all read it.
 *
 * Keep it aligned with the `method_types` values stored on `gateway_accounts`: Smart
 * Routing matches on them. The dashboard keeps its own copy in
 * `dashboard/app/(storefront)/method-choice.tsx`.
 */
export const METHOD_TYPES = [
  "card",
  "upi",
  "wallet",
  /** Provider-native netbanking (RazorPay eMandate, India eNACH). */
  "bank_transfer",
  "paypal",
  "venmo",
  /** ACH. */
  "us_bank_account",
  "sepa_debit",
  "bacs_debit",
  "au_becs_debit",
  "nz_becs_debit",
  /** Canadian pre-authorized debit (PAD). */
  "acss_debit",
  "autogiro",
  "betalingsservice",
  "payto",
] as const;

export type MethodType = (typeof METHOD_TYPES)[number];

/**
 * What a buyer may ask to vault. Includes `paypal`: it is the only method a PayPal gateway
 * offers, so the storefront sends it.
 */
export const BUYER_METHOD_TYPES = METHOD_TYPES;

/**
 * Bank debits: they settle days later by webhook and have their own dispute path, so an
 * unprompted refund is not safe. `ach_debit` is a legacy stored type.
 */
export const BANK_DEBIT_METHODS: ReadonlySet<string> = new Set([
  "bank_transfer",
  "us_bank_account",
  "ach_debit",
  "sepa_debit",
  "bacs_debit",
  "au_becs_debit",
  "nz_becs_debit",
  "acss_debit",
  "autogiro",
  "betalingsservice",
  "payto",
]);

/** Rails that settle in one currency on every gateway. Per-gateway bindings live in the catalog. */
export const METHOD_CURRENCY: Readonly<Record<string, string>> = {
  us_bank_account: "USD",
  ach_debit: "USD",
  sepa_debit: "EUR",
  bacs_debit: "GBP",
  au_becs_debit: "AUD",
  nz_becs_debit: "NZD",
  acss_debit: "CAD",
  autogiro: "SEK",
  betalingsservice: "DKK",
  payto: "AUD",
  venmo: "USD",
};

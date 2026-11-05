/**
 * Option lists for filter fields, built so a real value can never go missing.
 *
 * ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────────────────
 * Eight filters built their options with `options(rows.map(…))` — the values seen on
 * the pages loaded so far. A `select` filter has no free-text escape, so a value that
 * had not been paged in was not merely absent from the list: the query was
 * **unexpressible**. Reported 2026-09-15 as "EUR is missing in currency", on a business
 * that bills in EUR.
 *
 * Deriving is not wrong on its own — it is wrong when used ALONE. A reference list can
 * be stale too: the gateway catalogue names four gateways, and `payment_methods`
 * and `gateway_request_logs` both carry a fifth, `shadow`, from the parity harness. A
 * reference-only list would have dropped it exactly as the derived-only list dropped
 * EUR.
 *
 * So: union the two. The reference guarantees the known vocabulary is always offerable
 * and gives it proper labels; the derived values guarantee nothing present in the data
 * is unreachable, whatever the reference forgot.
 */

export interface FilterOption {
  value: string;
  label: string;
}

/**
 * Reference options first (in their declared order, with their labels), then any value
 * actually present in the rows that the reference does not name — appended raw, because
 * an unexpected value has no label we can invent for it.
 *
 * Matching is case-insensitive on the VALUE, so a reference `"stripe"` and a stored
 * `"Stripe"` do not become two entries that filter differently.
 */
export function mergeOptions(
  reference: readonly FilterOption[],
  derived: readonly (string | null | undefined)[],
): FilterOption[] {
  const seen = new Set(reference.map((o) => o.value.toLowerCase()));
  const extra = [
    ...new Set(
      derived
        .filter((v): v is string => typeof v === "string" && v.trim() !== "")
        .map((v) => v.trim())
        .filter((v) => !seen.has(v.toLowerCase())),
    ),
  ].sort();
  return [...reference, ...extra.map((v) => ({ value: v, label: v }))];
}

/** Distinct, sorted options from row values alone — for vocabularies with no reference. */
export function derivedOptions(values: (string | null | undefined)[]): FilterOption[] {
  return [...new Set(values.filter((v): v is string => !!v))]
    .sort()
    .map((v) => ({ value: v, label: v }));
}

/**
 * `payment_methods.type` values: the engine's method types (src/providers/method-types.ts)
 * plus `paypal`. Shared by the customers and subscriptions lists.
 */
export const PAYMENT_METHOD_TYPE_OPTIONS: FilterOption[] = [
  { value: "card", label: "Card" },
  { value: "upi", label: "UPI" },
  { value: "wallet", label: "Wallet" },
  { value: "bank_transfer", label: "Direct debit / netbanking" },
  { value: "paypal", label: "PayPal wallet" },
  { value: "venmo", label: "Venmo" },
  { value: "us_bank_account", label: "Direct debit (ACH)" },
  { value: "sepa_debit", label: "Direct debit (SEPA)" },
  { value: "bacs_debit", label: "Direct debit (Bacs)" },
  { value: "au_becs_debit", label: "Direct debit (BECS Australia)" },
  { value: "nz_becs_debit", label: "Direct debit (BECS New Zealand)" },
  { value: "acss_debit", label: "Pre-authorized debit (Canada)" },
  { value: "autogiro", label: "Direct debit (Autogiro)" },
  { value: "betalingsservice", label: "Direct debit (Betalingsservice)" },
  { value: "payto", label: "PayTo" },
];

/** The display name of a method type, or the raw value when we have none. */
export function paymentMethodTypeLabel(v: string): string {
  return PAYMENT_METHOD_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v;
}

/**
 * The HTTP verbs a gateway request log can carry. Closed — this is our own outbound
 * client, not an open vocabulary — and confirmed against the column
 * (`select distinct method from gateway_request_logs`).
 */
export const HTTP_METHOD_OPTIONS: FilterOption[] = [
  { value: "GET", label: "GET" },
  { value: "POST", label: "POST" },
  { value: "PUT", label: "PUT" },
  { value: "PATCH", label: "PATCH" },
  { value: "DELETE", label: "DELETE" },
];

/**
 * Why CURRENCY gets no reference list here.
 *
 * ISO-4217 has ~300 codes and a filter value renders in a plain `SelectField`
 * (`ValueControl`) with no search box, so the full list is unusable — and any shorter
 * list is a guess about which currencies a merchant bills in, which is the same class
 * of mistake as deriving from one page. `lib/money.ts`'s exponent table is not a
 * substitute: it enumerates only the EXCEPTIONS to two decimal places, so USD, EUR and
 * INR are absent from it by design.
 *
 * Until a distinct-values endpoint exists (filed in `docs/PROGRESS.md`), the currency
 * filters take a typed 3-letter code instead. Typing is worse to discover than picking,
 * and it is the only option that can express every currency a business actually uses.
 */
export const CURRENCY_FILTER_HINT = "3-letter ISO code, for example EUR. Not case-sensitive.";

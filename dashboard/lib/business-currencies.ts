/**
 * No app imports, so the root unit tests can load it (`test/unit/gateway-currency-field.test.ts`).
 */

/**
 * The currencies a business bills in: its default plus its currency list. Null when the business
 * has no list, which allows every currency.
 */
export function businessCurrencyOptions(b: {
  default_currency: string | null;
  currencies?: string[] | null;
}): string[] | null {
  if (!b.currencies?.length) return null;
  const codes = [b.default_currency, ...b.currencies].filter((c): c is string => !!c);
  return [...new Set(codes.map((c) => c.toUpperCase()))];
}

/**
 * The Currencies field of a gateway account: the business's currencies that the gateway takes.
 * `options` is null when neither side has a list (every currency). The help names the business
 * currencies the gateway does not take.
 */
export function gatewayCurrencyField(
  business: string[] | null,
  gateway: { display_name: string; currencies?: string[] | null } | undefined,
): { options: string[] | null; help: string; emptyHint?: string } {
  const pick = "Select currencies to route only those currencies here.";
  const list = gateway?.currencies;
  if (!gateway || !list)
    return {
      options: business,
      help: `Leave empty to accept all currencies of this business. ${pick}`,
    };
  const name = gateway.display_name;
  const takes = new Set(list.map((c) => c.toUpperCase()));
  const unsupported = (business ?? []).filter((c) => !takes.has(c));
  const options = business ? business.filter((c) => takes.has(c)) : [...takes];
  // No overlap: "no restriction" would read as "takes everything" for an account that can take nothing.
  if (!options.length) {
    const none = `${name} takes none of the currencies of this business. This account cannot take payments.`;
    return {
      options,
      help: `${none} Add a currency that ${name} takes to the business, or use a different gateway.`,
      emptyHint: none,
    };
  }
  return {
    options,
    help:
      `Leave empty to accept all currencies of this business that ${name} takes. ${pick}` +
      (unsupported.length ? ` ${name} does not take ${unsupported.join(", ")}.` : ""),
    emptyHint: `No restriction. All currencies of this business that ${name} takes are allowed.`,
  };
}

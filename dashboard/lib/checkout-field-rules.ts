/**
 * Which checkout-matrix fields the hosted checkout always asks for, so "Hidden" is not
 * offered for them. No imports: read by the operator settings page and the storefront.
 *
 * - first name: the name printed on the invoice.
 * - country: it decides the region list and the postal code format.
 *
 * Every other address field follows the matrix.
 */
export const ALWAYS_ASKED_CHECKOUT_FIELDS = ["customer.first_name", "billing.country"] as const;

export function isAlwaysAskedCheckoutField(key: string): boolean {
  return (ALWAYS_ASKED_CHECKOUT_FIELDS as readonly string[]).includes(key);
}

/**
 * The gateways a sign-up can name (`SIGNUP_GATEWAYS` in src/modules/auth/signup.ts) that are
 * also catalogue keys. `other` and `none` name no gateway, so they map to nothing.
 */
const NAMES: Record<string, string> = { stripe: "Stripe", razorpay: "Razorpay", paypal: "PayPal" };

/** "Razorpay" for `razorpay`; null when the answer names no gateway. */
export function signupGatewayName(key: string | null | undefined): string | null {
  return key && Object.hasOwn(NAMES, key) ? NAMES[key]! : null;
}

/** The catalogue key to preselect on Add a gateway, or null. */
export function signupGatewayKey(key: string | null | undefined): string | null {
  return key && Object.hasOwn(NAMES, key) ? key : null;
}

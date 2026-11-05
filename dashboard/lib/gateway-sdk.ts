/**
 * Browser gateway clients for `mode: 'sdk'` buyer authorizations, keyed by `sdk.provider`.
 *
 * A new gateway registers one loader here; the storefront surfaces call `openGatewaySdk`
 * and never branch on the provider. RazorPay's `mode: 'checkout'` sheet is not routed
 * through this (see `razorpay-checkout.ts`).
 */

/** `next_action.sdk` / `vault_setup.sdk`: the provider and the params its browser SDK takes. */
export interface GatewaySdkDescriptor {
  provider: string;
  params: Record<string, unknown>;
}

/** `next_action.formPost` / `vault_setup.form_post`: signed fields to POST to the gateway. */
export interface FormPostDescriptor {
  action: string;
  fields: Record<string, string>;
}

export interface GatewaySdkContext {
  businessName: string;
  /** A vault setup (save a method) or a charge (authorize this payment). */
  purpose: "setup" | "payment";
  prefill?: { name?: string | null; email?: string | null; contact?: string | null };
}

/** `clientResult` goes back to the engine as `client_result` on leg 2. */
export type GatewaySdkResult =
  | { status: "completed"; clientResult?: Record<string, string> }
  | { status: "dismissed" }
  | { status: "failed"; message: string };

type GatewaySdkLoader = (
  params: Record<string, unknown>,
  context: GatewaySdkContext,
) => Promise<GatewaySdkResult>;

// Loaded on demand, so no gateway client ships with a page that does not use it.
const LOADERS: Record<string, GatewaySdkLoader> = {
  tmtest: async (params, context) =>
    (await import("@/app/(storefront)/test-gateway-dialog")).openTestGatewayDialog(params, context),
  braintree: async (params, context) =>
    (await import("@/app/(storefront)/braintree-dropin-dialog")).openBraintreeDropin(
      params,
      context,
    ),
  cashfree: async (params, context) =>
    (await import("./cashfree-checkout")).openCashfreeCheckout(params, context),
  adyen: async (params, context) =>
    (await import("@/app/(storefront)/adyen-dropin-dialog")).openAdyenDropin(params, context),
  checkoutcom: async (params, context) =>
    (await import("@/app/(storefront)/checkoutcom-flow-dialog")).openCheckoutcomFlow(
      params,
      context,
    ),
  authorizenet: async (params, context) =>
    (await import("./authorizenet-accept")).openAuthorizenetAccept(params, context),
  square: async (params, context) =>
    (await import("@/app/(storefront)/square-payments-dialog")).openSquarePayments(params, context),
  cybersource: async (params, context) =>
    (await import("@/app/(storefront)/cybersource-microform-dialog")).openCybersourceMicroform(
      params,
      context,
    ),
};

export async function openGatewaySdk(
  sdk: GatewaySdkDescriptor,
  context: GatewaySdkContext,
): Promise<GatewaySdkResult> {
  const loader = LOADERS[sdk.provider];
  if (!loader) {
    return {
      status: "failed",
      message:
        "We could not open the payment form. This page does not support this payment provider. Contact the business.",
    };
  }
  try {
    return await loader(sdk.params ?? {}, context);
  } catch {
    return {
      status: "failed",
      message: "We could not open the payment form. Check your connection. Then try again.",
    };
  }
}

/** Only http(s): a `javascript:` action would run in our origin. */
export function formPostTargetIsSafe(action: string): boolean {
  try {
    const { protocol } = new URL(action);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Top-level POST to the gateway with its signed fields — the `form_post` twin of
 * `window.location.href = approvalUrl`. Write the return-leg stash BEFORE calling this.
 * Returns false (and navigates nowhere) for an action that is not http(s).
 */
export function submitFormPost(
  formPost: FormPostDescriptor,
  opts: { newTab?: boolean } = {},
): boolean {
  if (!formPostTargetIsSafe(formPost.action)) return false;
  const form = document.createElement("form");
  form.method = "POST";
  form.action = formPost.action;
  if (opts.newTab) form.target = "_blank";
  form.style.display = "none";
  for (const [name, value] of Object.entries(formPost.fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
  // A new-tab post leaves this page in place, so the helper form must not pile up.
  if (opts.newTab) form.remove();
  return true;
}

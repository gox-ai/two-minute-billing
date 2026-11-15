/**
 * Confirm a Stripe intent client-side, and say what failed.
 *
 * Every failure carries a full message (what failed, Stripe's own words, the next step) and
 * the page shows it, a field validation error too, even though the Payment Element also
 * marks the field. A decline left to the Element showed nothing at all, and the buyer saw
 * nothing happen after Save or Pay.
 *
 * A second click on an intent a previous attempt already confirmed comes back
 * `setup_intent_unexpected_state` / `payment_intent_unexpected_state`. That is not a
 * failure: the intent succeeded and only our completion leg did not, so we retrieve it and
 * carry on.
 *
 * Structural types, not Stripe.js's: the root unit suite drives this with a stub.
 */

import { gatewayFailure, RETRY_IN_FORM } from "./gateway-errors";

interface StripeError {
  type?: string;
  code?: string;
  message?: string;
}
interface SetupIntentLike {
  status: string;
  payment_method?: string | { id: string } | null;
}
interface PaymentIntentLike {
  id: string;
  status: string;
}

export interface StripeConfirmClient<E> {
  confirmSetup(opts: {
    elements: E;
    redirect: "if_required";
    confirmParams?: { return_url: string };
  }): Promise<{ setupIntent?: SetupIntentLike | null; error?: StripeError }>;
  retrieveSetupIntent(clientSecret: string): Promise<{ setupIntent?: SetupIntentLike | null }>;
  confirmPayment(opts: {
    elements: E;
    redirect: "if_required";
    confirmParams?: { return_url: string };
  }): Promise<{ paymentIntent?: PaymentIntentLike | null; error?: StripeError }>;
  retrievePaymentIntent(
    clientSecret: string,
  ): Promise<{ paymentIntent?: PaymentIntentLike | null }>;
}

/** `pending`: a bank debit Stripe accepted and has not settled (`processing`). */
export type ConfirmOutcome =
  | { ok: true; providerToken: string; pending: boolean }
  | { ok: false; error: string };

export async function confirmStripeIntent<E>(
  stripe: StripeConfirmClient<E>,
  elements: E,
  purpose: "setup" | "payment",
  clientSecret: string,
  returnUrl?: string,
): Promise<ConfirmOutcome> {
  // With a return URL, a method that must redirect (a bank page) can leave and come back.
  // Without one, Stripe refuses those methods at confirm.
  const confirmParams = returnUrl ? { confirmParams: { return_url: returnUrl } } : {};
  if (purpose === "setup") {
    const first = await stripe.confirmSetup({
      elements,
      redirect: "if_required",
      ...confirmParams,
    });
    let intent = first.setupIntent;
    let errMsg = first.error?.message;
    if (first.error?.code === "setup_intent_unexpected_state") {
      intent = (await stripe.retrieveSetupIntent(clientSecret)).setupIntent;
      errMsg = undefined;
    }
    if (!intent || intent.status !== "succeeded" || !intent.payment_method)
      return {
        ok: false,
        error: gatewayFailure("We could not save your payment method.", errMsg, RETRY_IN_FORM),
      };
    return {
      ok: true,
      pending: false,
      providerToken:
        typeof intent.payment_method === "string"
          ? intent.payment_method
          : intent.payment_method.id,
    };
  }
  const first = await stripe.confirmPayment({
    elements,
    redirect: "if_required",
    ...confirmParams,
  });
  let intent = first.paymentIntent;
  let errMsg = first.error?.message;
  if (first.error?.code === "payment_intent_unexpected_state") {
    intent = (await stripe.retrievePaymentIntent(clientSecret)).paymentIntent;
    errMsg = undefined;
  }
  // `requires_capture` counts: a card authorizes, and the second leg captures it
  // server-side against the invoice. `processing` is a bank debit on its way, not a
  // failure: the second leg books it as pending.
  const pending = intent?.status === "processing";
  const authorized =
    pending || intent?.status === "succeeded" || intent?.status === "requires_capture";
  if (!intent || !authorized)
    return {
      ok: false,
      error: gatewayFailure("We could not confirm your payment.", errMsg, RETRY_IN_FORM),
    };
  return { ok: true, providerToken: intent.id, pending };
}

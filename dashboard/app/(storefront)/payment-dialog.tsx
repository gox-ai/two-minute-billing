"use client";

import * as React from "react";
// `/pure`: the main entry injects Stripe.js on import, on every storefront page — 269 KB
// for a buyer still typing an address, or paying through another gateway. This loads it
// only when `loadStripe` runs, at the Stripe payment step.
import { loadStripe } from "@stripe/stripe-js/pure";
import type { Stripe as StripeJs, StripeElements } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { stripeAppearance } from "@/lib/stripe-elements";

/**
 * The storefront's payment modal — one shape for every gateway.
 *
 * RazorPay authorizes in its own overlay, and that turned out to be the better
 * flow: the page the buyer was reading stays put behind it, and the form owns the
 * foreground until it is answered. Stripe hands us Elements to mount wherever we
 * like, and we used to swap it into the page — which meant the gateway picker, the
 * plan summary or the invoice row it replaced simply vanished mid-flow, and the
 * same journey looked like two different products depending on the gateway. So the
 * Stripe form is mounted HERE instead, in our own dialog.
 *
 * `data-brand` is on the CONTENT and not inherited: Radix portals a dialog to
 * <body>, which is outside the storefront's `[data-brand]` wrapper, so without it
 * the modal drops the merchant's colour that the page behind it is painted with.
 * (That was already true of the 3DS sheet — it rendered in our tokens on a branded
 * page.)
 */
export function PaymentDialog({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      {/* A click on the overlay does NOT dismiss this one. Everything else in the app
          is a short confirm flow where an outside click is a cheap escape hatch; here
          it throws away a card the buyer is halfway through typing AND strands the
          setup intent we just opened on the gateway. Deliberate exits only: Cancel,
          the ✕, or Escape. */}
      <DialogContent size="sm" data-brand onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** Errors Stripe's Payment Element already shows under the fields: a field error or a card decline. */
function shownByElement(type: string | undefined): boolean {
  return type === "validation_error" || type === "card_error";
}

/**
 * The message a payment dialog shows when the step after the gateway's form is refused.
 *
 * Shown IN the dialog, not as a toast: a toast sat in the far corner while the dialog
 * stayed open with nothing changed, and went away by itself, so the buyer saw nothing.
 * `reason` is the engine's or the gateway's own sentence, kept whole.
 */
export function refusalMessage(failed: string, reason: string, nextStep: string): string {
  const said = reason.trim();
  const sentence = /[.!?]$/.test(said) ? said : `${said}.`;
  // The engine's messages often already open with "We could not …": do not say it twice.
  return /^We could not /.test(sentence)
    ? `${sentence} ${nextStep}`
    : `${failed} ${sentence} ${nextStep}`;
}

/** `pending`: a bank debit Stripe accepted and has not settled (`processing`). */
type ConfirmOutcome =
  | { ok: true; providerToken: string; pending: boolean }
  /** `inForm`: a field error the Payment Element already shows under the field. */
  | { ok: false; error: string; inForm?: boolean };

/**
 * Confirm a Stripe intent client-side.
 *
 * A second click on an intent a previous attempt already confirmed comes back
 * `setup_intent_unexpected_state` / `payment_intent_unexpected_state`. That is not a
 * failure: the intent succeeded and only our completion leg didn't, so we retrieve it
 * and carry on rather than walling the buyer behind an intent that in fact went
 * through.
 */
async function confirmIntent(
  stripe: StripeJs,
  elements: StripeElements,
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
    if (!intent || intent.status !== "succeeded" || !intent.payment_method) {
      return {
        ok: false,
        error: errMsg ?? "We could not confirm your card. Try again.",
        inForm: shownByElement(first.error?.type),
      };
    }
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
      error: errMsg ?? "We could not confirm the payment. Try again.",
      inForm: shownByElement(first.error?.type),
    };
  return { ok: true, providerToken: intent.id, pending };
}

/**
 * Stripe Elements plus its two buttons, to be placed inside a `PaymentDialog`.
 *
 * The PAN never touches us — Elements posts it to Stripe from its own iframe, which
 * is what keeps this page in PCI SAQ-A. All three storefront card surfaces (portal
 * add-card, hosted checkout, the 3DS sheet on "Pay now") mount this one component,
 * so the confirm-and-recover dance above exists once instead of three times.
 */
export function StripeIntentForm({
  purpose,
  clientSecret,
  publishableKey,
  brandColor,
  confirmLabel,
  busyLabel,
  returnUrl,
  onBeforeConfirm,
  onCancel,
  onAuthorized,
}: {
  purpose: "setup" | "payment";
  clientSecret: string;
  publishableKey: string;
  brandColor?: string | null;
  confirmLabel: string;
  busyLabel: string;
  /** Where Stripe sends the buyer back after a method that redirects (`?pay=` / `?setup=`). */
  returnUrl?: string;
  /** Runs before the confirm, so the return page can find what a redirect left behind. */
  onBeforeConfirm?: () => void;
  onCancel: () => void;
  /**
   * The confirmed instrument (`pm_…`) for a setup; the authorized `pi_…` for a payment.
   * A returned string is a refusal: the form shows it and stays open, so the buyer can
   * select the confirm button again.
   */
  onAuthorized: (
    providerToken: string,
    outcome: { pending: boolean },
  ) => Promise<string | void> | string | void;
}) {
  const stripePromise = React.useMemo<Promise<StripeJs | null>>(
    () => loadStripe(publishableKey),
    [publishableKey],
  );
  const appearance = React.useMemo(() => stripeAppearance(brandColor), [brandColor]);
  return (
    <Elements stripe={stripePromise} options={{ clientSecret, appearance }}>
      <StripeIntentFormInner
        purpose={purpose}
        clientSecret={clientSecret}
        confirmLabel={confirmLabel}
        busyLabel={busyLabel}
        returnUrl={returnUrl}
        onBeforeConfirm={onBeforeConfirm}
        onCancel={onCancel}
        onAuthorized={onAuthorized}
      />
    </Elements>
  );
}

function StripeIntentFormInner({
  purpose,
  clientSecret,
  confirmLabel,
  busyLabel,
  returnUrl,
  onBeforeConfirm,
  onCancel,
  onAuthorized,
}: {
  purpose: "setup" | "payment";
  clientSecret: string;
  confirmLabel: string;
  busyLabel: string;
  returnUrl?: string;
  onBeforeConfirm?: () => void;
  onCancel: () => void;
  onAuthorized: (
    providerToken: string,
    outcome: { pending: boolean },
  ) => Promise<string | void> | string | void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  // A payment the server already confirmed on a saved card only needs the bank's check:
  // asking for the card again would let the buyer pay with a different one. Holds the
  // card's `pm_…`, `false` for the form, `null` while we ask Stripe.
  const [probe, setProbe] = React.useState<string | false | null>(null);
  const savedCard = purpose === "payment" ? probe : false;
  React.useEffect(() => {
    if (!stripe || savedCard !== null) return;
    void stripe
      .retrievePaymentIntent(clientSecret)
      .then(({ paymentIntent: pi }) => {
        const pm =
          typeof pi?.payment_method === "string" ? pi.payment_method : pi?.payment_method?.id;
        const challenge =
          pi?.next_action?.type === "use_stripe_sdk" || pi?.next_action?.type === "redirect_to_url";
        setProbe(pi?.status === "requires_action" && challenge && pm ? pm : false);
      })
      // Cannot tell: the card form still works.
      .catch(() => setProbe(false));
  }, [stripe, clientSecret, savedCard]);
  // Elements refuses an intent it cannot confirm (one already authorized, captured or
  // cancelled) with `loaderror` and never `ready`; say so instead of loading forever.
  const [loadFailed, setLoadFailed] = React.useState(false);
  /** The last refusal: the gateway's decline, or the step after it. Cleared on a new try. */
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);
    try {
      onBeforeConfirm?.();
      const outcome = await confirmIntent(stripe, elements, purpose, clientSecret, returnUrl);
      if (!outcome.ok) return void setError(outcome.inForm ? null : outcome.error);
      const refused = await onAuthorized(outcome.providerToken, { pending: outcome.pending });
      if (typeof refused === "string") setError(refused);
    } catch {
      // A server action that throws (the network) must not leave the form looking untouched.
      setError(
        refusalMessage(
          purpose === "payment"
            ? "We could not confirm your payment."
            : "We could not save your payment method.",
          "The request did not finish",
          `Select ${confirmLabel} to try again.`,
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const submitSavedCard = async () => {
    if (!stripe || !savedCard) return;
    setBusy(true);
    setError(null);
    try {
      // Confirmed again here, not `handleNextAction`: the server's confirm may carry a
      // redirect, and leaving the page loses the step that finishes the payment.
      const first = await stripe.confirmCardPayment(clientSecret, { payment_method: savedCard });
      // Same recovery as `confirmIntent`: a second click on a confirmed intent is not a failure.
      const after =
        first.error?.code === "payment_intent_unexpected_state" || !first.paymentIntent
          ? (await stripe.retrievePaymentIntent(clientSecret)).paymentIntent
          : first.paymentIntent;
      if (after?.status === "requires_capture" || after?.status === "succeeded") {
        const refused = await onAuthorized(after.id, { pending: false });
        if (typeof refused === "string") setError(refused);
        return;
      }
      setError(first.error?.message ?? "We could not confirm the payment. Try again.");
      // A failed check leaves the intent waiting for a card: show the card form.
      if (after?.status === "requires_payment_method") setProbe(false);
    } finally {
      setBusy(false);
    }
  };

  if (savedCard) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          We charge the card that you added. Your bank asks you to confirm the payment in the next
          step.
        </p>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submitSavedCard} disabled={busy}>
            {busy ? busyLabel : confirmLabel}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/*
        Elements takes a moment: Stripe.js has to load, then the iframe has to mount and
        lay out — measured at up to ~8s on a cold load here. Until `onReady` fires the
        dialog is a title and two buttons over an empty gap, which reads as broken rather
        than as loading.

        The element stays MOUNTED and in flow underneath, only transparent: it is an
        iframe that sizes itself from its container, and hiding it with `display:none` or
        a zero height is how you get a form that never reports ready. The skeleton is an
        absolute overlay instead, and the container carries a min-height while it shows —
        without one the container is 0px tall until the iframe lays out, so the overlay
        would have nothing to fill. 360px is the measured height of the real single-card
        form, so there is no jump when it arrives.
      */}
      {loadFailed ? (
        <Alert tone="error">
          We could not open the payment form. Close this window and reload the page. Then try again.
        </Alert>
      ) : null}
      <div className={cn("relative", !ready && !loadFailed && "min-h-[360px]")}>
        <div className={cn("transition-opacity duration-200", ready ? "opacity-100" : "opacity-0")}>
          {/* Left on the DEFAULT `auto` layout deliberately. An explicit
              `layout: { type: 'accordion', radios: … }` looked like the closer match to
              our single-column forms, and measured worse: inside this 448px dialog
              Stripe laid the accordion item out at ~185px — the card fields ended up in
              a narrow left column with half the sheet empty beside them (2026-08-21). On
              `auto` the same iframe fills its 406px, expiry and CVC sit side by side, and
              the mandate consent line renders. Don't "tidy" this into an explicit layout
              without re-measuring at this width. */}
          <PaymentElement onReady={() => setReady(true)} onLoadError={() => setLoadFailed(true)} />
        </div>
        {!ready && !loadFailed ? <CardFormSkeleton /> : null}
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {/* Disabled until READY, not merely until Stripe.js exists: confirming against an
            element that has not mounted fails, and the buyer would have paid for the
            error with a real card in the box. */}
        <Button onClick={submit} disabled={busy || !ready || savedCard === null}>
          {busy ? busyLabel : confirmLabel}
        </Button>
      </div>
    </div>
  );
}

/** The shape of the card form, while the card form is on its way. */
function CardFormSkeleton() {
  return (
    <div className="absolute inset-0 flex flex-col gap-4" aria-hidden>
      <Field />
      <div className="grid grid-cols-2 gap-3">
        <Field />
        <Field />
      </div>
      <Field />
      <div className="flex flex-col gap-1.5 pt-1">
        <Skeleton className="h-2.5 w-full" />
        <Skeleton className="h-2.5 w-11/12" />
        <Skeleton className="h-2.5 w-2/3" />
      </div>
      <span className="sr-only" role="status">
        Loading the card form…
      </span>
    </div>
  );
}

function Field() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-2.5 w-24" />
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

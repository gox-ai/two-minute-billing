"use client";

import * as React from "react";
// `/pure`: the main entry injects Stripe.js on import, on every storefront page — 269 KB
// for a buyer still typing an address, or paying through another gateway. This loads it
// only when `loadStripe` runs, at the Stripe payment step.
import { loadStripe } from "@stripe/stripe-js/pure";
import type { Stripe as StripeJs } from "@stripe/stripe-js";
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
import { refusalMessage, RETRY_IN_FORM, stripeClientFailure } from "@/lib/gateway-errors";
import { confirmStripeIntent } from "@/lib/stripe-confirm";
import { clearActiveIntent, reportBuyerError, setActiveGateway } from "@/lib/buyer-error-report";
import { PAYER_CLIENT_REASON, PAYER_NEXT_STEP } from "../../../src/providers/payer-wording";
import { ShieldCheck } from "lucide-react";
import { privacyText, type Instrument } from "./storefront-text";

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
  useGatewayLayerFocus(open);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      {/* The page behind stays readable: the order summary is what the buyer commits to,
          so the scrim tints it and does not blur it. */}
      <style href="tmb-payment-dialog" precedence="default">
        {`body:has([data-payment-dialog]) [data-slot="dialog-overlay"]{backdrop-filter:none}`}
      </style>
      {/* A click on the overlay does NOT dismiss this one. Everything else in the app
          is a short confirm flow where an outside click is a cheap escape hatch; here
          it throws away a card the buyer is halfway through typing AND strands the
          setup intent we just opened on the gateway. Deliberate exits only: Cancel,
          the ✕, or Escape. */}
      {/* Height-capped with an inner scroller: a tall gateway form scrolls under the header,
          and `PaymentDialogFooter` stays at the bottom of the screen. */}
      <DialogContent
        size="sm"
        data-brand
        data-payment-dialog
        className="flex max-h-[90dvh] flex-col overflow-hidden"
        onInteractOutside={(e) => e.preventDefault()}
      >
        {/* Room for the × on both sides while the phone sheet centres the title. */}
        <DialogHeader className="px-8 sm:pr-8 sm:pl-0">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="-mx-6 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-1">
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The dialog's action row. Sticky at the foot of the scrolling body, so Cancel and the
 * commit button stay on screen however tall the gateway's form is.
 */
/**
 * A body-level element added after the dialog opened (Radix marked the ones already there
 * with `data-aria-hidden`) and not one of ours: a gateway's layer, such as its 3-D Secure
 * challenge.
 */
function inGatewayLayer(el: EventTarget | null): boolean {
  if (!(el instanceof Element) || !document.body.contains(el)) return false;
  let top: Element = el;
  while (top.parentElement && top.parentElement !== document.body) top = top.parentElement;
  // Our own layers (a second dialog, a select's list) carry `data-slot` or Radix's wrapper.
  const ours =
    top.matches("[data-slot], [data-radix-popper-content-wrapper], [data-radix-focus-guard]") ||
    top.firstElementChild?.matches("[data-slot]") === true;
  return top.parentElement === document.body && !top.hasAttribute("data-aria-hidden") && !ours;
}

/**
 * The dialog's focus trap pulled focus back out of a gateway's 3-D Secure challenge, so the
 * buyer could not type the code. While open, focus moving into such a layer is not reported
 * to the trap. Pointer events: see globals.css.
 */
function useGatewayLayerFocus(open: boolean) {
  React.useEffect(() => {
    if (!open) return;
    const onIn = (e: FocusEvent) => {
      if (inGatewayLayer(e.target)) e.stopImmediatePropagation();
    };
    const onOut = (e: FocusEvent) => {
      if (inGatewayLayer(e.relatedTarget)) e.stopImmediatePropagation();
    };
    window.addEventListener("focusin", onIn, true);
    window.addEventListener("focusout", onOut, true);
    return () => {
      window.removeEventListener("focusin", onIn, true);
      window.removeEventListener("focusout", onOut, true);
    };
  }, [open]);
}

/** Set by `SdkFrame` when a gateway's form is drawn inside a list row, not in a dialog. */
const InlineFrame = React.createContext(false);
/** True inside a gateway form drawn in a list row: no Cancel there, the row is the choice. */
export const useInlineFrame = () => React.useContext(InlineFrame);

export function PaymentDialogFooter({ children }: { children: React.ReactNode }) {
  const inline = React.useContext(InlineFrame);
  if (inline) return <div className="flex justify-end gap-2">{children}</div>;
  return (
    <div className="sticky bottom-0 z-10 -mx-6 mt-auto flex justify-end gap-2 bg-popover px-6 pt-2">
      {children}
    </div>
  );
}

/**
 * A gateway's form frame: our dialog, or — with `inline` — a plain block inside the open
 * row of Pay now / Add a payment method (the row already names the method, so no title).
 */
export function SdkFrame({
  inline = false,
  open,
  onClose,
  title,
  description,
  children,
}: {
  inline?: boolean;
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  if (inline)
    return open ? (
      <InlineFrame.Provider value>
        <div className="flex flex-col gap-3">
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
          {children}
        </div>
      </InlineFrame.Provider>
    ) : null;
  return (
    <PaymentDialog open={open} onClose={onClose} title={title} description={description}>
      {children}
    </PaymentDialog>
  );
}

/** The privacy sentence under a gateway's fields: who never sees what the buyer types. */
export function PaymentPrivacyNote({
  business,
  instrument = "card",
}: {
  business: string;
  instrument?: Instrument;
}) {
  return (
    <p className="flex items-start gap-2 text-xs text-muted-foreground">
      <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>{privacyText(business, instrument)}</span>
    </p>
  );
}

/**
 * The message a payment dialog shows when the step after the gateway's form is refused.
 *
 * Shown IN the dialog, not as a toast: a toast sat in the far corner while the dialog
 * stayed open with nothing changed, and went away by itself, so the buyer saw nothing.
 */
export { refusalMessage } from "@/lib/gateway-errors";

/**
 * A refusal beside the control that caused it, scrolled into view when it appears or
 * changes: under a tall gateway form or below the fold it was easy to miss. `nearest` moves
 * the dialog body or the page only as far as needed; the bottom margin clears the sticky
 * `PaymentDialogFooter`. The error `Alert` is `role="alert"`, so it is announced.
 *
 * Each message shown is reported for ops (`reportBuyerError`): this is where a payment error
 * reaches the buyer, so it is where a gateway's own words are caught.
 */
export function RefusalAlert({
  message,
  className,
  gateway,
  step,
}: {
  message: string | null | undefined;
  className?: string;
  /** The gateway whose form this is, when the message carries no signal of its own. */
  gateway?: string;
  /** Where on the page, for the report. */
  step?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!message) return;
    ref.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
    reportBuyerError(message, { gateway, step });
  }, [message, gateway, step]);
  if (!message) return null;
  return (
    // Keyed on the message, so a new refusal slides in again.
    <div key={message} ref={ref} className={cn("sf-refusal scroll-mt-4 scroll-mb-14", className)}>
      <Alert tone="error">{message}</Alert>
    </div>
  );
}

/**
 * Stripe Elements plus its two buttons, to be placed inside a `PaymentDialog`.
 *
 * The PAN never touches us — Elements posts it to Stripe from its own iframe, which
 * is what keeps this page in PCI SAQ-A. All three storefront card surfaces (portal
 * add-card, hosted checkout, the 3DS sheet on "Pay now") mount this one component,
 * so the confirm-and-recover dance (`confirmStripeIntent`) exists once instead of three times.
 */
export function StripeIntentForm({
  purpose,
  clientSecret,
  publishableKey,
  brandColor,
  confirmLabel,
  busyLabel,
  returnUrl,
  failureLead,
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
  /**
   * A setup's failure lead. Checkout passes "We could not take your payment." when the
   * same click also charges, so a decline does not read as a save problem.
   */
  failureLead?: string;
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
        failureLead={failureLead}
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
  failureLead,
  onBeforeConfirm,
  onCancel,
  onAuthorized,
}: {
  purpose: "setup" | "payment";
  clientSecret: string;
  confirmLabel: string;
  busyLabel: string;
  returnUrl?: string;
  failureLead?: string;
  onBeforeConfirm?: () => void;
  onCancel: () => void;
  onAuthorized: (
    providerToken: string,
    outcome: { pending: boolean },
  ) => Promise<string | void> | string | void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  React.useEffect(() => {
    setActiveGateway("stripe");
    // The form closes on success and on Cancel: the flow is over either way.
    return () => {
      setActiveGateway(null);
      clearActiveIntent();
    };
  }, []);
  const [busy, setBusy] = React.useState(false);
  const inlineFrame = React.useContext(InlineFrame);
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
      const outcome = await confirmStripeIntent(
        stripe,
        elements,
        purpose,
        clientSecret,
        returnUrl,
        failureLead,
      );
      // Every failure is shown here, a field error too: never left to the Element alone.
      if (!outcome.ok) return void setError(outcome.error);
      const refused = await onAuthorized(outcome.providerToken, { pending: outcome.pending });
      if (typeof refused === "string") setError(refused);
    } catch {
      // A server action that throws (the network) must not leave the form looking untouched.
      setError(
        refusalMessage(
          purpose === "payment"
            ? "We could not confirm your payment."
            : (failureLead ?? "We could not save your payment method."),
          PAYER_CLIENT_REASON.requestUnfinished,
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
      setError(
        stripeClientFailure("We could not confirm your payment.", first.error, RETRY_IN_FORM),
      );
      // A failed check leaves the intent waiting for a card: show the card form.
      if (after?.status === "requires_payment_method") setProbe(false);
    } catch {
      setError(
        refusalMessage(
          "We could not confirm your payment.",
          PAYER_CLIENT_REASON.requestUnfinished,
          `Select ${confirmLabel} to try again.`,
        ),
      );
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
        <RefusalAlert message={error} gateway="stripe" step="saved_card" />
        <PaymentDialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submitSavedCard} disabled={busy}>
            {busy ? busyLabel : confirmLabel}
          </Button>
        </PaymentDialogFooter>
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
      <RefusalAlert
        message={
          loadFailed ? `We could not open the payment form. ${PAYER_NEXT_STEP.reloadDialog}` : null
        }
        gateway="stripe"
        step="payment_form"
      />
      <div className={cn("relative", !ready && !loadFailed && "min-h-[360px]")}>
        <div className={cn("transition-opacity", ready ? "opacity-100" : "opacity-0")}>
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
      <RefusalAlert message={error} gateway="stripe" step="payment_form" />
      <PaymentDialogFooter>
        {/* Inline in a list row, another row is the way out: no Cancel. */}
        {inlineFrame ? null : (
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        {/* Disabled until READY, not merely until Stripe.js exists: confirming against an
            element that has not mounted fails, and the buyer would have paid for the
            error with a real card in the box. */}
        <Button onClick={submit} disabled={busy || !ready || savedCard === null}>
          {busy ? busyLabel : confirmLabel}
        </Button>
      </PaymentDialogFooter>
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

"use client";

import * as React from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { checkoutcomFailure, contactBusiness } from "@/lib/gateway-errors";
import type { GatewaySdkContext, GatewaySdkResult } from "@/lib/gateway-sdk";
import { SdkFrame, PaymentDialogFooter, PaymentPrivacyNote, RefusalAlert } from "./payment-dialog";
import { sdkAmountLabel } from "./storefront-text";

/**
 * Checkout.com Flow. Checkout.com publishes one unversioned URL and no SRI hash, and PCI
 * requires loading it from their host, so it cannot be pinned. Flow loads its card fields
 * and 3DS frames from *.checkout.com; the CSP lists that host. A pay-now session also
 * offers Google Pay (pay.google.com).
 */
const FLOW_SRC = "https://checkout-web-components.checkout.com/index.js";

interface FlowComponent {
  mount(el: HTMLElement): void;
  unmount?(): void;
  /** With `showPayButton: false`: our own button submits. */
  submit?(): void;
  isValid?(): boolean;
}
interface FlowCheckout {
  create(name: "flow", options?: Record<string, unknown>): FlowComponent;
}
declare global {
  interface Window {
    CheckoutWebComponents?: (options: Record<string, unknown>) => Promise<FlowCheckout>;
  }
}

let loading: Promise<void> | null = null;
function loadFlow(): Promise<void> {
  if (window.CheckoutWebComponents) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = FLOW_SRC;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      loading = null;
      reject(new Error("We could not load the payment form. Reload the page. Then try again."));
    };
    document.head.appendChild(el);
  });
  return loading;
}

function CheckoutcomFlowDialog({
  open,
  inline,
  params,
  purpose,
  amountLabel,
  businessName,
  onSettle,
}: {
  open: boolean;
  inline: boolean;
  businessName: string;
  params: { publicKey: string; environment: string; paymentSession: Record<string, unknown> };
  purpose: GatewaySdkContext["purpose"];
  amountLabel: string | null;
  onSettle: (result: GatewaySdkResult) => void;
}) {
  const container = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState<string | null>(null);
  const setup = purpose === "setup";
  // Add card: Flow's own button says "Pay", so ours ("Save card") submits instead.
  const flow = React.useRef<FlowComponent | null>(null);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let component: FlowComponent | null = null;
    (async () => {
      try {
        await loadFlow();
        if (cancelled || !container.current || !window.CheckoutWebComponents) return;
        const checkout = await window.CheckoutWebComponents({
          publicKey: params.publicKey,
          environment: params.environment,
          paymentSession: params.paymentSession,
          // The engine reads the payment from Checkout.com; the browser only names it.
          onPaymentCompleted: (_c: unknown, response: { id?: string }) => {
            if (response?.id)
              onSettle({ status: "completed", clientResult: { payment_id: response.id } });
            // A payment with no id: the engine finds it by this session's reference,
            // so the buyer is never sent to pay again.
            else if (!setup)
              onSettle({ status: "completed", clientResult: { lookup: "reference" } });
            else
              onSettle({
                status: "failed",
                // The provider reported a completed payment that we cannot read: a second
                // try could pay twice, so the buyer is not sent to one.
                message: `We could not confirm the result. It is possible that the payment is complete. Do not pay again. ${contactBusiness(businessName)}`,
              });
          },
          // Flow's own words (a decline, a failed 3DS check), shown here as well as in Flow.
          onError: (_c: unknown, error: unknown) => {
            if (!cancelled) setError(checkoutcomFailure(purpose, error));
          },
        });
        if (cancelled || !container.current) return;
        component = checkout.create("flow", setup ? { showPayButton: false } : {});
        component.mount(container.current);
        flow.current = component;
        setReady(true);
      } catch (e) {
        if (!cancelled)
          setError(
            e instanceof Error && e.message.startsWith("We could not")
              ? e.message
              : `We could not open the ${setup ? "card" : "payment"} form. Try again.`,
          );
      }
    })();
    return () => {
      cancelled = true;
      component?.unmount?.();
      flow.current = null;
      setReady(false);
    };
  }, [open, params, onSettle, setup, purpose]);

  return (
    <SdkFrame
      inline={inline}
      open={open}
      onClose={() => onSettle({ status: "dismissed" })}
      title={setup ? "Add a card" : "Pay"}
      description={
        setup
          ? "Enter your card details. We check the card before we save it."
          : `Enter your payment details to pay${amountLabel ? ` ${amountLabel}` : ""}.`
      }
    >
      <div ref={container} className="min-h-40" />
      <PaymentPrivacyNote business={businessName} instrument={setup ? "card" : "other"} />
      <RefusalAlert message={error} gateway="checkoutcom" />
      <PaymentDialogFooter>
        {inline ? null : (
          <Button variant="outline" onClick={() => onSettle({ status: "dismissed" })}>
            Cancel
          </Button>
        )}
        {setup ? (
          <Button
            disabled={!ready}
            onClick={() => {
              const c = flow.current;
              if (!c?.submit) return;
              if (c.isValid && !c.isValid()) {
                setError("We could not save your card. Correct the card details. Then try again.");
                return;
              }
              setError(null);
              c.submit();
            }}
          >
            Save card
          </Button>
        ) : null}
      </PaymentDialogFooter>
    </SdkFrame>
  );
}

/** The `checkoutcom` loader for `openGatewaySdk`. Mounted in its own root, like Braintree's. */
export function openCheckoutcomFlow(
  params: Record<string, unknown>,
  context: GatewaySdkContext,
): Promise<GatewaySdkResult> {
  const publicKey = typeof params.publicKey === "string" ? params.publicKey : "";
  const environment = params.environment === "production" ? "production" : "sandbox";
  const paymentSession =
    params.paymentSession && typeof params.paymentSession === "object"
      ? (params.paymentSession as Record<string, unknown>)
      : null;
  if (!publicKey || !paymentSession)
    return Promise.resolve({
      status: "failed",
      message: `We could not open the ${context.purpose === "setup" ? "card" : "payment"} form. ${contactBusiness(context.businessName)}`,
    });
  const amountLabel = sdkAmountLabel(params.amount, params.currency);
  const flowParams = { publicKey, environment, paymentSession };
  return new Promise((resolve) => {
    const inline = Boolean(context.inline);
    const host = context.inline ?? document.createElement("div");
    if (!inline) document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const render = (open: boolean) =>
      root.render(
        <CheckoutcomFlowDialog
          open={open}
          inline={inline}
          params={flowParams}
          purpose={context.purpose}
          amountLabel={amountLabel}
          businessName={context.businessName}
          onSettle={settle}
        />,
      );
    const settle = (result: GatewaySdkResult) => {
      if (settled) return;
      settled = true;
      render(false);
      resolve(result);
      setTimeout(() => {
        root.unmount();
        if (!inline) host.remove();
      }, 300);
    };
    render(true);
  });
}

"use client";

import * as React from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import type { GatewaySdkContext, GatewaySdkResult } from "@/lib/gateway-sdk";
import { PaymentDialog } from "./payment-dialog";

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
      reject(
        new Error("We could not connect to Checkout.com. Check your connection. Then try again."),
      );
    };
    document.head.appendChild(el);
  });
  return loading;
}

function CheckoutcomFlowDialog({
  open,
  params,
  purpose,
  amountLabel,
  onSettle,
}: {
  open: boolean;
  params: { publicKey: string; environment: string; paymentSession: Record<string, unknown> };
  purpose: GatewaySdkContext["purpose"];
  amountLabel: string | null;
  onSettle: (result: GatewaySdkResult) => void;
}) {
  const container = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState<string | null>(null);
  const setup = purpose === "setup";

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
          },
          onError: () =>
            setError(
              setup
                ? "We could not complete the card check. Examine the card details and try again, or use a different card."
                : "We could not complete the payment. Examine the details and try again, or use a different payment method.",
            ),
        });
        if (cancelled || !container.current) return;
        component = checkout.create("flow");
        component.mount(container.current);
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
    };
  }, [open, params, onSettle, setup]);

  return (
    <PaymentDialog
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
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => onSettle({ status: "dismissed" })}>
          Cancel
        </Button>
      </div>
    </PaymentDialog>
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
      message: `We could not open the ${context.purpose === "setup" ? "card" : "payment"} form. Contact the business.`,
    });
  const amountLabel =
    typeof params.amount === "string" && typeof params.currency === "string"
      ? `${params.amount} ${params.currency}`
      : null;
  const flowParams = { publicKey, environment, paymentSession };
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const render = (open: boolean) =>
      root.render(
        <CheckoutcomFlowDialog
          open={open}
          params={flowParams}
          purpose={context.purpose}
          amountLabel={amountLabel}
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
        host.remove();
      }, 300);
    };
    render(true);
  });
}

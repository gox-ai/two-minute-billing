"use client";

import * as React from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import type { GatewaySdkContext, GatewaySdkResult } from "@/lib/gateway-sdk";
import { PaymentDialog } from "./payment-dialog";

/**
 * Adyen Web Drop-in (sessions flow), pinned to an exact version with SRI. The card fields are
 * iframes on checkoutshopper-<env>.adyen.com and Drop-in runs 3D Secure itself; the CSP lists
 * those hosts. The hashes were computed from Adyen's CDN for this version. A pay-now session
 * also offers Google Pay, whose pay.js Drop-in loads from pay.google.com.
 */
const ADYEN_WEB_VERSION = "6.46.0";
const CDN = `https://checkoutshopper-live.cdn.adyen.com/checkoutshopper/sdk/${ADYEN_WEB_VERSION}`;
const SCRIPT_SRI = "sha384-BWFAwV8ndpuOuMAiAu2fKA0Vj2lSBNRCVBKIV2K7G6hRT7+0CaXiFYZxkDgfwY7r";
const STYLE_SRI = "sha384-iqhFsakyeWB88YbaGEhZMvY6gJnakKalS52WEM1jya1sN8udUMNyKpfouOSmYVy/";

interface SessionOutcome {
  resultCode?: string;
  sessionResult?: string;
}
interface DropinElement {
  mount(target: HTMLElement): DropinElement;
  unmount(): void;
}
declare global {
  interface Window {
    AdyenWeb?: {
      AdyenCheckout(options: Record<string, unknown>): Promise<unknown>;
      Dropin: new (checkout: unknown, options?: Record<string, unknown>) => DropinElement;
    };
  }
}

let loading: Promise<void> | null = null;
function loadAdyenWeb(): Promise<void> {
  if (window.AdyenWeb?.AdyenCheckout) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    if (!document.querySelector(`link[data-adyen-web="${ADYEN_WEB_VERSION}"]`)) {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = `${CDN}/adyen.css`;
      css.integrity = STYLE_SRI;
      css.crossOrigin = "anonymous";
      css.dataset.adyenWeb = ADYEN_WEB_VERSION;
      document.head.appendChild(css);
    }
    const el = document.createElement("script");
    el.src = `${CDN}/adyen.js`;
    el.integrity = SCRIPT_SRI;
    el.crossOrigin = "anonymous";
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      loading = null;
      reject(new Error("We could not connect to Adyen. Check your connection. Then try again."));
    };
    document.head.appendChild(el);
  });
  return loading;
}

function AdyenDropinDialog({
  open,
  params,
  purpose,
  amountLabel,
  onSettle,
}: {
  open: boolean;
  params: {
    clientKey: string;
    environment: string;
    sessionId: string;
    sessionData: string;
    countryCode: string;
    /** The session's `allowedPaymentMethods`, comma-joined (`scheme,sepadirectdebit`). */
    methods: string;
  };
  purpose: GatewaySdkContext["purpose"];
  amountLabel: string | null;
  onSettle: (result: GatewaySdkResult) => void;
}) {
  const container = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState<string | null>(null);
  const setup = purpose === "setup";
  const methods = params.methods.split(",");
  const bank = methods.includes("sepadirectdebit");
  const card = !bank || methods.includes("scheme");
  const setupTitle = bank ? (card ? "Add a payment method" : "Add a bank account") : "Add a card";
  const setupText = bank
    ? card
      ? "Enter your card or bank account details. For a bank account, you accept a SEPA Direct Debit mandate when you save it."
      : "Enter the account holder name and the IBAN. You accept a SEPA Direct Debit mandate when you save it."
    : "Enter your card details. We check the card before we save it.";

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let dropin: DropinElement | null = null;
    const openFailed = `We could not open the ${setup ? "card" : "payment"} form. Try again.`;
    // The server reads the session and decides; a refusal is reported from there.
    const finish = (outcome: SessionOutcome) => {
      if (outcome.sessionResult)
        onSettle({
          status: "completed",
          clientResult: { sessionId: params.sessionId, sessionResult: outcome.sessionResult },
        });
      else
        onSettle({
          status: "failed",
          message: `We could not complete the payment. Try again, or use a different ${setup ? "card" : "payment method"}.`,
        });
    };
    (async () => {
      try {
        await loadAdyenWeb();
        if (cancelled || !container.current || !window.AdyenWeb) return;
        const checkout = await window.AdyenWeb.AdyenCheckout({
          environment: params.environment,
          clientKey: params.clientKey,
          // Required by Drop-in 6: the billing country, else the browser's region.
          countryCode: params.countryCode,
          session: { id: params.sessionId, sessionData: params.sessionData },
          onPaymentCompleted: (result: SessionOutcome) => finish(result),
          onPaymentFailed: (result: SessionOutcome) => finish(result),
          onError: () => {
            if (!cancelled) setError(openFailed);
          },
        });
        if (cancelled || !container.current) return;
        dropin = new window.AdyenWeb.Dropin(checkout).mount(container.current);
      } catch (e) {
        if (!cancelled)
          setError(
            e instanceof Error && e.message.startsWith("We could not") ? e.message : openFailed,
          );
      }
    })();
    return () => {
      cancelled = true;
      dropin?.unmount();
    };
  }, [open, params, onSettle, setup]);

  return (
    <PaymentDialog
      open={open}
      onClose={() => onSettle({ status: "dismissed" })}
      title={setup ? setupTitle : "Pay"}
      description={
        setup
          ? setupText
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

/** The region of the browser's language (`en-US` → `US`), else `US`. */
function browserRegion(): string {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    return region && /^[A-Z]{2}$/.test(region) ? region : "US";
  } catch {
    return "US";
  }
}

/** The `adyen` loader for `openGatewaySdk`. Mounted in its own root, like the Braintree one. */
export function openAdyenDropin(
  params: Record<string, unknown>,
  context: GatewaySdkContext,
): Promise<GatewaySdkResult> {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const p = {
    clientKey: str(params.clientKey),
    environment: str(params.environment) || "test",
    sessionId: str(params.sessionId),
    sessionData: str(params.sessionData),
    countryCode: str(params.countryCode) || browserRegion(),
    methods: str(params.methods) || "scheme",
  };
  if (!p.clientKey || !p.sessionId || !p.sessionData)
    return Promise.resolve({
      status: "failed",
      message: `We could not open the ${context.purpose === "setup" ? "card" : "payment"} form. Contact the business.`,
    });
  const amountLabel =
    typeof params.amount === "string" && typeof params.currency === "string"
      ? `${params.amount} ${params.currency}`
      : null;
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const render = (open: boolean) =>
      root.render(
        <AdyenDropinDialog
          open={open}
          params={p}
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

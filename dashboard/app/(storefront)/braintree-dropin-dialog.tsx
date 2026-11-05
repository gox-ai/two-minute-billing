"use client";

import * as React from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import type { GatewaySdkContext, GatewaySdkResult } from "@/lib/gateway-sdk";
import { PaymentDialog } from "./payment-dialog";

/**
 * Braintree's Drop-in, pinned to an exact version with SRI. It loads its card fields
 * (iframes on assets.braintreegateway.com), a stylesheet, PayPal's and Venmo's buttons and
 * Cardinal's 3D Secure script itself; the CSP lists those hosts.
 */
const DROPIN_SRC = "https://js.braintreegateway.com/web/dropin/1.48.0/js/dropin.min.js";
// Measured 2026-10-25 (the file is dated 2026-09-10; the earlier value never matched).
const DROPIN_SRI = "sha384-p3+mVEfgBEFnRcczC8DVskFaVK22CKiBYSOBstELTgl34BcRrgHrMCLM7JX796H6";

interface DropinInstance {
  requestPaymentMethod(options?: Record<string, unknown>): Promise<{ nonce: string }>;
  teardown(): Promise<void>;
  on(event: "changeActiveView", handler: (e: { newViewId: string }) => void): void;
}

/** Our method types → Drop-in's payment option ids. */
const DROPIN_OPTION: Record<string, string> = { card: "card", paypal: "paypal", venmo: "venmo" };

/** The line under the title, for the method the buyer selected (null: none yet). */
function dialogDescription(
  purpose: GatewaySdkContext["purpose"],
  method: string | null,
  amountLabel: string | null,
): string {
  const pay = amountLabel ? ` ${amountLabel}` : "";
  if (purpose === "setup") {
    if (method === "card") return "Enter your card details. We check the card before we save it.";
    if (method === "paypal") return "Sign in to PayPal to save this payment method.";
    if (method === "venmo") return "Use the Venmo app to save this payment method.";
    return "Select a payment method.";
  }
  if (method === "card") return `Enter your card details to pay${pay}.`;
  if (method === "paypal") return `Sign in to PayPal to pay${pay}.`;
  if (method === "venmo") return `Use the Venmo app to pay${pay}.`;
  return `Select a payment method to pay${pay}.`;
}

interface DropinParams {
  clientToken: string;
  /** What the server offers for this intent; Drop-in hides any the merchant has not enabled. */
  methods: string[];
  /** Decimal amount and currency: the payment, or zero for a saved card's 3D Secure check. */
  amount: string | null;
  currency: string | null;
  email: string | null;
  billingCountry: string | null;
}

/**
 * Drop-in's options. 3D Secure runs only for cards. PayPal saves a billing agreement for a
 * saved method and pays once for a payment; Venmo is saved for reuse the same way.
 */
function dropinOptions(p: DropinParams, purpose: GatewaySdkContext["purpose"], tds: boolean) {
  const has = (m: string) => p.methods.includes(m);
  return {
    authorization: p.clientToken,
    paymentOptionPriority: p.methods.map((m) => DROPIN_OPTION[m]).filter(Boolean),
    // Our server vaults the method after it checks it; Drop-in must not save it first.
    vaultManager: false,
    card: has("card") ? { vault: { allowVaultCardOverride: false, vaultCard: false } } : false,
    ...(has("paypal")
      ? {
          paypal:
            purpose === "setup"
              ? { flow: "vault" }
              : { flow: "checkout", amount: p.amount, currency: p.currency },
        }
      : {}),
    ...(has("venmo")
      ? {
          venmo: {
            allowDesktop: true,
            paymentMethodUsage: purpose === "setup" ? "multi_use" : "single_use",
          },
        }
      : {}),
    ...(tds ? { threeDSecure: true } : {}),
  };
}
declare global {
  interface Window {
    braintree?: {
      dropin: {
        create(options: Record<string, unknown>): Promise<DropinInstance>;
      };
    };
  }
}

let loading: Promise<void> | null = null;
function loadDropin(): Promise<void> {
  if (window.braintree?.dropin) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = DROPIN_SRC;
    el.integrity = DROPIN_SRI;
    el.crossOrigin = "anonymous";
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      loading = null;
      reject(
        new Error("We could not connect to Braintree. Check your connection. Then try again."),
      );
    };
    document.head.appendChild(el);
  });
  return loading;
}

function BraintreeDropinDialog({
  open,
  params,
  purpose,
  email,
  onSettle,
}: {
  open: boolean;
  params: DropinParams;
  purpose: GatewaySdkContext["purpose"];
  email: string | null;
  onSettle: (result: GatewaySdkResult) => void;
}) {
  const container = React.useRef<HTMLDivElement>(null);
  const instance = React.useRef<DropinInstance | null>(null);
  /** Whether Drop-in was made with 3D Secure (a merchant without it fails to create). */
  const threeDs = React.useRef(false);
  const cardsOnly = params.methods.length === 1 && params.methods[0] === "card";
  const amountLabel =
    purpose === "payment" && params.amount && params.currency
      ? `${params.amount} ${params.currency}`
      : null;
  const [ready, setReady] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  /** Drop-in's selected option. With one method there is no choice to make. */
  const [picked, setSelected] = React.useState<string | null>(null);
  const selected = params.methods.length === 1 ? (params.methods[0] ?? null) : picked;

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        await loadDropin();
        if (cancelled || !container.current || !window.braintree) return;
        const create = (tds: boolean) =>
          window.braintree!.dropin.create({
            ...dropinOptions(params, purpose, tds),
            container: container.current,
          });
        const withCards = params.methods.includes("card");
        try {
          instance.current = await create(withCards);
          threeDs.current = withCards;
        } catch (e) {
          if (!withCards) throw e;
          // 3D Secure is not on for this merchant account: cards work without it.
          console.warn("Braintree Drop-in: created without 3D Secure", e);
          if (container.current) container.current.innerHTML = "";
          instance.current = await create(false);
          threeDs.current = false;
        }
        // `options` is the list of methods: nothing selected. Other views keep the last one.
        instance.current.on("changeActiveView", ({ newViewId }) => {
          if (newViewId === "options") setSelected(null);
          else if (newViewId in DROPIN_OPTION) setSelected(newViewId);
        });
        if (!cancelled) setReady(true);
      } catch (e) {
        if (!cancelled)
          setError(
            e instanceof Error && e.message.startsWith("We could not")
              ? e.message
              : "We could not open the payment form. Try again.",
          );
      }
    })();
    return () => {
      cancelled = true;
      void instance.current?.teardown().catch(() => undefined);
      instance.current = null;
    };
  }, [open, params, purpose]);

  const submit = async () => {
    if (!instance.current) return;
    setBusy(true);
    setError(null);
    try {
      // Drop-in runs 3D Secure on a card only; PayPal and Venmo ignore these options.
      const { nonce } = await instance.current.requestPaymentMethod(
        threeDs.current && params.amount
          ? {
              threeDSecure: {
                amount: params.amount,
                ...((params.email ?? email) ? { email: params.email ?? email } : {}),
                ...(params.billingCountry
                  ? { billingAddress: { countryCodeAlpha2: params.billingCountry } }
                  : {}),
                // A saved card is charged later without the buyer: ask the issuer for a
                // challenge now, which sets up the mandate for those charges.
                ...(purpose === "setup" ? { challengeRequested: true } : {}),
              },
            }
          : undefined,
      );
      onSettle({ status: "completed", clientResult: { nonce } });
    } catch {
      // Drop-in shows the field errors itself; the buyer corrects them and tries again.
      setBusy(false);
    }
  };

  return (
    <PaymentDialog
      open={open}
      onClose={() => onSettle({ status: "dismissed" })}
      title={
        purpose === "setup"
          ? cardsOnly
            ? "Add a card"
            : "Add a payment method"
          : cardsOnly
            ? "Pay by card"
            : "Pay"
      }
      description={dialogDescription(purpose, selected, amountLabel)}
    >
      <div ref={container} className="min-h-40" />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => onSettle({ status: "dismissed" })}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!ready || busy}>
          {busy ? "Checking…" : purpose === "setup" ? (cardsOnly ? "Save card" : "Save") : "Pay"}
        </Button>
      </div>
    </PaymentDialog>
  );
}

/** The `braintree` loader for `openGatewaySdk`. Mounted in its own root, like the test gateway's. */
export function openBraintreeDropin(
  params: Record<string, unknown>,
  context: GatewaySdkContext,
): Promise<GatewaySdkResult> {
  const clientToken = typeof params.clientToken === "string" ? params.clientToken : "";
  if (!clientToken)
    return Promise.resolve({
      status: "failed",
      message: "We could not open the payment form. Contact the business.",
    });
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const methods = Array.isArray(params.methods)
    ? params.methods.filter((m): m is string => typeof m === "string" && m in DROPIN_OPTION)
    : [];
  const dropin: DropinParams = {
    clientToken,
    // A challenge from before PayPal and Venmo names no methods: cards only.
    methods: methods.length ? methods : ["card"],
    amount: str(params.amount),
    currency: str(params.currency),
    email: str(params.email),
    billingCountry: str(params.billingCountry),
  };
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const render = (open: boolean) =>
      root.render(
        <BraintreeDropinDialog
          open={open}
          params={dropin}
          purpose={context.purpose}
          email={context.prefill?.email ?? null}
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

"use client";

import * as React from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { GatewaySdkContext, GatewaySdkResult } from "@/lib/gateway-sdk";
import { useDefaultState } from "@/lib/use-default-state";
import { PaymentDialog } from "./payment-dialog";

/**
 * Square's Web Payments SDK. Square publishes one unversioned URL per environment and no SRI
 * hash, and PCI requires loading it from their host, so it cannot be pinned. The card fields
 * render in Square's iframe. Pay now also offers the methods the SDK reports as available for
 * this location (Apple Pay, Google Pay, Cash App Pay, Afterpay, ACH); saving a card offers
 * cards only. The script URL is chosen HERE from `environment`, never taken from the server.
 */
const SCRIPT = {
  sandbox: "https://sandbox.web.squarecdn.com/v1/square.js",
  production: "https://web.squarecdn.com/v1/square.js",
} as const;

interface TokenResult {
  status?: string;
  token?: string;
  errors?: Array<{ field?: string; type?: string }>;
}
/** Errors the card fields show themselves. */
const CARD_FIELDS = new Set(["cardNumber", "expirationDate", "cvv", "postalCode"]);

interface TokenEvent {
  detail?: { tokenResult?: TokenResult; error?: unknown };
}
interface SqMethod {
  attach?(el: HTMLElement | string): Promise<void>;
  tokenize(options?: Record<string, unknown>): Promise<TokenResult>;
  destroy?(): Promise<void>;
  addEventListener?(name: string, fn: (e: TokenEvent) => void): void;
}
interface SqPayments {
  card(): Promise<SqMethod>;
  paymentRequest(r: Record<string, unknown>): unknown;
  googlePay(r: unknown): Promise<SqMethod>;
  applePay(r: unknown): Promise<SqMethod>;
  cashAppPay(r: unknown, o: Record<string, unknown>): Promise<SqMethod>;
  afterpayClearpay(r: unknown): Promise<SqMethod>;
  ach(o: Record<string, unknown>): Promise<SqMethod>;
}
declare global {
  interface Window {
    Square?: {
      payments(applicationId: string, locationId: string): Promise<SqPayments> | SqPayments;
    };
  }
}

const loading = new Map<string, Promise<void>>();
function loadSquare(src: string): Promise<void> {
  if (window.Square) return Promise.resolve();
  let p = loading.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => {
        loading.delete(src);
        reject(new Error("We could not connect to Square. Check your connection. Then try again."));
      };
      document.head.appendChild(el);
    });
    loading.set(src, p);
  }
  return p;
}

interface Params {
  applicationId: string;
  locationId: string;
  environment: "sandbox" | "production";
  countryCode: string;
  currency: string;
  amount: string | null;
  methods: string[];
}

type Extra = "apple_pay" | "google_pay" | "cash_app_pay" | "afterpay" | "ach";

function SquarePaymentsDialog({
  open,
  params,
  context,
  amountLabel,
  onSettle,
}: {
  open: boolean;
  params: Params;
  context: GatewaySdkContext;
  amountLabel: string | null;
  onSettle: (result: GatewaySdkResult) => void;
}) {
  const purpose = context.purpose;
  const cardEl = React.useRef<HTMLDivElement>(null);
  const googleEl = React.useRef<HTMLDivElement>(null);
  const cashEl = React.useRef<HTMLDivElement>(null);
  const afterpayEl = React.useRef<HTMLDivElement>(null);
  const card = React.useRef<SqMethod | null>(null);
  const extras = React.useRef<Partial<Record<Extra, SqMethod>>>({});
  const [ready, setReady] = React.useState(false);
  const [offered, setOffered] = React.useState<Extra[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [holder, setHolder] = useDefaultState(context.prefill?.name ?? "");

  const done = React.useCallback(
    (token: string | undefined, method: string) => {
      if (token) onSettle({ status: "completed", clientResult: { token, method } });
      else {
        setBusy(false);
        setError("We could not read the payment details. Try again, or use a different method.");
      }
    },
    [onSettle],
  );

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const made: SqMethod[] = [];
    (async () => {
      try {
        await loadSquare(SCRIPT[params.environment]);
        if (cancelled || !window.Square || !cardEl.current) return;
        const payments = await window.Square.payments(params.applicationId, params.locationId);
        const c = await payments.card();
        made.push(c);
        if (cancelled) return;
        await c.attach!(cardEl.current);
        card.current = c;
        setReady(true);
        if (purpose !== "payment" || !params.amount) return;
        const request = () =>
          payments.paymentRequest({
            countryCode: params.countryCode,
            currencyCode: params.currency,
            total: { amount: params.amount, label: context.businessName || "Total" },
          });
        const wants = (m: string) => params.methods.includes(m);
        // Each method shows only when Square says it is available here; a refusal hides it.
        const tries: Array<[Extra, () => Promise<SqMethod>]> = [];
        if (wants("google_pay"))
          tries.push([
            "google_pay",
            async () => {
              const g = await payments.googlePay(request());
              await g.attach!(googleEl.current!);
              return g;
            },
          ]);
        if (wants("apple_pay")) tries.push(["apple_pay", () => payments.applePay(request())]);
        if (wants("cash_app_pay"))
          tries.push([
            "cash_app_pay",
            async () => {
              const k = await payments.cashAppPay(request(), {
                redirectURL: window.location.href,
              });
              k.addEventListener?.("ontokenization", (e) => {
                const r = e.detail?.tokenResult;
                done(r?.status === "OK" ? r.token : undefined, "cash_app_pay");
              });
              await k.attach!(cashEl.current!);
              return k;
            },
          ]);
        if (wants("afterpay"))
          tries.push([
            "afterpay",
            async () => {
              const a = await payments.afterpayClearpay(request());
              await a.attach!(afterpayEl.current!);
              return a;
            },
          ]);
        if (wants("ach"))
          tries.push([
            "ach",
            async () => {
              const b = await payments.ach({
                redirectURI: window.location.origin + window.location.pathname,
                transactionId: crypto.randomUUID(),
              });
              b.addEventListener?.("ontokenization", (e) => {
                const r = e.detail?.tokenResult;
                done(r?.status === "OK" ? r.token : undefined, "ach");
              });
              return b;
            },
          ]);
        const shown: Extra[] = [];
        for (const [name, make] of tries) {
          try {
            const m = await make();
            made.push(m);
            extras.current[name] = m;
            shown.push(name);
          } catch {
            // Not available for this buyer, browser or location.
          }
        }
        if (!cancelled) setOffered(shown);
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
      for (const m of made) void m.destroy?.().catch(() => undefined);
      card.current = null;
      extras.current = {};
    };
  }, [open, params, purpose, context.businessName, done]);

  const names = (context.prefill?.name ?? "").trim().split(/\s+/);
  const verification = {
    intent: purpose === "setup" ? "STORE" : "CHARGE",
    // STORE refuses `currencyCode` (measured: VALIDATION_ERROR on verificationDetails.currencyCode).
    ...(purpose === "payment"
      ? { currencyCode: params.currency, ...(params.amount ? { amount: params.amount } : {}) }
      : {}),
    billingContact: {
      ...(names[0] ? { givenName: names[0] } : {}),
      ...(names.length > 1 ? { familyName: names.slice(1).join(" ") } : {}),
      ...(context.prefill?.email ? { email: context.prefill.email } : {}),
    },
    customerInitiated: true,
    sellerKeyedIn: false,
  };

  const run = async (method: string, tokenize: () => Promise<TokenResult>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await tokenize();
      if (r.status === "OK") done(r.token, method);
      else {
        setBusy(false);
        // The card fields show their own errors. Any other refusal shows nowhere, so say so.
        const errors = r.errors ?? [];
        const onFields = errors.length > 0 && errors.every((e) => CARD_FIELDS.has(e.field ?? ""));
        if (!onFields)
          setError("We could not complete the check. Try again, or use a different method.");
      }
    } catch {
      setBusy(false);
      setError("We could not complete the check. Try again, or use a different method.");
    }
  };

  const extra = (name: Extra) => extras.current[name];

  return (
    <PaymentDialog
      open={open}
      onClose={() => onSettle({ status: "dismissed" })}
      title={purpose === "setup" ? "Add a card" : "Pay"}
      description={
        purpose === "setup"
          ? "Enter your card details. We check the card before we save it."
          : `Select how to pay${amountLabel ? ` ${amountLabel}` : ""}.`
      }
    >
      <div className="flex flex-col gap-3">
        <div
          ref={googleEl}
          hidden={!offered.includes("google_pay")}
          onClick={() => {
            const g = extra("google_pay");
            if (g && !busy) void run("google_pay", () => g.tokenize());
          }}
        />
        {offered.includes("apple_pay") ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => run("apple_pay", () => extra("apple_pay")!.tokenize())}
          >
            Pay with Apple Pay
          </Button>
        ) : null}
        <div
          ref={afterpayEl}
          hidden={!offered.includes("afterpay")}
          onClick={() => {
            const a = extra("afterpay");
            if (a && !busy) void run("afterpay", () => a.tokenize());
          }}
        />
        <div ref={cashEl} hidden={!offered.includes("cash_app_pay")} />
        <div ref={cardEl} className="min-h-24" />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {offered.includes("ach") ? (
          <div className="flex flex-col gap-2 border-t pt-3">
            <Label htmlFor="sq-ach-holder">Account holder name</Label>
            <Input
              id="sq-ach-holder"
              value={holder}
              onChange={(e) => setHolder(e.target.value)}
              autoComplete="name"
            />
            <Button
              variant="outline"
              disabled={busy || !holder.trim()}
              onClick={() => {
                const b = extra("ach");
                if (!b) return;
                setBusy(true);
                setError(null);
                // The token arrives on `ontokenization` after the buyer finishes with their bank.
                void b
                  .tokenize({
                    accountHolderName: holder.trim(),
                    intent: "CHARGE",
                    amount: params.amount,
                    currency: params.currency,
                  })
                  .catch(() => {
                    setBusy(false);
                    setError(
                      "We could not connect to your bank. Try again, or use a different method.",
                    );
                  });
              }}
            >
              Pay by bank account (ACH)
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => onSettle({ status: "dismissed" })}>
          Cancel
        </Button>
        <Button
          onClick={() => {
            const c = card.current;
            if (c) void run("card", () => c.tokenize(verification));
          }}
          disabled={!ready || busy}
        >
          {busy ? "Checking…" : purpose === "setup" ? "Save card" : "Pay by card"}
        </Button>
      </div>
    </PaymentDialog>
  );
}

/** The `square` loader for `openGatewaySdk`. Mounted in its own root, like Braintree's. */
export function openSquarePayments(
  raw: Record<string, unknown>,
  context: GatewaySdkContext,
): Promise<GatewaySdkResult> {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const params: Params = {
    applicationId: str(raw.applicationId),
    locationId: str(raw.locationId),
    environment: raw.environment === "production" ? "production" : "sandbox",
    countryCode: str(raw.countryCode) || "US",
    currency: str(raw.currency) || "USD",
    amount: str(raw.amount) || null,
    methods: Array.isArray(raw.methods)
      ? raw.methods.filter((m): m is string => typeof m === "string")
      : ["card"],
  };
  if (!params.applicationId || !params.locationId)
    return Promise.resolve({
      status: "failed",
      message: "We could not open the payment form. Contact the business.",
    });
  const amountLabel = params.amount ? `${params.amount} ${params.currency}` : null;
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const render = (open: boolean) =>
      root.render(
        <SquarePaymentsDialog
          open={open}
          params={params}
          context={context}
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

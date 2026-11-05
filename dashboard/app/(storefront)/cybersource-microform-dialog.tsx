"use client";

import * as React from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { GatewaySdkContext, GatewaySdkResult } from "@/lib/gateway-sdk";
import { PaymentDialog } from "./payment-dialog";

/**
 * CyberSource Microform. The card number and security code are entered in CyberSource's own
 * iframes (PCI SAQ A); we get a transient token back and post it as `client_result` with the
 * billing address, which CyberSource requires on the card check.
 *
 * The script URL and its SRI hash come from the capture context, as CyberSource requires;
 * only its two Microform hosts are accepted. The capture context may also allow a bank
 * account (`paymentTypes` has CHECK). This form offers cards only until a NACHA authorization
 * text is in place (`achAuthorizationRequired`).
 */
const FLEX_ORIGINS = new Set(["https://testflex.cybersource.com", "https://flex.cybersource.com"]);

interface MicroformField {
  load(target: HTMLElement | string): void;
}
interface Microform {
  createField(name: "number" | "securityCode", options?: Record<string, unknown>): MicroformField;
  createToken(
    options: Record<string, string>,
    cb: (err: { message?: string } | null, token?: string) => void,
  ): void;
}
interface FlexInstance {
  microform(type: string, options?: Record<string, unknown>): Microform;
}
declare global {
  interface Window {
    Flex?: new (captureContext: string) => FlexInstance;
  }
}

const loaded = new Map<string, Promise<void>>();
function loadScript(src: string, integrity: string | null): Promise<void> {
  if (window.Flex) return Promise.resolve();
  let p = loaded.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.async = true;
      if (integrity) el.integrity = integrity;
      el.crossOrigin = "anonymous";
      el.onload = () => resolve();
      el.onerror = () => {
        loaded.delete(src);
        reject(
          new Error("We could not connect to CyberSource. Check your connection. Then try again."),
        );
      };
      document.head.appendChild(el);
    });
    loaded.set(src, p);
  }
  return p;
}

interface Params {
  captureContext: string;
  clientLibrary: string;
  clientLibraryIntegrity: string | null;
}

const BILLING: Array<{ key: string; label: string; autoComplete: string; wide?: boolean }> = [
  { key: "firstName", label: "First name", autoComplete: "given-name" },
  { key: "lastName", label: "Last name", autoComplete: "family-name" },
  { key: "address1", label: "Address", autoComplete: "address-line1", wide: true },
  { key: "locality", label: "City", autoComplete: "address-level2" },
  { key: "administrativeArea", label: "State or province", autoComplete: "address-level1" },
  { key: "postalCode", label: "ZIP or postal code", autoComplete: "postal-code" },
  { key: "country", label: "Country code", autoComplete: "country" },
];

function CybersourceMicroformDialog({
  open,
  params,
  purpose,
  amountLabel,
  prefill,
  onSettle,
}: {
  open: boolean;
  params: Params;
  purpose: GatewaySdkContext["purpose"];
  amountLabel: string | null;
  prefill: GatewaySdkContext["prefill"];
  onSettle: (result: GatewaySdkResult) => void;
}) {
  const numberRef = React.useRef<HTMLDivElement>(null);
  const cvvRef = React.useRef<HTMLDivElement>(null);
  const microform = React.useRef<Microform | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  const [values, setValues] = React.useState<Record<string, string>>(() => {
    const [first, ...rest] = (prefill?.name ?? "").trim().split(/\s+/);
    return {
      firstName: first ?? "",
      lastName: rest.join(" "),
      email: prefill?.email ?? "",
      expMonth: "",
      expYear: "",
    };
  });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [k]: e.target.value }));

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        await loadScript(params.clientLibrary, params.clientLibraryIntegrity);
        if (cancelled || !window.Flex || !numberRef.current || !cvvRef.current) return;
        const flex = new window.Flex(params.captureContext);
        const styles = { input: { "font-size": "14px" } };
        const mf = flex.microform("card", { styles });
        mf.createField("number", { placeholder: "Card number" }).load(numberRef.current);
        mf.createField("securityCode", { placeholder: "CVV" }).load(cvvRef.current);
        microform.current = mf;
        setReady(true);
      } catch (e) {
        if (!cancelled)
          setError(
            e instanceof Error && e.message.startsWith("We could not")
              ? e.message
              : "We could not open the card form. Try again.",
          );
      }
    })();
    return () => {
      cancelled = true;
      microform.current = null;
    };
  }, [open, params]);

  const submit = () => {
    const mf = microform.current;
    if (!mf) return;
    const month = values.expMonth.trim().padStart(2, "0");
    const year = values.expYear.trim();
    const missing = ["firstName", "lastName", "address1", "locality", "postalCode", "country"].some(
      (k) => !(values[k] ?? "").trim(),
    );
    if (missing || !/^(0[1-9]|1[0-2])$/.test(month) || !/^\d{4}$/.test(year)) {
      setError("Correct the highlighted fields.");
      return;
    }
    setBusy(true);
    setError(null);
    mf.createToken({ expirationMonth: month, expirationYear: year }, (err, token) => {
      setBusy(false);
      if (err || !token) {
        setError("We could not read the card details. Examine them and try again.");
        return;
      }
      const clientResult: Record<string, string> = { transientToken: token };
      for (const k of [...BILLING.map((b) => b.key), "email"]) {
        const v = (values[k] ?? "").trim();
        if (v) clientResult[k] = v;
      }
      onSettle({ status: "completed", clientResult });
    });
  };

  const invalid = (k: string) => error !== null && !(values[k] ?? "").trim();

  return (
    <PaymentDialog
      open={open}
      onClose={() => onSettle({ status: "dismissed" })}
      title={purpose === "setup" ? "Add a card" : "Pay by card"}
      description={
        purpose === "setup"
          ? "Enter your card details. We check the card before we save it."
          : `Enter your card details to pay${amountLabel ? ` ${amountLabel}` : ""}.`
      }
    >
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label>Card number</Label>
          <div ref={numberRef} className="h-9 rounded-md border border-input px-3 py-2" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="cybs-exp-month">Month (MM)</Label>
            <Input
              id="cybs-exp-month"
              inputMode="numeric"
              maxLength={2}
              autoComplete="cc-exp-month"
              value={values.expMonth}
              onChange={set("expMonth")}
              aria-invalid={error !== null && !/^(0?[1-9]|1[0-2])$/.test(values.expMonth.trim())}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cybs-exp-year">Year (YYYY)</Label>
            <Input
              id="cybs-exp-year"
              inputMode="numeric"
              maxLength={4}
              autoComplete="cc-exp-year"
              value={values.expYear}
              onChange={set("expYear")}
              aria-invalid={error !== null && !/^\d{4}$/.test(values.expYear.trim())}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>CVV</Label>
            <div ref={cvvRef} className="h-9 rounded-md border border-input px-3 py-2" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {BILLING.map((b) => (
            <div key={b.key} className={b.wide ? "col-span-2 grid gap-1.5" : "grid gap-1.5"}>
              <Label htmlFor={`cybs-${b.key}`}>{b.label}</Label>
              <Input
                id={`cybs-${b.key}`}
                autoComplete={b.autoComplete}
                maxLength={b.key === "country" ? 2 : 60}
                value={values[b.key] ?? ""}
                onChange={set(b.key)}
                aria-invalid={b.key !== "administrativeArea" && invalid(b.key)}
              />
            </div>
          ))}
        </div>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => onSettle({ status: "dismissed" })}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!ready || busy}>
          {purpose === "setup" ? "Save card" : amountLabel ? `Pay ${amountLabel}` : "Pay"}
        </Button>
      </div>
    </PaymentDialog>
  );
}

/** The `cybersource` loader for `openGatewaySdk`. Mounted in its own root, like Checkout.com's. */
export function openCybersourceMicroform(
  params: Record<string, unknown>,
  context: GatewaySdkContext,
): Promise<GatewaySdkResult> {
  const captureContext = typeof params.captureContext === "string" ? params.captureContext : "";
  const clientLibrary = typeof params.clientLibrary === "string" ? params.clientLibrary : "";
  let origin = "";
  try {
    origin = new URL(clientLibrary).origin;
  } catch {
    origin = "";
  }
  if (!captureContext || !FLEX_ORIGINS.has(origin))
    return Promise.resolve({
      status: "failed",
      message: "We could not open the card form. Contact the business.",
    });
  const amountLabel =
    typeof params.amount === "string" && typeof params.currency === "string"
      ? `${params.amount} ${params.currency}`
      : null;
  const mfParams: Params = {
    captureContext,
    clientLibrary,
    clientLibraryIntegrity:
      typeof params.clientLibraryIntegrity === "string" ? params.clientLibraryIntegrity : null,
  };
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const render = (open: boolean) =>
      root.render(
        <CybersourceMicroformDialog
          open={open}
          params={mfParams}
          purpose={context.purpose}
          amountLabel={amountLabel}
          prefill={context.prefill}
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

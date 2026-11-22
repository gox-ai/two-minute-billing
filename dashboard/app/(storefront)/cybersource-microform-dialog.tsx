"use client";

import * as React from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectField } from "@/components/ui/select-field";
import { Combobox } from "@/components/ui/combobox";
import { contactBusiness, microformFailure } from "@/lib/gateway-errors";
import type { GatewaySdkContext, GatewaySdkResult } from "@/lib/gateway-sdk";
import { SdkFrame, PaymentDialogFooter, PaymentPrivacyNote, RefusalAlert } from "./payment-dialog";
import { countryOptions, sdkAmountLabel } from "./storefront-text";

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
    cb: (
      err: { message?: string; details?: Array<{ location?: string; message?: string }> } | null,
      token?: string,
    ) => void,
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
        reject(new Error("We could not load the payment form. Reload the page. Then try again."));
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
  { key: "firstName", label: "First name", autoComplete: "billing given-name" },
  { key: "lastName", label: "Last name", autoComplete: "billing family-name" },
  { key: "address1", label: "Address", autoComplete: "billing address-line1", wide: true },
  { key: "locality", label: "City", autoComplete: "billing address-level2" },
  { key: "administrativeArea", label: "State or province", autoComplete: "billing address-level1" },
  { key: "postalCode", label: "ZIP or postal code", autoComplete: "billing postal-code" },
];
/** CyberSource refuses the card check without these. */
const REQUIRED = ["firstName", "lastName", "address1", "locality", "postalCode", "country"];

const MONTHS = Array.from({ length: 12 }, (_, i) => {
  const v = String(i + 1).padStart(2, "0");
  return { value: v, label: v };
});
const YEARS = (() => {
  const now = new Date().getFullYear();
  return Array.from({ length: 21 }, (_, i) => ({ value: String(now + i), label: String(now + i) }));
})();

/**
 * What a hosted page may hand a gateway dialog beyond `GatewaySdkContext`: the billing
 * address it already took, and the label its own commit button uses ("Subscribe").
 */
type SdkExtras = {
  prefill?: {
    address?: {
      line1?: string | null;
      city?: string | null;
      state?: string | null;
      state_code?: string | null;
      postal_code?: string | null;
      country?: string | null;
    } | null;
  };
  confirmLabel?: string;
};

function CybersourceMicroformDialog({
  open,
  inline,
  params,
  context,
  amountLabel,
  onSettle,
}: {
  open: boolean;
  inline: boolean;
  params: Params;
  context: GatewaySdkContext;
  amountLabel: string | null;
  onSettle: (result: GatewaySdkResult) => void;
}) {
  const purpose = context.purpose;
  const prefill = context.prefill;
  const address = (context as GatewaySdkContext & SdkExtras).prefill?.address ?? null;
  const confirmLabel = (context as GatewaySdkContext & SdkExtras).confirmLabel;
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
      address1: address?.line1 ?? "",
      locality: address?.city ?? "",
      administrativeArea: address?.state_code || address?.state || "",
      postalCode: address?.postal_code ?? "",
      country: (address?.country ?? "").toUpperCase(),
      expMonth: "",
      expYear: "",
    };
  });
  // The page already took the name and address: show them as one line, editable on request.
  const [editBilling, setEditBilling] = React.useState(
    () => !REQUIRED.every((k) => (values[k] ?? "").trim()),
  );
  const countries = React.useMemo(() => countryOptions(), []);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [k]: e.target.value }));
  const setValue = (k: string) => (v: string) => setValues((prev) => ({ ...prev, [k]: v }));

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
        mf.createField("number", { placeholder: "1234 1234 1234 1234" }).load(numberRef.current);
        mf.createField("securityCode", { placeholder: "123" }).load(cvvRef.current);
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
    const month = values.expMonth;
    const year = values.expYear;
    const missing = REQUIRED.some((k) => !(values[k] ?? "").trim());
    if (missing || !month || !year) {
      if (missing) setEditBilling(true);
      setError("Correct the highlighted fields.");
      return;
    }
    setBusy(true);
    setError(null);
    mf.createToken({ expirationMonth: month, expirationYear: year }, (err, token) => {
      setBusy(false);
      if (err || !token) {
        setError(microformFailure(err));
        return;
      }
      const clientResult: Record<string, string> = { transientToken: token };
      for (const k of [...BILLING.map((b) => b.key), "country", "email"]) {
        const v = (values[k] ?? "").trim();
        if (v) clientResult[k] = v;
      }
      onSettle({ status: "completed", clientResult });
    });
  };

  const invalid = (k: string) => error !== null && !(values[k] ?? "").trim();
  const countryName = countries.find((c) => c.value === values.country)?.label ?? values.country;
  const billingLine = [
    [values.firstName, values.lastName].filter(Boolean).join(" "),
    values.address1,
    [values.locality, values.administrativeArea, values.postalCode].filter(Boolean).join(" "),
    countryName,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <SdkFrame
      inline={inline}
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
        <div className="grid grid-cols-3 items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="cybs-exp-month">Expiration month</Label>
            <SelectField
              id="cybs-exp-month"
              options={MONTHS}
              value={values.expMonth}
              onValueChange={setValue("expMonth")}
              placeholder="Month"
              aria-invalid={invalid("expMonth")}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cybs-exp-year">Expiration year</Label>
            <SelectField
              id="cybs-exp-year"
              options={YEARS}
              value={values.expYear}
              onValueChange={setValue("expYear")}
              placeholder="Year"
              aria-invalid={invalid("expYear")}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Security code</Label>
            <div ref={cvvRef} className="h-9 rounded-md border border-input px-3 py-2" />
          </div>
        </div>
        {editBilling ? (
          <fieldset className="grid grid-cols-2 gap-3">
            <legend className="mb-2 text-sm font-medium">Billing address</legend>
            {BILLING.map((b) => (
              <div key={b.key} className={b.wide ? "col-span-2 grid gap-1.5" : "grid gap-1.5"}>
                <Label htmlFor={`cybs-${b.key}`}>{b.label}</Label>
                <Input
                  id={`cybs-${b.key}`}
                  autoComplete={b.autoComplete}
                  maxLength={60}
                  value={values[b.key] ?? ""}
                  onChange={set(b.key)}
                  aria-invalid={b.key !== "administrativeArea" && invalid(b.key)}
                />
              </div>
            ))}
            <div className="col-span-2 grid gap-1.5">
              <Label htmlFor="cybs-country">Country</Label>
              <Combobox
                id="cybs-country"
                options={countries.map((c) => ({ ...c, keywords: c.value }))}
                value={values.country}
                onValueChange={setValue("country")}
                ariaLabel="Country"
                placeholder="Select a country…"
                searchPlaceholder="Search country or code…"
                emptyMessage="No matching country."
                aria-invalid={invalid("country")}
              />
            </div>
          </fieldset>
        ) : (
          <div className="flex items-start justify-between gap-3 rounded-md bg-muted/50 px-3 py-2.5 text-sm">
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">Billing address</div>
              <div className="mt-0.5">{billingLine}</div>
            </div>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto shrink-0 p-0"
              onClick={() => setEditBilling(true)}
            >
              Change
            </Button>
          </div>
        )}
        <PaymentPrivacyNote business={context.businessName} />
      </div>
      <RefusalAlert message={error} gateway="cybersource" />
      <PaymentDialogFooter>
        {inline ? null : (
          <Button variant="outline" onClick={() => onSettle({ status: "dismissed" })}>
            Cancel
          </Button>
        )}
        <Button onClick={submit} disabled={!ready || busy}>
          {confirmLabel ??
            (purpose === "setup" ? "Save card" : amountLabel ? `Pay ${amountLabel}` : "Pay")}
        </Button>
      </PaymentDialogFooter>
    </SdkFrame>
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
      message: `We could not open the card form. ${contactBusiness(context.businessName)}`,
    });
  const amountLabel = sdkAmountLabel(params.amount, params.currency);
  const mfParams: Params = {
    captureContext,
    clientLibrary,
    clientLibraryIntegrity:
      typeof params.clientLibraryIntegrity === "string" ? params.clientLibraryIntegrity : null,
  };
  return new Promise((resolve) => {
    const inline = Boolean(context.inline);
    const host = context.inline ?? document.createElement("div");
    if (!inline) document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const render = (open: boolean) =>
      root.render(
        <CybersourceMicroformDialog
          open={open}
          inline={inline}
          params={mfParams}
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
        if (!inline) host.remove();
      }, 300);
    };
    render(true);
  });
}

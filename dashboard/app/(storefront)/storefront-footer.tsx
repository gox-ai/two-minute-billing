"use client";

import * as React from "react";
import { Mail, ShieldCheck } from "lucide-react";
import { privacyText, supportEmail, websiteLink, type Instrument } from "./storefront-text";

const BANK_ACCOUNT_TYPES = new Set([
  "bank_transfer",
  "us_bank_account",
  "sepa_debit",
  "bacs_debit",
  "au_becs_debit",
  "nz_becs_debit",
  "acss_debit",
  "autogiro",
  "betalingsservice",
  "payto",
]);

const InstrumentContext = React.createContext<React.Dispatch<
  React.SetStateAction<Instrument>
> | null>(null);
const InstrumentValue = React.createContext<Instrument>("card");

export function StorefrontInstrumentProvider({ children }: { children: React.ReactNode }) {
  const [instrument, setInstrument] = React.useState<Instrument>("card");
  return (
    <InstrumentContext.Provider value={setInstrument}>
      <InstrumentValue.Provider value={instrument}>{children}</InstrumentValue.Provider>
    </InstrumentContext.Provider>
  );
}

/** A method chooser reports the selected method type; it resets to card when it unmounts. */
export function useReportInstrument(methodType: string) {
  const set = React.useContext(InstrumentContext);
  const instrument: Instrument =
    methodType === "card" ? "card" : BANK_ACCOUNT_TYPES.has(methodType) ? "bank" : "other";
  React.useEffect(() => {
    if (!set) return;
    set(instrument);
    return () => set("card");
  }, [set, instrument]);
}

/**
 * The page footer: who never sees the buyer's payment details, and how to reach the business.
 * `secure={false}` on a page where nothing is entered or bought. Contact lines render only
 * when the business has set them.
 */
export function StorefrontFooter({
  business,
  supportEmail: email,
  website,
  secure = true,
}: {
  business: string;
  supportEmail?: string | null;
  website?: string | null;
  secure?: boolean;
}) {
  const instrument = React.useContext(InstrumentValue);
  const mail = supportEmail(email);
  const site = websiteLink(website);
  if (!secure && !mail && !site) return null;
  return (
    <footer className="flex flex-col items-center gap-1.5 px-4 pb-2 text-center text-xs text-muted-foreground">
      {secure ? (
        <p className="flex items-start justify-center gap-2">
          <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{privacyText(business, instrument)}</span>
        </p>
      ) : null}
      {mail || site ? (
        <p className="flex flex-col items-center gap-1 sm:flex-row sm:flex-wrap sm:justify-center sm:gap-x-2">
          <span className="flex items-center gap-2">
            <Mail className="size-3.5 shrink-0" aria-hidden />
            Contact {business}:
          </span>
          {mail ? (
            <a href={`mailto:${mail}`} className="text-primary hover:underline">
              {mail}
            </a>
          ) : null}
          {mail && site ? (
            <span aria-hidden className="hidden sm:inline">
              ·
            </span>
          ) : null}
          {site ? (
            <a
              href={site.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              {site.label}
            </a>
          ) : null}
        </p>
      ) : null}
    </footer>
  );
}

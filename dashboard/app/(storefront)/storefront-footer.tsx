"use client";

import * as React from "react";
import { ShieldCheck } from "lucide-react";

/** What the buyer enters now: the footer names it. */
type Instrument = "card" | "bank" | "other";

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

const WHAT: Record<Instrument, string> = {
  card: "Your card details",
  bank: "Your bank account details",
  other: "Your payment details",
};

/** The one claim worth making on a hosted page, and it is true: we never see the PAN. */
export function StorefrontFooter({ business }: { business: string }) {
  const instrument = React.useContext(InstrumentValue);
  return (
    <footer className="flex items-start justify-center gap-2 px-4 pb-2 text-center text-xs text-muted-foreground">
      <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>
        {WHAT[instrument]} go directly to the payment provider. They never reach {business}&apos;s
        servers.
      </span>
    </footer>
  );
}

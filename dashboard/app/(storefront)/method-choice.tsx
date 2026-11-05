"use client";

import * as React from "react";
import { CreditCard, Landmark, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import { RadioGroup, RadioOption } from "@/components/ui/radio-group";
import { PaymentMark } from "@/components/brand/payment-mark";
import { Glyph } from "./chrome";

/**
 * WHERE future invoices get paid from — the rail chooser both hosted surfaces show
 * before they start a vault setup (the portal's "Add a payment method" block and the
 * checkout's card step).
 *
 * One component because it was two: the checkout's copy was ported from the portal's
 * (0186) and they were already drifting — same three rails, same wording, two sets of
 * markup, so every change to the buyer's most consequential choice had to be made twice.
 * The `notice` slot is what kept them apart (the checkout has a second, cap-related
 * warning the portal's endpoint cannot report), so it is a prop rather than a fork.
 *
 * The advice renders INSIDE the selected option, not under the group: it is a fact about
 * the rail the buyer just picked, and under the group it read as a page-level warning
 * about all three.
 */
/** The engine's buyer method types (`BUYER_METHOD_TYPES` in src/providers/method-types.ts). */
export type MethodType =
  | "card"
  | "upi"
  | "wallet"
  | "bank_transfer"
  | "paypal"
  | "venmo"
  | "us_bank_account"
  | "sepa_debit"
  | "bacs_debit"
  | "au_becs_debit"
  | "nz_becs_debit"
  | "acss_debit"
  | "autogiro"
  | "betalingsservice"
  | "payto";

const bankGlyph = (
  <Glyph>
    <Landmark />
  </Glyph>
);

/** A direct-debit rail: the row names the country, the hint names the scheme. */
const debit = (value: MethodType, label: string, scheme: string) => ({
  value,
  label,
  hint: `${scheme} · automatic debit each billing cycle`,
  icon: bankGlyph,
});

/**
 * The tile is the same `Glyph` the saved-methods rows above use, so a rail looks the same
 * before the buyer adds it and after. Where a rail HAS a mark of its own it wears it —
 * UPI is a logo people look for, not a word they read — and where it does not (a bank
 * account is every bank), it keeps our glyph.
 *
 * The card row keeps WORDS for its networks. Marks were tried there and measured wrong:
 * the Visa and Mastercard art is card-plate shaped (1.59:1) and RuPay's is a bare
 * wordmark (3.83:1), so at a shared height RuPay painted 6px tall beside two 14px
 * plates — three logos that read as misaligned rather than as a set. A mark earns its
 * place where it identifies ONE thing (the instrument on file, the UPI rail); a list of
 * accepted networks is a sentence.
 */
const OPTIONS: ReadonlyArray<{
  value: MethodType;
  label: string;
  hint: React.ReactNode;
  icon: React.ReactNode;
}> = [
  {
    value: "card",
    label: "Credit or debit card",
    hint: "Visa, Mastercard, RuPay",
    icon: (
      <Glyph>
        <CreditCard />
      </Glyph>
    ),
  },
  {
    value: "upi",
    label: "UPI Autopay",
    hint: "GPay, PhonePe, Paytm or any UPI app",
    icon: (
      <Glyph className="bg-card">
        <PaymentMark mark="upi" />
      </Glyph>
    ),
  },
  {
    value: "bank_transfer",
    label: "Bank account",
    hint: "Netbanking e-Mandate · you approve it once with your bank",
    icon: (
      <Glyph>
        <Landmark />
      </Glyph>
    ),
  },
  /**
   * The two Stripe direct-debit rails. The engine has done these end to end for a while
   * — `capabilities.methods` advertises them, a debit returns `pending` and settles by
   * webhook, and `fetchChargeStatus` recovers one whose webhook never arrived — but no
   * buyer could ever choose one, because both surfaces hardcoded `card` for every
   * non-RazorPay gateway. A backend with no control reads as "unsupported".
   *
   * Named by the RAIL rather than by the country: a buyer knows whether they are paying
   * from a US bank or a European one, and "Direct Debit" alone is four different schemes.
   */
  {
    value: "us_bank_account",
    label: "US bank account",
    hint: "ACH Direct Debit · automatic debit each billing cycle",
    icon: (
      <Glyph>
        <Landmark />
      </Glyph>
    ),
  },
  {
    value: "sepa_debit",
    label: "European bank account",
    hint: "SEPA Direct Debit · you sign the mandate once, then debits are automatic",
    icon: (
      <Glyph>
        <Landmark />
      </Glyph>
    ),
  },
  // Rendered only when a gateway advertises the rail.
  debit("bacs_debit", "UK bank account", "Bacs Direct Debit"),
  debit("au_becs_debit", "Australian bank account", "BECS Direct Debit"),
  debit("nz_becs_debit", "New Zealand bank account", "BECS Direct Debit"),
  debit("acss_debit", "Canadian bank account", "Pre-authorized debit (PAD)"),
  debit("autogiro", "Swedish bank account", "Autogiro"),
  debit("betalingsservice", "Danish bank account", "Betalingsservice"),
  {
    value: "payto",
    label: "PayTo",
    hint: "Australian bank account · you approve the agreement once in your banking app",
    icon: bankGlyph,
  },
  {
    value: "wallet",
    label: "Digital wallet",
    hint: "Pay with a wallet app that this provider supports",
    icon: (
      <Glyph>
        <Wallet />
      </Glyph>
    ),
  },
  {
    value: "paypal",
    label: "PayPal",
    hint: "Pay from your PayPal account",
    icon: (
      <Glyph className="bg-card">
        <PaymentMark mark="paypal" />
      </Glyph>
    ),
  },
  {
    value: "venmo",
    label: "Venmo",
    hint: "Pay from your Venmo account · US dollars only",
    icon: (
      <Glyph>
        <Wallet />
      </Glyph>
    ),
  },
];

export function MethodTypeChoice({
  value,
  onValueChange,
  allowed,
  heading,
  notice,
  className,
}: {
  value: MethodType;
  onValueChange: (next: MethodType) => void;
  /** What this gateway actually supports — a rail it cannot do must not be offered. */
  allowed: string[];
  /**
   * Visible label over the group. Omitted where the block above already says it, which
   * is why the group keeps an `aria-label` of its own regardless.
   */
  heading?: React.ReactNode;
  /** Advice about the SELECTED rail, rendered inside its card. */
  notice?: React.ReactNode;
  className?: string;
}) {
  /**
   * `bank_transfer` and `us_bank_account` are ONE rail wearing two names.
   *
   * Stripe's `capabilities.methods` lists both, and the adapter maps them to the same
   * `us_bank_account` — so rendering both hands the buyer two identical choices, one of
   * them labelled "Netbanking e-Mandate", which is RazorPay's rail and not what Stripe
   * would debit. The specific name wins because only it can carry a truthful hint.
   * RazorPay advertises `bank_transfer` alone, so its netbanking row is untouched.
   */
  const collapsed = allowed.includes("us_bank_account")
    ? allowed.filter((m) => m !== "bank_transfer")
    : allowed;
  const options = OPTIONS.filter((o) => collapsed.includes(o.value));
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {heading ? (
        <div className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
          {heading}
        </div>
      ) : null}
      <RadioGroup
        value={value}
        onValueChange={(v) => onValueChange(v as MethodType)}
        aria-label="Pay future invoices from"
        className="flex flex-col gap-2"
      >
        {options.map(({ value: option, label, hint, icon }) => {
          const selected = value === option;
          return (
            <div
              key={option}
              /*
               * THE WHOLE ROW IS THE TARGET. Measured on an iPhone 12 Pro: the row is
               * 87×316px and reads as one card-sized button, but only the 16×16 radio and
               * a 210×21 strip of label text selected anything — the two-line hint (the
               * largest text in the row), the payment mark and every pixel of padding did
               * nothing. `RadioOption` puts the hint and the icon OUTSIDE `<label for>`,
               * and this bordered box had no handler of its own.
               *
               * A click handler here rather than wrapping the radio in a `<label>`: Radix
               * renders the radio as a BUTTON, and the `ui` skill records that a label
               * wrapping a button swallows the click. Keyboard and AT behaviour is
               * untouched — the real radio group still owns focus and arrow keys — so this
               * is pointer-only enhancement. Re-selecting the current option is a no-op,
               * so the click bubbling up from the radio itself is harmless.
               */
              onClick={() => onValueChange(option)}
              className={cn(
                "cursor-pointer rounded-md border px-3.5 py-3 transition-colors",
                /**
                 * A LIGHTER ring than a top-level choice, because this group is always a
                 * SUB-group.
                 *
                 * Both consumers nest it: checkout renders it inside the "Add a new payment
                 * method" row, and the portal's add-card flow does the same. At full
                 * `ring-primary` it painted with exactly the weight of the row that OWNS it,
                 * so the screen showed two (and with the provider group, three) selection
                 * rings stacked vertically with nothing saying the lower ones exist because
                 * of the upper one — reported by the user looking at the step, and visible
                 * in the portal screenshot taken 2026-09-01.
                 *
                 * Matches the weight the sibling "Payment provider" sub-group now uses in
                 * checkout-flow.tsx, so the two nested groups read as one level together.
                 * The token stays `--primary` (never a hardcoded palette step, per the ui
                 * skill); only its alpha changes, so both themes follow automatically.
                 */
                selected ? "border-primary/70 ring-1 ring-primary/30" : "hover:bg-muted/50",
              )}
            >
              <RadioOption value={option} label={label} hint={hint} icon={icon} />
              {selected && notice ? <div className="mt-3">{notice}</div> : null}
            </div>
          );
        })}
      </RadioGroup>
    </div>
  );
}

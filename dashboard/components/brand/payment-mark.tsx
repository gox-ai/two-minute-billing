import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The network's own mark for an instrument — a Visa card, a UPI Autopay mandate, a
 * PayPal account.
 *
 * Why colour is allowed here, on a monochrome surface: this is not decoration, it is
 * IDENTITY. A payer recognises their card by the mark before they read the last four
 * digits, and every one of these is recognised by its colour. So the artwork renders as
 * published, on a light plate (`bg-card`), inside our own tile — the tile, its size and
 * its radius stay ours, which is what keeps a row of mixed instruments looking like one
 * list. Artwork + licences: `public/brands/README.md`.
 *
 * It is also never invented: the mark is chosen from `payment_methods.brand` (what the
 * gateway told us the instrument IS) or from a mandate rail, and an unrecognised brand
 * renders NOTHING rather than a wrong or generic-but-branded plate — the caller falls
 * back to its own glyph. Guessing "probably Visa" on a payment screen is worse than a
 * grey card icon.
 */

/** file → what a screen reader should hear. */
const MARKS = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  rupay: "RuPay",
  discover: "Discover",
  elo: "Elo",
  diners: "Diners Club",
  jcb: "JCB",
  maestro: "Maestro",
  unionpay: "UnionPay",
  upi: "UPI",
  paypal: "PayPal",
} as const;

/**
 * Marks we draw in INK rather than serve as published artwork.
 *
 * The exception exists because these two have no colour form we may redistribute — the
 * colour Apple Pay and Google Pay marks come from their owners' brand portals under terms
 * of their own, not from an MPL/CC0 package. Both owners publish a MONOCHROME mark for
 * exactly this use, so ink is a published form and not a recolouring: `currentColor`
 * resolves to our foreground, i.e. near-black on light and near-white on dark, which is
 * the black/white pair each guideline allows.
 *
 * They are inline paths rather than files because an `<img>` cannot inherit `currentColor`,
 * and a fixed black mark disappears on the dark theme.
 */
const MONO_MARKS = {
  applepay: "Apple Pay",
  googlepay: "Google Pay",
} as const;

const MONO_PATHS: Record<keyof typeof MONO_MARKS, string> = {
  applepay:
    "M2.15 4.318a42.16 42.16 0 0 0-.454.003c-.15.005-.303.013-.452.04a1.44 1.44 0 0 0-1.06.772c-.07.138-.114.278-.14.43-.028.148-.037.3-.04.45A10.2 10.2 0 0 0 0 6.222v11.557c0 .07.002.138.003.207.004.15.013.303.04.452.027.15.072.291.142.429a1.436 1.436 0 0 0 .63.63c.138.07.278.115.43.142.148.027.3.036.45.04l.208.003h20.194l.207-.003c.15-.004.303-.013.452-.04.15-.027.291-.071.428-.141a1.432 1.432 0 0 0 .631-.631c.07-.138.115-.278.141-.43.027-.148.036-.3.04-.45.002-.07.003-.138.003-.208l.001-.246V6.221c0-.07-.002-.138-.004-.207a2.995 2.995 0 0 0-.04-.452 1.446 1.446 0 0 0-1.2-1.201 3.022 3.022 0 0 0-.452-.04 10.448 10.448 0 0 0-.453-.003zm0 .512h19.942c.066 0 .131.002.197.003.115.004.25.01.375.032.109.02.2.05.287.094a.927.927 0 0 1 .407.407.997.997 0 0 1 .094.288c.022.123.028.258.031.374.002.065.003.13.003.197v11.552c0 .065 0 .13-.003.196-.003.115-.009.25-.032.375a.927.927 0 0 1-.5.693 1.002 1.002 0 0 1-.286.094 2.598 2.598 0 0 1-.373.032l-.2.003H1.906c-.066 0-.133-.002-.196-.003a2.61 2.61 0 0 1-.375-.032c-.109-.02-.2-.05-.288-.094a.918.918 0 0 1-.406-.407 1.006 1.006 0 0 1-.094-.288 2.531 2.531 0 0 1-.032-.373 9.588 9.588 0 0 1-.002-.197V6.224c0-.065 0-.131.002-.197.004-.114.01-.248.032-.375.02-.108.05-.199.094-.287a.925.925 0 0 1 .407-.406 1.03 1.03 0 0 1 .287-.094c.125-.022.26-.029.375-.032.065-.002.131-.002.196-.003zm4.71 3.7c-.3.016-.668.199-.88.456-.191.22-.36.58-.316.918.338.03.675-.169.888-.418.205-.258.345-.603.308-.955zm2.207.42v5.493h.852v-1.877h1.18c1.078 0 1.835-.739 1.835-1.812 0-1.07-.742-1.805-1.808-1.805zm.852.719h.982c.739 0 1.161.396 1.161 1.089 0 .692-.422 1.092-1.164 1.092h-.979zm-3.154.3c-.45.01-.83.28-1.05.28-.235 0-.593-.264-.981-.257a1.446 1.446 0 0 0-1.23.747c-.527.908-.139 2.255.374 2.995.249.366.549.769.944.754.373-.014.52-.242.973-.242.454 0 .586.242.98.235.41-.007.667-.366.915-.733.286-.417.403-.82.41-.841-.007-.008-.79-.308-.797-1.209-.008-.754.615-1.113.644-1.135-.352-.52-.9-.578-1.09-.593a1.123 1.123 0 0 0-.092-.002zm8.204.397c-.99 0-1.606.533-1.652 1.256h.777c.072-.358.369-.586.845-.586.502 0 .803.266.803.711v.309l-1.097.064c-.951.054-1.488.484-1.488 1.184 0 .72.548 1.207 1.332 1.207.526 0 1.032-.281 1.264-.727h.019v.659h.788v-2.76c0-.803-.62-1.317-1.591-1.317zm1.94.072l1.446 4.009c0 .003-.073.24-.073.247-.125.41-.33.571-.711.571-.069 0-.206 0-.267-.015v.666c.06.011.267.019.335.019.83 0 1.226-.312 1.568-1.283l1.5-4.214h-.868l-1.012 3.259h-.015l-1.013-3.26zm-1.167 2.189v.316c0 .521-.45.917-1.024.917-.442 0-.731-.228-.731-.579 0-.342.278-.56.769-.593z",
  googlepay:
    "M3.963 7.235A3.963 3.963 0 00.422 9.419a3.963 3.963 0 000 3.559 3.963 3.963 0 003.541 2.184c1.07 0 1.97-.352 2.627-.957.748-.69 1.18-1.71 1.18-2.916a4.722 4.722 0 00-.07-.806H3.964v1.526h2.14a1.835 1.835 0 01-.79 1.205c-.356.241-.814.379-1.35.379-1.034 0-1.911-.697-2.225-1.636a2.375 2.375 0 010-1.517c.314-.94 1.191-1.636 2.225-1.636a2.152 2.152 0 011.52.594l1.132-1.13a3.808 3.808 0 00-2.652-1.033zm6.501.55v6.9h.886V11.89h1.465c.603 0 1.11-.196 1.522-.588a1.911 1.911 0 00.635-1.464 1.92 1.92 0 00-.635-1.456 2.125 2.125 0 00-1.522-.598zm2.427.85a1.156 1.156 0 01.823.365 1.176 1.176 0 010 1.686 1.171 1.171 0 01-.877.357H11.35V8.635h1.487a1.156 1.156 0 01.054 0zm4.124 1.175c-.842 0-1.477.308-1.907.925l.781.491c.288-.417.68-.626 1.175-.626a1.255 1.255 0 01.856.323 1.009 1.009 0 01.366.785v.202c-.34-.193-.774-.289-1.3-.289-.617 0-1.11.145-1.479.434-.37.288-.554.677-.554 1.165a1.476 1.476 0 00.525 1.156c.35.308.785.463 1.305.463.61 0 1.098-.27 1.465-.81h.038v.655h.848v-2.909c0-.61-.19-1.09-.568-1.44-.38-.35-.896-.525-1.551-.525zm2.263.154l1.946 4.422-1.098 2.38h.915L24 9.963h-.965l-1.368 3.391h-.02l-1.406-3.39zm-2.146 2.368c.494 0 .88.11 1.156.33 0 .372-.147.696-.44.973a1.413 1.413 0 01-.997.414 1.081 1.081 0 01-.69-.232.708.708 0 01-.293-.578c0-.257.12-.47.363-.647.24-.173.54-.26.9-.26Z",
};

export type PaymentMarkKey = keyof typeof MARKS | keyof typeof MONO_MARKS;

/**
 * Gateways spell the same network a dozen ways — `Visa`, `visa`, `MasterCard`,
 * `master_card`, `American Express`, `amex`, `Diners Club`. Normalise hard (case and
 * punctuation out) and match on what is left, so a new gateway's spelling of an old
 * network does not silently lose its mark.
 */
export function paymentMarkKey(input: {
  brand?: string | null;
  type?: string | null;
  mandateRail?: string | null;
}): PaymentMarkKey | null {
  const rail = (input.mandateRail ?? "").toLowerCase();
  // A UPI Autopay mandate has no card brand — the rail IS the instrument.
  if (rail === "upi") return "upi";
  if ((input.type ?? "").toLowerCase() === "paypal") return "paypal";
  const b = (input.brand ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!b) return null;
  if (b === "visa" || b === "visaelectron") return "visa";
  if (b === "mastercard" || b === "mc" || b === "master") return "mastercard";
  if (b === "amex" || b === "americanexpress") return "amex";
  if (b === "rupay") return "rupay";
  if (b === "discover") return "discover";
  if (b === "elo") return "elo";
  if (b === "diners" || b === "dinersclub") return "diners";
  if (b === "jcb") return "jcb";
  if (b === "maestro") return "maestro";
  if (b === "unionpay") return "unionpay";
  if (b === "upi") return "upi";
  if (b === "paypal") return "paypal";
  // Stripe reports a wallet-funded card with the WALLET as its brand — see the `card`
  // case in `providers/stripe.ts`. Stripe Link has no mark we may ship, so it keeps the
  // generic card glyph rather than borrowing another network's.
  if (b === "applepay") return "applepay";
  if (b === "googlepay" || b === "gpay") return "googlepay";
  return null;
}

/**
 * The artwork alone, sized to sit inside a caller's tile. `alt` is empty when the row
 * already names the instrument in text (it always does — see `instrumentLabel`), so the
 * mark is not read out twice; pass `labelled` where it stands on its own.
 */
export function PaymentMark({
  mark,
  labelled = false,
  className,
}: {
  mark: PaymentMarkKey;
  /** Announce the network name — for a mark with no adjacent text. */
  labelled?: boolean;
  className?: string;
}) {
  const label = paymentMarkLabel(mark);
  if (mark in MONO_PATHS) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        role={labelled ? "img" : undefined}
        aria-hidden={labelled ? undefined : true}
        className={cn("h-4 w-7", className)}
      >
        {labelled ? <title>{label}</title> : null}
        <path d={MONO_PATHS[mark as keyof typeof MONO_PATHS]} />
      </svg>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a static local SVG; next/image would need dangerouslyAllowSVG and buys nothing for a 2KB file.
    <img
      src={`/brands/${mark}.svg`}
      alt={labelled ? label : ""}
      {...(labelled ? {} : { "aria-hidden": true })}
      className={cn("h-4 w-7 object-contain", className)}
    />
  );
}

/** The name of a mark, for callers that need it in text (a tooltip, an aria-label). */
export function paymentMarkLabel(mark: PaymentMarkKey): string {
  return mark in MONO_MARKS
    ? MONO_MARKS[mark as keyof typeof MONO_MARKS]
    : MARKS[mark as keyof typeof MARKS];
}

/**
 * Official gateway and integration logos (files in `public/logos/`, sources and rules in the
 * internal logo manifest) and the one sizing rule every surface uses: each logo covers the same
 * area, so height = sqrt(area / aspect ratio), capped by the width it may take.
 *
 * Metrics are measured on each file: `ar` is the file's width / height, `pad` the empty margin
 * around the ink as a fraction of the file (top, right, bottom, left). The rule sizes the ink,
 * and negative margins take the empty margin back out of the layout.
 */

export type PartnerLogoKey =
  | "stripe"
  | "paypal"
  | "razorpay"
  | "square"
  | "braintree"
  | "checkoutcom"
  | "adyen"
  | "mollie"
  | "authorizenet"
  | "gocardless"
  | "cashfree"
  | "payu"
  | "hubspot"
  | "firstpromoter";

interface LogoFile {
  /** Path under `public/`. A `.webp` base gets `@2x` and `@3x` files. */
  src: string;
  ar: number;
  pad?: [number, number, number, number];
}

interface PartnerLogoDef {
  name: string;
  light?: LogoFile;
  dark?: LogoFile;
  /** The file for a ground that has no own variant, and the plate colour it sits on. */
  plate?: { ground: "light" | "dark"; color: string };
  /**
   * Fraction of the ink height that counts toward the area: a tagline under the wordmark
   * ("A Visa Solution") makes the box taller without adding weight.
   */
  weightHeight?: number;
}

const svg = (file: string, ar: number, pad?: LogoFile["pad"]): LogoFile => ({
  src: `/logos/${file}.svg`,
  ar,
  pad,
});
const webp = (file: string, ar: number): LogoFile => ({ src: `/logos/${file}.webp`, ar });

export const PARTNER_LOGOS: Record<PartnerLogoKey, PartnerLogoDef> = {
  // Blurple on light, white on dark: the only colours allowed.
  stripe: {
    name: "Stripe",
    light: svg("stripe-wordmark", 2.4),
    dark: svg("stripe-wordmark-dark", 2.3841, [0.0032, 0, 0.0032, 0]),
  },
  paypal: {
    name: "PayPal",
    light: webp("paypal-wordmark", 2.9762),
    dark: webp("paypal-wordmark-dark", 2.9762),
  },
  // White only: a navy plate on light grounds.
  razorpay: {
    name: "Razorpay",
    dark: webp("razorpay-wordmark-dark", 4.7028),
    plate: { ground: "light", color: "#0c2451" },
  },
  // The wordmark always carries its square mark.
  square: {
    name: "Square",
    light: svg("square-wordmark", 4.04, [0, 0.0123, 0, 0]),
    dark: svg("square-wordmark-dark", 4.0133, [0, 0.0056, 0, 0]),
  },
  // No dark variant: a white plate on dark grounds.
  braintree: {
    name: "Braintree",
    light: svg("braintree-wordmark", 6.7391, [0.0419, 0.0054, 0.0366, 0.0062]),
    plate: { ground: "dark", color: "#ffffff" },
  },
  checkoutcom: {
    name: "Checkout.com",
    light: svg("checkoutcom-wordmark", 5.75, [0.01, 0.0043, 0.025, 0.0017]),
    dark: svg("checkoutcom-wordmark-dark", 5.75, [0.01, 0.0043, 0.025, 0.0017]),
  },
  // Always green, dark grounds included.
  adyen: {
    name: "Adyen",
    light: svg("adyen-wordmark", 2.1667, [0.27, 0.1721, 0.27, 0.1732]),
    dark: svg("adyen-wordmark", 2.1667, [0.27, 0.1721, 0.27, 0.1732]),
  },
  mollie: {
    name: "Mollie",
    light: svg("mollie-wordmark", 3.4092),
    dark: svg("mollie-wordmark-dark", 3.4092),
  },
  authorizenet: {
    name: "Authorize.net",
    light: svg("authorizenet-wordmark", 4.4886),
    dark: svg("authorizenet-wordmark-dark", 4.4885, [0, 0.0013, 0, 0]),
    weightHeight: 0.545,
  },
  gocardless: {
    name: "GoCardless",
    light: svg("gocardless-wordmark", 6.7195),
    dark: svg("gocardless-wordmark-dark", 6.5667, [0.0126, 0.0022, 0.0126, 0.0017]),
  },
  cashfree: {
    name: "Cashfree",
    light: svg("cashfree-wordmark", 5.92, [0, 0.0049, 0.0192, 0.0065]),
    dark: svg("cashfree-wordmark-dark", 5.9231, [0.0092, 0, 0.0035, 0]),
  },
  // PayU India's own logo (payu.in), not the global "PayU" mark: that is the brand merchants see.
  payu: {
    name: "PayU",
    light: svg("payu-wordmark", 1.8349),
    dark: svg("payu-wordmark-dark", 1.8349),
  },
  hubspot: {
    name: "HubSpot",
    light: svg("hubspot-wordmark", 3.5277),
    dark: svg("hubspot-wordmark-dark", 3.5277),
  },
  firstpromoter: {
    name: "FirstPromoter",
    light: svg("firstpromoter-wordmark", 5.59),
    dark: svg("firstpromoter-wordmark-dark", 5.59),
  },
};

/** A plated logo gives up some size to its plate, so the plate reads as heavy as a bare logo. */
const PLATE_SCALE = 0.9;

export interface PartnerLogoLayout {
  name: string;
  src: string;
  srcset?: string;
  /** Rendered <img> box, empty margins included. */
  width: number;
  height: number;
  /** Negative margins that take the empty margins out of the layout. */
  margin: string;
  plate?: { color: string; padY: number; padX: number; radius: number };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Size one logo for a ground: ink area `area` px², ink width at most `maxWidth`. */
export function partnerLogoLayout(
  key: PartnerLogoKey,
  ground: "light" | "dark",
  area: number,
  maxWidth?: number,
): PartnerLogoLayout {
  const def = PARTNER_LOGOS[key];
  const file = def[ground] ?? def.light ?? def.dark!;
  const plated = !def[ground] && def.plate?.ground === ground;
  const [t, r, b, l] = file.pad ?? [0, 0, 0, 0];
  const inkAr = (file.ar * (1 - l - r)) / (1 - t - b);
  const wh = def.weightHeight ?? 1;
  // Area counts the weighted band only: its aspect ratio is inkAr / wh.
  let inkH = Math.sqrt(area / (inkAr / wh)) / wh;
  if (plated) inkH *= PLATE_SCALE;
  if (maxWidth && inkH * inkAr > maxWidth) inkH = maxWidth / inkAr;
  const height = inkH / (1 - t - b);
  const width = height * file.ar;
  const webpBase = file.src.endsWith(".webp") ? file.src.slice(0, -5) : null;
  return {
    name: def.name,
    src: webpBase ? `${webpBase}@2x.webp` : file.src,
    srcset: webpBase ? `${webpBase}@2x.webp 2x, ${webpBase}@3x.webp 3x` : undefined,
    width: r1(width),
    height: r1(height),
    margin: [t * height, r * width, b * height, l * width].map((m) => `${-r1(m)}px`).join(" "),
    plate: plated
      ? {
          color: def.plate!.color,
          padY: r1(inkH * 0.4),
          padX: r1(inkH * 0.65),
          radius: r1(Math.min(8, inkH * 0.4)),
        }
      : undefined,
  };
}

/** Whether a logo looks the same on both grounds (one file, no plate), so one <img> serves both. */
/** Whether a logo file exists for this key (a new gateway may not have one yet). */
export function hasPartnerLogo(key: string): key is PartnerLogoKey {
  return Object.hasOwn(PARTNER_LOGOS, key);
}

export function partnerLogoSameOnBothGrounds(key: PartnerLogoKey): boolean {
  const def = PARTNER_LOGOS[key];
  return !!def.light && !!def.dark && def.light.src === def.dark.src;
}

import { cn } from "@/lib/utils";

/**
 * A payment gateway's or integration's official logo, keyed by the catalogue key.
 * Files and their sources: `public/logos/README.md`. Only those files; never a
 * third-party icon set or a drawn approximation.
 *
 * Equal visual weight: every logo covers the same AREA, so a long wordmark is short and a
 * compact one tall (height = sqrt(area / aspect), capped by the box width). The box is
 * fixed per call site, so a column of logos lines up. A key with no file shows its name as
 * text in the same box.
 *
 * Decorative: callers always show the name as text beside it.
 */

type Variant = {
  src: string;
  srcSet?: string;
  /** A ground the logo needs on this theme (a brand that publishes one colourway only). */
  plate?: string;
};

type Logo = {
  name: string;
  /** Width / height of the artwork's ink (the files are trimmed to it). */
  aspect: number;
  light: Variant;
  /** Omitted: the light file is correct on dark too. */
  dark?: Variant;
};

const svg = (file: string): Variant => ({ src: `/logos/${file}.svg` });
/** PNG-only brands: WebP at 2x and 3x of a 32px-tall render. */
const webp = (file: string): Variant => ({
  src: `/logos/${file}@2x.webp`,
  srcSet: `/logos/${file}@2x.webp 2x, /logos/${file}@3x.webp 3x`,
});

const LOGOS: Record<string, Logo> = {
  // Blurple on light, white on dark: the only two colours allowed besides slate.
  stripe: { name: "Stripe", aspect: 2.4, light: svg("stripe"), dark: svg("stripe-dark") },
  paypal: { name: "PayPal", aspect: 2.976, light: webp("paypal"), dark: webp("paypal-dark") },
  // Published white-only: on a light ground it sits on its own navy.
  razorpay: {
    name: "Razorpay",
    aspect: 4.7,
    light: { ...webp("razorpay"), plate: "#0c2451" },
    dark: webp("razorpay"),
  },
  // The primary lockup: the wordmark never appears without the square mark.
  square: { name: "Square", aspect: 3.986, light: svg("square"), dark: svg("square-dark") },
  // No dark version is served; the navy lockup needs a light ground.
  braintree: {
    name: "Braintree",
    aspect: 7.274,
    light: svg("braintree"),
    dark: { ...svg("braintree"), plate: "#ffffff" },
  },
  checkoutcom: {
    name: "Checkout.com",
    aspect: 5.946,
    light: svg("checkoutcom"),
    dark: svg("checkoutcom-dark"),
  },
  // Always green, on dark grounds too.
  adyen: { name: "Adyen", aspect: 3.089, light: svg("adyen") },
  mollie: { name: "Mollie", aspect: 3.404, light: svg("mollie"), dark: svg("mollie-dark") },
  authorizenet: {
    name: "Authorize.net",
    aspect: 4.489,
    light: svg("authorizenet"),
    dark: svg("authorizenet-dark"),
  },
  gocardless: {
    name: "GoCardless",
    aspect: 6.72,
    light: svg("gocardless"),
    dark: svg("gocardless-dark"),
  },
  cashfree: { name: "Cashfree", aspect: 6, light: svg("cashfree"), dark: svg("cashfree-dark") },
  // PayU India's own logo (payu.in), not the global "PayU" mark: that is the brand merchants see.
  payu: { name: "PayU", aspect: 1.835, light: svg("payu"), dark: svg("payu-dark") },
  hubspot: { name: "HubSpot", aspect: 3.528, light: svg("hubspot"), dark: svg("hubspot-dark") },
  firstpromoter: {
    name: "FirstPromoter",
    aspect: 5.59,
    light: svg("firstpromoter"),
    dark: svg("firstpromoter-dark"),
  },
};

/** The most compact logo sets the box height, so every logo fits the box. */
const MIN_ASPECT = Math.min(...Object.values(LOGOS).map((l) => l.aspect));
/** Plate padding, as a fraction of the logo height. 1.4x a 4.7:1 logo fits the box. */
const PLATE_Y = 0.2;
const PLATE_X = 0.35;

/** Sizes per surface: `area` in px², `width` = the box width that caps a long wordmark. */
export const LOGO_SIZE = {
  /** Beside a gateway name in a list cell or a detail row. */
  inline: { area: 800, width: 88 },
  /** Beside a card title or an integration name. */
  mark: { area: 900, width: 88 },
  /** Beside an account name in the gateway accounts list. */
  row: { area: 1000, width: 96 },
  /** Beside the page title on a gateway account. */
  title: { area: 1300, width: 112 },
  /** A card in the gateway directory. */
  card: { area: 2000, width: 136 },
} as const;

export type LogoSize = { area: number; width: number };

/** The logo's rendered size: same area for every brand, capped by the box width. */
export function logoDimensions(aspect: number, { area, width }: LogoSize, plated = false) {
  const pad = plated ? 2 * PLATE_X : 0;
  const h = Math.min(Math.sqrt(area / aspect), width / (aspect + pad));
  return { width: Math.round(h * aspect * 10) / 10, height: Math.round(h * 10) / 10 };
}

export function hasPartnerLogo(key: string | null | undefined): boolean {
  return !!key && key in LOGOS;
}

/** The brand's own name for a key with a logo; `null` otherwise. */
export function partnerName(key: string | null | undefined): string | null {
  return (key && LOGOS[key]?.name) || null;
}

function LogoImage({
  variant,
  aspect,
  size,
  className,
}: {
  variant: Variant;
  aspect: number;
  size: LogoSize;
  className?: string;
}) {
  const { width, height } = logoDimensions(aspect, size, !!variant.plate);
  const img = (
    // eslint-disable-next-line @next/next/no-img-element -- static local files at a computed size; next/image would need dangerouslyAllowSVG and buys nothing here.
    <img
      src={variant.src}
      srcSet={variant.srcSet}
      alt=""
      width={width}
      height={height}
      style={{ width, height }}
      className="block max-w-none shrink-0"
      draggable={false}
    />
  );
  if (!variant.plate) return <span className={className}>{img}</span>;
  return (
    <span
      className={cn("rounded-md", className)}
      style={{
        backgroundColor: variant.plate,
        padding: `${Math.round(height * PLATE_Y)}px ${Math.round(height * PLATE_X)}px`,
      }}
    >
      {img}
    </span>
  );
}

export function PartnerLogo({
  brand,
  name,
  area,
  width,
  fit = false,
  className,
}: {
  /** Catalogue key: `gateway_key` or the integration key. */
  brand: string;
  /** Shown in the box when the brand has no logo file. */
  name: string;
  /** px² the logo covers. Pick from `LOGO_SIZE`. */
  area: number;
  /** Box width; caps a long wordmark. */
  width: number;
  /** Shrink the box to the logo (a title, a card) instead of a fixed column width. */
  fit?: boolean;
  className?: string;
}) {
  const logo = LOGOS[brand];
  const size = { area, width };
  const boxHeight = Math.ceil(Math.sqrt(area / MIN_ASPECT));
  const box = cn("flex shrink-0 items-center", fit ? "justify-start" : "justify-center", className);
  const boxWidth = fit ? undefined : width;

  if (!logo) {
    // A wordmark slot: the name set in type, in the same box as a logo.
    return (
      <span
        aria-hidden
        className={cn(box, "leading-tight font-semibold tracking-tight text-muted-foreground")}
        style={{
          width: boxWidth,
          maxWidth: width,
          minHeight: boxHeight,
          fontSize: Math.min(20, Math.max(12, Math.round(boxHeight * 0.55))),
          textAlign: fit ? "left" : "center",
        }}
      >
        <span className="min-w-0 wrap-anywhere">{name}</span>
      </span>
    );
  }

  return (
    <span aria-hidden className={box} style={{ width: boxWidth, height: boxHeight }}>
      {logo.dark ? (
        <>
          <LogoImage
            variant={logo.light}
            aspect={logo.aspect}
            size={size}
            className="flex dark:hidden"
          />
          <LogoImage
            variant={logo.dark}
            aspect={logo.aspect}
            size={size}
            className="hidden dark:flex"
          />
        </>
      ) : (
        <LogoImage variant={logo.light} aspect={logo.aspect} size={size} className="flex" />
      )}
    </span>
  );
}

/**
 * A gateway named in a list or detail: a small logo, then the name as text (read by
 * screen readers and matched by search). A key with no logo (an offline method, the test
 * gateway) shows the name only.
 */
export function GatewayLabel({
  gatewayKey,
  name,
  fit = false,
  className,
}: {
  gatewayKey: string;
  /** A detail row: no column to line up, so the logo box shrinks to the logo. */
  fit?: boolean;
  /** Defaults to the brand's name, else the key. */
  name?: string;
  className?: string;
}) {
  const label = name ?? partnerName(gatewayKey) ?? gatewayKey;
  return (
    <span className={cn("inline-flex items-center gap-2 align-middle", className)}>
      {hasPartnerLogo(gatewayKey) ? (
        <PartnerLogo brand={gatewayKey} name={label} {...LOGO_SIZE.inline} fit={fit} />
      ) : null}
      <span className="min-w-0">{label}</span>
    </span>
  );
}

/**
 * Brand Styles (0185) — turning a tenant's one brand colour into something safe to
 * paint on a hosted page.
 *
 * A merchant picks a colour they like on their own website; we then have to use it as
 * a LINK colour on white, a button FILL under white or black text, and both again in
 * dark mode. Taking the hex and painting it raw is how you ship a pale yellow "Pay
 * now" with white text on it, or a link nobody with low vision can read. So every
 * value here is derived and contrast-checked rather than used raw.
 *
 * Scope: the STOREFRONT only. The operator dashboard's identity is ours — a tenant
 * colour must never reach it (see the storefront chrome).
 *
 * ONE surface, because the hosted pages are light-only (see the storefront layout:
 * a merchant supplies one logo, drawn for one background). That is what removes the
 * awkward half of this problem — the same hex cannot clear AA against both #ffffff
 * and #121418, so a two-theme storefront needed two corrected values and the
 * merchant could only ever preview one of them.
 */

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** The surface a brand colour has to survive: `--card` in the light palette. */
const LIGHT_SURFACE = "#ffffff";
/** WCAG AA for normal text. Links and small labels are normal text. */
const AA = 4.5;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

const toHex = ({ r, g, b }: Rgb) =>
  `#${[r, g, b]
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Mix toward black (t<0) or white (t>0), t in -1..1. */
function shift(hex: string, t: number): string {
  const { r, g, b } = hexToRgb(hex);
  const target = t > 0 ? 255 : 0;
  const k = Math.abs(t);
  return toHex({ r: r + (target - r) * k, g: g + (target - g) * k, b: b + (target - b) * k });
}

/**
 * The nearest version of `hex` that reaches AA against `surface`, walking toward
 * black on a light surface and toward white on a dark one. Returns the original when
 * it already passes — a brand that is already readable is never altered, which is the
 * behaviour a merchant expects when they paste their exact brand hex.
 */
export function readableOn(hex: string, surface: string): string {
  if (contrastRatio(hex, surface) >= AA) return hex;
  const towardWhite = luminance(surface) < 0.5;
  for (let step = 1; step <= 20; step++) {
    const candidate = shift(hex, (towardWhite ? 1 : -1) * (step / 20));
    if (contrastRatio(candidate, surface) >= AA) return candidate;
  }
  return towardWhite ? "#ffffff" : "#000000";
}

/** Black or white label on a filled button of `hex`, whichever contrasts more. */
export function onColor(hex: string): string {
  return contrastRatio("#ffffff", hex) >= contrastRatio("#111111", hex) ? "#ffffff" : "#111111";
}

/**
 * The accent a brand colour becomes: the merchant's hex, corrected until it is
 * readable on the storefront's light surface. Null when there is no usable brand,
 * so the caller falls through to our own token.
 *
 * Exported because the accent has a second consumer that is NOT this stylesheet:
 * Stripe Elements renders in a cross-origin iframe and cannot read a custom
 * property, so `lib/stripe-elements.ts` has to be handed the literal value. One
 * derivation, for the same reason the previews share `brandCss` — a card form
 * sitting on a branded page must not be a different blue from the page.
 */
export function brandAccent(brandColor: string | null | undefined): string | null {
  if (!brandColor || !HEX_RE.test(brandColor)) return null;
  return readableOn(brandColor.toLowerCase(), LIGHT_SURFACE);
}

/**
 * CSS for a branded storefront subtree, scoped to `[data-brand]`.
 *
 * `--primary` (the accent: links, focus rings, marks) is contrast-corrected, because a
 * brand chosen to look good on a marketing site is often unreadable as 14px link text.
 * `--solid` (the primary button fill) keeps the RAW brand colour — a filled button is
 * the one place the merchant's exact hex belongs — and `--solid-foreground` flips
 * between black and white so the label stays legible on whatever they picked.
 *
 * Returns '' for no brand, so the page falls through to our own tokens.
 */
export function brandCss(brandColor: string | null | undefined): string {
  const accent = brandAccent(brandColor);
  if (!accent || !brandColor) return "";
  const raw = brandColor.toLowerCase();
  return `[data-brand]{--primary:${accent};--ring:${accent};--solid:${raw};--solid-foreground:${onColor(raw)}}`;
}

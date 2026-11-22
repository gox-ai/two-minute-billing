/**
 * The label colour on a brand-coloured email button — the same rule the hosted pages use
 * (`dashboard/lib/brand.ts` `buttonLabel`; a unit test keeps the two in step). A text colour
 * the merchant set always wins; unset, it is white, near-black or black, whichever first
 * reaches WCAG AA (4.5:1) on the fill.
 */
const HEX = /^#[0-9a-fA-F]{6}$/;
const AA = 4.5;

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export function emailButtonLabel(fill: string, textColor?: string | null): string {
  if (textColor && HEX.test(textColor)) return textColor.toLowerCase();
  if (contrast("#ffffff", fill) >= AA) return "#ffffff";
  return contrast("#111111", fill) >= AA ? "#111111" : "#000000";
}

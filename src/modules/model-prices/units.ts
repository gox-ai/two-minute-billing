/**
 * What one unit of a price is, and the price tier (quality, resolution). The CHECKs in 0524
 * hold the same sets.
 */

export const MODEL_PRICE_UNITS = [
  "token",
  "request",
  "image",
  "video_second",
  "audio_second",
  "character",
  "page",
  "pixel",
] as const;
export type ModelPriceUnit = (typeof MODEL_PRICE_UNITS)[number];

export const isModelPriceUnit = (u: unknown): u is ModelPriceUnit =>
  typeof u === "string" && (MODEL_PRICE_UNITS as readonly string[]).includes(u);

/** A lookup that names no unit resolves these, in order: the units the list had before 0524. */
export const LEGACY_UNITS: readonly ModelPriceUnit[] = ["token", "request"];

/** A quality or resolution value; '' = no tier. */
export const TIER_RE = /^[a-z0-9_.x-]{0,40}$/;

/** A tier as it is stored and matched: trimmed, lower-case ("HD " → "hd"). */
export const normalizeTier = (v: string | null | undefined): string =>
  (v ?? "").trim().toLowerCase();

/** A held batch or row stored before 0524 has no unit: `_kcount` (per 1,000) was a request. */
export const legacyUnitOf = (divisor: string | bigint): ModelPriceUnit =>
  String(divisor) === "1000" ? "request" : "token";

/**
 * The tiers a lookup tries, in order: exact; same quality, no resolution; same resolution, no
 * quality; no tier.
 */
export function tierOrder(quality = "", resolution = ""): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const t of [
    [quality, resolution],
    [quality, ""],
    ["", resolution],
    ["", ""],
  ] as Array<[string, string]>) {
    const k = `${t[0]}\u0000${t[1]}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

const UNIT_WORDS: Record<ModelPriceUnit, [string, string]> = {
  token: ["token", "tokens"],
  request: ["request", "requests"],
  image: ["image", "images"],
  video_second: ["second of video", "seconds of video"],
  audio_second: ["second of audio", "seconds of audio"],
  character: ["character", "characters"],
  page: ["page", "pages"],
  pixel: ["pixel", "pixels"],
};

const count = (n: bigint): string => {
  for (const [v, s] of [
    [1_000_000_000n, "B"],
    [1_000_000n, "M"],
    [1_000n, "K"],
  ] as const)
    if (n >= v && n % v === 0n) return `${n / v}${s}`;
  return n.toLocaleString("en-US");
};

/** "per 1M tokens", "per 1K requests", "per hour of audio", "per image". */
export function perUnitText(unit: string, divisor: string | bigint): string {
  const d = BigInt(divisor);
  const u = isModelPriceUnit(unit) ? unit : "token";
  if (u === "audio_second" || u === "video_second") {
    const what = u === "audio_second" ? "audio" : "video";
    if (d === 3600n) return `per hour of ${what}`;
    if (d === 60n) return `per minute of ${what}`;
  }
  const [one, many] = UNIT_WORDS[u];
  return d === 1n ? `per ${one}` : `per ${count(d)} ${many}`;
}

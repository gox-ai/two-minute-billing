/**
 * The second price source (LiteLLM `model_prices_and_context_window.json`, MIT), read for MEDIA
 * prices only: images, seconds of video and audio, characters. Token prices stay with the first
 * feed. Numbers stay source text (`parseJsonExact`), USD per one unit, divisor 1.
 *
 * Fields: `output_cost_per_image[_<size>]`, `input_cost_per_image`,
 * `output_cost_per_second[_<res>]` and `input_cost_per_second` (unit from `mode`: video or audio;
 * any other mode is skipped), `{input,output}_cost_per_video_per_second`, `input_cost_per_character`.
 * Batch, priority, image-token and "above N" variants are ignored. A price of 0 is skipped: in
 * this file it usually means "not known".
 *
 * Key prefixes carry tiers: `azure/high/1024-x-1024/gpt-image-1` → provider azure, quality high,
 * resolution 1024x1024, model gpt-image-1. Only segments before the model count; the last
 * segment is always model. An entry whose tiers do not map cleanly is skipped and counted.
 */
import { JsonNumber, parseJsonExact } from "@/modules/metering/json-source";
import { majorTextToMinorFixed12 } from "./decimal";
import { FeedSchemaError, priceKey, type ParsedModel, type ParsedPrice } from "./parse";
import { TIER_RE, type ModelPriceUnit } from "./units";

/** `model_prices.source` for this feed. */
export const MEDIA_SOURCE_NAME = "litellm";
export const MEDIA_SOURCE_LICENCE = "MIT License, Copyright (c) 2023 Berri AI";

/**
 * This file's `litellm_provider` → the first feed's provider id, only where both name the same
 * seller. Anything else keeps its own id, lower-cased.
 */
export const MEDIA_PROVIDER_MAP: Readonly<Record<string, string>> = {
  openai: "openai",
  azure: "azure",
  azure_ai: "azure",
  bedrock: "aws",
  gemini: "google",
  vertex_ai: "google",
  "vertex_ai-language-models": "google",
  "vertex_ai-video-models": "google",
  "vertex_ai-embedding-models": "google",
  xai: "x-ai",
  mistral: "mistral",
  elevenlabs: "elevenlabs",
  groq: "groq",
  cohere: "cohere",
  cloudflare: "cloudflare",
  minimax: "minimax",
  meta: "meta",
};

const VIDEO_MODES = new Set(["video_generation"]);
const AUDIO_MODES = new Set(["audio_transcription", "audio_speech"]);

/** Quality words a key prefix may carry. */
const QUALITY_WORDS = new Set(["auto", "low", "medium", "high", "xhigh", "max", "standard", "hd"]);
const SIZE_SEG = /^(\d{1,5})-x-(\d{1,5})$/;
const STEPS_SEG = /^(?:\d{1,4}|max)-steps$/;
const FIELD = /^(input|output)_cost_per_(image|second|video_per_second|character)(?:_(.+))?$/;
const IMAGE_SIZE_SUFFIX = /^(?:\d+(?:\.\d+)?k|\d{3,5})$/i;
const SECOND_RES_SUFFIX = /^\d{3,4}p$|^\d{1,2}k$/;

export type MediaSkipReason =
  /** A price of exactly 0. */
  | "zero"
  /** A per-second price whose mode says neither video nor audio. */
  | "mode_unclear"
  /** A key prefix or field suffix that does not map to quality and resolution. */
  | "unmapped_tier"
  /** Two keys give one price key different prices: neither is used. */
  | "conflict"
  /** No provider, a bad id, or a value that is not a non-negative number. */
  | "invalid";

export interface MediaParseSummary {
  /** Entries in the file (less `sample_spec`). */
  entries: number;
  models: number;
  /** Price keys kept, by unit. */
  keysByUnit: Partial<Record<ModelPriceUnit, number>>;
  /** Prices skipped, by reason. */
  skipped: Record<MediaSkipReason, number>;
}

export interface ParsedMediaFeed {
  models: ParsedModel[];
  summary: MediaParseSummary;
}

/** The provider id we store for a `litellm_provider` value. */
export const mediaProviderOf = (litellmProvider: string): string =>
  MEDIA_PROVIDER_MAP[litellmProvider] ?? litellmProvider.toLowerCase();

/** A key segment names the provider: `vertex_ai` also prefixes `vertex_ai-language-models`. */
const isProviderSeg = (seg: string, raw: string) => seg === raw || raw.startsWith(`${seg}-`);

/**
 * A model key → model id and tiers; null when a prefix segment looks like a tier but does not
 * map cleanly (`max-x-max`, two qualities, two sizes).
 */
export function mediaKeyOf(
  key: string,
  litellmProvider: string,
): { model: string; quality: string; resolution: string } | null {
  const segs = key.split("/");
  let i = 0;
  let stripped = false;
  let quality = "";
  let resolution = "";
  while (i < segs.length - 1) {
    const s = segs[i]!;
    if (!stripped && isProviderSeg(s, litellmProvider)) {
      stripped = true;
      i++;
      continue;
    }
    const size = SIZE_SEG.exec(s);
    if (size) {
      if (resolution) return null;
      resolution = `${Number(size[1])}x${Number(size[2])}`;
    } else if (QUALITY_WORDS.has(s) || STEPS_SEG.test(s)) {
      if (quality) return null;
      quality = s;
    } else if (s.includes("-x-")) {
      return null;
    } else break;
    i++;
  }
  return { model: segs.slice(i).join("/"), quality, resolution };
}

interface FieldMap {
  tokenType: "input" | "output";
  unit: ModelPriceUnit;
  resolution: string;
}

/** A cost field → kind, unit and resolution; "skip" for one we do not import; a reason to count. */
export function mediaFieldOf(
  field: string,
  mode: string | undefined,
): FieldMap | "skip" | "mode_unclear" | "unmapped_tier" {
  const m = FIELD.exec(field);
  if (!m) return "skip";
  const kind = m[1] as "input" | "output";
  const what = m[2]!;
  const suffix = m[3];
  const secondUnit: ModelPriceUnit | null =
    mode && VIDEO_MODES.has(mode)
      ? "video_second"
      : mode && AUDIO_MODES.has(mode)
        ? "audio_second"
        : null;
  switch (what) {
    case "image":
      if (suffix === undefined) return { tokenType: kind, unit: "image", resolution: "" };
      if (kind === "output" && IMAGE_SIZE_SUFFIX.test(suffix))
        return { tokenType: kind, unit: "image", resolution: suffix.toLowerCase() };
      return "skip";
    case "second":
      if (suffix !== undefined && !(kind === "output" && SECOND_RES_SUFFIX.test(suffix)))
        return "skip";
      // Input seconds are audio only (a video model's input is not priced per second here).
      if (!secondUnit || (kind === "input" && secondUnit !== "audio_second")) return "mode_unclear";
      return { tokenType: kind, unit: secondUnit, resolution: suffix ?? "" };
    case "video_per_second":
      return suffix === undefined
        ? { tokenType: kind, unit: "video_second", resolution: "" }
        : "skip";
    case "character":
      return suffix === undefined && kind === "input"
        ? { tokenType: kind, unit: "character", resolution: "" }
        : "skip";
  }
  return "skip";
}

/** Parse the file. Throws `FeedSchemaError` when it is not an object of model entries. */
export function parseMediaFeed(text: string): ParsedMediaFeed {
  let raw: unknown;
  try {
    raw = parseJsonExact(text);
  } catch {
    throw new FeedSchemaError("The media source did not return JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new FeedSchemaError("The media source does not match the expected format at (root)");

  const summary: MediaParseSummary = {
    entries: 0,
    models: 0,
    keysByUnit: {},
    skipped: { zero: 0, mode_unclear: 0, unmapped_tier: 0, conflict: 0, invalid: 0 },
  };
  const models = new Map<
    string,
    { provider: string; model: string; prices: Map<string, ParsedPrice> }
  >();
  const conflicted = new Set<string>();

  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "sample_spec") continue;
    summary.entries++;
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const e = v as Record<string, unknown>;
    const mode = typeof e.mode === "string" ? e.mode : undefined;
    const found: Array<[FieldMap, JsonNumber]> = [];
    for (const [field, value] of Object.entries(e)) {
      const f = mediaFieldOf(field, mode);
      if (f === "skip") continue;
      if (!(value instanceof JsonNumber)) {
        summary.skipped.invalid++;
        continue;
      }
      if (f === "mode_unclear" || f === "unmapped_tier") {
        summary.skipped[f]++;
        continue;
      }
      found.push([f, value]);
    }
    if (found.length === 0) continue;
    const prov = e.litellm_provider;
    if (typeof prov !== "string" || prov.length < 1 || prov.length > 100) {
      summary.skipped.invalid += found.length;
      continue;
    }
    const k = mediaKeyOf(key, prov);
    if (!k) {
      summary.skipped.unmapped_tier += found.length;
      continue;
    }
    if (k.model.length < 1 || k.model.length > 200 || k.model.includes("*")) {
      summary.skipped.invalid += found.length;
      continue;
    }
    const provider = mediaProviderOf(prov);
    for (const [f, value] of found) {
      // A size in the key and another in the field name: which one priced it is unclear.
      if (f.resolution && k.resolution && f.resolution !== k.resolution) {
        summary.skipped.unmapped_tier++;
        continue;
      }
      const resolution = f.resolution || k.resolution;
      if (!TIER_RE.test(k.quality) || !TIER_RE.test(resolution)) {
        summary.skipped.unmapped_tier++;
        continue;
      }
      let parsed: { value: bigint; rounded: boolean };
      try {
        parsed = majorTextToMinorFixed12(value.text);
      } catch {
        summary.skipped.invalid++;
        continue;
      }
      if (parsed.value === 0n) {
        summary.skipped.zero++;
        continue;
      }
      const mk = `${provider}\u0000${k.model}`;
      const pk = priceKey(f.tokenType, f.unit, k.quality, resolution);
      const fullKey = `${mk}\u0000${pk}`;
      if (conflicted.has(fullKey)) {
        summary.skipped.conflict++;
        continue;
      }
      const m = models.get(mk) ?? { provider, model: k.model, prices: new Map() };
      models.set(mk, m);
      const price: ParsedPrice = {
        tokenType: f.tokenType,
        unit: f.unit,
        quality: k.quality,
        resolution,
        value: parsed.value,
        divisor: 1n,
        rounded: parsed.rounded,
      };
      const prev = m.prices.get(pk);
      if (prev && prev.value !== price.value) {
        m.prices.delete(pk);
        conflicted.add(fullKey);
        summary.skipped.conflict += 2;
        continue;
      }
      // The same price under two keys (`vertex_ai/x` and `x`): one key.
      m.prices.set(pk, price);
    }
  }

  const out: ParsedModel[] = [];
  for (const m of [...models.values()].sort((a, b) =>
    a.provider === b.provider ? (a.model < b.model ? -1 : 1) : a.provider < b.provider ? -1 : 1,
  )) {
    if (m.prices.size === 0) continue;
    for (const p of m.prices.values())
      summary.keysByUnit[p.unit] = (summary.keysByUnit[p.unit] ?? 0) + 1;
    out.push({
      provider: m.provider,
      model: m.model,
      aliases: [],
      contextTiers: null,
      entries: [{ startDate: null, prices: m.prices, tiers: null }],
    });
  }
  summary.models = out.length;
  return { models: out, summary };
}

/**
 * Name each media model as the first feed does: an id that is the first feed's alias of a model
 * under the same provider becomes that model (`voxtral-mini-latest` → `voxtral-mini-2602`), so
 * a lookup by the alias still finds the model with the token prices. Prices of two ids that
 * meet on one model merge; a price key they give differently is dropped and counted.
 * `aliasOf(provider, id)` = the model that alias names, or undefined (none, or not unique).
 */
export function canonicalMediaModels(
  models: ParsedModel[],
  aliasOf: (provider: string, id: string) => string | undefined,
): { models: ParsedModel[]; renamed: number; conflicts: number } {
  const out = new Map<string, ParsedModel>();
  const dropped = new Set<string>();
  let renamed = 0;
  let conflicts = 0;
  for (const m of models) {
    const to = aliasOf(m.provider, m.model);
    if (to && to !== m.model) renamed++;
    const model = to ?? m.model;
    const mk = `${m.provider}\u0000${model}`;
    const into = out.get(mk);
    if (!into) {
      out.set(mk, {
        ...m,
        model,
        entries: [{ ...m.entries[0]!, prices: new Map(m.entries[0]!.prices) }],
      });
      continue;
    }
    const prices = into.entries[0]!.prices;
    for (const [pk, p] of m.entries[0]!.prices) {
      if (dropped.has(`${mk}\u0000${pk}`)) continue;
      const prev = prices.get(pk);
      if (prev && prev.value !== p.value) {
        prices.delete(pk);
        dropped.add(`${mk}\u0000${pk}`);
        conflicts++;
      } else prices.set(pk, p);
    }
  }
  return {
    models: [...out.values()].filter((m) => m.entries[0]!.prices.size > 0),
    renamed,
    conflicts,
  };
}

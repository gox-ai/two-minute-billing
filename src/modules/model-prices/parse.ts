/**
 * The price source feed (genai-prices v2 `data_slim.json`, MIT) read into our own shape.
 *
 * A zod subset: provider id, model id, `match.equals` aliases and `prices`. Numbers stay the
 * text the source wrote (`parseJsonExact`), so no price passes through a float. Each price key
 * maps to a kind, a unit and a divisor (`feedPriceKeyOf`). Only the
 * standard price is kept: `price_variants` (batch, service tier) and time-of-day entries
 * (`constraint.start_time`) are skipped and counted. Context tiers keep their base price.
 */
import { z } from "zod";
import { JsonNumber, parseJsonExact } from "@/modules/metering/json-source";
import { majorTextToMinorFixed12 } from "./decimal";
import type { ModelPriceUnit } from "./units";

/** One price of one kind in one unit: cents per `divisor` units, Fixed12. */
export interface ParsedPrice {
  tokenType: string;
  unit: ModelPriceUnit;
  /** '' or absent = no tier (the first feed has none). */
  quality?: string;
  resolution?: string;
  value: bigint;
  divisor: bigint;
  rounded: boolean;
}

/** The `ParsedEntry.prices` key: kind, unit and tier (a tier only when there is one). */
export const priceKey = (tokenType: string, unit: string, quality = "", resolution = "") =>
  quality || resolution
    ? `${tokenType}\u0000${unit}\u0000${quality}\u0000${resolution}`
    : `${tokenType}\u0000${unit}`;

/** A dated entry. `startDate` null = the undated first entry ("before we tracked it"). */
export interface ParsedEntry {
  startDate: string | null;
  /** By `priceKey(kind, unit)`. */
  prices: Map<string, ParsedPrice>;
  tiers: Record<string, unknown> | null;
}

export interface ParsedModel {
  provider: string;
  model: string;
  aliases: string[];
  /** Per token type, as published (USD text): `{ base, tiers: [{ start, price }] }`. */
  contextTiers: Record<string, unknown> | null;
  entries: ParsedEntry[];
}

export interface ParseSummary {
  providers: number;
  models: number;
  /** Price keys whose suffix is not a unit we know. */
  skippedUnits: number;
  /** Time-of-day entries (`start_time`/`end_time`): not the standard price. */
  skippedTimeOfDay: number;
  /** Models or entries refused by our own limits (id length, bad date, bad number). */
  skippedInvalid: number;
}

export interface ParsedFeed {
  models: ParsedModel[];
  summary: ParseSummary;
}

export class FeedSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedSchemaError";
  }
}

const num = z.instanceof(JsonNumber);
const tiered = z.object({
  base: num,
  tiers: z.array(z.object({ start: num, price: num }).passthrough()),
});
const priceMap = z.record(z.string(), z.union([num, tiered]));
const entry = z.object({
  constraint: z
    .object({
      start_date: z.string().optional(),
      start_time: z.string().optional(),
      end_time: z.string().optional(),
    })
    .passthrough()
    .optional(),
  prices: priceMap,
});
const model = z
  .object({
    id: z.string(),
    match: z.unknown().optional(),
    prices: z.union([priceMap, z.array(entry).min(1)]),
  })
  .passthrough();
const feed = z.array(
  z.object({ id: z.string(), name: z.string().optional(), models: z.array(model) }).passthrough(),
);

const SUFFIX_UNITS: Record<string, { unit: ModelPriceUnit; divisor: bigint }> = {
  mtok: { unit: "token", divisor: 1_000_000n },
  kcount: { unit: "request", divisor: 1_000n },
  mchars: { unit: "character", divisor: 1_000_000n },
  kpages: { unit: "page", divisor: 1_000n },
  gpixels: { unit: "pixel", divisor: 1_000_000_000n },
};

/**
 * A feed price key → kind, unit and divisor; null for a suffix we do not know.
 * `<kind>_mtok` per 1M tokens · `<kind>_kcount` per 1K requests · `<kind>_mchars` per 1M
 * characters · `<kind>_kpages` per 1K pages · `<kind>_gpixels` per 1B pixels ·
 * `[<kind>_]audio_hours` per 3,600 audio seconds (bare `audio_hours` is kind `audio`).
 */
export function feedPriceKeyOf(
  key: string,
): { tokenType: string; unit: ModelPriceUnit; divisor: bigint } | null {
  const audio = /^(?:([a-z0-9_]+?)_)?audio_hours$/.exec(key);
  if (audio) return { tokenType: audio[1] ?? "audio", unit: "audio_second", divisor: 3600n };
  const m = /^([a-z0-9_]+?)_(mtok|kcount|mchars|kpages|gpixels)$/.exec(key);
  if (!m) return null;
  return { tokenType: m[1]!, ...SUFFIX_UNITS[m[2]!]! };
}

/** `equals` values at the top of `match` or under its `or`; never patterns. */
export function aliasesOf(match: unknown, id: string): string[] {
  const out = new Set<string>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (typeof n.equals === "string") out.add(n.equals);
    if (Array.isArray(n.or)) n.or.forEach(visit);
  };
  visit(match);
  out.delete(id);
  return [...out].filter((a) => a.length >= 1 && a.length <= 200).sort();
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

function tiersAsText(v: z.infer<typeof tiered>): Record<string, unknown> {
  return {
    base: v.base.text,
    tiers: v.tiers.map((t) => ({ start: t.start.text, price: t.price.text })),
  };
}

/** Parse and normalize the feed text. Throws `FeedSchemaError` when the shape is not the feed. */
export function parseFeed(text: string): ParsedFeed {
  let raw: unknown;
  try {
    raw = parseJsonExact(text);
  } catch {
    throw new FeedSchemaError("The source did not return JSON");
  }
  const parsed = feed.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new FeedSchemaError(
      `The source does not match the expected format at ${issue?.path.join(".") || "(root)"}`,
    );
  }
  const summary: ParseSummary = {
    providers: 0,
    models: 0,
    skippedUnits: 0,
    skippedTimeOfDay: 0,
    skippedInvalid: 0,
  };
  const models: ParsedModel[] = [];
  for (const p of parsed.data) {
    if (p.id.length < 1 || p.id.length > 100) {
      summary.skippedInvalid++;
      continue;
    }
    summary.providers++;
    const seen = new Set<string>();
    for (const m of p.models) {
      if (m.id.length < 1 || m.id.length > 200 || seen.has(m.id)) {
        summary.skippedInvalid++;
        continue;
      }
      seen.add(m.id);
      const rawEntries = Array.isArray(m.prices) ? m.prices : [{ prices: m.prices }];
      const entries: ParsedEntry[] = [];
      let invalid = false;
      for (const e of rawEntries) {
        const c = "constraint" in e ? e.constraint : undefined;
        if (c?.start_time !== undefined || c?.end_time !== undefined) {
          summary.skippedTimeOfDay++;
          continue;
        }
        const startDate = c?.start_date ?? null;
        if (startDate !== null && !validDate(startDate)) {
          invalid = true;
          break;
        }
        const prices = new Map<string, ParsedPrice>();
        let tiers: Record<string, unknown> | null = null;
        for (const [key, v] of Object.entries(e.prices)) {
          const unit = feedPriceKeyOf(key);
          if (!unit || unit.tokenType.length > 100) {
            summary.skippedUnits++;
            continue;
          }
          const text = v instanceof JsonNumber ? v.text : v.base.text;
          // Token tiers keep their kind as the key (as before 0524); other units the feed key.
          if (!(v instanceof JsonNumber))
            (tiers ??= {})[unit.unit === "token" ? unit.tokenType : key] = tiersAsText(v);
          try {
            const { value, rounded } = majorTextToMinorFixed12(text);
            prices.set(priceKey(unit.tokenType, unit.unit), { ...unit, value, rounded });
          } catch {
            invalid = true;
          }
        }
        entries.push({ startDate, prices, tiers });
      }
      if (invalid) {
        summary.skippedInvalid++;
        continue;
      }
      // Undated first, then by date (stable: a later duplicate date wins in the sync's map).
      entries.sort((a, b) =>
        a.startDate === b.startDate
          ? 0
          : a.startDate === null
            ? -1
            : b.startDate === null
              ? 1
              : a.startDate < b.startDate
                ? -1
                : 1,
      );
      // No price in a unit we know: not a list model.
      if (!entries.some((e) => e.prices.size > 0)) continue;
      summary.models++;
      models.push({
        provider: p.id,
        model: m.id,
        aliases: aliasesOf(m.match, m.id),
        contextTiers: entries.at(-1)!.tiers,
        entries,
      });
    }
  }
  return { models, summary };
}

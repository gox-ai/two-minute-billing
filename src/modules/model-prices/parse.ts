/**
 * The price source feed (genai-prices v2 `data_slim.json`, MIT) read into our own shape.
 *
 * A zod subset: provider id, model id, `match.equals` aliases and `prices`. Numbers stay the
 * text the source wrote (`parseJsonExact`), so no price passes through a float. Only the
 * standard price is kept: `price_variants` (batch, service tier) and time-of-day entries
 * (`constraint.start_time`) are skipped and counted. Context tiers keep their base price.
 */
import { z } from "zod";
import { JsonNumber, parseJsonExact } from "@/modules/metering/json-source";
import { majorTextToMinorFixed12 } from "./decimal";

/** One price of one token type: cents per `divisor` units, Fixed12. */
export interface ParsedPrice {
  value: bigint;
  divisor: bigint;
  rounded: boolean;
}

/** A dated entry. `startDate` null = the undated first entry ("before we tracked it"). */
export interface ParsedEntry {
  startDate: string | null;
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
  /** Price keys whose unit we do not bill (hours, pages, characters). */
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

/** `<x>_mtok` → per 1,000,000; `<x>_kcount` → per 1,000. Anything else is not billed. */
export function tokenTypeOf(key: string): { tokenType: string; divisor: bigint } | null {
  const m = /^([a-z0-9_]+?)_(mtok|kcount)$/.exec(key);
  if (!m) return null;
  return { tokenType: m[1]!, divisor: m[2] === "mtok" ? 1_000_000n : 1_000n };
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
          const unit = tokenTypeOf(key);
          if (!unit || unit.tokenType.length > 100) {
            summary.skippedUnits++;
            continue;
          }
          const text = v instanceof JsonNumber ? v.text : v.base.text;
          if (!(v instanceof JsonNumber)) (tiers ??= {})[unit.tokenType] = tiersAsText(v);
          try {
            const { value, rounded } = majorTextToMinorFixed12(text);
            prices.set(unit.tokenType, { value, divisor: unit.divisor, rounded });
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
      // Nothing we bill (only hours, pages or characters): not a list model.
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

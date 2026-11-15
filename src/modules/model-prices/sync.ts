/**
 * `model_prices_sync`: the AI model price list, fetched every hour into our own dated table
 * (design G1b § 3.2). We bill only from the table, so every billed price is reproducible.
 *
 * Fetch through the egress guard (no private target, no redirect), 20 s, body capped at 5 MB,
 * `If-None-Match` with the last ETag. Diff per key against our rows; append, never update.
 * A run that looks wrong (> 25 % of known keys change, a price drops to 0, or one moves more
 * than ×10) is held in `reference_data_sources.held_batch`; nothing is written. It applies on
 * its own once the source has listed the same suspect prices for `SETTLE_MS`, so a source slip
 * corrected within hours never reaches a bill and nobody has to watch prices. Staff may apply
 * or drop it sooner. Either way it applies from that instant: recorded usage keeps its price.
 */
import { sql, type SQL } from "drizzle-orm";
import { systemDb, type Tx } from "@/platform/db";
import { config } from "@/platform/config";
import { describeEgressError, guardedFetch } from "@/platform/egress";
import { fixed12FromNumeric } from "@/platform/fixed";
import { publicId, uuidv7 } from "@/platform/ids";
import { createLogger } from "@/platform/logger";
import { pgTextArray, rowsOf } from "@/modules/metering/usage-sql";
import { numericText } from "./decimal";
import {
  FeedSchemaError,
  parseFeed,
  type ParsedModel,
  type ParsedPrice,
  type ParseSummary,
} from "./parse";
import {
  canonicalMediaModels,
  MEDIA_SOURCE_NAME,
  parseMediaFeed,
  type MediaParseSummary,
} from "./parse-media";
import { recordModelPriceChanges, type ModelPriceChange } from "./notices";
import { legacyUnitOf } from "./units";

const log = createLogger("model-prices.sync");

/** `reference_data_sources.source` for this feed. */
export const MODEL_PRICES_SOURCE = "model_prices";
/** `model_prices.source`: who published the price. */
export const MODEL_PRICES_SOURCE_NAME = "genai-prices";
export const MODEL_PRICES_LICENCE =
  "MIT License, Copyright (c) Pydantic Services Inc. 2025 to present";
export const LIST_CURRENCY = "USD";

export const FETCH_TIMEOUT_MS = 20_000;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** `reference_data_sources.source` for the media feed (its own ETag, success and error). */
export const MEDIA_SOURCE = "model_prices_media";
/** The media file is ~4 MB and growing. */
export const MEDIA_FETCH_TIMEOUT_MS = 60_000;
export const MEDIA_MAX_BODY_BYTES = 12 * 1024 * 1024;
/** Hold a key both sources price when they differ by more than this, either way. */
export const CROSS_CHECK_MARGIN_PERCENT = 25n;
/** The hold reason for such keys. */
export const SOURCES_DISAGREE = "sources_disagree";
/**
 * Two prices this close are one price written two ways ($0.111 per hour vs 3.083e-05 per
 * second): the key keeps the source that holds it, so a rounding never reads as a change.
 */
export const SAME_PRICE_PERCENT = 1n;
/** Hold a run that changes more than this share of the keys we know. */
export const HOLD_CHANGED_SHARE = 0.25;
/** Hold a run that moves any price by more than this factor, up or down. */
export const HOLD_FACTOR = 10n;
/** A held batch applies on its own once its suspect prices have been unchanged this long. */
export const SETTLE_MS = 6 * 3_600_000;
/** `released_by` on rows a settled batch wrote (staff releases record the staff email). */
export const SETTLED_BY = "settled";

export class SourceFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceFetchError";
  }
}

// ── Fetch ────────────────────────────────────────────────────────────────────

type Fetched = { status: 304 } | { status: 200; text: string; etag: string | null };

async function readCapped(res: Response, cap: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > cap)
    throw new SourceFetchError(`The source sent more than ${cap / 1024 / 1024} MB`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new SourceFetchError(`The source sent more than ${cap / 1024 / 1024} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** GET the feed through the egress guard. A 3xx is a failure: redirects are never followed. */
export async function fetchModelPriceFeed(
  url: string,
  etag: string | null,
  limits: { timeoutMs: number; maxBytes: number } = {
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: MAX_BODY_BYTES,
  },
): Promise<Fetched> {
  let res: Response;
  try {
    res = await guardedFetch(url, {
      headers: {
        accept: "application/json",
        ...(etag ? { "if-none-match": etag } : {}),
      },
      signal: AbortSignal.timeout(limits.timeoutMs),
    });
  } catch (e) {
    log.warn("model price source fetch failed", { event: "model_prices_fetch_failed", error: e });
    throw new SourceFetchError(describeEgressError(e).replace("endpoint", "source"));
  }
  if (res.status === 304) return { status: 304 };
  if (res.status < 200 || res.status > 299) {
    await res.body?.cancel().catch(() => {});
    throw new SourceFetchError(`The source answered HTTP ${res.status}`);
  }
  let text: string;
  try {
    text = await readCapped(res, limits.maxBytes);
  } catch (e) {
    if (e instanceof SourceFetchError) throw e;
    throw new SourceFetchError(describeEgressError(e).replace("endpoint", "source"));
  }
  return { status: 200, text, etag: res.headers.get("etag") };
}

// ── Source row ───────────────────────────────────────────────────────────────

export interface HeldRow {
  provider: string;
  model: string;
  tokenType: string;
  /** Absent on batches held before 0524: read as `legacyUnitOf(divisor)`. */
  unit?: string;
  /** '' = no tier. Absent on batches held before 0524. */
  quality?: string;
  resolution?: string;
  /** numeric(38,12) text, minor units per divisor. */
  unitAmount: string;
  divisor: string;
  rounded: boolean;
  /** "-infinity" (a new key's first price), "now" (applied-from = the apply instant), or a date. */
  from: string;
  sourceEffectiveFrom: string | null;
  /** The price this row replaces; null for a new key. */
  oldUnitAmount: string | null;
  /** That price's divisor. Absent on batches held before it was recorded. */
  oldDivisor?: string | null;
  /** Who published the price. Absent = the first feed (batches held before the second). */
  source?: string;
  /** That source's version; absent = the batch's `sourceVersion`. */
  sourceVersion?: string | null;
  /** Set when the other source prices this key more than the margin apart. */
  crossCheck?: { source: string; unitAmount: string; divisor: string };
}

export interface HeldModel {
  provider: string;
  model: string;
  aliases: string[];
  contextTiers: Record<string, unknown> | null;
  /** The media feed has no aliases: its models never overwrite the first feed's. */
  source?: string;
}

export interface HeldBatch {
  syncRunId: string;
  /** Since when the source has listed these suspect prices; the batch settles `SETTLE_MS` later. */
  heldAt: string;
  /** Since when some batch has been held, across changes of content. Absent on older batches. */
  firstHeldAt?: string;
  sourceVersion: string | null;
  reasons: string[];
  knownKeys: number;
  changedKeys: number;
  rows: HeldRow[];
  models: HeldModel[];
}

/** The media feed's own sync state. */
export interface MediaSourceState {
  source: typeof MEDIA_SOURCE_NAME;
  url: string;
  upstreamVersion: string | null;
  checkedAt: Date | null;
  checkError: string | null;
  lastSuccessAt: Date | null;
}

export interface ModelPriceSourceState {
  url: string;
  upstreamVersion: string | null;
  checkedAt: Date | null;
  checkError: string | null;
  lastSuccessAt: Date | null;
  /** The merged batch (both feeds) lives on the first feed's row. */
  held: HeldBatch | null;
  /** Null = the media feed is off (`MODEL_PRICES_MEDIA_SOURCE_URL=off`). */
  media?: MediaSourceState | null;
}

/** The media feed URL, or null when it is off. */
export const mediaSourceUrl = (): string | null =>
  config.MODEL_PRICES_MEDIA_SOURCE_URL === "off" ? null : config.MODEL_PRICES_MEDIA_SOURCE_URL;

/** Both feeds' sync state (platform-global; read through the system connection). */
export async function readModelPriceSource(): Promise<ModelPriceSourceState> {
  const rows = rowsOf<{
    source: string;
    upstream_version: string | null;
    checked_at: Date | null;
    check_error: string | null;
    last_success_at: Date | null;
    held_batch: HeldBatch | null;
  }>(
    await systemDb.execute(sql`
      select source, upstream_version, checked_at, check_error, last_success_at, held_batch
      from reference_data_sources where source in (${MODEL_PRICES_SOURCE}, ${MEDIA_SOURCE})`),
  );
  const row = rows.find((r) => r.source === MODEL_PRICES_SOURCE);
  const m = rows.find((r) => r.source === MEDIA_SOURCE);
  const mediaUrl = mediaSourceUrl();
  return {
    url: config.MODEL_PRICES_SOURCE_URL,
    upstreamVersion: row?.upstream_version ?? null,
    checkedAt: row?.checked_at ? new Date(row.checked_at) : null,
    checkError: row?.check_error ?? null,
    lastSuccessAt: row?.last_success_at ? new Date(row.last_success_at) : null,
    held: row?.held_batch ?? null,
    media: mediaUrl
      ? {
          source: MEDIA_SOURCE_NAME,
          url: mediaUrl,
          upstreamVersion: m?.upstream_version ?? null,
          checkedAt: m?.checked_at ? new Date(m.checked_at) : null,
          checkError: m?.check_error ?? null,
          lastSuccessAt: m?.last_success_at ? new Date(m.last_success_at) : null,
        }
      : null,
  };
}

async function writeSource(
  tx: Tx | typeof systemDb,
  set: {
    checkedAt?: Date;
    checkError?: string | null;
    upstreamVersion?: string | null;
    lastSuccessAt?: Date;
    held?: HeldBatch | null;
  },
  source: string = MODEL_PRICES_SOURCE,
): Promise<void> {
  const cols: string[] = [];
  const vals: SQL[] = [];
  const add = (c: string, v: SQL) => {
    cols.push(c);
    vals.push(v);
  };
  if (set.checkedAt) add("checked_at", sql`${set.checkedAt.toISOString()}::timestamptz`);
  if (set.checkError !== undefined) add("check_error", sql`${set.checkError}`);
  if (set.upstreamVersion !== undefined) add("upstream_version", sql`${set.upstreamVersion}`);
  if (set.lastSuccessAt)
    add("last_success_at", sql`${set.lastSuccessAt.toISOString()}::timestamptz`);
  if (set.held !== undefined)
    add("held_batch", set.held === null ? sql`null` : sql`${JSON.stringify(set.held)}::jsonb`);
  await tx.execute(sql`
    insert into reference_data_sources (source, ${sql.raw(cols.join(", "))})
    values (${source}, ${sql.join(vals, sql`, `)})
    on conflict (source) do update set ${sql.join(
      cols.map((c) => sql.raw(`${c} = excluded.${c}`)),
      sql`, `,
    )}`);
}

// ── Diff ─────────────────────────────────────────────────────────────────────

interface DbRow {
  fromMs: number;
  value: bigint;
  divisor: bigint;
  /** `model_prices.source`; absent = the first feed. */
  source?: string;
}

/** The diff key: provider, model, kind, unit and tier. */
export const keyOf = (
  provider: string,
  model: string,
  tokenType: string,
  unit = "token",
  quality = "",
  resolution = "",
) => `${provider}\u0000${model}\u0000${tokenType}\u0000${unit}\u0000${quality}\u0000${resolution}`;

/** A held row's unit and tier, reading a pre-0524 row as before. */
const tierOf = (r: HeldRow) => ({
  unit: r.unit ?? legacyUnitOf(r.divisor),
  quality: r.quality ?? "",
  resolution: r.resolution ?? "",
});
const heldKeyOf = (r: HeldRow) => {
  const t = tierOf(r);
  return keyOf(r.provider, r.model, r.tokenType, t.unit, t.quality, t.resolution);
};

async function loadCurrentRows(tx: Tx | typeof systemDb): Promise<Map<string, DbRow[]>> {
  const rows = rowsOf<{
    provider: string;
    model: string;
    token_type: string;
    unit: string;
    quality: string;
    resolution: string;
    v: string;
    d: string;
    from_ms: string | null;
    source: string;
  }>(
    await tx.execute(sql`
      select provider, model, token_type, unit, quality, resolution,
        unit_amount_decimal::text as v,
        quantity_divisor::text as d,
        case when effective_from = '-infinity' then null
          else (extract(epoch from effective_from) * 1000)::bigint::text end as from_ms,
        source
      from model_prices where currency = ${LIST_CURRENCY}
      order by effective_from asc`),
  );
  const out = new Map<string, DbRow[]>();
  for (const r of rows) {
    const k = keyOf(r.provider, r.model, r.token_type, r.unit, r.quality, r.resolution);
    const list = out.get(k) ?? [];
    list.push({
      fromMs: r.from_ms == null ? Number.NEGATIVE_INFINITY : Number(r.from_ms),
      value: fixed12FromNumeric(r.v),
      divisor: BigInt(r.d),
      source: r.source,
    });
    out.set(k, list);
  }
  return out;
}

export interface SyncPlan {
  rows: HeldRow[];
  models: HeldModel[];
  knownKeys: number;
  changedKeys: number;
  reasons: string[];
  /** Future-dated rows we already hold at a different price: left alone (rows never change). */
  futureConflicts: number;
  /** Keys owned by a source that was not read this run, which the other source also prices. */
  frozenKeys: number;
}

/** Inputs beyond the first feed. Absent = the first feed alone, as before the second. */
export interface PlanOptions {
  /** The media feed's models; null or absent = off or not read this run. */
  media?: ParsedModel[] | null;
  /** False when the first feed was not read this run (`models` is then empty). */
  primaryAvailable?: boolean;
  primaryVersion?: string | null;
  mediaVersion?: string | null;
}

const dateMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const sameDivisorValue = (a: { value: bigint; divisor: bigint }, b: DbRow) =>
  a.value * b.divisor === b.value * a.divisor;

/** Two prices more than `percent` apart per unit, either way. */
export function pricesDisagree(
  a: { value: bigint; divisor: bigint },
  b: { value: bigint; divisor: bigint },
  percent = CROSS_CHECK_MARGIN_PERCENT,
): boolean {
  const x = a.value * b.divisor;
  const y = b.value * a.divisor;
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return hi * 100n > lo * (100n + percent);
}

/** Who owns a key now: the source of its live row (else its first row). */
const ownerOf = (rows: DbRow[], nowMs: number): string =>
  ([...rows].reverse().find((r) => r.fromMs <= nowMs) ?? rows[0])?.source ??
  MODEL_PRICES_SOURCE_NAME;

/**
 * The rows that made a batch suspect, as one string: equal strings mean the source still lists
 * the same suspect prices. Under `many_keys_changed` every changed row counts; a cross-checked
 * row always counts, with the other source's price.
 */
export function suspectFingerprint(b: Pick<HeldBatch, "rows" | "reasons">): string {
  const all = b.reasons.includes("many_keys_changed");
  return b.rows
    .filter((r) => {
      if (r.crossCheck) return true;
      if (r.oldUnitAmount === null) return false;
      if (all) return true;
      const o = fixed12FromNumeric(r.oldUnitAmount) * BigInt(r.divisor);
      const n = fixed12FromNumeric(r.unitAmount) * BigInt(r.oldDivisor ?? r.divisor);
      return o > 0n && (n === 0n || n > o * HOLD_FACTOR || o > n * HOLD_FACTOR);
    })
    .map((r) => {
      // A pre-0524 row and the same row after it give the same string: the clock keeps running.
      const t = tierOf(r);
      const extra =
        t.unit === legacyUnitOf(r.divisor) && !t.quality && !t.resolution
          ? ""
          : `\u0000${t.unit}\u0000${t.quality}\u0000${t.resolution}`;
      const cross = r.crossCheck
        ? `\u0000${r.crossCheck.source}=${r.crossCheck.unitAmount}/${r.crossCheck.divisor}`
        : "";
      return `${r.provider}\u0000${r.model}\u0000${r.tokenType}${extra}\u0000${r.unitAmount}/${r.divisor}${cross}`;
    })
    .sort()
    .join("\n");
}

/** When a held batch applies on its own if the source keeps listing it. */
export const settlesAt = (h: Pick<HeldBatch, "heldAt">): Date =>
  new Date(Date.parse(h.heldAt) + SETTLE_MS);

/** One key's wanted prices: a dated timeline from one source. */
interface Want {
  model: ParsedModel;
  /** date ("" = undated) → price, ascending. */
  timeline: Array<[string, ParsedPrice]>;
  source: string;
  version: string | null | undefined;
  /** The first feed's live price for a key the media feed won, when they disagree. */
  other?: { source: string; value: bigint; divisor: bigint };
}

const byDate = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * What a run would write, and whether it must be held. Pure. Both feeds are merged into one
 * wanted state first, then diffed once, so the two never fight over a key.
 */
export function planSync(
  models: ParsedModel[],
  current: Map<string, DbRow[]>,
  now: Date,
  opts: PlanOptions = {},
): SyncPlan {
  const nowMs = now.getTime();
  const today = now.toISOString().slice(0, 10);
  const rows: HeldRow[] = [];
  const touched = new Set<string>();
  const reasons = new Set<string>();
  let futureConflicts = 0;
  let frozenKeys = 0;
  const knownKeys = current.size;
  const media = opts.media ?? null;
  const frozen = new Set<string>();
  if (opts.primaryAvailable === false) frozen.add(MODEL_PRICES_SOURCE_NAME);
  if (!media) frozen.add(MEDIA_SOURCE_NAME);

  // Known keys and changed known keys per owner: the share rule is per source, so one feed's
  // new keys never dilute the other's.
  const known = new Map<string, number>();
  for (const list of current.values()) {
    const o = ownerOf(list, nowMs);
    known.set(o, (known.get(o) ?? 0) + 1);
  }
  const changed = new Map<string, Set<string>>();

  // ── The wanted state ──
  const wants = new Map<string, Want>();
  for (const m of models) {
    // Kind + unit (`priceKey`); the first feed has no tiers.
    const priceKeys = new Set(m.entries.flatMap((e) => [...e.prices.keys()]));
    for (const pk of priceKeys) {
      // date (or "" for undated) → price; a later duplicate date wins.
      const timeline = new Map<string, ParsedPrice>();
      for (const e of m.entries) {
        const p = e.prices.get(pk);
        if (p) timeline.set(e.startDate ?? "", p);
      }
      const entries = [...timeline.entries()].sort(byDate);
      const p0 = entries[0]![1];
      const k = keyOf(m.provider, m.model, p0.tokenType, p0.unit, p0.quality, p0.resolution);
      wants.set(k, {
        model: m,
        timeline: entries,
        source: MODEL_PRICES_SOURCE_NAME,
        version: opts.primaryVersion,
      });
    }
  }
  for (const m of media ?? []) {
    for (const p of m.entries[0]?.prices.values() ?? []) {
      // Token and request keys always come from the first feed.
      if (p.unit === "token" || p.unit === "request") continue;
      const k = keyOf(m.provider, m.model, p.tokenType, p.unit, p.quality, p.resolution);
      const first = wants.get(k);
      const live = first
        ? [...first.timeline].reverse().find(([d]) => d === "" || d <= today)
        : null;
      // The same price in both: the key stays with the source that holds it (else the first).
      if (live && !pricesDisagree(live[1], p, SAME_PRICE_PERCENT)) {
        const held = current.get(k);
        if (!held || ownerOf(held, nowMs) !== MEDIA_SOURCE_NAME) continue;
      }
      wants.set(k, {
        model: m,
        timeline: [["", p]],
        source: MEDIA_SOURCE_NAME,
        version: opts.mediaVersion,
        ...(live && pricesDisagree(live[1], p)
          ? {
              other: {
                source: MODEL_PRICES_SOURCE_NAME,
                value: live[1].value,
                divisor: live[1].divisor,
              },
            }
          : {}),
      });
    }
  }

  // ── The diff ──
  const plan = (
    k: string,
    w: Want,
    p: ParsedPrice,
    from: string,
    sourceEffectiveFrom: string | null,
    old: { value: bigint; divisor: bigint } | null,
    owner: string | null,
  ) => {
    const m = w.model;
    rows.push({
      provider: m.provider,
      model: m.model,
      tokenType: p.tokenType,
      unit: p.unit,
      quality: p.quality ?? "",
      resolution: p.resolution ?? "",
      unitAmount: numericText(p.value),
      divisor: p.divisor.toString(),
      rounded: p.rounded,
      from,
      sourceEffectiveFrom,
      oldUnitAmount: old ? numericText(old.value) : null,
      oldDivisor: old ? old.divisor.toString() : null,
      source: w.source,
      ...(w.version !== undefined ? { sourceVersion: w.version } : {}),
      ...(w.other
        ? {
            crossCheck: {
              source: w.other.source,
              unitAmount: numericText(w.other.value),
              divisor: w.other.divisor.toString(),
            },
          }
        : {}),
    });
    touched.add(`${w.source}\u0000${m.provider}\u0000${m.model}`);
    // A cross-checked key is held on its own; it does not judge the rest of the run.
    if (!old || !owner || w.other) return;
    const set = changed.get(owner) ?? new Set<string>();
    set.add(k);
    changed.set(owner, set);
    // Compare per unit: a divisor change alone is not a price move.
    const o = old.value * p.divisor;
    const n = p.value * old.divisor;
    if (o > 0n && n === 0n) reasons.add("price_to_zero");
    if (o > 0n && n > 0n && (n > o * HOLD_FACTOR || o > n * HOLD_FACTOR))
      reasons.add("price_moved_tenfold");
  };

  for (const [k, w] of wants) {
    const entries = w.timeline;
    const existing = current.get(k);
    if (!existing) {
      // A new key. Not a change of anything we billed, so it never counts towards a hold and
      // sends no notice (`changesOf` skips rows with no old price). Every past date applies
      // from the same instant (now), so only the one in effect today is written: the undated
      // first price, the live past entry, then the future ones.
      const livePast = [...entries].reverse().find(([d]) => d !== "" && d <= today)?.[0];
      for (const [date, p] of entries) {
        if (date !== "" && date <= today && date !== livePast) continue;
        plan(k, w, p, date === "" ? "-infinity" : date, date || null, null, null);
      }
      continue;
    }
    const owner = ownerOf(existing, nowMs);
    // The owner was not read this run: its keys stay as they are, never taken over.
    if (owner !== w.source && frozen.has(owner)) {
      frozenKeys++;
      continue;
    }
    const atNow = [...existing].reverse().find((r) => r.fromMs <= nowMs) ?? null;
    const live = [...entries].reverse().find(([d]) => d === "" || d <= today);
    if (live) {
      const [date, p] = live;
      if (!atNow || !sameDivisorValue(p, atNow))
        plan(k, w, p, "now", date || null, atNow, atNow ? owner : null);
    }
    let prev = live?.[1] ?? null;
    for (const [date, p] of entries) {
      if (date === "" || date <= today) continue;
      const held = existing.find((r) => r.fromMs === dateMs(date));
      if (held) {
        if (!sameDivisorValue(p, held)) futureConflicts++;
      } else if (!prev || p.value * prev.divisor !== prev.value * p.divisor) {
        const before = [...existing].reverse().find((r) => r.fromMs < dateMs(date)) ?? null;
        plan(k, w, p, date, date, prev ?? before, owner);
      }
      prev = p;
    }
  }
  for (const [owner, set] of changed) {
    const n = known.get(owner) ?? 0;
    if (n > 0 && set.size / n > HOLD_CHANGED_SHARE) reasons.add("many_keys_changed");
  }
  if (rows.some((r) => r.crossCheck)) reasons.add(SOURCES_DISAGREE);

  // A model both feeds list keeps the first feed's names (the media feed has no aliases).
  const models_: HeldModel[] = [];
  const seen = new Set<string>();
  const firstByKey = new Map(models.map((m) => [`${m.provider}\u0000${m.model}`, m]));
  for (const [list, source] of [
    [models, MODEL_PRICES_SOURCE_NAME],
    [media ?? [], MEDIA_SOURCE_NAME],
  ] as const) {
    for (const m of list) {
      const mk = `${m.provider}\u0000${m.model}`;
      if (seen.has(mk) || !touched.has(`${source}\u0000${mk}`)) continue;
      // A model whose rows all came from the media feed but which the first feed also lists.
      const firstToo = source === MEDIA_SOURCE_NAME && firstByKey.get(mk);
      seen.add(mk);
      const named = firstToo || m;
      models_.push({
        provider: named.provider,
        model: named.model,
        aliases: named.aliases,
        contextTiers: named.contextTiers,
        ...(firstToo || source === MODEL_PRICES_SOURCE_NAME ? {} : { source: MEDIA_SOURCE_NAME }),
      });
    }
  }
  const changedKeys = [...changed.values()].reduce((n, s) => n + s.size, 0);
  return {
    rows,
    models: models_,
    knownKeys,
    changedKeys,
    reasons: [...reasons].sort(),
    futureConflicts,
    frozenKeys,
  };
}

// ── Apply ────────────────────────────────────────────────────────────────────

const CHUNK = 500;

async function upsertModels(
  tx: Tx,
  all: HeldModel[],
  now: Date,
  touchLastSeen: boolean,
): Promise<void> {
  // A media-feed model never overwrites names the first feed gave the same model.
  const media = all.filter((m) => m.source === MEDIA_SOURCE_NAME);
  for (let i = 0; i < media.length; i += CHUNK) {
    const part = media.slice(i, i + CHUNK);
    await tx.execute(sql`
      insert into model_price_models
        (provider, model, aliases, context_tiers, first_seen_at, last_seen_at)
      select x.provider, x.model, '{}'::text[], null,
        ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz
      from unnest(${pgTextArray(part.map((m) => m.provider))}::text[],
                  ${pgTextArray(part.map((m) => m.model))}::text[]) as x(provider, model)
      on conflict (provider, model) do ${touchLastSeen ? sql`update set last_seen_at = excluded.last_seen_at` : sql`nothing`}`);
  }
  const models = all.filter((m) => m.source !== MEDIA_SOURCE_NAME);
  for (let i = 0; i < models.length; i += CHUNK) {
    const part = models.slice(i, i + CHUNK);
    await tx.execute(sql`
      insert into model_price_models
        (provider, model, aliases, context_tiers, first_seen_at, last_seen_at)
      select x.provider, x.model, x.aliases::text[], x.tiers::jsonb,
        ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz
      from unnest(${pgTextArray(part.map((m) => m.provider))}::text[],
                  ${pgTextArray(part.map((m) => m.model))}::text[],
                  ${pgTextArray(part.map((m) => pgTextArray(m.aliases)))}::text[],
                  ${pgTextArray(part.map((m) => (m.contextTiers ? JSON.stringify(m.contextTiers) : null)))}::text[])
        as x(provider, model, aliases, tiers)
      on conflict (provider, model) do update set
        aliases = excluded.aliases,
        context_tiers = excluded.context_tiers
        ${touchLastSeen ? sql`, last_seen_at = excluded.last_seen_at` : sql``}`);
  }
}

interface AppliedRow extends HeldRow {
  unit: string;
  quality: string;
  resolution: string;
  id: string;
  publicId: string;
  effectiveFrom: string;
}

async function insertRows(
  tx: Tx,
  rows: HeldRow[],
  ctx: { now: Date; syncRunId: string; sourceVersion: string | null; releasedBy: string | null },
): Promise<AppliedRow[]> {
  const nowIso = ctx.now.toISOString();
  const checkedOn = nowIso.slice(0, 10);
  const applied: AppliedRow[] = rows.map((r) => ({
    ...r,
    ...tierOf(r),
    id: uuidv7(),
    publicId: publicId("mpr"),
    // A released future date that has passed applies from the release instant.
    effectiveFrom:
      r.from === "-infinity"
        ? "-infinity"
        : r.from === "now" || dateMs(r.from) <= ctx.now.getTime()
          ? nowIso
          : `${r.from}T00:00:00Z`,
  }));
  const inserted = new Set<string>();
  for (let i = 0; i < applied.length; i += CHUNK) {
    const part = applied.slice(i, i + CHUNK);
    const res = rowsOf<{ public_id: string }>(
      await tx.execute(sql`
      insert into model_prices (id, public_id, provider, model, token_type, unit, quality,
        resolution, currency, unit_amount_decimal, quantity_divisor, effective_from, source,
        source_version, source_effective_from, source_checked_on, rounded, sync_run_id, released_by)
      select x.id::uuid, x.pid, x.provider, x.model, x.token_type, x.u, x.q, x.res, ${LIST_CURRENCY},
        x.v::numeric, x.d::bigint, x.f::timestamptz, x.src, x.sv, x.sd::date,
        ${checkedOn}::date, x.r::boolean,
        ${ctx.syncRunId}::uuid, ${ctx.releasedBy}
      from unnest(${pgTextArray(part.map((r) => r.id))}::text[],
                  ${pgTextArray(part.map((r) => r.publicId))}::text[],
                  ${pgTextArray(part.map((r) => r.provider))}::text[],
                  ${pgTextArray(part.map((r) => r.model))}::text[],
                  ${pgTextArray(part.map((r) => r.tokenType))}::text[],
                  ${pgTextArray(part.map((r) => r.unit))}::text[],
                  ${pgTextArray(part.map((r) => r.quality))}::text[],
                  ${pgTextArray(part.map((r) => r.resolution))}::text[],
                  ${pgTextArray(part.map((r) => r.unitAmount))}::text[],
                  ${pgTextArray(part.map((r) => r.divisor))}::text[],
                  ${pgTextArray(part.map((r) => r.effectiveFrom))}::text[],
                  ${pgTextArray(part.map((r) => r.sourceEffectiveFrom))}::text[],
                  ${pgTextArray(part.map((r) => String(r.rounded)))}::text[],
                  ${pgTextArray(part.map((r) => r.source ?? MODEL_PRICES_SOURCE_NAME))}::text[],
                  ${pgTextArray(part.map((r) => (r.sourceVersion !== undefined ? r.sourceVersion : ctx.sourceVersion)))}::text[])
        as x(id, pid, provider, model, token_type, u, q, res, v, d, f, sd, r, src, sv)
      on conflict (provider, model, token_type, unit, quality, resolution, currency, effective_from)
        do nothing
      returning public_id`),
    );
    for (const r of res) inserted.add(r.public_id);
  }
  return applied.filter((r) => inserted.has(r.publicId));
}

function changesOf(applied: AppliedRow[], sourceVersion: string | null): ModelPriceChange[] {
  return applied
    .filter((r) => r.oldUnitAmount !== null)
    .map((r) => ({
      provider: r.provider,
      model: r.model,
      tokenType: r.tokenType,
      unit: r.unit,
      quality: r.quality,
      resolution: r.resolution,
      currency: LIST_CURRENCY,
      modelPriceId: r.publicId,
      oldUnitAmountDecimal: r.oldUnitAmount,
      newUnitAmountDecimal: r.unitAmount,
      quantityDivisor: r.divisor,
      effectiveFrom: r.effectiveFrom,
      sourceEffectiveFrom: r.sourceEffectiveFrom,
      source: r.source ?? MODEL_PRICES_SOURCE_NAME,
      sourceVersion: r.sourceVersion !== undefined ? r.sourceVersion : sourceVersion,
    }));
}

// ── The job ──────────────────────────────────────────────────────────────────

/** One feed's part of a run. */
type SourceRead<T> =
  | { status: "fresh"; parsed: T; etag: string | null }
  | { status: "not_modified" }
  | { status: "failed"; error: string };

export interface SourceFailure {
  source: string;
  error: string;
}

export type SyncOutcome = (
  | { status: "disabled" }
  | { status: "not_modified" }
  | { status: "failed"; error: string }
  | { status: "held"; reasons: string[]; rows: number; settlesAt: string }
  /** The source was unchanged and the held batch had settled: it applied. */
  | { status: "settled"; rows: number; changes: number }
  | {
      status: "applied";
      /** True when this run applied a batch that had been held and settled. */
      settled: boolean;
      rows: number;
      models: number;
      changes: number;
      /** Null when the first feed was not read this run. */
      summary: ParseSummary | null;
      futureConflicts: number;
      /** The media feed, when it was read. */
      mediaModels?: number;
      mediaSummary?: MediaParseSummary;
      /** Keys the two feeds price more than the margin apart: held, the rest applied. */
      heldRows?: number;
    }
) & {
  /** A feed that could not be read this run; its keys stayed as they were. */
  failures?: SourceFailure[];
};

interface SourceSpec<T> {
  source: string;
  name: string;
  parse: (text: string) => T;
  limits: { timeoutMs: number; maxBytes: number };
}

const PRIMARY: SourceSpec<ReturnType<typeof parseFeed>> = {
  source: MODEL_PRICES_SOURCE,
  name: MODEL_PRICES_SOURCE_NAME,
  parse: parseFeed,
  limits: { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_BODY_BYTES },
};
const MEDIA: SourceSpec<ReturnType<typeof parseMediaFeed>> = {
  source: MEDIA_SOURCE,
  name: MEDIA_SOURCE_NAME,
  parse: parseMediaFeed,
  limits: { timeoutMs: MEDIA_FETCH_TIMEOUT_MS, maxBytes: MEDIA_MAX_BODY_BYTES },
};

async function readSource<T>(
  spec: SourceSpec<T>,
  url: string,
  etag: string | null,
): Promise<SourceRead<T>> {
  try {
    const f = await fetchModelPriceFeed(url, etag, spec.limits);
    if (f.status === 304) return { status: "not_modified" };
    return { status: "fresh", parsed: spec.parse(f.text), etag: f.etag };
  } catch (e) {
    if (!(e instanceof SourceFetchError || e instanceof FeedSchemaError))
      log.error(e, { event: "model_prices_sync_failed", source: spec.name });
    return {
      status: "failed",
      error:
        e instanceof SourceFetchError || e instanceof FeedSchemaError
          ? e.message
          : "We could not read the source",
    };
  }
}

/**
 * One run of `model_prices_sync`. Never throws for a source failure: it is stored.
 * `mediaUrl` null = the media feed is not read; absent = `MODEL_PRICES_MEDIA_SOURCE_URL`.
 */
export async function runModelPriceSync(
  opts: { now?: Date; url?: string; mediaUrl?: string | null } = {},
): Promise<SyncOutcome> {
  if (config.MODEL_PRICES_SYNC === "off") return { status: "disabled" };
  const now = opts.now ?? new Date();
  const url = opts.url ?? config.MODEL_PRICES_SOURCE_URL;
  const mediaUrl = opts.mediaUrl !== undefined ? opts.mediaUrl : mediaSourceUrl();
  const state = await readModelPriceSource();

  let a = await readSource(PRIMARY, url, state.upstreamVersion);
  let b = mediaUrl ? await readSource(MEDIA, mediaUrl, await mediaEtag()) : null;

  if (a.status !== "fresh" && b?.status !== "fresh") {
    // A failure keeps the ETag, the last good check, the last success and any held batch.
    await writeSource(
      systemDb,
      a.status === "not_modified" ? { checkedAt: now, checkError: null } : { checkError: a.error },
    );
    if (b)
      await writeSource(
        systemDb,
        b.status === "not_modified"
          ? { checkedAt: now, checkError: null }
          : { checkError: b.error },
        MEDIA_SOURCE,
      );
    const failures = failuresOf(a, b);
    const fail = failures.length ? { failures } : {};
    // Every feed still lists what it listed: a held batch past its settle time applies.
    if (
      a.status === "not_modified" &&
      b?.status !== "failed" &&
      state.held &&
      settlesAt(state.held) <= now
    ) {
      try {
        const r = await releaseHeldModelPrices({
          by: SETTLED_BY,
          syncRunId: state.held.syncRunId,
          now,
        });
        return { status: "settled", ...r, ...fail };
      } catch (e) {
        // Staff applied or dropped it first.
        if (!(e instanceof NoHeldBatchError)) throw e;
      }
    }
    if (a.status === "failed") return { status: "failed", error: a.error, ...fail };
    return { status: "not_modified", ...fail };
  }

  // One feed changed: read the other in full, so the plan merges both.
  if (a.status === "not_modified") a = refetched(await readSource(PRIMARY, url, null));
  if (b?.status === "not_modified") b = refetched(await readSource(MEDIA, mediaUrl!, null));
  const failures = failuresOf(a, b);
  const fail = failures.length ? { failures } : {};
  const primary = a.status === "fresh" ? a : null;
  const media = b?.status === "fresh" ? b : null;

  const syncRunId = uuidv7();
  const sourceVersion = primary?.etag ?? null;
  return systemDb.transaction(async (tx) => {
    // One sync at a time, and against the rows as they are now.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('model_prices_sync'))`);
    const mediaModels = media
      ? canonicalMediaModels(media.parsed.models, await aliasIndex(tx, primary?.parsed.models))
          .models
      : null;
    const plan = planSync(primary?.parsed.models ?? [], await loadCurrentRows(tx), now, {
      media: mediaModels,
      primaryAvailable: primary !== null,
      primaryVersion: sourceVersion,
      mediaVersion: media?.etag ?? null,
    });
    const prev = await readHeldBatch(tx);
    // Same suspect prices as the batch already held: its settle clock keeps running.
    const heldAt =
      prev && suspectFingerprint(prev) === suspectFingerprint(plan)
        ? prev.heldAt
        : now.toISOString();
    const settled = plan.reasons.length > 0 && settlesAt({ heldAt }) <= now;
    const batch = (rows: HeldRow[], reasons: string[]): HeldBatch => {
      const named = new Set(rows.map((r) => `${r.provider}\u0000${r.model}`));
      return {
        syncRunId,
        heldAt,
        firstHeldAt: prev ? (prev.firstHeldAt ?? prev.heldAt) : now.toISOString(),
        sourceVersion,
        reasons,
        knownKeys: plan.knownKeys,
        changedKeys: plan.changedKeys,
        rows,
        models: plan.models.filter((m) => named.has(`${m.provider}\u0000${m.model}`)),
      };
    };
    const writeStates = async (applied: boolean, held: HeldBatch | null) => {
      await writeSource(
        tx,
        primary
          ? {
              checkedAt: now,
              checkError: null,
              upstreamVersion: primary.etag,
              ...(applied ? { lastSuccessAt: now } : {}),
              held,
            }
          : { checkError: a.status === "failed" ? a.error : null, held },
      );
      if (media)
        await writeSource(
          tx,
          {
            checkedAt: now,
            checkError: null,
            upstreamVersion: media.etag,
            ...(applied ? { lastSuccessAt: now } : {}),
          },
          MEDIA_SOURCE,
        );
      else if (b?.status === "failed") await writeSource(tx, { checkError: b.error }, MEDIA_SOURCE);
    };

    // A suspicious run holds whole; keys the two feeds disagree on hold on their own.
    if (plan.reasons.some((r) => r !== SOURCES_DISAGREE) && !settled) {
      const held = batch(plan.rows, plan.reasons);
      await writeStates(false, held);
      log.warn("model price batch held", {
        event: "model_prices_held",
        reasons: plan.reasons,
        rows: plan.rows.length,
        changed_keys: plan.changedKeys,
        known_keys: plan.knownKeys,
        settles_at: settlesAt(held).toISOString(),
      });
      return {
        status: "held",
        reasons: plan.reasons,
        rows: plan.rows.length,
        settlesAt: settlesAt(held).toISOString(),
        ...fail,
      } as const;
    }
    if (settled)
      log.info("model price batch settled", {
        event: "model_prices_settled",
        reasons: plan.reasons,
        held_at: heldAt,
      });
    const crossRows = settled ? [] : plan.rows.filter((r) => r.crossCheck);
    // Every model in each feed read: names and tiers refresh, last_seen_at moves.
    await upsertModels(
      tx,
      [
        ...(mediaModels ?? []).map((m) => ({
          provider: m.provider,
          model: m.model,
          aliases: [],
          contextTiers: null,
          source: MEDIA_SOURCE_NAME,
        })),
        ...(primary?.parsed.models ?? []).map((m) => ({
          provider: m.provider,
          model: m.model,
          aliases: m.aliases,
          contextTiers: m.contextTiers,
        })),
      ],
      now,
      true,
    );
    const applied = await insertRows(
      tx,
      crossRows.length ? plan.rows.filter((r) => !r.crossCheck) : plan.rows,
      { now, syncRunId, sourceVersion, releasedBy: settled ? SETTLED_BY : null },
    );
    const changes = changesOf(applied, sourceVersion);
    await recordModelPriceChanges(tx, { syncRunId, changes, now });
    // Superseded: this run's diff already holds whatever the sources still say.
    const held = crossRows.length ? batch(crossRows, [SOURCES_DISAGREE]) : null;
    await writeStates(true, held);
    if (held)
      log.warn("model price keys held: the sources disagree", {
        event: "model_prices_held",
        reasons: held.reasons,
        rows: crossRows.length,
        settles_at: settlesAt(held).toISOString(),
      });
    return {
      status: "applied",
      settled,
      rows: applied.length,
      models: primary?.parsed.models.length ?? 0,
      changes: changes.length,
      summary: primary?.parsed.summary ?? null,
      futureConflicts: plan.futureConflicts,
      ...(media && mediaModels
        ? { mediaModels: mediaModels.length, mediaSummary: media.parsed.summary }
        : {}),
      ...(held ? { heldRows: crossRows.length } : {}),
      ...fail,
    } as const;
  });
}

/** A full re-read that still answers 304 cannot be merged: a failure for this run. */
function refetched<T>(r: SourceRead<T>): SourceRead<T> {
  return r.status === "not_modified"
    ? { status: "failed", error: "The source answered 304 to a request without an ETag" }
    : r;
}

function failuresOf(a: SourceRead<unknown>, b: SourceRead<unknown> | null): SourceFailure[] {
  const out: SourceFailure[] = [];
  if (a.status === "failed") out.push({ source: MODEL_PRICES_SOURCE_NAME, error: a.error });
  if (b?.status === "failed") out.push({ source: MEDIA_SOURCE_NAME, error: b.error });
  return out;
}

/**
 * `(provider, alias)` → the model it names: this run's first feed where read, else the names
 * on the list. An alias two models claim names neither.
 */
async function aliasIndex(
  tx: Tx,
  first: ParsedModel[] | undefined,
): Promise<(provider: string, id: string) => string | undefined> {
  const named = first
    ? first.map((m) => ({ provider: m.provider, model: m.model, aliases: m.aliases }))
    : rowsOf<{ provider: string; model: string; aliases: string[] }>(
        await tx.execute(sql`select provider, model, aliases from model_price_models
          where cardinality(aliases) > 0`),
      );
  const ids = new Set(named.map((m) => `${m.provider}\u0000${m.model}`));
  const index = new Map<string, string | null>();
  for (const m of named)
    for (const a of m.aliases) {
      const k = `${m.provider}\u0000${a}`;
      index.set(k, index.has(k) && index.get(k) !== m.model ? null : m.model);
    }
  return (provider, id) => {
    const k = `${provider}\u0000${id}`;
    // A model id of its own is never renamed.
    return ids.has(k) ? undefined : (index.get(k) ?? undefined);
  };
}

async function mediaEtag(): Promise<string | null> {
  const [row] = rowsOf<{ upstream_version: string | null }>(
    await systemDb.execute(sql`select upstream_version from reference_data_sources
      where source = ${MEDIA_SOURCE}`),
  );
  return row?.upstream_version ?? null;
}

// ── Release / drop ───────────────────────────────────────────────────────────

/** The held batch, row-locked for the rest of the transaction. */
async function readHeldBatch(tx: Tx): Promise<HeldBatch | null> {
  const [row] = rowsOf<{ held_batch: HeldBatch | null }>(
    await tx.execute(sql`select held_batch from reference_data_sources
      where source = ${MODEL_PRICES_SOURCE} for update`),
  );
  return row?.held_batch ?? null;
}

export class NoHeldBatchError extends Error {
  constructor() {
    super("No price batch is held.");
    this.name = "NoHeldBatchError";
  }
}

/**
 * Apply the held batch from `now` (the release instant): by staff, or by the sync once it settled. A row whose key already shows the
 * same price at `now` is skipped, so a release after the source settled writes nothing twice.
 */
export async function releaseHeldModelPrices(input: {
  by: string;
  syncRunId?: string;
  now?: Date;
}): Promise<{ rows: number; changes: number }> {
  const now = input.now ?? new Date();
  return systemDb.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('model_prices_sync'))`);
    const held = await readHeldBatch(tx);
    if (!held || (input.syncRunId && held.syncRunId !== input.syncRunId))
      throw new NoHeldBatchError();
    const current = await loadCurrentRows(tx);
    const nowMs = now.getTime();
    const rows = held.rows.filter((r) => {
      const existing = current.get(heldKeyOf(r));
      if (!existing) return true;
      const atNow = [...existing].reverse().find((e) => e.fromMs <= nowMs);
      const p = { value: fixed12FromNumeric(r.unitAmount), divisor: BigInt(r.divisor) };
      if (r.from === "-infinity") return false;
      return !atNow || !sameDivisorValue(p, atNow);
    });
    await upsertModels(tx, held.models, now, false);
    const applied = await insertRows(tx, rows, {
      now,
      syncRunId: held.syncRunId,
      sourceVersion: held.sourceVersion,
      releasedBy: input.by,
    });
    const changes = changesOf(applied, held.sourceVersion);
    await recordModelPriceChanges(tx, { syncRunId: held.syncRunId, changes, now });
    await writeSource(tx, { held: null, lastSuccessAt: now });
    // The media feed's prices applied too: its last success moves, as in a run.
    if (held.rows.some((r) => r.source === MEDIA_SOURCE_NAME))
      await writeSource(tx, { lastSuccessAt: now }, MEDIA_SOURCE);
    log.info("model price batch released", {
      event: "model_prices_released",
      by: input.by,
      rows: applied.length,
    });
    return { rows: applied.length, changes: changes.length };
  });
}

/** Drop the held batch: nothing is written. The next changed feed is diffed afresh. */
export async function dropHeldModelPrices(input: {
  by: string;
  syncRunId?: string;
}): Promise<void> {
  await systemDb.transaction(async (tx) => {
    const held = await readHeldBatch(tx);
    if (!held || (input.syncRunId && held.syncRunId !== input.syncRunId))
      throw new NoHeldBatchError();
    await writeSource(tx, { held: null });
    log.info("model price batch dropped", { event: "model_prices_dropped", by: input.by });
  });
}

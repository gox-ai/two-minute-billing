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
import { FeedSchemaError, parseFeed, type ParsedModel, type ParseSummary } from "./parse";
import { recordModelPriceChanges, type ModelPriceChange } from "./notices";

const log = createLogger("model-prices.sync");

/** `reference_data_sources.source` for this feed. */
export const MODEL_PRICES_SOURCE = "model_prices";
/** `model_prices.source`: who published the price. */
export const MODEL_PRICES_SOURCE_NAME = "genai-prices";
export const MODEL_PRICES_LICENCE = "MIT, Copyright (c) Pydantic Services Inc. 2025 to present";
export const LIST_CURRENCY = "USD";

export const FETCH_TIMEOUT_MS = 20_000;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
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
export async function fetchModelPriceFeed(url: string, etag: string | null): Promise<Fetched> {
  let res: Response;
  try {
    res = await guardedFetch(url, {
      headers: {
        accept: "application/json",
        ...(etag ? { "if-none-match": etag } : {}),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
    text = await readCapped(res, MAX_BODY_BYTES);
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
}

export interface HeldModel {
  provider: string;
  model: string;
  aliases: string[];
  contextTiers: Record<string, unknown> | null;
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

export interface ModelPriceSourceState {
  url: string;
  upstreamVersion: string | null;
  checkedAt: Date | null;
  checkError: string | null;
  lastSuccessAt: Date | null;
  held: HeldBatch | null;
}

/** The feed's sync state (platform-global; read through the system connection). */
export async function readModelPriceSource(): Promise<ModelPriceSourceState> {
  const [row] = rowsOf<{
    upstream_version: string | null;
    checked_at: Date | null;
    check_error: string | null;
    last_success_at: Date | null;
    held_batch: HeldBatch | null;
  }>(
    await systemDb.execute(sql`
      select upstream_version, checked_at, check_error, last_success_at, held_batch
      from reference_data_sources where source = ${MODEL_PRICES_SOURCE}`),
  );
  return {
    url: config.MODEL_PRICES_SOURCE_URL,
    upstreamVersion: row?.upstream_version ?? null,
    checkedAt: row?.checked_at ? new Date(row.checked_at) : null,
    checkError: row?.check_error ?? null,
    lastSuccessAt: row?.last_success_at ? new Date(row.last_success_at) : null,
    held: row?.held_batch ?? null,
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
    values (${MODEL_PRICES_SOURCE}, ${sql.join(vals, sql`, `)})
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
}

const keyOf = (provider: string, model: string, tokenType: string) =>
  `${provider}\u0000${model}\u0000${tokenType}`;

async function loadCurrentRows(tx: Tx | typeof systemDb): Promise<Map<string, DbRow[]>> {
  const rows = rowsOf<{
    provider: string;
    model: string;
    token_type: string;
    v: string;
    d: string;
    from_ms: string | null;
  }>(
    await tx.execute(sql`
      select provider, model, token_type, unit_amount_decimal::text as v,
        quantity_divisor::text as d,
        case when effective_from = '-infinity' then null
          else (extract(epoch from effective_from) * 1000)::bigint::text end as from_ms
      from model_prices where currency = ${LIST_CURRENCY}
      order by effective_from asc`),
  );
  const out = new Map<string, DbRow[]>();
  for (const r of rows) {
    const k = keyOf(r.provider, r.model, r.token_type);
    const list = out.get(k) ?? [];
    list.push({
      fromMs: r.from_ms == null ? Number.NEGATIVE_INFINITY : Number(r.from_ms),
      value: fixed12FromNumeric(r.v),
      divisor: BigInt(r.d),
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
}

const dateMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const sameDivisorValue = (a: { value: bigint; divisor: bigint }, b: DbRow) =>
  a.value * b.divisor === b.value * a.divisor;

/**
 * The rows that made a batch suspect, as one string: equal strings mean the source still lists
 * the same suspect prices. Under `many_keys_changed` every changed row counts.
 */
export function suspectFingerprint(b: Pick<HeldBatch, "rows" | "reasons">): string {
  const all = b.reasons.includes("many_keys_changed");
  return b.rows
    .filter((r) => {
      if (r.oldUnitAmount === null) return false;
      if (all) return true;
      const o = fixed12FromNumeric(r.oldUnitAmount) * BigInt(r.divisor);
      const n = fixed12FromNumeric(r.unitAmount) * BigInt(r.oldDivisor ?? r.divisor);
      return o > 0n && (n === 0n || n > o * HOLD_FACTOR || o > n * HOLD_FACTOR);
    })
    .map(
      (r) => `${r.provider}\u0000${r.model}\u0000${r.tokenType}\u0000${r.unitAmount}/${r.divisor}`,
    )
    .sort()
    .join("\n");
}

/** When a held batch applies on its own if the source keeps listing it. */
export const settlesAt = (h: Pick<HeldBatch, "heldAt">): Date =>
  new Date(Date.parse(h.heldAt) + SETTLE_MS);

/** What a run would write, and whether it must be held. Pure. */
export function planSync(
  models: ParsedModel[],
  current: Map<string, DbRow[]>,
  now: Date,
): SyncPlan {
  const nowMs = now.getTime();
  const today = now.toISOString().slice(0, 10);
  const rows: HeldRow[] = [];
  const touched = new Set<string>();
  const changedKnown = new Set<string>();
  const reasons = new Set<string>();
  let futureConflicts = 0;
  const knownKeys = current.size;

  const plan = (
    m: ParsedModel,
    tokenType: string,
    p: { value: bigint; divisor: bigint; rounded: boolean },
    from: string,
    sourceEffectiveFrom: string | null,
    old: { value: bigint; divisor: bigint } | null,
  ) => {
    rows.push({
      provider: m.provider,
      model: m.model,
      tokenType,
      unitAmount: numericText(p.value),
      divisor: p.divisor.toString(),
      rounded: p.rounded,
      from,
      sourceEffectiveFrom,
      oldUnitAmount: old ? numericText(old.value) : null,
      oldDivisor: old ? old.divisor.toString() : null,
    });
    touched.add(`${m.provider}\u0000${m.model}`);
    if (!old) return;
    changedKnown.add(keyOf(m.provider, m.model, tokenType));
    // Compare per unit: a divisor change alone is not a price move.
    const o = old.value * p.divisor;
    const n = p.value * old.divisor;
    if (o > 0n && n === 0n) reasons.add("price_to_zero");
    if (o > 0n && n > 0n && (n > o * HOLD_FACTOR || o > n * HOLD_FACTOR))
      reasons.add("price_moved_tenfold");
  };

  for (const m of models) {
    const tokenTypes = new Set(m.entries.flatMap((e) => [...e.prices.keys()]));
    for (const tokenType of tokenTypes) {
      // date (or "" for undated) → price; a later duplicate date wins.
      const timeline = new Map<string, { value: bigint; divisor: bigint; rounded: boolean }>();
      for (const e of m.entries) {
        const p = e.prices.get(tokenType);
        if (p) timeline.set(e.startDate ?? "", p);
      }
      const entries = [...timeline.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const existing = current.get(keyOf(m.provider, m.model, tokenType));
      if (!existing) {
        // A new key: its whole dated history. Not a change of anything we billed.
        for (const [date, p] of entries)
          plan(m, tokenType, p, date === "" ? "-infinity" : date, date || null, null);
        continue;
      }
      const atNow = [...existing].reverse().find((r) => r.fromMs <= nowMs) ?? null;
      const live = [...entries].reverse().find(([d]) => d === "" || d <= today);
      if (live) {
        const [date, p] = live;
        if (!atNow || !sameDivisorValue(p, atNow))
          plan(m, tokenType, p, "now", date || null, atNow);
      }
      let prev = live?.[1] ?? null;
      for (const [date, p] of entries) {
        if (date === "" || date <= today) continue;
        const held = existing.find((r) => r.fromMs === dateMs(date));
        if (held) {
          if (!sameDivisorValue(p, held)) futureConflicts++;
        } else if (!prev || p.value * prev.divisor !== prev.value * p.divisor) {
          const before = [...existing].reverse().find((r) => r.fromMs < dateMs(date)) ?? null;
          plan(m, tokenType, p, date, date, prev ?? before);
        }
        prev = p;
      }
    }
  }
  if (knownKeys > 0 && changedKnown.size / knownKeys > HOLD_CHANGED_SHARE)
    reasons.add("many_keys_changed");
  const models_ = models
    .filter((m) => touched.has(`${m.provider}\u0000${m.model}`))
    .map((m) => ({
      provider: m.provider,
      model: m.model,
      aliases: m.aliases,
      contextTiers: m.contextTiers,
    }));
  return {
    rows,
    models: models_,
    knownKeys,
    changedKeys: changedKnown.size,
    reasons: [...reasons].sort(),
    futureConflicts,
  };
}

// ── Apply ────────────────────────────────────────────────────────────────────

const CHUNK = 500;

async function upsertModels(
  tx: Tx,
  models: HeldModel[],
  now: Date,
  touchLastSeen: boolean,
): Promise<void> {
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
      insert into model_prices (id, public_id, provider, model, token_type, currency,
        unit_amount_decimal, quantity_divisor, effective_from, source, source_version,
        source_effective_from, source_checked_on, rounded, sync_run_id, released_by)
      select x.id::uuid, x.pid, x.provider, x.model, x.token_type, ${LIST_CURRENCY},
        x.v::numeric, x.d::bigint, x.f::timestamptz, ${MODEL_PRICES_SOURCE_NAME},
        ${ctx.sourceVersion}, x.sd::date, ${checkedOn}::date, x.r::boolean,
        ${ctx.syncRunId}::uuid, ${ctx.releasedBy}
      from unnest(${pgTextArray(part.map((r) => r.id))}::text[],
                  ${pgTextArray(part.map((r) => r.publicId))}::text[],
                  ${pgTextArray(part.map((r) => r.provider))}::text[],
                  ${pgTextArray(part.map((r) => r.model))}::text[],
                  ${pgTextArray(part.map((r) => r.tokenType))}::text[],
                  ${pgTextArray(part.map((r) => r.unitAmount))}::text[],
                  ${pgTextArray(part.map((r) => r.divisor))}::text[],
                  ${pgTextArray(part.map((r) => r.effectiveFrom))}::text[],
                  ${pgTextArray(part.map((r) => r.sourceEffectiveFrom))}::text[],
                  ${pgTextArray(part.map((r) => String(r.rounded)))}::text[])
        as x(id, pid, provider, model, token_type, v, d, f, sd, r)
      on conflict (provider, model, token_type, currency, effective_from) do nothing
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
      currency: LIST_CURRENCY,
      modelPriceId: r.publicId,
      oldUnitAmountDecimal: r.oldUnitAmount,
      newUnitAmountDecimal: r.unitAmount,
      quantityDivisor: r.divisor,
      effectiveFrom: r.effectiveFrom,
      sourceEffectiveFrom: r.sourceEffectiveFrom,
      source: MODEL_PRICES_SOURCE_NAME,
      sourceVersion,
    }));
}

// ── The job ──────────────────────────────────────────────────────────────────

export type SyncOutcome =
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
      summary: ParseSummary;
      futureConflicts: number;
    };

/** One run of `model_prices_sync`. Never throws for a source failure: it is stored. */
export async function runModelPriceSync(
  opts: { now?: Date; url?: string } = {},
): Promise<SyncOutcome> {
  if (config.MODEL_PRICES_SYNC === "off") return { status: "disabled" };
  const now = opts.now ?? new Date();
  const url = opts.url ?? config.MODEL_PRICES_SOURCE_URL;
  const state = await readModelPriceSource();

  let fetched: Fetched;
  let parsed: ReturnType<typeof parseFeed>;
  try {
    fetched = await fetchModelPriceFeed(url, state.upstreamVersion);
    if (fetched.status === 304) {
      await writeSource(systemDb, { checkedAt: now, checkError: null });
      if (state.held && settlesAt(state.held) <= now) {
        try {
          const r = await releaseHeldModelPrices({
            by: SETTLED_BY,
            syncRunId: state.held.syncRunId,
            now,
          });
          return { status: "settled", ...r };
        } catch (e) {
          // Staff applied or dropped it first.
          if (!(e instanceof NoHeldBatchError)) throw e;
        }
      }
      return { status: "not_modified" };
    }
    parsed = parseFeed(fetched.text);
  } catch (e) {
    const error =
      e instanceof SourceFetchError || e instanceof FeedSchemaError
        ? e.message
        : "We could not read the source";
    if (!(e instanceof SourceFetchError || e instanceof FeedSchemaError))
      log.error(e, { event: "model_prices_sync_failed" });
    // A failure keeps the ETag, the last good check, the last success and any held batch.
    await writeSource(systemDb, { checkError: error });
    return { status: "failed", error };
  }

  const syncRunId = uuidv7();
  const sourceVersion = fetched.etag;
  return systemDb.transaction(async (tx) => {
    // One sync at a time, and against the rows as they are now.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('model_prices_sync'))`);
    const plan = planSync(parsed.models, await loadCurrentRows(tx), now);
    const prev = await readHeldBatch(tx);
    // Same suspect prices as the batch already held: its settle clock keeps running.
    const heldAt =
      prev && suspectFingerprint(prev) === suspectFingerprint(plan)
        ? prev.heldAt
        : now.toISOString();
    const settled = plan.reasons.length > 0 && settlesAt({ heldAt }) <= now;
    if (plan.reasons.length > 0 && !settled) {
      const held: HeldBatch = {
        syncRunId,
        heldAt,
        firstHeldAt: prev ? (prev.firstHeldAt ?? prev.heldAt) : now.toISOString(),
        sourceVersion,
        reasons: plan.reasons,
        knownKeys: plan.knownKeys,
        changedKeys: plan.changedKeys,
        rows: plan.rows,
        models: plan.models,
      };
      await writeSource(tx, {
        checkedAt: now,
        checkError: null,
        upstreamVersion: sourceVersion,
        held,
      });
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
      } as const;
    }
    if (settled)
      log.info("model price batch settled", {
        event: "model_prices_settled",
        reasons: plan.reasons,
        held_at: heldAt,
      });
    // Every model in the feed: aliases and tiers refresh, last_seen_at moves.
    await upsertModels(
      tx,
      parsed.models.map((m) => ({
        provider: m.provider,
        model: m.model,
        aliases: m.aliases,
        contextTiers: m.contextTiers,
      })),
      now,
      true,
    );
    const applied = await insertRows(tx, plan.rows, {
      now,
      syncRunId,
      sourceVersion,
      releasedBy: settled ? SETTLED_BY : null,
    });
    const changes = changesOf(applied, sourceVersion);
    await recordModelPriceChanges(tx, { syncRunId, changes, now });
    await writeSource(tx, {
      checkedAt: now,
      checkError: null,
      upstreamVersion: sourceVersion,
      lastSuccessAt: now,
      // Superseded: this run's diff already holds whatever the source still says.
      held: null,
    });
    return {
      status: "applied",
      settled,
      rows: applied.length,
      models: parsed.models.length,
      changes: changes.length,
      summary: parsed.summary,
      futureConflicts: plan.futureConflicts,
    } as const;
  });
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
      const existing = current.get(keyOf(r.provider, r.model, r.tokenType));
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

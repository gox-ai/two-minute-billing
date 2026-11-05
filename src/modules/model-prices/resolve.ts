/**
 * The two price resolvers (design G1b § 3.3). Each answers with the value AND the row it came
 * from, so a rated line can cite it.
 *
 * - list price: the `model_prices` row for (provider, model or alias, token type, currency)
 *   with the greatest `effective_from ≤ at`.
 * - model cost: the organization's own cost row live at `at`; else the list price.
 *
 * Rating needs many lookups inside one window and a synchronous rate resolver, so the rows are
 * loaded once into a `ModelPriceBook` and resolved in memory. `resolveListPrice` and
 * `resolveModelCost` are the one-shot SQL forms for screens and projections.
 *
 * Currency: the list is USD. Another currency resolves only through a cost row set in that
 * currency; a list price is never converted.
 */
import { sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { fixed12FromNumeric } from "@/platform/fixed";

export interface ModelKey {
  /** Null or absent = the provider is not known; resolved when the model is under one only. */
  provider?: string | null;
  /** The model as the event names it: a list model id or one of its exact aliases. */
  model: string;
  tokenType: string;
  currency: string;
}

export interface ListPriceHit {
  kind: "list";
  id: string;
  /** mpr_… — what a line cites. */
  publicId: string;
  provider: string;
  /** The list's own model id (an alias resolves to it). */
  model: string;
  tokenType: string;
  currency: string;
  /** Fixed12 minor units per `quantityDivisor` units. */
  unitAmount: bigint;
  quantityDivisor: bigint;
  /** Null = the model's first price, in effect since before we tracked it. */
  effectiveFrom: Date | null;
  source: string;
  sourceVersion: string | null;
  sourceEffectiveFrom: string | null;
}

export interface CostHit {
  kind: "cost";
  id: string;
  /** mco_… */
  publicId: string;
  provider: string | null;
  model: string;
  tokenType: string;
  currency: string;
  unitAmount: bigint;
  quantityDivisor: bigint;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export type PriceMissReason = "not_found" | "ambiguous_provider";
export interface PriceMiss {
  kind: null;
  reason: PriceMissReason;
}

export type ListPriceResult = ListPriceHit | PriceMiss;
export type ModelCostResult = CostHit | ListPriceHit | PriceMiss;

export interface ListRow {
  id: string;
  public_id: string;
  provider: string;
  model: string;
  token_type: string;
  currency: string;
  unit_amount_decimal: string;
  quantity_divisor: string;
  /** Epoch ms; null = -infinity. */
  from_ms: string | null;
  source: string;
  source_version: string | null;
  source_effective_from: string | null;
}

export interface CostRow {
  id: string;
  public_id: string;
  provider: string | null;
  model: string;
  token_type: string;
  currency: string;
  unit_amount_decimal: string;
  quantity_divisor: string;
  from_ms: string;
  to_ms: string | null;
}

export interface Candidate {
  provider: string;
  model: string;
  exact: boolean;
}

const NEG_INF = Number.NEGATIVE_INFINITY;
const POS_INF = Number.POSITIVE_INFINITY;

function toListHit(r: ListRow): ListPriceHit {
  return {
    kind: "list",
    id: r.id,
    publicId: r.public_id,
    provider: r.provider,
    model: r.model,
    tokenType: r.token_type,
    currency: r.currency,
    unitAmount: fixed12FromNumeric(r.unit_amount_decimal),
    quantityDivisor: BigInt(r.quantity_divisor),
    effectiveFrom: r.from_ms == null ? null : new Date(Number(r.from_ms)),
    source: r.source,
    sourceVersion: r.source_version,
    sourceEffectiveFrom: r.source_effective_from,
  };
}

function toCostHit(r: CostRow): CostHit {
  return {
    kind: "cost",
    id: r.id,
    publicId: r.public_id,
    provider: r.provider,
    model: r.model,
    tokenType: r.token_type,
    currency: r.currency,
    unitAmount: fixed12FromNumeric(r.unit_amount_decimal),
    quantityDivisor: BigInt(r.quantity_divisor),
    effectiveFrom: new Date(Number(r.from_ms)),
    effectiveTo: r.to_ms == null ? null : new Date(Number(r.to_ms)),
  };
}

const fromMs = (r: { from_ms: string | null }) => (r.from_ms == null ? NEG_INF : Number(r.from_ms));
const toMs = (r: { to_ms: string | null }) => (r.to_ms == null ? POS_INF : Number(r.to_ms));

/**
 * List and cost rows for a set of model values over a window, resolved in memory. Load once
 * per rating window; every method is synchronous.
 */
export class ModelPriceBook {
  constructor(
    /** model value → list models it names (exact id or alias). */
    private readonly candidates: Map<string, Candidate[]>,
    /** `provider model token currency` → rows by effective_from ascending. */
    private readonly listRows: Map<string, ListRow[]>,
    private readonly costRows: CostRow[],
  ) {}

  /** The list model a key names: one provider, exact id before alias. */
  private listModel(key: ModelKey): Candidate | PriceMiss {
    let cands = this.candidates.get(key.model) ?? [];
    if (key.provider) cands = cands.filter((c) => c.provider === key.provider);
    const providers = new Set(cands.map((c) => c.provider));
    if (providers.size === 0) return { kind: null, reason: "not_found" };
    if (providers.size > 1) return { kind: null, reason: "ambiguous_provider" };
    return cands.find((c) => c.exact) ?? cands.sort((a, b) => a.model.localeCompare(b.model))[0]!;
  }

  private listRowsFor(key: ModelKey): ListRow[] | PriceMiss {
    const m = this.listModel(key);
    if ("kind" in m) return m;
    return (
      this.listRows.get(
        `${m.provider}\u0000${m.model}\u0000${key.tokenType}\u0000${key.currency}`,
      ) ?? []
    );
  }

  /** The `model_prices` row in effect at `at`. */
  listPrice(key: ModelKey, at: Date): ListPriceResult {
    const rows = this.listRowsFor(key);
    if (!Array.isArray(rows)) return rows;
    const t = at.getTime();
    let hit: ListRow | null = null;
    for (const r of rows) if (fromMs(r) <= t) hit = r;
    return hit ? toListHit(hit) : { kind: null, reason: "not_found" };
  }

  /** Cost rows that can price this key: the event's model value, or the list model it names. */
  private costRowsFor(key: ModelKey): CostRow[] | PriceMiss {
    const m = this.listModel(key);
    const names = new Set([key.model]);
    if (!("kind" in m)) names.add(m.model);
    const rows = this.costRows.filter(
      (r) => names.has(r.model) && r.token_type === key.tokenType && r.currency === key.currency,
    );
    if (key.provider) {
      const exact = rows.filter((r) => r.provider === key.provider);
      return exact.length > 0 ? exact : rows.filter((r) => r.provider === null);
    }
    const any = rows.filter((r) => r.provider === null);
    if (any.length > 0) return any;
    const providers = new Set(rows.map((r) => r.provider));
    if (providers.size > 1) return { kind: null, reason: "ambiguous_provider" };
    return rows;
  }

  /** Your cost live at `at`; else the list price at `at`. */
  modelCost(key: ModelKey, at: Date): ModelCostResult {
    const rows = this.costRowsFor(key);
    if (!Array.isArray(rows)) return rows;
    const t = at.getTime();
    const live = rows.find((r) => fromMs(r) <= t && t < toMs(r));
    return live ? toCostHit(live) : this.listPrice(key, at);
  }

  /** Your cost only (no list fallback), for a `cost` markup base and the cost columns. */
  ownCost(key: ModelKey, at: Date): CostHit | PriceMiss {
    const rows = this.costRowsFor(key);
    if (!Array.isArray(rows)) return rows;
    const t = at.getTime();
    const live = rows.find((r) => fromMs(r) <= t && t < toMs(r));
    return live ? toCostHit(live) : { kind: null, reason: "not_found" };
  }

  /**
   * Instants strictly inside (start, end) where a list row or a cost row for this key starts
   * or ends: where a rating segment must split. Ascending, unique.
   */
  changeInstants(key: ModelKey, start: Date, end: Date): Date[] {
    const s = start.getTime();
    const e = end.getTime();
    const out = new Set<number>();
    const add = (t: number) => {
      if (t > s && t < e) out.add(t);
    };
    const list = this.listRowsFor(key);
    if (Array.isArray(list)) for (const r of list) add(fromMs(r));
    const cost = this.costRowsFor(key);
    if (Array.isArray(cost))
      for (const r of cost) {
        add(fromMs(r));
        add(toMs(r));
      }
    return [...out].sort((a, b) => a - b).map((t) => new Date(t));
  }
}

/**
 * Load the rows that can price `models` inside [start, end): every list row of a model they
 * name (by id or exact alias), and the organization's cost rows that overlap the window.
 * `organizationId` null = list only (the cost table is never read).
 */
export async function loadModelPriceBook(
  tx: Tx,
  organizationId: string | null,
  models: readonly string[],
  window: { start: Date; end: Date },
): Promise<ModelPriceBook> {
  const values = [...new Set(models)];
  if (values.length === 0) return new ModelPriceBook(new Map(), new Map(), []);
  const arr = sql`array[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
  const cands = (await tx.execute(sql`
    select v.value, m.provider, m.model, (m.model = v.value) as exact
    from unnest(${arr}) as v(value)
    join model_price_models m on m.model = v.value or v.value = any(m.aliases)`)) as unknown as Array<{
    value: string;
    provider: string;
    model: string;
    exact: boolean;
  }>;
  const candidates = new Map<string, Candidate[]>();
  for (const c of cands) {
    const list = candidates.get(c.value) ?? [];
    list.push({ provider: c.provider, model: c.model, exact: c.exact });
    candidates.set(c.value, list);
  }
  const listRows = new Map<string, ListRow[]>();
  const pairs = [...new Set(cands.map((c) => `${c.provider}\u0000${c.model}`))];
  if (pairs.length > 0) {
    const provArr = sql`array[${sql.join(
      pairs.map((p) => sql`${p.split("\u0000")[0]!}`),
      sql`, `,
    )}]::text[]`;
    const modelArr = sql`array[${sql.join(
      pairs.map((p) => sql`${p.split("\u0000")[1]!}`),
      sql`, `,
    )}]::text[]`;
    // Rows that start before the window end; the in-memory pick takes the latest at an instant.
    const rows = (await tx.execute(sql`
      select p.id, p.public_id, p.provider, p.model, p.token_type, p.currency::text as currency,
        p.unit_amount_decimal::text as unit_amount_decimal,
        p.quantity_divisor::text as quantity_divisor,
        case when p.effective_from = '-infinity' then null
          else (extract(epoch from p.effective_from) * 1000)::bigint::text end as from_ms,
        p.source, p.source_version, p.source_effective_from::text as source_effective_from
      from model_prices p
      join unnest(${provArr}, ${modelArr}) as k(provider, model)
        on p.provider = k.provider and p.model = k.model
      where p.effective_from < ${window.end.toISOString()}::timestamptz
      order by p.effective_from asc`)) as unknown as ListRow[];
    for (const r of rows) {
      const k = `${r.provider}\u0000${r.model}\u0000${r.token_type}\u0000${r.currency}`;
      const list = listRows.get(k) ?? [];
      list.push(r);
      listRows.set(k, list);
    }
  }
  let costRows: CostRow[] = [];
  if (organizationId) {
    const names = [...new Set([...values, ...cands.map((c) => c.model)])];
    costRows = (await tx.execute(sql`
      select id, public_id, provider, model, token_type, currency::text as currency,
        unit_amount_decimal::text as unit_amount_decimal,
        quantity_divisor::text as quantity_divisor,
        (extract(epoch from effective_from) * 1000)::bigint::text as from_ms,
        case when effective_to is null then null
          else (extract(epoch from effective_to) * 1000)::bigint::text end as to_ms
      from model_cost_overrides
      where organization_id = ${organizationId}
        and model = any(array[${sql.join(
          names.map((n) => sql`${n}`),
          sql`, `,
        )}]::text[])
        and effective_from < ${window.end.toISOString()}::timestamptz
        and (effective_to is null or effective_to > ${window.start.toISOString()}::timestamptz)
      order by effective_from asc`)) as unknown as CostRow[];
  }
  return new ModelPriceBook(candidates, listRows, costRows);
}

const instant = (at: Date) => ({ start: at, end: new Date(at.getTime() + 1) });

/** The list price at `at`, with the row it came from. */
export async function resolveListPrice(tx: Tx, key: ModelKey, at: Date): Promise<ListPriceResult> {
  const book = await loadModelPriceBook(tx, null, [key.model], instant(at));
  return book.listPrice(key, at);
}

/** Your cost at `at`, else the list price at `at`, with the row it came from. */
export async function resolveModelCost(
  tx: Tx,
  organizationId: string,
  key: ModelKey,
  at: Date,
): Promise<ModelCostResult> {
  const book = await loadModelPriceBook(tx, organizationId, [key.model], instant(at));
  return book.modelCost(key, at);
}

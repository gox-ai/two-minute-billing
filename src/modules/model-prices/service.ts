/**
 * The model price list as an organization reads it, and "your cost" (`model_cost_overrides`):
 * the provider prices the organization negotiated. Cost rows are organization data (RLS);
 * the list is platform-global and read-only to the app role.
 *
 * A cost row starts now or later and ends now or later, so no change reaches back over usage
 * already costed. A row that has started cannot be deleted, only ended. Overlaps per key are
 * refused by the `model_cost_overrides_no_overlap` exclusion constraint (SQLSTATE 23P01).
 */
import { sql, type SQL } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { fixed12FromNumeric, formatFixed12, parseFixed12, FixedParseError } from "@/platform/fixed";
import { publicId } from "@/platform/ids";
import { writeAuditLog } from "@/modules/audit/service";
import { rowsOf } from "@/modules/metering/usage-sql";
import { USED_WITHIN_DAYS } from "./notices";
import { isModelPriceUnit, MODEL_PRICE_UNITS, normalizeTier, TIER_RE } from "./units";
import {
  LIST_CURRENCY,
  MODEL_PRICES_LICENCE,
  MODEL_PRICES_SOURCE_NAME,
  readModelPriceSource,
} from "./sync";
import { MEDIA_SOURCE_LICENCE } from "./parse-media";

export class CostOverrideRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostOverrideRuleError";
  }
}
export class CostOverrideConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostOverrideConflictError";
  }
}

// ── Serialization ────────────────────────────────────────────────────────────

interface PriceRow {
  id: string;
  public_id: string;
  provider: string;
  model: string;
  token_type: string;
  unit: string;
  quality: string;
  resolution: string;
  currency: string;
  unit_amount_decimal: string;
  quantity_divisor: string;
  effective_from: string | null;
  source: string;
  source_version: string | null;
  source_effective_from: string | null;
  rounded: boolean;
  last_seen_at?: string | Date | null;
}

interface CostRow {
  id: string;
  public_id: string;
  provider: string | null;
  model: string;
  token_type: string;
  unit: string;
  quality: string;
  resolution: string;
  currency: string;
  unit_amount_decimal: string;
  quantity_divisor: string;
  effective_from: string | Date;
  effective_to: string | Date | null;
  note: string | null;
  created_at: string | Date;
}

const iso = (v: string | Date | null | undefined) =>
  v == null ? null : (v instanceof Date ? v : new Date(v)).toISOString();
const decimal = (v: string) => formatFixed12(fixed12FromNumeric(v));

/** Kind, unit and tier as the API returns them. `price_kind` is `token_type` under its new name. */
const keyFields = (r: {
  token_type: string;
  unit: string;
  quality: string;
  resolution: string;
}) => ({
  token_type: r.token_type,
  price_kind: r.token_type,
  unit: r.unit,
  quality: r.quality || null,
  resolution: r.resolution || null,
});

export function serializeModelPrice(r: PriceRow) {
  return {
    object: "model_price" as const,
    id: r.public_id,
    provider: r.provider,
    model: r.model,
    ...keyFields(r),
    currency: r.currency.trim(),
    unit_amount_decimal: decimal(r.unit_amount_decimal),
    quantity_divisor: Number(r.quantity_divisor),
    /** Null = the model's first price, in effect since before we tracked it. */
    effective_from: r.effective_from == null ? null : iso(r.effective_from),
    source_effective_from: r.source_effective_from,
    source: r.source,
    source_version: r.source_version,
    rounded: r.rounded,
    ...(r.last_seen_at !== undefined ? { last_seen_at: iso(r.last_seen_at) } : {}),
  };
}

export function serializeCostOverride(r: CostRow) {
  return {
    object: "model_cost_override" as const,
    id: r.public_id,
    provider: r.provider,
    model: r.model,
    ...keyFields(r),
    currency: r.currency.trim(),
    unit_amount_decimal: decimal(r.unit_amount_decimal),
    quantity_divisor: Number(r.quantity_divisor),
    effective_from: iso(r.effective_from)!,
    effective_to: iso(r.effective_to),
    note: r.note,
    created_at: iso(r.created_at)!,
  };
}

const PRICE_COLS = sql`p.id, p.public_id, p.provider, p.model, p.token_type,
  p.unit, p.quality, p.resolution, p.currency::text as currency, p.unit_amount_decimal::text as unit_amount_decimal,
  p.quantity_divisor::text as quantity_divisor,
  case when p.effective_from = '-infinity' then null else p.effective_from::text end as effective_from,
  p.source, p.source_version, p.source_effective_from::text as source_effective_from, p.rounded`;

const COST_COLS = sql`id, public_id, provider, model, token_type, unit, quality, resolution,
  currency::text as currency,
  unit_amount_decimal::text as unit_amount_decimal, quantity_divisor::text as quantity_divisor,
  effective_from, effective_to, note, created_at`;

// ── The list ─────────────────────────────────────────────────────────────────

/** The business with this public id in the organization, or null. */
export async function businessIdOf(organizationId: string, publicId: string) {
  return withTenant(organizationId, async (tx) => {
    const [b] = rowsOf<{ id: string }>(
      await tx.execute(sql`select id from businesses
        where organization_id = ${organizationId} and public_id = ${publicId}`),
    );
    return b?.id ?? null;
  });
}

/** Model values the mapped meters saw in the last 35 days (of one business, when given). */
async function usedModelValues(
  tx: Tx,
  organizationId: string,
  now: Date,
  businessId?: string,
): Promise<string[]> {
  const since = new Date(now.getTime() - USED_WITHIN_DAYS * 86_400_000).toISOString();
  return rowsOf<{ v: string }>(
    await tx.execute(sql`
      select distinct r.group_values[array_position(mt.group_by,
        coalesce(mt.price_list ->> 'model_key', 'model'))] as v
      from usage_rollups r join meters mt on mt.id = r.meter_id
      where r.organization_id = ${organizationId} and mt.price_list is not null
        and array_position(mt.group_by, coalesce(mt.price_list ->> 'model_key', 'model')) is not null
        and r.bucket_start >= ${since}::timestamptz
        ${businessId ? sql`and r.business_id = ${businessId}` : sql``}`),
  )
    .map((r) => r.v)
    .filter((v) => v != null && v !== "");
}

const textArray = (values: readonly string[]): SQL =>
  values.length === 0
    ? sql`array[]::text[]`
    : sql`array[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`;

export interface ListModelPricesQuery {
  asOf?: Date;
  provider?: string;
  model?: string;
  tokenType?: string;
  unit?: string;
  q?: string;
  hasCost?: boolean;
  used?: boolean;
  /** Only models this business used in the last 35 days (implies `used`). */
  businessId?: string;
  limit: number;
  /** Cursor: the last row's id (mpr_…). */
  startingAfter?: string;
}

/** The list price per key at `asOf` (default now), with your cost live at that instant. */
export async function listModelPrices(organizationId: string, q: ListModelPricesQuery) {
  const at = (q.asOf ?? new Date()).toISOString();
  return withTenant(organizationId, async (tx) => {
    const onlyUsed = q.used || q.businessId != null;
    const used = onlyUsed
      ? await usedModelValues(tx, organizationId, new Date(), q.businessId)
      : [];
    type After = {
      provider: string;
      model: string;
      token_type: string;
      unit: string;
      quality: string;
      resolution: string;
    };
    let after: After | undefined;
    if (q.startingAfter) {
      [after] = rowsOf<After>(
        await tx.execute(sql`select provider, model, token_type, unit, quality, resolution
          from model_prices where public_id = ${q.startingAfter}`),
      );
    }
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const rows = rowsOf<PriceRow & { cost: CostRow | null }>(
      await tx.execute(sql`
        with cur as (
          select distinct on (p.provider, p.model, p.token_type, p.unit, p.quality, p.resolution,
            p.currency) ${PRICE_COLS}
          from model_prices p
          where p.effective_from <= ${at}::timestamptz
            ${q.provider ? sql`and p.provider = ${q.provider}` : sql``}
            ${q.model ? sql`and p.model = ${q.model}` : sql``}
            ${q.tokenType ? sql`and p.token_type = ${q.tokenType}` : sql``}
            ${q.unit ? sql`and p.unit = ${q.unit}` : sql``}
            ${like ? sql`and (p.model ilike ${like} or p.provider ilike ${like})` : sql``}
          order by p.provider, p.model, p.token_type, p.unit, p.quality, p.resolution, p.currency,
            p.effective_from desc
        )
        select * from (
          select cur.*, m.last_seen_at, m.aliases,
            (select to_jsonb(c) from (
               select ${COST_COLS} from model_cost_overrides o
               where o.organization_id = ${organizationId}
                 and (o.model = cur.model or o.model = any(m.aliases))
                 and o.token_type = cur.token_type
                 -- A unit-less meter costs a request key from a token cost row (as before 0524).
                 and (o.unit = cur.unit or (o.unit = 'token' and cur.unit = 'request'))
                 and o.quality = cur.quality and o.resolution = cur.resolution
                 and (o.provider is null or o.provider = cur.provider)
                 and o.effective_from <= ${at}::timestamptz
                 and (o.effective_to is null or o.effective_to > ${at}::timestamptz)
               order by (o.unit <> cur.unit), (o.provider is null), (o.currency <> ${LIST_CURRENCY}), o.effective_from desc
               limit 1) c) as cost
          from cur join model_price_models m on m.provider = cur.provider and m.model = cur.model
        ) x
        where true
          ${
            after
              ? sql`and (x.provider, x.model, x.token_type, x.unit, x.quality, x.resolution)
                  > (${after.provider}, ${after.model}, ${after.token_type}, ${after.unit},
                     ${after.quality}, ${after.resolution})`
              : sql``
          }
          ${onlyUsed ? sql`and (x.model = any(${textArray(used)}) or x.aliases && ${textArray(used)})` : sql``}
          ${q.hasCost ? sql`and x.cost is not null` : sql``}
        order by x.provider, x.model, x.token_type, x.unit, x.quality, x.resolution
        limit ${q.limit + 1}`),
    );
    const page = rows.slice(0, q.limit);
    return {
      data: page.map((r) => ({
        ...serializeModelPrice(r),
        cost: r.cost ? serializeCostOverride(r.cost) : null,
        ...(onlyUsed ? { used: true } : {}),
      })),
      hasMore: rows.length > q.limit,
    };
  });
}

/** One dated list row (the id an invoice line cites). */
export async function getModelPrice(organizationId: string, id: string) {
  return withTenant(organizationId, async (tx) => {
    const [r] = rowsOf<PriceRow>(
      await tx.execute(sql`select ${PRICE_COLS}, m.last_seen_at from model_prices p
        join model_price_models m on m.provider = p.provider and m.model = p.model
        where p.public_id = ${id}`),
    );
    return r ? serializeModelPrice(r) : null;
  });
}

/**
 * Every dated list row for a model (both dates), and the organization's cost rows for it. Costs
 * match as in `listModelPrices`: the model or one of its aliases, and a token cost for a
 * request key.
 */
export async function modelPriceHistory(
  organizationId: string,
  key: { provider?: string; model: string; tokenType?: string; unit?: string },
) {
  return withTenant(organizationId, async (tx) => {
    const prices = rowsOf<PriceRow>(
      await tx.execute(sql`select ${PRICE_COLS} from model_prices p
        where p.model = ${key.model}
          ${key.provider ? sql`and p.provider = ${key.provider}` : sql``}
          ${key.tokenType ? sql`and p.token_type = ${key.tokenType}` : sql``}
          ${key.unit ? sql`and p.unit = ${key.unit}` : sql``}
        order by p.provider, p.token_type, p.unit, p.quality, p.resolution, p.effective_from asc`),
    );
    const costs = rowsOf<CostRow>(
      await tx.execute(sql`select ${COST_COLS} from model_cost_overrides
        where organization_id = ${organizationId}
          and (model = ${key.model} or model in (
            select unnest(m.aliases) from model_price_models m where m.model = ${key.model}
              ${key.provider ? sql`and m.provider = ${key.provider}` : sql``}))
          ${key.provider ? sql`and (provider is null or provider = ${key.provider})` : sql``}
          ${key.tokenType ? sql`and token_type = ${key.tokenType}` : sql``}
          ${
            key.unit === "request"
              ? sql`and unit in ('request', 'token')`
              : key.unit
                ? sql`and unit = ${key.unit}`
                : sql``
          }
        order by token_type, unit, quality, resolution, effective_from asc`),
    );
    return {
      object: "model_price_history" as const,
      provider: key.provider ?? null,
      model: key.model,
      prices: prices.map(serializeModelPrice),
      costs: costs.map(serializeCostOverride),
    };
  });
}

/** The next scheduled sync after `now` (hourly, at :10 UTC). */
export function nextSyncAt(now: Date): Date {
  const t = new Date(now);
  t.setUTCMinutes(10, 0, 0);
  if (t <= now) t.setUTCHours(t.getUTCHours() + 1);
  return t;
}

/** One feed of the list, with its own state. */
interface SourceInfo {
  source: string;
  url: string;
  licence: string;
  /** `all`, or `media` (images, video, audio, characters; it wins a media price both give). */
  prices: "all" | "media";
  checked_at: string | null;
  last_success_at: string | null;
  check_error: string | null;
  upstream_version: string | null;
}

/**
 * Where the list comes from and how fresh it is. The top-level fields are the first feed (as
 * before the second); `sources` lists every feed with its own state.
 */
export async function modelPriceSourceInfo(organizationId: string, now = new Date()) {
  const s = await readModelPriceSource();
  const sources: SourceInfo[] = [
    {
      source: MODEL_PRICES_SOURCE_NAME,
      url: s.url,
      licence: MODEL_PRICES_LICENCE,
      prices: "all",
      checked_at: iso(s.checkedAt),
      last_success_at: iso(s.lastSuccessAt),
      check_error: s.checkError,
      upstream_version: s.upstreamVersion,
    },
  ];
  if (s.media)
    sources.push({
      source: s.media.source,
      url: s.media.url,
      licence: MEDIA_SOURCE_LICENCE,
      prices: "media",
      checked_at: iso(s.media.checkedAt),
      last_success_at: iso(s.media.lastSuccessAt),
      check_error: s.media.checkError,
      upstream_version: s.media.upstreamVersion,
    });
  const providers = await withTenant(organizationId, async (tx) =>
    rowsOf<{ provider: string }>(
      await tx.execute(sql`select distinct provider from model_price_models order by provider`),
    ).map((r) => r.provider),
  );
  return {
    object: "model_price_source" as const,
    source: MODEL_PRICES_SOURCE_NAME,
    url: s.url,
    licence: MODEL_PRICES_LICENCE,
    checked_at: iso(s.checkedAt),
    last_success_at: iso(s.lastSuccessAt),
    check_error: s.checkError,
    upstream_version: s.upstreamVersion,
    held: s.held !== null,
    next_check_at: nextSyncAt(now).toISOString(),
    providers,
    sources,
  };
}

// ── Your cost ────────────────────────────────────────────────────────────────

export interface CostOverrideInput {
  provider?: string | null;
  model: string;
  tokenType: string;
  /** Default `token`. */
  unit?: string;
  /** '' or absent = no tier. */
  quality?: string | null;
  resolution?: string | null;
  currency: string;
  unitAmountDecimal: string;
  quantityDivisor: string;
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
  note?: string | null;
}

/** Postgres SQLSTATE through Drizzle's wrapper (`cause`). */
function pgCode(e: unknown): string | undefined {
  for (let cur: unknown = e, i = 0; cur != null && i < 4; i++) {
    const c = (cur as { code?: unknown }).code;
    if (typeof c === "string" && /^[0-9A-Z]{5}$/.test(c)) return c;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

const OVERLAP_MESSAGE =
  "We could not save your cost. Another cost for this model and token type is in effect in that period. End that cost first, or select a later start.";

export async function createCostOverride(
  organizationId: string,
  input: CostOverrideInput,
  now = new Date(),
) {
  let unit: bigint;
  try {
    unit = parseFixed12(input.unitAmountDecimal);
  } catch (e) {
    throw new CostOverrideRuleError(
      e instanceof FixedParseError && e.reason === "too_many_decimals"
        ? "unit_amount_decimal can have 12 decimal places at most."
        : 'unit_amount_decimal must be a decimal number such as "0.25".',
    );
  }
  if (unit < 0n) throw new CostOverrideRuleError("unit_amount_decimal cannot be negative.");
  const priceUnit = input.unit ?? "token";
  if (!isModelPriceUnit(priceUnit))
    throw new CostOverrideRuleError(`unit must be one of ${MODEL_PRICE_UNITS.join(", ")}.`);
  const quality = normalizeTier(input.quality);
  const resolution = normalizeTier(input.resolution);
  for (const [name, v] of [
    ["quality", quality],
    ["resolution", resolution],
  ] as const)
    if (!TIER_RE.test(v))
      throw new CostOverrideRuleError(
        `${name} can have 40 characters at most: lower-case letters, digits, "_", "." and "-".`,
      );
  if (!/^[1-9][0-9]{0,11}$/.test(input.quantityDivisor))
    throw new CostOverrideRuleError(
      "quantity_divisor must be a whole number from 1 to 999999999999.",
    );
  const from = input.effectiveFrom ?? now;
  // A cost never reaches back over usage that is already costed.
  if (from.getTime() < now.getTime() - 60_000)
    throw new CostOverrideRuleError("effective_from cannot be in the past.");
  const start = from < now ? now : from;
  if (input.effectiveTo && input.effectiveTo <= start)
    throw new CostOverrideRuleError("effective_to must be after effective_from.");
  const id = publicId("mco");
  try {
    return await withTenant(organizationId, async (tx) => {
      const [row] = rowsOf<CostRow>(
        await tx.execute(sql`
          insert into model_cost_overrides (organization_id, public_id, provider, model, token_type,
            unit, quality, resolution, currency, unit_amount_decimal, quantity_divisor,
            effective_from, effective_to, note)
          values (${organizationId}, ${id}, ${input.provider ?? null}, ${input.model},
            ${input.tokenType}, ${priceUnit}, ${quality}, ${resolution},
            ${input.currency.toUpperCase()}, ${formatFixed12(unit)}::numeric,
            ${input.quantityDivisor}::bigint, ${start.toISOString()}::timestamptz,
            ${input.effectiveTo ? input.effectiveTo.toISOString() : null}::timestamptz,
            ${input.note ?? null})
          returning ${COST_COLS}`),
      );
      const out = serializeCostOverride(row!);
      await writeAuditLog(
        {
          organizationId,
          action: "model_cost_override.create",
          resourceType: "model_cost_override",
          resourceId: out.id,
          after: out,
          beforeFull: null,
          afterFull: out,
        },
        tx,
      );
      return out;
    });
  } catch (e) {
    if (pgCode(e) === "23P01") throw new CostOverrideConflictError(OVERLAP_MESSAGE);
    throw e;
  }
}

export async function listCostOverrides(
  organizationId: string,
  q: {
    model?: string;
    provider?: string;
    tokenType?: string;
    unit?: string;
    /** Text in the model or provider id. */
    q?: string;
    /**
     * false = only rows whose key has no row on the price list now, so the list read shows
     * them beside no price; true = only the others.
     */
    listed?: boolean;
    limit: number;
    startingAfter?: string;
  },
) {
  // The key match of `listModelPrices`, from the cost row's side.
  const listedBy = (model: SQL) => sql`exists (
    select 1 from model_prices p
      join model_price_models m on m.provider = p.provider and m.model = p.model
    where ${model}
      and p.token_type = o.token_type
      and (p.unit = o.unit or (o.unit = 'token' and p.unit = 'request'))
      and p.quality = o.quality and p.resolution = o.resolution
      and (o.provider is null or o.provider = p.provider)
      and p.effective_from <= ${new Date().toISOString()}::timestamptz)`;
  const isListed = sql`(${listedBy(sql`p.model = o.model`)}
    or ${listedBy(sql`o.model = any(m.aliases)`)})`;
  const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  return withTenant(organizationId, async (tx) => {
    const rows = rowsOf<CostRow>(
      await tx.execute(sql`select ${COST_COLS} from model_cost_overrides o
        where organization_id = ${organizationId}
          ${q.model ? sql`and model = ${q.model}` : sql``}
          ${q.provider ? sql`and provider = ${q.provider}` : sql``}
          ${q.tokenType ? sql`and token_type = ${q.tokenType}` : sql``}
          ${q.unit ? sql`and unit = ${q.unit}` : sql``}
          ${like ? sql`and (model ilike ${like} or provider ilike ${like})` : sql``}
          ${q.listed === undefined ? sql`` : q.listed ? sql`and ${isListed}` : sql`and not ${isListed}`}
          ${q.startingAfter ? sql`and public_id < ${q.startingAfter}` : sql``}
        order by public_id desc limit ${q.limit + 1}`),
    );
    return {
      data: rows.slice(0, q.limit).map(serializeCostOverride),
      hasMore: rows.length > q.limit,
    };
  });
}

export async function getCostOverride(organizationId: string, id: string) {
  return withTenant(organizationId, async (tx) => {
    const [r] = rowsOf<CostRow>(
      await tx.execute(sql`select ${COST_COLS} from model_cost_overrides
        where organization_id = ${organizationId} and public_id = ${id}`),
    );
    return r ? serializeCostOverride(r) : null;
  });
}

/** End a cost now or later. Null when there is no such row. */
export async function endCostOverride(
  organizationId: string,
  id: string,
  effectiveTo?: Date,
  now = new Date(),
) {
  try {
    return await withTenant(organizationId, async (tx) => {
      const [cur] = rowsOf<CostRow>(
        await tx.execute(sql`select ${COST_COLS} from model_cost_overrides
          where organization_id = ${organizationId} and public_id = ${id} for update`),
      );
      if (!cur) return null;
      const before = serializeCostOverride(cur);
      const to = effectiveTo ?? now;
      if (to.getTime() < now.getTime() - 60_000)
        throw new CostOverrideRuleError("effective_to cannot be in the past.");
      const end = to < now ? now : to;
      if (before.effective_to && new Date(before.effective_to) <= now)
        throw new CostOverrideConflictError("We could not end this cost. It has already ended.");
      if (end <= new Date(before.effective_from))
        throw new CostOverrideRuleError(
          "effective_to must be after effective_from. To remove a cost that has not started, delete it.",
        );
      const [row] = rowsOf<CostRow>(
        await tx.execute(sql`update model_cost_overrides
          set effective_to = ${end.toISOString()}::timestamptz, updated_at = app_now()
          where id = ${cur.id} returning ${COST_COLS}`),
      );
      const out = serializeCostOverride(row!);
      await writeAuditLog(
        {
          organizationId,
          action: "model_cost_override.end",
          resourceType: "model_cost_override",
          resourceId: out.id,
          before: { effective_to: before.effective_to },
          after: { effective_to: out.effective_to },
          beforeFull: before,
          afterFull: out,
        },
        tx,
      );
      return out;
    });
  } catch (e) {
    if (pgCode(e) === "23P01") throw new CostOverrideConflictError(OVERLAP_MESSAGE);
    throw e;
  }
}

/** Delete a cost that has not started. A started one may have costed an invoice: end it. */
export async function deleteCostOverride(organizationId: string, id: string, now = new Date()) {
  return withTenant(organizationId, async (tx) => {
    const [cur] = rowsOf<CostRow>(
      await tx.execute(sql`select ${COST_COLS} from model_cost_overrides
        where organization_id = ${organizationId} and public_id = ${id} for update`),
    );
    if (!cur) return null;
    const before = serializeCostOverride(cur);
    if (new Date(before.effective_from) <= now)
      throw new CostOverrideConflictError(
        "We could not delete this cost. It has started and can be on an invoice. End it instead.",
      );
    await tx.execute(sql`delete from model_cost_overrides where public_id = ${id}
      and organization_id = ${organizationId}`);
    await writeAuditLog(
      {
        organizationId,
        action: "model_cost_override.delete",
        resourceType: "model_cost_override",
        resourceId: before.id,
        before,
        beforeFull: before,
        afterFull: null,
      },
      tx,
    );
    return { ...before, deleted: true };
  });
}

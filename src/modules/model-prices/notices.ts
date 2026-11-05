/**
 * Price-change notices (design G1b § 3.5). Written in the sync transaction:
 * - one `model_prices_changed` event per business that USES a changed key: a meter maps to the
 *   list and the model is in that meter's usage of the last 35 days or in its prices' rate cards;
 * - one `model_price_notices` row per organization and sync run (unique), mailed later by the
 *   `model_price_notices` cron to members who hold `model_prices:manage`.
 * Changes to your cost or a selling rate never notify: the operator made them.
 */
import { sql } from "drizzle-orm";
import { systemDb, type Tx } from "@/platform/db";
import { config } from "@/platform/config";
import { divHalfUp, fixed12FromNumeric, formatFixed12 } from "@/platform/fixed";
import { createLogger } from "@/platform/logger";
import { emitEvent } from "@/modules/events/emit";
import { effectivePermissions } from "@/modules/auth/permissions";
import { resolveMailer } from "@/modules/emails/mailer-resolver";
import { escapeHtml } from "@/modules/emails/sanitize";
import { rowsOf } from "@/modules/metering/usage-sql";
import type { PriceSnapshot } from "@/modules/catalog/pricing";

const log = createLogger("model-prices.notices");

/** One changed list key, as the sync applied it. */
export interface ModelPriceChange {
  provider: string;
  model: string;
  tokenType: string;
  currency: string;
  modelPriceId: string;
  oldUnitAmountDecimal: string | null;
  newUnitAmountDecimal: string;
  quantityDivisor: string;
  /** ISO instant, or "-infinity". */
  effectiveFrom: string;
  sourceEffectiveFrom: string | null;
  source: string;
  sourceVersion: string | null;
}

/** The change as an event and a notice carry it (snake_case, decimals as text). */
export interface ChangeRecord {
  provider: string;
  model: string;
  token_type: string;
  currency: string;
  model_price_id: string;
  old_unit_amount_decimal: string | null;
  new_unit_amount_decimal: string;
  quantity_divisor: string;
  effective_from: string;
  source_effective_from: string | null;
  bill_moves: boolean;
  cost_moves: boolean;
  source: string;
  source_version: string | null;
}

/** Usage this recent makes a business a user of the model. */
export const USED_WITHIN_DAYS = 35;
export const NOTICE_MAX_ATTEMPTS = 6;
/** A claimed notice is not due again for this long: a crashed or retried job cannot resend it. */
const CLAIM_MS = 10 * 60_000;

const dec = (v: string | null) => (v == null ? null : formatFixed12(fixed12FromNumeric(v)));

interface PriceListMap {
  provider?: string;
  provider_key?: string;
  model_key?: string;
  token_type?: string;
  token_type_key?: string;
}

interface MappedMeter {
  id: string;
  organization_id: string;
  business_id: string;
  group_by: string[];
  price_list: PriceListMap;
}

/** Does a rate's match name this combination (only on the keys we know)? */
function matches(
  match: Record<string, string>,
  combo: Record<string, string>,
  known: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(match);
  return keys.length > 0 && keys.every((k) => known.has(k) && combo[k] === match[k]);
}

/**
 * True when an item bills this key from the list: no fixed rate for it on the item override or
 * the rate card, and the markup base is the list (or a cost base with no cost row).
 */
function itemBillsFromList(
  snap: PriceSnapshot,
  combo: Record<string, string>,
  known: ReadonlySet<string>,
  hasCost: boolean,
): boolean {
  const override = snap.sellingOverride?.rates.find((r) => matches(r.match, combo, known));
  if (override?.unitAmountDecimal != null) return false;
  if (!override) {
    const rate = snap.rates?.find((r) => matches(r.match, combo, known));
    if (rate && rate.markupPercent == null) return false;
  }
  return (snap.markupBase ?? "list") === "list" || !hasCost;
}

/**
 * Record the events and notice rows for an applied change set. Runs inside the sync's
 * system transaction; a repeat for the same run writes no second notice.
 */
export async function recordModelPriceChanges(
  tx: Tx,
  input: { syncRunId: string; changes: ModelPriceChange[]; now: Date },
): Promise<{ businesses: number; organizations: number }> {
  if (input.changes.length === 0) return { businesses: 0, organizations: 0 };
  const meters = rowsOf<MappedMeter>(
    await tx.execute(sql`
      select id, organization_id, business_id, group_by, price_list
      from meters where price_list is not null`),
  );
  if (meters.length === 0) return { businesses: 0, organizations: 0 };

  // Every name a changed model goes by: its id and its exact aliases.
  const names = new Map<string, Set<string>>();
  const aliasRows = rowsOf<{ provider: string; model: string; aliases: string[] }>(
    await tx.execute(sql`
      select provider, model, aliases from model_price_models
      where (provider, model) in (${sql.join(
        input.changes.map((c) => sql`(${c.provider}, ${c.model})`),
        sql`, `,
      )})`),
  );
  for (const c of input.changes) names.set(`${c.provider}\u0000${c.model}`, new Set([c.model]));
  for (const a of aliasRows)
    for (const n of a.aliases) names.get(`${a.provider}\u0000${a.model}`)?.add(n);

  const since = new Date(input.now.getTime() - USED_WITHIN_DAYS * 86_400_000).toISOString();
  // business → change index → { change, meters and model names it was used under }
  const used = new Map<
    string,
    { org: string; hits: Map<number, { meters: Set<string>; values: Set<string> }> }
  >();

  for (const m of meters) {
    const map = m.price_list;
    const modelKey = map.model_key ?? "model";
    const mi = m.group_by.indexOf(modelKey);
    if (mi < 0) continue;
    const pi = map.provider_key ? m.group_by.indexOf(map.provider_key) : -1;
    const ti = map.token_type_key ? m.group_by.indexOf(map.token_type_key) : -1;
    const relevant = input.changes
      .map((c, i) => ({ c, i }))
      .filter(
        ({ c }) =>
          (!map.provider || map.provider === c.provider) &&
          (!map.token_type || map.token_type === c.tokenType),
      );
    if (relevant.length === 0) continue;
    const combos = rowsOf<{ m: string; p: string | null; t: string | null }>(
      await tx.execute(sql`
        select distinct group_values[${mi + 1}] as m,
          ${pi >= 0 ? sql`group_values[${pi + 1}]` : sql`null::text`} as p,
          ${ti >= 0 ? sql`group_values[${ti + 1}]` : sql`null::text`} as t
        from usage_rollups
        where meter_id = ${m.id} and business_id = ${m.business_id}
          and bucket_start >= ${since}::timestamptz`),
    );
    const rateModels = rowsOf<{ v: string | null }>(
      await tx.execute(sql`
        select distinct r.match ->> ${modelKey} as v
        from price_rates r join prices p on p.id = r.price_id
        where p.meter_id = ${m.id}`),
    ).map((r) => r.v);
    for (const { c, i } of relevant) {
      const n = names.get(`${c.provider}\u0000${c.model}`)!;
      const hitValues = new Set<string>();
      for (const x of combos)
        if (n.has(x.m) && (pi < 0 || x.p === c.provider) && (ti < 0 || x.t === c.tokenType))
          hitValues.add(x.m);
      for (const v of rateModels) if (v != null && n.has(v)) hitValues.add(v);
      if (hitValues.size === 0) continue;
      const b = used.get(m.business_id) ?? { org: m.organization_id, hits: new Map() };
      const h = b.hits.get(i) ?? { meters: new Set<string>(), values: new Set<string>() };
      h.meters.add(m.id);
      hitValues.forEach((v) => h.values.add(v));
      b.hits.set(i, h);
      used.set(m.business_id, b);
    }
  }
  if (used.size === 0) return { businesses: 0, organizations: 0 };

  // Cost rows live at each change's applied-from instant decide cost_moves (and a cost base).
  const orgs = [...new Set([...used.values()].map((b) => b.org))];
  const costKeys = rowsOf<{
    organization_id: string;
    provider: string | null;
    model: string;
    token_type: string;
  }>(
    await tx.execute(sql`
      select distinct organization_id, provider, model, token_type from model_cost_overrides
      where organization_id = any(array[${sql.join(
        orgs.map((o) => sql`${o}`),
        sql`, `,
      )}]::uuid[])
        and currency = 'USD'
        and effective_from <= ${input.now.toISOString()}::timestamptz
        and (effective_to is null or effective_to > ${input.now.toISOString()}::timestamptz)`),
  );
  const hasCost = (org: string, c: ModelPriceChange) => {
    const n = names.get(`${c.provider}\u0000${c.model}`)!;
    return costKeys.some(
      (k) =>
        k.organization_id === org &&
        n.has(k.model) &&
        k.token_type === c.tokenType &&
        (k.provider === null || k.provider === c.provider),
    );
  };

  const perOrg = new Map<string, Map<number, ChangeRecord>>();
  for (const [businessId, b] of used) {
    const meterIds = [...new Set([...b.hits.values()].flatMap((h) => [...h.meters]))];
    const items = rowsOf<{ snap: PriceSnapshot }>(
      await tx.execute(sql`
        select si.price_snapshot as snap
        from subscription_items si join subscriptions s on s.id = si.subscription_id
        where si.business_id = ${businessId}
          and s.status in ('future', 'in_trial', 'active', 'paused')
          and si.price_snapshot ->> 'amountSource' in ('model_price_list', 'event_cost_or_list')
          and si.price_snapshot -> 'meter' ->> 'id' = any(array[${sql.join(
            meterIds.map((id) => sql`${id}`),
            sql`, `,
          )}]::text[])`),
    );
    const records: ChangeRecord[] = [];
    for (const [i, h] of b.hits) {
      const c = input.changes[i]!;
      const cost = hasCost(b.org, c);
      const meter = (id: string) => meters.find((m) => m.id === id)!;
      const billMoves = items.some(({ snap }) => {
        if (!snap.meter || !h.meters.has(snap.meter.id)) return false;
        const map = meter(snap.meter.id).price_list;
        const known = new Set<string>([map.model_key ?? "model"]);
        const combo: Record<string, string> = {};
        if (map.provider_key) {
          known.add(map.provider_key);
          combo[map.provider_key] = c.provider;
        }
        if (map.token_type_key) {
          known.add(map.token_type_key);
          combo[map.token_type_key] = c.tokenType;
        }
        return [...h.values].some((v) =>
          itemBillsFromList(snap, { ...combo, [map.model_key ?? "model"]: v }, known, cost),
        );
      });
      const record: ChangeRecord = {
        provider: c.provider,
        model: c.model,
        token_type: c.tokenType,
        currency: c.currency,
        model_price_id: c.modelPriceId,
        old_unit_amount_decimal: dec(c.oldUnitAmountDecimal),
        new_unit_amount_decimal: dec(c.newUnitAmountDecimal)!,
        quantity_divisor: c.quantityDivisor,
        effective_from: c.effectiveFrom,
        source_effective_from: c.sourceEffectiveFrom,
        bill_moves: billMoves,
        cost_moves: !cost,
        source: c.source,
        source_version: c.sourceVersion,
      };
      records.push(record);
      const o = perOrg.get(b.org) ?? new Map<number, ChangeRecord>();
      const prev = o.get(i);
      o.set(i, prev ? { ...record, bill_moves: prev.bill_moves || billMoves } : record);
      perOrg.set(b.org, o);
    }
    await emitEvent(tx, {
      organizationId: b.org,
      businessId,
      type: "model_prices_changed",
      source: "system",
      resource: { type: "model_prices", id: input.syncRunId },
      data: {
        model_prices: { object: "model_prices_change", id: input.syncRunId, changes: records },
      },
    });
  }
  for (const [org, records] of perOrg) {
    await tx.execute(sql`
      insert into model_price_notices (organization_id, sync_run_id, changes, next_attempt_at)
      values (${org}, ${input.syncRunId}::uuid, ${JSON.stringify([...records.values()])}::jsonb,
        ${input.now.toISOString()}::timestamptz)
      on conflict (organization_id, sync_run_id) do nothing`);
  }
  return { businesses: used.size, organizations: perOrg.size };
}

// ── The email ────────────────────────────────────────────────────────────────

/** Fixed12 minor units per `divisor` → "$3.00 per 1M tokens". USD only (the list currency). */
export function formatListPrice(unitAmountDecimal: string, divisor: string): string {
  const cents = fixed12FromNumeric(unitAmountDecimal);
  const dollars = formatFixed12(divHalfUp(cents, 100n));
  const [int, frac = ""] = dollars.split(".");
  const per =
    divisor === "1000000" ? "per 1M tokens" : divisor === "1000" ? "per 1K" : `per ${divisor}`;
  return `$${int}.${frac.padEnd(2, "0")} ${per}`;
}

const effectText = (c: ChangeRecord) =>
  [
    c.bill_moves ? "Your customers' bills change." : null,
    c.cost_moves ? null : "Your cost stays in effect.",
    !c.bill_moves && c.cost_moves ? "Your margin reports use the new price." : null,
  ]
    .filter(Boolean)
    .join(" ");

const startsText = (iso: string) =>
  iso === "-infinity" ? "Now" : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

export function renderModelPriceNotice(changes: ChangeRecord[]): {
  subject: string;
  html: string;
  text: string;
} {
  const models = new Set(changes.map((c) => `${c.provider}/${c.model}`)).size;
  const subject = `Prices changed for ${models} AI model${models === 1 ? "" : "s"}`;
  const intro =
    "The public price list changed for AI models that your businesses use. The new prices start at the time below. Usage before that time keeps the old price.";
  const rows = changes.map((c) => ({
    model: `${c.provider} ${c.model}`,
    token: c.token_type,
    old: c.old_unit_amount_decimal
      ? formatListPrice(c.old_unit_amount_decimal, c.quantity_divisor)
      : "No price",
    now: formatListPrice(c.new_unit_amount_decimal, c.quantity_divisor),
    starts: startsText(c.effective_from),
    effect: effectText(c),
  }));
  const base = config.DASHBOARD_BASE_URL?.replace(/\/$/, "");
  const cell = 'style="padding:4px 12px 4px 0;vertical-align:top"';
  const html = [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#222">',
    `<h2 style="font-size:18px;margin:0 0 16px">${escapeHtml(subject)}</h2>`,
    `<p style="font-size:14px;line-height:1.6;margin:0 0 12px">${escapeHtml(intro)}</p>`,
    '<table style="font-size:13px;line-height:1.5;border-collapse:collapse;margin:0 0 16px">',
    `<tr>${["Model", "Token type", "Old price", "New price", "Starts", "Effect"]
      .map((h) => `<th ${cell} align="left">${h}</th>`)
      .join("")}</tr>`,
    ...rows.map(
      (r) =>
        `<tr>${[r.model, r.token, r.old, r.now, r.starts, r.effect]
          .map((v) => `<td ${cell}>${escapeHtml(v)}</td>`)
          .join("")}</tr>`,
    ),
    "</table>",
    base
      ? `<p style="margin:24px 0"><a href="${escapeHtml(`${base}/settings/model-prices`)}" style="background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">View model prices</a></p>`
      : "",
    "</div>",
  ].join("");
  const text = [
    intro,
    ...rows.map((r) =>
      `${r.model}, ${r.token}: ${r.old} → ${r.now}. Starts ${r.starts}. ${r.effect}`.trim(),
    ),
    base ? `View model prices: ${base}/settings/model-prices` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { subject, html, text };
}

/** Members whose role holds `model_prices:manage`. */
async function priceManagers(organizationId: string): Promise<string[]> {
  const rows = rowsOf<{
    email: string;
    role: string;
    role_id: string | null;
    version: number | null;
    permissions: string[] | null;
  }>(
    await systemDb.execute(sql`
      select u.email, m.role, r.id as role_id, r.version, r.permissions
      from memberships m join users u on u.id = m.user_id
      left join roles r on r.id = m.custom_role_id and r.deleted_at is null
      where m.organization_id = ${organizationId} and m.accepted_at is not null
      order by u.email`),
  );
  return rows
    .filter((r) =>
      effectivePermissions(
        r.role,
        r.role_id
          ? { id: r.role_id, version: r.version ?? 1, permissions: r.permissions ?? [] }
          : null,
      ).has("model_prices:manage"),
    )
    .map((r) => r.email);
}

/**
 * The `model_price_notices` cron: mail due notices through the deployment mailer. A notice is
 * claimed (attempt counted, next attempt pushed out) before any send, so a retried job finds
 * nothing due. Up to 6 attempts with backoff; then `failed`.
 */
export async function runModelPriceNotices(now: Date = new Date()): Promise<{ sent: number }> {
  let sent = 0;
  for (;;) {
    const [claimed] = rowsOf<{
      id: string;
      organization_id: string;
      changes: ChangeRecord[];
      attempts: number;
    }>(
      await systemDb.execute(sql`
        update model_price_notices set attempts = attempts + 1,
          next_attempt_at = ${new Date(now.getTime() + CLAIM_MS).toISOString()}::timestamptz,
          updated_at = now()
        where id = (
          select id from model_price_notices
          where status = 'pending' and next_attempt_at <= ${now.toISOString()}::timestamptz
          order by next_attempt_at limit 1 for update skip locked)
        returning id, organization_id, changes, attempts`),
    );
    if (!claimed) break;
    const to = await priceManagers(claimed.organization_id);
    if (to.length === 0) {
      await systemDb.execute(sql`update model_price_notices set status = 'skipped', updated_at = now()
        where id = ${claimed.id}`);
      continue;
    }
    const mail = renderModelPriceNotice(claimed.changes);
    try {
      for (const email of to)
        await resolveMailer(null).send({
          to: email,
          from: config.MAIL_FROM,
          fromName: config.MAIL_FROM_NAME,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        });
      await systemDb.execute(sql`update model_price_notices
        set status = 'sent', sent_at = ${now.toISOString()}::timestamptz, last_error = null,
          updated_at = now()
        where id = ${claimed.id}`);
      sent++;
    } catch (e) {
      const last = claimed.attempts >= NOTICE_MAX_ATTEMPTS;
      const backoffMs = 5 * 60_000 * 2 ** (claimed.attempts - 1);
      log.warn("model price notice not sent", {
        event: "model_price_notice_failed",
        notice: claimed.id,
        attempts: claimed.attempts,
        error: e,
      });
      await systemDb.execute(sql`update model_price_notices
        set status = ${last ? "failed" : "pending"},
          next_attempt_at = ${new Date(now.getTime() + backoffMs).toISOString()}::timestamptz,
          last_error = ${(e as Error).message?.slice(0, 500) ?? "send failed"}, updated_at = now()
        where id = ${claimed.id}`);
    }
  }
  return { sent };
}

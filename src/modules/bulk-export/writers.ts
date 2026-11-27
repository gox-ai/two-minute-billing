/**
 * The export's record types, as the file import reads them: one CSV per entity whose first
 * columns are `ENTITY_FIELDS[entity]` in order, in the import's formats (amounts in the
 * currency's main unit, instants as ISO 8601 UTC, lists separated by `|`), then a few
 * read-only columns the import ignores (`autoMap` maps an unknown header to nothing).
 *
 * Which rows: the entity's own filters, plus, with `includeRelated`, every record the chosen
 * rows refer to (an invoice's customer and subscription, a subscription's prices and
 * coupons…), so a filtered export still imports on its own. The sets are SQL subqueries, so
 * nothing is held in memory; each file is read with a cursor in one snapshot.
 */
import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { minorToDecimalString } from "@/platform/currency";
import type { CsvValue } from "@/platform/csv";
import { ENTITY_FIELDS, IMPORT_ENTITIES, type ImportEntity } from "@/modules/bulk-import/templates";

export const EXPORT_ENTITIES = IMPORT_ENTITIES;
export type ExportEntity = ImportEntity;

/** Subscription states, in the import's words. */
export const SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "future",
  "paused",
  "non_renewing",
  "cancelled",
] as const;
export const INVOICE_STATUSES = ["paid", "open", "void"] as const;
export const PAYMENT_STATUSES = ["succeeded", "failed"] as const;

export interface EntityFilter {
  /** Subscriptions, invoices, payments: the states to keep. Empty or absent: all. */
  status?: string[];
  /** Customers, subscriptions: which date the range applies to. Default `created`. */
  dateField?: "created" | "updated";
  /** Inclusive start and exclusive end, ISO instants. */
  from?: string | null;
  to?: string | null;
  /** Plans, add-ons, coupons: archived ones too. */
  includeArchived?: boolean;
}
export type ExportFilters = Partial<Record<ExportEntity, EntityFilter>>;

/** The read-only columns after the import's, per entity. */
export const EXTRA_COLUMNS: Record<ExportEntity, string[]> = {
  plans: ["product_name", "updated_at"],
  addons: ["product_name", "updated_at"],
  coupons: ["times_redeemed"],
  customers: ["currency", "updated_at"],
  subscriptions: ["mrr", "next_billing_at", "updated_at"],
  invoices: ["amount_paid", "paid_status"],
  credit_notes: ["number", "status"],
  payments: ["subscription_id"],
  usage: [],
};

export function headerOf(entity: ExportEntity): string[] {
  return [...ENTITY_FIELDS[entity].map((f) => f.key), ...EXTRA_COLUMNS[entity]];
}

const NONE = sql`select null::uuid as id where false`;

const iso = (v: unknown): string | null =>
  v == null ? null : (v instanceof Date ? v : new Date(String(v))).toISOString();
const money = (minor: unknown, currency: unknown): string | null =>
  minor == null || currency == null
    ? null
    : minorToDecimalString(BigInt(String(minor)), String(currency));
const pct = (bps: unknown): string | null =>
  bps == null ? null : String(Number(bps) / 100).replace(/\.0+$/, "");

interface Ctx {
  businessId: string;
  entities: Set<ExportEntity>;
  filters: ExportFilters;
  includeRelated: boolean;
}

function range(col: SQL, f: EntityFilter | undefined): SQL {
  const parts: SQL[] = [];
  if (f?.from) parts.push(sql`${col} >= ${f.from}::timestamptz`);
  if (f?.to) parts.push(sql`${col} < ${f.to}::timestamptz`);
  return parts.length ? sql.join(parts, sql` and `) : sql`true`;
}

const picked = (f: EntityFilter | undefined, all: readonly string[]) =>
  f?.status?.length ? f.status.filter((s) => all.includes(s)) : [...all];

/** The rows of `e` its own filters choose; none when `e` was not asked for. */
function chosen(ctx: Ctx, e: ExportEntity): SQL {
  if (!ctx.entities.has(e)) return NONE;
  const b = ctx.businessId;
  const f = ctx.filters[e];
  switch (e) {
    case "plans":
    case "addons":
      return sql`select p.id from prices p join products pr on pr.id = p.product_id
        where p.business_id = ${b}::uuid
          and pr.kind ${e === "plans" ? sql`= 'plan'` : sql`in ('addon', 'charge')`}
          and (${f?.includeArchived ?? false} or p.active)`;
    case "coupons":
      return sql`select c.id from coupons c where c.business_id = ${b}::uuid
        and (${f?.includeArchived ?? false} or c.active)`;
    case "customers":
      return sql`select c.id from customers c where c.business_id = ${b}::uuid
        and ${range(f?.dateField === "updated" ? sql`c.updated_at` : sql`c.created_at`, f)}`;
    case "subscriptions": {
      const st = picked(f, SUBSCRIPTION_STATUSES);
      const conds: SQL[] = [];
      if (st.includes("active"))
        conds.push(sql`(s.status = 'active' and not s.cancel_at_period_end)`);
      if (st.includes("non_renewing"))
        conds.push(sql`(s.status = 'active' and s.cancel_at_period_end)`);
      if (st.includes("trialing")) conds.push(sql`s.status = 'in_trial'`);
      if (st.includes("future")) conds.push(sql`s.status = 'future'`);
      if (st.includes("paused")) conds.push(sql`s.status = 'paused'`);
      if (st.includes("cancelled")) conds.push(sql`s.status = 'cancelled'`);
      if (!conds.length) return NONE;
      return sql`select s.id from subscriptions s where s.business_id = ${b}::uuid
        and s.deleted_at is null and (${sql.join(conds, sql` or `)})
        and ${range(f?.dateField === "updated" ? sql`s.updated_at` : sql`s.created_at`, f)}`;
    }
    case "invoices": {
      const st = picked(f, INVOICE_STATUSES);
      const db: string[] = [];
      if (st.includes("paid")) db.push("paid");
      if (st.includes("open")) db.push("posted", "payment_due", "not_paid");
      if (st.includes("void")) db.push("voided");
      if (!db.length) return NONE;
      return sql`select i.id from invoices i where i.business_id = ${b}::uuid
        and i.status in ${sql`(${sql.join(
          db.map((s) => sql`${s}`),
          sql`, `,
        )})`} and ${range(sql`i.created_at`, f)}`;
    }
    case "credit_notes":
      return sql`select n.id from credit_notes n where n.business_id = ${b}::uuid
        and n.invoice_id is not null and ${range(sql`n.created_at`, f)}`;
    case "payments": {
      const st = picked(f, PAYMENT_STATUSES);
      if (!st.length) return NONE;
      return sql`select t.id from transactions t where t.business_id = ${b}::uuid
        and t.type in ('payment', 'refund')
        and t.status in (${sql.join(
          st.map((s) => sql`${s}`),
          sql`, `,
        )}) and ${range(sql`t.occurred_at`, f)}`;
    }
    case "usage":
      return sql`select u.id from usage_records u where u.business_id = ${b}::uuid
        and ${range(sql`u."timestamp"`, f)}`;
  }
}

/**
 * Every row of `e` the file holds: the chosen rows, and with `includeRelated` the ones that
 * other chosen rows refer to. History refers down (payment → invoice → subscription →
 * customer, price, coupon), never up, so the sets close without recursion.
 */
export function rowSet(ctx: Ctx, e: ExportEntity): SQL {
  const own = chosen(ctx, e);
  if (!ctx.includeRelated) return own;
  const b = ctx.businessId;
  const invoices = (): SQL => sql`${chosen(ctx, "invoices")}
    union select t.invoice_id from transactions t
      where t.id in (${chosen(ctx, "payments")}) and t.invoice_id is not null
    union select n.invoice_id from credit_notes n
      where n.id in (${chosen(ctx, "credit_notes")}) and n.invoice_id is not null`;
  const subscriptions = (): SQL => sql`${chosen(ctx, "subscriptions")}
    union select i.subscription_id from invoices i
      where i.id in (${invoices()}) and i.subscription_id is not null
    union select u.subscription_id from usage_records u where u.id in (${chosen(ctx, "usage")})`;
  const prices = (): SQL => sql`select si.price_id from subscription_items si
      where si.subscription_id in (${subscriptions()})
    union select li.price_id from invoice_line_items li
      where li.invoice_id in (${invoices()}) and li.price_id is not null`;
  switch (e) {
    case "plans":
    case "addons":
      return sql`${own} union select p.id from prices p join products pr on pr.id = p.product_id
        where p.business_id = ${b}::uuid and p.id in (${prices()})
          and pr.kind ${e === "plans" ? sql`= 'plan'` : sql`in ('addon', 'charge')`}`;
    case "coupons":
      return sql`${own} union select ac.coupon_id from applied_coupons ac
        where ac.subscription_id in (${subscriptions()}) and ac.coupon_id is not null
          and ac.status = 'active'`;
    case "customers":
      return sql`${own}
        union select s.customer_id from subscriptions s where s.id in (${subscriptions()})
        union select i.customer_id from invoices i where i.id in (${invoices()})
        union select t.customer_id from transactions t
          where t.id in (${chosen(ctx, "payments")}) and t.customer_id is not null
        union select n.customer_id from credit_notes n where n.id in (${chosen(ctx, "credit_notes")})`;
    case "subscriptions":
      return subscriptions();
    case "invoices":
      return invoices();
    case "payments":
      // A refund names the payment it returned; that payment comes too.
      return sql`${own} union select p.id from transactions r
        join refunds rf on rf.id = r.refund_id
        join transactions p on p.payment_id = rf.payment_id and p.type = 'payment'
        where r.id in (${own}) and r.type = 'refund'`;
    default:
      return own;
  }
}

/** The query whose rows become the entity's file, ordered so related lines stay together. */
export function fileQuery(ctx: Ctx, e: ExportEntity): SQL {
  const ids = rowSet(ctx, e);
  switch (e) {
    case "plans":
    case "addons":
      return sql`select p.public_id as price_id, pr.public_id as product_id, pr.name as product_name,
          coalesce(p.name, pr.name) as name, p.model, p.amount_minor, p.currency, p.interval,
          p.interval_count, p.tiers, p.trial_period, p.trial_period_unit, p.type, p.meter_id,
          coalesce(p.description, pr.description) as description, p.active,
          p.created_at, p.updated_at
        from prices p join products pr on pr.id = p.product_id
        where p.id in (${ids}) order by p.created_at, p.id`;
    case "coupons":
      return sql`select c.* from coupons c where c.id in (${ids}) order by c.created_at, c.id`;
    case "customers":
      return sql`select c.public_id, c.email, c.first_name, c.last_name, c.name, c.company,
          c.phone, c.address_line1, c.address_line2, c.city, c.state, c.postal_code, c.country,
          coalesce(c.vat_number, c.tax_registration_number) as tax_id, c.auto_collection,
          c.net_term_days, c.currency, c.created_at, c.updated_at,
          pm.provider_key, pm.provider_customer_id, pm.provider_payment_method_id, pm.brand,
          pm.last4, pm.exp_month, pm.exp_year
        from customers c
        left join lateral (
          select m.* from payment_methods m
           where m.customer_id = c.id and m.status = 'valid'
           order by (m.role = 'primary') desc, m.created_at desc limit 1
        ) pm on true
        where c.id in (${ids}) order by c.created_at, c.id`;
    case "subscriptions":
      return sql`select s.public_id, c.public_id as customer_public_id, s.status,
          s.cancel_at_period_end, s.currency, s.current_period_start, s.current_period_end,
          s.trial_end, s.start_date, coalesce(s.canceled_at, s.cancel_scheduled_at) as cancelled_at,
          s.auto_collection, s.po_number, s.created_at, s.updated_at, s.mrr,
          p.public_id as price_public_id, p.amount_minor as price_amount, i.quantity,
          coalesce(i.price_snapshot->>'amountMinor', i.price_snapshot->>'amount_minor') as snapshot_amount,
          (select string_agg(cp.code, '|' order by ac.created_at) from applied_coupons ac
             join coupons cp on cp.id = ac.coupon_id
            where ac.subscription_id = s.id and ac.status = 'active') as coupon_codes
        from subscriptions s
        join customers c on c.id = s.customer_id
        join subscription_items i on i.subscription_id = s.id
        join prices p on p.id = i.price_id
        where s.id in (${ids}) order by s.created_at, s.id, i.created_at, i.id`;
    case "invoices":
      return sql`select i.id, i.public_id, i.number, i.status, i.currency, i.created_at,
          i.due_date, i.paid_at, i.period_start, i.period_end, i.total_minor, i.amount_due_minor,
          c.public_id as customer_public_id, s.public_id as subscription_public_id,
          li.description as line_description, li.amount_minor as line_amount,
          li.quantity as line_quantity, li.kind as line_kind, lp.public_id as line_price_id
        from invoices i
        join customers c on c.id = i.customer_id
        left join subscriptions s on s.id = i.subscription_id
        left join invoice_line_items li on li.invoice_id = i.id
        left join prices lp on lp.id = li.price_id
        where i.id in (${ids}) order by i.created_at, i.id, li.seq, li.id`;
    case "credit_notes":
      return sql`select n.public_id, n.number, n.status, n.credit_method, n.currency,
          n.created_at, n.total_minor, n.allocated_minor, n.refunded_minor, n.paid_out_minor,
          n.reason, n.voided_at, i.public_id as invoice_public_id,
          c.public_id as customer_public_id
        from credit_notes n
        join invoices i on i.id = n.invoice_id
        join customers c on c.id = n.customer_id
        where n.id in (${ids}) order by n.created_at, n.id`;
    case "payments":
      return sql`select t.public_id, t.type, t.status, t.amount_minor, t.currency,
          t.occurred_at, t.gateway_key, t.id_at_gateway, t.error_text,
          c.public_id as customer_public_id, i.public_id as invoice_public_id,
          s.public_id as subscription_public_id,
          (select p.public_id from refunds rf
             join transactions p on p.payment_id = rf.payment_id and p.type = 'payment'
            where rf.id = t.refund_id order by p.created_at limit 1) as refunded_public_id
        from transactions t
        left join customers c on c.id = t.customer_id
        left join invoices i on i.id = t.invoice_id
        left join subscriptions s on s.id = t.subscription_id
        where t.id in (${ids}) order by t.occurred_at, t.id`;
    case "usage":
      return sql`select u.public_id, s.public_id as subscription_public_id,
          p.public_id as price_public_id, u.quantity, u."timestamp"
        from usage_records u
        join subscriptions s on s.id = u.subscription_id
        join prices p on p.id = u.price_id
        where u.id in (${ids}) order by u."timestamp", u.id`;
  }
}

/** How many records a file will hold: subscriptions and invoices, not their item or line rows. */
export function countQuery(ctx: Ctx, e: ExportEntity): SQL {
  return sql`select count(*)::int as n from (${rowSet(ctx, e)}) x where x.id is not null`;
}

/** Rows its own filters choose, before related ones are added. */
export function chosenCountQuery(ctx: Ctx, e: ExportEntity): SQL {
  return sql`select count(*)::int as n from (${chosen(ctx, e)}) x`;
}

export type DbRow = Record<string, unknown>;
export interface Skip {
  entity: ExportEntity;
  id: string;
  reason: string;
}

/** A row the import cannot read, and why. */
export class Skipped {
  constructor(readonly reason: string) {}
}

/** Invoice lines that are not charges: the import reads them as the tax and the discount. */
const ADJUSTMENT_KINDS = new Set(["tax", "discount", "rounding"]);

const IMPORT_MODELS = new Set(["flat", "per_unit", "tiered", "volume", "stairstep"]);

/**
 * One query row → the file's cells, or a reason the import cannot read it. Invoices are
 * not here: their lines need the whole invoice (`invoiceRows`).
 */
export function toCells(e: ExportEntity, r: DbRow): Record<string, CsvValue> | Skipped {
  switch (e) {
    case "plans":
    case "addons": {
      if (r.meter_id != null || r.type === "usage" || r.model === "usage")
        return new Skipped(
          "A usage price. Create it in the other business before you import usage.",
        );
      if (!IMPORT_MODELS.has(String(r.model)))
        return new Skipped(`The pricing model ${String(r.model)} cannot be imported from a file.`);
      const tiers = Array.isArray(r.tiers)
        ? (r.tiers as Array<Record<string, unknown>>)
            .map((t) => {
              const up = t.upToMinor ?? t.upTo ?? null;
              const amt = r.model === "stairstep" ? t.flatAmountMinor : t.unitAmountMinor;
              return `${up == null ? "inf" : String(up)}:${money(amt ?? 0, r.currency)}`;
            })
            .join("|")
        : null;
      const unit = String(r.trial_period_unit ?? "");
      const trial =
        r.trial_period == null
          ? null
          : unit === "day"
            ? Number(r.trial_period)
            : unit === "week"
              ? Number(r.trial_period) * 7
              : null;
      const flat = r.model === "flat" || r.model === "per_unit";
      return {
        price_id: r.price_id as string,
        [e === "plans" ? "plan_id" : "addon_id"]: r.product_id as string,
        name: r.name as string,
        pricing_model: r.model as string,
        amount: flat ? money(r.amount_minor, r.currency) : null,
        currency: r.currency as string,
        interval: (r.interval as string) ?? null,
        interval_count: r.interval == null ? null : (r.interval_count as number),
        tiers: flat ? null : tiers,
        trial_days: trial,
        description: (r.description as string) ?? null,
        status: r.active ? "active" : "archived",
        created_at: iso(r.created_at),
        product_name: r.product_name as string,
        updated_at: iso(r.updated_at),
      };
    }
    case "coupons": {
      const fixed = r.kind === "fixed_amount";
      return {
        coupon_id: r.code as string,
        name: (r.name as string) ?? null,
        discount_type: fixed ? "fixed_amount" : "percentage",
        percent_off: fixed ? null : pct(r.percent_off_bps),
        amount_off: fixed ? money(r.amount_off_minor, r.currency) : null,
        currency: fixed ? (r.currency as string) : null,
        duration: r.duration_type as string,
        duration_periods:
          r.duration_type === "repeating" ? (r.duration_in_periods as number) : null,
        max_redemptions: (r.max_redemptions as number) ?? null,
        redeem_by: iso(r.redeem_by),
        status: r.active ? "active" : "archived",
        created_at: iso(r.created_at),
        times_redeemed: (r.times_redeemed as number) ?? 0,
      };
    }
    case "customers":
      return {
        customer_id: r.public_id as string,
        email: (r.email as string) ?? null,
        first_name: (r.first_name as string) ?? null,
        last_name: (r.last_name as string) ?? null,
        name: (r.name as string) ?? null,
        company: (r.company as string) ?? null,
        phone: (r.phone as string) ?? null,
        address_line1: (r.address_line1 as string) ?? null,
        address_line2: (r.address_line2 as string) ?? null,
        city: (r.city as string) ?? null,
        state: (r.state as string) ?? null,
        postal_code: (r.postal_code as string) ?? null,
        country: (r.country as string) ?? null,
        tax_id: (r.tax_id as string) ?? null,
        auto_collection: (r.auto_collection as string) ?? null,
        net_term_days: (r.net_term_days as number) ?? null,
        payment_gateway: r.provider_payment_method_id ? (r.provider_key as string) : null,
        gateway_customer_id: r.provider_payment_method_id
          ? (r.provider_customer_id as string)
          : null,
        gateway_payment_method_id: (r.provider_payment_method_id as string) ?? null,
        card_brand: r.provider_payment_method_id ? ((r.brand as string) ?? null) : null,
        card_last4: r.provider_payment_method_id ? ((r.last4 as string) ?? null) : null,
        card_exp_month: r.provider_payment_method_id ? ((r.exp_month as number) ?? null) : null,
        card_exp_year: r.provider_payment_method_id ? ((r.exp_year as number) ?? null) : null,
        created_at: iso(r.created_at),
        currency: (r.currency as string) ?? null,
        updated_at: iso(r.updated_at),
      };
    case "subscriptions": {
      const status =
        r.status === "in_trial"
          ? "trialing"
          : r.status === "active" && r.cancel_at_period_end
            ? "non_renewing"
            : String(r.status);
      if (!SUBSCRIPTION_STATUSES.includes(status as (typeof SUBSCRIPTION_STATUSES)[number]))
        return new Skipped(`A subscription in the state ${status} cannot be imported from a file.`);
      const snap = r.snapshot_amount == null ? null : String(r.snapshot_amount);
      const override = snap != null && snap !== String(r.price_amount ?? "") ? snap : null;
      return {
        subscription_id: r.public_id as string,
        customer_id: r.customer_public_id as string,
        price_id: r.price_public_id as string,
        quantity: (r.quantity as number) ?? 1,
        unit_price: override == null ? null : money(override, r.currency),
        status,
        currency: r.currency as string,
        current_term_start: iso(r.current_period_start),
        current_term_end: iso(r.current_period_end),
        trial_end: status === "trialing" ? iso(r.trial_end) : null,
        start_date: status === "future" ? iso(r.start_date) : null,
        cancelled_at:
          status === "cancelled" || status === "non_renewing" ? iso(r.cancelled_at) : null,
        coupon_ids: (r.coupon_codes as string) ?? null,
        auto_collection: (r.auto_collection as string) ?? null,
        po_number: (r.po_number as string) ?? null,
        created_at: iso(r.created_at),
        mrr: r.mrr == null ? null : money(r.mrr, r.currency),
        next_billing_at:
          status === "active" || status === "trialing" ? iso(r.current_period_end) : null,
        updated_at: iso(r.updated_at),
      };
    }
    case "credit_notes": {
      const total = BigInt(String(r.total_minor ?? 0));
      const allocated = BigInt(String(r.allocated_minor ?? 0));
      const refunded =
        BigInt(String(r.refunded_minor ?? 0)) + BigInt(String(r.paid_out_minor ?? 0));
      const left = total - allocated - refunded;
      const voided = r.status === "voided";
      return {
        credit_note_id: r.public_id as string,
        invoice_id: r.invoice_public_id as string,
        customer_id: r.customer_public_id as string,
        type: r.credit_method === "refund" ? "refundable" : "adjustment",
        currency: r.currency as string,
        date: iso(r.created_at),
        total: money(total, r.currency),
        amount_allocated: money(allocated, r.currency),
        amount_refunded: money(refunded, r.currency),
        amount_available: money(voided || left < 0n ? 0n : left, r.currency),
        reason: (r.reason as string) ?? null,
        voided_at: iso(r.voided_at),
        number: (r.number as string) ?? null,
        status: r.status as string,
      };
    }
    case "payments":
      return {
        transaction_id: r.public_id as string,
        type: r.type as string,
        customer_id: (r.customer_public_id as string) ?? null,
        invoice_id: (r.invoice_public_id as string) ?? null,
        amount: money(r.amount_minor, r.currency),
        currency: r.currency as string,
        date: iso(r.occurred_at),
        status: r.status as string,
        payment_gateway: (r.gateway_key as string) ?? null,
        gateway_transaction_id: (r.id_at_gateway as string) ?? null,
        refunded_transaction_id: (r.refunded_public_id as string) ?? null,
        failure_reason: (r.error_text as string) ?? null,
        subscription_id: (r.subscription_public_id as string) ?? null,
      };
    case "usage":
      return {
        usage_id: r.public_id as string,
        subscription_id: r.subscription_public_id as string,
        price_id: r.price_public_id as string,
        quantity: String(r.quantity),
        timestamp: iso(r.timestamp),
      };
    case "invoices":
      throw new Error("invoices are written by invoiceRows");
  }
}

/**
 * One invoice's query rows (its lines) → file rows. The import reads one row per line and
 * checks lines − discount + tax = total, so: positive lines are lines, negative lines (a
 * discount the engine stored as a line) add to the discount, and the tax is what is left.
 */
export function invoiceRows(rows: DbRow[]): Array<Record<string, CsvValue>> | Skipped {
  const h = rows[0]!;
  const cur = h.currency as string;
  const status =
    h.status === "paid"
      ? "paid"
      : h.status === "voided"
        ? "void"
        : h.status === "pending"
          ? null
          : "open";
  if (!status) return new Skipped("A draft invoice cannot be imported from a file.");
  const amt = (r: DbRow) => BigInt(String(r.line_amount));
  const kind = (r: DbRow) => String(r.line_kind ?? "");
  const lines = rows.filter(
    (r) => r.line_amount != null && !ADJUSTMENT_KINDS.has(kind(r)) && amt(r) > 0n,
  );
  if (!lines.length) return new Skipped("An invoice with no lines cannot be imported from a file.");
  const total = BigInt(String(h.total_minor ?? 0));
  const sum = lines.reduce((n, r) => n + amt(r), 0n);
  const taxLines = rows
    .filter((r) => r.line_amount != null && kind(r) === "tax")
    .reduce((n, r) => n + amt(r), 0n);
  // Discount and tax as the import reads them: lines − discount + tax = total. Tax lines are
  // tax; whatever else is between the lines and the total is the discount (or, when the lines
  // fall short, tax that was not kept as lines).
  let tax = taxLines;
  let discount = sum + tax - total;
  if (discount < 0n) {
    tax -= discount;
    discount = 0n;
  }
  const paid = total - BigInt(String(h.amount_due_minor ?? 0));
  // The import reads the tax and the discount from the invoice's first line only.
  return lines.map((r, i) => ({
    invoice_id: h.public_id as string,
    customer_id: h.customer_public_id as string,
    subscription_id: (h.subscription_public_id as string) ?? null,
    number: (h.number as string) ?? null,
    status,
    currency: cur,
    date: iso(h.created_at),
    due_date: iso(h.due_date),
    paid_at: status === "paid" ? iso(h.paid_at) : null,
    period_start: iso(h.period_start),
    period_end: iso(h.period_end),
    total: money(total, cur),
    amount_due: money(h.amount_due_minor ?? 0, cur),
    tax: i === 0 ? money(tax, cur) : null,
    discount: i === 0 ? money(discount, cur) : null,
    line_description: (r.line_description as string) || "Line",
    line_amount: money(r.line_amount, cur),
    line_quantity: Math.max(1, Math.round(Number(r.line_quantity ?? 1))),
    line_price_id: (r.line_price_id as string) ?? null,
    amount_paid: money(paid < 0n ? 0n : paid, cur),
    paid_status: h.status as string,
  }));
}

export function makeCtx(input: {
  businessId: string;
  entities: readonly ExportEntity[];
  filters: ExportFilters;
  includeRelated: boolean;
}): Ctx {
  return {
    businessId: input.businessId,
    entities: new Set(input.entities),
    filters: input.filters,
    includeRelated: input.includeRelated,
  };
}

/** Run a count query in a transaction. */
export async function count(tx: Tx, q: SQL): Promise<number> {
  const rows = (await tx.execute(q)) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

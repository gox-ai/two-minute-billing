/**
 * One file row → typed values and per-cell errors. Pure: no database. The check (`check.ts`)
 * adds the errors that need other rows or the business (duplicates, references, existing).
 */
import { currencyExponent, decimalToMinor, isIsoCurrency } from "@/platform/currency";
import { zonedDayStart } from "@/platform/timezones";
import {
  ENTITY_FIELDS,
  normalizeHeader,
  type ColumnMapping,
  type FieldDef,
  type ImportEntity,
} from "./templates";

export interface CellIssue {
  /** The file's column name, or null for a row-level issue. */
  column: string | null;
  field: string | null;
  message: string;
}

export type ParsedValues = Record<string, string | number | string[] | Tier[] | null>;
export interface Tier {
  upTo: number | null;
  amountMinor: number;
}

export interface ParsedRow {
  sourceId: string | null;
  values: ParsedValues;
  errors: CellIssue[];
  warnings: CellIssue[];
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAIVE_DT_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
const ZONED_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

function validDay(day: string): boolean {
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

/**
 * A date cell as an instant. A date alone is midnight in the business's time zone; a date
 * and time with no offset is UTC, the way exports label their time columns; unix seconds
 * are accepted too.
 */
export function parseDate(v: string, tz: string | null): Date | null {
  const s = v.trim();
  if (DAY_RE.test(s)) return validDay(s) ? zonedDayStart(s, tz) : null;
  const naive = NAIVE_DT_RE.exec(s);
  if (naive) {
    if (!validDay(naive[1]!)) return null;
    const d = new Date(`${naive[1]}T${naive[2]}:${naive[3]}:${naive[4] ?? "00"}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (ZONED_DT_RE.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (/^\d{9,10}$/.test(s)) return new Date(Number(s) * 1000);
  return null;
}

/** "1,234.50" or "$49" → minor units; null when it is not an amount in `currency`. */
export function parseMoney(v: string, currency: string): number | null {
  const s = v
    .trim()
    .replace(/^[^\d-]+/, "")
    .replace(/,/g, "");
  if (!/^\d{1,13}(\.\d+)?$/.test(s)) return null;
  const frac = s.split(".")[1] ?? "";
  if (frac.length > currencyExponent(currency)) return null;
  return Number(decimalToMinor(s, currency));
}

const moneyHint = (currency: string) =>
  currencyExponent(currency) === 0
    ? `Enter a whole amount in ${currency}, with no decimals.`
    : `Enter an amount in ${currency} with up to ${currencyExponent(currency)} decimals, for example 49.00.`;

export function parseRow(
  entity: ImportEntity,
  raw: Record<string, string>,
  mapping: ColumnMapping,
  tz: string | null,
  /** The currency for amounts when the row has no currency column (a subscription's price). */
  fallbackCurrency: string | null = null,
): ParsedRow {
  const fields = ENTITY_FIELDS[entity];
  const columnOf = new Map<string, string>();
  for (const [header, key] of Object.entries(mapping)) if (key) columnOf.set(key, header);
  const errors: CellIssue[] = [];
  const warnings: CellIssue[] = [];
  const values: ParsedValues = {};
  const cell = (key: string) => {
    const h = columnOf.get(key);
    const v = h == null ? "" : (raw[h] ?? "").trim();
    // Our CSV exports put ' before text that starts with = + - or @, so a spreadsheet does
    // not run it as a formula (platform/csv.ts). The value is the text after it.
    return /^'[=+\-@]/.test(v) ? v.slice(1) : v;
  };
  const fail = (f: FieldDef, message: string) =>
    errors.push({ column: columnOf.get(f.key) ?? null, field: f.key, message });

  // Currency first: money cells depend on it.
  const currencyCell = cell("currency").toUpperCase();
  const currency = currencyCell
    ? isIsoCurrency(currencyCell)
      ? currencyCell
      : null
    : fallbackCurrency;

  for (const f of fields) {
    const v = cell(f.key);
    if (v === "") {
      if (f.required) fail(f, "Enter a value.");
      values[f.key] = null;
      continue;
    }
    switch (f.kind) {
      case "id":
        if (!ID_RE.test(v))
          fail(
            f,
            "Use 1 to 100 letters, digits, dots, hyphens or underscores. Start with a letter or digit.",
          );
        values[f.key] = v;
        break;
      case "text":
        if (v.length > 500) fail(f, "Use 500 characters or fewer.");
        values[f.key] = v;
        break;
      case "email":
        if (!EMAIL_RE.test(v) || v.length > 254) fail(f, "Enter a valid email address.");
        values[f.key] = v;
        break;
      case "currency":
        if (!isIsoCurrency(v.toUpperCase()))
          fail(f, "Enter a three-letter currency code, for example USD.");
        values[f.key] = v.toUpperCase();
        break;
      case "country":
        if (!/^[A-Za-z]{2}$/.test(v)) fail(f, "Enter a two-letter country code, for example US.");
        values[f.key] = v.toUpperCase();
        break;
      case "int": {
        const n = /^\d{1,9}$/.test(v) ? Number(v) : NaN;
        if (Number.isNaN(n)) fail(f, "Enter a whole number that is 0 or more.");
        values[f.key] = Number.isNaN(n) ? null : n;
        break;
      }
      case "percent": {
        const ok = /^\d{1,3}(\.\d{1,2})?%?$/.test(v);
        const bps = ok ? Math.round(Number(v.replace("%", "")) * 100) : NaN;
        if (!ok || bps <= 0 || bps > 10000)
          fail(f, "Enter a percent more than 0 and not more than 100.");
        values[f.key] = ok ? bps : null;
        break;
      }
      case "money": {
        if (!currency) {
          if (!currencyCell)
            fail(
              f,
              "We could not find the currency of this amount. Enter it in the currency column.",
            );
          values[f.key] = null;
          break;
        }
        const m = parseMoney(v, currency);
        if (m == null) fail(f, moneyHint(currency));
        values[f.key] = m;
        break;
      }
      case "enum": {
        const key = normalizeHeader(v);
        const out = f.values?.[key];
        if (!out) fail(f, `Use one of: ${[...new Set(Object.values(f.values ?? {}))].join(", ")}.`);
        values[f.key] = out ?? null;
        break;
      }
      case "date": {
        const d = parseDate(v, tz);
        if (!d) fail(f, "Enter a date as YYYY-MM-DD, or a date and time as YYYY-MM-DDTHH:MM:SSZ.");
        values[f.key] = d ? d.toISOString() : null;
        break;
      }
      case "list": {
        const parts = v
          .split("|")
          .map((p) => p.trim())
          .filter(Boolean);
        if (parts.some((p) => !ID_RE.test(p)))
          fail(
            f,
            "Separate the values with |. Each one uses letters, digits, dots, hyphens or underscores.",
          );
        values[f.key] = parts;
        break;
      }
      case "tiers": {
        if (!currency) {
          values[f.key] = null;
          break;
        }
        const tiers: Tier[] = [];
        let bad = false;
        for (const part of v.split("|")) {
          const [upTo, amount] = part.split(":").map((x) => x?.trim() ?? "");
          const up = /^inf(inity)?$/i.test(upTo ?? "")
            ? null
            : /^\d{1,9}$/.test(upTo ?? "")
              ? Number(upTo)
              : NaN;
          const m = amount ? parseMoney(amount, currency) : null;
          if (Number.isNaN(up) || m == null) bad = true;
          else tiers.push({ upTo: up, amountMinor: m });
        }
        const ordered = tiers.every(
          (t, i) =>
            i === 0 ||
            (tiers[i - 1]!.upTo != null && (t.upTo == null || t.upTo > tiers[i - 1]!.upTo!)),
        );
        if (bad || !tiers.length || !ordered || tiers[tiers.length - 1]!.upTo != null) {
          fail(
            f,
            "Enter up_to:amount pairs separated by |, in order, and end with inf. Example: 10:5.00|50:4.00|inf:3.00",
          );
          values[f.key] = null;
        } else values[f.key] = tiers;
        break;
      }
    }
  }

  checkEntity(
    entity,
    values,
    fields,
    (f, m) => {
      // One message per cell: a cell that did not parse already says why.
      if (!errors.some((e) => e.field === f.key)) fail(f, m);
    },
    warnings,
  );
  const idKey = fields.find((f) => f.required && f.kind === "id")!.key;
  return { sourceId: (values[idKey] as string | null) ?? null, values, errors, warnings };
}

/** Rules across the fields of one row. */
function checkEntity(
  entity: ImportEntity,
  v: ParsedValues,
  fields: FieldDef[],
  fail: (f: FieldDef, message: string) => void,
  warnings: CellIssue[],
) {
  const f = (key: string) => fields.find((x) => x.key === key)!;
  if (entity === "plans" || entity === "addons") {
    const model = (v.pricing_model as string | null) ?? "flat";
    if (model === "flat" || model === "per_unit") {
      if (v.amount == null) fail(f("amount"), "Enter the amount of the price.");
    } else if (v.tiers == null) fail(f("tiers"), `A ${model} price needs tiers.`);
    if (v.interval == null && v.interval_count != null)
      fail(f("interval_count"), "Enter an interval too, or leave this empty.");
    if (v.interval_count === 0) fail(f("interval_count"), "Enter 1 or more.");
  }
  if (entity === "coupons") {
    if (v.discount_type === "percentage" && v.percent_off == null)
      fail(f("percent_off"), "Enter the percent of the discount.");
    if (v.discount_type === "fixed_amount") {
      if (v.currency == null) fail(f("currency"), "A fixed_amount coupon needs a currency.");
      else if (v.amount_off == null) fail(f("amount_off"), "Enter the amount of the discount.");
    }
    if (v.duration === "repeating" && !v.duration_periods)
      fail(f("duration_periods"), "A repeating coupon needs the number of periods.");
  }
  if (entity === "customers") {
    const card = ["gateway_customer_id", "gateway_payment_method_id"].filter((k) => v[k] != null);
    if (card.length && (v.payment_gateway == null || card.length < 2)) {
      const missing = ["payment_gateway", "gateway_customer_id", "gateway_payment_method_id"].find(
        (k) => v[k] == null,
      )!;
      fail(
        f(missing),
        "A saved card needs the gateway, the gateway customer ID and the payment method ID.",
      );
    }
    if (v.card_last4 != null && !/^\d{4}$/.test(String(v.card_last4).slice(-4)))
      fail(f("card_last4"), "Enter the last 4 digits of the card.");
    if (v.card_exp_month != null && (Number(v.card_exp_month) < 1 || Number(v.card_exp_month) > 12))
      fail(f("card_exp_month"), "Enter a month from 1 to 12.");
    if (v.email == null)
      warnings.push({
        column: null,
        field: "email",
        message: "This customer has no email. We cannot send invoices or receipts.",
      });
  }
  if (entity === "invoices") {
    if (v.line_quantity === 0) fail(f("line_quantity"), "Enter 1 or more.");
    if (
      v.period_start != null &&
      v.period_end != null &&
      String(v.period_start) > String(v.period_end)
    )
      fail(f("period_end"), "The end of the period must be after its start.");
  }
  if (entity === "payments" && v.amount === 0) fail(f("amount"), "Enter an amount more than 0.");
  if (entity === "credit_notes" && v.total === 0) fail(f("total"), "Enter an amount more than 0.");
  if (entity === "usage" && v.quantity === 0) fail(f("quantity"), "Enter 1 or more.");
  if (entity === "subscriptions") {
    if (v.quantity === 0) fail(f("quantity"), "Enter 1 or more.");
    if (v.status === "trialing" && v.trial_end == null)
      fail(f("trial_end"), "A trialing subscription needs the date its trial ends.");
    if (v.status === "future" && v.start_date == null)
      fail(f("start_date"), "A future subscription needs its start date.");
    if (
      v.current_term_start != null &&
      v.current_term_end != null &&
      String(v.current_term_start) >= String(v.current_term_end)
    )
      fail(f("current_term_end"), "The end of the term must be after its start.");
  }
}

/**
 * The check: every row parsed, checked against the other files and the business, and the
 * run's review summary. `analyze` is pure (unit-tested); `runner.ts` loads its context and
 * stores what it returns. Nothing here writes billing data.
 */
import { minorToDecimalString } from "@/platform/currency";
import { parseRow, type CellIssue, type ParsedValues, type Tier } from "./parse";
import {
  ENTITY_FIELDS,
  IMPORT_ENTITIES,
  missingRequired,
  type ColumnMapping,
  type ImportEntity,
} from "./templates";

export interface RunFile {
  entity: ImportEntity;
  filename: string;
  headers: string[];
  mapping: ColumnMapping;
  rows: number;
}

export interface RunOptions {
  /** Leave out rows with errors (and the rows that need them) instead of blocking the run. */
  skip_invalid_rows?: boolean;
  /** Leave out subscriptions that renew in the next 24 hours. */
  exclude_renewing_within_24h?: boolean;
  /**
   * Open imported invoices enter the retry schedule from their due date. Off (the default):
   * they import as owed and nothing collects them until an operator does.
   */
  collect_open_invoices?: boolean;
}

export interface RawRow {
  id: string;
  entity: ImportEntity;
  rowNumber: number;
  raw: Record<string, string>;
}

export interface ExistingPrice {
  currency: string;
  model: string;
  amountMinor: number | null;
  interval: string | null;
  intervalCount: number;
  kind: "plan" | "addon" | "charge";
}

export interface CheckContext {
  tz: string | null;
  now: Date;
  /** Ids already in the business (imported or not). */
  existing: {
    prices: Map<string, ExistingPrice>;
    products: Set<string>;
    coupons: Set<string>;
    /** customer id → has a valid saved payment method. */
    customers: Map<string, boolean>;
    subscriptions: Set<string>;
    /** Subscription id → the price ids of its items (usage needs the item). */
    subscriptionPrices?: Map<string, Set<string>>;
    /** Source ids an earlier file import into this business brought, per record type. */
    imported?: {
      invoices: Map<string, { currency: string; customerId: string | null }>;
      creditNotes: Set<string>;
      transactions: Set<string>;
      usage: Set<string>;
    };
  };
  /** The business's next invoice number, for the numbering warning. */
  invoiceNextNumber?: number | null;
  /** Gateway keys with an active account in the business. */
  connectedGateways: Set<string>;
  /** Test business usage; null for a live business. */
  testUsage: {
    customers: { used: number; limit: number | null };
    subscriptions: { used: number; limit: number | null };
  } | null;
}

export type RowState = "new" | "existing" | "invalid" | "excluded";

export interface RowResult {
  id: string;
  sourceId: string | null;
  parsed: ParsedValues;
  errors: CellIssue[];
  warnings: CellIssue[];
  state: RowState;
}

export interface Notice {
  code: string;
  message: string;
  count?: number;
}

export interface EntityCounts {
  rows: number;
  new: number;
  existing: number;
  invalid: number;
  excluded: number;
}

export interface CheckSummary {
  entities: Partial<Record<ImportEntity, EntityCounts>>;
  /** Subscriptions are counted once each, not per item row. */
  subscriptions: { new: number; existing: number; invalid: number; excluded: number };
  mrr: Array<{ currency: string; amount_minor: number }>;
  payment: {
    with_card_connected: number;
    with_card_not_connected: number;
    without_card: number;
    gateways_not_connected: string[];
  };
  renewals: { first_at: string | null; last_at: string | null; within_24h: number };
  test_limits: {
    customers: { used: number; adding: number; limit: number | null };
    subscriptions: { used: number; adding: number; limit: number | null };
  } | null;
  /** Present when the files carry history. */
  history?: {
    /** New invoices (each is one or more rows: its lines). */
    invoices: number;
    open_invoices: number;
    /** What the open invoices still owe, per currency: opening receivables. */
    receivables: Array<{ currency: string; amount_minor: number }>;
    /** Refundable credit-note balances: opening customer credit. */
    credit: Array<{ currency: string; amount_minor: number }>;
    /** The next invoice number after the import, when imported numbers move it. */
    next_invoice_number: number | null;
  };
  not_imported: string[];
  blockers: Notice[];
  warnings: Notice[];
  ready: boolean;
}

/** What no file import carries: the review says so before anything is written. */
export const NOT_IMPORTED = [
  "tax_rates",
  "gateway_credentials",
  "dunning_rules",
  "invoice_numbering",
  "email_templates",
];

const SUB_FIELDS = [
  "customer_id",
  "status",
  "currency",
  "current_term_start",
  "current_term_end",
  "trial_end",
  "start_date",
  "cancelled_at",
  "auto_collection",
  "po_number",
  "created_at",
];

const INVOICE_FIELDS = [
  "customer_id",
  "subscription_id",
  "number",
  "status",
  "currency",
  "date",
  "due_date",
  "paid_at",
  "period_start",
  "period_end",
  "total",
  "amount_due",
];

const RENEWING = new Set(["active", "trialing", "future", "non_renewing"]);
const COLLECTING = new Set(["active", "trialing", "future"]);
const DAY_MS = 86_400_000;

const issue = (
  message: string,
  field: string | null = null,
  column: string | null = null,
): CellIssue => ({
  column,
  field,
  message,
});

/** Amount for `qty` units of a tiered price. */
function tieredAmount(model: string, tiers: Tier[], qty: number): number {
  let prev = 0;
  if (model === "volume" || model === "stairstep") {
    const t = tiers.find((x) => x.upTo == null || qty <= x.upTo) ?? tiers[tiers.length - 1]!;
    return model === "volume" ? t.amountMinor * qty : t.amountMinor;
  }
  let total = 0;
  for (const t of tiers) {
    const top = t.upTo ?? Infinity;
    const units = Math.max(0, Math.min(qty, top) - prev);
    total += units * t.amountMinor;
    prev = top;
    if (qty <= top) break;
  }
  return total;
}

function monthly(amount: number, interval: string | null, count: number): number {
  const c = Math.max(1, count);
  switch (interval) {
    case "day":
      return (amount * 365) / 12 / c;
    case "week":
      return (amount * 52) / 12 / c;
    case "month":
      return amount / c;
    case "year":
      return amount / 12 / c;
    default:
      return 0;
  }
}

export function analyze(
  files: RunFile[],
  rawRows: RawRow[],
  options: RunOptions,
  ctx: CheckContext,
): { rows: RowResult[]; summary: CheckSummary } {
  const mappingOf = new Map(files.map((f) => [f.entity, f.mapping]));
  const results = new Map<string, RowResult>();
  const byEntity = new Map<ImportEntity, RowResult[]>(IMPORT_ENTITIES.map((e) => [e, []]));
  const rowNo = new Map<string, number>();
  const entityOf = new Map<string, ImportEntity>();
  const blockers: Notice[] = [];
  const warnings: Notice[] = [];

  for (const f of files) {
    const missing = missingRequired(f.entity, f.mapping);
    if (missing.length)
      blockers.push({
        code: "unmapped_required",
        message: `${f.filename}: map a column to ${missing.join(", ")}.`,
      });
  }

  // Subscriptions last: a row with no currency column reads its amounts in its price's currency.
  const priceCurrency = new Map<string, string>();
  const ordered = [...rawRows].sort(
    (a, b) => Number(a.entity === "subscriptions") - Number(b.entity === "subscriptions"),
  );
  for (const r of ordered) {
    const mapping = mappingOf.get(r.entity) ?? {};
    let fallback: string | null = null;
    if (r.entity === "subscriptions") {
      const h = Object.entries(mapping).find(([, k]) => k === "price_id")?.[0];
      const pid = h ? (r.raw[h] ?? "").trim() : "";
      fallback = priceCurrency.get(pid) ?? ctx.existing.prices.get(pid)?.currency ?? null;
    }
    const p = parseRow(r.entity, r.raw, mapping, ctx.tz, fallback);
    if ((r.entity === "plans" || r.entity === "addons") && p.values.price_id && p.values.currency)
      priceCurrency.set(String(p.values.price_id), String(p.values.currency));
    if (r.raw.__extra)
      p.errors.push(
        issue(
          "This row has more values than the file has columns. Check the quotes and separators.",
        ),
      );
    const res: RowResult = {
      id: r.id,
      sourceId: p.sourceId,
      parsed: p.values,
      errors: p.errors,
      warnings: p.warnings,
      state: "new",
    };
    results.set(r.id, res);
    byEntity.get(r.entity)!.push(res);
    rowNo.set(r.id, r.rowNumber);
    entityOf.set(r.id, r.entity);
  }
  const col = (entity: ImportEntity, key: string) => {
    const m = mappingOf.get(entity) ?? {};
    return Object.entries(m).find(([, k]) => k === key)?.[0] ?? null;
  };
  const err = (r: RowResult, entity: ImportEntity, key: string | null, message: string) =>
    r.errors.push(issue(message, key, key ? col(entity, key) : null));

  // ── Duplicates and the catalog ───────────────────────────────────────────────
  const fileName = (e: ImportEntity) => files.find((f) => f.entity === e)?.filename ?? `${e}.csv`;
  const priceRows = new Map<string, { row: RowResult; entity: "plans" | "addons" }>();
  const productKind = new Map<string, { kind: "plans" | "addons"; row: RowResult }>();
  for (const entity of ["plans", "addons"] as const) {
    for (const r of byEntity.get(entity)!) {
      const id = r.parsed.price_id as string | null;
      if (!id) continue;
      const dup = priceRows.get(id);
      if (dup) {
        err(
          r,
          entity,
          "price_id",
          `This price ID is also on row ${rowNo.get(dup.row.id)} of ${fileName(dup.entity)}.`,
        );
        continue;
      }
      priceRows.set(id, { row: r, entity });
      const productId =
        (r.parsed[entity === "plans" ? "plan_id" : "addon_id"] as string | null) ?? id;
      const pk = productKind.get(productId);
      if (pk && pk.kind !== entity)
        err(
          r,
          entity,
          entity === "plans" ? "plan_id" : "addon_id",
          `This ID is also an ${pk.kind === "plans" ? "plan" : "add-on"} on row ${rowNo.get(pk.row.id)} of ${fileName(pk.kind)}.`,
        );
      else if (!pk) productKind.set(productId, { kind: entity, row: r });
      if (r.parsed.interval == null && entity === "plans")
        err(r, entity, "interval", "A plan needs an interval.");
    }
  }
  const once = (entity: ImportEntity, key: string) => {
    const seen = new Map<string, RowResult>();
    for (const r of byEntity.get(entity)!) {
      const id = r.parsed[key] as string | null;
      if (!id) continue;
      const first = seen.get(id);
      if (first) err(r, entity, key, `This ID is also on row ${rowNo.get(first.id)}.`);
      else seen.set(id, r);
    }
    return seen;
  };
  const couponRows = once("coupons", "coupon_id");
  const customerRows = once("customers", "customer_id");

  // ── Subscriptions: one per id, rows are its items ────────────────────────────
  const subs = new Map<string, RowResult[]>();
  for (const r of byEntity.get("subscriptions")!) {
    const id = r.parsed.subscription_id as string | null;
    if (!id) continue;
    const list = subs.get(id) ?? [];
    if (list.length) {
      const first = list[0]!;
      for (const k of SUB_FIELDS)
        if (r.parsed[k] != null && JSON.stringify(r.parsed[k]) !== JSON.stringify(first.parsed[k]))
          err(
            r,
            "subscriptions",
            k,
            `This is different on row ${rowNo.get(first.id)} of the same subscription.`,
          );
      if (list.some((x) => x.parsed.price_id === r.parsed.price_id))
        err(r, "subscriptions", "price_id", "This price is on the subscription two times.");
    }
    list.push(r);
    subs.set(id, list);
  }

  // ── References ────────────────────────────────────────────────────────────────
  const priceInfo = (id: string) => {
    const f = priceRows.get(id);
    if (f)
      return {
        currency: f.row.parsed.currency as string,
        model: (f.row.parsed.pricing_model as string | null) ?? "flat",
        amountMinor: f.row.parsed.amount as number | null,
        tiers: f.row.parsed.tiers as Tier[] | null,
        interval: f.row.parsed.interval as string | null,
        intervalCount: (f.row.parsed.interval_count as number | null) ?? 1,
        row: f.row,
      };
    const e = ctx.existing.prices.get(id);
    return e ? { ...e, tiers: null, row: null } : null;
  };
  const deps = new Map<string, RowResult[]>(); // row id → rows it needs
  const need = (r: RowResult, dep: RowResult | null | undefined) => {
    if (!dep) return;
    const l = deps.get(r.id) ?? [];
    l.push(dep);
    deps.set(r.id, l);
  };
  const subCurrency = new Map<string, string>();
  for (const [id, rows] of subs) {
    const first = rows[0]!;
    const custId = first.parsed.customer_id as string | null;
    if (custId) {
      const c = customerRows.get(custId);
      if (c) for (const r of rows) need(r, c);
      else if (!ctx.existing.customers.has(custId))
        err(
          first,
          "subscriptions",
          "customer_id",
          "There is no customer with this ID in your customers file or in this business.",
        );
    }
    let currency = (first.parsed.currency as string | null) ?? null;
    for (const r of rows) {
      const pid = r.parsed.price_id as string | null;
      if (!pid) continue;
      const p = priceInfo(pid);
      if (!p) {
        err(
          r,
          "subscriptions",
          "price_id",
          "There is no price with this ID in your plans or add-ons file or in this business.",
        );
        continue;
      }
      need(r, p.row);
      if (p.interval == null && priceRows.get(pid)?.entity !== "addons")
        err(r, "subscriptions", "price_id", "A subscription item needs a recurring price.");
      currency ??= p.currency;
      if (p.currency !== currency)
        err(
          r,
          "subscriptions",
          "price_id",
          `This price is in ${p.currency}. The subscription is in ${currency}.`,
        );
      if (r.parsed.unit_price != null && !["flat", "per_unit"].includes(p.model))
        err(
          r,
          "subscriptions",
          "unit_price",
          "A negotiated price is possible only on a flat or per_unit price.",
        );
    }
    if (currency) subCurrency.set(id, currency);
    for (const c of new Set(rows.flatMap((r) => (r.parsed.coupon_ids as string[] | null) ?? []))) {
      const cr = couponRows.get(c);
      if (cr) for (const r of rows) need(r, cr);
      else if (!ctx.existing.coupons.has(c))
        err(
          first,
          "subscriptions",
          "coupon_ids",
          `There is no coupon ${c} in your coupons file or in this business.`,
        );
    }
    if (ctx.existing.subscriptions.has(id)) for (const r of rows) r.state = "existing";
  }

  // ── Renewal dates ────────────────────────────────────────────────────────────
  const renewalOf = (v: ParsedValues): Date | null => {
    const s = (v.status as string | null) ?? "active";
    if (!RENEWING.has(s)) return null;
    const d = s === "trialing" ? v.trial_end : s === "future" ? v.start_date : v.current_term_end;
    return d ? new Date(String(d)) : null;
  };
  const soon = new Set<string>();
  for (const [id, rows] of subs) {
    const first = rows[0]!;
    if (first.state === "existing") continue;
    const at = renewalOf(first.parsed);
    if (!at) continue;
    if (at.getTime() <= ctx.now.getTime())
      err(
        first,
        "subscriptions",
        first.parsed.status === "trialing"
          ? "trial_end"
          : first.parsed.status === "future"
            ? "start_date"
            : "current_term_end",
        "This date is in the past. The subscription would renew and charge at once. Use the date the paid period ends.",
      );
    else if (at.getTime() - ctx.now.getTime() < DAY_MS) soon.add(id);
  }

  // ── History: invoices (rows are lines), credit notes, payments, usage ─────────
  const imported = ctx.existing.imported;
  const invoices = new Map<string, RowResult[]>();
  for (const r of byEntity.get("invoices")!) {
    const id = r.parsed.invoice_id as string | null;
    if (!id) continue;
    const list = invoices.get(id) ?? [];
    if (list.length) {
      const first = list[0]!;
      for (const k of INVOICE_FIELDS)
        if (r.parsed[k] != null && JSON.stringify(r.parsed[k]) !== JSON.stringify(first.parsed[k]))
          err(
            r,
            "invoices",
            k,
            `This is different on row ${rowNo.get(first.id)} of the same invoice.`,
          );
      for (const k of ["tax", "discount"])
        if (r.parsed[k] != null)
          err(
            r,
            "invoices",
            k,
            "Put the tax and the discount on the first row of the invoice only.",
          );
    }
    list.push(r);
    invoices.set(id, list);
  }
  const subRows = (id: string) => subs.get(id) ?? null;
  const customerRef = (entity: ImportEntity, r: RowResult, custId: string | null) => {
    if (!custId) return;
    const c = customerRows.get(custId);
    if (c) need(r, c);
    else if (!ctx.existing.customers.has(custId))
      err(
        r,
        entity,
        "customer_id",
        "There is no customer with this ID in your customers file or in this business.",
      );
  };
  /** An invoice in the files, or one an earlier import brought: its currency and customer. */
  const invoiceInfo = (id: string) => {
    const rows = invoices.get(id);
    if (rows)
      return {
        currency: rows[0]!.parsed.currency as string | null,
        customerId: rows[0]!.parsed.customer_id as string | null,
        rows,
      };
    const e = imported?.invoices.get(id);
    return e ? { currency: e.currency, customerId: e.customerId, rows: null } : null;
  };
  const receivables = new Map<string, number>();
  const credit = new Map<string, number>();
  let openInvoices = 0;
  let maxNumber = 0;
  for (const [, rows] of invoices) {
    const first = rows[0]!;
    const v = first.parsed;
    for (const r of rows) customerRef("invoices", r, v.customer_id as string | null);
    const subId = v.subscription_id as string | null;
    if (subId) {
      const sr = subRows(subId);
      if (sr) for (const r of rows) for (const d of sr) need(r, d);
      else if (!ctx.existing.subscriptions.has(subId))
        err(
          first,
          "invoices",
          "subscription_id",
          "There is no subscription with this ID in your subscriptions file or in this business.",
        );
      else if (sr === null && v.customer_id && customerRows.has(String(v.customer_id)))
        err(
          first,
          "invoices",
          "subscription_id",
          "This subscription is in this business, but the customer is new in your customers file.",
        );
    }
    for (const r of rows) {
      const pid = r.parsed.line_price_id as string | null;
      if (!pid) continue;
      const p = priceInfo(pid);
      if (!p)
        err(
          r,
          "invoices",
          "line_price_id",
          "There is no price with this ID in your plans or add-ons file or in this business.",
        );
      else need(r, p.row);
    }
    const total = v.total as number | null;
    const lines = rows.reduce((n, r) => n + ((r.parsed.line_amount as number | null) ?? 0), 0);
    const tax = (v.tax as number | null) ?? 0;
    const discount = (v.discount as number | null) ?? 0;
    if (total != null && rows.every((r) => r.parsed.line_amount != null)) {
      const sum = lines - discount + tax;
      if (sum !== total)
        err(
          first,
          "invoices",
          "total",
          `The lines, less the discount, plus the tax make ${v.currency ? minorToDecimalString(BigInt(sum), String(v.currency)) : sum}. Make the total the same, or correct the lines.`,
        );
    }
    const status = v.status as string | null;
    const due = (v.amount_due as number | null) ?? (status === "payment_due" ? total : 0);
    if (total != null && due != null && due > total)
      err(first, "invoices", "amount_due", "The amount due cannot be more than the total.");
    if (status === "payment_due" && due === 0)
      err(first, "invoices", "amount_due", "An open invoice needs an amount due more than 0.");
    if (status !== "payment_due" && v.amount_due != null && (v.amount_due as number) > 0)
      err(first, "invoices", "amount_due", `A ${status} invoice has no amount due. Use 0.`);
    if (status === "paid" && v.paid_at == null)
      first.warnings.push(issue("No paid date. We use the invoice date.", "paid_at"));
    const n = Number(String(v.number ?? v.invoice_id ?? "").replace(/\D/g, ""));
    if (Number.isFinite(n) && n > maxNumber) maxNumber = n;
  }
  const paymentRows = once("payments", "transaction_id");
  for (const r of byEntity.get("payments")!) {
    const v = r.parsed;
    customerRef("payments", r, v.customer_id as string | null);
    const invId = v.invoice_id as string | null;
    if (invId) {
      const inv = invoiceInfo(invId);
      if (!inv)
        err(
          r,
          "payments",
          "invoice_id",
          "There is no invoice with this ID in your invoices file or in an earlier import.",
        );
      else {
        if (inv.rows) for (const d of inv.rows) need(r, d);
        if (inv.currency && v.currency && inv.currency !== v.currency)
          err(r, "payments", "currency", `The invoice is in ${inv.currency}.`);
        if (inv.customerId && v.customer_id && inv.customerId !== v.customer_id)
          err(r, "payments", "customer_id", `The invoice is for customer ${inv.customerId}.`);
      }
    }
    if (v.type === "refund") {
      const of = v.refunded_transaction_id as string | null;
      const pay = of ? paymentRows.get(of) : undefined;
      if (!of)
        err(r, "payments", "refunded_transaction_id", "A refund needs the payment it gives back.");
      else if (!pay || (pay.parsed.type ?? "payment") !== "payment")
        err(
          r,
          "payments",
          "refunded_transaction_id",
          "There is no payment with this ID in your payments file.",
        );
      else need(r, pay);
    } else if (v.refunded_transaction_id != null)
      err(r, "payments", "refunded_transaction_id", "Only a refund gives back a payment.");
  }
  once("credit_notes", "credit_note_id");
  for (const r of byEntity.get("credit_notes")!) {
    const v = r.parsed;
    const invId = v.invoice_id as string | null;
    const inv = invId ? invoiceInfo(invId) : null;
    if (invId && !inv)
      err(
        r,
        "credit_notes",
        "invoice_id",
        "There is no invoice with this ID in your invoices file or in an earlier import.",
      );
    if (inv?.rows) for (const d of inv.rows) need(r, d);
    if (inv?.currency && v.currency && inv.currency !== v.currency)
      err(r, "credit_notes", "currency", `The invoice is in ${inv.currency}.`);
    if (v.customer_id && inv?.customerId && v.customer_id !== inv.customerId)
      err(r, "credit_notes", "customer_id", `The invoice is for customer ${inv.customerId}.`);
    const parts = ["amount_allocated", "amount_refunded", "amount_available"].reduce(
      (n, k) => n + ((v[k] as number | null) ?? 0),
      0,
    );
    if (v.total != null && parts > (v.total as number))
      err(
        r,
        "credit_notes",
        "amount_available",
        "The allocated, refunded and available amounts are more than the total.",
      );
  }
  once("usage", "usage_id");
  for (const r of byEntity.get("usage")!) {
    const v = r.parsed;
    const subId = v.subscription_id as string | null;
    const pid = v.price_id as string | null;
    if (!subId || !pid) continue;
    const sr = subRows(subId);
    if (sr) for (const d of sr) need(r, d);
    const price = ctx.existing.prices.get(pid);
    if (!price || price.model !== "usage")
      err(
        r,
        "usage",
        "price_id",
        "There is no usage price with this ID in this business. Create the usage price first.",
      );
    else if (
      sr ? !sr.some((x) => x.parsed.price_id === pid) : !ctx.existing.subscriptions.has(subId)
    )
      err(
        r,
        "usage",
        sr ? "price_id" : "subscription_id",
        sr
          ? "This price is not on the subscription in your subscriptions file."
          : "There is no subscription with this ID in your subscriptions file or in this business.",
      );
    else if (!sr && !ctx.existing.subscriptionPrices?.get(subId)?.has(pid))
      err(r, "usage", "price_id", "This price is not on the subscription.");
  }

  // ── States ───────────────────────────────────────────────────────────────────
  const existsInBusiness = (entity: ImportEntity, r: RowResult): boolean => {
    const id = r.sourceId;
    if (!id) return false;
    if (entity === "plans" || entity === "addons") return ctx.existing.prices.has(id);
    if (entity === "coupons") return ctx.existing.coupons.has(id);
    if (entity === "customers") return ctx.existing.customers.has(id);
    if (entity === "subscriptions") return ctx.existing.subscriptions.has(id);
    const imp = ctx.existing.imported;
    if (entity === "invoices") return !!imp?.invoices.has(id);
    if (entity === "credit_notes") return !!imp?.creditNotes.has(id);
    if (entity === "payments") return !!imp?.transactions.has(id);
    return !!imp?.usage.has(id);
  };
  for (const [entity, rows] of byEntity)
    for (const r of rows) {
      if (r.errors.length) r.state = "invalid";
      else if (r.state !== "existing" && existsInBusiness(entity, r)) r.state = "existing";
    }
  // A subscription or an invoice with one bad row is bad as a whole.
  for (const rows of [...subs.values(), ...invoices.values()])
    if (rows.some((r) => r.state === "invalid"))
      for (const r of rows)
        if (r.state !== "invalid") {
          r.state = "excluded";
          r.warnings.push(issue("Left out: another row of this subscription has errors."));
        }
  // Rows that need an invalid row are left out, in dependency order.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [rid, list] of deps) {
      const r = results.get(rid)!;
      if (r.state === "invalid" || r.state === "excluded") continue;
      const bad = list.find((d) => d.state === "invalid" || d.state === "excluded");
      if (!bad) continue;
      const e = entityOf.get(bad.id)!;
      r.state = "excluded";
      r.warnings.push(issue(`Left out: row ${rowNo.get(bad.id)} of ${fileName(e)} has errors.`));
      changed = true;
    }
    // Keep each subscription and invoice whole.
    for (const rows of [...subs.values(), ...invoices.values()])
      if (
        rows.some((r) => r.state === "excluded") &&
        rows.some((r) => r.state === "new" || r.state === "existing")
      ) {
        for (const r of rows) if (r.state === "new" || r.state === "existing") r.state = "excluded";
        changed = true;
      }
  }
  if (options.exclude_renewing_within_24h)
    for (const id of soon)
      for (const r of subs.get(id) ?? [])
        if (r.state === "new") {
          r.state = "excluded";
          r.warnings.push(issue("Left out: this subscription renews in the next 24 hours."));
        }

  // ── Summary ──────────────────────────────────────────────────────────────────
  const entities: CheckSummary["entities"] = {};
  for (const f of files) {
    const rows = byEntity.get(f.entity)!;
    entities[f.entity] = {
      rows: rows.length,
      new: rows.filter((r) => r.state === "new").length,
      existing: rows.filter((r) => r.state === "existing").length,
      invalid: rows.filter((r) => r.state === "invalid").length,
      excluded: rows.filter((r) => r.state === "excluded").length,
    };
  }
  const subState = (rows: RowResult[]): RowState =>
    rows.some((r) => r.state === "invalid") ? "invalid" : rows[0]!.state;
  const newSubs = [...subs].filter(([, rows]) => subState(rows) === "new");
  const subscriptions = {
    new: newSubs.length,
    existing: [...subs.values()].filter((r) => subState(r) === "existing").length,
    invalid: [...subs.values()].filter((r) => subState(r) === "invalid").length,
    excluded: [...subs.values()].filter((r) => subState(r) === "excluded").length,
  };

  // Opening money the history brings: what open invoices owe, refundable credit.
  for (const [, rows] of invoices) {
    const v = rows[0]!.parsed;
    if (rows[0]!.state !== "new" || v.status !== "payment_due") continue;
    openInvoices++;
    const due = (v.amount_due as number | null) ?? (v.total as number);
    const c = String(v.currency);
    receivables.set(c, (receivables.get(c) ?? 0) + due);
  }
  for (const r of byEntity.get("credit_notes")!) {
    const v = r.parsed;
    if (r.state !== "new" || (v.type ?? "refundable") !== "refundable" || v.voided_at != null)
      continue;
    const n = (v.amount_available as number | null) ?? 0;
    if (n > 0) credit.set(String(v.currency), (credit.get(String(v.currency)) ?? 0) + n);
  }
  const hasHistory = ["invoices", "credit_notes", "payments", "usage"].some((e) =>
    files.some((f) => f.entity === e),
  );
  const nextNumber =
    maxNumber > 0 && maxNumber + 1 > (ctx.invoiceNextNumber ?? 0) ? maxNumber + 1 : null;
  if (openInvoices)
    warnings.push(
      options.collect_open_invoices
        ? {
            code: "open_invoices_collected",
            count: openInvoices,
            message: `${openInvoices === 1 ? "1 open invoice enters" : `${openInvoices} open invoices enter`} your retry schedule from the due date. A card on file is charged at the next retry, also for an invoice that is past due. Stop collecting ${openInvoices === 1 ? "it" : "them"} in your current system first.`,
          }
        : {
            code: "open_invoices_not_collected",
            count: openInvoices,
            message: `${openInvoices === 1 ? "1 open invoice imports" : `${openInvoices} open invoices import`} as owed. Nothing collects ${openInvoices === 1 ? "it" : "them"} until you do, or until you turn on collection for this import.`,
          },
    );
  if (nextNumber)
    warnings.push({
      code: "invoice_numbering",
      message: `The imported invoice numbers move your next invoice number to ${nextNumber}. An undo does not move it back.`,
    });

  const mrr = new Map<string, number>();
  let firstAt: Date | null = null;
  let lastAt: Date | null = null;
  let within24h = 0;
  const collectingCustomers = new Set<string>();
  for (const [id, rows] of newSubs) {
    const v = rows[0]!.parsed;
    const status = (v.status as string | null) ?? "active";
    const currency = subCurrency.get(id);
    if (currency && (status === "active" || status === "non_renewing")) {
      let total = 0;
      for (const r of rows) {
        const p = priceInfo(r.parsed.price_id as string)!;
        const qty = (r.parsed.quantity as number | null) ?? 1;
        const unit = (r.parsed.unit_price as number | null) ?? p.amountMinor;
        const amount =
          p.model === "flat"
            ? (unit ?? 0)
            : p.model === "per_unit"
              ? (unit ?? 0) * qty
              : p.tiers
                ? tieredAmount(p.model, p.tiers, qty)
                : 0;
        total += monthly(amount, p.interval, p.intervalCount);
      }
      mrr.set(currency, (mrr.get(currency) ?? 0) + total);
    }
    const at = renewalOf(v);
    if (at) {
      if (!firstAt || at < firstAt) firstAt = at;
      if (!lastAt || at > lastAt) lastAt = at;
      if (soon.has(id)) within24h++;
    }
    const customer = v.customer_id as string;
    const custRow = customerRows.get(customer);
    const auto =
      (v.auto_collection as string | null) ??
      (custRow?.parsed.auto_collection as string | null) ??
      "on";
    if (COLLECTING.has(status) && auto === "on") collectingCustomers.add(customer);
  }
  let withConnected = 0;
  let withOther = 0;
  let without = 0;
  const notConnected = new Set<string>();
  for (const c of collectingCustomers) {
    const row = customerRows.get(c);
    if (row && row.state === "new") {
      const gw = row.parsed.payment_gateway as string | null;
      if (!gw || row.parsed.gateway_payment_method_id == null) without++;
      else if (ctx.connectedGateways.has(gw)) withConnected++;
      else {
        withOther++;
        notConnected.add(gw);
      }
    } else if (ctx.existing.customers.get(c)) withConnected++;
    else without++;
  }
  if (notConnected.size)
    warnings.push({
      code: "gateway_not_connected",
      count: withOther,
      message: `${withOther} customers have a saved card at ${[...notConnected].join(", ")}, which is not connected to this business. Their renewals fail until you connect the same gateway account and import again.`,
    });
  if (without)
    warnings.push({
      code: "no_card",
      count: without,
      message: `${without} customers with automatic collection have no saved card. At renewal their invoices go into dunning until they add a card.`,
    });
  if (within24h && !options.exclude_renewing_within_24h)
    warnings.push({
      code: "renews_within_24h",
      count: within24h,
      message: `${within24h} subscriptions renew in the next 24 hours. Stop their renewals in your current system first, or leave them out.`,
    });

  const invalidRows = [...results.values()].filter((r) => r.state === "invalid").length;
  if (invalidRows && !options.skip_invalid_rows)
    blockers.push({
      code: "invalid_rows",
      count: invalidRows,
      message: `${invalidRows} rows have errors. Correct them and upload the files again, or leave out the rows with errors.`,
    });

  let testLimits: CheckSummary["test_limits"] = null;
  if (ctx.testUsage) {
    const newCustomers = byEntity.get("customers")!.filter((r) => r.state === "new").length;
    testLimits = {
      customers: { ...ctx.testUsage.customers, adding: newCustomers },
      subscriptions: { ...ctx.testUsage.subscriptions, adding: newSubs.length },
    };
    for (const k of ["customers", "subscriptions"] as const) {
      const t = testLimits[k];
      if (t.limit != null && t.used + t.adding > t.limit)
        blockers.push({
          code: `test_limit_${k}`,
          message: `A test business holds up to ${t.limit} ${k}. It has ${t.used}, and this import adds ${t.adding}.`,
        });
    }
  }

  const anythingNew = [...results.values()].some((r) => r.state === "new");
  if (!anythingNew && !blockers.length)
    blockers.push({
      code: "nothing_new",
      message:
        "There is nothing new to import. Every row is in this business already, or left out.",
    });

  return {
    rows: [...results.values()],
    summary: {
      entities,
      subscriptions,
      mrr: [...mrr].map(([currency, v]) => ({ currency, amount_minor: Math.round(v) })),
      payment: {
        with_card_connected: withConnected,
        with_card_not_connected: withOther,
        without_card: without,
        gateways_not_connected: [...notConnected].sort(),
      },
      renewals: {
        first_at: firstAt?.toISOString() ?? null,
        last_at: lastAt?.toISOString() ?? null,
        within_24h: within24h,
      },
      test_limits: testLimits,
      ...(hasHistory
        ? {
            history: {
              invoices: [...invoices.values()].filter((rows) => rows[0]!.state === "new").length,
              open_invoices: openInvoices,
              receivables: [...receivables].map(([currency, amount_minor]) => ({
                currency,
                amount_minor,
              })),
              credit: [...credit].map(([currency, amount_minor]) => ({ currency, amount_minor })),
              next_invoice_number: nextNumber,
            },
          }
        : {}),
      not_imported: NOT_IMPORTED,
      blockers,
      warnings,
      ready: blockers.length === 0,
    },
  };
}

/** Fields of each entity, in template order: the review's column list. */
export const fieldKeys = (e: ImportEntity) => ENTITY_FIELDS[e].map((f) => f.key);

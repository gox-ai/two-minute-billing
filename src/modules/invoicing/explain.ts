/**
 * Why an invoice is what it is — from its own stored lines, never recomputed.
 *
 * Works on the serialized detail view (`serializeInvoice` with lines, discount shares and
 * relations), so it explains exactly what the API shows. Three parts:
 *  - the totals ladder, from stored fields, with a check that the documented identity holds;
 *  - per line, the facts behind it (kind, period, price, discounts, tax or why untaxed);
 *  - the difference from the subscription's previous invoice, grouped by price.
 */

type Line = {
  id: string;
  description: string;
  kind: string;
  quantity: number;
  amount_minor: number;
  discount_minor?: number;
  tax_amount_minor?: number;
  is_taxed?: boolean;
  tax_exempt_reason?: string | null;
  price: string | null;
  period_start: string | Date | null;
  period_end: string | Date | null;
  adjustment?: string | null;
  rating?: unknown;
};

type Discount = {
  label: string | null;
  scope: string;
  source: string | null;
  coupon_code: string | null;
  line_item_ids: string[];
  amount_minor: number;
};

export type InvoiceView = {
  id: string;
  number: string | null;
  status: string;
  currency: string;
  subtotal_minor: number;
  total_minor: number;
  amount_paid_minor: number;
  amount_due_minor: number;
  credits_applied_minor: number;
  withholding_minor?: number;
  item_level_discount_minor?: number;
  document_level_discount_minor?: number;
  tax_treatment?: string | null;
  place_of_supply_code?: string | null;
  seller_state_code?: string | null;
  tax_origin?: unknown;
  customer_tax_id?: unknown;
  period_start?: string | Date | null;
  period_end?: string | Date | null;
  created_at?: string | Date;
  lines?: Line[];
  discounts?: Discount[];
};

const CHARGE_KINDS = new Set(["recurring", "proration", "usage", "one_time"]);

const LINE_WHY: Record<string, string> = {
  recurring: "The plan or add-on charge for this billing period.",
  proration:
    "A charge or credit for part of a billing period, because the subscription changed during it.",
  usage: "Metered usage, rated by the price's model.",
  one_time: "A one-time charge.",
  discount: "A discount line.",
  tax: "Tax on the taxable lines.",
  rounding: "Rounding to the currency's smallest unit.",
};

const iso = (d: string | Date | null | undefined) =>
  d == null ? null : (d instanceof Date ? d : new Date(d)).toISOString();

const days = (a: string | Date | null | undefined, b: string | Date | null | undefined) =>
  a == null || b == null
    ? null
    : Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);

const sumKind = (lines: Line[], kind: string) =>
  lines.filter((l) => l.kind === kind).reduce((s, l) => s + l.amount_minor, 0);

export function explainLines(inv: InvoiceView) {
  const lines = inv.lines ?? [];
  const discounts = inv.discounts ?? [];
  return lines.map((l) => {
    const hitBy = discounts
      .filter((d) => d.line_item_ids.includes(l.id))
      .map((d) => ({ label: d.label, coupon_code: d.coupon_code, scope: d.scope }));
    return {
      id: l.id,
      description: l.description,
      kind: l.kind,
      why: l.adjustment
        ? `A true-up to the ${l.adjustment.replace(/_/g, " ")}.`
        : (LINE_WHY[l.kind] ?? null),
      price: l.price,
      quantity: l.quantity,
      amount_minor: l.amount_minor,
      period_start: iso(l.period_start),
      period_end: iso(l.period_end),
      period_days: days(l.period_start, l.period_end),
      discount_minor: l.discount_minor ?? 0,
      discounted_by: hitBy,
      ...(CHARGE_KINDS.has(l.kind)
        ? {
            tax_amount_minor: l.tax_amount_minor ?? null,
            untaxed_because: l.is_taxed === false ? (l.tax_exempt_reason ?? null) : null,
          }
        : {}),
    };
  });
}

/** Stored totals and the identity they must satisfy. `holds: false` is worth reporting. */
export function totalsLadder(inv: InvoiceView) {
  const lines = inv.lines ?? [];
  const itemLevel = inv.item_level_discount_minor ?? 0;
  const documentLevel = inv.document_level_discount_minor ?? 0;
  const tax = sumKind(lines, "tax");
  const rounding = sumKind(lines, "rounding");
  return {
    subtotal_minor: inv.subtotal_minor,
    item_level_discount_minor: itemLevel,
    document_level_discount_minor: documentLevel,
    tax_minor: tax,
    rounding_minor: rounding,
    total_minor: inv.total_minor,
    credits_applied_minor: inv.credits_applied_minor,
    amount_paid_minor: inv.amount_paid_minor,
    withholding_minor: inv.withholding_minor ?? 0,
    amount_due_minor: inv.amount_due_minor,
    identity: "total = subtotal − document-level discounts + tax + rounding",
    holds: inv.total_minor === inv.subtotal_minor - documentLevel + tax + rounding,
  };
}

type Bucket = {
  price: string | null;
  quantity: number;
  amount_minor: number;
  descriptions: string[];
};

function byPrice(inv: InvoiceView): Map<string, Bucket> {
  const out = new Map<string, Bucket>();
  for (const l of inv.lines ?? []) {
    if (!CHARGE_KINDS.has(l.kind)) continue;
    const key = `${l.kind}|${l.price ?? l.description}`;
    const b = out.get(key) ?? { price: l.price, quantity: 0, amount_minor: 0, descriptions: [] };
    b.quantity += l.quantity;
    b.amount_minor += l.amount_minor;
    if (!b.descriptions.includes(l.description)) b.descriptions.push(l.description);
    out.set(key, b);
  }
  return out;
}

/** What changed from `prev` to `cur`, by (kind, price). Sorted by size of change. */
export function compareInvoices(cur: InvoiceView, prev: InvoiceView) {
  const a = byPrice(prev);
  const b = byPrice(cur);
  const changes = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const before = a.get(key);
    const after = b.get(key);
    const delta = (after?.amount_minor ?? 0) - (before?.amount_minor ?? 0);
    if (before && after && delta === 0 && before.quantity === after.quantity) continue;
    const kind = key.slice(0, key.indexOf("|"));
    changes.push({
      kind,
      price: (after ?? before)!.price,
      description: (after ?? before)!.descriptions[0],
      change: !before ? "added" : !after ? "removed" : "changed",
      before: before ? { quantity: before.quantity, amount_minor: before.amount_minor } : null,
      after: after ? { quantity: after.quantity, amount_minor: after.amount_minor } : null,
      delta_minor: delta,
    });
  }
  changes.sort((x, y) => Math.abs(y.delta_minor) - Math.abs(x.delta_minor));
  const pl = totalsLadder(prev);
  const cl = totalsLadder(cur);
  return {
    previous_invoice: prev.id,
    previous_number: prev.number,
    previous_total_minor: prev.total_minor,
    total_delta_minor: cur.total_minor - prev.total_minor,
    discount_delta_minor:
      cl.item_level_discount_minor +
      cl.document_level_discount_minor -
      (pl.item_level_discount_minor + pl.document_level_discount_minor),
    tax_delta_minor: cl.tax_minor - pl.tax_minor,
    line_changes: changes,
  };
}

export function explainInvoice(cur: InvoiceView, prev: InvoiceView | null) {
  return {
    object: "invoice_explanation",
    invoice: cur.id,
    number: cur.number,
    status: cur.status,
    currency: cur.currency,
    period_start: iso(cur.period_start),
    period_end: iso(cur.period_end),
    totals: totalsLadder(cur),
    lines: explainLines(cur),
    discounts: (cur.discounts ?? []).map((d) => ({
      label: d.label,
      source: d.source,
      coupon_code: d.coupon_code,
      scope: d.scope,
      amount_minor: d.amount_minor,
      line_item_ids: d.line_item_ids,
    })),
    tax: {
      treatment: cur.tax_treatment ?? null,
      place_of_supply_code: cur.place_of_supply_code ?? null,
      seller_state_code: cur.seller_state_code ?? null,
      origin: cur.tax_origin ?? null,
      customer_tax_id: cur.customer_tax_id ?? null,
    },
    compared_to_previous: prev ? compareInvoices(cur, prev) : null,
  };
}

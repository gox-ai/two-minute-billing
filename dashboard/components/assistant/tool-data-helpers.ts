/** Pure text helpers for the assistant's record cards; no React, so unit tests reach them. */

import { canChargeMethod } from "../../lib/payment-method-status";

export const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const words = (s: string) => s.replace(/[._]/g, " ").trim();

export interface PaysWith {
  type?: unknown;
  brand?: unknown;
  status?: unknown;
}

/** "Pays with card" / "Pays with card (invalid)"; null when the payer has no method data. */
export function paysWithText(p: PaysWith | null | undefined): string | null {
  if (!p || typeof p.type !== "string" || !p.type) return null;
  const kind = words(p.type);
  const invalid = typeof p.status === "string" && !canChargeMethod(p.status);
  return `Pays with ${kind}${invalid ? " (invalid)" : ""}`;
}

/** The sentence a timeline row shows: its summary, else its readable type. */
export function timelineText(e: { summary?: unknown; type?: unknown; kind?: unknown }): string {
  const s = typeof e.summary === "string" ? e.summary.trim() : "";
  if (s) return s;
  const t =
    typeof e.type === "string" && e.type ? e.type : typeof e.kind === "string" ? e.kind : "";
  return t ? sentence(words(t)) : "Event";
}

/** "3 open disputes" / "1 open dispute". */
export const openDisputesText = (n: number) => `${n} open ${n === 1 ? "dispute" : "disputes"}`;

/** The by-payment-type split as one line: "Card 12 · PayPal 3 · No method 2". */
/** "Card 12 · PayPal 3", with the amount when the cell carries one: "PayPal 3 · $170.00". */
export function paymentSplitText(
  by: Record<string, unknown> | null | undefined,
  amount?: (minor: number) => string,
): string | null {
  if (!by) return null;
  const names: Record<string, string> = { card: "Card", paypal: "PayPal", none: "No method" };
  const parts = Object.entries(by)
    .map(([k, v]) => {
      const cell = v && typeof v === "object" ? (v as Record<string, unknown>) : { count: v };
      const n = typeof cell.count === "number" ? cell.count : 0;
      if (n <= 0) return null;
      const a =
        typeof cell.amount_minor === "number" && amount ? ` ${amount(cell.amount_minor)}` : "";
      return `${names[k] ?? sentence(words(k))} ${n}${a}`;
    })
    .filter((x): x is string => !!x);
  return parts.length ? parts.join(" · ") : null;
}

/** "name · $10.00 / month"; the interval part is left out for a one-time price. */
export function priceText(name: string | null, amount: string | null, interval: string | null) {
  return [name, amount ? (interval ? `${amount} / ${interval}` : amount) : null]
    .filter(Boolean)
    .join(" · ");
}

/** "sum_recurring_amount_minor" → "Recurring amount (sum)"; "count" → "Count". */
export function metricLabel(name: string): string {
  const m = /^(count_distinct|sum|avg|min|max)_(.+)$/.exec(name);
  if (!m) return name === "count" ? "Count" : sentence(words(name));
  const field = sentence(words(m[2]!.replace(/_minor$/, "")));
  const op = { count_distinct: "distinct", sum: "sum", avg: "average", min: "min", max: "max" }[
    m[1]!
  ];
  return `${field} (${op})`;
}

/** A group key as one line: "USD · paypal"; a missing part reads as "—". */
export function groupKeyText(key: Record<string, unknown>): string {
  return Object.values(key)
    .map((v) => (v === null || v === undefined || v === "" ? "—" : String(v)))
    .join(" · ");
}

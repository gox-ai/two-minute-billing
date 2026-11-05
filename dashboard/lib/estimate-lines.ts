/**
 * Estimate lines come off the wire as a DESCRIPTION STRING plus an amount
 * (`EstimateLine`, src/modules/subscriptions/estimate.ts) — there is no structured
 * price reference, unit count or unit price in the payload. Those strings are built
 * from the price's INTERNAL HANDLE, so the create-subscription estimate reads
 *
 *     flat (gs-business-v202506-INR-Monthly) ×1
 *
 * Leaking a catalog slug onto a confirmation screen an operator reads to a customer
 * is the defect this module closes, frontend-only.
 *
 * It invents nothing. It only
 *   1. substitutes a handle the loaded catalog actually knows for that price's
 *      display name, and
 *   2. reads back the `×N` the engine already wrote into the string.
 * Anything it cannot resolve is passed through byte-for-byte.
 *
 * The raw shapes it has to cope with (all from `estimate.ts`):
 *   `flat (<handle>) ×1`                        — estimateNewSubscription
 *   `Unused time on <handle> ×1`                — change, non-reset credit
 *   `Remaining time on <handle> ×1`             — change, non-reset charge
 *   `<handle> — prorated credit for unused time`— removal credit
 *   `<label> - Prorated Charges ×1`             — added item
 *   `<handle> ×1 (new term)`                    — term reset
 *   `<label> ×1`                                — in-trial / one-time
 * `<label>` is already `externalName ?? name ?? publicId` server-side, so it is
 * sometimes human and sometimes the handle — hence the handle substitution runs
 * over the whole string rather than a single anchored pattern.
 */

import type { Price, Product } from "@/lib/api";

const INTERVAL_LABEL: Record<string, string> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
  year: "yearly",
};

/** The name a customer-facing line should carry for a price: product name + cadence. */
export function priceDisplayName(
  priceId: string,
  priceById: Map<string, Price>,
  productById: Map<string, Product>,
): string {
  const price = priceById.get(priceId);
  if (!price) return priceId;
  const base = productById.get(price.product)?.name ?? price.external_name ?? price.name ?? priceId;
  return price.interval ? `${base} ${INTERVAL_LABEL[price.interval] ?? price.interval}` : base;
}

/** One estimate line, ready for `SummaryChargeLine`. */
export interface EstimateLineView {
  description: string;
  units: number | null;
  unitPriceMinor: number | null;
  amountMinor: number;
}

export interface EstimateLineFormatter {
  /** Human description, `×N` kept — for a breakdown table with no Units column. */
  describe(raw: string): string;
  /** Human description with `×N` lifted into its own `units` field. */
  view(line: { description: string; amount_minor: number }): EstimateLineView;
  /** The catalog price a RAW description refers to, when the handle is in it. */
  priceIdIn(raw: string): string | null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `flat (handle) …` — the model word is machinery, not something to show. */
const MODEL_PREFIX = /^[a-z_]+\s+\(([^)]+)\)/;
/** The engine writes the multiplier as a real `×`, never `x`. */
const UNITS = /\s*×\s*(\d+)/;

export function makeEstimateLineFormatter(
  priceById: Map<string, Price>,
  productById: Map<string, Product>,
): EstimateLineFormatter {
  const handles = [...priceById.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  // ONE pass over an alternation sorted longest-first: replacing handle by handle
  // could rewrite text a previous substitution had already produced, and a short
  // handle that is a prefix of a longer one would win. `null` when the catalog is
  // empty — `new RegExp('')` matches everywhere.
  const handleRe = handles.length > 0 ? new RegExp(handles.map(escapeRe).join("|"), "g") : null;

  const describe = (raw: string): string => {
    let out = raw;
    const wrapped = out.match(MODEL_PREFIX);
    if (wrapped && priceById.has(wrapped[1])) {
      out = out.slice(wrapped[0].length);
      out = `${priceDisplayName(wrapped[1], priceById, productById)}${out}`;
    }
    if (handleRe) out = out.replace(handleRe, (m) => priceDisplayName(m, priceById, productById));
    return out;
  };

  return {
    describe,
    // Longest-first so a handle that is a prefix of another cannot win.
    priceIdIn: (raw) => handles.find((h) => raw.includes(h)) ?? null,
    view: (line) => {
      const human = describe(line.description);
      const m = human.match(UNITS);
      const units = m ? Number(m[1]) : null;
      // Only divide when it divides EXACTLY. A prorated line is a fraction of a
      // term price, so amount ÷ units is usually not the catalog unit price — and
      // a rounded per-unit figure beside an exact total is a money lie.
      const unitPriceMinor =
        units != null && units > 0 && line.amount_minor % units === 0
          ? line.amount_minor / units
          : null;
      return {
        // The `×N` becomes the Units column, so leaving it in the text repeats it.
        description: units != null ? human.replace(UNITS, "").trim() : human,
        units,
        unitPriceMinor,
        amountMinor: line.amount_minor,
      };
    },
  };
}

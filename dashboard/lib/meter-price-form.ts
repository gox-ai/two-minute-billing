// Reads the meter-price fields that `MeterRateCard` posts, for the price create and edit
// actions. Plain module (no "use server"), so the actions can import it.
import { MAX_USAGE_DECIMALS, decimalPlaces } from "./meters";
import { isListSource } from "./model-prices";

const DECIMAL = /^\d+(?:\.\d+)?$/;
const AMOUNT_SOURCES = [
  "rate",
  "event_amount",
  "event_cost",
  "model_price_list",
  "event_cost_or_list",
] as const;
const PERCENT = /^\d+(?:\.\d{1,6})?$/;

export type MeterPriceFields =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; field: string; message: string };

/**
 * The API body for a meter price, or a field error. `null` when the form posted no meter
 * fields (an ordinary price). On create the meter is sent; on edit it is fixed.
 */
export function meterPriceFields(fd: FormData, mode: "create" | "edit"): MeterPriceFields | null {
  if (fd.get("meter_present") !== "1") return null;
  const meter = String(fd.get("meter") ?? "").trim();
  if (mode === "create" && !meter) return null;
  // On edit the field is locked and posts the stored value; a missing one is never read as "rate".
  const posted = fd.get("amount_source");
  const source = posted == null && mode === "create" ? "rate" : String(posted ?? "");
  if (!(AMOUNT_SOURCES as readonly string[]).includes(source))
    return {
      ok: false,
      field: "amount_source",
      message:
        mode === "create"
          ? "Select how we calculate the amount."
          : "We could not read how this price calculates the amount. Reload the page.",
    };

  // The meter, amount source and divisor are fixed after create: the API refuses them on edit.
  const body: Record<string, unknown> = mode === "create" ? { meter, amount_source: source } : {};

  // Edit posts no amount_source (it is fixed); the form tells us the source it shows.
  const listMode = isListSource(source);
  if (listMode) {
    const markup = String(fd.get("markup_percent") ?? "").trim() || "0";
    if (!PERCENT.test(markup))
      return {
        ok: false,
        field: "markup_percent",
        message: "Enter the markup as a percent, 0 or more, with no more than 6 decimal places.",
      };
    body.markup_percent = markup;
    body.markup_base = fd.get("markup_base") === "cost" ? "cost" : "list";
  }
  if (source === "rate" || listMode) {
    const rate = String(fd.get("unit_amount_decimal") ?? "").trim();
    if (!DECIMAL.test(rate) || (decimalPlaces(rate) ?? 99) > MAX_USAGE_DECIMALS)
      return {
        ok: false,
        field: "unit_amount_decimal",
        message:
          "Enter the default rate as a number. Use no more than 12 decimal places in minor units.",
      };
    const divisor = String(fd.get("quantity_divisor") ?? "1").trim();
    if (!/^[1-9]\d{0,14}$/.test(divisor))
      return {
        ok: false,
        field: "quantity_divisor",
        message: "Enter a whole number of units, 1 or more.",
      };
    let rates: Array<{
      match: Record<string, string>;
      unit_amount_decimal?: string;
      markup_percent?: string;
    }>;
    try {
      rates = JSON.parse(String(fd.get("rates") ?? "[]"));
    } catch {
      return {
        ok: false,
        field: "rates",
        message: "We could not read the rate card. Reload the page.",
      };
    }
    for (const r of rates) {
      if (!Object.keys(r.match ?? {}).length)
        return {
          ok: false,
          field: "rates",
          message:
            "Each rate needs at least one group value. The default rate applies to all others.",
        };
      if (listMode && r.markup_percent !== undefined) {
        if (!PERCENT.test(r.markup_percent))
          return {
            ok: false,
            field: "rates",
            message:
              "Enter a markup for each row, as a percent with no more than 6 decimal places.",
          };
        continue;
      }
      if (
        !DECIMAL.test(r.unit_amount_decimal ?? "") ||
        (decimalPlaces(r.unit_amount_decimal ?? "") ?? 99) > MAX_USAGE_DECIMALS
      )
        return {
          ok: false,
          field: "rates",
          message: "Enter a rate for each row of the rate card.",
        };
    }
    const seen = new Set(rates.map((r) => JSON.stringify(Object.entries(r.match).sort())));
    if (seen.size !== rates.length)
      return {
        ok: false,
        field: "rates",
        message: "Two rows have the same group values. Remove one.",
      };
    body.unit_amount_decimal = rate;
    if (mode === "create") body.quantity_divisor = divisor;
    body.rates = rates;
  } else if (source === "event_cost") {
    const markup = String(fd.get("markup_percent") ?? "").trim() || "0";
    if (!DECIMAL.test(markup) || (decimalPlaces(markup) ?? 99) > 6)
      return {
        ok: false,
        field: "markup_percent",
        message: "Enter the markup as a percent, 0 or more, with no more than 6 decimal places.",
      };
    body.markup_percent = markup;
  }
  return { ok: true, body };
}

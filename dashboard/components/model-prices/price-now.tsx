"use client";

import * as React from "react";
import { priceNowAction } from "@/app/(dashboard)/settings/model-prices/actions";
import type { ModelPriceListRow } from "@/lib/api/model-prices";
import type { MeterPriceList } from "@/lib/api/meters";
import { formatListPrice } from "@/lib/model-prices";

/** The list key of a rate-card row: the model and token type its `match` (or the meter) names. */
export function rowListKey(
  map: MeterPriceList | null | undefined,
  match: Record<string, string>,
): { provider: string | null; model: string; token_type: string } | null {
  if (!map) return null;
  const model = match[map.model_key || "model"]?.trim();
  const tokenType = (
    map.token_type ?? (map.token_type_key ? match[map.token_type_key] : "")
  )?.trim();
  const provider = map.provider ?? (map.provider_key ? match[map.provider_key]?.trim() : null);
  if (!model || !tokenType) return null;
  return { provider: provider || null, model, token_type: tokenType };
}

/** base × (1 + markup ÷ 100), as a decimal string for display only. */
function marked(base: string, markup: string): string {
  const v = Number(base) * (1 + (Number(markup) || 0) / 100);
  return Number.isFinite(v) ? v.toFixed(12).replace(/\.?0+$/, "") : base;
}

/**
 * Read-only "Price now" for one model row (design G1b § 3.4): a fixed rate as entered; else the
 * markup over the base. `list` falls back to your cost when the list has no row; `cost` uses your
 * cost, else the list. A base in another currency does not count: we never convert a list price.
 * This is a preview; the invoice resolves the price at each usage instant.
 */
export function PriceNow({
  listKey,
  fixedMinor,
  markup,
  base,
  currency,
}: {
  listKey: { provider: string | null; model: string; token_type: string } | null;
  /** A fixed rate in minor units per its own divisor; set → no lookup. */
  fixedMinor?: { minor: string; divisor: string } | null;
  markup: string;
  base: "list" | "cost";
  currency: string;
}) {
  const [loaded, setLoaded] = React.useState<{ key: string; row: ModelPriceListRow | null }>({
    key: "",
    row: null,
  });
  const k = listKey ? `${listKey.provider ?? ""}|${listKey.model}|${listKey.token_type}` : "";
  const hasFixed = !!fixedMinor;
  const row = loaded.key === k ? loaded.row : "loading";

  React.useEffect(() => {
    if (!k || hasFixed) return;
    const [provider, model, token_type] = k.split("|");
    let live = true;
    const t = setTimeout(() => {
      priceNowAction({ provider: provider || null, model, token_type }).then(
        (r) => live && setLoaded({ key: k, row: r }),
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [k, hasFixed]);

  if (fixedMinor)
    return <span>{formatListPrice(fixedMinor.minor, currency, fixedMinor.divisor)}</span>;
  if (!listKey) return <span className="text-muted-foreground">—</span>;
  if (row === "loading") return <span className="text-muted-foreground">…</span>;

  const cur = currency.toUpperCase();
  const list = row && row.currency.toUpperCase() === cur ? row : null;
  const cost = row?.cost && row.cost.currency.toUpperCase() === cur ? row.cost : null;
  const b = base === "cost" ? (cost ?? list) : (list ?? cost);
  if (!b) return <span className="text-muted-foreground">Default rate</span>;
  return (
    <span title={b === cost ? "Your cost plus the markup" : "List price plus the markup"}>
      {formatListPrice(marked(b.unit_amount_decimal, markup), currency, b.quantity_divisor)}
    </span>
  );
}

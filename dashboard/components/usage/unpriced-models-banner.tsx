"use client";

import * as React from "react";
import { Alert } from "@/components/ui/alert";
import { SetCostDialog } from "@/components/model-prices/model-price-actions";
import { PriceType } from "@/components/model-prices/tier-text";

/** A model billed at the default rate. `token_type` null: the meter does not name one. */
export interface UnpricedKey {
  provider: string | null;
  model: string;
  token_type: string | null;
  /** Null: the meter names no unit (tokens, else requests). */
  unit?: string | null;
  quality?: string | null;
  resolution?: string | null;
}

/** "2 models have no price…" with Set your cost for each (`model_prices:manage`). */
export function UnpricedModelsBanner({
  keys,
  canManage,
  currencies,
  currency,
}: {
  keys: UnpricedKey[];
  canManage: boolean;
  currencies: string[];
  /** The currency the usage bills in; the cost dialog starts there. */
  currency: string;
}) {
  const [open, setOpen] = React.useState<UnpricedKey | null>(null);
  if (!keys.length) return null;
  const n = new Set(keys.map((k) => k.model)).size;
  return (
    <>
      <Alert
        tone="warning"
        title={`We bill ${n} ${n === 1 ? "model" : "models"} at the default rate, because ${n === 1 ? "it has" : "they have"} no price.`}
      >
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {keys.map((k) => (
            <li
              key={`${k.provider} ${k.model} ${k.token_type} ${k.unit ?? ""} ${k.quality ?? ""} ${k.resolution ?? ""}`}
              className="flex items-center gap-2"
            >
              <span>
                <span className="font-mono">{k.model}</span>
                {k.token_type ? (
                  <>
                    {" · "}
                    <PriceType r={{ ...k, token_type: k.token_type }} />
                  </>
                ) : null}
              </span>
              {canManage ? (
                <button
                  type="button"
                  className="text-sm font-medium text-primary hover:underline"
                  onClick={() => setOpen(k)}
                >
                  Set your cost
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </Alert>
      {open ? (
        <SetCostDialog
          open
          onOpenChange={(o) => (o ? null : setOpen(null))}
          modelKey={
            open.token_type
              ? {
                  provider: open.provider,
                  model: open.model,
                  token_type: open.token_type,
                  unit: open.unit ?? "token",
                  quality: open.quality ?? null,
                  resolution: open.resolution ?? null,
                }
              : null
          }
          defaultModel={open.model}
          currencies={currencies}
          defaultCurrency={currency}
        />
      ) : null}
    </>
  );
}

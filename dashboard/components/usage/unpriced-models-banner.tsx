"use client";

import * as React from "react";
import { Alert } from "@/components/ui/alert";
import { SetCostDialog } from "@/components/model-prices/model-price-actions";
import { tokenTypeLabel } from "@/lib/model-prices";

/** A model billed at the default rate. `token_type` null: the meter does not name one. */
export interface UnpricedKey {
  provider: string | null;
  model: string;
  token_type: string | null;
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
        title={`${n} ${n === 1 ? "model has" : "models have"} no price. We bill ${n === 1 ? "it" : "them"} at the default rate.`}
      >
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {keys.map((k) => (
            <li
              key={`${k.provider} ${k.model} ${k.token_type}`}
              className="flex items-center gap-2"
            >
              <span>
                <span className="font-mono">{k.model}</span>
                {k.token_type ? ` · ${tokenTypeLabel(k.token_type)}` : ""}
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
              ? { provider: open.provider, model: open.model, token_type: open.token_type }
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

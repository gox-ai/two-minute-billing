"use client";

import * as React from "react";
import { toast } from "sonner";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { Alert } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  deleteCostAction,
  endCostAction,
  modelPriceHistoryAction,
  setCostAction,
} from "@/app/(dashboard)/settings/model-prices/actions";
import type { ModelCostOverride, ModelPriceHistory } from "@/lib/api/model-prices";
import { COST_DIVISORS, formatListPrice, tokenTypeLabel } from "@/lib/model-prices";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { tzLabel } from "@/lib/tz";
import { useDisplayTz } from "@/components/business-tz";
import { DateTimeField } from "@/components/form/datetime-field";

/** A model key. `fixed` = the dialog opened from a row, so the key is not editable. */
export interface ModelKey {
  provider: string | null;
  model: string;
  token_type: string;
}

/**
 * Cost rows belong to the organization, so their times are entered and shown in one zone: the
 * business's inside a business, else the organization's (UTC when unset). Posts UTC; empty
 * posts nothing (the API then uses now).
 */
function InstantInput({ name }: { name: string }) {
  const tz = useDisplayTz();
  return <DateTimeField id={name} name={name} tz={tz} className="w-60" />;
}

/** Set your cost → `POST /v1/organization/model_cost_overrides`. */
export function SetCostDialog({
  open,
  onOpenChange,
  modelKey,
  currencies,
  defaultCurrency = "USD",
  defaultModel,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Null: the operator types the model and token type (a model the list does not have). */
  modelKey: ModelKey | null;
  /** The currencies the organization bills in. */
  currencies: string[];
  defaultCurrency?: string;
  /** Free entry: the model to start with (an unpriced model from usage). */
  defaultModel?: string;
}) {
  const options = Array.from(new Set(["USD", ...currencies.map((c) => c.toUpperCase())])).sort();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Set your cost</DialogTitle>
          <DialogDescription>
            The price that the provider charges you. We use it for cost and margin, and as the
            markup base of a price that bills on your cost. The price list sync does not change it.
          </DialogDescription>
        </DialogHeader>
        <ActionForm
          action={setCostAction}
          onSuccess={() => onOpenChange(false)}
          className="space-y-3"
        >
          {modelKey ? (
            <>
              <input type="hidden" name="provider" value={modelKey.provider ?? ""} />
              <input type="hidden" name="model" value={modelKey.model} />
              <input type="hidden" name="token_type" value={modelKey.token_type} />
              <p className="text-sm">
                <span className="font-mono">{modelKey.model}</span>
                {modelKey.provider ? (
                  <span className="text-muted-foreground"> · {modelKey.provider}</span>
                ) : null}{" "}
                · {tokenTypeLabel(modelKey.token_type)}
              </p>
            </>
          ) : (
            <>
              <Field
                name="model"
                label="Model"
                required
                help="The model value that your usage events send."
              >
                <Input
                  name="model"
                  required
                  maxLength={200}
                  defaultValue={defaultModel}
                  className="font-mono"
                />
              </Field>
              <Field
                name="token_type"
                label="Token type"
                required
                help="For example input, output or cache_read."
              >
                <Input name="token_type" required maxLength={100} className="font-mono" />
              </Field>
              <Field
                name="provider"
                label="Provider"
                help="Optional. Leave empty to use this cost for the model under each provider."
              >
                <Input name="provider" maxLength={100} className="font-mono" />
              </Field>
            </>
          )}
          <div className="flex flex-wrap gap-3">
            <Field name="cost" label="Cost" required className="min-w-0 flex-[1_1_10rem]">
              <Input name="cost" required inputMode="decimal" className="tabular-nums" />
            </Field>
            <Field name="quantity_divisor" label="Per" className="w-36">
              <SelectField
                name="quantity_divisor"
                defaultValue="1000000"
                ariaLabel="Per"
                options={COST_DIVISORS.map((d) => ({ value: d.value, label: d.label }))}
              />
            </Field>
            <Field name="currency" label="Currency" className="w-32">
              <SelectField
                name="currency"
                defaultValue={
                  options.includes(defaultCurrency.toUpperCase())
                    ? defaultCurrency.toUpperCase()
                    : "USD"
                }
                ariaLabel="Currency"
                options={options.map((c) => ({ value: c, label: c }))}
              />
            </Field>
          </div>
          <Field name="effective_from" label="Starts" help="Leave empty to start now.">
            <InstantInput name="effective_from" />
          </Field>
          <Field name="note" label="Note" help="Optional. For example, the contract name.">
            <Input name="note" maxLength={500} />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <SubmitButton>Save</SubmitButton>
          </div>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

/** End your cost → `POST …/model_cost_overrides/:id/end`. */
export function EndCostDialog({
  open,
  onOpenChange,
  cost,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  cost: ModelCostOverride;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>End your cost</DialogTitle>
          <DialogDescription>
            After the end, cost and margin for {cost.model} use the list price. A price that bills
            on your cost uses the list price too.
          </DialogDescription>
        </DialogHeader>
        <ActionForm
          action={endCostAction}
          onSuccess={() => onOpenChange(false)}
          className="space-y-3"
        >
          <input type="hidden" name="id" value={cost.id} />
          <Field name="effective_to" label="Ends" help="Leave empty to end it now.">
            <InstantInput name="effective_to" />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <SubmitButton>End cost</SubmitButton>
          </div>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

/** View history: dated list rows (both dates) and cost rows for one model. */
export function PriceHistorySheet({
  open,
  onOpenChange,
  modelKey,
  canManage,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  modelKey: ModelKey;
  canManage: boolean;
}) {
  type Loaded =
    | { status: "error"; message: string; nonce: number }
    | { status: "ok"; data: ModelPriceHistory; nonce: number };
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [toDelete, setToDelete] = React.useState<ModelCostOverride | null>(null);
  const [nonce, setNonce] = React.useState(0);
  const [now] = React.useState(() => Date.now());
  const tz = useDisplayTz();
  const zone = tzLabel(tz);
  const state = loaded && loaded.nonce === nonce ? loaded : ({ status: "loading" } as const);

  React.useEffect(() => {
    if (!open) return;
    let live = true;
    modelPriceHistoryAction(modelKey).then((r) => {
      if (!live) return;
      setLoaded(
        r.ok
          ? { status: "ok", data: r.data, nonce }
          : { status: "error", message: r.message, nonce },
      );
    });
    return () => {
      live = false;
    };
  }, [open, modelKey, nonce]);

  const prices = state.status === "ok" ? state.data.prices : [];
  const costs = state.status === "ok" ? state.data.costs : [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl">
        <SheetHeader className="pr-12">
          <SheetTitle>Price history</SheetTitle>
          <SheetDescription>
            <span className="font-mono">{modelKey.model}</span>
            {modelKey.provider ? ` · ${modelKey.provider}` : ""} ·{" "}
            {tokenTypeLabel(modelKey.token_type)}
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-6 text-sm">
          {state.status === "loading" ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : state.status === "error" ? (
            <Alert tone="error">{state.message}</Alert>
          ) : (
            <>
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">List price</h3>
                {prices.length === 0 ? (
                  <p className="text-muted-foreground">The price list has no price for it.</p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border bg-card">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40 text-xs text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">Price</th>
                          <th className="px-3 py-2 text-left font-medium">Source date</th>
                          <th className="px-3 py-2 text-left font-medium">Applies from ({zone})</th>
                          <th className="px-3 py-2 text-left font-medium">Version</th>
                        </tr>
                      </thead>
                      <tbody>
                        {prices.map((p) => (
                          <tr key={p.id} className="border-t">
                            <td className="px-3 py-2 tabular-nums">
                              {formatListPrice(
                                p.unit_amount_decimal,
                                p.currency,
                                p.quantity_divisor,
                              )}
                              <div className="font-mono text-xs text-muted-foreground">{p.id}</div>
                            </td>
                            <td className="px-3 py-2">
                              {p.source_effective_from
                                ? fmtDate(p.source_effective_from, "UTC")
                                : "—"}
                            </td>
                            <td className="px-3 py-2">
                              {p.effective_from
                                ? fmtDateTime(p.effective_from, tz)
                                : "Before we tracked it"}
                            </td>
                            <td className="px-3 py-2 font-mono text-xs">
                              {p.source_version ?? "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Source date is the date the source gives. Applies from is when we started to bill
                  with the price. Usage before that time keeps the earlier price.
                </p>
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Your cost</h3>
                {costs.length === 0 ? (
                  <p className="text-muted-foreground">You did not set a cost for this model.</p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border bg-card">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40 text-xs text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">Cost</th>
                          <th className="px-3 py-2 text-left font-medium">Starts ({zone})</th>
                          <th className="px-3 py-2 text-left font-medium">Ends ({zone})</th>
                          <th className="px-3 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {costs.map((c) => {
                          const notStarted = Date.parse(c.effective_from) > now;
                          return (
                            <tr key={c.id} className="border-t align-top">
                              <td className="px-3 py-2 tabular-nums">
                                {formatListPrice(
                                  c.unit_amount_decimal,
                                  c.currency,
                                  c.quantity_divisor,
                                )}
                                {c.note ? (
                                  <div className="text-xs text-muted-foreground">{c.note}</div>
                                ) : null}
                              </td>
                              <td className="px-3 py-2">{fmtDateTime(c.effective_from, tz)}</td>
                              <td className="px-3 py-2">
                                {c.effective_to ? fmtDateTime(c.effective_to, tz) : "No end"}
                              </td>
                              <td className="px-3 py-2 text-right">
                                {canManage && notStarted ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="text-destructive"
                                    onClick={() => setToDelete(c)}
                                  >
                                    Delete
                                  </Button>
                                ) : null}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
        {toDelete ? (
          <ConfirmDialog
            open
            onOpenChange={(o) => (o ? null : setToDelete(null))}
            title="Delete this cost?"
            description="The cost has not started, so no invoice uses it. You cannot undo this."
            confirmLabel="Delete cost"
            destructive
            onConfirm={async () => {
              const r = await deleteCostAction(toDelete.id);
              if (r.ok) toast.success(r.message ?? "Cost deleted.");
              else toast.error(r.message ?? "We could not delete the cost.");
              setToDelete(null);
              setNonce((n) => n + 1);
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

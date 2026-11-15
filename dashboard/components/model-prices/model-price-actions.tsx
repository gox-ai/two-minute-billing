"use client";

import * as React from "react";
import { toast } from "sonner";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { KeptInput } from "@/components/form/kept-input";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { Alert } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import {
  COST_DIVISORS_BY_UNIT,
  PRICE_UNITS,
  costRowActions,
  costTierFields,
  defaultCostDivisor,
  formatListPrice,
  listFeedName,
  perUnitLabel,
  shortVersion,
} from "@/lib/model-prices";
import { providerName } from "@/lib/model-providers";
import { Capped, PriceType, Tier, TierText } from "@/components/model-prices/tier-text";
import { MiddleEllipsis } from "@/components/patterns/id-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtDate, fmtDateTime } from "@/lib/format-date";
import { tzLabel } from "@/lib/tz";
import { useDefaultState } from "@/lib/use-default-state";
import { useDisplayTz } from "@/components/business-tz";
import { DateTimeField } from "@/components/form/datetime-field";

/** A model key. `fixed` = the dialog opened from a row, so the key is not editable. */
export interface ModelKey {
  provider: string | null;
  model: string;
  token_type: string;
  /** Absent = tokens. */
  unit?: string | null;
  quality?: string | null;
  resolution?: string | null;
}

/** "gpt-x · openai · Output · hd", with the unit when it is not tokens. */
function KeyLine({ k }: { k: ModelKey }) {
  const unit = PRICE_UNITS.find((u) => u.value === (k.unit ?? "token"));
  return (
    <>
      <span className="font-mono">{k.model}</span>
      {k.provider ? (
        <span className="text-muted-foreground"> · {providerName(k.provider)}</span>
      ) : null}{" "}
      · <PriceType r={k} />
      {unit && unit.value !== "token" ? ` · ${unit.label}` : ""}
    </>
  );
}

/**
 * Cost rows belong to the organization, so their times are entered and shown in one zone: the
 * business's inside a business, else the organization's (UTC when unset). Posts UTC; empty
 * posts nothing (the API then uses now).
 */
function InstantInput({ name }: { name: string }) {
  const tz = useDisplayTz();
  return <DateTimeField id={name} name={name} tz={tz} className="w-60" hideZoneHint />;
}

/** The zone line `DateTimeField` would print, folded into the field's one help line. */
function useZoneText(): string {
  const tz = useDisplayTz();
  const name = tz || "UTC";
  const offset = tzLabel(tz);
  return `Time zone: ${name}${offset !== name ? ` (${offset})` : ""}.`;
}

/** "Per" is the field's label, so the options name the quantity: "1M tokens", "hour of audio". */
const perOptions = (unit: string) =>
  (COST_DIVISORS_BY_UNIT[unit] ?? COST_DIVISORS_BY_UNIT.token!).map((d) => ({
    value: d,
    label: perUnitLabel(unit, d).replace(/^per /, ""),
  }));

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
  const zoneText = useZoneText();
  // A row's key fixes its unit; free entry picks one, and "Per" follows it.
  // Follows the row the dialog is opened for.
  const [unit, setUnit] = useDefaultState(modelKey?.unit ?? "token");
  const per = perOptions(unit);
  // A row opened with a tier keeps its tier fields, so the new cost has the same key.
  const tiers = costTierFields(unit, modelKey);
  // Held in state: React resets the form after a failed submit, and a select would go back
  // to its default.
  const [divisor, setDivisor] = useDefaultState(defaultCostDivisor(unit));
  const [currency, setCurrency] = React.useState(
    options.includes(defaultCurrency.toUpperCase()) ? defaultCurrency.toUpperCase() : "USD",
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" className="flex max-h-[85vh] flex-col overflow-hidden">
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
          className="flex min-h-0 flex-1 flex-col gap-3"
        >
          {/* The fields scroll; the title and the buttons stay in view. */}
          <div className="-mx-6 min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-0.5">
            {modelKey ? (
              <>
                <input type="hidden" name="provider" value={modelKey.provider ?? ""} />
                <input type="hidden" name="model" value={modelKey.model} />
                <input type="hidden" name="token_type" value={modelKey.token_type} />
                <input type="hidden" name="unit" value={unit} />
                <p className="text-sm">
                  <KeyLine k={{ ...modelKey, quality: null, resolution: null }} />
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
                  <KeptInput
                    name="model"
                    required
                    maxLength={200}
                    defaultValue={defaultModel}
                    className="font-mono"
                  />
                </Field>
                <Field
                  name="token_type"
                  label="Price type"
                  required
                  help={
                    <>
                      For example <TierText>input</TierText>, <TierText>output</TierText> or{" "}
                      <TierText>cache_read</TierText>.
                    </>
                  }
                >
                  <KeptInput name="token_type" required maxLength={100} className="font-mono" />
                </Field>
                <Field name="unit" label="Unit" className="w-72 max-w-full">
                  <SelectField
                    name="unit"
                    value={unit}
                    onValueChange={(u) => {
                      setUnit(u);
                      setDivisor(defaultCostDivisor(u));
                    }}
                    ariaLabel="Unit"
                    options={PRICE_UNITS.map((u) => ({ value: u.value, label: u.label }))}
                  />
                </Field>
                <Field
                  name="provider"
                  label="Provider"
                  help="Optional. Leave empty to use this cost for the model under each provider."
                >
                  <KeptInput name="provider" maxLength={100} className="font-mono" />
                </Field>
              </>
            )}
            {tiers.quality || tiers.resolution ? (
              <div className="flex flex-wrap gap-3">
                {tiers.quality ? (
                  <Field
                    name="quality"
                    label="Quality"
                    className="min-w-0 flex-[1_1_10rem]"
                    help={
                      <>
                        Optional. For example <TierText>hd</TierText>.
                      </>
                    }
                  >
                    <KeptInput
                      name="quality"
                      maxLength={40}
                      defaultValue={modelKey?.quality ?? ""}
                      className="font-mono"
                    />
                  </Field>
                ) : null}
                {tiers.resolution ? (
                  <Field
                    name="resolution"
                    label="Resolution"
                    className="min-w-0 flex-[1_1_10rem]"
                    help={
                      <>
                        Optional. For example <TierText>1024x1024</TierText>.
                      </>
                    }
                  >
                    <KeptInput
                      name="resolution"
                      maxLength={40}
                      defaultValue={modelKey?.resolution ?? ""}
                      className="font-mono"
                    />
                  </Field>
                ) : null}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-3">
              <Field name="cost" label="Cost" required className="w-30">
                <KeptInput name="cost" required inputMode="decimal" className="tabular-nums" />
              </Field>
              <Field name="quantity_divisor" label="Per" className="min-w-30 flex-1">
                {/* Keyed by unit: the options change with it, and the select would keep none. */}
                <SelectField
                  key={unit}
                  name="quantity_divisor"
                  value={divisor}
                  onValueChange={(d) => (d ? setDivisor(d) : undefined)}
                  ariaLabel="Per"
                  options={per}
                />
              </Field>
              <Field name="currency" label="Currency" className="w-30">
                <SelectField
                  name="currency"
                  value={currency}
                  onValueChange={setCurrency}
                  ariaLabel="Currency"
                  options={options.map((c) => ({ value: c, label: c }))}
                />
              </Field>
            </div>
            <Field
              name="effective_from"
              label="Starts"
              help={`${zoneText} Leave empty to start now.`}
            >
              <InstantInput name="effective_from" />
            </Field>
            <Field name="note" label="Note" help="Optional. For example, the contract name.">
              <KeptInput name="note" maxLength={500} />
            </Field>
          </div>
          <DialogFooter className="pt-1">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <SubmitButton>Save cost</SubmitButton>
          </DialogFooter>
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
  const zoneText = useZoneText();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>End your cost</DialogTitle>
          <DialogDescription>
            After the end, cost and margin for {cost.model} use the list price, if the list has one.
            A price that bills on your cost uses the list price too.
          </DialogDescription>
        </DialogHeader>
        <ActionForm
          action={endCostAction}
          onSuccess={() => onOpenChange(false)}
          className="space-y-3"
        >
          <input type="hidden" name="id" value={cost.id} />
          <Field name="effective_to" label="Ends" help={`${zoneText} Leave empty to end it now.`}>
            <InstantInput name="effective_to" />
          </Field>
          <DialogFooter className="pt-1">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <SubmitButton>End cost</SubmitButton>
          </DialogFooter>
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
    | { status: "ok"; data: ModelPriceHistory; nonce: number; at: number };
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [toDelete, setToDelete] = React.useState<ModelCostOverride | null>(null);
  const [toEnd, setToEnd] = React.useState<ModelCostOverride | null>(null);
  const [nonce, setNonce] = React.useState(0);
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
          ? { status: "ok", data: r.data, nonce, at: r.at }
          : { status: "error", message: r.message, nonce },
      );
    });
    return () => {
      live = false;
    };
  }, [open, modelKey, nonce]);

  const prices = state.status === "ok" ? state.data.prices : [];
  const costs = state.status === "ok" ? state.data.costs : [];
  // Per load, so a cost that was ended a moment ago reads as ended.
  const now = state.status === "ok" ? state.at : 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl">
        <SheetHeader className="pr-12">
          <SheetTitle>Price history</SheetTitle>
          <SheetDescription>
            <KeyLine k={modelKey} />
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
                  <p className="text-muted-foreground">
                    The price list has no price for this model.
                  </p>
                ) : (
                  <>
                    {/* Widths in the 638px sheet body: 184 + 108 + 174 + 109 = 575. */}
                    <div className="overflow-hidden rounded-xl border bg-card">
                      <Table phone="stack" className="[--phone-row-x:0.75rem]">
                        <TableHeader>
                          <TableRow>
                            <TableHead>Price</TableHead>
                            <TableHead>Source date</TableHead>
                            <TableHead>Applies from ({zone})</TableHead>
                            <TableHead>Source</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {prices.map((p) => (
                            <TableRow key={p.id}>
                              <TableCell className="py-2">
                                {formatListPrice(
                                  p.unit_amount_decimal,
                                  p.currency,
                                  p.quantity_divisor,
                                  p.unit ?? "token",
                                )}
                                {p.quality || p.resolution ? (
                                  <Capped
                                    className="max-w-40 text-xs text-muted-foreground"
                                    text={<Tier quality={p.quality} resolution={p.resolution} />}
                                  />
                                ) : null}
                                {/* The id an invoice line cites; capped, so it sets no width. */}
                                <div className="max-w-40 text-muted-foreground">
                                  <MiddleEllipsis value={p.id} className="text-xs" />
                                </div>
                              </TableCell>
                              <TableCell className="py-2">
                                {p.source_effective_from
                                  ? fmtDate(p.source_effective_from, "UTC")
                                  : "—"}
                              </TableCell>
                              <TableCell className="py-2">
                                {p.effective_from
                                  ? fmtDateTime(p.effective_from, tz)
                                  : "Before we tracked it"}
                              </TableCell>
                              <TableCell className="py-2">
                                {listFeedName(p.source)}
                                {p.source_version ? (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <div className="w-fit font-mono text-xs text-muted-foreground">
                                        {shortVersion(p.source_version)}
                                      </div>
                                    </TooltipTrigger>
                                    <TooltipContent className="font-mono text-xs break-all">
                                      {p.source_version}
                                    </TooltipContent>
                                  </Tooltip>
                                ) : null}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Source date is the date the source gives. Applies from is when we started to
                      bill with the price. Usage before that time keeps the earlier price.
                    </p>
                  </>
                )}
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Your cost</h3>
                {costs.length === 0 ? (
                  <p className="text-muted-foreground">You did not set a cost for this model.</p>
                ) : (
                  // Widths in the 638px sheet body: 216 + 161 + 161 + 86 = 624.
                  <div className="overflow-hidden rounded-xl border bg-card">
                    <Table phone="stack" className="[--phone-row-x:0.75rem]">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Cost</TableHead>
                          <TableHead>Starts ({zone})</TableHead>
                          <TableHead>Ends ({zone})</TableHead>
                          <TableHead />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {costs.map((c) => {
                          const can = costRowActions(c, now);
                          return (
                            <TableRow key={c.id}>
                              <TableCell className="py-2">
                                {formatListPrice(
                                  c.unit_amount_decimal,
                                  c.currency,
                                  c.quantity_divisor,
                                  c.unit ?? "token",
                                )}
                                {c.quality || c.resolution ? (
                                  <Capped
                                    className="max-w-48 text-xs text-muted-foreground"
                                    text={<Tier quality={c.quality} resolution={c.resolution} />}
                                  />
                                ) : null}
                                {c.note ? (
                                  <Capped
                                    className="max-w-48 text-xs text-muted-foreground"
                                    text={c.note}
                                  />
                                ) : null}
                              </TableCell>
                              <TableCell className="py-2">
                                {fmtDateTime(c.effective_from, tz)}
                              </TableCell>
                              <TableCell className="py-2">
                                {c.effective_to ? fmtDateTime(c.effective_to, tz) : "No end"}
                              </TableCell>
                              <TableCell className="py-2 text-right">
                                {canManage && can.canDelete ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="text-destructive"
                                    onClick={() => setToDelete(c)}
                                  >
                                    Delete
                                  </Button>
                                ) : canManage && can.canEnd ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setToEnd(c)}
                                  >
                                    End
                                  </Button>
                                ) : null}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
        {toEnd ? (
          <EndCostDialog
            open
            cost={toEnd}
            onOpenChange={(o) => {
              if (o) return;
              setToEnd(null);
              setNonce((n) => n + 1);
            }}
          />
        ) : null}
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

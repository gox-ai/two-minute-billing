"use client";

// The directive is load-bearing: the dialogs below hold React state and the row list
// renders them, so the whole module must sit in the client graph even though its only
// consumer is a server page.

import * as React from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/patterns/chip";
import { RadioField } from "@/components/ui/radio-group";
import { Alert } from "@/components/ui/alert";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CurrencySelect } from "@/components/form/currency-select";
import { SettingsCard } from "@/components/settings/settings-layout";
import type { CurrencyRate } from "@/lib/api";
import {
  saveCurrencyRateAction,
  saveBaseCurrencyAction,
  removeCurrencyAction,
} from "@/app/(dashboard)/businesses/[biz]/settings/actions";

/**
 * Settings → Currencies: the BASE currency card, then the additional currencies as rows
 * carrying their rate, an AUTO/Manual badge, when the held rate was published (or that
 * its last refresh failed) and a `⋯` menu. The count includes the base currency.
 * Failed refreshes are spelled out in the page's attention band.
 */
export function CurrencyScreen({
  biz,
  baseCurrency,
  rates,
  enabledCount,
}: {
  biz: string;
  baseCurrency: string | null;
  rates: CurrencyRate[];
  /** Base + additional, i.e. what the heading counts. */
  enabledCount: number;
}) {
  const [managing, setManaging] = React.useState<CurrencyRate | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [changingBase, setChangingBase] = React.useState(false);
  const [removing, setRemoving] = React.useState<CurrencyRate | null>(null);

  return (
    <>
      <SettingsCard
        title="Base currency"
        meta="Reports use this currency. All rates are quoted against it."
        actions={
          <Button
            type="button"
            variant={baseCurrency ? "ghost" : "outline"}
            size="sm"
            onClick={() => setChangingBase(true)}
          >
            {baseCurrency ? "Change" : "Set base currency"}
          </Button>
        }
      >
        <div className="flex min-h-14 items-center px-5 py-3">
          {baseCurrency ? (
            <CurrencyName code={baseCurrency} />
          ) : (
            <span className="text-sm text-muted-foreground">
              Not set. Rates are quoted against the base currency, so we cannot convert amounts yet.
            </span>
          )}
        </div>
      </SettingsCard>

      <SettingsCard
        id="currencies"
        title="Currencies"
        meta={`${enabledCount} enabled, including the base`}
        actions={
          <Button type="button" size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden className="size-4" />
            Add currency
          </Button>
        }
      >
        {rates.length === 0 ? (
          <p className="m-0 px-5 py-4 text-sm text-muted-foreground">
            None yet. Add a currency to sell in it. Its rate against{" "}
            {baseCurrency ?? "the base currency"} converts reporting roll-ups, and we record it on
            new invoices.
          </p>
        ) : (
          rates.map((r) => (
            // Wraps on a phone: the chip, the date and the menu cannot usefully shrink.
            <div key={r.currency} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
              <CurrencyName code={r.currency} />
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground tabular-nums">
                {r.rate && baseCurrency ? (
                  `1 ${baseCurrency} = ${r.rate} ${r.currency}`
                ) : (
                  // An unset rate means the roll-up cannot convert this currency at all.
                  <span className="text-warning-foreground">No rate set</span>
                )}
              </span>
              {r.source === "auto" ? (
                <Chip tone="blue">AUTO</Chip>
              ) : (
                <Chip tone="gray">Manual</Chip>
              )}
              <span className="shrink-0 text-right text-xs text-muted-foreground sm:w-36">
                {r.last_error ? (
                  <span className="text-warning-foreground">Refresh failed</span>
                ) : r.updated_at ? (
                  formatDay(r.updated_at)
                ) : (
                  "never updated"
                )}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="touch-target relative"
                    aria-label={`Actions for ${r.currency}`}
                  >
                    <MoreHorizontal aria-hidden className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setManaging(r)}>
                    Manage currency
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setRemoving(r)}>Remove</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))
        )}
      </SettingsCard>

      <ManageCurrencyDialog
        biz={biz}
        baseCurrency={baseCurrency}
        rate={managing}
        onClose={() => setManaging(null)}
      />
      <AddCurrencyDialog
        biz={biz}
        baseCurrency={baseCurrency}
        open={adding}
        taken={[...(baseCurrency ? [baseCurrency] : []), ...rates.map((r) => r.currency)]}
        onClose={() => setAdding(false)}
      />
      <ChangeBaseDialog
        biz={biz}
        baseCurrency={baseCurrency}
        additional={rates}
        open={changingBase}
        onClose={() => setChangingBase(false)}
      />
      <RemoveCurrencyDialog biz={biz} rate={removing} onClose={() => setRemoving(null)} />
    </>
  );
}

/**
 * `INR - ₹  Indian Rupee` — how a currency row is labelled.
 *
 * Symbol and name come from `Intl` rather than a table we would have to maintain: the
 * browser already ships ISO 4217 display data, and a hand-kept list of 180 currency names
 * is exactly the kind of mirror that drifts. A code `Intl` does not know falls back to the
 * code alone, which is still correct.
 */
function CurrencyName({ code }: { code: string }) {
  const symbol = React.useMemo(() => currencySymbol(code), [code]);
  const name = React.useMemo(() => currencyName(code), [code]);
  return (
    <span className="flex shrink-0 items-baseline gap-2">
      <span className="text-sm font-medium">
        {code}
        {symbol && symbol !== code ? ` - ${symbol}` : ""}
      </span>
      {name && name !== code ? <span className="text-sm text-muted-foreground">{name}</span> : null}
    </span>
  );
}

function currencySymbol(code: string): string {
  try {
    // `narrowSymbol` gives ₹ rather than "INR"; the parts walk avoids locale-dependent
    // formatting around the number.
    const parts = new Intl.NumberFormat("en", {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
    }).formatToParts(0);
    return parts.find((p) => p.type === "currency")?.value ?? code;
  } catch {
    return code;
  }
}

function currencyName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** `2026-09-02T00:00:00Z` → `2 Sept 2026`, as the dialog prints it. */
function formatDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** The two radios, shared by Add and Manage — one wording, one place to fix it. */
function RateSourceRadios({
  source,
  onChange,
}: {
  source: "manual" | "auto";
  onChange: (v: "manual" | "auto") => void;
}) {
  return (
    <div className="space-y-2">
      {/* The question is a visible label above the two options: without it the two
          long options read as unrelated statements rather than a choice. */}
      <p className="text-sm font-medium">How do you want to set the exchange rate?</p>
      <RadioField
        name="source"
        ariaLabel="How do you want to set the exchange rate?"
        value={source}
        onValueChange={(v) => onChange(v as "manual" | "auto")}
        options={[
          {
            value: "manual",
            label: "I set the exchange rate myself",
            hint: "You enter the conversion rate for this currency. Nothing else changes it. You must change it each time that the rate changes.",
          },
          {
            value: "auto",
            label: "Two Minute Billing sets it for me",
            hint: "We update the rate every day from the reference rates that the European Central Bank publishes. The ECB publishes on weekdays, so a weekend rate is the Friday rate.",
          },
        ]}
      />
    </div>
  );
}

function RateInput({
  baseCurrency,
  currency,
  defaultValue,
}: {
  baseCurrency: string | null;
  currency: string;
  defaultValue?: string | null;
}) {
  return (
    <Field
      name="rate"
      label={`1 ${baseCurrency ?? "base"} =`}
      help={currency || undefined}
      required
    >
      <Input
        name="rate"
        // `text`, not `number`: the rate is a decimal string all the way into a
        // `numeric(20,10)` column, and a number input hands back a float whose trailing
        // digits are not the ones that were typed.
        type="text"
        inputMode="decimal"
        defaultValue={defaultValue ?? ""}
        placeholder="94.9537410000"
        className="w-48 tabular-nums"
      />
    </Field>
  );
}

function ManageCurrencyDialog({
  biz,
  baseCurrency,
  rate,
  onClose,
}: {
  biz: string;
  baseCurrency: string | null;
  rate: CurrencyRate | null;
  onClose: () => void;
}) {
  const [source, setSource] = React.useState<"manual" | "auto">("manual");
  React.useEffect(() => {
    if (rate) setSource(rate.source);
  }, [rate]);

  if (!rate) return null;
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Manage currency</DialogTitle>
          <DialogDescription>
            {rate.currency}: how we keep its rate against {baseCurrency ?? "the base currency"}.
            Rates convert reporting roll-ups, and we record them on new invoices. Rates never price
            or settle a charge.
          </DialogDescription>
        </DialogHeader>

        <ActionForm action={saveCurrencyRateAction} onSuccess={onClose} className="space-y-4">
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="currency" value={rate.currency} />
          {/* Read-only. NOT a disabled select: a disabled control implies a choice
              exists here, and it does not — managing a currency cannot change which
              currency it is. */}
          <div className="space-y-1">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Currency
            </p>
            <CurrencyName code={rate.currency} />
          </div>
          <RateSourceRadios source={source} onChange={setSource} />
          {source === "manual" ? (
            <RateInput
              baseCurrency={baseCurrency}
              currency={rate.currency}
              defaultValue={rate.rate}
            />
          ) : (
            <CurrentAutoRate rate={rate} baseCurrency={baseCurrency} />
          )}
          <DialogActions onClose={onClose} submitLabel="Apply" />
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

/** What an `auto` currency currently holds, shown under the radios. */
function CurrentAutoRate({
  rate,
  baseCurrency,
}: {
  rate: CurrencyRate;
  baseCurrency: string | null;
}) {
  return (
    <div className="rounded-md bg-muted/50 p-3">
      <p className="text-xs text-muted-foreground">Exchange rate</p>
      <p className="text-sm tabular-nums">
        {rate.rate && baseCurrency
          ? `1 ${baseCurrency} = ${rate.rate} ${rate.currency}`
          : "We did not get the rate yet. When you apply this, we get the rate."}
      </p>
      {rate.updated_at ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Last updated on {formatDay(rate.updated_at)}
          {rate.provider ? ` · ${rate.provider.toUpperCase()}` : ""}
        </p>
      ) : null}
      {rate.last_error ? (
        <p className="text-warning-foreground mt-1 text-xs">
          We could not refresh the rate: {rate.last_error}
        </p>
      ) : null}
    </div>
  );
}

function AddCurrencyDialog({
  biz,
  baseCurrency,
  taken,
  open,
  onClose,
}: {
  biz: string;
  baseCurrency: string | null;
  taken: string[];
  open: boolean;
  onClose: () => void;
}) {
  const [source, setSource] = React.useState<"manual" | "auto">("auto");
  const [currency, setCurrency] = React.useState("");
  React.useEffect(() => {
    if (open) {
      setSource("auto");
      setCurrency("");
    }
  }, [open]);

  if (!open) return null;
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Add currency</DialogTitle>
          <DialogDescription>
            The business can then price and bill in this currency. We use its rate against{" "}
            {baseCurrency ?? "the base currency"} for reporting roll-ups and the invoice record.
          </DialogDescription>
        </DialogHeader>

        <ActionForm action={saveCurrencyRateAction} onSuccess={onClose} className="space-y-4">
          <input type="hidden" name="biz" value={biz} />
          <Field name="currency" label="Currency" required>
            <CurrencySelect
              name="currency"
              value={currency}
              onValueChange={setCurrency}
              exclude={taken}
              className="w-64"
            />
          </Field>
          <RateSourceRadios source={source} onChange={setSource} />
          {source === "manual" ? (
            <RateInput baseCurrency={baseCurrency} currency={currency} />
          ) : (
            <p className="text-sm text-muted-foreground">
              We get the rate now and refresh it daily.
            </p>
          )}
          <DialogActions onClose={onClose} submitLabel="Add currency" />
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

function ChangeBaseDialog({
  biz,
  baseCurrency,
  additional,
  open,
  onClose,
}: {
  biz: string;
  baseCurrency: string | null;
  additional: CurrencyRate[];
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{baseCurrency ? "Change base currency" : "Set base currency"}</DialogTitle>
          <DialogDescription>
            Catalog prices and reporting roll up to this currency, and every other currency&apos;s
            rate is quoted against it.
          </DialogDescription>
        </DialogHeader>

        <ActionForm action={saveBaseCurrencyAction} onSuccess={onClose} className="space-y-4">
          <input type="hidden" name="biz" value={biz} />
          <Field name="default_currency" label="Base currency" required>
            <CurrencySelect
              name="default_currency"
              defaultValue={baseCurrency ?? ""}
              className="w-64"
            />
          </Field>
          {additional.length > 0 ? (
            // The warning is the whole reason this is a dialog and not an inline select:
            // the existing rates are quoted against the OLD base, so after a change each
            // one asserts something different. Nothing converts them, and pretending
            // otherwise is how a reporting figure silently becomes wrong.
            <Alert tone="warning" title="Existing rates are not converted">
              {additional.map((r) => r.currency).join(", ")}{" "}
              {additional.length === 1 ? "is" : "are"} quoted against{" "}
              {baseCurrency ?? "the current base"}. After the change,{" "}
              {additional.length === 1 ? "it keeps" : "they keep"} the same number, but the number
              has a different meaning. Review each one. Currencies set to AUTO correct themselves on
              the next daily refresh. Manual currencies do not.
            </Alert>
          ) : null}
          <DialogActions onClose={onClose} submitLabel="Save" />
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

function RemoveCurrencyDialog({
  biz,
  rate,
  onClose,
}: {
  biz: string;
  rate: CurrencyRate | null;
  onClose: () => void;
}) {
  if (!rate) return null;
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Remove {rate.currency}?</DialogTitle>
          <DialogDescription>
            The business stops pricing and billing in {rate.currency}, and we delete its exchange
            rate. We do not change existing prices, subscriptions and invoices in {rate.currency}.
            Each invoice keeps the rate from when it was issued, so history still converts.
          </DialogDescription>
        </DialogHeader>
        <ActionForm action={removeCurrencyAction} onSuccess={onClose} className="space-y-4">
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="currency" value={rate.currency} />
          <DialogActions onClose={onClose} submitLabel={`Remove ${rate.currency}`} />
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

function DialogActions({ onClose, submitLabel }: { onClose: () => void; submitLabel: string }) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      <SubmitButton>{submitLabel}</SubmitButton>
    </div>
  );
}

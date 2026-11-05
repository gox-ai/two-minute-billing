"use client";

import * as React from "react";
import Link from "next/link";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Price } from "@/lib/api";
import type { RateChangePreview } from "@/lib/api/usage-controls";
import { money, pctFromBps } from "@/lib/format";
import { divisorLabel } from "@/lib/meters";
import { toMajorInput, toMinor } from "@/lib/money";
import { previewRateChangeAction } from "@/app/(dashboard)/businesses/[biz]/usage-controls-actions";

type MeterTier = { up_to: string | null; unit_amount_decimal: string; flat_amount_minor?: number };
type ClassicTier = { upToMinor: number | null; unitAmountMinor?: number; flatAmountMinor?: number };

const TIERED = new Set(["tiered", "volume"]);
const CLASSIC_TIERED = new Set(["tiered", "volume", "stairstep"]);

/**
 * "Preview a rate change" (design G5 § 3.8): edit the rates, then see what each customer's last
 * closed period would cost. It saves nothing; edit the price to change it.
 */
export function RatePreviewButton({ biz, price }: { biz: string; price: Price }) {
  const meter = !!price.meter;
  const tiered = meter ? TIERED.has(price.model) : CLASSIC_TIERED.has(price.model);
  const [open, setOpen] = React.useState(false);
  const seed = React.useCallback(
    () => ({
      rate: price.unit_amount_decimal ?? "",
      unit: toMajorInput(price.amount_minor, price.currency),
      tiers: (price.tiers ?? []).map((t) =>
        meter
          ? {
              up: (t as unknown as MeterTier).up_to ?? "",
              rate: (t as unknown as MeterTier).unit_amount_decimal,
            }
          : {
              up: (t as ClassicTier).upToMinor == null ? "" : String((t as ClassicTier).upToMinor),
              rate: toMajorInput((t as ClassicTier).unitAmountMinor ?? 0, price.currency),
            },
      ),
      rates: (price.rates ?? []).map((r) => r.unit_amount_decimal ?? ""),
    }),
    [price, meter],
  );
  const [form, setForm] = React.useState(seed);
  const [result, setResult] = React.useState<RateChangePreview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const draft = (): Record<string, unknown> => {
    if (meter) {
      const out: Record<string, unknown> = {};
      if (tiered)
        out.tiers = (price.tiers ?? []).map((t, i) => ({
          ...(t as unknown as MeterTier),
          up_to: form.tiers[i]?.up.trim() ? form.tiers[i]!.up.trim() : null,
          unit_amount_decimal: form.tiers[i]?.rate.trim() ?? "",
        }));
      else out.unit_amount_decimal = form.rate.trim() || null;
      if (price.rates?.length)
        out.rates = price.rates.map((r, i) => ({
          match: r.match,
          ...(r.tiers ? { tiers: r.tiers } : { unit_amount_decimal: form.rates[i]?.trim() ?? "" }),
        }));
      return out;
    }
    if (tiered)
      return {
        tiers: (price.tiers ?? []).map((t, i) => ({
          ...(t as ClassicTier),
          upToMinor: form.tiers[i]?.up.trim() ? Number(form.tiers[i]!.up) : null,
          unitAmountMinor: toMinor(Number(form.tiers[i]?.rate || 0), price.currency),
        })),
      };
    return { amount_minor: toMinor(Number(form.unit || 0), price.currency) };
  };

  const run = async (after?: string) => {
    setPending(true);
    setError(null);
    const fd = new FormData();
    fd.set("biz", biz);
    fd.set("price", price.id);
    fd.set("draft", JSON.stringify(draft()));
    if (after) fd.set("starting_after", after);
    try {
      const res = await previewRateChangeAction(fd);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setResult((prev) =>
        after && prev ? { ...res.data, data: [...prev.data, ...res.data.data] } : res.data,
      );
    } finally {
      setPending(false);
    }
  };

  const cur = price.currency;
  const rateLabel = `(${cur} minor units ${divisorLabel(price.quantity_divisor)})`;
  const pct = (bps: number | null) =>
    bps == null ? "—" : `${bps > 0 ? "+" : ""}${pctFromBps(bps)}`;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          setForm(seed());
          setResult(null);
          setError(null);
          setOpen(true);
        }}
      >
        Preview a rate change
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="xl" className="flex max-h-[85vh] flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Preview a rate change</DialogTitle>
            <DialogDescription>
              Change the rates, then see what each customer&apos;s last closed period costs at the
              new rates. This does not change the price. Tax, discounts and credit are not included.
            </DialogDescription>
          </DialogHeader>
          <div className="-mx-6 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6">
            {tiered ? (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">
                  Tiers {meter ? rateLabel : `(${cur} per unit)`}
                </span>
                {form.tiers.map((t, i) => (
                  <div key={i} className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`tier-up-${i}`}>Up to</Label>
                      <Input
                        id={`tier-up-${i}`}
                        value={t.up}
                        placeholder={i === form.tiers.length - 1 ? "No upper limit" : ""}
                        inputMode="decimal"
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            tiers: f.tiers.map((x, j) =>
                              j === i ? { ...x, up: e.target.value } : x,
                            ),
                          }))
                        }
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`tier-rate-${i}`}>Rate</Label>
                      <Input
                        id={`tier-rate-${i}`}
                        value={t.rate}
                        inputMode="decimal"
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            tiers: f.tiers.map((x, j) =>
                              j === i ? { ...x, rate: e.target.value } : x,
                            ),
                          }))
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : meter ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor="preview-rate">Default rate {rateLabel}</Label>
                <Input
                  id="preview-rate"
                  value={form.rate}
                  inputMode="decimal"
                  onChange={(e) => setForm((f) => ({ ...f, rate: e.target.value }))}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <Label htmlFor="preview-unit">Price per unit ({cur})</Label>
                <Input
                  id="preview-unit"
                  value={form.unit}
                  inputMode="decimal"
                  onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
                />
              </div>
            )}
            {meter && price.rates?.length ? (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">Rate card {rateLabel}</span>
                {price.rates.map((r, i) => (
                  <div key={i} className="grid grid-cols-2 items-end gap-3">
                    <span className="text-sm wrap-anywhere text-muted-foreground">
                      {Object.entries(r.match)
                        .map(([k, v]) => `${k} = ${v}`)
                        .join(", ")}
                    </span>
                    {r.tiers ? (
                      <span className="text-sm text-muted-foreground">
                        Tiered: not changed here
                      </span>
                    ) : (
                      <Input
                        aria-label={`Rate for ${Object.values(r.match).join(", ")}`}
                        value={form.rates[i] ?? ""}
                        inputMode="decimal"
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            rates: f.rates.map((x, j) => (j === i ? e.target.value : x)),
                          }))
                        }
                      />
                    )}
                  </div>
                ))}
              </div>
            ) : null}
            <div className="flex justify-end">
              <Button type="button" onClick={() => run()} disabled={pending}>
                {pending ? "Calculating…" : "Preview"}
              </Button>
            </div>
            {error ? <Alert tone="error">{error}</Alert> : null}
            {result ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-px overflow-hidden rounded-xl border bg-border">
                  {[
                    ["Customers", result.totals.customers.toLocaleString()],
                    ["Now", money(result.totals.old_minor, result.currency)],
                    ["At the new rates", money(result.totals.new_minor, result.currency)],
                    [
                      "Change",
                      `${money(result.totals.diff_minor, result.currency)} (${pct(result.totals.diff_bps)})`,
                    ],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="flex flex-[1_1_10rem] flex-col gap-0.5 bg-card px-4 py-3"
                    >
                      <span className="text-xs text-muted-foreground">{label}</span>
                      <span className="text-sm font-medium tabular-nums">{value}</span>
                    </div>
                  ))}
                </div>
                {result.customers_without_usage > 0 ? (
                  <p className="m-0 text-sm text-muted-foreground">
                    {result.customers_without_usage === 1
                      ? "1 customer on this price has no closed period yet and is not included."
                      : `${result.customers_without_usage} customers on this price have no closed period yet and are not included.`}
                  </p>
                ) : null}
                {result.truncated ? (
                  <Alert tone="info">
                    More than 5,000 customers are on this price. The preview shows the first 5,000.
                  </Alert>
                ) : null}
                {result.data.length ? (
                  <div className="rounded-xl border bg-card">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="pl-4">Customer</TableHead>
                          <TableHead className="text-right">Now</TableHead>
                          <TableHead className="text-right">New</TableHead>
                          <TableHead className="pr-4 text-right">Change</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {result.data.map((r) => (
                          <TableRow key={r.customer}>
                            <TableCell className="pl-4">
                              <Link
                                href={`/businesses/${biz}/customers/${r.customer}`}
                                className="text-primary hover:underline"
                              >
                                {r.customer_name ?? r.customer}
                              </Link>
                            </TableCell>
                            <TableCell className="text-right">
                              {money(r.old_minor, result.currency)}
                            </TableCell>
                            <TableCell className="text-right">
                              {money(r.new_minor, result.currency)}
                            </TableCell>
                            <TableCell className="pr-4 text-right">
                              {money(r.diff_minor, result.currency)} ({pct(r.diff_bps)})
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <p className="m-0 text-sm text-muted-foreground">
                    No customer on this price has a closed period yet.
                  </p>
                )}
                {result.has_more && result.next_cursor ? (
                  <div className="flex justify-center pb-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => run(result.next_cursor!)}
                    >
                      Load more
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

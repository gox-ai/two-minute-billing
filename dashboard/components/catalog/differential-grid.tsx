import Link from "next/link";
import { setDifferentialPriceAction } from "@/app/actions";
import { money, type DifferentialPrice, type Product } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { DifferentialPriceInput } from "@/components/catalog/differential-price-input";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { ActionForm } from "@/components/form/action-form";

/**
 * Differential pricing for an addon/charge attached to ONE plan: a Currency ×
 * Billing Frequency grid where each cell sets the item's price when attached to
 * that plan. The plan is chosen upstream (?plan=) via the overview table or the
 * "Set Differential Pricing" modal, so this view is purely the per-plan grid.
 *
 * When a row has a `tiers` array instead of a flat amount, a view-only tier
 * summary is shown inline — tier editing is not supported via this UI; use the
 * API directly for tiered differential prices.
 */
export function DifferentialGrid({
  biz,
  addon,
  plan,
  currencies,
  rows,
}: {
  biz: string;
  addon: Product;
  /** The plan whose differential prices are being edited. */
  plan: { id: string; name: string };
  currencies: string[];
  rows: DifferentialPrice[];
}) {
  const baseUrl = `/businesses/${biz}/catalog/products/${addon.id}`;
  const cell = (currency: string, interval: string) =>
    rows.find((r) => r.plan === plan.id && r.currency === currency && r.interval === interval);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1">
        <Link href={baseUrl} className="text-xs font-medium text-primary hover:underline">
          ← All plans
        </Link>
        <h3 className="text-base font-semibold">
          Differential Pricing for <span className="font-mono text-sm">{plan.name}</span>
        </h3>
        <p className="text-sm text-muted-foreground">
          Set the price for <b className="text-foreground">{addon.name}</b> when it is added to{" "}
          <b className="text-foreground">{plan.name}</b>. Currencies without a differential use the
          item's base price.
        </p>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Currency</TableHead>
            <TableHead>Billing frequency</TableHead>
            <TableHead className="text-right">Differential price</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {currencies.flatMap((currency) =>
            (["month", "year"] as const).map((interval) => {
              const existing = cell(currency, interval);
              const hasTiers =
                existing && Array.isArray(existing.tiers) && existing.tiers.length > 0;

              return (
                <TableRow key={`${currency}-${interval}`}>
                  <TableCell className="font-medium">{currency}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {interval === "month" ? "Monthly" : "Yearly"}
                  </TableCell>
                  <TableCell>
                    {hasTiers ? (
                      /* Tier view — read-only. Tier editing not supported via UI. */
                      <div className="flex items-center justify-end gap-2">
                        <details className="text-right">
                          <summary className="cursor-pointer text-xs text-primary hover:underline">
                            {existing!.tiers!.length} tier{existing!.tiers!.length !== 1 ? "s" : ""}
                          </summary>
                          <div className="mt-1 rounded border bg-muted p-2 text-xs">
                            <div className="overflow-x-auto">
                              <table className="w-full border-collapse">
                                <thead>
                                  <tr className="text-muted-foreground">
                                    <th className="pr-4 text-left font-normal">Up to</th>
                                    <th className="pr-4 text-right font-normal">Per unit</th>
                                    <th className="text-right font-normal">Flat fee</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {existing!.tiers!.map((t, i) => (
                                    <tr key={i}>
                                      <td className="pr-4 tabular-nums">
                                        {t.upToMinor == null ? "∞" : t.upToMinor.toLocaleString()}
                                      </td>
                                      <td className="pr-4 text-right tabular-nums">
                                        {t.unitAmountMinor != null
                                          ? money(t.unitAmountMinor, currency)
                                          : "—"}
                                      </td>
                                      <td className="text-right tabular-nums">
                                        {t.flatAmountMinor != null
                                          ? money(t.flatAmountMinor, currency)
                                          : "—"}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            <p className="mt-1.5 text-muted-foreground">
                              To edit tiers, use the API.
                            </p>
                          </div>
                        </details>
                      </div>
                    ) : (
                      /* Flat amount editing */
                      <ActionForm
                        action={setDifferentialPriceAction}
                        className="flex items-center justify-end gap-2"
                      >
                        <input type="hidden" name="biz" value={biz} />
                        <input type="hidden" name="addon" value={addon.id} />
                        <input type="hidden" name="plan" value={plan.id} />
                        <input type="hidden" name="currency" value={currency} />
                        <input type="hidden" name="interval" value={interval} />
                        <DifferentialPriceInput
                          currency={currency}
                          defaultMinor={existing?.amountMinor ?? null}
                        />
                        <Button type="submit" variant="outline" size="sm">
                          {existing ? "Save" : "Set Price"}
                        </Button>
                      </ActionForm>
                    )}
                  </TableCell>
                </TableRow>
              );
            }),
          )}
        </TableBody>
      </Table>
    </div>
  );
}

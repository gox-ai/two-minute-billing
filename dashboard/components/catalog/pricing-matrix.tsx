import Link from "next/link";
import { intervalLabel } from "@/lib/format";
import { money, type Price } from "@/lib/api";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { PriceRowMenu } from "@/components/catalog/price-row-menu";
import { Paged, PagedFooter, PagedItems } from "@/components/patterns/pager";

/**
 * Pricing table on the product detail page: one row per price, plus one
 * "Set price" row for each business currency that has none yet (it opens the
 * price form pre-scoped to that currency). Any other currency × frequency is
 * reached through the card's Add price.
 */

export function freqLabel(p: Price): string {
  if (p.type === "one_time" || !p.interval) return "One-time";
  const n = p.interval_count ?? 1;
  if (n === 1) {
    return intervalLabel(p.interval);
  }
  return `Every ${n} ${p.interval}s`;
}

export function priceDisplay(p: Price): string {
  if (p.amount_minor != null) return money(p.amount_minor, p.currency);
  if (p.model === "percentage" && p.percentage_bps != null)
    return `${(p.percentage_bps / 100).toFixed(2)}%`;
  if (p.tiers?.length) return `${p.tiers.length} tiers`;
  return "—";
}

export const MODEL_LABEL: Record<string, string> = {
  flat: "Flat Fee",
  per_unit: "Per Unit",
  tiered: "Tiered",
  volume: "Volume",
  stairstep: "Stairstep",
  usage: "Usage",
  package: "Package",
  percentage: "Percentage",
  graduated_percentage: "Graduated Percentage",
};

export function PricingMatrix({
  biz,
  productId,
  prices,
  currencies,
}: {
  biz: string;
  productId: string;
  prices: Price[];
  /** Currencies to render rows for (business default + any priced currency). */
  currencies: string[];
}) {
  const newPriceUrl = (currency: string) =>
    `/businesses/${biz}/catalog/products/${productId}/prices/new?${new URLSearchParams({ currency, interval: "month" })}`;

  const ordered = [...prices].sort(
    (a, b) =>
      a.currency.localeCompare(b.currency) ||
      freqRank(a) - freqRank(b) ||
      (a.interval_count ?? 1) - (b.interval_count ?? 1),
  );
  const priced = new Set(prices.map((p) => p.currency));
  const rows = [
    ...ordered.map((p) => <PriceRow key={p.id} biz={biz} p={p} freq={freqLabel(p)} />),
    ...currencies
      .filter((c) => !priced.has(c))
      .map((currency) => (
        <TableRow key={`unpriced-${currency}`}>
          <TableCell className="pl-5 font-medium">{currency}</TableCell>
          <TableCell className="text-muted-foreground">Monthly</TableCell>
          <TableCell colSpan={6}>
            <Link href={newPriceUrl(currency)} className="text-sm text-primary hover:underline">
              Set price
            </Link>
          </TableCell>
        </TableRow>
      )),
  ];

  if (rows.length === 0)
    return (
      <p className="px-5 py-4 text-sm text-muted-foreground">
        No prices yet. Add one to sell this item.
      </p>
    );

  return (
    <Paged size={10} items={rows}>
      <Table className="table-fixed max-lg:min-w-3xl">
        <colgroup>
          <col className="w-[14%]" />
          <col className="w-[14%]" />
          <col className="w-[15%]" />
          <col />
          <col className="w-[12%]" />
          <col className="w-[9%]" />
          <col className="w-[12%]" />
          {/* Fixed px: the row menu is a 32px button, never a share of the width. */}
          <col className="w-16" />
        </colgroup>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-5">Currency</TableHead>
            <TableHead>Frequency</TableHead>
            <TableHead className="text-right">Price</TableHead>
            <TableHead>Pricing model</TableHead>
            <TableHead>Billing cycles</TableHead>
            <TableHead>Trial</TableHead>
            <TableHead>Taxable</TableHead>
            <TableHead className="pr-5" />
          </TableRow>
        </TableHeader>
        <TableBody>
          <PagedItems />
        </TableBody>
      </Table>
      <PagedFooter />
    </Paged>
  );
}

const FREQ_ORDER = ["day", "week", "month", "year"];
function freqRank(p: Price): number {
  if (p.type === "one_time" || !p.interval) return FREQ_ORDER.length;
  const i = FREQ_ORDER.indexOf(p.interval);
  return i < 0 ? FREQ_ORDER.length : i;
}

function PriceRow({ biz, p, freq }: { biz: string; p: Price; freq: string }) {
  return (
    <TableRow className={p.active === false ? "opacity-50" : undefined}>
      <TableCell className="pl-5 font-medium">{p.currency}</TableCell>
      <TableCell className="whitespace-normal text-muted-foreground">{freq}</TableCell>
      <TableCell className="text-right font-medium tabular-nums">
        <Link
          href={`/businesses/${biz}/catalog/products/${p.product}/prices/${p.id}`}
          className="text-primary hover:underline"
        >
          {priceDisplay(p)}
        </Link>
      </TableCell>
      <TableCell className="truncate">{MODEL_LABEL[p.model] ?? p.model}</TableCell>
      <TableCell className="text-muted-foreground">
        {p.billing_cycles ? `${p.billing_cycles} cycles` : "Forever"}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {p.trial_period ? `${p.trial_period} ${p.trial_period_unit ?? "day"}s` : "—"}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {p.is_taxable === false ? "No" : "Yes"}
      </TableCell>
      <TableCell className="pr-5">
        <div className="flex justify-end">
          <PriceRowMenu
            biz={biz}
            price={p}
            returnTo={`/businesses/${biz}/catalog/products/${p.product}`}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}

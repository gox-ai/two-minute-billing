import Link from "next/link";
import { listBusinesses } from "@/lib/api";
import { getUsageMargin, type MarginGroupBy, type UsageMarginRow } from "@/lib/api/model-prices";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { RecordCard } from "@/components/patterns/record-page";
import { ErrorState, EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { money } from "@/lib/format";
import { localDate, localMidnightIso, minusDays, percentLabel, plusDays } from "@/lib/model-prices";

export const dynamic = "force-dynamic";

const GROUPS: Array<{ value: MarginGroupBy; label: string }> = [
  { value: "customer", label: "Customer" },
  { value: "model", label: "Model" },
  { value: "meter", label: "Meter" },
];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reports → Usage margin (design G1b § 3.7). Revenue after discounts and line credit notes,
 * before tax, minus cost, over usage lines of finalized invoices in the range.
 */
export default async function UsageMarginPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{ from?: string; to?: string; currency?: string; group_by?: string }>;
}) {
  await requirePermission("usage_margin:view", "manager");
  const { biz } = await params;
  const sp = await searchParams;
  const businesses = await listBusinesses().catch(() => null);
  const b = businesses?.data.find((x) => x.id === biz);
  const tz = b?.timezone ?? null;
  const today = localDate(tz);
  const to = sp.to && DATE.test(sp.to) ? sp.to : today;
  const from = sp.from && DATE.test(sp.from) ? sp.from : minusDays(to, 29);
  const groupBy: MarginGroupBy = GROUPS.some((g) => g.value === sp.group_by)
    ? (sp.group_by as MarginGroupBy)
    : "customer";
  const currency = sp.currency?.toUpperCase() || b?.default_currency?.toUpperCase() || undefined;
  const crumbs = [
    { label: b?.name ?? biz, href: `/businesses/${biz}` },
    { label: "Reports" },
    { label: "Usage margin" },
  ];

  let report;
  try {
    report = await getUsageMargin(biz, {
      from: localMidnightIso(from, tz),
      to: localMidnightIso(plusDays(to, 1), tz),
      currency,
      group_by: groupBy,
    });
  } catch (e) {
    return (
      <>
        <PageHeader title="Usage margin" breadcrumbs={crumbs} />
        <ErrorState
          title="We could not load the report"
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const c = currency ?? report.totals[0]?.currency ?? "USD";
  const total = report.totals.find((t) => t.currency === c) ?? null;
  const rows = report.data.filter((r) => r.currency === c);
  const currencies = Array.from(
    new Set(
      [c, ...report.totals.map((t) => t.currency), b?.default_currency, ...(b?.currencies ?? [])]
        .filter((x): x is string => !!x)
        .map((x) => x.toUpperCase()),
    ),
  ).sort();
  const keyOf = (r: UsageMarginRow) => r[groupBy] ?? "";
  const keyCell = (r: UsageMarginRow) =>
    groupBy === "customer" && keyOf(r) ? (
      <Link
        href={`/businesses/${biz}/customers/${keyOf(r)}`}
        className={
          r.customer_name
            ? "text-primary hover:underline"
            : "font-mono text-primary hover:underline"
        }
      >
        {r.customer_name || keyOf(r)}
      </Link>
    ) : (
      <span className="font-mono">{keyOf(r) || "No model"}</span>
    );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Usage margin"
        breadcrumbs={crumbs}
        description="Revenue from usage after discounts and credit notes, before tax, minus the cost of that usage. Lines without a cost are not in revenue or cost."
      />
      <RecordCard title="Filters">
        <form method="get" className="flex flex-wrap items-end gap-3 px-5 py-4">
          <div className="flex w-44 flex-col gap-1.5">
            <label htmlFor="from" className="text-sm font-medium">
              From
            </label>
            <Input id="from" name="from" type="date" defaultValue={from} max={to} />
          </div>
          <div className="flex w-44 flex-col gap-1.5">
            <label htmlFor="to" className="text-sm font-medium">
              To
            </label>
            <Input id="to" name="to" type="date" defaultValue={to} />
          </div>
          <div className="flex w-32 flex-col gap-1.5">
            <span className="text-sm font-medium">Currency</span>
            <SelectField
              name="currency"
              defaultValue={c}
              ariaLabel="Currency"
              options={currencies.map((x) => ({ value: x, label: x }))}
            />
          </div>
          <div className="flex w-40 flex-col gap-1.5">
            <span className="text-sm font-medium">Group by</span>
            <SelectField
              name="group_by"
              defaultValue={groupBy}
              ariaLabel="Group by"
              options={GROUPS}
            />
          </div>
          <Button type="submit" variant="outline">
            Show
          </Button>
        </form>
      </RecordCard>

      <RecordCard
        title={`By ${GROUPS.find((g) => g.value === groupBy)!.label.toLowerCase()}`}
        meta={`Invoices dated ${from} to ${to} · ${c}`}
        flush
      >
        {rows.length === 0 ? (
          <EmptyState
            title="No usage lines"
            description="No finalized invoice in this range has a usage line in this currency."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">
                  {GROUPS.find((g) => g.value === groupBy)!.label}
                </TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Margin</TableHead>
                <TableHead className="text-right">Margin %</TableHead>
                <TableHead className="pr-5 text-right">Lines without cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={keyOf(r)}>
                  <TableCell className="pl-5">{keyCell(r)}</TableCell>
                  <TableCell className="text-right">{money(r.revenue_minor, c)}</TableCell>
                  <TableCell className="text-right">{money(r.cost_minor, c)}</TableCell>
                  <TableCell className="text-right">{money(r.margin_minor, c)}</TableCell>
                  <TableCell className="text-right">{percentLabel(r.margin_percent)}</TableCell>
                  <TableCell className="pr-5 text-right">
                    {r.lines_without_cost.toLocaleString("en-US")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            {total ? (
              <TableFooter>
                <TableRow>
                  <TableCell className="pl-5 font-medium">Total</TableCell>
                  <TableCell className="text-right font-medium">
                    {money(total.revenue_minor, c)}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {money(total.cost_minor, c)}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {money(total.margin_minor, c)}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {percentLabel(total.margin_percent)}
                  </TableCell>
                  <TableCell className="pr-5 text-right font-medium">
                    {total.lines_without_cost.toLocaleString("en-US")}
                  </TableCell>
                </TableRow>
              </TableFooter>
            ) : null}
          </Table>
        )}
      </RecordCard>
      <p className="text-xs text-muted-foreground">
        Cost is fixed when we rate a line, so the margin of a billed period does not change when a
        price changes later. A cost in another currency is converted at the exchange rate on the
        last day of the line&apos;s period.
      </p>
    </div>
  );
}

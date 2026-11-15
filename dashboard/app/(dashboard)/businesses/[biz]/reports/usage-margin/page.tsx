import Link from "next/link";
import { reportCrumbs } from "@/lib/report-crumbs";
import { listBusinesses } from "@/lib/api";
import {
  getUsageMargin,
  type MarginGroupBy,
  type UsageMarginFigures,
  type UsageMarginRow,
} from "@/lib/api/model-prices";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { RecordCard } from "@/components/patterns/record-page";
import { Chip } from "@/components/patterns/chip";
import { ErrorState, EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/reports/date-input";
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
import { fmtRange } from "@/lib/format-date";
import { localDate, localMidnightIso, minusDays, percentLabel, plusDays } from "@/lib/model-prices";

export const dynamic = "force-dynamic";

const GROUPS: Array<{ value: MarginGroupBy; label: string }> = [
  { value: "customer", label: "Customer" },
  { value: "model", label: "Model" },
  { value: "meter", label: "Meter" },
  { value: "plan", label: "Plan" },
];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reports → Usage margin (design G1b § 3.7), `scope=all`: revenue after discounts and credit
 * notes, before tax, minus the cost of usage, billed on a line or not billed (cost only). By
 * customer and plan the revenue is every line; by meter and model, usage lines only.
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
  const crumbs = reportCrumbs(biz, b?.name, "Usage margin");

  let report;
  try {
    report = await getUsageMargin(biz, {
      from: localMidnightIso(from, tz),
      to: localMidnightIso(plusDays(to, 1), tz),
      currency,
      group_by: groupBy,
      scope: "all",
    });
  } catch (e) {
    return (
      <>
        <PageHeader title="Usage margin" breadcrumbs={crumbs} />
        <ErrorState title="We could not load the usage margin report." error={e} retry />
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
  // What makes a row, per grouping (see the engine's usage-margin.ts): every invoice line by
  // customer and plan, usage lines only by meter and model; a plan also gets its live
  // subscriptions. The empty state says exactly that.
  const emptyText = {
    customer: "No finalized invoice in this range has a line in this currency",
    plan: "No subscription on a plan was live in this range. No finalized invoice in this range has a line in this currency",
    meter: "No finalized invoice in this range has a usage line in this currency",
    model: "No finalized invoice in this range has a usage line in this currency",
  }[groupBy];
  const byPlan = groupBy === "plan";
  const withoutCost = (r: UsageMarginFigures) =>
    (r.lines_without_cost + (r.cost_only_rows_without_cost ?? 0)).toLocaleString("en-US");
  const keyCell = (r: UsageMarginRow) =>
    byPlan ? (
      keyOf(r) ? (
        <Link
          href={`/businesses/${biz}/catalog/products/${keyOf(r)}`}
          className="text-primary hover:underline"
        >
          {r.plan_name || keyOf(r)}
        </Link>
      ) : (
        <span className="text-muted-foreground">No plan</span>
      )
    ) : groupBy === "customer" && keyOf(r) ? (
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
      <span className="inline-flex flex-wrap items-center gap-2">
        {groupBy === "meter" && keyOf(r) ? (
          <span className="flex flex-col">
            <span>{r.meter_name || keyOf(r)}</span>
            {r.meter_name ? (
              <span className="font-mono text-xs text-muted-foreground">{keyOf(r)}</span>
            ) : null}
          </span>
        ) : keyOf(r) ? (
          <span className="font-mono">{keyOf(r)}</span>
        ) : (
          <span className="text-muted-foreground">
            {groupBy === "meter" ? "No meter" : "No model"}
          </span>
        )}
        {r.lines === 0 ? <Chip>Not billed</Chip> : null}
      </span>
    );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Usage margin"
        breadcrumbs={crumbs}
        description="Revenue after discounts and credit notes, before tax, minus the cost of usage. Usage that is not on an invoice shows its cost as not billed."
      />
      <RecordCard title="Filters">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <div className="flex w-44 flex-col gap-1.5">
            <label htmlFor="from" className="text-sm font-medium">
              From
            </label>
            <DateInput id="from" name="from" label="From" defaultValue={from} max={to} tz={tz} />
          </div>
          <div className="flex w-44 flex-col gap-1.5">
            <label htmlFor="to" className="text-sm font-medium">
              To
            </label>
            <DateInput
              id="to"
              name="to"
              label="To"
              defaultValue={to}
              min={from}
              max={today}
              tz={tz}
            />
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
            View report
          </Button>
        </form>
      </RecordCard>

      <RecordCard
        title={`By ${GROUPS.find((g) => g.value === groupBy)!.label.toLowerCase()}`}
        meta={`Invoices and usage dated ${fmtRange(from, to, tz)} · ${c}`}
        flush
      >
        {rows.length === 0 ? (
          <EmptyState
            title="No revenue or usage cost"
            description={`${emptyText}, and we found no usage that is not billed. Select a wider date range or another currency. We calculate usage cost each night.`}
          />
        ) : (
          <Table phone="stack">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">
                  {GROUPS.find((g) => g.value === groupBy)!.label}
                </TableHead>
                {byPlan ? <TableHead className="text-right">Subscribers</TableHead> : null}
                {byPlan ? <TableHead className="text-right">Plan fees</TableHead> : null}
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">Cost billed</TableHead>
                <TableHead className="text-right">Cost not billed</TableHead>
                {/* The phone row's figure, opposite the name. */}
                <TableHead phone="aside" className="text-right">
                  Margin
                </TableHead>
                <TableHead className="text-right">Margin %</TableHead>
                <TableHead className="pr-5 text-right">Items without cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={keyOf(r)}>
                  <TableCell className="pl-5">{keyCell(r)}</TableCell>
                  {byPlan ? (
                    <TableCell className="text-right">
                      {(r.subscribers ?? 0).toLocaleString("en-US")}
                    </TableCell>
                  ) : null}
                  {byPlan ? (
                    <TableCell className="text-right">{money(r.plan_fee_minor ?? 0, c)}</TableCell>
                  ) : null}
                  <TableCell className="text-right">
                    {money(r.total_revenue_minor ?? 0, c)}
                  </TableCell>
                  <TableCell className="text-right">{money(r.cost_minor, c)}</TableCell>
                  <TableCell className="text-right">{money(r.cost_only_minor ?? 0, c)}</TableCell>
                  <TableCell className="text-right">
                    {money(r.total_margin_minor ?? 0, c)}
                  </TableCell>
                  <TableCell className="text-right">
                    {percentLabel(r.total_margin_percent ?? null)}
                  </TableCell>
                  <TableCell className="pr-5 text-right">{withoutCost(r)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            {total ? (
              <TableFooter>
                <TableRow>
                  <TableCell className="pl-5 font-medium">Total</TableCell>
                  {byPlan ? (
                    <TableCell className="text-right font-medium">
                      {(total.subscribers ?? 0).toLocaleString("en-US")}
                    </TableCell>
                  ) : null}
                  {byPlan ? (
                    <TableCell className="text-right font-medium">
                      {money(total.plan_fee_minor ?? 0, c)}
                    </TableCell>
                  ) : null}
                  <TableCell className="text-right font-medium">
                    {money(total.total_revenue_minor ?? 0, c)}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {money(total.cost_minor, c)}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {money(total.cost_only_minor ?? 0, c)}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {money(total.total_margin_minor ?? 0, c)}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {percentLabel(total.total_margin_percent ?? null)}
                  </TableCell>
                  <TableCell className="pr-5 text-right font-medium">
                    {withoutCost(total)}
                  </TableCell>
                </TableRow>
              </TableFooter>
            ) : null}
          </Table>
        )}
      </RecordCard>
      <p className="text-xs text-muted-foreground">
        Revenue by customer and by plan includes every invoice line: plan fees, usage and one-time
        sales. Revenue by meter and by model includes only usage lines. Cost not billed is the cost
        of usage that is not on an invoice and that no subscription will bill. We calculate it each
        night for the days up to yesterday. A plan gets the usage of the subscription that was live
        on that day.
      </p>
      <p className="text-xs text-muted-foreground">
        If a usage event does not report its own cost, we use your cost for its model. If you set
        none, we use the list price. Items without cost counts the invoice lines and usage days that
        have no cost, or only part of their cost. Their cost is not in the cost columns.
      </p>
      <p className="text-xs text-muted-foreground">
        Cost is fixed when we rate a line, so the margin of a billed period does not change when a
        price changes later. A cost in another currency is converted at the exchange rate on the
        last day of the line&apos;s period.
      </p>
    </div>
  );
}

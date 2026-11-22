import Link from "next/link";
import { reportCrumbs } from "@/lib/report-crumbs";
import { listBusinesses } from "@/lib/api";
import { listCreditUnits } from "@/lib/api/credits";
import { getDeferredRevenue, getRefusedDemand } from "@/lib/api/credit-settings";
import { rollTotals, type RollForwardRow } from "@/lib/credit-settings";
import { requirePermission } from "@/lib/session";
import { modelEmptyState } from "@/components/reports/model-empty-state";
import { PageHeader } from "@/components/page-header";
import { RecordCard } from "@/components/patterns/record-page";
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
import { fmtUnits, unitCount, unitInfo } from "@/lib/credits";
import { queryAnalytics, type BatchEntry } from "@/lib/analytics-api";
import { BarList, Headline, pick, slice, slices } from "@/components/analytics/home/parts";
import { Grid } from "@/components/analytics/layout";
import { fmtDate, fmtRange } from "@/lib/format-date";
import { localDate, localMidnightIso, minusDays, plusDays } from "@/lib/model-prices";

export const dynamic = "force-dynamic";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GROUPS = [
  { value: "meter", label: "Meter" },
  { value: "day", label: "Day" },
  { value: "customer", label: "Customer" },
] as const;
type Group = (typeof GROUPS)[number]["value"];

/** The last `n` months, newest first, as YYYY-MM. */
function recentMonths(today: string, n: number): string[] {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = y * 12 + (m - 1) - i;
    out.push(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

const MONTH_NAME = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
/** "Nov 2026" for a `YYYY-MM` month, which is already in the business time zone. */
const monthLabel = (ym: string) => {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return MONTH_NAME.format(new Date(Date.UTC(y, m - 1, 1)));
};

/**
 * Reports → Credits: the deferred revenue of paid credit, month by month (opening + sold −
 * recognised − breakage − refunds = closing), and the usage refused for lack of credit.
 */
export default async function CreditReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{
    from?: string;
    to?: string;
    currency?: string;
    unit?: string;
    rfrom?: string;
    rto?: string;
    group_by?: string;
  }>;
}) {
  await requirePermission("credits:view", "manager");
  const { biz } = await params;
  const empty = await modelEmptyState(biz, "credits", "Credits");
  if (empty) return empty;
  const sp = await searchParams;
  const businesses = await listBusinesses().catch(() => null);
  const b = businesses?.data.find((x) => x.id === biz);
  const tz = b?.timezone ?? null;
  const today = localDate(tz);
  const months = recentMonths(today.slice(0, 7), 36);
  const to = sp.to && MONTH.test(sp.to) ? sp.to : months[0]!;
  const from = sp.from && MONTH.test(sp.from) && sp.from <= to ? sp.from : months[11]!;
  const units = await listCreditUnits(biz).catch(() => null);
  const unit = sp.unit ?? "";
  const currency = (sp.currency ?? b?.default_currency ?? "USD").toUpperCase();
  const rto = sp.rto && DATE.test(sp.rto) ? sp.rto : today;
  const rfrom = sp.rfrom && DATE.test(sp.rfrom) ? sp.rfrom : minusDays(rto, 29);
  const groupBy: Group = GROUPS.some((g) => g.value === sp.group_by)
    ? (sp.group_by as Group)
    : "meter";
  const crumbs = reportCrumbs(biz, b?.name, "Credits");

  let roll, refused;
  try {
    [roll, refused] = await Promise.all([
      getDeferredRevenue(biz, { from, to, currency, ...(unit ? { unit } : {}) }),
      getRefusedDemand(biz, {
        from: localMidnightIso(rfrom, tz),
        to: localMidnightIso(plusDays(rto, 1), tz),
        group_by: groupBy,
      }),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Credits" breadcrumbs={crumbs} />
        <ErrorState error={e} thing="credits report" retry />
      </>
    );
  }

  // Burn, runway and packs: read for the refused-usage dates. A failed read hides the section.
  const win = { start: rfrom, end: rto, grain: "month" as const };
  const extra = await queryAnalytics({
    business: biz,
    currency,
    queries: [
      { key: "burn", measure: "credit_burn_rate", grain: "day", range: "7d" },
      {
        key: "runway",
        measure: "credit_runway_customers",
        split: "runway_band",
        grain: "day",
        range: "7d",
      },
      { key: "packs", measure: "credit_packs_sold", ...win },
      { key: "pack_revenue", measure: "revenue_billed", split: "revenue_type", ...win },
      { key: "recognized", measure: "credits_used_cost", ...win },
      // Credit in a unit with no money value, in its own units.
      {
        key: "u_balance",
        measure: "credit_units_outstanding",
        split: "credit_unit",
        grain: "day",
        range: "7d",
      },
      {
        key: "u_used30",
        measure: "credit_units_used",
        split: "credit_unit",
        range: "30d",
        grain: "month",
      },
      { key: "u_granted", measure: "credit_units_granted", split: "credit_unit", ...win },
      { key: "u_used", measure: "credit_units_used", split: "credit_unit", ...win },
      { key: "u_expired", measure: "credit_units_expired", split: "credit_unit", ...win },
    ],
  }).catch(() => [] as BatchEntry[]);
  const burn = pick(extra, "burn")?.total ?? null;
  const packs = pick(extra, "packs")?.total ?? null;
  const packRevenue = slice(pick(extra, "pack_revenue"), "credit_pack");
  const recognized = pick(extra, "recognized")?.total ?? null;
  const runway = slices(pick(extra, "runway"));
  const inUnit = (slot: string, key: string) =>
    slices(pick(extra, slot)).find((r) => r.key === key)?.total ?? 0;
  const ownUnitKeys = [
    ...new Set(
      ["u_balance", "u_granted", "u_used", "u_expired"].flatMap((k) =>
        slices(pick(extra, k)).map((r) => r.key),
      ),
    ),
  ];
  const ownUnit = (key: string) => unitInfo(units?.data ?? [], key, currency);
  const RUNWAY: Array<{ key: string; label: string; filters: string[] }> = [
    { key: "0_7", label: "7 days or less", filters: ["credit_runway_days:lte:7"] },
    {
      key: "8_30",
      label: "8 to 30 days",
      filters: ["credit_runway_days:gt:7", "credit_runway_days:lte:30"],
    },
    {
      key: "31_90",
      label: "31 to 90 days",
      filters: ["credit_runway_days:gt:30", "credit_runway_days:lte:90"],
    },
    { key: "90_plus", label: "More than 90 days", filters: ["credit_runway_days:gt:90"] },
    { key: "no_recent_use", label: "No use in the last 7 days", filters: [] },
  ];

  const byUnit = new Map<string, RollForwardRow[]>();
  for (const r of roll.data) byUnit.set(r.unit, [...(byUnit.get(r.unit) ?? []), r]);
  const unitName = (key: string) => {
    const name =
      key === "money"
        ? "Credit in money"
        : (units?.data.find((u) => u.id === key)?.plural_name ?? key);
    return name.charAt(0).toUpperCase() + name.slice(1);
  };
  const unitWord = (key: string, amount: number) => {
    const u = units?.data.find((x) => x.id === key);
    return (Math.abs(amount) === 1 ? u?.name : u?.plural_name) ?? key;
  };
  // Leading months with no figure at all are noise: start at the first month with one.
  const fromFirstFigure = (rows: RollForwardRow[]) => {
    const i = rows.findIndex((r) =>
      [
        r.opening_minor,
        r.sold_minor,
        r.recognised_minor,
        r.breakage_minor,
        r.refunds_minor,
        r.other_minor,
        r.closing_minor,
        r.credited_minor,
      ].some((x) => x !== 0),
    );
    return i < 0 ? rows.slice(-1) : rows.slice(i);
  };
  const currencies = Array.from(
    new Set([currency, b?.default_currency, ...(b?.currencies ?? [])].filter(Boolean)),
  ).map((x) => String(x).toUpperCase());
  const ledger = roll.ledger_closing.find((l) => l.currency === currency);
  const closingAll = roll.data
    .filter((r) => r.month === to)
    .reduce((s, r) => s + r.closing_minor, 0);
  const groupLabel = GROUPS.find((g) => g.value === groupBy)!.label;
  const groupCell = (r: (typeof refused.data)[number]) =>
    groupBy === "customer" && r.customer ? (
      <Link
        href={`/businesses/${biz}/customers/${r.customer}`}
        className="text-primary hover:underline"
      >
        {r.customer_name || r.customer}
      </Link>
    ) : groupBy === "day" && r.day ? (
      <span className="tabular-nums">{fmtDate(localMidnightIso(r.day, tz), tz)}</span>
    ) : (
      <span>{r.meter_name || r.meter}</span>
    );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Credits"
        breadcrumbs={crumbs}
        description="Paid credit not yet used, month by month, and the usage we refused because a customer did not have enough credit."
      />

      <RecordCard title="Deferred credit revenue">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="rfrom" value={rfrom} />
          <input type="hidden" name="rto" value={rto} />
          <input type="hidden" name="group_by" value={groupBy} />
          <div className="flex w-40 flex-col gap-1.5">
            <span className="text-sm font-medium">From</span>
            <SelectField
              name="from"
              defaultValue={from}
              ariaLabel="From month"
              options={months.map((m) => ({ value: m, label: monthLabel(m) }))}
            />
          </div>
          <div className="flex w-40 flex-col gap-1.5">
            <span className="text-sm font-medium">To</span>
            <SelectField
              name="to"
              defaultValue={to}
              ariaLabel="To month"
              options={months.map((m) => ({ value: m, label: monthLabel(m) }))}
            />
          </div>
          <div className="flex w-32 flex-col gap-1.5">
            <span className="text-sm font-medium">Currency</span>
            <SelectField
              name="currency"
              defaultValue={currency}
              ariaLabel="Currency"
              options={currencies.map((x) => ({ value: x, label: x }))}
            />
          </div>
          <div className="flex w-48 flex-col gap-1.5">
            <span className="text-sm font-medium">Unit</span>
            <SelectField
              name="unit"
              defaultValue={unit}
              ariaLabel="Unit"
              options={[
                { value: "", label: "All units" },
                { value: "money", label: "Credit in money" },
                ...(units?.data ?? []).map((u) => ({ value: u.id, label: u.plural_name })),
              ]}
            />
          </div>
          <Button type="submit" variant="outline">
            View report
          </Button>
        </form>
      </RecordCard>

      {byUnit.size === 0 ? (
        <RecordCard title="By month" flush>
          <EmptyState
            title="No paid credit"
            description={`No customer bought credit in ${currency}${unit ? `, in ${unit === "money" ? "money" : unitWord(unit, 2)},` : ""} up to ${monthLabel(to)}.`}
          />
        </RecordCard>
      ) : (
        [...byUnit].map(([key, all]) => {
          const t = rollTotals(all);
          const rows = fromFirstFigure(all);
          return (
            <RecordCard
              key={key}
              title={unitName(key)}
              meta={`${monthLabel(from)} to ${monthLabel(to)} · ${currency}`}
              flush
            >
              <Table phone="stack">
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">Month</TableHead>
                    <TableHead className="text-right">Opening</TableHead>
                    <TableHead className="text-right">Sold</TableHead>
                    <TableHead className="text-right">Recognized</TableHead>
                    <TableHead className="text-right">Breakage</TableHead>
                    <TableHead className="text-right">Refunds</TableHead>
                    <TableHead className="text-right">Other</TableHead>
                    <TableHead phone="aside" className="text-right">
                      Closing
                    </TableHead>
                    <TableHead className="pr-5 text-right">Credit notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.month}>
                      <TableCell className="pl-5">{monthLabel(r.month)}</TableCell>
                      <TableCell className="text-right">
                        {money(r.opening_minor, currency)}
                      </TableCell>
                      <TableCell className="text-right">{money(r.sold_minor, currency)}</TableCell>
                      <TableCell className="text-right">
                        {money(r.recognised_minor, currency)}
                      </TableCell>
                      <TableCell className="text-right">
                        {money(r.breakage_minor, currency)}
                      </TableCell>
                      <TableCell className="text-right">
                        {money(r.refunds_minor, currency)}
                      </TableCell>
                      <TableCell className="text-right">{money(r.other_minor, currency)}</TableCell>
                      <TableCell className="text-right">
                        {money(r.closing_minor, currency)}
                      </TableCell>
                      <TableCell className="pr-5 text-right">
                        {money(r.credited_minor, currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell className="pl-5 font-medium">Total for the range</TableCell>
                    <TableCell className="text-right font-medium">
                      {money(t.opening_minor, currency)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {money(t.sold_minor, currency)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {money(t.recognised_minor, currency)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {money(t.breakage_minor, currency)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {money(t.refunds_minor, currency)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {money(t.other_minor, currency)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {money(t.closing_minor, currency)}
                    </TableCell>
                    <TableCell className="pr-5 text-right font-medium">
                      {money(t.credited_minor, currency)}
                    </TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </RecordCard>
          );
        })
      )}
      {ledger && !unit ? (
        <p className="text-xs text-muted-foreground">
          {closingAll === ledger.credit_grants_paid_minor
            ? `The closing balance of every unit together, ${money(closingAll, currency)}, is equal to the deferred credit revenue in the ledger.`
            : `The closing balance of every unit together is ${money(closingAll, currency)}, but the ledger shows ${money(ledger.credit_grants_paid_minor, currency)}. These must be equal. Contact support.`}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Amounts are what customers paid for the credit. Sold is paid credit that became available.
        Recognized is credit used, less credit given back. Breakage is credit that expired. Refunds
        is unused credit voided by a credit note. Other is credit moved between grants by a
        rollover. Credit notes is what credit notes gave back on the packs. A full refund also gives
        back credit that was used, so it can be more than Refunds. It is not part of the balance.
        Credit on an invoice that is not paid yet is not included. Months are in the business time
        zone.
      </p>

      <RecordCard title="Burn rate and runway" meta="Now. We keep no history of these figures.">
        <Grid className="gap-4">
          {ownUnitKeys.length > 0 && !burn ? null : (
            <Headline
              span={4}
              label="Credit burn rate"
              value={burn == null ? "—" : money(burn, currency)}
              note="Credit used per day, averaged over the last 30 days"
            />
          )}
          {ownUnitKeys.map((key) => {
            const u = ownUnit(key);
            return (
              <Headline
                key={key}
                span={4}
                label={`Burn rate in ${u.plural}`}
                value={fmtUnits(Math.round(inUnit("u_used30", key) / 30), u)}
                note="Used per day, averaged over the last 30 days"
              />
            );
          })}
        </Grid>
        <div className="mt-4">
          <BarList
            rows={RUNWAY.map((b) => ({
              key: b.key,
              label: b.label,
              total: runway.find((r) => r.key === b.key)?.total ?? 0,
              href: b.filters.length
                ? `/businesses/${biz}/customers?${b.filters.map((f) => `filter=${f}`).join("&")}`
                : null,
            }))}
            format={(n) => n.toLocaleString("en")}
          />
        </div>
      </RecordCard>
      {ownUnitKeys.length > 0 ? (
        <RecordCard
          title="Credit with no money value"
          meta={`Balance now. Granted, used and expired in ${fmtRange(rfrom, rto, tz)}.`}
          flush
        >
          <Table phone="stack">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Unit</TableHead>
                <TableHead phone="aside" className="text-right">
                  Balance now
                </TableHead>
                <TableHead className="text-right">Granted</TableHead>
                <TableHead className="text-right">Used</TableHead>
                <TableHead className="pr-5 text-right">Expired</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ownUnitKeys.map((key) => {
                const u = ownUnit(key);
                return (
                  <TableRow key={key}>
                    <TableCell className="pl-5">{unitName(key)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {unitCount(inUnit("u_balance", key), u)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {unitCount(inUnit("u_granted", key), u)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {unitCount(inUnit("u_used", key), u)}
                    </TableCell>
                    <TableCell className="pr-5 text-right tabular-nums">
                      {unitCount(inUnit("u_expired", key), u)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </RecordCard>
      ) : null}
      <RecordCard title="Credit packs" meta={`Sold ${fmtRange(rfrom, rto, tz)} · ${currency}`}>
        <Grid className="gap-4">
          <Headline
            span={4}
            label="Packs sold"
            value={packs == null ? "—" : packs.toLocaleString("en")}
          />
          <Headline
            span={4}
            label="Pack sales billed"
            value={packRevenue == null ? "—" : money(packRevenue, currency)}
            note="Counted when the pack is sold"
          />
          <Headline
            span={4}
            label="Revenue recognized"
            value={recognized == null ? "—" : money(recognized, currency)}
            note="Counted when customers use the credit"
          />
        </Grid>
      </RecordCard>

      <RecordCard title="Refused usage">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="from" value={from} />
          <input type="hidden" name="to" value={to} />
          <input type="hidden" name="currency" value={currency} />
          <input type="hidden" name="unit" value={unit} />
          <div className="flex w-44 flex-col gap-1.5">
            <label htmlFor="rfrom" className="text-sm font-medium">
              From
            </label>
            <DateInput
              id="rfrom"
              name="rfrom"
              label="From"
              defaultValue={rfrom}
              max={rto}
              tz={tz}
            />
          </div>
          <div className="flex w-44 flex-col gap-1.5">
            <label htmlFor="rto" className="text-sm font-medium">
              To
            </label>
            <DateInput
              id="rto"
              name="rto"
              label="To"
              defaultValue={rto}
              min={rfrom}
              max={today}
              tz={tz}
            />
          </div>
          <div className="flex w-40 flex-col gap-1.5">
            <span className="text-sm font-medium">Group by</span>
            <SelectField
              name="group_by"
              defaultValue={groupBy}
              ariaLabel="Group by"
              options={GROUPS.map((g) => ({ value: g.value, label: g.label }))}
            />
          </div>
          <Button type="submit" variant="outline">
            View report
          </Button>
        </form>
      </RecordCard>
      <RecordCard
        title={`Refused usage by ${groupLabel.toLowerCase()}`}
        meta={`Received ${fmtRange(rfrom, rto, tz)}`}
        flush
      >
        {refused.data.length === 0 ? (
          <EmptyState
            title="No refused usage"
            description="No usage event was refused for lack of credit in this range."
          />
        ) : (
          <Table phone="stack">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">{groupLabel}</TableHead>
                {groupBy === "meter" ? null : <TableHead>Meter</TableHead>}
                <TableHead className="text-right">Events</TableHead>
                {groupBy === "customer" ? null : (
                  <TableHead className="text-right">Customers</TableHead>
                )}
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead phone="aside" className="pr-5 text-right">
                  Credits
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {refused.data.map((r, i) => (
                <TableRow key={`${r.day ?? r.customer ?? ""}-${r.meter}-${i}`}>
                  <TableCell className="pl-5">{groupCell(r)}</TableCell>
                  {groupBy === "meter" ? null : <TableCell>{r.meter_name || r.meter}</TableCell>}
                  <TableCell className="text-right">
                    {r.refused_events.toLocaleString("en-US")}
                  </TableCell>
                  {groupBy === "customer" ? null : (
                    <TableCell className="text-right">
                      {r.customers.toLocaleString("en-US")}
                    </TableCell>
                  )}
                  <TableCell className="text-right tabular-nums">
                    {Number(r.refused_quantity).toLocaleString("en-US")}
                  </TableCell>
                  <TableCell className="pr-5 text-right tabular-nums">
                    {Number(r.refused_units_decimal).toLocaleString("en-US", {
                      maximumFractionDigits: 4,
                    })}{" "}
                    {unitWord(r.unit, Number(r.refused_units_decimal))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </RecordCard>
      <p className="text-xs text-muted-foreground">
        Refused usage is demand you did not serve. It is not in any usage total, allowance or
        invoice. Credits is what the refused usage would have cost.
      </p>
    </div>
  );
}

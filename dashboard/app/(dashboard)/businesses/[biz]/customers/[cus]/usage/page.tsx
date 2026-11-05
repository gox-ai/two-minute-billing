import Link from "next/link";
import { getCustomer, listBusinesses } from "@/lib/api";
import { getCustomerCurrentUsage, type CurrentUsage } from "@/lib/api/current-usage";
import { getCustomerUsageHistory } from "@/lib/api/model-prices";
import { listMeters } from "@/lib/api/meters";
import { getTimeTravel } from "@/lib/api/time-travel";
import { allows, requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { RecordCard } from "@/components/patterns/record-page";
import { Chip } from "@/components/patterns/chip";
import { EmptyState } from "@/components/states";
import { Alert } from "@/components/ui/alert";
import { SEGMENT_TRACK, segmentItem } from "@/components/ui/segmented";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UsageDailyChart, type DailyPoint } from "@/components/usage/usage-daily-chart";
import { UnpricedModelsBanner, type UnpricedKey } from "@/components/usage/unpriced-models-banner";
import { fmtDate, money } from "@/lib/format";
import { formatDecimalQuantity } from "@/lib/meters";
import {
  PRICE_SOURCE_LABEL,
  localDate,
  localMidnightIso,
  minusDays,
  plusDays,
} from "@/lib/model-prices";

export const dynamic = "force-dynamic";

const RANGES = [7, 30, 90] as const;

const groupText = (g: Record<string, string> | null | undefined) =>
  g && Object.keys(g).length
    ? Object.entries(g)
        .map(([, v]) => v)
        .join(" · ")
    : "All usage";

interface PeriodRow {
  key: string;
  sub: string;
  item: string;
  meter: string | null;
  group: Record<string, string> | null;
  quantity: string;
  amount: number;
  projected: number | null;
  source: string | null;
  cost: number | null | undefined;
  currency: string;
}

function periodRows(u: CurrentUsage): PeriodRow[] {
  return u.items.flatMap((i): PeriodRow[] =>
    i.combinations?.length
      ? i.combinations.map((c, k) => ({
          key: `${u.subscription}-${i.item ?? i.name}-${k}`,
          sub: u.subscription ?? "",
          item: i.name,
          meter: null,
          group: c.group,
          quantity: c.quantity,
          amount: c.amount_minor,
          projected: c.projected_amount_minor ?? null,
          source: c.price_source ?? null,
          cost: c.cost_minor,
          currency: u.currency,
        }))
      : [
          {
            key: `${u.subscription}-${i.item ?? i.name}`,
            sub: u.subscription ?? "",
            item: i.name,
            meter: null,
            group: null,
            quantity: String(i.quantity),
            amount: i.amount_minor,
            projected: i.projected_amount_minor,
            source: null,
            cost: undefined,
            currency: u.currency,
          },
        ],
  );
}

/**
 * Customer → Usage (design G1b § 5.3): this period by meter and model with the projected
 * amount, usage by day, and cost and margin for people with `usage_margin:view`.
 */
export default async function CustomerUsagePage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string; cus: string }>;
  searchParams: Promise<{ days?: string }>;
}) {
  const me = await requirePermission("usage:view", "ops");
  const canSeeCost = allows(me, "usage_margin:view", "manager");
  const canManagePrices = allows(me, "model_prices:manage", "manager");
  const { biz, cus } = await params;
  const { days: daysParam } = await searchParams;
  const days = RANGES.find((d) => String(d) === daysParam) ?? 30;

  const [businesses, clock] = await Promise.all([
    listBusinesses().catch(() => null),
    getTimeTravel(biz).catch(() => null),
  ]);
  const b = businesses?.data.find((x) => x.id === biz);
  const tz = b?.timezone ?? null;
  // A time-travelled business ends the range on its simulated day, like its billing clock.
  const now =
    clock?.status === "in_progress" && clock.simulated_now
      ? new Date(clock.simulated_now)
      : new Date();
  const to = localDate(tz, now);
  const from = minusDays(to, days - 1);

  const [customer, current, history, meters] = await Promise.all([
    getCustomer(biz, cus).catch(() => null),
    getCustomerCurrentUsage(biz, cus).catch(() => null),
    getCustomerUsageHistory(biz, cus, {
      from: localMidnightIso(from, tz),
      to: localMidnightIso(plusDays(to, 1), tz),
      includeCost: canSeeCost,
      currency: b?.default_currency ?? undefined,
    }).catch((e: Error) => e),
    listMeters(biz).catch(() => null),
  ]);

  const custHref = `/businesses/${biz}/customers/${cus}`;
  const name = customer?.name || customer?.email || cus;
  const crumbs = [
    { label: b?.name ?? biz, href: `/businesses/${biz}` },
    { label: "Customers", href: `/businesses/${biz}/customers` },
    { label: name, href: custHref },
    { label: "Usage" },
  ];

  const modelKey = (meter: string) =>
    meters?.data.find((m) => m.id === meter)?.price_list?.model_key || "model";
  const rows = (current?.data ?? []).flatMap(periodRows);
  // One entry per list key where the token type is known, so "Set your cost" can prefill it.
  const unpricedMap = new Map<string, UnpricedKey>();
  for (const i of (current?.data ?? []).flatMap((u) => u.items)) {
    const keys = i.unpriced_keys ?? [];
    for (const k of keys) unpricedMap.set(JSON.stringify(k), k);
    for (const m of i.unpriced_models ?? [])
      if (!keys.some((k) => k.model === m))
        unpricedMap.set(JSON.stringify([m]), { provider: null, model: m, token_type: null });
  }
  const unpriced = [...unpricedMap.values()];
  const currencies = Array.from(
    new Set([b?.default_currency, ...(b?.currencies ?? [])].filter((x): x is string => !!x)),
  );

  const hist = history instanceof Error ? null : history;
  const points: DailyPoint[] = (hist?.data ?? []).map((r) => ({
    date: r.date,
    series: r.group[modelKey(r.meter)] ?? r.meter,
    quantity: Number(r.quantity) || 0,
  }));
  // Range totals by meter and model, folded from the day rows.
  const totals = new Map<
    string,
    { meter: string; model: string; quantity: number; cost: number | null; currency: string | null }
  >();
  for (const r of hist?.data ?? []) {
    const model = r.group[modelKey(r.meter)] ?? "—";
    const k = `${r.meter}|${model}`;
    const t = totals.get(k) ?? {
      meter: r.meter,
      model,
      quantity: 0,
      cost: r.cost_minor == null ? null : 0,
      currency: hist?.currency ?? null,
    };
    t.quantity += Number(r.quantity) || 0;
    if (r.cost_minor != null) t.cost = (t.cost ?? 0) + r.cost_minor;
    totals.set(k, t);
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Usage"
        breadcrumbs={crumbs}
        description={`Usage of ${name}: this billing period, and usage by day.`}
      />

      {unpriced.length ? (
        <UnpricedModelsBanner
          keys={unpriced}
          canManage={canManagePrices}
          currencies={currencies}
          currency={current?.data[0]?.currency ?? b?.default_currency ?? "USD"}
        />
      ) : null}

      <RecordCard
        title="This period"
        meta={current?.totals.map((t) => `${money(t.total_minor, t.currency)} so far`).join(" · ")}
        flush
      >
        {!current ? (
          <div className="px-5 py-4">
            <Alert tone="error">We could not load the usage of this period. Try again.</Alert>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No usage this period"
            description="The customer has no metered subscription, or no usage in its open period."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Item</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Projected amount</TableHead>
                {canSeeCost ? <TableHead className="text-right">Cost</TableHead> : null}
                {canSeeCost ? <TableHead className="pr-5 text-right">Margin</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="pl-5">
                    <div className="font-medium">{r.item}</div>
                    <Link
                      href={`/businesses/${biz}/subscriptions/${r.sub}?from=customer#usage`}
                      className="font-mono text-xs text-primary hover:underline"
                    >
                      {r.sub}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="font-mono text-sm">{groupText(r.group)}</div>
                    {r.source && r.source !== "model_price_list" ? (
                      <div className="text-xs text-muted-foreground">
                        {PRICE_SOURCE_LABEL[r.source] ?? r.source}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">{formatDecimalQuantity(r.quantity)}</TableCell>
                  <TableCell className="text-right">{money(r.amount, r.currency)}</TableCell>
                  <TableCell className="text-right">
                    {r.projected == null ? (
                      "—"
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        <Chip tone="gray">Estimate</Chip>
                        {money(r.projected, r.currency)}
                      </span>
                    )}
                  </TableCell>
                  {canSeeCost ? (
                    <TableCell className="text-right">
                      {r.cost == null ? "—" : money(r.cost, r.currency)}
                    </TableCell>
                  ) : null}
                  {canSeeCost ? (
                    <TableCell className="pr-5 text-right">
                      {r.cost == null ? "—" : money(r.amount - r.cost, r.currency)}
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {current && rows.length ? (
          <p className="border-t px-5 py-3 text-xs text-muted-foreground">
            Amounts are before discounts, credits and tax. A projected amount is an estimate: it
            rates the usage at the end of the period if it continues at the current rate. The final
            amount can be different.
            {canSeeCost ? " Margin so far is the amount minus the cost." : ""}
          </p>
        ) : null}
      </RecordCard>

      <RecordCard
        title="Usage by day"
        meta={`${fmtDate(from, "UTC")} to ${fmtDate(to, "UTC")}${tz ? ` · ${tz}` : ""}`}
        actions={
          <nav className={SEGMENT_TRACK} aria-label="Range">
            {RANGES.map((d) => (
              <Link key={d} href={`?days=${d}`} className={segmentItem(d === days)} scroll={false}>
                {d} days
              </Link>
            ))}
          </nav>
        }
      >
        {history instanceof Error ? (
          <Alert tone="error">We could not load the usage by day. Try again.</Alert>
        ) : (
          <div className="flex flex-col gap-4">
            <UsageDailyChart points={points} from={from} to={to} />
            {totals.size ? (
              <div className="overflow-x-auto rounded-xl border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-5">Meter</TableHead>
                      <TableHead>Model</TableHead>
                      <TableHead className="text-right">Quantity</TableHead>
                      {canSeeCost ? <TableHead className="pr-5 text-right">Cost</TableHead> : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...totals.values()]
                      .sort((a, z) => z.quantity - a.quantity)
                      .map((t) => (
                        <TableRow key={`${t.meter}|${t.model}|${t.currency ?? ""}`}>
                          <TableCell className="pl-5 font-mono">{t.meter}</TableCell>
                          <TableCell className="font-mono">{t.model}</TableCell>
                          <TableCell className="text-right">
                            {t.quantity.toLocaleString("en-US")}
                          </TableCell>
                          {canSeeCost ? (
                            <TableCell className="pr-5 text-right">
                              {t.cost == null || !t.currency ? "—" : money(t.cost, t.currency)}
                            </TableCell>
                          ) : null}
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
          </div>
        )}
      </RecordCard>
    </div>
  );
}

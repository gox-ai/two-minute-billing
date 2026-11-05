import Link from "next/link";
import { RecordCard } from "@/components/patterns/record-page";
import { getCustomerCurrentUsage } from "@/lib/api/current-usage";
import { fmtDate, money } from "@/lib/format";

/**
 * Usage so far on each of the customer's metered subscriptions, with totals per currency.
 * Renders nothing without one. Currencies are never added together.
 */
export async function CustomerUsageCard({
  biz,
  cus,
  tz,
}: {
  biz: string;
  cus: string;
  tz?: string | null;
}) {
  const usage = await getCustomerCurrentUsage(biz, cus).catch(() => null);
  if (!usage || usage.data.length === 0) return null;
  return (
    <RecordCard
      id="usage"
      title="Usage this period"
      meta={usage.totals.map((t) => `${money(t.total_minor, t.currency)} so far`).join(" · ")}
      actions={
        <Link
          href={`/businesses/${biz}/customers/${cus}/usage`}
          className="text-sm text-primary hover:underline"
        >
          View usage by model and day
        </Link>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <div className="overflow-x-auto">
          <div className="min-w-[36rem]">
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_8rem] gap-x-4 border-b py-2 text-xs font-medium text-muted-foreground">
              <span>Subscription</span>
              <span>Period</span>
              <span className="text-right">Total so far</span>
              <span className="text-right">Projected total</span>
            </div>
            {usage.data.map((u) => (
              <div
                key={u.subscription}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_8rem] gap-x-4 border-b border-border/40 py-3 tabular-nums"
              >
                <Link
                  href={`/businesses/${biz}/subscriptions/${u.subscription}?from=customer#usage`}
                  className="truncate font-mono text-xs text-primary hover:underline"
                >
                  {u.subscription}
                </Link>
                <span className="text-muted-foreground">
                  {u.window
                    ? `${fmtDate(u.window.start, tz)} to ${fmtDate(u.window.end, tz)}`
                    : "—"}
                </span>
                <span className="text-right">{money(u.total_minor, u.currency)}</span>
                <span className="text-right text-muted-foreground">
                  {u.projection ? money(u.projection.total_minor, u.currency) : "—"}
                </span>
              </div>
            ))}
          </div>
        </div>
        {usage.totals.length > 1 ? (
          <ul className="flex flex-col gap-1 tabular-nums">
            {usage.totals.map((t) => (
              <li key={t.currency} className="flex justify-between gap-4">
                <span className="text-muted-foreground">Total in {t.currency}</span>
                <span>
                  {money(t.total_minor, t.currency)}
                  {t.projected_total_minor != null
                    ? ` · projected ${money(t.projected_total_minor, t.currency)}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {usage.has_more ? (
          <p className="text-xs text-muted-foreground">
            This list shows the 50 newest metered subscriptions. The totals include only these.
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Totals include tax. They do not include discounts or credits.
        </p>
      </div>
    </RecordCard>
  );
}

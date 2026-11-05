import { portalSubscriptionUsage, portalSubscriptionUsageDaily } from "@/lib/portal-api";
import { UsageDailyChart } from "@/components/usage/usage-daily-chart";
import { formatDecimalQuantity } from "@/lib/meters";
import { localDate } from "@/lib/model-prices";
import { readStorefrontToken } from "@/lib/storefront-session";
import { hasUsage } from "@/lib/api/current-usage";
import { fmtDate, money } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";

const units = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "unit" : "units"}`;

/**
 * Usage so far on one metered subscription. Loaded per subscription inside Suspense, so
 * the plan renders first. Renders nothing when the business hides usage (404).
 */
export async function PortalUsage({
  subscription,
  tz,
}: {
  subscription: string;
  tz?: string | null;
}) {
  const token = await readStorefrontToken("portal");
  if (!token) return null;
  const [res, daily] = await Promise.all([
    portalSubscriptionUsage(token, subscription).catch(() => null),
    portalSubscriptionUsageDaily(token, subscription).catch(() => null),
  ]);
  const u = res?.ok ? res.data : null;
  if (!hasUsage(u)) return null;
  const days = daily?.ok ? daily.data : null;
  const c = u.currency;
  return (
    <div className="border-t px-5 py-4">
      <div className="mb-2 text-xs font-medium tracking-widest text-muted-foreground uppercase">
        Usage this period
      </div>
      {u.window ? (
        <>
          <div className="mb-2 text-sm text-muted-foreground">
            Since {fmtDate(u.window.start, tz)}
          </div>
          <ul className="flex flex-col gap-1.5 text-sm">
            {u.items.map((i, k) => (
              <li key={`${i.name}-${k}`} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate">
                  {i.name}{" "}
                  <span className="text-muted-foreground tabular-nums">· {units(i.quantity)}</span>
                </span>
                <span className="shrink-0 tabular-nums">{money(i.amount_minor, c)}</span>
              </li>
            ))}
            {u.items
              .filter((i) => i.combinations?.length)
              .flatMap((i) =>
                i.combinations!.map((cb, k) => (
                  <li
                    key={`${i.name}-combo-${k}`}
                    className="flex items-baseline justify-between gap-3 pl-3 text-muted-foreground"
                  >
                    <span className="min-w-0 truncate">
                      <span className="font-mono">
                        {Object.values(cb.group).join(" · ") || i.name}
                      </span>{" "}
                      <span className="tabular-nums">· {formatDecimalQuantity(cb.quantity)}</span>
                    </span>
                    <span className="shrink-0 tabular-nums">{money(cb.amount_minor, c)}</span>
                  </li>
                )),
              )}
            {u.settled_charges.map((s, k) => (
              <li key={`settled-${k}`} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate">
                  {s.name}{" "}
                  <span className="text-muted-foreground tabular-nums">· {units(s.quantity)}</span>
                </span>
                <span className="shrink-0 tabular-nums">{money(s.amount_minor, c)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-col gap-1">
            {u.tax_lines.map((t) => (
              <div
                key={t.label}
                className="flex items-center justify-between gap-3 text-xs text-muted-foreground"
              >
                <span>{t.label}</span>
                <span className="tabular-nums">{money(t.amount_minor, c)}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-3">
            <span className="text-sm text-muted-foreground">Total so far, with tax</span>
            <span className="font-semibold tabular-nums">{money(u.total_minor, c)}</span>
          </div>
          {u.projection ? (
            <>
              <div className="mt-1 flex items-baseline justify-between gap-3 text-sm text-muted-foreground">
                <span>Projected total at the end of the period</span>
                <span className="tabular-nums">{money(u.projection.total_minor, c)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Estimate. The final amount can be different.
              </p>
            </>
          ) : null}
          {days && days.data.length ? (
            <div className="mt-3">
              <div className="mb-1 text-sm text-muted-foreground">Usage by day</div>
              <UsageDailyChart
                points={days.data.map((r) => ({
                  date: r.date,
                  series: r.group.model ?? Object.values(r.group)[0] ?? r.meter,
                  quantity: Number(r.quantity) || 0,
                }))}
                from={localDate(days.time_zone, new Date(days.from))}
                to={localDate(days.time_zone, new Date(Date.parse(days.to) - 1))}
                height={180}
              />
            </div>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">
            These amounts do not include discounts or credits.
          </p>
        </>
      ) : null}
      {u.trial && u.trial.items.length > 0 ? (
        <>
          <div className="mb-1 text-sm text-muted-foreground">Usage during your trial</div>
          <ul className="flex flex-col gap-1 text-sm">
            {u.trial.items.map((t, k) => (
              <li key={`${t.name}-${k}`} className="flex justify-between gap-3">
                <span className="min-w-0 truncate">{t.name}</span>
                <span className="shrink-0 tabular-nums">{units(t.quantity)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export function PortalUsageSkeleton() {
  return (
    <div className="border-t px-5 py-4" aria-busy="true" aria-label="Loading usage">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="mt-3 h-10 w-full" />
    </div>
  );
}

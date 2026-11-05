import { money } from "@/lib/format";
import { FigureTile, FigureTiles } from "@/components/patterns/record-page";
import type { MoneyByCurrency, UsageStats } from "@/lib/api/catalog-stats";

/**
 * The business's default currency as the figure, the rest as "+ …" by code. MRR is never summed
 * across currencies, and raw minor units cannot be compared across them either.
 */
export function mrrParts(
  mrr: MoneyByCurrency[],
  primary: string | null | undefined,
): { value: string; rest: string | null } {
  const live = mrr.filter((m) => m.amount_minor !== 0);
  if (live.length === 0) return { value: "—", rest: null };
  const byCode = [...live].sort((a, b) => a.currency.localeCompare(b.currency));
  // A book with nothing in the business's currency leads with what it does have, not a zero.
  const first = byCode.find((m) => m.currency === primary) ?? byCode[0];
  const rest = byCode.filter((m) => m !== first);
  return {
    value: money(first.amount_minor, first.currency),
    rest: rest.length
      ? `+ ${rest.map((m) => money(m.amount_minor, m.currency)).join(" · ")}`
      : null,
  };
}

/** The catalog record page's figure row: Active subscriptions + MRR. Nothing without stats. */
export function UsageTiles({
  stats,
  scope,
  currency,
}: {
  stats: UsageStats | null;
  scope: string;
  /** The business's default currency; it leads even when another currency is larger. */
  currency: string | null | undefined;
}) {
  if (!stats) return null;
  const mrr = mrrParts(stats.mrr, currency);
  return (
    <FigureTiles cols={2}>
      <FigureTile
        label="Active subscriptions"
        value={stats.active_subscriptions.toLocaleString()}
        note={
          stats.in_trial_subscriptions
            ? `${stats.in_trial_subscriptions} in trial`
            : "None in trial"
        }
      />
      <FigureTile label="MRR" value={mrr.value} note={mrr.rest ?? `From this ${scope}`} />
    </FigureTiles>
  );
}

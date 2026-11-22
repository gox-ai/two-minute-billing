import { money } from "@/lib/format";
import { fmtDate } from "@/lib/format-date";
import { runwayLabel } from "@/lib/usage-controls";
import type { PortalCreditRunway, PortalSpendLimit } from "@/lib/portal-api";
import { Row, RowList, StorefrontSection } from "../../chrome";
import { AddLimitButton, OwnLimitActions } from "./portal-limit-forms";

const PER: Record<PortalSpendLimit["interval"], string> = {
  day: "per day",
  week: "per week",
  month: "per month",
  period: "per billing period",
};

/** Used against the limit. Neutral until near it; red once reached. */
function LimitMeter({ spent, limit }: { spent: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 100;
  const fill = spent >= limit ? "bg-destructive" : pct >= 80 ? "bg-warning" : "bg-foreground/60";
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuenow={Math.min(spent, limit)}
      className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div className={`h-full rounded-full ${fill}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Credit runway and spend limits (design G5 § 5, Decision 7): the buyer sees the business's
 * limits read-only, and adds, lowers or deletes its own. "Add limit" only where the engine
 * says the buyer may add one (`can_add`).
 */
export function PortalUsageControlsSection({
  runway,
  limits,
  canAdd,
  business,
  currency,
  tz,
}: {
  runway: PortalCreditRunway | null;
  limits: PortalSpendLimit[] | null;
  canAdd: boolean;
  /** The business name, for limits it set. */
  business: string;
  currency: string;
  tz: string | null;
}) {
  if (!runway && !limits) return null;
  const runwayText = runwayLabel(runway?.runway_days ?? null, runway);
  return (
    <StorefrontSection
      title="Usage limits"
      description="Stop your usage when it reaches an amount."
      action={canAdd ? <AddLimitButton currency={currency} /> : undefined}
      bodyClassName="p-0"
    >
      <RowList>
        {runway && (runway.balance_minor > 0 || runway.runway_days != null) ? (
          <Row className="flex-row items-center gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">{runwayText}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  An estimate from your usage in the last 7 days
                  {runway.runs_out_at && runway.runway_days != null
                    ? ` · about ${fmtDate(runway.runs_out_at, tz)}`
                    : ""}
                </div>
              </div>
            </div>
            <div className="shrink-0 text-right text-sm font-semibold tabular-nums">
              {money(runway.balance_minor, runway.currency)}
            </div>
          </Row>
        ) : null}
        {limits?.length ? (
          limits.map((l) => {
            const limit = l.effective_amount_minor ?? l.amount_minor;
            return (
              <li key={l.id} className="px-5 py-3.5">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="font-medium">
                      {l.scope === "customer"
                        ? "All your usage"
                        : `${l.property_key} ${l.property_value ?? "(each value)"}`}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {l.editable ? "Your limit" : `Set by ${business}`}
                      {l.resets_at ? ` · resets ${fmtDate(l.resets_at, tz)}` : ""}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-sm tabular-nums">
                    {l.spent_minor != null ? (
                      <>
                        <span className="font-medium">{money(l.spent_minor, l.currency)}</span>
                        <span className="text-muted-foreground">
                          {" "}
                          of {money(limit, l.currency)}
                        </span>
                      </>
                    ) : (
                      money(limit, l.currency)
                    )}
                    <div className="text-xs text-muted-foreground">{PER[l.interval]}</div>
                  </div>
                </div>
                {l.spent_minor != null ? <LimitMeter spent={l.spent_minor} limit={limit} /> : null}
                {l.reached ? (
                  <p className="m-0 mt-1.5 text-xs text-destructive">
                    You reached this limit. Usage stops until the limit resets.
                  </p>
                ) : null}
                {l.editable ? (
                  <div className="mt-2 flex justify-end">
                    <OwnLimitActions id={l.id} amountMinor={l.amount_minor} currency={l.currency} />
                  </div>
                ) : null}
              </li>
            );
          })
        ) : limits ? (
          <Row>
            <span className="text-sm text-muted-foreground">You have no usage limits.</span>
          </Row>
        ) : null}
      </RowList>
    </StorefrontSection>
  );
}

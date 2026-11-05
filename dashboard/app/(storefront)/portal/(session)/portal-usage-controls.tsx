import { Gauge } from "lucide-react";
import { money, fmtDate } from "@/lib/format";
import { runwayLabel } from "@/lib/usage-controls";
import type { PortalCreditRunway, PortalSpendLimit } from "@/lib/portal-api";
import { Glyph, Row, RowList, StorefrontSection } from "../../chrome";
import { AddLimitButton, OwnLimitActions } from "./portal-limit-forms";

const PER: Record<PortalSpendLimit["interval"], string> = {
  day: "per day",
  week: "per week",
  month: "per month",
  period: "per billing period",
};

/**
 * Credit runway and spend limits (design G5 § 5, Decision 7): the buyer sees the provider's
 * limits read-only, and adds, lowers or deletes its own. Renders nothing when neither loaded.
 */
export function PortalUsageControlsSection({
  runway,
  limits,
  currency,
  tz,
}: {
  runway: PortalCreditRunway | null;
  limits: PortalSpendLimit[] | null;
  currency: string;
  tz: string | null;
}) {
  if (!runway && !limits) return null;
  const runwayText = runwayLabel(runway?.runway_days ?? null);
  return (
    <StorefrontSection
      title="Usage limits"
      description="Stop new requests when your usage reaches an amount."
      action={limits ? <AddLimitButton currency={currency} /> : undefined}
      bodyClassName="p-0"
    >
      <RowList>
        {runway && (runway.balance_minor > 0 || runway.runway_days != null) ? (
          <Row>
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <Glyph>
                <Gauge />
              </Glyph>
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
            <div className="text-right text-sm font-semibold tabular-nums sm:min-w-28">
              {money(runway.balance_minor, runway.currency)}
            </div>
          </Row>
        ) : null}
        {limits?.length ? (
          limits.map((l) => (
            <Row key={l.id}>
              <div className="min-w-0 flex-1 text-sm">
                {l.scope === "customer"
                  ? "All your usage"
                  : `${l.property_key} ${l.property_value ?? "(each value)"}`}
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {l.editable ? "Your limit" : "Set by your provider"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-right text-sm tabular-nums sm:min-w-28">
                  {money(l.effective_amount_minor ?? l.amount_minor, l.currency)} {PER[l.interval]}
                </span>
                {l.editable ? (
                  <OwnLimitActions id={l.id} amountMinor={l.amount_minor} currency={l.currency} />
                ) : null}
              </div>
            </Row>
          ))
        ) : limits ? (
          <Row>
            <span className="text-sm text-muted-foreground">You have no usage limits.</span>
          </Row>
        ) : null}
      </RowList>
    </StorefrontSection>
  );
}

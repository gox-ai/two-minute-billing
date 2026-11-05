"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useNavPending } from "@/components/navigation/nav-pending";
import { SelectField } from "@/components/ui/select-field";
import { CANCELLATION_RANGES, DEFAULT_RANGE } from "./window";
import { CANCELLATION_INTERVALS } from "./cuts";

/**
 * The three cuts this screen answers over, each one a query parameter the server re-reads.
 *
 * Every option here reaches a real filter on the subscriptions list, which is also where a
 * drill-down lands — the period is `canceled_at[between]`, the plan is `plan[is]` and the
 * interval is `billing_period_unit[is]`. Nothing is offered that the engine would ignore,
 * so a narrowed heading can never sit over an unnarrowed figure.
 *
 * The choice lives in the URL rather than in state: the link is shareable, Back works, and
 * the figures are re-counted by the server instead of re-sliced in the browser from a page
 * of rows that was never the whole answer.
 */
export function CancellationFilters({
  range,
  plan,
  interval,
  plans,
}: {
  range: string;
  plan: string;
  interval: string;
  /** Plan products, from the business's own catalogue. Empty when it has none. */
  plans: Array<{ id: string; name: string }>;
}) {
  const { navigate, pendingFrom } = useNavPending();
  const pending = pendingFrom("filters");
  const pathname = usePathname();
  const params = useSearchParams();

  const go = (key: string, value: string, isDefault: boolean) => {
    const next = new URLSearchParams(params.toString());
    // The default stays out of the URL, so the common link is the clean one.
    if (!value || isDefault) next.delete(key);
    else next.set(key, value);
    const q = next.toString();
    navigate(q ? `${pathname}?${q}` : pathname, { source: "filters" });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="w-44">
        <SelectField
          size="sm"
          ariaLabel="Period"
          value={range}
          onValueChange={(v) => go("range", v, v === DEFAULT_RANGE)}
          options={CANCELLATION_RANGES.map((r) => ({ value: r.id, label: r.label }))}
        />
      </div>
      {/*
        Rendered only when the catalog HAS plans. A plan picker on a business with none
        would be a control whose every choice returns nothing.
      */}
      {plans.length > 0 ? (
        <div className="w-48">
          <SelectField
            size="sm"
            ariaLabel="Plan"
            value={plan}
            onValueChange={(v) => go("plan", v, false)}
            options={[
              { value: "", label: "All plans" },
              ...plans.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        </div>
      ) : null}
      <div className="w-40">
        <SelectField
          size="sm"
          ariaLabel="Billing interval"
          value={interval}
          onValueChange={(v) => go("interval", v, false)}
          options={[
            { value: "", label: "All intervals" },
            ...CANCELLATION_INTERVALS.map((i) => ({ value: i.value, label: i.label })),
          ]}
        />
      </div>
      {/* The selects own their chevrons, so the spinner sits beside them. */}
      {pending ? (
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
      ) : null}
    </div>
  );
}

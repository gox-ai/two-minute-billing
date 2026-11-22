"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useNavPending } from "@/components/navigation/nav-pending";
import { SelectField } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_HOSTED_RANGE, HOSTED_RANGES } from "./window";

export interface ReportFilter {
  /** The query parameter the server re-reads. */
  param: string;
  ariaLabel: string;
  value: string;
  /** The first option is "All": an empty value. */
  options: Array<{ value: string; label: string }>;
}

/**
 * The period, the compare toggle and each filter, all in the URL: the link is shareable and
 * the server counts again. A filter with only its "All" option is not rendered.
 */
export function ReportFilters({
  range,
  compare,
  filters,
}: {
  range: string;
  compare: boolean;
  filters: ReportFilter[];
}) {
  const { navigate, pendingFrom } = useNavPending();
  const pending = pendingFrom("filters");
  const pathname = usePathname();
  const params = useSearchParams();

  const go = (key: string, value: string, isDefault: boolean) => {
    const next = new URLSearchParams(params.toString());
    if (!value || isDefault) next.delete(key);
    else next.set(key, value);
    const q = next.toString();
    navigate(q ? `${pathname}?${q}` : pathname, { source: "filters" });
  };

  return (
    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
      <div className="grid min-w-0 basis-full grid-cols-2 gap-2 sm:flex sm:flex-1 sm:basis-auto sm:flex-wrap sm:items-center">
        <div className="col-span-2 min-w-0 sm:w-44">
          <SelectField
            size="sm"
            ariaLabel="Period"
            value={range}
            onValueChange={(v) => go("range", v, v === DEFAULT_HOSTED_RANGE)}
            options={HOSTED_RANGES.map((r) => ({ value: r.id, label: r.label }))}
          />
        </div>
        {filters
          .filter((f) => f.options.length > 1)
          .map((f) => (
            <div key={f.param} className="min-w-0 sm:w-48">
              <SelectField
                size="sm"
                ariaLabel={f.ariaLabel}
                value={f.value}
                onValueChange={(v) => go(f.param, v, false)}
                options={f.options}
              />
            </div>
          ))}
      </div>
      <label className="flex items-center gap-2 text-sm whitespace-nowrap">
        <Switch
          checked={compare}
          onCheckedChange={(on) => go("compare", on ? "" : "off", on)}
          aria-label="Compare to the previous period"
        />
        Compare to the previous period
      </label>
      {pending ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
      ) : null}
    </div>
  );
}

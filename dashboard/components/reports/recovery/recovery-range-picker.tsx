"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { useNavPending } from "@/components/navigation/nav-pending";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  RECOVERY_RANGES,
  RECOVERY_RANGE_LABEL,
  DEFAULT_RECOVERY_RANGE,
} from "@/components/reports/recovery/recovery-ranges";

/**
 * The window the PERIOD figures are measured over — `?range=`, forwarded straight to
 * `getReport`.
 *
 * Its options are the report engine's own presets, not the Explore vocabulary: this page
 * asks the reports API, which accepts `daily | 3m | 6m | 12m` and nothing else. A picker
 * offering `30d` here would send a value the engine refuses.
 *
 * It deliberately does NOT move the lifetime block. That block comes from an as-of-now
 * measure with no history, so a range would change its label and not its number.
 */
export function RecoveryRangePicker({ value }: { value: string }) {
  const { navigate, pendingFrom } = useNavPending();
  const pending = pendingFrom("range");
  const pathname = usePathname();
  const params = useSearchParams();

  const go = (id: string) => {
    const next = new URLSearchParams(params.toString());
    // The default stays out of the URL, so the common link is the clean one.
    if (id === DEFAULT_RECOVERY_RANGE) next.delete("range");
    else next.set("range", id);
    const q = next.toString();
    navigate(q ? `${pathname}?${q}` : pathname, { source: "range" });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex h-8 items-center gap-2 rounded-md border bg-card px-3 text-sm hover:bg-accent">
        {RECOVERY_RANGE_LABEL[value] ?? value}
        {pending ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
        ) : (
          <ChevronDown className="size-3.5 text-muted-foreground" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {RECOVERY_RANGES.map((r) => (
          <DropdownMenuItem key={r} onClick={() => go(r)} className="justify-between">
            {RECOVERY_RANGE_LABEL[r] ?? r}
            {r === value ? <Check className="size-3.5" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

"use client";

import { Info } from "lucide-react";
import { useDashboardMode } from "@/components/mode-provider";

/**
 * The shell's test-mode bar. Client-side because the effective mode depends on the
 * route (see `mode-provider.tsx`) and a server layout has no pathname — which is
 * exactly how it came to be driven by the cookie alone, and to contradict the
 * business on screen.
 *
 * `businesses/[biz]/layout.tsx` deliberately does NOT render its own copy of this;
 * this bar and the sidebar chip are the two signals, and a third per-page one was
 * removed as banner-blindness. That makes this bar's correctness load-bearing.
 */
export function ModeBanner() {
  const state = useDashboardMode();
  if (!state || state.mode !== "test") return null;
  return (
    <div className="z-50 flex flex-none items-center justify-center gap-1.5 bg-warning-soft px-3 py-1 text-center text-xs font-medium text-warning">
      <strong className="font-semibold">Test mode</strong> — nothing here bills a real customer.
      Email goes only to team members.
      <Info className="size-3" aria-hidden />
    </div>
  );
}

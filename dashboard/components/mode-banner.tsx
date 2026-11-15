"use client";

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
    // The label never breaks; on a phone the sentence wraps beside it.
    <div className="z-50 flex flex-none items-center justify-center gap-1.5 bg-warning-soft px-3 py-1 text-xs font-medium text-warning">
      <strong className="shrink-0 font-semibold whitespace-nowrap">Test mode</strong>
      <span className="min-w-0 text-pretty">
        — nothing here bills a real customer. Email goes only to team members.
      </span>
    </div>
  );
}

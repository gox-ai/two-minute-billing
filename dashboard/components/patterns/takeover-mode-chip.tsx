"use client";

import { Chip } from "@/components/patterns/chip";
import { useDashboardMode } from "@/components/mode-provider";

/**
 * The mode chip in a takeover's header.
 *
 * This used to be the literal string "Test", hardcoded into `takeover.tsx` — so
 * every create/edit takeover in the app announced Test mode, including on a live
 * business, where it is the most dangerous thing it could get wrong: the takeover
 * covers the shell, hiding both the sidebar chip and the top bar, so it is the ONLY
 * mode signal on screen while an operator edits.
 *
 * Split out as a client component so `Takeover` itself stays server-renderable —
 * three of its five call sites are server pages.
 *
 * Renders nothing when the mode cannot be resolved (no provider, or a business the
 * layout could not fetch); an absent chip is recoverable, a wrong one is not.
 */
export function TakeoverModeChip() {
  const state = useDashboardMode();
  if (!state) return null;
  return (
    <Chip tone={state.mode === "test" ? "tan" : "gray"} className="font-semibold uppercase">
      {state.mode === "test" ? "Test" : "Live"}
    </Chip>
  );
}

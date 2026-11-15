"use client";

import * as React from "react";
import Link from "next/link";
import { useNavPending } from "@/components/navigation/nav-pending";
import { SEGMENT_TRACK, segmentItem } from "@/components/ui/segmented";
import { SegmentIndicator } from "@/components/ui/segment-indicator";
import { cn } from "@/lib/utils";
import type { BoardOption } from "@/components/reports/board-range-picker";

/**
 * How finely the board is cut, as a segmented row of links. Pressing the pinned grain again
 * unpins it (its href already says so), and each tile falls back to its own.
 */
export function GrainControl({ grains, grain }: { grains: BoardOption[]; grain: string }) {
  const { navigate } = useNavPending();
  return (
    // Last in a phone's control row (see BoardSurface): the period and the download go first.
    <div role="group" aria-label="Grain" className={cn(SEGMENT_TRACK, "max-sm:order-last")}>
      <SegmentIndicator />
      {grains.map((g) => {
        const on = g.id === grain;
        return (
          <Link
            key={g.id}
            href={g.href}
            aria-current={on ? "true" : undefined}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              e.preventDefault();
              navigate(g.href, { source: "period" });
            }}
            className={segmentItem(on, "h-7 px-3")}
          >
            {g.label}
          </Link>
        );
      })}
    </div>
  );
}

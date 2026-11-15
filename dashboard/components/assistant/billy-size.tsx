"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BILLY_DEFAULT_W, BILLY_STEP } from "@/lib/billy-width";
import {
  billyLayoutNow,
  initBillyLayout,
  restampBilly,
  setBillyMode,
  setBillyWidth,
  subscribeBillyLayout,
} from "./billy-open";
import { billyEntry, billyMorph, billyMoving, panelEl } from "./billy-morph";
import { motionMs } from "@/lib/motion";

/** The panel's width and mode, as React sees them (not updated per drag frame). */
export function useBillyLayout() {
  return React.useSyncExternalStore(subscribeBillyLayout, billyLayoutNow, () => null);
}

/** Keeps `--billy-w` and `data-billy-push` true to the window and the rail. Mount once. */
export function useBillyLayoutSync() {
  React.useLayoutEffect(() => {
    initBillyLayout();
    // Chromium already sends one resize per frame.
    window.addEventListener("resize", restampBilly);
    const mo = new MutationObserver(restampBilly);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-nav"] });
    return () => {
      window.removeEventListener("resize", restampBilly);
      mo.disconnect();
    };
  }, []);
}

type Drag = { id: number; x0: number; w0: number; x: number; w: number; frame: number };

/**
 * The panel's inner edge: drag it, or use the arrow keys, to change the width. Each frame
 * writes `--billy-w` only; React and the stored width see the result on release.
 */
export function BillyResizeHandle() {
  const layout = useBillyLayout();
  const drag = React.useRef<Drag | null>(null);
  const ref = React.useRef<HTMLDivElement>(null);

  const apply = (w: number, commit: boolean) => {
    const s = setBillyWidth(w, commit);
    ref.current?.setAttribute("aria-valuenow", String(s.width));
    return s;
  };
  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    cancelAnimationFrame(d.frame);
    delete document.documentElement.dataset.billyResizing;
    delete ref.current?.dataset.dragging;
    apply(d.w, true);
  };
  React.useEffect(() => end, []);

  if (!layout?.resizable) return null;
  const { min, max, width } = layout;
  const clamp = (w: number) => Math.min(max, Math.max(min, Math.round(w)));

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the assistant panel"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      className={[
        "absolute inset-y-0 -left-0.5 z-10 w-2 cursor-col-resize touch-none outline-none select-none max-sm:hidden",
        // The line sits on the panel's edge.
        "after:absolute after:inset-y-0 after:left-0 after:w-0.5 after:bg-transparent after:transition-colors",
        "hover:after:bg-ring/60 focus-visible:after:w-[3px] focus-visible:after:bg-ring data-dragging:after:bg-ring",
      ].join(" ")}
      onPointerDown={(e) => {
        if (e.button !== 0 || drag.current) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = {
          id: e.pointerId,
          x0: e.clientX,
          w0: width,
          x: e.clientX,
          w: width,
          frame: 0,
        };
        document.documentElement.dataset.billyResizing = "";
        e.currentTarget.dataset.dragging = "";
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || e.pointerId !== d.id) return;
        d.x = e.clientX;
        // The width comes from the pointer alone, so a page that relays out cannot fight it.
        d.frame ||= requestAnimationFrame(() => {
          d.frame = 0;
          const w = clamp(d.w0 + d.x0 - d.x);
          if (w !== d.w) d.w = apply(w, false).width;
        });
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (!d || e.pointerId !== d.id) return;
        d.w = clamp(d.w0 + d.x0 - e.clientX);
        end();
      }}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => apply(BILLY_DEFAULT_W, true)}
      onKeyDown={(e) => {
        const next =
          e.key === "ArrowLeft"
            ? width + BILLY_STEP
            : e.key === "ArrowRight"
              ? width - BILLY_STEP
              : e.key === "Home"
                ? min
                : e.key === "End"
                  ? max
                  : e.key === "Enter"
                    ? BILLY_DEFAULT_W
                    : null;
        if (next === null) return;
        e.preventDefault();
        apply(e.key === "Enter" ? next : clamp(next), true);
      }}
    />
  );
}

/**
 * Our own pair, drawn on the icon set's grid: the frame is the page, the solid block is Billy.
 * A tall block on the right edge is the side panel; a small block in the corner is the window.
 */
function BoxIcon({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.25" />
      {children}
    </svg>
  );
}
const SidePanelIcon = ({ className }: { className?: string }) => (
  <BoxIcon className={className}>
    <rect x="14.25" y="8" width="3.25" height="8" rx="0.75" fill="currentColor" stroke="none" />
  </BoxIcon>
);
const WindowIcon = ({ className }: { className?: string }) => (
  <BoxIcon className={className}>
    <rect x="11.5" y="11.25" width="6" height="5" rx="1" fill="currentColor" stroke="none" />
  </BoxIcon>
);

/** A side panel beside the page or a floating window over it. With no room, it floats. */
export function BillyDockToggle() {
  const layout = useBillyLayout();
  if (!layout) return null;
  const docked = layout.mode === "dock";
  const blocked = !layout.room;
  const label = docked ? "Float over the page" : "Show as side panel";
  const Icon = docked && !blocked ? WindowIcon : SidePanelIcon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={blocked ? "Show as side panel" : label}
          aria-disabled={blocked || undefined}
          onClick={() => {
            if (blocked) return;
            const next = docked ? "float" : "dock";
            // One shape from the side panel to the window and back; else the edge eases alone.
            const panel = panelEl();
            if (panel && billyEntry(panel) === "morph")
              return billyMorph(
                "swap",
                next,
                panel,
                () => setBillyMode(next),
                () => {},
              );
            billyMoving(motionMs("--dur-dock"));
            setBillyMode(next);
          }}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50 hover:aria-disabled:bg-transparent max-sm:hidden"
        >
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {blocked ? "The screen is too narrow for the side panel." : label}
      </TooltipContent>
    </Tooltip>
  );
}

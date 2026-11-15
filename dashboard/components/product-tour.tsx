"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { markProductTourSeenAction } from "@/app/auth-actions";
import { START_TOUR_EVENT, startProductTour } from "@/lib/product-tour";
import { paletteKeys } from "@/lib/palette-hints";
import { ASSISTANT_NAME } from "@/lib/assistant";
import { cn } from "@/lib/utils";
import { CoachGrip, useCoachCard } from "@/components/coach-card";

interface Stop {
  /** Tried in order; the first visible match is the anchor. No match: the stop is skipped. */
  anchors: string[];
  title: string;
  body: string;
}

const RAIL = ".app-rail";

/**
 * Anchored on what the rail already renders (each nav row's `title`, the mode switch's
 * `aria-label`, the search row), so the tour follows the nav and a role that cannot see a
 * section simply skips its stop.
 */
const STOPS: Stop[] = [
  // One of these two shows, by the mode the business is in.
  {
    anchors: [`${RAIL} [aria-label^="Mode: test"]`],
    title: "You are in test mode",
    body: "Test mode does not bill real customers. Try each step here first. Then use this switch to go to live mode.",
  },
  {
    anchors: [`${RAIL} [aria-label^="Mode: live"]`],
    title: "You are in live mode",
    body: "Live mode bills real customers. To try each step first, use this switch to go to test mode.",
  },
  {
    // The bubble at the bottom right (2026-11-09), no longer on the rail.
    anchors: ['[data-tour="assistant"]'],
    title: `Meet ${ASSISTANT_NAME}`,
    body: `Ask about any invoice, customer or payment. ${ASSISTANT_NAME} reads your data and shows you where to act. It changes nothing without your confirmation.`,
  },
  {
    anchors: [`${RAIL} [data-nav-label="Product catalog"]`, `${RAIL} [data-nav-label="Plans"]`],
    title: "Product catalog",
    body: "Create your plans, prices, addons and coupons here. A subscription bills a recurring price.",
  },
  {
    anchors: [`${RAIL} [data-nav-label="Customers"]`],
    title: "Customers",
    body: "Customers are the people and companies that pay you. Each customer has their payment methods and invoices.",
  },
  {
    anchors: [`${RAIL} [data-nav-label="Subscriptions"]`],
    title: "Subscriptions",
    body: "A subscription connects a customer to a price. It renews on time and creates each invoice.",
  },
  {
    anchors: [
      `${RAIL} [data-nav-label="Invoices & credit notes"]`,
      `${RAIL} [data-nav-label="Invoices"]`,
    ],
    title: "Invoices and credit notes",
    body: "All invoices, payments and refunds are here. Open an invoice to see each payment attempt.",
  },
  {
    anchors: [`${RAIL} [data-nav-label="Settings"]`],
    title: "Settings",
    body: "Connect your payment gateway in Settings, Payment Gateways. Billing rules and email notifications are here too.",
  },
  {
    anchors: [`${RAIL} button[title^="Search or jump"]`],
    title: "Go anywhere fast",
    body: "Search finds any page, customer, subscription or invoice.",
  },
];

/** The business home, where a new business lands and the setup checklist lives. */
const BUSINESS_HOME = /^\/businesses\/[^/]+$/;
/** Below this the rail is an off-canvas drawer, so there is nothing to point at. */
const MIN_WIDTH = 768;
const POP_WIDTH = 340;

function findAnchor(stop: Stop): HTMLElement | null {
  for (const sel of stop.anchors) {
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
  }
  return null;
}

const WIDE_QUERY = `(min-width: ${MIN_WIDTH}px)`;
function useWide(): boolean {
  return React.useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(WIDE_QUERY);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(WIDE_QUERY).matches,
    () => false,
  );
}

/**
 * The product tour: offered once to a person who has not seen it, on the business home, and
 * replayable from the setup checklist. Seen is stored on the user row (0500), so the offer
 * does not come back on another device.
 */
export function ProductTour({ offer }: { offer: boolean }) {
  const path = usePathname();
  const wide = useWide();
  const [phase, setPhase] = React.useState<"idle" | "touring">("idle");
  // Answered (started or "Not now") in this page load; the server row covers later loads.
  const [answered, setAnswered] = React.useState(false);
  const [stops, setStops] = React.useState<Stop[]>([]);
  const [i, setI] = React.useState(0);
  const nextRef = React.useRef<HTMLButtonElement>(null);
  // The rail's scroll position before the tour, put back when it ends.
  const railScroll = React.useRef<{ el: Element; top: number } | null>(null);

  const markSeen = React.useCallback(() => {
    if (offer) void markProductTourSeenAction();
  }, [offer]);

  const start = React.useCallback(() => {
    if (window.innerWidth < MIN_WIDTH) return;
    const found = STOPS.filter((s) => findAnchor(s));
    if (found.length === 0) return;
    const rail = document.querySelector(`${RAIL} .overflow-y-auto`);
    railScroll.current = rail ? { el: rail, top: rail.scrollTop } : null;
    setStops(found);
    setI(0);
    setPhase("touring");
  }, []);

  React.useEffect(() => {
    window.addEventListener(START_TOUR_EVENT, start);
    return () => window.removeEventListener(START_TOUR_EVENT, start);
  }, [start]);

  const offering = offer && !answered && phase === "idle" && wide && BUSINESS_HOME.test(path);
  const stop = phase === "touring" ? stops[i] : undefined;

  // Bring the anchor into view; the coach card follows it from there.
  React.useEffect(() => {
    if (!stop) return;
    findAnchor(stop)?.scrollIntoView({ block: "nearest" });
    nextRef.current?.focus();
  }, [stop]);
  const anchor = stop ? findAnchor(stop) : null;
  const cardRef = React.useRef<HTMLDivElement>(null);
  const coach = useCoachCard({
    cardRef,
    stepKey: stop && anchor ? `tour:${i}` : null,
    measureTarget: () => (stop ? (findAnchor(stop)?.getBoundingClientRect() ?? null) : null),
    targetEl: () => (stop ? findAnchor(stop) : null),
    width: POP_WIDTH,
  });

  const end = React.useCallback((finished: boolean) => {
    setPhase("idle");
    if (railScroll.current) railScroll.current.el.scrollTop = railScroll.current.top;
    railScroll.current = null;
    if (finished) {
      toast("Tour complete", {
        description: "Complete the setup steps on this page to send your first invoice.",
      });
    }
  }, []);

  React.useEffect(() => {
    if (phase !== "touring") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) end(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, end]);

  if (offering) {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) {
            markSeen();
            setAnswered(true);
          }
        }}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Your business is ready</DialogTitle>
            <DialogDescription>
              Take a short tour. It shows where to find plans, customers, subscriptions and
              invoices. It takes about one minute.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            You can start the tour again from the setup steps on this page.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                markSeen();
                setAnswered(true);
              }}
            >
              Not now
            </Button>
            <Button
              onClick={() => {
                markSeen();
                setAnswered(true);
                start();
              }}
            >
              Start tour
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  if (!stop || !anchor) return null;

  const last = i === stops.length - 1;
  const rect = coach.target;
  const body =
    stop.title === "Go anywhere fast" && paletteKeys()
      ? `${stop.body} Press ${paletteKeys()} on any page.`
      : stop.body;

  return (
    <div className="fixed inset-0 z-50" aria-live="polite">
      {/* The spotlight: one box whose huge shadow dims everything else. Clicks are caught,
          so a stray click cannot navigate away mid-tour. */}
      {rect ? (
        <div
          aria-hidden
          className="pointer-events-none fixed rounded-md shadow-[0_0_0_9999px_rgb(0_0_0/0.55)] ring-2 ring-primary transition-all duration-200"
          style={{
            left: rect.left - 4,
            top: rect.top - 4,
            width: rect.right - rect.left + 8,
            height: rect.bottom - rect.top + 8,
          }}
        />
      ) : null}
      {/* Placed clear of the anchor and any open menu; the member can drag it by its header. */}
      <div
        ref={cardRef}
        role="dialog"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        data-coach-card
        className="fixed flex flex-col gap-2 rounded-xl border bg-popover p-5 text-popover-foreground shadow-lg"
        style={coach.style}
      >
        <div
          {...coach.handleProps}
          className={cn(
            "-mx-2 -mt-2 flex touch-none items-center justify-between gap-2 rounded-md px-2 pt-2 select-none",
            coach.dragging ? "cursor-grabbing" : "cursor-grab",
          )}
        >
          <span className="flex items-center gap-1 text-xs font-semibold text-primary">
            <CoachGrip onKeyDown={coach.onGripKey} dragging={coach.dragging} />
            {i + 1} of {stops.length}
          </span>
          <button
            type="button"
            onClick={() => end(false)}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            End tour
          </button>
        </div>
        <h2 id="tour-title" className="text-base font-semibold">
          {stop.title}
        </h2>
        <p id="tour-body" className="text-sm text-muted-foreground">
          {body}
        </p>
        <div className="mt-2 flex items-center justify-between gap-3">
          <div className="flex gap-1.5" aria-hidden>
            {stops.map((s, k) => (
              <span
                key={s.title}
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  k === i ? "w-4 bg-primary" : "w-1.5 bg-border",
                )}
              />
            ))}
          </div>
          <div className="flex gap-2">
            {i > 0 ? (
              <Button variant="outline" size="sm" onClick={() => setI(i - 1)}>
                Back
              </Button>
            ) : null}
            <Button ref={nextRef} size="sm" onClick={() => (last ? end(true) : setI(i + 1))}>
              {last ? "Finish" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** "Show the tour again", for server components such as the setup checklist. */
export function StartTourLink({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={startProductTour}
      className={cn("text-primary hover:underline", className)}
    >
      Show the tour again
    </button>
  );
}

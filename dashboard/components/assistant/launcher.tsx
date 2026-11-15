"use client";

import * as React from "react";
import { X } from "lucide-react";
import { ASSISTANT_NAME, type RecordRef } from "@/lib/assistant";
import { BillyMark } from "./billy-mark";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/ui/kbd";
import { box, inflate, paintsBox, placeBeside, reach, type Box } from "@/lib/coach-placement";
import { nextAnchor, tuckBubble } from "@/lib/billy-tuck";

/**
 * The launcher (option B1, 2026-11-09): a 52px round bubble at the bottom right with the mark
 * and the flowing three-colour ring (`.billy-bubble`). Hidden while the panel is open. It rises
 * above a sticky action bar at the foot of the page, so it never covers the page's own buttons.
 * From 1024px it lives in the content column's end gutter (`--main-pe`, layout.tsx), so no
 * right-aligned control scrolls under it; below that it slides out while the page scrolls
 * down (`lib/billy-tuck.ts`).
 * A dot shows a support reply the member has not read. It springs in, and shrinks away
 * (`leaving`) while the panel slides over it.
 *
 * On a record page, a small card beside it (option B4) offers to ask about the record, once per
 * record type for each member. It shows only where nothing on the page is under it.
 */

const NUDGES: Record<string, string> = {
  invoice: "Totals, payments, and why it is not paid.",
  customer: "Payments, credit and their subscriptions.",
  subscription: "Renewals, credit, what changes if you cancel.",
  "credit note": "What it credits, and where the credit went.",
  payment: "Why it failed, and what was refunded.",
  transaction: "Why it failed, and what was refunded.",
};

/** Record type → the record it was shown on in this page load. */
const shownOn = new Map<string, string>();

const SEEN_KEY = (member: string) => `tmb.billy.nudged.${member}`;

function readSeen(member: string): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(SEEN_KEY(member)) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeSeen(member: string, types: string[]) {
  try {
    window.localStorage.setItem(SEEN_KEY(member), JSON.stringify(types));
  } catch {
    /* a private window shows the card again next time */
  }
}

/**
 * Height of a sticky action bar at the foot of the page, so the bubble can sit above it. The
 * shell keeps a `[data-action-bar]` flush with main's foot at every scroll position, so this
 * holds while the page scrolls.
 */
function stickyFooterHeight(): number {
  const main = document.querySelector("main");
  if (!main) return 0;
  const foot = Math.min(main.getBoundingClientRect().bottom, window.innerHeight);
  let h = 0;
  for (const el of main.querySelectorAll<HTMLElement>(
    '[data-action-bar], [class*="sticky"][class*="bottom-0"]',
  )) {
    const r = el.getBoundingClientRect();
    // Only a bar that is on screen and touches main's foot.
    if (r.height > 0 && r.top < foot && Math.abs(r.bottom - foot) < 4) h = Math.max(h, r.height);
  }
  return h;
}

/** Bubble size and its inset from the viewport edge (`right-4`): `--main-pe` keeps clear of both. */
const BUBBLE = 52;
const INSET = 16;
const NUDGE_SIZE = { width: 224, height: 84 };
/** Taken whole: controls and media. Everything else counts by its text. */
const SOLID =
  'a[href], button, input, select, textarea, summary, img, svg, canvas, video, iframe, [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="img"], [role="progressbar"], [tabindex]:not([tabindex="-1"])';
/** Floating layers outside `<main>`: menus, selects, popovers, dialogs. */
const LAYERS =
  '[data-radix-popper-content-wrapper], [role="menu"], [role="listbox"], [role="dialog"]';
/** Room kept between the nudge and the content around it. */
const CLEAR = 8;

/**
 * What the nudge must not cover inside `area`: every line of text, control, image and painted
 * surface (a card, its header, a well) in `<main>`, sticky bars, and open menus. Free ground is
 * main's own ground. Subtrees whose box misses `area` are skipped.
 */
function contentRects(main: HTMLElement, area: Box): Box[] {
  const out: Box[] = [];
  const ground = getComputedStyle(main).backgroundColor;
  const hits = (r: DOMRect) =>
    r.right > area.left && r.left < area.right && r.bottom > area.top && r.top < area.bottom;
  const add = (r: DOMRect) => {
    // sr-only text is 1px: not on screen.
    if (r.width >= 2 && r.height >= 2 && hits(r))
      out.push(inflate(box(r.left, r.top, r.width, r.height), CLEAR));
  };
  const range = document.createRange();
  const walk = (el: Element) => {
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        if (!n.textContent?.trim()) continue;
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) add(r);
        continue;
      }
      if (!(n instanceof Element)) continue;
      const r = n.getBoundingClientRect();
      // A zero box (display: contents) can still hold visible children.
      if ((r.width > 0 || r.height > 0) && !hits(r)) continue;
      // A card counts whole: text alone left its header and edges free (a credit note's
      // Comments card had the nudge over its header, 9px clear of the title).
      if (n.matches(SOLID) || paintsBox(getComputedStyle(n), ground)) add(r);
      else walk(n);
    }
  };
  walk(main);
  for (const el of main.querySelectorAll<HTMLElement>('[class*="sticky"]'))
    if (getComputedStyle(el).position === "sticky") add(el.getBoundingClientRect());
  for (const el of document.querySelectorAll(LAYERS))
    if (!el.closest("[data-billy-nudge]")) add(el.getBoundingClientRect());
  return out;
}

export function AssistantLauncher({
  unread,
  record,
  memberKey,
  pathname,
  onOpen,
  onAskRecord,
  leaving = false,
  returning = false,
}: {
  unread: number;
  record: RecordRef | null;
  memberKey: string;
  pathname: string;
  onOpen: () => void;
  onAskRecord: (r: RecordRef) => void;
  /** The panel is opening: play the exit, take no input. */
  leaving?: boolean;
  /** The panel just morphed back into the bubble: no second entrance; the dot pops last. */
  returning?: boolean;
}) {
  const [lift, setLift] = React.useState(0);
  const [nudge, setNudge] = React.useState<string | null>(null);
  // Where the nudge is on screen, for which record; null while it has no free ground.
  const [spot, setSpot] = React.useState<{ left: number; top: number; key: string } | null>(null);
  // The nudge's height on this path: the foot of the page keeps room for it beside the bubble.
  // Kept after the × so the page does not jump; a new path drops it.
  const [room, setRoom] = React.useState<{ path: string; height: number } | null>(null);
  const nudgeRef = React.useRef<HTMLDivElement>(null);
  const bubbleRef = React.useRef<HTMLButtonElement>(null);
  const [tucked, setTucked] = React.useState(false);
  const tall = room?.path === pathname ? Math.max(room.height, BUBBLE) : BUBBLE;

  // Billy's footprint: the page keeps this much room at the foot so content scrolls clear.
  React.useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--billy-clear", `${INSET + tall + INSET}px`);
    return () => {
      root.style.removeProperty("--billy-clear");
    };
  }, [tall]);

  // Re-measure on navigation, resize and scroll: a sticky bar only touches the foot when the
  // page is long enough to scroll it there.
  React.useEffect(() => {
    let frame = 0;
    const measure = () => {
      window.clearTimeout(frame);
      frame = window.setTimeout(() => setLift(stickyFooterHeight()), 50);
    };
    // At once as well: a bar that is there on arrival must not sit under the bubble for a beat.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLift(stickyFooterHeight());
    const main = document.querySelector("main");
    window.addEventListener("resize", measure);
    main?.addEventListener("scroll", measure, { passive: true });
    const mo = main ? new MutationObserver(measure) : null;
    if (main && mo) mo.observe(main, { childList: true, subtree: true });
    return () => {
      window.clearTimeout(frame);
      window.removeEventListener("resize", measure);
      main?.removeEventListener("scroll", measure);
      mo?.disconnect();
    };
  }, [pathname]);

  // Below 1024px: out of the way while the page scrolls down, back on the way up.
  React.useEffect(() => {
    const main = document.querySelector<HTMLElement>("main");
    if (!main) return;
    const narrow = window.matchMedia("(width < 64rem)");
    let anchor = main.scrollTop;
    const onScroll = () => {
      if (!narrow.matches) return setTucked(false);
      const p = {
        top: main.scrollTop,
        anchor,
        clientHeight: main.clientHeight,
        scrollHeight: main.scrollHeight,
      };
      anchor = nextAnchor(p);
      setTucked((t) => tuckBubble(t, p));
    };
    // A new page starts with the bubble in view.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTucked(false);
    main.addEventListener("scroll", onScroll, { passive: true });
    narrow.addEventListener("change", onScroll);
    return () => {
      main.removeEventListener("scroll", onScroll);
      narrow.removeEventListener("change", onScroll);
    };
  }, [pathname]);

  // What a member saw is in localStorage, readable only after mount. The record it was shown
  // on is kept for this page load, so a second run of the effect keeps it on screen.
  React.useEffect(() => {
    const type = record?.type;
    const id = record?.id;
    if (!type || !NUDGES[type] || !id) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNudge(null);
      return;
    }
    if (shownOn.get(type) === id) return setNudge(type);
    if (readSeen(memberKey).includes(type)) return setNudge(null);
    setNudge(type);
  }, [record?.type, record?.id, memberKey]);

  const bottom = INSET + lift;
  const recordId = record?.id;
  const key = `${pathname}|${nudge}|${recordId}`;
  const at = spot?.key === key ? spot : null;

  // Place the nudge beside the bubble on free ground; re-run as the page scrolls. With no free
  // ground it hides at once, and comes back only once the page is still.
  React.useEffect(() => {
    if (!nudge || leaving || !recordId) return;
    let raf = 0;
    let settle = 0;
    const main = document.querySelector<HTMLElement>("main");
    const place = (now: boolean) => {
      raf = 0;
      const card = nudgeRef.current;
      // `max-lg:hidden`: no box below 1024px, and it does not count as shown.
      if (!main || !card || card.getClientRects().length === 0) return;
      const m = main.getBoundingClientRect();
      const vh = window.innerHeight;
      const vp = box(
        m.left,
        Math.max(m.top, 0),
        m.width,
        Math.min(m.bottom, vh) - Math.max(m.top, 0),
      );
      // Layout box, not the painted one: the bubble may still be springing in.
      const b = bubbleRef.current;
      const bubble = b
        ? box(b.offsetLeft, b.offsetTop, BUBBLE, BUBBLE)
        : box(m.right - INSET - BUBBLE, vh - bottom - BUBBLE, BUBBLE, BUBBLE);
      const size = {
        width: card.offsetWidth || NUDGE_SIZE.width,
        height: card.offsetHeight || NUDGE_SIZE.height,
      };
      setRoom((p) =>
        p?.path === pathname && p.height === size.height
          ? p
          : { path: pathname, height: size.height },
      );
      const free = placeBeside({
        card: size,
        viewport: vp,
        target: bubble,
        keepOut: contentRects(main, reach(bubble, size)),
        prefer: "left",
      });
      if (!free) return setSpot(null);
      if (now && shownOn.get(nudge) !== recordId) {
        // Once per record type: it counts as shown the first time it is on screen.
        shownOn.set(nudge, recordId);
        const seen = readSeen(memberKey);
        if (!seen.includes(nudge)) writeSeen(memberKey, [...seen, nudge]);
      }
      setSpot((p) => {
        const same = p?.key === key;
        // Coming back from hidden waits for the page to be still.
        if (!same && !now) return p;
        return same && p.left === free.left && p.top === free.top
          ? p
          : { left: free.left, top: free.top, key };
      });
    };
    const queue = () => {
      if (!raf) raf = requestAnimationFrame(() => place(false));
      window.clearTimeout(settle);
      settle = window.setTimeout(() => place(true), 300);
    };
    queue();
    document.addEventListener("scroll", queue, { capture: true, passive: true });
    window.addEventListener("resize", queue);
    const mo = main ? new MutationObserver(queue) : null;
    if (main && mo) mo.observe(main, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
      document.removeEventListener("scroll", queue, { capture: true });
      window.removeEventListener("resize", queue);
      mo?.disconnect();
    };
  }, [nudge, leaving, bottom, pathname, recordId, memberKey, key]);
  return (
    <>
      {nudge && record && !leaving ? (
        <div
          role="complementary"
          aria-label={`Ask ${ASSISTANT_NAME} about this ${nudge}`}
          ref={nudgeRef}
          className={cn(
            "fixed z-30 w-56 rounded-xl border bg-popover p-3 pr-8 text-sm shadow-lg max-lg:hidden",
            at ? "anim-rise-spring" : "invisible",
          )}
          style={at ? { left: at.left, top: at.top } : { right: 24, bottom: bottom + 64 }}
          data-billy-nudge
        >
          <button
            type="button"
            className="block w-full text-left"
            onClick={() => {
              setNudge(null);
              onAskRecord(record);
            }}
          >
            <span className="block font-medium">Ask about this {nudge}</span>
            <span className="block text-xs text-muted-foreground">{NUDGES[nudge]}</span>
          </button>
          <button
            type="button"
            aria-label="Hide"
            title="Hide"
            onClick={() => setNudge(null)}
            className="absolute top-1.5 right-1.5 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ) : null}
      <button
        ref={bubbleRef}
        type="button"
        data-tour="assistant"
        aria-label={
          unread
            ? `Ask ${ASSISTANT_NAME}. Support replied to you.`
            : record && record.type in NUDGES
              ? `Ask ${ASSISTANT_NAME} about this ${record.type.replace(/_/g, " ")}`
              : `Ask ${ASSISTANT_NAME}`
        }
        onClick={onOpen}
        onFocus={() => setTucked(false)}
        data-state={leaving ? "closed" : "open"}
        data-returning={returning || undefined}
        data-tucked={tucked || undefined}
        aria-expanded={leaving}
        aria-hidden={leaving || undefined}
        tabIndex={leaving ? -1 : undefined}
        className="billy-bubble group fixed right-4 z-30 inline-flex size-[52px] items-center justify-center rounded-full"
        style={{ bottom, translate: tucked ? `0 ${bottom + BUBBLE + 8}px` : undefined }}
      >
        <BillyMark size={24} twinkle />
        {unread ? (
          <span
            className={cn(
              "absolute -top-0.5 -right-0.5 size-3.5 animate-mark rounded-full border-2 border-card bg-destructive",
              returning
                ? "[animation-delay:var(--dur-morph)]"
                : "[animation-delay:var(--dur-fast)]",
            )}
            data-billy-unread
            aria-hidden
          />
        ) : null}
        <span
          aria-hidden
          className="pointer-events-none absolute right-[62px] translate-x-1.5 rounded-md border bg-popover px-2 py-1 text-xs font-medium whitespace-nowrap text-foreground opacity-0 shadow-md transition-[opacity,transform] group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100 max-md:hidden"
        >
          {/* On a record page the label names the record; the panel opens anchored to it. */}
          {record && record.type in NUDGES
            ? `Ask about this ${record.type.replace(/_/g, " ")}`
            : `Ask ${ASSISTANT_NAME}`}{" "}
          <Kbd mod className="ml-1">
            J
          </Kbd>
        </span>
      </button>
    </>
  );
}

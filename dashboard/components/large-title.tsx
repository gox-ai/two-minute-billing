"use client";

import * as React from "react";
import { createPortal } from "react-dom";

/**
 * Large-title collapse, behind `LARGE_TITLE_COLLAPSE` (lib/motion.ts).
 *
 * Render it inside a page's title row (`relative`). It watches that spot with an
 * IntersectionObserver on <main> (no scroll handler, no layout) and, once the title has
 * gone under the bar, fades in a 48px compact bar in the sticky slot `RouteMain` keeps at
 * the top of <main>. The bar is a portal: it takes no space, so nothing shifts.
 *
 * While mounted it sets `--compact-h` on <main>; sticky-top elements offset by it, so the
 * bar never covers them.
 */
export function CompactTitle({
  title,
  actions,
}: {
  title: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const [slot, setSlot] = React.useState<HTMLElement | null>(null);
  const [shown, setShown] = React.useState(false);

  React.useEffect(() => {
    const mark = ref.current;
    const main = mark?.closest("main");
    const host = main?.querySelector<HTMLElement>(":scope > [data-compact-slot]");
    if (!mark || !main || !host) return;
    setSlot(host);
    main.style.setProperty("--compact-h", "3rem");
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e) return;
        const top = e.rootBounds?.top ?? 0;
        setShown(!e.isIntersecting && e.boundingClientRect.top < top);
      },
      { root: main, rootMargin: "-48px 0px 0px 0px", threshold: 0 },
    );
    io.observe(mark);
    return () => {
      io.disconnect();
      main.style.removeProperty("--compact-h");
    };
  }, []);

  return (
    <>
      {/* Absolute in the title row (which must be `relative`): adds no height. */}
      <span
        ref={ref}
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-0 size-px"
      />
      {slot
        ? createPortal(
            <div
              data-compact-title
              data-shown={shown || undefined}
              inert={!shown}
              className="compact-title absolute inset-x-0 top-0 flex h-12 items-center gap-3 border-b bg-card/80 px-5 backdrop-blur-md md:px-10"
            >
              <span
                aria-hidden
                className="min-w-0 flex-1 truncate text-base font-medium max-sm:text-center"
              >
                {title}
              </span>
              {actions ? (
                <div className="flex shrink-0 items-center gap-2 overflow-hidden max-sm:hidden">
                  {actions}
                </div>
              ) : null}
            </div>,
            slot,
          )
        : null}
    </>
  );
}

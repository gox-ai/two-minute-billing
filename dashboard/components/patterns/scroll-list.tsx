"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

/**
 * A list that shows its rows in steps as the reader scrolls, with the same footer as
 * the list pages: the sentinel does the work, the button is the keyboard path.
 * For rows already loaded on the server; `ListPage` is the one that fetches.
 */
export function ScrollList({
  items,
  step = 50,
  className,
}: {
  items: React.ReactNode[];
  step?: number;
  className?: string;
}) {
  // Pages shown, not rows: the count follows `step` instead of freezing its first value.
  const [pages, setPages] = React.useState(1);
  const total = items.length;
  const shown = Math.min(pages * step, total);
  const more = shown < total;
  const showMore = React.useCallback(() => setPages((n) => n + 1), []);

  const sentinel = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = sentinel.current;
    if (!el || !more) return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && showMore(), {
      rootMargin: "400px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [more, showMore]);

  return (
    <>
      <ul className={className}>{items.slice(0, shown)}</ul>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-sm text-muted-foreground">
        <span>
          Showing 1–{Math.min(shown, total).toLocaleString("en")} of {total.toLocaleString("en")}
        </span>
        {more ? (
          <div className="flex items-center gap-3">
            <div ref={sentinel} aria-hidden className="size-px" />
            <Button variant="outline" size="sm" onClick={showMore}>
              Load more
            </Button>
          </div>
        ) : (
          <span>All {total.toLocaleString("en")} loaded</span>
        )}
      </div>
    </>
  );
}

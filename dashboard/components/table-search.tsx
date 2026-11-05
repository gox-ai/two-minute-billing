"use client";

import * as React from "react";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useDebounced } from "@/lib/use-debounced";

/**
 * The search field, owning the state that changes on every keystroke.
 *
 * ── Why this is its own component ──────────────────────────────────────────────
 * `DataTable` already debounced the WORK: the settled value is what re-filters or
 * refetches. But the input's `value` state lived in `DataTable` itself, so every
 * character re-rendered the whole table — rows, cells and all — to produce an
 * identical table with one different character in the toolbar. Debouncing the
 * filter never addressed that; React re-rendered anyway.
 *
 * Measured on `settings/decline-rules`, production build, same input:
 *
 *   67 visible rows / 1800 DOM nodes  →  ~20ms of synchronous work per keystroke
 *    1 visible row  /  279 DOM nodes  →    2ms
 *
 * The cost was the rows, and the rows did not need to render. Keeping the volatile
 * state below the table in the tree is what makes typing cost 2ms regardless of how
 * many rows are on screen — no memoization of the row tree required, which is the
 * fragile way to fix this.
 *
 * The parent hears only settled values, so it re-renders when the RESULTS change
 * rather than when the text does.
 */
export function TableSearch({
  placeholder,
  debounceMs,
  loading,
  externalValue,
  onSettled,
  ariaLabel = "Search table",
  className = "relative w-full max-w-xs",
}: {
  placeholder?: string;
  /** 0 disables the debounce — the parent then hears every keystroke. */
  debounceMs: number;
  /** The request driven by the settled value is still in flight. */
  loading?: boolean;
  /**
   * A value pushed DOWN by the parent (it cleared the search, or restored a saved
   * view). Only adopted when it differs from what we last reported up, so it can
   * never fight the operator mid-word.
   */
  externalValue?: string;
  onSettled: (value: string) => void;
  ariaLabel?: string;
  /** The wrapper's classes — the field positions its icon against this box. */
  className?: string;
}) {
  const [text, setText] = React.useState(externalValue ?? "");
  const settled = useDebounced(text, debounceMs);
  const reported = React.useRef(settled);

  React.useEffect(() => {
    if (settled === reported.current) return;
    reported.current = settled;
    onSettled(settled);
    // `onSettled` is excluded deliberately: an inline arrow from the parent is a new
    // identity every render, and depending on it would re-fire this effect for
    // reasons unrelated to the value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled]);

  React.useEffect(() => {
    if (externalValue === undefined || externalValue === reported.current) return;
    reported.current = externalValue;
    setText(externalValue);
  }, [externalValue]);

  const pending = text !== settled;

  return (
    <div className={className}>
      {/* Spinner while the debounce settles / the request is in flight, so a pause
          after typing reads as "working", not as "nothing happened". */}
      {pending || loading ? (
        <Loader2 className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
      ) : (
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      )}
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        className="h-8 pl-8"
        aria-label={ariaLabel}
      />
    </div>
  );
}

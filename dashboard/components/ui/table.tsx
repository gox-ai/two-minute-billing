"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

// A fixed layout sizes columns from the colgroup, so nowrap text overlaps the next column.
const FixedLayout = React.createContext(false);

/** Cells wrap in a fixed layout unless the caller truncates or keeps the line whole. */
function useCellWrap(className: string | undefined) {
  const fixed = React.useContext(FixedLayout);
  return fixed && !/\b(truncate|whitespace-(nowrap|pre))/.test(className ?? "")
    ? "whitespace-normal wrap-break-word"
    : "whitespace-nowrap";
}

function Table({ className, ...props }: React.ComponentProps<"table">) {
  const fixed = !!className?.includes("table-fixed");
  return (
    <FixedLayout.Provider value={fixed}>
      <div data-slot="table-container" className="relative w-full overflow-x-auto">
        <table
          data-slot="table"
          className={cn(
            "w-full caption-bottom text-sm",
            // Below lg a card is phone-narrow (~430px beside the nav at 768), so fixed columns
            // get a floor and scroll rather than wrap a word per line. A caller resizes it
            // (`max-lg:min-w-*`) or opts out (`max-lg:min-w-0`).
            fixed && "max-lg:min-w-xl",
            className,
          )}
          {...props}
        />
      </div>
    </FixedLayout.Provider>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  // A soft band, so the head reads as chrome without a heavier label.
  return (
    <thead
      data-slot="table-header"
      className={cn("bg-muted/40 [&_tr]:border-b", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  const wrap = useCellWrap(className);
  return (
    <th
      data-slot="table-head"
      className={cn(
        // A 12px label on the head's soft band: it reads as chrome, so the data is the only
        // thing competing for attention.
        //
        // SENTENCE CASE, settled 2026-09-09. This used to add `uppercase`, but Tailwind
        // Preflight resets `text-transform` on `button` and a SORTABLE head renders inside a
        // sort button — so sortable heads came out sentence-case and `enableSorting: false`
        // heads came out UPPERCASE, sometimes in the same header row, and the payments
        // analytics page showed both conventions side by side. Size, weight and tracking do
        // the "this is chrome" job on their own; the case was never load-bearing.
        "h-9 px-3 text-left align-middle text-xs font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0",
        wrap,
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  const wrap = useCellWrap(className);
  return (
    <td
      data-slot="table-cell"
      className={cn(
        // 44px rows with 12px gutters, up from ~33px originally. Row height is
        // where this design gets its breathing room — not from smaller type.
        "h-11 px-3 align-middle [&:has([role=checkbox])]:pr-0",
        wrap,
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };

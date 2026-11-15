"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import {
  cellPlace,
  columnStarts,
  textOf,
  type PhoneHead,
  type PhonePlace,
} from "@/lib/phone-table";
import { installRowPress } from "./row-press";

/**
 * Below 640px: `stack` turns each row into a block (lib/phone-table.ts), `scroll` keeps the
 * grid and scrolls it inside its container with the first column frozen and a fade at the
 * edge. Unset: the table scrolls as it does on a desktop.
 */
type PhoneMode = "stack" | "scroll";

interface Layout {
  // A fixed layout sizes columns from the colgroup, so nowrap text overlaps the next column.
  fixed: boolean;
  phone?: PhoneMode;
  /** The head row records each column as it renders; the body rows after it read them. */
  setHead: (col: number, head: PhoneHead) => void;
  heads: () => PhoneHead[];
}

const NO_HEADS: PhoneHead[] = [];
const TableLayout = React.createContext<Layout>({
  fixed: false,
  setHead: () => {},
  heads: () => NO_HEADS,
});
const InHead = React.createContext(false);

/** Cells wrap in a fixed layout unless the caller truncates or keeps the line whole. */
function useCellWrap(className: string | undefined) {
  const { fixed } = React.useContext(TableLayout);
  return fixed && !/\b(truncate|whitespace-(nowrap|pre))/.test(className ?? "")
    ? "whitespace-normal wrap-break-word"
    : "whitespace-nowrap";
}

// The frozen first column paints the card (the head cell keeps its band), with a hairline edge.
const SCROLL_TABLE =
  "max-sm:[&_tr>:first-child]:sticky max-sm:[&_tr>:first-child]:left-0 max-sm:[&_tr>:first-child]:z-10 max-sm:[&_tr>:first-child]:bg-card max-sm:[&_tr>:first-child]:shadow-[inset_-1px_0_0_var(--border)] max-sm:[&_thead_tr>:first-child]:bg-linear-to-r max-sm:[&_thead_tr>:first-child]:from-muted/40 max-sm:[&_thead_tr>:first-child]:to-muted/40";
// A shadow at the right edge while more columns are hidden; a card-coloured cover attached
// to the content's end hides it once the last column is in view.
const SCROLL_FADE =
  "max-sm:[background:linear-gradient(to_left,var(--card)_40%,transparent)_right/2.5rem_100%_no-repeat_local,linear-gradient(to_left,color-mix(in_oklab,var(--foreground)_18%,transparent),transparent)_right/1rem_100%_no-repeat_scroll]";

function Table({
  className,
  phone,
  ...props
}: React.ComponentProps<"table"> & { phone?: PhoneMode }) {
  const fixed = !!className?.includes("table-fixed");
  const heads = React.useRef<PhoneHead[]>([]);
  const layout = React.useMemo<Layout>(
    () => ({
      fixed,
      phone,
      setHead: (col, head) => {
        heads.current[col] = head;
      },
      heads: () => heads.current,
    }),
    [fixed, phone],
  );
  return (
    <TableLayout.Provider value={layout}>
      <div
        data-slot="table-container"
        data-phone={phone}
        className={cn("relative w-full overflow-x-auto", phone === "scroll" && SCROLL_FADE)}
      >
        <table
          data-slot="table"
          className={cn(
            "w-full caption-bottom text-sm",
            // Below lg a card is phone-narrow (~430px beside the nav at 768), so fixed columns
            // get a floor and scroll rather than wrap a word per line. A caller resizes it
            // (`max-lg:min-w-*`) or opts out (`max-lg:min-w-0`).
            fixed && "max-lg:min-w-xl",
            // Row inset on a phone; a table inside a padded card passes `[--phone-row-x:0]`.
            phone === "stack" && "[--phone-row-x:1.25rem]",
            className,
            phone === "stack" &&
              "max-sm:block max-sm:min-w-0 max-sm:[&>colgroup]:hidden max-sm:[&>tbody]:block max-sm:[&>tfoot]:block max-sm:[&>thead]:hidden",
            phone === "scroll" && SCROLL_TABLE,
          )}
          {...props}
        />
      </div>
    </TableLayout.Provider>
  );
}

/** Children in order, with fragments opened, so each cell's column can be counted. */
function flatCells(children: React.ReactNode): React.ReactNode[] {
  return React.Children.toArray(children).flatMap((c) =>
    React.isValidElement<{ children?: React.ReactNode }>(c) && c.type === React.Fragment
      ? flatCells(c.props.children)
      : [c],
  );
}

type CellProps = { colSpan?: number; phone?: PhonePlace; children?: React.ReactNode };

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  // A soft band, so the head reads as chrome without a heavier label.
  return (
    <InHead.Provider value={true}>
      <thead
        data-slot="table-header"
        className={cn("bg-muted/40 [&_tr]:border-b", className)}
        {...props}
      />
    </InHead.Provider>
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

function TableRow({ className, children, ...props }: React.ComponentProps<"tr">) {
  // A row that answers a click gets a press highlight (row-press.ts); plain data
  // rows never light.
  const pressable = props.onClick != null;
  React.useEffect(() => {
    if (pressable) installRowPress();
  }, [pressable]);
  const { phone, setHead } = React.useContext(TableLayout);
  const inHead = React.useContext(InHead);
  let cells = children;
  if (phone === "stack") {
    // The head row records each column's label and place; a body cell learns its column.
    const list = flatCells(children);
    const starts = columnStarts(
      list.map((c) => (React.isValidElement<CellProps>(c) ? Number(c.props.colSpan) : 1)),
    );
    cells = list.map((c, i) => {
      if (!React.isValidElement<CellProps>(c)) return c;
      if (inHead) {
        setHead(starts[i], { label: textOf(c.props.children).trim(), place: c.props.phone });
        return c;
      }
      return React.cloneElement(c, { "data-col": starts[i] } as Partial<CellProps>);
    });
  }
  return (
    <tr
      data-slot="table-row"
      data-pressable={pressable || undefined}
      className={cn(
        "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        phone === "stack" &&
          "max-sm:grid max-sm:grid-cols-[fit-content(40%)_minmax(0,1fr)_auto] max-sm:items-baseline max-sm:gap-x-3 max-sm:gap-y-1 max-sm:px-(--phone-row-x) max-sm:py-3",
        className,
      )}
      {...props}
    >
      {cells}
    </tr>
  );
}

function TableHead({
  className,
  phone: _phone,
  ...props
}: React.ComponentProps<"th"> & {
  /** Where this column's cells go in a `phone="stack"` table. */
  phone?: PhonePlace;
}) {
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

// A stacked cell is `contents`: its label (::before) and its value box are the row grid's items.
const STACK_LABEL =
  "max-sm:before:col-start-1 max-sm:before:text-left max-sm:before:text-xs max-sm:before:font-normal max-sm:before:whitespace-normal max-sm:before:text-muted-foreground max-sm:before:content-[attr(data-label)]";
// The value box is `contents` from 640px up, so the desktop cell is unchanged. A detail
// without a label (an actions column) takes the full width.
const STACK_VALUE = {
  title: "max-sm:col-[1/3] max-sm:row-start-1 max-sm:text-left",
  aside: "max-sm:col-start-3 max-sm:row-start-1 max-sm:text-right max-sm:whitespace-nowrap",
  labelled: "max-sm:col-[2/-1] max-sm:text-left",
  unlabelled: "max-sm:col-[1/-1] max-sm:text-left",
};

function TableCell({
  className,
  phone,
  children,
  ...props
}: React.ComponentProps<"td"> & {
  /** This cell's place in a `phone="stack"` table; defaults to its column head's. */
  phone?: PhonePlace;
}) {
  const wrap = useCellWrap(className);
  const { phone: mode, heads } = React.useContext(TableLayout);
  const base = cn(
    // 44px rows with 12px gutters, up from ~33px originally. Row height is
    // where this design gets its breathing room — not from smaller type.
    "h-11 px-3 align-middle [&:has([role=checkbox])]:pr-0",
    wrap,
    className,
  );
  if (mode !== "stack") {
    return (
      <td data-slot="table-cell" className={base} {...props}>
        {children}
      </td>
    );
  }
  const col = Number((props as Record<string, unknown>)["data-col"] ?? -1);
  const place = cellPlace(col, heads(), phone);
  const label = place === "detail" ? heads()[col]?.label || undefined : undefined;
  // A cell the caller hides on a phone (`hidden sm:table-cell`) stays hidden.
  const hidden = place === "hide" || /(^|\s)hidden(\s|$)/.test(className ?? "");
  return (
    <td
      data-slot="table-cell"
      data-label={label}
      className={cn(
        base,
        hidden ? "max-sm:hidden" : "max-sm:contents",
        !hidden && label && STACK_LABEL,
      )}
      {...props}
    >
      <div
        className={cn(
          "max-sm:min-w-0 max-sm:wrap-break-word max-sm:whitespace-normal sm:contents",
          place === "title" || place === "aside"
            ? STACK_VALUE[place]
            : STACK_VALUE[label ? "labelled" : "unlabelled"],
        )}
      >
        {children}
      </div>
    </td>
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

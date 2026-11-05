"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { BreakdownRow } from "@/components/reports/report-format";

type Sort = { col: "group" | "value"; dir: "asc" | "desc" } | null;

function SortHead({
  col,
  sort,
  onSort,
  right,
  className,
  children,
}: {
  col: "group" | "value";
  sort: Sort;
  onSort: (col: "group" | "value") => void;
  right?: boolean;
  className?: string;
  children: string;
}) {
  const active = sort?.col === col;
  const Icon = !active ? ChevronsUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(col)}
        aria-label={`Sort by ${children}`}
        className={cn(
          "touch-target relative -mx-1 flex w-full items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-foreground",
          right && "flex-row-reverse",
          active && "text-foreground",
        )}
      >
        <span>{children}</span>
        <Icon className={cn("size-3", !active && "opacity-40")} />
      </button>
    </TableHead>
  );
}

/**
 * The outcome breakdown, sized for a 4-wide card: fixed columns, the label wraps, and the
 * share bar joins its percentage only once the card is wide enough (2xl).
 */
export function ByOutcomeTable({ rows }: { rows: BreakdownRow[] }) {
  const [sort, setSort] = React.useState<Sort>(null);
  const onSort = (col: "group" | "value") =>
    setSort((s) =>
      s?.col !== col ? { col, dir: "desc" } : s.dir === "desc" ? { col, dir: "asc" } : null,
    );
  const total = rows.reduce((a, r) => a + Math.abs(r.value), 0);
  const share = (v: number) => (total > 0 ? Math.abs(v) / total : 0);
  const ordered = !sort
    ? rows
    : [...rows].sort((a, b) => {
        const dir = sort.dir === "asc" ? 1 : -1;
        return sort.col === "group"
          ? a.group.localeCompare(b.group) * dir
          : (a.value - b.value) * dir;
      });

  return (
    <Table className="table-fixed max-lg:min-w-0">
      <TableHeader>
        <TableRow>
          <SortHead col="group" sort={sort} onSort={onSort}>
            Outcome
          </SortHead>
          <SortHead col="value" sort={sort} onSort={onSort} right className="w-24 text-right">
            Invoices
          </SortHead>
          {/* Share orders exactly as the count does, so it sorts the same column. */}
          <SortHead
            col="value"
            sort={sort}
            onSort={onSort}
            right
            className="w-20 text-right 2xl:w-32"
          >
            Share
          </SortHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ordered.map((r) => (
          <TableRow key={r.group_id ?? r.group}>
            <TableCell className="font-medium">
              {r.href ? (
                <Link href={r.href} className="text-primary hover:underline">
                  {r.group}
                </Link>
              ) : (
                r.group
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {r.value.toLocaleString("en")}
            </TableCell>
            <TableCell>
              <div className="flex items-center justify-end gap-2">
                <div className="hidden h-1.5 w-12 shrink-0 overflow-hidden rounded-md bg-muted 2xl:block">
                  <div
                    className="anim-grow h-full rounded-md bg-primary"
                    style={{ width: `${(share(r.value) * 100).toFixed(1)}%` }}
                  />
                </div>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {`${(share(r.value) * 100).toFixed(0)}%`}
                </span>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

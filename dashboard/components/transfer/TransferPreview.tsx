"use client";

import * as React from "react";
import { Chip } from "@/components/patterns/chip";
import { SEGMENT_TRACK, segmentItem } from "@/components/ui/segmented";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ChangeKind, ChangeRow } from "./classify";

function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "Not set";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string" || typeof v === "number") return String(v);
  return JSON.stringify(v);
}

const KIND: Record<ChangeKind, { label: string; tone: "green" | "blue" | "gray" }> = {
  new: { label: "New", tone: "green" },
  replaced: { label: "Replaced", tone: "blue" },
  left_out: { label: "Left out", tone: "gray" },
};

type Filter = "all" | ChangeKind;

/** The change list: one table, filtered in place by what happens to each row. */
export function TransferPreview({ rows }: { rows: ChangeRow[] }) {
  const [filter, setFilter] = React.useState<Filter>("all");
  const count = (k: ChangeKind) => rows.filter((r) => r.kind === k).length;
  const shown = filter === "all" ? rows : rows.filter((r) => r.kind === filter);
  const filters: Array<{ id: Filter; label: string }> = [
    { id: "all", label: `All ${rows.length}` },
    { id: "new", label: `New ${count("new")}` },
    { id: "replaced", label: `Replaced ${count("replaced")}` },
    { id: "left_out", label: `Left out ${count("left_out")}` },
  ];
  const twin = rows.some((r) => r.pair);

  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="Show changes" className={SEGMENT_TRACK}>
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            className={segmentItem(filter === f.id)}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing in this list.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Section</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Now</TableHead>
                <TableHead>After the copy</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="align-top whitespace-nowrap">
                    {r.section}
                    {twin && r.pair && (
                      <div className="text-xs text-muted-foreground">{r.pair}</div>
                    )}
                  </TableCell>
                  <TableCell className="max-w-80 align-top whitespace-normal">
                    {r.item}
                    {r.reason && (
                      <div
                        className={
                          r.problem ? "text-xs text-destructive" : "text-xs text-muted-foreground"
                        }
                      >
                        {r.reason}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="max-w-64 align-top font-mono text-xs break-all whitespace-normal text-muted-foreground">
                    {"from" in r ? show(r.from) : ""}
                  </TableCell>
                  <TableCell className="max-w-64 align-top font-mono text-xs break-all whitespace-normal">
                    {"to" in r ? show(r.to) : ""}
                  </TableCell>
                  <TableCell className="align-top">
                    <Chip tone={r.problem ? "red" : KIND[r.kind].tone}>
                      {r.problem ? "Problem" : KIND[r.kind].label}
                    </Chip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

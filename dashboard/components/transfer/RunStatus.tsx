"use client";

import { Chip } from "@/components/patterns/chip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ItemStatus, TransferJob, SectionReport } from "@/lib/api/transfer";
import { SECTION_LABEL } from "./sections";

const RUN: Record<
  TransferJob["status"],
  { label: string; tone: "green" | "tan" | "red" | "gray" | "blue" }
> = {
  planned: { label: "Not started", tone: "gray" },
  queued: { label: "Waiting", tone: "blue" },
  running: { label: "Copying", tone: "blue" },
  succeeded: { label: "Copied", tone: "green" },
  partially_failed: { label: "Partly copied", tone: "tan" },
  failed: { label: "Failed", tone: "red" },
  cancelled: { label: "Stopped", tone: "gray" },
  superseded: { label: "Replaced", tone: "gray" },
};

export function JobStatus({ status }: { status: TransferJob["status"] }) {
  const s = RUN[status] ?? { label: status, tone: "gray" as const };
  return <Chip tone={s.tone}>{s.label}</Chip>;
}

const ITEM: Record<ItemStatus, { label: string; tone: "green" | "red" | "gray" | "blue" }> = {
  pending: { label: "Waiting", tone: "gray" },
  running: { label: "Copying", tone: "blue" },
  done: { label: "Copied", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  skipped: { label: "Skipped", tone: "gray" },
};

export function ItemStatusChip({ status }: { status: ItemStatus }) {
  const s = ITEM[status];
  return <Chip tone={s.tone}>{s.label}</Chip>;
}

export const ACTIVE: TransferJob["status"][] = ["queued", "running"];
export const TERMINAL: TransferJob["status"][] = [
  "succeeded",
  "partially_failed",
  "failed",
  "cancelled",
  "superseded",
];

/** Per section: what the copy added, changed and left alone. */
export function JobReport({ job, names }: { job: TransferJob; names?: (id: string) => string }) {
  const entries = Object.entries(job.report ?? {}) as Array<[string, SectionReport]>;
  const name = names ?? ((id: string) => id);
  return (
    <div className="space-y-2">
      <p className="text-sm">
        {name(job.source_business)} → {name(job.destination_business)}
        {job.wipe_destination && <span className="text-muted-foreground"> · cleared first</span>}
      </p>
      {entries.length > 0 && (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table phone="stack" className="[--phone-row-x:1rem]">
            <TableHeader>
              <TableRow>
                <TableHead phone="title">Section</TableHead>
                <TableHead className="text-right">Added</TableHead>
                <TableHead className="text-right">Updated</TableHead>
                <TableHead className="text-right">Not changed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map(([section, r]) => (
                <TableRow key={section}>
                  <TableCell>{SECTION_LABEL[section] ?? section}</TableCell>
                  <TableCell className="text-right">{r.created}</TableCell>
                  <TableCell className="text-right">{r.updated}</TableCell>
                  <TableCell className="text-right">{r.skipped}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {job.error && <p className="text-sm text-destructive">{job.error}</p>}
    </div>
  );
}

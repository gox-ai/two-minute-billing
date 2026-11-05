"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/patterns/chip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { TransferJob, SectionReport } from "@/lib/api/transfer";
import { SECTION_LABEL } from "./sections";

export function JobStatus({ status }: { status: TransferJob["status"] }) {
  if (status === "succeeded") return <Chip tone="green">Copied</Chip>;
  if (status === "failed") return <Chip tone="red">Failed</Chip>;
  return <Chip tone="blue">Copying</Chip>;
}

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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Section</TableHead>
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

interface TransferJobCardProps {
  job: TransferJob;
  names: (id: string) => string;
  onRefresh: () => void;
  refreshing?: boolean;
  onDone: () => void;
}

/** The result of the copy that was just run. */
export function TransferJobCard({
  job,
  names,
  onRefresh,
  refreshing,
  onDone,
}: TransferJobCardProps) {
  return (
    <div className="space-y-4 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-medium">Result</span>
        <JobStatus status={job.status} />
        {job.live_override && <Chip tone="tan">Live business updated</Chip>}
        <div className="ml-auto flex gap-2">
          {job.status === "running" && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={refreshing}
              className="gap-1.5"
            >
              <RefreshCw className={`size-3 ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onDone}>
            Start a new copy
          </Button>
        </div>
      </div>
      {job.twin && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            Test businesses <JobStatus status={job.twin.status} />
          </div>
          <JobReport job={job.twin} names={names} />
        </div>
      )}
      <div className="space-y-2">
        {job.twin && (
          <div className="flex items-center gap-2 text-sm font-medium">
            Live businesses <JobStatus status={job.status} />
          </div>
        )}
        <JobReport job={job} names={names} />
      </div>
    </div>
  );
}

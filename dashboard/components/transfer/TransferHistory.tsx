"use client";

import Link from "next/link";
import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Business } from "@/lib/api";
import { useDisplayTz } from "@/components/business-tz";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/patterns/chip";
import { SEGMENT_TRACK, segmentItem } from "@/components/ui/segmented";
import { SegmentIndicator } from "@/components/ui/segment-indicator";
import { SettingsCard } from "@/components/settings/settings-layout";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmtDateTime } from "@/lib/format-date";
import type { TransferHistoryPage, TransferJob } from "@/lib/api/transfer";
import { SECTION_LABEL } from "./sections";
import { JobReport, JobStatus } from "./RunStatus";
import { FLUSH, ModeChip } from "./RouteBand";

type Scope = "business" | "organization";

interface TransferHistoryProps {
  biz: string;
  businesses: Business[];
  listAction: (biz: string, scope: Scope, cursor?: string) => Promise<TransferHistoryPage | null>;
}

/** Past copies, newest first: a report or a link to the run, and "Repeat" for runs from here. */
export function TransferHistory({ biz, businesses, listAction }: TransferHistoryProps) {
  const [scope, setScope] = React.useState<Scope>("business");
  const tz = useDisplayTz();
  const [jobs, setJobs] = React.useState<TransferJob[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);

  const nameOf = (id: string) => {
    const b = businesses.find((x) => x.id === id);
    return b ? `${b.name} (${b.livemode === "live" ? "Live" : "Test"})` : id;
  };
  const bizCell = (id: string) => {
    const b = businesses.find((x) => x.id === id);
    if (!b) return <span className="text-muted-foreground">A deleted business</span>;
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span className="wrap-break-word">{b.name}</span>
        <ModeChip live={b.livemode === "live"} />
      </span>
    );
  };

  React.useEffect(() => {
    let live = true;
    listAction(biz, scope).then((page) => {
      if (!live) return;
      setFailed(!page);
      setJobs(page?.data ?? []);
      setCursor(page?.has_more ? page.next_cursor : null);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [biz, scope, listAction]);

  async function more() {
    if (!cursor) return;
    setLoading(true);
    const page = await listAction(biz, scope, cursor);
    setJobs((j) => [...j, ...(page?.data ?? [])]);
    setCursor(page?.has_more ? page.next_cursor : null);
    setLoading(false);
  }

  return (
    <SettingsCard
      title="Past copies"
      actions={
        <div role="tablist" aria-label="Whose copies" className={SEGMENT_TRACK}>
          <SegmentIndicator />
          {(
            [
              ["business", "This business"],
              ["organization", "Whole organization"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={scope === id}
              className={segmentItem(scope === id)}
              onClick={() => {
                if (id === scope) return;
                setLoading(true);
                setScope(id);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      }
    >
      {failed ? (
        <p className="m-0 px-5 py-4 text-sm text-destructive">
          We could not load the past copies. Reload the page.
        </p>
      ) : !loading && jobs.length === 0 ? (
        <p className="m-0 px-5 py-6 text-sm text-muted-foreground">No copies yet.</p>
      ) : (
        <Table phone="stack" className={FLUSH}>
          <TableHeader>
            <TableRow>
              <TableHead phone="title">From → to</TableHead>
              <TableHead>Sections</TableHead>
              <TableHead phone="aside">Result</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((j) => (
              <React.Fragment key={j.id}>
                <TableRow>
                  <TableCell className="align-top whitespace-normal">
                    <div className="flex items-start gap-1">
                      {j.run_kind !== "async" && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="-ml-1"
                          aria-label={open === j.id ? "Hide the report" : "Show the report"}
                          aria-expanded={open === j.id}
                          onClick={() => setOpen(open === j.id ? null : j.id)}
                        >
                          {open === j.id ? <ChevronDown /> : <ChevronRight />}
                        </Button>
                      )}
                      <div className="flex min-w-0 flex-col gap-1">
                        {bizCell(j.source_business)}
                        <span className="flex items-start gap-1.5">
                          <span aria-hidden className="text-muted-foreground">
                            →
                          </span>
                          {bizCell(j.destination_business)}
                        </span>
                        {j.twin && (
                          <span className="text-xs text-muted-foreground">
                            With the test businesses
                          </span>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="max-w-60 align-top whitespace-normal">
                    {j.sections.map((s) => SECTION_LABEL[s] ?? s).join(", ")}
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">
                    <div className="flex flex-wrap gap-1">
                      <JobStatus status={j.status} />
                      {j.live_override && !["planned", "queued", "running"].includes(j.status) && (
                        <Chip tone="tan">Live business updated</Chip>
                      )}
                    </div>
                    {j.status === "superseded" ? (
                      <div className="mt-1 text-xs text-muted-foreground">
                        A newer check replaced this plan
                      </div>
                    ) : j.counts ? (
                      <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                        {j.counts.done} copied, {j.counts.failed} failed, {j.counts.skipped} skipped
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">
                    <div className="whitespace-nowrap">{fmtDateTime(j.created_at, tz)}</div>
                    <div className="text-xs wrap-break-word text-muted-foreground">
                      {j.started_by ? `by ${j.started_by}` : "Started by: not recorded"}
                    </div>
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex justify-end gap-2 max-sm:justify-start">
                      {j.run_kind === "async" && j.source_business === biz && (
                        <Button variant="outline" size="sm" asChild>
                          <Link href={`?tab=copy&run=${j.id}`}>View</Link>
                        </Button>
                      )}
                      {j.source_business === biz && (
                        <Button variant="outline" size="sm" asChild>
                          <Link href={`?tab=copy&repeat=${j.id}`}>Repeat</Link>
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
                {open === j.id && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={5} className="space-y-3 whitespace-normal">
                      {j.twin && <JobReport job={j.twin} names={nameOf} />}
                      <JobReport job={j} names={nameOf} />
                    </TableCell>
                  </TableRow>
                )}
              </React.Fragment>
            ))}
          </TableBody>
        </Table>
      )}
      {cursor && (
        <div className="flex justify-center px-5 py-3">
          <Button variant="outline" size="sm" onClick={more} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </SettingsCard>
  );
}

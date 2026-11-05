"use client";

import { useDisplayTz } from "@/components/business-tz";
import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { fmtDateTime } from "@/lib/format";
import type { TransferHistoryPage, TransferJob } from "@/lib/api/transfer";
import { SECTION_LABEL } from "./sections";
import { JobReport, JobStatus } from "./TransferJobCard";

type Scope = "business" | "organization";

interface TransferHistoryProps {
  biz: string;
  names: (id: string) => string;
  /** Bumped after a copy, so the list reloads. */
  refreshKey: number;
  listAction: (biz: string, scope: Scope, cursor?: string) => Promise<TransferHistoryPage | null>;
  onRepeat: (job: TransferJob) => void;
}

/** Past copies, newest first, with a per-run report and "Repeat" for runs from this business. */
export function TransferHistory({
  biz,
  names,
  refreshKey,
  listAction,
  onRepeat,
}: TransferHistoryProps) {
  const [scope, setScope] = React.useState<Scope>("business");
  const tz = useDisplayTz();
  const [jobs, setJobs] = React.useState<TransferJob[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);

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
  }, [biz, scope, refreshKey, listAction]);

  async function more() {
    if (!cursor) return;
    setLoading(true);
    const page = await listAction(biz, scope, cursor);
    setJobs((j) => [...j, ...(page?.data ?? [])]);
    setCursor(page?.has_more ? page.next_cursor : null);
    setLoading(false);
  }

  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="Whose copies" className={SEGMENT_TRACK}>
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
      {failed ? (
        <p className="text-sm text-destructive">
          We could not load the past copies. Reload the page.
        </p>
      ) : !loading && jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No copies yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>When</TableHead>
                <TableHead>From → to</TableHead>
                <TableHead>Sections</TableHead>
                <TableHead>Result</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((j) => (
                <React.Fragment key={j.id}>
                  <TableRow>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={open === j.id ? "Hide the report" : "Show the report"}
                        onClick={() => setOpen(open === j.id ? null : j.id)}
                      >
                        {open === j.id ? <ChevronDown /> : <ChevronRight />}
                      </Button>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {fmtDateTime(j.created_at, tz)}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {names(j.source_business)} → {names(j.destination_business)}
                      {j.twin && (
                        <div className="text-xs text-muted-foreground">
                          With the test businesses
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="max-w-72 whitespace-normal">
                      {j.sections.map((s) => SECTION_LABEL[s] ?? s).join(", ")}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <JobStatus status={j.status} />
                        {j.live_override && <Chip tone="tan">Live business updated</Chip>}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {j.source_business === biz && (
                        <Button variant="outline" size="sm" onClick={() => onRepeat(j)}>
                          Repeat
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                  {open === j.id && (
                    <TableRow>
                      <TableCell />
                      <TableCell colSpan={5} className="space-y-3 whitespace-normal">
                        {j.twin && <JobReport job={j.twin} names={names} />}
                        <JobReport job={j} names={names} />
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {cursor && (
        <Button variant="outline" size="sm" onClick={more} disabled={loading}>
          {loading ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}

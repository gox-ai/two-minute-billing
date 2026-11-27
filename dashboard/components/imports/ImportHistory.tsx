"use client";

import Link from "next/link";
import * as React from "react";
import type { ImportRun, ImportRunPage } from "@/lib/api/imports";
import { useDisplayTz } from "@/components/business-tz";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/patterns/chip";
import { SettingsCard } from "@/components/settings/settings-layout";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FLUSH } from "@/components/transfer/RouteBand";
import { fmtDateTime } from "@/lib/format-date";
import { plural } from "@/lib/labels";
import { ENTITY_LABEL, RUN_STATUS, fmt } from "./labels";
import { createdCount, failedCount, newCount } from "./steps";

function resultLine(r: ImportRun): string | null {
  if (r.status === "undone") {
    const n = Object.values(r.result?.undo ?? {}).reduce((a, b) => a + b, 0);
    return `${fmt(n)} deleted`;
  }
  if (["succeeded", "partially_failed", "failed"].includes(r.status))
    return `${fmt(createdCount(r))} added, ${fmt(failedCount(r))} failed`;
  if (r.status === "checked" && r.summary) return `${plural(newCount(r), "new record")} found`;
  return null;
}

/** Past imports, newest first, with who and when. Each opens on the Import files tab. */
export function ImportHistory({
  biz,
  listAction,
}: {
  biz: string;
  listAction: (biz: string, cursor?: string) => Promise<ImportRunPage | null>;
}) {
  const tz = useDisplayTz();
  const [runs, setRuns] = React.useState<ImportRun[]>([]);
  const [hasMore, setHasMore] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    listAction(biz).then((page) => {
      if (!live) return;
      setFailed(!page);
      setRuns(page?.data ?? []);
      setHasMore(!!page?.has_more);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [biz, listAction]);

  async function more() {
    const last = runs[runs.length - 1];
    if (!last) return;
    setLoading(true);
    const page = await listAction(biz, last.id);
    setRuns((r) => [...r, ...(page?.data ?? [])]);
    setHasMore(!!page?.has_more);
    setLoading(false);
  }

  return (
    <SettingsCard title="Past imports">
      {failed ? (
        <p className="m-0 px-5 py-4 text-sm text-destructive">
          We could not load the past imports. Reload the page.
        </p>
      ) : loading && runs.length === 0 ? (
        <p className="m-0 px-5 py-6 text-sm text-muted-foreground">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="m-0 px-5 py-6 text-sm text-muted-foreground">No imports yet.</p>
      ) : (
        <Table phone="stack" className={FLUSH}>
          <TableHeader>
            <TableRow>
              <TableHead phone="title">Files</TableHead>
              <TableHead>Sections</TableHead>
              <TableHead phone="aside">Result</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((r) => {
              const s = RUN_STATUS[r.status];
              const line = resultLine(r);
              const at = r.started_at ?? r.created_at;
              const by = r.started_by ?? r.created_by;
              return (
                <TableRow key={r.id}>
                  <TableCell className="max-w-72 align-top whitespace-normal">
                    <span className="wrap-break-word">
                      {r.files.map((f) => f.filename).join(", ")}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-60 align-top whitespace-normal">
                    {r.files.map((f) => ENTITY_LABEL[f.entity]).join(", ")}
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">
                    <Chip tone={s.tone}>{s.label}</Chip>
                    {line && (
                      <div className="mt-1 text-xs text-muted-foreground tabular-nums">{line}</div>
                    )}
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">
                    <div className="whitespace-nowrap">{fmtDateTime(at, tz)}</div>
                    <div className="text-xs wrap-break-word text-muted-foreground">
                      {by ? `by ${by}` : "By: not recorded"}
                    </div>
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex justify-end max-sm:justify-start">
                      <Button variant="outline" size="sm" asChild>
                        <Link href={`/businesses/${biz}/imports?tab=files&run=${r.id}`}>View</Link>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {hasMore && (
        <div className="flex justify-center px-5 py-3">
          <Button variant="outline" size="sm" onClick={more} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </SettingsCard>
  );
}

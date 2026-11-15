"use client";

import * as React from "react";
import { toast } from "sonner";
import { Search } from "lucide-react";
import type { TransferItem, TransferRun } from "@/lib/api/transfer";
import type { RunResult } from "@/app/(dashboard)/businesses/[biz]/transfer/actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/patterns/chip";
import { SEGMENT_TRACK, segmentItem } from "@/components/ui/segmented";
import { SegmentIndicator } from "@/components/ui/segment-indicator";
import { SettingsCard } from "@/components/settings/settings-layout";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDisplayTz } from "@/components/business-tz";
import { fmtDateTime } from "@/lib/format-date";
import { useDebounced } from "@/lib/use-debounced";
import { progressCounts, statusCount, type StatusFilter } from "@/lib/transfer-items";
import { SECTION_LABEL, fieldLabel } from "./sections";
import { ACTIVE, ItemStatusChip, JobStatus } from "./RunStatus";
import { FLUSH } from "./RouteBand";
import { ConfirmCopyDialog } from "./ConfirmCopyDialog";
import { useItemPages, type InitialPage, type ListItemsAction } from "./use-item-pages";

const SKIP_TEXT: Record<string, string> = {
  dependency: "An item that it needs was not copied.",
  cancelled: "The copy stopped before this item.",
  drift: "The set-up changed after the check.",
};

const detail = (i: TransferItem) =>
  i.error ?? (i.skip_reason ? (SKIP_TEXT[i.skip_reason] ?? "") : "");

const fmt = (n: number) => n.toLocaleString("en-US");

function Bar({
  done,
  failed,
  skipped,
  total,
  label = "Progress",
}: Record<"done" | "failed" | "skipped" | "total", number> & { label?: string }) {
  const pct = (n: number) => (total ? (n / total) * 100 : 0);
  return (
    <div
      className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done + failed + skipped}
    >
      <div className="bg-success transition-[width]" style={{ width: `${pct(done)}%` }} />
      <div className="bg-destructive transition-[width]" style={{ width: `${pct(failed)}%` }} />
      <div
        className="bg-muted-foreground/40 transition-[width]"
        style={{ width: `${pct(skipped)}%` }}
      />
    </div>
  );
}

/** A row of figure cells that wraps with hairlines between. */
function Figures({ cells }: { cells: Array<{ label: string; n: number; red?: boolean }> }) {
  return (
    <div className="flex flex-wrap gap-px bg-border">
      {cells.map((c) => (
        <div key={c.label} className="flex flex-[1_1_8rem] flex-col bg-card px-5 py-3">
          <span className="text-xs text-muted-foreground">{c.label}</span>
          <span
            className={
              c.red && c.n > 0
                ? "text-xl font-semibold text-destructive tabular-nums"
                : "text-xl font-semibold tabular-nums"
            }
          >
            {fmt(c.n)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** A queued, running or ended run: overall and per-section progress, then each item. */
export function RunProgress({
  biz,
  run,
  names,
  canOverride,
  initial,
  cancelAction,
  retryAction,
  listItems,
  onRun,
  onNew,
}: {
  biz: string;
  run: TransferRun;
  names: (id: string, bare?: boolean) => string;
  canOverride: boolean;
  initial?: InitialPage | null;
  cancelAction: (biz: string, run: string) => Promise<RunResult>;
  retryAction: (biz: string, run: string, confirm?: string) => Promise<RunResult>;
  listItems: ListItemsAction;
  onRun: (run: TransferRun) => void;
  onNew: () => void;
}) {
  const tz = useDisplayTz();
  const active = ACTIVE.includes(run.status);
  const progress = progressCounts(run.summary);
  const c = run.counts ?? progress;
  // An ended run with failures opens on them; otherwise on every queued item.
  const [filter, setFilter] = React.useState<StatusFilter>(
    !active && progress.failed > 0 ? "failed" : "queued",
  );
  const [search, setSearch] = React.useState("");
  const q = useDebounced(search.trim(), 250);
  const [stopOpen, setStopOpen] = React.useState(false);
  const [retryOpen, setRetryOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<"stop" | "retry" | null>(null);

  const destName = names(run.destination_business, true);
  // With its mode: a test twin shares its live business's name.
  const destLabel = names(run.destination_business);
  const retryable = run.status === "partially_failed" || run.status === "failed";
  const again = run.summary.retryable;
  const stopping = active && !!run.cancel_requested_at;
  // Each poll that moves the run reloads the items shown.
  const token = `${run.status}:${run.updated_at}:${c.done}:${c.failed}:${c.skipped}:${c.running}`;

  const sectionName = (s: { pair: string; section: string }) =>
    `${s.pair === "twin" ? "Test businesses · " : ""}${SECTION_LABEL[s.section] ?? s.section}`;
  const queuedSections = run.summary.sections.filter((s) => s.progress.total > 0);
  const list = useItemPages({
    biz,
    run: run.id,
    query: { status: filter, ...(q ? { q } : {}) },
    token,
    listItems,
    initial,
  });
  // The first item not done is the one the runner holds: it copies in plan order.
  const next = useItemPages({
    biz,
    run: run.id,
    query: { status: "open", limit: 1 },
    token,
    listItems,
    enabled: run.status === "running",
  });
  const now = next.items[0]?.status === "running" ? next.items[0] : null;
  const shown = list.items;
  const total = statusCount(progress, filter);

  // What the copy wrote, from the summary.
  const sum = (f: (s: TransferRun["summary"]["sections"][number]) => number) =>
    run.summary.sections.reduce((n, s) => n + f(s), 0);
  const added = sum((s) => s.applied?.new ?? 0);
  const updated = sum((s) => s.applied?.updated ?? 0);
  const deleted = sum((s) => s.applied?.deleted ?? 0);
  const same = run.summary.results.unchanged + run.summary.results.kept;

  async function stop() {
    setBusy("stop");
    try {
      const r = await cancelAction(biz, run.id);
      if (r.ok) {
        setStopOpen(false);
        onRun(r.run);
      } else toast.error(r.message);
    } finally {
      setBusy(null);
    }
  }

  async function retry(confirm?: string) {
    setBusy("retry");
    try {
      const r = await retryAction(biz, run.id, confirm);
      if (r.ok) {
        setRetryOpen(false);
        toast.success("Copy started again.");
        onRun(r.run);
      } else toast.error(r.message);
    } finally {
      setBusy(null);
    }
  }

  const countsLine = (
    <p className="m-0 text-sm text-muted-foreground tabular-nums">
      {fmt(c.done)} copied, {fmt(c.failed)} failed, {fmt(c.skipped)} skipped, of {fmt(c.total)}
      {run.status === "queued" ? ". Waiting for the copy to start." : ""}
    </p>
  );

  const who = (
    <>
      {run.started_by ? `Started by ${run.started_by}` : "Started"}
      {run.queued_at ? ` ${fmtDateTime(run.queued_at, tz)}` : ""}
      {run.finished_at ? `. Ended ${fmtDateTime(run.finished_at, tz)}` : ""}
      {run.cancelled_by && run.status === "cancelled" ? `. Stopped by ${run.cancelled_by}` : ""}.
    </>
  );

  return (
    <div className="flex flex-col gap-5">
      {active ? (
        <SettingsCard
          title={
            <span className="flex flex-wrap items-center gap-2">
              Copy in progress <JobStatus status={run.status} />
              {stopping && <Chip tone="gray">Stopping</Chip>}
            </span>
          }
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => setStopOpen(true)}
              disabled={stopping || busy !== null}
            >
              Stop the copy
            </Button>
          }
        >
          <div className="flex flex-col gap-2 px-5 py-4">
            <Bar done={c.done} failed={c.failed} skipped={c.skipped} total={c.total} />
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              {countsLine}
              {now && (
                <p className="m-0 flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                  <span aria-hidden className="size-2 shrink-0 rounded-full bg-info" />
                  Now copying:
                  <span className="min-w-0 truncate font-medium text-foreground">{now.label}</span>
                  <span>· {fieldLabel(now.kind)}</span>
                </p>
              )}
            </div>
            <p className="m-0 text-xs text-muted-foreground">
              The copy continues if you close this page.
            </p>
          </div>
          {queuedSections.length > 0 && (
            <Table phone="stack" className={FLUSH}>
              <TableHeader>
                <TableRow>
                  <TableHead phone="title">Section</TableHead>
                  <TableHead className="w-48" phone="hide">
                    Progress
                  </TableHead>
                  <TableHead className="text-right">Copied</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead className="text-right">Skipped</TableHead>
                  <TableHead className="text-right" phone="aside">
                    Items
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queuedSections.map((s) => (
                  <TableRow key={`${s.pair}:${s.section}`}>
                    <TableCell className="whitespace-normal">{sectionName(s)}</TableCell>
                    <TableCell>
                      <Bar {...s.progress} label={`${sectionName(s)} progress`} />
                    </TableCell>
                    <TableCell className="text-right">{fmt(s.progress.done)}</TableCell>
                    <TableCell className="text-right">{fmt(s.progress.failed)}</TableCell>
                    <TableCell className="text-right">{fmt(s.progress.skipped)}</TableCell>
                    <TableCell className="text-right">{fmt(s.progress.total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SettingsCard>
      ) : (
        <SettingsCard
          title={
            <span className="flex flex-wrap items-center gap-2">
              {run.status === "cancelled" ? "Copy stopped" : "Copy finished"}
              <JobStatus status={run.status} />
              {run.live_override && <Chip tone="tan">Live business updated</Chip>}
            </span>
          }
          actions={
            <>
              <Button variant="outline" size="sm" onClick={onNew}>
                Start a new copy
              </Button>
              {retryable && again > 0 && (
                <Button size="sm" onClick={() => setRetryOpen(true)} disabled={busy !== null}>
                  Try the failed items again
                </Button>
              )}
            </>
          }
          footer={<span className="text-xs text-muted-foreground">{who}</span>}
        >
          <Figures
            cells={[
              { label: "Added", n: added },
              { label: "Updated", n: updated },
              ...(deleted > 0 ? [{ label: "Deleted", n: deleted }] : []),
              { label: "Not changed", n: same },
              { label: "Failed", n: c.failed, red: true },
            ]}
          />
          {(c.failed > 0 || c.skipped > 0 || run.status === "cancelled") && (
            <div className="flex flex-col gap-2 px-5 py-4">
              <Bar done={c.done} failed={c.failed} skipped={c.skipped} total={c.total} />
              {countsLine}
            </div>
          )}
          {run.error && (
            <div className="px-5 py-4">
              <Alert tone={run.status === "failed" ? "error" : "warning"}>{run.error}</Alert>
            </div>
          )}
          {run.summary.sections.length > 0 && (
            <Table phone="stack" className={FLUSH}>
              <TableHeader>
                <TableRow>
                  <TableHead phone="title">Section</TableHead>
                  <TableHead className="text-right">Added</TableHead>
                  <TableHead className="text-right">Updated</TableHead>
                  {deleted > 0 && <TableHead className="text-right">Deleted</TableHead>}
                  <TableHead className="text-right">Not changed</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {run.summary.sections.map((s) => (
                  <TableRow key={`${s.pair}:${s.section}`}>
                    <TableCell className="whitespace-normal">{sectionName(s)}</TableCell>
                    <TableCell className="text-right">{fmt(s.applied?.new ?? 0)}</TableCell>
                    <TableCell className="text-right">{fmt(s.applied?.updated ?? 0)}</TableCell>
                    {deleted > 0 && (
                      <TableCell className="text-right">{fmt(s.applied?.deleted ?? 0)}</TableCell>
                    )}
                    <TableCell className="text-right">
                      {fmt(s.results.unchanged + s.results.kept)}
                    </TableCell>
                    <TableCell className="text-right">{fmt(s.progress.failed)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SettingsCard>
      )}

      {progress.total > 0 && (
        <SettingsCard
          title="Items"
          actions={
            <div role="tablist" aria-label="Show items" className={SEGMENT_TRACK}>
              <SegmentIndicator />
              {(
                [
                  ["queued", "All"],
                  ["open", "Not done"],
                  ["done", "Copied"],
                  ["failed", "Failed"],
                  ["skipped", "Skipped"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={filter === id}
                  className={segmentItem(filter === id)}
                  onClick={() => setFilter(id)}
                >
                  {label}
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {fmt(statusCount(progress, id))}
                  </span>
                </button>
              ))}
            </div>
          }
        >
          <div className="flex flex-wrap items-center gap-3 px-5 py-3">
            <div className="relative min-w-0 flex-[1_1_16rem] sm:max-w-sm">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                aria-label="Search items"
                className="pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or code"
                maxLength={200}
                autoComplete="off"
              />
            </div>
          </div>
          {list.failed && !list.loading ? (
            <div className="px-5 py-4">
              <Alert tone="error">We could not load the items. Reload the page.</Alert>
            </div>
          ) : shown.length === 0 ? (
            <div className="flex flex-wrap items-center gap-3 px-5 py-6 text-sm text-muted-foreground">
              <span>{list.loading ? "Loading…" : "No items in this list."}</span>
              {!list.loading && search && (
                <Button variant="outline" size="sm" onClick={() => setSearch("")}>
                  Clear search
                </Button>
              )}
            </div>
          ) : (
            <>
              <Table phone="stack" className={FLUSH}>
                <TableHeader>
                  <TableRow>
                    <TableHead phone="title">Item</TableHead>
                    <TableHead phone="aside">Status</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((i) => (
                    <ItemRow key={i.key} i={i} />
                  ))}
                </TableBody>
              </Table>
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <span className="text-xs text-muted-foreground tabular-nums">
                  {q
                    ? `Showing ${fmt(shown.length)}`
                    : `Showing ${fmt(shown.length)} of ${fmt(total)}`}
                </span>
                {list.hasMore && (
                  <Button variant="outline" size="sm" onClick={list.more} disabled={list.loading}>
                    {list.loading ? "Loading…" : "Show more"}
                  </Button>
                )}
              </div>
            </>
          )}
        </SettingsCard>
      )}

      <Dialog open={stopOpen} onOpenChange={setStopOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Stop the copy?</DialogTitle>
            <DialogDescription>
              The copy stops after the item that it copies now. Items that are copied stay in{" "}
              {destLabel}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStopOpen(false)} disabled={busy !== null}>
              Continue the copy
            </Button>
            <Button variant="destructive" onClick={stop} disabled={busy !== null}>
              {busy === "stop" ? "Stopping…" : "Stop the copy"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmCopyDialog
        open={retryOpen}
        onOpenChange={setRetryOpen}
        title="Try the failed items again?"
        summary={`${again} ${again === 1 ? "item goes" : "items go"} into ${destLabel} again.`}
        destName={destName}
        typedConfirm={run.live_override_needed}
        blocked={
          run.live_override_needed && !canOverride
            ? "These items change records of a live business. Only an owner or an admin can start them again."
            : null
        }
        busy={busy === "retry"}
        action="Try again"
        onConfirm={retry}
      />
    </div>
  );
}

function ItemRow({ i }: { i: TransferItem }) {
  return (
    <TableRow>
      <TableCell className="align-top whitespace-normal">
        <div className="wrap-break-word">{i.label}</div>
        <div className="text-xs text-muted-foreground">
          {fieldLabel(i.kind)} · {i.pair === "twin" ? "Test businesses · " : ""}
          {SECTION_LABEL[i.section] ?? i.section}
        </div>
      </TableCell>
      <TableCell className="align-top">
        <ItemStatusChip status={i.status} />
      </TableCell>
      <TableCell
        className={
          i.status === "failed"
            ? "align-top wrap-break-word whitespace-normal text-destructive"
            : "align-top wrap-break-word whitespace-normal text-muted-foreground"
        }
      >
        {detail(i)}
        {i.attempts > 1 && (
          <div className="text-xs text-muted-foreground">{i.attempts} attempts</div>
        )}
      </TableCell>
    </TableRow>
  );
}

"use client";

import * as React from "react";
import { toast } from "sonner";
import type { Business } from "@/lib/api";
import type { ImportEntity, ImportRun } from "@/lib/api/imports";
import type { ImportRunResult } from "@/app/(dashboard)/businesses/[biz]/imports/actions";
import { Alert } from "@/components/ui/alert";
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
import { useDisplayTz } from "@/components/business-tz";
import { fmtDateTime } from "@/lib/format-date";
import { plural } from "@/lib/labels";
import { ENTITY_LABEL, ENTITY_NOUN, FINISHED, RUN_STATUS, fmt } from "./labels";
import { RowsPanel, type ListRowsAction, type RowTab } from "./RowsPanel";
import { ConfirmTypedDialog } from "./ConfirmTypedDialog";
import { DownloadLinks } from "./ImportReview";
import { createdCount, newCount } from "./steps";

/** What an undo deletes, per record type, in the words of the card. */
const UNDO_NOUN: Record<string, [string, string]> = {
  customers: ["customer", "customers"],
  subscriptions: ["subscription", "subscriptions"],
  prices: ["price", "prices"],
  products: ["plan or add-on", "plans and add-ons"],
  coupons: ["coupon", "coupons"],
  payment_methods: ["saved card", "saved cards"],
  applied_coupons: ["coupon on a subscription", "coupons on subscriptions"],
  invoices: ["invoice", "invoices"],
  credit_notes: ["credit note", "credit notes"],
  payments: ["payment", "payments"],
  refunds: ["refund", "refunds"],
  gateway_transactions: ["gateway transaction", "gateway transactions"],
  usage_records: ["usage record", "usage records"],
};

function StatusChip({ run }: { run: ImportRun }) {
  const s = RUN_STATUS[run.status];
  return <Chip tone={s.tone}>{s.label}</Chip>;
}

/** A queued, running, finished or undone import. */
export function ImportProgress({
  biz,
  business,
  run,
  canManage,
  listRows,
  undoAction,
  onRun,
  onNew,
}: {
  biz: string;
  business: Business | undefined;
  run: ImportRun;
  canManage: boolean;
  listRows: ListRowsAction;
  undoAction: (biz: string, run: string, confirm?: string) => Promise<ImportRunResult>;
  onRun: (run: ImportRun) => void;
  onNew: () => void;
}) {
  const tz = useDisplayTz();
  const [undoOpen, setUndoOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const live = business?.livemode === "live";

  async function undo(confirm?: string) {
    setBusy(true);
    const r = await undoAction(biz, run.id, confirm);
    setBusy(false);
    if (!r.ok) return toast.error(r.message);
    setUndoOpen(false);
    onRun(r.run);
  }

  const who = (
    <>
      {run.started_by ? `Started by ${run.started_by}` : "Started"}
      {run.started_at ? ` ${fmtDateTime(run.started_at, tz)}` : ""}
      {run.finished_at ? `. Ended ${fmtDateTime(run.finished_at, tz)}` : ""}.
    </>
  );

  if (run.status === "queued" || run.status === "running") {
    const p = run.result?.progress;
    const total = p?.total ?? newCount(run);
    const done = Math.min(p?.done ?? 0, total);
    return (
      <SettingsCard
        title={
          <span className="flex flex-wrap items-center gap-2">
            Import in progress <StatusChip run={run} />
          </span>
        }
      >
        <div className="flex flex-col gap-2 px-5 py-4">
          <div
            className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Import progress"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
          >
            <div
              className="bg-success transition-[width]"
              style={{ width: `${total ? (done / total) * 100 : 0}%` }}
            />
          </div>
          <p className="m-0 text-sm text-muted-foreground tabular-nums">
            {run.status === "queued"
              ? `Waiting to start. ${plural(total, "record")} to import.`
              : `${fmt(done)} of ${fmt(total)} records imported.`}
          </p>
          <p className="m-0 text-xs text-muted-foreground">
            You can leave this page. The import continues, and we send an email to the person who
            started it when it ends.
          </p>
        </div>
      </SettingsCard>
    );
  }

  if (run.status === "undoing" || run.status === "undone") {
    const deleted = Object.entries(run.result?.undo ?? {}).filter(
      ([k, n]) => n > 0 && k !== "ledger_reversals",
    );
    const reversed = run.result?.undo?.ledger_reversals ?? 0;
    return (
      <SettingsCard
        title={
          <span className="flex flex-wrap items-center gap-2">
            {run.status === "undoing" ? "Undoing the import" : "Import undone"}{" "}
            <StatusChip run={run} />
          </span>
        }
        actions={
          run.status === "undone" ? (
            <Button variant="outline" size="sm" onClick={onNew}>
              Start a new import
            </Button>
          ) : null
        }
        footer={
          <span className="text-xs text-muted-foreground">
            {run.undone_by ? `Undone by ${run.undone_by}` : "Undone"}
            {run.undone_at ? ` ${fmtDateTime(run.undone_at, tz)}` : ""}.
          </span>
        }
      >
        <div className="px-5 py-4 text-sm">
          {run.status === "undoing" ? (
            <p className="m-0 text-muted-foreground">
              We are deleting the records this import added. You can leave this page.
            </p>
          ) : deleted.length ? (
            <p className="m-0">
              Deleted{" "}
              {deleted
                .map(([k, n]) => {
                  const w = UNDO_NOUN[k];
                  return w ? plural(n, w[0], w[1]) : `${fmt(n)} ${k}`;
                })
                .join(", ")}
              .
            </p>
          ) : (
            <p className="m-0 text-muted-foreground">The import added nothing to delete.</p>
          )}
          {reversed > 0 && (
            <p className="m-0 mt-2 text-muted-foreground">
              The opening balances of {plural(reversed, "document")} are reversed in the ledger.
            </p>
          )}
          {run.error && (
            <Alert tone="error" className="mt-3">
              {run.error}
            </Alert>
          )}
        </div>
      </SettingsCard>
    );
  }

  // Finished: succeeded, partially_failed or failed.
  const entities = run.files.map((f) => f.entity);
  const per = run.result?.entities ?? {};
  const sum = (k: "created" | "unchanged" | "failed" | "excluded") =>
    entities.reduce((n, e) => n + (per[e]?.[k] ?? 0), 0);
  const counts = (k: "created" | "unchanged" | "failed" | "excluded") =>
    Object.fromEntries(entities.map((e) => [e, per[e]?.[k] ?? 0])) as Partial<
      Record<ImportEntity, number>
    >;
  const blockers = run.undo_blockers ?? null;
  const canUndo =
    canManage && FINISHED.includes(run.status) && blockers != null && !blockers.length;
  const added = createdCount(run);

  const tabs: RowTab[] = [
    {
      id: "created",
      label: "Added",
      counts: counts("created"),
      sub: "New in this business",
      filter: { outcome: "created" },
    },
    {
      id: "failed",
      label: "Failed",
      counts: counts("failed"),
      sub: "Not added",
      red: true,
      filter: { outcome: "failed" },
    },
    {
      id: "unchanged",
      label: "Not changed",
      counts: counts("unchanged"),
      sub: "In this business already",
      filter: { outcome: "unchanged" },
    },
    {
      id: "excluded",
      label: "Left out",
      counts: counts("excluded"),
      sub: "Not imported",
      filter: { outcome: "excluded" },
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <SettingsCard
        title={
          <span className="flex flex-wrap items-center gap-2">
            Import finished <StatusChip run={run} />
          </span>
        }
        actions={
          <>
            {canUndo && added > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive"
                onClick={() => setUndoOpen(true)}
              >
                Undo import
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={onNew}>
              Start a new import
            </Button>
          </>
        }
        footer={
          <span className="text-xs text-muted-foreground">
            {who}
            {canUndo && added > 0
              ? " You can undo this import until the first renewal, payment or change on a record it added."
              : ""}
          </span>
        }
      >
        {run.error && (
          <div className="px-5 py-4">
            <Alert tone={run.status === "failed" ? "error" : "warning"}>{run.error}</Alert>
          </div>
        )}
        <Table phone="stack" className={FLUSH}>
          <TableHeader>
            <TableRow>
              <TableHead phone="title">Section</TableHead>
              <TableHead className="text-right">Added</TableHead>
              <TableHead className="text-right">Not changed</TableHead>
              <TableHead className="text-right">Left out</TableHead>
              <TableHead className="text-right">Failed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entities.map((e) => (
              <TableRow key={e}>
                <TableCell className="whitespace-normal">{ENTITY_LABEL[e]}</TableCell>
                <TableCell className="text-right">{fmt(per[e]?.created ?? 0)}</TableCell>
                <TableCell className="text-right">{fmt(per[e]?.unchanged ?? 0)}</TableCell>
                <TableCell className="text-right">{fmt(per[e]?.excluded ?? 0)}</TableCell>
                <TableCell className="text-right">{fmt(per[e]?.failed ?? 0)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="px-5 py-3 text-sm">
          <DownloadLinks biz={biz} run={run} files={run.files} label="Download results" />
        </div>
        {blockers && blockers.length > 0 && added > 0 && (
          <div className="px-5 py-4">
            <Alert tone="neutral" title="You cannot undo this import">
              <ul className="m-0 list-inside list-disc space-y-1 p-0">
                {blockers.map((b) => (
                  <li key={b.code}>{b.message}</li>
                ))}
              </ul>
            </Alert>
          </div>
        )}
      </SettingsCard>

      <RowsPanel
        biz={biz}
        runId={run.id}
        version={run.finished_at ?? run.id}
        entities={entities}
        tabs={tabs}
        initialTab={sum("failed") ? "failed" : "created"}
        listRows={listRows}
      />

      <ConfirmTypedDialog
        open={undoOpen}
        onOpenChange={setUndoOpen}
        title="Undo this import?"
        description={
          <>
            This deletes the {plural(added, "record")} the import added in{" "}
            {business?.name ?? "this business"}: {undoList(per, entities)}. Records that were in the
            business before stay as they are.
            {entities.some((e) => e === "invoices" || e === "credit_notes")
              ? " The opening balances of open invoices and credit are reversed in the ledger."
              : ""}{" "}
            You cannot undo this.
          </>
        }
        name={live ? (business?.name ?? "") : null}
        busy={busy}
        destructive
        action="Undo import"
        busyLabel="Undoing…"
        onConfirm={undo}
      />
    </div>
  );
}

function undoList(
  per: Partial<Record<ImportEntity, { created: number }>>,
  entities: ImportEntity[],
): string {
  return entities
    .filter((e) => (per[e]?.created ?? 0) > 0)
    .map((e) => plural(per[e]!.created, ENTITY_NOUN[e][0], ENTITY_NOUN[e][1]))
    .join(", ");
}

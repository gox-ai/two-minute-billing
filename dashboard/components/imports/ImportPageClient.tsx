"use client";

import * as React from "react";
import { toast } from "sonner";
import { useSearchParams } from "next/navigation";
import type { Business } from "@/lib/api";
import type { ImportEntity, ImportOptions, ImportRun, TemplateField } from "@/lib/api/imports";
import type { ImportRunResult } from "@/app/(dashboard)/businesses/[biz]/imports/actions";
import { useDisplayTz } from "@/components/business-tz";
import { BizTile, RouteBand } from "@/components/transfer/RouteBand";
import { SettingsCard } from "@/components/settings/settings-layout";
import { fmtDateTime } from "@/lib/format-date";
import { useDefaultState } from "@/lib/use-default-state";
import { ImportForm } from "./ImportForm";
import { ImportReview } from "./ImportReview";
import { ImportProgress } from "./ImportProgress";
import { FilesTile } from "./FilesTile";
import { ACTIVE } from "./labels";
import { createdCount, failedCount, importSteps } from "./steps";
import type { ListRowsAction } from "./RowsPanel";

const POLL_MS = 2000;

function endToast(run: ImportRun) {
  const failed = failedCount(run);
  const added = createdCount(run);
  if (run.status === "checked") return;
  if (run.status === "succeeded") toast.success("Import finished.");
  else if (run.status === "partially_failed")
    toast.warning(`Import partly finished. ${failed} ${failed === 1 ? "row" : "rows"} failed.`);
  else if (run.status === "failed")
    toast.error(
      added ? "The import failed. Read the errors." : "The import failed. Nothing was added.",
    );
  else if (run.status === "undone") toast.success("Import undone.");
}

/** `?run=<id>` names the import on screen, so a reload or a second tab opens the same state. */
function writeUrl(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("run", id);
  else url.searchParams.delete("run");
  url.searchParams.delete("section");
  window.history.replaceState(null, "", url.pathname + url.search);
}

export interface ImportActions {
  getAction: (biz: string, run: string) => Promise<ImportRun | null>;
  listRowsAction: ListRowsAction;
  recheckAction: (
    biz: string,
    run: string,
    body: {
      mapping?: Partial<Record<ImportEntity, Record<string, string | null>>>;
      options?: ImportOptions;
    },
  ) => Promise<ImportRunResult>;
  startAction: (biz: string, run: string, confirm?: string) => Promise<ImportRunResult>;
  undoAction: (biz: string, run: string, confirm?: string) => Promise<ImportRunResult>;
  discardAction: (biz: string, run: string) => Promise<ImportRunResult>;
}

/** The "Import files" tab: the form, or the import on screen. */
export function ImportPageClient({
  biz,
  business,
  canManage,
  initialRun,
  focus,
  fields,
  explainer,
  actions,
}: {
  biz: string;
  business: Business | undefined;
  canManage: boolean;
  initialRun: ImportRun | null;
  focus: ImportEntity | null;
  fields: Partial<Record<ImportEntity, TemplateField[]>>;
  explainer: React.ReactNode;
  actions: ImportActions;
}) {
  const tz = useDisplayTz();
  const [run, setRun] = useDefaultState<ImportRun | null>(initialRun, (r) => r?.id ?? "");
  const [formKey, setFormKey] = React.useState(0);
  const runRef = React.useRef(run);
  React.useLayoutEffect(() => {
    runRef.current = run;
  }, [run]);
  const urlRun = useSearchParams().get("run");
  const { getAction } = actions;

  const show = React.useCallback(
    (r: ImportRun | null) => {
      runRef.current = r;
      setRun(r);
      if ((r?.id ?? null) !== new URL(window.location.href).searchParams.get("run"))
        writeUrl(r?.id ?? null);
    },
    [setRun],
  );

  // The URL leads: back/forward or a "View" link loads that import.
  const prevUrl = React.useRef(urlRun);
  React.useEffect(() => {
    const prev = prevUrl.current;
    prevUrl.current = urlRun;
    if (urlRun === prev || urlRun === (runRef.current?.id ?? null)) return;
    if (!urlRun) {
      runRef.current = null;
      setRun(null);
      return;
    }
    let live = true;
    getAction(biz, urlRun).then((r) => {
      if (!live) return;
      if (!r) {
        toast.error("We could not find this import. It is not from this business.");
        writeUrl(null);
      }
      runRef.current = r;
      setRun(r);
    });
    return () => {
      live = false;
    };
  }, [urlRun, biz, getAction, setRun]);

  // Poll while the check, the import or the undo runs; one toast when it ends.
  const activeId = run && ACTIVE.includes(run.status) ? run.id : null;
  React.useEffect(() => {
    if (!activeId) return;
    let stopped = false;
    const tick = async () => {
      const r = await getAction(biz, activeId);
      if (stopped || !r || runRef.current?.id !== activeId) return;
      if (!ACTIVE.includes(r.status)) endToast(r);
      show(r);
    };
    const t = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [activeId, biz, getAction, show]);

  function toForm() {
    show(null);
    setFormKey((k) => k + 1);
  }

  if (!run || run.status === "discarded")
    return (
      <ImportForm
        key={formKey}
        biz={biz}
        business={business}
        focus={focus}
        canManage={canManage}
        explainer={explainer}
        onRun={(r) => show(r)}
      />
    );

  const before = ["uploaded", "checking", "checked"].includes(run.status);
  const checking =
    run.status === "checking" || run.status === "uploaded" || (before && !run.summary);
  const when = before ? (run.checked_at ?? run.created_at) : (run.started_at ?? run.created_at);
  const by = before ? run.created_by : run.started_by;

  return (
    <div className="flex flex-col gap-5">
      <RouteBand
        label="Import route"
        from={<FilesTile count={run.files.length} names={run.files.map((f) => f.filename)} />}
        to={<BizTile label="To" biz={business} />}
        aside={
          <>
            <span>
              {before ? (run.checked_at ? "Checked" : "Uploaded") : "Started"}{" "}
              {fmtDateTime(when, tz)}
            </span>
            {by ? <span>by {by}</span> : null}
          </>
        }
        steps={importSteps(run)}
      />
      {checking ? (
        <SettingsCard title="Checking the files">
          <p className="m-0 px-5 py-4 text-sm text-muted-foreground">
            We are reading each row and comparing it with what is in this business. Nothing changes
            yet. This page updates when the check ends.
          </p>
        </SettingsCard>
      ) : run.status === "checked" ? (
        <ImportReview
          key={`${run.id}:${run.checked_at}`}
          biz={biz}
          business={business}
          run={run}
          fields={fields}
          canManage={canManage}
          listRows={actions.listRowsAction}
          recheckAction={actions.recheckAction}
          startAction={actions.startAction}
          discardAction={actions.discardAction}
          onRun={show}
          onDiscarded={toForm}
        />
      ) : (
        <ImportProgress
          key={run.id}
          biz={biz}
          business={business}
          run={run}
          canManage={canManage}
          listRows={actions.listRowsAction}
          undoAction={actions.undoAction}
          onRun={show}
          onNew={toForm}
        />
      )}
    </div>
  );
}

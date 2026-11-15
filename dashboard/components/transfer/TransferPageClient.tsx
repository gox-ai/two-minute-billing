"use client";

import * as React from "react";
import { toast } from "sonner";
import { useSearchParams } from "next/navigation";
import type { Business } from "@/lib/api";
import type { PlanRequest, TransferRun } from "@/lib/api/transfer";
import type { RunResult } from "@/app/(dashboard)/businesses/[biz]/transfer/actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useDisplayTz } from "@/components/business-tz";
import { fmtDateTime } from "@/lib/format-date";
import { useDefaultState } from "@/lib/use-default-state";
import { TransferForm } from "./TransferForm";
import { seedOf, type TransferSeed } from "./seed";
import { PlanReview, type PlanInitial } from "./PlanReview";
import { RunProgress } from "./RunProgress";
import { BizTile, RouteBand, stepsOf } from "./RouteBand";
import type { InitialPage, ListItemsAction } from "./use-item-pages";
import { ACTIVE } from "./RunStatus";

/** Poll interval while a run is queued or running. */
const POLL_MS = 2000;

interface TransferPageClientProps {
  biz: string;
  businesses: Business[];
  canOverride: boolean;
  /** The run named by `?run=`, else this business's open plan or active run. Counts only. */
  initialRun: TransferRun | null;
  /** The first item pages of `initialRun`, loaded with the page. */
  initialItems?: { plan?: PlanInitial; progress?: InitialPage | null } | null;
  /** The choices of a past copy, for "Repeat" (`?repeat=`). */
  initialSeed?: TransferSeed | null;
  /** What the copy takes and leaves; shown on request. */
  explainer: React.ReactNode;
  planAction: (biz: string, body: PlanRequest) => Promise<RunResult>;
  getRunAction: (biz: string, run: string) => Promise<TransferRun | null>;
  setItemsAction: (
    biz: string,
    run: string,
    change: { exclude?: string[]; include?: string[] },
  ) => Promise<RunResult>;
  applyAction: (biz: string, run: string, confirm?: string) => Promise<RunResult>;
  retryAction: (biz: string, run: string, confirm?: string) => Promise<RunResult>;
  cancelAction: (biz: string, run: string) => Promise<RunResult>;
  listItemsAction: ListItemsAction;
  excludedKeysAction: (biz: string, run: string) => Promise<string[] | null>;
}

function endToast(run: TransferRun) {
  const failed = run.counts?.failed ?? 0;
  if (run.status === "succeeded") toast.success("Set-up copied.");
  else if (run.status === "partially_failed")
    toast.warning(`Set-up partly copied. ${failed} ${failed === 1 ? "item" : "items"} failed.`);
  else if (run.status === "failed")
    toast.error("We could not copy the set-up. Read the errors, then try the failed items again.");
  else if (run.status === "cancelled") toast("Copy stopped.");
}

/** `?run=<id>` names the run on screen, so a reload or a second tab opens the same state. */
function writeUrl(id: string | null, push = false) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("run", id);
  else url.searchParams.delete("run");
  url.searchParams.delete("repeat");
  window.history[push ? "pushState" : "replaceState"](null, "", url.pathname + url.search);
}

/** The "Copy set-up" tab: the form, or the plan or run on screen. */
export function TransferPageClient({
  biz,
  businesses,
  canOverride,
  initialRun,
  initialItems,
  initialSeed,
  explainer,
  planAction,
  getRunAction,
  setItemsAction,
  applyAction,
  retryAction,
  cancelAction,
  listItemsAction,
  excludedKeysAction,
}: TransferPageClientProps) {
  const tz = useDisplayTz();
  const [run, setRun] = useDefaultState<TransferRun | null>(initialRun, (r) => r?.id ?? "");
  const [seed, setSeed] = useDefaultState<TransferSeed | null>(initialSeed ?? null, (v) =>
    JSON.stringify(v),
  );
  // A new key remounts the form, so it starts from the seed.
  const [formKey, setFormKey] = React.useState(0);
  const topRef = React.useRef<HTMLDivElement>(null);
  const runRef = React.useRef(run);
  React.useEffect(() => {
    runRef.current = run;
  }, [run]);
  const urlRun = useSearchParams().get("run");

  // "Name (Test)" for display; `bare` is the exact name a typed confirmation must match.
  const names = React.useCallback(
    (id: string, bare?: boolean) => {
      const b = businesses.find((x) => x.id === id);
      if (!b) return id;
      return bare ? b.name : `${b.name} (${b.livemode === "live" ? "Live" : "Test"})`;
    },
    [businesses],
  );

  const show = React.useCallback(
    (r: TransferRun | null, push = false) => {
      runRef.current = r;
      setRun(r);
      if ((r?.id ?? null) !== new URL(window.location.href).searchParams.get("run"))
        writeUrl(r?.id ?? null, push);
    },
    [setRun],
  );

  // The URL leads: back/forward or an edited `?run=` loads that run. Acts only when the
  // param changes, so a double-run effect (strict mode) cannot clear the run on screen.
  const prevUrl = React.useRef(urlRun);
  React.useEffect(() => {
    const prev = prevUrl.current;
    prevUrl.current = urlRun;
    if (urlRun === prev) {
      if (!urlRun && runRef.current) writeUrl(runRef.current.id);
      return;
    }
    if (urlRun === (runRef.current?.id ?? null)) return;
    if (!urlRun) {
      runRef.current = null;
      setRun(null);
      return;
    }
    let live = true;
    getRunAction(biz, urlRun).then((r) => {
      if (!live) return;
      if (!r) {
        toast.error("We could not find this copy. It is not from this business.");
        writeUrl(null);
      }
      runRef.current = r;
      setRun(r);
    });
    return () => {
      live = false;
    };
  }, [urlRun, biz, getRunAction, setRun]);

  // Poll while the run is queued or running; one toast when it ends.
  const activeId = run && ACTIVE.includes(run.status) ? run.id : null;
  React.useEffect(() => {
    if (!activeId) return;
    let stopped = false;
    const tick = async () => {
      const r = await getRunAction(biz, activeId);
      if (stopped || !r || runRef.current?.id !== activeId) return;
      if (!ACTIVE.includes(r.status)) endToast(r);
      show(r);
    };
    const t = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [activeId, biz, getRunAction, show]);

  // The pages loaded with the page fit only the run as it was then.
  const fresh = !!run && run.id === initialRun?.id && run.updated_at === initialRun.updated_at;

  function toForm(next: TransferSeed | null) {
    setSeed(next);
    show(null);
    setFormKey((k) => k + 1);
    topRef.current?.scrollIntoView({ block: "start" });
  }

  if (!run)
    return (
      <div ref={topRef} className="flex scroll-mt-24 flex-col gap-5">
        <TransferForm
          key={formKey}
          biz={biz}
          businesses={businesses}
          canOverride={canOverride}
          seed={seed}
          explainer={explainer}
          planAction={planAction}
          onPlan={(r) => show(r)}
        />
      </div>
    );

  const bizOf = (id: string) => businesses.find((b) => b.id === id);
  const planned = run.status === "planned" || run.status === "superseded";
  const when = planned ? run.created_at : (run.queued_at ?? run.created_at);
  const by = planned ? run.planned_by : run.started_by;

  return (
    <div ref={topRef} className="flex scroll-mt-24 flex-col gap-5">
      <RouteBand
        from={<BizTile label="From" biz={bizOf(run.source_business)} />}
        to={<BizTile label="To" biz={bizOf(run.destination_business)} />}
        aside={
          <>
            <span>
              {planned ? "Checked" : "Started"} {fmtDateTime(when, tz)}
            </span>
            {by ? <span>by {by}</span> : null}
          </>
        }
        steps={stepsOf(run)}
      />
      {run.status === "planned" ? (
        <PlanReview
          key={run.id}
          biz={biz}
          run={run}
          names={names}
          canOverride={canOverride}
          initial={fresh ? initialItems?.plan : null}
          planAction={planAction}
          setItemsAction={setItemsAction}
          applyAction={applyAction}
          listItems={listItemsAction}
          excludedKeys={excludedKeysAction}
          onRun={(r) => show(r)}
          onChangeOptions={(exclude) => toForm({ ...seedOf(run), exclude })}
        />
      ) : run.status === "superseded" ? (
        <Alert
          tone="info"
          title="A newer check replaced this plan"
          action={
            <Button variant="outline" size="sm" onClick={() => toForm(seedOf(run))}>
              Start a new copy
            </Button>
          }
        >
          Nothing was copied from this plan.
        </Alert>
      ) : (
        <RunProgress
          key={run.id}
          biz={biz}
          run={run}
          names={names}
          canOverride={canOverride}
          initial={fresh ? initialItems?.progress : null}
          cancelAction={cancelAction}
          retryAction={retryAction}
          listItems={listItemsAction}
          onRun={(r) => show(r)}
          onNew={() => toForm(null)}
        />
      )}
    </div>
  );
}

"use client";

import * as React from "react";
import { ArrowRight, Check } from "lucide-react";
import type { Business } from "@/lib/api";
import type { TransferRun } from "@/lib/api/transfer";
import { Chip } from "@/components/patterns/chip";
import { Alert } from "@/components/ui/alert";
import { initialsOf } from "@/components/brand/brand-mark";
import { cn } from "@/lib/utils";
import { plural } from "@/lib/labels";

/** A table that runs edge to edge in a card: its outer cells line up with the card's padding. */
export const FLUSH = "sm:[&_tr>:first-child]:pl-5 sm:[&_tr>:last-child]:pr-5";

/** "Live" or "Test" beside a business name. */
export function ModeChip({ live }: { live: boolean }) {
  return <Chip tone={live ? "gray" : "tan"}>{live ? "Live" : "Test"}</Chip>;
}

function Mark({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="flex size-10 shrink-0 items-center justify-center rounded-md border border-brand-border bg-brand-soft text-sm font-semibold text-brand"
    >
      {initialsOf(name)}
    </span>
  );
}

/** One end of the copy: a business with its mode. `children` replaces the name (a picker). */
export function BizTile({
  label,
  biz,
  labelFor,
  picker,
}: {
  label: string;
  biz: Business | undefined;
  labelFor?: string;
  picker?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-[1_1_16rem] items-center gap-3 rounded-xl border bg-card px-4 py-3 max-sm:px-3 max-sm:py-2",
        picker &&
          "border-input focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
      )}
    >
      {biz ? <Mark name={biz.name} /> : null}
      <div className="flex min-w-0 flex-1 flex-col">
        {labelFor ? (
          <label htmlFor={labelFor} className="text-xs text-muted-foreground">
            {label}
          </label>
        ) : (
          <span className="text-xs text-muted-foreground">{label}</span>
        )}
        {picker ??
          (biz ? (
            <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium">
              <span className="min-w-0 wrap-break-word">{biz.name}</span>
              <ModeChip live={biz.livemode === "live"} />
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">Not found</span>
          ))}
      </div>
    </div>
  );
}

type StepState = "todo" | "current" | "done" | "warn" | "error";
interface Step {
  label: string;
  sub: string;
  state: StepState;
}

const changesOf = (run: TransferRun) =>
  run.summary.results.new + run.summary.results.updated + run.summary.results.deleted;

/** The three steps, from the run on screen (none: the form). */
export function stepsOf(run: TransferRun | null): Step[] {
  if (!run)
    return [
      { label: "Set up", sub: "Select what to copy", state: "current" },
      { label: "Review", sub: "See each change", state: "todo" },
      { label: "Copy", sub: "Write to the destination", state: "todo" },
    ];
  const setup: Step = {
    label: "Set up",
    sub: plural(run.sections.length, "section"),
    state: "done",
  };
  const n = changesOf(run);
  const review: Step = {
    label: "Review",
    sub: run.status === "superseded" ? "Replaced" : plural(n, "change"),
    state: run.status === "planned" || run.status === "superseded" ? "current" : "done",
  };
  const c = run.counts ?? { total: 0, done: 0, failed: 0, skipped: 0 };
  const copy: Step =
    run.status === "planned" || run.status === "superseded"
      ? { label: "Copy", sub: "Write to the destination", state: "todo" }
      : run.status === "queued"
        ? { label: "Copy", sub: "Waiting to start", state: "current" }
        : run.status === "running"
          ? { label: "Copy", sub: `${c.done} of ${c.total} copied`, state: "current" }
          : run.status === "succeeded"
            ? { label: "Copied", sub: `${c.done} of ${c.total} copied`, state: "done" }
            : run.status === "cancelled"
              ? { label: "Stopped", sub: `${c.done} of ${c.total} copied`, state: "todo" }
              : {
                  label: run.status === "failed" ? "Failed" : "Partly copied",
                  sub: `${plural(c.failed, "item")} failed`,
                  state: run.status === "failed" ? "error" : "warn",
                };
  return [setup, review, copy];
}

const DOT: Record<StepState, string> = {
  todo: "border bg-card text-muted-foreground",
  current: "bg-solid text-solid-foreground",
  done: "border border-brand-border bg-brand-soft text-brand",
  warn: "border border-warning/30 bg-warning-soft text-warning",
  error: "border border-destructive/30 bg-destructive-soft text-destructive",
};

/** Read-only: where the copy is. The run status drives it. */
export function StepBar({ steps }: { steps: Step[] }) {
  return (
    <ol aria-label="Steps" className="m-0 flex list-none items-center gap-3 p-0">
      {steps.map((s, i) => (
        <React.Fragment key={s.label + i}>
          {i > 0 && (
            <li
              aria-hidden
              className={cn(
                "h-px min-w-4 flex-1 max-sm:hidden",
                steps[i - 1]!.state === "done" ? "bg-brand/40" : "bg-border",
              )}
            />
          )}
          {i > 0 && (
            <li aria-hidden className="text-muted-foreground sm:hidden">
              ·
            </li>
          )}
          <li
            className="flex shrink-0 items-center gap-2.5"
            aria-current={s.state === "current" ? "step" : undefined}
          >
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums",
                DOT[s.state],
              )}
            >
              {s.state === "done" ? (
                <Check className="size-3.5" aria-hidden />
              ) : s.state === "warn" || s.state === "error" ? (
                "!"
              ) : (
                i + 1
              )}
            </span>
            <span className="flex flex-col leading-tight">
              <span
                className={cn(
                  "text-sm",
                  s.state === "todo" ? "text-muted-foreground" : "font-medium",
                )}
              >
                {s.label}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums max-sm:hidden">
                {s.sub}
              </span>
            </span>
          </li>
        </React.Fragment>
      ))}
    </ol>
  );
}

/** From → To, what sits at the right, then the step bar. */
export function RouteBand({
  from,
  to,
  aside,
  steps,
  children,
}: {
  from: React.ReactNode;
  to: React.ReactNode;
  aside?: React.ReactNode;
  steps: Step[];
  /** Under the tiles: a warning, the explainer. */
  children?: React.ReactNode;
}) {
  return (
    <section
      aria-label="Copy route"
      className="anim-rise overflow-hidden rounded-xl border bg-card"
    >
      <div className="flex flex-col gap-4 p-5 max-sm:p-4">
        <div className="flex flex-wrap items-center gap-3">
          {from}
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-card text-muted-foreground max-sm:hidden"
          >
            <ArrowRight className="size-4" />
          </span>
          {to}
          {aside ? (
            <div className="flex flex-[1_1_12rem] flex-col items-end gap-1 text-right text-xs text-muted-foreground max-sm:items-start max-sm:text-left">
              {aside}
            </div>
          ) : null}
        </div>
        {children}
      </div>
      <div className="border-t bg-muted/30 px-5 py-3 max-sm:px-4">
        <StepBar steps={steps} />
      </div>
    </section>
  );
}

/** The warning on a live destination. */
export function LiveWarning({ name }: { name: string }) {
  return (
    <Alert tone="warning" title="This copy changes a live business">
      {name} has customers that bill from these records, so it is never cleared. New records are
      always added. Each section sets what happens to a record that is in both businesses. To update
      a record, an owner or an admin types the business name to confirm.
    </Alert>
  );
}

/** The sticky bar at the foot of the page: a status line, then the actions. */
export function ActionBar({
  status,
  children,
}: {
  status: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      data-action-bar
      className="sticky bottom-0 z-10 -mx-5 -mb-(--main-pb) flex flex-wrap items-center gap-x-3 gap-y-2 border-t bg-card px-5 py-3 md:-mx-10 md:px-10"
    >
      <p className="m-0 min-w-0 flex-[1_1_16rem] text-sm text-muted-foreground">{status}</p>
      <div className="ml-auto flex items-center gap-2 max-sm:w-full max-sm:[&>*:last-child]:flex-1">
        {children}
      </div>
    </div>
  );
}

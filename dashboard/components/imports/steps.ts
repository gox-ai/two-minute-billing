import type { ImportRun } from "@/lib/api/imports";
import type { Step } from "@/components/transfer/RouteBand";
import { plural } from "@/lib/labels";
import { fmt } from "./labels";

/** New records the check found: what the import adds. */
export function newCount(run: ImportRun): number {
  const s = run.summary;
  if (!s) return 0;
  // Subscriptions and invoices count once each, not once per row (item or line).
  let n = s.subscriptions.new + (s.history?.invoices ?? 0);
  for (const [e, c] of Object.entries(s.entities))
    if (e !== "subscriptions" && e !== "invoices") n += c?.new ?? 0;
  return n;
}

/** Records the run added, per its result. */
export function createdCount(run: ImportRun): number {
  return Object.values(run.result?.entities ?? {}).reduce((n, c) => n + (c?.created ?? 0), 0);
}

export function failedCount(run: ImportRun): number {
  return Object.values(run.result?.entities ?? {}).reduce((n, c) => n + (c?.failed ?? 0), 0);
}

/** The three steps, from the run on screen (none: the form). */
export function importSteps(run: ImportRun | null): Step[] {
  if (!run)
    return [
      { label: "Set up", sub: "Select files", state: "current" },
      { label: "Review", sub: "See each change", state: "todo" },
      { label: "Import", sub: "Write to this business", state: "todo" },
    ];
  const setup: Step = { label: "Set up", sub: plural(run.files.length, "file"), state: "done" };
  const before = run.status === "uploaded" || run.status === "checking" || run.status === "checked";
  const review: Step =
    run.status === "checking" || run.status === "uploaded"
      ? { label: "Review", sub: "Checking the files", state: "current" }
      : {
          label: "Review",
          sub: plural(newCount(run), "new record"),
          state: before ? "current" : "done",
        };
  const p = run.result?.progress;
  const imp: Step = before
    ? { label: "Import", sub: "Write to this business", state: "todo" }
    : run.status === "queued"
      ? { label: "Import", sub: "Waiting to start", state: "current" }
      : run.status === "running"
        ? {
            label: "Import",
            sub: p ? `${fmt(p.done)} of ${fmt(p.total)} imported` : "Starting",
            state: "current",
          }
        : run.status === "succeeded"
          ? { label: "Imported", sub: `${fmt(createdCount(run))} added`, state: "done" }
          : run.status === "partially_failed"
            ? { label: "Partly imported", sub: `${fmt(failedCount(run))} failed`, state: "warn" }
            : run.status === "failed"
              ? { label: "Failed", sub: "Nothing added", state: "error" }
              : run.status === "undoing"
                ? { label: "Undoing", sub: "Deleting what it added", state: "current" }
                : { label: "Undone", sub: "Deleted what it added", state: "done" };
  return [setup, review, imp];
}

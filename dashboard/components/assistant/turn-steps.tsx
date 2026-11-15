"use client";

import * as React from "react";
import { Check, ChevronRight, CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { stepsSummary } from "@/lib/assistant-reply";
import type { Step } from "./chat-messages";

/** The steps as a list: the running one marked and in ink, finished ones ticked. */
function StepItems({ steps }: { steps: Step[] }) {
  return (
    <ol className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-muted-foreground">
      {steps.map((s) => (
        <li
          key={s.id}
          aria-current={s.phase === "running" ? "step" : undefined}
          className={cn(
            "flex items-start gap-1.5",
            s.phase === "running" && "font-medium text-foreground",
          )}
        >
          <span className="flex h-[1.125rem] shrink-0 items-center">
            {s.phase === "done" ? (
              <Check className="size-3.5 text-success" aria-hidden />
            ) : s.phase === "error" ? (
              <CircleAlert className="size-3.5 text-destructive" aria-hidden />
            ) : (
              <span className="flex size-3.5 items-center justify-center" aria-hidden>
                <span className="size-2 rounded-full bg-primary motion-safe:animate-pulse" />
              </span>
            )}
          </span>
          <span className="min-w-0 wrap-break-word">
            {s.label}
            {s.phase === "error" ? <span className="sr-only"> (failed)</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * What Billy did for one answer. While the turn runs, every step shows as it arrives; once
 * the answer is complete they fold into one line ("Used 3 steps") that opens the list again.
 */
export function TurnSteps({ steps, live }: { steps: Step[]; live: boolean }) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  if (!steps.length) return null;
  if (live) return <StepItems steps={steps} />;
  const failed = steps.some((s) => s.phase === "error");
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="-ml-1 inline-flex h-6 items-center gap-1 self-start rounded-md px-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ChevronRight
          className={cn("size-3.5 transition-transform duration-(--dur-fast)", open && "rotate-90")}
          aria-hidden
        />
        {failed ? <CircleAlert className="size-3.5 text-destructive" aria-hidden /> : null}
        {stepsSummary(steps)}
      </button>
      {open ? (
        <div id={id} className="pl-1">
          <StepItems steps={steps} />
        </div>
      ) : null}
    </div>
  );
}

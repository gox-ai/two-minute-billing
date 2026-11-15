"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { pullArmed, refreshDone } from "@/lib/gestures";
import { motionMs } from "@/lib/motion";

/**
 * Pull to refresh's indicator (`PULL_TO_REFRESH`, lib/motion.ts). `MainGestures` renders it
 * once and drives it through `createPull`: `data-state` and `--pull-p` (0 at rest, 1 armed)
 * are the whole interface, and `app/motion/pull-refresh.css` does the rest.
 *
 * Fixed over the top of <main>, clipped there so the chip slides out from under the edge.
 * It takes no space and no pointer events, and sits under dialogs (z-30 < z-50).
 */
export function PullIndicator({ ref }: { ref: React.Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      data-pull-refresh
      data-state="idle"
      role="status"
      aria-live="polite"
      className="pull-refresh pointer-events-none fixed top-0 left-0 z-30 w-0 overflow-hidden"
    >
      <div
        aria-hidden
        className="pull-refresh-chip flex size-8 items-center justify-center rounded-full border border-popover-border bg-card shadow-lg"
      >
        <RefreshCw className="pull-refresh-icon size-4 text-muted-foreground" />
      </div>
      <span data-pull-text className="sr-only" />
    </div>
  );
}

type State = "idle" | "pull" | "armed" | "settle" | "refreshing" | "done";

/**
 * The indicator's state machine. `run` starts the page's refresh and returns a probe for
 * whether it is still pending; the chip spins until it is not (see `refreshDone`).
 */
export function createPull(el: HTMLElement, main: HTMLElement, run: () => () => boolean) {
  const text = el.querySelector<HTMLElement>("[data-pull-text]");
  let state: State = "idle";
  let timer = 0;
  let poll = 0;

  const set = (s: State) => {
    state = s;
    el.dataset.state = s;
  };
  const setP = (p: number) => el.style.setProperty("--pull-p", p.toFixed(4));
  const clearTimers = () => {
    window.clearTimeout(timer);
    window.clearInterval(poll);
    timer = 0;
    poll = 0;
  };
  // A timer, not `transitionend`: a window that renders no frames never ends one.
  const after = (fn: () => void) => {
    timer = window.setTimeout(fn, motionMs("--dur-out") + 50);
  };
  /** Over <main>, below the compact title bar when it shows. */
  const place = () => {
    const r = main.getBoundingClientRect();
    const bar = main.querySelector<HTMLElement>("[data-compact-title][data-shown]");
    el.style.left = `${r.left}px`;
    el.style.top = `${r.top + (bar?.offsetHeight ?? 0)}px`;
    el.style.width = `${main.clientWidth}px`;
  };
  const idle = () => {
    clearTimers();
    set("idle");
    el.style.removeProperty("--pull-p");
    if (text) text.textContent = "";
  };
  const settle = () => {
    set("settle");
    setP(0);
    after(idle);
  };
  const finish = () => {
    clearTimers();
    set("done");
    if (text) text.textContent = "";
    after(idle);
  };
  const refresh = () => {
    set("refreshing");
    setP(1);
    if (text) text.textContent = "Refreshing";
    let pending: () => boolean = () => false;
    try {
      pending = run();
    } catch {
      // A failed start still lets the chip finish.
    }
    const t0 = performance.now();
    poll = window.setInterval(() => {
      let busy = false;
      try {
        busy = pending();
      } catch {
        // Treat a probe that throws as done.
      }
      if (refreshDone(performance.now() - t0, busy)) finish();
    }, 100);
  };

  return {
    /** A refresh is running or finishing: no new pull starts. */
    get busy() {
      return state === "refreshing" || state === "done";
    },
    /** The pull's progress (lib/gestures.ts `pullProgress`). */
    move(p: number) {
      if (state === "refreshing" || state === "done") return;
      if (state === "idle" || state === "settle") {
        if (p <= 0) return;
        clearTimers();
        place();
      }
      setP(p);
      set(pullArmed(p) ? "armed" : "pull");
    },
    /** The finger or the wheel let go: an armed pull refreshes when `commit`. */
    release(commit: boolean) {
      if (state === "armed" && commit) refresh();
      else if (state === "pull" || state === "armed") settle();
    },
    reset: idle,
  };
}

export type Pull = ReturnType<typeof createPull>;

"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { motionMs } from "@/lib/motion";
import { cn } from "@/lib/utils";

/*
 * Buyer-page motion helpers (app/motion/storefront.css). Each one marks a CHANGE, never a
 * first paint: the page entrance is CSS alone, so these stay quiet on load.
 */

const noSubscribe = () => () => {};

/** A list row that slides in when it arrives after the page loaded (a card just added). */
export function ArriveRow({
  rowId,
  className,
  children,
}: {
  rowId: string;
  className?: string;
  children: React.ReactNode;
}) {
  // False while the server HTML hydrates; true for a row that mounts on the client later.
  const fresh = React.useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
  const [arrived] = React.useState(fresh);
  return (
    <li data-sf-row={rowId} className={cn(arrived && "sf-arrive", className)}>
      {children}
    </li>
  );
}

/** Pops its content in when `value` changes after the first render (a chip that moved). */
export function PopOnChange({ value, children }: { value: string; children: React.ReactNode }) {
  const [seen, setSeen] = React.useState({ cur: value, changed: false });
  if (seen.cur !== value) setSeen({ cur: value, changed: true });
  // Nothing to show (the chip moved off this row): no empty box in a gapped row.
  if (!seen.changed || children == null || children === false) return <>{children}</>;
  return (
    <span key={value} className="sf-pop inline-flex">
      {children}
    </span>
  );
}

type RowEl = React.ReactElement<{ rowId?: string }>;

/**
 * A `RowList` of `ArriveRow`s whose removed rows collapse out: a row that leaves the
 * server's list stays where it was for one `--dur`, closing to zero height, then goes.
 */
export function ExitRowList({ children }: { children: React.ReactNode }) {
  const items = React.Children.toArray(children) as RowEl[];
  const keys = keysOf(items);
  // The previous render's rows, so a leaving row keeps its latest look.
  const last = React.useRef(items);
  const [seenKeys, setSeenKeys] = React.useState(keys);
  const [leaving, setLeaving] = React.useState<{ el: RowEl; at: number }[]>([]);
  if (seenKeys !== keys) {
    const now = new Set(items.map((e) => e.key));
    const gone = last.current.map((el, at) => ({ el, at })).filter((x) => !now.has(x.el.key));
    setSeenKeys(keys);
    setLeaving((l) => [...l.filter((x) => !now.has(x.el.key)), ...gone]);
  }
  React.useLayoutEffect(() => {
    last.current = items;
  });

  const ulRef = React.useRef<HTMLUListElement>(null);
  React.useLayoutEffect(() => {
    if (leaving.length === 0) return;
    const ms = motionMs("--dur");
    for (const { el: row } of leaving) {
      const id = row.props.rowId;
      const el = id
        ? ulRef.current?.querySelector<HTMLElement>(`[data-sf-row="${CSS.escape(id)}"]`)
        : null;
      if (!el || ms === 0 || el.hasAttribute("data-sf-leaving")) continue;
      el.style.height = `${el.offsetHeight}px`;
      void el.offsetHeight;
      el.setAttribute("data-sf-leaving", "");
    }
    const t = setTimeout(() => setLeaving([]), ms);
    return () => clearTimeout(t);
  }, [leaving]);

  const shown = [...items];
  for (const { el, at } of leaving) shown.splice(Math.min(at, shown.length), 0, el);
  return (
    <ul ref={ulRef} className="divide-y">
      {shown}
    </ul>
  );
}

function keysOf(els: RowEl[]): string {
  return els.map((e) => e.key).join("|");
}

/** A commit button's label: a spinner leads it while the payment runs. */
export function BusyLabel({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  if (!busy) return <>{children}</>;
  return (
    <>
      <Loader2 className="animate-spin" aria-hidden />
      {children}
    </>
  );
}

"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * 0149 — the CONTEXTUAL diff: the whole record on both sides, with unchanged lines
 * kept as context and the moved ones marked.
 *
 * Why context matters, given we already ship a changed-fields table: a bare
 * "status: in_trial → active" does not tell you whether the term moved with it, what
 * the trial end was, or which plan this even is. The surrounding lines answer all
 * three without a second screen.
 *
 * `before === null` is a CREATION, and renders single-column ("Show Content"): a
 * two-column view of a record that did not exist would be half empty and would
 * imply every field was "added", which is true but useless.
 *
 * Rendering is a flat line list, NOT a tree, deliberately. A record snapshot is one
 * or two levels deep at most, and pairing a tree's expand state across two columns
 * is a lot of machinery to make the same lines harder to align. Nested objects and
 * arrays are flattened into indented lines, so an array element that changed marks
 * only itself instead of reddening the whole array.
 */

type LineKind = "same" | "modified" | "added" | "removed";

interface Line {
  key: string;
  depth: number;
  /** Rendered left cell; null = nothing on this side (an added line). */
  left: string | null;
  right: string | null;
  kind: LineKind;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** `"status" : "active",` — the snapshot's own shape, so it reads as the record. */
function fmt(key: string | null, v: unknown): string {
  const val =
    v === null || v === undefined
      ? "null"
      : typeof v === "string"
        ? `"${v}"`
        : typeof v === "boolean" || typeof v === "number"
          ? `"${String(v)}"`
          : "";
  if (key === null) return val;
  return val === "" ? `"${key}" : ` : `"${key}" : ${val},`;
}

/**
 * Walk both sides together, emitting aligned lines.
 *
 * Key order follows BEFORE first, then keys only AFTER has — so a record keeps its
 * familiar field order and genuinely new fields collect at the end instead of
 * shuffling everything below them.
 */
function walk(before: unknown, after: unknown, depth: number, path: string, out: Line[]): void {
  const bothArrays = Array.isArray(before) || Array.isArray(after);
  if (bothArrays) {
    const b = Array.isArray(before) ? before : [];
    const a = Array.isArray(after) ? after : [];
    for (let i = 0; i < Math.max(b.length, a.length); i++) {
      const hasB = i < b.length;
      const hasA = i < a.length;
      const kind: LineKind = !hasB ? "added" : !hasA ? "removed" : "same";
      out.push({
        key: `${path}[${i}]{`,
        depth,
        left: hasB ? "{" : null,
        right: hasA ? "{" : null,
        kind,
      });
      walk(hasB ? b[i] : undefined, hasA ? a[i] : undefined, depth + 1, `${path}[${i}]`, out);
      out.push({
        key: `${path}[${i}]}`,
        depth,
        left: hasB ? "}" : null,
        right: hasA ? "}" : null,
        kind,
      });
    }
    return;
  }
  const b = isObj(before) ? before : {};
  const a = isObj(after) ? after : {};
  const keys = [...Object.keys(b), ...Object.keys(a).filter((k) => !(k in b))];
  for (const k of keys) {
    const inB = k in b;
    const inA = k in a;
    const bv = b[k];
    const av = a[k];
    const nested = isObj(bv) || isObj(av) || Array.isArray(bv) || Array.isArray(av);
    if (nested) {
      const open = Array.isArray(bv) || Array.isArray(av) ? "[" : "{";
      const close = open === "[" ? "]" : "}";
      const kind: LineKind = !inB ? "added" : !inA ? "removed" : "same";
      out.push({
        key: `${path}.${k}(`,
        depth,
        left: inB ? `${fmt(k, bv)}${open}` : null,
        right: inA ? `${fmt(k, av)}${open}` : null,
        kind,
      });
      walk(bv, av, depth + 1, `${path}.${k}`, out);
      out.push({
        key: `${path}.${k})`,
        depth,
        left: inB ? close : null,
        right: inA ? close : null,
        kind,
      });
      continue;
    }
    const same = inB && inA && JSON.stringify(bv) === JSON.stringify(av);
    out.push({
      key: `${path}.${k}`,
      depth,
      left: inB ? fmt(k, bv) : null,
      right: inA ? fmt(k, av) : null,
      kind: same ? "same" : !inB ? "added" : !inA ? "removed" : "modified",
    });
  }
}

function lines(before: unknown, after: unknown, root: string): Line[] {
  const out: Line[] = [
    { key: "root", depth: 0, left: `"${root}": {`, right: `"${root}": {`, kind: "same" },
  ];
  walk(before, after, 1, "", out);
  out.push({ key: "rootEnd", depth: 0, left: "}", right: "}", kind: "same" });
  return out;
}

/**
 * A changed line is marked on BOTH sides, in opposite tones — the old value reads as
 * removed and the new as added, the convention every diff tool uses. This is one of
 * the cases the design system explicitly keeps distinct rather than flattening onto
 * one token (as with credits vs charges on proration screens): "what it was" and
 * "what it is" are opposites, and a single highlight colour on both sides would lose
 * which is which for a reader who is colour-scanning rather than reading.
 */
const TONE: Record<LineKind, { left: string; right: string }> = {
  same: { left: "", right: "" },
  modified: { left: "bg-destructive-soft", right: "bg-success-soft" },
  removed: { left: "bg-destructive-soft", right: "" },
  added: { left: "", right: "bg-success-soft" },
};

function Cell({ text, depth, tone }: { text: string | null; depth: number; tone: string }) {
  return (
    <div className={cn("px-3 py-0.5 font-mono text-xs leading-relaxed whitespace-pre", tone)}>
      {text === null ? "" : `${"  ".repeat(depth)}${text}`}
    </div>
  );
}

export function RecordDiff({
  before,
  after,
  root,
}: {
  before: unknown;
  after: unknown;
  /** The record's name, so the block reads `"subscription": { … }`. */
  root: string;
}) {
  const rows = React.useMemo(() => lines(before, after, root), [before, after, root]);
  const creation = before === null;

  // A creation has one column, so the two-column grid would leave half the width
  // empty and every line marked "added".
  if (creation) {
    return (
      <div className="overflow-x-auto rounded-md border bg-muted/40">
        {rows.map((l) => (
          <Cell key={l.key} text={l.right} depth={l.depth} tone="" />
        ))}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border bg-muted/40">
      <div className="grid min-w-[44rem] grid-cols-2 divide-x">
        <div>
          <p className="border-b px-3 py-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Before
          </p>
          {rows.map((l) => (
            <Cell key={l.key} text={l.left} depth={l.depth} tone={TONE[l.kind].left} />
          ))}
        </div>
        <div>
          <p className="border-b px-3 py-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            After
          </p>
          {rows.map((l) => (
            <Cell key={l.key} text={l.right} depth={l.depth} tone={TONE[l.kind].right} />
          ))}
        </div>
      </div>
    </div>
  );
}

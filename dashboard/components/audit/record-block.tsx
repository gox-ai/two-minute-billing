"use client";

import * as React from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { actionHeadline, changeSentence, diffFields, type ChangeSentence } from "./labels";
import { RecordDiff } from "./record-diff";

/**
 * 0149 — one resource's block of an audit record: the headline naming the resource,
 * the field changes as sentences, and a toggle onto the diff.
 *
 * One record can hold several of these because one ACTION can change several
 * resources — activating a subscription changes the subscription and raises an
 * invoice. Before this, each of those was an unrelated row in our log.
 */

export interface RecordBlockData {
  id: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  before: unknown;
  after: unknown;
  snapshot: "available" | "created" | "none";
  before_full: unknown;
  after_full: unknown;
}

/** Interpolate `{0}`/`{1}` with mono-rendered values. */
function Sentence({ s }: { s: ChangeSentence }) {
  const parts = s.rest.split(/(\{\d\})/);
  return (
    <span className="text-muted-foreground">
      <span className="font-mono text-xs text-foreground/80">{s.field}</span>{" "}
      {parts.map((p, i) => {
        const m = /^\{(\d)\}$/.exec(p);
        if (!m) return <React.Fragment key={i}>{p}</React.Fragment>;
        return (
          <span key={i} className="font-mono text-xs text-foreground/80">
            {s.values[Number(m[1])]}
          </span>
        );
      })}
    </span>
  );
}

export function RecordBlock({
  block,
  href,
  /** True for the block the reader arrived from (`?source=`). */
  isSource,
}: {
  block: RecordBlockData;
  href?: string;
  isSource?: boolean;
}) {
  const creation = block.snapshot === "created";
  // Starts OPEN: this page exists to show the change. It is one click from the record,
  // and a reader who clicked "Details" has already said they want the detail.
  const [open, setOpen] = React.useState(true);
  const { noun, verb } = actionHeadline(block.action, block.resource_type);

  const sentences = React.useMemo(
    () =>
      diffFields(block.before, block.after)
        .map(changeSentence)
        .filter((s): s is ChangeSentence => s !== null),
    [block.before, block.after],
  );

  return (
    <div className="anim-rise min-w-0 rounded-xl border bg-card p-4">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 text-sm">
        {creation ? (
          <Badge variant="outline" className="text-xs">
            New
          </Badge>
        ) : null}
        <span>
          {href && block.resource_id ? (
            <Link
              href={href}
              className="font-medium text-primary hover:underline"
              title={block.resource_id}
            >
              {noun}
            </Link>
          ) : (
            <span className="font-medium">{noun}</span>
          )}{" "}
          {verb}
        </span>
        {isSource ? null : (
          // Marks the blocks the reader did NOT come looking for — the rest of what
          // this one action did. Without it a second block reads as an unrelated
          // entry that somehow landed on the page.
          <span className="text-xs text-muted-foreground">also changed by this action</span>
        )}
      </div>

      {sentences.length > 0 ? (
        <ul className="mb-3 space-y-1 text-sm">
          {sentences.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden className="text-muted-foreground">
                –
              </span>
              <Sentence s={s} />
            </li>
          ))}
        </ul>
      ) : null}

      {block.snapshot === "none" ? (
        // Honest about WHY there is no diff, without claiming which reason: an action
        // that never captured a snapshot and one whose snapshot GDPR erasure removed
        // are indistinguishable in the data, and inventing a reason would be worse
        // than naming both. The changed fields above are unaffected either way.
        <p className="text-xs text-muted-foreground">
          We did not capture a full record for this action, or we deleted its snapshot with the
          customer&rsquo;s personal data. The field changes above are the complete record of the
          change.
        </p>
      ) : (
        <>
          <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
            {open
              ? creation
                ? "Hide Content"
                : "Hide Diff"
              : creation
                ? "Show Content"
                : "Show Diff"}
          </Button>
          {open ? (
            <div className="mt-3">
              <RecordDiff
                before={creation ? null : block.before_full}
                after={block.after_full}
                root={block.resource_type ?? "record"}
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

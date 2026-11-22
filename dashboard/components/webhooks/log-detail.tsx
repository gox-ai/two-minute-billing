"use client";

import * as React from "react";
import { Chip } from "@/components/patterns/chip";
import { EditDrawer } from "@/components/edit-drawer";

/**
 * The parts the two webhook logs share: gateway webhooks (inbound, per business) and an
 * endpoint's delivery log (outbound, per organization). One copy, so the two cannot drift.
 */

/** A 2xx is green, a 4xx needs a look, a 5xx failed. */
export function httpStatusTone(status: number): "green" | "tan" | "red" {
  if (status >= 500) return "red";
  if (status >= 400) return "tan";
  return "green";
}

/** The HTTP status as a chip; null renders nothing, so the caller picks its own blank. */
export function HttpStatusChip({ status }: { status: number | null | undefined }) {
  if (status == null) return null;
  return <Chip tone={httpStatusTone(status)}>{status}</Chip>;
}

export interface LogDetailRow {
  label: string;
  /** Null or undefined renders the house blank. */
  value: React.ReactNode;
}

/** A JSON block under the rows: headers, a payload. `value` null means none was stored. */
export function LogJsonBlock({
  title,
  value,
  empty,
}: {
  title: string;
  value: unknown;
  empty: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium">{title}</p>
      {value != null ? (
        <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
          {JSON.stringify(value, null, 2)}
        </pre>
      ) : (
        <div className="text-sm text-muted-foreground">{empty}</div>
      )}
    </div>
  );
}

/**
 * The Inspect drawer: a name for a title (the event type, never a raw id), the record's
 * fields as rows, then any JSON blocks as children.
 */
export function LogDetailDrawer({
  open,
  onClose,
  title,
  description,
  rows,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  rows: LogDetailRow[];
  children?: React.ReactNode;
}) {
  return (
    <EditDrawer
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={description}
    >
      {open ? (
        <div className="space-y-4 pb-6">
          <dl className="divide-y">
            {rows.map((r) => (
              <div key={r.label} className="grid grid-cols-3 gap-2 py-1.5 text-sm">
                <dt className="text-muted-foreground">{r.label}</dt>
                <dd className="col-span-2 break-all">{r.value ?? "—"}</dd>
              </div>
            ))}
          </dl>
          {children}
        </div>
      ) : null}
    </EditDrawer>
  );
}

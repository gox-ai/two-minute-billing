"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { RadioField } from "@/components/ui/radio-group";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { portalSkipRenewalAction } from "./actions";

export interface PortalRenewalRow {
  renewal_at: string;
  /** The date in the business timezone. */
  label: string;
  skipped: boolean;
  changeable: boolean;
}

const CUTOFF = "Changes close 48 hours before the renewal.";

/**
 * Skip and undo on the buyer's own subscription. Rendered only when the business offers
 * skipping and the subscription has upcoming renewals. Refreshes rather than patching
 * locally: a skip moves the next payment date, which only the server computes.
 */
export function PortalSkipRenewal({
  subscription,
  limitPerYear,
  renewals,
}: {
  subscription: string;
  limitPerYear: number;
  renewals: PortalRenewalRow[];
}) {
  const router = useRouter();
  const skipped = renewals.filter((r) => r.skipped);
  const first = renewals.find((r) => r.changeable && !r.skipped)?.renewal_at ?? "";
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState(first);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [undoing, setUndoing] = React.useState<PortalRenewalRow | null>(null);
  const [undoError, setUndoError] = React.useState<string | null>(null);

  function openDialog() {
    setSelected(first);
    setError(null);
    setOpen(true);
  }

  async function skip() {
    if (!selected || busy) return;
    setError(null);
    setBusy(true);
    const res = await portalSkipRenewalAction(subscription, selected, false);
    setBusy(false);
    // The server's own words: the limit, the 48-hour cut-off.
    if (!res.ok) return setError(res.error ?? "We could not skip the renewal.");
    setOpen(false);
    router.refresh();
  }

  async function undo(row: PortalRenewalRow) {
    setUndoError(null);
    const res = await portalSkipRenewalAction(subscription, row.renewal_at, true);
    if (!res.ok) return setUndoError(res.error ?? "We could not undo the skip.");
    router.refresh();
  }

  const limitLine = `You can skip up to ${limitPerYear} renewal${limitPerYear === 1 ? "" : "s"} in 12 months.`;

  return (
    <div className="border-t px-5 py-3">
      {skipped.length > 0 ? (
        <ul className="mb-2 flex flex-col gap-1">
          {skipped.map((r) => (
            <li
              key={r.renewal_at}
              className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
            >
              <span>
                Renewal on <span className="text-foreground tabular-nums">{r.label}</span> skipped.
                We do not charge your plan on that date.
              </span>
              {r.changeable ? (
                <button
                  type="button"
                  onClick={() => setUndoing(r)}
                  className="text-xs font-medium text-primary transition-colors hover:underline"
                >
                  Undo
                </button>
              ) : (
                <span>{CUTOFF}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {undoError ? (
        <Alert tone="error" className="mb-2 text-xs">
          {undoError}
        </Alert>
      ) : null}
      {first ? (
        <button
          type="button"
          onClick={openDialog}
          className="text-xs font-medium text-primary transition-colors hover:underline"
        >
          Skip a renewal
        </button>
      ) : null}

      {/* `data-brand`: Radix portals the dialog outside the storefront's brand wrapper. */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm" data-brand className="flex max-h-[85vh] flex-col overflow-hidden">
          <DialogHeader className="pr-12">
            <DialogTitle>Skip a renewal</DialogTitle>
            <DialogDescription>
              We do not charge your plan on the renewal that you skip. Your subscription stays
              active. We still charge for usage and one-time items. {limitLine}
            </DialogDescription>
          </DialogHeader>
          {/* The body scrolls, not the dialog, so the close button stays in view. */}
          <div className="-mx-6 min-h-0 flex-1 space-y-2 overflow-y-auto px-6">
            <div className="text-sm font-medium">Renewal to skip</div>
            <RadioField
              ariaLabel="Renewal to skip"
              value={selected}
              onValueChange={setSelected}
              options={renewals.map((r) => ({
                value: r.renewal_at,
                label: r.label,
                disabled: r.skipped || !r.changeable,
                hint: r.skipped ? "Skipped" : !r.changeable ? CUTOFF : undefined,
              }))}
            />
          </div>
          {error ? (
            <Alert tone="error" className="text-xs">
              {error}
            </Alert>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={skip} disabled={!selected || busy}>
              {busy ? "Skipping…" : "Skip renewal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        brand
        open={undoing != null}
        onOpenChange={(o) => {
          if (!o) setUndoing(null);
        }}
        title="Undo this skip?"
        description={
          undoing ? `We charge your plan on the renewal on ${undoing.label}.` : undefined
        }
        confirmLabel="Undo skip"
        cancelLabel="Keep skip"
        onConfirm={() => (undoing ? undo(undoing) : undefined)}
      />
    </div>
  );
}

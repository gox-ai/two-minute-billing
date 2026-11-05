"use client";

// Skip one upcoming renewal, and undo a skip. The page passes the engine's upcoming list
// (`GET …/upcoming_renewals`) with each date already formatted in the business timezone.

import * as React from "react";
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
import { ActionForm } from "@/components/form/action-form";
import { ActionButton } from "@/components/action-button";
import { SubmitButton } from "@/components/form/submit-button";
import {
  skipRenewalAction,
  unskipRenewalAction,
} from "@/app/(dashboard)/businesses/[biz]/subscriptions/actions";

export interface RenewalOption {
  renewal_at: string;
  /** The date in the business timezone. */
  label: string;
  skipped: boolean;
  /** False within 48 hours of the renewal. */
  changeable: boolean;
}

const CUTOFF = "Changes close 48 hours before the renewal.";

export function SkipRenewalDialog({
  biz,
  sub,
  renewals,
}: {
  biz: string;
  sub: string;
  renewals: RenewalOption[];
}) {
  const [open, setOpen] = React.useState(false);
  const first = renewals.find((r) => r.changeable && !r.skipped)?.renewal_at ?? "";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded px-1 py-0.5 text-left text-sm text-primary hover:underline"
      >
        Skip a renewal
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          key={String(open)}
          size="md"
          className="flex max-h-[85vh] flex-col overflow-hidden"
        >
          <DialogHeader className="pr-12">
            <DialogTitle>Skip a renewal</DialogTitle>
            <DialogDescription>
              At a skipped renewal, the term moves on one period. We do not charge the recurring
              items for that period. We still invoice usage and one-time charges. A fixed term does
              not count the skipped period.
            </DialogDescription>
          </DialogHeader>
          <ActionForm
            action={skipRenewalAction}
            onSuccess={() => setOpen(false)}
            className="-mx-6 flex min-h-0 flex-1 flex-col"
          >
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6">
              <input type="hidden" name="biz" value={biz} />
              <input type="hidden" name="sub" value={sub} />
              {first ? null : (
                <Alert tone="info">
                  You cannot skip a renewal now. Each listed renewal is skipped or is less than 48
                  hours away.
                </Alert>
              )}
              {/* Not <Field>: its label points at an id, and a radio group has none. */}
              <div className="space-y-2">
                <div className="text-sm font-medium">Renewal to skip</div>
                <RadioField
                  name="renewal_at"
                  defaultValue={first}
                  ariaLabel="Renewal to skip"
                  options={renewals.map((r, i) => ({
                    value: r.renewal_at,
                    label: r.label,
                    disabled: r.skipped || !r.changeable,
                    hint: r.skipped
                      ? "Skipped"
                      : !r.changeable
                        ? CUTOFF
                        : i === 0
                          ? "Next renewal"
                          : undefined,
                  }))}
                />
              </div>
            </div>
            <DialogFooter className="mt-4 px-6">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton disabled={!first}>Skip renewal</SubmitButton>
            </DialogFooter>
          </ActionForm>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The renewals this subscription skips, each with its undo. */
export function SkippedRenewals({
  biz,
  sub,
  skipped,
  canEdit,
}: {
  biz: string;
  sub: string;
  skipped: RenewalOption[];
  canEdit: boolean;
}) {
  if (skipped.length === 0) return <span className="text-muted-foreground">None</span>;
  return (
    <ul className="flex flex-col gap-1.5">
      {skipped.map((r) => (
        <li key={r.renewal_at} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span className="tabular-nums">{r.label}</span>
          {!canEdit ? null : r.changeable ? (
            <ActionButton
              resultAction={unskipRenewalAction}
              fields={{ biz, sub, renewal_at: r.renewal_at }}
              label="Undo skip"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              confirm={{
                title: "Undo this skip?",
                description: `We charge the recurring items at the renewal on ${r.label}.`,
                confirmLabel: "Undo skip",
              }}
            />
          ) : (
            <>
              <Button variant="link" size="sm" className="h-auto p-0 text-xs" disabled>
                Undo skip
              </Button>
              <span className="text-xs text-muted-foreground">{CUTOFF}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

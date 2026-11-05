"use client";

import * as React from "react";
import { DateTimeField } from "@/components/form/datetime-field";
import { useBusinessTz } from "@/components/business-tz";
import { dateOnlyToUtcISO, todayInTz, utcToDateValue } from "@/lib/tz";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/lib/utils";
import type { ActionResult } from "@/lib/action-result";
import {
  startTimeTravelAction,
  advanceTimeTravelAction,
  stopTimeTravelAction,
} from "@/app/(dashboard)/businesses/[biz]/time_travel/actions";

// ── helpers ─────────────────────────────────────────────────────────────────

// Day arithmetic on `YYYY-MM-DD` strings, for the quick-jump buttons. The day strings are
// BUSINESS-zone days (`utcToDateValue`), and `dateOnlyToUtcISO` turns one back into the UTC
// instant the form posts — so a "+7 days" jump means seven of the operator's days, and the
// clock still pins to their midnight rather than UTC's.
function shiftDay(day: string, { days = 0, months = 0 }): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  if (months) d.setUTCMonth(d.getUTCMonth() + months);
  if (days) d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Start form ────────────────────────────────────────────────────────────────

export function StartForm({ biz }: { biz: string }) {
  const action = React.useCallback(
    (prev: ActionResult | null, fd: FormData) => startTimeTravelAction(biz, prev, fd),
    [biz],
  );
  const tz = useBusinessTz();
  const today = todayInTz(tz);
  return (
    <ActionForm action={action} className="space-y-4">
      <Field
        name="genesis"
        label="Genesis date"
        required
        help="The clock stays at this date. Nothing is charged at genesis, because a new test business is empty. Travel forward from this date to run billing."
      >
        <DateTimeField
          granularity="date"
          name="genesis"
          defaultValue={dateOnlyToUtcISO(today, tz)}
          className={fieldClass}
        />
      </Field>
      <SubmitButton>Start Time Travel</SubmitButton>
    </ActionForm>
  );
}

// ── Travel form ─────────────────────────────────────────────────────────────

export function TravelForm({ biz, simulatedNow }: { biz: string; simulatedNow: string }) {
  const action = React.useCallback(
    (prev: ActionResult | null, fd: FormData) => advanceTimeTravelAction(biz, prev, fd),
    [biz],
  );
  const tz = useBusinessTz();
  const now = utcToDateValue(simulatedNow, tz);
  const [dest, setDest] = React.useState(now);

  // Keep the picker in sync when the simulated clock moves after a travel.
  React.useEffect(() => setDest(now), [now]);

  return (
    <ActionForm action={action} className="space-y-4">
      <Field
        name="destination"
        label="Destination date"
        required
        help="Forward-only. Each day from the current date to the destination runs one full billing tick (renewals, invoices, dunning, webhooks)."
      >
        <DateTimeField
          granularity="date"
          name="destination"
          min={now}
          defaultValue={dateOnlyToUtcISO(dest, tz)}
          onUtcChange={(utc) => setDest(utcToDateValue(utc, tz) || dest)}
          className={fieldClass}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Quick jump:</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setDest(shiftDay(now, { days: 1 }))}
        >
          +1 day
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setDest(shiftDay(now, { days: 7 }))}
        >
          +7 days
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setDest(shiftDay(now, { months: 1 }))}
        >
          +1 month
        </Button>
      </div>
      <Field
        name="step_days"
        label="Step size (days)"
        help="The number of days for each tick. This must not be more than the business's shortest billing interval. If it is more, renewals are skipped. Leave it empty for 1 day."
      >
        <Input
          type="number"
          name="step_days"
          min={1}
          max={366}
          placeholder="1"
          className={fieldClass}
        />
      </Field>
      <SubmitButton>Travel forward</SubmitButton>
    </ActionForm>
  );
}

// ── Stop button + confirm ─────────────────────────────────────────────────────

export function StopButton({ biz }: { biz: string }) {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();
  return (
    <>
      <Button variant="destructive" onClick={() => setOpen(true)}>
        Stop &amp; delete
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Stop Time Travel?"
        destructive
        confirmLabel="Stop &amp; delete simulated data"
        description={
          <span className="block space-y-2">
            <span className="block">
              This permanently deletes all simulated transactional data for this business. Then the
              business returns to the real clock. You cannot undo this.
            </span>
            <span className="block font-medium text-destructive">
              Deleted: customers, subscriptions, invoices, payments, credit notes, refunds, ledger
              entries, usage records, events and webhook deliveries.
            </span>
            <span className="block">
              Kept: catalog (products &amp; prices), coupons, tax rates, business settings, payment
              gateways, API keys and webhook endpoints.
            </span>
          </span>
        }
        onConfirm={async () => {
          const res = await stopTimeTravelAction(biz);
          if (res.ok) {
            toast.success(res.message ?? "Stopped");
            router.refresh(); // status card flips to "off"
          } else {
            toast.error(res.message ?? "We could not stop Time Travel.");
          }
        }}
      />
    </>
  );
}

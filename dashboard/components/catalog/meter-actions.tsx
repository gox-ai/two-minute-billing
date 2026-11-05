"use client";

import * as React from "react";
import { toast } from "sonner";
import { Archive, Send } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  archiveMeterAction,
  sendTestEventAction,
} from "@/app/(dashboard)/businesses/[biz]/catalog/meters/actions";
import type { Meter } from "@/lib/api/meters";
import { needsUniqueProperty, needsValueProperty } from "@/lib/meters";

/** The properties a test event needs for this meter to count it, in a stable order. */
function testProperties(m: Meter): Array<{ name: string; hint: string; numeric?: boolean }> {
  const out: Array<{ name: string; hint: string; numeric?: boolean }> = [];
  const seen = new Set<string>();
  const add = (name: string | null, hint: string, numeric?: boolean) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, hint, numeric });
  };
  if (needsValueProperty(m.aggregation)) add(m.value_property, "The value to count", true);
  if (needsUniqueProperty(m.aggregation)) add(m.unique_property, "The value to count one time");
  for (const p of m.group_by) add(p, "Group value");
  for (const [p, values] of Object.entries(m.filters))
    add(p, `The meter counts only: ${values.join(", ")}`);
  return out;
}

/** Posts one real event with the key `test_<random>`. It counts and bills like any other. */
export function SendTestEventDialog({ biz, meter }: { biz: string; meter: Meter }) {
  const [open, setOpen] = React.useState(false);
  const props = testProperties(meter);
  const [values, setValues] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      props.map((p) => [
        p.name,
        meter.filters[p.name]?.length ? String(meter.filters[p.name][0]) : "",
      ]),
    ),
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button disabled={meter.status !== "active"}>
          <Send aria-hidden className="size-4" />
          Send test event
        </Button>
      </DialogTrigger>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Send test event</DialogTitle>
          <DialogDescription>
            We record a real “{meter.event_name}” event now. If a subscription bills this meter for
            the customer, the event goes on the next invoice.
          </DialogDescription>
        </DialogHeader>
        <ActionForm
          action={sendTestEventAction}
          onSuccess={() => setOpen(false)}
          className="space-y-3"
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="meter" value={meter.id} />
          <input type="hidden" name="event_name" value={meter.event_name} />
          <input type="hidden" name="properties" value={JSON.stringify(values)} />
          <Field
            name="customer"
            label="Customer"
            required
            help="A usage key of the customer, or the customer ID (cus_…)."
          >
            <Input name="customer" required maxLength={255} className="font-mono" />
          </Field>
          {props.map((p) => (
            <Field key={p.name} name={`prop_${p.name}`} label={p.name} help={p.hint}>
              <Input
                value={values[p.name] ?? ""}
                inputMode={p.numeric ? "decimal" : undefined}
                className={p.numeric ? "font-mono tabular-nums" : "font-mono"}
                onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
              />
            </Field>
          ))}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton>Send test event</SubmitButton>
          </div>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

/** More-menu item. The API refuses while a price on a live subscription uses the meter. */
export function ArchiveMeterButton({ biz, meter }: { biz: string; meter: Meter }) {
  const [open, setOpen] = React.useState(false);
  async function confirm() {
    const fd = new FormData();
    fd.set("biz", biz);
    fd.set("meter", meter.id);
    const res = await archiveMeterAction(null, fd);
    if (res.ok) toast.success(res.message ?? "Meter archived.");
    else toast.error(res.message ?? "We could not archive the meter.");
  }
  return (
    <>
      <button type="button" className="text-destructive" onClick={() => setOpen(true)}>
        <Archive aria-hidden className="size-4" />
        Archive meter
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Archive ${meter.name}?`}
        description="You cannot add a price on an archived meter. The meter continues to count events for periods that are open now."
        confirmLabel="Archive meter"
        destructive
        onConfirm={confirm}
      />
    </>
  );
}

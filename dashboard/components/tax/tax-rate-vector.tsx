"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { RecordCard } from "@/components/patterns/record-page";
import { useLocalPages, Pager } from "@/components/patterns/pager";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { Field } from "@/components/form/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { CreateDialog } from "@/components/create-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { StateSelect } from "@/components/tax/state-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  saveTaxComponentsAction,
  saveTaxStateRegistrationAction,
  deleteTaxStateRegistration,
} from "@/app/actions";
import { componentBps, intraTotalBps, interTotalBps, pct, pctValue } from "@/lib/tax-format";
import type { TaxRegion } from "@/lib/api";

/**
 * The rate vector — the part that could not exist under the old single-rate model.
 *
 * For a GST region the form collects CGST, SGST/UTGST and an optional Cess as PERCENTS,
 * and IGST is DERIVED as CGST + SGST rather than being a fourth input: the law makes an
 * inter-state supply attract the same total, so a separate field would only create a way
 * to configure the two branches inconsistently.
 * The derived inter-state figure is shown live so the operator sees both outcomes.
 *
 * The whole vector saves at once — CGST and SGST are two halves of one decision, and a
 * partial save would leave the region taxing at a rate nobody chose.
 */
export function TaxRateVector({ biz, region }: { biz: string; region: TaxRegion }) {
  const isGst = region.regime === "gst";
  // Re-seeded from the saved region, so the inputs show what the engine stored.
  const [cgst, setCgst] = useDefaultState(pctValue(componentBps(region.components, null, "CGST")));
  const [sgst, setSgst] = useDefaultState(
    pctValue(componentBps(region.components, null, "SGST/UTGST")),
  );
  const cessBps = componentBps(region.components, null, "Cess");
  const [cess, setCess] = useDefaultState(cessBps > 0 ? pctValue(cessBps) : "");

  const num = (s: string) => {
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  // Both branches total the SAME percentage — they differ only in how it is split and
  // named. One variable, so the UI cannot imply a difference that does not exist.
  const total = num(cgst) + num(sgst) + num(cess);

  const configured = region.components.filter((c) => c.state_code === null);

  return (
    <RecordCard id="rates" title={isGst ? "GST rates" : "Tax rate"}>
      {configured.length === 0 ? (
        <Alert tone="warning" className="mb-4">
          No rates are configured. Invoices for this country now have 0% tax.
        </Alert>
      ) : null}

      <ActionForm action={saveTaxComponentsAction} className="space-y-4">
        <input type="hidden" name="biz" value={biz} />
        <input type="hidden" name="txg" value={region.id} />
        <input type="hidden" name="regime" value={region.regime} />

        {isGst ? (
          <>
            <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
              These rates apply to supplies made anywhere in {region.country}. Override a specific
              state below.
            </p>
            <div className="flex flex-wrap items-start gap-4">
              <Field name="cgst" label="CGST %" required className="w-28">
                <Input
                  name="cgst"
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  value={cgst}
                  onChange={(e) => setCgst(e.target.value)}
                  required
                  className="tabular-nums"
                />
              </Field>
              <Field name="sgst" label="SGST/UTGST %" required className="w-32">
                <Input
                  name="sgst"
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  value={sgst}
                  onChange={(e) => setSgst(e.target.value)}
                  required
                  className="tabular-nums"
                />
              </Field>
              <Field name="cess" label="Cess %" help="Optional." className="w-28">
                <Input
                  name="cess"
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  value={cess}
                  onChange={(e) => setCess(e.target.value)}
                  className="tabular-nums"
                />
              </Field>
            </div>
            {/* A filled well, not a dashed box — marks this as derived, per the design system. */}
            <div className="max-w-prose rounded-md bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              Within {region.home_state_code ?? "your state"}:{" "}
              <span className="font-medium text-foreground tabular-nums">
                CGST {num(cgst)}% + SGST/UTGST {num(sgst)}%
                {num(cess) > 0 ? ` + Cess ${num(cess)}%` : ""} = {total}%
              </span>
              <br />
              To other states:{" "}
              <span className="font-medium text-foreground tabular-nums">
                IGST {num(cgst) + num(sgst)}%{num(cess) > 0 ? ` + Cess ${num(cess)}%` : ""} ={" "}
                {total}%
              </span>
              <br />
              IGST is CGST + SGST/UTGST. An inter-state supply has the same total tax.
            </div>
          </>
        ) : (
          <div className="flex flex-wrap items-start gap-4">
            <Field name="name" label="Tax name" required className="w-48">
              <Input
                name="name"
                defaultValue={configured[0]?.name ?? ""}
                placeholder="VAT"
                maxLength={60}
                required
              />
            </Field>
            <Field name="rate" label="Rate %" required className="w-28">
              <Input
                name="rate"
                type="number"
                min={0}
                max={100}
                step="0.01"
                defaultValue={configured[0] ? pctValue(configured[0].rate_bps) : ""}
                required
                className="tabular-nums"
              />
            </Field>
          </div>
        )}

        <div className="flex justify-end">
          <SubmitButton>Save rates</SubmitButton>
        </div>
      </ActionForm>
    </RecordCard>
  );
}

/**
 * Per-state seller registrations, and the per-state rate override that sits alongside
 * them. Two independent facts, so a state may carry a GSTIN with no override — the
 * table shows the effective rate either way.
 */
export function StateRegistrations({ biz, region }: { biz: string; region: TaxRegion }) {
  const router = useRouter();
  const [confirming, setConfirming] = React.useState<{ id: string; state_code: string } | null>(
    null,
  );
  const isGst = region.regime === "gst";

  const overrideStates = new Set(
    region.components.filter((c) => c.state_code).map((c) => c.state_code as string),
  );
  const rows = [
    ...region.state_registrations.map((s) => ({
      ...s,
      hasOverride: overrideStates.has(s.state_code),
    })),
    // States that override rates without carrying a registration still belong in the
    // list; hiding them would make a rate that IS applied invisible.
    ...[...overrideStates]
      .filter((sc) => !region.state_registrations.some((s) => s.state_code === sc))
      .map((sc) => ({
        id: `override:${sc}`,
        state_code: sc,
        state_name: null,
        registration_number: null,
        hasOverride: true,
      })),
  ].sort((a, b) => a.state_code.localeCompare(b.state_code));

  async function runDelete(id: string) {
    const res = await deleteTaxStateRegistration(biz, region.id, id);
    if (res.ok) {
      toast.success("Registration removed");
      router.refresh();
    } else {
      toast.error(res.error ?? "We could not remove the registration.");
    }
  }

  const { rows: page, pager } = useLocalPages(rows, 10);

  return (
    <RecordCard
      id="state_registrations"
      title="State registrations"
      meta={rows.length ? String(rows.length) : undefined}
      actions={<AddStateDialog biz={biz} region={region} />}
      flush
      footer={
        <span className="text-xs text-muted-foreground">
          Rows without an override show the region’s default rates.
        </span>
      }
    >
      <p className="max-w-prose px-5 pt-4 pb-3 text-xs leading-relaxed text-muted-foreground">
        {isGst
          ? "Add one registration for each state where you have a place of business. The invoice shows the number of the supplying state. A state can override the default rates."
          : "Registrations for each state or sub-region."}
      </p>

      {rows.length === 0 ? (
        <p className="px-5 pb-4 text-sm text-muted-foreground">
          No state registrations. We use the region-level registration number for all supplies.
        </p>
      ) : (
        <>
          <Table className="table-fixed">
            <colgroup>
              <col />
              <col className="w-[34%]" />
              <col className="w-[18%]" />
              <col className="w-[18%]" />
              <col className="w-14" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">State</TableHead>
                <TableHead>Registration number</TableHead>
                <TableHead className="text-right">Intra-state</TableHead>
                <TableHead className="text-right">Inter-state</TableHead>
                <TableHead className="pr-5" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.map((s) => {
                const intra = s.hasOverride
                  ? intraTotalBps(region.components, s.state_code)
                  : intraTotalBps(region.components);
                const inter = s.hasOverride
                  ? interTotalBps(region.components, s.state_code)
                  : interTotalBps(region.components);
                return (
                  <TableRow key={s.id}>
                    <TableCell className="pl-5 font-medium whitespace-normal">
                      {s.state_code}
                      {s.state_name ? (
                        <span className="ml-2 text-xs text-muted-foreground">{s.state_name}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs wrap-anywhere whitespace-normal">
                      {s.registration_number ?? (
                        <span className="font-sans text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{pct(intra)}</TableCell>
                    <TableCell className="text-right tabular-nums">{pct(inter)}</TableCell>
                    <TableCell className="pr-5 text-right">
                      {s.id.startsWith("override:") ? null : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Remove registration for ${s.state_code}`}
                          onClick={() => setConfirming({ id: s.id, state_code: s.state_code })}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <Pager pager={pager} />
        </>
      )}

      <ConfirmDialog
        open={!!confirming}
        onOpenChange={(o) => !o && setConfirming(null)}
        title={`Remove the registration for ${confirming?.state_code}?`}
        description="Invoices for that state then use the region-level registration number. We keep any rate override for the state."
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (confirming) return runDelete(confirming.id);
        }}
      />
    </RecordCard>
  );
}

function AddStateDialog({ biz, region }: { biz: string; region: TaxRegion }) {
  return (
    <CreateDialog
      triggerLabel="Add state"
      triggerVariant="outline"
      triggerSize="sm"
      title={`Add a state registration for ${region.country}`}
      description="Record the registration number of the state. You set rate overrides separately below."
    >
      <ActionForm action={saveTaxStateRegistrationAction} className="space-y-4">
        <input type="hidden" name="biz" value={biz} />
        <input type="hidden" name="txg" value={region.id} />
        {/* Lets the action derive the state NAME from the code. */}
        <input type="hidden" name="country" value={region.country} />
        {/* Strictly selectable: `state_code` is a tax-resolution key, so a typo or a
            display name would configure a registration nothing can ever match. The
            state NAME is no longer asked for — it is derived from the code by the
            action, so the two cannot disagree. Already-registered states are hidden. */}
        <Field
          name="state_code"
          label="State"
          required
          help="The state where this registration is filed."
        >
          <StateSelect
            name="state_code"
            country={region.country}
            required
            className="w-72"
            ariaLabel="State"
            exclude={region.state_registrations.map((s) => s.state_code)}
          />
        </Field>
        <Field
          name="registration_number"
          label={region.registration_label === "gstin" ? "GSTIN" : "Registration number"}
          help="Leave blank to record the state without a number."
        >
          <Input
            name="registration_number"
            placeholder="27AAFCN5032R1ZX"
            maxLength={50}
            className="font-mono"
          />
        </Field>
        <div className="flex justify-end">
          <SubmitButton>Save registration</SubmitButton>
        </div>
      </ActionForm>
    </CreateDialog>
  );
}

/**
 * Per-state RATE override. Separate form from the registration because they are separate
 * facts: folded into one dialog, a state that only needs a GSTIN would be forced to
 * carry a duplicate rate row.
 */
export function StateRateOverride({ biz, region }: { biz: string; region: TaxRegion }) {
  const isGst = region.regime === "gst";
  if (!isGst) return null;
  const states = region.state_registrations.map((s) => s.state_code);
  const overridden = [
    ...new Set(region.components.filter((c) => c.state_code).map((c) => c.state_code as string)),
  ];

  return (
    <RecordCard id="state_overrides" title="State rate overrides">
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        Charge a different rate for supplies to one state. Everything else keeps the region default
        {region.components.some((c) => c.state_code === null)
          ? ` (${pct(intraTotalBps(region.components))} intra-state).`
          : "."}
      </p>
      {overridden.length > 0 ? (
        <p className="mt-2 text-sm">
          Overridden:{" "}
          <span className="font-medium tabular-nums">
            {overridden
              .map(
                (sc) =>
                  `${sc} ${pct(intraTotalBps(region.components, sc))}/${pct(interTotalBps(region.components, sc))}`,
              )
              .join(" · ")}
          </span>
        </p>
      ) : null}

      <ActionForm action={saveTaxComponentsAction} className="mt-4 space-y-4">
        <input type="hidden" name="biz" value={biz} />
        <input type="hidden" name="txg" value={region.id} />
        <input type="hidden" name="regime" value={region.regime} />
        <div className="flex flex-wrap items-start gap-4">
          <Field
            name="state_code"
            label="State"
            required
            help={states.length ? `Registered: ${states.join(", ")}` : "Any state in this region."}
            className="w-64"
          >
            <StateSelect
              name="state_code"
              country={region.country}
              required
              ariaLabel="State to override"
            />
          </Field>
          <Field name="cgst" label="CGST %" required className="w-28">
            <Input
              name="cgst"
              type="number"
              min={0}
              max={100}
              step="0.01"
              required
              className="tabular-nums"
            />
          </Field>
          <Field name="sgst" label="SGST/UTGST %" required className="w-32">
            <Input
              name="sgst"
              type="number"
              min={0}
              max={100}
              step="0.01"
              required
              className="tabular-nums"
            />
          </Field>
          <Field name="cess" label="Cess %" className="w-28">
            <Input
              name="cess"
              type="number"
              min={0}
              max={100}
              step="0.01"
              className="tabular-nums"
            />
          </Field>
        </div>
        <div className="flex justify-end">
          <SubmitButton>
            <Plus className="size-4" />
            Save override
          </SubmitButton>
        </div>
      </ActionForm>
    </RecordCard>
  );
}

"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNavPending } from "@/components/navigation/nav-pending";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { Field } from "@/components/form/field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";
import { KPI_LABEL } from "@/components/analytics/layout";
import { toMinor } from "@/lib/money";
import { createSegmentAction } from "@/app/(dashboard)/businesses/[biz]/reports/customers/actions";
import type { SegmentAttribute, SegmentFilter } from "@/lib/api/segments";

/**
 * How each operator reads in a chip. Prose, not the wire token: `mrr[gte]` is
 * "Current MRR ≥", and an operator nobody can read makes a chip that has to be decoded
 * rather than scanned.
 */
const OP_LABEL: Record<string, string> = {
  is: "is",
  is_not: "is not",
  in: "is one of",
  not_in: "is none of",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  between: "between",
  on: "on",
  before: "before",
  after: "after",
  on_or_before: "on or before",
  on_or_after: "on or after",
  in_last: "in the last",
  in_next: "in the next",
  is_present: "is present",
};

/**
 * The currency an `mrr` threshold is compared in — the engine's rule, stated once: a pinned
 * `currency is X` compares natively in X and counts only X; otherwise every subscription is
 * converted into the business's default currency at its stored rate.
 */
export function mrrComparisonCurrency(filters: SegmentFilter[], fallback: string): string {
  const pin = filters.find(
    (f) => f.field === "currency" && (f.op === "is" || (f.op === "in" && !f.value.includes(","))),
  );
  return pin ? pin.value.trim().toUpperCase() : fallback;
}

/** The value, as a person reads it. */
function valueLabel(attr: SegmentAttribute | undefined, f: SegmentFilter, currency: string) {
  if (f.op === "is_present") return f.value === "false" ? "no" : "yes";
  if (f.op === "in_last" || f.op === "in_next") return `${f.value} days`;
  if (attr?.field === "mrr") return money(Number(f.value), currency);
  if (attr?.options) {
    const byValue = new Map(attr.options.map((o) => [o.value, o.label]));
    return f.value
      .split(",")
      .map((v) => byValue.get(v.trim()) ?? v.trim())
      .join(", ");
  }
  return f.value;
}

/**
 * The segment card: its heading and the population it names, then the active predicate as
 * removable chips.
 *
 * ⚠️ The chips ARE the filter set. Picking a saved segment in the rail materialises its
 * definition into these chips and into the URL, so editing one is the same action
 * whether it came from a segment or was typed here — and the moment a chip changes, the
 * rail stops claiming a saved segment is selected. A screen that showed a segment's
 * name over an edited predicate would be lying about which population the figures are.
 *
 * Every attribute offered comes from the ENGINE (`/customer_segments/attributes`), so
 * there is no control here that the list would refuse.
 */
export function SegmentFilterBar({
  biz,
  heading,
  attributes,
  filters,
  customers,
  mrrByCurrency,
  currency,
  canSave,
}: {
  biz: string;
  /** The segment's name, description and starter label. */
  heading: React.ReactNode;
  attributes: SegmentAttribute[];
  filters: SegmentFilter[];
  customers: number | null;
  mrrByCurrency: Record<string, number>;
  /** The business's own currency — what a single-currency figure is printed in. */
  currency: string;
  /** False for an empty predicate: "all customers" is not a segment worth saving. */
  canSave: boolean;
}) {
  const router = useRouter();
  const { navigate, pendingFrom } = useNavPending();
  const pending = pendingFrom("filters");
  const pathname = usePathname();
  const params = useSearchParams();
  const [adding, setAdding] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const byField = new Map(attributes.map((a) => [a.field, a]));

  /** Write a filter set into the URL. The segment selection drops: it is ours now. */
  const apply = (next: SegmentFilter[]) => {
    const qs = new URLSearchParams();
    for (const f of next) qs.append("filter", `${f.field}:${f.op}:${f.value}`);
    const q = qs.toString();
    navigate(q ? `${pathname}?${q}` : pathname, { source: "filters" });
  };

  const remove = (i: number) => apply(filters.filter((_, n) => n !== i));
  const mrrCurrency = mrrComparisonCurrency(filters, currency);

  const currencies = Object.keys(mrrByCurrency);
  const summary =
    currencies.length === 0
      ? money(0, currency)
      : currencies.length === 1
        ? money(mrrByCurrency[currencies[0]!]!, currencies[0]!)
        : // Never one number over several currencies. Each is printed on its own, because
          // adding minor units of different currencies produces a figure of nothing.
          currencies
            .sort()
            .map((c) => money(mrrByCurrency[c]!, c))
            .join(" · ");

  return (
    <>
      <section aria-label="Segment" className="anim-rise overflow-hidden rounded-xl border bg-card">
        <div className="flex flex-col gap-x-8 gap-y-4 px-4 py-5 sm:px-6 xl:flex-row xl:items-start">
          <div className="min-w-0 flex-1 xl:min-w-60">{heading}</div>
          {/* The count and MRR are the old predicate's until the new one lands. */}
          <div className="flex min-w-0 flex-wrap gap-x-10 gap-y-3">
            <div className="flex flex-col gap-1.5">
              <span className={KPI_LABEL}>
                {pending ? (
                  <Loader2
                    className="mr-1.5 inline size-3.5 animate-spin align-[-2px]"
                    aria-hidden
                  />
                ) : null}
                Customers
              </span>
              <span className="text-2xl font-semibold tabular-nums">
                {(customers ?? 0).toLocaleString("en")}
              </span>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className={KPI_LABEL}>MRR</span>
              <span className="text-2xl font-semibold wrap-anywhere tabular-nums">{summary}</span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-4 py-3 sm:px-6">
          <span className={cn(KPI_LABEL, "mr-1")}>Filters</span>
          {filters.map((f, i) => {
            const attr = byField.get(f.field);
            return (
              <span
                key={`${f.field}-${f.op}-${i}`}
                className="inline-flex h-7 max-w-full min-w-0 items-center gap-2 rounded-full border bg-muted pr-1.5 pl-2.5 text-xs"
              >
                <span className="shrink-0 text-muted-foreground">
                  {attr?.label ?? f.field} {OP_LABEL[f.op] ?? f.op}
                </span>
                <span className="min-w-0 truncate font-semibold">
                  {valueLabel(attr, f, mrrCurrency)}
                </span>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  aria-label={`Remove the ${attr?.label ?? f.field} filter`}
                  className="inline-flex size-4.5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" strokeWidth={2.5} aria-hidden />
                </button>
              </span>
            );
          })}
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            Add filter
          </Button>
          {canSave ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => setSaving(true)}
            >
              Save as segment
            </Button>
          ) : null}
        </div>
      </section>

      <AddFilterDialog
        open={adding}
        onOpenChange={setAdding}
        attributes={attributes}
        mrrCurrency={mrrCurrency}
        pinned={mrrCurrency !== currency}
        onAdd={(f) => {
          setAdding(false);
          apply([...filters, f]);
        }}
      />
      <SaveSegmentDialog
        open={saving}
        onOpenChange={setSaving}
        biz={biz}
        filters={filters}
        onSaved={() => {
          setSaving(false);
          router.refresh();
        }}
      />
      {/* Kept so the URL params this bar writes are visibly the ones the server reads. */}
      <span hidden data-testid="segment-filter-count">
        {params.getAll("filter").length}
      </span>
    </>
  );
}

function AddFilterDialog({
  open,
  onOpenChange,
  attributes,
  mrrCurrency,
  pinned,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  attributes: SegmentAttribute[];
  /** What an MRR amount typed here means, and is converted from. */
  mrrCurrency: string;
  /** True when a `currency` filter pins it, rather than the business default. */
  pinned: boolean;
  onAdd: (f: SegmentFilter) => void;
}) {
  const [field, setField] = React.useState(attributes[0]?.field ?? "");
  const attr = attributes.find((a) => a.field === field);
  const [op, setOp] = React.useState(attr?.ops[0] ?? "is");
  const [value, setValue] = React.useState("");

  // Re-seed the operator when the attribute changes: `contains` is legal on a text
  // field and not on a number, and carrying it over would post a filter the engine
  // refuses — a control that does nothing, by a slower route.
  React.useEffect(() => {
    const a = attributes.find((x) => x.field === field);
    if (a && !a.ops.includes(op)) setOp(a.ops[0] ?? "is");
    setValue("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field]);

  const groups = [...new Set(attributes.map((a) => a.group))];
  const valueless = op === "is_present";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Add a filter</DialogTitle>
          <DialogDescription>
            The engine stores every attribute in this list, so the filter changes the real figures.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Attribute" name="segment_field">
            <SelectField
              name="segment_field"
              value={field}
              onValueChange={setField}
              options={groups.flatMap((g) =>
                attributes
                  .filter((a) => a.group === g)
                  .map((a) => ({ value: a.field, label: `${g} · ${a.label}` })),
              )}
            />
          </Field>
          {attr?.hint ? <p className="text-xs text-muted-foreground">{attr.hint}</p> : null}
          <Field label="Condition" name="segment_op">
            <SelectField
              name="segment_op"
              value={op}
              onValueChange={setOp}
              options={(attr?.ops ?? []).map((o) => ({ value: o, label: OP_LABEL[o] ?? o }))}
            />
          </Field>
          {valueless ? (
            <Field label="Value" name="segment_value">
              <SelectField
                name="segment_value"
                value={value || "true"}
                onValueChange={setValue}
                options={[
                  { value: "true", label: "Present" },
                  { value: "false", label: "Absent" },
                ]}
              />
            </Field>
          ) : attr?.options ? (
            <Field label="Value" name="segment_value">
              <SelectField
                name="segment_value"
                value={value}
                onValueChange={setValue}
                placeholder="Select one"
                options={attr.options.map((o) => ({ value: o.value, label: o.label }))}
              />
            </Field>
          ) : (
            <Field
              label={
                attr?.field === "mrr"
                  ? `Monthly amount, in ${mrrCurrency}`
                  : op === "in_last" || op === "in_next"
                    ? "Days"
                    : "Value"
              }
              name="segment_value"
              // Typed in MAJOR units of the comparison currency and converted with that
              // currency's own exponent on the way out (2 for USD, 0 for JPY) — the engine
              // stores minor units, a person does not think in them.
              help={
                attr?.field === "mrr"
                  ? pinned
                    ? `Only ${mrrCurrency} subscriptions count.`
                    : `We convert each customer's subscriptions into ${mrrCurrency} at the rates in Settings → Currencies.`
                  : attr?.kind === "date" && op !== "in_last" && op !== "in_next"
                    ? "YYYY-MM-DD"
                    : undefined
              }
            >
              <Input
                name="segment_value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                inputMode={
                  attr?.field === "mrr"
                    ? "decimal"
                    : attr?.kind === "number" || op === "in_last" || op === "in_next"
                      ? "numeric"
                      : undefined
                }
              />
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={
              !field ||
              (!valueless && value.trim() === "") ||
              (attr?.field === "mrr" && !Number.isFinite(Number(value.trim())))
            }
            onClick={() =>
              onAdd({
                field,
                op,
                value: valueless
                  ? value || "true"
                  : attr?.field === "mrr"
                    ? String(toMinor(Number(value.trim()), mrrCurrency))
                    : value.trim(),
              })
            }
          >
            Add filter
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SaveSegmentDialog({
  open,
  onOpenChange,
  biz,
  filters,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  biz: string;
  filters: SegmentFilter[];
  onSaved: () => void;
}) {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = await createSegmentAction(biz, {
      name: name.trim(),
      description: description.trim() || null,
      filters,
    });
    setBusy(false);
    // The engine's refusal verbatim: it names the attribute and says why, which is the
    // whole point of the message. Replacing it with "Could not save" throws that away.
    if (!res.ok) return setError(res.error ?? "We could not save this segment.");
    setName("");
    setDescription("");
    onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Save as a segment</DialogTitle>
          <DialogDescription>
            A segment is a named group of customers. It shows in the rail. Reports can compare a
            metric across it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Name" name="segment_name">
            <Input
              name="segment_name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
            />
          </Field>
          <Field label="Description" name="segment_description" help="Optional.">
            <Input
              name="segment_description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
            />
          </Field>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={busy || name.trim() === ""} onClick={submit}>
            {busy ? "Saving…" : "Save segment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

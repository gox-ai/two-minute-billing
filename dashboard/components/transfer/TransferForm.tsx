"use client";

import * as React from "react";
import { toast } from "sonner";
import { Columns2, Trash2 } from "lucide-react";
import type { Business } from "@/lib/api";
import type { ConflictPolicy, PlanRequest, TransferRun, TransferSection } from "@/lib/api/transfer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { CheckboxField } from "@/components/ui/checkbox";
import { RadioField } from "@/components/ui/radio-group";
import { SettingsCard, FieldLabel } from "@/components/settings/settings-layout";
import { useDefaultState } from "@/lib/use-default-state";
import { plural } from "@/lib/labels";
import type { RunResult } from "@/app/(dashboard)/businesses/[biz]/transfer/actions";
import { SECTIONS } from "./sections";
import { CLEARABLE, type TransferSeed } from "./seed";
import { ActionBar, BizTile, LiveWarning, ModeChip, RouteBand, stepsOf } from "./RouteBand";

export { seedOf, requestOf, type TransferSeed } from "./seed";

interface TransferFormProps {
  biz: string;
  businesses: Business[];
  /** An owner or admin: may update records of a live business. */
  canOverride: boolean;
  seed: TransferSeed | null;
  /** What the copy takes and leaves; shown on request. */
  explainer: React.ReactNode;
  planAction: (biz: string, body: PlanRequest) => Promise<RunResult>;
  onPlan: (run: TransferRun) => void;
}

/**
 * Copy set-up: the destination, the sections with what happens to a record in both, what
 * happens first, and the prefixes. "Check what changes" stores a plan; nothing changes
 * until the plan is applied.
 */
export function TransferForm({
  biz,
  businesses,
  canOverride,
  seed,
  explainer,
  planAction,
  onPlan,
}: TransferFormProps) {
  const current = businesses.find((b) => b.id === biz);
  // The usual copy is between the two modes of the same business, so start there.
  const twinId =
    (current?.livemode === "live" ? current.test_business_id : current?.live_business_id) ?? "";
  const startDest = seed?.dest ?? twinId;
  const liveOf = (id: string) => businesses.find((b) => b.id === id)?.livemode === "live";
  const startPolicy = (id: string): ConflictPolicy => (liveOf(id) ? "skip" : "update");

  // A new seed ("Repeat", "Change the options") re-seeds each value.
  const [dest, setDest] = useDefaultState<string>(startDest);
  const [clearFirst, setClearFirst] = useDefaultState(!!seed?.clearFirst);
  const [sections, setSections] = useDefaultState<TransferSection[]>(
    seed?.sections ?? SECTIONS.filter((s) => s.defaultOn).map((s) => s.id),
    (v) => v.join(","),
  );
  const [policy, setPolicy] = useDefaultState<Partial<Record<TransferSection, ConflictPolicy>>>(
    seed?.policy ?? {},
    (v) => JSON.stringify(v),
  );
  const [invoicePrefix, setInvoicePrefix] = useDefaultState(seed?.invoicePrefix ?? "");
  const [creditNotePrefix, setCreditNotePrefix] = useDefaultState(seed?.creditNotePrefix ?? "");
  const [withTwins, setWithTwins] = useDefaultState(!!seed?.withTwins);
  const [busy, setBusy] = React.useState(false);
  const [showExplainer, setShowExplainer] = React.useState(false);

  const destBiz = businesses.find((b) => b.id === dest);
  const destLive = destBiz?.livemode === "live";
  const twinsPossible =
    current?.livemode === "live" &&
    destLive &&
    !!current?.test_business_id &&
    !!destBiz?.test_business_id;
  const clears = sections.some((s) => CLEARABLE.includes(s));
  const wipe = !destLive && clearFirst && clears;
  const policyOf = (s: TransferSection): ConflictPolicy => policy[s] ?? startPolicy(dest);
  // A clear-first plans clearable sections against an empty destination: nothing to keep.
  const policyApplies = (s: TransferSection) => !(wipe && CLEARABLE.includes(s));

  async function check() {
    const body: PlanRequest = {
      destination_business: dest,
      sections,
      conflict_policy: Object.fromEntries(
        sections.filter(policyApplies).map((s) => [s, policyOf(s)]),
      ),
      ...(invoicePrefix.trim() || creditNotePrefix.trim()
        ? {
            numbering: {
              ...(invoicePrefix.trim() ? { invoice_prefix: invoicePrefix.trim() } : {}),
              ...(creditNotePrefix.trim() ? { credit_note_prefix: creditNotePrefix.trim() } : {}),
            },
          }
        : {}),
      ...(twinsPossible && withTwins ? { include_test_twins: true } : {}),
      ...(wipe ? { wipe_destination: true } : {}),
      ...(seed?.exclude?.length && seed.dest === dest ? { exclude: seed.exclude } : {}),
    };
    setBusy(true);
    try {
      const r = await planAction(biz, body);
      if (r.ok) onPlan(r.run);
      else toast.error(r.message);
    } finally {
      setBusy(false);
    }
  }

  const other = businesses.filter((b) => b.id !== biz);
  const updateHint = destLive
    ? canOverride
      ? "Changes records of the live business. You type its name to confirm."
      : "Only an owner or an admin can change records of a live business."
    : undefined;

  const picker = (
    <SelectField
      id="dest-select"
      value={dest}
      onValueChange={(v) => {
        setDest(v);
        setPolicy({});
        setClearFirst(false);
      }}
      ariaLabel="Copy to"
      placeholder="Select a business"
      className="h-auto border-0 bg-transparent p-0 font-medium shadow-none focus-visible:ring-0 data-[size=default]:h-7 dark:bg-transparent hover:dark:bg-transparent"
      options={other.map((b) => ({
        value: b.id,
        label: (
          <span className="inline-flex items-center gap-2">
            {b.name}
            <ModeChip live={b.livemode === "live"} />
          </span>
        ),
      }))}
    />
  );

  return (
    <div className="flex flex-col gap-5">
      <RouteBand
        from={<BizTile label="From" biz={current} />}
        to={<BizTile label="To" biz={destBiz} labelFor="dest-select" picker={picker} />}
        aside={
          <>
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={showExplainer}
              onClick={() => setShowExplainer((v) => !v)}
            >
              {showExplainer ? "Hide what is copied" : "Show what is copied"}
            </Button>
            <span className="max-w-60">
              Customers, subscriptions, invoices and payments are never copied.
            </span>
          </>
        }
        steps={stepsOf(null)}
      >
        {dest && destLive && destBiz ? <LiveWarning name={destBiz.name} /> : null}
        {showExplainer ? explainer : null}
      </RouteBand>

      {dest && (
        <SettingsCard
          title="What to copy"
          meta={
            destLive && destBiz
              ? `${destBiz.name} (Live)`
              : `${sections.length} of ${SECTIONS.length} sections`
          }
          padded
        >
          <div className="grid grid-cols-1 gap-3 @min-[40rem]/main:grid-cols-2 @min-[64.375rem]/main:grid-cols-3">
            {SECTIONS.map((s) => {
              const on = sections.includes(s.id);
              const showPolicy = on && policyApplies(s.id);
              return (
                <div
                  key={s.id}
                  className="flex flex-col gap-3 rounded-xl border bg-card p-4 has-data-[state=checked]:bg-muted/30"
                >
                  <CheckboxField
                    checked={on}
                    onCheckedChange={(v) =>
                      setSections(v ? [...sections, s.id] : sections.filter((x) => x !== s.id))
                    }
                    label={s.label}
                    hint={s.description}
                  />
                  <div className="mt-auto flex flex-col gap-1.5 border-t pt-3">
                    {showPolicy ? (
                      <>
                        <FieldLabel htmlFor={`policy-${s.id}`}>A record that is in both</FieldLabel>
                        <SelectField
                          id={`policy-${s.id}`}
                          value={policyOf(s.id)}
                          onValueChange={(v) =>
                            setPolicy({ ...policy, [s.id]: v as ConflictPolicy })
                          }
                          ariaLabel={`${s.label}: a record that is in both`}
                          options={[
                            { value: "skip", label: "Keep what is there" },
                            {
                              value: "update",
                              label: "Update what is there",
                              disabled: destLive && !canOverride,
                            },
                          ]}
                        />
                        {updateHint && (policyOf(s.id) === "update" || !canOverride) && (
                          <p className="m-0 text-xs text-muted-foreground">{updateHint}</p>
                        )}
                      </>
                    ) : (
                      <p className="m-0 text-xs text-muted-foreground">
                        {on ? "Its records are deleted first, then copied." : "Not copied"}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </SettingsCard>
      )}

      {twinsPossible && (
        <SettingsCard title="Test businesses" padded>
          <CheckboxField
            checked={withTwins}
            onCheckedChange={setWithTwins}
            label="Also copy the test businesses"
            hint="The test business of this business goes into the test business of the destination first. If that fails, the live business does not change."
          />
        </SettingsCard>
      )}

      {dest && !destLive && (
        <SettingsCard title="Before the copy" meta="Only for a test business" padded>
          <RadioField
            variant="cards"
            ariaLabel="Before the copy"
            value={wipe ? "clear" : "compare"}
            onValueChange={(v) => setClearFirst(v === "clear")}
            options={[
              {
                value: "compare",
                label: "Compare with the records it has",
                icon: <Columns2 className="size-4 text-muted-foreground" aria-hidden />,
                hint: "Each section above sets what happens to a record that is in both businesses.",
              },
              {
                value: "clear",
                label: "Delete its catalog, coupons and taxes first",
                icon: <Trash2 className="size-4 text-destructive" aria-hidden />,
                hint: clears
                  ? "The destination gets an exact copy of these sections. The “in both” choice then does not apply to them."
                  : "Select Catalog, Coupons or Taxes to use this.",
                disabled: !clears,
              },
            ]}
          />
        </SettingsCard>
      )}

      {dest && (
        <SettingsCard title="Number prefixes" meta="Optional" padded>
          <p className="m-0 mb-4 text-xs text-muted-foreground">
            The copy does not take the number prefixes of the source. To give the destination new
            ones, enter them here.
            {destLive && " A new prefix changes the live business."}
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-4">
            <div className="flex w-72 max-w-full flex-col gap-1.5">
              <label htmlFor="invoice-prefix" className="text-sm font-medium">
                Invoice prefix
              </label>
              <Input
                id="invoice-prefix"
                maxLength={20}
                value={invoicePrefix}
                placeholder={
                  destBiz?.invoice_prefix
                    ? `Keep ${destBiz.invoice_prefix}`
                    : "Keep the current prefix"
                }
                onChange={(e) => setInvoicePrefix(e.target.value)}
              />
            </div>
            <div className="flex w-72 max-w-full flex-col gap-1.5">
              <label htmlFor="credit-note-prefix" className="text-sm font-medium">
                Credit note prefix
              </label>
              <Input
                id="credit-note-prefix"
                maxLength={20}
                value={creditNotePrefix}
                placeholder={
                  destBiz?.credit_note_prefix
                    ? `Keep ${destBiz.credit_note_prefix}`
                    : "Keep the current prefix"
                }
                onChange={(e) => setCreditNotePrefix(e.target.value)}
              />
            </div>
          </div>
        </SettingsCard>
      )}

      {dest && (
        <ActionBar
          status={
            sections.length === 0 ? (
              "Select a section to copy."
            ) : (
              <>
                <span className="font-medium text-foreground">
                  {plural(sections.length, "section")}
                </span>{" "}
                to {destBiz?.name ?? "the destination"}. Nothing changes until you start the copy.
              </>
            )
          }
        >
          <Button onClick={check} disabled={sections.length === 0 || busy}>
            {busy ? "Checking…" : "Check what changes"}
          </Button>
        </ActionBar>
      )}
    </div>
  );
}

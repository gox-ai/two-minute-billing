"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useDefaultState } from "@/lib/use-default-state";
import { CheckboxField } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { Consequence, SettingRow, SettingsCard } from "@/components/settings/settings-layout";
import { SettingSwitch } from "@/components/settings/setting-switch";
import { ACTIONS, type BackdateAction } from "./operations";

const CUTOFF_OPTIONS = [
  { value: "", label: "No cut-off" },
  ...Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: `Day ${i + 1}` })),
];

export interface BackdatingDefaults {
  enabled: boolean;
  allowed: BackdateAction[];
  cutoff: string;
  pastOnCreate: boolean;
  pastOnChange: boolean;
}

/**
 * Every backdating field. With backdating off the engine refuses every past date before
 * reading anything else, so the rest is hidden — but stays mounted, so a save keeps it.
 */
export function BackdatingFields({ d, timezone }: { d: BackdatingDefaults; timezone: string }) {
  const [enabled, setEnabled] = useDefaultState(d.enabled);
  const [allowed, setAllowed] = useDefaultState<Set<BackdateAction>>(new Set(d.allowed), (s) =>
    [...s].sort().join(","),
  );
  const [cutoff, setCutoff] = useDefaultState(d.cutoff);
  const [pastOnCreate, setPastOnCreate] = useDefaultState(d.pastOnCreate);
  const [pastOnChange, setPastOnChange] = useDefaultState(d.pastOnChange);

  const toggle = (a: BackdateAction, on: boolean) =>
    setAllowed((prev) => {
      const next = new Set(prev);
      if (on) next.add(a);
      else next.delete(a);
      return next;
    });

  return (
    <>
      <SettingsCard
        title="Backdating"
        actions={
          <SettingSwitch
            name="enabled"
            label="Allow operations to be backdated"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        }
      >
        <div className="flex flex-col gap-2.5 px-5 py-4">
          <p className="m-0 text-sm text-muted-foreground">
            Whether a request may use a date in the past.
          </p>
          <Consequence>
            {enabled
              ? "On: the operations and cut-off below decide which past dates we accept."
              : "Off: we reject every request with a past date, whatever is set below."}
          </Consequence>
        </div>
      </SettingsCard>

      <div className={cn("flex flex-col gap-5", !enabled && "hidden")}>
        <SettingsCard title="Operations" meta="Which may use a past date">
          <div className="flex flex-col gap-3 px-5 py-4">
            <p className="m-0 text-sm text-muted-foreground">
              Each setting is independent. If you clear one, we reject only that operation when its
              date is before today.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {ACTIONS.map((a) => (
                <CheckboxField
                  key={a.value}
                  name="allowed_actions"
                  value={a.value}
                  checked={allowed.has(a.value)}
                  onCheckedChange={(on) => toggle(a.value, on)}
                  label={a.label}
                  hint={a.hint}
                />
              ))}
            </div>
            {allowed.size === 0 ? (
              <Consequence>None selected: we reject every past-dated operation.</Consequence>
            ) : null}
          </div>
        </SettingsCard>

        <SettingsCard title="Books close" meta="How far back">
          <SettingRow
            label="The previous month's books close on"
            htmlFor="cutoff_day_of_month"
            help={`We count days on the calendar in ${timezone}, where you keep your books.`}
            control={
              <div className="max-w-sm">
                <SelectField
                  name="cutoff_day_of_month"
                  value={cutoff}
                  onValueChange={setCutoff}
                  options={CUTOFF_OPTIONS}
                />
              </div>
            }
            consequence={
              cutoff === ""
                ? "No cut-off: a backdate can go as far back as the request asks."
                : `Until day ${cutoff} of each month, last month still accepts backdated entries. After that day, only the current month accepts them. We always reject anything older than last month.`
            }
          />
        </SettingsCard>

        {/* A backdated invoice is generated at once and may land in a filed period. */}
        <SettingsCard title="Past invoice dates" meta="Invoices raised by a backdate">
          <div className={cn(!allowed.has("create") && "hidden")}>
            <SettingRow
              label="Allow a past invoice date when a subscription is created"
              placement="end"
              control={
                <SettingSwitch
                  name="allow_past_invoice_date_on_create"
                  label="Allow a past invoice date when a subscription is created"
                  checked={pastOnCreate}
                  onCheckedChange={setPastOnCreate}
                />
              }
              consequence={
                pastOnCreate
                  ? "A backdated signup may invoice its first period with a past date."
                  : "We reject a backdated signup that would invoice its first period at once. We still accept a backdated trial, or a signup that defers its first invoice."
              }
            />
          </div>
          <div className={cn("border-t", !allowed.has("change") && "hidden")}>
            <SettingRow
              label="Allow a past invoice date when a subscription is changed"
              placement="end"
              control={
                <SettingSwitch
                  name="allow_past_invoice_date_on_change"
                  label="Allow a past invoice date when a subscription is changed"
                  checked={pastOnChange}
                  onCheckedChange={setPastOnChange}
                />
              }
              consequence={
                pastOnChange
                  ? "A backdated change may raise its proration invoice with a past date."
                  : "We reject a backdated change that would raise its proration invoice at once."
              }
            />
          </div>
          {!allowed.has("create") && !allowed.has("change") ? (
            <p className="m-0 px-5 py-4 text-sm text-muted-foreground">
              Neither creating nor changing a subscription may be backdated, so no backdate raises
              an invoice.
            </p>
          ) : null}
        </SettingsCard>
      </div>
    </>
  );
}

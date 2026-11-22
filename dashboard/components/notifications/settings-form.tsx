"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { ActionForm, useFieldError } from "@/components/form/action-form";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Chip } from "@/components/patterns/chip";
import { SelectAnswer, ToggleAnswer } from "@/components/patterns/settings-page";
import { SettingRow, SettingsCard, SettingsSaveBar } from "@/components/settings/settings-layout";
import { TimezoneSelect } from "@/components/form/timezone-select";
import { useDefaultState } from "@/lib/use-default-state";
import { TIMING_OPTIONS, hourLabel, timingLabel, type Timing } from "@/lib/notifications-view";
import type {
  BusinessFilter,
  CatalogueEntry,
  KindPreference,
  NotificationChannel,
  NotificationPreferences,
  NotificationSettings,
  QuietHours,
  SummarySetting,
} from "@/lib/api/notifications";
import { saveNotificationSettingsAction } from "@/app/(dashboard)/account/notifications/actions";
import { AboveEditor } from "./above-editor";

type Kinds = Record<string, KindPreference>;

interface FormState {
  def: Kinds;
  /** Per business id: only the kinds that differ from `def`. */
  exceptions: Record<string, Kinds>;
  filter: BusinessFilter;
  daily: SummarySetting;
  weekly: SummarySetting;
  sendEmpty: boolean;
  timezone: string;
  summaryHour: number;
  weeklyDay: number;
  quiet: QuietHours;
}

const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hourLabel(h) }));
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map(
  (label, i) => ({ value: String(i + 1), label }),
);
const CHANNELS: Array<{ value: string; label: string; channels: NotificationChannel[] }> = [
  { value: "both", label: "Push and email", channels: ["push", "email"] },
  { value: "email", label: "Email", channels: ["email"] },
  { value: "push", label: "Push", channels: ["push"] },
];
const channelsValue = (c: NotificationChannel[]) =>
  c.includes("push") && c.includes("email") ? "both" : c.includes("push") ? "push" : "email";

const samePref = (a: KindPreference | undefined, b: KindPreference | undefined) =>
  JSON.stringify(normal(a)) === JSON.stringify(normal(b));
function normal(p: KindPreference | undefined) {
  if (!p) return null;
  const above = Object.fromEntries(
    Object.entries(p.above ?? {})
      .filter(([, v]) => v > 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return { timing: p.timing, push: p.push, email: p.email, above };
}

/** "Instant, push and email" — what a business's row falls back to. */
function prefText(p: KindPreference): string {
  if (p.timing !== "instant") return timingLabel(p.timing);
  const ch = [p.push && "push", p.email && "email"].filter(Boolean);
  return ch.length ? `Instant, ${ch.join(" and ")}` : "Instant, bell only";
}

export function seedState(
  prefs: NotificationPreferences,
  settings: NotificationSettings,
  fallbackTz: string,
): FormState {
  return {
    def: prefs.default,
    exceptions: Object.fromEntries(prefs.exceptions.map((e) => [e.business, e.kinds])),
    filter: prefs.business_filter,
    daily: prefs.daily,
    // One "Send by" serves both summaries.
    weekly: { ...prefs.weekly, channels: prefs.daily.channels },
    sendEmpty: prefs.send_empty,
    timezone: settings.set ? settings.timezone : fallbackTz,
    summaryHour: settings.summary_hour,
    weeklyDay: settings.weekly_day,
    quiet: settings.quiet,
  };
}

export function NotificationSettingsForm({
  prefs,
  settings,
  fallbackTz,
  onDirtyChange,
}: {
  prefs: NotificationPreferences;
  settings: NotificationSettings;
  /** Personal zone when none is stored yet: the organization's, else UTC. */
  fallbackTz: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const initial = React.useMemo(
    () => seedState(prefs, settings, fallbackTz),
    [prefs, settings, fallbackTz],
  );
  const [state, setState] = useDefaultState(initial, (v) => JSON.stringify(v));
  const [tab, setTab] = React.useState("default");
  const [resets, setResets] = React.useState(0);
  const dirty = JSON.stringify(state) !== JSON.stringify(initial);
  const showBar = dirty || !prefs.set_up;
  React.useEffect(() => onDirtyChange?.(showBar), [showBar, onDirtyChange]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setState((s) => ({ ...s, [k]: v }));

  const visible = prefs.catalogue.filter((c) => c.visible);
  const live = prefs.businesses;
  const nameOf = (id: string) => live.find((b) => b.id === id)?.name ?? id;
  const exceptionIds = Object.keys(state.exceptions).filter((id) => live.some((b) => b.id === id));
  const activeTab = tab !== "default" && !state.exceptions[tab] ? "default" : tab;

  const setKind = (kind: string, next: KindPreference) =>
    setState((s) => {
      if (activeTab === "default") {
        // A business row equal to the new default is no longer an exception.
        const exceptions = Object.fromEntries(
          Object.entries(s.exceptions).map(([biz, kinds]) => {
            const k = { ...kinds };
            if (samePref(k[kind], next)) delete k[kind];
            return [biz, k];
          }),
        );
        return { ...s, def: { ...s.def, [kind]: next }, exceptions };
      }
      const kinds = { ...s.exceptions[activeTab] };
      if (samePref(next, s.def[kind])) delete kinds[kind];
      else kinds[kind] = next;
      return { ...s, exceptions: { ...s.exceptions, [activeTab]: kinds } };
    });

  const addException = (biz: string) => {
    setState((s) => ({ ...s, exceptions: { ...s.exceptions, [biz]: s.exceptions[biz] ?? {} } }));
    setTab(biz);
  };
  const dropException = (biz: string) => {
    setState((s) => {
      const { [biz]: _drop, ...rest } = s.exceptions;
      return { ...s, exceptions: rest };
    });
    setTab("default");
  };

  const payload = {
    default: state.def,
    // Empty exception tabs store nothing.
    exceptions: Object.entries(state.exceptions)
      .filter(([biz, kinds]) => Object.keys(kinds).length > 0 && live.some((b) => b.id === biz))
      .map(([business, kinds]) => ({ business, kinds })),
    business_filter: state.filter,
    daily: state.daily,
    weekly: { ...state.weekly, channels: state.daily.channels },
    send_empty: state.sendEmpty,
    timezone: state.timezone,
    summary_hour: state.summaryHour,
    weekly_day: state.weeklyDay,
    quiet: state.quiet,
  };

  const summariesOff = !state.daily.enabled && !state.weekly.enabled;

  return (
    <ActionForm action={saveNotificationSettingsAction} className="flex flex-col gap-5">
      <input type="hidden" name="prefs" value={JSON.stringify(payload)} />

      {live.length > 1 ? (
        <SettingsCard id="businesses" title="Businesses" meta="In this organization">
          <SettingRow
            label="Notify me about"
            help='New businesses are included when you select "All businesses". Test businesses never send notifications.'
            placement="end"
            control={
              <SelectAnswer
                ariaLabel="Notify me about"
                value={state.filter.mode}
                onValueChange={(v) =>
                  set(
                    "filter",
                    v === "all"
                      ? { mode: "all" }
                      : { mode: "selected", business_ids: live.map((b) => b.id) },
                  )
                }
                options={[
                  { value: "all", label: `All businesses (${live.length})` },
                  { value: "selected", label: "Selected businesses" },
                ]}
              />
            }
          >
            {state.filter.mode === "selected" ? (
              <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
                <legend className="sr-only">Selected businesses</legend>
                {live.map((b) => {
                  const ids = state.filter.mode === "selected" ? state.filter.business_ids : [];
                  return (
                    <CheckboxField
                      key={b.id}
                      label={b.name}
                      checked={ids.includes(b.id)}
                      onCheckedChange={(on) =>
                        set("filter", {
                          mode: "selected",
                          business_ids: on ? [...ids, b.id] : ids.filter((x) => x !== b.id),
                        })
                      }
                    />
                  );
                })}
                <FieldErrorLine name="business_filter" />
              </fieldset>
            ) : null}
          </SettingRow>
        </SettingsCard>
      ) : null}

      <SettingsCard
        id="events"
        title="Events"
        meta={
          state.filter.mode === "all"
            ? "Every business in this organization"
            : "The businesses you selected"
        }
        actions={
          live.length > 1 && exceptionIds.length < live.length ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="sm">
                  <Plus aria-hidden />
                  Set different settings for a business
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                {live
                  .filter((b) => !exceptionIds.includes(b.id))
                  .map((b) => (
                    <DropdownMenuItem key={b.id} onSelect={() => addException(b.id)}>
                      {b.name}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null
        }
      >
        <div className="flex flex-col gap-3 px-5 py-4">
          {exceptionIds.length ? (
            <Tabs value={activeTab} onValueChange={setTab}>
              <TabsList aria-label="Settings for">
                <TabsTrigger value="default">Default</TabsTrigger>
                {exceptionIds.map((id) => {
                  const n = Object.keys(state.exceptions[id] ?? {}).length;
                  return (
                    <TabsTrigger key={id} value={id}>
                      {nameOf(id)}
                      <span className="text-muted-foreground">
                        · {n === 1 ? "1 change" : `${n} changes`}
                      </span>
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </Tabs>
          ) : null}
          <p className="m-0 text-xs text-muted-foreground">
            {activeTab === "default"
              ? 'Instant events always show in the bell. Push and Email apply to Instant events. Events set to "Daily summary" go out with your summary.'
              : `Rows marked Changed apply only to ${nameOf(activeTab)}. The other rows follow Default.`}
          </p>
        </div>
        <EventTable
          catalogue={visible}
          currencies={prefs.currencies}
          rows={(kind) =>
            activeTab === "default"
              ? { pref: state.def[kind]!, changed: false }
              : {
                  pref: state.exceptions[activeTab]?.[kind] ?? state.def[kind]!,
                  changed: !!state.exceptions[activeTab]?.[kind],
                  fallback: state.def[kind],
                }
          }
          onChange={setKind}
        />
        {activeTab !== "default" ? (
          <div className="border-t px-5 py-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => dropException(activeTab)}
            >
              Use Default for this business
            </Button>
          </div>
        ) : null}
      </SettingsCard>

      <SettingsCard
        id="summaries"
        title="Summaries"
        meta={`One summary per organization · ${state.timezone}`}
      >
        <SettingRow
          label="Daily summary"
          help="What needs action, yesterday in figures, your summary events, and what comes next."
          placement="end"
          control={
            <ToggleAnswer
              label="Daily summary"
              checked={state.daily.enabled}
              onCheckedChange={(on) => set("daily", { ...state.daily, enabled: on })}
            />
          }
        />
        <SettingRow
          label="Weekly summary"
          help="Last week compared with the week before: MRR movement, payments collected, failed and recovered, new and cancelled subscriptions."
          placement="end"
          control={
            <ToggleAnswer
              label="Weekly summary"
              checked={state.weekly.enabled}
              onCheckedChange={(on) => set("weekly", { ...state.weekly, enabled: on })}
            />
          }
        />
        <SettingRow
          label="Time"
          help="The hour we send each summary, in your time zone."
          placement="end"
          control={
            <SelectAnswer
              ariaLabel="Summary time"
              value={String(state.summaryHour)}
              onValueChange={(v) => set("summaryHour", Number(v))}
              options={HOURS}
              disabled={summariesOff}
            />
          }
        />
        <SettingRow
          label="Day of the weekly summary"
          placement="end"
          control={
            <SelectAnswer
              ariaLabel="Day of the weekly summary"
              value={String(state.weeklyDay)}
              onValueChange={(v) => set("weeklyDay", Number(v))}
              options={DAYS}
              disabled={!state.weekly.enabled}
            />
          }
        />
        <SettingRow
          label="Send by"
          help="For both summaries. The bell always shows them."
          placement="end"
          control={
            <SelectAnswer
              ariaLabel="Send summaries by"
              value={channelsValue(state.daily.channels)}
              onValueChange={(v) =>
                set("daily", {
                  ...state.daily,
                  channels: CHANNELS.find((c) => c.value === v)?.channels ?? ["email"],
                })
              }
              options={CHANNELS.map(({ value, label }) => ({ value, label }))}
              disabled={summariesOff}
            />
          }
        />
        <SettingRow
          label="Send on a day with no activity"
          placement="end"
          control={
            <ToggleAnswer
              label="Send on a day with no activity"
              checked={state.sendEmpty}
              onCheckedChange={(on) => set("sendEmpty", on)}
              disabled={summariesOff}
            />
          }
        />
        <SettingRow
          label="Time zone"
          htmlFor="timezone"
          help="Your summaries and quiet hours use this time zone, in all your organizations."
          placement="end"
          control={
            <TimezoneSelect
              key={resets}
              name="timezone"
              defaultValue={state.timezone}
              onValueChange={(z) => z && set("timezone", z)}
              description="Sets when your summaries and quiet hours happen. It does not change a business's billing dates."
              className="w-full sm:w-72"
            />
          }
        />
      </SettingsCard>

      <SettingsCard
        id="quiet-hours"
        title="Quiet hours"
        meta={`For all your organizations · ${state.timezone}`}
      >
        <SettingRow
          label="Hold push notifications at night"
          help="We send one summary when quiet hours end. Email, the bell and Google Chat are not held."
          placement="end"
          control={
            <ToggleAnswer
              label="Hold push notifications at night"
              checked={state.quiet.enabled}
              onCheckedChange={(on) => set("quiet", { ...state.quiet, enabled: on })}
            />
          }
        />
        <SettingRow
          label="From"
          placement="end"
          control={
            <SelectAnswer
              ariaLabel="Quiet hours from"
              value={String(state.quiet.from)}
              onValueChange={(v) => set("quiet", { ...state.quiet, from: Number(v) })}
              options={HOURS}
              disabled={!state.quiet.enabled}
            />
          }
        />
        <SettingRow
          label="To"
          placement="end"
          control={
            <SelectAnswer
              ariaLabel="Quiet hours to"
              value={String(state.quiet.to)}
              onValueChange={(v) => set("quiet", { ...state.quiet, to: Number(v) })}
              options={HOURS}
              disabled={!state.quiet.enabled}
            />
          }
        />
        <SettingRow
          label="Send dispute notifications during quiet hours"
          placement="end"
          control={
            <ToggleAnswer
              label="Send dispute notifications during quiet hours"
              checked={state.quiet.disputes_through}
              onCheckedChange={(on) => set("quiet", { ...state.quiet, disputes_through: on })}
              disabled={!state.quiet.enabled}
            />
          }
        />
      </SettingsCard>

      {showBar ? (
        <SettingsSaveBar
          note={
            dirty
              ? "You have unsaved changes."
              : "We send nothing until you save. Save to start with the settings shown."
          }
        >
          {dirty ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setState(initial);
                setResets((n) => n + 1);
              }}
            >
              Cancel
            </Button>
          ) : null}
        </SettingsSaveBar>
      ) : null}
    </ActionForm>
  );
}

/** The action's error for a field with no `Field` of its own. Inside the ActionForm. */
function FieldErrorLine({ name }: { name: string }) {
  const error = useFieldError(name);
  return error ? <p className="m-0 text-xs font-medium text-destructive">{error}</p> : null;
}

function EventTable({
  catalogue,
  currencies,
  rows,
  onChange,
}: {
  catalogue: CatalogueEntry[];
  currencies: string[];
  rows: (kind: string) => {
    pref: KindPreference;
    changed: boolean;
    fallback?: KindPreference;
  };
  onChange: (kind: string, next: KindPreference) => void;
}) {
  const groups: Array<{ group: string; items: CatalogueEntry[] }> = [];
  for (const c of catalogue) {
    const g = groups.find((x) => x.group === c.group);
    if (g) g.items.push(c);
    else groups.push({ group: c.group, items: [c] });
  }
  return (
    <Table phone="stack">
      <TableHeader>
        <TableRow>
          <TableHead phone="title">Event</TableHead>
          <TableHead phone="aside" className="w-44">
            When
          </TableHead>
          <TableHead className="w-24">Push</TableHead>
          <TableHead className="w-24">Email</TableHead>
          <TableHead className="w-44">Only above</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((g) => (
          <React.Fragment key={g.group}>
            <TableRow className="hover:bg-transparent">
              <TableCell
                colSpan={5}
                className="h-9 bg-muted/25 text-xs font-medium text-muted-foreground"
              >
                {g.group}
              </TableCell>
            </TableRow>
            {g.items.map((c) => {
              const { pref, changed, fallback } = rows(c.kind);
              const set = (patch: Partial<KindPreference>) =>
                onChange(c.kind, { ...pref, ...patch });
              return (
                <TableRow key={c.kind} className="hover:bg-transparent">
                  <TableCell className="py-2 whitespace-normal">
                    <span className="flex flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {c.label}
                        {changed ? <Chip>Changed</Chip> : null}
                      </span>
                      {changed && fallback ? (
                        <span className="text-xs text-muted-foreground">
                          Default: {prefText(fallback)}
                        </span>
                      ) : c.help ? (
                        <span className="text-xs text-muted-foreground">{c.help}</span>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell>
                    <SelectField
                      size="sm"
                      ariaLabel={`When for ${c.label}`}
                      value={pref.timing}
                      onValueChange={(v) => set({ timing: v as Timing })}
                      options={TIMING_OPTIONS}
                      className="w-40"
                    />
                  </TableCell>
                  {/* No fragments: the phone layout counts a row's direct cells. */}
                  {pref.timing === "summary" ? (
                    <TableCell
                      colSpan={2}
                      data-label="Push, Email"
                      className="text-sm text-muted-foreground"
                    >
                      In the summary
                    </TableCell>
                  ) : (
                    <TableCell
                      className={pref.timing === "off" ? "text-muted-foreground" : undefined}
                    >
                      {pref.timing === "instant" ? (
                        <CheckboxField
                          ariaLabel={`Push for ${c.label}`}
                          checked={pref.push}
                          onCheckedChange={(on) => set({ push: on })}
                        />
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  )}
                  {pref.timing === "summary" ? null : (
                    <TableCell
                      className={pref.timing === "off" ? "text-muted-foreground" : undefined}
                    >
                      {pref.timing === "instant" ? (
                        <CheckboxField
                          ariaLabel={`Email for ${c.label}`}
                          checked={pref.email}
                          onCheckedChange={(on) => set({ email: on })}
                        />
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  )}
                  <TableCell>
                    {c.amount && pref.timing !== "off" ? (
                      <AboveEditor
                        label={c.label}
                        currencies={currencies}
                        value={pref.above}
                        onChange={(above) => set({ above })}
                      />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </React.Fragment>
        ))}
      </TableBody>
    </Table>
  );
}

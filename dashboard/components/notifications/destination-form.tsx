"use client";

import * as React from "react";
import { ActionForm, useFieldError } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { KeptInput } from "@/components/form/kept-input";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SelectAnswer, ToggleAnswer } from "@/components/patterns/settings-page";
import { SettingRow, SettingsCard, SettingsSaveBar } from "@/components/settings/settings-layout";
import { useDefaultState } from "@/lib/use-default-state";
import type {
  BusinessFilter,
  CatalogueEntry,
  DestinationKind,
  NotificationDestination,
} from "@/lib/api/notifications";
import { updateDestinationAction } from "@/app/(dashboard)/settings/notifications/actions";
import { AboveEditor } from "./above-editor";

interface State {
  filter: BusinessFilter;
  kinds: Record<string, DestinationKind>;
  daily: boolean;
  weekly: boolean;
  hideNames: boolean;
}

const seed = (d: NotificationDestination): State => ({
  filter: d.business_filter,
  kinds: d.kinds,
  daily: d.daily,
  weekly: d.weekly,
  hideNames: d.hide_names,
});

/**
 * The edit view of one destination. Like a member's event table, but each event is on or off:
 * a space or an address gets the daily and weekly summary as one switch each.
 */
export function DestinationForm({
  destination: d,
  businesses,
  catalogue,
  currencies,
}: {
  destination: NotificationDestination;
  businesses: Array<{ id: string; name: string }>;
  catalogue: CatalogueEntry[];
  currencies: string[];
}) {
  const initial = React.useMemo(() => seed(d), [d]);
  const [state, setState] = useDefaultState(initial, (v) => JSON.stringify(v));
  const set = <K extends keyof State>(k: K, v: State[K]) => setState((s) => ({ ...s, [k]: v }));
  const chat = d.type === "chat";
  const groups: Array<{ group: string; items: CatalogueEntry[] }> = [];
  for (const c of catalogue) {
    const g = groups.find((x) => x.group === c.group);
    if (g) g.items.push(c);
    else groups.push({ group: c.group, items: [c] });
  }
  const kindOf = (kind: string): DestinationKind => state.kinds[kind] ?? { on: false };
  const setKind = (kind: string, next: DestinationKind) =>
    setState((s) => ({ ...s, kinds: { ...s.kinds, [kind]: next } }));

  return (
    <ActionForm action={updateDestinationAction} className="flex flex-col gap-5">
      <input type="hidden" name="id" value={d.id} />
      <input
        type="hidden"
        name="config"
        value={JSON.stringify({
          business_filter: state.filter,
          kinds: state.kinds,
          daily: state.daily,
          weekly: state.weekly,
          hide_names: state.hideNames,
        })}
      />
      {d.type === "email" && d.status === "pending" ? (
        <Alert tone="neutral">
          This address has not confirmed yet. We send it nothing until it selects the link in the
          confirmation email.
        </Alert>
      ) : null}
      {chat ? (
        <SettingsCard
          id="webhook"
          title="Space"
          meta={d.url_hint ? `Webhook URL ends in ${d.url_hint}` : undefined}
        >
          {d.status === "not_working" ? (
            <div className="px-5 pt-4">
              <Alert tone="error" title="Not working">
                {d.last_error ?? "Google Chat refuses the webhook URL."} Enter the new webhook URL
                of the space.
              </Alert>
            </div>
          ) : null}
          <div className="flex flex-col gap-4 px-5 py-4">
            <Field name="name" label="Name">
              <KeptInput
                name="name"
                defaultValue={d.name}
                maxLength={100}
                required
                className="sm:w-72"
              />
            </Field>
            <Field
              name="url"
              label="New webhook URL"
              help="Empty keeps the current URL. A new URL makes the space work again."
            >
              <KeptInput
                name="url"
                type="url"
                placeholder="https://chat.googleapis.com/v1/spaces/…"
                maxLength={2048}
              />
            </Field>
          </div>
        </SettingsCard>
      ) : null}

      <SettingsCard id="businesses" title="Businesses">
        <SettingRow
          label="Send about"
          help="Test businesses never send notifications."
          placement="end"
          control={
            <SelectAnswer
              ariaLabel="Send about"
              value={state.filter.mode}
              onValueChange={(v) =>
                set(
                  "filter",
                  v === "all"
                    ? { mode: "all" }
                    : { mode: "selected", business_ids: businesses.map((b) => b.id) },
                )
              }
              options={[
                { value: "all", label: `All businesses (${businesses.length})` },
                { value: "selected", label: "Selected businesses" },
              ]}
            />
          }
        >
          {state.filter.mode === "selected" ? (
            <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
              <legend className="sr-only">Selected businesses</legend>
              {businesses.map((b) => {
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
        {chat ? (
          <SettingRow
            label="Hide customer names and email addresses"
            help="Messages show the amount and the business, without the customer."
            placement="end"
            control={
              <ToggleAnswer
                label="Hide customer names and email addresses"
                checked={state.hideNames}
                onCheckedChange={(on) => set("hideNames", on)}
              />
            }
          />
        ) : null}
      </SettingsCard>

      <SettingsCard id="events" title="Events" meta="Sent as each event happens">
        <Table phone="stack">
          <TableHeader>
            <TableRow>
              <TableHead phone="title">Event</TableHead>
              <TableHead phone="aside" className="w-24">
                Send
              </TableHead>
              <TableHead className="w-44">Only above</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((g) => (
              <React.Fragment key={g.group}>
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={3}
                    className="h-9 bg-muted/25 text-xs font-medium text-muted-foreground"
                  >
                    {g.group}
                  </TableCell>
                </TableRow>
                {g.items.map((c) => {
                  const k = kindOf(c.kind);
                  return (
                    <TableRow key={c.kind} className="hover:bg-transparent">
                      <TableCell className="py-2 whitespace-normal">
                        <span className="flex flex-col gap-0.5">
                          <span className="text-sm font-medium">{c.label}</span>
                          {c.help ? (
                            <span className="text-xs text-muted-foreground">{c.help}</span>
                          ) : null}
                        </span>
                      </TableCell>
                      <TableCell>
                        <ToggleAnswer
                          label={`Send ${c.label}`}
                          checked={k.on}
                          onCheckedChange={(on) => setKind(c.kind, { ...k, on })}
                        />
                      </TableCell>
                      <TableCell>
                        {c.amount && k.on ? (
                          <AboveEditor
                            label={c.label}
                            currencies={currencies}
                            value={k.above}
                            onChange={(above) => setKind(c.kind, { ...k, above })}
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
      </SettingsCard>

      <SettingsCard id="summaries" title="Summaries" meta="At 08:00 in each business's time zone">
        <SettingRow
          label="Daily summary"
          help="What needs action, yesterday in figures and what comes next. Sent only on a day with activity."
          placement="end"
          control={
            <ToggleAnswer
              label="Daily summary"
              checked={state.daily}
              onCheckedChange={(on) => set("daily", on)}
            />
          }
        />
        <SettingRow
          label="Weekly summary"
          help="Last week compared with the week before. Sent on Monday."
          placement="end"
          control={
            <ToggleAnswer
              label="Weekly summary"
              checked={state.weekly}
              onCheckedChange={(on) => set("weekly", on)}
            />
          }
        />
      </SettingsCard>

      <SettingsSaveBar>
        <Button
          type="button"
          variant="outline"
          disabled={JSON.stringify(state) === JSON.stringify(initial)}
          onClick={() => setState(initial)}
        >
          Cancel
        </Button>
      </SettingsSaveBar>
    </ActionForm>
  );
}

function FieldErrorLine({ name }: { name: string }) {
  const error = useFieldError(name);
  return error ? <p className="m-0 text-xs font-medium text-destructive">{error}</p> : null;
}

"use client";

import * as React from "react";
import { ActionForm, useFieldError } from "@/components/form/action-form";
import { Input } from "@/components/ui/input";
import { SwitchField } from "@/components/ui/switch";
import { CheckboxField } from "@/components/ui/checkbox";
import { RadioField } from "@/components/ui/radio-group";
import {
  SettingRow,
  SettingsCard,
  SettingsColumns,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { MoneyField, majorToMinor, useFormModel } from "@/components/catalog/form-kit";
import { saveCreditConfigAction } from "@/app/(dashboard)/businesses/[biz]/settings/credits/actions";
import { toMajorInput } from "@/lib/money";
import { money } from "@/lib/format";
import {
  POLICY_LABEL,
  TAX_TREATMENT_LABEL,
  type CreditOnExhausted,
  type ResolvedCreditConfig,
} from "@/lib/credits";

interface Values {
  blocking: boolean;
  policy: CreditOnExhausted;
  hold: string;
  share: string;
  overdraft: Record<string, string>;
  topMin: Record<string, string>;
  topMax: Record<string, string>;
  grantMax: Record<string, string>;
  grantAlert: Record<string, string>;
  tax: string;
  /** Credit scope (2.55): "all", "meters" or "prices" (set through the API, kept as it is). */
  scope: "all" | "meters" | "prices";
  scopeMeters: string[];
}

export interface ScopeMeter {
  key: string;
  name: string;
  archived: boolean;
}

const seedOf = (c: ResolvedCreditConfig, currencies: string[]): Values => ({
  blocking: c.blocking_enabled,
  policy: c.on_exhausted_default,
  hold: String(c.hold_default_seconds),
  share: String(c.in_flight_share_bps / 100),
  overdraft: Object.fromEntries(
    currencies.map((cur) => [cur, toMajorInput(c.overdraft_limit_minor[cur] ?? 0, cur)]),
  ),
  topMin: Object.fromEntries(
    currencies.map((cur) => [cur, toMajorInput(c.top_up_limits[cur]?.min_minor ?? null, cur)]),
  ),
  topMax: Object.fromEntries(
    currencies.map((cur) => [cur, toMajorInput(c.top_up_limits[cur]?.max_minor ?? null, cur)]),
  ),
  grantMax: Object.fromEntries(
    currencies.map((cur) => [cur, toMajorInput(c.grant_limits[cur]?.max_minor ?? null, cur)]),
  ),
  grantAlert: Object.fromEntries(
    currencies.map((cur) => [
      cur,
      toMajorInput(c.grant_limits[cur]?.alert_above_minor ?? null, cur),
    ]),
  ),
  tax: c.default_tax_treatment ?? "",
  scope: c.credit_scope?.kind ?? "all",
  scopeMeters: c.credit_scope?.kind === "meters" ? c.credit_scope.meters : [],
});

const minorOrNull = (major: string | undefined, cur: string) => {
  const m = majorToMinor(major ?? "", cur);
  return m === "" ? null : Number(m);
};

/** The config the form posts: every key, so the API can replace the column whole. */
function toConfig(v: Values, currencies: string[], saved: ResolvedCreditConfig) {
  const overdraft: Record<string, number> = { ...saved.overdraft_limit_minor };
  const topUp: ResolvedCreditConfig["top_up_limits"] = { ...saved.top_up_limits };
  const grants: ResolvedCreditConfig["grant_limits"] = { ...saved.grant_limits };
  for (const cur of currencies) {
    const gMax = minorOrNull(v.grantMax[cur], cur);
    const gAlert = minorOrNull(v.grantAlert[cur], cur);
    if (gMax == null && gAlert == null) delete grants[cur];
    else grants[cur] = { max_minor: gMax, alert_above_minor: gAlert };
    const o = minorOrNull(v.overdraft[cur], cur);
    if (o) overdraft[cur] = o;
    else delete overdraft[cur];
    const min = minorOrNull(v.topMin[cur], cur);
    const max = minorOrNull(v.topMax[cur], cur);
    if (min == null && max == null) delete topUp[cur];
    else topUp[cur] = { min_minor: min, max_minor: max };
  }
  return {
    hold_default_seconds: Number(v.hold),
    in_flight_share_bps: Math.round(Number(v.share) * 100),
    blocking_enabled: v.blocking,
    on_exhausted_default: v.policy,
    overdraft_limit_minor: overdraft,
    top_up_limits: topUp,
    grant_limits: grants,
    default_tax_treatment: v.tax === "" ? null : v.tax,
    credit_scope:
      v.scope === "meters"
        ? { kind: "meters" as const, meters: v.scopeMeters }
        : v.scope === "prices"
          ? saved.credit_scope
          : null,
  };
}

/** Settings → Credits (`businesses.credit_config`). */
export function CreditSettingsForm({
  biz,
  config,
  currencies,
  meters,
  version,
}: {
  biz: string;
  config: ResolvedCreditConfig;
  currencies: string[];
  meters: ScopeMeter[];
  version?: number;
}) {
  const formRef = React.useRef<HTMLFormElement>(null);
  const [v, set] = useFormModel(seedOf(config, currencies), formRef);
  const setIn = (
    key: "overdraft" | "topMin" | "topMax" | "grantMax" | "grantAlert",
    cur: string,
    val: string,
  ) => set(key, { ...v[key], [cur]: val });

  const topUpLine = (cur: string) => {
    const l = config.top_up_limits[cur];
    if (!l || (l.min_minor == null && l.max_minor == null)) return "No limit";
    return [
      l.min_minor != null ? `from ${money(l.min_minor, cur)}` : null,
      l.max_minor != null ? `up to ${money(l.max_minor, cur)}` : null,
    ]
      .filter(Boolean)
      .join(" ");
  };

  const grantLine = (cur: string) => {
    const l = config.grant_limits[cur];
    if (!l || (l.max_minor == null && l.alert_above_minor == null)) return "No limit, no alert";
    return [
      l.max_minor != null ? `up to ${money(l.max_minor, cur)} for each grant` : "no limit",
      l.alert_above_minor != null ? `alert above ${money(l.alert_above_minor, cur)}` : null,
    ]
      .filter(Boolean)
      .join(", ");
  };

  return (
    <ActionForm action={saveCreditConfigAction} formRef={formRef}>
      <input type="hidden" name="biz" value={biz} />
      {version != null ? <input type="hidden" name="expected_version" value={version} /> : null}
      <input type="hidden" name="config" value={JSON.stringify(toConfig(v, currencies, config))} />
      <SettingsColumns
        summary={
          <SettingsSummary
            items={[
              {
                label: "When credit is used up",
                value: config.blocking_enabled
                  ? `Blocking is on. Default: ${POLICY_LABEL[config.on_exhausted_default].toLowerCase()}`
                  : "Blocking is off. We bill usage on the invoice",
              },
              {
                label: "Hold time",
                value: `${config.hold_default_seconds} seconds`,
              },
              {
                label: "Open holds",
                value: `Up to ${config.in_flight_share_bps / 100}% of the balance`,
              },
              {
                label: "Default tax treatment",
                value: config.default_tax_treatment
                  ? TAX_TREATMENT_LABEL[config.default_tax_treatment]
                  : "Not set. Each paid credit pack sets its own",
              },
              { label: "Credit scope", value: scopeLine(config, meters) },
              ...currencies.map((cur) => ({
                label: `Credit purchases in ${cur}`,
                value: topUpLine(cur),
              })),
              ...currencies.map((cur) => ({
                label: `Free credit in ${cur}`,
                value: grantLine(cur),
              })),
            ]}
          />
        }
        save={{ note: "The changes apply to the next access check, hold and purchase." }}
      >
        <SettingsCard title="Usage when credit is used up">
          <SettingRow
            label="Block usage when credit is used up"
            placement="end"
            help="When this is off, the access check never refuses for lack of credit. We bill all usage on the invoice."
            control={
              <SwitchField
                checked={v.blocking}
                onCheckedChange={(c) => set("blocking", c)}
                ariaLabel="Block usage when credit is used up"
              />
            }
          />
          {/* The policy and the overdraft limit do nothing while blocking is off. */}
          {v.blocking ? (
            <>
              <SettingRow
                label="Default policy"
                help="Applies when the customer, the credit grant and the plan price do not set a policy."
                control={
                  <RadioField
                    value={v.policy}
                    onValueChange={(p) => set("policy", p as CreditOnExhausted)}
                    ariaLabel="Default policy"
                    options={[
                      {
                        value: "bill",
                        label: POLICY_LABEL.bill,
                        hint: "The customer can continue. We bill the usage on the invoice.",
                      },
                      {
                        value: "block",
                        label: POLICY_LABEL.block,
                        hint: "The access check refuses when the customer has no credit available.",
                      },
                    ]}
                  />
                }
              />
              <SettingRow
                label="Overdraft limit"
                help="How far below zero a balance can go before we block. 0 blocks at zero. You can set a different limit on a customer."
                errorFor="overdraft_limit_minor"
              >
                <div className="grid max-w-md grid-cols-1 gap-3 sm:grid-cols-2">
                  {currencies.map((cur) => (
                    <MoneyField
                      key={cur}
                      id={`overdraft_${cur}`}
                      currency={cur}
                      value={v.overdraft[cur] ?? ""}
                      onChange={(x) => setIn("overdraft", cur, x)}
                    />
                  ))}
                </div>
              </SettingRow>
            </>
          ) : null}
        </SettingsCard>

        <SettingsCard title="Holds">
          <SettingRow
            label="Hold time"
            htmlFor="hold_default_seconds"
            help="How long a hold stays open when the app does not set a time. From 1 to 86,400 seconds."
            errorFor="hold_default_seconds"
            control={
              <div className="flex items-center gap-2">
                <Input
                  id="hold_default_seconds"
                  type="number"
                  min={1}
                  max={86400}
                  value={v.hold}
                  onChange={(e) => set("hold", e.target.value)}
                  className="w-32 tabular-nums"
                />
                <span className="text-sm text-muted-foreground">seconds</span>
              </div>
            }
          />
          <SettingRow
            label="Open holds limit"
            htmlFor="in_flight_share"
            help="The part of the balance that open holds can use at one time. A new hold above it gets in_flight_limit."
            errorFor="in_flight_share_bps"
            control={
              <div className="flex items-center gap-2">
                <Input
                  id="in_flight_share"
                  type="number"
                  min={0.01}
                  max={100}
                  step={0.01}
                  value={v.share}
                  onChange={(e) => set("share", e.target.value)}
                  className="w-32 tabular-nums"
                />
                <span className="text-sm text-muted-foreground">% of the balance</span>
              </div>
            }
          />
        </SettingsCard>

        <SettingsCard title="Credit scope">
          <SettingRow
            label="Usage that credit pays"
            help="Applies to every credit grant that does not name its own prices or meters. A grant that names them keeps its own scope."
            errorFor="credit_scope"
            control={
              <RadioField
                value={v.scope}
                onValueChange={(x) => set("scope", x as Values["scope"])}
                ariaLabel="Usage that credit pays"
                options={[
                  {
                    value: "all",
                    label: "Every usage line",
                    hint: "Credit pays the usage of every meter and every usage price.",
                  },
                  {
                    value: "meters",
                    label: "Only the usage of the selected meters",
                    hint: "Credit pays only the usage lines of these meters. We bill the other usage on the invoice.",
                  },
                  // A price scope is set through the API; the screen keeps it as it is.
                  ...(config.credit_scope?.kind === "prices"
                    ? [
                        {
                          value: "prices",
                          label: "Only the usage of the prices set through the API",
                          hint: `${config.credit_scope.prices.length} prices. Change the list through the API.`,
                        },
                      ]
                    : []),
                ]}
              />
            }
          />
          {v.scope === "meters" ? (
            <SettingRow label="Meters" help="Select one or more meters.">
              {meters.length === 0 ? (
                <p className="m-0 text-sm text-muted-foreground">
                  This business has no meters. Create a meter first.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {meters.map((m) => (
                    <CheckboxField
                      key={m.key}
                      label={m.archived ? `${m.name} (archived)` : m.name}
                      hint={m.key}
                      checked={v.scopeMeters.includes(m.key)}
                      onCheckedChange={(c) =>
                        set(
                          "scopeMeters",
                          c ? [...v.scopeMeters, m.key] : v.scopeMeters.filter((k) => k !== m.key),
                        )
                      }
                    />
                  ))}
                </div>
              )}
            </SettingRow>
          ) : null}
        </SettingsCard>

        <SettingsCard title="Credit purchases">
          <SettingRow
            label="Purchase limits"
            help="The minimum and maximum value of the credit packs on one purchase: checkout, payment links, the portal and manual invoices. Leave a field empty for no limit. Free credit that you give has its own limits below."
          >
            <div className="flex flex-col gap-3">
              {currencies.map((cur) => (
                <div key={cur} className="flex flex-col gap-1">
                  <div className="grid max-w-xl grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Minimum
                      <MoneyField
                        id={`top_up_min_${cur}`}
                        currency={cur}
                        value={v.topMin[cur] ?? ""}
                        onChange={(x) => setIn("topMin", cur, x)}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Maximum
                      <MoneyField
                        id={`top_up_max_${cur}`}
                        currency={cur}
                        value={v.topMax[cur] ?? ""}
                        onChange={(x) => setIn("topMax", cur, x)}
                      />
                    </label>
                  </div>
                  <TopUpError cur={cur} />
                </div>
              ))}
            </div>
          </SettingRow>
          <SettingRow
            label="Default tax treatment for paid credit"
            help="A paid credit pack that does not set a tax treatment uses this one. Credit in your own units is always taxed at purchase."
            control={
              <RadioField
                value={v.tax}
                onValueChange={(t) => set("tax", t)}
                ariaLabel="Default tax treatment"
                options={[
                  {
                    value: "",
                    label: "Not set",
                    hint: "Each paid credit pack must set its own tax treatment.",
                  },
                  {
                    value: "taxed_at_purchase",
                    label: TAX_TREATMENT_LABEL.taxed_at_purchase,
                    hint: "We charge tax on the purchase. Usage paid by the credit has no tax.",
                  },
                  {
                    value: "taxed_at_use",
                    label: TAX_TREATMENT_LABEL.taxed_at_use,
                    hint: "The purchase has no tax. We charge tax on the usage, and the credit pays it.",
                  },
                ]}
              />
            }
          />
        </SettingsCard>

        <SettingsCard title="Free credit">
          <SettingRow
            label="Limits on free credit"
            help="For each grant of free credit that you give: a wallet top-up of type granted, promotional credit and a promotional credit grant. We refuse a grant above the maximum. Above the alert amount, we record the grant in the audit log and send a team alert, if that alert is on. Leave a field empty for no limit."
          >
            <div className="flex flex-col gap-3">
              {currencies.map((cur) => (
                <div key={cur} className="grid max-w-xl grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Maximum for one grant
                    <MoneyField
                      id={`grant_max_${cur}`}
                      currency={cur}
                      value={v.grantMax[cur] ?? ""}
                      onChange={(x) => setIn("grantMax", cur, x)}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Alert above
                    <MoneyField
                      id={`grant_alert_${cur}`}
                      currency={cur}
                      value={v.grantAlert[cur] ?? ""}
                      onChange={(x) => setIn("grantAlert", cur, x)}
                    />
                  </label>
                </div>
              ))}
            </div>
          </SettingRow>
        </SettingsCard>
      </SettingsColumns>
    </ActionForm>
  );
}

function TopUpError({ cur }: { cur: string }) {
  const error = useFieldError(`top_up_${cur}`);
  return error ? <p className="m-0 text-xs text-destructive">{error}</p> : null;
}

/** The saved scope, as a summary line. */
function scopeLine(c: ResolvedCreditConfig, meters: ScopeMeter[]): string {
  const s = c.credit_scope;
  if (!s) return "Every usage line";
  if (s.kind === "prices") return `${s.prices.length} prices, set through the API`;
  const names = s.meters.map((k) => meters.find((m) => m.key === k)?.name ?? k);
  return `Only ${names.join(", ")}`;
}

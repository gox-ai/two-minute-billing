"use client";

import * as React from "react";
import { ActionForm, useFieldError } from "@/components/form/action-form";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
import { majorToMinor, useFormModel } from "@/components/catalog/form-kit";
import { saveCreditConfigAction } from "@/app/(dashboard)/businesses/[biz]/settings/credits/actions";
import { currencyExponent, majorStep, toMajorInput } from "@/lib/money";
import { money } from "@/lib/format";
import { plural } from "@/lib/labels";
import {
  fmtUnits,
  NO_SUBSCRIPTION_INVOICE_DAYS,
  POLICY_LABEL,
  RESTORE_EXPIRY_MONTHS,
  TAX_TREATMENT_LABEL,
  type AutoTopupOnHardDecline,
  type CaptureOverHold,
  type CreditOnExhausted,
  type InFlightApplies,
  type NoSubscriptionOverdraft,
  type NoSubscriptionUsage,
  type ResolvedCreditConfig,
  type TrialUsage,
} from "@/lib/credits";
import { SettingError } from "@/components/settings/setting-error";
import {
  RETRY_HOURS_KEY,
  TOPUP_RETRY_DEFAULT_HOURS,
  TOPUP_RETRY_MAX_DELAYS,
  TOPUP_RETRY_METHODS,
  TOPUP_RETRY_METHOD_NAME,
  TOPUP_RETRY_WINDOW_HOURS,
  hoursList,
  parseHoursText,
  retryConsequence,
  retryMethodKey,
  retryRowKey,
  retryScheduleLine,
  topupRetryDraft,
  type TopupRetryDraft,
  type TopupRetryMethod,
} from "@/lib/topup-retry";
import { unitLimitErrorKey, unitLimitInput, type UnitLimitDraft } from "@/lib/unit-grant-limits";

interface Values {
  blocking: boolean;
  policy: CreditOnExhausted;
  hold: string;
  share: string;
  shareApplies: InFlightApplies;
  overdraft: Record<string, string>;
  topMin: Record<string, string>;
  topMax: Record<string, string>;
  grantMax: Record<string, string>;
  grantAlert: Record<string, string>;
  /** Units with no money value, by unit key: the limits as typed, in whole units. */
  unitMax: Record<string, string>;
  unitAlert: Record<string, string>;
  tax: string;
  /** Credit scope (2.55): "all", "meters" or "prices" (set through the API, kept as it is). */
  scope: "all" | "meters" | "prices";
  scopeMeters: string[];
  /** `portal_auto_topup`. */
  portalTopup: boolean;
  /** `late_event_grace_hours`, as typed. */
  lateHours: string;
  /** `auto_topup_retries`. */
  retries: boolean;
  /** `auto_topup_retry_hours`, one row per delay. The key keeps a row's input on removal. */
  retryRows: Array<{ key: number; value: string }>;
  /** `auto_topup_retry_hours_by_method`, as typed: a comma-separated list per kind. */
  retryMethod: Record<TopupRetryMethod, string>;
  trialUsage: TrialUsage;
  noSubUsage: NoSubscriptionUsage;
  noSubOverdraft: NoSubscriptionOverdraft;
  /** `no_subscription_invoice_after_days`, as typed. */
  noSubDays: string;
  /** `restore_expiry_months`: "months" with the typed number, or "never". */
  restoreMode: "months" | "never";
  restoreMonths: string;
  hardDecline: AutoTopupOnHardDecline;
  captureOverHold: CaptureOverHold;
}

export interface ScopeMeter {
  key: string;
  name: string;
  archived: boolean;
}

/** An active credit unit with no money value: free credit in it has its own limit. */
export interface LimitUnit {
  key: string;
  name: string;
  plural: string;
  decimals: number;
}

const seedOf = (c: ResolvedCreditConfig, currencies: string[], units: LimitUnit[]): Values => ({
  blocking: c.blocking_enabled,
  policy: c.on_exhausted_default,
  hold: String(c.hold_default_seconds),
  share: String(c.in_flight_share_bps / 100),
  shareApplies: c.in_flight_applies,
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
  unitMax: Object.fromEntries(
    units.map((u) => [u.key, unitLimitInput(c.unit_grant_limits[u.key]?.max_units, u.decimals)]),
  ),
  unitAlert: Object.fromEntries(
    units.map((u) => [
      u.key,
      unitLimitInput(c.unit_grant_limits[u.key]?.alert_above_units, u.decimals),
    ]),
  ),
  tax: c.default_tax_treatment ?? "",
  scope: c.credit_scope?.kind ?? "all",
  scopeMeters: c.credit_scope?.kind === "meters" ? c.credit_scope.meters : [],
  portalTopup: c.portal_auto_topup,
  lateHours: String(c.late_event_grace_hours),
  retries: c.auto_topup_retries,
  retryRows: topupRetryDraft(c).hours.map((value, key) => ({ key, value })),
  retryMethod: { card: topupRetryDraft(c).card, bank_debit: topupRetryDraft(c).bank_debit },
  trialUsage: c.trial_usage,
  noSubUsage: c.no_subscription_usage,
  noSubOverdraft: c.no_subscription_overdraft,
  noSubDays: String(c.no_subscription_invoice_after_days),
  restoreMode: c.restore_expiry_months === "never" ? "never" : "months",
  restoreMonths: String(
    c.restore_expiry_months === "never" ? RESTORE_EXPIRY_MONTHS.default : c.restore_expiry_months,
  ),
  hardDecline: c.auto_topup_on_hard_decline,
  captureOverHold: c.capture_over_hold,
});

/** A typed whole number; "" posts null and the action answers under the field. */
const typedNumber = (x: string) => (x.trim() === "" ? null : Number(x));

const minorOrNull = (major: string | undefined, cur: string) => {
  const m = majorToMinor(major ?? "", cur);
  return m === "" ? null : Number(m);
};

/** The config the form posts: every key, so the API can replace the column whole. */
function toConfig(
  v: Values,
  currencies: string[],
  saved: ResolvedCreditConfig,
  units: LimitUnit[],
) {
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
    in_flight_applies: v.shareApplies,
    blocking_enabled: v.blocking,
    on_exhausted_default: v.policy,
    overdraft_limit_minor: overdraft,
    top_up_limits: topUp,
    grant_limits: grants,
    // The stored limits; the action sets the typed fields (`unit_limits`) over them. With
    // no such unit the key is left out, and the API keeps what it has.
    ...(units.length > 0 ? { unit_grant_limits: saved.unit_grant_limits } : {}),
    default_tax_treatment: v.tax === "" ? null : v.tax,
    credit_scope:
      v.scope === "meters"
        ? { kind: "meters" as const, meters: v.scopeMeters }
        : v.scope === "prices"
          ? saved.credit_scope
          : null,
    portal_auto_topup: v.portalTopup,
    // "" posts null, and the action answers "Enter a number of hours." under the field.
    late_event_grace_hours: typedNumber(v.lateHours),
    trial_usage: v.trialUsage,
    no_subscription_usage: v.noSubUsage,
    no_subscription_overdraft: v.noSubOverdraft,
    no_subscription_invoice_after_days: typedNumber(v.noSubDays),
    restore_expiry_months: v.restoreMode === "never" ? "never" : typedNumber(v.restoreMonths),
    auto_topup_on_hard_decline: v.hardDecline,
    capture_over_hold: v.captureOverHold,
  };
}

/** Settings → Credits (`businesses.credit_config`). */
export function CreditSettingsForm({
  biz,
  config,
  currencies,
  meters,
  limitUnits,
  version,
}: {
  biz: string;
  config: ResolvedCreditConfig;
  currencies: string[];
  meters: ScopeMeter[];
  limitUnits: LimitUnit[];
  version?: number;
}) {
  const formRef = React.useRef<HTMLFormElement>(null);
  const [v, set] = useFormModel(seedOf(config, currencies, limitUnits), formRef);
  const setIn = (
    key: "overdraft" | "topMin" | "topMax" | "grantMax" | "grantAlert" | "unitMax" | "unitAlert",
    cur: string,
    val: string,
  ) => set(key, { ...v[key], [cur]: val });

  // The example follows the typed limit; an empty or invalid one falls back to the saved value.
  const typedShare = Number(v.share);
  const shareExample =
    v.share !== "" && typedShare > 0 && typedShare <= 100
      ? typedShare
      : config.in_flight_share_bps / 100;

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

  const unitGrantLine = (u: LimitUnit) => {
    const l = config.unit_grant_limits[u.key];
    if (!l || (l.max_units == null && l.alert_above_units == null)) return "No limit, no alert";
    const info = { ...u, currency: "" };
    return [
      l.max_units != null ? `up to ${fmtUnits(l.max_units, info)} for each grant` : "no limit",
      l.alert_above_units != null ? `alert above ${fmtUnits(l.alert_above_units, info)}` : null,
    ]
      .filter(Boolean)
      .join(", ");
  };

  // The retry fields as typed, with the saved values: the action sends only what changed.
  const retryDraft: TopupRetryDraft = {
    enabled: v.retries,
    hours: v.retryRows.map((r) => r.value),
    ...v.retryMethod,
  };
  const nextRetryKey = React.useRef(v.retryRows.length);
  // The preview follows the valid rows; no row = the default schedule.
  const typedHours = v.retryRows
    .map((r) => Number(r.value))
    .filter((n) => Number.isInteger(n) && n >= 1);
  const previewHours = v.retryRows.length ? typedHours : [...TOPUP_RETRY_DEFAULT_HOURS];
  const addRetryRow = () => {
    if (v.retryRows.length >= TOPUP_RETRY_MAX_DELAYS) return;
    const last = Number(v.retryRows[v.retryRows.length - 1]?.value);
    set("retryRows", [
      ...v.retryRows,
      {
        key: nextRetryKey.current++,
        value: Number.isInteger(last) && last >= 1 ? String(last) : "",
      },
    ]);
  };

  const unitDrafts: UnitLimitDraft[] = limitUnits.map((u) => ({
    unit: u.key,
    plural: u.plural,
    decimals: u.decimals,
    max: v.unitMax[u.key] ?? "",
    alert: v.unitAlert[u.key] ?? "",
  }));

  return (
    <ActionForm action={saveCreditConfigAction} formRef={formRef}>
      <input type="hidden" name="biz" value={biz} />
      {version != null ? <input type="hidden" name="expected_version" value={version} /> : null}
      <input
        type="hidden"
        name="config"
        value={JSON.stringify(toConfig(v, currencies, config, limitUnits))}
      />
      {limitUnits.length > 0 ? (
        <input type="hidden" name="unit_limits" value={JSON.stringify(unitDrafts)} />
      ) : null}
      <input
        type="hidden"
        name="topup_retries"
        value={JSON.stringify({
          draft: retryDraft,
          saved: {
            auto_topup_retries: config.auto_topup_retries,
            auto_topup_retry_hours: config.auto_topup_retry_hours,
            auto_topup_retry_hours_by_method: config.auto_topup_retry_hours_by_method,
          },
        })}
      />
      <SettingsColumns
        summary={
          <SettingsSummary
            items={[
              {
                label: "When credit is used up",
                value: config.blocking_enabled
                  ? `Blocking is on. Default: ${POLICY_LABEL[config.on_exhausted_default].toLowerCase()}`
                  : "Blocking is off. We bill usage on the invoice, except in units with no money value and no overage price",
              },
              {
                label: "Hold time",
                value: `${config.hold_default_seconds} seconds`,
              },
              {
                label: "Open holds",
                value: `Up to ${config.in_flight_share_bps / 100}% of the balance, ${
                  config.in_flight_applies === "always"
                    ? "on every hold"
                    : "only while another hold is open"
                }`,
              },
              {
                label: "Default tax treatment",
                value: config.default_tax_treatment
                  ? TAX_TREATMENT_LABEL[config.default_tax_treatment]
                  : "Not set. Each paid credit pack sets its own",
              },
              { label: "Credit scope", value: scopeLine(config, meters) },
              {
                label: "Automatic top-up in the portal",
                value: config.portal_auto_topup
                  ? "Customers can enable and disable it"
                  : "Only you can enable and disable it",
              },
              {
                label: "Declined automatic top-ups",
                value: retrySummary(config),
              },
              {
                label: "Hard decline of an automatic top-up",
                value:
                  config.auto_topup_on_hard_decline === "keep_enabled"
                    ? "The automatic top-up stays on"
                    : "The automatic top-up turns off",
              },
              { label: "Usage in a free trial", value: TRIAL_USAGE_LINE[config.trial_usage] },
              {
                label: "Customers with no subscription",
                value: `${NO_SUB_USAGE_LINE[config.no_subscription_usage]}. ${NO_SUB_OVERDRAFT_LINE[config.no_subscription_overdraft]}. Invoiced after ${plural(config.no_subscription_invoice_after_days, "day")}`,
              },
              { label: "Capture above the hold", value: CAPTURE_LINE[config.capture_over_hold] },
              {
                label: "Credit given back",
                value:
                  config.restore_expiry_months === "never"
                    ? "Does not expire"
                    : `Expires after ${plural(config.restore_expiry_months, "month")}`,
              },
              {
                label: "Late usage events",
                value:
                  config.late_event_grace_hours === 0
                    ? "Paid from the balance when they arrive"
                    : `Up to ${plural(config.late_event_grace_hours, "hour")} late: paid from the credit that was live at the time of the event`,
              },
              ...currencies.map((cur) => ({
                label: `Credit purchases in ${cur}`,
                value: topUpLine(cur),
              })),
              ...currencies.map((cur) => ({
                label: `Free credit in ${cur}`,
                value: grantLine(cur),
              })),
              ...limitUnits.map((u) => ({
                label: `Free credit in ${u.plural}`,
                value: unitGrantLine(u),
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
            help="When this is off, we bill usage on the invoice. Usage in a unit with no money value is different: past its balance and overdraft limit, we refuse it unless an overage price applies."
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
                placement="end"
                control={
                  <div className="flex flex-col gap-3">
                    {currencies.map((cur) => (
                      <AmountInput
                        key={cur}
                        id={`overdraft_${cur}`}
                        label={cur}
                        currency={cur}
                        value={v.overdraft[cur] ?? ""}
                        onChange={(x) => setIn("overdraft", cur, x)}
                      />
                    ))}
                  </div>
                }
              />
            </>
          ) : null}
        </SettingsCard>

        <SettingsCard title="Holds">
          <SettingRow
            label="Hold time"
            htmlFor="hold_default_seconds"
            help="How long a hold stays open when the app does not set a time. From 1 to 86,400 seconds."
            errorFor="hold_default_seconds"
            placement="end"
            control={
              <span className="inline-flex items-center gap-2">
                <Input
                  id="hold_default_seconds"
                  type="number"
                  min={1}
                  max={86400}
                  value={v.hold}
                  onChange={(e) => set("hold", e.target.value)}
                  className="w-30 tabular-nums"
                />
                <span className="text-sm text-muted-foreground">seconds</span>
              </span>
            }
          />
          <SettingRow
            label="Open holds limit"
            htmlFor="in_flight_share"
            help="The percentage of the balance that open holds can use at one time. If the policy blocks usage, we refuse a new hold that goes above it."
            errorFor="in_flight_share_bps"
            placement="end"
            control={
              <span className="inline-flex items-center gap-2">
                <Input
                  id="in_flight_share"
                  type="number"
                  min={0.01}
                  max={100}
                  step={0.01}
                  value={v.share}
                  onChange={(e) => set("share", e.target.value)}
                  className="w-30 tabular-nums"
                />
                <span className="text-sm text-muted-foreground">% of the balance</span>
              </span>
            }
          />
          <SettingRow
            label="Holds under the limit"
            errorFor="in_flight_applies"
            control={
              <RadioField
                value={v.shareApplies}
                onValueChange={(x) => set("shareApplies", x as InFlightApplies)}
                ariaLabel="Holds under the limit"
                options={[
                  {
                    value: "always",
                    label: "On every hold",
                    hint: `The limit applies even when no other hold is open. For example, with a ${shareExample}% limit and a balance of 10 credits, one action can hold up to ${(shareExample / 10).toLocaleString("en", { maximumFractionDigits: 3 })} credits.`,
                  },
                  {
                    value: "other_holds_open",
                    label: "Only while another hold is open",
                    hint: "One action at a time can use the full balance. Actions that run at the same time stay inside the limit.",
                  },
                ]}
              />
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
            placement="end"
            control={
              <div className="flex flex-col gap-3">
                {currencies.map((cur) => (
                  <div key={cur} className="flex flex-col gap-1">
                    <div className="flex gap-3">
                      <AmountInput
                        id={`top_up_min_${cur}`}
                        label={`Minimum (${cur})`}
                        currency={cur}
                        value={v.topMin[cur] ?? ""}
                        onChange={(x) => setIn("topMin", cur, x)}
                      />
                      <AmountInput
                        id={`top_up_max_${cur}`}
                        label={`Maximum (${cur})`}
                        currency={cur}
                        value={v.topMax[cur] ?? ""}
                        onChange={(x) => setIn("topMax", cur, x)}
                      />
                    </div>
                    <TopUpError cur={cur} />
                  </div>
                ))}
              </div>
            }
          />
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

        <SettingsCard title="Declined automatic top-ups">
          <SettingRow
            label="Try a declined automatic top-up again"
            placement="end"
            help="For each automatic top-up, in money and in credit units. When this is off, the first declined payment disables the automatic top-up."
            control={
              <SwitchField
                checked={v.retries}
                onCheckedChange={(c) => set("retries", c)}
                ariaLabel="Try a declined automatic top-up again"
              />
            }
          />
          <SettingRow
            label="Retry schedule"
            help={`The time that we wait before each new try, in hours after the previous try. You can set ${TOPUP_RETRY_MAX_DELAYS} delays, and they can add up to ${TOPUP_RETRY_WINDOW_HOURS} hours. Remove each delay to use the default: ${hoursList(TOPUP_RETRY_DEFAULT_HOURS)}.`}
            errorFor={RETRY_HOURS_KEY}
            consequence={retryConsequence(v.retries, previewHours).join(" ")}
            control={
              <div className="flex flex-col gap-2">
                {v.retryRows.length === 0 ? (
                  <p className="m-0 rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
                    No schedule of your own. The default applies:{" "}
                    {hoursList(TOPUP_RETRY_DEFAULT_HOURS)}.
                  </p>
                ) : (
                  <>
                    {/* One header for the columns: a label on every row would repeat it. */}
                    <div className="flex gap-2.5 text-xs text-muted-foreground" aria-hidden="true">
                      <span className="w-12 shrink-0">Try</span>
                      <span>Hours after the previous try</span>
                    </div>
                    <ol id={RETRY_HOURS_KEY} className="m-0 flex list-none flex-col gap-2 p-0">
                      {v.retryRows.map((row, i) => (
                        <li key={row.key} className="flex items-center gap-2.5">
                          <span className="w-12 shrink-0 text-sm text-muted-foreground tabular-nums">
                            {i + 2}
                          </span>
                          <RetryHoursInput
                            index={i}
                            disabled={!v.retries}
                            value={row.value}
                            onChange={(x) =>
                              set(
                                "retryRows",
                                v.retryRows.map((r) =>
                                  r.key === row.key ? { ...r, value: x } : r,
                                ),
                              )
                            }
                          />
                          <span className="text-sm whitespace-nowrap text-muted-foreground">
                            hours
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            disabled={!v.retries}
                            onClick={() =>
                              set(
                                "retryRows",
                                v.retryRows.filter((r) => r.key !== row.key),
                              )
                            }
                            aria-label={`Remove try ${i + 2}`}
                          >
                            <X className="size-4" aria-hidden />
                          </Button>
                        </li>
                      ))}
                    </ol>
                  </>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-ml-2 self-start text-primary"
                  onClick={addRetryRow}
                  disabled={!v.retries || v.retryRows.length >= TOPUP_RETRY_MAX_DELAYS}
                >
                  <Plus className="size-4" aria-hidden /> Add delay
                  {v.retryRows.length >= TOPUP_RETRY_MAX_DELAYS
                    ? ` (maximum ${TOPUP_RETRY_MAX_DELAYS})`
                    : ""}
                </Button>
              </div>
            }
          />
          <SettingRow
            label="By payment method"
            help="Hours after the previous try, with commas between them. Leave a field blank to use the schedule above. Other payment methods (UPI, wallets, PayPal) use the schedule above."
            control={
              <div className="flex flex-col gap-3">
                {TOPUP_RETRY_METHODS.map((m) => (
                  <MethodRetryRow
                    key={m}
                    method={m}
                    disabled={!v.retries}
                    value={v.retryMethod[m]}
                    onChange={(x) => set("retryMethod", { ...v.retryMethod, [m]: x })}
                    blank={
                      config.auto_topup_retry_hours_by_method[m]?.length === 0
                        ? "Set through the API: no new try. Enter delays to change this."
                        : `Blank: ${previewHours.length ? hoursList(previewHours) : "the schedule above"}`
                    }
                  />
                ))}
              </div>
            }
          />
          <SettingRow
            label="After a hard decline"
            help="A hard decline is a payment that a new try cannot change, for example a stolen card or a closed account. We never try that payment again."
            errorFor="auto_topup_on_hard_decline"
            control={
              <RadioField
                value={v.hardDecline}
                onValueChange={(x) => set("hardDecline", x as AutoTopupOnHardDecline)}
                ariaLabel="After a hard decline"
                options={[
                  {
                    value: "disable",
                    label: "Disable the automatic top-up",
                    hint: "The customer or you must enable it again.",
                  },
                  {
                    value: "keep_enabled",
                    label: "Keep the automatic top-up enabled",
                    hint: "A top-up at a threshold runs again after the balance goes above the threshold and then below it. A scheduled top-up runs at its next time.",
                  },
                ]}
              />
            }
          />
        </SettingsCard>

        <SettingsCard title="Credit with no money value">
          <SettingRow
            label="Automatic top-up in the portal"
            placement="end"
            help="For each automatic top-up of a credit unit with no money value that you set up for a customer. When this is on, the customer sees it in the portal and can enable or disable it. The customer cannot change what it buys. When this is off, only you can enable or disable it."
            control={
              <SwitchField
                checked={v.portalTopup}
                onCheckedChange={(c) => set("portalTopup", c)}
                ariaLabel="Automatic top-up in the portal"
              />
            }
          />
          <SettingRow
            label="Late usage events"
            htmlFor="late_event_grace_hours"
            help="An event can arrive after the time it records. If it arrives within this time, credit that was live at its time pays for it, also when that credit expired since. After this time, or at 0, the balance on arrival pays for it. Credit that expires is booked out only after this time."
            errorFor="late_event_grace_hours"
            placement="end"
            control={
              <span className="inline-flex items-center gap-2">
                <HoursInput value={v.lateHours} onChange={(x) => set("lateHours", x)} />
                <span className="text-sm text-muted-foreground">hours</span>
              </span>
            }
          />
          <SettingRow
            label="Usage in a free trial"
            help="When a subscription in a free trial uses more than its credit. The balance goes below zero only in a unit with an overage price, so that we can invoice the rest if the trial ends with no payment."
            errorFor="trial_usage"
            control={
              <RadioField
                value={v.trialUsage}
                onValueChange={(x) => set("trialUsage", x as TrialUsage)}
                ariaLabel="Usage in a free trial"
                options={[
                  {
                    value: "refuse",
                    label: TRIAL_USAGE_LINE.refuse,
                    hint: "A free trial never costs money.",
                  },
                  {
                    value: "overdraft_only",
                    label: TRIAL_USAGE_LINE.overdraft_only,
                    hint: "The balance can go below zero to the overdraft limit. We do not bill usage in money. The plan credit after the trial pays it back first.",
                  },
                  {
                    value: "as_paid",
                    label: TRIAL_USAGE_LINE.as_paid,
                    hint: "The same rules as a paid subscription. Usage that we bill in money goes on the first invoice after the trial.",
                  },
                ]}
              />
            }
          />
          <SettingRow
            label="Customers with no subscription"
            help="For example, a customer who only bought credit packs, when they use more than their credit."
            errorFor="no_subscription_usage"
            control={
              <RadioField
                value={v.noSubUsage}
                onValueChange={(x) => set("noSubUsage", x as NoSubscriptionUsage)}
                ariaLabel="Customers with no subscription"
                options={[
                  {
                    value: "block",
                    label: NO_SUB_USAGE_LINE.block,
                    hint: "Only the overdraft limit lets usage continue.",
                  },
                  {
                    value: "as_subscriber",
                    label: NO_SUB_USAGE_LINE.as_subscriber,
                    hint: "Block or bill, as for a customer with a subscription. We bill at the unit's overage price, on a separate invoice.",
                  },
                ]}
              />
            }
          />
          <SettingRow
            label="Overdraft with no subscription"
            help="When a customer with no subscription can go below zero, to the overdraft limit. Only in a unit with an overage price."
            errorFor="no_subscription_overdraft"
            control={
              <RadioField
                value={v.noSubOverdraft}
                onValueChange={(x) => set("noSubOverdraft", x as NoSubscriptionOverdraft)}
                ariaLabel="Overdraft with no subscription"
                options={[
                  {
                    value: "needs_payment_method",
                    label: NO_SUB_OVERDRAFT_LINE.needs_payment_method,
                    hint: "And only while no invoice for their usage is unpaid or written off.",
                  },
                  {
                    value: "always",
                    label: NO_SUB_OVERDRAFT_LINE.always,
                    hint: "With no payment method, the invoice stays unpaid until the customer pays it.",
                  },
                  {
                    value: "never",
                    label: NO_SUB_OVERDRAFT_LINE.never,
                    hint: "The balance never goes below zero.",
                  },
                ]}
              />
            }
          />
          <SettingRow
            label="Invoice for usage with no subscription"
            htmlFor="no_subscription_invoice_after_days"
            help={`We put the usage that credit did not pay on one invoice when its oldest part is this old. From ${NO_SUBSCRIPTION_INVOICE_DAYS.min} to ${NO_SUBSCRIPTION_INVOICE_DAYS.max} days. We invoice at once when you archive the customer or their last subscription is cancelled.`}
            errorFor="no_subscription_invoice_after_days"
            placement="end"
            control={
              <span className="inline-flex items-center gap-2">
                <WholeInput
                  id="no_subscription_invoice_after_days"
                  value={v.noSubDays}
                  onChange={(x) => set("noSubDays", x)}
                />
                <span className="text-sm text-muted-foreground">days</span>
              </span>
            }
          />
          <SettingRow
            label="Capture above the hold"
            help="When the usage of a captured hold is more than the hold. We never refuse the capture: the work is done."
            errorFor="capture_over_hold"
            control={
              <RadioField
                value={v.captureOverHold}
                onValueChange={(x) => set("captureOverHold", x as CaptureOverHold)}
                ariaLabel="Capture above the hold"
                options={[
                  {
                    value: "debt",
                    label: CAPTURE_LINE.debt,
                    hint: "We take it from the balance, bill it or take it below zero, as for other usage.",
                  },
                  {
                    value: "cap_at_hold",
                    label: CAPTURE_LINE.cap_at_hold,
                    hint: "We charge only the held credit. We record the rest on the usage event and in the audit log, and we do not bill it.",
                  },
                ]}
              />
            }
          />
        </SettingsCard>

        <SettingsCard title="Credit given back">
          <SettingRow
            label="Expiry of credit given back"
            help="When we give credit back after a usage event is voided, or after a credit note, and the original credit has expired. Credit that is still live keeps its own expiry."
            errorFor="restore_expiry_months"
            control={
              <div className="flex flex-col gap-3">
                <RadioField
                  value={v.restoreMode}
                  onValueChange={(x) => set("restoreMode", x as Values["restoreMode"])}
                  ariaLabel="Expiry of credit given back"
                  options={[
                    {
                      value: "months",
                      label: "Expires after a number of months",
                      hint: `From ${RESTORE_EXPIRY_MONTHS.min} to ${RESTORE_EXPIRY_MONTHS.max} months after we give it back.`,
                    },
                    { value: "never", label: "Does not expire" },
                  ]}
                />
                <span className="inline-flex items-center gap-2">
                  <WholeInput
                    id="restore_expiry_months"
                    ariaLabel="Months before credit given back expires"
                    disabled={v.restoreMode === "never"}
                    value={v.restoreMonths}
                    onChange={(x) => set("restoreMonths", x)}
                  />
                  <span className="text-sm text-muted-foreground">months</span>
                </span>
              </div>
            }
          />
        </SettingsCard>

        <SettingsCard title="Free credit">
          <SettingRow
            label="Limits on free credit"
            help="For each grant of free credit that you give: a wallet top-up of type granted, promotional credit and a promotional credit grant. We refuse a grant above the maximum. Above the alert amount, we record the grant in the audit log and send a team alert, if that alert is on. Leave a field empty for no limit."
            placement="end"
            control={
              <div className="flex flex-col gap-3">
                {currencies.map((cur) => (
                  <div key={cur} className="flex gap-3">
                    <AmountInput
                      id={`grant_max_${cur}`}
                      label={`Maximum (${cur})`}
                      currency={cur}
                      value={v.grantMax[cur] ?? ""}
                      onChange={(x) => setIn("grantMax", cur, x)}
                    />
                    <AmountInput
                      id={`grant_alert_${cur}`}
                      label={`Alert above (${cur})`}
                      currency={cur}
                      value={v.grantAlert[cur] ?? ""}
                      onChange={(x) => setIn("grantAlert", cur, x)}
                    />
                  </div>
                ))}
              </div>
            }
          />
          {/* One pair for each active unit with no money value; none = no row. */}
          {limitUnits.length > 0 ? (
            <SettingRow
              label="Limits on free credit with no money value"
              help="For each promotional credit grant in a unit with no money value. The money limits above do not apply. We refuse a grant above the maximum. Above the alert amount, we record the grant in the audit log and send the Large free credit team alert, if it is on. Leave a field empty for no limit."
              placement="below"
              control={
                // One grid, so every unit's fields line up and a long unit name wraps.
                <div className="grid grid-cols-[minmax(0,1fr)_5rem_5rem] items-center gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_7.5rem_7.5rem]">
                  <span className="text-xs text-muted-foreground">Unit</span>
                  <span className="text-xs text-muted-foreground">Maximum</span>
                  <span className="text-xs text-muted-foreground">Alert above</span>
                  {limitUnits.map((u) => (
                    <React.Fragment key={u.key}>
                      <span className="min-w-0 text-sm wrap-anywhere">{u.plural}</span>
                      <UnitInput
                        id={unitLimitErrorKey(u.key, "max")}
                        ariaLabel={`Maximum for ${u.plural}`}
                        decimals={u.decimals}
                        value={v.unitMax[u.key] ?? ""}
                        onChange={(x) => setIn("unitMax", u.key, x)}
                      />
                      <UnitInput
                        id={unitLimitErrorKey(u.key, "alert")}
                        ariaLabel={`Alert above for ${u.plural}`}
                        decimals={u.decimals}
                        value={v.unitAlert[u.key] ?? ""}
                        onChange={(x) => setIn("unitAlert", u.key, x)}
                      />
                      <UnitLimitError unit={u.key} />
                    </React.Fragment>
                  ))}
                </div>
              }
            />
          ) : null}
        </SettingsCard>
      </SettingsColumns>
    </ActionForm>
  );
}

/** Hours, 120px; the row's error marks it. */
function HoursInput({ value, onChange }: { value: string; onChange: (h: string) => void }) {
  const error = useFieldError("late_event_grace_hours");
  return (
    <Input
      id="late_event_grace_hours"
      type="number"
      inputMode="decimal"
      step="any"
      aria-invalid={error ? true : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-30 tabular-nums"
    />
  );
}

/** A whole number, 120px; the row's error (its id) marks it. */
function WholeInput({
  id,
  ariaLabel,
  disabled,
  value,
  onChange,
}: {
  id: string;
  ariaLabel?: string;
  disabled?: boolean;
  value: string;
  onChange: (x: string) => void;
}) {
  const error = useFieldError(id);
  return (
    <Input
      id={id}
      aria-label={ariaLabel}
      type="number"
      inputMode="numeric"
      // No `min` or `max`: a wrong value gets our message from the save, under the field.
      step="any"
      disabled={disabled}
      aria-invalid={error ? true : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-30 tabular-nums"
    />
  );
}

const TRIAL_USAGE_LINE: Record<TrialUsage, string> = {
  refuse: "Refuse the usage",
  overdraft_only: "Use the overdraft limit only",
  as_paid: "Same as a paid subscription",
};
const NO_SUB_USAGE_LINE: Record<NoSubscriptionUsage, string> = {
  block: "Refuse the usage",
  as_subscriber: "Same as a subscriber",
};
const NO_SUB_OVERDRAFT_LINE: Record<NoSubscriptionOverdraft, string> = {
  needs_payment_method: "Overdraft only with a saved payment method",
  always: "Overdraft always",
  never: "No overdraft",
};
const CAPTURE_LINE: Record<CaptureOverHold, string> = {
  debt: "Charge all the usage",
  cap_at_hold: "Charge only the held credit",
};

function TopUpError({ cur }: { cur: string }) {
  return <FieldsError name={`top_up_${cur}`} />;
}

/** The message under a pair of fields. */
function FieldsError({ name }: { name: string }) {
  const error = useFieldError(name);
  // `w-0 min-w-full`: the message wraps at the inputs' width instead of widening the column.
  return error ? <p className="m-0 w-0 min-w-full text-xs text-destructive">{error}</p> : null;
}

/** The message of one unit's row, under its two fields. */
function UnitLimitError({ unit }: { unit: string }) {
  const max = useFieldError(unitLimitErrorKey(unit, "max"));
  const alert = useFieldError(unitLimitErrorKey(unit, "alert"));
  const error = max ?? alert;
  return error ? <p className="col-span-3 m-0 text-xs text-destructive">{error}</p> : null;
}

/** An amount in whole units of a credit unit: 80px, 120px from `sm`. The grid names the column. */
function UnitInput({
  id,
  ariaLabel,
  decimals,
  value,
  onChange,
}: {
  id: string;
  ariaLabel: string;
  decimals: number;
  value: string;
  onChange: (units: string) => void;
}) {
  // The id is the error key of this field, so the input at fault is the one marked.
  const error = useFieldError(id);
  return (
    <Input
      id={id}
      aria-label={ariaLabel}
      aria-invalid={error ? true : undefined}
      type="number"
      inputMode={decimals === 0 ? "numeric" : "decimal"}
      // No `min` and a free `step`: a negative or too precise value gets our message from the
      // save, under the field, not the browser's own bubble.
      step="any"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full tabular-nums"
    />
  );
}

/** An amount in major units, 120px; the currency is in the label so the box holds the digits. */
function AmountInput({
  id,
  label,
  currency,
  value,
  onChange,
}: {
  id: string;
  label: string;
  currency: string;
  value: string;
  onChange: (major: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs whitespace-nowrap text-muted-foreground">
      {label}
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={0}
        step={majorStep(currency)}
        placeholder={
          currencyExponent(currency) === 0 ? "0" : (0).toFixed(currencyExponent(currency))
        }
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-30 tabular-nums"
      />
    </label>
  );
}

/** One delay of the retry schedule: 80px; its own error key marks it. */
function RetryHoursInput({
  index,
  disabled,
  value,
  onChange,
}: {
  index: number;
  disabled: boolean;
  value: string;
  onChange: (h: string) => void;
}) {
  const error = useFieldError(retryRowKey(index));
  return (
    <Input
      id={retryRowKey(index)}
      type="number"
      inputMode="numeric"
      // No `min` or `max`: a wrong value gets our message from the save, under the list.
      step="any"
      disabled={disabled}
      aria-label={`Try ${index + 2}, hours after the previous try`}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${RETRY_HOURS_KEY}-error` : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-20 tabular-nums"
    />
  );
}

const METHOD_RETRY_LABEL: Record<TopupRetryMethod, { label: string; hint: string }> = {
  card: { label: "Cards", hint: `You can set ${TOPUP_RETRY_MAX_DELAYS} delays.` },
  bank_debit: {
    label: "Bank debits",
    hint: `ACH, SEPA, Bacs, BECS, PAD, e-mandate and NACH. You can set ${TOPUP_RETRY_MAX_DELAYS} delays.`,
  },
};

/** The schedule of one kind of payment method: a list of hours, blank = the business schedule. */
function MethodRetryRow({
  method,
  disabled,
  value,
  onChange,
  blank,
}: {
  method: TopupRetryMethod;
  disabled: boolean;
  value: string;
  onChange: (text: string) => void;
  /** What a blank field means, with the schedule it resolves to. */
  blank: string;
}) {
  const id = retryMethodKey(method);
  const error = useFieldError(id);
  const { label, hint } = METHOD_RETRY_LABEL[method];
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
      <div className="flex min-w-0 flex-col gap-0.5">
        <label
          htmlFor={id}
          className={cn("text-sm font-medium", disabled && "text-muted-foreground")}
        >
          {label}
        </label>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>
      <div className="flex shrink-0 flex-col gap-1">
        <div className="flex items-center gap-2.5">
          <Input
            id={id}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : `${id}_blank`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-full tabular-nums sm:w-72"
          />
          <span className="text-sm whitespace-nowrap text-muted-foreground">hours</span>
        </div>
        {parseHoursText(value).length === 0 ? (
          <span id={`${id}_blank`} className="text-xs text-muted-foreground">
            {blank}
          </span>
        ) : null}
        <SettingError name={id} />
      </div>
    </div>
  );
}

/** The saved retry rule, as a summary line. */
function retrySummary(c: ResolvedCreditConfig): string {
  if (!c.auto_topup_retries) return "1 try. A declined payment disables the automatic top-up";
  const own = TOPUP_RETRY_METHODS.flatMap((m) => {
    const list = c.auto_topup_retry_hours_by_method[m];
    if (!list) return [];
    const name = TOPUP_RETRY_METHOD_NAME[m];
    const line = retryScheduleLine(list).replace(": ", ", ");
    return [`${name.charAt(0).toUpperCase()}${name.slice(1)}: ${line}`];
  });
  return [retryScheduleLine(c.auto_topup_retry_hours), ...own].join(". ");
}

/** The saved scope, as a summary line. */
function scopeLine(c: ResolvedCreditConfig, meters: ScopeMeter[]): string {
  const s = c.credit_scope;
  if (!s) return "Every usage line";
  if (s.kind === "prices") return `${s.prices.length} prices, set through the API`;
  const names = s.meters.map((k) => meters.find((m) => m.key === k)?.name ?? k);
  return `Only ${names.join(", ")}`;
}

// Plain module (no "use client"): server pages and the customer form both read it.
import type { Business } from "@/lib/api";
import { money } from "@/lib/format";
import type { DunningDefaults } from "./dunning-form";
import {
  DEFAULT_CADENCE,
  DEFAULT_RETRY_DAYS,
  HELD_GRACE_DAYS,
  finalActionsLine,
  listDays,
} from "./copy";

type Cfg = Business["dunning_config"];

/**
 * What `resolveDunningConfig` resolves for this config, so a form previews the real
 * outcome. `cfg` is a business's config or a policy's; the two business-wide keys always
 * come from `business`. When a default moves in the engine, move it here too.
 */
export function dunningDefaults(
  cfg: Cfg,
  business: Pick<
    Business,
    "dunning_config" | "dunning_retry_days" | "default_currency" | "currencies"
  >,
  opts?: { legacyDays?: boolean },
): DunningDefaults {
  const biz = business.dunning_config;
  return {
    enabled: cfg?.enabled ?? true,
    // Only an explicit 'smart' is smart.
    mode: cfg?.mode === "smart" ? "smart" : "fixed",
    days:
      cfg?.retries?.map((r) => r.after_days) ??
      (opts?.legacyDays ? (business.dunning_retry_days ?? []) : []),
    periodDays: cfg?.dunning_period_days ?? null,
    finalInvoice: cfg?.final_action?.invoice ?? "not_paid",
    finalSubscription: cfg?.final_action?.subscription ?? "cancel",
    methodDays: {
      card: cfg?.retries_by_method?.card?.map((r) => r.after_days) ?? [],
      bank_debit: cfg?.retries_by_method?.bank_debit?.map((r) => r.after_days) ?? [],
      offline: cfg?.retries_by_method?.offline?.map((r) => r.after_days) ?? [],
    },
    cadence: {
      transientHours: cfg?.adaptive_cadence?.transient_hours ?? DEFAULT_CADENCE.transientHours,
      genericDays: cfg?.adaptive_cadence?.generic_days ?? DEFAULT_CADENCE.genericDays,
      fundsGapDays:
        cfg?.adaptive_cadence?.funds_gap_days === undefined
          ? DEFAULT_CADENCE.fundsGapDays
          : cfg.adaptive_cadence.funds_gap_days,
      fundsMaxRetries: cfg?.adaptive_cadence?.funds_max_retries ?? DEFAULT_CADENCE.fundsMaxRetries,
    },
    skipHardFailures: cfg?.skip_retries_for_hard_failures ?? true,
    parkHardDeclines: cfg?.park_hard_declines === true,
    adaptiveTiming: cfg?.adaptive_timing === true,
    dunTrialFuture: cfg?.dun_trial_and_future_subscriptions ?? true,
    dunOneTime: cfg?.dun_one_time_invoices ?? false,
    dunOffline: cfg?.dun_offline_invoices ?? true,
    collectOnPm: biz?.collect_on_payment_method_update ?? true,
    cancelNoPmAtRenewal: biz?.no_payment_method_at_renewal === "cancel",
    minimumAmounts: cfg?.minimum_amounts ?? {},
    // A stored minimum stays editable even if its currency was removed from the business.
    currencies: [
      ...new Set(
        [
          business.default_currency,
          ...(business.currencies ?? []),
          ...Object.keys(cfg?.minimum_amounts ?? {}),
        ]
          .filter((c): c is string => !!c)
          .map((c) => c.toUpperCase()),
      ),
    ],
  };
}

/** One sentence: what this dunning config does. */
export function dunningLine(d: DunningDefaults): string {
  if (!d.enabled) return "Off. We mark a failed charge not paid and retry nothing.";
  const days = d.days.length ? d.days : DEFAULT_RETRY_DAYS;
  const mode = d.mode === "smart" ? "Smart" : "Fixed";
  const period = d.periodDays == null ? "" : `, ${d.periodDays}-day dunning period`;
  return `${mode}. Retries on days ${listDays(days)} after the due date${period}. Then ${finalActionsLine(d.finalInvoice, d.finalSubscription)}.`;
}

/** "Your setup": the SAVED configuration, in sentences. */
export function dunningSummaryItems(d: DunningDefaults) {
  if (!d.enabled)
    return [{ label: "Dunning", value: "Off. We mark a failed charge not paid and retry nothing" }];
  const days = d.days.length ? d.days : DEFAULT_RETRY_DAYS;
  const smart = d.mode === "smart";
  return [
    {
      label: "Decline handling",
      value: smart
        ? `Smart · hard declines ${d.parkHardDeclines ? "held for the customer" : "retried"}`
        : `Fixed · hard declines ${d.skipHardFailures ? "skip retries" : "retried"}`,
    },
    {
      label: "Retries",
      value: `Days ${days.join(", ")} after due date${d.days.length ? "" : " (default)"}`,
    },
    smart && {
      label: "Retry timing",
      value: d.adaptiveTiming ? "Adaptive, by decline reason" : "Fixed days (adaptive off)",
    },
    {
      label: "Dunning period",
      value:
        d.periodDays == null
          ? "None. Ends after the last retry"
          : `${d.periodDays} days after the due date`,
    },
    (smart || (d.skipHardFailures && d.parkHardDeclines)) && {
      label: "Held invoices",
      value: `Close after ${d.periodDays ?? HELD_GRACE_DAYS} days`,
    },
    !smart &&
      d.skipHardFailures && {
        label: "Hard declines",
        value:
          d.periodDays == null ? "Final actions at once" : `Final actions on day ${d.periodDays}`,
      },
    !!(
      d.methodDays.card.length ||
      d.methodDays.bank_debit.length ||
      d.methodDays.offline.length
    ) && {
      label: "By payment method",
      value: (
        [
          ["Cards", d.methodDays.card],
          ["Bank debits", d.methodDays.bank_debit],
          ["Offline", d.methodDays.offline],
        ] as const
      )
        .filter(([, days]) => days.length)
        .map(([k, days]) => `${k}: days ${days.join(", ")}`)
        .join(" · "),
    },
    {
      label: "Minimum amount due",
      value: Object.keys(d.minimumAmounts).length
        ? Object.entries(d.minimumAmounts)
            .map(([c, minor]) => money(minor, c))
            .join(", ")
        : "None",
    },
    {
      label: "Then",
      value: capitalise(
        finalActionsLine(d.finalInvoice, d.finalSubscription)
          .replace("the invoice is ", "invoice ")
          .replace(" and the subscription is ", " · subscription "),
      ),
    },
  ];
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The customer form's policy picker: the live policies, plus the customer's own one when
 * it was archived after it was assigned (so the select can show what is stored).
 */
export function customerDunningOptions(
  policies: Array<{ id: string; name: string; archived: boolean }>,
  business: Parameters<typeof dunningDefaults>[1],
  current: string | null | undefined,
) {
  return {
    policies: policies
      .filter((p) => !p.archived || p.id === current)
      .map((p) => ({ id: p.id, name: p.name, archived: p.archived })),
    businessLine: dunningLine(
      dunningDefaults(business.dunning_config, business, { legacyDays: true }),
    ),
  };
}

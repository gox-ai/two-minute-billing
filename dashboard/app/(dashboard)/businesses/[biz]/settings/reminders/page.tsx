import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import type { ReminderConfig, ReminderLeadDays } from "@/lib/api";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import {
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { saveReminderTimingAction } from "../actions";
import { LeadDaysRow } from "./lead-days-row";
import { TimingRow } from "./timing-row";
import { leadDaysLine } from "./copy";

export const dynamic = "force-dynamic";

/** The engine defaults (`DEFAULT_REMINDER_LEAD_DAYS`), shown in each row's help. */
const DEFAULTS: ReminderConfig = {
  trial_ending: [3],
  renewal: [5],
  renewal_yearly: [30],
  cancellation: [5],
  card_expiring: "expiry_month",
  payment_due: [],
  pause: [],
  resume: [],
};

/** Kinds that can be off, or (card expiry) sent in the expiry month instead. */
const TIMING_ROWS: Array<{
  kind: "payment_due" | "pause" | "resume" | "card_expiring";
  label: string;
  help: string;
  target: string;
  otherLabel: string;
  otherConsequence: string;
  /** The recommended lead days, put in the field when it is empty. */
  suggested: number[];
}> = [
  {
    kind: "payment_due",
    label: "Payment due",
    help: "Days before the due date of an invoice that we do not collect automatically. We do not send it for invoices that we charge to a payment method.",
    target: "the due date",
    otherLabel: "Off",
    otherConsequence: "We send no reminder before the due date.",
    suggested: [3],
  },
  {
    kind: "pause",
    label: "Scheduled pause",
    help: "Days before a scheduled pause starts.",
    target: "the pause",
    otherLabel: "Off",
    otherConsequence: "We send no reminder before a scheduled pause.",
    suggested: [7],
  },
  {
    kind: "resume",
    label: "Scheduled resume",
    help: "Days before a paused subscription resumes on its scheduled date.",
    target: "the resume",
    otherLabel: "Off",
    otherConsequence: "We send no reminder before a scheduled resume.",
    suggested: [7],
  },
  {
    kind: "card_expiring",
    label: "Card expiring",
    help: "When we tell the customer that a stored card expires. A card stops working after the last day of its expiry month.",
    target: "the card expires",
    otherLabel: "In the month the card expires",
    otherConsequence: "We send one email when the card enters its expiry month.",
    suggested: [30, 7],
  },
];

const timingLine = (v: number[] | "expiry_month") =>
  v === "expiry_month" ? "In the expiry month" : v.length ? `${leadDaysLine(v)} before` : "Off";

const ROWS: Array<{
  kind: keyof ReminderLeadDays;
  label: string;
  help: string;
  target: string;
}> = [
  {
    kind: "trial_ending",
    label: "Trial ending",
    help: "Days before a free trial ends.",
    target: "the trial ends",
  },
  {
    kind: "renewal",
    label: "Renewal",
    help: "Days before a subscription renews, for billing periods shorter than one year.",
    target: "the renewal",
  },
  {
    kind: "renewal_yearly",
    label: "Yearly renewal",
    help: "Days before a subscription renews, for billing periods of one year or more.",
    target: "the renewal",
  },
  {
    kind: "cancellation",
    label: "Scheduled cancellation",
    help: "Days before a scheduled cancellation occurs.",
    target: "the cancellation",
  },
];

/**
 * Settings → Subscription reminders: `reminder_config` (0376). The API returns every kind
 * resolved, so each field shows the lists that are in use now.
 */
export default async function ReminderSettings({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");

  let b;
  try {
    b = await getBusiness(biz);
  } catch (e) {
    return (
      <ErrorState description={<span className="font-mono text-xs">{(e as Error).message}</span>} />
    );
  }
  if (!b)
    return <ErrorState title="Not found" description={`We could not find the business ${biz}.`} />;

  const cfg = b.reminder_config ?? DEFAULTS;

  return (
    <SettingsPage
      title="Subscription reminders"
      crumbs={[
        { label: "Settings", href: `/businesses/${biz}/settings` },
        { label: "Subscription reminders" },
      ]}
      description="When we send reminders before a trial ends, a subscription renews, pauses or resumes, a scheduled cancellation occurs, an invoice is due, or a card expires. Each reminder goes to your webhooks as an event. If the email for it is enabled, it also goes to the customer."
    >
      <ActionForm action={saveReminderTimingAction}>
        <input type="hidden" name="biz" value={biz} />
        {b.resource_version != null ? (
          <input type="hidden" name="expected_version" value={b.resource_version} />
        ) : null}
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                ...ROWS.map((r) => ({
                  label: r.label,
                  value: `${leadDaysLine(cfg[r.kind])} before`,
                })),
                ...TIMING_ROWS.map((r) => ({
                  label: r.label,
                  value: timingLine(cfg[r.kind] ?? DEFAULTS[r.kind]),
                })),
              ]}
            />
          }
          save={{
            note: "A new list applies to dates that are still ahead. We do not send a reminder for a day that is already in the past.",
          }}
        >
          <SettingsCard title="Days before" meta="Up to 5 values from 1 to 90, with commas">
            <div className="divide-y">
              {ROWS.map((r) => (
                <LeadDaysRow
                  key={r.kind}
                  kind={r.kind}
                  label={r.label}
                  help={`${r.help} Default: ${(DEFAULTS[r.kind] as number[]).join(", ")}.`}
                  target={r.target}
                  value={cfg[r.kind]}
                />
              ))}
            </div>
            <p className="m-0 border-t px-5 py-3 text-sm text-muted-foreground">
              The mandate rules set the time of the pre-debit notice, so you cannot change it here.
              To select which reminder emails we send, go to{" "}
              <Link
                href={`/businesses/${biz}/settings/emails`}
                className="text-primary hover:underline"
              >
                Email notifications
              </Link>
              .
            </p>
          </SettingsCard>
          <SettingsCard
            title="Payments, pauses and cards"
            meta="Up to 3 values from 1 to 90, with commas"
          >
            <div className="divide-y">
              {TIMING_ROWS.map((r) => {
                const v = cfg[r.kind] ?? DEFAULTS[r.kind];
                const days = Array.isArray(v) && v.length ? v : null;
                return (
                  <TimingRow
                    key={r.kind}
                    kind={r.kind}
                    label={r.label}
                    help={r.help}
                    target={r.target}
                    otherLabel={r.otherLabel}
                    otherConsequence={r.otherConsequence}
                    value={days}
                    suggested={r.suggested}
                  />
                );
              })}
            </div>
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}

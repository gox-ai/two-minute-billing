import { requirePermission } from "@/lib/session";
import Link from "next/link";
import { getBusiness, listTeamAlertRecipients } from "@/lib/api/business-settings";
import type { TeamAlertRecipient, TeamAlertsConfig } from "@/lib/api";
import { Chip } from "@/components/patterns/chip";
import { ActionButton } from "@/components/action-button";
import { fmtDateTime, money } from "@/lib/format";
import { majorStep, toMajorInput } from "@/lib/money";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SwitchField } from "@/components/ui/switch";
import {
  SettingRow,
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { resendTeamAlertConfirmationAction, saveTeamAlertsAction } from "./actions";

export const dynamic = "force-dynamic";

/** What the engine resolves an unset config to (`DEFAULT_TEAM_ALERTS`): everything off. */
const OFF: TeamAlertsConfig = {
  recipients: [],
  overdue: { enabled: false, thresholds: {} },
  webhook_failures: { enabled: false },
  daily_digest: { enabled: false },
  large_grants: { enabled: false },
};

const STATE: Record<TeamAlertRecipient["state"], { label: string; tone: "green" | "tan" }> = {
  member: { label: "Team member", tone: "green" },
  confirmed: { label: "Confirmed", tone: "green" },
  pending: { label: "Waiting for confirmation", tone: "tan" },
};

/** Settings → Team alerts (`team_alerts_config`, 0489). The API returns the resolved value. */
export default async function TeamAlertsSettings({ params }: { params: Promise<{ biz: string }> }) {
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

  const cfg = b.team_alerts_config ?? OFF;
  const thresholds = cfg.overdue.thresholds;
  const currencies = [
    ...new Set(
      [b.default_currency, ...(b.currencies ?? []), ...Object.keys(thresholds)]
        .filter((c): c is string => !!c)
        .map((c) => c.toUpperCase()),
    ),
  ];
  const set = currencies.filter((c) => thresholds[c] != null);
  const tz = b.timezone ?? "UTC";
  const onOff = (v: boolean) => (v ? "On" : "Off");
  // A failed read leaves the list empty; the addresses still show in the form.
  const states = cfg.recipients.length
    ? await listTeamAlertRecipients(biz)
        .then((r) => r.data)
        .catch(() => [])
    : [];

  return (
    <SettingsPage
      title="Team alerts"
      crumbs={[
        { label: "Settings", href: `/businesses/${biz}/settings` },
        { label: "Team alerts" },
      ]}
      description="Email your team when a large invoice is overdue or webhooks fail, and send a daily summary. Your customers do not get these emails."
    >
      <ActionForm action={saveTeamAlertsAction}>
        <input type="hidden" name="biz" value={biz} />
        {b.resource_version != null ? (
          <input type="hidden" name="expected_version" value={b.resource_version} />
        ) : null}
        <input type="hidden" name="currencies" value={currencies.join(",")} />
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                {
                  label: "Recipients",
                  value: cfg.recipients.length ? cfg.recipients.join(", ") : "None",
                },
                {
                  label: "Overdue invoices",
                  value:
                    cfg.overdue.enabled && set.length
                      ? set.map((c) => `${money(thresholds[c]!, c)} or more`).join(", ")
                      : "Off",
                },
                { label: "Failed webhooks", value: onOff(cfg.webhook_failures.enabled) },
                { label: "Daily summary", value: onOff(cfg.daily_digest.enabled) },
                { label: "Large free credit", value: onOff(cfg.large_grants?.enabled === true) },
              ]}
            />
          }
          save={{ note: "Alerts start from the next hour." }}
        >
          <SettingsCard title="Recipients" meta="Up to 10 email addresses">
            <SettingRow
              label="Send alerts to"
              htmlFor="recipients"
              errorFor="recipients"
              help="One email address on each line. The first address is in To, the others are in CC. The email comes from the platform sender, not from your billing email settings. An address that is not a team member gets a confirmation email, and gets alerts only after it is confirmed."
              control={
                <Textarea
                  id="recipients"
                  name="recipients"
                  rows={3}
                  className="w-full sm:max-w-md"
                  defaultValue={cfg.recipients.join("\n")}
                  placeholder="finance@example.com"
                />
              }
            />
          </SettingsCard>

          <SettingsCard title="Overdue invoices" meta="Checked every hour">
            <SettingRow
              label="Alert when a large invoice is overdue"
              placement="end"
              errorFor="overdue_enabled"
              help="We send one email for each hour in which an unpaid invoice passes its due date and the amount due is at or above the limit for its currency."
              control={
                <SwitchField
                  name="overdue_enabled"
                  defaultChecked={cfg.overdue.enabled}
                  ariaLabel="Alert when a large invoice is overdue"
                />
              }
            />
            {currencies.length === 0 ? (
              <p className="m-0 px-5 py-4 text-sm text-muted-foreground">
                Set a default currency on the business profile first.
              </p>
            ) : (
              currencies.map((c) => (
                <SettingRow
                  key={c}
                  label={`Limit in ${c}`}
                  htmlFor={`threshold_${c}`}
                  errorFor={`threshold_${c}`}
                  help="Leave empty to send no alert for invoices in this currency."
                  control={
                    <Input
                      id={`threshold_${c}`}
                      name={`threshold_${c}`}
                      type="number"
                      min="0"
                      step={majorStep(c)}
                      inputMode="decimal"
                      className="w-full sm:w-56"
                      defaultValue={toMajorInput(thresholds[c] ?? null, c)}
                      placeholder="No alert"
                    />
                  }
                />
              ))
            )}
          </SettingsCard>

          <SettingsCard title="Webhooks" meta="Checked every hour">
            <SettingRow
              label="Alert when webhooks fail"
              placement="end"
              help="We send one email for each hour in which we stopped trying to deliver a webhook. It shows each endpoint and its last response."
              control={
                <SwitchField
                  name="webhook_failures_enabled"
                  defaultChecked={cfg.webhook_failures.enabled}
                  ariaLabel="Alert when webhooks fail"
                />
              }
            />
          </SettingsCard>

          <SettingsCard title="Daily summary" meta={`At 08:00, ${tz}`}>
            <SettingRow
              label="Send a daily summary"
              placement="end"
              help="Each morning: payments collected and payments that failed on the day before, invoices in dunning now, and cards that expire this month or next month."
              control={
                <SwitchField
                  name="daily_digest_enabled"
                  defaultChecked={cfg.daily_digest.enabled}
                  ariaLabel="Send a daily summary"
                />
              }
            />
          </SettingsCard>

          <SettingsCard title="Large free credit" meta="At the time of the grant">
            <SettingRow
              label="Alert when someone gives a large amount of free credit"
              placement="end"
              help={
                <>
                  A wallet top-up of type granted, promotional credit or a promotional credit grant
                  above the alert amount in{" "}
                  <Link
                    href={`/businesses/${biz}/settings/credits`}
                    className="text-primary hover:underline"
                  >
                    Settings &gt; Credits
                  </Link>
                  . The audit log records each one, also when this alert is off.
                </>
              }
              control={
                <SwitchField
                  name="large_grants_enabled"
                  defaultChecked={cfg.large_grants?.enabled === true}
                  ariaLabel="Alert when someone gives a large amount of free credit"
                />
              }
            />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>

      {states.length ? (
        <SettingsCard title="Recipient status" meta="Saved addresses">
          {states.map((r) => (
            <SettingRow
              key={r.email}
              label={r.email}
              help={
                r.state === "pending"
                  ? r.last_sent_at
                    ? `We sent a confirmation email on ${fmtDateTime(r.last_sent_at, tz)}. This address gets no alerts until it is confirmed.`
                    : "We did not send a confirmation email yet. This address gets no alerts until it is confirmed."
                  : r.state === "member"
                    ? "A member of your team. Gets alerts without confirmation."
                    : "Confirmed by email. Gets alerts."
              }
              control={
                <div className="flex items-center gap-3">
                  <Chip tone={STATE[r.state].tone}>{STATE[r.state].label}</Chip>
                  {r.state === "pending" ? (
                    <ActionButton
                      resultAction={resendTeamAlertConfirmationAction}
                      fields={{ biz, email: r.email }}
                      label="Send again"
                      size="sm"
                    />
                  ) : null}
                </div>
              }
            />
          ))}
        </SettingsCard>
      ) : null}
    </SettingsPage>
  );
}

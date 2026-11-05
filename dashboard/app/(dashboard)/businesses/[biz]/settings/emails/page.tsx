import Link from "next/link";
import { AtSign, Ban, Send, Server } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  SettingRow,
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
  type AttentionItem,
} from "@/components/settings/settings-layout";
import { SettingSwitch } from "@/components/settings/setting-switch";
import {
  getSmtpSettings,
  getSesSettings,
  listEmailTemplates,
  getEmailActivity,
  getEmailReminderSchedule,
  listSuppressions,
} from "@/lib/api/emails";
import {
  AUTOMATIC_EMAIL_TYPES,
  EMAIL_GROUPS,
  EMAIL_GROUP_DESCRIPTIONS,
  emailTypesInGroup,
} from "@/lib/email-types";
import { saveEmailsAction } from "../actions";
import { listDays } from "../dunning/copy";
import { LinkTargetRow } from "./link-target-row";

export const dynamic = "force-dynamic";

/**
 * Settings → Email notifications. The master switch and per-type mutes of
 * `email_config` (gated in src/modules/emails/config.ts → isEmailTypeEnabled).
 * Sender, delivery and suppressions are their own pages; the setup card links to each
 * with its CURRENT resolved value.
 */
export default async function EmailSettings({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  await requirePermission("emails:view", "admin");

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

  const [smtp, ses, templates, activity, reminders, suppressions] = await Promise.all([
    getSmtpSettings(biz),
    getSesSettings(biz),
    listEmailTemplates(biz),
    getEmailActivity(biz),
    getEmailReminderSchedule(biz),
    listSuppressions(biz),
  ]);
  const customizedTypes = new Set(templates.data.filter((t) => t.customized).map((t) => t.type));
  // Lead times are this business's own (Subscription reminders), except the pre-debit notice.
  const leadDays = new Map(
    reminders.data.map((r) => [
      r.type,
      {
        text:
          r.lead_days.length === 0
            ? r.expiry_month
              ? "Sends in the month that the card expires."
              : "Timing is off, so we send none."
            : r.yearly_lead_days
              ? `Sends ${listDays(r.lead_days)} days before (${listDays(r.yearly_lead_days)} on yearly plans).`
              : `Sends ${listDays(r.lead_days)} days before.`,
        configurable: r.configurable,
      },
    ]),
  );

  const cfg = b.email_config;
  // Opt-in: no config means nothing is sent (resolveEmailConfig).
  const enabled = cfg?.enabled ?? false;
  const types = cfg?.types ?? {};
  // Mirrors isEmailTypeEnabled: Invoice to pay follows Invoice issued until set on its own.
  // …and Checkout reminder is opt-in: off until switched on.
  const isOn = (key: string) =>
    key === "checkout_reminder" || key === "spend_limit_reached"
      ? types[key] === true
      : key === "invoice_to_pay" && types[key] === undefined
        ? types.invoice_issued !== false
        : types[key] !== false;
  const autoOn = AUTOMATIC_EMAIL_TYPES.filter((t) => isOn(t.key)).length;

  // `delivered` and `not_delivered` are never summed: the console sink marks rows sent.
  const activityHint = (() => {
    if (activity.bounced > 0) return `${activity.bounced} bounced: address refused`;
    if (activity.delivered > 0 && activity.not_delivered === 0)
      return `${activity.delivered} delivered in ${activity.window_days} days`;
    if (activity.not_delivered > 0) return `${activity.not_delivered} sent but not delivered`;
    if (activity.pending > 0) return `${activity.pending} queued`;
    if (activity.failed > 0) return `${activity.failed} failed`;
    return `Nothing sent in ${activity.window_days} days`;
  })();

  const setup = [
    {
      icon: AtSign,
      title: "Sender",
      href: `/businesses/${biz}/settings/emails/sender`,
      // The resolved identity: blank falls back to the deployment MAIL_FROM.
      hint: `${smtp.effective_from_name} <${smtp.effective_from_address}>`,
      note: smtp.from_source === "platform" ? "Platform default" : "Set for this business",
    },
    {
      icon: Server,
      title: "Delivery",
      href: `/businesses/${biz}/settings/emails/delivery`,
      // Neither transport chosen is an unfinished setup, not a platform-relay choice.
      hint:
        ses.enabled && ses.region
          ? `Amazon SES · ${ses.region}`
          : smtp.enabled && smtp.host
            ? `SMTP · ${smtp.host}`
            : "No delivery method chosen",
      note:
        ses.enabled || smtp.enabled
          ? smtp.delivers
            ? "Delivering"
            : "Delivers nothing"
          : "Configure SMTP or SES",
    },
    {
      icon: Send,
      title: "Activity",
      href: `/businesses/${biz}/emails`,
      hint: activityHint,
      note: `${customizedTypes.size} of ${templates.data.length} templates customized`,
    },
    {
      icon: Ban,
      title: "Suppressed addresses",
      href: `/businesses/${biz}/settings/emails/suppressions`,
      // Only SES with a configuration set reports bounces, so otherwise empty proves nothing.
      hint:
        suppressions.data.length === 0
          ? "None"
          : `We will not email ${suppressions.data.length} address${suppressions.data.length === 1 ? "" : "es"}`,
      note:
        suppressions.data.length > 0
          ? "After a bounce or spam complaint"
          : ses.enabled && ses.configuration_set
            ? "No bounces"
            : "Only Amazon SES reports bounces",
    },
  ];

  // Sending can be on with every type ticked and still land in a log file.
  const attention: AttentionItem[] =
    enabled && !smtp.delivers
      ? [
          {
            key: "not-delivered",
            tone: "attention",
            title: "Billing emails are not delivered",
            detail:
              smtp.effective_transport === "unconfigured"
                ? "This deployment selects an email transport that is not configured, so every send fails."
                : "We write messages to the console dev sink and mark them sent. Nothing reaches your customers.",
            actions: (
              <Link
                href={`/businesses/${biz}/settings/emails/delivery`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Configure delivery
              </Link>
            ),
          },
        ]
      : [];

  return (
    <SettingsPage
      title="Email notifications"
      crumbs={[
        { label: "Settings", href: `/businesses/${biz}/settings` },
        { label: "Email notifications" },
      ]}
      description="Billing emails that we send to your customers. They are disabled until you enable them, so an imported business does not send unexpected email to its customers."
      attention={attention}
    >
      <SettingsCard title="Setup" meta="Who email comes from, what sends it, and what happened">
        <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-4">
          {setup.map(({ icon: Icon, title, href, hint, note }) => (
            <Link
              key={title}
              href={href}
              // The gap paints the hairlines; min-w-0 lets the hint truncate.
              className="group min-w-0 bg-card px-5 py-4 transition-colors hover:bg-muted"
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Icon className="size-4 text-muted-foreground" aria-hidden />
                {title}
              </span>
              <span className="mt-2 block truncate text-sm text-foreground/90" title={hint}>
                {hint}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{note}</span>
            </Link>
          ))}
        </div>
      </SettingsCard>

      <ActionForm action={saveEmailsAction}>
        <input type="hidden" name="biz" value={biz} />
        {b.resource_version != null ? (
          <input type="hidden" name="expected_version" value={b.resource_version} />
        ) : null}
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                {
                  label: "Sending",
                  value: enabled ? "On" : "Off. We send no automatic email",
                },
                {
                  label: "Automatic emails",
                  value: `${autoOn} of ${AUTOMATIC_EMAIL_TYPES.length} enabled`,
                },
                {
                  label: "Templates",
                  value: `${customizedTypes.size} of ${templates.data.length} customized`,
                },
              ]}
            />
          }
          save={{
            note: "Saves sending, the per-email switches, the links and the receipt attachment. Sender and delivery save on their own pages.",
          }}
        >
          <SettingsCard title="Sending" meta={enabled ? "On" : "Off"}>
            <SettingRow
              label="Send billing emails to customers"
              help="Starts or stops every automatic billing email at once. The per-email choices below stay as they are."
              placement="end"
              control={
                <SettingSwitch
                  name="emails_enabled"
                  label="Send billing emails to customers"
                  defaultChecked={enabled}
                />
              }
              consequence="While this is off, we send no automatic email, whatever the switches below say. Emails that you send yourself still go out."
            />
          </SettingsCard>

          {EMAIL_GROUPS.map((group) => {
            const rows = emailTypesInGroup(group);
            if (rows.length === 0) return null;
            // Ad-hoc and system sends never consult the switches, so they get none.
            const isAdhoc = rows.every((t) => t.adhoc || t.system);
            const onCount = rows.filter((t) => isOn(t.key)).length;
            const customised = rows.filter((t) => customizedTypes.has(t.key)).length;
            return (
              <SettingsCard
                key={group}
                title={group}
                meta={
                  <>
                    {isAdhoc ? `${rows.length} sent on demand` : `${onCount} of ${rows.length} on`}
                    {!isAdhoc && !enabled ? (
                      <span className="text-warning"> · sending is off, so we send none</span>
                    ) : null}
                    {customised > 0 ? ` · ${customised} customized` : null}
                  </>
                }
              >
                <p className="m-0 px-5 py-3 text-sm text-muted-foreground">
                  {EMAIL_GROUP_DESCRIPTIONS[group]}
                </p>
                <div className={cn("divide-y", !enabled && !isAdhoc && "opacity-60")}>
                  {rows.map((t) => (
                    <SettingRow
                      key={t.key}
                      placement="end"
                      label={
                        <span className="flex flex-wrap items-center gap-2">
                          {t.label}
                          {customizedTypes.has(t.key) ? (
                            <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                              Customised
                            </span>
                          ) : null}
                        </span>
                      }
                      help={
                        <>
                          {t.description}{" "}
                          {leadDays.has(t.key) ? (
                            <span className="text-foreground/70">{leadDays.get(t.key)!.text} </span>
                          ) : null}
                          {leadDays.get(t.key)?.configurable ? (
                            <>
                              <Link
                                href={`/businesses/${biz}/settings/reminders`}
                                className="text-primary hover:underline"
                              >
                                Change timing
                              </Link>
                              {" · "}
                            </>
                          ) : null}
                          <Link
                            href={`/businesses/${biz}/settings/emails/templates/${t.key}`}
                            className="text-primary hover:underline"
                          >
                            Edit template
                          </Link>
                        </>
                      }
                      control={
                        t.adhoc || t.system ? (
                          <span className="text-xs text-muted-foreground">On demand</span>
                        ) : (
                          <>
                            {/* Tells the action this type rendered, so unchecked = muted. */}
                            <input type="hidden" name="email_type_present" value={t.key} />
                            <SettingSwitch
                              name={`email_type_${t.key}`}
                              label={t.label}
                              defaultChecked={isOn(t.key)}
                            />
                          </>
                        )
                      }
                    />
                  ))}
                </div>
              </SettingsCard>
            );
          })}

          <SettingsCard title="Links" meta="Saved with the switches above">
            <LinkTargetRow
              target={
                cfg?.linkTarget === "merchant_url" && cfg.merchantUrl ? "merchant_url" : "portal"
              }
              url={cfg?.merchantUrl ?? null}
            />
          </SettingsCard>

          <SettingsCard title="Receipts" meta="Saved with the switches above">
            <SettingRow
              label="Attach the receipt PDF to the payment confirmation email"
              help={
                <>
                  We attach the numbered receipt of the payment.{" "}
                  <Link
                    href={`/businesses/${biz}/settings/receipts`}
                    className="text-primary hover:underline"
                  >
                    Receipt numbering
                  </Link>
                </>
              }
              placement="end"
              control={
                <>
                  {/* Tells the action the switch rendered, so unchecked = off. */}
                  <input type="hidden" name="attach_receipt_pdf_present" value="1" />
                  <SettingSwitch
                    name="attach_receipt_pdf"
                    label="Attach the receipt PDF to the payment confirmation email"
                    defaultChecked={cfg?.attachReceiptPdf === true}
                  />
                </>
              }
              consequence={
                cfg?.attachReceiptPdf === true
                  ? "On: the payment confirmation email has the receipt PDF. A receipt that has no number yet is not attached."
                  : "Off: the payment confirmation email has no attachment. The customer can download receipts in the portal."
              }
            />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}

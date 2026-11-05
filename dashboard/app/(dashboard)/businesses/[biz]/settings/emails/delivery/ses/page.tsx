import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { Input } from "@/components/ui/input";
import { CheckboxField } from "@/components/ui/checkbox";
import { StatusChip } from "@/components/patterns/chip";
import {
  SettingRow,
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { SettingSwitch } from "@/components/settings/setting-switch";
import { SettingError } from "@/components/settings/setting-error";
import { getSmtpSettings, getSesSettings } from "@/lib/api/emails";
import { saveSesTransportAction } from "../../../actions";
import { activeTransport, deliveryCrumbs } from "../transport-status";

export const dynamic = "force-dynamic";

/**
 * Settings → Email notifications → Delivery → Amazon SES. Same `activate` shapes as
 * the SMTP page. The IAM action is `ses:SendRawEmail` (we send raw MIME for
 * attachments); a key with only `ses:SendEmail` is refused. The secret is write-only.
 */
export default async function SesTransportSettings({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
  const { biz } = await params;
  await requirePermission("emails:view", "admin");

  let smtp, ses;
  try {
    [smtp, ses] = await Promise.all([getSmtpSettings(biz), getSesSettings(biz)]);
  } catch (e) {
    return (
      <ErrorState description={<span className="font-mono text-xs">{(e as Error).message}</span>} />
    );
  }

  const active = activeTransport(smtp, ses);
  const isActive = active === "ses";
  const testHref = `/businesses/${biz}/settings/emails/delivery/test`;

  return (
    <SettingsPage
      title="Amazon SES"
      crumbs={[...deliveryCrumbs(biz), { label: "Amazon SES" }]}
      description="Your own AWS account, through the SES API."
    >
      <ActionForm action={saveSesTransportAction}>
        <input type="hidden" name="biz" value={biz} />
        <SettingsColumns
          summary={
            <>
              <SettingsSummary
                items={[
                  {
                    label: "Status",
                    value: isActive ? (
                      <span className="inline-flex items-center gap-2">
                        <StatusChip status="active" /> Sends this business&rsquo;s email
                      </span>
                    ) : active === "smtp" ? (
                      "Not in use. An SMTP server sends the email"
                    ) : (
                      "Not in use"
                    ),
                  },
                  { label: "Region", value: ses.region || "Not set" },
                  { label: "Access key ID", value: ses.access_key_id || "Not set" },
                  {
                    label: "Secret access key",
                    value: ses.secret_configured ? "Saved" : "Not saved",
                  },
                  {
                    label: "Bounce reports",
                    value: ses.configuration_set
                      ? `Via configuration set ${ses.configuration_set}`
                      : "None. No configuration set",
                  },
                ]}
              />
              <div className="border-t px-5 py-4">
                <p className="m-0 text-sm leading-normal text-muted-foreground">
                  A new AWS account stays in the <strong>sandbox</strong> until you request
                  production access. The sandbox lets you send only to addresses that you have
                  verified. There is no connection test for SES. A real send is the only true check.
                </p>
                <Link
                  href={testHref}
                  className="mt-2 inline-block text-sm text-primary hover:underline"
                >
                  Send a test email
                </Link>
              </div>
            </>
          }
          save={{ label: "Save changes" }}
        >
          <SettingsCard
            title="Credentials"
            meta="The secret is write-only. We store it encrypted and never show it here or return it through the API"
          >
            <div className="grid gap-x-4 sm:grid-cols-2">
              <SettingRow
                label="Region"
                htmlFor="ses_region"
                errorFor="ses_region"
                help="The region where you verified your sending identity. A domain that you verify in one region does not exist in another."
                control={
                  <Input
                    id="ses_region"
                    name="ses_region"
                    defaultValue={ses.region ?? ""}
                    maxLength={64}
                    placeholder="us-east-1"
                  />
                }
              />
              <SettingRow
                label="Access key ID"
                htmlFor="ses_access_key_id"
                errorFor="ses_access_key_id"
                help="This identifies the key but does not authenticate it. It shows which key is installed."
                control={
                  <Input
                    id="ses_access_key_id"
                    name="ses_access_key_id"
                    defaultValue={ses.access_key_id ?? ""}
                    maxLength={128}
                    autoComplete="off"
                    placeholder="AKIA…"
                  />
                }
              />
            </div>
            <SettingRow
              label="Secret access key"
              htmlFor="ses_secret"
              help={
                !ses.secret_configured
                  ? "Required to send through SES. AWS shows it only once, when you create the key."
                  : isActive
                    ? "A secret key is saved. Leave blank to keep it, or paste a new one to rotate it. You cannot remove it while SES sends the email."
                    : "A secret key is saved. Leave blank to keep it."
              }
              control={
                <Input
                  id="ses_secret"
                  name="ses_secret"
                  type="password"
                  defaultValue=""
                  maxLength={1024}
                  autoComplete="new-password"
                  placeholder={ses.secret_configured ? "••••••••" : ""}
                />
              }
            />
            {ses.secret_configured && !isActive ? (
              <div className="flex flex-col gap-2 px-5 py-4">
                <CheckboxField
                  name="ses_clear_secret"
                  label="Remove the saved secret access key"
                  hint="This clears the stored credential. You cannot select SES again without a secret key."
                />
                <SettingError name="ses_clear_secret" />
              </div>
            ) : null}
            <SettingRow
              label="IAM permission"
              help={
                <>
                  Scope the key to <span className="font-mono text-xs">ses:SendRawEmail</span>. Your
                  From domain must be a verified identity in the region above.
                </>
              }
              more={
                <>
                  <span className="font-mono text-xs">ses:SendEmail</span> alone is not enough. We
                  send raw MIME so that we can attach invoices. AWS authorises raw content under the
                  separate <span className="font-mono text-xs">SendRawEmail</span> action. No other
                  permission is necessary.
                </>
              }
            />
          </SettingsCard>

          <SettingsCard title="Bounces and complaints">
            <SettingRow
              label="Configuration set"
              htmlFor="ses_configuration_set"
              help="Optional. This is the only way for this business to know that a message bounced."
              control={
                <Input
                  id="ses_configuration_set"
                  name="ses_configuration_set"
                  defaultValue={ses.configuration_set ?? ""}
                  maxLength={255}
                  placeholder="Optional"
                />
              }
              more={
                <>
                  A configuration set routes bounce and complaint notifications to SNS, which this
                  platform turns into{" "}
                  <Link
                    href={`/businesses/${biz}/settings/emails/suppressions`}
                    className="text-primary hover:underline"
                  >
                    suppressions
                  </Link>
                  . Without a configuration set, email still sends. But you do not know what
                  happened to it.
                </>
              }
            />
          </SettingsCard>

          <SettingsCard title="Use for billing email">
            {isActive ? (
              <SettingRow
                label="Send this business's billing email through Amazon SES"
                help="A business always has one transport, so you cannot disable it here."
                consequence={
                  <>
                    Amazon SES sends this business&rsquo;s email. To change the transport, enable
                    the{" "}
                    <Link
                      href={`/businesses/${biz}/settings/emails/delivery/smtp`}
                      className="text-primary hover:underline"
                    >
                      SMTP server
                    </Link>
                    .
                  </>
                }
              >
                <input type="hidden" name="activate" value="on" />
              </SettingRow>
            ) : (
              <SettingRow
                label="Send this business's billing email through Amazon SES"
                placement="end"
                help={
                  active === "smtp"
                    ? "If you save with this enabled, we change from SMTP. We keep the SMTP settings, so you can change back without entering them again."
                    : "Keep this enabled unless you have not finished the account configuration."
                }
                control={
                  <SettingSwitch
                    name="activate"
                    label="Send this business's billing email through Amazon SES"
                    defaultChecked={active === null}
                  />
                }
                consequence={
                  active === "smtp" ? (
                    <>
                      An SMTP server sends the email now. We store what you save here, but we do not
                      use it until you change the transport.{" "}
                      <Link
                        href={`/businesses/${biz}/settings/emails/delivery/smtp`}
                        className="text-primary hover:underline"
                      >
                        SMTP settings
                      </Link>
                    </>
                  ) : (
                    "No transport sends this business's email yet."
                  )
                }
              />
            )}
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}

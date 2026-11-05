import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
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
import { saveSmtpTransportAction } from "../../../actions";
import { activeTransport, deliveryCrumbs } from "../transport-status";

export const dynamic = "force-dynamic";

const ENCRYPTION_OPTIONS = [
  { value: "starttls", label: "STARTTLS — required upgrade (port 587)" },
  { value: "tls", label: "TLS — encrypted from connect (port 465)" },
  { value: "none", label: "None — unencrypted, local test sinks only" },
];

/**
 * Settings → Email notifications → Delivery → SMTP server. One form, one PATCH.
 *
 * `activate` has three shapes: SMTP live → hidden "on" (you leave SMTP by activating
 * SES); nothing live → a switch, on; SES live → a switch, off, because moving live
 * mail must be deliberate. The password is write-only and never rendered.
 */
export default async function SmtpTransportSettings({
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
  const isActive = active === "smtp";
  const testHref = `/businesses/${biz}/settings/emails/delivery/test`;

  return (
    <SettingsPage
      title="SMTP server"
      crumbs={[...deliveryCrumbs(biz), { label: "SMTP server" }]}
      description="A relay of your own. This can be any server that uses SMTP, from a hosted email service to your own postfix."
    >
      <ActionForm action={saveSmtpTransportAction}>
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
                    ) : active === "ses" ? (
                      "Not in use. Amazon SES sends the email"
                    ) : (
                      "Not in use"
                    ),
                  },
                  {
                    label: "Server",
                    value: smtp.host
                      ? `${smtp.host}${smtp.port ? `:${smtp.port}` : ""}`
                      : "Not set",
                  },
                  {
                    label: "Encryption",
                    value:
                      ENCRYPTION_OPTIONS.find((o) => o.value === smtp.encryption)?.label.split(
                        " — ",
                      )[0] ?? smtp.encryption,
                  },
                  { label: "Username", value: smtp.username || "None. Authenticates by IP" },
                  { label: "Password", value: smtp.password_configured ? "Saved" : "Not saved" },
                ]}
              />
              <div className="border-t px-5 py-4">
                <p className="m-0 text-sm leading-normal text-muted-foreground">
                  Most relays refuse a From address whose domain you have not verified with them.
                  Setting the sender does not make this relay accept it.
                </p>
                <Link
                  href={testHref}
                  className="mt-2 inline-block text-sm text-primary hover:underline"
                >
                  Test the connection
                </Link>
              </div>
            </>
          }
          save={{ label: "Save changes" }}
        >
          <SettingsCard title="Server">
            <div className="grid gap-x-4 sm:grid-cols-[minmax(0,1fr)_11rem]">
              <SettingRow
                label="Host"
                htmlFor="smtp_host"
                errorFor="smtp_host"
                help="The relay's hostname."
                control={
                  <Input
                    id="smtp_host"
                    name="smtp_host"
                    defaultValue={smtp.host ?? ""}
                    maxLength={255}
                    placeholder="smtp.example.com"
                  />
                }
              />
              <SettingRow
                label="Port"
                htmlFor="smtp_port"
                errorFor="smtp_port"
                help="465 for TLS, 587 for STARTTLS."
                control={
                  <Input
                    id="smtp_port"
                    name="smtp_port"
                    type="number"
                    min={1}
                    max={65535}
                    defaultValue={smtp.port ?? 587}
                    className="w-32"
                  />
                }
              />
            </div>
            <SettingRow
              label="Encryption"
              htmlFor="smtp_encryption"
              control={
                <SelectField
                  name="smtp_encryption"
                  defaultValue={smtp.encryption}
                  ariaLabel="Encryption"
                  options={ENCRYPTION_OPTIONS}
                />
              }
              help="Use what your relay documents."
              more="We require the STARTTLS upgrade, not only offer it. So a server that does not support it fails, and does not send unencrypted email."
            />
          </SettingsCard>

          <SettingsCard
            title="Authentication"
            meta="The password is write-only. We store it encrypted and never show it here or return it through the API"
          >
            <SettingRow
              label="Username"
              htmlFor="smtp_username"
              help="Leave blank for a relay that authenticates by IP."
              control={
                <Input
                  id="smtp_username"
                  name="smtp_username"
                  defaultValue={smtp.username ?? ""}
                  maxLength={255}
                  autoComplete="off"
                />
              }
            />
            <SettingRow
              label="Password"
              htmlFor="smtp_password"
              help={
                !smtp.password_configured
                  ? "Required to send through SMTP."
                  : isActive
                    ? "A password is saved. Leave blank to keep it, or type a new one to replace it. You cannot remove it while SMTP sends the email."
                    : "A password is saved. Leave blank to keep it."
              }
              control={
                // Never populated: blank means keep, clearing needs the box below.
                <Input
                  id="smtp_password"
                  name="smtp_password"
                  type="password"
                  defaultValue=""
                  maxLength={1024}
                  autoComplete="new-password"
                  placeholder={smtp.password_configured ? "••••••••" : ""}
                />
              }
            />
            {/* Not offered while live: the engine refuses a selected transport with no credential. */}
            {smtp.password_configured && !isActive ? (
              <div className="flex flex-col gap-2 px-5 py-4">
                <CheckboxField
                  name="smtp_clear_password"
                  label="Remove the saved password"
                  hint="This clears the stored credential. You cannot select SMTP again without a password."
                />
                <SettingError name="smtp_clear_password" />
              </div>
            ) : null}
          </SettingsCard>

          <SettingsCard title="Use for billing email">
            {isActive ? (
              <SettingRow
                label="Send this business's billing email through SMTP"
                help="A business always has one transport, so you cannot disable it here."
                consequence={
                  <>
                    SMTP sends this business&rsquo;s email. To change the transport, enable{" "}
                    <Link
                      href={`/businesses/${biz}/settings/emails/delivery/ses`}
                      className="text-primary hover:underline"
                    >
                      Amazon SES
                    </Link>
                    .
                  </>
                }
              >
                {/* Keeps SMTP selected across a save of the fields above. */}
                <input type="hidden" name="activate" value="on" />
              </SettingRow>
            ) : (
              <SettingRow
                label="Send this business's billing email through SMTP"
                placement="end"
                help={
                  active === "ses"
                    ? "If you save with this enabled, we change from Amazon SES. We keep the SES settings, so you can change back without entering them again."
                    : "Keep this enabled unless you have not finished the relay configuration."
                }
                control={
                  <SettingSwitch
                    name="activate"
                    label="Send this business's billing email through SMTP"
                    defaultChecked={active === null}
                  />
                }
                consequence={
                  active === "ses" ? (
                    <>
                      Amazon SES sends the email now. We store what you save here, but we do not use
                      it until you change the transport.{" "}
                      <Link
                        href={`/businesses/${biz}/settings/emails/delivery/ses`}
                        className="text-primary hover:underline"
                      >
                        Amazon SES settings
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

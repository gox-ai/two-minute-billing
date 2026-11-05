import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  SettingRow,
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { getSmtpSettings } from "@/lib/api/emails";
import { saveEmailSenderAction } from "../../actions";

export const dynamic = "force-dynamic";

/**
 * Settings → Email notifications → Sender. Who the mail claims to be FROM.
 * Every default is read off `effective_from_*`, the same `cfg.fromX || MAIL_FROM_X`
 * fallback the senders use (resolveSender). Reply-to has NO fallback.
 */
export default async function EmailSenderSettings({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
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

  const smtp = await getSmtpSettings(biz);
  const cfg = b.email_config;
  const count = (n: number) => (n === 0 ? "None" : `${n} address${n === 1 ? "" : "es"}`);

  return (
    <SettingsPage
      title="Sender"
      crumbs={[
        { label: "Settings", href: `/businesses/${biz}/settings` },
        { label: "Email notifications", href: `/businesses/${biz}/settings/emails` },
        { label: "Sender" },
      ]}
      description="The name and address your billing emails come from, and where replies go. You set the relay that sends the email under Delivery."
    >
      <ActionForm action={saveEmailSenderAction}>
        <input type="hidden" name="biz" value={biz} />
        {b.resource_version != null ? (
          <input type="hidden" name="expected_version" value={b.resource_version} />
        ) : null}
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                {
                  label: "From",
                  value: `${smtp.effective_from_name} <${smtp.effective_from_address}>`,
                },
                {
                  label: "Source",
                  value:
                    smtp.from_source === "platform" ? "Platform default" : "Set for this business",
                },
                {
                  label: "Replies go to",
                  value: cfg?.replyTo
                    ? cfg.replyTo
                    : `${smtp.effective_from_address} (no Reply-To header)`,
                },
                { label: "CC", value: count(cfg?.cc?.length ?? 0) },
                { label: "BCC", value: count(cfg?.bcc?.length ?? 0) },
                { label: "Subject prefix", value: cfg?.subjectPrefix || "None" },
                {
                  label: "Footer",
                  value: cfg?.footerNote ? "Your own" : "Default (“Thanks, … team”)",
                },
              ]}
            />
          }
          save={{
            label: "Save sender",
            note: "Applies to every billing email: automatic emails, emails that you send, and test emails.",
          }}
        >
          <SettingsCard
            title="Identity"
            meta="Who the email is from"
            actions={
              <Link
                href={`/businesses/${biz}/settings/emails/delivery`}
                className="text-primary hover:underline"
              >
                Delivery settings
              </Link>
            }
          >
            <SettingRow
              label="From name"
              htmlFor="from_name"
              errorFor="from_name"
              help={
                cfg?.fromName
                  ? "The display name recipients see."
                  : `The display name recipients see. If blank, we use the platform default, which is now “${smtp.effective_from_name}”.`
              }
              control={
                // The placeholder is the resolved default (MAIL_FROM_NAME), not the business name.
                <Input
                  id="from_name"
                  name="from_name"
                  defaultValue={cfg?.fromName ?? ""}
                  maxLength={120}
                  placeholder={smtp.effective_from_name}
                />
              }
            />
            <SettingRow
              label="From address"
              htmlFor="from_address"
              errorFor="from_address"
              help={
                cfg?.fromAddress
                  ? "The envelope From."
                  : `The envelope From. If blank, we use the platform default, which is now ${smtp.effective_from_address}.`
              }
              control={
                <Input
                  id="from_address"
                  name="from_address"
                  type="email"
                  defaultValue={cfg?.fromAddress ?? ""}
                  maxLength={320}
                  placeholder={smtp.effective_from_address}
                />
              }
              consequence="Your relay must accept this address as the sender. Most relays require you to verify the domain with them first. Setting the address here does not verify it."
            />
            <SettingRow
              label="Reply-to"
              htmlFor="reply_to"
              errorFor="reply_to"
              help="Where customer replies go."
              control={
                <Input
                  id="reply_to"
                  name="reply_to"
                  type="email"
                  defaultValue={cfg?.replyTo ?? ""}
                  maxLength={320}
                />
              }
              consequence={`If blank, we send no Reply-To header, so replies go to the From address (${smtp.effective_from_address}).`}
            />
          </SettingsCard>

          <SettingsCard
            title="Copies and subject"
            meta="Every billing email: automatic, sent by you and test"
          >
            <SettingRow
              label="CC"
              htmlFor="cc"
              errorFor="cc"
              help="Separate addresses with commas. Up to 10. The customer can see these addresses. Use BCC for an internal mailbox."
              control={
                <Input
                  id="cc"
                  name="cc"
                  defaultValue={(cfg?.cc ?? []).join(", ")}
                  placeholder="accounts@example.com"
                />
              }
            />
            <SettingRow
              label="BCC"
              htmlFor="bcc"
              errorFor="bcc"
              help="Separate addresses with commas. Up to 10. The customer cannot see these addresses. Use BCC for an archive mailbox."
              control={
                <Input
                  id="bcc"
                  name="bcc"
                  defaultValue={(cfg?.bcc ?? []).join(", ")}
                  placeholder="archive@example.com"
                />
              }
            />
            <SettingRow
              label="Subject prefix"
              htmlFor="subject_prefix"
              errorFor="subject_prefix"
              help="We add this to the start of every subject, for example “[Acme]”."
              control={
                <Input
                  id="subject_prefix"
                  name="subject_prefix"
                  defaultValue={cfg?.subjectPrefix ?? ""}
                  maxLength={40}
                  placeholder="[Acme]"
                  className="max-w-72"
                />
              }
              consequence={
                cfg?.subjectPrefix
                  ? `Every subject becomes “${cfg.subjectPrefix} …”. Test sends read “[Test] ${cfg.subjectPrefix} …”.`
                  : "If blank, we add nothing."
              }
            />
          </SettingsCard>

          <SettingsCard title="Footer" meta="Ends every email that has no footer of its own">
            {/* An email's own footer (template editor) overrides this; empty uses DEFAULT_FOOTER. */}
            <SettingRow
              label="Footer"
              htmlFor="footer_note"
              errorFor="footer_note"
              help="You can use {{businessName}} and {{customerName}}. Leave empty to use the placeholder text."
              control={
                <Textarea
                  id="footer_note"
                  name="footer_note"
                  defaultValue={cfg?.footerNote ?? ""}
                  maxLength={1000}
                  rows={3}
                  placeholder={"Thanks,\n{{businessName}} team"}
                />
              }
            />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}

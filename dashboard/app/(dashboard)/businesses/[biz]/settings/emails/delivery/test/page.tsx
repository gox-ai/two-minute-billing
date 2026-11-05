import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { buttonVariants } from "@/components/ui/button";
import {
  SettingRow,
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  type AttentionItem,
} from "@/components/settings/settings-layout";
import { getSmtpSettings, getSesSettings } from "@/lib/api/emails";
import { EMAIL_TYPES } from "@/lib/email-types";
import { testSmtpConnectionAction, sendTestEmailAction } from "../../../actions";
import { activeTransport, deliveryCrumbs, TRANSPORT_LABEL } from "../transport-status";

export const dynamic = "force-dynamic";

/**
 * Settings → Email notifications → Delivery → Test delivery. Two independent forms.
 * There is no SES connection test: an account probe needs a permission a send-scoped
 * key lacks, so it would fail good credentials. A real send is the check.
 */
export default async function TestDeliveryPage({ params }: { params: Promise<{ biz: string }> }) {
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

  const attention: AttentionItem[] =
    active === null
      ? [
          {
            key: "no-transport",
            tone: "warning",
            title: "There is no transport to test",
            detail: (
              <>
                A test send would use the platform&rsquo;s{" "}
                <span className="font-mono text-xs">{smtp.effective_transport}</span> transport. It
                would tell you nothing about your own configuration.
              </>
            ),
            actions: (
              <Link
                href={`/businesses/${biz}/settings/emails/delivery`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Configure one
              </Link>
            ),
          },
        ]
      : [];

  return (
    <SettingsPage
      title="Test delivery"
      crumbs={[...deliveryCrumbs(biz), { label: "Test delivery" }]}
      description="Make sure that the transport works before your customers depend on it. Neither test affects a real customer, and nothing here changes a setting."
      attention={attention}
    >
      <SettingsColumns>
        {/* Only when there is a relay to connect to. */}
        {active === "smtp" && smtp.host ? (
          <SettingsCard
            title="Test the connection"
            meta={`${smtp.host}${smtp.port ? `:${smtp.port}` : ""}`}
          >
            <ActionForm action={testSmtpConnectionAction}>
              <input type="hidden" name="biz" value={biz} />
              <SettingRow
                label="Connect and authenticate"
                help="This sends nothing. It checks the host, port, encryption and password. It does not check whether the relay accepts your From address."
                placement="end"
                control={
                  <SubmitButton variant="outline" size="sm">
                    Test connection
                  </SubmitButton>
                }
              />
            </ActionForm>
          </SettingsCard>
        ) : null}

        {active === "ses" ? (
          <SettingsCard title="Test the connection" meta="Not available for Amazon SES">
            <p className="m-0 px-5 py-4 text-sm leading-normal text-muted-foreground">
              Every AWS call that reports on the account needs a permission that a send-scoped key
              does not have. So this test would fail for credentials that send correctly. The test
              send below is the real check.
            </p>
          </SettingsCard>
        ) : null}

        {/* Not resetOnSuccess: the usual next move is another type to the same address. */}
        <SettingsCard
          title="Send a test email"
          meta={active ? `Via ${TRANSPORT_LABEL[active]}` : "No transport chosen"}
        >
          <ActionForm action={sendTestEmailAction}>
            <input type="hidden" name="biz" value={biz} />
            <p className="m-0 border-b px-5 py-3 text-sm leading-normal text-muted-foreground">
              This fills a real template with sample data and sends it now, from{" "}
              {smtp.effective_from_address}. It shows in the{" "}
              <Link href={`/businesses/${biz}/emails`} className="text-primary hover:underline">
                Emails log
              </Link>{" "}
              with a <span className="font-mono text-xs">[Test]</span> subject.
            </p>
            <div className="grid gap-x-4 sm:grid-cols-2">
              <SettingRow
                label="Send to"
                htmlFor="test_to"
                errorFor="test_to"
                control={
                  <Input
                    id="test_to"
                    name="test_to"
                    type="email"
                    required
                    maxLength={320}
                    placeholder="you@example.com"
                  />
                }
              />
              <SettingRow
                label="Which email"
                htmlFor="test_type"
                errorFor="test_type"
                control={
                  <SelectField
                    name="test_type"
                    defaultValue={EMAIL_TYPES[0]!.key}
                    ariaLabel="Which email"
                    // A sign-in code is never test-sent: it would mail a code that signs no one in.
                    options={EMAIL_TYPES.filter((t) => !t.system).map((t) => ({
                      value: t.key,
                      label: t.label,
                    }))}
                  />
                }
              />
            </div>
            <div className="border-t px-5 py-4">
              <SubmitButton variant="outline">Send test email</SubmitButton>
            </div>
          </ActionForm>
        </SettingsCard>
      </SettingsColumns>
    </SettingsPage>
  );
}

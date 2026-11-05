import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { ErrorState } from "@/components/states";
import { buttonVariants } from "@/components/ui/button";
import { StatusChip } from "@/components/patterns/chip";
import {
  Consequence,
  SettingRow,
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
  type AttentionItem,
} from "@/components/settings/settings-layout";
import { getSmtpSettings, getSesSettings } from "@/lib/api/emails";
import {
  activeTransport,
  deliveryCrumbs,
  transportDetail,
  transportReady,
  TRANSPORT_LABEL,
  type TransportId,
} from "./transport-status";

export const dynamic = "force-dynamic";

/**
 * Settings → Email notifications → Delivery. Which relay carries this business's mail.
 * `smtp_config` and `ses_config` are separate resources, so each has its own page;
 * activation lives there, beside the credentials being switched to.
 */
export default async function EmailDeliverySettings({
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

  const [smtp, ses] = await Promise.all([getSmtpSettings(biz), getSesSettings(biz)]);
  const active = activeTransport(smtp, ses);
  const sendingOn = b.email_config?.enabled ?? false;
  const testHref = `/businesses/${biz}/settings/emails/delivery/test`;

  const rows: Array<{ id: TransportId; description: string }> = [
    {
      id: "smtp",
      description: "Your own relay, so email comes from your domain and uses your reputation.",
    },
    {
      id: "ses",
      description: "Your own AWS account, through the SES API. It uses an IAM key, not a password.",
    },
  ];

  // Shown before sending is switched on too: set-up needs to know first.
  const attention: AttentionItem[] =
    active === null
      ? [
          {
            key: "no-transport",
            tone: sendingOn ? "attention" : "warning",
            title: sendingOn
              ? "Billing emails are not delivered"
              : "This business has no delivery method yet",
            detail: (
              <>
                Until you configure SMTP or Amazon SES, email goes to the platform&rsquo;s{" "}
                <span className="font-mono text-xs">{smtp.effective_transport}</span> transport.
                {smtp.delivers
                  ? " That transport sends from the platform’s own domain, not yours."
                  : " That transport delivers nothing."}{" "}
                Select one below.
              </>
            ),
          },
        ]
      : [];

  return (
    <SettingsPage
      title="Delivery"
      crumbs={[...deliveryCrumbs(biz).slice(0, -1), { label: "Delivery" }]}
      description="Which relay sends this business's billing email: your own SMTP server or Amazon SES account. Email then goes out on your domain and uses your sending reputation."
      attention={attention}
    >
      <SettingsColumns
        summary={
          <>
            <SettingsSummary
              items={[
                {
                  label: "Carried by",
                  value: active
                    ? `${TRANSPORT_LABEL[active]}${transportDetail(active, smtp, ses) ? ` · ${transportDetail(active, smtp, ses)}` : ""}`
                    : "Nothing selected",
                },
                {
                  label: "Delivering",
                  value: smtp.delivers ? "Yes" : "No. Nothing is sent.",
                },
                { label: "From", value: smtp.effective_from_address },
                { label: "Billing emails", value: sendingOn ? "On" : "Off" },
              ]}
            />
            <div className="border-t px-5 py-4">
              <p className="m-0 text-sm leading-normal text-muted-foreground">
                Saved credentials do not prove delivery. A relay can refuse the From address. A new
                AWS account stays in the sandbox until you request production access.
              </p>
              <Link
                href={testHref}
                className="mt-2 inline-block text-sm text-primary hover:underline"
              >
                Test delivery
              </Link>
            </div>
          </>
        }
      >
        <SettingsCard
          title="Transport"
          meta={
            active
              ? `${TRANSPORT_LABEL[active]} · ${smtp.delivers ? "delivering" : "delivers nothing"}`
              : "Nothing selected"
          }
        >
          {rows.map(({ id, description }) => {
            const detail = transportDetail(id, smtp, ses);
            const ready = transportReady(id, smtp, ses);
            return (
              <SettingRow
                key={id}
                placement="end"
                label={
                  <span className="flex flex-wrap items-center gap-2">
                    {TRANSPORT_LABEL[id]}
                    {active === id ? <StatusChip status="active" /> : null}
                  </span>
                }
                help={description}
                control={
                  <Link
                    href={`/businesses/${biz}/settings/emails/delivery/${id}`}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    {detail ? "Edit" : "Configure"}
                  </Link>
                }
                // Read off the stored fields; "incomplete" because the engine would refuse it.
                consequence={
                  active === id
                    ? `Sends this business's email${detail ? ` · ${detail}` : ""}.`
                    : detail
                      ? ready
                        ? `${detail} · saved, not in use.`
                        : `${detail} · incomplete, so you cannot enable it yet.`
                      : "Not configured."
                }
              />
            );
          })}
          <p className="m-0 px-5 py-3 text-sm text-muted-foreground">
            A business sends through only one transport. We keep the settings of the other one, so
            you do not need to type them again when you change back.
          </p>
        </SettingsCard>

        <SettingsCard
          title="Diagnostics"
          meta="Make sure that the transport works before customers depend on it"
        >
          <SettingRow
            label="Test delivery"
            help="Send a real templated message through the transport above. For SMTP, you can also open the connection without sending."
            placement="end"
            control={
              <Link href={testHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
                Open
              </Link>
            }
          >
            <Consequence>
              {active === null
                ? "No transport to test yet."
                : smtp.delivers
                  ? `Sends via ${TRANSPORT_LABEL[active]}.`
                  : "Nothing would be sent."}
            </Consequence>
          </SettingRow>
        </SettingsCard>
      </SettingsColumns>
    </SettingsPage>
  );
}

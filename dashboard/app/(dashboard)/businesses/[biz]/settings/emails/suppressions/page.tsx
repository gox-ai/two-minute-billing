import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { ErrorState, EmptyState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { Chip } from "@/components/patterns/chip";
import { SettingsCard, SettingsPage } from "@/components/settings/settings-layout";
import { getSesSettings, listSuppressions, type EmailSuppression } from "@/lib/api/emails";
import { removeSuppressionAction } from "../../actions";

export const dynamic = "force-dynamic";

/** The provider's verdict, in the merchant's words. */
function reasonLabel(s: EmailSuppression): string {
  if (s.reason === "complaint") return "Marked as spam";
  if (s.reason === "manual") return "Added by hand";
  return "Bounced";
}

/**
 * Settings → Email notifications → Suppressed addresses. Filled only by Amazon SES
 * feedback over SNS (suppression.ts → applySesFeedback); never added here. Every row is
 * removable — a full mailbox in March may be fine in June.
 */
export default async function EmailSuppressionSettings({
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

  const [{ data: rows }, ses] = await Promise.all([listSuppressions(biz), getSesSettings(biz)]);

  return (
    <SettingsPage
      title="Suppressed addresses"
      crumbs={[
        { label: "Settings", href: `/businesses/${biz}/settings` },
        { label: "Email notifications", href: `/businesses/${biz}/settings/emails` },
        { label: "Suppressed addresses" },
      ]}
      description="Addresses that this business will not email again, because Amazon SES reported a hard bounce or a spam complaint. Emails to these addresses damage your sending reputation. But no entry here is permanent."
    >
      <SettingsCard
        title="Suppressed addresses"
        meta={
          rows.length === 0
            ? "None"
            : `We will not email ${rows.length} address${rows.length === 1 ? "" : "es"}`
        }
      >
        {rows.length === 0 ? (
          <EmptyState
            title="No suppressed addresses"
            description={
              ses.enabled && ses.configuration_set ? (
                "No address has a hard bounce or a spam complaint. Addresses show here automatically when Amazon SES reports one."
              ) : (
                <>
                  Only Amazon SES with a configuration set reports bounces and complaints. This list
                  stays empty until you configure it.{" "}
                  <Link
                    href={`/businesses/${biz}/settings/emails/delivery/ses`}
                    className="text-primary hover:underline"
                  >
                    Amazon SES settings
                  </Link>
                </>
              )
            }
          />
        ) : (
          rows.map((s) => (
            <div key={s.address} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
              <div className="min-w-0 flex-1 basis-56">
                <div className="truncate text-sm font-medium" title={s.address}>
                  {s.address}
                </div>
                <div className="mt-0.5 text-xs wrap-anywhere text-muted-foreground">
                  {/* The provider's own words separate "mailbox full" from "no such user". */}
                  {s.detail ? <span className="font-mono">{s.detail}</span> : "no further detail"}
                </div>
              </div>
              {/* Neutral: a suppression is the correct end of an address, not an outage. */}
              <Chip tone="gray" className="text-xs uppercase">
                {reasonLabel(s)}
              </Chip>
              <ActionForm action={removeSuppressionAction}>
                <input type="hidden" name="biz" value={biz} />
                <input type="hidden" name="address" value={s.address} />
                <SubmitButton variant="outline" size="sm">
                  Remove
                </SubmitButton>
              </ActionForm>
            </div>
          ))
        )}
      </SettingsCard>
    </SettingsPage>
  );
}

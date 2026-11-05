import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { listBusinessIntegrations, type BusinessIntegration } from "@/lib/api/integrations";
import { ErrorState, EmptyState } from "@/components/states";
import { SettingsCard, SettingsLinkRow, SettingsPage } from "@/components/settings/settings-layout";
import { LOGO_SIZE, PartnerLogo } from "@/components/partner-logo";

export const dynamic = "force-dynamic";

const CATEGORIES: Array<{ key: BusinessIntegration["category"]; title: string; meta: string }> = [
  { key: "crm", title: "CRM", meta: "Keep the records of your sales team in sync with billing" },
  {
    key: "affiliate",
    title: "Affiliate programs",
    meta: "Send sales and refunds to your affiliate program, so partners get the correct commission",
  },
];

/** The value a row shows: read off the live status, never a placeholder. */
function statusHint(i: BusinessIntegration, testMode: boolean): string {
  switch (i.status) {
    case "active":
      return i.summary ?? "Connected";
    case "disabled":
      return "Disabled";
    case "reauth_required":
      return "Reconnect needed";
    default:
      // HubSpot refuses test data, so a test business cannot connect it.
      return i.key === "hubspot" && testMode ? "Not available in test mode" : "Not connected";
  }
}

/** The integrations directory, from the engine's catalogue: one row per tool with its status. */
export default async function IntegrationsPage({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  await requirePermission("integrations:view", "admin");

  let business, directory;
  try {
    [business, directory] = await Promise.all([getBusiness(biz), listBusinessIntegrations(biz)]);
  } catch (e) {
    return (
      <ErrorState
        title="We could not load the integrations"
        description={<span className="font-mono text-xs">{(e as Error).message}</span>}
      />
    );
  }
  if (!business)
    return <ErrorState title="Not found" description={`We could not find the business ${biz}.`} />;

  const base = `/businesses/${biz}/integrations`;
  const testMode = business.livemode === "test";
  // A category the dashboard does not know yet still shows, under its own key.
  const known = new Set(CATEGORIES.map((c) => c.key));
  const groups = [
    ...CATEGORIES,
    ...[...new Set(directory.data.map((i) => i.category))]
      .filter((c) => !known.has(c))
      .map((c) => ({ key: c, title: c, meta: "" })),
  ]
    .map((g) => ({ ...g, items: directory.data.filter((i) => i.category === g.key) }))
    .filter((g) => g.items.length);

  return (
    <SettingsPage
      title="Integrations"
      description="Connect the other tools that your team uses."
      crumbs={[{ label: business.name, href: `/businesses/${biz}` }, { label: "Integrations" }]}
    >
      {groups.length === 0 ? (
        <SettingsCard title="Integrations" padded>
          <EmptyState
            title="Nothing to connect"
            description="This deployment has no integrations."
          />
        </SettingsCard>
      ) : (
        groups.map((g) => (
          <SettingsCard key={g.key} title={g.title} meta={g.meta || undefined}>
            {g.items.map((i) => (
              <SettingsLinkRow
                key={i.key}
                title={
                  <span className="flex items-center gap-2">
                    <PartnerLogo brand={i.key} name={i.label} {...LOGO_SIZE.mark} />
                    {i.label}
                  </span>
                }
                description={i.blurb}
                value={statusHint(i, testMode)}
                href={`${base}/${i.key}`}
              />
            ))}
          </SettingsCard>
        ))
      )}
    </SettingsPage>
  );
}

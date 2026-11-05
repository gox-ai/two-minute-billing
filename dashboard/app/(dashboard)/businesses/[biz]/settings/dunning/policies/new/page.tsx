import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { ErrorState } from "@/components/states";
import { SettingsPage } from "@/components/settings/settings-layout";
import { dunningDefaults } from "../../defaults";
import { PolicyForm } from "../policy-form";

export const dynamic = "force-dynamic";

/** A new policy starts as a copy of the business settings, so every field shows a real value. */
export default async function NewDunningPolicyPage({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
  const { biz } = await params;
  await requirePermission("dunning_policies:manage", "admin");

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

  const base = `/businesses/${biz}/settings`;
  return (
    <SettingsPage
      title="Create dunning policy"
      crumbs={[
        { label: "Settings", href: base },
        { label: "Dunning", href: `${base}/dunning` },
        { label: "Policies", href: `${base}/dunning/policies` },
        { label: "Create" },
      ]}
      description="The fields start with the business dunning settings. Change the ones that must be different for the customers that get this policy."
    >
      <PolicyForm biz={biz} d={dunningDefaults(b.dunning_config, b, { legacyDays: true })} />
    </SettingsPage>
  );
}

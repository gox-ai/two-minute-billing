import { isApiNotFound } from "@/lib/api";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { getDunningPolicy } from "@/lib/api/dunning-policies";
import { ErrorState } from "@/components/states";
import { Alert } from "@/components/ui/alert";
import { StatusChip } from "@/components/patterns/chip";
import { SettingsPage } from "@/components/settings/settings-layout";
import { dunningDefaults } from "../../defaults";
import { PolicyForm } from "../policy-form";

export const dynamic = "force-dynamic";

export default async function DunningPolicyPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string; dpol: string }>;
  searchParams: Promise<{ msg?: string }>;
}) {
  const [{ biz, dpol }, { msg }] = await Promise.all([params, searchParams]);
  await requirePermission("dunning_policies:view", "admin");

  let b, policy;
  try {
    [b, policy] = await Promise.all([getBusiness(biz), getDunningPolicy(biz, dpol)]);
  } catch (e) {
    if (isApiNotFound(e)) notFound();
    return (
      <ErrorState
        error={e}
        thing="dunning policy"
        back={{ label: "View dunning settings", href: `/businesses/${biz}/settings/dunning` }}
        retry
      />
    );
  }
  if (!b || !policy) notFound();

  const base = `/businesses/${biz}/settings`;
  return (
    <SettingsPage
      title={policy.name}
      crumbs={[
        { label: "Settings", href: base },
        { label: "Dunning", href: `${base}/dunning` },
        { label: "Policies", href: `${base}/dunning/policies` },
        { label: policy.name },
      ]}
      description={
        <span className="inline-flex flex-wrap items-center gap-2">
          {policy.archived ? <StatusChip status="archived" /> : null}
          <span className="font-mono text-xs">{policy.code}</span>
          <span>
            Customers with this policy use these settings in place of the business dunning settings.
          </span>
        </span>
      }
    >
      {msg ? <Alert tone="success">{msg}</Alert> : null}
      {policy.archived ? (
        <Alert tone="info">
          This policy is archived. You cannot assign it to a customer. You can still change its
          settings.
        </Alert>
      ) : null}
      {/* The stored config is the full per-invoice set; the business-wide keys come from the business. */}
      <PolicyForm biz={biz} d={dunningDefaults(policy.config, b)} policy={policy} />
    </SettingsPage>
  );
}

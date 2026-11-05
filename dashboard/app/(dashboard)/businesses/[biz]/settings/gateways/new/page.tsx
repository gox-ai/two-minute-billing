import { listBusinesses } from "@/lib/api";
import { businessCurrencyOptions } from "@/lib/business-currencies";
import { getGatewayCatalog } from "@/lib/api/gateways";
import { requirePermission } from "@/lib/session";
import { ErrorState } from "@/components/states";
import { SettingsPage } from "@/components/settings/settings-layout";
import { GatewayCreateForm } from "@/components/gateways/gateway-create-form";
import { createGatewayAccountAction } from "../actions";

export const dynamic = "force-dynamic";

/** Add a gateway account: provider directory → that provider's form. */
export default async function NewGatewayPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{ gateway?: string }>;
}) {
  const { biz } = await params;
  // From the setup checklist: the gateway named at sign-up opens on its form.
  const { gateway } = await searchParams;
  await requirePermission("gateways:manage", "admin");

  const crumbs = [
    { label: "Settings", href: `/businesses/${biz}/settings` },
    { label: "Payment gateways", href: `/businesses/${biz}/settings/gateways` },
    { label: "Add" },
  ];
  let businesses, catalog;
  try {
    [businesses, catalog] = await Promise.all([listBusinesses(), getGatewayCatalog()]);
  } catch (e) {
    return (
      <SettingsPage title="Add a gateway" crumbs={crumbs}>
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </SettingsPage>
    );
  }
  const b = businesses.data.find((x) => x.id === biz);
  if (!b) {
    return (
      <SettingsPage title="Add a gateway" crumbs={crumbs}>
        <ErrorState title="Not found" description={`We could not find the business ${biz}.`} />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title="Add a gateway"
      crumbs={crumbs}
      description="Select the provider. Then connect the account with its credentials."
    >
      <div className="max-w-4xl">
        <GatewayCreateForm
          biz={biz}
          catalog={catalog}
          businessLivemode={b.livemode}
          businessCurrencies={b.currencies ?? null}
          currencyOptions={businessCurrencyOptions(b)}
          action={createGatewayAccountAction}
          initialGateway={typeof gateway === "string" ? gateway : null}
        />
      </div>
    </SettingsPage>
  );
}

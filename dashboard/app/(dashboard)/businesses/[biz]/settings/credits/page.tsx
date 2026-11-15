import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { businessCurrencyOptions } from "@/lib/business-currencies";
import { resolveCreditConfig, type CreditConfigInput } from "@/lib/credits";
import { ErrorState } from "@/components/states";
import { SettingsPage } from "@/components/settings/settings-layout";
import { CreditSettingsForm } from "@/components/credits/credit-settings-form";
import { listMeters } from "@/lib/api/meters";
import { listCreditUnits } from "@/lib/api/credits";

export const dynamic = "force-dynamic";

/** Settings → Credits: `credit_config` (design G3 § 5, 0464). Absent keys show the API defaults. */
export default async function CreditSettingsPage({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");

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

  const config = resolveCreditConfig((b as { credit_config?: CreditConfigInput }).credit_config);
  const currencies = businessCurrencyOptions(b) ?? [(b.default_currency ?? "USD").toUpperCase()];
  // For the credit scope. A failed read leaves the list empty; the saved scope still shows.
  const meters = await listMeters(biz)
    .then((r) =>
      r.data.map((m) => ({ key: m.id, name: m.name, archived: m.status === "archived" })),
    )
    .catch(() => []);
  // The active units with no money value: each has its own limit on free credit. A failed
  // read shows no fields, and the save then leaves the stored limits as they are.
  const limitUnits = await listCreditUnits(biz)
    .then((r) =>
      r.data
        .filter((u) => u.status === "active" && u.minor_per_unit === null)
        .map((u) => ({ key: u.id, name: u.name, plural: u.plural_name, decimals: u.decimals })),
    )
    .catch(() => []);

  return (
    <SettingsPage
      title="Credits"
      crumbs={[{ label: "Settings", href: `/businesses/${biz}/settings` }, { label: "Credits" }]}
      description={
        <>
          What happens when a customer has no credit, how long holds stay open, and the limits on
          credit purchases. To give credit in your own units, go to{" "}
          <Link
            href={`/businesses/${biz}/settings/credit-units`}
            className="text-primary hover:underline"
          >
            Credit units
          </Link>
          .
        </>
      }
    >
      <CreditSettingsForm
        biz={biz}
        config={config}
        currencies={currencies}
        meters={meters}
        limitUnits={limitUnits}
        version={b.resource_version ?? undefined}
      />
    </SettingsPage>
  );
}

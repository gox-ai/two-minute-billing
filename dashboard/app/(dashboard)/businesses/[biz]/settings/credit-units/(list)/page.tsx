import { getBusiness } from "@/lib/api/business-settings";
import { listCreditUnits } from "@/lib/api/credits";
import { allows, requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/states";
import { CreditUnitsTable } from "@/components/credits/credit-units-table";

export const dynamic = "force-dynamic";

export default async function CreditUnitsPage({ params }: { params: Promise<{ biz: string }> }) {
  const me = await requirePermission("credits:view", "manager");
  const { biz } = await params;
  let business, units;
  try {
    [business, units] = await Promise.all([getBusiness(biz), listCreditUnits(biz)]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Credit units" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  return (
    <CreditUnitsTable
      page={{
        title: "Credit units",
        description:
          "Your own units of credit, for example 1 credit = USD 0.01. Credit grants and credit packs can give credit in these units.",
        breadcrumbs: [
          { label: business?.name ?? biz, href: `/businesses/${biz}` },
          { label: "Settings", href: `/businesses/${biz}/settings` },
          { label: "Credit units" },
        ],
      }}
      biz={biz}
      rows={units.data}
      canManage={allows(me, "credits:manage", "ops")}
    />
  );
}

import { KindCatalog } from "@/components/catalog/kind-catalog";
import { requirePermission } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function PlansPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{ archived?: string; group?: string; msg?: string; error?: string }>;
}) {
  await requirePermission("catalog:view", "manager");

  const { biz } = await params;
  const { archived, group, msg, error } = await searchParams;
  return (
    <KindCatalog
      biz={biz}
      kind="plan"
      page="plans"
      title="Plans"
      blurb="Plans are the recurring products customers subscribe to."
      showArchived={archived === "1"}
      group={group}
      msg={msg}
      error={error}
    />
  );
}

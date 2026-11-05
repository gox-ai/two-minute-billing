import { KindCatalog } from "@/components/catalog/kind-catalog";
import { requirePermission } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AddonsPage({
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
      kind="addon"
      page="addons"
      title="Add-ons"
      blurb="Add-ons are recurring items that a subscription has in addition to its plan."
      showArchived={archived === "1"}
      group={group}
      msg={msg}
      error={error}
    />
  );
}

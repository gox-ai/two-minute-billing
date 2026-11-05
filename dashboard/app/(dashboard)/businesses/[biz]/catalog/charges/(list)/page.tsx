import { KindCatalog } from "@/components/catalog/kind-catalog";
import { requirePermission } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ChargesPage({
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
      kind="charge"
      page="charges"
      title="One-time products"
      blurb="A one-time product is paid once. Sell it on a payment link, or add it to a subscription."
      showArchived={archived === "1"}
      group={group}
      msg={msg}
      error={error}
    />
  );
}

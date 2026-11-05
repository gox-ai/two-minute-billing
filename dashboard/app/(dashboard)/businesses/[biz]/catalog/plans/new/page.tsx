import { requirePermission } from "@/lib/session";
import { NewProductPage } from "@/components/catalog/new-product-page";

export const dynamic = "force-dynamic";

export default async function NewPlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{ group?: string }>;
}) {
  await requirePermission("catalog:manage", "manager");
  const { biz } = await params;
  const { group } = await searchParams;
  return <NewProductPage biz={biz} kind="plan" group={group} />;
}

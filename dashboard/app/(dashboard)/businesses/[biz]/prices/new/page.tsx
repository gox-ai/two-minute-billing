import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/session";

// Retired: a price is only ever created from its plan/addon
// detail pricing matrix ("Set Price" on an empty Currency × Frequency cell).
export default async function RetiredNewPricePage({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
  await requirePermission("catalog:manage", "manager");

  const { biz } = await params;
  redirect(`/businesses/${biz}/catalog/plans`);
}

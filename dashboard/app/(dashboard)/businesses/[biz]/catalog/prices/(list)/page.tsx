import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/session";

// Retired: prices are owned by a plan/addon and
// are managed from the product detail pricing matrix — there is no standalone
// prices list. Kept only as a redirect so old links/bookmarks don't 404.
export default async function RetiredPricesPage({ params }: { params: Promise<{ biz: string }> }) {
  await requirePermission("catalog:view", "manager");

  const { biz } = await params;
  redirect(`/businesses/${biz}/catalog/plans`);
}

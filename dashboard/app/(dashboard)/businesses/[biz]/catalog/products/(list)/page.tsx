import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/session";

// Catalog was split by kind (Plans / Add-ons / Charges). Keep this route as a
// redirect so old links land somewhere sensible.
export default async function ProductsRedirect({ params }: { params: Promise<{ biz: string }> }) {
  await requirePermission("catalog:view", "manager");

  const { biz } = await params;
  redirect(`/businesses/${biz}/catalog/plans`);
}

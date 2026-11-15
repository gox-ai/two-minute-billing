import { redirect } from "next/navigation";

/** `/catalog` has no page of its own: Plans is the catalog's first tab. */
export default async function CatalogIndex({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  redirect(`/businesses/${biz}/catalog/plans`);
}

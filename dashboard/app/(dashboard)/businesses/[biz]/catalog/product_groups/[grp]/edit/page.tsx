import { listBusinesses, getProductGroup } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/states";
import { RecordCard } from "@/components/patterns/record-page";
import { EditProductGroupPanel } from "@/components/catalog/edit-product-group-form";

export const dynamic = "force-dynamic";

/** Deep-link target for older links; the list and row menu edit in a dialog. */
export default async function EditProductGroupPage({
  params,
}: {
  params: Promise<{ biz: string; grp: string }>;
}) {
  await requirePermission("catalog:manage", "manager");
  const { biz, grp } = await params;

  let businesses, group;
  try {
    [businesses, group] = await Promise.all([listBusinesses(), getProductGroup(biz, grp)]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Edit product group" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const name = businesses.data.find((b) => b.id === biz)?.name ?? biz;
  const listHref = `/businesses/${biz}/catalog/product_groups`;

  return (
    <>
      <PageHeader
        title="Edit product group"
        breadcrumbs={[
          { label: name, href: `/businesses/${biz}` },
          { label: "Product Catalog" },
          { label: "Product Groups", href: listHref },
          { label: group.name },
        ]}
      />
      <div className="max-w-xl">
        <RecordCard title={group.name}>
          <EditProductGroupPanel biz={biz} group={group} listHref={listHref} />
        </RecordCard>
      </div>
    </>
  );
}

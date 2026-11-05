import { listBusinesses, listProductGroups } from "@/lib/api";
import { importProductGroupsAction } from "@/app/actions";
import { ProductGroupDialog } from "@/components/catalog/product-group-dialog";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { GroupsTable } from "@/components/catalog/groups-table";
import { CreateDialog } from "@/components/create-dialog";
import { ErrorState } from "@/components/states";
import { fieldClass } from "@/lib/utils";
import { ActionForm } from "@/components/form/action-form";

export const dynamic = "force-dynamic";

export default async function ProductGroupsPage({ params }: { params: Promise<{ biz: string }> }) {
  await requirePermission("catalog:view", "manager");
  const { biz } = await params;

  let businesses, groups;
  try {
    [businesses, groups] = await Promise.all([listBusinesses(), listProductGroups(biz)]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Product Groups" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  const name = businesses.data.find((b) => b.id === biz)?.name ?? biz;

  // Create + import are dialogs — they live in the list top bar as slots.
  const importDialog = (
    <CreateDialog
      triggerLabel="Import Product Groups"
      triggerVariant="outline"
      title="Import Product Groups"
      description="Enter one group on each line, as name,description. The name is required. The description is optional."
    >
      <ActionForm action={importProductGroupsAction} className="space-y-3">
        <input type="hidden" name="biz" value={biz} />
        <textarea
          name="csv"
          rows={6}
          required
          placeholder={"Platform,Core subscription products\nAdd-ons"}
          className={`${fieldClass} min-h-32 py-2 font-mono text-xs`}
        />
        <div className="flex justify-end">
          <Button type="submit">Import</Button>
        </div>
      </ActionForm>
    </CreateDialog>
  );
  const createDialog = <ProductGroupDialog biz={biz} triggerLabel="Create Product Group" />;

  return (
    <>
      <GroupsTable
        page={{
          title: "Product Groups",
          breadcrumbs: [
            { label: name, href: `/businesses/${biz}` },
            { label: "Product Catalog" },
            { label: "Product Groups" },
          ],
        }}
        biz={biz}
        rows={groups.data}
        createSlot={createDialog}
        importSlot={importDialog}
      />
    </>
  );
}

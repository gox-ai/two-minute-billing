import { listBusinesses, listProducts, listProductGroups } from "@/lib/api";
import { importProductsAction } from "@/app/actions";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { ProductsListPage } from "@/components/catalog/products-table";
import { ShowArchivedToggle } from "@/components/catalog/show-archived-toggle";
import { CreateDialog } from "@/components/create-dialog";
import { ErrorState } from "@/components/states";
import { fieldClass } from "@/lib/utils";
import { Alert } from "@/components/ui/alert";
import { ActionForm } from "@/components/form/action-form";

type Kind = "plan" | "addon" | "charge";

/**
 * Shared renderer for the three kind-specific catalog pages (Plans / Add-ons /
 * Charges). Each is the same product list filtered to one `kind`, with a create
 * form that stamps that kind.
 */
export async function KindCatalog({
  biz,
  kind,
  page,
  title,
  blurb,
  showArchived,
  group,
  msg,
  error,
}: {
  biz: string;
  kind: Kind;
  /** url segment under /catalog (plans | addons | charges) */
  page: string;
  /** plural page title (Plans / Add-ons / Charges) */
  title: string;
  /** one-line description for the empty state */
  blurb: string;
  showArchived: boolean;
  /** filter to one product group (from the group row menu "Show associated …") */
  group?: string;
  msg?: string;
  error?: string;
}) {
  await requirePermission("catalog:view", "manager");

  let businesses, products, groups;
  try {
    [businesses, products, groups] = await Promise.all([
      listBusinesses(),
      listProducts(biz, { includeArchived: showArchived }),
      listProductGroups(biz),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title={title} />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const name = businesses.data.find((b) => b.id === biz)?.name ?? biz;
  const groupName = group ? (groups.data.find((g) => g.id === group)?.name ?? group) : undefined;
  const rows = products.data
    .filter((p) => (p.kind ?? "plan") === kind)
    .filter((p) => (group ? p.product_group === group : true));
  const basePath = `/businesses/${biz}/catalog/${page}`;
  const singular = title.replace(/s$/, "");

  return (
    <>
      <PageHeader
        title={title}
        breadcrumbs={[
          { label: name, href: `/businesses/${biz}` },
          { label: "Product Catalog" },
          { label: title },
        ]}
      />

      {msg ? (
        <Alert tone="info" className="mb-6">
          {msg}
        </Alert>
      ) : null}
      {error ? <ErrorState className="mb-6" description={error} /> : null}

      {group ? (
        <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
          <span>
            Filtered to product group{" "}
            <span className="font-medium text-foreground">{groupName}</span>
          </span>
          <a href={basePath} className="text-primary hover:underline">
            Clear
          </a>
        </div>
      ) : null}

      {/* Create / Import / show-archived all live in the list top bar now. */}
      <ProductsListPage
        biz={biz}
        rows={rows}
        kind={kind}
        entity={{ singular, plural: title }}
        createHref={`${basePath}/new${group ? `?group=${group}` : ""}`}
        groups={groups.data}
        emptyDescription={blurb}
        topBarExtras={<ShowArchivedToggle basePath={basePath} showing={showArchived} />}
        importSlot={
          <CreateDialog
            triggerLabel={`Import ${title}`}
            triggerVariant="outline"
            title={`Import ${title}`}
            description={`Enter one ${singular.toLowerCase()} on each line, as name,description. The name is required. The description is optional.`}
          >
            <ActionForm action={importProductsAction} className="space-y-3">
              <input type="hidden" name="biz" value={biz} />
              <input type="hidden" name="kind" value={kind} />
              <textarea
                name="csv"
                rows={6}
                required
                className={`${fieldClass} min-h-32 py-2 font-mono text-xs`}
              />
              <div className="flex justify-end">
                <Button type="submit">Import</Button>
              </div>
            </ActionForm>
          </CreateDialog>
        }
      />
    </>
  );
}

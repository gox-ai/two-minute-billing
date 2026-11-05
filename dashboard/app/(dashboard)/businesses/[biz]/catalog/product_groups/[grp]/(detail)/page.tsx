import Link from "next/link";
import { listBusinesses, listProducts, listPrices, getProductGroup, fmtDate } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { StatusChip, IdChip } from "@/components/patterns/chip";
import {
  RecordCard,
  RecordCrumbs,
  RecordHeader,
  Row,
  Zone,
} from "@/components/patterns/record-page";
import { MoreMenu, MoreSection } from "@/components/patterns/more-menu";
import { RailLink } from "@/components/patterns/action-rail";
import { Paged, PagedFooter, PagedItems } from "@/components/patterns/pager";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { ProductRowMenu } from "@/components/catalog/product-row-menu";
import { ArchiveRestoreItem } from "@/components/catalog/catalog-record-actions";
import { PageRefresh } from "@/components/patterns/page-refresh";
import { ActivityLogCard } from "@/components/activity-log-card";
import { UsageTiles } from "@/components/catalog/usage-tiles";
import { getProductGroupStats } from "@/lib/api/catalog-stats";
import { ErrorState } from "@/components/states";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  plan: "Plan",
  addon: "Addon",
  charge: "One-time product",
};

/**
 * Product group detail, record-page layout: header, figures, the products filed
 * under it, then Records.
 */
export default async function ProductGroupDetailPage({
  params,
}: {
  params: Promise<{ biz: string; grp: string }>;
}) {
  await requirePermission("catalog:view", "manager");
  const { biz, grp } = await params;

  let businesses, group, products, prices, stats;
  try {
    [businesses, group, products, prices, stats] = await Promise.all([
      listBusinesses(),
      getProductGroup(biz, grp),
      listProducts(biz, { group: grp, includeArchived: true }),
      listPrices(biz, { includeArchived: true }),
      // Figures are supplementary: a stats failure drops the tiles and the column.
      getProductGroupStats(biz, grp).catch(() => null),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Product group" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  const business = businesses.data.find((b) => b.id === biz);
  const bizName = business?.name ?? biz;
  const tz = business?.timezone ?? null;
  const catalog = `/businesses/${biz}/catalog`;

  const livePriceCount = new Map<string, number>();
  for (const p of prices.data) {
    if (p.active === false) continue;
    livePriceCount.set(p.product, (livePriceCount.get(p.product) ?? 0) + 1);
  }
  const rows = products.data;
  const activeCount = rows.filter((p) => p.active).length;
  const archivedCount = rows.length - activeCount;
  const livePrices = rows.reduce((n, p) => n + (livePriceCount.get(p.id) ?? 0), 0);

  const subsByProduct = new Map(
    (stats?.products ?? []).map((r) => [r.product, r.active_subscriptions]),
  );

  const newProduct = (
    <MoreMenu label="Create product">
      <RailLink href={`${catalog}/plans/new?group=${group.id}`}>Create plan</RailLink>
      <RailLink href={`${catalog}/addons/new?group=${group.id}`}>Create addon</RailLink>
      <RailLink href={`${catalog}/charges/new?group=${group.id}`}>Create charge</RailLink>
    </MoreMenu>
  );

  return (
    <div className="flex flex-col gap-4">
      <RecordCrumbs
        items={[
          { label: bizName, href: `/businesses/${biz}` },
          { label: "Product Catalog" },
          { label: "Product Groups", href: `${catalog}/product_groups` },
          { label: group.name },
        ]}
        right={<PageRefresh />}
      />

      <RecordHeader
        title={group.name}
        chips={<StatusChip status={group.active ? "active" : "archived"} />}
        facts={[
          <IdChip key="id" label="Group ID" id={group.id} />,
          group.description,
          group.created_at ? `Created ${fmtDate(group.created_at, tz)}` : null,
        ]}
        actions={
          <>
            <Button asChild>
              <Link href={`${catalog}/product_groups/${group.id}/edit`}>Edit</Link>
            </Button>
            <MoreMenu>
              <MoreSection heading="View associated">
                <RailLink href={`${catalog}/plans?group=${group.id}`}>Plans</RailLink>
                <RailLink href={`${catalog}/addons?group=${group.id}`}>Add-ons</RailLink>
                <RailLink href={`${catalog}/charges?group=${group.id}`}>One-time products</RailLink>
              </MoreSection>
              <MoreSection heading="Product group">
                {/* A soft archive, refused by the engine while active products remain. */}
                <ArchiveRestoreItem
                  biz={biz}
                  resource="product_groups"
                  id={group.id}
                  active={group.active}
                  noun={group.name}
                  archiveDescription="An archived group cannot take new products. We do not archive a group that has active products."
                  restoreDescription="The group can take new products again."
                />
              </MoreSection>
            </MoreMenu>
          </>
        }
      />

      <UsageTiles stats={stats} scope="group" currency={business?.default_currency} />

      <Zone title="Products">
        <Row span="12">
          <RecordCard
            id="products"
            title="Products in this group"
            meta={
              // Group-wide counts: the table below is paged.
              rows.length
                ? `${activeCount} active · ${archivedCount} archived · ${livePrices} active prices`
                : undefined
            }
            flush={rows.length > 0}
            actions={newProduct}
          >
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">This group has no products yet.</p>
            ) : (
              <Paged
                size={10}
                items={rows.map((p) => (
                  <TableRow key={p.id} className={p.active ? undefined : "opacity-60"}>
                    <TableCell className="pl-5 whitespace-normal">
                      <Link
                        href={`${catalog}/products/${p.id}`}
                        className="font-medium wrap-anywhere text-primary hover:underline"
                      >
                        {p.name}
                      </Link>
                      <div className="font-mono text-xs wrap-anywhere text-muted-foreground">
                        {p.id}
                      </div>
                    </TableCell>
                    <TableCell>{KIND_LABEL[p.kind ?? "plan"] ?? p.kind}</TableCell>
                    <TableCell>
                      <StatusChip status={p.active ? "active" : "archived"} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {livePriceCount.get(p.id) ?? 0}
                    </TableCell>
                    {stats ? (
                      <TableCell className="text-right tabular-nums">
                        {(subsByProduct.get(p.id) ?? 0).toLocaleString()}
                      </TableCell>
                    ) : null}
                    <TableCell className="pr-5">
                      <div className="flex justify-end">
                        <ProductRowMenu biz={biz} id={p.id} label={p.name} active={p.active} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              >
                <Table className="table-fixed max-lg:min-w-2xl">
                  <colgroup>
                    <col className={stats ? "w-[31%]" : "w-[40%]"} />
                    <col className="w-[14%]" />
                    <col className="w-[14%]" />
                    <col className={stats ? "w-[13%]" : "w-[22%]"} />
                    {stats ? <col className="w-[17%]" /> : null}
                    <col className="w-16" />
                  </colgroup>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-5">Product</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Prices</TableHead>
                      {stats ? (
                        <TableHead className="text-right">Active subscriptions</TableHead>
                      ) : null}
                      <TableHead className="pr-5" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <PagedItems />
                  </TableBody>
                </Table>
                <PagedFooter />
              </Paged>
            )}
          </RecordCard>
        </Row>
      </Zone>

      <Zone title="Records">
        <Row span="12">
          <ActivityLogCard
            biz={biz}
            resourceType="product_group"
            resourceId={group.id}
            tz={tz}
            layout="card"
            previewRows={5}
          />
        </Row>
      </Zone>
    </div>
  );
}

import { notFound } from "next/navigation";
import { listBusinesses } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import type { PermissionKey } from "@/lib/permissions.generated";
import { PageHeader, type Crumb } from "@/components/page-header";
import { ActivityLogCard } from "@/components/activity-log-card";

export const dynamic = "force-dynamic";

/** Rows read per stream: the engine's list maximum. */
const FULL_LIMIT = 1000;

/**
 * The record types whose pages carry an Activity log card, with the permission each
 * of those pages requires, so the full log is never stricter or looser than its card.
 * `path` is the record page; a price needs its product id, so it gets no crumb.
 */
const RECORDS: Record<
  string,
  { noun: string; perm: PermissionKey; level: "ops" | "manager"; path?: string }
> = {
  customer: { noun: "customer", perm: "customers:view", level: "manager", path: "customers" },
  subscription: {
    noun: "subscription",
    perm: "subscriptions:view",
    level: "ops",
    path: "subscriptions",
  },
  invoice: { noun: "invoice", perm: "invoices:view", level: "ops", path: "invoices" },
  credit_note: {
    noun: "credit note",
    perm: "credit_notes:view",
    level: "ops",
    path: "credit_notes",
  },
  coupon: { noun: "coupon", perm: "coupons:view", level: "manager", path: "catalog/coupons" },
  coupon_set: {
    noun: "coupon set",
    perm: "coupons:view",
    level: "manager",
    path: "catalog/coupon_sets",
  },
  product: { noun: "product", perm: "catalog:view", level: "manager", path: "catalog/products" },
  price: { noun: "price", perm: "catalog:view", level: "manager" },
  product_group: {
    noun: "product group",
    perm: "catalog:view",
    level: "manager",
    path: "catalog/product_groups",
  },
};

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? "";

export default async function ActivityLogPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{
    resource_type?: string | string[];
    resource_id?: string | string[];
    scope?: string | string[];
  }>;
}) {
  const [{ biz }, search] = await Promise.all([params, searchParams]);
  const resourceType = one(search.resource_type);
  const resourceId = one(search.resource_id);
  const scopeParam = one(search.scope) || "resource";
  const record = Object.hasOwn(RECORDS, resourceType) ? RECORDS[resourceType] : undefined;
  // Never an unscoped log: every part of the address must name one record.
  if (!record || !resourceId) notFound();
  if (scopeParam !== "resource" && scopeParam !== "customer") notFound();
  if (scopeParam === "customer" && resourceType !== "customer") notFound();
  const scope: "resource" | "customer" = scopeParam;

  await requirePermission(record.perm, record.level);

  const businesses = await listBusinesses().catch(() => null);
  const business = businesses?.data.find((b) => b.id === biz);
  const tz = business?.timezone ?? null;

  const breadcrumbs: Crumb[] = [{ label: business?.name ?? biz, href: `/businesses/${biz}` }];
  if (record.path) {
    breadcrumbs.push({
      label: resourceId,
      href: `/businesses/${biz}/${record.path}/${encodeURIComponent(resourceId)}`,
    });
  }
  breadcrumbs.push({ label: "Activity log" });

  return (
    <>
      <PageHeader
        title="Activity log"
        breadcrumbs={breadcrumbs}
        description={
          scope === "customer"
            ? "All activity for this customer and its subscriptions, invoices, credit notes and payments."
            : `All activity for this ${record.noun}.`
        }
      />
      <ActivityLogCard
        biz={biz}
        resourceType={resourceType}
        resourceId={resourceId}
        tz={tz}
        scope={scope}
        layout="card"
        limit={FULL_LIMIT}
        fullPage
      />
    </>
  );
}

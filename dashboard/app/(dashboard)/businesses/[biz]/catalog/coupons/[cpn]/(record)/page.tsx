import Link from "next/link";
import { Ticket } from "lucide-react";
import { listBusinesses, listCouponSets, listProducts, listSubscriptions } from "@/lib/api";
import { getCoupon } from "@/lib/api/coupons";
import { getCouponStats, listCouponRedemptions } from "@/lib/api/catalog-stats";
import { requirePermission } from "@/lib/session";
import { money, fmtDate } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { StatusChip, IdChip, Chip } from "@/components/patterns/chip";
import {
  FigureTile,
  FigureTiles,
  Facts,
  RecordCard,
  RecordCrumbs,
  RecordHeader,
  Row,
  Zone,
} from "@/components/patterns/record-page";
import { PageRefresh } from "@/components/patterns/page-refresh";
import { CouponMoreMenu } from "@/components/catalog/coupon-actions";
import { CouponScopeRow } from "@/components/catalog/coupon-scope";
import { EditMetadataDialog } from "@/components/catalog/edit-metadata-dialog";
import { ActivityLogCard } from "@/components/activity-log-card";
import { CommentsCard } from "@/components/comments/comments-card";
import { EmptyState, ErrorState } from "@/components/states";
import { cursorSource, HISTORY_PAGE } from "@/lib/cursor-source";
import { updateCouponMetadataAction } from "../../actions";
import { CouponRedemptionsCard, CouponSubscriptionsCard } from "./coupon-cards";
import type { CouponDetail } from "@/lib/api/coupons";

const ITEM_KINDS = ["plan", "addon", "charge"] as const;

export const dynamic = "force-dynamic";

const APPLY_ON_LABEL: Record<string, string> = {
  invoice_amount: "Invoice amount",
  each_specified_item: "Each specified item",
};

function discountLabel(c: CouponDetail): string {
  return c.kind === "percentage"
    ? `${(c.percent_off_bps ?? 0) / 100}%`
    : money(c.amount_off_minor ?? 0, c.currency ?? "USD");
}
function durationLabel(c: CouponDetail): string {
  if (c.duration_type === "once") return "One-time";
  if (c.duration_type === "forever") return "Forever";
  return c.duration_in_periods ? `${c.duration_in_periods} periods` : "Limited period";
}

export default async function CouponDetailPage({
  params,
}: {
  params: Promise<{ biz: string; cpn: string }>;
}) {
  await requirePermission("coupons:view", "manager");
  const { biz, cpn } = await params;

  let businesses, coupon;
  try {
    [businesses, coupon] = await Promise.all([listBusinesses(), getCoupon(biz, cpn)]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Coupon" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  if (!coupon) {
    return (
      <>
        <PageHeader title="Coupon" />
        <ErrorState description={`We could not find the coupon ${cpn}.`} />
      </>
    );
  }

  const bizName = businesses.data.find((b) => b.id === biz)?.name ?? biz;
  // Dates render in the business timezone, not UTC — the engine's term
  // boundaries are midnight in this zone (see components/business-tz).
  const tz = businesses.data.find((b) => b.id === biz)?.timezone ?? null;
  const listHref = `/businesses/${biz}/catalog/coupons`;
  const editHref = `${listHref}/${coupon.id}/edit`;
  const status = coupon.status ?? (coupon.active ? "active" : "archived");
  const title = coupon.name ?? coupon.code;
  const couponFilter = `coupon:is:${coupon.code}`;
  const subscriptionsHref = `/businesses/${biz}/subscriptions?filter=${encodeURIComponent(couponFilter)}`;

  // Everything below is supporting detail: each read degrades on its own so a failure
  // never takes the coupon itself down with it.
  const [products, subs, sets, stats, redemptions] = await Promise.all([
    listProducts(biz).catch(() => null),
    listSubscriptions(biz, undefined, {
      limit: HISTORY_PAGE,
      filters: [{ field: "coupon", op: "is", value: coupon.code }],
    }).catch(() => null),
    listCouponSets(biz).catch(() => null),
    getCouponStats(biz, coupon.id).catch(() => null),
    listCouponRedemptions(biz, coupon.id, { limit: HISTORY_PAGE }).catch(() => null),
  ]);
  // Names for the ids a `specific` constraint stores; the raw id still says what the scope is.
  const productNames: Record<string, string> = Object.fromEntries(
    (products?.data ?? []).map((p) => [p.id, p.name]),
  );
  // Sets carry the parent coupon's CODE.
  const couponSets = (sets?.data ?? []).filter((s) => s.coupon === coupon.code);
  // `item_constraints` is null unless apply_on is each_specified_item — the only mode in
  // which the engine consults them, so the rows are hidden rather than shown as vacuous.
  const scoped = coupon.apply_on === "each_specified_item";
  const perCustomer = (coupon as { max_redemptions_per_customer?: number | null })
    .max_redemptions_per_customer;
  const hasMetadata = Boolean(coupon.metadata && Object.keys(coupon.metadata).length);
  // Net of credit notes; a fully credited currency still shows (as 0) beside its gross.
  const grossBy = new Map((stats?.discount_gross ?? []).map((g) => [g.currency, g.amount_minor]));
  const reversedBy = new Map(
    (stats?.discount_reversed ?? []).map((g) => [g.currency, g.amount_minor]),
  );
  const given = (stats?.discount_given ?? []).filter(
    (g) => g.amount_minor !== 0 || (grossBy.get(g.currency) ?? 0) !== 0,
  );
  const reversedNote = given
    .filter((g) => (reversedBy.get(g.currency) ?? 0) !== 0)
    .map(
      (g) =>
        `${money(grossBy.get(g.currency) ?? 0, g.currency)} gross · ${money(reversedBy.get(g.currency) ?? 0, g.currency)} reversed`,
    )
    .join(", ");

  return (
    <div className="flex flex-col gap-4">
      <RecordCrumbs
        items={[
          { label: bizName, href: `/businesses/${biz}` },
          { label: "Product Catalog" },
          { label: "Coupons", href: listHref },
          { label: title },
        ]}
        right={<PageRefresh />}
      />

      <RecordHeader
        title={title}
        chips={
          <>
            <StatusChip status={status} />
            <Chip>{coupon.kind === "percentage" ? "Percentage" : "Fixed amount"}</Chip>
          </>
        }
        facts={[
          <IdChip key="code" id={coupon.code} />,
          coupon.invoice_name ? <>Invoice name “{coupon.invoice_name}”</> : null,
          durationLabel(coupon),
        ]}
        actions={
          <>
            <Button asChild>
              <Link href={editHref}>Edit coupon</Link>
            </Button>
            <CouponMoreMenu
              biz={biz}
              couponId={coupon.id}
              cloneHref={`${listHref}/new?clone=${coupon.id}`}
              subscriptionsHref={subscriptionsHref}
              backHref={listHref}
              active={coupon.active}
            />
          </>
        }
      />

      <FigureTiles cols={2}>
        <FigureTile
          label="Redemptions"
          value={String(coupon.times_redeemed)}
          note={coupon.max_redemptions != null ? `of ${coupon.max_redemptions} max` : "No limit"}
        />
        {stats ? (
          <FigureTile
            label="Discount given"
            value={
              given.length
                ? given.map((g) => money(g.amount_minor, g.currency)).join(" · ")
                : "None yet"
            }
            note={reversedNote || "To date, on invoices"}
          />
        ) : null}
      </FigureTiles>

      <Zone title="Coupon">
        <Row span="6/6">
          <RecordCard title="Discount details">
            <Facts
              rows={[
                {
                  label: "Discount",
                  value: <span className="font-medium">{discountLabel(coupon)}</span>,
                },
                coupon.currency ? { label: "Currency", value: coupon.currency } : null,
                {
                  label: "Apply on",
                  value: coupon.apply_on
                    ? (APPLY_ON_LABEL[coupon.apply_on] ?? coupon.apply_on)
                    : "Invoice amount",
                },
              ]}
            />
            {scoped ? (
              <dl className="mt-2 grid grid-cols-[40%_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                {ITEM_KINDS.map((k) => (
                  <CouponScopeRow
                    key={k}
                    facts
                    kind={k}
                    constraint={coupon.item_constraints?.find((c) => c.item_kind === k)}
                    names={productNames}
                    // The engine refuses a scope change once redeemed.
                    changeHref={
                      coupon.times_redeemed === 0 ? `${editHref}#item-constraints` : undefined
                    }
                  />
                ))}
              </dl>
            ) : null}
          </RecordCard>

          <RecordCard
            title="Details"
            actions={
              <Link href={editHref} className="text-primary hover:underline">
                Edit
              </Link>
            }
          >
            <Facts
              rows={[
                { label: "Status", value: <StatusChip status={status} /> },
                { label: "Invoice name", value: coupon.invoice_name || "—" },
                { label: "Duration", value: durationLabel(coupon) },
                {
                  label: "Max redemptions",
                  value: coupon.max_redemptions ?? "Unlimited",
                },
                perCustomer !== undefined
                  ? { label: "Max per customer", value: perCustomer ?? "Unlimited" }
                  : null,
                {
                  label: "Valid from",
                  value: coupon.valid_from ? fmtDate(coupon.valid_from, tz) : "—",
                },
                {
                  label: "Valid till",
                  value: coupon.redeem_by ? fmtDate(coupon.redeem_by, tz) : "Forever",
                },
                coupon.created_at
                  ? { label: "Created", value: fmtDate(coupon.created_at, tz) }
                  : null,
                {
                  label: "JSON Meta Data",
                  value: (
                    <span className="flex flex-wrap items-baseline gap-2">
                      {hasMetadata ? (
                        <span className="font-mono text-xs break-all">
                          {JSON.stringify(coupon.metadata)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      <EditMetadataDialog
                        action={updateCouponMetadataAction}
                        hidden={{ biz, cpn: coupon.id }}
                        metadata={coupon.metadata}
                      />
                    </span>
                  ),
                },
              ]}
            />
          </RecordCard>
        </Row>

        <Row span="8/4">
          <CouponSubscriptionsCard
            biz={biz}
            source={cursorSource(subs, "subscriptions", undefined, [couponFilter])}
            viewAllHref={subscriptionsHref}
          />
          {/* No "New coupon set" here: generating a set is a dialog on the Coupon sets
              list, not a component this page can place. */}
          <RecordCard
            id="coupon-sets"
            title="Coupon sets"
            meta={couponSets.length ? `${couponSets.length}` : undefined}
            flush={couponSets.length > 0}
          >
            {couponSets.length === 0 ? (
              <EmptyState
                icon={<Ticket />}
                title="No coupon sets"
                description="No coupon set uses this coupon as its parent."
              />
            ) : (
              <Table className="table-fixed max-lg:min-w-0">
                <colgroup>
                  {/* A 360px side card: the heads must fit whole, the set name truncates. */}
                  <col className="w-[46%]" />
                  <col className="w-[24%]" />
                  <col className="w-[30%]" />
                </colgroup>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">Set</TableHead>
                    <TableHead className="text-right">Codes</TableHead>
                    <TableHead className="pr-5 text-right">Redeemed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {couponSets.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="pl-5">
                        <Link
                          href={`/businesses/${biz}/catalog/coupon_sets/${s.id}`}
                          className="block truncate text-primary hover:underline"
                        >
                          {s.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{s.total_count}</TableCell>
                      <TableCell className="pr-5 text-right tabular-nums">
                        {s.redeemed_count}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </RecordCard>
        </Row>

        {redemptions ? (
          <Row span="12">
            <CouponRedemptionsCard
              biz={biz}
              tz={tz}
              source={cursorSource(redemptions, "coupon_redemptions", { coupon: coupon.id })}
            />
          </Row>
        ) : null}
      </Zone>

      <Zone title="Records">
        <Row span="8/4">
          <ActivityLogCard
            biz={biz}
            resourceType="coupon"
            resourceId={coupon.id}
            tz={tz}
            layout="card"
            previewRows={5}
          />
          <CommentsCard
            biz={biz}
            resourceType="coupon"
            resourceId={coupon.id}
            backPath={`${listHref}/${coupon.id}`}
            layout="card"
          />
        </Row>
      </Zone>
    </div>
  );
}

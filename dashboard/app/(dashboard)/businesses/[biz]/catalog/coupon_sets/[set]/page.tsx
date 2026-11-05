import Link from "next/link";
import { listBusinesses, listCouponSets, listCouponSetCodes } from "@/lib/api";
import { getCoupon } from "@/lib/api/coupons";
import { requirePermission } from "@/lib/session";
import { money, fmtDate } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/states";
import { IdChip } from "@/components/patterns/chip";
import {
  FigureTile,
  FigureTiles,
  RecordCrumbs,
  RecordHeader,
  Row,
  Zone,
} from "@/components/patterns/record-page";
import { PageRefresh } from "@/components/patterns/page-refresh";
import { MoreMenu, MoreSection } from "@/components/patterns/more-menu";
import { ActivityLogCard } from "@/components/activity-log-card";
import { CodesPanel } from "./codes-panel";
import { AddCodesDialog, DeleteUnusedCodesButton, RenameCouponSetDialog } from "./set-actions";

export const dynamic = "force-dynamic";

export default async function CouponSetDetailPage({
  params,
}: {
  params: Promise<{ biz: string; set: string }>;
}) {
  await requirePermission("coupons:view", "manager");
  const { biz, set } = await params;

  let businesses, sets, codes;
  try {
    [businesses, sets, codes] = await Promise.all([
      listBusinesses(),
      listCouponSets(biz),
      listCouponSetCodes(biz, set),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Coupon Set" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const business = businesses.data.find((b) => b.id === biz);
  const bizName = business?.name ?? biz;
  const tz = business?.timezone ?? null;
  const setRow = sets.data.find((s) => s.id === set);
  const title = setRow?.name ?? set;
  // The parent's name and discount are context only; a failed read keeps its code.
  const parent = setRow ? await getCoupon(biz, setRow.coupon).catch(() => null) : null;
  const parentHref = parent ? `/businesses/${biz}/catalog/coupons/${parent.id}` : null;
  const parentDiscount = parent
    ? parent.kind === "percentage"
      ? `${(parent.percent_off_bps ?? 0) / 100}% off`
      : `${money(parent.amount_off_minor ?? 0, parent.currency ?? "USD")} off`
    : null;

  // Server counts first: the local filter only sees the codes this page fetched.
  const count = (s: string) => codes.data.filter((c) => c.status === s).length;
  const total = setRow?.total_count ?? codes.data.length;
  const redeemed = setRow?.redeemed_count ?? count("redeemed");
  const unused = setRow?.unredeemed_count ?? count("not_redeemed");
  const archived = setRow?.archived_count ?? count("archived");
  const pct = total > 0 ? Math.round((redeemed / total) * 1000) / 10 : 0;

  return (
    <div className="flex flex-col gap-4">
      <RecordCrumbs
        items={[
          { label: bizName, href: `/businesses/${biz}` },
          { label: "Product Catalog" },
          { label: "Coupon Sets", href: `/businesses/${biz}/catalog/coupon_sets` },
          { label: title },
        ]}
        right={<PageRefresh />}
      />

      {/* No status chip: a coupon set has no status of its own. */}
      <RecordHeader
        title={title}
        facts={[
          <IdChip key="id" id={set} />,
          setRow ? (
            <span key="parent">
              Parent coupon{" "}
              {parentHref ? (
                <Link href={parentHref} className="text-primary hover:underline">
                  {parent?.name ?? setRow.coupon}
                </Link>
              ) : (
                <span className="font-mono">{setRow.coupon}</span>
              )}
            </span>
          ) : null,
          parentDiscount,
          setRow?.created_at ? `Created ${fmtDate(setRow.created_at, tz)}` : null,
        ]}
        actions={
          <>
            <AddCodesDialog biz={biz} set={set} />
            {setRow ? (
              <MoreMenu>
                <MoreSection heading="Coupon set">
                  {setRow ? <RenameCouponSetDialog biz={biz} set={set} name={setRow.name} /> : null}
                  {parentHref ? <Link href={parentHref}>View parent coupon</Link> : null}
                </MoreSection>
              </MoreMenu>
            ) : null}
          </>
        }
      />

      <FigureTiles cols={2}>
        {/* The split rides here: the codes list below may hold only the fetched page. */}
        <FigureTile
          label="Total codes"
          value={String(total)}
          note={`${unused} not redeemed · ${archived} archived`}
        />
        <FigureTile label="Redeemed" value={String(redeemed)} note={`${pct}% of codes`} />
      </FigureTiles>

      <Zone title="Codes">
        <Row span="12">
          <CodesPanel biz={biz} set={set} codes={codes.data} />
        </Row>
      </Zone>

      <Zone title="Records">
        <Row span="12">
          <ActivityLogCard
            biz={biz}
            resourceType="coupon_set"
            resourceId={set}
            tz={tz}
            layout="card"
            previewRows={5}
          />
        </Row>
      </Zone>

      <section
        id="danger"
        className="mt-4 flex scroll-mt-24 flex-col gap-3 rounded-xl border border-destructive/30 bg-card px-5 py-4 sm:flex-row sm:items-center"
      >
        <div className="flex-1">
          <p className="text-sm font-semibold text-destructive">
            Danger zone · Delete unused codes
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Deletes every code that is not redeemed. We keep redeemed codes and their subscriptions.
            You cannot undo this.
          </p>
        </div>
        <DeleteUnusedCodesButton biz={biz} set={set} unusedCount={unused} />
      </section>
    </div>
  );
}

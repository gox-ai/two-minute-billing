"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { MoreMenu, MoreSection } from "@/components/patterns/more-menu";
import { archiveCatalogItem, restoreCatalogItem } from "@/app/actions";

/** The coupon header's More menu: Clone, then Archive or Restore. */
export function CouponMoreMenu({
  biz,
  couponId,
  cloneHref,
  subscriptionsHref,
  backHref,
  active,
}: {
  biz: string;
  couponId: string;
  cloneHref: string;
  subscriptionsHref: string;
  backHref: string;
  active: boolean;
}) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  async function run() {
    const fn = active ? archiveCatalogItem : restoreCatalogItem;
    const res = await fn("coupons", biz, couponId);
    if (res.ok) {
      toast.success(active ? "Coupon archived." : "Coupon restored.");
      if (active) router.push(backHref);
      else router.refresh();
    } else {
      toast.error(res.error ?? "We could not complete the action.");
    }
  }

  return (
    <>
      <MoreMenu>
        <MoreSection heading="Coupon">
          <Link href={cloneHref}>Clone coupon</Link>
          <Link href={subscriptionsHref}>View subscriptions that use it</Link>
        </MoreSection>
        <MoreSection>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            className={active ? "text-destructive" : undefined}
          >
            {active ? "Archive coupon" : "Restore coupon"}
          </button>
        </MoreSection>
      </MoreMenu>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={active ? "Archive coupon?" : "Restore coupon?"}
        description={
          active
            ? "Active coupon lists do not show it, and customers cannot redeem it. Existing redemptions do not change. You can restore it later."
            : "It reappears in active coupon lists."
        }
        confirmLabel={active ? "Archive" : "Restore"}
        destructive={active}
        onConfirm={run}
      />
    </>
  );
}

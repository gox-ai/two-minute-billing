import { RecordCard } from "@/components/patterns/record-page";
import { listCoupons, type Coupon, type CustomerDiscount } from "@/lib/api";
import { money } from "@/lib/format";
import { plural } from "@/lib/labels";
import { fmtDate } from "@/lib/format-date";
import { AddCustomerCouponDialog, RemoveCustomerCouponButton } from "./customer-discounts-actions";

function offLabel(d: {
  kind: string;
  percent_off_bps: number | null;
  amount_off_minor: number | null;
  currency: string | null;
}): string {
  if (d.kind === "percentage") return `${(d.percent_off_bps ?? 0) / 100}% off`;
  return d.amount_off_minor != null && d.currency
    ? `${money(d.amount_off_minor, d.currency)} off`
    : "Fixed amount off";
}

/** What is left of a customer coupon, counted in invoices. */
function leftLabel(d: CustomerDiscount): string {
  if (d.remaining_invoices == null) return "Every invoice until removed";
  return `${plural(d.remaining_invoices, "invoice")} left`;
}

function couponOption(c: Coupon) {
  const dur =
    c.duration_type === "once"
      ? "1 invoice"
      : c.duration_type === "forever"
        ? "every invoice"
        : "limited number of invoices";
  return { value: c.code, label: `${c.name || c.code} · ${offLabel(c)}, ${dur}` };
}

/**
 * Coupons applied to the customer. They discount the customer's invoices: subscription
 * invoices, one-off invoices, purchases and automatic top-ups.
 */
export async function CustomerDiscountsCard({
  biz,
  cus,
  discounts,
  tz,
  canManage,
}: {
  biz: string;
  cus: string;
  discounts: CustomerDiscount[];
  tz?: string | null;
  canManage: boolean;
}) {
  const coupons = canManage ? await listCoupons(biz).catch(() => null) : null;
  const applied = new Set(discounts.map((d) => d.coupon));
  const options = (coupons?.data ?? [])
    .filter((c) => c.active && !applied.has(c.code))
    .map(couponOption);
  return (
    <RecordCard
      id="discounts"
      title="Coupons"
      meta={discounts.length ? plural(discounts.length, "coupon") : undefined}
      actions={
        canManage && coupons ? (
          <AddCustomerCouponDialog biz={biz} cus={cus} options={options} />
        ) : null
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          A coupon on the customer discounts their invoices: subscription invoices, one-off
          invoices, purchases and automatic top-ups. A fixed amount discounts only invoices in its
          currency.
        </p>
        {discounts.length === 0 ? (
          <p className="text-muted-foreground">This customer has no coupons.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border/60">
            {discounts.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="flex min-w-32 flex-1 flex-col">
                  <span className="font-medium">{d.coupon_name || d.coupon}</span>
                  <span className="text-xs text-muted-foreground">
                    {offLabel(d)} · {leftLabel(d)}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  Added {fmtDate(d.created_at, tz)}
                </span>
                {canManage ? (
                  <RemoveCustomerCouponButton biz={biz} cus={cus} discount={d.id} code={d.coupon} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </RecordCard>
  );
}

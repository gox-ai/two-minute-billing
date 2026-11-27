"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import {
  ListPage,
  createAction,
  type ListFilterField,
  type ListSegment,
  type ListPageHeader,
} from "@/components/patterns/list-page";
import { InfoCell } from "@/components/patterns/list-cells";
import { CouponRowMenu } from "@/components/catalog/coupon-row-menu";
import { EmptyState } from "@/components/states";
import { money } from "@/lib/format";
import { plural } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { Percent } from "lucide-react";
import type { CouponDetail } from "@/lib/api/coupons";

/** "15% for 3 periods", "₹500.00, forever", "50% once". */
function discountDetails(c: CouponDetail, fallback: string): string {
  const amount =
    c.kind === "percentage"
      ? `${(c.percent_off_bps ?? 0) / 100}%`
      : money(c.amount_off_minor ?? 0, c.currency ?? fallback);
  if (c.duration_type === "once") return `${amount} once`;
  if (c.duration_type === "forever") return `${amount}, forever`;
  return c.duration_in_periods
    ? `${amount} for ${plural(c.duration_in_periods, "period")}`
    : `${amount} for a limited period`;
}

/** Distinct, sorted select options from the loaded rows. */
function options(values: (string | null | undefined)[], label?: (v: string) => string) {
  return [...new Set(values.filter((v): v is string => !!v))]
    .sort()
    .map((v) => ({ value: v, label: label?.(v) ?? v }));
}

/** Coupons list on the shared `ListPage` chrome. */
export function CouponsTable({
  page,
  biz,
  rows,
  currency,
  topBarExtras,
}: {
  /** The page header, drawn by the list (see ListPage.page). */
  page?: ListPageHeader;
  biz: string;
  rows: CouponDetail[];
  currency: string;
  /** e.g. the show-archived toggle. */
  topBarExtras?: React.ReactNode;
}) {
  const columns = React.useMemo<ColumnDef<CouponDetail>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Coupon info",
        // `id` is the coupon code on this list (see the cell).
        meta: {
          exportAs: [
            { header: "Coupon code", value: (c) => c.id },
            { header: "Name", value: (c) => c.name ?? "" },
          ],
        },
        cell: ({ row }) => {
          const c = row.original;
          // `c.id` IS the code here — this list's serializer emits `id: c.code` and no
          // `code` key, so reading `c.code` left both lines of an unnamed coupon blank.
          return (
            <InfoCell
              status={c.status ?? (c.active ? "active" : "archived")}
              title={
                <span className={cn("block max-w-80 wrap-anywhere", !c.name && "font-mono")}>
                  {c.name ?? c.id}
                </span>
              }
              href={`/businesses/${biz}/catalog/coupons/${c.id}`}
              // An unnamed coupon already shows its code as the title.
              sub={c.name ? c.id : undefined}
            />
          );
        },
      },
      // No invoice-name, apply-on or valid-until columns: the list serializer does not emit them.
      {
        id: "discount",
        header: "Discount details",
        accessorFn: (c) => discountDetails(c, currency),
        cell: ({ row }) => (
          <span className="text-sm">{discountDetails(row.original, currency)}</span>
        ),
      },
      {
        id: "redeemed",
        header: "Redemptions",
        accessorFn: (c) => c.times_redeemed,
        cell: ({ row }) => (
          <span className="text-sm tabular-nums">
            {row.original.times_redeemed} of {row.original.max_redemptions ?? "unlimited"}
          </span>
        ),
      },
    ],
    [biz, currency],
  );

  const segments = React.useMemo<ListSegment<CouponDetail>[]>(
    () => [
      { id: "all", label: "All coupons" },
      { id: "active", label: "Active coupons", match: (c) => c.active },
      { id: "archived", label: "Archived coupons", match: (c) => !c.active },
      { id: "percentage", label: "Percentage discounts", match: (c) => c.kind === "percentage" },
      { id: "fixed", label: "Fixed-amount Discounts", match: (c) => c.kind !== "percentage" },
      // Was "With an Expiry Date", on `!!c.redeem_by` — a field this list's serializer
      // does not emit, so the view was permanently EMPTY under a label that promised
      // rows. `status` is emitted (the engine derives it from redeem_by/valid_from
      // against the business wall clock), so these two ask the same questions and can
      // actually answer them.
      { id: "expired", label: "Expired", match: (c) => c.status === "expired" },
      { id: "future", label: "Not started yet", match: (c) => c.status === "future" },
    ],
    [],
  );

  /**
   * ⚠ Only fields `serializeCoupon` in **src/api/portal-routes.ts** emits, because that
   * — not the richer serializer in `coupon-routes.ts` — is what backs
   * `GET /v1/businesses/:biz/coupons` and therefore this screen.
   *
   * Removed because the list row simply does not carry them, so each was a filter that
   * matched nothing while looking real: `code` (the serializer maps the code to `id`,
   * and emits no `code` key at all), `invoice_name`, `apply_on`, `redeem_by` and
   * `created_at`. They come back the day the list serializer carries them; adding them
   * back before that is the emails-`attempts` mistake again.
   */
  const filterFields = React.useMemo<ListFilterField<CouponDetail>[]>(
    () => [
      { id: "name", label: "Name", group: "Identity", value: (c) => c.name },
      // `id` IS the coupon code on this endpoint (`id: c.code`), which is why the label
      // says Code — the operator types the thing printed in the Coupon Info cell.
      { id: "id", label: "Coupon code", group: "Identity", value: (c) => c.id },
      {
        id: "status",
        label: "Status",
        type: "select",
        group: "Status",
        options: [
          { value: "future", label: "Not started yet" },
          { value: "active", label: "Active" },
          { value: "expired", label: "Expired" },
          { value: "archived", label: "Archived" },
        ],
        value: (c) => c.status,
      },
      { id: "active", label: "Active", type: "boolean", group: "Status", value: (c) => c.active },
      // Derived, not stored: a coupon nobody can redeem any more is the actionable
      // state, and `max_redemptions` null means unlimited (never exhausted).
      {
        id: "exhausted",
        label: "Redemptions exhausted",
        type: "boolean",
        group: "Status",
        value: (c) => c.max_redemptions != null && c.times_redeemed >= c.max_redemptions,
      },
      {
        id: "kind",
        label: "Discount type",
        type: "select",
        group: "Configuration",
        options: [
          { value: "percentage", label: "Percentage" },
          { value: "fixed_amount", label: "Fixed amount" },
        ],
        value: (c) => c.kind,
      },
      {
        id: "duration_type",
        label: "Duration",
        type: "select",
        group: "Configuration",
        options: options(rows.map((c) => c.duration_type)),
        value: (c) => c.duration_type,
      },
      {
        id: "percent_off_bps",
        label: "Percent off (basis points)",
        type: "number",
        group: "Amounts",
        hint: "1000 = 10%",
        value: (c) => c.percent_off_bps,
      },
      // `number`, not `money`: the coupon's own currency varies row to row, so no single
      // exponent is right for the whole list — see ListFilterType.
      {
        id: "amount_off_minor",
        label: "Amount off (minor units)",
        type: "number",
        group: "Amounts",
        value: (c) => c.amount_off_minor,
      },
      {
        id: "currency",
        label: "Currency",
        type: "select",
        group: "Amounts",
        options: options(rows.map((c) => c.currency)),
        value: (c) => c.currency,
      },
      {
        id: "times_redeemed",
        label: "Redemptions",
        type: "number",
        group: "Other",
        value: (c) => c.times_redeemed,
      },
      {
        id: "max_redemptions",
        label: "Redemption limit",
        type: "number",
        group: "Other",
        hint: "If empty, there is no limit",
        value: (c) => c.max_redemptions,
      },
    ],
    [rows],
  );

  return (
    <ListPage
      page={page}
      entity={{ singular: "Coupon", plural: "Coupons" }}
      columns={columns}
      data={rows}
      segments={segments}
      filterFields={filterFields}
      savedViews={{ entity: "coupons", biz }}
      createAction={createAction("Coupon", `/businesses/${biz}/catalog/coupons/new`)}
      topBarExtras={topBarExtras}
      searchPlaceholder="Search by ID or name"
      exportName="coupons"
      bulkExportHref={`/businesses/${biz}/imports?tab=export&section=coupons`}
      persistKey={`coupons:${biz}`}
      rowHref={(c) => `/businesses/${biz}/catalog/coupons/${c.id}`}
      rowMenu={(c) => <CouponRowMenu biz={biz} id={c.id} label={c.id} active={c.active} />}
      // No Created At column in the coupon list — sort by the code instead.
      defaultSort={{ id: "name", desc: false }}
      emptyState={
        <EmptyState
          icon={<Percent />}
          title="No coupons"
          description="No coupons match this view, filter or search."
        />
      }
    />
  );
}

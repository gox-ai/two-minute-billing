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
import { InfoCell, TextCell } from "@/components/patterns/list-cells";
import { CouponRowMenu } from "@/components/catalog/coupon-row-menu";
import { EmptyState } from "@/components/states";
import { money, fmtDateShort, couponDurationLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Percent } from "lucide-react";
import type { CouponDetail } from "@/lib/api/coupons";
import { moneyCell } from "@/lib/table-export";
import { useBusinessTz } from "@/components/business-tz";

const APPLY_ON_LABEL: Record<string, string> = {
  invoice_amount: "Invoice amount",
  each_specified_item: "Each specified item",
};

const durationSuffix = (c: CouponDetail): string =>
  couponDurationLabel(c.duration_type, c.duration_in_periods);
function discountDetails(c: CouponDetail, fallback: string): string {
  const amount =
    c.kind === "percentage"
      ? `${(c.percent_off_bps ?? 0) / 100}%`
      : money(c.amount_off_minor ?? 0, c.currency ?? fallback);
  return `${amount} for ${durationSuffix(c)}`;
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
  // Dates render in the business timezone, not UTC (see components/business-tz).
  const tz = useBusinessTz();
  const columns = React.useMemo<ColumnDef<CouponDetail>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Coupon Info",
        // `id` is the coupon code on this list (see the cell).
        meta: {
          exportAs: [
            { header: "Coupon Code", value: (c) => c.id },
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
      {
        id: "invoice_name",
        header: "Invoice Name",
        accessorFn: (c) => c.invoice_name ?? "",
        cell: ({ row }) => (
          <span className="block max-w-80 text-sm wrap-anywhere">
            {row.original.invoice_name || "—"}
          </span>
        ),
      },
      {
        id: "apply_on",
        header: "Apply On",
        accessorFn: (c) => c.apply_on ?? "",
        // Blank, not "Invoice amount". `GET /v1/businesses/:biz/coupons` is served by
        // `serializeCoupon` in src/api/portal-routes.ts, which does NOT emit `apply_on`
        // — so this cell printed a fabricated default on every row, which CLAUDE.md
        // forbids outright ("never preselect a fake default"). The column stays; it
        // fills in the moment the list serializer carries the field (the WRITE
        // serializer in coupon-routes.ts already does).
        cell: ({ row }) => (
          <TextCell>
            {row.original.apply_on
              ? (APPLY_ON_LABEL[row.original.apply_on] ?? row.original.apply_on)
              : null}
          </TextCell>
        ),
      },
      {
        id: "discount",
        header: "Discount Details",
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
      {
        id: "valid_till",
        header: "Valid Till",
        accessorFn: (c) => c.redeem_by ?? "",
        cell: ({ row }) => (
          <TextCell className="tabular-nums">
            {row.original.redeem_by ? fmtDateShort(row.original.redeem_by, tz) : null}
          </TextCell>
        ),
      },
    ],
    [biz, currency],
  );

  const segments = React.useMemo<ListSegment<CouponDetail>[]>(
    () => [
      { id: "all", label: "All Coupons" },
      { id: "active", label: "Active Coupons", match: (c) => c.active },
      { id: "archived", label: "Archived Coupons", match: (c) => !c.active },
      { id: "percentage", label: "Percentage Discounts", match: (c) => c.kind === "percentage" },
      { id: "fixed", label: "Fixed-amount Discounts", match: (c) => c.kind !== "percentage" },
      // Was "With an Expiry Date", on `!!c.redeem_by` — a field this list's serializer
      // does not emit, so the view was permanently EMPTY under a label that promised
      // rows. `status` is emitted (the engine derives it from redeem_by/valid_from
      // against the business wall clock), so these two ask the same questions and can
      // actually answer them.
      { id: "expired", label: "Expired", match: (c) => c.status === "expired" },
      { id: "future", label: "Not Started Yet", match: (c) => c.status === "future" },
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
      { id: "id", label: "Coupon Code", group: "Identity", value: (c) => c.id },
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
        label: "Discount Type",
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
      searchPlaceholder="Search for ID / Name…"
      exportName="coupons"
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

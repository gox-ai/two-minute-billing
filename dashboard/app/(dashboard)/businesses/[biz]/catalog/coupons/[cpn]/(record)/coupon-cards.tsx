"use client";

import * as React from "react";
import Link from "next/link";
import { History, Layers } from "lucide-react";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { StatusChip } from "@/components/patterns/chip";
import { EmptyState } from "@/components/states";
import { RecordCard } from "@/components/patterns/record-page";
import { Pager, useCursorPages, type CursorSource } from "@/components/patterns/pager";
import { HISTORY_PAGE } from "@/lib/cursor-source";
import { money, fmtDate } from "@/lib/format";
import type { Subscription } from "@/lib/api";
import type { CouponRedemption } from "@/lib/api/catalog-stats";

/**
 * Subscriptions whose ACTIVE discount is this coupon — the list's `coupon[is]` filter,
 * paged through /api/lists/subscriptions.
 */
export function CouponSubscriptionsCard({
  biz,
  source,
  viewAllHref,
}: {
  biz: string;
  source: CursorSource<Subscription>;
  viewAllHref: string;
}) {
  const page = useCursorPages(biz, source, HISTORY_PAGE);
  const total = page.pager.total;
  return (
    <RecordCard
      id="subscriptions"
      title="Subscriptions using this coupon"
      meta={total != null && total > 0 ? `${total} with it applied` : undefined}
      actions={
        source.rows.length ? (
          <Link href={viewAllHref} className="text-primary hover:underline">
            View all
          </Link>
        ) : undefined
      }
      flush={source.rows.length > 0}
    >
      {source.rows.length === 0 ? (
        <EmptyState
          icon={<Layers />}
          title="No subscriptions"
          description="No subscription has this coupon applied right now."
        />
      ) : (
        <>
          <Table className="table-fixed max-lg:min-w-2xl">
            <colgroup>
              {/* At the 672px floor "non renewing" and a 5-figure MRR still fit whole. */}
              <col className="w-[30%]" />
              <col className="w-[28%]" />
              <col className="w-[21%]" />
              <col className="w-[21%]" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Subscription</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-5 text-right">MRR</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.rows.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="pl-5">
                    <Link
                      href={`/businesses/${biz}/subscriptions/${s.id}`}
                      className="block truncate font-mono text-xs text-primary hover:underline"
                    >
                      {s.id}
                    </Link>
                  </TableCell>
                  <TableCell className="truncate">
                    {s.customer ? (
                      <Link
                        href={`/businesses/${biz}/customers/${s.customer}`}
                        className="hover:underline"
                        title={s.customer_email ?? s.customer}
                      >
                        {s.customer_name || s.customer_email || s.customer}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusChip status={s.status} />
                  </TableCell>
                  <TableCell className="pr-5 text-right tabular-nums">
                    {s.mrr != null ? money(s.mrr, s.currency) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager pager={page.pager} />
        </>
      )}
    </RecordCard>
  );
}

/** Every time this coupon was applied, newest first, paged through /api/lists. */
export function CouponRedemptionsCard({
  biz,
  source,
  tz,
}: {
  biz: string;
  source: CursorSource<CouponRedemption>;
  tz: string | null;
}) {
  const page = useCursorPages(biz, source, HISTORY_PAGE);
  return (
    <RecordCard
      id="redemptions"
      title="Redemption history"
      meta={page.pager.total ? `${page.pager.total} redemptions` : undefined}
      flush={source.rows.length > 0}
    >
      {source.rows.length === 0 ? (
        <EmptyState
          icon={<History />}
          title="No redemptions"
          description="This coupon has no redemptions yet."
        />
      ) : (
        <>
          <Table className="table-fixed max-lg:min-w-2xl">
            <colgroup>
              {/* Ids truncate; the amount and date keep their whole width. */}
              <col className="w-[17%]" />
              <col className="w-[16%]" />
              <col className="w-[15%]" />
              <col className="w-[17%]" />
              <col className="w-[13%]" />
              <col className="w-[22%]" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Subscription</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead className="text-right">Discount</TableHead>
                <TableHead>Periods left</TableHead>
                <TableHead className="pr-5">Applied</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="pl-5">
                    {r.subscription ? (
                      <Link
                        href={`/businesses/${biz}/subscriptions/${r.subscription}`}
                        className="block truncate font-mono text-xs text-primary hover:underline"
                      >
                        {r.subscription}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/businesses/${biz}/customers/${r.customer}`}
                      className="block truncate font-mono text-xs text-primary hover:underline"
                    >
                      {r.customer}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {r.invoice ? (
                      <Link
                        href={`/businesses/${biz}/invoices/${r.invoice}`}
                        className="block truncate font-mono text-xs text-primary hover:underline"
                      >
                        {r.invoice}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(r.discount_minor, r.currency)}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {r.status === "removed" ? (
                      <span className="text-muted-foreground">Removed</span>
                    ) : r.remaining_periods == null ? (
                      "Forever"
                    ) : (
                      r.remaining_periods
                    )}
                  </TableCell>
                  <TableCell className="pr-5 tabular-nums">{fmtDate(r.redeemed_at, tz)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager pager={page.pager} />
        </>
      )}
    </RecordCard>
  );
}

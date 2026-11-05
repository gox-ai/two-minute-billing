"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Archive, Download, Ticket } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Chip } from "@/components/patterns/chip";
import { RecordCard } from "@/components/patterns/record-page";
import { Pager, useLocalPages } from "@/components/patterns/pager";
import { EmptyState } from "@/components/states";
import { fmtDateTime } from "@/lib/format";
import { archiveCouponCodeAction } from "@/app/(dashboard)/businesses/[biz]/catalog/coupon_sets/actions";
import type { CouponCode } from "@/lib/api/coupons";
import { useBusinessTz } from "@/components/business-tz";
import { SelectField } from "@/components/ui/select-field";

type StatusFilter = "all" | "not_redeemed" | "redeemed" | "archived";

const CODE_STATUS: Record<string, { label: string; tone: "green" | "blue" | "gray" }> = {
  not_redeemed: { label: "Not redeemed", tone: "blue" },
  redeemed: { label: "Redeemed", tone: "green" },
  archived: { label: "Archived", tone: "gray" },
};

/** The set's codes: search, status filter, CSV export, archive per unredeemed code. */
export function CodesPanel({ biz, set, codes }: { biz: string; set: string; codes: CouponCode[] }) {
  // Dates render in the business timezone, not UTC (see components/business-tz).
  const tz = useBusinessTz();
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [q, setQ] = React.useState("");
  const [archiving, setArchiving] = React.useState<string | null>(null);

  const filtered = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return codes.filter(
      (c) =>
        (statusFilter === "all" || c.status === statusFilter) &&
        (!needle || c.code.toLowerCase().includes(needle)),
    );
  }, [codes, statusFilter, q]);
  const page = useLocalPages(filtered, 10);

  const exportHref =
    `/api/coupon_sets/${encodeURIComponent(set)}/export?biz=${encodeURIComponent(biz)}` +
    (statusFilter === "all" ? "" : `&status=${statusFilter}`);

  async function confirmArchive() {
    if (!archiving) return;
    const fd = new FormData();
    fd.set("biz", biz);
    fd.set("set", set);
    fd.set("code", archiving);
    const res = await archiveCouponCodeAction(null, fd);
    if (res.ok) toast.success(res.message ?? "Code archived");
    else toast.error(res.message ?? "We could not archive the code.");
  }

  return (
    <RecordCard
      id="codes"
      title="Codes"
      meta={filtered.length !== codes.length ? `${filtered.length} of ${codes.length}` : undefined}
      actions={
        <>
          <Button asChild variant="outline" size="sm">
            <a href={exportHref} download>
              <Download aria-hidden className="size-4" />
              Export CSV
            </a>
          </Button>
          <Input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              page.reset();
            }}
            placeholder="Search codes…"
            aria-label="Search codes"
            className="h-8 w-44"
          />
          <SelectField
            ariaLabel="Filter by status"
            size="sm"
            value={statusFilter}
            onValueChange={(v) => {
              setStatusFilter(v as StatusFilter);
              page.reset();
            }}
            className="w-40"
            options={[
              { value: "all", label: "All statuses" },
              { value: "not_redeemed", label: "Not redeemed" },
              { value: "redeemed", label: "Redeemed" },
              { value: "archived", label: "Archived" },
            ]}
          />
        </>
      }
      flush={filtered.length > 0}
    >
      {filtered.length === 0 ? (
        <EmptyState
          icon={<Ticket />}
          title="No codes"
          description={codes.length ? "No codes match this filter." : "This set has no codes yet."}
        />
      ) : (
        <>
          <Table className="table-fixed max-lg:min-w-2xl">
            <colgroup>
              <col className="w-[26%]" />
              <col className="w-[18%]" />
              <col className="w-[20%]" />
              <col />
              <col className="w-32" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Code</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Redeemed at</TableHead>
                <TableHead>Subscription</TableHead>
                <TableHead className="pr-5">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.rows.map((c) => {
                const st = CODE_STATUS[c.status];
                return (
                  <TableRow key={c.code}>
                    <TableCell className="truncate pl-5 font-mono text-xs" title={c.code}>
                      {c.code}
                    </TableCell>
                    <TableCell>
                      <Chip tone={st?.tone ?? "gray"}>{st?.label ?? c.status}</Chip>
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {c.redeemed_at ? fmtDateTime(c.redeemed_at, tz) : "—"}
                    </TableCell>
                    <TableCell>
                      {c.subscription ? (
                        <Link
                          href={`/businesses/${biz}/subscriptions/${c.subscription}`}
                          className="block truncate font-mono text-xs text-primary hover:underline"
                        >
                          {c.subscription}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="pr-5 text-right">
                      {c.status === "not_redeemed" ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => setArchiving(c.code)}
                        >
                          <Archive aria-hidden className="size-3.5" />
                          Archive
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <Pager pager={page.pager} />
        </>
      )}

      <ConfirmDialog
        open={!!archiving}
        onOpenChange={(o) => !o && setArchiving(null)}
        title="Archive code?"
        description={
          <>
            Customers cannot redeem code <span className="font-mono">{archiving}</span> after this.
            You cannot archive a redeemed code.
          </>
        }
        confirmLabel="Archive code"
        destructive
        onConfirm={confirmArchive}
      />
    </RecordCard>
  );
}

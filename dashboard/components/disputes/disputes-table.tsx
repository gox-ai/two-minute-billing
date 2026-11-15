"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import {
  ListPage,
  type ListFilterField,
  type ListSegment,
  type ListPageHeader,
} from "@/components/patterns/list-page";
import Link from "next/link";
import { IdCell, MoneyCell, TextCell, TruncateCell } from "@/components/patterns/list-cells";
import { CustomerInfoCell } from "@/components/patterns/customer-info-cell";
import { Chip } from "@/components/patterns/chip";
import { IdText } from "@/components/patterns/id-text";
import { gatewayObjectUrl, type GatewayCatalogEntry } from "@/components/gateways/gateway-meta";
import { EmptyState } from "@/components/states";
import { EditDrawer } from "@/components/edit-drawer";
import { Button } from "@/components/ui/button";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";
import { fmtDateTime } from "@/lib/format-date";
import type { Dispute } from "@/lib/api/disputes";
import { ShieldAlert } from "lucide-react";
import { useBusinessTz } from "@/components/business-tz";
import { disputeOutcomeNote, disputeReasonLabel, disputeStatusTone } from "@/lib/dispute-vocab";
import { moneyCell } from "@/lib/table-export";
import { DisputeOutcomeButtons } from "@/components/disputes/dispute-actions";

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="col-span-2 break-all">{children}</dd>
    </div>
  );
}

/** A related record in the drawer: a link when we matched it, a dash when we did not. */
function RecordLink({
  href,
  mono = false,
  children,
}: {
  href: string | null;
  mono?: boolean;
  children: React.ReactNode;
}) {
  if (!href || !children) return <>—</>;
  return (
    <Link href={href} className={cn("text-primary hover:underline", mono && "font-mono text-xs")}>
      {children}
    </Link>
  );
}

/**
 * Disputes / chargebacks log with a detail drawer. A dispute the engine lets a person close
 * (`outcome_settable_by_operator`) takes its outcome there.
 */
export function DisputesTable({
  biz,
  rows,
  page,
  canManage = false,
  gatewayNames = {},
  gatewayCatalog = [],
  livemode = null,
}: {
  biz: string;
  rows: Dispute[];
  page?: ListPageHeader;
  /** Holds `payments:refund`: may set the outcome of a dispute. */
  canManage?: boolean;
  /** Gateway key → display name, from the catalogue. */
  gatewayNames?: Record<string, string>;
  /** Declares which gateway ids link to the gateway's dashboard. */
  gatewayCatalog?: GatewayCatalogEntry[];
  livemode?: "live" | "test" | null;
}) {
  // Dates render in the business timezone, not UTC (see components/business-tz).
  const tz = useBusinessTz();
  const base = `/businesses/${biz}`;
  // Keyed by id so a recorded outcome re-renders the open drawer from the refreshed rows.
  const [detailId, setDetailId] = React.useState<string | null>(null);
  const detail = detailId ? (rows.find((r) => r.id === detailId) ?? null) : null;
  const setDetail = (d: Dispute | null) => setDetailId(d?.id ?? null);

  const columns = React.useMemo<ColumnDef<Dispute>[]>(
    () => [
      {
        id: "created_at",
        header: "Opened",
        accessorFn: (r) => r.opened_at ?? "",
        cell: ({ row }) => <TextCell>{fmtDateTime(row.original.opened_at, tz)}</TextCell>,
      },
      // Null on a dispute that matches no payment of ours: the gateway named a charge we
      // did not take, or one taken before the business moved here.
      {
        id: "customer",
        header: "Customer",
        accessorFn: (r) => r.customer_name ?? r.customer ?? "",
        meta: { phone: "title" },
        cell: ({ row }) => {
          const d = row.original;
          if (!d.customer) return <TextCell>{null}</TextCell>;
          return (
            <CustomerInfoCell
              id={d.customer}
              name={d.customer_name}
              href={`${base}/customers/${d.customer}`}
            />
          );
        },
      },
      {
        id: "subscription",
        header: "Subscription",
        accessorFn: (r) => r.subscription ?? "",
        cell: ({ row }) => (
          <IdCell
            id={row.original.subscription}
            href={
              row.original.subscription
                ? `${base}/subscriptions/${row.original.subscription}`
                : undefined
            }
          />
        ),
      },
      {
        id: "invoice",
        header: "Invoice",
        accessorFn: (r) => r.invoice_number ?? r.invoice ?? "",
        cell: ({ row }) => (
          <IdCell
            id={row.original.invoice_number ?? row.original.invoice}
            plain={!!row.original.invoice_number}
            href={row.original.invoice ? `${base}/invoices/${row.original.invoice}` : undefined}
          />
        ),
      },
      {
        id: "amount",
        header: "Amount",
        accessorFn: (r) => r.amount_minor,
        meta: {
          align: "right",
          phone: "aside",
          exportAs: [
            moneyCell<Dispute>(
              "Amount",
              (r) => r.amount_minor,
              (r) => r.currency,
            ),
            { header: "Currency", value: (r) => r.currency ?? "" },
          ],
        },
        cell: ({ row }) => (
          <MoneyCell minor={row.original.amount_minor} currency={row.original.currency} />
        ),
      },
      {
        id: "reason",
        header: "Reason",
        meta: { grow: true },
        accessorFn: (r) => disputeReasonLabel(r.reason),
        cell: ({ row }) => (
          <TruncateCell
            value={disputeReasonLabel(row.original.reason)}
            width="max-w-md"
            className="text-foreground"
          />
        ),
      },
      {
        accessorKey: "provider_key",
        header: "Gateway",
        cell: ({ row }) => (
          <span className="text-sm">
            {gatewayNames[row.original.provider_key] ?? row.original.provider_key}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (r) => r.status,
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <Chip tone={disputeStatusTone(row.original.status)} className="uppercase">
              {row.original.status.replace(/_/g, " ")}
            </Chip>
            {row.original.funds_withdrawn ? (
              <Chip tone="tan" className="text-xs">
                funds held
              </Chip>
            ) : null}
          </span>
        ),
      },
      {
        id: "evidence_due_by",
        header: "Evidence due",
        accessorFn: (r) => r.evidence_due_by ?? "",
        cell: ({ row }) => <TextCell>{fmtDateTime(row.original.evidence_due_by, tz)}</TextCell>,
      },
    ],
    [tz, gatewayNames, base],
  );

  const segments = React.useMemo<ListSegment<Dispute>[]>(
    () => [
      { id: "all", label: "All disputes" },
      {
        id: "needs_response",
        label: "Needs response",
        match: (d) => d.status === "needs_response",
      },
      { id: "under_review", label: "Under review", match: (d) => d.status === "under_review" },
      { id: "won", label: "Won", match: (d) => d.status === "won" },
      { id: "lost", label: "Lost", match: (d) => d.status === "lost" },
      { id: "funds_held", label: "Funds withdrawn", match: (d) => !!d.funds_withdrawn },
      // `closed_at` is stamped only by a terminal gateway event, so "not closed" is the
      // live caseload — bigger than needs_response alone, which excludes under_review.
      { id: "open", label: "Still open", match: (d) => !d.closed_at },
      // The deadline actually passed while we still owe evidence. Read against the
      // browser clock, which is right for a due-date question an operator is asking now.
      {
        id: "overdue",
        label: "Evidence overdue",
        match: (d) =>
          d.status === "needs_response" &&
          !!d.evidence_due_by &&
          Date.parse(d.evidence_due_by) < Date.now(),
      },
    ],
    [],
  );

  /** The whole of `serializeDispute` (src/modules/disputes/service.ts). */
  const filterFields = React.useMemo<ListFilterField<Dispute>[]>(
    () => [
      { id: "id", label: "Dispute ID", group: "Identity", value: (d) => d.id },
      {
        id: "status",
        label: "Status",
        type: "select",
        group: "Status",
        options: [...new Set(rows.map((d) => d.status))]
          .sort()
          .map((v) => ({ value: v, label: v.replace(/_/g, " ") })),
        value: (d) => d.status,
      },
      { id: "reason", label: "Reason", group: "Status", value: (d) => d.reason },
      {
        id: "source",
        label: "Reported by",
        type: "select",
        group: "Status",
        options: [
          { value: "gateway", label: "Gateway" },
          { value: "operator", label: "Recorded by hand" },
        ],
        value: (d) => d.source,
      },
      {
        id: "funds_withdrawn",
        label: "Funds withdrawn",
        type: "boolean",
        group: "Status",
        value: (d) => !!d.funds_withdrawn,
      },
      // Derived from `closed_at`, which no column shows — the drawer does.
      {
        id: "open",
        label: "Still open",
        type: "boolean",
        group: "Status",
        value: (d) => !d.closed_at,
      },
      { id: "customer", label: "Customer ID", group: "Customer", value: (d) => d.customer },
      {
        id: "customer_name",
        label: "Customer name",
        group: "Customer",
        value: (d) => d.customer_name,
      },
      {
        id: "subscription",
        label: "Subscription ID",
        group: "Customer",
        value: (d) => d.subscription,
      },
      // `number`, not `money`: each dispute carries its own currency, so no single
      // exponent is right for the whole list.
      {
        id: "amount_minor",
        label: "Amount (minor units)",
        type: "number",
        group: "Amounts",
        value: (d) => d.amount_minor,
      },
      {
        id: "currency",
        label: "Currency",
        type: "select",
        group: "Amounts",
        options: [...new Set(rows.map((d) => d.currency))]
          .sort()
          .map((v) => ({ value: v, label: v })),
        value: (d) => d.currency,
      },
      {
        id: "provider_key",
        label: "Gateway",
        type: "select",
        group: "Gateway",
        options: [...new Set(rows.map((d) => d.provider_key))]
          .sort()
          .map((v) => ({ value: v, label: v })),
        value: (d) => d.provider_key,
      },
      // The gateway's own ids — what you paste in from a provider dashboard.
      {
        id: "provider_dispute_id",
        label: "Provider dispute ID",
        group: "Gateway",
        value: (d) => d.provider_dispute_id,
      },
      {
        id: "provider_charge_id",
        label: "Provider charge ID",
        group: "Gateway",
        value: (d) => d.provider_charge_id,
      },
      { id: "invoice", label: "Invoice ID", group: "Other", value: (d) => d.invoice },
      {
        id: "invoice_number",
        label: "Invoice number",
        group: "Other",
        value: (d) => d.invoice_number,
      },
      { id: "transaction", label: "Transaction ID", group: "Other", value: (d) => d.transaction },
      { id: "opened_at", label: "Opened", type: "date", group: "Dates", value: (d) => d.opened_at },
      {
        id: "evidence_due_by",
        label: "Evidence due",
        type: "date",
        group: "Dates",
        value: (d) => d.evidence_due_by,
      },
      { id: "closed_at", label: "Closed", type: "date", group: "Dates", value: (d) => d.closed_at },
      {
        id: "created_at",
        label: "Recorded",
        type: "date",
        group: "Dates",
        hint: "When we recorded the dispute. This is not the date when the dispute opened",
        value: (d) => d.created_at,
      },
    ],
    [rows],
  );

  return (
    <>
      <ListPage
        page={page}
        entity={{ singular: "Dispute", plural: "Disputes" }}
        columns={columns}
        data={rows}
        segments={segments}
        filterFields={filterFields}
        savedViews={{ entity: "disputes", biz }}
        searchPlaceholder="Search by reason, gateway or status"
        exportName="disputes"
        persistKey={`disputes:${biz}`}
        // The drawer shows the invoice; the list leads with who and which subscription.
        initialHidden={["invoice"]}
        rowMenu={(d) => (
          <Button variant="ghost" size="sm" onClick={() => setDetail(d)}>
            Inspect
          </Button>
        )}
        emptyState={
          <EmptyState
            icon={<ShieldAlert />}
            title="No disputes"
            description="A dispute shows here when a customer contests a payment with their bank or card issuer."
          />
        }
      />

      <EditDrawer
        open={!!detail}
        onOpenChange={(o) => !o && setDetail(null)}
        title={detail ? `Dispute ${money(detail.amount_minor, detail.currency)}` : "Dispute"}
        description={detail ? disputeReasonLabel(detail.reason) : undefined}
      >
        {detail ? (
          <div className="space-y-4 pb-6">
            <dl className="divide-y">
              <DetailRow label="Status">
                <Chip tone={disputeStatusTone(detail.status)} className="uppercase">
                  {detail.status.replace(/_/g, " ")}
                </Chip>
              </DetailRow>
              <DetailRow label="Amount">{money(detail.amount_minor, detail.currency)}</DetailRow>
              <DetailRow label="Reason">{disputeReasonLabel(detail.reason)}</DetailRow>
              <DetailRow label="Reported by">
                {detail.source === "operator" ? "Recorded by hand" : "Gateway"}
              </DetailRow>
              {detail.source === "operator" ? (
                <DetailRow label="Processor reference">
                  {detail.processor_reference ?? "—"}
                </DetailRow>
              ) : null}
              <DetailRow label="Funds withdrawn">
                {detail.funds_withdrawn ? "Yes. The ledger holds the funds." : "No"}
              </DetailRow>
              <DetailRow label="Gateway">
                {gatewayNames[detail.provider_key] ?? detail.provider_key}
              </DetailRow>
              <DetailRow label="Provider dispute id">
                {detail.provider_dispute_id ? (
                  <IdText
                    id={detail.provider_dispute_id}
                    href={gatewayObjectUrl(
                      gatewayCatalog,
                      detail.provider_key,
                      detail.provider_dispute_id,
                      livemode,
                    )}
                  />
                ) : (
                  "—"
                )}
              </DetailRow>
              <DetailRow label="Provider charge id">
                {detail.provider_charge_id ? (
                  <IdText
                    id={detail.provider_charge_id}
                    href={gatewayObjectUrl(
                      gatewayCatalog,
                      detail.provider_key,
                      detail.provider_charge_id,
                      livemode,
                    )}
                  />
                ) : (
                  "—"
                )}
              </DetailRow>
              <DetailRow label="Customer">
                <RecordLink href={detail.customer && `${base}/customers/${detail.customer}`}>
                  {detail.customer_name ?? detail.customer}
                </RecordLink>
              </DetailRow>
              <DetailRow label="Subscription">
                <RecordLink
                  href={detail.subscription && `${base}/subscriptions/${detail.subscription}`}
                  mono
                >
                  {detail.subscription}
                </RecordLink>
              </DetailRow>
              <DetailRow label="Invoice">
                <RecordLink
                  href={detail.invoice && `${base}/invoices/${detail.invoice}`}
                  mono={!detail.invoice_number}
                >
                  {detail.invoice_number ?? detail.invoice}
                </RecordLink>
              </DetailRow>
              <DetailRow label="Transaction">
                <RecordLink
                  href={detail.transaction && `${base}/transactions/${detail.transaction}`}
                  mono
                >
                  {detail.transaction}
                </RecordLink>
              </DetailRow>
              <DetailRow label="Evidence due">{fmtDateTime(detail.evidence_due_by, tz)}</DetailRow>
              <DetailRow label="Opened">{fmtDateTime(detail.opened_at, tz)}</DetailRow>
              <DetailRow label="Closed">{fmtDateTime(detail.closed_at, tz)}</DetailRow>
            </dl>
            {canManage && detail.outcome_settable_by_operator ? (
              <div className="space-y-3">
                {detail.source === "gateway" ? (
                  <p className="text-sm text-muted-foreground">
                    {disputeOutcomeNote(gatewayNames[detail.provider_key] ?? detail.provider_key)}
                  </p>
                ) : null}
                <DisputeOutcomeButtons
                  biz={biz}
                  dsp={detail.id}
                  amountMinor={detail.amount_minor}
                  currency={detail.currency}
                  fundsWithdrawn={detail.funds_withdrawn}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </EditDrawer>
    </>
  );
}

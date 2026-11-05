"use client";

import * as React from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { StatusChip } from "@/components/patterns/chip";
import { creditNoteChipStatus } from "@/lib/credit-note-status";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import type { Invoice, CreditNote } from "@/lib/api";
import type { Transaction } from "@/lib/api/payments";
import type { EventRecord } from "@/lib/api/developer";
import type { EmailMessage } from "@/lib/api/emails";
import { useBusinessTz } from "@/components/business-tz";
import { Button } from "@/components/ui/button";
import { EmailDetailDialog } from "@/components/emails/email-detail-dialog";
import { Pager, useCursorPages, type CursorSource } from "@/components/patterns/pager";
import { HISTORY_PAGE as PAGE } from "@/lib/cursor-source";

const NO_EVENTS: CursorSource<EventRecord> = {
  rows: [],
  hasMore: false,
  nextCursor: null,
  total: 0,
};

// "History" panel: a single tabbed widget spanning Invoices,
// Transactions, Credit Notes, Email Logs and Events. Each tab's first page is
// server-rendered (fetched with `limit: HISTORY_PAGE`); later pages come through
// `/api/lists`, so the key stays server-side.
export function CustomerHistory({
  biz,
  invoices,
  transactions,
  creditNotes,
  events,
  emails,
}: {
  biz: string;
  invoices: CursorSource<Invoice>;
  transactions: CursorSource<Transaction>;
  creditNotes: CursorSource<CreditNote>;
  /**
   * Raw event stream — type, source, and the record each event names. OPTIONAL
   * only because not every page has one to pass; the customer page passes its whole
   * footprint (subscriptions, invoices, payments), the subscription page its own.
   */
  events?: CursorSource<EventRecord>;
  /** Email Logs tab — billing emails addressed to this customer. */
  emails: CursorSource<EmailMessage>;
}) {
  const inv = useCursorPages(biz, invoices, PAGE);
  const txn = useCursorPages(biz, transactions, PAGE);
  const cns = useCursorPages(biz, creditNotes, PAGE);
  const mail = useCursorPages(biz, emails, PAGE);
  const evt = useCursorPages(biz, events ?? NO_EVENTS, PAGE);
  // Dates render in the business timezone, not UTC (see components/business-tz).
  const tz = useBusinessTz();
  const [openEmail, setOpenEmail] = React.useState<EmailMessage | null>(null);
  const multiResource = new Set(evt.rows.map((e) => e.resource?.id ?? "")).size > 1;
  return (
    <Tabs defaultValue="invoices">
      <TabsList className="flex-wrap justify-start group-data-[orientation=horizontal]/tabs:h-auto">
        <TabsTrigger value="invoices">Invoices{count(invoices)}</TabsTrigger>
        <TabsTrigger value="transactions">Transactions{count(transactions)}</TabsTrigger>
        <TabsTrigger value="credit-notes">Credit Notes{count(creditNotes)}</TabsTrigger>
        <TabsTrigger value="emails">Email Logs{count(emails)}</TabsTrigger>
        {events ? <TabsTrigger value="events">Events{count(events)}</TabsTrigger> : null}
      </TabsList>

      <TabsContent value="invoices" className="pt-3">
        {invoices.rows.length === 0 ? (
          <Empty>No invoice history.</Empty>
        ) : (
          <>
            {/* Fixed widths, like Transactions: the id truncates instead of scrolling. */}
            <Table className="table-fixed max-lg:min-w-2xl">
              <colgroup>
                <col />
                <col className="w-[20%]" />
                <col className="w-[15%]" />
                <col className="w-[21%]" />
                <col className="w-[17%]" />
              </colgroup>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Created on</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inv.rows.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>
                      <a
                        href={`/businesses/${biz}/invoices/${i.id}`}
                        title={i.id}
                        className="block truncate font-mono text-xs text-primary hover:underline"
                      >
                        {i.number ?? i.id}
                      </a>
                    </TableCell>
                    <TableCell>
                      <StatusChip status={i.status} />
                    </TableCell>
                    <TableCell>{i.subscription ? "Recurring" : "One-time"}</TableCell>
                    <TableCell>{i.created_at ? fmtDate(i.created_at, tz) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(i.total_minor, i.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pager pager={inv.pager} className="px-0" />
          </>
        )}
      </TabsContent>

      <TabsContent value="transactions" className="pt-3">
        {transactions.rows.length === 0 ? (
          <Empty>No transaction history.</Empty>
        ) : (
          <>
            {/* Fixed widths, like Email Logs: long ids truncate and dates wrap inside
                their column; the gateway sits under the type. */}
            <Table className="table-fixed max-lg:min-w-2xl">
              <colgroup>
                <col />
                <col className="w-[17%]" />
                {/* Fits "needs attention" whole. */}
                <col className="w-[22%]" />
                <col className="w-[15%]" />
                <col className="w-[17%]" />
              </colgroup>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Occurred on</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {txn.rows.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <a
                        href={`/businesses/${biz}/transactions/${t.id}`}
                        title={t.id}
                        className="block truncate font-mono text-xs text-primary hover:underline"
                      >
                        {t.id}
                      </a>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {t.occurred_at
                        ? fmtDateTime(t.occurred_at, tz)
                        : fmtDateTime(t.created_at, tz)}
                    </TableCell>
                    <TableCell>
                      <StatusChip status={t.status} />
                    </TableCell>
                    <TableCell className="py-2.5 whitespace-normal">
                      <div className="capitalize">{t.type.replace(/_/g, " ")}</div>
                      {t.gateway_key ? (
                        <div
                          className="truncate text-xs text-muted-foreground"
                          title={t.gateway_key}
                        >
                          {t.gateway_key}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(t.amount_minor, t.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pager pager={txn.pager} className="px-0" />
          </>
        )}
      </TabsContent>

      <TabsContent value="credit-notes" className="pt-3">
        {creditNotes.rows.length === 0 ? (
          <Empty>No credit note history.</Empty>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Credit note</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Created on</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cns.rows.map((c) => (
                  <TableRow key={c.id}>
                    {/* Links out like the Invoices/Transactions tabs above — this was the
                      only ID column in this panel rendered as dead text, so the credit
                      notes a customer holds were visible here but not reachable, and the
                      CN list has no customer filter to get there instead. */}
                    <TableCell>
                      <a
                        href={`/businesses/${biz}/credit_notes/${c.id}`}
                        title={c.id}
                        className="font-mono text-xs text-primary hover:underline"
                      >
                        {c.number ?? c.id}
                      </a>
                    </TableCell>
                    <TableCell>
                      <StatusChip status={creditNoteChipStatus(c)} />
                    </TableCell>
                    <TableCell>
                      <a
                        href={`/businesses/${biz}/invoices/${c.invoice}`}
                        title={c.invoice}
                        className="font-mono text-xs text-primary hover:underline"
                      >
                        {c.invoice_number ?? c.invoice}
                      </a>
                    </TableCell>
                    <TableCell>{fmtDate(c.created_at, tz)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(c.total_minor, c.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pager pager={cns.pager} className="px-0" />
          </>
        )}
      </TabsContent>

      {/* Email Logs — `status` is the QUEUE
          outcome, not proof of delivery: with no ESP configured the console sink
          marks rows 'sent' without anything leaving the box, so the column is
          labelled Status rather than Delivered. */}
      <TabsContent value="emails" className="pt-3">
        {emails.rows.length === 0 ? (
          <Empty>No email history.</Empty>
        ) : (
          <>
            {/* Fixed widths, so a long subject, address or error wraps or truncates
                inside its column instead of scrolling the table sideways. The address
                sits under the subject: it is the customer's own on nearly every row. */}
            <Table className="table-fixed">
              <colgroup>
                <col className="w-[18%]" />
                <col />
                <col className="w-[22%]" />
                <col className="w-[17%]" />
                <col className="w-20" />
              </colgroup>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Sent on</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mail.rows.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="whitespace-normal capitalize">
                      {m.type.replace(/_/g, " ")}
                    </TableCell>
                    <TableCell className="py-2.5">
                      <div className="truncate" title={m.subject}>
                        {m.subject}
                      </div>
                      <div
                        className="truncate font-mono text-xs text-muted-foreground"
                        title={m.to}
                      >
                        {m.to}
                      </div>
                    </TableCell>
                    <TableCell className="py-2.5">
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                        <StatusChip status={m.status} />
                        {m.attempts > 1 ? (
                          <span className="text-xs whitespace-nowrap text-muted-foreground">
                            {m.attempts} attempts
                          </span>
                        ) : null}
                      </div>
                      {/* A failed send is useless without the reason. */}
                      {m.last_error ? (
                        <div
                          className="mt-0.5 truncate text-xs text-destructive"
                          title={m.last_error}
                        >
                          {m.last_error}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {m.sent_at ? fmtDateTime(m.sent_at, tz) : fmtDateTime(m.created_at, tz)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => setOpenEmail(m)}>
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pager pager={mail.pager} className="px-0" />
          </>
        )}
      </TabsContent>

      {!events ? null : (
        <TabsContent value="events" className="pt-3">
          {evt.rows.length === 0 ? (
            <Empty>No event history.</Empty>
          ) : (
            <>
              {/* Fixed widths, like Email Logs: ids truncate, event types and dates wrap. */}
              <Table className="table-fixed">
                <colgroup>
                  <col />
                  <col className="w-[28%]" />
                  {multiResource ? <col className="w-[20%]" /> : null}
                  <col className="w-[13%]" />
                  <col className="w-[20%]" />
                </colgroup>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Type</TableHead>
                    {/* Only when the stream spans more than one record: a customer's
                      events cover its invoices and subscriptions, where the type alone
                      doesn't say which — a subscription's are all the same id. */}
                    {multiResource ? <TableHead>Resource</TableHead> : null}
                    <TableHead>Source</TableHead>
                    <TableHead>Occurred on</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {evt.rows.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>
                        <a
                          href={`/businesses/${biz}/events/${e.id}`}
                          title={e.id}
                          className="block truncate font-mono text-xs text-primary hover:underline"
                        >
                          {e.id}
                        </a>
                      </TableCell>
                      <TableCell className="wrap-anywhere whitespace-normal">{e.type}</TableCell>
                      {multiResource ? (
                        <TableCell
                          className="truncate font-mono text-xs"
                          title={e.resource?.id ?? undefined}
                        >
                          {e.resource?.id ?? "—"}
                        </TableCell>
                      ) : null}
                      <TableCell className="truncate" title={e.source ?? undefined}>
                        {e.source ?? "—"}
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        {fmtDateTime(e.occurred_at, tz)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pager pager={evt.pager} className="px-0" />
            </>
          )}
        </TabsContent>
      )}
      <EmailDetailDialog biz={biz} email={openEmail} onClose={() => setOpenEmail(null)} />
    </Tabs>
  );
}

/** The engine's count when it has one; else what is loaded, with "+" when there is more. */
function count<T>(src: CursorSource<T>) {
  const n = src.total ?? src.rows.length;
  if (!n) return null;
  return (
    <span className="ml-1.5 text-xs text-muted-foreground">
      ({n}
      {src.total == null && src.hasMore ? "+" : ""})
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-sm text-muted-foreground">{children}</p>;
}

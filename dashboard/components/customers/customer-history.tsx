"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { plural } from "@/lib/labels";
import { sourceLabel } from "@/components/audit/labels";
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
import { money } from "@/lib/format";
import { fmtDate, fmtDateTime } from "@/lib/format-date";
import type { Invoice, CreditNote } from "@/lib/api";
import type { PaymentIntentRow, Transaction } from "@/lib/api/payments";
import type { EventRecord } from "@/lib/api/developer";
import type { EmailMessage } from "@/lib/api/emails";
import { useBusinessTz } from "@/components/business-tz";
import { Button } from "@/components/ui/button";
import { EmailDetailDialog } from "@/components/emails/email-detail-dialog";
import { Pager, useCursorPages, type CursorSource } from "@/components/patterns/pager";
import { HISTORY_PAGE as PAGE } from "@/lib/cursor-source";
import { EmptyState } from "@/components/states";
import { MiddleEllipsis } from "@/components/patterns/id-text";
import { displayIntentStatus } from "@/lib/payment-intent-status";
import { IntentLastError, IntentPurposeChip } from "@/components/payments/payment-intents-table";

const NO_EVENTS: CursorSource<EventRecord> = {
  rows: [],
  hasMore: false,
  nextCursor: null,
  total: 0,
};
const NO_INTENTS: CursorSource<PaymentIntentRow> = { ...NO_EVENTS, rows: [] };

export type HistoryTab =
  | "invoices"
  | "transactions"
  | "payment-intents"
  | "credit-notes"
  | "emails"
  | "events";

const VIEW_ALL_LABEL: Record<HistoryTab, string> = {
  invoices: "View all invoices",
  transactions: "View all transactions",
  "payment-intents": "View all payment intents",
  "credit-notes": "View all credit notes",
  emails: "View all emails",
  events: "View all events",
};

// "History" panel: a single tabbed widget spanning Invoices, Transactions,
// Payment intents, Credit Notes, Email Logs and Events. Each tab's first page is
// server-rendered (fetched with `limit: HISTORY_PAGE`); later pages come through
// `/api/lists`, so the key stays server-side.
export function CustomerHistory({
  biz,
  invoices,
  transactions,
  paymentIntents,
  creditNotes,
  events,
  emails,
  viewAll,
}: {
  biz: string;
  invoices: CursorSource<Invoice>;
  transactions: CursorSource<Transaction>;
  /**
   * The customer's payment intents, open ones included (they write no transaction).
   * OPTIONAL: only the customer page passes it.
   */
  paymentIntents?: CursorSource<PaymentIntentRow>;
  creditNotes: CursorSource<CreditNote>;
  /**
   * Raw event stream — type, source, and the record each event names. OPTIONAL
   * only because not every page has one to pass; the customer page passes its whole
   * footprint (subscriptions, invoices, payments), the subscription page its own.
   */
  events?: CursorSource<EventRecord>;
  /** Email Logs tab — billing emails addressed to this customer. */
  emails: CursorSource<EmailMessage>;
  /** Per tab, the full list narrowed to this record. A tab without one shows no link. */
  viewAll?: Partial<Record<HistoryTab, string>>;
}) {
  const inv = useCursorPages(biz, invoices, PAGE);
  const txn = useCursorPages(biz, transactions, PAGE);
  const pis = useCursorPages(biz, paymentIntents ?? NO_INTENTS, PAGE);
  const router = useRouter();
  const cns = useCursorPages(biz, creditNotes, PAGE);
  const mail = useCursorPages(biz, emails, PAGE);
  const evt = useCursorPages(biz, events ?? NO_EVENTS, PAGE);
  // Dates render in the business timezone, not UTC (see components/business-tz).
  const tz = useBusinessTz();
  const [openEmail, setOpenEmail] = React.useState<EmailMessage | null>(null);
  const multiResource = new Set(evt.rows.map((e) => e.resource?.id ?? "")).size > 1;
  const [tab, setTab] = React.useState<HistoryTab>("invoices");
  const rowsIn: Record<HistoryTab, number> = {
    invoices: invoices.rows.length,
    transactions: transactions.rows.length,
    "payment-intents": paymentIntents?.rows.length ?? 0,
    "credit-notes": creditNotes.rows.length,
    emails: emails.rows.length,
    events: events?.rows.length ?? 0,
  };
  const viewAllHref = rowsIn[tab] > 0 ? viewAll?.[tab] : undefined;
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as HistoryTab)}>
      {/* The link follows the active tab; on a phone it wraps under the tabs. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <TabsList className="flex-wrap justify-start group-data-[orientation=horizontal]/tabs:h-auto">
          <TabsTrigger value="invoices">Invoices{count(invoices)}</TabsTrigger>
          <TabsTrigger value="transactions">Transactions{count(transactions)}</TabsTrigger>
          {paymentIntents ? (
            <TabsTrigger value="payment-intents">
              Payment intents{count(paymentIntents)}
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="credit-notes">Credit notes{count(creditNotes)}</TabsTrigger>
          <TabsTrigger value="emails">Email logs{count(emails)}</TabsTrigger>
          {events ? <TabsTrigger value="events">Events{count(events)}</TabsTrigger> : null}
        </TabsList>
        {viewAllHref ? (
          <Link href={viewAllHref} className="text-sm text-primary hover:underline sm:ml-auto">
            {VIEW_ALL_LABEL[tab]}
          </Link>
        ) : null}
      </div>

      <TabsContent value="invoices" className="pt-3">
        {invoices.rows.length === 0 ? (
          <Empty>No invoice history.</Empty>
        ) : (
          <>
            {/* Auto layout with colgroup widths: the id truncates, and an amount wider than
                its column widens it instead of breaking or drawing over the next one. */}
            <Table phone="stack" fit className="[--phone-row-x:0]">
              {/* The id takes no room of its own, so its column holds a width. */}
              <colgroup>
                <col className="w-[28%]" />
                <col />
                <col />
                <col />
                <col />
              </colgroup>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Created on</TableHead>
                  <TableHead phone="aside" className="text-right">
                    Total
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inv.rows.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="min-w-28">
                      <Link
                        href={`/businesses/${biz}/invoices/${i.id}`}
                        title={i.id}
                        className="block w-0 min-w-full truncate font-mono text-xs text-primary hover:underline"
                      >
                        {i.number ?? i.id}
                      </Link>
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
            {/* As Invoices: long ids truncate and dates wrap inside their column, an amount
                widens its own; the gateway sits under the type. */}
            <Table phone="stack" fit className="[--phone-row-x:0]">
              <colgroup>
                <col className="w-[24%]" />
                <col />
                <col />
                <col />
                <col />
              </colgroup>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Occurred on</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead phone="aside" className="text-right">
                    Amount
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {txn.rows.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="min-w-28">
                      <Link
                        href={`/businesses/${biz}/transactions/${t.id}`}
                        title={t.id}
                        className="block w-0 min-w-full truncate font-mono text-xs text-primary hover:underline"
                      >
                        {t.id}
                      </Link>
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
                          className="w-0 min-w-full truncate text-xs text-muted-foreground"
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

      {!paymentIntents ? null : (
        <TabsContent value="payment-intents" className="pt-3">
          {pis.rows.length === 0 ? (
            <EmptyState
              compact
              title="No payment intents"
              description="We create a payment intent when this customer pays on a payment page or saves a payment method."
            />
          ) : (
            <>
              {/* Last error takes the spare width; the rest hold their widths, like the tabs above. */}
              <Table phone="stack" fit className="[--phone-row-x:0]">
                <colgroup>
                  <col />
                  <col className="w-[16%]" />
                  <col />
                  <col />
                  <col />
                  <col />
                </colgroup>
                <TableHeader>
                  <TableRow>
                    <TableHead>Created</TableHead>
                    <TableHead phone="title">Payment intent</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last error</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead phone="aside" className="text-right">
                      Amount
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pis.rows.map((p) => {
                    const href = `/businesses/${biz}/payment_intents/${p.id}`;
                    return (
                      <TableRow
                        key={p.id}
                        className="cursor-pointer"
                        // The row opens the intent; a link inside it wins.
                        onClick={(e) => {
                          if ((e.target as HTMLElement).closest("a,button")) return;
                          router.push(href);
                        }}
                      >
                        <TableCell className="whitespace-normal">
                          {fmtDateTime(p.created_at, tz)}
                        </TableCell>
                        <TableCell>
                          <Link
                            href={href}
                            className="flex w-0 min-w-full text-muted-foreground hover:text-primary hover:underline"
                          >
                            <MiddleEllipsis value={p.id} className="text-xs" />
                          </Link>
                        </TableCell>
                        <TableCell>
                          <StatusChip status={displayIntentStatus(p)} />
                        </TableCell>
                        <TableCell className="py-2.5 whitespace-normal">
                          <IntentLastError error={p.last_error} />
                        </TableCell>
                        <TableCell>
                          <IntentPurposeChip purpose={p.purpose} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {p.amount_minor != null && p.currency
                            ? money(p.amount_minor, p.currency)
                            : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <Pager pager={pis.pager} className="px-0" />
            </>
          )}
        </TabsContent>
      )}

      <TabsContent value="credit-notes" className="pt-3">
        {creditNotes.rows.length === 0 ? (
          <Empty>No credit note history.</Empty>
        ) : (
          <>
            <Table phone="stack" fit className="[--phone-row-x:0]">
              <TableHeader>
                <TableRow>
                  <TableHead>Credit note</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Created on</TableHead>
                  <TableHead phone="aside" className="text-right">
                    Total
                  </TableHead>
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
                      <Link
                        href={`/businesses/${biz}/credit_notes/${c.id}`}
                        title={c.id}
                        className="font-mono text-xs text-primary hover:underline"
                      >
                        {c.number ?? c.id}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <StatusChip status={creditNoteChipStatus(c)} />
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/businesses/${biz}/invoices/${c.invoice}`}
                        title={c.invoice}
                        className="font-mono text-xs text-primary hover:underline"
                      >
                        {c.invoice_number ?? c.invoice}
                      </Link>
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
            <Table phone="stack" className="table-fixed [--phone-row-x:0]">
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
                  <TableHead phone="aside">
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
                            {plural(m.attempts, "attempt")}
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
              <Table phone="stack" className="table-fixed [--phone-row-x:0]">
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
                        <Link
                          href={`/businesses/${biz}/events/${e.id}`}
                          title={e.id}
                          className="block truncate font-mono text-xs text-primary hover:underline"
                        >
                          {e.id}
                        </Link>
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
                      <TableCell className="truncate">
                        {e.source ? sourceLabel(e.source) : "—"}
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

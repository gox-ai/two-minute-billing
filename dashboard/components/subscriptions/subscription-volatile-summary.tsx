"use client";

// Consumer components for SubscriptionRefreshProvider — each replaces one static `sub.*`
// read on the subscription detail page with the live, refreshable value.

import { RefreshButton } from "@/components/refresh-button";
import { StatusChip, Chip } from "@/components/patterns/chip";
import { Alert } from "@/components/ui/alert";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import { useSubscriptionRefresh } from "@/components/subscriptions/subscription-refresh-context";
import * as React from "react";
import { CalendarClock, CalendarX2, CircleDollarSign, FileText, TrendingUp } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { CollectInvoiceDialog } from "@/components/invoices/collect-invoice-dialog";
import type { PaymentMethod } from "@/lib/api";
import {
  AttentionCard,
  FigureTile,
  FigureTiles,
  type AttentionItem,
} from "@/components/patterns/record-page";
import { UnpaidJourneys } from "@/components/invoices/unpaid-journeys";
import type { InvoiceTimeline } from "@/components/invoices/invoice-timeline";
import { RemoveScheduledCancellationButton } from "@/components/subscriptions/remove-scheduled-cancellation";

/** The Refresh control itself — place once, near the title. */
export function SubscriptionRefreshControl() {
  const { pending, refresh } = useSubscriptionRefresh();
  return <RefreshButton onRefresh={refresh} pending={pending} variant="outline" />;
}

/** Replaces the header's static `<StatusChip status={sub.status} />`, plus a pending-
 *  scheduled-change count when there is one. */
export function SubscriptionStatusChips() {
  const { state } = useSubscriptionRefresh();
  return (
    <>
      <StatusChip status={state.status} />
      {state.pending_scheduled_count > 0 ? (
        <Chip tone="tan">
          {state.pending_scheduled_count} scheduled change
          {state.pending_scheduled_count > 1 ? "s" : ""}
        </Chip>
      ) : null}
    </>
  );
}

/** Replaces the standalone dues banner (dunning/retry-adjacent state). */
export function SubscriptionDuesBanner({ currency, tz }: { currency: string; tz: string | null }) {
  const { state } = useSubscriptionRefresh();
  if (state.due_invoices_count <= 0) return null;
  return (
    <Alert tone="error" className="mb-4">
      <strong>
        {state.due_invoices_count} unpaid invoice{state.due_invoices_count > 1 ? "s" : ""}
      </strong>
      {". "}Total due:{" "}
      <strong className="tabular-nums">
        {money(state.total_dues_minor, currency)} {currency}
      </strong>
      {state.due_since ? (
        <>
          , since <strong>{fmtDate(state.due_since, tz)}</strong>
        </>
      ) : null}
      .
    </Alert>
  );
}

/** Replaces the Summary card's MRR + upcoming-invoice line. */
export function SubscriptionSummaryFigures({
  currency,
  tz,
}: {
  currency: string;
  tz: string | null;
}) {
  const { state } = useSubscriptionRefresh();
  const renews =
    (state.status === "active" || state.status === "in_trial" || state.status === "non_renewing") &&
    !state.cancel_at_period_end;
  return (
    <div className="space-y-1 text-xs text-foreground/80">
      <div>
        Total MRR{" "}
        <strong className="font-bold text-foreground">
          {money(state.mrr, currency)} {currency}
        </strong>
      </div>
      {renews && state.next_billing_amount_minor != null ? (
        <div>
          We will raise the next invoice of{" "}
          <strong className="font-semibold text-foreground">
            {money(state.next_billing_amount_minor, currency)} {currency}
          </strong>{" "}
          on <strong>{fmtDateTime(state.next_billing_at, tz)}</strong>.
        </div>
      ) : null}
    </div>
  );
}

/** Surfaces a refresh error inline — mirrors ErrorState's plain-text presentation. */
export function SubscriptionRefreshError() {
  const { error } = useSubscriptionRefresh();
  if (!error) return null;
  return (
    <Alert tone="error" className="mb-4 text-xs">
      We could not refresh the data: {error}
    </Alert>
  );
}

// ── Record-page layout ────────────────────────────────────────────────────────

/** Unpaid dues beside the status chip; nothing when the subscription owes nothing. */
export function SubscriptionDuesChip({ currency }: { currency: string }) {
  const { state } = useSubscriptionRefresh();
  if (state.due_invoices_count <= 0) return null;
  return (
    <Chip tone="red">
      {state.due_invoices_count} unpaid · {money(state.total_dues_minor, currency)}
    </Chip>
  );
}

/**
 * What needs a person: unpaid dues (with each invoice's payments and dunning) and a
 * scheduled cancellation. Nothing renders when neither applies.
 * `dunning` / `invoiceTracks` come from the page: the refresh state carries totals, not
 * the retry schedule or the attempts.
 */
export function SubscriptionAttention({
  biz,
  sub,
  currency,
  tz,
  dunning,
  invoiceTracks,
  canRemoveCancellation,
  autoCollection,
  pms,
  firstTried,
}: {
  biz: string;
  sub: string;
  currency: string;
  tz: string | null;
  dunning: {
    invoice: string;
    number: string | null;
    attempt_count: number;
    next_attempt_at: string | null;
    /** payment_due / not_paid — the states the invoice's collect accepts. */
    collectable: boolean;
  } | null;
  /** Up to two unpaid invoices, each with its payments and dunning. */
  invoiceTracks: InvoiceTimeline[];
  canRemoveCancellation: boolean;
  /** Off = offline invoices: the next date is a reminder, not a charge. */
  autoCollection: boolean;
  /** The customer's cards, for Collect payment's card choice. */
  pms: PaymentMethod[];
  /** The card collection tries first (the subscription's own, else the primary). */
  firstTried: PaymentMethod | null;
}) {
  const { state } = useSubscriptionRefresh();
  const items: AttentionItem[] = [];
  const unpaid = state.due_invoices_count > 0;

  const single = state.due_invoices_count === 1;
  if (unpaid) {
    items.push({
      key: "due",
      tone: "attention",
      title: `${state.due_invoices_count} unpaid invoice${single ? "" : "s"} · ${money(state.total_dues_minor, currency)}`,
      // One invoice: its own number, attempts and retry. Several: only the oldest date —
      // one invoice's attempts beside another's retry date would describe neither.
      detail: single
        ? [
            // Same order as the customer page's card.
            dunning ? `Invoice ${dunning.number ?? dunning.invoice}` : null,
            state.due_since ? `since ${fmtDate(state.due_since, tz)}` : null,
            dunning?.attempt_count
              ? `${dunning.attempt_count} attempt${dunning.attempt_count === 1 ? "" : "s"}`
              : null,
            dunning?.next_attempt_at
              ? `${autoCollection ? "next retry" : "next reminder"} ${fmtDateTime(dunning.next_attempt_at, tz)}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : state.due_since
          ? `Oldest due since ${fmtDate(state.due_since, tz)}`
          : undefined,
      actions:
        single && dunning ? (
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={`/businesses/${biz}/invoices/${dunning.invoice}`}>View invoice</Link>
            </Button>
            {/* The invoice's own collect, so only THIS invoice is charged — the
                customer-level collect would take every due invoice the customer has. */}
            {dunning.collectable ? (
              <CollectInvoiceDialog
                biz={biz}
                invoice={{
                  id: dunning.invoice,
                  number: dunning.number,
                  dueMinor: state.total_dues_minor,
                  currency,
                }}
                pms={pms}
                firstTried={firstTried}
                back={`/businesses/${biz}/subscriptions/${sub}`}
              />
            ) : null}
          </>
        ) : !single ? (
          <Button asChild variant="outline" size="sm">
            <a href="#history">Show invoices</a>
          </Button>
        ) : null,
    });
  }

  // Terminal subscriptions never carry a live cancellation, however the flag got there.
  if (
    (state.cancel_at_period_end || state.status === "non_renewing") &&
    state.status !== "cancelled"
  ) {
    const on = state.canceled_at ?? state.current_period_end;
    items.push({
      key: "cancel",
      tone: "warning",
      title: on
        ? `Cancellation scheduled · cancels on ${fmtDate(on, tz)}`
        : "Cancellation scheduled",
      detail: [
        "This subscription will not renew",
        state.cancel_reason_code ? `reason ${state.cancel_reason_code}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      // `removeScheduledCancellation` needs a stored `active` status — exactly
      // `non_renewing`; a trial or paused sub keeps the notice, not the button.
      actions: canRemoveCancellation ? (
        <RemoveScheduledCancellationButton biz={biz} sub={sub} size="sm" />
      ) : null,
    });
  }

  // Only while the count the tracks were built for still holds (a refresh can move it).
  const tracks =
    unpaid && state.due_invoices_count === invoiceTracks.length ? (
      // The same timeline as the customer page: the invoice's payments and dunning only.
      <UnpaidJourneys biz={biz} tz={tz} tracks={invoiceTracks} />
    ) : null;

  return (
    <AttentionCard items={items} columns={false}>
      {tracks}
    </AttentionCard>
  );
}

export function SubscriptionFigures({
  currency,
  tz,
  nowMs,
}: {
  currency: string;
  tz: string | null;
  /** Server clock, so the day count renders the same on server and client. */
  nowMs: number;
}) {
  const { state } = useSubscriptionRefresh();
  const daysUntil = (iso: string | null) =>
    iso ? Math.max(0, Math.ceil((Date.parse(iso) - nowMs) / 86_400_000)) : null;
  const daysLeft = (iso: string | null) => {
    const n = daysUntil(iso);
    return n != null ? `${n} day${n === 1 ? "" : "s"} left` : null;
  };
  const renews =
    (state.status === "active" || state.status === "in_trial") && !state.cancel_at_period_end;
  const cancelledOn = state.canceled_at ?? state.current_period_end;
  const paid = state.revenue_paid_invoices_count;
  return (
    <FigureTiles>
      <FigureTile
        label="MRR"
        icon={CircleDollarSign}
        value={money(state.mrr, currency)}
        note="After discounts"
      />
      <FigureTile
        label="Total due"
        icon={FileText}
        value={money(state.total_dues_minor, currency)}
        note={
          state.due_invoices_count
            ? `${state.due_invoices_count} invoice${state.due_invoices_count > 1 ? "s" : ""}`
            : "Nothing outstanding"
        }
        tone={state.due_invoices_count ? "loss" : undefined}
      />
      {/* One tile for the renewal: the next charge when it renews, else when the term ends. */}
      {state.status === "cancelled" ? (
        <FigureTile
          label="Cancelled on"
          icon={CalendarX2}
          value={cancelledOn ? fmtDate(cancelledOn, tz) : "—"}
          note={
            state.current_period_start &&
            state.current_period_end &&
            Date.parse(state.current_period_start) <= Date.parse(state.current_period_end)
              ? `Last term ${fmtDate(state.current_period_start, tz)} – ${fmtDate(state.current_period_end, tz)}`
              : undefined
          }
        />
      ) : renews && state.next_billing_at ? (
        <FigureTile
          label="Next billing"
          icon={CalendarClock}
          value={
            state.next_billing_amount_minor != null
              ? money(state.next_billing_amount_minor, currency)
              : fmtDate(state.next_billing_at, tz)
          }
          note={[
            state.next_billing_amount_minor != null ? fmtDate(state.next_billing_at, tz) : null,
            state.next_billing_amount_minor != null ? "incl. tax" : null,
            daysLeft(state.next_billing_at),
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      ) : (
        <FigureTile
          label="Term ends"
          icon={CalendarX2}
          value={state.current_period_end ? fmtDate(state.current_period_end, tz) : "—"}
          note={["Does not renew", daysLeft(state.current_period_end)].filter(Boolean).join(" · ")}
        />
      )}
      <FigureTile
        label="Revenue to date"
        icon={TrendingUp}
        featured
        value={money(state.revenue_to_date_minor, currency)}
        note={
          paid && state.revenue_since
            ? `${paid} invoice${paid === 1 ? "" : "s"} paid · since ${fmtDate(state.revenue_since, tz)}`
            : "Nothing collected yet"
        }
      />
    </FigureTiles>
  );
}

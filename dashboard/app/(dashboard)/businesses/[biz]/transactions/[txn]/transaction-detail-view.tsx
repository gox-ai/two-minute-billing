"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import Link from "next/link";
import { Chip, StatusChip } from "@/components/patterns/chip";
import { RecordDisputeButton, DisputeOutcomeButtons } from "@/components/disputes/dispute-actions";
import type { Dispute } from "@/lib/api/disputes";
import { disputeOutcomeNote, disputeReasonLabel, disputeStatusTone } from "@/lib/dispute-vocab";
import type { TimelineEntry } from "@/components/patterns/timeline-card";
import {
  RecordCrumbs,
  RecordHeader,
  Zone,
  Row as GridRow,
  RecordCard,
} from "@/components/patterns/record-page";
import { TransactionReconcileForm } from "@/components/payments/transaction-reconcile";
import { TransactionSyncPanel } from "@/components/payments/transaction-sync";
import { RefreshButton } from "@/components/refresh-button";
import { InstrumentMark } from "@/components/brand/instrument-mark";
import { gatewayObjectUrl } from "@/components/gateways/gateway-meta";
import { money, fmtDateTime } from "@/lib/format";
import { paymentMethodTypeLabel } from "@/lib/filter-options";
import type { Transaction, GatewayWebhook } from "@/lib/api/payments";
import { RECONCILABLE_STATUSES } from "@/lib/transaction-status";
import { refreshTransactionAction } from "./refresh-action";
import { GatewayLabel } from "@/components/partner-logo";
import { gatewayLogsHref } from "@/lib/gateway-logs-href";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="col-span-2 break-all">{children}</dd>
    </div>
  );
}

/**
 * Merges the transaction's own lifecycle with the gateway callback log into one
 * chronological timeline. Pulled out of the page so a Refresh can rebuild it
 * client-side from freshly re-fetched data without re-running the server tree.
 */
function buildTimeline(
  t: Transaction,
  callbacks: GatewayWebhook[],
  biz: string,
  tz: string | null,
) {
  const named = callbacks.filter((w) => w.type && w.type !== "unknown");
  const unparsed = callbacks.length - named.length;
  const timeline: TimelineEntry[] = [
    { label: "Created", date: fmtDateTime(t.created_at, tz), at: t.created_at },
    ...named.map((w) => ({
      label: `Gateway callback · ${w.type}${w.outcome === "processed" ? "" : ` (${w.outcome})`}`,
      date: fmtDateTime(w.received_at, tz),
      at: w.received_at,
    })),
    // A success is described by when its money settled; anything else by when it
    // stopped being able to change (finalised_at) — see page history for why.
    ...(t.status === "succeeded" && t.settled_at
      ? [{ label: "Settled", date: fmtDateTime(t.settled_at, tz), at: t.settled_at }]
      : t.finalised_at
        ? [{ label: "Finalised", date: fmtDateTime(t.finalised_at, tz), at: t.finalised_at }]
        : []),
  ]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.label.localeCompare(b.label))
    .map(({ label, date }) => ({ label, date }));
  if (unparsed > 0) {
    timeline.push({
      label: `+ ${unparsed} callback${unparsed === 1 ? "" : "s"} of an unhandled type`,
      date: (
        <Link
          href={`/businesses/${biz}/gateway_webhooks?transaction%5Bis%5D=${encodeURIComponent(t.id)}`}
          className="text-primary hover:underline"
        >
          view all
        </Link>
      ),
    });
  }
  return timeline;
}

/**
 * Whole transaction-detail body, client-side so Refresh can reload the money
 * facts (status, settlement, refunds, gateway result) without re-running the
 * page's server component. Static facts (business name/tz, breadcrumbs) come in
 * as props once and never change.
 */
export function TransactionDetailView({
  biz,
  name,
  gatewayName,
  tz,
  livemode,
  initialTransaction,
  initialCallbacks,
  initialDisputes,
  canManageDisputes,
}: {
  biz: string;
  name: string;
  /** The gateway's display name, or "the gateway" when the transaction has none. */
  gatewayName: string;
  tz: string | null;
  /** Stripe's dashboard puts the mode in the path, so the link needs it. */
  livemode: "live" | "test" | null;
  initialTransaction: Transaction;
  initialCallbacks: GatewayWebhook[];
  /** The disputes on this payment (empty for anything but a payment). */
  initialDisputes: Dispute[];
  /** Holds `payments:refund`: may record a dispute and its outcome, and cancel a pending debit. */
  canManageDisputes: boolean;
}) {
  // Re-seeded when a save re-renders the page; a bare useState kept the pre-save data.
  const [t, setT] = useDefaultState(initialTransaction, (v) => JSON.stringify(v));
  const [callbacks, setCallbacks] = useDefaultState(initialCallbacks, (v) => JSON.stringify(v));
  const [disputes, setDisputes] = useDefaultState(initialDisputes, (v) => JSON.stringify(v));
  const [refreshError, setRefreshError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const handleRefresh = () => {
    startTransition(async () => {
      const res = await refreshTransactionAction(biz, t.id);
      if (res.ok) {
        setT(res.transaction);
        setCallbacks(res.callbacks);
        setDisputes(res.disputes);
        setRefreshError(null);
      } else {
        setRefreshError(res.error);
      }
    });
  };

  const timeline = React.useMemo(
    () => buildTimeline(t, callbacks, biz, tz),
    [t, callbacks, biz, tz],
  );

  // The payer row. `t.customer_name` is resolved server-side through
  // accountHolderName, so it already IS the account holder.
  const holderName = t.customer_name ?? null;
  const mono = (v: string | null) => (v ? <span className="font-mono text-xs">{v}</span> : "—");
  const gatewayUrl = gatewayObjectUrl(t.gateway_key, t.id_at_gateway, livemode);
  const recording = canManageDisputes ? (t.dispute_recording ?? null) : null;

  return (
    <div className="flex flex-col gap-4">
      <RecordCrumbs
        items={[
          { label: name, href: `/businesses/${biz}` },
          { label: "Transactions", href: `/businesses/${biz}/transactions` },
          { label: t.id },
        ]}
        right={
          <>
            {refreshError ? <span className="text-xs text-destructive">{refreshError}</span> : null}
            <RefreshButton onRefresh={handleRefresh} pending={pending} />
          </>
        }
      />

      <RecordHeader
        title={
          <span className="flex flex-wrap items-baseline gap-2">
            Transaction <span className="font-mono text-lg font-semibold">{t.id}</span>
          </span>
        }
        chips={<StatusChip status={t.status} />}
        facts={[
          <span key="type" className="capitalize">
            {t.type.replace(/_/g, " ")}
          </span>,
          <span key="amt" className="tabular-nums">
            {money(t.amount_minor, t.currency)}
          </span>,
          t.customer ? (
            <Link
              key="cus"
              href={`/businesses/${biz}/customers/${t.customer}`}
              className="text-primary hover:underline"
            >
              {holderName ?? t.customer}
            </Link>
          ) : null,
          t.invoice ? (
            <Link
              key="inv"
              href={`/businesses/${biz}/invoices/${t.invoice}`}
              className="font-mono text-xs text-primary hover:underline"
            >
              {t.invoice}
            </Link>
          ) : null,
          fmtDateTime(t.occurred_at ?? t.created_at, tz),
        ]}
      />

      {/* The operator's move, when there is one: a scheduled check to hurry, or a
          verdict to record. Settled or failed rows need nothing, so no card. */}
      {RECONCILABLE_STATUSES.includes(t.status) ? (
        <TransactionReconcileForm biz={biz} txn={t.id} settledRefund={t.settled_refund} />
      ) : t.status === "in_progress" ? (
        <TransactionSyncPanel
          biz={biz}
          txn={t.id}
          lastPolledAt={t.settlement_poll?.last_polled_at ?? null}
          nextPollAt={t.settlement_poll?.next_poll_at ?? null}
          attempts={t.settlement_poll?.attempts ?? null}
          gatewayName={gatewayName}
          cancelPayment={canManageDisputes ? (t.pending_debit_cancel?.payment ?? null) : null}
        />
      ) : null}

      <Zone title="Transaction">
        <GridRow span="8/4">
          <RecordCard id="summary" title="Summary">
            <dl className="divide-y">
              <Row label="Transaction type">
                <span className="capitalize">{t.type.replace(/_/g, " ")}</span>
              </Row>
              <Row label="Status">
                <StatusChip status={t.status} />
              </Row>
              <Row label="Date">{fmtDateTime(t.occurred_at ?? t.created_at, tz)}</Row>
              <Row label="Amount">
                {money(t.amount_minor, t.currency)} {t.currency}
              </Row>
              <Row label="Customer">
                {t.customer ? (
                  <Link
                    href={`/businesses/${biz}/customers/${t.customer}`}
                    className="text-primary hover:underline"
                  >
                    {holderName ?? t.customer}
                    {t.customer_email ? (
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({t.customer_email})
                      </span>
                    ) : null}
                  </Link>
                ) : (
                  "—"
                )}
              </Row>
              <Row label="Subscription">
                {t.subscription ? (
                  <Link
                    href={`/businesses/${biz}/subscriptions/${t.subscription}`}
                    className="font-mono text-xs text-primary hover:underline"
                  >
                    {t.subscription}
                  </Link>
                ) : (
                  "—"
                )}
              </Row>
              <Row label="Invoice">
                {t.invoice ? (
                  <Link
                    href={`/businesses/${biz}/invoices/${t.invoice}`}
                    className="font-mono text-xs text-primary hover:underline"
                  >
                    {t.invoice}
                  </Link>
                ) : (
                  "—"
                )}
              </Row>
              <Row label="Credit note">
                {t.credit_note ? (
                  <Link
                    href={`/businesses/${biz}/credit_notes/${t.credit_note}`}
                    className="font-mono text-xs text-primary hover:underline"
                  >
                    {t.credit_note}
                  </Link>
                ) : (
                  "—"
                )}
              </Row>
              {t.fraud_signal ? (
                <Row label="Fraud signal">
                  <span
                    className={
                      t.fraud_signal.type === "fraud_warning.created"
                        ? "text-destructive"
                        : t.fraud_signal.type === "review.opened"
                          ? "text-warning"
                          : "text-muted-foreground"
                    }
                  >
                    {t.fraud_signal.type === "fraud_warning.created"
                      ? "Early fraud warning"
                      : t.fraud_signal.type === "review.opened"
                        ? "Under manual review"
                        : "Manual review closed"}
                    {" · "}
                    {fmtDateTime(t.fraud_signal.received_at, tz)}
                  </span>
                </Row>
              ) : null}
              {t.payment_intent ? (
                <Row label="Payment intent">
                  <Link
                    href={`/businesses/${biz}/payment_intents/${t.payment_intent}`}
                    className="font-mono text-xs text-primary hover:underline"
                  >
                    {t.payment_intent}
                  </Link>
                </Row>
              ) : null}
              <Row label="Error">
                {t.error_code || t.error_text ? (
                  <span className="text-destructive">
                    {t.error_code}
                    {t.error_text ? ` — ${t.error_text}` : ""}
                  </span>
                ) : (
                  "—"
                )}
              </Row>
              {t.type === "refund" && t.reference_payment ? (
                <Row label="Refund of payment">{mono(t.reference_payment)}</Row>
              ) : null}
              {/* Money the gateway has already returned on this charge (#17). */}
              {t.settled_refund ? (
                <Row label="Refunded amount">
                  {money(t.settled_refund.refunded_minor, t.settled_refund.currency ?? t.currency)}{" "}
                  {t.settled_refund.currency ?? t.currency}
                  {t.settled_refund.fully_returned ? (
                    <span className="ml-1.5 text-xs text-muted-foreground">(fully returned)</span>
                  ) : null}
                </Row>
              ) : null}
              <Row label="Settled">{t.settled_at ? fmtDateTime(t.settled_at, tz) : "—"}</Row>
              <Row label="Created">{fmtDateTime(t.created_at, tz)}</Row>
            </dl>
          </RecordCard>

          <RecordCard id="timeline" title="Timeline">
            <ul className="space-y-1.5 text-sm">
              {timeline.map((e, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                  <span
                    aria-hidden
                    className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/60"
                  />
                  <span className="wrap-anywhere text-muted-foreground">{e.label}</span>
                  <span className="font-medium">{e.date}</span>
                </li>
              ))}
            </ul>
          </RecordCard>
        </GridRow>

        <GridRow span="6/6">
          <RecordCard id="payment-method" title="Payment method">
            {t.payment_method || t.method_type ? (
              <dl className="divide-y">
                {t.payment_method ? (
                  <Row label="Card">
                    <span className="flex items-center gap-1.5">
                      <InstrumentMark
                        brand={t.payment_method.brand}
                        last4={t.payment_method.last4}
                        className="h-3.5 w-6"
                      />
                      <span className="capitalize">{t.payment_method.brand ?? "Card"}</span>
                      {t.payment_method.last4 ? (
                        <span className="text-muted-foreground">
                          ending {t.payment_method.last4}
                        </span>
                      ) : null}
                    </span>
                  </Row>
                ) : null}
                {/* What the gateway said paid, which can differ from the saved method. */}
                {t.method_type ? (
                  <Row label="Paid with">{paymentMethodTypeLabel(t.method_type)}</Row>
                ) : null}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                No payment method on record for this transaction.
              </p>
            )}
          </RecordCard>

          <RecordCard id="gateway" title="Gateway">
            <dl className="divide-y">
              <Row label="Gateway">
                {t.gateway_key ? (
                  <GatewayLabel gatewayKey={t.gateway_key} name={gatewayName} fit />
                ) : (
                  "—"
                )}
              </Row>
              <Row label="Gateway account">
                {t.gateway_account ? (
                  <Link
                    href={`/businesses/${biz}/settings/gateways/${t.gateway_account.id}`}
                    className="text-primary hover:underline"
                  >
                    {t.gateway_account.name ?? t.gateway_account.id}
                    {t.gateway_account.name ? (
                      <span className="ml-1.5 text-muted-foreground">
                        {mono(t.gateway_account.id)}
                      </span>
                    ) : null}
                  </Link>
                ) : (
                  "—"
                )}
              </Row>
              <Row label="Gateway transaction id">
                {/* Linked only where we have a confirmed dashboard URL for this
                    gateway and id shape (`gatewayObjectUrl`); otherwise the id
                    stays plain text rather than becoming a link to a 404. */}
                {gatewayUrl ? (
                  <a
                    href={gatewayUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-xs text-primary hover:underline"
                    title={`Open in ${gatewayName}`}
                  >
                    {t.id_at_gateway}
                  </a>
                ) : (
                  mono(t.id_at_gateway)
                )}
              </Row>
              {gatewayLogsHref(biz, t) ? (
                <Row label="Gateway activity">
                  <Link href={gatewayLogsHref(biz, t)!} className="text-primary hover:underline">
                    View request/response logs
                  </Link>
                </Row>
              ) : null}
            </dl>
          </RecordCard>
        </GridRow>

        {/* Only where there is a dispute to show, or the gateway cannot report one. */}
        {disputes.length > 0 || recording ? (
          <GridRow span="12">
            <RecordCard
              id="disputes"
              title="Disputes"
              meta={disputes.length > 0 ? disputes.length : undefined}
              actions={
                recording && recording.available_minor > 0 ? (
                  <RecordDisputeButton
                    biz={biz}
                    pay={recording.payment}
                    txn={t.id}
                    availableMinor={recording.available_minor}
                    currency={t.currency}
                    gatewayName={gatewayName}
                  />
                ) : null
              }
            >
              {disputes.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {gatewayName} does not send disputes to us. If your card processor reports a
                  chargeback on this payment, record it here.
                </p>
              ) : (
                <ul className="divide-y">
                  {disputes.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
                      <span className="flex-[1_1_14rem] text-sm">
                        <span className="font-medium tabular-nums">
                          {money(d.amount_minor, d.currency)}
                        </span>{" "}
                        <span className="text-muted-foreground">
                          · {disputeReasonLabel(d.reason)} · opened {fmtDateTime(d.opened_at, tz)}
                          {d.source === "operator" ? " · recorded by hand" : ""}
                          {d.processor_reference ? ` · ${d.processor_reference}` : ""}
                        </span>
                      </span>
                      <Chip tone={disputeStatusTone(d.status)} className="uppercase">
                        {d.status.replace(/_/g, " ")}
                      </Chip>
                      {canManageDisputes && d.outcome_settable_by_operator ? (
                        <>
                          {d.source === "gateway" ? (
                            <p className="basis-full text-sm text-muted-foreground">
                              {disputeOutcomeNote(gatewayName)}
                            </p>
                          ) : null}
                          <DisputeOutcomeButtons
                            biz={biz}
                            dsp={d.id}
                            txn={t.id}
                            amountMinor={d.amount_minor}
                            currency={d.currency}
                            fundsWithdrawn={d.funds_withdrawn}
                          />
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </RecordCard>
          </GridRow>
        ) : null}
      </Zone>
    </div>
  );
}

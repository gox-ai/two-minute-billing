import * as React from "react";
import Link from "next/link";
import type { Transaction, PaymentIntentRow } from "@/lib/api/payments";
import { SectionCard } from "@/components/patterns/section-card";
import { EmptyState } from "@/components/states";
import { StatusChip } from "@/components/patterns/chip";
import { money, fmtDateTime } from "@/lib/format";
import { ATTEMPT_FAILED, displayIntentStatus } from "@/lib/payment-intent-status";
import type { DunningJourney } from "@/lib/api";
import { DunningJourneyView, finalActionSentence } from "./dunning-journey-view";

/** One cell of the summary strip: a small label over a figure, with an optional note. */
function SummaryCell({
  label,
  value,
  note,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-5 py-3.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg font-medium wrap-anywhere tabular-nums">
        {value}
        {note ? (
          <span className="ml-1.5 text-sm font-normal text-muted-foreground">{note}</span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * The journey at a glance: what is due, how the attempts went, and — while money is owed —
 * the next automatic retry and the final action from the forecast. Every cell is read off
 * the journey; a cell with nothing to say is left out.
 */
function JourneySummary({
  journey,
  amountDueMinor,
  currency,
  owed,
  tz,
}: {
  journey: DunningJourney;
  amountDueMinor: number;
  currency: string;
  owed: boolean;
  tz: string | null;
}) {
  const attempts = journey.history.filter((h) => h.kind === "attempt");
  // A refusal sent nothing to the gateway, so it is not a failed charge.
  const counts = (
    [
      ["succeeded", attempts.filter((a) => a.status === "succeeded").length],
      ["failed", attempts.filter((a) => a.presented && a.status === "failed").length],
      ["refused before sending", attempts.filter((a) => !a.presented).length],
      [
        "pending",
        attempts.filter((a) => a.presented && a.status !== "succeeded" && a.status !== "failed")
          .length,
      ],
    ] as const
  ).filter(([, n]) => n > 0);
  // One outcome reads as a word ("2 failed"); a mix names each count.
  const outcome =
    counts.length === 1 ? counts[0][0] : counts.map(([label, n]) => `${n} ${label}`).join(" · ");
  const retry = owed ? journey.projection?.find((s) => s.kind === "retry") : undefined;
  const final = owed ? journey.projection?.find((s) => s.kind === "final_action") : undefined;
  const cells = [
    <SummaryCell key="due" label="Amount due" value={money(amountDueMinor, currency)} />,
    <SummaryCell
      key="attempts"
      label="Attempts"
      value={attempts.length.toLocaleString("en")}
      note={outcome || undefined}
    />,
    retry ? (
      <SummaryCell key="retry" label="Next automatic retry" value={fmtDateTime(retry.at, tz)} />
    ) : null,
    final && final.kind === "final_action" ? (
      <div key="final" className="flex min-w-0 flex-col gap-1 px-5 py-3.5">
        <span className="text-xs text-muted-foreground tabular-nums">
          Final action · {fmtDateTime(final.at, tz)}
        </span>
        <span className="text-sm font-medium">{finalActionSentence(final)}</span>
      </div>
    ) : null,
  ].filter(Boolean);
  // Hairlines from a 1px gap over the border colour, so the cells wrap at any width and each
  // keeps a rule on every inner side; a short last row grows to fill it. Each cell paints
  // the tint over an opaque card. Neutral even when owed: the attention banner carries that.
  return (
    <div className="flex flex-wrap gap-px border-b bg-border *:flex-[1_1_12rem] *:bg-card *:bg-linear-to-r *:from-muted/40 *:to-muted/40">
      {cells}
    </div>
  );
}

/**
 * The "Payments and Credits" card, as a pure view.
 *
 * Its own file because the fetch beside it reaches `@/lib/api/payments`, which imports
 * `next/headers`. A client component importing this view out of that module dragged the
 * whole server chain into the browser bundle and every invoice page 500'd — the
 * `next/headers` rule in `dashboard/README.md`. Anything both halves need lives here,
 * where nothing touches Node.
 */
export function PaymentsAndCreditsView({
  biz,
  tz,
  transactions,
  openIntents,
  journey,
  dunningStatus,
  layout,
  summary,
  actions,
}: {
  biz: string;
  tz: string | null;
  transactions: Transaction[];
  openIntents: PaymentIntentRow[];
  /** When given, one timeline of attempts, money and dunning replaces the list. */
  journey?: DunningJourney | null;
  dunningStatus?: string | null;
  layout?: "section" | "card";
  /** With a journey: the summary strip under the card header. */
  summary?: { amountDueMinor: number; currency: string; owed: boolean };
  /** Card-header actions beside the dunning status (Pause dunning, Stop dunning). */
  actions?: React.ReactNode;
}) {
  const intents =
    openIntents.length > 0 ? (
      <div className="mb-4 rounded-md bg-muted/50 p-3">
        {/* "Open", not "In progress": an intent whose newest attempt the gateway REFUSED
              is still open — it has no failed status of its own — but nothing about it is
              in progress, and this block used to tell the operator the customer still had
              to finish it. */}
        <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Open at the gateway
        </p>
        <ul className="space-y-2">
          {openIntents.map((i) => {
            const status = displayIntentStatus(i);
            const refused = status === ATTEMPT_FAILED;
            return (
              <li key={i.id} className="flex flex-wrap items-start gap-2 text-sm">
                <StatusChip status={status} />
                <span className="min-w-0 flex-1">
                  <span className="font-mono text-xs">{i.id}</span>{" "}
                  {i.amount_minor != null && i.currency ? (
                    <>
                      —{" "}
                      <span className="font-medium tabular-nums">
                        {money(i.amount_minor, i.currency)}
                      </span>{" "}
                    </>
                  ) : null}
                  <span className="text-muted-foreground">
                    {i.attempt_count > 1 ? `${i.attempt_count} attempts · ` : ""}
                    opened {fmtDateTime(i.created_at, tz)}
                  </span>
                  {/* The deadline is the actionable part: past it the clock fails the
                      intent and the invoice re-enters dunning. Nothing has been taken
                      yet, so this is `muted`, not a warning. The refused wording is a
                      different fact and must not be softened into the other: waiting on
                      the buyer and refused by the gateway need different responses. */}
                  {i.expires_at ? (
                    <span className="block text-xs text-muted-foreground">
                      {refused
                        ? "No money moved. The gateway refused the last attempt. You can try again until "
                        : "No money moved yet. The customer must complete this at the gateway. It expires "}
                      {fmtDateTime(i.expires_at, tz)}.
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    ) : null;
  const list = (
    <>
      {intents}
      {transactions.length === 0 && openIntents.length === 0 ? (
        <EmptyState
          title="No payments yet"
          description="Charges, refunds and offline payments for this invoice show here."
        />
      ) : transactions.length === 0 ? null : (
        <ul className="space-y-3">
          {transactions.map((t) => {
            const method = t.payment_method?.brand
              ? `${t.payment_method.brand}${t.payment_method.last4 ? ` ending ${t.payment_method.last4}` : ""}`
              : t.gateway_key?.startsWith("offline_")
                ? `offline · ${t.gateway_key.slice("offline_".length).replace(/_/g, " ")}`
                : (t.gateway_key ?? "gateway");
            return (
              <li key={t.id} className="flex flex-wrap items-start gap-2 text-sm">
                <StatusChip status={t.status} />
                <span className="min-w-0 flex-1">
                  <Link
                    href={`/businesses/${biz}/transactions/${t.id}`}
                    className="font-mono text-xs text-primary hover:underline"
                  >
                    {t.id}
                  </Link>{" "}
                  —{" "}
                  <span className="font-medium tabular-nums">
                    {money(t.amount_minor, t.currency)}
                  </span>{" "}
                  <span className="capitalize">{t.type.replace(/_/g, " ")}</span> via{" "}
                  <span className="font-medium">{method}</span>
                  {t.occurred_at ? <> on {fmtDateTime(t.occurred_at, tz)}</> : null}
                  {/* The reason a charge failed is the whole point of showing failures. */}
                  {t.error_text ? (
                    <span className="block text-xs text-destructive">
                      {t.error_text}
                      {t.error_code ? ` (${t.error_code})` : ""}
                    </span>
                  ) : null}
                  {/* An `in_progress` row that is actually waiting on the CUSTOMER, not
                      on a settlement network. Without this the chip says "in progress"
                      for days and an operator has no way to tell a netbanking debit
                      that is fine from a card debit that will expire unapproved — and
                      only the second one is worth a phone call. `warning`, not
                      `destructive`: nothing has gone wrong yet. */}
                  {t.awaiting_authentication ? (
                    <span className="block text-xs text-warning">
                      Waiting for the customer to approve this with their bank. We cannot take it
                      without the customer. It expires if they do not approve it.
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
  const headerActions =
    (journey && dunningStatus) || actions ? (
      <div className="flex flex-wrap items-center gap-2">
        {journey && dunningStatus ? <StatusChip status={dunningStatus} /> : null}
        {actions}
      </div>
    ) : undefined;
  const strip = journey && summary && layout === "card";
  return (
    <SectionCard
      id="payments"
      layout={layout}
      title={journey ? "Payments and dunning" : "Payments and credits"}
      actions={headerActions}
      contentClassName={strip ? "p-0" : undefined}
    >
      {journey ? (
        strip ? (
          <>
            <JourneySummary journey={journey} tz={tz} {...summary} />
            <div className="px-5 py-4">
              {intents}
              <DunningJourneyView journey={journey} transactions={transactions} biz={biz} tz={tz} />
            </div>
          </>
        ) : (
          <>
            {intents}
            <DunningJourneyView journey={journey} transactions={transactions} biz={biz} tz={tz} />
          </>
        )
      ) : (
        list
      )}
    </SectionCard>
  );
}

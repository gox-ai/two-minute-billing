import * as React from "react";
import Link from "next/link";
import type {
  DunningJourney,
  DunningJourneyAttempt,
  DunningJourneyEvent,
  DunningJourneyStep,
} from "@/lib/api";
import type { Transaction } from "@/lib/api/payments";
import { fmtDateTime, money } from "@/lib/format";
import { cn } from "@/lib/utils";
import { JourneyMarker, type MarkKind } from "@/components/patterns/journey-marker";

/**
 * One history for an invoice's money and dunning: every attempt (with its transaction and
 * refusal), refunds and reversals, the dunning events around them, then the forecast.
 * A pure view, so the invoice page's Refresh control can re-render it client-side.
 */

const SHOWN = 8;
const SHOWN_COMPACT = 3;

const EVENT_LABEL: Record<string, string> = {
  invoice_dunning_started: "Dunning started",
  invoice_dunning_reminder: "Reminder email sent to the customer",
  invoice_dunning_exhausted: "Dunning ended",
  invoice_paid: "Invoice paid",
  invoice_not_paid: "Invoice marked not paid",
  invoice_voided: "Invoice voided",
  invoice_written_off: "Invoice written off",
  "invoice.pause_dunning": "Dunning paused",
  "invoice.stop_dunning": "Dunning stopped",
};

const TXN_LABEL: Record<string, string> = {
  refund: "Refund",
  payment_reversal: "Payment reversed",
  authorization: "Authorization",
  payment: "Payment",
};

const FINAL_INVOICE: Record<string, string> = {
  not_paid: "the invoice is marked not paid",
  void: "the invoice is voided",
  write_off: "the invoice is written off",
  reverse: "the invoice is reversed",
};

/** "If it is still unpaid, …" — the final action in words, shared by the row and the summary. */
export function finalActionSentence(
  s: Extract<DunningJourneyStep, { kind: "final_action" }>,
): string {
  return `If it is still unpaid, ${FINAL_INVOICE[s.invoice] ?? s.invoice}${
    s.subscription === "cancel"
      ? " and the subscription is cancelled."
      : s.subscription === "retain"
        ? " and the subscription stays active."
        : "."
  }`;
}

const NOTE: Record<string, string> = {
  stopped: "Dunning was stopped. Nothing more happens automatically.",
  exhausted: "Dunning ended. Nothing more happens automatically.",
  auto_collect_off: "Auto-collection is off, so nothing is charged automatically.",
  dunning_off: "Dunning does not apply to this invoice, so we do not retry automatically.",
  customer_excluded:
    "This customer is excluded from dunning, so we do not retry or send reminders. When the exclusion is removed, dunning continues.",
  below_minimum:
    "The amount due is less than the dunning minimum for this currency, so we do not retry or send reminders.",
};

/** Only a person is worth naming; system actors (`billing_clock`, a bare `dashboard` key) are not. */
function person(actor: string | null): string | null {
  return actor && actor.includes("@") ? actor : null;
}

function humanize(s: string): string {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Older declines stored the raw gateway code as the message too; show it once. */
function declineMessage(message: string | null, code: string | null): string | null {
  return message && message !== code ? message : null;
}

/** Still at the gateway: neither paid nor declined yet. */
function inFlight(a: DunningJourneyAttempt): boolean {
  return a.presented && a.status !== "succeeded" && a.status !== "failed";
}

function triggerLabel(a: DunningJourneyAttempt, retryNumber: number | null): string | null {
  switch (a.trigger) {
    case "billing_clock":
      return retryNumber ? `Automatic retry ${retryNumber}` : "First charge";
    case "dashboard":
      return person(a.actor) ? `Manual collection by ${person(a.actor)}` : "Manual collection";
    case "portal":
      return "Paid by the customer in the portal";
    case "new_payment_method":
      return "Charged when the customer added a payment method";
    case "offline":
      return person(a.actor) ? `Recorded by ${person(a.actor)}` : "Recorded offline";
    case "api":
      return "Collected through the API";
    default:
      return null;
  }
}

function methodLabel(pm: DunningJourneyAttempt["payment_method"]): string | null {
  if (!pm) return null;
  const name = pm.brand ? pm.brand.charAt(0).toUpperCase() + pm.brand.slice(1) : humanize(pm.type);
  const rail = pm.rail && pm.rail !== "card" ? ` (${pm.rail.toUpperCase()})` : "";
  return pm.last4 ? `${name} •••• ${pm.last4}${rail}` : `${name}${rail}`;
}

function Row({
  mark,
  title,
  when,
  children,
  muted,
}: {
  mark: MarkKind;
  title: React.ReactNode;
  when: string;
  children?: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <li className="flex gap-3.5 [&:last-child>div>.connector]:hidden">
      <div className="flex shrink-0 flex-col items-center">
        <JourneyMarker kind={mark} />
        <span className="connector mt-1 w-px flex-1 bg-border" aria-hidden />
      </div>
      <div className="min-w-0 flex-1 pt-1 pb-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
          <span className={cn("text-sm font-medium", muted && "text-muted-foreground")}>
            {title}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">{when}</span>
        </div>
        {children ? (
          <div className="mt-0.5 space-y-1 text-sm text-muted-foreground tabular-nums">
            {children}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function TxnLink({ biz, id }: { biz: string; id: string }) {
  return (
    <Link
      href={`/businesses/${biz}/transactions/${id}`}
      className="font-mono text-xs text-primary hover:underline"
    >
      {id}
    </Link>
  );
}

function Reason({ message, code }: { message: string | null; code: string | null }) {
  if (!message && !code) return null;
  // The readable reason; the code stays one hover away.
  return (
    <div
      title={code ?? undefined}
      className="mt-1.5 w-fit max-w-full rounded-md border border-destructive/20 bg-destructive-soft px-2 py-0.5 text-xs text-destructive"
    >
      {declineMessage(message, code) ?? humanize(code!)}
    </div>
  );
}

/** An attempt's title and detail line. */
function describeAttempt(
  a: DunningJourneyAttempt,
  txn: Transaction | undefined,
  retryNumber: number | null,
): { ok: boolean; title: string; detail: string } {
  const ok = a.status === "succeeded";
  const offline = a.trigger === "offline";
  // The transaction's gateway key names the method (`offline_bank_transfer`); the payment
  // row may only say "offline".
  const method = txn?.gateway_key?.startsWith("offline_")
    ? txn.gateway_key.slice("offline_".length)
    : a.offline_method && a.offline_method !== "offline"
      ? a.offline_method
      : null;
  const title = offline
    ? `Offline payment${method ? ` · ${humanize(method)}` : ""}`
    : ok
      ? "Payment succeeded"
      : !a.presented
        ? "Refused before sending"
        : a.status === "failed"
          ? "Payment failed"
          : `Payment ${a.status.replace(/_/g, " ")}`;
  const detail = [
    money(a.amount_minor, a.currency),
    offline ? null : methodLabel(a.payment_method),
    triggerLabel(a, retryNumber),
  ]
    .filter(Boolean)
    .join(" · ");
  return { ok, title, detail };
}

function AttemptRow({
  a,
  txn,
  retryNumber,
  biz,
  tz,
  compact,
}: {
  a: DunningJourneyAttempt;
  txn: Transaction | undefined;
  retryNumber: number | null;
  biz: string;
  tz: string | null;
  compact?: boolean;
}) {
  const { ok, title, detail } = describeAttempt(a, txn, retryNumber);
  const mark = ok ? "paid" : !a.presented ? "refused" : inFlight(a) ? "pending" : "failed";
  // Compact: one detail line with the reason in it; the transaction is on the invoice page.
  if (compact) {
    const reason =
      !ok && !inFlight(a) && (a.failure_message || a.failure_code)
        ? (declineMessage(a.failure_message, a.failure_code) ?? humanize(a.failure_code!))
        : null;
    return (
      <Row mark={mark} title={title} when={fmtDateTime(a.at, tz)}>
        <div>
          {detail}
          {reason ? (
            <span className="text-destructive" title={a.failure_code ?? undefined}>
              {" · "}
              {reason}
            </span>
          ) : txn?.awaiting_authentication ? (
            <span className="text-warning"> · Waiting for the customer's bank approval</span>
          ) : null}
        </div>
      </Row>
    );
  }
  return (
    <Row mark={mark} title={title} when={fmtDateTime(a.at, tz)}>
      <div>{detail}</div>
      {!ok && !inFlight(a) ? <Reason message={a.failure_message} code={a.failure_code} /> : null}
      {txn?.awaiting_authentication ? (
        <div className="text-warning">
          Waiting for the customer to approve this with their bank. It expires if they do not
          approve it.
        </div>
      ) : null}
      <div>
        {a.transaction ? (
          <TxnLink biz={biz} id={a.transaction} />
        ) : !a.presented ? (
          <span className="text-xs">
            We sent nothing to the gateway, so there is no transaction.
          </span>
        ) : null}
      </div>
    </Row>
  );
}

function TransactionRow({
  t,
  biz,
  tz,
  compact,
}: {
  t: Transaction;
  biz: string;
  tz: string | null;
  compact?: boolean;
}) {
  const ok = t.status === "succeeded";
  const failed = t.status === "failed";
  const outflow = t.type === "refund" || t.type === "payment_reversal";
  const pm = t.payment_method?.brand
    ? `${humanize(t.payment_method.brand)}${t.payment_method.last4 ? ` •••• ${t.payment_method.last4}` : ""}`
    : null;
  return (
    <Row
      mark={failed ? "failed" : ok ? "paid" : "neutral"}
      title={`${TXN_LABEL[t.type] ?? humanize(t.type)}${failed ? " failed" : ok ? "" : ` ${t.status.replace(/_/g, " ")}`}`}
      when={fmtDateTime(t.occurred_at ?? t.created_at, tz)}
    >
      <div>
        {[`${outflow ? "−" : ""}${money(t.amount_minor, t.currency)}`, pm]
          .filter(Boolean)
          .join(" · ")}
      </div>
      {failed ? <Reason message={t.error_text} code={t.error_code} /> : null}
      {compact ? null : (
        <div>
          <TxnLink biz={biz} id={t.id} />
        </div>
      )}
    </Row>
  );
}

function EventRow({ e, tz }: { e: DunningJourneyEvent; tz: string | null }) {
  const label = EVENT_LABEL[e.type] ?? humanize(e.type);
  return (
    <Row
      mark="event"
      title={person(e.actor) ? `${label} by ${person(e.actor)}` : label}
      when={fmtDateTime(e.at, tz)}
      muted
    />
  );
}

function StepRow({ s, tz }: { s: DunningJourneyStep; tz: string | null }) {
  const when = fmtDateTime(s.at, tz);
  switch (s.kind) {
    case "retry":
      return <Row mark="next" title="Automatic retry" when={when} muted />;
    case "deadline_attempt":
      return (
        <Row mark="next" title="Last attempt, at the end of the dunning period" when={when} muted />
      );
    case "hold":
      return (
        <Row
          mark="next"
          title={
            s.reason === "network_limit"
              ? "No more debits: the payment network's retry limit is reached"
              : "Held for the customer: no automatic charges"
          }
          when={when}
          muted
        >
          Until {fmtDateTime(s.until, tz)}.{" "}
          {s.reason === "parked"
            ? "We send reminders. We charge a new payment method when the customer adds it."
            : "The customer can still pay, or authorize a new payment method."}
        </Row>
      );
    case "final_action":
      return (
        <Row mark="next" title="Final action" when={when} muted>
          {finalActionSentence(s)}
        </Row>
      );
  }
}

type Entry = { at: number; node: (key: number) => React.ReactNode };

/** What happens next, in a line or two: the first forecast step, then the final action. */
function nextLines(projection: DunningJourneyStep[], tz: string | null): string[] {
  const [first] = projection;
  const final = projection.find((s) => s.kind === "final_action");
  const line = (s: DunningJourneyStep): string => {
    const when = fmtDateTime(s.at, tz);
    switch (s.kind) {
      case "retry":
        return `Next automatic retry: ${when}.`;
      case "deadline_attempt":
        return `Last attempt: ${when}, at the end of the dunning period.`;
      case "hold":
        return s.reason === "network_limit"
          ? `No more debits until ${fmtDateTime(s.until, tz)}: the payment network's retry limit is reached.`
          : `Held for the customer until ${fmtDateTime(s.until, tz)}. No automatic charges.`;
      case "final_action":
        return `Final action on ${when}. ${finalActionSentence(s)}`;
    }
  };
  return first ? [line(first), ...(final && final !== first ? [line(final)] : [])] : [];
}

/**
 * The invoice page's card, or — `compact` — the same rows in a needs-attention card: the
 * latest few entries, a link to the rest on the invoice, and what happens next.
 */
export function DunningJourneyView({
  journey,
  transactions,
  biz,
  tz,
  compact,
}: {
  journey: DunningJourney;
  transactions: Transaction[];
  biz: string;
  tz: string | null;
  /** The invoice page, where the earlier entries and the full forecast are. */
  compact?: { href: string };
}) {
  const byId = new Map(transactions.map((t) => [t.id, t]));
  const linked = new Set(
    journey.history.flatMap((h) => (h.kind === "attempt" && h.transaction ? [h.transaction] : [])),
  );
  // The clock's first attempt is the first charge; its later ones are numbered retries.
  let attemptsSeen = 0;
  let retries = 0;
  const entries: Entry[] = [
    ...journey.history.map((h): Entry => {
      if (h.kind === "event")
        return { at: Date.parse(h.at), node: (k) => <EventRow key={k} e={h} tz={tz} /> };
      const retryNumber = h.trigger === "billing_clock" && attemptsSeen > 0 ? ++retries : null;
      attemptsSeen++;
      return {
        at: Date.parse(h.at),
        node: (k) => (
          <AttemptRow
            key={k}
            a={h}
            txn={h.transaction ? byId.get(h.transaction) : undefined}
            retryNumber={retryNumber}
            biz={biz}
            tz={tz}
            compact={!!compact}
          />
        ),
      };
    }),
    // Money the attempts don't account for: refunds, reversals, anything booked without one.
    ...transactions
      .filter((t) => !linked.has(t.id))
      .map((t): Entry => ({
        at: Date.parse(t.occurred_at ?? t.created_at),
        node: (k) => <TransactionRow key={k} t={t} biz={biz} tz={tz} compact={!!compact} />,
      })),
  ].sort((x, y) => x.at - y.at);

  const shown = compact ? SHOWN_COMPACT : SHOWN;
  const earlier = entries.length > shown ? entries.slice(0, -shown) : [];
  const recent = entries.slice(earlier.length);
  const note = journey.projection_note ? NOTE[journey.projection_note] : null;
  const next = compact && journey.projection?.length ? nextLines(journey.projection, tz) : null;

  return (
    <div className={compact ? "space-y-3" : "space-y-5"}>
      {entries.length ? (
        <div className="space-y-3">
          {earlier.length && compact ? (
            <Link href={compact.href} className="block text-sm text-primary hover:underline">
              View {earlier.length} earlier {earlier.length === 1 ? "entry" : "entries"} on the
              invoice
            </Link>
          ) : earlier.length ? (
            <details className="group">
              <summary className="cursor-pointer text-sm text-primary select-none">
                <span className="group-open:hidden">Show {earlier.length} earlier entries</span>
                <span className="hidden group-open:inline">Hide earlier entries</span>
              </summary>
              <ol className="mt-3">{earlier.map((e, i) => e.node(i))}</ol>
            </details>
          ) : null}
          <ol>{recent.map((e, i) => e.node(earlier.length + i))}</ol>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No payments or collection attempts yet.</p>
      )}
      {next ? (
        <div className="space-y-0.5 border-t pt-3 text-sm text-muted-foreground tabular-nums">
          {next.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
      ) : !compact && journey.projection?.length ? (
        <div className="space-y-2 border-t pt-4">
          <h3 className="text-sm font-semibold">What happens next, if each retry fails</h3>
          <ol>
            {journey.projection.map((s, i) => (
              <StepRow key={i} s={s} tz={tz} />
            ))}
          </ol>
          <p className="text-xs text-muted-foreground">
            A forecast from the latest decline. A different decline, a new payment method or a
            manual collection changes it.
          </p>
        </div>
      ) : note ? (
        <p className={cn("border-t text-sm text-muted-foreground", compact ? "pt-3" : "pt-4")}>
          {note}
        </p>
      ) : null}
    </div>
  );
}

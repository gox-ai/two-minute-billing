import * as React from "react";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/patterns/copy-button";

type Tone = "green" | "tan" | "red" | "gray" | "blue" | "slate";

/**
 * Chip tones, on semantic tokens rather than pinned Tailwind palette steps.
 *
 * Every chip is a filled pill; the tone carries the meaning (see StatusChip).
 */
const TONE_FILL: Record<Tone, string> = {
  green: "border-success/25 bg-success-soft text-success",
  tan: "border-warning/25 bg-warning-soft text-warning",
  red: "border-destructive/25 bg-destructive-soft text-destructive",
  gray: "border-border bg-muted text-muted-foreground",
  blue: "border-info/25 bg-info-soft text-info",
  slate: "border-border bg-muted text-muted-foreground",
};

const STATUS_TONE: Record<string, Tone> = {
  // HubSpot sync: a run that pushed some records and failed others; a revoked install.
  partial: "tan",
  reauth_required: "red",
  // Billing-clock diary (due work). `overdue` is the ONLY one that fills: work whose
  // date has passed and which the clock has not done is the whole reason that screen
  // exists. `due_now` and `upcoming` are the healthy, expected states of a diary — a book
  // full of upcoming renewals is a working business, not a wall of alerts — so they stay
  // quiet, per the rule that a fill is reserved for something needing a human.
  overdue: "red",
  due_now: "blue",
  upcoming: "gray",
  active: "green",
  // Team vocabulary (2026-08-30). An INVITED member cannot sign in yet, so the row is
  // unfinished business — it fills, like the other states waiting on a person. The
  // person is the invitee rather than the admin reading the screen, but "who can
  // actually get in" is exactly what an admin comes to this table to see.
  invited: "tan",
  paid: "green",
  succeeded: "green",
  success: "green",
  enabled: "green",
  trialing: "tan",
  in_trial: "tan",
  open: "tan",
  posted: "tan",
  payment_due: "tan",
  not_paid: "red",
  // Dunning vocabulary. PARKED is a hard-but-recoverable decline: the retry
  // ladder is halted and the invoice waits on the CUSTOMER to fix their card, so
  // it needs a human and must not read as neutral. It fell through to grey until
  // 2026-08-21, i.e. exactly like a terminal state that needs nothing.
  // (`exhausted` / `stopped` are deliberately left neutral — those really are
  // ends: the ladder ran out, or an operator halted it.)
  parked: "tan",
  // Usage events: an unmatched event waits for a usage key on a customer.
  matched: "green",
  unmatched: "tan",
  // Transaction-log vocabulary (SUCCESS green, VOIDED neutral, failures red,
  // unsettled states amber).
  voided: "gray",
  // Payment-intent / payment-attempt vocabulary (PI_STATUSES + attempt statuses).
  // Spelled out rather than left to fall through the `?? 'gray'` default, so the
  // reason each one is neutral is on the record: `inited` is merely new, and
  // `consumed`/`voided`/`expired` are the normal ENDS of an intent's life.
  // `authorized` is the healthy milestone (the gateway approved the buyer);
  // `requires_action` is the one that genuinely waits on a human, so it fills.
  inited: "gray",
  authorized: "green",
  consumed: "gray",
  requires_action: "tan",
  in_progress: "tan",
  // Payment-request vocabulary: money moving on an async rail, waiting for its webhook.
  processing: "tan",
  // DERIVED, not an engine status — see `lib/payment-intent-status.ts`. An intent has no
  // `failed` of its own, so an open intent whose newest attempt was refused used to render
  // as `in_progress` ("the buyer is mid-challenge"), directly above its own failed attempt.
  // Red because the refusal is the fact that needs a human: nothing will move this row on
  // its own, and it lapses at its expiry unless someone retries or voids it.
  attempt_failed: "red",
  timeout: "tan",
  needs_attention: "tan",
  failure: "red",
  late_failure: "red",
  late_failed: "red",
  past_due: "tan",
  pending: "tan",
  future: "blue",
  // TERMINAL states are neutral. Cancelled is the normal end of a subscription's
  // life, not a failure — rendering it red made a mostly-churned list read as an
  // outage and buried the rows that actually needed attention.
  canceled: "gray",
  cancelled: "gray",
  expired: "gray",
  non_renewing: "gray",
  void: "gray",
  uncollectible: "red",
  failed: "red",
  // Job-queue vocabulary. `abandoned` = locked by a worker that is gone AND out of
  // attempts, so nothing will ever claim it — and on a named queue it is blocking
  // every job behind it. It FILLS because it needs a human: it looked exactly like
  // `running` (neutral) for the 46 minutes the billing clock was down on 2026-08-29,
  // which is the whole reason the state was split out. Not terminal-neutral — a
  // terminal state is a life that ENDED, this is one that stopped mid-stride.
  abandoned: "red",
  paused: "gray",
  archived: "gray",
  imported: "slate",
  // ── `refund_due` IS NOT A FAILURE (corrected 2026-08-31) ────────────────────────
  // This was amber-on-fill with the label "payout pending/failed", on the premise that
  // it meant "gateway refund failed/hasn't landed yet, refunded_minor lags total_minor".
  // That premise is false. `refund_due` is the BIRTH status of every refundable credit
  // note — `credit-notes/service.ts` writes `status: total > 0n ? 'refund_due' :
  // 'refunded'` at creation — it means credits yet to be used, or partially used. It
  // says nothing about a payout.
  //
  // Reported from a real screen: an invoice showed "A card refund for this invoice hasn't
  // reached the gateway yet — the payout is pending or failed and will be retried" beside
  // a note whose own page correctly said "No gateway refund available — this note's
  // invoice has no payment left to reverse". `payout_attempt_at` was NULL, refunded 0,
  // paid out 0, and NO credit note in the database has ever had a payout attempt. The
  // label invented a failure. At the time of the report 3,693 notes were in this state,
  // 150 of them on invoices with no cash at all, where the claim is maximally misleading.
  //
  // So: INFO. `blue` is not an alarm tone, which is the point — an unspent
  // credit note needs nobody. It stays distinct from `refunded`/`adjusted` (grey, settled)
  // because "still available" is worth seeing; it just is not an alarm. A genuine failed
  // payout is a real state worth flagging, but it cannot be read off this status: it needs
  // `payout_attempt_at`, which the API does not expose to the dashboard. Not faked here —
  // see docs/PROGRESS.md.
  refund_due: "blue",
  // The other two credit-note statuses, spelled out rather than left to the `?? "gray"`
  // default so the reason is on the record (same convention as the payment-intent block
  // above). Both are SETTLED: `adjusted` reduced an unpaid invoice, `refunded` has
  // nothing left available. Only `refund_due` still needs a human.
  refunded: "gray",
  adjusted: "gray",
  // A `refunded` note used up by allocation alone (`creditNoteChipStatus`).
  applied_to_invoices: "gray",
};

// Overrides for statuses whose default `s.replace(/_/g, ' ')` label doesn't
// carry enough context on its own.
const STATUS_LABEL: Record<string, string> = {
  refund_due: "refund due: credit available",
  abandoned: "abandoned: dead worker",
};

// Explanatory tooltip (title attr) for statuses that are easy to misread.
const STATUS_TITLE: Record<string, string> = {
  // `refunded` flips from refund_due on pure ALLOCATION, with amount_refunded still 0.
  // It reads as "money went back" and usually means no such thing, so say so on hover.
  // Kept byte-identical to `status-badge.tsx`: the credit-note LIST renders StatusBadge
  // and the DETAIL renders StatusChip, and one status must not carry two explanations.
  applied_to_invoices:
    "Settled. The credit note is fully applied to invoices. No money went back to the customer.",
  refunded:
    "Settled. Nothing is left AVAILABLE. This does not mean that cash was returned. A credit note gets this status when it is fully used: by allocation to an invoice, by a cash refund, or both. The Allocated and Refunded rows show which.",
  parked:
    "A decline that a retry cannot fix stopped the schedule. Collection resumes automatically when the" +
    " customer updates their payment method.",
  attempt_failed:
    "The gateway refused the newest attempt. The intent stays open, so a new attempt can use it." +
    " The intent has no failed status of its own. It expires at its expiry date unless someone" +
    " retries or voids it. The Intent Status row shows the stored value.",
  refund_due:
    "A credit note with money still on it. Nothing was attempted and nothing failed." +
    " The Available row shows what the customer can still get paid or can still spend. The status" +
    " changes to Refunded when the note is fully used: by allocation to an invoice, by a refund, or both.",
  abandoned:
    "A worker that no longer exists holds the lock, and no attempts are left. Nothing will claim it." +
    " If it is on a named queue, it blocks every job behind it until the lock is released." +
    " The ops_release_stranded_locks sweep clears this automatically in approximately 5 minutes.",
};

/**
 * Status chip. Every status is a FILLED pill, the same shape as `Chip`, so a status
 * sits beside the other pills in a header without looking like a different kind of
 * mark. Colour still carries the meaning: healthy green, needs-action red/amber,
 * terminal (cancelled, void, archived…) neutral grey — never red.
 *
 * Set at 12px — the previous 10px was below the readable floor for a surface
 * operators scan all day, and appeared ~54 times per list page.
 */
export function StatusChip({
  status,
  className,
}: {
  status: string | null | undefined;
  className?: string;
}) {
  const s = (status ?? "").toLowerCase();
  const tone = STATUS_TONE[s] ?? "gray";
  const raw = STATUS_LABEL[s] ?? s.replace(/_/g, " ");
  // Sentence case, like every other label: "Not paid", not "Not Paid".
  const label = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "—";
  const title = STATUS_TITLE[s];
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE_FILL[tone],
        className,
      )}
    >
      {label}
    </span>
  );
}

/** Neutral informational chip (channel, currency, frequency, trial countdown…). */
export function Chip({
  children,
  tone = "gray",
  title,
  className,
}: {
  children: React.ReactNode;
  tone?: Tone;
  /** Hover explanation, for a chip whose one word carries more than one word of meaning. */
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        tone === "gray" ? "border-border bg-muted/60 text-foreground/80" : TONE_FILL[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Id chip with copy-to-clipboard (e.g. "Subscription ID sub_…"). */
export function IdChip({
  label,
  id,
  className,
}: {
  label?: string;
  id: string;
  className?: string;
}) {
  return (
    // May shrink below the ID's width (a phone header): the ID truncates, copy keeps it whole.
    <Chip className={cn("max-w-full min-w-0 shrink font-mono text-xs", className)}>
      {label ? <span className="shrink-0 font-sans text-muted-foreground">{label}</span> : null}
      <span className="min-w-0 truncate" title={id}>
        {id}
      </span>
      <CopyButton value={id} className="-mr-1 shrink-0" />
    </Chip>
  );
}

/** Wrapping row of chips under a detail-page title. */
export function ChipRow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("flex flex-wrap items-center gap-1.5", className)}>{children}</div>;
}

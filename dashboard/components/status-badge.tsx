import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Tone = "green" | "amber" | "red" | "gray" | "blue";

const TONE: Record<string, Tone> = {
  // green
  active: "green",
  trialing: "green",
  in_trial: "green",
  future: "blue",
  paid: "green",
  succeeded: "green",
  enabled: "green",
  // ops / system monitor
  alive: "green",
  ok: "green",
  running: "blue",
  scheduled: "blue",
  stale: "red",
  stopped: "gray",
  overran: "amber",
  // A clock gap with no worker up — informational, not the clock struggling.
  gap: "gray",
  errors: "red",
  // A tick row the engine opened and never closed: the worker died mid-tick, or a
  // pass threw before `finishClockTick`. Nothing server-side revisits it, so this
  // badge is the only place it surfaces.
  abandoned: "red",
  // amber
  open: "amber",
  posted: "amber",
  payment_due: "amber",
  not_paid: "red",
  past_due: "amber",
  pending: "amber",
  // Outbound webhook DELIVERY states (`webhook_deliveries.status`). They were missing, so
  // `delivered` fell through to gray — and callers worked around that by passing `'paid'`,
  // which is why an endpoint's status chip read "Paid". A delivery is not an invoice; borrowing
  // another domain's vocabulary to borrow its colour makes the label lie. `failed` was already
  // mapped; `exhausted` — a delivery that has given up for good — was rendering GRAY, which is
  // worse than a wrong word: a dead delivery looked like an ordinary terminal state.
  delivered: "green",
  exhausted: "red",
  // Terminal and BENIGN, so neutral by the design system's own rule — and declared here rather
  // than left to fall through, which is how `delivered` ended up gray in the first place.
  // `skipped`: the integration had nothing to send for this event (an organic signup, a
  // zero-value sale). `superseded`: this delivery was replayed, and a newer row carries the
  // outcome — without it a replayed failure stays red forever and is indistinguishable at a
  // glance from one that still needs attention.
  skipped: "gray",
  superseded: "gray",
  // ── `refund_due` IS NOT A FAILURE (corrected 2026-08-31) ────────────────────────
  // This was amber-on-fill with the label "payout pending/failed", on the premise that
  // it meant "gateway refund failed/hasn't landed yet, refunded_minor lags total_minor".
  // That premise is false. `refund_due` is the BIRTH status of every refundable credit
  // note — `credit-notes/service.ts` writes `status: total > 0n ? 'refund_due' :
  // 'refunded'` at creation — and it means "credits yet to be used, or partially
  // used". It says nothing about a payout.
  //
  // Reported from a real screen: an invoice showed "A card refund for this invoice hasn't
  // reached the gateway yet — the payout is pending or failed and will be retried" beside
  // a note whose own page correctly said "No gateway refund available — this note's
  // invoice has no payment left to reverse". `payout_attempt_at` was NULL, refunded 0,
  // paid out 0, and NO credit note in the database has ever had a payout attempt. The
  // label invented a failure. At the time of the report 3,693 notes were in this state,
  // 150 of them on invoices with no cash at all, where the claim is maximally misleading.
  //
  // So: INFO. `blue` renders `info-soft` here, which reads informational rather than
  // "needs a human" — an unspent credit note needs nobody. It stays distinct from
  // `refunded`/`adjusted` (grey, settled) because "still available" is worth seeing; it
  // just is not an alarm. (This file gives every tone a soft fill; `patterns/chip.tsx` splits
  // quiet from filled, and there `blue` is deliberately outside `NEEDS_ACTION`. Both land
  // on the same reading, and the label and tooltip below are byte-identical to that file's
  // by long-standing convention — the credit-note LIST renders StatusBadge and the DETAIL
  // renders StatusChip, and one status must not carry two explanations.)
  // A genuine failed payout IS a real state worth flagging, but it cannot be read off this
  // status: it needs `payout_attempt_at`, which the API does not expose to the dashboard.
  // Not faked here — see docs/PROGRESS.md.
  refund_due: "blue",
  // red — a real problem, someone has to act
  uncollectible: "red",
  failed: "red",
  no_payment_method: "red",
  // gray — TERMINAL states. Cancelled and void are normal ends of life, not
  // errors: rendering them red made a churned list read as an outage.
  canceled: "gray",
  cancelled: "gray",
  void: "gray",
  // `voided` is the spelling invoices, credit notes, transactions and payment intents
  // actually emit; only `void` above was mapped neutral, so every voided row rendered
  // RED — an error mark on the normal end of a document's life, against this file's own
  // rule two lines up. `patterns/chip.tsx` already had it grey: this was the two chip systems
  // drifting. The surface it reached is the credit-notes LIST (the only StatusBadge
  // consumer whose vocabulary includes `voided`) — 274 voided notes in this database.
  // The invoices list renders StatusChip, so it was never affected.
  voided: "gray",
  expired: "gray",
  non_renewing: "gray",
  archived: "gray",
  draft: "gray",
  paused: "gray",
  credited: "gray",
  disabled: "gray",
};

// Semantic tokens, so these follow the theme instead of pinning Tailwind palette
// steps that no longer match the design system (and needed hand-written `dark:`
// variants for every single one).
const TONE_CLASS: Record<Tone, string> = {
  green: "border-success/25 bg-success-soft text-success",
  amber: "border-warning/25 bg-warning-soft text-warning",
  red: "border-destructive/25 bg-destructive-soft text-destructive",
  gray: "border-border bg-muted text-muted-foreground",
  blue: "border-info/25 bg-info-soft text-info",
};

const DOT_CLASS: Record<Tone, string> = {
  green: "bg-success",
  amber: "bg-warning",
  red: "bg-destructive",
  gray: "bg-muted-foreground/60",
  blue: "bg-info",
};

// Overrides for statuses whose default `s.replace(/_/g, ' ')` label doesn't
// carry enough context on its own.
const LABEL_OVERRIDE: Record<string, string> = {
  refund_due: "refund due: credit available",
};

// Explanatory tooltip (title attr) for statuses that are easy to misread.
const TITLE_OVERRIDE: Record<string, string> = {
  // The word is deliberate: the status flips refund_due → refunded on pure ALLOCATION,
  // with amount_refunded still 0. It reads as "money went back" and usually means no such
  // thing: 2,201 of the 3,770 engine-created `refunded` notes in the local DB have
  // refunded_minor = 0. Say so on hover.
  applied_to_invoices:
    "Settled. The credit note is fully applied to invoices. No money went back to the customer.",
  refunded:
    "Settled. Nothing is left AVAILABLE. This does not mean that cash was returned. A credit note gets this status when it is fully used: by allocation to an invoice, by a cash refund, or both. The Allocated and Refunded rows show which.",
  refund_due:
    "A credit note with money still on it. Nothing was attempted and nothing failed." +
    " The Available row shows what the customer can still get paid or can still spend. The status" +
    " changes to Refunded when the note is fully used: by allocation to an invoice, by a refund, or both.",
  abandoned:
    "The clock started this tick but did not record a completion. The worker stopped during the tick, or a pass threw an error. Its counters are incomplete.",
};

/** Sentence case, like every other label: "Not paid", not "Not Paid". */
function label(status: string) {
  const t = LABEL_OVERRIDE[status] ?? status.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Maps a domain status string to a soft colored pill with a status dot. */
export function StatusBadge({
  status,
  className,
}: {
  status: string | null | undefined;
  className?: string;
}) {
  const s = (status ?? "").toLowerCase();
  const tone = TONE[s] ?? "gray";
  const title = TITLE_OVERRIDE[s];
  return (
    <Badge
      variant="outline"
      title={title}
      className={cn("gap-1.5 font-medium", TONE_CLASS[tone], className)}
    >
      <span className={cn("size-1.5 rounded-full", DOT_CLASS[tone])} aria-hidden />
      {status ? label(s) : "—"}
    </Badge>
  );
}

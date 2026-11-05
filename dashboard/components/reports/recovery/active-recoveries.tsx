import * as React from "react";
import Link from "next/link";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Chip } from "@/components/patterns/chip";
import { EmptyState } from "@/components/states";
import { money, fmtDateTime } from "@/lib/format";
import type { RetryRow } from "@/lib/api/retries";
import { RotateCcw } from "lucide-react";

/**
 * The campaign ladder, resolved for THIS business.
 *
 * `retries` is the structured config and supersedes the legacy day list; neither being set
 * means the engine's own fallback applies (`DUNNING_RETRY_DAYS`, `modules/subscriptions/
 * dunning-schedule.ts`). The screen resolves the real ladder rather than printing a
 * plausible one — a progress fraction against a schedule the business does not use is a
 * number that looks precise and is wrong.
 */
export interface Ladder {
  /** Day offsets from the invoice's due date, in order. */
  days: number[];
  /** Whether the offsets come from the engine fallback rather than the business. */
  isDefault: boolean;
  /** What happens to the invoice once dunning gives up, where the business states one. */
  finalInvoiceAction: string | null;
}

/**
 * Total charge attempts the ladder implies: the initial charge plus one per retry offset.
 *
 * ⚠️ Not a cap. Exhaustion is decided by the retry clock running off the end of the
 * resolved list, so this is what the schedule PLANS, which is why the column says
 * "of N planned" rather than presenting itself as a limit.
 */
const plannedAttempts = (ladder: Ladder) => ladder.days.length + 1;

const FINAL_ACTION_LABEL: Record<string, string> = {
  not_paid: "marked not paid",
  void: "voided",
  write_off: "written off",
  reverse: "reversed",
};

/** Where the campaign stands, in the words the engine's own states justify. */
function nextStep(r: RetryRow, ladder: Ladder, tz: string | null): React.ReactNode {
  if (r.next_attempt_at) {
    return <span className="whitespace-nowrap">{fmtDateTime(r.next_attempt_at, tz)}</span>;
  }
  // `parked` is a hard-but-recoverable refusal: the ladder is halted on purpose and
  // nothing will be re-presented until the card changes. Saying "no retry scheduled"
  // would read as a defect.
  if (r.dunning_status === "parked") {
    return <span className="text-muted-foreground">Waiting for the customer&rsquo;s card</span>;
  }
  // A live attempt has no successor scheduled precisely BECAUSE its outcome is unknown —
  // the most active row on the screen, not a stalled one.
  if (r.dunning_status === "in_progress" || r.dunning_status == null) {
    return <span className="text-muted-foreground">Waiting for this attempt to settle</span>;
  }
  const action = ladder.finalInvoiceAction
    ? (FINAL_ACTION_LABEL[ladder.finalInvoiceAction] ?? ladder.finalInvoiceAction)
    : null;
  return (
    <span className="text-muted-foreground">
      {action ? `No retries left. Invoice ${action}.` : "No retries left"}
    </span>
  );
}

/**
 * Active recoveries — the invoices dunning is working right now, and where each one is in
 * its campaign.
 *
 * This is the one block on the page that needs a human, so it is the one block carrying a
 * fill: the retry state chip. Everything above it is a figure about work already done.
 *
 * Read-only by design. Every collections ACTION (retry now, stop dunning, write off) lives
 * on the invoice, and a per-row button here would be a second, thinner copy of a control
 * that already exists one click away.
 */
export function ActiveRecoveries({
  biz,
  rows,
  ladder,
  tz,
}: {
  biz: string;
  rows: RetryRow[];
  ladder: Ladder;
  tz: string | null;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<RotateCcw />}
        title="Nothing is under retry"
        description="No invoice is in a dunning campaign now. The outcomes above count recovered invoices and invoices that dunning stopped."
      />
    );
  }

  const planned = plannedAttempts(ladder);

  return (
    // Frameless: the page's card carries the title, the link out and this table's note.
    // Below md the attempt and refusal columns step aside; the rest scrolls inside the card.
    // Below 2xl the attempt bar gives way to its "N of M" text so all seven fit at xl.
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Invoice</TableHead>
          <TableHead>Customer</TableHead>
          <TableHead className="text-right">Amount due</TableHead>
          <TableHead>State</TableHead>
          <TableHead className="hidden whitespace-nowrap md:table-cell">Attempt</TableHead>
          <TableHead className="whitespace-nowrap">Next step</TableHead>
          <TableHead className="hidden md:table-cell">Last refusal</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          // `attempt_count` counts charges already made, so the ladder is complete when
          // it reaches the planned total. Clamped, because the engine consults the
          // resolved list and not this arithmetic — a bar past 100% would be the screen
          // disagreeing with itself rather than the engine being wrong.
          const done = Math.min(r.attempt_count, planned);
          const frac = planned > 0 ? done / planned : 0;
          return (
            <TableRow key={r.invoice}>
              <TableCell className="font-medium whitespace-nowrap">
                <Link
                  href={`/businesses/${biz}/invoices/${r.invoice}`}
                  className="text-primary hover:underline"
                >
                  {r.invoice_number ?? r.invoice}
                </Link>
              </TableCell>
              <TableCell className="max-w-56 truncate">
                {r.customer ? (
                  <Link
                    href={`/businesses/${biz}/customers/${r.customer}`}
                    className="text-primary hover:underline"
                  >
                    {r.customer_name ?? r.customer}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {money(r.amount_due_minor, r.currency)}
              </TableCell>
              <TableCell>
                {/* `in_progress` and `parked` are the two states the chip vocabulary
                      already fills — both are waiting on someone. A row whose dunning pass
                      has not run yet takes the neutral pill. */}
                {r.dunning_status ? (
                  <Chip
                    tone="tan"
                    title={
                      r.dunning_status === "parked"
                        ? "The gateway refused the payment, but recovery is possible. Retries stop until the customer updates their payment method."
                        : "The retry schedule is in progress."
                    }
                  >
                    {r.dunning_status === "parked" ? "Parked" : "Retrying"}
                  </Chip>
                ) : (
                  <Chip tone="gray">Not yet dunned</Chip>
                )}
              </TableCell>
              <TableCell className="hidden whitespace-nowrap md:table-cell">
                <div className="flex items-center gap-2">
                  <div className="hidden h-1.5 w-16 overflow-hidden rounded-md bg-muted 2xl:block">
                    <div
                      className="anim-grow h-full rounded-md bg-primary"
                      style={{ width: `${(frac * 100).toFixed(0)}%` }}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {r.attempt_count === 0 ? `0 of ${planned}` : `${done} of ${planned}`}
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-sm">{nextStep(r, ladder, tz)}</TableCell>
              <TableCell className="hidden max-w-60 truncate text-sm md:table-cell 2xl:max-w-72">
                {r.last_error_code || r.last_error_text ? (
                  <>
                    {r.last_error_code ? (
                      <span className="text-muted-foreground">({r.last_error_code}) </span>
                    ) : null}
                    {r.last_error_text}
                  </>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** What the attempt column counts against. */
export function ActiveRecoveriesNote({ ladder }: { ladder: Ladder }) {
  return (
    <span>
      Attempts count the initial charge plus the{" "}
      <span className="tabular-nums">{ladder.days.length}</span> scheduled retries
      {ladder.days.length > 0 ? (
        <>
          {" "}
          on day{ladder.days.length === 1 ? "" : "s"}{" "}
          <span className="tabular-nums">{ladder.days.join(", ")}</span> after the due date
        </>
      ) : null}
      {ladder.isDefault
        ? ". This is the default schedule, because this business has not set one"
        : ""}
      .
    </span>
  );
}

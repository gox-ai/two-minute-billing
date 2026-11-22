import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Sparkline, type HeadlineChange } from "@/components/analytics/home/parts";
import { Grid } from "@/components/analytics/layout";
import { Busy } from "@/components/reports/skeletons";
import { pctFromBps } from "@/lib/format";
import { BAR_GROW, barStyle, drawKey } from "@/lib/chart-draw";
import { cn } from "@/lib/utils";

/** `2 min 41 s`, `58 s`, `3 h 5 min`; an em dash for no value. */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
}

export const count = (n: number) => n.toLocaleString("en");
export const rate = (bps: number | null | undefined) => (bps == null ? "—" : pctFromBps(bps, 1));

/**
 * Movement against the previous window, as the Headline chip reads it. Null with nothing to
 * compare: no previous window asked for, or nothing in it.
 */
export function changeOf(
  now: number | null,
  before: number | null | undefined,
  /** Which way is good news. */
  good: "up" | "down",
  context: string,
): HeadlineChange | null {
  if (now == null || before == null || before === 0) return null;
  const bps = Math.round(((now - before) / Math.abs(before)) * 10_000);
  const direction = bps > 0 ? "up" : bps < 0 ? "down" : "flat";
  const tone = direction === "flat" ? "neutral" : direction === good ? "good" : "bad";
  return { value: pctFromBps(Math.abs(bps), 1), direction, tone, context };
}

/** The "right now" strip: what is happening this minute, beside the last 30 minutes. */
export function LiveStrip({
  active,
  recent,
  perMinute,
  label,
}: {
  active: string;
  recent: string;
  perMinute: number[];
  label: string;
}) {
  return (
    <div className="anim-rise flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border bg-card px-5 py-3">
      <span className="flex items-center gap-2 text-sm">
        <span className="size-2 rounded-full bg-success" aria-hidden />
        <span className="font-medium">Right now:</span>
        <span className="tabular-nums">{active}</span>
        <span className="text-muted-foreground">·</span>
        <span className="tabular-nums">{recent}</span>
      </span>
      <span className="ms-auto flex items-center gap-2 text-xs text-muted-foreground">
        {label}
        {perMinute.some((n) => n > 0) ? (
          <Sparkline values={perMinute} className="h-8 w-40" />
        ) : (
          <span>none in the last 30 minutes</span>
        )}
      </span>
    </div>
  );
}

/**
 * A closed funnel as a table: each step's count, its share of the first step, what the step
 * before kept, and how many left between them.
 */
export function FunnelTable({
  unit,
  steps,
  timing = false,
}: {
  unit: string;
  steps: Array<{ label: string; sessions: number; median_seconds_from_previous?: number | null }>;
  /** Show the median time from the previous step. */
  timing?: boolean;
}) {
  const first = steps[0]?.sessions ?? 0;
  return (
    <Table phone="stack" fit>
      <TableHeader>
        <TableRow>
          <TableHead phone="title">Step</TableHead>
          <TableHead className="text-right">{unit}</TableHead>
          <TableHead className="text-right">Of first step</TableHead>
          <TableHead className="text-right">Of previous</TableHead>
          <TableHead className="text-right">Left</TableHead>
          {timing ? <TableHead className="text-right">Median time from previous</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {steps.map((s, i) => {
          const prev = i > 0 ? steps[i - 1]!.sessions : null;
          return (
            <TableRow key={s.label}>
              <TableCell>
                <span className="flex items-center gap-3">
                  <span className="text-muted-foreground tabular-nums">{i + 1}.</span>
                  <span className="flex min-w-0 flex-col gap-1">
                    {s.label}
                    <span className="h-1.5 w-32 overflow-hidden rounded-full bg-muted" aria-hidden>
                      <span
                        key={drawKey([s.sessions, first])}
                        className={cn(BAR_GROW, "block h-full rounded-full bg-chart-1")}
                        style={barStyle(first > 0 ? Math.round((s.sessions / first) * 100) : 0, i)}
                      />
                    </span>
                  </span>
                </span>
              </TableCell>
              <TableCell className="text-right">{count(s.sessions)}</TableCell>
              <TableCell className="text-right">
                {first > 0 ? rate(Math.round((s.sessions / first) * 10_000)) : "—"}
              </TableCell>
              <TableCell className="text-right">
                {prev != null && prev > 0 ? rate(Math.round((s.sessions / prev) * 10_000)) : "—"}
              </TableCell>
              <TableCell className="text-right">
                {prev != null ? count(Math.max(0, prev - s.sessions)) : "—"}
              </TableCell>
              {timing ? (
                <TableCell className="text-right">
                  {i > 0 ? fmtDuration(s.median_seconds_from_previous) : "—"}
                </TableCell>
              ) : null}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** The body bones while a filter change reloads the figures. */
export function HostedReportSkeleton({ label }: { label: string }) {
  return (
    <Busy label={label} className="flex flex-col gap-4">
      <Skeleton className="h-12 w-full rounded-xl" />
      <Grid className="gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="col-span-12 rounded-xl border bg-card p-6 lg:col-span-6 @min-[64.375rem]/main:col-span-3"
          >
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-2.5 h-7 w-28" />
            <Skeleton className="mt-2.5 h-3 w-32" />
          </div>
        ))}
      </Grid>
      <Skeleton className="h-72 w-full rounded-xl" />
    </Busy>
  );
}

const GATEWAY_LABELS: Record<string, string> = {
  stripe: "Stripe",
  razorpay: "Razorpay",
  paypal: "PayPal",
  tmtest: "TM Test",
};
const METHOD_LABELS: Record<string, string> = {
  card: "Card",
  upi: "UPI",
  paypal: "PayPal",
  wallet: "Wallet",
  netbanking: "Net banking",
  us_bank_account: "US bank account",
  sepa_debit: "SEPA Direct Debit",
  bank_transfer: "Bank transfer",
  emandate: "Bank mandate",
  none: "No payment",
  unknown: "Not recorded",
};

const sentence = (k: string) => {
  const t = k.replace(/[_-]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
export const gatewayLabel = (k: string | null) => (k ? (GATEWAY_LABELS[k] ?? sentence(k)) : "—");
export const methodLabel = (k: string) => METHOD_LABELS[k] ?? sentence(k);

/** How a portal visit arrived, from the report's arrival key. */
export function arrivalLabel(key: string, emailTypeLabel: (k: string) => string): string {
  if (key === "api") return "Link from the API or the dashboard";
  if (key === "email_code") return "Sign-in with an email code";
  if (key === "email") return "Email (type not recorded)";
  return `${emailTypeLabel(key)} email`;
}

export const DELETE_REASON_LABELS: Record<string, string> = {
  card_replaced: "The card expired or was replaced",
  different_method: "Wants a different payment method",
  cancelling: "Plans to cancel",
  other: "Other",
  none: "No reason given",
};

export const OFFER_LABELS: Record<string, string> = {
  pause: "Took a pause",
  downgrade: "Moved to a cheaper plan",
  discount: "Took a discount",
  contact: "Contacted you",
  other: "Other offer",
};

// Typed fetcher for GET /v1/businesses/:biz/email_report. Read-only, SERVER-ONLY. Days are
// business-zone civil days, inclusive; money is integer minor units in `currency`; rates are
// basis points. Opens and clicks count only emails sent while the business had tracking on.
import { apiGet } from "@/lib/api";

export interface EmailCounts {
  queued: number;
  delivered: number;
  not_sent: number;
  pending: number;
  failed: number;
  bounced: number;
  complained: number;
  skipped: number;
  attempted: number;
  delivered_bps: number | null;
  bounce_bps: number | null;
  complaint_bps: number | null;
}

/** Emails sent with tracking on (delivered only), and what people did with them. */
export interface EmailEngagement {
  tracked: number;
  /** Opened by a person; a click counts as an open. */
  opened: number;
  clicked: number;
  /** Opened by a privacy proxy or scanner; not in `opened`. */
  machine_opened: number;
  open_bps: number | null;
  click_bps: number | null;
}

export interface EmailFigures extends EmailCounts, EmailEngagement {
  link_visits: number | null;
  recovered_minor: number | null;
}

export type EmailOutcome = "failed" | "bounced" | "complained";

export type EmailStatus =
  | "delivered"
  | "not_sent"
  | "pending"
  | "failed"
  | "bounced"
  | "complained"
  | "skipped";

export interface EmailReport {
  object: "email_report";
  business: string;
  start: string;
  end: string;
  previous_start: string;
  previous_end: string;
  timezone: string;
  currency: string;
  missing_rates: string[];
  filters: { type: string | null; transport: string | null };
  options: { types: string[]; transports: string[] };
  live: { waiting: number; queued_last_30_minutes: number; per_minute: number[] };
  totals: EmailFigures;
  previous: EmailFigures | null;
  days: Array<{ date: string; label: string }>;
  series: {
    queued: number[];
    delivered: number[];
    problems: number[];
    delivered_bps: Array<number | null>;
    bounce_bps: Array<number | null>;
    complaint_bps: Array<number | null>;
    open_bps: Array<number | null>;
    click_bps: Array<number | null>;
    failed: number[];
    skipped: number[];
    link_visits: number[] | null;
    recovered_minor: number[] | null;
  };
  previous_series: { queued: number[] } | null;
  funnel: Array<{ step: string; label: string; sessions: number }>;
  tracking: { enabled: boolean; since: string | null; covers_period: boolean };
  top_links: Array<{
    label: string | null;
    host: string | null;
    path: string | null;
    clicks: number;
    emails: number;
  }>;
  by_type: Array<
    EmailCounts & EmailEngagement & { type: string; paid_after: number; link_visits: number | null }
  >;
  by_transport: Array<EmailCounts & { transport: string }>;
  by_domain: Array<EmailCounts & { domain: string }>;
  reasons: Array<{ outcome: EmailOutcome; reason: string | null; count: number }>;
  skipped_reasons: Array<{ reason: string | null; count: number }>;
  dunning: {
    hold_days: number;
    steps: Array<{ position: number; sent: number; recovered: number }>;
  };
  recent: Array<{
    email: string;
    at: string;
    type: string;
    status: EmailStatus;
    transport: string | null;
    customer: string | null;
    customer_name: string | null;
    /** Sent with tracking on. */
    tracked: boolean;
    opened: boolean | null;
    clicked: boolean | null;
    portal_opened: boolean;
    paid_after: boolean;
  }>;
}

export function getEmailReport(
  biz: string,
  opts: {
    start: string;
    end: string;
    compare: boolean;
    type?: string;
    transport?: string;
    recent?: number;
  },
) {
  const qs = new URLSearchParams({
    start: opts.start,
    end: opts.end,
    compare: String(opts.compare),
  });
  if (opts.type) qs.set("type", opts.type);
  if (opts.transport) qs.set("transport", opts.transport);
  if (opts.recent) qs.set("recent", String(opts.recent));
  return apiGet<EmailReport>(`/v1/businesses/${biz}/email_report?${qs}`);
}

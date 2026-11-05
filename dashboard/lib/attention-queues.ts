// The attention strip's conditional queues: each appears only while it holds something.
// Server-only — every count is the linked list's own total through the same filters, so a
// cell and the list it opens always agree.
import { listInvoices, type ListFilterParam } from "@/lib/api";
import { listEmails } from "@/lib/api/emails";
import { listDisputes } from "@/lib/api/disputes";
import { fmtDate } from "@/lib/format";
import { G } from "@/components/analytics/glossary";
import type { AttentionItem } from "@/components/analytics/home/parts";

/** The core three are always shown, so at most this many conditional cells fit the strip. */
const MAX_CONDITIONAL = 3;

type QueueKey = "disputes" | "unpaid_after_retries" | "emails_not_delivered" | "pending_invoices";

export interface QueueReading {
  count: number;
  /** Disputes only: the soonest evidence deadline. */
  dueBy?: string | null;
}
export type QueueCounts = Record<QueueKey, QueueReading>;

const UNPAID_AFTER_RETRIES: ListFilterParam[] = [
  { field: "dunning_status", op: "is", value: "exhausted" },
  // Still owed: a voided, reversed or written-off invoice (status paid) needs no one.
  { field: "status", op: "in", value: "payment_due,not_paid" },
  { field: "dunning_exhausted_at", op: "in_last", value: "30" },
];
const EMAILS_NOT_DELIVERED: ListFilterParam[] = [
  { field: "status", op: "in", value: "failed,bounced" },
  { field: "created_at", op: "in_last", value: "7" },
];
const PENDING_INVOICES: ListFilterParam[] = [{ field: "status", op: "is", value: "pending" }];

const qs = (filters: ListFilterParam[]) =>
  filters.map((f) => `filter=${encodeURIComponent(`${f.field}:${f.op}:${f.value}`)}`).join("&");

/** Priority order: the first non-zero ones win the free cells. */
const QUEUES: Array<{
  key: QueueKey;
  label: string;
  href: (biz: string) => string;
  note: (r: QueueReading, tz: string | null) => string | undefined;
  tone: AttentionItem["tone"];
  info: AttentionItem["info"];
}> = [
  {
    key: "disputes",
    label: "Disputes",
    href: (biz) => `/businesses/${biz}/disputes?segment=needs_response`,
    note: (r, tz) => (r.dueBy ? `respond by ${fmtDate(r.dueBy, tz)}` : "need a response"),
    tone: "attention",
    info: G.disputesNeedResponse,
  },
  {
    key: "unpaid_after_retries",
    label: "Unpaid after retries",
    href: (biz) => `/businesses/${biz}/invoices?${qs(UNPAID_AFTER_RETRIES)}`,
    note: () => "last 30 days",
    tone: "attention",
    info: G.unpaidAfterRetries,
  },
  {
    key: "emails_not_delivered",
    label: "Emails not delivered",
    href: (biz) => `/businesses/${biz}/emails?${qs(EMAILS_NOT_DELIVERED)}`,
    note: () => "last 7 days",
    tone: "warning",
    info: G.emailsNotDelivered,
  },
  {
    key: "pending_invoices",
    label: "Pending invoices",
    href: (biz) => `/businesses/${biz}/invoices?${qs(PENDING_INVOICES)}`,
    note: () => "awaiting approval",
    tone: "warning",
    info: G.pendingInvoices,
  },
];

/** One business's queue counts. A failed read reads as empty, so it never blocks the page. */
export async function fetchQueueCounts(biz: string): Promise<QueueCounts> {
  const total = (p: Promise<{ total: number | null }>) =>
    p.then((l) => l.total ?? 0).catch(() => 0);
  const [disputes, unpaid, emails, pending] = await Promise.all([
    listDisputes(biz, { status: "needs_response", sort: "evidence_due_by", limit: 1 })
      .then((l) => ({ count: l.total ?? l.data.length, dueBy: l.data[0]?.evidence_due_by ?? null }))
      .catch(() => ({ count: 0, dueBy: null })),
    total(listInvoices(biz, undefined, { limit: 1, filters: UNPAID_AFTER_RETRIES })),
    total(listEmails(biz, { limit: 1, filters: EMAILS_NOT_DELIVERED })),
    total(listInvoices(biz, undefined, { limit: 1, filters: PENDING_INVOICES })),
  ]);
  return {
    disputes,
    unpaid_after_retries: { count: unpaid },
    emails_not_delivered: { count: emails },
    pending_invoices: { count: pending },
  };
}

/**
 * The non-empty queues as strip cells, highest priority first, capped so the strip stays at
 * six. `hrefBiz` picks the business a cell opens (the org view sends the one holding most).
 */
export function queueItems(
  counts: QueueCounts,
  hrefBiz: (key: QueueKey) => string | null,
  tz: string | null,
): AttentionItem[] {
  return QUEUES.filter((q) => counts[q.key].count > 0)
    .slice(0, MAX_CONDITIONAL)
    .map((q) => {
      const biz = hrefBiz(q.key);
      return {
        key: q.key,
        label: q.label,
        value: counts[q.key].count.toLocaleString("en"),
        note: q.note(counts[q.key], tz),
        href: biz ? q.href(biz) : "/metrics",
        tone: q.tone,
        info: q.info,
      };
    });
}

/** Many businesses' counts as one: summed, the soonest deadline, and who holds most of each. */
export function combineQueueCounts(per: Array<{ biz: string; counts: QueueCounts }>): {
  counts: QueueCounts;
  topBiz: (key: QueueKey) => string | null;
} {
  const keys = QUEUES.map((q) => q.key);
  const counts = Object.fromEntries(
    keys.map((k) => [k, { count: per.reduce((s, p) => s + p.counts[k].count, 0) }]),
  ) as QueueCounts;
  counts.disputes.dueBy =
    per
      .map((p) => p.counts.disputes.dueBy)
      .filter((d): d is string => !!d)
      .sort()[0] ?? null;
  const topBiz = (key: QueueKey) =>
    [...per]
      .sort((a, z) => z.counts[key].count - a.counts[key].count)
      .find((p) => p.counts[key].count > 0)?.biz ?? null;
  return { counts, topBiz };
}

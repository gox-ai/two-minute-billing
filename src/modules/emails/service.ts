/**
 * Read + resend API for the customer-email outbox (email_messages). RLS-scoped
 * (org isolation on the table), so all access goes through withTenant and
 * additionally filters business_id, per the tenancy rules.
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import {
  clampLimit,
  filterConditions,
  keysetCondition,
  opsFromSpecs,
  pageOrder,
  parseCursor,
  searchCondition,
  toPage,
  type FilterSpec,
  type ListFilter,
  type ListPage,
  cappedTotal,
} from "@/platform/list-query";
import { businessTimezone } from "@/platform/business-tz";
import { withTenant } from "@/platform/db";
import { businesses, customers, emailMessages } from "@db/schema";

export type EmailMessageRow = typeof emailMessages.$inferSelect;

async function assertBusiness(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  businessId: string,
): Promise<boolean> {
  const [b] = await tx
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  return !!b;
}

// ── Paginated list (see docs/GUIDE.md §3.4 for the shared contract) ────────────

const LIST_FILTERS: Record<string, FilterSpec> = {
  id: { column: emailMessages.publicId, kind: "text" },
  type: { column: emailMessages.type, kind: "enum" },
  status: { column: emailMessages.status, kind: "enum" },
  to: { column: emailMessages.toAddress, kind: "text" },
  subject: { column: emailMessages.subject, kind: "text" },
  created_at: { column: emailMessages.createdAt, kind: "date" },
};

/**
 * Virtual filter field: the customer's public id, resolved with an EXISTS
 * sub-query (no join) — `email_messages.customer_id` is an internal uuid, and
 * this is the one non-column filter the customer-detail / subscription-detail
 * "Email Logs" tabs need (the `?customer=cus_…` scope param).
 */
const CUSTOMER_FIELD = "customer";

function customerCondition(op: string, value: string): SQL | undefined {
  const exists = (inner: SQL) =>
    sql`EXISTS (SELECT 1 FROM ${customers} WHERE ${customers.id} = ${emailMessages.customerId} AND ${inner})`;
  switch (op) {
    case "is":
      return exists(sql`lower(${customers.publicId}) = lower(${value})`);
    case "is_not":
      return sql`(${emailMessages.customerId} IS NULL OR NOT ${exists(sql`lower(${customers.publicId}) = lower(${value})`)})`;
    case "is_present":
      return value === "false"
        ? sql`${emailMessages.customerId} IS NULL`
        : sql`${emailMessages.customerId} IS NOT NULL`;
    default:
      return undefined;
  }
}

/** field → operators it accepts; the route validates the request against this. */
export const EMAIL_FILTER_OPS: Record<string, readonly string[]> = {
  ...opsFromSpecs(LIST_FILTERS),
  [CUSTOMER_FIELD]: ["is", "is_not", "is_present"],
};

const LIST_SORTS = {
  created_at: emailMessages.createdAt,
} as const;

export type EmailSortField = keyof typeof LIST_SORTS;
export const EMAIL_SORT_FIELDS = Object.keys(LIST_SORTS) as EmailSortField[];

export interface EmailListFilters {
  /** `field[op]=value` filters (validated by the route against EMAIL_FILTER_OPS). */
  filters?: ListFilter[];
  search?: string;
  sortField?: string;
  sortDesc?: boolean;
  startingAfter?: string;
  limit?: number;
}

/**
 * One page of the customer billing-email log, newest-first. Mirrors
 * `listTransactionsPage` — this list used to be capped at 50 rows with no way
 * to reach the rest, which is exactly the shape of loss this contract exists
 * to close. Keyset on `(created_at DESC, public_id DESC)`
 * (`email_messages_biz_created_idx`).
 */
export async function listEmailsPage(
  organizationId: string,
  businessId: string,
  f: EmailListFilters = {},
): Promise<ListPage<EmailMessageRow>> {
  const limit = clampLimit(f.limit);
  const sortField = (f.sortField ?? "created_at") as EmailSortField;
  const descending = f.sortDesc ?? true;
  const keyset = sortField === "created_at";

  return withTenant(organizationId, async (tx) => {
    if (!(await assertBusiness(tx, businessId))) {
      return { data: [], hasMore: false, nextCursor: null, total: 0 };
    }

    const conds: SQL[] = [eq(emailMessages.businessId, businessId)];
    const search = searchCondition(
      [emailMessages.publicId, emailMessages.toAddress, emailMessages.subject],
      f.search,
    );
    if (search) conds.push(search);
    // Date filters bucket by the BUSINESS day, not the UTC day (business-tz.ts).
    conds.push(
      ...filterConditions(LIST_FILTERS, f.filters, await businessTimezone(tx, businessId)),
    );
    for (const filter of f.filters ?? []) {
      if (filter.field !== CUSTOMER_FIELD) continue;
      const c = customerCondition(filter.op, filter.value);
      if (c) conds.push(c);
    }

    let total: number | null = null;
    if (!f.startingAfter) {
      total = await cappedTotal(
        tx,
        tx
          .select({ one: sql`1` })
          .from(emailMessages)
          .where(and(...conds)),
      );
    }

    const { keysetId, offset } = parseCursor(f.startingAfter);
    const pageConds = [...conds];
    if (keyset && keysetId) {
      const [cursor] = await tx
        .select({
          createdAt: sql<string>`${emailMessages.createdAt}::text`,
          publicId: emailMessages.publicId,
        })
        .from(emailMessages)
        .where(and(eq(emailMessages.businessId, businessId), eq(emailMessages.publicId, keysetId)))
        .limit(1);
      const seek = keysetCondition(
        emailMessages.createdAt,
        emailMessages.publicId,
        cursor ? { sortValue: cursor.createdAt, tiebreak: cursor.publicId } : undefined,
        descending,
      );
      if (seek) pageConds.push(seek);
    }

    const rows = await tx
      .select()
      .from(emailMessages)
      .where(and(...pageConds))
      .orderBy(...pageOrder(LIST_SORTS[sortField], emailMessages.publicId, descending, keyset))
      .limit(limit + 1)
      .offset(keyset ? 0 : offset);

    return toPage(rows, limit, { keyset, offset, keyOf: (r) => r.publicId, total });
  });
}

export async function getEmail(
  organizationId: string,
  businessId: string,
  publicId: string,
): Promise<EmailMessageRow | null> {
  return withTenant(organizationId, async (tx) => {
    if (!(await assertBusiness(tx, businessId))) return null;
    const [row] = await tx
      .select()
      .from(emailMessages)
      .where(and(eq(emailMessages.businessId, businessId), eq(emailMessages.publicId, publicId)))
      .limit(1);
    return row ?? null;
  });
}

// ── Activity summary ──────────────────────────────────────────────────────────

/**
 * The transports that actually hand a message to something that delivers it.
 *
 * Stated ONCE because it is the difference between "we sent this" and "we wrote this to a
 * log file", and every surface that reports delivery has to agree on it. `console` is the
 * dev sink (accepts and delivers nothing) and `unconfigured` is a business with no transport
 * at all (refuses); neither belongs here. NULL predates the column and is unprovable, so it
 * is not a delivery either.
 */
export const DELIVERING_TRANSPORTS = ["smtp", "esp", "ses"] as const;

/** The same list as a SQL tuple, so the query and the constant cannot drift. */
const DELIVERING_TRANSPORTS_SQL = sql`(${sql.join(
  DELIVERING_TRANSPORTS.map((t) => sql`${t}`),
  sql`, `,
)})`;

export interface EmailActivitySummary {
  /** How many days back the counts cover. */
  window_days: number;
  /** Reached something that delivers: `sent` AND carried by a DELIVERING_TRANSPORTS member. */
  delivered: number;
  /**
   * Marked `sent` but carried by the console sink — or written before the transport
   * column existed, so unprovable. Counted SEPARATELY from `delivered` on purpose:
   * folding it in is precisely the false delivery claim the transport column exists to
   * prevent, and a hub that reports "12 sent" for twelve console writes is a lie.
   */
  not_delivered: number;
  /** Still queued for the billing clock. */
  pending: number;
  /**
   * Gave up after the retry budget — the last word was inconclusive (relay down, timeout).
   * Usually OUR problem, and distinct from `bounced` on purpose.
   */
  failed: number;
  /**
   * The relay permanently refused the address (5xx). Terminal on the first attempt, never
   * retried. The merchant's data problem, not ours, and it needs a different action —
   * which is why it is not folded into `failed`.
   */
  bounced: number;
  /** Most recent successful send in the window, or null when nothing was sent. */
  last_sent_at: string | null;
}

/**
 * Counts for the Settings → Email notifications hub, so an operator can read whether
 * mail is actually moving without opening the log. One aggregate query, bucketed by the
 * (status, transport) pair rather than status alone — see `not_delivered`.
 *
 * `skipped` rows are deliberately not counted: they were gated off before any send was
 * attempted, so they are neither activity nor a failure, and a total that included them
 * would not equal anything an operator could act on.
 */
export async function getEmailActivity(
  organizationId: string,
  businessId: string,
  windowDays = 30,
): Promise<EmailActivitySummary | null> {
  return withTenant(organizationId, async (tx) => {
    if (!(await assertBusiness(tx, businessId))) return null;
    const [row] = await tx
      .select({
        delivered: sql<number>`count(*) filter (
          where ${emailMessages.status} = 'sent'
            and ${emailMessages.transport} in ${DELIVERING_TRANSPORTS_SQL})::int`,
        // The COMPLEMENT, not a second hand-listed set. Listing `console` and NULL by name
        // meant a `sent` row on any OTHER transport belonged to neither bucket and simply
        // vanished from the hub — which is exactly what happened when `ses` and
        // `unconfigured` were added: real SES deliveries stopped being counted at all.
        // Written as a negation, the two buckets partition `sent` by construction and a
        // fourth transport can never fall between them again.
        notDelivered: sql<number>`count(*) filter (
          where ${emailMessages.status} = 'sent'
            and (${emailMessages.transport} is null
                 or ${emailMessages.transport} not in ${DELIVERING_TRANSPORTS_SQL}))::int`,
        pending: sql<number>`count(*) filter (where ${emailMessages.status} = 'pending')::int`,
        failed: sql<number>`count(*) filter (where ${emailMessages.status} = 'failed')::int`,
        bounced: sql<number>`count(*) filter (where ${emailMessages.status} = 'bounced')::int`,
        lastSentAt: sql<string | null>`max(${emailMessages.sentAt})::text`,
      })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.businessId, businessId),
          sql`${emailMessages.createdAt} >= now() - make_interval(days => ${windowDays})`,
        ),
      );
    return {
      window_days: windowDays,
      delivered: row?.delivered ?? 0,
      not_delivered: row?.notDelivered ?? 0,
      pending: row?.pending ?? 0,
      failed: row?.failed ?? 0,
      bounced: row?.bounced ?? 0,
      last_sent_at: row?.lastSentAt ?? null,
    };
  });
}

/**
 * Re-queue a sent/failed email for delivery on the next tick (status → pending, retry clock reset).
 * `body_removed` when the retention sweep deleted its body: there is nothing left to send.
 */
export async function resendEmail(
  organizationId: string,
  businessId: string,
  publicId: string,
): Promise<EmailMessageRow | "body_removed" | null> {
  return withTenant(organizationId, async (tx) => {
    if (!(await assertBusiness(tx, businessId))) return null;
    const [found] = await tx
      .select({ bodyRemovedAt: emailMessages.bodyRemovedAt })
      .from(emailMessages)
      .where(and(eq(emailMessages.businessId, businessId), eq(emailMessages.publicId, publicId)));
    if (!found) return null;
    if (found.bodyRemovedAt) return "body_removed";
    const [row] = await tx
      .update(emailMessages)
      // `transport` clears with the rest of the attempt state: the row is pending again
      // and has not been carried by anything, so keeping the previous transport would
      // attribute a delivery to a send that has not happened yet.
      .set({
        status: "pending",
        transport: null,
        attempts: 0,
        lastError: null,
        nextAttemptAt: new Date(),
      })
      .where(and(eq(emailMessages.businessId, businessId), eq(emailMessages.publicId, publicId)))
      .returning();
    return row ?? null;
  });
}

export function serializeEmail(r: EmailMessageRow) {
  return {
    object: "email_message",
    id: r.publicId,
    type: r.type,
    to: r.toAddress,
    /** Additional contacts copied (business-wide CC/BCC are not listed here). */
    cc: r.ccAddresses ?? [],
    subject: r.subject,
    status: r.status,
    // Which transport carried it: console | smtp | esp, or null for rows written before
    // the column existed. `status: 'sent'` with `transport: 'console'` means the dev sink
    // accepted it and no customer received anything — the two must be read together.
    transport: r.transport,
    /**
     * What the provider said about this message AFTER accepting it —
     * `permanent | transient | undetermined | complaint`, or null when no feedback arrived.
     *
     * Distinct from `last_error`, which says why an ATTEMPT failed. This is the one field
     * that separates "the mailbox is full" from "there is no such person": both leave the
     * message undelivered, and only one is worth updating the customer's record over.
     */
    bounce_type: r.bounceType,
    attempts: r.attempts,
    last_error: r.lastError,
    provider_message_id: r.providerMessageId,
    body_html: r.bodyHtml,
    body_text: r.bodyText,
    /** When the body was deleted after its retention period; both bodies are empty after. */
    body_removed_at: r.bodyRemovedAt,
    created_at: r.createdAt,
    sent_at: r.sentAt,
  };
}

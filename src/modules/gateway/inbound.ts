/**
 * Inbound gateway-webhook ingestion + log (C8 / GW-6, LOG-1).
 *
 * The HTTP route for external gateways lands here: it resolves the business's
 * gateway adapter, verifies + normalizes the payload, and runs the shared
 * `handleProviderEvent` reconciliation. Every inbound event is recorded in
 * `provider_events` (payload, outcome, error) for the inspector API.
 */
import { and, desc, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { scanBusinessFilter } from "@/platform/clock";
import type { TickError } from "@/modules/subscriptions/renewal";
import {
  encodeNormalizedEvent,
  handleProviderEvent,
  reviveNormalizedEvent,
  type HandleResult,
} from "@/modules/webhooks/inbound";
import { resolveAdapter, resolveAdapterWithWebhookSecret } from "@/providers/registry";
import type { NormalizeWebhookInput, NormalizedProviderEvent } from "@/providers/types";
import { decryptCredentials, encryptCredentials } from "@/platform/secrets";
import {
  activeWebhookSecretFallback,
  buildNotificationUrl,
  setWebhookSecretFallback,
} from "./webhook-endpoint";
import { redactHeaders } from "@/providers/http";
import { gatewayAccounts, businesses, providerEvents } from "@db/schema";
import {
  clampLimit,
  filterConditions,
  keysetCondition,
  opsFromSpecs,
  pageOrder,
  parseCursor,
  isUuid,
  isUuidCursor,
  searchCondition,
  toPage,
  type FilterSpec,
  type ListFilter,
  type ListPage,
  cappedTotal,
} from "@/platform/list-query";
import { businessTimezone } from "@/platform/business-tz";
import { withTraceContext, newTraceId, stampTracePayload } from "@/platform/trace";
import { createHash } from "node:crypto";
import { createLogger } from "@/platform/logger";

const log = createLogger("gateway.inbound");

export type ProviderEventRow = typeof providerEvents.$inferSelect;

/**
 * Ingest a raw inbound webhook for a business's gateway. Resolves the (single)
 * active gateway account for `gatewayKey` on the business, normalizes via its
 * adapter (signature verification), and reconciles.
 */
export async function ingestGatewayWebhook(input: {
  gatewayKey: string;
  /** The exact gateway account the provider posts to (`?id=gwa_…`). */
  gatewayAccountPublicId?: string;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  /**
   * The URL the gateway posted to (P2). Logged on every `provider_events` row this
   * delivery writes. Omitted by non-HTTP callers, which stay NULL.
   */
  requestUrl?: string;
}): Promise<
  | {
      handled: HandleResult[];
      businessId: string;
      gatewayAccountId: string;
      /**
       * The provider-side event ids whose log row THIS delivery wrote (i.e. not the
       * ones deduped as a replay). The route stamps the response status onto exactly
       * these — see `recordGatewayWebhookResponse`.
       */
      providerEventIds: string[];
    }
  | { error: string }
> {
  // The account id is the ONLY attribution path: it identifies the business too, via
  // `acc.businessId`. The per-business URL fallback was removed 2026-08-01 along with
  // the `/v1/gateway_webhooks/:gateway/:business` route — every endpoint we register
  // carries `?id=`, and guessing "the single active account of this key" silently
  // picked one of several once a business had more than one account per gateway.
  if (!input.gatewayAccountPublicId) return { error: "gateway_account_not_specified" };
  const [acc] = await systemDb
    .select()
    .from(gatewayAccounts)
    .where(
      and(
        eq(gatewayAccounts.publicId, input.gatewayAccountPublicId),
        eq(gatewayAccounts.gatewayKey, input.gatewayKey),
        // Any status: a disabled account takes no new charges (the router refuses it), but
        // money already moved through it — late captures, refunds, disputes — must book.
      ),
    )
    .limit(1);
  if (!acc) return { error: "gateway_account_not_found" };
  const biz = { id: acc.businessId };

  // Everything this delivery causes shares one trace id, so `gateway_request_logs`
  // can answer "what did processing THIS webhook call out to?" — PayPal's signature
  // verification is itself an outbound call made right here, and without a trace
  // context it logged with `trace_id = null` and correlated to nothing.
  return withTraceContext({ traceId: newTraceId("hook"), businessId: biz.id }, async () => {
    const { events, parsedPayload, headers } = await verifyDelivery(acc, input);
    const handled: HandleResult[] = [];
    const providerEventIds: string[] = [];
    // A batch may list a later event first (GoCardless: a chargeback before its payment's
    // confirmation). Apply in event time; a stable sort keeps one notification's events in order.
    const ordered = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    for (const ev of ordered) {
      const result = await handleProviderEvent(input.gatewayKey, ev, {
        businessId: biz.id,
        gatewayAccountId: acc.id,
        payload: parsedPayload,
        headers,
        requestUrl: input.requestUrl ?? null,
      });
      handled.push(result);
      // A replay wrote nothing (dedup returned early), so the row already records the
      // exchange of the delivery that DID the work — don't overwrite it with ours.
      if (result !== "duplicate") providerEventIds.push(ev.providerEventId);
    }
    // The route still answers 502, but our retry no longer depends on the gateway's.
    const errored = ordered.filter((_, i) => handled[i] === "error").map((e) => e.providerEventId);
    if (errored.length)
      await queueGatewayWebhookRetry({
        gatewayKey: input.gatewayKey,
        businessId: biz.id,
        gatewayAccountId: acc.id,
        providerEventIds: errored,
      }).catch((e) =>
        // The clock pass re-queues an errored row with no job, so this is not the last chance.
        log.error(e, {
          event: "gateway_webhook_retry_queue_failed",
          gateway: input.gatewayKey,
          businessId: biz.id,
          eventIds: errored,
        }),
      );
    return { handled, businessId: biz.id, gatewayAccountId: acc.id, providerEventIds };
  });
}

type DeliveryInput = Parameters<typeof ingestGatewayWebhook>[0];

/** Verify and normalize a delivery (throws on a bad signature), plus what its log rows keep. */
async function verifyDelivery(acc: typeof gatewayAccounts.$inferSelect, input: DeliveryInput) {
  const events = distinctEventIds(
    await normalizeWithFallbackSecret(acc, {
      payload: input.rawBody,
      headers: input.headers,
      notificationUrl: buildNotificationUrl({
        gatewayKey: acc.gatewayKey,
        gatewayAccountPublicId: acc.publicId,
      }),
      settledEventIds: (ids) => settledProviderEventIds(input.gatewayKey, acc.businessId, ids),
    }),
  );
  let parsedPayload: unknown = input.rawBody;
  try {
    parsedPayload = JSON.parse(input.rawBody);
  } catch {
    // Kept raw and still processed — but a gateway that stops sending JSON is worth
    // a line, because everything downstream reads the parsed form.
    log.debug("inbound webhook body is not JSON — keeping it raw", {
      bytes: input.rawBody.length,
    });
  }
  const headers = redactHeaders(input.headers as Record<string, unknown>);
  return { events, parsedPayload, headers };
}

/** The delivery failed verification; nothing was stored. */
export class WebhookRejectedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "WebhookRejectedError";
  }
}

export const PROCESS_GATEWAY_WEBHOOK_TASK = "process_gateway_webhook";
/** graphile backoff is exp(min(attempt, 10)) s: 25 tries span about four days. */
export const PROCESS_MAX_ATTEMPTS = 25;

export interface StoredDeliveryJob {
  gatewayKey: string;
  businessId: string;
  /** NULL when the clock pass cannot tell the account from the row's URL, as for a replay. */
  gatewayAccountId: string | null;
  providerEventIds: string[];
}

/** One key per (gateway, business, set of events): two copies of one delivery share a job. */
export function storedDeliveryJobKey(
  job: Pick<StoredDeliveryJob, "gatewayKey" | "businessId" | "providerEventIds">,
): string {
  return `gwhook:${job.gatewayKey}:${job.businessId}:${createHash("sha256")
    .update([...job.providerEventIds].sort().join(","))
    .digest("hex")
    .slice(0, 32)}`;
}

/**
 * Queue `process_gateway_webhook` inside `tx`. With `unlessLive`, a job under the same key that
 * is queued, running or retrying will reach these rows already, and a second could run beside it.
 */
async function queueStoredDelivery(
  tx: Tx,
  job: StoredDeliveryJob,
  opts: { unlessLive: boolean },
): Promise<boolean> {
  const jobKey = storedDeliveryJobKey(job);
  // Two copies of one delivery arriving together queue one job.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${jobKey}))`);
  if (opts.unlessLive) {
    const live = (await tx.execute(
      sql`select 1 from graphile_worker.jobs where key = ${jobKey} and attempts < max_attempts limit 1`,
    )) as unknown as unknown[];
    if (live.length > 0) return false;
  }
  await tx.execute(sql`select graphile_worker.add_job(
    ${PROCESS_GATEWAY_WEBHOOK_TASK},
    ${JSON.stringify(stampTracePayload(job))}::json,
    max_attempts => ${PROCESS_MAX_ATTEMPTS},
    job_key => ${jobKey})`);
  return true;
}

/** Queue our own retry of events a synchronous delivery (or the clock pass) found errored. */
export async function queueGatewayWebhookRetry(job: StoredDeliveryJob): Promise<boolean> {
  return systemDb.transaction((tx) => queueStoredDelivery(tx, job, { unlessLive: true }));
}

/**
 * Store a verified delivery and queue its processing, in one transaction, so the route can
 * answer at once (`webhook.processAfterAnswer`). A bad signature throws before anything is
 * written. A redelivery queues the work again only when no job for it is still live.
 */
export async function storeGatewayWebhook(
  input: DeliveryInput,
): Promise<
  | { businessId: string; gatewayAccountId: string; providerEventIds: string[]; queued: boolean }
  | { error: string }
> {
  if (!input.gatewayAccountPublicId) return { error: "gateway_account_not_specified" };
  const [acc] = await systemDb
    .select()
    .from(gatewayAccounts)
    .where(
      and(
        eq(gatewayAccounts.publicId, input.gatewayAccountPublicId),
        eq(gatewayAccounts.gatewayKey, input.gatewayKey),
      ),
    )
    .limit(1);
  if (!acc) return { error: "gateway_account_not_found" };
  return withTraceContext({ traceId: newTraceId("hook"), businessId: acc.businessId }, async () => {
    const { events, parsedPayload, headers } = await verifyDelivery(acc, input).catch((e) => {
      throw new WebhookRejectedError(e);
    });
    const ids = events.map((e) => e.providerEventId);
    const out = {
      businessId: acc.businessId,
      gatewayAccountId: acc.id,
      providerEventIds: ids,
      queued: false,
    };
    if (ids.length === 0) return out;
    const job: StoredDeliveryJob = {
      gatewayKey: input.gatewayKey,
      businessId: acc.businessId,
      gatewayAccountId: acc.id,
      providerEventIds: ids,
    };
    out.queued = await systemDb.transaction(async (tx) => {
      // Held across the insert too, so a concurrent copy sees our rows or none of them.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${storedDeliveryJobKey(job)}))`);
      const inserted = await tx
        .insert(providerEvents)
        .values(
          events.map((ev) => ({
            providerKey: input.gatewayKey,
            providerEventId: ev.providerEventId,
            type: ev.type,
            businessId: acc.businessId,
            payload: parsedPayload as object,
            headers,
            requestUrl: input.requestUrl ?? null,
            normalized: encodeNormalizedEvent(ev) as object | null,
            // What the route answers once this commits.
            responseStatus: 200,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: providerEvents.providerEventId });
      if (inserted.length === 0) {
        const open = await tx
          .select({ id: providerEvents.providerEventId })
          .from(providerEvents)
          .where(
            and(
              eq(providerEvents.providerKey, input.gatewayKey),
              eq(providerEvents.businessId, acc.businessId),
              inArray(providerEvents.providerEventId, ids),
              sql`(${providerEvents.outcome} IS NULL OR ${providerEvents.outcome} = 'error')`,
            ),
          );
        if (open.length === 0) return false;
      }
      return queueStoredDelivery(tx, job, { unlessLive: inserted.length === 0 });
    });
    return out;
  });
}

/** Leads the note on a row whose retries ran out. The clock pass matches on it: never reword. */
export const RETRIES_EXHAUSTED_NOTE = "We stopped the automatic retries";

/**
 * The `process_gateway_webhook` job: apply stored events in event time. Each row already holds
 * the verified, normalized event; settled rows are skipped, so a retry re-runs only what did not
 * finish. Throws while any event errors, so the queue retries it. `attempt` is graphile's count
 * for this run; on the last one the rows are marked, so the clock pass leaves them to a replay.
 */
export async function processStoredGatewayWebhook(
  job: StoredDeliveryJob,
  attempt?: { attempts: number; maxAttempts: number },
): Promise<HandleResult[]> {
  const rows = await systemDb
    .select()
    .from(providerEvents)
    .where(
      and(
        eq(providerEvents.providerKey, job.gatewayKey),
        eq(providerEvents.businessId, job.businessId),
        inArray(providerEvents.providerEventId, job.providerEventIds),
      ),
    );
  const open = rows
    .filter((r) => (r.outcome == null || r.outcome === "error") && r.normalized != null)
    .map((r) => ({ row: r, ev: reviveNormalizedEvent(r.normalized) }))
    .sort((a, b) => a.ev.occurredAt.getTime() - b.ev.occurredAt.getTime());
  const results: HandleResult[] = [];
  for (const { row, ev } of open) {
    // `handleProviderEvent` re-reads the outcome under the per-event lock, so a redelivery
    // or a second job that got there first makes this a duplicate.
    results.push(
      await handleProviderEvent(job.gatewayKey, ev, {
        businessId: job.businessId,
        gatewayAccountId: job.gatewayAccountId,
        payload: row.payload,
        headers: row.headers as Record<string, string> | null,
        // The row is in flight (NULL, stored before processing) or errored.
        rerunIf: (o) => o == null || o === "error",
      }),
    );
  }
  const failed = open.filter((_, i) => results[i] === "error").map((f) => f.row.providerEventId);
  if (failed.length) {
    if (attempt && attempt.attempts >= attempt.maxAttempts)
      await recordRetriesExhausted(job, failed, attempt.attempts);
    throw new Error(
      `${failed.length} stored ${job.gatewayKey} webhook event(s) failed: ${failed.join(", ")}`,
    );
  }
  return results;
}

/**
 * Our last try failed. The note on each row is the durable record: the Gateway Webhooks screen
 * shows it, and the clock pass skips the row. The job itself stays in the queue as exhausted,
 * which the back-office error feed reports as critical.
 */
async function recordRetriesExhausted(
  job: StoredDeliveryJob,
  eventIds: string[],
  attempts: number,
): Promise<void> {
  const note = `${RETRIES_EXHAUSTED_NOTE} after ${attempts} attempts. Select Replay to try again.`;
  await systemDb
    .update(providerEvents)
    .set({
      error: sql`concat_ws(' ', ${providerEvents.error}, ${note}::text)`,
    })
    .where(
      and(
        eq(providerEvents.providerKey, job.gatewayKey),
        eq(providerEvents.businessId, job.businessId),
        inArray(providerEvents.providerEventId, eventIds),
        eq(providerEvents.outcome, "error"),
        sql`position(${RETRIES_EXHAUSTED_NOTE}::text in coalesce(${providerEvents.error}, '')) = 0`,
      ),
    );
  log.error("gateway webhook retries exhausted", {
    event: "gateway_webhook_retries_exhausted",
    gateway: job.gatewayKey,
    businessId: job.businessId,
    eventIds,
    attempts,
  });
}

/** Rows the clock pass re-queues per tick, oldest first. */
export const STRANDED_WEBHOOK_SCAN_LIMIT = 50;
/** How far back it looks. Older errored rows are left to a replay. */
export const STRANDED_WEBHOOK_LOOKBACK_MS = 30 * 24 * 60 * 60_000;
/** A fresh error is the delivery's own to queue; the pass waits this long before it steps in. */
export const STRANDED_WEBHOOK_GRACE_MS = 5 * 60_000;

/**
 * Clock pass: queue our retry for errored gateway-webhook rows that no job will reach. Causes:
 * rows from before the sync path queued its own retry, or a queue insert that failed. Skips a
 * row any `process_gateway_webhook` job names (live or exhausted) and a row marked exhausted.
 * Database only: no network call.
 */
export async function requeueStrandedGatewayWebhooks(now: Date): Promise<{
  examined: number;
  queued: number;
  errors: TickError[];
  capped: boolean;
}> {
  const since = new Date(now.getTime() - STRANDED_WEBHOOK_LOOKBACK_MS).toISOString();
  const settledBefore = new Date(now.getTime() - STRANDED_WEBHOOK_GRACE_MS).toISOString();
  const scope = scanBusinessFilter(providerEvents.businessId);
  // Unaliased on purpose: the scope filter renders "provider_events"."business_id".
  const rows = (await systemDb.execute(sql`
    select provider_events.provider_key, provider_events.provider_event_id,
           provider_events.business_id::text as business_id,
           b.organization_id::text as organization_id, ga.id::text as gateway_account_id
      from provider_events
      join businesses b on b.id = provider_events.business_id
      left join gateway_accounts ga
        on ga.public_id = substring(provider_events.request_url from 'gwa_[A-Za-z0-9]+')
       and ga.business_id = provider_events.business_id
     where provider_events.outcome = 'error'
       and provider_events.normalized is not null
       and provider_events.request_url like '%/gateway_webhooks/%'
       and provider_events.received_at >= ${since}::timestamptz
       and coalesce(provider_events.processed_at, provider_events.received_at)
           <= ${settledBefore}::timestamptz
       and position(${RETRIES_EXHAUSTED_NOTE}::text in coalesce(provider_events.error, '')) = 0
       and not exists (
         select 1
           from graphile_worker._private_jobs j
           join graphile_worker._private_tasks t on t.id = j.task_id
          where t.identifier = ${PROCESS_GATEWAY_WEBHOOK_TASK}
            and j.payload->>'gatewayKey' = provider_events.provider_key
            and j.payload->>'businessId' = provider_events.business_id::text
            and (j.payload::jsonb)->'providerEventIds' ? provider_events.provider_event_id)
       ${scope ? sql`and ${scope}` : sql``}
     order by provider_events.received_at asc
     limit ${STRANDED_WEBHOOK_SCAN_LIMIT}
  `)) as unknown as Array<{
    provider_key: string;
    provider_event_id: string;
    business_id: string;
    organization_id: string;
    gateway_account_id: string | null;
  }>;
  // One job per (gateway, business, account), so its events still apply in event time.
  const groups = new Map<string, { job: StoredDeliveryJob; organizationId: string }>();
  for (const r of rows) {
    const k = `${r.provider_key}:${r.business_id}:${r.gateway_account_id ?? ""}`;
    const g = groups.get(k) ?? {
      job: {
        gatewayKey: r.provider_key,
        businessId: r.business_id,
        gatewayAccountId: r.gateway_account_id,
        providerEventIds: [],
      },
      organizationId: r.organization_id,
    };
    g.job.providerEventIds.push(r.provider_event_id);
    groups.set(k, g);
  }
  const out = {
    examined: rows.length,
    queued: 0,
    errors: [] as TickError[],
    capped: rows.length >= STRANDED_WEBHOOK_SCAN_LIMIT,
  };
  for (const { job, organizationId } of groups.values()) {
    try {
      if (await queueGatewayWebhookRetry(job)) out.queued += job.providerEventIds.length;
    } catch (e) {
      out.errors.push({
        organization: organizationId,
        business: job.businessId,
        step: "gateway_webhook_retries",
        message: (e as Error)?.message ?? String(e),
      });
      log.error(e, {
        event: "gateway_webhook_requeue_failed",
        gateway: job.gatewayKey,
        businessId: job.businessId,
      });
    }
  }
  return out;
}

/**
 * Verify with the stored secret, then with the fallback secret while its window is open (see
 * `WEBHOOK_SECRET_FALLBACK`). The first error is the one that propagates.
 */
async function normalizeWithFallbackSecret(
  acc: typeof gatewayAccounts.$inferSelect,
  input: NormalizeWebhookInput,
): Promise<NormalizedProviderEvent[]> {
  try {
    return await resolveAdapter(acc).normalizeWebhook(input);
  } catch (first) {
    let creds: Record<string, unknown>;
    try {
      creds = decryptCredentials(acc.credentialsEnc);
    } catch {
      throw first;
    }
    const fallback = activeWebhookSecretFallback(creds);
    if (!fallback) throw first;
    let events: NormalizedProviderEvent[];
    try {
      events = await resolveAdapterWithWebhookSecret(acc, fallback.secret).normalizeWebhook(input);
    } catch {
      throw first;
    }
    log.info("inbound webhook verified with the fallback secret", {
      event: "gateway_webhook_fallback_secret",
      gateway: acc.gatewayKey,
      gatewayAccount: acc.publicId,
      kind: fallback.kind,
    });
    if (fallback.kind === "unconfirmed")
      await promoteUnconfirmedSecret(acc, creds, fallback.secret);
    return events;
  }
}

/** The gateway signed with the secret it may not have accepted: it holds it, so make it primary. */
async function promoteUnconfirmedSecret(
  acc: typeof gatewayAccounts.$inferSelect,
  creds: Record<string, unknown>,
  secret: string,
): Promise<void> {
  const previous = typeof creds.webhook_secret === "string" ? creds.webhook_secret : "";
  creds.webhook_secret = secret;
  if (previous) setWebhookSecretFallback(creds, previous, "previous", acc.gatewayKey);
  // Guarded on the version we read, so a rotation that happened since wins.
  await systemDb
    .update(gatewayAccounts)
    .set({ credentialsEnc: encryptCredentials(creds), updatedAt: new Date() })
    .where(
      and(eq(gatewayAccounts.id, acc.id), eq(gatewayAccounts.resourceVersion, acc.resourceVersion)),
    );
}

/**
 * The event ids this business already holds a row for that will not run again: every
 * outcome but `error` (a NULL outcome is a delivery still in flight). Same rule as the
 * dedup in `handleProviderEvent`, so a skipped read is never an event that would have run.
 */
export async function settledProviderEventIds(
  providerKey: string,
  businessId: string,
  ids: string[],
): Promise<ReadonlySet<string>> {
  if (!ids.length) return new Set();
  const rows = await systemDb
    .select({ id: providerEvents.providerEventId })
    .from(providerEvents)
    .where(
      and(
        eq(providerEvents.providerKey, providerKey),
        eq(providerEvents.businessId, businessId),
        inArray(providerEvents.providerEventId, ids),
        sql`${providerEvents.outcome} IS DISTINCT FROM 'error'`,
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/**
 * An adapter that fans one delivery out to several events must give each its own id, or
 * the dedup drops all but the first. Repeats get a stable `#2`, `#3` suffix in order.
 */
export function distinctEventIds<T extends { providerEventId: string }>(events: T[]): T[] {
  const seen = new Map<string, number>();
  return events.map((ev) => {
    const n = (seen.get(ev.providerEventId) ?? 0) + 1;
    seen.set(ev.providerEventId, n);
    return n === 1 ? ev : { ...ev, providerEventId: `${ev.providerEventId}#${n}` };
  });
}

/**
 * Stamp the HTTP status we answered a gateway with onto the log rows this delivery
 * wrote (P2). Called by the route AFTER it decides the reply, because the route is
 * the only place that knows it: 200 handled, 502 "please redeliver", and so on.
 * Duplicating that mapping inside the handler would be a second source of truth
 * that could quietly disagree with what the gateway actually received.
 *
 * Base connection — `provider_events` is the platform-global log (no RLS).
 * A no-op when nothing was written (a rejected signature never created a row).
 */
export async function recordGatewayWebhookResponse(input: {
  gatewayKey: string;
  /** The delivery's business: the same event id can belong to another business too. */
  businessId: string;
  providerEventIds: string[];
  responseStatus: number;
}): Promise<void> {
  if (input.providerEventIds.length === 0) return;
  await systemDb
    .update(providerEvents)
    .set({ responseStatus: input.responseStatus })
    .where(
      and(
        eq(providerEvents.providerKey, input.gatewayKey),
        eq(providerEvents.businessId, input.businessId),
        inArray(providerEvents.providerEventId, input.providerEventIds),
      ),
    );
}

/** List inbound gateway webhooks for a business (inspector). Base connection — platform-global log. */
export async function listGatewayWebhooks(
  organizationId: string,
  businessId: string,
  opts?: { limit?: number; outcome?: string; before?: Date },
): Promise<ProviderEventRow[]> {
  // Guard the business belongs to the caller's org (RLS-scoped lookup).
  const ok = await withTenant(organizationId, async (tx) => {
    const [b] = await tx
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    return !!b;
  });
  if (!ok) return [];
  const conds = [eq(providerEvents.businessId, businessId)];
  if (opts?.outcome) conds.push(eq(providerEvents.outcome, opts.outcome));
  if (opts?.before) conds.push(lt(providerEvents.receivedAt, opts.before));
  return systemDb
    .select()
    .from(providerEvents)
    .where(and(...conds))
    .orderBy(desc(providerEvents.receivedAt))
    .limit(Math.min(opts?.limit ?? 50, 200));
}

// ── Paginated list (see docs/GUIDE.md §3.4 for the shared contract) ────────────

const GATEWAY_WEBHOOK_FILTERS: Record<string, FilterSpec> = {
  id: { column: providerEvents.id, kind: "text" },
  gateway_key: { column: providerEvents.providerKey, kind: "enum" },
  type: { column: providerEvents.type, kind: "text" },
  outcome: { column: providerEvents.outcome, kind: "enum" },
  error: { column: providerEvents.error, kind: "text" },
  // P2 — the HTTP exchange, filterable so "every callback we answered 5xx" and
  // "every callback about this transaction" are each one query.
  response_status: { column: providerEvents.responseStatus, kind: "number" },
  request_url: { column: providerEvents.requestUrl, kind: "text" },
  transaction: { column: providerEvents.transactionPublicId, kind: "text" },
  // The gateway's intent id (`seti_…`, `pi_…`, an order id). A setup refused in the buyer's
  // browser reaches us only as a webhook, so this is how an attempt finds its refusal.
  intent: { column: sql`${providerEvents.normalized}->>'providerIntentId'`, kind: "text" },
  received_at: { column: providerEvents.receivedAt, kind: "date" },
};

export const GATEWAY_WEBHOOK_FILTER_OPS = opsFromSpecs(GATEWAY_WEBHOOK_FILTERS);

const GATEWAY_WEBHOOK_SORTS = {
  received_at: providerEvents.receivedAt,
  created_at: providerEvents.receivedAt,
} as const;
export const GATEWAY_WEBHOOK_SORT_FIELDS = Object.keys(GATEWAY_WEBHOOK_SORTS) as Array<
  keyof typeof GATEWAY_WEBHOOK_SORTS
>;

export interface GatewayWebhookListFilters {
  search?: string;
  filters?: ListFilter[];
  sortField?: string;
  sortDesc?: boolean;
  startingAfter?: string;
  limit?: number;
}

/**
 * One page of the inbound gateway-webhook log, newest-first. Keyset on
 * `(received_at DESC, id DESC)` via `provider_events_business_received_idx` —
 * this log is unbounded provider callback traffic, so it must never be
 * shipped to the browser wholesale (docs/GUIDE.md §3.4).
 */
export async function listGatewayWebhooksPage(
  organizationId: string,
  businessId: string,
  f: GatewayWebhookListFilters = {},
): Promise<ListPage<ProviderEventRow>> {
  const limit = clampLimit(f.limit);
  const descending = f.sortDesc ?? true;

  // Guard the business belongs to the caller's org (RLS-scoped lookup) — same
  // guard as the legacy `listGatewayWebhooks` above; `provider_events` has no
  // `organization_id` column of its own to scope on directly. Grabs the
  // business's IANA zone in the same tenant-scoped round trip, for `date`-kind
  // day bucketing (received_at filters bucket by the business day, not UTC).
  const guard = await withTenant(organizationId, async (tx) => {
    const [b] = await tx
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    if (!b) return null;
    return { tz: await businessTimezone(tx, businessId) };
  });
  if (!guard) return { data: [], hasMore: false, nextCursor: null, total: 0 };

  const conds: SQL[] = [eq(providerEvents.businessId, businessId)];
  const search = searchCondition(
    [
      providerEvents.id,
      providerEvents.providerKey,
      providerEvents.type,
      providerEvents.providerEventId,
      providerEvents.outcome,
      providerEvents.error,
      providerEvents.transactionPublicId,
      providerEvents.requestUrl,
    ],
    f.search,
  );
  if (search) conds.push(search);
  conds.push(...filterConditions(GATEWAY_WEBHOOK_FILTERS, f.filters, guard.tz));

  let total: number | null = null;
  if (!f.startingAfter) {
    total = await cappedTotal(
      systemDb,
      systemDb
        .select({ one: sql`1` })
        .from(providerEvents)
        .where(and(...conds)),
    );
  }

  const { keysetId, offset } = parseCursor(f.startingAfter);
  const pageConds = [...conds];
  // A non-uuid keyset id would make Postgres throw 22P02 on the lookup
  // below (these tables tiebreak on the raw uuid PK, not a public id),
  // which surfaced as a 500. Ignoring it degrades to the first page.
  if (keysetId && isUuidCursor(keysetId)) {
    const [cursor] = await systemDb
      .select({
        receivedAt: sql<string>`${providerEvents.receivedAt}::text`,
        id: providerEvents.id,
      })
      .from(providerEvents)
      .where(and(eq(providerEvents.businessId, businessId), eq(providerEvents.id, keysetId)))
      .limit(1);
    const seek = keysetCondition(
      providerEvents.receivedAt,
      providerEvents.id,
      cursor ? { sortValue: cursor.receivedAt, tiebreak: cursor.id } : undefined,
      descending,
    );
    if (seek) pageConds.push(seek);
  }

  const rows = await systemDb
    .select()
    .from(providerEvents)
    .where(and(...pageConds))
    .orderBy(
      ...pageOrder(
        GATEWAY_WEBHOOK_SORTS[(f.sortField as keyof typeof GATEWAY_WEBHOOK_SORTS) ?? "received_at"],
        providerEvents.id,
        descending,
        true,
      ),
    )
    .limit(limit + 1);

  return toPage(rows, limit, { keyset: true, offset, keyOf: (r) => r.id, total });
}

export async function getGatewayWebhook(
  organizationId: string,
  businessId: string,
  id: string,
): Promise<ProviderEventRow | null> {
  // `provider_events.id` is a raw uuid PK, so a non-uuid id would reach Postgres as `22P02` and
  // surface as a 500 instead of a 404. Same reasoning as the cursor guard this file already
  // imports — see isUuid.
  if (!isUuid(id)) return null;
  const ok = await withTenant(organizationId, async (tx) => {
    const [b] = await tx
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    return !!b;
  });
  if (!ok) return null;
  const [row] = await systemDb
    .select()
    .from(providerEvents)
    .where(and(eq(providerEvents.id, id), eq(providerEvents.businessId, businessId)))
    .limit(1);
  return row ?? null;
}

export type ReplayResult =
  | { ok: true; outcome: HandleResult }
  | { ok: false; reason: "not_found" | "not_replayable" | "no_normalized"; detail: string };

/**
 * Re-run a webhook whose processing FAILED (the last resort after the gateway has
 * given up).
 *
 * A failed delivery is answered 502 so the gateway redelivers, but every gateway caps
 * its own retries — Stripe gives up after ~3 days. Past that the row sits at
 * `outcome='error'` forever: the money moved at the gateway, our ledger never learned,
 * and nothing will try again. This is the manual handle for exactly that state.
 *
 * Deliberately narrow:
 *  - **`error` and `ignored` replay; `processed` never does.** A `processed` row already
 *    booked money and re-running it is how you double-post. An `ignored` row, BY
 *    DEFINITION, booked nothing — so re-running it cannot double-post, and the money-level
 *    guards (`settleAbandonedCapture`'s payment claim; the `in_progress|timeout|
 *    needs_attention` status gate) stop it even if the event turns out to be redundant
 *    after all: it simply lands on `ignored` again.
 *
 *    `ignored` was refused until 2026-09-05 on the reasoning that it is "a settled verdict
 *    too (the event was not ours)". It is not one verdict but two — "redundant, not ours"
 *    and "our code did not understand this yet" — and only the second is a defect. When the
 *    off-session AFA bug booked `requires_action` as a terminal failure, four real Stripe
 *    `charge.succeeded` (₹35,472.22 captured) were dropped as `ignored`. Fixing the handler
 *    could not recover them: replay refused the outcome, and the gateway's own redelivery
 *    hit the same dedup. A bug that ignores an event made that event unrecoverable, which
 *    is the opposite of what a replay handle is for.
 *  - **Signature is NOT re-verified, and cannot be.** `headers` is stored redacted and
 *    `payload` is parsed json, so the bytes the signature covered are gone. That is why
 *    replay consumes `normalized` — the interpretation of an *already verified*
 *    delivery. The row exists only because verification passed at ingest.
 *  - **Rows with no `normalized`** (written before migration 0143, or stripped by retention)
 *    are refused with a reason rather than guessed at.
 *
 * Re-entering `handleProviderEvent` is safe by construction: its dedup reprocesses an
 * errored row and updates it in place, so no second log row appears.
 */
export async function replayGatewayWebhook(
  organizationId: string,
  businessId: string,
  id: string,
): Promise<ReplayResult> {
  const row = await getGatewayWebhook(organizationId, businessId, id);
  if (!row)
    return {
      ok: false,
      reason: "not_found",
      detail: `We could not find the gateway webhook ${id}.`,
    };
  if (row.outcome !== "error" && row.outcome !== "ignored") {
    return {
      ok: false,
      reason: "not_replayable",
      detail:
        `You can replay only a webhook that FAILED or was IGNORED. This webhook is ` +
        `'${row.outcome ?? "still in flight"}'. A replay of a processed event would run the ` +
        `handlers that already booked money a second time.`,
    };
  }
  if (row.normalized == null) {
    return {
      ok: false,
      reason: "no_normalized",
      detail:
        "We could not replay this webhook. Its stored contents are gone: it is older than the " +
        "retention period or than migration 0143. Ask the gateway to deliver it again, or " +
        "settle the payment by hand.",
    };
  }
  const ev = reviveNormalizedEvent(row.normalized);
  const outcome = await withTraceContext({ traceId: newTraceId("replay"), businessId }, () =>
    handleProviderEvent(row.providerKey, ev, {
      businessId,
      // Keep the ORIGINAL payload/headers/URL on the row: this is a re-run of that
      // delivery, not a new one, and overwriting them would erase what actually arrived.
      payload: row.payload,
      headers: row.headers as Record<string, string> | null,
      // Without `ignored` here the dedup answers `duplicate` and the replay is a silent
      // no-op. Read under the per-event lock: a row our retry job settled meanwhile is a
      // duplicate, never a second booking.
      rerunIf: (o) => o === "error" || o === "ignored",
    }),
  );
  return { ok: true, outcome };
}

export function serializeGatewayWebhook(r: ProviderEventRow) {
  return {
    object: "gateway_webhook",
    id: r.id,
    gateway_key: r.providerKey,
    provider_event_id: r.providerEventId,
    type: r.type,
    outcome: r.outcome,
    error: r.error,
    // P2 — the HTTP exchange. Null (never 0, never a placeholder) when this row
    // predates migration 0141 or was written by a non-HTTP caller.
    response_status: r.responseStatus,
    request_url: r.requestUrl,
    /** The transaction this callback affected, as its public id (`txn_…`). */
    transaction: r.transactionPublicId,
    payload: r.payload ?? null,
    headers: r.headers ?? null,
    received_at: r.receivedAt,
    processed_at: r.processedAt,
  };
}

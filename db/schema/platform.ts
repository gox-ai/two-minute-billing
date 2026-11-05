import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { organizations, apiKeys } from "./tenancy";

/**
 * Idempotency keys make every API write safe to retry. The first request with a
 * key runs and stores its response; replays return the stored response instead
 * of re-executing. `requestFingerprint` guards against key reuse with a
 * different payload. Scoped to the organization (the API caller).
 *
 * `status` walks `in_progress` → (`side_effects`) → `completed` | `failed`, or the
 * row is deleted. `side_effects` is stamped by `withTenant` inside the request's
 * FIRST writing transaction, so it is atomic with that write; it is what lets
 * `idempotencyOnSend` free the key after a pre-write early return (404/403/400)
 * while refusing to re-execute a request that failed *after* moving money — the
 * latter is stored as `failed` and replayed. See `src/platform/idempotency.ts`.
 *
 * `lockedAt` (2026-08-03): when the CURRENT attempt started holding this row —
 * stamped on insert and refreshed only when a stale `in_progress` row is reclaimed
 * for a fresh attempt (`createdAt` never changes; `lockedAt` does). It is the
 * staleness clock a crashed-process reaper uses to tell a dead attempt from a live
 * one, in `platform/idempotency.ts` (`reapStaleIdempotencyKeys`, `IDEMPOTENCY_STALE_MS`).
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    status: text("status").notNull().default("in_progress"), // in_progress | side_effects | completed | failed
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("idempotency_org_key_uq").on(t.organizationId, t.key)],
);

/**
 * Internal immutable event log. Every meaningful state change writes an event in
 * the SAME transaction (the "outbox"); delivery happens asynchronously.
 * `businessId` is set when the event concerns a specific business's object.
 */
export const events = pgTable(
  "events",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id"),
    publicId: text("public_id").notNull(), // evt_…
    type: text("type").notNull(), // e.g. invoice.paid, subscription.created
    data: jsonb("data").notNull(),
    // Envelope enrichment (EV-2). source: api|dashboard|scheduled_job|migration|system.
    source: text("source").notNull().default("api"),
    // api key public id | portal user email | 'billing_clock' | 'system' (the
    // dashboard's system credential and every no-request context).
    actor: text("actor"),
    resourceType: text("resource_type"), // 'invoice' | 'subscription' | …
    resourceId: text("resource_id"), // the resource's public id / slug
    apiVersion: text("api_version").notNull().default("v1"), // envelope schema version
    /**
     * The execution that produced this event, from the ambient trace context — the
     * same id `gateway_request_logs` already stores.
     *
     * `source`/`actor` answer "who did this"; this answers "as part of WHICH run", so a
     * clock tick (or one API request) can list exactly the changes it caused instead of
     * a fuzzy created_at window that a concurrent tick would poison. Nullable: events
     * emitted outside a trace, and every row written before this column existed.
     */
    traceId: text("trace_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("events_public_id_uq").on(t.publicId),
    index("events_org_idx").on(t.organizationId),
    index("events_type_idx").on(t.type),
    index("events_biz_type_created_idx").on(t.businessId, t.type, t.createdAt),
    index("events_resource_idx").on(t.resourceType, t.resourceId),
    // Pull every event belonging to one traced execution (a tick's "what changed").
    index("events_trace_idx").on(t.traceId),
  ],
);

/**
 * Inbound provider webhook events, for idempotent processing. PLATFORM-GLOBAL
 * (not org-scoped): a provider webhook arrives before we know the org, so this is
 * accessed only via the admin connection and carries no RLS. The unique
 * (provider_key, business_id, provider_event_id) makes replays a no-op, per business:
 * a gateway account shared by two businesses delivers the same event to each.
 */
export const providerEvents = pgTable(
  "provider_events",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    providerKey: text("provider_key").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    type: text("type").notNull(),
    // C8 (GW-6/LOG-1): inbound gateway-webhook log fields.
    businessId: uuid("business_id"),
    payload: jsonb("payload"),
    // Redacted inbound webhook request headers (secrets/signatures masked).
    headers: jsonb("headers"),
    outcome: text("outcome"), // processed | ignored | error
    error: text("error"),
    // P2: the HTTP exchange itself, not just what we did with the event. All three
    // are NULL for rows written before migration 0141 and for non-HTTP callers of
    // `handleProviderEvent` (verify suites, internal replays) — null stays null.
    /** The HTTP status we answered the gateway with (200 handled, 502 → redeliver). */
    responseStatus: integer("response_status"),
    /** The URL the gateway posted to, incl. its `?id=gwa_…` account query. */
    requestUrl: text("request_url"),
    /**
     * The NORMALIZED event this delivery produced — what `handleProviderEvent`
     * actually consumed, as opposed to `payload` (the provider's raw json).
     *
     * Exists so a failed event can be REPLAYED. Replay cannot re-run the adapter:
     * `headers` is redacted (the signature is masked) and re-serialising `payload`
     * changes the bytes the signature covers, so verification can never be repeated.
     * Both of those are deliberate, which makes the interpretation the thing that has
     * to be durable. Written best-effort — a serialization failure must never break
     * ingestion, so it lands NULL and the row is simply not replayable.
     *
     * bigints are encoded as `{__t:'bigint', v:'…'}` (JSON has no bigint) and Dates as
     * ISO strings; `reviveNormalizedEvent` reverses both.
     */
    normalized: jsonb("normalized"),
    /**
     * The transaction this callback affected, as its PUBLIC id (`txn_…`) — not a
     * uuid FK, so `serializeGatewayWebhook` stays a pure row → object function and
     * this platform-global log's lifetime is not coupled to tenant data. Rationale
     * in full: db/migrations/0141_gateway_webhook_http_exchange.sql.
     */
    transactionPublicId: text("transaction_public_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    // NULLS NOT DISTINCT in migration 0351, so rows with no business still dedupe.
    uniqueIndex("provider_events_business_uq").on(t.providerKey, t.businessId, t.providerEventId),
    index("provider_events_business_idx").on(t.businessId),
    // Keyset pagination for the inbound gateway-webhook log.
    index("provider_events_business_received_idx").on(
      t.businessId,
      t.receivedAt.desc(),
      t.id.desc(),
    ),
    // The clock pass that re-queues errored gateway webhooks (0401).
    index("provider_events_error_received_idx")
      .on(t.receivedAt)
      .where(sql`${t.outcome} = 'error'`),
  ],
);

/**
 * SCHED-1: one row per billing_clock_tick — start/finish, per-pass counters, and
 * per-item errors (instead of swallowing them into a log line). Platform-global
 * (like provider_events; no RLS) — the clock crosses tenants.
 *
 * `overran` flags a tick that ran too long, or one that started too late *while a
 * worker was up for the whole gap* — i.e. the clock genuinely fell behind. A gap
 * that no process spanned (restart, deploy, machine asleep) is `downtime_gap`
 * instead: those ticks were never attempted, which is a different failure and must
 * not masquerade as an overrun. `lag_ms` records the measured gap either way.
 */
export const clockTicks = pgTable("clock_ticks", {
  id: uuid("id")
    .default(sql`uuid_v7()`)
    .primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  scheduledApplied: integer("scheduled_applied").notNull().default(0),
  renewed: integer("renewed").notNull().default(0),
  dunningRetried: integer("dunning_retried").notNull().default(0),
  dunningRecovered: integer("dunning_recovered").notNull().default(0),
  dunningCanceled: integer("dunning_canceled").notNull().default(0),
  webhooksDelivered: integer("webhooks_delivered").notNull().default(0),
  webhooksFailed: integer("webhooks_failed").notNull().default(0),
  // [{ org, business, subscription, step, message }]
  errors: jsonb("errors"),
  /**
   * Every pass this tick ran, in execution order:
   * `[{ name, status: ok|failed, ms, counts?: {…}, error? }]`.
   *
   * The seven counter columns above cover four passes; the tick runs fifteen, and
   * the rest existed only inside a log string — so "what did the 03:00 tick actually
   * do" was unanswerable from the database, and "which pass was slow" or "which pass
   * threw" doubly so. Written by the `runPass` wrapper in platform/jobs.ts, so a pass
   * cannot be added without appearing here.
   */
  passes: jsonb("passes"),
  /**
   * The tick's trace id (`job-…`), stamped at START so it survives a tick that never
   * finishes. Joins to `gateway_request_logs.trace_id` and `events.trace_id`, which is
   * what turns this row from a set of counters into "here is everything that happened".
   */
  traceId: text("trace_id"),
  /** ms from the previous tick's finish to this tick's start; null for the first tick. */
  lagMs: integer("lag_ms"),
  downtimeGap: boolean("downtime_gap").notNull().default(false),
  overran: boolean("overran").notNull().default(false),
});

/** One row per (event → endpoint) delivery attempt chain, with retry/backoff. */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    /** The event's business (0350), so the egress pass ranks without joining events. NULL = org-level. */
    businessId: uuid("business_id"),
    endpointId: uuid("endpoint_id").notNull(),
    status: text("status").notNull().default("pending"), // pending | delivered | failed
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastResponseStatus: integer("last_response_status"),
    /**
     * Wall-clock ms of the LAST attempt (0249). `attempts` says how often we tried and
     * `last_attempt_at` when — neither says how long a POST takes, which is the number
     * egress concurrency has to be sized from. NULL on rows predating the column.
     */
    durationMs: integer("duration_ms"),
    /**
     * What the receiver said on the last failed attempt (0278): its response body, clipped, or
     * the transport error when nothing answered. NULL once delivered.
     */
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("webhook_deliveries_org_idx").on(t.organizationId),
    index("webhook_deliveries_status_idx").on(t.status, t.nextAttemptAt),
    index("webhook_deliveries_event_idx").on(t.eventId, t.status),
    // An endpoint's delivery log, paged newest-first (0377).
    index("webhook_deliveries_endpoint_created_idx").on(t.endpointId, t.createdAt, t.id),
    // Team alerts (0489): a business's failed deliveries by last attempt.
    index("webhook_deliveries_failed_biz_idx")
      .on(t.businessId, t.lastAttemptAt)
      .where(sql`status = 'failed'`),
  ],
);

/**
 * One row per live worker PROCESS, refreshed on an interval.
 *
 * graphile-worker 0.16 keeps no worker registry of its own — `graphile_worker.jobs`
 * exposes `locked_by` only while a job is actually running, so with an idle queue
 * there is no way to tell "the clock is healthy" from "the worker died three hours
 * ago". This table is that missing signal: the process announces itself on boot,
 * beats while alive, and stamps `stopped_at` on a graceful shutdown. A row whose
 * `last_beat_at` is older than `WORKER_STALE_MS` with no `stopped_at` is a process
 * that crashed or was SIGKILLed — exactly the state an operator needs to see.
 *
 * Platform-global (no RLS, like `clock_ticks` / `provider_events`): the worker runs
 * the clock for every tenant, so it belongs to no single organization.
 */
export const workerHeartbeats = pgTable(
  "worker_heartbeats",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    // wrk_… — identifies the PROCESS (minted at boot), not a graphile-worker
    // in-pool worker. A restart is a new row, which is what makes uptime and
    // restart-loops visible.
    workerId: text("worker_id").notNull(),
    hostname: text("hostname").notNull(),
    pid: integer("pid").notNull(),
    // Which worker this process is. `billing` (the clock) is the only role a deployment
    // runs today and `all` is its dev alias; historical rows also hold `shadow` (a
    // poller removed in 0236) and NULL (a build from before roles existed).
    // NULL is left as-is on purpose: defaulting it to 'billing' would assert a role the
    // process never claimed. Read it as an OPEN set, not an enum.
    role: text("role"),
    concurrency: integer("concurrency").notNull(),
    // Registered task identifiers + the crontab this process is running, so the
    // dashboard can show what a given process is actually able to do — a stale
    // deploy running an old task set is otherwise invisible.
    tasks: jsonb("tasks"),
    crontab: text("crontab"),
    jobsActive: integer("jobs_active").notNull().default(0),
    jobsSucceeded: integer("jobs_succeeded").notNull().default(0),
    jobsFailed: integer("jobs_failed").notNull().default(0),
    // graphile-worker's own in-pool worker ids (`worker-3391e…`) owned by this process.
    // graphile keeps NO worker registry, so these ids are durable nowhere else — and
    // without them a queue lock's `locked_by` cannot be traced to a process, which is
    // exactly what stranded the billing clock for 46 minutes on 2026-08-29 (0215).
    //
    // NULL means "row predates the column", NOT "holds no locks" — the distinction is what
    // makes the sweep safe to deploy (see `liveGraphileWorkerIds`). Empty = reported none.
    graphileWorkerIds: text("graphile_worker_ids").array(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    lastBeatAt: timestamp("last_beat_at", { withTimezone: true }).notNull(),
    // Set only on a clean SIGINT/SIGTERM stop. NULL + a stale beat = crashed.
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    // Did the drain finish, or did we give up and exit? `stoppedAt` is stamped either way
    // (the process is going), so without this a worker SIGKILLed mid-job reads as a clean
    // stop — which is precisely how the forced shutdown behind the 2026-08-29 incident left
    // no trace on its own row. NULL = running, or predates 0215.
    stoppedForced: boolean("stopped_forced"),
  },
  (t) => [
    uniqueIndex("worker_heartbeats_worker_id_uq").on(t.workerId),
    index("worker_heartbeats_beat_idx").on(t.lastBeatAt),
  ],
);

/**
 * Fixed-window request counters — the storage behind API rate limiting (#6).
 *
 * **Why Postgres and not memory.** The limit has to hold across processes: the API
 * runs under pm2 and can be scaled, so a per-process bucket would multiply the real
 * ceiling by the instance count and reset on every deploy. A counter row is one
 * statement per request (`insert … on conflict do update … returning`), which is
 * cheaper than the auth lookup already on that path.
 *
 * **Why fixed windows and not a token bucket.** A bucket needs the last-refill
 * instant and a rate, so every read is a write even when nothing is consumed, and the
 * arithmetic has to be done in SQL to stay atomic. A fixed window is a single integer
 * and the reset instant is derivable from the key itself, which is also what makes the
 * `X-RateLimit-Reset` header honest. The known cost is burstiness at a boundary — up
 * to 2× the limit across two adjacent windows — which is acceptable for a ceiling
 * meant to stop runaway integrations rather than to shape traffic precisely.
 *
 * Keyed per API KEY, not per organization: an org's integrations and its dashboard
 * hold different credentials, so one runaway script cannot lock the operator out of
 * their own console. The LIMIT is configured per organization
 * (`organizations.rate_limit_per_minute`) and applies to each of its keys.
 *
 * Rows are swept by the clock (`sweepRateLimitCounters`) — the window is a minute, so
 * anything older than the retention below is unreachable by definition.
 */
export const rateLimitCounters = pgTable(
  "rate_limit_counters",
  {
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    /** Start of the fixed window this row counts — always truncated to the minute. */
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.apiKeyId, t.windowStart] }),
    // The sweep's predicate. Also the only index the read path needs beyond the PK.
    index("rate_limit_counters_window_idx").on(t.windowStart),
  ],
);

/**
 * The same fixed-window mechanism for routes reached WITHOUT an API key (0191): the
 * dashboard's login and signup, and the buyer's portal magic-link request.
 *
 * Separate from `rateLimitCounters` above because that table's key is a uuid with a
 * foreign key into `api_keys`, and none of these callers has a row there — that is the
 * gap 0180's own "NOT COVERED" paragraph describes, now closed.
 *
 * `bucket` is a namespaced key minted by `consumePublicRateLimit`, e.g.
 * `login:ip:203.0.113.7` or `login:email:<sha256>`. Addresses go in plain (they are in
 * the access log already, and an operator reading a 429 needs to see them); email
 * addresses are hashed, because a table listing who recently tried to sign in is an
 * account directory, and account directories are what SR-2026-010 is about. Equality
 * is all a counter needs, and a hash compares equal.
 */
export const publicRateLimitCounters = pgTable(
  "public_rate_limit_counters",
  {
    bucket: text("bucket").notNull(),
    /** Start of the fixed window this row counts — always truncated to the minute. */
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.bucket, t.windowStart] }),
    index("public_rate_limit_counters_window_idx").on(t.windowStart),
  ],
);

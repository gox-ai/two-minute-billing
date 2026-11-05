import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";

/**
 * One row per (invariant check × run) — the CORRECTNESS watchdog's record.
 *
 * `/ops` was a LIVENESS monitor: workers, queue, clock, outboxes. It answers "is the
 * engine running", never "is the engine right". Every one of the five bug-fix
 * commits before this table existed — a cancelled subscription keeping its MRR, the
 * dashboard reporting 10.3× the true MRR, a downgrade corrupting a subscription —
 * shipped with every `/ops` tile green. This is the layer that would have caught them:
 * a set of statements about the data that must be true, evaluated on a schedule, with
 * the offending rows kept.
 *
 * Platform-global — NO RLS, like `clock_ticks` and `worker_heartbeats`. A correctness
 * check crosses every tenant by construction (an unbalanced ledger transaction is not
 * one organization's business), so the rows belong to no organization and the read API
 * is gated to an `all`-mode key instead.
 */
export const opsInvariantResults = pgTable(
  "ops_invariant_results",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    /** Stable identifier from the `INVARIANTS` registry (`ledger_balanced`, …). */
    checkKey: text("check_key").notNull(),
    /**
     * `critical` | `warn`, snapshotted from the registry AT RUN TIME rather than
     * joined at read time: re-grading a check must not silently rewrite the severity
     * of every historical result.
     */
    severity: text("severity").notNull(),
    /**
     * How many rows violate the invariant. **Nullable, and null is not zero**: null
     * means the check did not produce an answer (see `error`). A `NOT NULL DEFAULT 0`
     * would have made a check that threw indistinguishable from a clean one — an
     * unknown rendered as healthy, which is the exact failure mode this table exists
     * to prevent.
     */
    violations: bigint("violations", { mode: "number" }),
    /**
     * A capped array of offending rows: identifying ids plus the values that make each
     * one a violation, plus the organization/business public ids so a reader can
     * navigate to the tenant it belongs to. Capped because a systemic break produces
     * one row per record in the table.
     */
    sample: jsonb("sample"),
    /** True when `violations` exceeds the sample cap — the UI must say "showing N of M". */
    sampleTruncated: boolean("sample_truncated").notNull().default(false),
    durationMs: integer("duration_ms"),
    /**
     * The check itself failed (a bad query, a missing column, a timeout) — DISTINCT
     * from "0 violations". Set together with a null `violations`.
     */
    error: text("error"),
    /** The run's trace id, so a result joins to the job's log lines and gateway calls. */
    traceId: text("trace_id"),
    ranAt: timestamp("ran_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // "The latest result for each check" and "this check's recent history" are the
    // only two reads this table has.
    index("ops_invariant_results_key_ran_idx").on(t.checkKey, t.ranAt.desc()),
  ],
);

/**
 * One row per (minute × process × method × route pattern × status class) — the HTTP
 * dimension `/ops` never had.
 *
 * The engine is thoroughly measured: `clock_ticks` records every pass with counters and
 * timings, `worker_heartbeats` records liveness, `ops_invariant_results` records
 * correctness. The API surface was measured by nothing. "How many requests, how fast,
 * how many failed" could only be answered by grepping the access log, which makes the
 * answer a function of the log retention and — once the access log is ever sampled —
 * an estimate.
 *
 * That is the reason this is a table and NOT a Cloud Logging log-based metric. A
 * log-based metric is computed at INGESTION, so it measures whatever was shipped:
 * sampling the access log would silently sample the counter with it, welding the
 * request numbers to the log bill forever. Counting in-process decouples them — these
 * rows stay exact no matter what fraction of access lines reach the sink.
 *
 * **Append-only, and rows are summed on read.** There is deliberately no unique key to
 * upsert into: an "add to the existing row" write is not safe to retry (a write that
 * succeeded but reported failure would double-count), and a flush that lands twice in
 * one minute is both legal and harmless when the reader does `SUM … GROUP BY`.
 *
 * Platform-global — NO RLS, like `clock_ticks` and `worker_heartbeats`. Request volume
 * crosses every tenant by construction, and the read API is gated to an `all`-mode key.
 */
export const opsHttpStats = pgTable(
  "ops_http_stats",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    /** Start of the minute this row covers, truncated UTC. */
    bucketStartedAt: timestamp("bucket_started_at", { withTimezone: true }).notNull(),
    /**
     * Which process produced it (`api`, `worker`; historical rows also hold
     * `worker:shadow`, a removed poller). The API and the
     * workers are separate pm2 processes writing into one table; without this they
     * would be indistinguishable, and "is the API slow" would silently include the
     * worker's own outbound work.
     */
    process: text("process").notNull(),
    method: text("method").notNull(),
    /**
     * The route PATTERN (`/v1/businesses/:biz/subscriptions`), never the raw path.
     * Same reason the access-log message is a constant: pattern × class × minute is a
     * bounded key space, raw paths are not, and a metric keyed on ten thousand
     * subscription ids is a metric you cannot group by.
     */
    route: text("route").notNull(),
    /** 2, 3, 4 or 5 — the leading digit. Enough to alert on, cheap to group by. */
    statusClass: integer("status_class").notNull(),
    requests: integer("requests").notNull().default(0),
    /** Sum of durations, so the mean is derivable without storing every sample. */
    durationMsTotal: bigint("duration_ms_total", { mode: "number" }).notNull().default(0),
    /** The worst single request in the bucket — the one a mean would hide. */
    durationMsMax: integer("duration_ms_max").notNull().default(0),
    /**
     * Cumulative-count histogram keyed by upper bound in ms
     * (`{"5":n,"10":n,…,"+Inf":n}`), which is what makes p95/p99 recoverable from
     * aggregated rows. A mean cannot be un-averaged and a per-row p95 cannot be
     * combined, so storing either alone would make every multi-row read a lie.
     */
    buckets: jsonb("buckets").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // The two reads: a time window across everything, and one route's history.
    index("ops_http_stats_bucket_idx").on(t.bucketStartedAt.desc()),
    index("ops_http_stats_route_bucket_idx").on(t.route, t.bucketStartedAt.desc()),
  ],
);

/**
 * One row per outbound dependency we have stopped calling, and why — the circuit breaker's
 * durable state.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 * Every outbound call already has a timeout, a per-message retry backoff and a pass-wide
 * budget. All three worked as written on 2026-09-01 and the billing clock still fell three
 * days behind, because none of them addresses the actual shape of the failure: one
 * business's SMTP host was unreachable, so every attempt paid the full 10s connect timeout.
 * At ~2,900 messages/day x 6 attempts that is ~174,000s of clock time demanded per day
 * against the 86,400s a day contains. Per-message backoff cannot fix a fault that belongs
 * to the relay — there is always another message due — and no budget value survives that
 * arithmetic; a smaller budget merely caps attempts while the backlog grows unbounded.
 *
 * The missing move is to stop calling a host that is not answering. `MailerSendError.fault`
 * (`providers/mailer/types.ts`) supplies the signal; this table remembers the verdict.
 *
 * ── WHY A TABLE AND NOT PROCESS MEMORY ──────────────────────────────────────────
 * In-memory state resets on every deploy, so each release re-pays the full timeout sequence
 * before re-learning what it already knew. It is also invisible: "which dependency is down"
 * is the first question during an incident, and an answer that lives only inside one worker
 * process cannot be read from the ops API or shared with a second worker when the scheduler
 * is sharded.
 *
 * The cost this design refuses to pay is a query per message. Callers read the OPEN SET once
 * at the start of a pass and decide in memory; rows are written only when the state changes.
 * A breaker that did a round trip per row would have reintroduced a per-row cost to remove
 * one.
 *
 * Platform-global — NO RLS, like `clock_ticks`, `worker_heartbeats` and the other ops tables.
 * The KEY is scoped per business (a relay is a tenant's own configuration), but the health of
 * a host is an operational fact about the deployment, and the billing clock that reads it
 * crosses every tenant by construction.
 */
export const dependencyHealth = pgTable(
  "dependency_health",
  {
    /**
     * `<kind>:<businessId|platform>:<host>` — e.g. `smtp:3f2a…:smtp.resend.com:4650`.
     *
     * Deliberately one opaque text key rather than three columns. The parts differ by
     * transport (SMTP has a host and port, SES has a region, a webhook has a URL origin),
     * and a schema that tried to model all of them would either grow a column per transport
     * or leave most of them null on every row. The key is built by one function
     * (`platform/circuit-breaker.ts`), which is where the shape is enforced.
     */
    key: text("key").primaryKey(),
    /**
     * `closed` (calling normally) | `open` (not calling) | `half_open` (one probe allowed).
     *
     * Stored rather than derived from `next_probe_at` so the ops API can report the state
     * without reimplementing the transition rules, and so a half-open probe in flight is
     * distinguishable from a cooldown that has merely elapsed.
     */
    state: text("state").notNull().default("closed"),
    /**
     * Consecutive TRANSPORT faults. Reset to 0 by any success, which is what makes an
     * intermittently-flapping host stay closed instead of tripping on scattered failures.
     */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** When the breaker last opened — for "this has been down for 40 minutes". */
    openedAt: timestamp("opened_at", { withTimezone: true }),
    /**
     * When one probe may next be attempted. The cooldown doubles on each failed probe up to
     * a cap, so a host that is down for a day is called ~a dozen times rather than 1,440.
     */
    nextProbeAt: timestamp("next_probe_at", { withTimezone: true }),
    /**
     * The error that opened it, kept verbatim. Without it the ops page can say a dependency
     * is broken but not what it said — and "connect ETIMEDOUT 1.2.3.4:4650" is usually the
     * whole diagnosis.
     */
    lastError: text("last_error"),
    /** Human-facing label for the ops page: `smtp`, `ses`, `webhook`. */
    kind: text("kind").notNull(),
    /** Which business's configuration this dependency belongs to; null for platform-wide. */
    businessId: uuid("business_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // The pass-start read is "everything not closed", and it must stay cheap enough to do
    // once per pass without thinking about it.
    index("dependency_health_open_idx").on(t.state, t.nextProbeAt),
  ],
);

/**
 * THE DIARY — what is due, and when, as one narrow row per item of scheduled work.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────────
 * Finding out who needs billing currently means looking at every customer: the clock
 * scans `subscriptions` for `current_period_end <= now`, `scheduled_changes` for
 * `effective_at <= now`, `invoices` for `next_attempt_at <= now`. Each is indexed and
 * each is bounded by `TICK_SCAN_LIMIT`, so none of them is slow today — but the cost of
 * every one tracks HOW MANY ENTITIES EXIST rather than how much is actually due, and at
 * 24,343 live subscriptions almost every row read is a row that needed nothing.
 *
 * A diary inverts that. Each state change writes the next due date as it goes, so the
 * clock reads only today's page: twenty rows to find twenty due items, whether the book
 * holds twenty-five thousand customers or ten million. The scan stops being a function of
 * size and becomes a function of work — which is the whole of what "scales" means here.
 *
 * ── STATUS: WRITTEN AND VERIFIED, NOT YET READ ──────────────────────────────────
 * Nothing schedules from this table yet, deliberately. It is populated by
 * `refreshDueWork` and continuously compared against the live scans by the
 * `due_work_matches_sources` invariant. Cutover happens per shard once the two have
 * agreed across a month boundary — the instant when anchors, timezones and proration all
 * interact at once, and the only honest test of a due-date index.
 *
 * A diary is a DENORMALISATION, and denormalisations drift. A missed write here is not an
 * error, it is silence: a subscription that quietly never bills again. That is why the
 * reconciler ships in the same change rather than after it, and why the gate is seven days
 * of zero drift rather than a passing test.
 *
 * ── SHARD FROM DAY ONE ──────────────────────────────────────────────────────────
 * `shard` is written and indexed now, while a single scheduler owns all 1,024 groups and
 * nothing reads it. Retrofitting a shard key onto a live money table is the expensive
 * version of this work; carrying an unused column is free.
 *
 * Platform-global — NO RLS, like the other ops tables. The billing clock crosses every
 * tenant by construction, so the rows belong to no organization; `business_id` is carried
 * for the fair-share and per-tenant work that reads it, not as a scope.
 */
export const dueWork = pgTable(
  "due_work",
  {
    /** `hashtext(business_id) % 1024` — fixed at write time, never recomputed. */
    shard: integer("shard").notNull(),
    /** When this item becomes due. THE index column: the clock range-scans on it. */
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    /**
     * What kind of work: `renewal` | `trial_end` | `scheduled_change` | `dunning_retry`.
     *
     * Part of the key because one entity can owe two different things at once — a
     * subscription has both a term end and a trial end, and they are different dates
     * driving different code.
     */
    kind: text("kind").notNull(),
    /** The subscription, scheduled change or invoice this is about. */
    entityId: uuid("entity_id").notNull(),
    businessId: uuid("business_id"),
    organizationId: uuid("organization_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // One row per (entity, kind). The composite primary key is what makes the write path
    // an idempotent upsert rather than a delete-then-insert — the latter has a window in
    // which the item is due and invisible, which on this table means a bill that does not
    // go out.
    primaryKey({ columns: [t.entityId, t.kind] }),
    // THE read path: "everything due in my shards, oldest first". An index-only range scan
    // on a narrow table, whose cost is the number of rows returned rather than the number
    // of subscriptions that exist.
    index("due_work_shard_due_idx").on(t.shard, t.dueAt),
  ],
);

/**
 * One row per run of a nightly job: opened when it starts, closed when it ends. A run with
 * no `finishedAt` never finished — the worker died mid-run. Platform-global, NO RLS.
 */
export const jobRuns = pgTable(
  "job_runs",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    job: text("job").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ok: boolean("ok"),
    error: text("error"),
  },
  (t) => [index("job_runs_started_idx").on(t.startedAt)],
);

/**
 * One row per request body the API refused on a BUYER surface (portal, hosted checkout).
 * No operator watches those pages, so a buyer stuck on a validation error leaves without a
 * trace anywhere but the log file. The back-office reads this into its error feed and posts
 * a session that keeps failing. Quoted values are redacted before the write, like the log.
 * Platform-global, NO RLS; `sweepBuyerRejections` enforces retention.
 */
export const buyerRequestRejections = pgTable(
  "buyer_request_rejections",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    /** `portal` or `checkout`. */
    surface: text("surface").notNull(),
    method: text("method").notNull(),
    /** The route PATTERN, never the raw path. */
    route: text("route").notNull(),
    /** The portal or checkout session public id — the unit a "stuck buyer" is. */
    sessionPublicId: text("session_public_id").notNull(),
    organizationId: uuid("organization_id"),
    businessId: uuid("business_id"),
    customerId: uuid("customer_id"),
    /** The message the buyer was shown, values redacted. */
    message: text("message").notNull(),
    /** Field → reasons, values redacted. Empty for a plain-text rejection. */
    fields: jsonb("fields").$type<Record<string, string[]>>().notNull().default({}),
    traceId: text("trace_id"),
  },
  (t) => [
    index("buyer_request_rejections_created_idx").on(t.createdAt),
    index("buyer_request_rejections_session_idx").on(t.sessionPublicId, t.createdAt),
  ],
);

/**
 * One row per unhandled API failure (a 5xx from `setErrorHandler`), so the back-office error
 * feed can group them; until this table they existed only in the log. Tenants are stored as
 * the trace context holds them (a public id, sometimes a uuid) and resolved on read. Message
 * and stack are credential-redacted. Platform-global, NO RLS; `sweepApiServerErrors` keeps 30 days.
 */
export const apiServerErrors = pgTable(
  "api_server_errors",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    method: text("method").notNull(),
    /** The route PATTERN, never the raw path. */
    route: text("route").notNull(),
    status: integer("status").notNull(),
    errorName: text("error_name").notNull(),
    errorCode: text("error_code"),
    message: text("message").notNull(),
    stack: text("stack"),
    organizationRef: text("organization_ref"),
    businessRef: text("business_ref"),
    traceId: text("trace_id"),
  },
  (t) => [index("api_server_errors_created_idx").on(t.createdAt)],
);

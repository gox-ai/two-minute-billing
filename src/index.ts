import { fileURLToPath } from "node:url";
import Fastify, {
  type FastifyInstance,
  type FastifyError,
  type FastifyBaseLogger,
  type RouteOptions,
} from "fastify";
import { config } from "./platform/config";
import { clientErrorHandler } from "./platform/client-error";
import { edition, ignoredCloudSettings } from "./platform/edition";
import { pingDb, closeDb, writeTrackingHook, writeTrackingCleanupHook } from "./platform/db";
import { requestClockHook } from "./platform/clock";
import { strictParamsRouteHook } from "./api/strict-params";
import { requestShapeHook } from "./api/request-shape";
import { readiness } from "./platform/health";
import { registerRoutes } from "./api/routes";
import { declareRoutePermission } from "./api/permission-registry";
import { eventContextHook } from "./platform/event-context";
import { requestKind } from "./platform/auth";
import { createLogger, logger, captureProcessErrors, flushCloudLogging } from "./platform/logger";
import { recordHttpRequest, startHttpStatsFlush } from "@/modules/ops/http-stats";
import { recordApiServerError } from "@/modules/ops/api-errors";
import { publicRequestId, registerRequestLog } from "@/modules/request-log/capture";
import { startRequestLogFlush } from "@/modules/request-log/flush";
import { enableSeriesCache } from "@/modules/metrics/daily/series-cache";
import { registerReplyGuard } from "./platform/reply-guard";
import { registerSecurityHeaders } from "./platform/security-headers";
import { registerCors } from "./platform/cors";
import { trustProxyHops } from "./platform/trust-proxy";
import { loadGeoReference } from "./platform/geo";
import { requireCurrentSchema } from "./platform/selfhost/schema-check";
// Side-effect: registers the webhook-delivery sink with the events module
// (ADR-009 — events primary, webhooks a subscriber). Must load before any event
// is emitted in the server process.
import "./modules/webhooks/outbox";
import "./modules/emails/outbox";
// Every integration (HubSpot, push partners) hangs off this one sink.
import "./modules/integrations/sink";
import "./modules/receipts/sink";
import "./modules/usage-controls/sink";

/** Every unhandled API failure is logged here — see `setErrorHandler` below. */
const apiLog = createLogger("api");

/**
 * Routes whose access log is `debug`. A probe every few seconds is not information, and
 * at three endpoints it would otherwise be the highest-volume line the service produces.
 * Matched on the route PATTERN, so a probe with a cache-buster query string still counts.
 */
const PROBE_ROUTES = new Set(["/health", "/healthz", "/readyz"]);

/** Build the Fastify app (no side effects) — reused by the server + tests.
 *  `onRoute` lets tooling (openapi-coverage) enumerate the REAL registered
 *  routes instead of regexing source (which missed helper-registered routes —
 *  finale review blocker). */
export async function buildApp(opts?: {
  logger?: boolean;
  onRoute?: (r: RouteOptions) => void;
}): Promise<FastifyInstance> {
  const app = Fastify({
    // The SHARED root logger (`platform/logger`), not a second pino built here.
    // Fastify's own request/response lines then land in the same place as every
    // `createLogger(...)` line — including the Google Cloud Logging sink when it is
    // switched on. Two independently-configured loggers is how you get a request
    // log in Logs Explorer and its error only on stdout.
    ...(opts?.logger === false
      ? { logger: false }
      : { loggerInstance: logger as FastifyBaseLogger }),
    // How many hops of `X-Forwarded-For` may be believed — i.e. whether `req.ip` is the
    // CLIENT or a proxy in front of us. The public rate limiter (`platform/rate-limit.ts`)
    // keys on `req.ip`, so this is load-bearing for W3, and SR-2026-009 Finding 3 lists
    // it as remediation step 4.
    //
    // A HOP COUNT since 2026-08-27 (audit H3). It was `TRUST_PROXY === 'TRUE'`, and
    // `trustProxy: true` believes the WHOLE chain and resolves `req.ip` to its LEFTMOST
    // entry — the one the client wrote. The old comment here already knew the hazard and
    // asked for a proxy that REWRITES the header; Caddy and nginx both APPEND, so that
    // condition was essentially never met and the safe configuration had no spelling.
    // A count fixes that: trust the last N entries, never the first.
    //
    // Deliberately NOT inferred. The framework cannot see the topology, and each way
    // of guessing wrong fails differently:
    //   • too many hops → the header is attacker-supplied, every request claims a fresh
    //     address, and the limiter is silently a no-op;
    //   • too few, behind a proxy → every request reads as the proxy's address, the
    //     whole internet shares one counter, and everyone is refused with 429.
    // The first is invisible, the second is a total outage. Neither is a default worth
    // shipping, so it is stated per deployment: `TRUST_PROXY_HOPS=1` behind a single
    // reverse proxy (the `deploy/README.md` shape — one nginx), 0 when the socket faces the
    // internet directly.
    trustProxy: trustProxyHops(config.TRUST_PROXY_HOPS),
    // Fastify's built-in pair is replaced by the single `onResponse` line below.
    // Its two lines per request said `incoming request` / `request completed` and
    // nothing else: method, path and status lived in nested `req`/`res` objects that
    // never reach a log viewer's summary column, so every request in Logs Explorer
    // rendered identically and the highest-volume log in the system was unreadable.
    // One line that names what happened beats two that don't.
    disableRequestLogging: true,
    // Parser-level refusals (e.g. `FOOBAR /health`) answer in our error envelope.
    clientErrorHandler,
  });

  // The boot gate: a route behind `authenticate` with no declared permission throws here.
  app.addHook("onRoute", declareRoutePermission);
  if (opts?.onRoute) app.addHook("onRoute", (r) => opts.onRoute!(r));

  // ── The access log ─────────────────────────────────────────────────────────
  // One line per request, through the module logger (NOT the raw pino instance), so
  // it carries service/traceId/source/actor/org/business like every other line and
  // can be joined to the error it produced.
  //
  // The message is written to be READ: `POST /v1/businesses/:biz/subscriptions 201
  // 18.4ms`. `route` is the PATTERN, not the raw path — you group by
  // `/v1/.../:sub`, you never group by ten thousand distinct subscription ids — and
  // the raw path rides along as `path` for when you need the actual id.
  //
  // Levels are the outcome, so severity alone is alertable: 5xx error, 4xx warn,
  // health checks debug (a liveness probe every few seconds is not information),
  // everything else info. A 5xx also produces the ERROR line with the stack from
  // `setErrorHandler`; the two share a traceId, so they read as one event.
  if (opts?.logger !== false) {
    app.addHook("onResponse", (req, reply, done) => {
      const status = reply.statusCode;
      const route = req.routeOptions?.url ?? "(unrouted)";
      const ms = Math.round(reply.elapsedTime * 10) / 10;
      const fields = {
        event: "http_request",
        method: req.method,
        route,
        path: req.url,
        ...(req.requestLog ? { requestId: publicRequestId(req.requestLog.id) } : {}),
        status,
        durationMs: ms,
        ...(req.headers["user-agent"]
          ? { userAgent: String(req.headers["user-agent"]).slice(0, 200) }
          : {}),
      };
      // The message is a CONSTANT per route — `POST /v1/gateway_webhooks/:gateway` — and
      // never carries the status or the duration. Those vary on every single call, so
      // baking them into the summary makes each line a unique string and defeats the one
      // thing a log viewer does with messages: group them. Status and timing are
      // dimensions you filter and aggregate BY (`status>=500`, p95 of `durationMs`), which
      // means they belong in the payload. Same rule everywhere: constant message,
      // variable data in fields.
      const message = `${req.method} ${route}`;
      if (status >= 500) apiLog.error(message, fields);
      else if (status >= 400) apiLog.warn(message, fields);
      else if (PROBE_ROUTES.has(route)) apiLog.debug(message, fields);
      else apiLog.log(message, fields);
      // The COUNTER, beside the log line and independent of it (OBS-1). This is what
      // makes "how many requests, how fast" answerable without reading logs — and
      // therefore what makes sampling the access log a free decision later rather than
      // a trade against observability. Probe routes are excluded for the same reason
      // they log at debug: an orchestrator polling every few seconds would otherwise be
      // most of the request rate.
      if (!PROBE_ROUTES.has(route)) {
        recordHttpRequest({ method: req.method, route, status, durationMs: ms });
      }
      done();
    });
  }

  // One reply per request — must be the FIRST onSend hook so it runs ahead of the
  // route-level (async) `idempotencyOnSend`. Without it, a route that replies and
  // then returns bare double-sends and an uncaught ERR_HTTP_HEADERS_SENT kills the
  // process. See platform/reply-guard.ts.
  registerReplyGuard(app);

  // Cross-origin policy (W7). Registered BEFORE anything that can answer a request, so
  // a preflight is decided by the allowlist rather than by whichever handler a browser's
  // OPTIONS happens to reach. Grants exactly the three origins this deployment names
  // (DASHBOARD_BASE_URL / PORTAL_BASE_URL / WEBHOOK_BASE_URL) and nothing else — see
  // platform/cors.ts for why it is an exact-match Set and why credentials are never
  // advertised.
  registerCors(app);

  // JSON only: without Fastify's default text/plain parser, a text/plain body is a 415
  // instead of a string a route may skip validating. Routes that take raw or form bodies
  // (gateway and SES webhooks, HubSpot, the test form post) register their own parsers.
  app.removeContentTypeParser("text/plain");

  // Security response headers (W2) on every reply — including 4xx, 5xx and redirects,
  // which is why it is an `onSend` hook. See platform/security-headers.ts.
  registerSecurityHeaders(app);

  // Establish a request-scoped event context for every request (EV-2). The actor
  // is filled in by `authenticate` once the API key is resolved.
  app.addHook("onRequest", eventContextHook);

  // Request-scoped slot recording whether this request has made a durable write.
  // Established here (with `run`, which reaches the whole lifecycle) and filled in
  // by the `idempotency` preHandler once the key is known; `idempotencyOnSend`
  // needs it to tell a pre-write early return — whose key must stay reusable —
  // from a failure that already moved money, which must never silently re-execute.
  // See platform/db.ts § "side effects began" tracking.
  app.addHook("onRequest", writeTrackingHook);
  // The backstop for the one-place-only `stopTrackingWrites()` — see writeTrackingCleanupHook.
  app.addHook("onResponse", writeTrackingCleanupHook);
  // Request-scoped Time Travel pin, filled by `resolveBusiness` (platform/clock.ts).
  app.addHook("onRequest", requestClockHook);
  // Route pattern for the `API_UNKNOWN_PARAMS=warn` log line (api/strict-params.ts).
  app.addHook("onRequest", strictParamsRouteHook);
  // Repeated query keys, NUL bytes and control characters in ids: a 400, never a 500.
  app.addHook("onRequest", requestShapeHook);
  // API request log: mints the `Request-Id` header, buffers one row per logged request
  // (modules/request-log). Read-only hooks; a logging failure never changes a reply.
  registerRequestLog(app, { kindOf: requestKind });

  // The original composite check, kept EXACTLY as it was: `deploy/README.md` step 8 and
  // two verify suites call it, and an endpoint an operator has in their fingers is not
  // worth reshaping for tidiness. `/healthz` + `/readyz` below are the orchestrator's
  // pair — this one stays the human's "is it up and can it see the database".
  app.get("/health", async (_req, reply) => {
    const dbOk = await pingDb();
    return reply.code(dbOk ? 200 : 503).send({
      status: dbOk ? "ok" : "degraded",
      db: dbOk ? "up" : "down",
      service: "tmbilling",
      env: config.NODE_ENV,
    });
  });

  /**
   * LIVENESS — "is this process wedged?" Checks NOTHING external, on purpose.
   *
   * The temptation is to reuse `/health` here. Don't: it pings the database, so pointing
   * a liveness probe at it hands the orchestrator a kill order for every API process the
   * moment Postgres blinks — a recoverable blip becomes a fleet-wide restart storm whose
   * simultaneous reconnects are what finish the database off. If this process can answer
   * at all, it is alive, and that is the entire question. See platform/health.ts.
   */
  app.get("/healthz", async (_req, reply) =>
    reply.code(200).send({ status: "ok", service: "tmbilling-api", env: config.NODE_ENV }),
  );

  /**
   * READINESS — "should this process be given traffic?" DB + job queue.
   *
   * The queue is in here because an API that cannot reach `graphile_worker` still serves
   * reads perfectly while silently failing to enqueue the webhook-outbox nudge every
   * write depends on — a half-working process is exactly what readiness exists to pull
   * out of rotation.
   *
   * Deliberately NOT the billing worker's liveness. That was the first shape of this
   * route and it is a trap: it would take the whole API offline — payments, the portal,
   * the dashboard — because a background process died, turning a delayed renewal into a
   * total outage. Whether the clock is running is a real question, answered by the
   * `worker_heartbeats` rows and by the worker's OWN probe on WORKER_HEALTH_PORT, neither
   * of which can take the API down.
   */
  app.get("/readyz", async (_req, reply) => {
    const r = await readiness();
    return reply.code(r.ready ? 200 : 503).send({
      status: r.ready ? "ready" : "not_ready",
      service: "tmbilling-api",
      db: r.db,
      queue: r.queue,
      env: config.NODE_ENV,
    });
  });

  // Consistent error envelope for ALL failures (matches the {error:{type,message}}
  // shape routes use). Validation → 400; everything unexpected → 500 WITHOUT
  // leaking internals/stack traces to the client (logged server-side instead).
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status =
      err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    // Through the module logger, not `req.log`: this is the one place every
    // unhandled API failure passes through, and it is worth the trace context
    // (traceId / org / business / actor) that `req.log`'s raw pino child lacks.
    if (status >= 500) {
      apiLog.error(err, {
        event: "http_request_failed",
        method: req.method,
        // Pattern first (groupable), raw path second (reproducible).
        route: req.routeOptions?.url ?? "(unrouted)",
        path: req.url,
        status,
      });
      recordApiServerError(req, err, status);
    }
    if (err.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return reply.code(415).send({
        error: {
          type: "invalid_request_error",
          message: "The request body must be JSON. Send Content-Type: application/json.",
        },
      });
    }
    if (err.validation) {
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: err.message } });
    }
    return reply.code(status).send({
      error: {
        // A domain error that sets its own 4xx `statusCode` may name its type too.
        type:
          status === 500
            ? "api_error"
            : ((err as { errorType?: string }).errorType ?? "invalid_request_error"),
        message: status === 500 ? "Internal server error" : err.message,
        // A 4xx domain error (one that names its errorType) may carry a stable machine code.
        // Fastify's own FST_* codes have no errorType and stay out.
        ...(status !== 500 && (err as { errorType?: string }).errorType && err.code
          ? { code: err.code }
          : {}),
        // A 4xx domain error may name the request field it refused, so a client can show it there.
        ...(status !== 500 && typeof (err as unknown as { param?: unknown }).param === "string"
          ? { param: (err as unknown as { param: string }).param }
          : {}),
      },
    });
  });

  // Consistent 404 envelope.
  app.setNotFoundHandler((req, reply) => {
    reply
      .code(404)
      .send({ error: { type: "not_found", message: `No route for ${req.method} ${req.url}` } });
  });

  // Country/subdivision reference data, loaded once. The address validators are
  // synchronous (they run inside tax resolution), so the set has to be in memory
  // before the first request rather than fetched per call.
  await loadGeoReference();

  await registerRoutes(app);
  return app;
}

export async function start() {
  // The serving process only: tests build the app without `start()` and read their own
  // writes, so they must never see a cached copy (series-cache.ts).
  enableSeriesCache();
  // Anything that escapes Fastify — a rejected promise in a hook, a throw inside a
  // timer — is logged (with its stack, through the sink) instead of vanishing into
  // Node's default handling.
  captureProcessErrors("api", (kind) => {
    if (kind === "uncaughtException") process.exit(1);
  });
  await requireCurrentSchema(config.DATABASE_URL, apiLog);
  // Usage events have no default partition: refuse to serve without this month and the next.
  const { requireUsagePartitions } = await import("./modules/metering/partitions");
  await requireUsagePartitions();
  const app = await buildApp();
  // The API and the workers are separate pm2 processes writing into one table, so the
  // process name is part of every row — without it "is the API slow" would silently
  // include the worker's own outbound work.
  const stopHttpStats = startHttpStatsFlush("api");
  const stopRequestLog = startRequestLogFlush();
  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    apiLog.info("tmbilling listening", {
      event: "api_listening",
      host: config.HOST,
      port: config.PORT,
      edition: edition(),
    });
    const ignored = ignoredCloudSettings();
    if (ignored.length)
      apiLog.warn("Cloud-only settings ignored: TMBILLING_EDITION is not cloud", {
        event: "edition_settings_ignored",
        settings: ignored,
      });
  } catch (err) {
    apiLog.error(err, { event: "api_start_failed" });
    process.exit(1);
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      apiLog.info("signal received, shutting down", { event: "api_shutdown", signal });
      await app.close();
      // Before the pool closes: the final partial minute is still only in memory, and
      // a deploy that drops it would leave a gap in the panel at exactly the moment
      // most worth looking at.
      await stopHttpStats();
      await stopRequestLog();
      await closeDb();
      // Last: get the queued cloud entries out before the process disappears —
      // shutdown lines are exactly the ones you want after an unexplained restart.
      await flushCloudLogging();
      process.exit(0);
    });
  }
}

// Auto-start only when run directly (not when imported by tests).
//
// This is true under a plain `node --import tsx src/index.ts` (pm2 fork mode, `pnpm start`)
// and FALSE under any wrapper that owns argv[1] — pm2's cluster mode sets it to
// `ProcessContainer.js`, so the server would load, log nothing and listen on nothing.
// `src/server.ts` is the entrypoint for those: it calls `start()` outright rather than
// asking this file to guess how it was launched.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void start();
}

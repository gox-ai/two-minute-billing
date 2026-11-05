/**
 * Liveness and readiness probes (RELEASE.md A4), for BOTH process groups.
 *
 * The API serves them as Fastify routes; the worker has no HTTP surface of its own, so
 * it starts the tiny `node:http` listener at the bottom of this file. One module, because
 * the two processes must answer the same question the same way — a readiness check that
 * means "DB up" on one and "DB up + queue installed" on the other is a check nobody can
 * reason about during an incident.
 *
 * ── LIVENESS AND READINESS ARE NOT THE SAME PROBE ────────────────────────────────────
 * The distinction is the whole point, and getting it backwards is actively harmful:
 *
 *  - **Liveness** answers "is this process wedged?" — and its only correct answer during a
 *    dependency outage is YES, STILL ALIVE. It checks NOTHING external. A liveness probe
 *    that pings Postgres hands the orchestrator a kill order for every process the moment
 *    the database blinks, converting a recoverable 30-second blip into a restart storm
 *    across the fleet — with the added cruelty that each restarting process reconnects at
 *    once, so the recovery is what finishes the database off.
 *  - **Readiness** answers "should this process be given work right now?" It DOES check
 *    dependencies, and a failure removes the process from rotation without killing it, so
 *    it is still there to recover when the dependency comes back.
 *
 * Hence: `/healthz` touches nothing, `/readyz` touches everything.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import { sql } from "drizzle-orm";
import { systemDb, pingDb } from "./db";
import { createLogger } from "./logger";

const log = createLogger("health");

/** `unknown` is a real third state — see the worker's heartbeat check in worker.ts. */
export type ProbeState = "up" | "down" | "unknown";

export interface ReadinessReport {
  ready: boolean;
  db: ProbeState;
  queue: ProbeState;
}

/**
 * Is the job queue reachable AND installed?
 *
 * `to_regclass` rather than a `select … from graphile_worker.jobs`: it is a catalog
 * lookup, so it costs nothing on a table that is hot and large, and — the reason it is
 * this and not `select 1` — it returns NULL instead of throwing when the schema is
 * absent. A deployment whose migrations have not run yet is not ready, and that is a
 * different fault from "Postgres is down": this reports it as `queue: down` with `db: up`,
 * which names the actual problem instead of sending the operator to the database.
 */
export async function pingQueue(): Promise<boolean> {
  try {
    const rows = (await systemDb.execute(
      sql`select to_regclass('graphile_worker.jobs') is not null as installed`,
    )) as unknown as Array<{ installed: boolean }>;
    return rows[0]?.installed === true;
  } catch (e) {
    // Same reasoning as `pingDb`'s log line: without it, `queue: down` is the whole
    // story and there is nothing to act on during the outage.
    log.error(e, { event: "queue_ping_failed" });
    return false;
  }
}

/** The dependency half of readiness, shared by both processes. */
export async function readiness(): Promise<ReadinessReport> {
  // In parallel: two round trips on the same pool, and a serial pair would make the
  // probe's own latency the thing that trips a probe timeout during a slow spell.
  const [dbOk, queueOk] = await Promise.all([pingDb(), pingQueue()]);
  return {
    ready: dbOk && queueOk,
    db: dbOk ? "up" : "down",
    queue: queueOk ? "up" : "down",
  };
}

// ── The worker's HTTP listener ───────────────────────────────────────────────────────

export interface HealthServerOptions {
  /** Reported as `service` in every body — `api`, `worker`, … */
  service: string;
  host: string;
  /** `0` disables the server entirely (see config.WORKER_HEALTH_PORT). */
  port: number;
  /** Process-local state to merge into `/readyz` on top of the dependency checks. */
  processReadiness: () => { ok: boolean; state: string; fields?: Record<string, unknown> };
  /** Process fields for `/healthz` (role, pid, memory, …), read on every probe. */
  identity: () => Record<string, unknown>;
}

export interface HealthServer {
  port: number;
  close: () => Promise<void>;
}

/**
 * Start the worker's probe listener. Resolves `null` when disabled or when the socket
 * cannot be bound.
 *
 * **A failure here must never stop the clock.** Same rule as `registerWorker`: the
 * billing engine is the product, the monitoring surface is not, and a worker that
 * refuses to bill because a probe port was taken is a worse outage than the one the
 * probe exists to detect. It is logged at error level and the process continues
 * un-probed, which the deploy will notice as an endpoint that never answers.
 */
export async function startHealthServer(opts: HealthServerOptions): Promise<HealthServer | null> {
  if (opts.port === 0) {
    log.info("worker health server disabled", {
      event: "health_server_disabled",
      service: opts.service,
    });
    return null;
  }

  const send = (res: ServerResponse, code: number, body: unknown) => {
    const payload = JSON.stringify(body);
    res.writeHead(code, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      // A probe response is never worth caching, and an intermediary that cached a 200
      // would keep reporting a dead process healthy.
      "cache-control": "no-store",
    });
    res.end(payload);
  };

  const server = createServer((req, res) => {
    // GET only. HEAD is deliberately allowed too — several probe implementations
    // (and every naive uptime monitor) send it, and answering 404 to a HEAD would
    // read as "the endpoint is missing" rather than "the process is fine".
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD")
      return send(res, 405, { error: "method_not_allowed" });
    // Query strings and trailing slashes both appear in real probe configs.
    const path = (req.url ?? "/").split("?")[0]!.replace(/\/+$/, "") || "/";

    if (path === "/healthz") {
      return send(res, 200, { status: "ok", service: opts.service, ...opts.identity() });
    }
    if (path === "/readyz") {
      // The dependency checks are async; the process check is not. Both are needed for
      // the body, so this handler is the one place the probe does real work.
      void (async () => {
        const proc = opts.processReadiness();
        // Skipped entirely while draining: a shutting-down process is not ready no
        // matter what Postgres says, and firing two queries per probe at a database
        // during a rolling restart is pure noise.
        const deps = proc.ok ? await readiness() : null;
        const ready = proc.ok && !!deps?.ready;
        send(res, ready ? 200 : 503, {
          status: ready ? "ready" : "not_ready",
          service: opts.service,
          state: proc.state,
          ...(deps ? { db: deps.db, queue: deps.queue } : {}),
          ...opts.identity(),
          ...(proc.fields ?? {}),
        });
      })().catch((e) => {
        // The probe itself throwing must answer, not hang: an unanswered readiness
        // check eventually reads as a timeout, which is the same signal for
        // "process wedged" and "probe has a bug" — and only one of those is real.
        log.error(e, { event: "readyz_failed", service: opts.service });
        try {
          send(res, 503, { status: "not_ready", service: opts.service, state: "probe_error" });
        } catch {
          res.destroy();
        }
      });
      return;
    }
    send(res, 404, { error: "not_found" });
  });

  // Bound to WORKER_HEALTH_HOST, which defaults to loopback: this listener answers
  // process-internal questions (role, pid, uptime, which dependency is down) and has no
  // authentication, so it follows the same loopback-by-construction rule as the API and
  // dashboard sockets in deploy/README.md. Widen it deliberately, behind the firewall.
  const bound = await new Promise<Server | null>((resolve) => {
    server.once("error", (e) => {
      log.error(e, {
        event: "health_server_failed",
        service: opts.service,
        host: opts.host,
        port: opts.port,
      });
      resolve(null);
    });
    server.listen(opts.port, opts.host, () => resolve(server));
  });
  if (!bound) return null;

  // Probe connections must never hold the process open past the drain.
  bound.unref();

  log.info("worker health server listening", {
    event: "health_server_listening",
    service: opts.service,
    host: opts.host,
    port: opts.port,
  });

  return {
    port: opts.port,
    close: () =>
      new Promise<void>((resolve) => {
        // `closeAllConnections` first: `close()` alone waits for keep-alive sockets a
        // probe left open, which is exactly how a 25-second shutdown budget gets spent
        // on an idle monitoring connection instead of on draining the tick.
        bound.closeAllConnections?.();
        bound.close(() => resolve());
      }),
  };
}

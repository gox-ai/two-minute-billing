import type { FastifyInstance, FastifyReply, RouteHandlerMethod, onSendHookHandler } from "fastify";
import { createLogger } from "@/platform/logger";

const log = createLogger("reply-guard");

/**
 * Availability guard: **one reply per request, always.**
 *
 * Why this exists (2026-08-03, DoS-grade bug). Our write routes carry an async
 * `onSend` hook (`idempotencyOnSend`) that awaits a `withTenant` write before the
 * payload reaches the socket. Between `reply.send()` and the real `writeHead`,
 * Fastify still reports `reply.sent === false` — the flag is just
 * `raw.writableEnded`. So a handler that replied through a helper and then
 * `return`ed **bare** (`if (!business) return`, `if (!requireAll(req, reply)) return`
 * — ~176 call sites) resolves *inside* that window, and Fastify's `wrap-thenable`
 * — seeing `payload === undefined && reply.sent === false` — starts a **second**
 * send. The second `safeWriteHead` throws `ERR_HTTP_HEADERS_SENT` from a promise
 * reaction, where nothing catches it: **the API process dies.** Any authenticated
 * caller could trigger it with a bogus id + an `Idempotency-Key` header.
 *
 * The call sites are fixed where we can (see `resolveBusiness` — it now awaits the
 * flush, so Fastify's own gate is accurate). This hook is the *structural* net that
 * makes the whole class unreachable, including future code and shapes we have not
 * converted: the first send chain claims the reply; any later chain is dropped.
 *
 * Dropping a chain = returning without calling `done()`. That is deliberate: the
 * hook chain simply stops, no bytes are written twice, and no `writeHead` runs a
 * second time. The response the caller receives is the *first* one — the reply the
 * route actually intended. Nothing dangles beyond the request's own closures.
 *
 * Registered instance-wide in `buildApp`, which puts it **ahead of every
 * route-level `onSend`** (Fastify composes `instanceHooks.concat(routeHooks)`), so a
 * suppressed duplicate never re-runs `idempotencyOnSend` either.
 */
const kSending = Symbol("tmbilling.replySending");

type Guarded = FastifyReply & { [kSending]?: true };

/** True once a send chain has claimed this reply (even if bytes are still in flight). */
export function replySendStarted(reply: FastifyReply): boolean {
  return (reply as Guarded)[kSending] === true;
}

const sendOnce: onSendHookHandler = function sendOnce(req, reply, payload, done) {
  const r = reply as Guarded;
  if (r[kSending] === true) {
    // A second send on a reply that is already being sent. Suppressing it keeps the
    // process alive; the warning names the route so the offending shape gets fixed.
    log.warn(
      "suppressed a duplicate reply send — a handler or hook replied and then returned without awaiting the reply",
      {
        event: "duplicate_reply_suppressed",
        method: req.method,
        route: req.routeOptions?.url ?? "(unrouted)",
        path: req.url,
        statusCode: reply.statusCode,
      },
    );
    return;
  }
  r[kSending] = true;
  done(null, payload);
};

/**
 * The same stale gate bites one lifecycle stage earlier: Fastify's
 * `preHandlerCallback` decides whether to run the route handler with `if (reply.sent)
 * return`, so a **preHandler** that replies and bare-`return`s does not stop the
 * handler — it executes the write anyway, and the caller only ever sees the hook's
 * error response. Verified in-process. Every preHandler we ship (`authenticate`,
 * `idempotency`, the portal/checkout guards) correctly `return`s its reply, so this
 * is latent — but the onSend guard above would now *hide* it (no crash, silent
 * duplicate execution), so gate the handler on the same flag.
 */
function guardHandlers(app: FastifyInstance): void {
  app.addHook("onRoute", (route) => {
    if (typeof route.handler !== "function") return;
    const handler = route.handler as RouteHandlerMethod;
    const guarded: RouteHandlerMethod = function guardedHandler(this: FastifyInstance, req, reply) {
      if (replySendStarted(reply)) {
        log.warn(
          "skipped the route handler — a hook already replied but returned without awaiting the reply",
          {
            event: "route_handler_skipped",
            method: req.method,
            route: req.routeOptions?.url ?? "(unrouted)",
            path: req.url,
            statusCode: reply.statusCode,
          },
        );
        // Thenable: resolves once the in-flight reply has flushed, so Fastify does
        // not try to send anything of its own.
        return reply as unknown as ReturnType<RouteHandlerMethod>;
      }
      return handler.call(this, req, reply);
    };
    route.handler = guarded;
  });
}

/** Install the one-reply-per-request guard. Call once, before routes are registered. */
export function registerReplyGuard(app: FastifyInstance): void {
  app.addHook("onSend", sendOnce);
  guardHandlers(app);
}

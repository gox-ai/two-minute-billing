/**
 * "Email me a new link" for an expired or used portal or checkout link. Bearer = the dead
 * link's own token; the new link goes only to the customer's address on file (see
 * `modules/customer-portal/new-link.ts`).
 *
 * GET says whether the button applies. POST always answers 202 with the same body, sent
 * or not, so the answer reveals nothing a guess could use.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { config } from "@/platform/config";
import { AUTH_WINDOW_MS } from "@/platform/rate-limit";
import { refusedByRateLimit } from "./helpers";
import {
  checkoutNewLinkJob,
  portalNewLinkJob,
  queueNewLink,
  type NewLinkJob,
} from "@/modules/customer-portal/new-link";

const bearer = (req: FastifyRequest) => {
  const h = req.headers["authorization"];
  return typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7).trim() : "";
};

/** Three requests per link per window, and the auth limit per IP. */
const limited = (req: FastifyRequest, reply: FastifyReply, token: string, scope: string) =>
  refusedByRateLimit(
    req,
    reply,
    {
      scope,
      keys: [
        { kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP },
        {
          kind: "resource",
          value: createHash("sha256").update(token).digest("hex").slice(0, 32),
          limit: 3,
        },
      ],
      windowMs: AUTH_WINDOW_MS,
      failClosed: true,
    },
    "Too many requests for a new link. Wait 15 minutes and try again.",
  );

type Find = (token: string) => Promise<NewLinkJob | null>;

/** GET: whether the button applies. */
const check = (scope: string, find: Find) => async (req: FastifyRequest, reply: FastifyReply) => {
  reply.header("cache-control", "no-store");
  reply.header("referrer-policy", "no-referrer");
  const token = bearer(req);
  if (
    await refusedByRateLimit(req, reply, {
      scope: `${scope}_check`,
      keys: [{ kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP * 10 }],
      windowMs: AUTH_WINDOW_MS,
      failClosed: true,
    })
  )
    return;
  return { object: "new_link_option", available: !!(token && (await find(token))) };
};

/** POST: queue the send; always 202. */
const request = (scope: string, find: Find) => async (req: FastifyRequest, reply: FastifyReply) => {
  reply.header("cache-control", "no-store");
  const token = bearer(req);
  if (await limited(req, reply, token || "none", scope)) return;
  const job = token ? await find(token) : null;
  if (job) await queueNewLink(job);
  return reply.code(202).send({ object: "new_link_request", accepted: true });
};

// Literal paths: verify:idempotency-race reads each registration's path from its source.
export async function registerNewLinkRoutes(app: FastifyInstance) {
  app.get("/portal/v1/new_link", check("portal_new_link", portalNewLinkJob));
  app.post("/portal/v1/new_link", request("portal_new_link", portalNewLinkJob));
  app.get("/checkout/v1/new_link", check("checkout_new_link", checkoutNewLinkJob));
  app.post("/checkout/v1/new_link", request("checkout_new_link", checkoutNewLinkJob));
}

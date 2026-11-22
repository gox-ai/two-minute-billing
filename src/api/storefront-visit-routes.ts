import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticateCheckout, authenticatePortal } from "@/platform/auth";
import {
  recordVisitEvent,
  type VisitEvent,
  type VisitScope,
} from "@/modules/storefront-analytics/service";
import { badRequest, refusedByRateLimit } from "./helpers";
import { parseRequest } from "./strict-params";

/** Events per session per minute. A beacon sends a few per page; a loop must not fill the table. */
export const STOREFRONT_VISIT_RATE_PER_SESSION = 60;
/** The largest event is a few short fields. */
const BODY_LIMIT = 2048;

const utm = z.string().trim().max(200).nullish();
export const storefrontVisitBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("entry"),
    referrer_host: z.string().trim().max(253).nullish(),
    utm_source: utm,
    utm_medium: utm,
    utm_campaign: utm,
  }),
  z.object({ kind: z.literal("view") }),
  z.object({
    kind: z.literal("engage"),
    steps: z
      .record(z.string().max(16), z.number().finite().min(0))
      .refine((s) => Object.keys(s).length <= 8, "Too many steps."),
  }),
  z.object({ kind: z.literal("pdf") }),
]);

async function record(req: FastifyRequest, reply: FastifyReply, scope: VisitScope) {
  if (
    await refusedByRateLimit(req, reply, {
      scope: "storefront_visit",
      keys: [
        {
          kind: "resource",
          value: scope.sessionPublicId,
          limit: STOREFRONT_VISIT_RATE_PER_SESSION,
        },
      ],
    })
  )
    return;
  const parsed = parseRequest(storefrontVisitBody, req.body);
  if (!parsed.success) return badRequest(reply, parsed.error);
  await recordVisitEvent(scope, parsed.data as VisitEvent, req.headers);
  return reply.code(204).send();
}

/**
 * `POST /checkout/v1/visits`, `POST /portal/v1/visits`: the storefront's analytics events,
 * authorised by the buyer's own session token. Telemetry: always 204 once accepted, whether
 * or not a row was written (GPC, DNT and bots write nothing).
 */
export async function registerStorefrontVisitRoutes(app: FastifyInstance) {
  app.post(
    "/checkout/v1/visits",
    { preHandler: authenticateCheckout, bodyLimit: BODY_LIMIT },
    (req, reply) => {
      const ctx = req.checkoutSession!;
      return record(req, reply, {
        surface: "checkout",
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        sessionPublicId: ctx.sessionPublicId,
        checkoutSessionId: ctx.sessionId,
      });
    },
  );
  app.post(
    "/portal/v1/visits",
    { preHandler: authenticatePortal, bodyLimit: BODY_LIMIT },
    (req, reply) => {
      const ctx = req.portalSession!;
      return record(req, reply, {
        surface: "portal",
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        sessionPublicId: ctx.sessionPublicId,
      });
    },
  );
}

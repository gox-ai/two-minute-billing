/**
 * Embeddable usage widget (design G5 § 3.9): the operator mints a 15-minute read-only token,
 * lists the origins that may call the widget, and the widget reads one route. No write route
 * answers a widget token.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { config } from "@/platform/config";
import { idempotency, idempotencyOnSend, idempotentNoStore } from "@/platform/idempotency";
import { getCustomerByPublicId } from "@/modules/customers/service";
import {
  MAX_WIDGET_ORIGINS,
  getUsageWidgetOrigins,
  isAnyWidgetOrigin,
  mintUsageWidgetToken,
  normaliseWidgetOrigin,
  resolveUsageWidgetToken,
  setUsageWidgetOrigins,
  usageWidgetView,
} from "@/modules/usage-controls/widget";
import {
  USAGE_WIDGET_SCRIPT,
  USAGE_WIDGET_SCRIPT_INTEGRITY,
} from "@/modules/usage-controls/widget-script";
import { badRequest, notFound, requirePerm, resolveBusiness } from "./helpers";
import { parseRequest } from "./strict-params";

const originsBody = z.object({
  origins: z.array(z.string().min(1).max(300)).max(MAX_WIDGET_ORIGINS),
});

/** Where the snippet loads the script from: this API's public origin. */
const scriptUrl = () =>
  config.WEBHOOK_BASE_URL
    ? `${config.WEBHOOK_BASE_URL.replace(/\/$/, "")}/widget/v1/usage.js`
    : null;

const settingsView = (origins: string[]) => ({
  object: "usage_widget_settings",
  origins,
  script_url: scriptUrl(),
  script_integrity: USAGE_WIDGET_SCRIPT_INTEGRITY,
});

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({
    error: { type: "authentication_error", message: "Invalid or expired usage widget token" },
  });
}

export async function registerUsageWidgetRoutes(app: FastifyInstance) {
  // ── Operator: mint a token (from the operator's backend, never the browser) ──
  app.post(
    "/v1/businesses/:biz/customers/:cus/usage_widget_tokens",
    {
      preHandler: [authenticate, requirePerm("customers:manage"), idempotency],
      onSend: idempotencyOnSend,
      // The body carries the bearer token; only its hash is stored.
      config: idempotentNoStore,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cus = (req.params as { cus: string }).cus;
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cus);
      if (!customer) return notFound(reply, `No such customer: ${cus}`);
      const t = await mintUsageWidgetToken({
        organizationId: req.organization!.id,
        businessId: business.id,
        customerId: customer.id,
        createdBy: req.operatorUserId ?? null,
      });
      return reply.code(201).send({
        object: "usage_widget_token",
        customer: customer.publicId,
        token: t.token,
        expires_at: t.expiresAt.toISOString(),
      });
    },
  );

  // ── Operator: allowed origins ──
  app.get(
    "/v1/businesses/:biz/settings/usage_widget",
    { preHandler: [authenticate, requirePerm("usage_controls:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      return settingsView(await getUsageWidgetOrigins(req.organization!.id, business.id));
    },
  );

  app.put(
    "/v1/businesses/:biz/settings/usage_widget",
    {
      preHandler: [authenticate, requirePerm("usage_controls:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(originsBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const origins: string[] = [];
      for (const [i, raw] of parsed.data.origins.entries()) {
        const n = normaliseWidgetOrigin(raw);
        if ("error" in n)
          return reply.code(400).send({
            error: {
              type: "invalid_request_error",
              message: `We could not save the origins. ${n.error}`,
              param: `origins.${i}`,
            },
          });
        origins.push(n.origin);
      }
      return settingsView(await setUsageWidgetOrigins(req.organization!.id, business.id, origins));
    },
  );

  // ── The widget (bearer `uwt_…`, cross-origin) ──
  app.get("/widget/v1/usage.js", async (_req, reply) => {
    // Public, static JS: any page may load it (SRI needs CORS on a cross-origin script).
    return reply
      .header("content-type", "application/javascript; charset=utf-8")
      .header("access-control-allow-origin", "*")
      .header("cache-control", "public, max-age=300")
      .send(USAGE_WIDGET_SCRIPT);
  });

  app.options("/widget/v1/usage", async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin || !(await isAnyWidgetOrigin(origin))) return reply.code(404).send();
    return reply
      .header("vary", "Origin")
      .header("access-control-allow-origin", origin)
      .header("access-control-allow-methods", "GET")
      .header("access-control-allow-headers", "authorization")
      .header("access-control-max-age", "600")
      .code(204)
      .send();
  });

  app.get("/widget/v1/usage", async (req: FastifyRequest, reply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return unauthorized(reply);
    const ctx = await resolveUsageWidgetToken(header.slice("Bearer ".length).trim());
    if (!ctx) return unauthorized(reply);
    const origin = req.headers.origin;
    // The global CORS hook already granted our own sites; this route answers to the business's list alone.
    reply.removeHeader("access-control-allow-origin");
    reply.removeHeader("access-control-expose-headers");
    if (origin !== undefined) {
      reply.header("vary", "Origin");
      // Only the token's business decides; any other origin gets no CORS grant.
      const allowed = await getUsageWidgetOrigins(ctx.organizationId, ctx.businessId);
      if (allowed.includes(origin)) reply.header("access-control-allow-origin", origin);
    }
    reply.header("cache-control", "no-store");
    return {
      ...(await usageWidgetView(ctx)),
      token_expires_at: ctx.expiresAt.toISOString(),
    };
  });
}

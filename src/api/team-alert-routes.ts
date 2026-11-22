import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import {
  legacyRecipientStates,
  legacyResend,
  NotificationError,
} from "@/modules/notifications/service";
import { parseRequest } from "./strict-params";
import { badRequest, requirePerm, resolveBusiness } from "./helpers";

const resendBody = z.object({ email: z.string().trim().toLowerCase().email().max(320) });

/** RFC 9745: the operation still answers, and is going away. */
const deprecated = (reply: FastifyReply) => reply.header("deprecation", "true");

/**
 * Deprecated team alert recipients (0495), answered from the business's email destinations
 * (0533 notifications). Same shapes and status codes as before; removed with the old API.
 */
export async function registerTeamAlertRoutes(app: FastifyInstance) {
  app.get(
    "/v1/businesses/:biz/team_alert_recipients",
    { preHandler: [authenticate, requirePerm("settings:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      deprecated(reply);
      const rows = await legacyRecipientStates(req.organization!.id, business.id);
      return {
        object: "list",
        data: rows.map((r) => ({
          object: "team_alert_recipient",
          email: r.email,
          state: r.state,
          last_sent_at: r.last_sent_at,
        })),
      };
    },
  );

  app.post(
    "/v1/businesses/:biz/team_alert_recipients/resend",
    {
      preHandler: [authenticate, requirePerm("settings:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      deprecated(reply);
      const parsed = parseRequest(resendBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        await legacyResend(req.organization!.id, business.id, parsed.data.email);
      } catch (e) {
        if (e instanceof NotificationError)
          return reply
            .code(e.code === "rate_limited" ? 429 : e.code === "not_found" ? 404 : 400)
            .send({
              error: {
                type: e.code === "rate_limited" ? "rate_limit_error" : "invalid_request_error",
                message: e.message,
              },
            });
        throw e;
      }
      return { object: "team_alert_recipient", email: parsed.data.email, state: "pending" };
    },
  );

  /**
   * Links in team alert confirmation emails sent before 0533. Notifications confirm at
   * `POST /auth/notification_destinations/confirm`; an old link can only be told so.
   */
  app.post("/auth/team_alerts/confirm", async (_req, reply) =>
    reply.code(410).send({
      error: {
        type: "invalid_request_error",
        code: "link_retired",
        message:
          "This link is no longer used. Ask an admin of the business to add your address again in Team notifications.",
      },
    }),
  );
}

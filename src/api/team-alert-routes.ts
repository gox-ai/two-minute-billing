import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { config } from "@/platform/config";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { AUTH_WINDOW_MS } from "@/platform/rate-limit";
import { resolveTeamAlertsConfig } from "@/modules/team-alerts/config";
import {
  confirmTeamAlertRecipient,
  listRecipientStates,
  resendConfirmation,
  TeamAlertRecipientError,
} from "@/modules/team-alerts/recipients";
import { parseRequest } from "./strict-params";
import { badRequest, refusedByRateLimit, requirePerm, resolveBusiness } from "./helpers";

const resendBody = z.object({ email: z.string().trim().toLowerCase().email().max(320) });
const confirmBody = z.object({ token: z.string().min(1).max(200) });

/** Team alert recipients (0495): who must still confirm, "Send again", and the public confirm. */
export async function registerTeamAlertRoutes(app: FastifyInstance) {
  app.get(
    "/v1/businesses/:biz/team_alert_recipients",
    { preHandler: [authenticate, requirePerm("settings:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const rows = await listRecipientStates(
        req.organization!.id,
        business.id,
        resolveTeamAlertsConfig(business).recipients,
      );
      return {
        object: "list",
        data: rows.map((r) => ({
          object: "team_alert_recipient",
          email: r.email,
          state: r.state,
          last_sent_at: r.lastSentAt,
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
      const parsed = parseRequest(resendBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        await resendConfirmation({
          organizationId: req.organization!.id,
          businessId: business.id,
          businessName: business.name,
          recipients: resolveTeamAlertsConfig(business).recipients,
          email: parsed.data.email,
        });
      } catch (e) {
        if (e instanceof TeamAlertRecipientError)
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
   * The link in the confirmation mail, posted by the public dashboard page. The answer says
   * only whether it worked: no business, no address.
   */
  app.post("/auth/team_alerts/confirm", async (req, reply) => {
    if (
      await refusedByRateLimit(req, reply, {
        scope: "team_alert_confirm",
        keys: [{ kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP }],
        windowMs: AUTH_WINDOW_MS,
      })
    )
      return;
    const parsed = parseRequest(confirmBody, req.body ?? {});
    if (!parsed.success) return badRequest(reply, "This link is not valid or is expired.");
    if (!(await confirmTeamAlertRecipient(parsed.data.token)))
      return reply.code(404).send({
        error: { type: "not_found", message: "This link is not valid or is expired." },
      });
    return { object: "team_alert_confirmation", confirmed: true };
  });
}

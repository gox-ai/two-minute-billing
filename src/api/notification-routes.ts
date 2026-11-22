import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "@/platform/config";
import { AUTH_WINDOW_MS, HOUR_WINDOW_MS } from "@/platform/rate-limit";
import type { AuthedUser } from "@/modules/auth/service";
import {
  confirmDestination,
  createDestination,
  deletePushSubscription,
  destinationCreateInput,
  destinationUpdateInput,
  dismissTeamAlertsNotice,
  getPreferences,
  getSettings,
  getSummary,
  isChatWebhookUrl,
  listDestinations,
  listNotifications,
  listPushSubscriptions,
  markAllRead,
  markRead,
  NotificationError,
  preferencesInput,
  pushSubscriptionInput,
  removeDestination,
  resendConfirmation,
  savePreferences,
  savePushSubscription,
  saveSettings,
  settingsInput,
  unreadCount,
  updateDestination,
} from "@/modules/notifications/service";
import {
  sendTestChat,
  sendTestPush,
  sendTestToDestination,
  type TestSendResult,
} from "@/modules/notifications/test-send";
import { parseRequest, acceptedAndIgnored } from "./strict-params";
import { badRequest, refusedByRateLimit } from "./helpers";
import { refusedByOrgTwoFactor, requireUser } from "./auth-routes";

/**
 * Operator notifications (0533): the member's own settings, devices and bell, and the
 * organization's destinations (owners and admins). Session only, like the rest of /auth/*.
 * No Idempotency-Key: every write sets a state or is a test send (see verify:idempotency-race).
 */

/** Test sends per member per hour: each one reaches a device or a Google Chat space. */
const TEST_SENDS_PER_HOUR = 20;

const STATUS: Record<NotificationError["code"], number> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  not_pending: 409,
  no_link: 409,
  rate_limited: 429,
};
const TYPE: Record<NotificationError["code"], string> = {
  invalid: "invalid_request_error",
  forbidden: "permission_error",
  not_found: "invalid_request_error",
  not_pending: "conflict_error",
  no_link: "conflict_error",
  rate_limited: "rate_limit_error",
};

function sendError(reply: FastifyReply, e: unknown) {
  if (!(e instanceof NotificationError)) throw e;
  return reply
    .code(STATUS[e.code])
    .send({ error: { type: TYPE[e.code], code: e.code, message: e.message } });
}

const notFound = (reply: FastifyReply, message: string) =>
  reply.code(404).send({ error: { type: "invalid_request_error", code: "not_found", message } });

/** A failed test send: the reason from the channel (Google Chat, the push service). */
function testResult(reply: FastifyReply, r: TestSendResult) {
  if (r.ok) return { object: "notification_test", sent: true };
  return reply
    .code(400)
    .send({ error: { type: "invalid_request_error", code: r.code, message: r.message } });
}

/** The signed-in member, or null after replying 401, or 403 when 2FA locks them out. */
async function member(req: FastifyRequest, reply: FastifyReply): Promise<AuthedUser | null> {
  const user = await requireUser(req, reply);
  if (!user) return null;
  if (await refusedByOrgTwoFactor(user, reply)) return null;
  return user;
}

const isManager = (u: AuthedUser) => u.role === "owner" || u.role === "admin";

/** Destinations are for owners and admins. Replies 403 and returns true for anyone else. */
function refusedNotManager(u: AuthedUser, reply: FastifyReply, verb: "see" | "change"): boolean {
  if (isManager(u)) return false;
  void reply.code(403).send({
    error: {
      type: "permission_error",
      code: "forbidden",
      message: `We could not ${verb === "see" ? "show" : "change"} team notifications. Only owners and admins can ${verb} them. Ask an owner or an admin of your organization.`,
    },
  });
  return true;
}

async function refusedTestRate(req: FastifyRequest, reply: FastifyReply, u: AuthedUser) {
  return refusedByRateLimit(
    req,
    reply,
    {
      scope: "notification_test",
      keys: [{ kind: "user", value: u.userId, limit: TEST_SENDS_PER_HOUR }],
      windowMs: HOUR_WINDOW_MS,
    },
    "We could not send the test. You sent too many tests in one hour. Try again later.",
  );
}

// The GET answer carries read-only keys; the dashboard may PUT the object back whole.
const preferencesBody = preferencesInput.extend({
  object: acceptedAndIgnored(),
  catalogue: acceptedAndIgnored(),
  set_up: acceptedAndIgnored(),
  notice_dismissed_at: acceptedAndIgnored(),
  team_alerts_notice: acceptedAndIgnored(),
  currencies: acceptedAndIgnored(),
  businesses: acceptedAndIgnored(),
});
const settingsBody = settingsInput.extend({
  object: acceptedAndIgnored(),
  set: acceptedAndIgnored(),
});

const listQuery = z.object({
  unread: z.enum(["1", "0", "true", "false"]).optional(),
  business: z.string().min(1).max(64).optional(),
  cursor: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const businessQuery = z.object({ business: z.string().min(1).max(64).optional() });
const readAllBody = z.object({ business: z.string().min(1).max(64).optional() });
const confirmBody = z.object({ token: z.string().min(1).max(200) });

const idParam = (req: FastifyRequest) => (req.params as { id: string }).id;

export async function registerNotificationRoutes(app: FastifyInstance) {
  // ── the member's own settings ──

  app.get("/auth/notifications/preferences", async (req, reply) => {
    const u = await member(req, reply);
    if (!u) return;
    return { object: "notification_preferences", ...(await getPreferences(u.organizationId, u)) };
  });

  /** The first save seeds the role's defaults for kinds not given. */
  app.put("/auth/notifications/preferences", async (req, reply) => {
    const u = await member(req, reply);
    if (!u) return;
    const parsed = parseRequest(preferencesBody, req.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    try {
      // The service's schema drops the read-only keys.
      return {
        object: "notification_preferences",
        ...(await savePreferences(u.organizationId, u, parsed.data)),
      };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  /** Hides the team-alerts notice without setting the member up. */
  app.post("/auth/notifications/notice/dismiss", async (req, reply) => {
    const u = await member(req, reply);
    if (!u) return;
    await dismissTeamAlertsNotice(u.organizationId, u);
    return { object: "notification_notice", dismissed: true };
  });

  app.get("/auth/notifications/settings", async (req, reply) => {
    const u = await member(req, reply);
    if (!u) return;
    return { object: "notification_settings", ...(await getSettings(u.organizationId, u.userId)) };
  });

  app.put("/auth/notifications/settings", async (req, reply) => {
    const u = await member(req, reply);
    if (!u) return;
    const parsed = parseRequest(settingsBody, req.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    try {
      return {
        object: "notification_settings",
        ...(await saveSettings(u.organizationId, u.userId, parsed.data)),
      };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── devices ──

  /** Null when this deployment has no VAPID key: the dashboard offers no push. */
  app.get("/auth/notifications/push/config", async (req, reply) => {
    const u = await member(req, reply);
    if (!u) return;
    return { object: "push_config", public_key: config.VAPID_PUBLIC_KEY ?? null };
  });

  app.get("/auth/notifications/push/subscriptions", async (req, reply) => {
    const u = await member(req, reply);
    if (!u) return;
    const data = await listPushSubscriptions(u.organizationId, u.userId);
    return { object: "list", data: data.map((d) => ({ object: "push_subscription", ...d })) };
  });

  /** Add this device, or take it over: the endpoint belongs to whoever subscribed last. */
  app.post("/auth/notifications/push/subscriptions", async (req, reply) => {
    const u = await member(req, reply);
    if (!u) return;
    const parsed = parseRequest(pushSubscriptionInput, req.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    try {
      const row = await savePushSubscription(u.userId, parsed.data);
      return reply.code(201).send({ object: "push_subscription", ...row });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.delete("/auth/notifications/push/subscriptions/:id", async (req, reply) => {
    const u = await member(req, reply);
    if (!u) return;
    const id = idParam(req);
    if (!(await deletePushSubscription(u.organizationId, u.userId, id)))
      return notFound(reply, "We could not find this device. It is possibly already removed.");
    return { object: "push_subscription", id, deleted: true };
  });

  app.post("/auth/notifications/push/subscriptions/:id/test", async (req, reply) => {
    const u = await member(req, reply);
    if (!u) return;
    if (await refusedTestRate(req, reply, u)) return;
    const result = await sendTestPush({
      organizationId: u.organizationId,
      userId: u.userId,
      subscriptionPublicId: idParam(req),
    });
    return testResult(reply, result);
  });

  // ── the bell ──

  app.get("/auth/notifications", async (req, reply) => {
    const u = await member(req, reply);
    if (!u) return;
    const parsed = parseRequest(listQuery, req.query ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    const q = parsed.data;
    try {
      const page = await listNotifications(u.organizationId, u.userId, {
        unread: q.unread === "1" || q.unread === "true",
        businessPublicId: q.business ?? null,
        cursor: q.cursor ?? null,
        limit: q.limit,
      });
      return {
        object: "list",
        data: page.data.map((n) => ({ object: "notification", ...n })),
        has_more: page.has_more,
        next_cursor: page.next_cursor,
      };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get("/auth/notifications/unread_count", async (req, reply) => {
    const u = await member(req, reply);
    if (!u) return;
    const parsed = parseRequest(businessQuery, req.query ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    try {
      const r = await unreadCount(u.organizationId, u.userId, {
        businessPublicId: parsed.data.business ?? null,
      });
      return { object: "notification_unread_count", ...r };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  /** Only the caller's own row: another member's id answers 404 like a missing one. */
  app.post("/auth/notifications/:id/read", async (req, reply) => {
    const u = await member(req, reply);
    if (!u) return;
    const id = idParam(req);
    if (!(await markRead(u.organizationId, u.userId, id)))
      return notFound(reply, "We could not find this notification.");
    return { object: "notification", id, read: true };
  });

  app.post("/auth/notifications/read_all", async (req, reply) => {
    const u = await member(req, reply);
    if (!u) return;
    const parsed = parseRequest(readAllBody, req.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    try {
      const n = await markAllRead(u.organizationId, u.userId, {
        businessPublicId: parsed.data.business ?? null,
      });
      return { object: "notification_read_all", marked: n };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get("/auth/notifications/summaries/:id", async (req, reply) => {
    const u = await member(req, reply);
    if (!u) return;
    try {
      return {
        object: "notification_summary",
        ...(await getSummary(u.organizationId, u.userId, idParam(req))),
      };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ── destinations (owners and admins) ──

  app.get("/auth/notification_destinations", async (req, reply) => {
    const u = await member(req, reply);
    if (!u) return;
    if (refusedNotManager(u, reply, "see")) return;
    try {
      const data = await listDestinations(u.organizationId, u);
      return {
        object: "list",
        data: data.map((d) => ({ object: "notification_destination", ...d })),
      };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  /**
   * `send_test: true` ("Send test and add"): a Google Chat space gets one test message first,
   * and the space is not added when the message fails. An email address ignores it: an
   * outside address gets the confirmation email instead.
   */
  app.post("/auth/notification_destinations", async (req, reply) => {
    const u = await member(req, reply);
    if (!u) return;
    if (refusedNotManager(u, reply, "change")) return;
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const { send_test: sendTest, ...rest } = typeof raw === "object" && raw ? raw : {};
    if (sendTest !== undefined && typeof sendTest !== "boolean")
      return badRequest(reply, "send_test: Enter true or false.");
    const parsed = parseRequest(destinationCreateInput, rest);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const input = parsed.data;
    if (sendTest && input.type === "chat") {
      if (!isChatWebhookUrl(input.url))
        return badRequest(
          reply,
          "Enter a Google Chat webhook URL. It starts with https://chat.googleapis.com/.",
        );
      if (await refusedTestRate(req, reply, u)) return;
      const r = await sendTestChat({
        organizationId: u.organizationId,
        url: input.url,
        name: input.name,
      });
      if (!r.ok) return testResult(reply, r);
    }
    try {
      const row = await createDestination(u.organizationId, u, input);
      return reply.code(201).send({ object: "notification_destination", ...row });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.patch("/auth/notification_destinations/:id", async (req, reply) => {
    const u = await member(req, reply);
    if (!u) return;
    if (refusedNotManager(u, reply, "change")) return;
    const parsed = parseRequest(destinationUpdateInput, req.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    try {
      const row = await updateDestination(u.organizationId, u, idParam(req), parsed.data);
      return { object: "notification_destination", ...row };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.delete("/auth/notification_destinations/:id", async (req, reply) => {
    const u = await member(req, reply);
    if (!u) return;
    if (refusedNotManager(u, reply, "change")) return;
    const id = idParam(req);
    try {
      await removeDestination(u.organizationId, u, id);
      return { object: "notification_destination", id, deleted: true };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post("/auth/notification_destinations/:id/test", async (req, reply) => {
    const u = await member(req, reply);
    if (!u) return;
    if (refusedNotManager(u, reply, "change")) return;
    if (await refusedTestRate(req, reply, u)) return;
    const result = await sendTestToDestination({
      organizationId: u.organizationId,
      destinationPublicId: idParam(req),
    });
    return testResult(reply, result);
  });

  /** "Send again" for an outside address that is not confirmed yet. */
  app.post("/auth/notification_destinations/:id/resend", async (req, reply) => {
    const u = await member(req, reply);
    if (!u) return;
    if (refusedNotManager(u, reply, "change")) return;
    const id = idParam(req);
    try {
      await resendConfirmation(u.organizationId, u, id);
      const row = (await listDestinations(u.organizationId, u)).find((d) => d.id === id);
      if (!row) return notFound(reply, `We could not find the destination ${id}.`);
      return { object: "notification_destination", ...row };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  /**
   * The link in the confirmation email, posted by the public dashboard page. The answer says
   * only whether it worked: no organization, no address.
   */
  app.post("/auth/notification_destinations/confirm", async (req, reply) => {
    if (
      await refusedByRateLimit(req, reply, {
        scope: "notification_destination_confirm",
        keys: [{ kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP }],
        windowMs: AUTH_WINDOW_MS,
      })
    )
      return;
    const parsed = parseRequest(confirmBody, req.body ?? {});
    if (!parsed.success) return badRequest(reply, "This link is not valid or is expired.");
    if (!(await confirmDestination(parsed.data.token)))
      return reply.code(404).send({
        error: { type: "not_found", message: "This link is not valid or is expired." },
      });
    return { object: "notification_destination_confirmation", confirmed: true };
  });
}

/**
 * The in-app assistant: a signed-in member's routes (`/auth/assistant/*`). The dashboard calls
 * them server-side with the member's session; the answer streams back as server-sent events.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { generateText } from "ai";
import { z } from "zod";
import { sessionTokenFromHeaders } from "@/platform/auth";
import { permissionsOf } from "@/modules/auth/service";
import { getBusinessById, getBusinessByPublicId } from "@/modules/tenancy/service";
import { buildModel, DEFAULT_MODELS, platformConfigured } from "@/modules/assistant/llm";
import { FORCEABLE_TOOLS, runTurn } from "@/modules/assistant/run";
import {
  ActionError,
  cancelAction,
  confirmAction,
  editAction,
} from "@/modules/assistant/actions";
import { callRoute } from "@/modules/assistant-tools/route-call";
import { TOOLS } from "@/modules/assistant-tools/catalog";
import { ImageUploadError, validateImageUpload } from "@/platform/image-upload";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  createAttachment,
  createConversation,
  decodeHistoryCursor,
  deleteAttachment,
  deleteConversation,
  getSharedConversation,
  HISTORY_PAGE_MAX,
  HistoryError,
  listHistory,
  serializeSharedMessage,
  unarchiveConversation,
  updateConversation,
  setFeedback,
  takeAttachments,
  getConversation,
  getSettings,
  listMessages,
  feedbackAlertFacts,
  memberLimitReached,
  memberName,
  capReached,
  monthUsage,
  serializeConversation,
  serializeMessage,
  updateSettings,
} from "@/modules/assistant/service";
import { refusedByOrgTwoFactor, requireMemberPermission } from "./auth-routes";
import { parseRequest } from "./strict-params";
import { badRequest } from "./helpers";
import { createLogger } from "@/platform/logger";
import { isCloud } from "@/platform/edition";
import { formatMoney } from "@/platform/currency";
import { notifyFeedbackDown } from "@/modules/assistant/support-notify";
import {
  BODY_MAX,
  MAX_ATTACHMENTS,
  SUBJECT_MAX,
  SupportError,
  createSupportRequest,
  getMemberRequest,
  listMemberRequests,
  markMemberRead,
  memberUnread,
  replyAsMember,
  serializeForMember,
  supportOffered,
} from "@/modules/assistant/support";

const log = createLogger("assistant.routes");

const bad = (reply: FastifyReply, message: string, status = 400) =>
  reply.code(status).send({ error: { type: "invalid_request_error", message } });

const messageBody = z.object({
  business: z.string().min(1).max(100),
  conversation: z.string().min(1).max(100).optional(),
  content: z.string().trim().min(1).max(4000),
  page: z
    .object({
      path: z.string().max(300),
      record: z
        .object({ type: z.string().max(40), id: z.string().max(100) })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  /** A task from the composer's menu: the turn starts with this tool. */
  tool: z.enum(FORCEABLE_TOOLS).optional(),
  mentions: z
    .array(
      z.object({
        type: z.enum(["customer", "invoice", "subscription", "credit_note", "payment"]),
        id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
      }),
    )
    .max(5)
    .optional(),
  attachments: z.array(z.string().max(100)).max(4).optional(),
});

const historyQuery = z.object({
  business: z.string().min(1).max(100).optional(),
  q: z.string().max(200).optional(),
  archived: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(HISTORY_PAGE_MAX).optional(),
  starting_after: z.string().max(300).optional(),
});

const conversationPatch = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  archived: z.boolean().optional(),
  pinned: z.boolean().optional(),
  shared: z.boolean().optional(),
});

const sharedQuery = z.object({ business: z.string().min(1).max(100).optional() });

const feedbackBody = z.object({
  rating: z.enum(["up", "down"]).nullable(),
  comment: z.string().max(1000).nullable().optional(),
});

const attachmentBody = z.object({
  business: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  content_type: z.string().max(100).optional(),
  // Base64 is 4 characters for every 3 bytes; the decoded size is checked again below.
  data_base64: z
    .string()
    .min(1)
    .max(Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4),
});

const confirmBody = z.object({ confirm_money: z.boolean().optional() });

const attachmentIds = z.array(z.string().max(100)).max(MAX_ATTACHMENTS).default([]);
const supportCreateBody = z.object({
  business: z.string().min(1).max(100),
  conversation: z.string().min(1).max(100),
  draft: z.string().min(1).max(100),
  subject: z.string().max(SUBJECT_MAX),
  description: z.string().max(BODY_MAX),
  /** Keys of attached items the member removed from the card. */
  remove: z.array(z.string().max(120)).max(30).default([]),
  attachments: attachmentIds,
});
const supportReplyBody = z.object({ body: z.string().max(BODY_MAX), attachments: attachmentIds });

/** Cloud only: on a self-hosted install the support routes do not exist. */
const notOffered = (reply: FastifyReply) =>
  reply.code(404).send({ error: { type: "invalid_request_error", message: "Not found." } });
/** Before Confirm: the note of a new email, and the plain fields the card offers. */
const editBody = z
  .object({
    note: z.string().max(2000).optional(),
    fields: z
      .record(
        z.string().max(100),
        z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]),
      )
      .refine((f) => Object.keys(f).length <= 20, "Change at most 20 fields at a time.")
      .optional(),
  })
  .refine((b) => b.note !== undefined || Object.keys(b.fields ?? {}).length > 0, {
    message: "Change at least one field.",
  });

const settingsBody = z.object({
  enabled: z.boolean().optional(),
  own_key: z
    .object({
      provider: z.enum(["openai", "anthropic", "google"]),
      model: z.string().max(100).nullable().optional(),
      api_key: z.string().min(8).max(500),
    })
    .nullable()
    .optional(),
  actions_enabled: z.boolean().optional(),
  money_actions_enabled: z.boolean().optional(),
});

/** SSE comment lines keep proxies from closing a quiet stream; the panel ignores them. */
const PING_MS = 15_000;

/** Skipped in tests: a real call to the provider. */
let testKey = async (
  provider: "openai" | "anthropic" | "google",
  model: string,
  apiKey: string,
) => {
  await generateText({
    model: buildModel(provider, model, apiKey),
    prompt: "Reply with OK.",
    maxOutputTokens: 16,
  });
};
export function setKeyTesterForTests(f: typeof testKey): void {
  testKey = f;
}

export async function registerAssistantRoutes(app: FastifyInstance) {
  app.get(
    "/auth/assistant/status",
    { preHandler: requireMemberPermission("assistant:view") },
    async (req) => {
      const orgId = req.member!.organizationId;
      const s = await getSettings(orgId);
      const usage = await monthUsage(orgId);
      return {
        object: "assistant_status",
        enabled: s.enabled,
        available: s.enabled && (platformConfigured() || !!s.own_key),
        cap_reached: !s.own_key && capReached(usage),
        // The included-use bar under the composer: every member who can use the assistant.
        allowance:
          !s.own_key && usage.allowance
            ? { used_percent: usage.allowance.used_percent, renews_at: usage.allowance.renews_at }
            : null,
        // Cloud: support requests, and how many have a reply the member has not read.
        support: supportOffered()
          ? { unread: await memberUnread(orgId, req.member!.userId) }
          : null,
      };
    },
  );

  app.get(
    "/auth/assistant/conversations",
    { preHandler: requireMemberPermission("assistant:view") },
    async (req, reply) => {
      const m = req.member!;
      const parsed = parseRequest(historyQuery, req.query ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const q = parsed.data;
      const biz = q.business ? await getBusinessByPublicId(m.organizationId, q.business) : null;
      if (q.business && !biz) return bad(reply, "We could not find that business.", 404);
      const cursor = q.starting_after ? decodeHistoryCursor(q.starting_after) : null;
      if (q.starting_after && !cursor)
        return bad(
          reply,
          "We could not read starting_after. Send the next_cursor of the previous page.",
        );
      const page = await listHistory({
        organizationId: m.organizationId,
        userId: m.userId,
        businessId: biz?.id ?? null,
        archived: q.archived === "true",
        q: q.q ?? null,
        limit: q.limit ?? 30,
        cursor,
      });
      return {
        object: "list",
        data: page.items.map((i) => serializeConversation(i.row, i.business, i.snippet)),
        has_more: page.nextCursor !== null,
        next_cursor: page.nextCursor,
      };
    },
  );

  app.get(
    "/auth/assistant/conversations/:id",
    { preHandler: requireMemberPermission("assistant:view") },
    async (req, reply) => {
      const m = req.member!;
      const c = await getConversation(
        m.organizationId,
        m.userId,
        (req.params as { id: string }).id,
      );
      if (!c) return bad(reply, "We could not find this conversation.", 404);
      const [messages, biz] = await Promise.all([
        listMessages(m.organizationId, c.id),
        getBusinessById(m.organizationId, c.businessId),
      ]);
      return {
        ...serializeConversation(c, biz?.publicId),
        object: "assistant_conversation",
        messages: messages.map(serializeMessage),
      };
    },
  );

  // The owner renames, archives, pins or shares their own conversation.
  app.patch(
    "/auth/assistant/conversations/:id",
    { preHandler: requireMemberPermission("assistant:use") },
    async (req, reply) => {
      const m = req.member!;
      const parsed = parseRequest(conversationPatch, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const hit = await updateConversation(
          m.organizationId,
          m.userId,
          (req.params as { id: string }).id,
          parsed.data,
        );
        if (!hit) return bad(reply, "We could not find this conversation.", 404);
        return {
          ...serializeConversation(hit.row, hit.business),
          object: "assistant_conversation",
        };
      } catch (e) {
        if (e instanceof HistoryError) return bad(reply, e.message, e.status);
        throw e;
      }
    },
  );

  // A conversation another member shared: read-only, for members who can see its business.
  app.get(
    "/auth/assistant/shared/:id",
    { preHandler: requireMemberPermission("assistant:view") },
    async (req, reply) => {
      const m = req.member!;
      const parsed = parseRequest(sharedQuery, req.query ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const hit = await getSharedConversation(m.organizationId, (req.params as { id: string }).id);
      if (!hit || (parsed.data.business && parsed.data.business !== hit.business))
        return bad(reply, "We could not find this conversation.", 404);
      const perms = permissionsOf(m);
      const readerMaySee = (tool: string) =>
        TOOLS.find((t) => t.name === tool)?.perms.every((k) => perms.has(k)) ?? false;
      const messages = await listMessages(m.organizationId, hit.row.id);
      return {
        object: "assistant_shared_conversation",
        id: hit.row.publicId,
        title: hit.row.title,
        business: hit.business,
        owner: { name: hit.ownerName ?? null },
        shared_at: hit.row.sharedAt,
        messages: messages.map((x) => serializeSharedMessage(x, readerMaySee)),
      };
    },
  );

  app.delete(
    "/auth/assistant/conversations/:id",
    { preHandler: requireMemberPermission("assistant:use") },
    async (req, reply) => {
      const m = req.member!;
      const c = await getConversation(
        m.organizationId,
        m.userId,
        (req.params as { id: string }).id,
      );
      if (!c) return bad(reply, "We could not find this conversation.", 404);
      await deleteConversation(m.organizationId, c.id);
      return { object: "assistant_conversation", id: c.publicId, deleted: true };
    },
  );

  app.post(
    "/auth/assistant/messages",
    { preHandler: requireMemberPermission("assistant:use") },
    async (req, reply) => {
      const m = req.member!;
      if (await refusedByOrgTwoFactor(m, reply)) return;
      const parsed = parseRequest(messageBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const body = parsed.data;
      const biz = await getBusinessByPublicId(m.organizationId, body.business);
      if (!biz || biz.status !== "active")
        return bad(reply, "We could not find that business.", 404);
      const limited = await memberLimitReached(m.organizationId, m.userId);
      if (limited) {
        return reply
          .code(429)
          .header("retry-after", String(limited.retryAfterSeconds))
          .send({ error: { type: "rate_limit_error", message: limited.message } });
      }
      let conversation = body.conversation
        ? await getConversation(m.organizationId, m.userId, body.conversation)
        : null;
      if (body.conversation && (!conversation || conversation.businessId !== biz.id)) {
        return bad(reply, "We could not find this conversation.", 404);
      }
      // A new message brings an archived conversation back to the list.
      if (conversation?.archivedAt)
        conversation = await unarchiveConversation(m.organizationId, conversation.id);
      conversation ??= await createConversation({
        organizationId: m.organizationId,
        businessId: biz.id,
        userId: m.userId,
        title: body.content.split("\n")[0]!,
      });
      const token = sessionTokenFromHeaders(req.headers as Record<string, unknown>);
      const attachments = await takeAttachments({
        organizationId: m.organizationId,
        businessId: biz.id,
        userId: m.userId,
        conversationId: conversation.id,
        ids: body.attachments ?? [],
      });
      if (attachments.length !== (body.attachments?.length ?? 0))
        return bad(reply, "We could not find an attached screenshot. Attach it again.", 404);

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      const abort = new AbortController();
      let finished = false;
      req.raw.on("close", () => {
        if (!finished) abort.abort();
      });
      const ping = setInterval(() => {
        if (!res.writableEnded) res.write(": ping\n\n");
      }, PING_MS);
      send({
        type: "conversation",
        conversation: serializeConversation(conversation, biz.publicId),
      });
      try {
        for await (const event of runTurn({
          app,
          organizationId: m.organizationId,
          member: {
            userId: m.userId,
            name: await memberName(m.userId),
            permissions: permissionsOf(m),
          },
          business: {
            id: biz.publicId,
            name: biz.name,
            livemode: biz.livemode as "test" | "live",
            currency: biz.defaultCurrency,
            timezone: biz.timezone ?? null,
          },
          conversation,
          content: body.content,
          page: body.page ?? null,
          businessRowId: biz.id,
          forceTool: body.tool,
          mentions: body.mentions,
          attachments: attachments.map((a) => ({
            publicId: a.publicId,
            name: a.name,
            contentType: a.contentType,
            size: a.size,
            data: a.data,
          })),
          cookie: `tmb_session=${token ?? ""}`,
          userAgent:
            typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
          signal: abort.signal,
        })) {
          send(event);
        }
      } catch (e) {
        log.error(e, { event: "assistant_stream_failed" });
        send({
          type: "error",
          code: "failed",
          message: "We could not get an answer. Try again in a minute.",
        });
      } finally {
        clearInterval(ping);
        finished = true;
        res.end();
      }
    },
  );

  app.put(
    "/auth/assistant/messages/:id/feedback",
    { preHandler: requireMemberPermission("assistant:use") },
    async (req, reply) => {
      const m = req.member!;
      const parsed = parseRequest(feedbackBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const ok = await setFeedback(
        m.organizationId,
        m.userId,
        (req.params as { id: string }).id,
        parsed.data.rating,
        parsed.data.comment ?? null,
      );
      if (!ok) return bad(reply, "We could not find this answer.", 404);
      // Cloud: our team hears about a thumbs-down at once. Never blocks the member.
      if (isCloud() && parsed.data.rating === "down") {
        const id = (req.params as { id: string }).id;
        void feedbackAlertFacts(m.organizationId, id)
          .then((f) =>
            f ? notifyFeedbackDown({ ...f, comment: parsed.data.comment ?? null }) : "skipped",
          )
          .catch((e) => log.error(e, { event: "assistant_feedback_alert_failed" }));
      }
      return { object: "assistant_feedback", rating: parsed.data.rating };
    },
  );

  // Records to mention with @: the member's own search, through the list routes as them.
  app.get(
    "/auth/assistant/mentions",
    { preHandler: requireMemberPermission("assistant:view") },
    async (req, reply) => {
      const m = req.member!;
      const q = req.query as { business?: string; q?: string };
      const biz = q.business ? await getBusinessByPublicId(m.organizationId, q.business) : null;
      if (!biz) return bad(reply, "We could not find that business.", 404);
      const text = (q.q ?? "").trim().slice(0, 100);
      if (!text) return { object: "list", data: [] };
      const token = sessionTokenFromHeaders(req.headers as Record<string, unknown>);
      const caller = { cookie: `tmb_session=${token ?? ""}`, "user-agent": "tmbilling-assistant" };
      const list = async (
        kind: "customers" | "invoices" | "subscriptions" | "credit_notes" | "transactions",
      ) => {
        const r = await callRoute(app, caller, {
          method: "GET",
          path: `/v1/businesses/${encodeURIComponent(biz.publicId)}/${kind}`,
          query: { q: text, limit: 5 },
        });
        return r.status === 200
          ? (((r.body as { data?: unknown[] })?.data ?? []) as Record<string, unknown>[])
          : [];
      };
      const [customers, invoices, subscriptions, creditNotes, payments] = await Promise.all([
        list("customers"),
        list("invoices"),
        list("subscriptions"),
        list("credit_notes"),
        list("transactions"),
      ]);
      const str = (v: unknown) => (typeof v === "string" && v ? v : null);
      // "Pro +2 · Maren Holt": the plan and who pays, so two subscriptions read apart.
      const subscriptionLabel = (x: Record<string, unknown>) => {
        const items = Array.isArray(x.items) ? (x.items as Array<{ product_name?: unknown }>) : [];
        const plan = str(items[0]?.product_name);
        const who = str(x.customer_name) ?? str(x.customer_email);
        const head = plan ? `${plan}${items.length > 1 ? ` +${items.length - 1}` : ""}` : null;
        return [head, who].filter(Boolean).join(" · ") || null;
      };
      const amount = (t: Record<string, unknown>) =>
        typeof t.amount_minor === "number" && typeof t.currency === "string"
          ? formatMoney(t.amount_minor, t.currency)
          : null;
      const data = [
        ...customers.map((c) => ({
          type: "customer" as const,
          id: String(c.id),
          label: str(c.name) ?? str(c.company) ?? str(c.email) ?? String(c.id),
          detail: str(c.email),
        })),
        ...invoices.map((i) => ({
          type: "invoice" as const,
          id: String(i.id),
          label: str(i.number) ?? String(i.id),
          detail: str(i.status),
        })),
        ...subscriptions.map((x) => {
          const label = subscriptionLabel(x);
          return {
            type: "subscription" as const,
            id: String(x.id),
            label: label ?? String(x.id),
            detail: label ? String(x.id) : str(x.status),
          };
        }),
        ...creditNotes.map((c) => ({
          type: "credit_note" as const,
          id: String(c.id),
          label: str(c.number) ?? String(c.id),
          detail: str(c.status),
        })),
        ...payments.map((t) => ({
          type: "payment" as const,
          id: String(t.id),
          label: [str(t.type), amount(t)].filter(Boolean).join(" ") || String(t.id),
          detail: str(t.customer_name) ?? str(t.customer_email) ?? str(t.status),
        })),
      ];
      return { object: "list", data };
    },
  );

  // Screenshots only, checked by their bytes; kept with the conversation (≤ 90 days).
  app.post(
    "/auth/assistant/attachments",
    {
      preHandler: requireMemberPermission("assistant:use"),
      // 10 MB of image is about 13.4 MB of base64.
      bodyLimit: 15 * 1024 * 1024,
    },
    async (req, reply) => {
      const m = req.member!;
      if (await refusedByOrgTwoFactor(m, reply)) return;
      const parsed = parseRequest(attachmentBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const biz = await getBusinessByPublicId(m.organizationId, parsed.data.business);
      if (!biz || biz.status !== "active")
        return bad(reply, "We could not find that business.", 404);
      const data = Buffer.from(parsed.data.data_base64, "base64");
      let contentType: (typeof ATTACHMENT_TYPES)[number];
      try {
        contentType = validateImageUpload(data, {
          maxBytes: ATTACHMENT_MAX_BYTES,
          label: "screenshot",
          allow: [...ATTACHMENT_TYPES],
        }).contentType as (typeof ATTACHMENT_TYPES)[number];
      } catch (e) {
        if (e instanceof ImageUploadError) return bad(reply, e.message);
        throw e;
      }
      const row = await createAttachment({
        organizationId: m.organizationId,
        businessId: biz.id,
        userId: m.userId,
        name: parsed.data.name,
        contentType,
        data,
      });
      return { object: "assistant_attachment", ...row };
    },
  );

  app.delete(
    "/auth/assistant/attachments/:id",
    { preHandler: requireMemberPermission("assistant:use") },
    async (req, reply) => {
      const m = req.member!;
      const id = (req.params as { id: string }).id;
      if (!(await deleteAttachment(m.organizationId, m.userId, id)))
        return bad(reply, "We could not find this screenshot.", 404);
      return { object: "assistant_attachment", id, deleted: true };
    },
  );

  // A change Billy prepared: the member confirms it (it runs as them) or cancels it.
  app.post(
    "/auth/assistant/actions/:id/confirm",
    { preHandler: requireMemberPermission("assistant:use") },
    async (req, reply) => {
      const m = req.member!;
      if (await refusedByOrgTwoFactor(m, reply)) return;
      const parsed = parseRequest(confirmBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const token = sessionTokenFromHeaders(req.headers as Record<string, unknown>);
      try {
        const view = await confirmAction({
          app,
          organizationId: m.organizationId,
          userId: m.userId,
          id: (req.params as { id: string }).id,
          confirmMoney: parsed.data.confirm_money === true,
          settings: await getSettings(m.organizationId),
          caller: { cookie: `tmb_session=${token ?? ""}`, "user-agent": "tmbilling-assistant" },
        });
        return { object: "assistant_action", ...view };
      } catch (e) {
        if (e instanceof ActionError) return bad(reply, e.message, e.status);
        throw e;
      }
    },
  );

  // Before Confirm: the member corrects the fields of a change Billy prepared. The edited
  // card is checked and previewed again as the member, the same way as a new one.
  app.post(
    "/auth/assistant/actions/:id/edit",
    { preHandler: requireMemberPermission("assistant:use") },
    async (req, reply) => {
      const m = req.member!;
      const parsed = parseRequest(editBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const token = sessionTokenFromHeaders(req.headers as Record<string, unknown>);
      const caller = { cookie: `tmb_session=${token ?? ""}`, "user-agent": "tmbilling-assistant" };
      try {
        const view = await editAction({
          organizationId: m.organizationId,
          userId: m.userId,
          id: (req.params as { id: string }).id,
          fields: parsed.data.fields,
          note: parsed.data.note,
          moneyEnabled: (await getSettings(m.organizationId)).money_actions_enabled,
          routes: (biz) => {
            const base = `/v1/businesses/${encodeURIComponent(biz)}`;
            return {
              get: (rel) => callRoute(app, caller, { method: "GET", path: `${base}/${rel}` }),
              post: (rel, body) =>
                callRoute(app, caller, { method: "POST", path: `${base}/${rel}`, body }),
            };
          },
        });
        return { object: "assistant_action", ...view };
      } catch (e) {
        if (e instanceof ActionError) return bad(reply, e.message, e.status);
        throw e;
      }
    },
  );

  app.post(
    "/auth/assistant/actions/:id/cancel",
    { preHandler: requireMemberPermission("assistant:use") },
    async (req, reply) => {
      const m = req.member!;
      try {
        const view = await cancelAction(
          m.organizationId,
          m.userId,
          (req.params as { id: string }).id,
        );
        return { object: "assistant_action", ...view };
      } catch (e) {
        if (e instanceof ActionError) return bad(reply, e.message, e.status);
        throw e;
      }
    },
  );

  // ── Support requests (Cloud): drafted by the assistant, sent by the member ─────────
  app.post(
    "/auth/assistant/support/requests",
    { preHandler: requireMemberPermission("assistant:use") },
    async (req, reply) => {
      if (!supportOffered()) return notOffered(reply);
      const m = req.member!;
      if (await refusedByOrgTwoFactor(m, reply)) return;
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || !/^[\x21-\x7e]{8,255}$/.test(key))
        return bad(reply, "Send an Idempotency-Key header (8 to 255 characters).");
      const parsed = parseRequest(supportCreateBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const body = parsed.data;
      const biz = await getBusinessByPublicId(m.organizationId, body.business);
      if (!biz) return bad(reply, "We could not find that business.", 404);
      const conversation = await getConversation(m.organizationId, m.userId, body.conversation);
      if (!conversation || conversation.businessId !== biz.id)
        return bad(reply, "We could not find this conversation.", 404);
      try {
        const { request, replayed } = await createSupportRequest({
          organizationId: m.organizationId,
          userId: m.userId,
          businessId: biz.id,
          conversationId: conversation.id,
          draftId: body.draft,
          subject: body.subject,
          description: body.description,
          remove: body.remove,
          attachments: body.attachments,
          idempotencyKey: key,
        });
        return reply.code(replayed ? 200 : 201).send(serializeForMember(request, biz.publicId));
      } catch (e) {
        if (e instanceof SupportError) return bad(reply, e.message, e.status);
        throw e;
      }
    },
  );

  app.get(
    "/auth/assistant/support/requests",
    { preHandler: requireMemberPermission("assistant:view") },
    async (req, reply) => {
      if (!supportOffered()) return notOffered(reply);
      const m = req.member!;
      const rows = await listMemberRequests(m.organizationId, m.userId);
      return {
        object: "list",
        data: rows.map((x) => serializeForMember(x.r, x.business)),
        unread: rows.filter((x) => x.r.memberUnreadAt).length,
      };
    },
  );

  app.get(
    "/auth/assistant/support/requests/:id",
    { preHandler: requireMemberPermission("assistant:view") },
    async (req, reply) => {
      if (!supportOffered()) return notOffered(reply);
      const m = req.member!;
      const r = await getMemberRequest(
        m.organizationId,
        m.userId,
        (req.params as { id: string }).id,
      );
      if (!r) return bad(reply, "We could not find this request.", 404);
      return serializeForMember(r.r, r.business, r.messages);
    },
  );

  app.post(
    "/auth/assistant/support/requests/:id/messages",
    { preHandler: requireMemberPermission("assistant:use") },
    async (req, reply) => {
      if (!supportOffered()) return notOffered(reply);
      const m = req.member!;
      if (await refusedByOrgTwoFactor(m, reply)) return;
      const parsed = parseRequest(supportReplyBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const id = (req.params as { id: string }).id;
      try {
        await replyAsMember({
          organizationId: m.organizationId,
          userId: m.userId,
          id,
          body: parsed.data.body,
          attachments: parsed.data.attachments,
        });
      } catch (e) {
        if (e instanceof SupportError) return bad(reply, e.message, e.status);
        throw e;
      }
      const r = await getMemberRequest(m.organizationId, m.userId, id);
      return serializeForMember(r!.r, r!.business, r!.messages);
    },
  );

  app.post(
    "/auth/assistant/support/requests/:id/read",
    { preHandler: requireMemberPermission("assistant:use") },
    async (req, reply) => {
      if (!supportOffered()) return notOffered(reply);
      const m = req.member!;
      const id = (req.params as { id: string }).id;
      if (!(await markMemberRead(m.organizationId, m.userId, id)))
        return bad(reply, "We could not find this request.", 404);
      return { object: "support_request", id, unread: false };
    },
  );

  app.get(
    "/auth/assistant/settings",
    { preHandler: requireMemberPermission("settings:view") },
    async (req) => {
      const orgId = req.member!.organizationId;
      return {
        object: "assistant_settings",
        ...(await getSettings(orgId)),
        default_models: DEFAULT_MODELS,
        usage: await monthUsage(orgId),
      };
    },
  );

  app.put(
    "/auth/assistant/settings",
    { preHandler: requireMemberPermission("settings:manage") },
    async (req, reply) => {
      const m = req.member!;
      if (await refusedByOrgTwoFactor(m, reply)) return;
      const parsed = parseRequest(settingsBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const key = parsed.data.own_key;
      if (key) {
        try {
          await testKey(
            key.provider,
            key.model?.trim() || DEFAULT_MODELS[key.provider],
            key.api_key,
          );
        } catch (e) {
          const reason =
            e instanceof Error ? e.message.slice(0, 200) : "The provider refused the request.";
          return bad(
            reply,
            `We could not use this key. ${reason} Check the key and the model name.`,
          );
        }
      }
      const view = await updateSettings(m.organizationId, parsed.data);
      return {
        object: "assistant_settings",
        ...view,
        default_models: DEFAULT_MODELS,
        usage: await monthUsage(m.organizationId),
      };
    },
  );
}

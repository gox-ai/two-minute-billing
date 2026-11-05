import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import {
  COMMENT_RESOURCE_TYPES,
  COMMENT_FILTER_KINDS,
  COMMENT_FILTER_OPS,
  COMMENT_SORT_FIELDS,
  CommentResourceNotFoundError,
  createComment,
  deleteComment,
  getComment,
  listComments,
  listCommentsPage,
  serializeComment,
  updateComment,
  CommentError,
} from "@/modules/comments/service";
import {
  resolveBusiness,
  badRequest,
  notFound,
  requirePerm,
  parseListQuery,
  listResponse,
} from "./helpers";
import { parseRequest } from "./strict-params";

/**
 * Comments — the per-record notes box (invoices, credit notes, customers, subscriptions,
 * products and prices all share it, so these routes are polymorphic rather than
 * nested under each resource).
 *
 * POST checks that `resource_id` names a record that exists in this business and 404s if
 * it does not: the table carries no FK (the target varies by type), so without the lookup
 * `resource_id` is free text that accepts a typo and buries the note.
 *
 * The per-record list (`resource_type` + `resource_id`, nothing else) is unpaged: a record
 * holds a handful of notes. Omitting both, or passing `limit`/`starting_after`/`sort_by`/
 * `created_at[op]`, takes the paged path (GUIDE.md §3.4) — business-wide when unscoped.
 */
export async function registerCommentRoutes(app: FastifyInstance) {
  const resourceQuery = z.object({
    resource_type: z.enum(COMMENT_RESOURCE_TYPES),
    resource_id: z.string().min(1).max(100),
  });

  app.get(
    "/v1/businesses/:biz/comments",
    { preHandler: [authenticate, requirePerm("comments:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = (req.query ?? {}) as Record<string, string | undefined>;
      const paged =
        (q.resource_type == null && q.resource_id == null) ||
        Object.keys(q).some(
          (k) =>
            k === "limit" ||
            k === "starting_after" ||
            k.startsWith("sort_by[") ||
            k.startsWith("created_at["),
        );
      if (paged) {
        // The rest of the query is the list grammar, checked by parseListQuery below.
        const scope = resourceQuery.partial().safeParse(q);
        if (!scope.success) return badRequest(reply, scope.error);
        const lq = parseListQuery(req, reply, {
          filterOps: COMMENT_FILTER_OPS,
          filterKinds: COMMENT_FILTER_KINDS,
          sortFields: COMMENT_SORT_FIELDS,
          bareParams: ["resource_type", "resource_id"],
        });
        if (!lq) return;
        const page = await listCommentsPage(req.organization!.id, business.id, {
          resourceType: scope.data.resource_type,
          resourceId: scope.data.resource_id,
          filters: lq.filters,
          sortDesc: lq.sortDesc,
          startingAfter: lq.startingAfter,
          limit: lq.limit,
        });
        return listResponse(page, serializeComment);
      }
      const parsed = parseRequest(resourceQuery, q);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const rows = await listComments(
        req.organization!.id,
        business.id,
        parsed.data.resource_type,
        parsed.data.resource_id,
      );
      return {
        object: "list",
        data: rows.map(serializeComment),
        has_more: false,
        next_cursor: null,
        total: rows.length,
      };
    },
  );

  app.get(
    "/v1/businesses/:biz/comments/:id",
    { preHandler: [authenticate, requirePerm("comments:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      const row = await getComment(req.organization!.id, business.id, id);
      if (!row) return notFound(reply, `No such comment: ${id}`);
      return serializeComment(row);
    },
  );

  const createBody = resourceQuery.extend({ body: z.string().min(1).max(5000) });
  app.post(
    "/v1/businesses/:biz/comments",
    {
      preHandler: [authenticate, requirePerm("comments:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(createBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const row = await createComment({
          organizationId: req.organization!.id,
          businessId: business.id,
          resourceType: parsed.data.resource_type,
          resourceId: parsed.data.resource_id,
          body: parsed.data.body,
        });
        return reply.code(201).send(serializeComment(row));
      } catch (e) {
        // Ordered subclass-first: a named resource that does not exist in this business
        // is a 404 about that resource, not a malformed body.
        if (e instanceof CommentResourceNotFoundError) return notFound(reply, e.message);
        if (e instanceof CommentError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.patch(
    "/v1/businesses/:biz/comments/:id",
    {
      preHandler: [authenticate, requirePerm("comments:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(z.object({ body: z.string().min(1).max(5000) }), req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { id } = req.params as { id: string };
      try {
        const row = await updateComment(req.organization!.id, business.id, id, parsed.data.body);
        if (!row) return notFound(reply, `No such comment: ${id}`);
        return serializeComment(row);
      } catch (e) {
        if (e instanceof CommentError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.delete(
    "/v1/businesses/:biz/comments/:id",
    {
      preHandler: [authenticate, requirePerm("comments:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      const ok = await deleteComment(req.organization!.id, business.id, id);
      if (!ok) return notFound(reply, `No such comment: ${id}`);
      return reply.code(204).send();
    },
  );
}

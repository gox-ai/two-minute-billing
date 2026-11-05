import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { getBusinessByPublicId } from "@/modules/tenancy/service";
import {
  createListView,
  deleteListView,
  duplicateListView,
  listListViews,
  resolveOwner,
  serializeListView,
  updateListView,
  ListViewError,
  ListViewNameTakenError,
  MAX_FILTERS_PER_VIEW,
} from "@/modules/list-views/service";
import { LIST_VIEW_ENTITIES, LIST_VIEW_VISIBILITY } from "@/modules/list-views/entities";
import { badRequest, conflict, notFound, requirePerm } from "./helpers";

/**
 * Saved list views.
 *
 * ORG-LEVEL routes with an OPTIONAL `business`, not the usual
 * `/v1/businesses/:biz/…` nesting: two of the product's lists are org-wide (the
 * `/audit` activity log; the billing clock, which crosses tenants), so a
 * business-scoped route family could not express their views at all. One family
 * covers both — `business` absent means an org-level list, and the service stores
 * NULL rather than guessing.
 *
 * NO `requirePerm` gate, deliberately. A view holds a filter definition, never data,
 * and every role that can open a list can already see everything a view would narrow.
 * Gating it on `ops` would stop a read-only analyst from saving their own segment,
 * which is the one thing they most need. Sharing (`visibility: 'everyone'`) is
 * ungated for the same reason: it publishes a query, not rows.
 */
export async function registerListViewRoutes(app: FastifyInstance) {
  /**
   * Resolve the optional `business` scope. Returns `undefined` on failure (after
   * replying 404), and `null` for "org-level list" — the two are different answers and
   * collapsing them would file an org-level view against a business that doesn't exist.
   */
  async function scope(
    req: FastifyRequest,
    reply: FastifyReply,
    biz: string | undefined,
  ): Promise<string | null | undefined> {
    if (!biz) return null;
    const business = await getBusinessByPublicId(req.organization!.id, biz);
    if (!business) {
      await reply
        .code(404)
        .send({ error: { type: "invalid_request_error", message: `No such business: ${biz}` } });
      return undefined;
    }
    return business.id;
  }

  const filterSchema = z.object({
    field: z.string().min(1).max(80),
    op: z.string().min(1).max(20),
    // Empty IS legal: `is_present` and the unary shapes carry 'true'/'false', and a
    // half-typed filter is dropped by the caller, not stored blank — but a set value
    // like `active,in_trial` needs the room.
    value: z.string().max(500),
  });

  const viewShape = {
    name: z.string().min(1).max(60),
    visibility: z.enum(LIST_VIEW_VISIBILITY).optional(),
    filters: z.array(filterSchema).max(MAX_FILTERS_PER_VIEW).optional(),
    search: z.string().max(200).nullish(),
    sort_field: z.string().max(80).nullish(),
    sort_desc: z.boolean().nullish(),
    hidden_columns: z.array(z.string().max(80)).max(100).nullish(),
    is_default: z.boolean().optional(),
  };

  app.get(
    "/v1/list_views",
    { preHandler: [authenticate, requirePerm("views:view")] },
    async (req, reply) => {
      const parsed = z
        .object({
          entity: z.enum(LIST_VIEW_ENTITIES),
          business: z.string().min(1).max(100).optional(),
        })
        .safeParse(req.query ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const businessId = await scope(req, reply, parsed.data.business);
      if (businessId === undefined) return;
      // One resolution of "who is asking", used both to scope the read and to mark each
      // row `is_mine` — two calls could in principle disagree and mislabel ownership.
      const owner = resolveOwner();
      const rows = await listListViews(req.organization!.id, businessId, parsed.data.entity, owner);
      return {
        object: "list",
        data: rows.map((r) => serializeListView(r, owner)),
        has_more: false,
        next_cursor: null,
        total: rows.length,
      };
    },
  );

  app.post(
    "/v1/list_views",
    {
      preHandler: [authenticate, requirePerm("views:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const parsed = z
        .object({
          entity: z.enum(LIST_VIEW_ENTITIES),
          business: z.string().min(1).max(100).optional(),
          ...viewShape,
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const businessId = await scope(req, reply, parsed.data.business);
      if (businessId === undefined) return;
      const owner = resolveOwner();
      try {
        const row = await createListView({
          organizationId: req.organization!.id,
          businessId,
          entity: parsed.data.entity,
          name: parsed.data.name,
          visibility: parsed.data.visibility,
          filters: parsed.data.filters,
          search: parsed.data.search ?? null,
          sortField: parsed.data.sort_field ?? null,
          sortDesc: parsed.data.sort_desc ?? null,
          hiddenColumns: parsed.data.hidden_columns ?? null,
          isDefault: parsed.data.is_default,
        });
        return reply.code(201).send(serializeListView(row, owner));
      } catch (e) {
        // Subclass first: a duplicate name is a well-formed request against conflicting
        // state, which is a 409 and not a 400.
        if (e instanceof ListViewNameTakenError) return conflict(reply, e.message);
        if (e instanceof ListViewError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.patch(
    "/v1/list_views/:id",
    {
      preHandler: [authenticate, requirePerm("views:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const parsed = z
        .object({ ...viewShape, name: viewShape.name.optional() })
        .safeParse(req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { id } = req.params as { id: string };
      const owner = resolveOwner();
      try {
        const row = await updateListView(req.organization!.id, id, owner, {
          name: parsed.data.name,
          visibility: parsed.data.visibility,
          filters: parsed.data.filters,
          // `undefined` means "not mentioned" and `null` means "clear it", so these are
          // forwarded as-is rather than defaulted — a PATCH that only renames a view
          // must not blank the sort it carries.
          search: parsed.data.search,
          sortField: parsed.data.sort_field,
          sortDesc: parsed.data.sort_desc,
          hiddenColumns: parsed.data.hidden_columns,
          isDefault: parsed.data.is_default,
        });
        // Not-yours and no-such-view are one answer on purpose: distinguishing them
        // would tell one operator that another holds a private view by that id.
        if (!row) return notFound(reply, `No such view: ${id}`);
        return serializeListView(row, owner);
      } catch (e) {
        if (e instanceof ListViewNameTakenError) return conflict(reply, e.message);
        if (e instanceof ListViewError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  /**
   * Copy a view — including a colleague's shared one — so the caller owns the copy.
   * This is what makes owner-only editing workable: "this segment, but with INR too" is
   * a view of your own, not a redefinition of everybody's.
   */
  app.post(
    "/v1/list_views/:id/duplicate",
    {
      preHandler: [authenticate, requirePerm("views:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const parsed = z
        .object({ name: z.string().min(1).max(60).optional() })
        .safeParse(req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { id } = req.params as { id: string };
      try {
        const owner = resolveOwner();
        const row = await duplicateListView(req.organization!.id, id, owner, parsed.data.name);
        if (!row) return notFound(reply, `No such view: ${id}`);
        return reply.code(201).send(serializeListView(row, owner));
      } catch (e) {
        if (e instanceof ListViewNameTakenError) return conflict(reply, e.message);
        if (e instanceof ListViewError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.delete(
    "/v1/list_views/:id",
    {
      preHandler: [authenticate, requirePerm("views:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const ok = await deleteListView(req.organization!.id, id, resolveOwner());
        if (!ok) return notFound(reply, `No such view: ${id}`);
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof ListViewError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );
}

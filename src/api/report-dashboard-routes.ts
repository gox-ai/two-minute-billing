import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { getBusinessByPublicId } from "@/modules/tenancy/service";
import {
  addTile,
  createDashboard,
  deleteDashboard,
  getDashboard,
  listDashboards,
  removeTile,
  reorderTiles,
  resolveDashboard,
  resolveOwner,
  serializeDashboard,
  serializeTile,
  updateDashboard,
  updateTile,
  DASHBOARD_VISIBILITY,
  MAX_TILES_PER_DASHBOARD,
  TILE_SIZES,
  BOARD_COLUMNS,
  MIN_TILE_HEIGHT_UNITS,
  MAX_TILE_HEIGHT_UNITS,
  ReportDashboardError,
  ReportDashboardNameTakenError,
} from "@/modules/metrics/dashboards/service";
import { badRequest, conflict, notFound, requirePerm } from "./helpers";

/**
 * Saved report dashboards.
 *
 * ORG-LEVEL routes with an OPTIONAL `business`, the same family shape saved list views
 * use and for the same reason: a dashboard may be org-level (a layout pointed at a
 * business when it is opened), and a `/v1/businesses/:biz/…` family could not express
 * one at all.
 *
 * NO `requirePerm` gate, deliberately. A dashboard holds report KEYS, never figures, and
 * every role that can open the report explorer can already ask each report directly.
 * Gating it would stop a read-only analyst saving their own arrangement, which is the one
 * thing they most need. The figures themselves are still read through the report
 * resolvers, under the same tenancy as the report screen.
 */
export async function registerReportDashboardRoutes(app: FastifyInstance) {
  /**
   * Resolve the optional `business` scope. `undefined` means failure (after replying
   * 404); `null` means "an org-level dashboard" — collapsing the two would file an
   * org-level dashboard against a business that does not exist.
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

  /** The dashboard public id from the path. */
  const id = (req: FastifyRequest) => (req.params as { id: string }).id;

  const tileShape = z.object({
    report_key: z.string().min(1).max(80),
    range: z.string().max(20).nullish(),
    currency: z.string().length(3).nullish(),
    group_by: z.string().max(20).nullish(),
    granularity: z.string().max(20).nullish(),
    shape: z.string().max(20).nullish(),
    segment_id: z.string().max(64).nullish(),
    /** DEPRECATED — a width preset. Ignored when `width_units` is given. */
    size: z.enum(TILE_SIZES).optional(),
    width_units: z.number().int().min(1).max(BOARD_COLUMNS).optional(),
    height_units: z.number().int().min(MIN_TILE_HEIGHT_UNITS).max(MAX_TILE_HEIGHT_UNITS).optional(),
  });
  type TileBody = z.infer<typeof tileShape>;
  const tileInput = (t: TileBody) => ({
    reportKey: t.report_key,
    range: t.range ?? null,
    currency: t.currency ?? null,
    groupBy: t.group_by ?? null,
    granularity: t.granularity ?? null,
    shape: t.shape ?? null,
    segmentId: t.segment_id ?? null,
    size: t.size,
    widthUnits: t.width_units,
    heightUnits: t.height_units,
  });

  /** Map a service error to its status: a name clash is conflicting state, not bad input. */
  function serviceError(reply: FastifyReply, e: unknown) {
    if (e instanceof ReportDashboardNameTakenError) return conflict(reply, e.message);
    if (e instanceof ReportDashboardError) return badRequest(reply, e.message);
    throw e;
  }

  app.get(
    "/v1/report_dashboards",
    { preHandler: [authenticate, requirePerm("views:view")] },
    async (req, reply) => {
      const parsed = z
        .object({ business: z.string().min(1).max(100).optional() })
        .safeParse(req.query ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const businessId = await scope(req, reply, parsed.data.business);
      if (businessId === undefined) return;
      // One resolution of "who is asking", used both to scope the read and to mark each row
      // `is_mine` — two calls could in principle disagree and mislabel ownership.
      const owner = resolveOwner();
      const rows = await listDashboards(req.organization!.id, businessId, owner);
      return {
        object: "list",
        data: rows.map((r) => serializeDashboard(r.dashboard, r.tiles, owner)),
        has_more: false,
        next_cursor: null,
        total: rows.length,
      };
    },
  );

  app.post(
    "/v1/report_dashboards",
    {
      preHandler: [authenticate, requirePerm("views:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const parsed = z
        .object({
          business: z.string().min(1).max(100).optional(),
          name: z.string().min(1).max(60),
          visibility: z.enum(DASHBOARD_VISIBILITY).optional(),
          is_default: z.boolean().optional(),
          tiles: z.array(tileShape).max(MAX_TILES_PER_DASHBOARD).optional(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const businessId = await scope(req, reply, parsed.data.business);
      if (businessId === undefined) return;
      const owner = resolveOwner();
      try {
        const created = await createDashboard({
          organizationId: req.organization!.id,
          businessId,
          name: parsed.data.name,
          visibility: parsed.data.visibility,
          isDefault: parsed.data.is_default,
          tiles: (parsed.data.tiles ?? []).map(tileInput),
        });
        return reply.code(201).send(serializeDashboard(created.dashboard, created.tiles, owner));
      } catch (e) {
        return serviceError(reply, e);
      }
    },
  );

  app.get(
    "/v1/report_dashboards/:id",
    { preHandler: [authenticate, requirePerm("views:view")] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const owner = resolveOwner();
      const found = await getDashboard(req.organization!.id, id, owner);
      // Not-visible and no-such-dashboard are one answer: telling them apart would reveal
      // that someone else holds a private dashboard by that id.
      if (!found) return notFound(reply, `No such dashboard: ${id}`);
      return serializeDashboard(found.dashboard, found.tiles, owner);
    },
  );

  /**
   * The whole dashboard, answered: metadata plus every tile's report in ONE request.
   *
   * The reason this exists rather than the client asking per tile: a twelve-tile dashboard
   * would otherwise be twelve round trips whose `as_of` instants differ, and a set of
   * figures that were measured at twelve different moments does not reconcile.
   *
   * `business` is required for an org-level dashboard and optional for a business-scoped
   * one, where the dashboard's own business wins.
   */
  app.get(
    "/v1/report_dashboards/:id/reports",
    { preHandler: [authenticate, requirePerm("views:view")] },
    async (req, reply) => {
      const parsed = z
        .object({
          business: z.string().min(1).max(100).optional(),
          range: z.string().max(20).optional(),
          currency: z.string().length(3).optional(),
          granularity: z.string().max(20).optional(),
        })
        .safeParse(req.query ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const owner = resolveOwner();
      const found = await getDashboard(req.organization!.id, id(req), owner);
      if (!found) return notFound(reply, `No such dashboard: ${id(req)}`);

      let businessId = found.dashboard.businessId;
      if (parsed.data.business) {
        const asked = await scope(req, reply, parsed.data.business);
        if (asked === undefined) return;
        // A business-scoped dashboard answers for ITS business, and a request naming a
        // different one is refused rather than quietly ignored — either answer would
        // otherwise be a set of figures the caller did not ask for.
        if (businessId != null && businessId !== asked) {
          return badRequest(reply, "This dashboard belongs to another business");
        }
        businessId = asked;
      }
      if (!businessId) {
        return badRequest(
          reply,
          "This dashboard is org-level, so name the business to answer for: ?business=<id>",
        );
      }

      const resolved = await resolveDashboard(req.organization!.id, businessId, id(req), owner, {
        range: parsed.data.range,
        currency: parsed.data.currency,
        granularity: parsed.data.granularity,
      });
      if (!resolved) return notFound(reply, `No such dashboard: ${id(req)}`);
      return {
        ...serializeDashboard(resolved.dashboard, resolved.tiles, owner),
        // `tiles` above carries the arrangement; this carries the answers, one per tile in
        // the same order, each stating whether its report is still available.
        resolved_tiles: resolved.resolved,
      };
    },
  );

  app.patch(
    "/v1/report_dashboards/:id",
    {
      preHandler: [authenticate, requirePerm("views:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const parsed = z
        .object({
          name: z.string().min(1).max(60).optional(),
          visibility: z.enum(DASHBOARD_VISIBILITY).optional(),
          is_default: z.boolean().optional(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const owner = resolveOwner();
      try {
        const row = await updateDashboard(req.organization!.id, id(req), owner, {
          name: parsed.data.name,
          visibility: parsed.data.visibility,
          isDefault: parsed.data.is_default,
        });
        if (!row) return notFound(reply, `No such dashboard: ${id(req)}`);
        return serializeDashboard(row.dashboard, row.tiles, owner);
      } catch (e) {
        return serviceError(reply, e);
      }
    },
  );

  app.delete(
    "/v1/report_dashboards/:id",
    {
      preHandler: [authenticate, requirePerm("views:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      try {
        const ok = await deleteDashboard(req.organization!.id, id(req), resolveOwner());
        if (!ok) return notFound(reply, `No such dashboard: ${id(req)}`);
        return reply.code(204).send();
      } catch (e) {
        return serviceError(reply, e);
      }
    },
  );

  app.post(
    "/v1/report_dashboards/:id/tiles",
    {
      preHandler: [authenticate, requirePerm("views:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const parsed = tileShape.safeParse(req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const row = await addTile(
          req.organization!.id,
          id(req),
          resolveOwner(),
          tileInput(parsed.data),
        );
        if (!row) return notFound(reply, `No such dashboard: ${id(req)}`);
        return reply.code(201).send(serializeTile(row));
      } catch (e) {
        return serviceError(reply, e);
      }
    },
  );

  app.patch(
    "/v1/report_dashboards/:id/tiles/:tile",
    {
      preHandler: [authenticate, requirePerm("views:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const parsed = tileShape.omit({ report_key: true }).safeParse(req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { tile } = req.params as { tile: string };
      try {
        const row = await updateTile(req.organization!.id, id(req), tile, resolveOwner(), {
          // `undefined` is "not mentioned" and `null` is "clear it", forwarded as-is: a
          // patch that only resizes a tile must not drop the currency it is pinned to.
          range: parsed.data.range,
          currency: parsed.data.currency,
          groupBy: parsed.data.group_by,
          granularity: parsed.data.granularity,
          shape: parsed.data.shape,
          segmentId: parsed.data.segment_id,
          size: parsed.data.size,
          widthUnits: parsed.data.width_units,
          heightUnits: parsed.data.height_units,
        });
        if (!row) return notFound(reply, `No such tile: ${tile}`);
        return serializeTile(row);
      } catch (e) {
        return serviceError(reply, e);
      }
    },
  );

  app.delete(
    "/v1/report_dashboards/:id/tiles/:tile",
    {
      preHandler: [authenticate, requirePerm("views:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const { tile } = req.params as { tile: string };
      try {
        const ok = await removeTile(req.organization!.id, id(req), tile, resolveOwner());
        if (!ok) return notFound(reply, `No such tile: ${tile}`);
        return reply.code(204).send();
      } catch (e) {
        return serviceError(reply, e);
      }
    },
  );

  /** Reorder by naming every tile in the order wanted — see `reorderTiles` for why whole-list. */
  app.post(
    "/v1/report_dashboards/:id/tiles/reorder",
    {
      preHandler: [authenticate, requirePerm("views:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const parsed = z
        .object({
          tiles: z.array(z.string().min(1).max(60)).min(0).max(MAX_TILES_PER_DASHBOARD),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const owner = resolveOwner();
      try {
        const rows = await reorderTiles(req.organization!.id, id(req), owner, parsed.data.tiles);
        if (!rows) return notFound(reply, `No such dashboard: ${id(req)}`);
        return { object: "list", data: rows.map((t) => serializeTile(t)), total: rows.length };
      } catch (e) {
        return serviceError(reply, e);
      }
    },
  );
}

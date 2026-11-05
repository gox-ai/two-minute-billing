import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import {
  badGateway,
  badRequest,
  conflict,
  notFound,
  requirePerm,
  resolveBusiness,
} from "./helpers";
import { getConnection } from "@/modules/hubspot/connections";
import { HubSpotApiError, HubSpotClient } from "@/modules/hubspot/client";
import { HubSpotAuthError } from "@/modules/hubspot/oauth";
import { parseSettings } from "@/modules/hubspot/settings";
import { getConflict, listOpenConflicts, type Conflict } from "@/modules/hubspot/sync/conflicts";
import { ConflictGoneError, resolveConflict } from "@/modules/hubspot/sync/inbound";

const resolveBody = z.object({ keep: z.enum(["ours", "theirs"]) });

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function serializeConflict(c: Conflict) {
  return {
    object: "hubspot_conflict",
    id: c.publicId,
    status: c.status,
    local_type: c.localType,
    local_id: c.localRef,
    remote_type: c.remoteType,
    remote_id: c.remoteId,
    fields: c.fields.map((f) => ({
      field: f.local,
      label: f.label,
      remote_property: f.remote,
      ours: f.ours,
      theirs: f.theirs,
    })),
    remote_updated_at: iso(c.remoteUpdatedAt),
    detected_at: iso(c.createdAt),
    resolution: c.resolution,
    resolved_at: iso(c.resolvedAt),
  };
}

/** Records changed on both sides under the `flag` rule, and the decision that releases them. */
export async function registerHubSpotConflictRoutes(app: FastifyInstance) {
  const path = "/v1/businesses/:biz/integrations/hubspot/conflicts";

  app.get(
    path,
    { preHandler: [authenticate, requirePerm("integrations:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = req.query as { limit?: string; starting_after?: string };
      const limit = Math.min(Math.max(Number(q.limit ?? 20) || 20, 1), 100);
      const conn = await getConnection(req.organization!.id, business.id);
      if (!conn) return { object: "list", data: [], has_more: false, next_cursor: null };
      const { rows, hasMore } = await listOpenConflicts(conn, {
        limit,
        startingAfter: q.starting_after,
      });
      return {
        object: "list",
        data: rows.map(serializeConflict),
        has_more: hasMore,
        next_cursor: hasMore ? rows[rows.length - 1]!.publicId : null,
      };
    },
  );

  app.post(
    `${path}/:id/resolve`,
    {
      preHandler: [authenticate, requirePerm("integrations:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = resolveBody.safeParse(req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { id } = req.params as { id: string };
      const conn = await getConnection(req.organization!.id, business.id);
      if (!conn || conn.status === "disconnected")
        return notFound(reply, "HubSpot is not connected");
      const found = await getConflict(conn, id);
      if (!found) return notFound(reply, `No such conflict: ${id}`);
      if (found.status !== "open") return conflict(reply, "This conflict was already resolved");
      // Taking HubSpot's values reads the record from HubSpot, so it needs a live grant.
      if (parsed.data.keep === "theirs" && conn.status !== "active")
        return badRequest(reply, "Reconnect HubSpot to take its values");
      try {
        const done = await resolveConflict(
          { client: new HubSpotClient(conn), conn, settings: parseSettings(conn.settings) },
          found,
          parsed.data.keep,
        );
        return serializeConflict(done);
      } catch (e) {
        if (e instanceof ConflictGoneError) return conflict(reply, e.message);
        if (e instanceof HubSpotApiError || e instanceof HubSpotAuthError)
          return badGateway(reply, e.message);
        throw e;
      }
    },
  );
}

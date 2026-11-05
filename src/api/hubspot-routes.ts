import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { withTenant } from "@/platform/db";
import { enqueue } from "@/platform/jobs";
import {
  badRequest,
  badGateway,
  conflict,
  notFound,
  requirePerm,
  resolveBusiness,
} from "./helpers";
import { hubspotSyncItems, hubspotSyncQueue, hubspotSyncRuns } from "@db/schema";
import type { Connection } from "@/modules/hubspot/client";
import {
  connectHubSpot,
  disconnectHubSpot,
  getConnection,
  startFirstSync,
  HubSpotConnectionError,
  updateConnection,
} from "@/modules/hubspot/connections";
import {
  authorizeUrlBase,
  hubspotEnabled,
  HubSpotAuthError,
  missingInvoiceScopes,
} from "@/modules/hubspot/oauth";
import { HubSpotApiError, HubSpotClient } from "@/modules/hubspot/client";
import {
  DISCOVERABLE,
  listCustomObjects,
  listDealPipelines,
  listProperties,
  type DiscoverableObject,
} from "@/modules/hubspot/discovery";
import { INVOICE_PROPERTIES, LOCAL_FIELDS, parseSettings } from "@/modules/hubspot/settings";
import { listDefinitions } from "@/modules/custom-fields/service";

type Run = typeof hubspotSyncRuns.$inferSelect;
type Item = typeof hubspotSyncItems.$inferSelect;

const connectBody = z.object({ code: z.string().min(1).max(2048) });
const updateBody = z.object({
  autosync: z.boolean().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
const syncBody = z.object({ full: z.boolean().optional() }).optional();

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function serializeRun(r: Run) {
  return {
    object: "hubspot_sync_run",
    id: r.publicId,
    trigger: r.trigger,
    status: r.status,
    created: r.created,
    updated: r.updated,
    skipped: r.skipped,
    failed: r.failed,
    error: r.error,
    started_at: iso(r.startedAt),
    finished_at: iso(r.finishedAt),
  };
}

function serializeItem(i: Item) {
  return {
    object: "hubspot_sync_item",
    local_type: i.localType,
    local_id: i.localRef,
    remote_type: i.remoteType,
    remote_id: i.remoteId,
    action: i.action,
    message: i.message,
    created_at: iso(i.createdAt),
  };
}

async function health(conn: Connection) {
  return withTenant(conn.organizationId, async (tx) => {
    const [last] = await tx
      .select()
      .from(hubspotSyncRuns)
      .where(eq(hubspotSyncRuns.connectionId, conn.id))
      .orderBy(desc(hubspotSyncRuns.startedAt))
      .limit(1);
    const [queue] = await tx
      .select({
        pending: sql<number>`count(*)::int`,
        retrying: sql<number>`count(*) FILTER (WHERE ${hubspotSyncQueue.lastError} IS NOT NULL)::int`,
      })
      .from(hubspotSyncQueue)
      .where(eq(hubspotSyncQueue.connectionId, conn.id));
    const [day] = await tx
      .select({
        synced: sql<number>`coalesce(sum(${hubspotSyncRuns.created} + ${hubspotSyncRuns.updated}), 0)::int`,
        failed: sql<number>`coalesce(sum(${hubspotSyncRuns.failed}), 0)::int`,
      })
      .from(hubspotSyncRuns)
      .where(
        and(
          eq(hubspotSyncRuns.connectionId, conn.id),
          sql`${hubspotSyncRuns.startedAt} > now() - interval '24 hours'`,
        ),
      );
    return {
      last_run: last ? serializeRun(last) : null,
      pending: queue?.pending ?? 0,
      retrying: queue?.retrying ?? 0,
      synced_24h: day?.synced ?? 0,
      failed_24h: day?.failed ?? 0,
    };
  });
}

async function serializeConnection(conn: Connection | null) {
  const base = {
    object: "hubspot_connection",
    configured: hubspotEnabled(),
    // Public by construction (it is the URL the browser is sent to); the dashboard adds `state`.
    authorize_url: authorizeUrlBase(),
  };
  if (!conn || conn.status === "disconnected") return { ...base, status: "not_connected" as const };
  return {
    ...base,
    id: conn.publicId,
    status: conn.status,
    portal_id: conn.portalId,
    hub_domain: conn.hubDomain,
    installed_by: conn.installedBy,
    scopes: conn.scopes,
    autosync: conn.autosync,
    settings: parseSettings(conn.settings),
    initial_sync: conn.initialSync,
    last_sync_at: iso(conn.lastSyncAt),
    last_error: conn.lastError,
    connected_at: iso(conn.connectedAt),
    health: await health(conn),
  };
}

function queueSync(conn: Connection, trigger: "manual" | "initial", full: boolean) {
  return enqueue(
    "hubspot_sync_connection",
    { organizationId: conn.organizationId, connectionId: conn.id, trigger, full },
    // Repeated clicks while one is waiting collapse into one run.
    { jobKey: `hubspot_sync_connection:${conn.id}` },
  );
}

export async function registerHubSpotRoutes(app: FastifyInstance) {
  const path = "/v1/businesses/:biz/integrations/hubspot";

  app.get(
    path,
    { preHandler: [authenticate, requirePerm("integrations:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      return serializeConnection(await getConnection(req.organization!.id, business.id));
    },
  );

  app.post(
    `${path}/connect`,
    {
      preHandler: [authenticate, requirePerm("integrations:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = connectBody.safeParse(req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const conn = await connectHubSpot({
          organizationId: req.organization!.id,
          businessId: business.id,
          code: parsed.data.code,
        });
        // A new portal waits for `/start`; reconnecting the portal we already synced catches up.
        if (conn.initialSync !== "pending") await queueSync(conn, "manual", true);
        return reply.code(201).send(await serializeConnection(conn));
      } catch (e) {
        if (e instanceof HubSpotConnectionError) return badRequest(reply, e.message);
        if (e instanceof HubSpotAuthError) return badGateway(reply, e.message);
        throw e;
      }
    },
  );

  app.patch(
    path,
    {
      preHandler: [authenticate, requirePerm("integrations:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = updateBody.safeParse(req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const before = await getConnection(req.organization!.id, business.id);
      let conn;
      try {
        conn = await updateConnection(req.organization!.id, business.id, parsed.data);
      } catch (e) {
        if (e instanceof HubSpotConnectionError) return badRequest(reply, e.message);
        throw e;
      }
      if (!conn || conn.status === "disconnected")
        return notFound(reply, "HubSpot is not connected");
      // Changes made while a sync was off were consumed as skips; turning it back on resyncs.
      if (before && conn.status === "active" && conn.initialSync !== "pending") {
        const was = parseSettings(before.settings);
        const now = parseSettings(conn.settings);
        const reenabled =
          (!was.products.enabled && now.products.enabled) ||
          (!was.deals.enabled && now.deals.enabled) ||
          (now.invoices.enabled &&
            (!was.invoices.enabled || was.invoices.objectType !== now.invoices.objectType)) ||
          (!before.autosync && conn.autosync);
        if (reenabled) await queueSync(conn, "manual", true);
      }
      return serializeConnection(conn);
    },
  );

  app.delete(
    path,
    {
      preHandler: [authenticate, requirePerm("integrations:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const conn = await disconnectHubSpot(req.organization!.id, business.id);
      if (!conn) return notFound(reply, "HubSpot is not connected");
      return serializeConnection(conn);
    },
  );

  /**
   * The first sync, after the merchant has reviewed the settings. Nothing is written to
   * HubSpot between connecting and this call.
   */
  app.post(
    `${path}/start`,
    {
      preHandler: [authenticate, requirePerm("integrations:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const conn = await startFirstSync(req.organization!.id, business.id);
      if (conn) await queueSync(conn, "initial", true);
      const current = conn ?? (await getConnection(req.organization!.id, business.id));
      if (!current || current.status === "disconnected")
        return notFound(reply, "HubSpot is not connected");
      return reply.code(conn ? 202 : 200).send(await serializeConnection(current));
    },
  );

  // Sync Now. `full: true` re-pushes every customer rather than only what changed.
  app.post(
    `${path}/sync`,
    {
      preHandler: [authenticate, requirePerm("integrations:sync"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = syncBody.safeParse(req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const conn = await getConnection(req.organization!.id, business.id);
      if (!conn || conn.status !== "active") return notFound(reply, "HubSpot is not connected");
      if (conn.initialSync === "pending")
        return conflict(reply, "Review the settings and start the first sync before syncing.");
      await queueSync(conn, "manual", parsed.data?.full ?? false);
      return reply
        .code(202)
        .send({ object: "hubspot_sync", queued: true, full: parsed.data?.full ?? false });
    },
  );

  /** The connected portal's properties for one object, for the field-mapping pickers. */
  app.get(
    `${path}/properties/:object`,
    { preHandler: [authenticate, requirePerm("integrations:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { object } = req.params as { object: string };
      if (!(DISCOVERABLE as readonly string[]).includes(object))
        return badRequest(reply, `object must be one of ${DISCOVERABLE.join(", ")}`);
      const conn = await getConnection(req.organization!.id, business.id);
      if (!conn || conn.status !== "active") return notFound(reply, "HubSpot is not connected");
      try {
        const props = await listProperties(new HubSpotClient(conn), object as DiscoverableObject);
        return { object: "list", data: props };
      } catch (e) {
        if (e instanceof HubSpotApiError || e instanceof HubSpotAuthError)
          return badGateway(reply, e.message);
        throw e;
      }
    },
  );

  app.get(
    `${path}/pipelines`,
    { preHandler: [authenticate, requirePerm("integrations:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const conn = await getConnection(req.organization!.id, business.id);
      if (!conn || conn.status !== "active") return notFound(reply, "HubSpot is not connected");
      try {
        return { object: "list", data: await listDealPipelines(new HubSpotClient(conn)) };
      } catch (e) {
        if (e instanceof HubSpotApiError || e instanceof HubSpotAuthError)
          return badGateway(reply, e.message);
        throw e;
      }
    },
  );

  /**
   * The portal's custom objects, for the invoice object picker. `missing_scopes` names what the
   * grant lacks; a connection made before invoice sync must reconnect to list any.
   */
  app.get(
    `${path}/objects`,
    { preHandler: [authenticate, requirePerm("integrations:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const conn = await getConnection(req.organization!.id, business.id);
      if (!conn || conn.status !== "active") return notFound(reply, "HubSpot is not connected");
      const missing = missingInvoiceScopes(conn.scopes ?? []);
      const shape = (data: Awaited<ReturnType<typeof listCustomObjects>>, scopes: string[]) => ({
        object: "list",
        data,
        missing_scopes: scopes,
        invoice_properties: INVOICE_PROPERTIES,
      });
      if (missing.length > 0) return shape([], missing);
      try {
        return shape(await listCustomObjects(new HubSpotClient(conn)), []);
      } catch (e) {
        // A portal without Enterprise refuses the schemas read even with the scope granted.
        if (e instanceof HubSpotApiError && e.status === 403) return shape([], []);
        if (e instanceof HubSpotApiError || e instanceof HubSpotAuthError)
          return badGateway(reply, e.message);
        throw e;
      }
    },
  );

  /** Our side of a mapping: the fixed fields per object plus the business's custom fields. */
  app.get(
    `${path}/local_fields`,
    { preHandler: [authenticate, requirePerm("integrations:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const defs = await listDefinitions(req.organization!.id, business.id).catch(() => []);
      const custom = (entity: string) =>
        defs.filter((d) => d.entityType === entity).map((d) => `cf_${d.apiName}`);
      return {
        object: "hubspot_local_fields",
        contacts: [...LOCAL_FIELDS.contacts, ...custom("customer")],
        companies: [...LOCAL_FIELDS.companies, ...custom("customer")],
        deals: [...LOCAL_FIELDS.deals, ...custom("subscription")],
      };
    },
  );

  app.get(
    `${path}/sync_runs`,
    { preHandler: [authenticate, requirePerm("integrations:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = req.query as { limit?: string; starting_after?: string };
      const limit = Math.min(Math.max(Number(q.limit ?? 20) || 20, 1), 100);
      const conn = await getConnection(req.organization!.id, business.id);
      if (!conn) return { object: "list", data: [], has_more: false, next_cursor: null };
      const rows = await withTenant(req.organization!.id, async (tx) => {
        let cursor: Run | undefined;
        if (q.starting_after) {
          [cursor] = await tx
            .select()
            .from(hubspotSyncRuns)
            .where(
              and(
                eq(hubspotSyncRuns.connectionId, conn.id),
                eq(hubspotSyncRuns.publicId, q.starting_after),
              ),
            )
            .limit(1);
        }
        return tx
          .select()
          .from(hubspotSyncRuns)
          .where(
            and(
              eq(hubspotSyncRuns.connectionId, conn.id),
              cursor
                ? or(
                    lt(hubspotSyncRuns.startedAt, cursor.startedAt),
                    and(
                      eq(hubspotSyncRuns.startedAt, cursor.startedAt),
                      lt(hubspotSyncRuns.publicId, cursor.publicId),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(hubspotSyncRuns.startedAt), desc(hubspotSyncRuns.publicId))
          .limit(limit + 1);
      });
      const page = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      return {
        object: "list",
        data: page.map(serializeRun),
        has_more: hasMore,
        next_cursor: hasMore ? page[page.length - 1]!.publicId : null,
      };
    },
  );

  app.get(
    `${path}/sync_runs/:run`,
    { preHandler: [authenticate, requirePerm("integrations:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { run: runId } = req.params as { run: string };
      const q = req.query as { limit?: string; starting_after?: string };
      const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
      const offset = q.starting_after?.startsWith("o:")
        ? Math.max(Number(q.starting_after.slice(2)) || 0, 0)
        : 0;
      const found = await withTenant(req.organization!.id, async (tx) => {
        const [run] = await tx
          .select()
          .from(hubspotSyncRuns)
          .where(
            and(eq(hubspotSyncRuns.businessId, business.id), eq(hubspotSyncRuns.publicId, runId)),
          )
          .limit(1);
        if (!run) return null;
        const items = await tx
          .select()
          .from(hubspotSyncItems)
          .where(eq(hubspotSyncItems.runId, run.id))
          .orderBy(hubspotSyncItems.createdAt, hubspotSyncItems.id)
          .limit(limit + 1)
          .offset(offset);
        return { run, items };
      });
      if (!found) return notFound(reply, `No such sync run: ${runId}`);
      const page = found.items.slice(0, limit);
      const hasMore = found.items.length > limit;
      return {
        ...serializeRun(found.run),
        items: {
          object: "list",
          data: page.map(serializeItem),
          has_more: hasMore,
          next_cursor: hasMore ? `o:${offset + limit}` : null,
        },
      };
    },
  );
}

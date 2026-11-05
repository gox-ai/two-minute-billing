import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { badRequest, conflict, notFound, requirePerm, resolveBusiness } from "./helpers";
import { listIntegrations } from "@/modules/integrations/catalogue";
import { pushIntegration, syncIntegration } from "@/modules/integrations/registry";
import type { IntegrationInfo, PushIntegration } from "@/modules/integrations/types";
import {
  connectIntegration,
  disconnectIntegration,
  getIntegrationConnection,
  IntegrationValidationError,
  listIntegrationConnections,
  updateIntegration,
  type IntegrationConnection,
} from "@/modules/integrations/connections";
import {
  IntegrationRedeliverConflictError,
  integrationDeliveryStats,
  listIntegrationDeliveries,
  redeliverIntegrationDelivery,
  requeueFailedIntegrationDeliveries,
} from "@/modules/integrations/outbox";

const credentials = z.record(z.string(), z.string().min(1).max(500));
const config = z.record(z.string(), z.string().max(500));
const connectBody = z.object({ credentials, config: config.optional() });
const updateBody = z.object({
  enabled: z.boolean().optional(),
  /** Replaces ALL credentials: send every one the integration declares. */
  credentials: credentials.optional(),
  config: config.optional(),
});

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** The catalogue entry, as the API serves it. Static: no tenant data. */
function serializeInfo(i: IntegrationInfo) {
  const base = {
    object: "integration",
    key: i.key,
    label: i.label,
    kind: i.kind,
    category: i.category,
    blurb: i.blurb,
    icon: i.icon,
    connect_method: i.connect.method,
  };
  if (i.connect.method !== "api_key")
    return { ...base, event_types: [], credentials: [], fields: [] };
  return {
    ...base,
    event_types: [...i.connect.eventTypes],
    credentials: i.connect.credentials.map((c) => ({ ...c, secret: c.secret ?? true })),
    fields: [...(i.connect.fields ?? [])],
    ...(i.connect.prerequisite ? { prerequisite: i.connect.prerequisite } : {}),
  };
}

async function serializeConnection(
  integration: PushIntegration,
  conn: IntegrationConnection | null,
  businessPublicId: string,
) {
  const base = {
    object: "integration_connection",
    integration: integration.key,
    business: businessPublicId,
  };
  if (!conn || conn.status !== "active") return { ...base, status: "not_connected" as const };
  return {
    ...base,
    id: conn.publicId,
    status: conn.enabled ? ("active" as const) : ("disabled" as const),
    enabled: conn.enabled,
    livemode: conn.livemode,
    // Values the operator typed; never the credentials, which are write-only.
    config: conn.config ?? {},
    connected_at: iso(conn.connectedAt),
    updated_at: iso(conn.updatedAt),
    stats: await integrationDeliveryStats(conn.organizationId, conn.id),
  };
}

function validation(reply: FastifyReply, e: unknown) {
  if (e instanceof IntegrationValidationError) return badRequest(reply, e.message);
  throw e;
}

/**
 * Business-level integrations. HubSpot keeps its own richer routes under
 * `/v1/businesses/:biz/integrations/hubspot` (static segments win over `:key`); every push
 * integration is served by the generic routes below.
 */
export async function registerIntegrationRoutes(app: FastifyInstance) {
  app.get(
    "/v1/integrations",
    { preHandler: [authenticate, requirePerm("integrations:view")] },
    async () => ({
      object: "list",
      data: listIntegrations().map(serializeInfo),
    }),
  );

  // The directory: every integration with this business's status.
  app.get(
    "/v1/businesses/:biz/integrations",
    { preHandler: [authenticate, requirePerm("integrations:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const orgId = req.organization!.id;
      const conns = new Map(
        (await listIntegrationConnections(orgId, business.id)).map((c) => [c.provider, c]),
      );
      const data = await Promise.all(
        listIntegrations().map(async (info) => {
          const sync = syncIntegration(info.key);
          if (sync) {
            // A status lookup failing must not take the directory down.
            const st = await sync
              .status(orgId, business.id)
              .catch(() => ({ status: "not_connected" as const, summary: null }));
            return { ...serializeInfo(info), status: st.status, summary: st.summary };
          }
          const c = conns.get(info.key);
          const status =
            !c || c.status !== "active" ? "not_connected" : c.enabled ? "active" : "disabled";
          return { ...serializeInfo(info), status, summary: null };
        }),
      );
      return { object: "list", data };
    },
  );

  const path = "/v1/businesses/:biz/integrations/:key";
  const push = (key: string) => pushIntegration(key);

  app.get(
    path,
    { preHandler: [authenticate, requirePerm("integrations:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const integration = push((req.params as { key: string }).key);
      if (!integration)
        return notFound(reply, `No such integration: ${(req.params as { key: string }).key}`);
      const conn = await getIntegrationConnection(
        req.organization!.id,
        business.id,
        integration.key,
      );
      return serializeConnection(integration, conn, business.publicId);
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
      const integration = push((req.params as { key: string }).key);
      if (!integration)
        return notFound(reply, `No such integration: ${(req.params as { key: string }).key}`);
      const parsed = connectBody.safeParse(req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const conn = await connectIntegration({
          organizationId: req.organization!.id,
          business,
          provider: integration.key,
          credentials: parsed.data.credentials,
          config: parsed.data.config,
        });
        return reply
          .code(201)
          .send(await serializeConnection(integration, conn, business.publicId));
      } catch (e) {
        return validation(reply, e);
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
      const integration = push((req.params as { key: string }).key);
      if (!integration)
        return notFound(reply, `No such integration: ${(req.params as { key: string }).key}`);
      const parsed = updateBody.safeParse(req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const conn = await updateIntegration(
          req.organization!.id,
          business.id,
          integration.key,
          parsed.data,
        );
        if (!conn) return notFound(reply, `${integration.label} is not connected`);
        return serializeConnection(integration, conn, business.publicId);
      } catch (e) {
        return validation(reply, e);
      }
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
      const integration = push((req.params as { key: string }).key);
      if (!integration)
        return notFound(reply, `No such integration: ${(req.params as { key: string }).key}`);
      const conn = await disconnectIntegration(req.organization!.id, business.id, integration.key);
      if (!conn) return notFound(reply, `${integration.label} is not connected`);
      return serializeConnection(integration, null, business.publicId);
    },
  );

  /** The connection's delivery log, newest first (100). Kept across a reconnect. */
  app.get(
    `${path}/deliveries`,
    { preHandler: [authenticate, requirePerm("integrations:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const integration = push((req.params as { key: string }).key);
      if (!integration)
        return notFound(reply, `No such integration: ${(req.params as { key: string }).key}`);
      const conn = await getIntegrationConnection(
        req.organization!.id,
        business.id,
        integration.key,
      );
      if (!conn) return { object: "list", data: [] };
      const rows = await listIntegrationDeliveries(req.organization!.id, conn.id);
      return {
        object: "list",
        data: rows.map((r) => ({
          object: "integration_delivery",
          id: r.delivery.id,
          event: r.eventPublicId,
          event_type: r.eventType,
          status: r.delivery.status,
          attempts: r.delivery.attempts,
          last_attempt_at: iso(r.delivery.lastAttemptAt),
          next_attempt_at: iso(r.delivery.nextAttemptAt),
          last_response_status: r.delivery.lastResponseStatus,
          last_error: r.delivery.lastError,
          created_at: iso(r.delivery.createdAt),
        })),
      };
    },
  );

  /** Resend one delivery NOW and answer with this attempt's transcript (credentials masked). */
  app.post(
    `${path}/deliveries/:delivery/redeliver`,
    {
      preHandler: [authenticate, requirePerm("integrations:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { key, delivery } = req.params as { key: string; delivery: string };
      const integration = push(key);
      if (!integration) return notFound(reply, `No such integration: ${key}`);
      const conn = await getIntegrationConnection(
        req.organization!.id,
        business.id,
        integration.key,
      );
      // A disconnected row keeps its log, but nothing can send without credentials.
      if (!conn || conn.status !== "active")
        return notFound(reply, `${integration.label} is not connected`);
      if (!z.uuid().safeParse(delivery).success)
        return notFound(reply, `No such delivery: ${delivery}`);
      try {
        const r = await redeliverIntegrationDelivery(req.organization!.id, conn.id, delivery);
        if (!r) return notFound(reply, `No such delivery: ${delivery}`);
        return {
          object: "integration_delivery",
          id: r.delivery.id,
          status: r.delivery.status,
          attempts: r.delivery.attempts,
          next_attempt_at: iso(r.delivery.nextAttemptAt),
          last_response_status: r.delivery.lastResponseStatus,
          attempt: {
            outcome: r.transcript.outcome,
            latency_ms: r.transcript.latencyMs,
            error: r.transcript.error,
            request: r.transcript.request,
            response: r.transcript.response,
          },
        };
      } catch (e) {
        if (e instanceof IntegrationRedeliverConflictError) return conflict(reply, e.message);
        throw e;
      }
    },
  );

  /** Requeue every failed delivery through the outbox; answers with a count. */
  app.post(
    `${path}/redeliver_failed`,
    {
      preHandler: [authenticate, requirePerm("integrations:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const integration = push((req.params as { key: string }).key);
      if (!integration)
        return notFound(reply, `No such integration: ${(req.params as { key: string }).key}`);
      const conn = await getIntegrationConnection(
        req.organization!.id,
        business.id,
        integration.key,
      );
      // A disconnected row keeps its log, but nothing can send without credentials.
      if (!conn || conn.status !== "active")
        return notFound(reply, `${integration.label} is not connected`);
      const r = await requeueFailedIntegrationDeliveries(req.organization!.id, conn.id);
      return { object: "integration_requeue", integration: integration.key, ...r };
    },
  );
}

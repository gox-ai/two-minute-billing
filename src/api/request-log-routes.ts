import type { FastifyInstance } from "fastify";
import { authenticate } from "@/platform/auth";
import {
  getRequestLog,
  listRequestLogsPage,
  requestLogRefs,
  REQUEST_LOG_FILTER_KINDS,
  REQUEST_LOG_FILTER_OPS,
  REQUEST_LOG_SORT_FIELDS,
  type RequestLogRefs,
  type RequestLogRow,
} from "@/modules/request-log/service";
import { publicRequestId } from "@/modules/request-log/capture";
import { listResponse, notFound, parseListQuery, requirePerm } from "./helpers";

function serializeSummary(r: RequestLogRow, refs: RequestLogRefs) {
  return {
    object: "request_log" as const,
    id: publicRequestId(r.id),
    created_at: r.createdAt,
    method: r.method,
    path: r.path,
    route: r.route,
    query: r.query,
    api_version: "v1" as const,
    kind: r.kind,
    status: r.status,
    duration_ms: r.durationMs,
    source: r.source,
    api_key: r.apiKeyId ? (refs.keys.get(r.apiKeyId) ?? null) : null,
    member: r.memberUserId ? (refs.members.get(r.memberUserId) ?? null) : null,
    business: r.businessId ? (refs.businesses.get(r.businessId) ?? null) : null,
    livemode: r.livemode,
    idempotency_key: r.idempotencyKey,
    idempotency_outcome: r.idempotencyOutcome,
    error_type: r.errorType,
    trace_id: r.traceId,
    customer: r.customerId,
    ip: r.ip,
    user_agent: r.userAgent,
  };
}

// The request log's own reads are not logged.
const NOT_LOGGED = { requestLog: "off" } as const;

/** API request log (design L): what this organization's credentials sent, and the answers. */
export async function registerRequestLogRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/v1/request_logs",
    { preHandler: [authenticate, requirePerm("api_logs:view")], config: NOT_LOGGED },
    async (req, reply) => {
      const q = parseListQuery(req, reply, {
        includeDeleted: "none",
        filterOps: REQUEST_LOG_FILTER_OPS,
        filterKinds: REQUEST_LOG_FILTER_KINDS,
        sortFields: REQUEST_LOG_SORT_FIELDS,
        bareParams: ["api_key", "business", "customer", "trace_id", "idempotency_key"],
      });
      if (!q) return;
      const bare = req.query as Record<string, string | undefined>;
      const page = await listRequestLogsPage(req.organization!.id, {
        ...q,
        keyMode: req.keyLivemode,
        apiKey: bare.api_key || undefined,
        business: bare.business || undefined,
        customer: bare.customer || undefined,
        traceId: bare.trace_id || undefined,
        idempotencyKey: bare.idempotency_key || undefined,
      });
      const refs = await requestLogRefs(req.organization!.id, page.data);
      return listResponse(page, (r) => serializeSummary(r, refs));
    },
  );

  app.get(
    "/v1/request_logs/:id",
    { preHandler: [authenticate, requirePerm("api_logs:view")], config: NOT_LOGGED },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const found = await getRequestLog(req.organization!.id, id, req.keyLivemode);
      if (!found) return notFound(reply, `No such request log: ${id}`);
      const { row, related } = found;
      const refs = await requestLogRefs(req.organization!.id, [row]);
      return {
        ...serializeSummary(row, refs),
        request_body: row.requestBody ?? null,
        response_body: row.responseBody ?? null,
        related: {
          same_idempotency_key: related.sameIdempotencyKey.map((r) => ({
            id: publicRequestId(r.id),
            created_at: r.createdAt,
            method: r.method,
            path: r.path,
            status: r.status,
            idempotency_outcome: r.idempotencyOutcome,
            original: r.original,
            current: r.id === row.id,
          })),
          events: related.events,
          audit_logs: related.auditLogs,
          gateway_requests: related.gatewayRequests,
        },
      };
    },
  );
}

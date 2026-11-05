import type { FastifyInstance } from "fastify";
import { authenticate } from "@/platform/auth";
import { auditLogs } from "@db/schema";
import {
  listAuditLogsPage,
  getAuditRecord,
  businessPublicIds,
  AUDIT_FILTER_OPS,
  AUDIT_SORT_FIELDS,
  type AuditBlock,
} from "@/modules/audit/service";
import { resolveBusiness, parseListQuery, listResponse, notFound, requirePerm } from "./helpers";

/**
 * `business_id` is the business's PUBLIC id (`biz_…`), not the uuid FK, because it is
 * what a caller can use: it addresses the business over this API and it is the path
 * segment the dashboard's business-scoped routes take — including the audit
 * drill-in, so the org-level list can link straight to a row's record page.
 *
 * Resolved by the caller and passed in rather than joined into `listAuditLogsPage`:
 * the org-level list is the only reader that spans businesses, and widening the
 * shared keyset query (used by three other screens) to carry a join for one of them
 * is the wrong trade. `null` is meaningful and common — an org-global action (an API
 * key rotation, a cross-business admin change) belongs to no business.
 */
function serialize(a: typeof auditLogs.$inferSelect, businessPublicId?: string | null) {
  return {
    object: "audit_log",
    business_id: businessPublicId ?? null,
    id: a.id,
    actor: a.actor,
    source: a.source,
    action: a.action,
    resource_type: a.resourceType,
    resource_id: a.resourceId,
    before: a.before ?? null,
    after: a.after ?? null,
    // P4: where the actor acted from. Null for every non-request writer (billing
    // clock, importer, seeds) — see db/migrations/0142.
    actor_ip: a.actorIp ?? null,
    // 0149: the execution that wrote this row. Rows sharing it are one ACTION —
    // what the detail route groups into a single record with a block per resource.
    trace_id: a.traceId ?? null,
    created_at: a.createdAt,
  };
}

/** One resource's block of an audit record — the row plus its snapshot bodies. */
function serializeBlock(b: AuditBlock) {
  return {
    ...serialize(b.row),
    /**
     * 'available' | 'created' | 'none' — see `AuditBlock`. The client renders a
     * contextual diff, a creation snapshot, or the changed-field table alone. It is
     * NOT derivable from the two bodies being null (a created record legitimately
     * has a null before-side), so it is served explicitly.
     */
    snapshot: b.snapshot,
    before_full: b.beforeFull ?? null,
    after_full: b.afterFull ?? null,
  };
}

/**
 * H2 (LOG-3): audit-log read API — org-level + business-scoped variants.
 * LOG-4: both are cursor-paginated (`?limit&starting_after&q&sort_by[..]&
 * <field>[<op>]=<value>` → `{ object, data, has_more, next_cursor, total }`),
 * the same contract as customers/transactions — see `docs/GUIDE.md` §3.4.
 */
export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/v1/audit_logs",
    { preHandler: [authenticate, requirePerm("audit_logs:view")] },
    async (req, reply) => {
      const q = parseListQuery(req, reply, {
        includeDeleted: "none",
        filterOps: AUDIT_FILTER_OPS,
        sortFields: AUDIT_SORT_FIELDS,
      });
      if (!q) return;
      const page = await listAuditLogsPage(req.organization!.id, {
        ...q,
        // Post-H (#9): gate by the key's mode so a test key can't read live audit rows.
        livemode: req.keyLivemode,
      });
      // ONE query for the businesses on this page. Without it `business_id` was never
      // emitted at all: the dashboard's list declared the column, so every row rendered
      // its Business as "—" and the row could not link to its own record page.
      const ids = [...new Set(page.data.map((r) => r.businessId).filter((v): v is string => !!v))];
      const names = await businessPublicIds(req.organization!.id, ids);
      return listResponse(page, (a) =>
        serialize(a, a.businessId ? (names.get(a.businessId) ?? null) : null),
      );
    },
  );

  app.get(
    "/v1/businesses/:biz/audit_logs",
    { preHandler: [authenticate, requirePerm("audit_logs:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = parseListQuery(req, reply, {
        includeDeleted: "none",
        filterOps: AUDIT_FILTER_OPS,
        sortFields: AUDIT_SORT_FIELDS,
        // Business-scoped only: a customer public id is unique per business.
        bareParams: ["customer"],
      });
      if (!q) return;
      const customer = (req.query as Record<string, unknown>).customer;
      const page = await listAuditLogsPage(req.organization!.id, {
        ...q,
        businessId: business.id,
        customer: customer ? String(customer) : undefined,
      });
      return listResponse(page, (a) => serialize(a, business.publicId));
    },
  );

  /**
   * P4 / 0149: one audit RECORD — what the dashboard's Activity Log drills into:
   * actor, source, IP, and a block per resource the action changed, each with its
   * changed-field diff and — when captured — the full record on both sides.
   *
   * `?source=<resource_type>` hoists that resource's block to the front: opening the
   * record from an invoice should lead with the invoice, from the subscription with
   * the subscription. It only reorders; every block is always returned, so the reader
   * can see everything else the act did.
   *
   * Business-scoped only, deliberately: the drill-in is reached from a business's
   * screens, and the org-level log has no detail route because its rows include
   * cross-business admin actions.
   */
  app.get(
    "/v1/businesses/:biz/audit_logs/:id",
    { preHandler: [authenticate, requirePerm("audit_logs:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      const { source } = req.query as { source?: string };
      const record = await getAuditRecord(req.organization!.id, business.id, id, source);
      if (!record) return notFound(reply, `No such audit log: ${id}`);
      return {
        object: "audit_record",
        id: record.id,
        trace_id: record.traceId,
        occurred_at: record.occurredAt,
        actor: record.actor,
        source: record.source,
        actor_ip: record.actorIp,
        blocks: record.blocks.map(serializeBlock),
      };
    },
  );
}

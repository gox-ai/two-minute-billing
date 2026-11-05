import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import {
  createSegment,
  deleteSegment,
  getSegment,
  listSegments,
  loadSegmentCustomerFacts,
  resolveSegment,
  serializeSegment,
  updateSegment,
  MAX_FILTERS_PER_SEGMENT,
  SegmentError,
  SegmentNameTakenError,
  SegmentRefusedError,
  segmentRefusals,
} from "@/modules/segments/service";
import { SEGMENT_ATTRIBUTES } from "@/modules/segments/attributes";
import { serializeCustomer } from "@/modules/customers/serialize";
import {
  badRequest,
  conflict,
  notFound,
  parseListQuery,
  resolveBusiness,
  listResponse,
  requirePerm,
} from "./helpers";
import {
  CUSTOMER_FILTER_OPS,
  CUSTOMER_FILTER_KINDS,
  CUSTOMER_SORT_FIELDS,
  customerCustomFieldFilterSet,
} from "@/modules/customers/service";
import { filterDefinitions } from "@/modules/custom-fields/service";
import { parseRequest } from "./strict-params";

/**
 * Customer segments — saved, named populations.
 *
 * Business-scoped, unlike `/v1/list_views`: a segment is a population of CUSTOMERS and
 * a customer belongs to exactly one business, so there is no org-level shape for one
 * to take.
 *
 * NO `requirePerm` gate, for the same reason saved views have none: a segment holds a
 * filter definition, never data, and every role that can open the customer list can
 * already see everything a segment would narrow. Gating it would stop a read-only
 * analyst from saving the one thing they most need.
 *
 * ⚠️ Vocabulary: a **view** filters a list (`/v1/list_views`), a **segment** names a
 * population (here), an **attribute** is what a segment is a predicate over. The three
 * are kept apart in the schema, the API and the UI — `docs/PROGRESS.md` § 4c.
 */
export async function registerSegmentRoutes(app: FastifyInstance) {
  const filterSchema = z.object({
    field: z.string().min(1).max(80),
    op: z.string().min(1).max(20),
    value: z.string().max(500),
  });

  const segmentBody = {
    name: z.string().min(1).max(60),
    description: z.string().max(500).nullish(),
    filters: z.array(filterSchema).min(1).max(MAX_FILTERS_PER_SEGMENT),
    starter_key: z.string().max(60).nullish(),
  };

  /** Map a module error onto the status code it means. */
  const fail = (reply: Parameters<typeof badRequest>[0], e: unknown) => {
    if (e instanceof SegmentNameTakenError) return conflict(reply, e.message);
    // A refusal is a 400 with a NAMED reason, never a 500 and never a slow answer.
    if (e instanceof SegmentRefusedError) return badRequest(reply, e.message);
    if (e instanceof SegmentError) return badRequest(reply, e.message);
    throw e;
  };

  /**
   * The attribute surface a filter builder can render: field, label, group, kind,
   * operators and the closed option set for an enum.
   *
   * Served rather than mirrored in the dashboard, so a screen cannot offer a control
   * the engine would reject — the duplication `platform/list-query.ts` documents as
   * the real defect behind ~250 hand-written operator mirrors.
   */
  app.get(
    "/v1/businesses/:biz/customer_segments/attributes",
    { preHandler: [authenticate, requirePerm("views:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      return {
        object: "list",
        data: SEGMENT_ATTRIBUTES.map((a) => ({
          field: a.field,
          label: a.label,
          group: a.group,
          kind: a.kind,
          ops: a.ops,
          options: a.options ?? null,
          hint: a.hint ?? null,
        })),
        has_more: false,
        next_cursor: null,
        total: SEGMENT_ATTRIBUTES.length,
      };
    },
  );

  /** The starter library, then this business's saved segments. */
  app.get(
    "/v1/businesses/:biz/customer_segments",
    { preHandler: [authenticate, requirePerm("views:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const rows = await listSegments(req.organization!.id, business.id);
      const refusals = await segmentRefusals(req.organization!.id, business.id, rows);
      return {
        object: "list",
        // `answerable` is for THIS business: a segment can be valid and still unresolvable on a
        // book it does not fit (an unpinned `mrr` threshold on a multi-currency book).
        data: rows.map((s) => {
          const refusal = refusals.get(s.publicId) ?? null;
          return { ...serializeSegment(s), answerable: refusal == null, refusal };
        }),
        has_more: false,
        next_cursor: null,
        total: rows.length,
      };
    },
  );

  app.get(
    "/v1/businesses/:biz/customer_segments/:seg",
    { preHandler: [authenticate, requirePerm("views:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { seg } = req.params as { seg: string };
      const found = await getSegment(req.organization!.id, business.id, seg);
      if (!found) return notFound(reply, `No such segment: ${seg}`);
      return serializeSegment(found);
    },
  );

  /**
   * The customers a segment matches, with the exact size of the population and what it
   * earns per month.
   *
   * `mrr_by_currency` is a MAP, always. One figure over a mixed book would add minor
   * units of different currencies; a segment that pins a currency simply returns a map
   * with one key.
   */
  app.get(
    "/v1/businesses/:biz/customer_segments/:seg/customers",
    { preHandler: [authenticate, requirePerm("views:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { seg } = req.params as { seg: string };
      const found = await getSegment(req.organization!.id, business.id, seg);
      if (!found) return notFound(reply, `No such segment: ${seg}`);
      const q = parseRequest(
        z.object({
          limit: z.coerce.number().int().min(1).max(200).optional(),
          starting_after: z.string().max(200).optional(),
          // The same token under the list contract's second name (`next_offset`).
          offset: z.string().max(200).optional(),
        }),
        req.query ?? {},
      );
      if (!q.success) return badRequest(reply, q.error);
      try {
        const { rows, totals } = await resolveSegment(
          req.organization!.id,
          business.id,
          found.filters,
          { limit: q.data.limit, startingAfter: q.data.starting_after ?? q.data.offset },
        );
        // ONE grouped query for the whole page, zipped on below — the columns the
        // table renders (status, subscription count, MRR) are not on the customer row
        // itself, and resolving them per row would be an N+1.
        const facts = await loadSegmentCustomerFacts(
          req.organization!.id,
          rows.data.map((c) => c.id),
        );
        const body = listResponse(rows, (c) => ({
          ...serializeCustomer(c),
          segment_facts: facts[c.id] ?? { statuses: {}, mrr: {}, last_order_at: null },
        }));
        return { ...body, segment: found.publicId, mrr_by_currency: totals.mrrByCurrency };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  /**
   * The population an UNSAVED filter set names — the screen's one data path.
   *
   * Takes the customer list's own `field[op]=value` grammar verbatim (not a JSON body),
   * so previewing a segment and listing customers are the same request shape, and a
   * chip an operator removes is one query parameter less. Validated by
   * `parseListQuery` against the same allow-list a saved segment is validated against,
   * so a preview cannot succeed where the save would fail.
   *
   * With no filters at all it is "all customers", which is the screen's default entry
   * and a real answer rather than an empty state.
   */
  app.get(
    "/v1/businesses/:biz/customer_segments/preview",
    { preHandler: [authenticate, requirePerm("views:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const customFieldDefs = await filterDefinitions(
        req.organization!.id,
        business.id,
        "customer",
      );
      const cf = customerCustomFieldFilterSet(customFieldDefs);
      const q = parseListQuery(req, reply, {
        filterOps: { ...CUSTOMER_FILTER_OPS, ...cf.ops },
        filterKinds: { ...CUSTOMER_FILTER_KINDS, ...cf.kinds },
        sortFields: CUSTOMER_SORT_FIELDS,
      });
      if (!q) return;
      try {
        const { rows, totals } = await resolveSegment(
          req.organization!.id,
          business.id,
          q.filters,
          {
            limit: q.limit,
            startingAfter: q.startingAfter,
            sortField: q.sortField,
            sortDesc: q.sortDesc,
          },
        );
        const facts = await loadSegmentCustomerFacts(
          req.organization!.id,
          rows.data.map((c) => c.id),
        );
        const body = listResponse(rows, (c) => ({
          ...serializeCustomer(c),
          segment_facts: facts[c.id] ?? { statuses: {}, mrr: {}, last_order_at: null },
        }));
        return { ...body, segment: null, mrr_by_currency: totals.mrrByCurrency };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.post(
    "/v1/businesses/:biz/customer_segments",
    {
      preHandler: [authenticate, requirePerm("views:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(z.object(segmentBody), req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const row = await createSegment({
          organizationId: req.organization!.id,
          businessId: business.id,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          filters: parsed.data.filters,
          starterKey: parsed.data.starter_key ?? null,
        });
        return reply.code(201).send(
          serializeSegment({
            publicId: row.publicId,
            name: row.name,
            description: row.description,
            filters: row.filters,
            isStarter: false,
            starterKey: row.starterKey,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          }),
        );
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.patch(
    "/v1/businesses/:biz/customer_segments/:seg",
    {
      preHandler: [authenticate, requirePerm("views:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { seg } = req.params as { seg: string };
      const parsed = parseRequest(
        z.object({
          name: segmentBody.name.optional(),
          description: segmentBody.description,
          filters: segmentBody.filters.optional(),
        }),
        req.body ?? {},
      );
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const row = await updateSegment(req.organization!.id, business.id, seg, {
          name: parsed.data.name,
          description: parsed.data.description,
          filters: parsed.data.filters,
        });
        if (!row) return notFound(reply, `No such segment: ${seg}`);
        return serializeSegment({
          publicId: row.publicId,
          name: row.name,
          description: row.description,
          filters: row.filters,
          isStarter: false,
          starterKey: row.starterKey,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.delete(
    "/v1/businesses/:biz/customer_segments/:seg",
    {
      preHandler: [authenticate, requirePerm("views:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { seg } = req.params as { seg: string };
      try {
        const gone = await deleteSegment(req.organization!.id, business.id, seg);
        if (!gone) return notFound(reply, `No such segment: ${seg}`);
        return { object: "customer_segment", id: seg, deleted: true };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );
}

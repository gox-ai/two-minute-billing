import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { isUuid } from "@/platform/list-query";
import { badRequest, notFound, resolveBusiness, requirePerm } from "./helpers";
import { parseRequest } from "./strict-params";
import {
  EXPORT_ENTITIES,
  INVOICE_STATUSES,
  PAYMENT_STATUSES,
  SUBSCRIPTION_STATUSES,
  type ExportFilters,
} from "@/modules/bulk-export/writers";
import {
  auditDownload,
  createExportRun,
  deleteExportRun,
  ExportConflictError,
  ExportError,
  exportFile,
  ExportNotFoundError,
  exportZip,
  getExportRun,
  listExportRuns,
  previewExport,
  type ExportInput,
} from "@/modules/bulk-export/runs";

const entity = z.enum(EXPORT_ENTITIES);
const status = z.enum([
  ...new Set([...SUBSCRIPTION_STATUSES, ...INVOICE_STATUSES, ...PAYMENT_STATUSES]),
] as [string, ...string[]]);
const filter = z.object({
  status: z.array(status).max(10).optional(),
  date_field: z.enum(["created", "updated"]).optional(),
  from: z.string().max(40).nullable().optional(),
  to: z.string().max(40).nullable().optional(),
  include_archived: z.boolean().optional(),
});
const body = z.object({
  entities: z.array(entity).min(1).max(EXPORT_ENTITIES.length),
  filters: z.partialRecord(entity, filter).optional(),
  include_related: z.boolean().optional(),
});
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  starting_after: z.string().uuid().optional(),
});

/** The API's snake_case filters → the module's. */
function toInput(d: z.infer<typeof body>): ExportInput {
  const filters: ExportFilters = {};
  for (const [e, f] of Object.entries(d.filters ?? {}))
    if (f)
      filters[e as keyof ExportFilters] = {
        status: f.status,
        dateField: f.date_field,
        from: f.from ?? null,
        to: f.to ?? null,
        includeArchived: f.include_archived,
      };
  return { entities: d.entities, filters, include_related: d.include_related };
}

async function fail(reply: FastifyReply, e: unknown) {
  if (e instanceof ExportNotFoundError) return notFound(reply, e.message);
  if (e instanceof ExportError) return badRequest(reply, e.message);
  if (e instanceof ExportConflictError)
    return reply.code(409).send({
      error: { type: "conflict_error", code: "export_conflict", message: e.message },
    });
  throw e;
}

const runId = (p: unknown) => (p as { id: string }).id;

export async function registerExportRoutes(app: FastifyInstance): Promise<void> {
  // Rows per file and the first rows as the files will have them. Writes nothing.
  app.post(
    "/v1/businesses/:biz/exports/preview",
    { preHandler: [authenticate, requirePerm("exports:view")] },
    async (req, reply) => {
      const biz = await resolveBusiness(req, reply);
      if (!biz) return;
      const parsed = parseRequest(body, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        return await previewExport(req.organization!.id, biz.id, toInput(parsed.data));
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  // Start an export; the files are written in the background.
  app.post(
    "/v1/businesses/:biz/exports",
    {
      preHandler: [authenticate, requirePerm("exports:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const biz = await resolveBusiness(req, reply);
      if (!biz) return;
      const parsed = parseRequest(body, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const run = await createExportRun({
          organizationId: req.organization!.id,
          businessId: biz.id,
          body: toInput(parsed.data),
          operatorUserId: req.hasOperator ? (req.operatorUserId ?? null) : null,
        });
        return reply.code(202).send(run);
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.get(
    "/v1/businesses/:biz/exports",
    { preHandler: [authenticate, requirePerm("exports:view")] },
    async (req, reply) => {
      const biz = await resolveBusiness(req, reply);
      if (!biz) return;
      const q = parseRequest(listQuery, req.query);
      if (!q.success) return badRequest(reply, q.error);
      const page = await listExportRuns(req.organization!.id, biz.id, {
        limit: q.data.limit,
        startingAfter: q.data.starting_after,
      });
      return { object: "list", ...page };
    },
  );

  app.get(
    "/v1/businesses/:biz/exports/:id",
    { preHandler: [authenticate, requirePerm("exports:view")] },
    async (req, reply) => {
      const biz = await resolveBusiness(req, reply);
      if (!biz) return;
      if (!isUuid(runId(req.params)))
        return notFound(reply, `No such export: ${runId(req.params)}`);
      try {
        return await getExportRun(req.organization!.id, biz.id, runId(req.params));
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  // The zip: every file of the export and a README.
  app.get(
    "/v1/businesses/:biz/exports/:id/file",
    { preHandler: [authenticate, requirePerm("exports:view")] },
    async (req, reply) => {
      const biz = await resolveBusiness(req, reply);
      if (!biz) return;
      if (!isUuid(runId(req.params)))
        return notFound(reply, `No such export: ${runId(req.params)}`);
      try {
        const out = await exportZip(req.organization!.id, biz.id, runId(req.params));
        await auditDownload(req.organization!.id, biz.id, out.run.id, out.name);
        return reply
          .header("content-type", "application/zip")
          .header("content-length", String(out.size))
          .header("content-disposition", `attachment; filename="${out.name}"`)
          .header("cache-control", "no-store")
          .send(Readable.from(out.body));
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  // One CSV of the export.
  app.get(
    "/v1/businesses/:biz/exports/:id/files/:entity",
    { preHandler: [authenticate, requirePerm("exports:view")] },
    async (req, reply) => {
      const biz = await resolveBusiness(req, reply);
      if (!biz) return;
      const p = req.params as { id: string; entity: string };
      if (!isUuid(p.id)) return notFound(reply, `No such export: ${p.id}`);
      const e = entity.safeParse(p.entity);
      if (!e.success) return notFound(reply, `No such file: ${p.entity}`);
      try {
        const out = await exportFile(req.organization!.id, biz.id, p.id, e.data);
        await auditDownload(req.organization!.id, biz.id, out.run.id, out.name);
        return reply
          .header("content-type", "text/csv; charset=utf-8")
          .header("content-length", String(out.size))
          .header("content-disposition", `attachment; filename="${out.name}"`)
          .header("cache-control", "no-store")
          .send(Readable.from(out.body));
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // Delete the files of a finished export now.
  app.post(
    "/v1/businesses/:biz/exports/:id/delete",
    {
      preHandler: [authenticate, requirePerm("exports:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const biz = await resolveBusiness(req, reply);
      if (!biz) return;
      if (!isUuid(runId(req.params)))
        return notFound(reply, `No such export: ${runId(req.params)}`);
      try {
        return await deleteExportRun(req.organization!.id, biz.id, runId(req.params));
      } catch (e) {
        return fail(reply, e);
      }
    },
  );
}

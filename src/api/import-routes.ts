import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { isUuid } from "@/platform/list-query";
import { badRequest, notFound, resolveBusiness, requirePerm } from "./helpers";
import { parseRequest } from "./strict-params";
import {
  IMPORT_ENTITIES,
  templateCsv,
  ENTITY_FIELDS,
  type ImportEntity,
} from "@/modules/bulk-import/templates";
import {
  createImportRun,
  discardImportRun,
  getImportRun,
  importRowsCsv,
  importUndoCheck,
  ImportConflictError,
  ImportError,
  ImportNotFoundError,
  listImportRows,
  listImportRuns,
  recheckImportRun,
  startImportRun,
  undoImportRun,
} from "@/modules/bulk-import/runs";

/** 50 MB of CSV per request: five files at the row limit fit with room. */
const BODY_LIMIT = 50 * 1024 * 1024;

const entity = z.enum(IMPORT_ENTITIES);
const mapping = z.record(z.string().max(200), z.string().max(64).nullable());
const mappings = z.partialRecord(entity, mapping);
const options = z.object({
  skip_invalid_rows: z.boolean().optional(),
  exclude_renewing_within_24h: z.boolean().optional(),
  collect_open_invoices: z.boolean().optional(),
});

const createBody = z.object({
  files: z
    .array(
      z.object({
        entity: z.union([entity, z.literal("json")]),
        filename: z.string().trim().min(1).max(255),
        content: z.string().min(1),
      }),
    )
    .min(1)
    .max(IMPORT_ENTITIES.length),
  mapping: mappings.optional(),
  options: options.optional(),
});
const checkBody = z.object({ mapping: mappings.optional(), options: options.optional() });
const confirmBody = z.object({ confirm: z.string().max(200).optional() });
const rowsQuery = z.object({
  entity: entity.optional(),
  state: z.enum(["new", "existing", "invalid", "excluded"]).optional(),
  outcome: z.enum(["created", "unchanged", "failed", "excluded"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  starting_after: z.string().uuid().optional(),
});
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  starting_after: z.string().uuid().optional(),
});

async function fail(reply: FastifyReply, e: unknown) {
  if (e instanceof ImportNotFoundError) return notFound(reply, e.message);
  if (e instanceof ImportError) return badRequest(reply, e.message);
  if (e instanceof ImportConflictError)
    return reply.code(409).send({
      error: {
        type: "conflict_error",
        code: "import_conflict",
        message: e.message,
        reasons: e.reasons,
      },
    });
  throw e;
}

const runId = (p: unknown) => (p as { id: string }).id;

export async function registerImportRoutes(app: FastifyInstance): Promise<void> {
  // The template of one file: its columns and one example row.
  app.get(
    "/v1/businesses/:biz/imports/templates/:entity",
    { preHandler: [authenticate, requirePerm("imports:view")] },
    async (req, reply) => {
      const biz = await resolveBusiness(req, reply);
      if (!biz) return;
      const e = entity.safeParse((req.params as { entity: string }).entity);
      if (!e.success)
        return notFound(reply, `No such template: ${(req.params as { entity: string }).entity}`);
      if ((req.query as { format?: string }).format === "json")
        return {
          object: "import_template",
          entity: e.data,
          fields: ENTITY_FIELDS[e.data].map((f) => ({
            key: f.key,
            required: !!f.required,
            aliases: f.aliases ?? [],
            example: f.example,
            help: f.help,
            values: f.values ? [...new Set(Object.values(f.values))] : null,
          })),
        };
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="${e.data}.csv"`)
        .send(templateCsv(e.data));
    },
  );

  // Upload: parse the files into rows and queue the check.
  app.post(
    "/v1/businesses/:biz/imports",
    {
      bodyLimit: BODY_LIMIT,
      preHandler: [authenticate, requirePerm("imports:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const biz = await resolveBusiness(req, reply);
      if (!biz) return;
      const parsed = parseRequest(createBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const run = await createImportRun({
          organizationId: req.organization!.id,
          businessId: biz.id,
          files: parsed.data.files,
          mapping: parsed.data.mapping,
          options: parsed.data.options,
          operatorUserId: req.hasOperator ? (req.operatorUserId ?? null) : null,
        });
        return reply.code(201).send(run);
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.get(
    "/v1/businesses/:biz/imports",
    { preHandler: [authenticate, requirePerm("imports:view")] },
    async (req, reply) => {
      const biz = await resolveBusiness(req, reply);
      if (!biz) return;
      const q = parseRequest(listQuery, req.query);
      if (!q.success) return badRequest(reply, q.error);
      const page = await listImportRuns(req.organization!.id, biz.id, {
        limit: q.data.limit,
        startingAfter: q.data.starting_after,
      });
      return { object: "list", ...page };
    },
  );

  app.get(
    "/v1/businesses/:biz/imports/:id",
    { preHandler: [authenticate, requirePerm("imports:view")] },
    async (req, reply) => {
      const biz = await resolveBusiness(req, reply);
      if (!biz) return;
      if (!isUuid(runId(req.params)))
        return notFound(reply, `No such import: ${runId(req.params)}`);
      try {
        const run = await getImportRun(req.organization!.id, biz.id, runId(req.params));
        const undo = await importUndoCheck(req.organization!.id, biz.id, run.id);
        return { ...run, undo_blockers: undo };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.get(
    "/v1/businesses/:biz/imports/:id/rows",
    { preHandler: [authenticate, requirePerm("imports:view")] },
    async (req, reply) => {
      const biz = await resolveBusiness(req, reply);
      if (!biz) return;
      if (!isUuid(runId(req.params)))
        return notFound(reply, `No such import: ${runId(req.params)}`);
      const q = parseRequest(rowsQuery, req.query);
      if (!q.success) return badRequest(reply, q.error);
      try {
        const page = await listImportRows(req.organization!.id, biz.id, runId(req.params), {
          entity: q.data.entity,
          state: q.data.state,
          outcome: q.data.outcome,
          limit: q.data.limit,
          startingAfter: q.data.starting_after,
        });
        return { object: "list", ...page };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  // One uploaded file with its errors (and, after the run, each row's result) added.
  app.get(
    "/v1/businesses/:biz/imports/:id/files/:entity",
    { preHandler: [authenticate, requirePerm("imports:view")] },
    async (req, reply) => {
      const biz = await resolveBusiness(req, reply);
      if (!biz) return;
      const p = req.params as { id: string; entity: string };
      if (!isUuid(p.id)) return notFound(reply, `No such import: ${p.id}`);
      const e = entity.safeParse(p.entity);
      if (!e.success) return notFound(reply, `No such file: ${p.entity}`);
      try {
        const out = await importRowsCsv(req.organization!.id, biz.id, p.id, e.data as ImportEntity);
        return reply
          .header("content-type", "text/csv; charset=utf-8")
          .header("content-disposition", `attachment; filename="${out.filename}"`)
          .send(out.csv);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  const write = (
    path: string,
    body: z.ZodTypeAny,
    handler: (args: {
      org: string;
      biz: string;
      id: string;
      data: any;
      operatorUserId: string | null;
    }) => Promise<unknown>,
  ) =>
    app.post(
      `/v1/businesses/:biz/imports/:id/${path}`,
      {
        preHandler: [authenticate, requirePerm("imports:manage"), idempotency],
        onSend: idempotencyOnSend,
      },
      async (req, reply) => {
        const biz = await resolveBusiness(req, reply);
        if (!biz) return;
        if (!isUuid(runId(req.params)))
          return notFound(reply, `No such import: ${runId(req.params)}`);
        const parsed = parseRequest(body, req.body ?? {});
        if (!parsed.success) return badRequest(reply, parsed.error);
        try {
          const out = await handler({
            org: req.organization!.id,
            biz: biz.id,
            id: runId(req.params),
            data: parsed.data,
            operatorUserId: req.hasOperator ? (req.operatorUserId ?? null) : null,
          });
          return reply.code(path === "discard" ? 200 : 202).send(out);
        } catch (e) {
          return fail(reply, e);
        }
      },
    );

  // Check again with a changed column mapping or options.
  write("check", checkBody, ({ org, biz, id, data }) =>
    recheckImportRun({
      organizationId: org,
      businessId: biz,
      runId: id,
      mapping: data.mapping,
      options: data.options,
    }),
  );
  // Start a checked import. A live business needs `confirm` = its name.
  write("start", confirmBody, ({ org, biz, id, data, operatorUserId }) =>
    startImportRun({
      organizationId: org,
      businessId: biz,
      runId: id,
      confirm: data.confirm,
      operatorUserId,
    }),
  );
  // Undo a finished import, while nothing it created has billing activity.
  write("undo", confirmBody, ({ org, biz, id, data, operatorUserId }) =>
    undoImportRun({
      organizationId: org,
      businessId: biz,
      runId: id,
      confirm: data.confirm,
      operatorUserId,
    }),
  );
  // Throw away an import that has not started.
  write("discard", z.object({}), ({ org, biz, id }) => discardImportRun(org, biz, id));
}

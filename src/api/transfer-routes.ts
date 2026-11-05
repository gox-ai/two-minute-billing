import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { LIMITS } from "./limits";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { badRequest, conflict, notFound, resolveBusiness, requirePerm } from "./helpers";
import { getBusinessByPublicId, listBusinesses } from "@/modules/tenancy/service";
import {
  runTransfer,
  previewTransfer,
  getTransfer,
  listTransfers,
  ALL_SECTIONS,
  TransferError,
  TransferConflictError,
  TransferForbiddenError,
  type TransferInput,
  type TransferJob,
  type TransferSection,
} from "@/modules/transfer/service";
import { createSampleData, deleteSampleData } from "@/modules/transfer/sample-data";
import { transferConfigurations } from "@db/schema";

function serializeJob(
  j: typeof transferConfigurations.$inferSelect,
  srcPid: string,
  destPid: string,
) {
  return {
    object: "transfer_configuration",
    id: j.id,
    status: j.status,
    source_business: srcPid,
    destination_business: destPid,
    sections: j.sections,
    wipe_destination: j.wipeDestination,
    options: j.options ?? null,
    live_override: j.liveOverride,
    twin_of: j.twinOf ?? null,
    report: j.report ?? null,
    error: j.error ?? null,
    created_at: j.createdAt,
    updated_at: j.updatedAt,
  };
}

/** A job plus its test-twin job; the twin's businesses are looked up by uuid. */
async function serializeWithTwin(orgId: string, job: TransferJob, srcPid: string, destPid: string) {
  const twin = job.twin
    ? serializeJob(
        job.twin,
        (await listBusinessesPublicId(orgId, job.twin.sourceBusinessId)) ??
          job.twin.sourceBusinessId,
        (await listBusinessesPublicId(orgId, job.twin.destinationBusinessId)) ??
          job.twin.destinationBusinessId,
      )
    : null;
  return { ...serializeJob(job, srcPid, destPid), twin };
}

// Transfer spans both test/live partitions → require an all-mode key.
// `await reply` is load-bearing: callers bare-`return` on false, and on these
// idempotent write routes the async idempotencyOnSend hook leaves the 403 in flight,
// which used to make Fastify double-send and crash the process (see
// platform/reply-guard.ts). Awaiting the thenable reply parks until it is flushed.
async function requireAll(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (req.keyLivemode !== "all") {
    await reply
      .code(403)
      .send({ error: { type: "forbidden", message: "Transfers require an all-mode API key" } });
    return false;
  }
  return true;
}

/** uuid → public id for a business in this org (for serializing a stored job). */
async function listBusinessesPublicId(orgId: string, bizUuid: string): Promise<string | null> {
  const all = await listBusinesses(orgId);
  return all.find((b) => b.id === bizUuid)?.publicId ?? null;
}

export async function registerTransferRoutes(app: FastifyInstance): Promise<void> {
  const prefix = z.string().trim().min(1, "Must not be blank").max(20);
  const previewBody = z.object({
    destination_business: z.string().max(LIMITS.id).min(1),
    sections: z.array(z.enum(ALL_SECTIONS as [TransferSection, ...TransferSection[]])).optional(),
    wipe_destination: z.boolean().optional(),
    numbering: z
      .object({ invoice_prefix: prefix.optional(), credit_note_prefix: prefix.optional() })
      .strict()
      .optional(),
    include_test_twins: z.boolean().optional(),
  });
  const body = previewBody.extend({
    live_override: z
      .object({
        confirm: z.string().max(LIMITS.name),
        plan_digest: z.string().min(1).max(128),
      })
      .strict()
      .optional(),
  });
  const toInput = (
    orgId: string,
    sourceId: string,
    destId: string,
    d: z.infer<typeof body>,
  ): TransferInput => ({
    organizationId: orgId,
    sourceBusinessId: sourceId,
    destinationBusinessId: destId,
    sections: d.sections,
    wipeDestination: d.wipe_destination,
    numbering: d.numbering
      ? {
          invoicePrefix: d.numbering.invoice_prefix,
          creditNotePrefix: d.numbering.credit_note_prefix,
        }
      : undefined,
    includeTestTwins: d.include_test_twins,
    liveOverride: d.live_override
      ? { confirm: d.live_override.confirm, planDigest: d.live_override.plan_digest }
      : null,
  });

  // What a run would write, field by field. No writes, so no Idempotency-Key.
  app.post(
    "/v1/businesses/:biz/transfer_configurations/preview",
    { preHandler: [authenticate, requirePerm("transfers:manage")] },
    async (req, reply) => {
      if (!(await requireAll(req, reply))) return;
      const source = await resolveBusiness(req, reply);
      if (!source) return;
      const parsed = previewBody.safeParse(req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const dest = await getBusinessByPublicId(
        req.organization!.id,
        parsed.data.destination_business,
      );
      if (!dest)
        return notFound(reply, `No such destination business: ${parsed.data.destination_business}`);
      try {
        return await previewTransfer(
          toInput(req.organization!.id, source.id, dest.id, parsed.data),
        );
      } catch (e) {
        if (e instanceof TransferError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // TL-1: run a transfer (source = :biz → destination_business).
  app.post(
    "/v1/businesses/:biz/transfer_configurations",
    {
      preHandler: [authenticate, requirePerm("transfers:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      if (!(await requireAll(req, reply))) return;
      const source = await resolveBusiness(req, reply);
      if (!source) return;
      const parsed = body.safeParse(req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const dest = await getBusinessByPublicId(
        req.organization!.id,
        parsed.data.destination_business,
      );
      if (!dest)
        return notFound(reply, `No such destination business: ${parsed.data.destination_business}`);
      // The live override is a person's decision: a key has no person behind it (see
      // requirePerm), so it can never grant one. The service checks the role again.
      if (parsed.data.live_override && !req.hasOperator) {
        await reply.code(403).send({
          error: {
            type: "permission_error",
            message:
              "The live override needs a signed-in owner or admin. An API key cannot grant it.",
          },
        });
        return;
      }
      try {
        const job = await runTransfer({
          ...toInput(req.organization!.id, source.id, dest.id, parsed.data),
          operatorPermissions: req.hasOperator ? (req.operatorPermissions ?? null) : null,
        });
        return reply
          .code(job.status === "failed" ? 422 : 201)
          .send(await serializeWithTwin(req.organization!.id, job, source.publicId, dest.publicId));
      } catch (e) {
        if (e instanceof TransferForbiddenError) {
          await reply.code(403).send({ error: { type: "permission_error", message: e.message } });
          return;
        }
        if (e instanceof TransferConflictError) return conflict(reply, e.message);
        if (e instanceof TransferError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // Past runs, newest first. `scope=business` (default): runs from or into :biz;
  // `scope=organization`: every run in the organization.
  const listQuery = z.object({
    scope: z.enum(["business", "organization"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    starting_after: z.string().max(LIMITS.id).optional(),
    offset: z.string().max(LIMITS.id).optional(),
  });
  app.get(
    "/v1/businesses/:biz/transfer_configurations",
    { preHandler: [authenticate, requirePerm("transfers:view")] },
    async (req, reply) => {
      const biz = await resolveBusiness(req, reply);
      if (!biz) return;
      const q = listQuery.safeParse(req.query);
      if (!q.success) return badRequest(reply, q.error);
      const orgId = req.organization!.id;
      const page = await listTransfers(orgId, {
        businessId: q.data.scope === "organization" ? undefined : biz.id,
        limit: q.data.limit ?? 20,
        startingAfter: q.data.starting_after ?? q.data.offset,
      });
      const all = await listBusinesses(orgId);
      const pid = (id: string) => all.find((b) => b.id === id)?.publicId ?? id;
      const data = page.data.map((j) => ({
        ...serializeJob(j, pid(j.sourceBusinessId), pid(j.destinationBusinessId)),
        twin: j.twin
          ? serializeJob(j.twin, pid(j.twin.sourceBusinessId), pid(j.twin.destinationBusinessId))
          : null,
      }));
      const last = page.data[page.data.length - 1];
      return {
        object: "list",
        data,
        has_more: page.hasMore,
        next_cursor: page.hasMore && last ? last.id : null,
      };
    },
  );

  app.get(
    "/v1/businesses/:biz/transfer_configurations/:job",
    { preHandler: [authenticate, requirePerm("transfers:status")] },
    async (req, reply) => {
      const source = await resolveBusiness(req, reply);
      if (!source) return;
      const { job } = req.params as { job: string };
      const row = await getTransfer(req.organization!.id, job);
      if (!row || row.sourceBusinessId !== source.id)
        return notFound(reply, `No such transfer: ${job}`);
      const dest = await listBusinessesPublicId(req.organization!.id, row.destinationBusinessId);
      return serializeWithTwin(
        req.organization!.id,
        row,
        source.publicId,
        dest ?? row.destinationBusinessId,
      );
    },
  );

  // TL-2: per-object copy — called on the DESTINATION (:biz), pulling one section
  // from `from_business`. A thin façade over runTransfer scoped to that section.
  const copyBody = z.object({ from_business: z.string().max(LIMITS.id).min(1) });
  const perObject = (section: TransferSection, path: string) =>
    app.post(
      path,
      {
        preHandler: [authenticate, requirePerm("catalog:copy"), idempotency],
        onSend: idempotencyOnSend,
      },
      async (req, reply) => {
        if (!(await requireAll(req, reply))) return;
        const dest = await resolveBusiness(req, reply);
        if (!dest) return;
        const parsed = copyBody.safeParse(req.body);
        if (!parsed.success) return badRequest(reply, parsed.error);
        const from = await getBusinessByPublicId(req.organization!.id, parsed.data.from_business);
        if (!from) return notFound(reply, `No such source business: ${parsed.data.from_business}`);
        try {
          const job = await runTransfer({
            organizationId: req.organization!.id,
            sourceBusinessId: from.id,
            destinationBusinessId: dest.id,
            sections: [section],
          });
          return reply
            .code(job.status === "failed" ? 422 : 201)
            .send(await serializeWithTwin(req.organization!.id, job, from.publicId, dest.publicId));
        } catch (e) {
          if (e instanceof TransferError) return badRequest(reply, e.message);
          throw e;
        }
      },
    );
  perObject("coupons", "/v1/businesses/:biz/coupons/copy");
  perObject("catalog", "/v1/businesses/:biz/products/copy");

  // TL-3: sample data (test businesses only).
  app.post(
    "/v1/businesses/:biz/sample_data",
    {
      preHandler: [authenticate, requirePerm("test_tools:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const biz = await resolveBusiness(req, reply);
      if (!biz) return;
      if (biz.livemode !== "test")
        return badRequest(reply, "sample_data is only available on test businesses");
      const summary = await createSampleData(req.organization!.id, biz.id);
      return reply.code(201).send({ object: "sample_data", ...summary });
    },
  );
  app.delete(
    "/v1/businesses/:biz/sample_data",
    {
      preHandler: [authenticate, requirePerm("test_tools:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const biz = await resolveBusiness(req, reply);
      if (!biz) return;
      if (biz.livemode !== "test")
        return badRequest(reply, "sample_data is only available on test businesses");
      const summary = await deleteSampleData(req.organization!.id, biz.id);
      return { object: "sample_data", deleted: true, ...summary };
    },
  );
}

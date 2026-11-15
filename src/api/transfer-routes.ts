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
import {
  applyTransferPlan,
  cancelTransferRun,
  createTransferPlan,
  getTransferRun,
  listTransferItems,
  retryTransferRun,
  setItemExclusions,
  TransferDriftError,
  type RunView,
} from "@/modules/transfer/runs";
import {
  pairKey,
  RESULT_KINDS,
  type Pair,
  type ResultKind,
  type RunSummary,
} from "@/modules/transfer/graph";
import { parseRequest } from "./strict-params";
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
    run_kind: j.runKind,
    ...(j.runKind === "async"
      ? {
          conflict_policy: j.conflictPolicy ?? null,
          counts: j.counts ?? null,
          validation: j.validation ?? null,
          planned_by: j.plannedBy ?? null,
          started_by: j.startedBy ?? null,
          cancelled_by: j.cancelledBy ?? null,
          queued_at: j.queuedAt ?? null,
          started_at: j.startedAt ?? null,
          finished_at: j.finishedAt ?? null,
          heartbeat_at: j.heartbeatAt ?? null,
          cancel_requested_at: j.cancelRequestedAt ?? null,
        }
      : {}),
    created_at: j.createdAt,
    updated_at: j.updatedAt,
  };
}

type ItemRow = RunView["items"][number];

/** One item as the run view and the items list show it. */
function serializeItem(i: ItemRow, effective: RunView["effective"]) {
  const key = pairKey({ pair: i.pair as Pair, key: i.key });
  const eff = effective.get(key);
  return {
    key,
    pair: i.pair,
    section: i.section,
    kind: i.kind,
    label: i.label,
    action: i.action,
    excluded: i.excluded,
    blocked: eff?.blocked ?? false,
    depends_on: i.dependsOn,
    diff: i.diff ?? null,
    messages: eff?.messages ?? i.messages,
    status: i.status,
    skip_reason: i.skipReason ?? null,
    error: i.error ?? null,
    attempts: i.attempts,
    started_at: i.startedAt ?? null,
    finished_at: i.finishedAt ?? null,
  };
}

/** Counts per section × result, progress per section, the open blockers. */
function serializeSummary(s: RunSummary) {
  return {
    total: s.total,
    results: s.results,
    sections: s.sections,
    blocked: s.blocked,
    retryable: s.retryable,
  };
}

/**
 * An async run with its counts, and its items unless the caller asked for none. Items and
 * blockers carry destination values, so only an all-mode caller sees them.
 */
function serializeRun(
  v: RunView,
  srcPid: string,
  destPid: string,
  o: { allMode: boolean; items: boolean },
) {
  const { blocked, ...counts } = serializeSummary(v.summary);
  return {
    ...serializeJob(v.run, srcPid, destPid),
    destination_livemode: v.destLive ? "live" : "test",
    live_override_needed: v.liveOverrideNeeded,
    summary: o.allMode ? { ...counts, blocked } : counts,
    ...(o.allMode && o.items ? { items: v.items.map((i) => serializeItem(i, v.effective)) } : {}),
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
    // Comma list, e.g. `planned,queued,running` for the open plan or active run.
    status: z.string().max(200).optional(),
    run_kind: z.enum(["async", "sync"]).optional(),
    // Relative to :biz: runs started from it, or runs into it. Both when omitted.
    direction: z.enum(["outgoing", "incoming"]).optional(),
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
        statuses: q.data.status ? q.data.status.split(",").map((x) => x.trim()) : undefined,
        runKind: q.data.run_kind,
        direction: q.data.direction,
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

  // `items=none`: the run with its counts only. A plan can hold tens of thousands of items;
  // page them through GET …/:job/items.
  const viewQuery = z.object({ items: z.enum(["all", "none"]).optional() });
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
      if (row.runKind === "async") {
        const v = viewQuery.safeParse(req.query);
        if (!v.success) return badRequest(reply, v.error);
        const items = v.data.items !== "none";
        const view = await getTransferRun(req.organization!.id, row.id, { items });
        if (!view) return notFound(reply, `No such transfer: ${job}`);
        return serializeRun(view, source.publicId, dest ?? row.destinationBusinessId, {
          allMode: req.keyLivemode === "all",
          items,
        });
      }
      return serializeWithTwin(
        req.organization!.id,
        row,
        source.publicId,
        dest ?? row.destinationBusinessId,
      );
    },
  );

  // ── Async transfers: plan → exclusions → apply (queued) → runner. ──
  const policy = z.enum(["skip", "update"]);
  const planBody = previewBody
    .extend({
      conflict_policy: z
        .object(Object.fromEntries(ALL_SECTIONS.map((s) => [s, policy.optional()])))
        .strict()
        .optional(),
      exclude: z.array(z.string().max(300)).max(5000).optional(),
    })
    .strict();
  const mapError = async (reply: FastifyReply, e: unknown) => {
    if (e instanceof TransferForbiddenError) {
      await reply.code(403).send({ error: { type: "permission_error", message: e.message } });
      return;
    }
    if (e instanceof TransferDriftError) return conflict(reply, e.message, "transfer_drift");
    if (e instanceof TransferConflictError) return conflict(reply, e.message);
    if (e instanceof TransferError) return badRequest(reply, e.message);
    throw e;
  };
  /** The async run named in the path, started from :biz. */
  const runOf = async (req: FastifyRequest, reply: FastifyReply) => {
    const source = await resolveBusiness(req, reply);
    if (!source) return null;
    const { job } = req.params as { job: string };
    const view = await getTransferRun(req.organization!.id, job);
    if (!view || view.run.sourceBusinessId !== source.id) {
      notFound(reply, `No such transfer: ${job}`);
      return null;
    }
    return { source, view };
  };
  /** The run after a write; `?items=none` leaves its items out, as on the GET. */
  const sendRun = async (req: FastifyRequest, sourcePid: string, runId: string) => {
    const items = (req.query as { items?: string } | undefined)?.items !== "none";
    const view = (await getTransferRun(req.organization!.id, runId, { items }))!;
    const dest = await listBusinessesPublicId(req.organization!.id, view.run.destinationBusinessId);
    return serializeRun(view, sourcePid, dest ?? view.run.destinationBusinessId, {
      allMode: true,
      items,
    });
  };

  // Build and store a plan: every object and setting with its action. Writes no configuration.
  app.post(
    "/v1/businesses/:biz/transfer_configurations/plans",
    {
      // Inline, not shared: verify:idempotency-race reads each registration's own options.
      preHandler: [authenticate, requirePerm("transfers:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      if (!(await requireAll(req, reply))) return;
      const source = await resolveBusiness(req, reply);
      if (!source) return;
      const parsed = parseRequest(planBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const d = parsed.data;
      const dest = await getBusinessByPublicId(req.organization!.id, d.destination_business);
      if (!dest) return notFound(reply, `No such destination business: ${d.destination_business}`);
      try {
        const id = await createTransferPlan({
          organizationId: req.organization!.id,
          sourceBusinessId: source.id,
          destinationBusinessId: dest.id,
          sections: d.sections,
          conflictPolicy: d.conflict_policy as
            | Record<TransferSection, "skip" | "update">
            | undefined,
          numbering: d.numbering
            ? {
                invoicePrefix: d.numbering.invoice_prefix,
                creditNotePrefix: d.numbering.credit_note_prefix,
              }
            : undefined,
          includeTestTwins: d.include_test_twins,
          wipeDestination: d.wipe_destination,
          exclude: d.exclude,
        });
        return reply.code(201).send(await sendRun(req, source.publicId, id));
      } catch (e) {
        return mapError(reply, e);
      }
    },
  );

  // One page of a run's items in plan order, filtered in the database.
  const itemsQuery = z
    .object({
      section: z.string().max(40).optional(),
      result: z
        .union([z.enum(RESULT_KINDS as [ResultKind, ...ResultKind[]]), z.literal("changes")])
        .optional(),
      status: z.enum(["queued", "open", "done", "failed", "skipped"]).optional(),
      q: z.string().trim().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      starting_after: z
        .string()
        .max(12)
        .regex(/^\d+$/, "Must be the next_cursor of the previous page")
        .optional(),
    })
    .strict();
  app.get(
    "/v1/businesses/:biz/transfer_configurations/:job/items",
    { preHandler: [authenticate, requirePerm("transfers:status")] },
    async (req, reply) => {
      if (!(await requireAll(req, reply))) return;
      const source = await resolveBusiness(req, reply);
      if (!source) return;
      const parsed = parseRequest(itemsQuery, req.query ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { job } = req.params as { job: string };
      const row = await getTransfer(req.organization!.id, job);
      if (!row || row.sourceBusinessId !== source.id || row.runKind !== "async")
        return notFound(reply, `No such transfer: ${job}`);
      const d = parsed.data;
      const page = await listTransferItems(req.organization!.id, row.id, {
        section: d.section,
        result: d.result,
        status: d.status,
        q: d.q || undefined,
        limit: d.limit ?? 100,
        startingAfter: d.starting_after !== undefined ? Number(d.starting_after) : undefined,
      });
      if (!page) return notFound(reply, `No such transfer: ${job}`);
      const last = page.items[page.items.length - 1];
      return {
        object: "list",
        data: page.items.map((i) => serializeItem(i, page.effective)),
        has_more: page.hasMore,
        next_cursor: page.hasMore && last ? String(last.seq) : null,
      };
    },
  );

  const itemsBody = z
    .object({
      exclude: z.array(z.string().max(300)).max(5000).optional(),
      include: z.array(z.string().max(300)).max(5000).optional(),
    })
    .strict();
  app.post(
    "/v1/businesses/:biz/transfer_configurations/:job/items",
    {
      preHandler: [authenticate, requirePerm("transfers:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      if (!(await requireAll(req, reply))) return;
      const r = await runOf(req, reply);
      if (!r) return;
      const parsed = parseRequest(itemsBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        await setItemExclusions(req.organization!.id, r.view.run.id, parsed.data);
        return await sendRun(req, r.source.publicId, r.view.run.id);
      } catch (e) {
        return mapError(reply, e);
      }
    },
  );

  const applyBody = z.object({ confirm: z.string().max(LIMITS.name).optional() }).strict();
  for (const [verb, fn] of [
    ["apply", applyTransferPlan],
    ["retry", retryTransferRun],
  ] as const)
    app.post(
      `/v1/businesses/:biz/transfer_configurations/:job/${verb}`,
      {
        preHandler: [authenticate, requirePerm("transfers:manage"), idempotency],
        onSend: idempotencyOnSend,
      },
      async (req, reply) => {
        if (!(await requireAll(req, reply))) return;
        const r = await runOf(req, reply);
        if (!r) return;
        const parsed = parseRequest(applyBody, req.body ?? {});
        if (!parsed.success) return badRequest(reply, parsed.error);
        try {
          await fn({
            organizationId: req.organization!.id,
            runId: r.view.run.id,
            confirm: parsed.data.confirm ?? null,
            // A key has no person behind it: it can never change a live business's records.
            operatorPermissions: req.hasOperator ? (req.operatorPermissions ?? null) : null,
            operatorUserId: req.hasOperator ? (req.operatorUserId ?? null) : null,
          });
          return reply.code(202).send(await sendRun(req, r.source.publicId, r.view.run.id));
        } catch (e) {
          return mapError(reply, e);
        }
      },
    );

  app.post(
    "/v1/businesses/:biz/transfer_configurations/:job/cancel",
    {
      preHandler: [authenticate, requirePerm("transfers:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      if (!(await requireAll(req, reply))) return;
      const r = await runOf(req, reply);
      if (!r) return;
      const parsed = parseRequest(z.object({}).strict(), req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        await cancelTransferRun(req.organization!.id, r.view.run.id);
        return await sendRun(req, r.source.publicId, r.view.run.id);
      } catch (e) {
        return mapError(reply, e);
      }
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

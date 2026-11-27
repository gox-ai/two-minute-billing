/**
 * The `export_run` job: read every file in one snapshot, write each as compressed parts,
 * then tell the member who started it. Safe to repeat: a run that is queued again starts
 * over and replaces its parts. A lease keeps it single; the clock re-queues a stalled run
 * and deletes files past their expiry.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { config } from "@/platform/config";
import { createLogger } from "@/platform/logger";
import { csvRow } from "@/platform/csv";
import { businesses, exportParts, exportRuns, users } from "@db/schema";
import { writeAuditLog } from "@/modules/audit/service";
import { emitEvent } from "@/modules/events/emit";
import { notPlatformOrg } from "@/modules/tenancy/platform-org";
import {
  chosenCountQuery,
  count,
  countQuery,
  EXPORT_ENTITIES,
  fileQuery,
  headerOf,
  invoiceRows,
  makeCtx,
  Skipped,
  toCells,
  type DbRow,
  type ExportEntity,
  type ExportFilters,
} from "./writers";
import {
  EXPORT_KEEP_DAYS,
  fileName,
  serializeExport,
  type ExportFileMeta,
  type ExportRunRow,
} from "./runs";
import { ExportTooLargeError, FileWriter } from "./zip";

const log = createLogger("bulk-export");

/** A heartbeat older than this means the runner died; the clock queues the run again. */
export const LEASE_STALE_MS = 5 * 60_000;
const PROGRESS_MS = 2_000;
const FETCH_ROWS = 1000;

async function loadRun(runId: string): Promise<ExportRunRow | null> {
  const [r] = await systemDb.select().from(exportRuns).where(eq(exportRuns.id, runId));
  return r ?? null;
}

async function lease(run: ExportRunRow, token: string): Promise<ExportRunRow | null> {
  return withTenant(run.organizationId, async (tx) => {
    const [r] = await tx
      .update(exportRuns)
      .set({
        leaseToken: token,
        heartbeatAt: new Date(),
        leaseCount: sql`${exportRuns.leaseCount} + 1`,
        status: "running",
        startedAt: sql`coalesce(${exportRuns.startedAt}, now())`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(exportRuns.id, run.id),
          inArray(exportRuns.status, ["queued", "running"]),
          or(
            isNull(exportRuns.leaseToken),
            lt(exportRuns.heartbeatAt, new Date(Date.now() - LEASE_STALE_MS)),
          ),
        ),
      )
      .returning();
    return r ?? null;
  });
}

export async function runExportJob(runId: string): Promise<string> {
  const head = await loadRun(runId);
  if (!head) return "missing";
  const token = randomUUID();
  const run = await lease(head, token);
  if (!run) return "busy_or_done";
  try {
    return await drive(run, token);
  } catch (e) {
    const message =
      e instanceof ExportTooLargeError
        ? e.message
        : "We could not finish the export. Export again, or contact support.";
    if (!(e instanceof ExportTooLargeError))
      log.error(e, { event: "export_run_failed", run: run.id });
    await withTenant(run.organizationId, (tx) =>
      tx.delete(exportParts).where(eq(exportParts.runId, run.id)),
    ).catch(() => {});
    await finish(run, token, { status: "failed", error: message });
    return "failed";
  }
}

async function drive(run: ExportRunRow, token: string): Promise<string> {
  const org = run.organizationId;
  // A repeat starts over.
  await withTenant(org, (tx) => tx.delete(exportParts).where(eq(exportParts.runId, run.id)));
  const asked = run.entities as ExportEntity[];
  const ctx = makeCtx({
    businessId: run.businessId,
    entities: asked,
    filters: run.filters as ExportFilters,
    includeRelated: run.includeRelated,
  });
  const files: ExportFileMeta[] = [];
  const skipped = new Map<string, { entity: string; reason: string; count: number }>();
  let snapshotAt = new Date();
  let lastBeat = 0;
  let written = 0;
  let total = 0;

  const beat = async (entity: string | null, force = false) => {
    if (!force && Date.now() - lastBeat < PROGRESS_MS) return;
    lastBeat = Date.now();
    const [ok] = await withTenant(org, (tx) =>
      tx
        .update(exportRuns)
        .set({
          heartbeatAt: new Date(),
          progress: { entity, done: written, rows: total },
          updatedAt: new Date(),
        })
        .where(and(eq(exportRuns.id, run.id), eq(exportRuns.leaseToken, token)))
        .returning({ id: exportRuns.id }),
    );
    if (!ok) throw new Error("export lease lost");
  };

  await withTenant(
    org,
    async (tx) => {
      const [now] = (await tx.execute(sql`select now() as at`)) as unknown as Array<{ at: Date }>;
      snapshotAt = new Date(now!.at);
      const plan: Array<{ entity: ExportEntity; rows: number; chosen: number }> = [];
      for (const e of EXPORT_ENTITIES) {
        if (!asked.includes(e) && !run.includeRelated) continue;
        const rows = await count(tx, countQuery(ctx, e));
        if (!asked.includes(e) && rows === 0) continue;
        const chosen = asked.includes(e) ? await count(tx, chosenCountQuery(ctx, e)) : 0;
        plan.push({ entity: e, rows, chosen });
        total += rows;
      }
      await beat(null, true);
      for (const p of plan) {
        const meta = await writeFile(
          tx,
          run,
          p.entity,
          ctx,
          async (n, reason) => {
            const k = `${p.entity}:${reason}`;
            const s = skipped.get(k) ?? { entity: p.entity, reason, count: 0 };
            s.count += n;
            skipped.set(k, s);
          },
          async (n) => {
            written += n;
            await beat(p.entity);
          },
        );
        // An empty file is left out: the import refuses a file with no rows.
        if (meta.rows === 0)
          await withTenant(org, (w) =>
            w
              .delete(exportParts)
              .where(and(eq(exportParts.runId, run.id), eq(exportParts.entity, p.entity))),
          );
        else files.push({ ...meta, related: Math.max(0, p.rows - p.chosen) });
      }
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );

  const size = files.reduce((n, f) => n + f.compressed, 0);
  const done = await finish(run, token, {
    status: "succeeded",
    files,
    skipped: [...skipped.values()],
    sizeBytes: size,
    snapshotAt,
  });
  return done ? "succeeded" : "lease_lost";
}

/** Writes one entity's file; returns its stored metadata. */
async function writeFile(
  tx: Tx,
  run: ExportRunRow,
  entity: ExportEntity,
  ctx: ReturnType<typeof makeCtx>,
  skip: (n: number, reason: string) => Promise<void>,
  progress: (n: number) => Promise<void>,
): Promise<Omit<ExportFileMeta, "related">> {
  const header = headerOf(entity);
  const writer = new FileWriter(async (seq, data) => {
    await withTenant(run.organizationId, (w) =>
      w.insert(exportParts).values({
        organizationId: run.organizationId,
        runId: run.id,
        entity,
        seq,
        data,
      }),
    );
  });
  // A BOM, so a spreadsheet reads the file as UTF-8. The import strips it.
  await writer.write(`﻿${csvRow(header)}\r\n`);
  let rows = 0;
  const line = (rec: Record<string, unknown>) =>
    csvRow(header.map((h) => (rec[h] as string | number | null | undefined) ?? null));

  const cursor = `export_${entity}`;
  await tx.execute(sql`declare ${sql.raw(cursor)} no scroll cursor for ${fileQuery(ctx, entity)}`);
  let carry: DbRow[] = [];
  for (;;) {
    const batch = (await tx.execute(
      sql.raw(`fetch forward ${FETCH_ROWS} from ${cursor}`),
    )) as unknown as DbRow[];
    const out: string[] = [];
    let units = batch.length;
    if (entity === "invoices") {
      // Lines of one invoice are adjacent; the last invoice of a batch may go on in the next.
      const all = [...carry, ...batch];
      const last = batch.length ? String(all[all.length - 1]!.id) : null;
      carry = batch.length ? all.filter((r) => String(r.id) === last) : [];
      const ready = batch.length ? all.filter((r) => String(r.id) !== last) : all;
      let group: DbRow[] = [];
      const flush = async () => {
        if (!group.length) return;
        const res = invoiceRows(group);
        if (res instanceof Skipped) await skip(1, res.reason);
        else for (const l of res) out.push(line(l));
        group = [];
      };
      units = 0;
      for (const r of ready) {
        if (group.length && String(group[0]!.id) !== String(r.id)) {
          await flush();
          units++;
        }
        group.push(r);
      }
      if (group.length) units++;
      await flush();
    } else {
      for (const r of batch) {
        const c = toCells(entity, r);
        if (c instanceof Skipped) await skip(1, c.reason);
        else out.push(line(c));
      }
    }
    if (out.length) await writer.write(`${out.join("\r\n")}\r\n`);
    rows += out.length;
    await progress(units);
    if (!batch.length) break;
  }
  await tx.execute(sql.raw(`close ${cursor}`));
  await writer.end();
  return {
    entity,
    name: fileName(entity),
    rows,
    crc: writer.crc,
    size: writer.size,
    compressed: writer.compressed,
    parts: writer.parts,
  };
}

async function finish(
  run: ExportRunRow,
  token: string,
  out:
    | { status: "failed"; error: string }
    | {
        status: "succeeded";
        files: ExportFileMeta[];
        skipped: Array<{ entity: string; reason: string; count: number }>;
        sizeBytes: number;
        snapshotAt: Date;
      },
): Promise<ExportRunRow | null> {
  const org = run.organizationId;
  const now = new Date();
  const done = await withTenant(org, async (tx) => {
    const [row] = await tx
      .update(exportRuns)
      .set({
        status: out.status,
        ...(out.status === "succeeded"
          ? {
              files: out.files,
              skipped: out.skipped,
              sizeBytes: out.sizeBytes,
              snapshotAt: out.snapshotAt,
              expiresAt: new Date(now.getTime() + EXPORT_KEEP_DAYS * 86_400_000),
              error: null,
            }
          : { error: out.error }),
        progress: null,
        finishedAt: now,
        leaseToken: null,
        updatedAt: now,
      })
      .where(and(eq(exportRuns.id, run.id), eq(exportRuns.leaseToken, token)))
      .returning();
    if (!row) return null;
    await writeAuditLog(
      {
        organizationId: org,
        businessId: run.businessId,
        action: "export.run",
        resourceType: "export",
        resourceId: run.id,
        after: {
          status: out.status,
          files:
            out.status === "succeeded"
              ? out.files.map((f) => ({ entity: f.entity, rows: f.rows }))
              : null,
          error: out.status === "failed" ? out.error : null,
        },
        actor: run.createdBy,
      },
      tx,
    );
    await emitEvent(tx, {
      organizationId: org,
      businessId: run.businessId,
      type: out.status === "succeeded" ? "export_completed" : "export_failed",
      data: { export: serializeExport(row) },
      resource: { type: "export", id: row.id },
    });
    return row;
  });
  if (done)
    await notifyExport(done).catch((e) =>
      log.error(e, { event: "export_notify_failed", run: run.id }),
    );
  return done;
}

/** Email the member who started the export, once. */
async function notifyExport(run: ExportRunRow) {
  if (!run.createdByUserId) return;
  const claimed = await withTenant(run.organizationId, (tx) =>
    tx
      .update(exportRuns)
      .set({ notifiedAt: new Date() })
      .where(and(eq(exportRuns.id, run.id), isNull(exportRuns.notifiedAt)))
      .returning({ id: exportRuns.id }),
  );
  if (!claimed.length) return;
  const [u] = await systemDb
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, run.createdByUserId));
  const [biz] = await systemDb.select().from(businesses).where(eq(businesses.id, run.businessId));
  if (!u?.email || !biz) return;
  const { resolveMailer } = await import("@/modules/emails/mailer-resolver");
  const { escapeHtml } = await import("@/modules/emails/sanitize");
  const base = (config.DASHBOARD_BASE_URL ?? "").replace(/\/$/, "");
  const url = `${base}/businesses/${biz.publicId}/imports?tab=export&export=${run.id}`;
  const ok = run.status === "succeeded";
  const rows = (run.files as ExportFileMeta[]).reduce((n, f) => n + f.rows, 0);
  const subject = ok ? `The export of ${biz.name} is ready` : `The export of ${biz.name} failed`;
  const lines = ok
    ? [
        `The export of ${biz.name} is ready: ${rows} rows in ${(run.files as ExportFileMeta[]).length} files.`,
        `To download it, open: ${url}`,
        `We delete the files after ${EXPORT_KEEP_DAYS} days.`,
      ]
    : [
        `The export of ${biz.name} failed. ${run.error ?? ""}`.trim(),
        `To export again, open: ${url}`,
      ];
  await resolveMailer(null).send({
    to: u.email,
    cc: null,
    from: config.MAIL_FROM,
    fromName: config.MAIL_FROM_NAME,
    subject,
    text: lines.join("\n\n"),
    html: lines.map((l) => `<p>${escapeHtml(l)}</p>`).join(""),
    idempotencyKey: `export_done:${run.id}`,
  });
}

/** Clock pass: re-queue an export whose runner stopped. */
export async function requeueStalledExports(now: Date): Promise<number> {
  const stale = new Date(now.getTime() - LEASE_STALE_MS);
  const rows = await systemDb
    .select({ id: exportRuns.id })
    .from(exportRuns)
    .where(
      and(
        inArray(exportRuns.status, ["queued", "running"]),
        // An ISO string, not a Date: a Date inside raw sql breaks the driver.
        sql`coalesce(${exportRuns.heartbeatAt}, ${exportRuns.queuedAt}, ${exportRuns.updatedAt}) < ${stale.toISOString()}::timestamptz`,
      ),
    );
  for (const r of rows)
    await systemDb.execute(
      sql`select graphile_worker.add_job('export_run', json_build_object('run', ${r.id}::text), max_attempts => 5, job_key => ${`export_run:${r.id}`})`,
    );
  return rows.length;
}

/** Clock pass: delete the files of exports past their expiry. The runs stay listed. */
export async function expireExports(now: Date): Promise<number> {
  const due = await systemDb
    .select({ id: exportRuns.id })
    .from(exportRuns)
    .where(
      and(
        eq(exportRuns.status, "succeeded"),
        sql`${exportRuns.expiresAt} < ${now.toISOString()}::timestamptz`,
        notPlatformOrg(exportRuns.organizationId),
      ),
    )
    .limit(200);
  for (const r of due) {
    await systemDb.delete(exportParts).where(eq(exportParts.runId, r.id));
    await systemDb
      .update(exportRuns)
      .set({ status: "expired", updatedAt: new Date() })
      .where(and(eq(exportRuns.id, r.id), eq(exportRuns.status, "succeeded")));
  }
  return due.length;
}

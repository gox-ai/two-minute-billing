/**
 * Bulk export runs: preview → start (job) → download → expire. Every write path is here;
 * the job is in `runner.ts`, the record types and their columns in `writers.ts`.
 */
import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import { createInflateRaw } from "node:zlib";
import { withTenant, type Tx } from "@/platform/db";
import { zonedDayStart } from "@/platform/timezones";
import { getTraceId } from "@/platform/trace";
import { currentEventContext } from "@/platform/event-context";
import { businesses, exportParts, exportRuns } from "@db/schema";
import { writeAuditLog } from "@/modules/audit/service";
import {
  chosenCountQuery,
  count,
  countQuery,
  EXPORT_ENTITIES,
  fileQuery,
  headerOf,
  INVOICE_STATUSES,
  invoiceRows,
  makeCtx,
  Skipped,
  PAYMENT_STATUSES,
  SUBSCRIPTION_STATUSES,
  toCells,
  type DbRow,
  type EntityFilter,
  type ExportEntity,
  type ExportFilters,
} from "./writers";
import { centralDirectory, localHeader, storeWhole, type StoredFile } from "./zip";

/** How long a finished export's files are kept. */
export const EXPORT_KEEP_DAYS = 7;
/** Rows a preview shows per record type. */
export const PREVIEW_ROWS = 10;

export class ExportError extends Error {}
export class ExportConflictError extends Error {}
export class ExportNotFoundError extends Error {}

export type ExportRunRow = typeof exportRuns.$inferSelect;
const actor = () => currentEventContext()?.actor ?? "system";

export interface ExportFileMeta extends StoredFile {
  entity: ExportEntity;
  rows: number;
  related: number;
  parts: number;
}

export interface ExportInput {
  entities: ExportEntity[];
  filters?: ExportFilters;
  include_related?: boolean;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/;

/** The asked-for entities in import order, and filters with only what applies to each. */
export function normalizeInput(
  input: ExportInput,
  /** The business's time zone: a date alone is midnight there, as the import reads dates. */
  tz: string | null = null,
): {
  entities: ExportEntity[];
  filters: ExportFilters;
  includeRelated: boolean;
} {
  const asked = [...new Set(input.entities ?? [])];
  const unknown = asked.find((e) => !EXPORT_ENTITIES.includes(e));
  if (unknown) throw new ExportError(`Unknown record type: ${unknown}.`);
  if (!asked.length) throw new ExportError("Select at least one record type.");
  const entities = EXPORT_ENTITIES.filter((e) => asked.includes(e));
  const filters: ExportFilters = {};
  for (const e of entities) {
    const f = input.filters?.[e];
    if (!f) continue;
    const out: EntityFilter = {};
    for (const k of ["from", "to"] as const) {
      const v = f[k];
      if (v == null || v === "") continue;
      if (!ISO.test(v) || Number.isNaN(new Date(v).getTime()))
        throw new ExportError(`${e}: ${k} is not a date. Use YYYY-MM-DD or an ISO 8601 instant.`);
      out[k] = (DAY.test(v) ? zonedDayStart(v, tz) : new Date(v)).toISOString();
    }
    if (out.from && out.to && out.from >= out.to)
      throw new ExportError(`${e}: the start date must be before the end date.`);
    const allowed =
      e === "subscriptions"
        ? SUBSCRIPTION_STATUSES
        : e === "invoices"
          ? INVOICE_STATUSES
          : e === "payments"
            ? PAYMENT_STATUSES
            : null;
    if (f.status?.length) {
      if (!allowed) throw new ExportError(`${e}: status is not a filter of this record type.`);
      const bad = f.status.find((s) => !(allowed as readonly string[]).includes(s));
      if (bad) throw new ExportError(`${e}: status ${bad} is not one of ${allowed.join(", ")}.`);
      out.status = [...new Set(f.status)];
    }
    if (f.dateField) {
      if (e !== "customers" && e !== "subscriptions")
        throw new ExportError(`${e}: date_field is a filter of customers and subscriptions only.`);
      out.dateField = f.dateField;
    }
    if (f.includeArchived != null) {
      if (e !== "plans" && e !== "addons" && e !== "coupons")
        throw new ExportError(`${e}: include_archived is a filter of plans, add-ons and coupons.`);
      out.includeArchived = !!f.includeArchived;
    }
    filters[e] = out;
  }
  if (entities.includes("usage") && !filters.usage?.from)
    throw new ExportError("usage: select a start date. Usage can be very large.");
  return { entities, filters, includeRelated: input.include_related ?? true };
}

async function businessTz(organizationId: string, businessId: string): Promise<string | null> {
  const [b] = await withTenant(organizationId, (tx) =>
    tx.select({ tz: businesses.timezone }).from(businesses).where(eq(businesses.id, businessId)),
  );
  return b?.tz ?? null;
}

async function queueJob(tx: Tx, runId: string) {
  await tx.execute(
    sql`select public.app_queue_export_job(${runId}::uuid, ${getTraceId() ?? null})`,
  );
}

/** Rows per file, and a sample of the first rows exactly as the file will have them. */
export async function previewExport(
  organizationId: string,
  businessId: string,
  input: ExportInput,
): Promise<{
  object: "export_preview";
  include_related: boolean;
  files: Array<{
    entity: ExportEntity;
    rows: number;
    chosen: number;
    related: number;
    columns: string[];
    sample: string[][];
  }>;
}> {
  const tz = await businessTz(organizationId, businessId);
  const n = normalizeInput(input, tz);
  const ctx = makeCtx({ businessId, ...n });
  return withTenant(
    organizationId,
    async (tx) => {
      const files = [];
      for (const e of EXPORT_ENTITIES) {
        if (!n.entities.includes(e) && !n.includeRelated) continue;
        const rows = await count(tx, countQuery(ctx, e));
        if (!n.entities.includes(e) && rows === 0) continue;
        const chosen = n.entities.includes(e) ? await count(tx, chosenCountQuery(ctx, e)) : 0;
        const sample = await sampleRows(tx, fileQuery(ctx, e), e);
        files.push({
          entity: e,
          rows,
          chosen,
          related: Math.max(0, rows - chosen),
          columns: headerOf(e),
          sample,
        });
      }
      return { object: "export_preview" as const, include_related: n.includeRelated, files };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

async function sampleRows(tx: Tx, q: SQL, e: ExportEntity): Promise<string[][]> {
  const header = headerOf(e);
  const rows = (await tx.execute(
    sql`select * from (${q}) x limit ${e === "invoices" ? 200 : PREVIEW_ROWS}`,
  )) as unknown as DbRow[];
  const out: string[][] = [];
  const cellsOf = (rec: Record<string, unknown>) =>
    header.map((h) => (rec[h] == null ? "" : String(rec[h])));
  if (e === "invoices") {
    const groups = new Map<string, DbRow[]>();
    for (const r of rows) {
      const k = String(r.id);
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    for (const g of groups.values()) {
      const lines = invoiceRows(g);
      if (lines instanceof Skipped) continue;
      for (const l of lines) if (out.length < PREVIEW_ROWS) out.push(cellsOf(l));
    }
    return out;
  }
  for (const r of rows) {
    const c = toCells(e, r);
    if (!(c instanceof Skipped)) out.push(cellsOf(c));
  }
  return out;
}

export async function createExportRun(input: {
  organizationId: string;
  businessId: string;
  body: ExportInput;
  operatorUserId?: string | null;
}): Promise<ExportView> {
  const n = normalizeInput(input.body, await businessTz(input.organizationId, input.businessId));
  return withTenant(input.organizationId, async (tx) => {
    const [busy] = await tx
      .select({ id: exportRuns.id })
      .from(exportRuns)
      .where(
        and(
          eq(exportRuns.businessId, input.businessId),
          sql`${exportRuns.status} in ('queued', 'running')`,
        ),
      );
    if (busy)
      throw new ExportConflictError(
        "An export of this business is in progress. Wait for it to end, then export again.",
      );
    const [run] = await tx
      .insert(exportRuns)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        status: "queued",
        entities: n.entities,
        filters: n.filters,
        includeRelated: n.includeRelated,
        createdBy: actor(),
        createdByUserId: input.operatorUserId ?? null,
        queuedAt: new Date(),
      })
      .returning();
    await writeAuditLog(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        action: "export.start",
        resourceType: "export",
        resourceId: run!.id,
        after: { entities: n.entities, filters: n.filters, include_related: n.includeRelated },
      },
      tx,
    );
    await queueJob(tx, run!.id);
    return serializeExport(run!);
  });
}

export async function getExportRun(
  organizationId: string,
  businessId: string,
  runId: string,
): Promise<ExportView> {
  return withTenant(organizationId, async (tx) =>
    serializeExport(await loadRun(tx, businessId, runId)),
  );
}

async function loadRun(tx: Tx, businessId: string, runId: string): Promise<ExportRunRow> {
  const [r] = await tx
    .select()
    .from(exportRuns)
    .where(and(eq(exportRuns.id, runId), eq(exportRuns.businessId, businessId)));
  if (!r) throw new ExportNotFoundError(`No such export: ${runId}`);
  return r;
}

export async function listExportRuns(
  organizationId: string,
  businessId: string,
  opts: { limit?: number; startingAfter?: string } = {},
): Promise<{ data: ExportView[]; has_more: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  return withTenant(organizationId, async (tx) => {
    const conds: SQL[] = [eq(exportRuns.businessId, businessId)];
    if (opts.startingAfter) conds.push(lt(exportRuns.id, opts.startingAfter));
    const rows = await tx
      .select()
      .from(exportRuns)
      .where(and(...conds))
      .orderBy(desc(exportRuns.id))
      .limit(limit + 1);
    return { data: rows.slice(0, limit).map(serializeExport), has_more: rows.length > limit };
  });
}

/** Delete a finished export's files now. The run stays in the list. */
export async function deleteExportRun(
  organizationId: string,
  businessId: string,
  runId: string,
): Promise<ExportView> {
  return withTenant(organizationId, async (tx) => {
    const run = await loadRun(tx, businessId, runId);
    if (run.status === "queued" || run.status === "running")
      throw new ExportConflictError(
        "This export is in progress. Wait for it to end, then delete it.",
      );
    if (run.status === "deleted" || run.status === "expired") return serializeExport(run);
    await tx.delete(exportParts).where(eq(exportParts.runId, run.id));
    const [row] = await tx
      .update(exportRuns)
      .set({ status: "deleted", deletedAt: new Date(), deletedBy: actor(), updatedAt: new Date() })
      .where(eq(exportRuns.id, run.id))
      .returning();
    await writeAuditLog(
      {
        organizationId,
        businessId,
        action: "export.delete",
        resourceType: "export",
        resourceId: run.id,
      },
      tx,
    );
    return serializeExport(row!);
  });
}

/** A run whose files can be downloaded, or why not. */
async function downloadable(organizationId: string, businessId: string, runId: string) {
  return withTenant(organizationId, async (tx) => {
    const run = await loadRun(tx, businessId, runId);
    if (run.status !== "succeeded")
      throw new ExportConflictError(
        run.status === "expired" || run.status === "deleted"
          ? "The files of this export were deleted. Export again."
          : run.status === "failed"
            ? "This export failed. Export again."
            : "This export is not ready. Wait for it to end.",
      );
    const [biz] = await tx
      .select({ publicId: businesses.publicId, name: businesses.name })
      .from(businesses)
      .where(eq(businesses.id, businessId));
    return { run, biz: biz! };
  });
}

async function* parts(organizationId: string, runId: string, entity: string) {
  for (let seq = 0; ; seq++) {
    const [p] = await withTenant(organizationId, (tx) =>
      tx
        .select({ data: exportParts.data })
        .from(exportParts)
        .where(
          and(
            eq(exportParts.runId, runId),
            eq(exportParts.entity, entity),
            eq(exportParts.seq, seq),
          ),
        ),
    );
    if (!p) return;
    yield Buffer.from(p.data);
  }
}

export function fileName(entity: string) {
  return `${entity}.csv`;
}

export function zipName(bizPublicId: string, run: ExportRunRow) {
  const day = (run.snapshotAt ?? run.createdAt).toISOString().slice(0, 10);
  return `export-${bizPublicId}-${day}.zip`;
}

/** The README inside the zip: what it holds and how to import it. */
export function readmeText(run: ExportRunRow, bizName: string): string {
  const files = run.files as ExportFileMeta[];
  const skipped = run.skipped as Array<{ entity: string; reason: string; count: number }>;
  return [
    `Export of ${bizName}`,
    `Taken at ${(run.snapshotAt ?? run.createdAt).toISOString()} (UTC). All files are from this one moment.`,
    "",
    "Files:",
    ...files.map(
      (f) =>
        `- ${f.name}: ${f.rows} rows${f.related ? ` (${f.related} added because other rows refer to them)` : ""}`,
    ),
    ...(() => {
      const none = (run.entities as string[]).filter((e) => !files.some((f) => f.entity === e));
      return none.length ? ["", `No rows to export: ${none.join(", ")}.`] : [];
    })(),
    "",
    "The columns are the columns the file import reads, then read-only columns that it ignores.",
    "Amounts are in the currency's main unit. Dates and times are ISO 8601 in UTC.",
    "To import into another business: Settings > Import data, upload these files.",
    "Usage imports only into a business that has the same usage prices.",
    ...(skipped.length
      ? ["", "Left out:", ...skipped.map((s) => `- ${s.entity}: ${s.count} (${s.reason})`)]
      : []),
    "",
  ].join("\r\n");
}

/** The zip, assembled from the stored parts. */
export async function exportZip(organizationId: string, businessId: string, runId: string) {
  const { run, biz } = await downloadable(organizationId, businessId, runId);
  const files = run.files as ExportFileMeta[];
  const readme = storeWhole(readmeText(run, biz.name));
  const at = run.snapshotAt ?? run.createdAt;
  const entries: Array<StoredFile & { offset: number; entity: string | null }> = [];
  let offset = 0;
  for (const f of [
    {
      name: "README.txt",
      crc: readme.crc,
      size: readme.size,
      compressed: readme.data.length,
      entity: null,
    },
    ...files.map((f) => ({ ...f, entity: f.entity as string | null })),
  ]) {
    entries.push({ ...f, offset });
    offset += localHeader(f, at).length + f.compressed;
  }
  const size = offset + centralDirectory(entries, at, offset).length;
  async function* body() {
    for (const e of entries) {
      yield localHeader(e, at);
      if (e.entity == null) yield readme.data;
      else yield* parts(organizationId, run.id, e.entity);
    }
    yield centralDirectory(entries, at, offset);
  }
  return { name: zipName(biz.publicId, run), size, body: body(), run };
}

/** One CSV of the export, inflated from its parts. */
export async function exportFile(
  organizationId: string,
  businessId: string,
  runId: string,
  entity: string,
) {
  const { run } = await downloadable(organizationId, businessId, runId);
  const f = (run.files as ExportFileMeta[]).find((x) => x.entity === entity);
  if (!f) throw new ExportNotFoundError(`This export has no ${entity} file.`);
  async function* body() {
    const inflate = createInflateRaw();
    const out: Buffer[] = [];
    inflate.on("data", (b: Buffer) => out.push(b));
    for await (const p of parts(organizationId, run.id, entity)) {
      await new Promise<void>((res, rej) => inflate.write(p, (e) => (e ? rej(e) : res())));
      while (out.length) yield out.shift()!;
    }
    await new Promise<void>((res) => inflate.end(res));
    while (out.length) yield out.shift()!;
  }
  return { name: fileName(entity), size: f.size, body: body(), run };
}

export async function auditDownload(
  organizationId: string,
  businessId: string,
  runId: string,
  what: string,
) {
  await withTenant(organizationId, (tx) =>
    writeAuditLog(
      {
        organizationId,
        businessId,
        action: "export.download",
        resourceType: "export",
        resourceId: runId,
        after: { file: what },
      },
      tx,
    ),
  );
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export interface ExportView {
  object: "export";
  id: string;
  status: string;
  entities: ExportEntity[];
  filters: ExportFilters;
  include_related: boolean;
  files: Array<{
    entity: ExportEntity;
    name: string;
    rows: number;
    related: number;
    bytes: number;
  }>;
  skipped: Array<{ entity: string; reason: string; count: number }>;
  progress: { entity: string | null; done: number; rows: number } | null;
  size_bytes: number;
  error: string | null;
  created_by: string | null;
  created_at: string;
  snapshot_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  expires_at: string | null;
  deleted_at: string | null;
}

export function serializeExport(r: ExportRunRow): ExportView {
  return {
    object: "export",
    id: r.id,
    status: r.status,
    entities: r.entities as ExportEntity[],
    filters: r.filters as ExportFilters,
    include_related: r.includeRelated,
    files: (r.files as ExportFileMeta[]).map((f) => ({
      entity: f.entity,
      name: f.name,
      rows: f.rows,
      related: f.related,
      bytes: f.size,
    })),
    skipped: r.skipped as ExportView["skipped"],
    progress: (r.progress as ExportView["progress"]) ?? null,
    size_bytes: r.sizeBytes,
    error: r.error,
    created_by: r.createdBy,
    created_at: r.createdAt.toISOString(),
    snapshot_at: iso(r.snapshotAt),
    started_at: iso(r.startedAt),
    finished_at: iso(r.finishedAt),
    expires_at: iso(r.expiresAt),
    deleted_at: iso(r.deletedAt),
  };
}

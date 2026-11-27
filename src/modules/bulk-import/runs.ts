/**
 * File import runs: upload → check (job) → review → start (job) → results → undo (job).
 * Every write path is here; the jobs are in `runner.ts`, the rules in `check.ts`.
 */
import { and, asc, desc, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { getTraceId } from "@/platform/trace";
import { currentEventContext } from "@/platform/event-context";
import { minorToDecimalString } from "@/platform/currency";
import { csvRow } from "@/platform/csv";
import { businesses, importRows, importRuns } from "@db/schema";
import { writeAuditLog } from "@/modules/audit/service";
import { migrationFileSchema } from "@/modules/migration/json-file";
import { CsvParseError, parseCsv } from "./csv-parse";
import {
  autoMap,
  ENTITY_FIELDS,
  IMPORT_ENTITIES,
  type ColumnMapping,
  type ImportEntity,
} from "./templates";
import type { CheckSummary, RunFile, RunOptions } from "./check";
import { undoBlockers } from "./undo";

/** Rows per file. Measured before raising: see the module README. */
export const MAX_ROWS_PER_FILE = 50_000;
const INSERT_CHUNK = 500;

export class ImportError extends Error {}
export class ImportConflictError extends Error {
  constructor(
    message: string,
    readonly reasons: Array<{ code: string; message: string; count?: number }> = [],
  ) {
    super(message);
  }
}
export class ImportNotFoundError extends Error {}

export type RunRow = typeof importRuns.$inferSelect;
const actor = () => currentEventContext()?.actor ?? "system";

/** `import_records.source` for file imports into this business: re-runs match on it. */
export const fileSourceName = (businessPublicId: string) => `file:${businessPublicId}`;

export interface UploadFile {
  /** A CSV for one entity, or `json`: our JSON file (plans, customers, subscriptions). */
  entity: ImportEntity | "json";
  filename: string;
  content: string;
}

interface StagedFile {
  file: RunFile;
  rows: Array<Record<string, string>>;
}

/** A JSON file as the three CSV files it is equal to. Amounts become decimals again. */
function jsonAsFiles(f: UploadFile): StagedFile[] {
  let data: unknown;
  try {
    data = JSON.parse(f.content);
  } catch {
    throw new ImportError(`${f.filename}: the file is not valid JSON.`);
  }
  const parsed = migrationFileSchema.safeParse(data);
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    throw new ImportError(`${f.filename}: ${i.path.join(".")}: ${i.message}`);
  }
  const d = parsed.data;
  const s = (v: unknown) => (v == null ? "" : String(v));
  const asFile = (entity: ImportEntity, rows: Array<Record<string, string>>): StagedFile => {
    const headers = ENTITY_FIELDS[entity].map((x) => x.key);
    return {
      file: {
        entity,
        filename: `${f.filename} (${entity})`,
        headers,
        mapping: Object.fromEntries(headers.map((h) => [h, h])),
        rows: rows.length,
      },
      rows,
    };
  };
  return [
    asFile(
      "plans",
      d.plans.map((p) => ({
        price_id: p.id,
        plan_id: p.id,
        name: p.name,
        amount: minorToDecimalString(BigInt(p.amountMinor), p.currency.toUpperCase()),
        currency: p.currency,
        interval: p.interval,
        interval_count: s(p.intervalCount),
        created_at: s(p.createdAt),
      })),
    ),
    asFile(
      "customers",
      d.customers.map((c) => ({
        customer_id: c.id,
        email: s(c.email),
        name: s(c.name),
        payment_gateway: s(c.paymentMethod?.provider),
        gateway_customer_id: s(c.paymentMethod?.providerCustomerId),
        gateway_payment_method_id: s(c.paymentMethod?.providerPaymentMethodId),
        card_brand: s(c.paymentMethod?.brand),
        card_last4: s(c.paymentMethod?.last4),
        card_exp_month: s(c.paymentMethod?.expMonth),
        card_exp_year: s(c.paymentMethod?.expYear),
        created_at: s(c.createdAt),
      })),
    ),
    asFile(
      "subscriptions",
      d.subscriptions.map((x) => ({
        subscription_id: x.id,
        customer_id: x.customerId,
        price_id: x.planId,
        quantity: s(x.quantity),
        status: s(x.status),
        currency: s(x.currency),
        current_term_start: s(x.currentTermStart),
        current_term_end: x.currentTermEnd,
        trial_end: s(x.trialEnd),
        created_at: s(x.createdAt),
      })),
    ),
  ].filter((x) => x.rows.length);
}

function csvAsFile(f: UploadFile & { entity: ImportEntity }, mapping?: ColumnMapping): StagedFile {
  let parsed;
  try {
    parsed = parseCsv(f.content, { maxRows: MAX_ROWS_PER_FILE });
  } catch (e) {
    if (e instanceof CsvParseError) throw new ImportError(`${f.filename}: ${e.message}`);
    throw e;
  }
  const { headers, rows } = parsed;
  if (new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length)
    throw new ImportError(`${f.filename}: two columns have the same name.`);
  if (!rows.length) throw new ImportError(`${f.filename}: the file has no rows.`);
  const map = { ...autoMap(f.entity, headers), ...validMapping(f.entity, headers, mapping) };
  return {
    file: { entity: f.entity, filename: f.filename, headers, mapping: map, rows: rows.length },
    rows: rows.map((cells) => {
      const raw: Record<string, string> = {};
      headers.forEach((h, i) => {
        if (h) raw[h] = cells[i] ?? "";
      });
      const extra = cells.slice(headers.length).some((c) => c.trim() !== "");
      if (extra) raw.__extra = "1";
      return raw;
    }),
  };
}

/** A caller's mapping, checked: known headers, known fields, each field once. */
function validMapping(
  entity: ImportEntity,
  headers: string[],
  mapping?: ColumnMapping,
): ColumnMapping {
  if (!mapping) return {};
  const keys = new Set(ENTITY_FIELDS[entity].map((f) => f.key));
  const used = new Set<string>();
  for (const [h, k] of Object.entries(mapping)) {
    if (!headers.includes(h)) throw new ImportError(`The ${entity} file has no column "${h}".`);
    if (k == null) continue;
    if (!keys.has(k)) throw new ImportError(`"${k}" is not a field of the ${entity} file.`);
    if (used.has(k))
      throw new ImportError(`Two columns of the ${entity} file are mapped to "${k}".`);
    used.add(k);
  }
  return mapping;
}

/** A full mapping for a re-check: the auto-mapped one with the caller's changes over it. */
function remap(file: RunFile, changes?: ColumnMapping): ColumnMapping {
  if (!changes) return file.mapping;
  const merged = { ...file.mapping, ...validMapping(file.entity, file.headers, changes) };
  // A field moved to another column leaves its old column.
  const seen = new Map<string, string>();
  for (const [h, k] of Object.entries(changes)) if (k) seen.set(k, h);
  for (const [h, k] of Object.entries(merged))
    if (k && seen.has(k) && seen.get(k) !== h) merged[h] = null;
  return merged;
}

async function queueJob(
  tx: Tx,
  task: "import_check" | "import_run" | "import_undo",
  runId: string,
) {
  await tx.execute(
    sql`select public.app_queue_import_job(${task}, ${runId}::uuid, ${getTraceId() ?? null})`,
  );
}

async function businessRow(tx: Tx, businessId: string) {
  const [b] = await tx
    .select({
      id: businesses.id,
      publicId: businesses.publicId,
      name: businesses.name,
      livemode: businesses.livemode,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId));
  if (!b) throw new ImportNotFoundError("No such business.");
  return b;
}

async function lockRun(tx: Tx, businessId: string, runId: string): Promise<RunRow> {
  const [r] = await tx
    .select()
    .from(importRuns)
    .where(and(eq(importRuns.id, runId), eq(importRuns.businessId, businessId)))
    .for("update");
  if (!r) throw new ImportNotFoundError(`No such import: ${runId}`);
  return r;
}

export async function createImportRun(input: {
  organizationId: string;
  businessId: string;
  files: UploadFile[];
  mapping?: Partial<Record<ImportEntity, ColumnMapping>>;
  options?: RunOptions;
  operatorUserId?: string | null;
}): Promise<RunView> {
  if (!input.files.length) throw new ImportError("Upload at least one file.");
  const staged: StagedFile[] = [];
  for (const f of input.files) {
    if (f.entity === "json") staged.push(...jsonAsFiles(f));
    else
      staged.push(csvAsFile(f as UploadFile & { entity: ImportEntity }, input.mapping?.[f.entity]));
  }
  const entities = staged.map((s) => s.file.entity);
  const dup = entities.find((e, i) => entities.indexOf(e) !== i);
  if (dup) throw new ImportError(`Upload one ${dup} file per import.`);
  staged.sort(
    (a, b) => IMPORT_ENTITIES.indexOf(a.file.entity) - IMPORT_ENTITIES.indexOf(b.file.entity),
  );

  return withTenant(input.organizationId, async (tx) => {
    const biz = await businessRow(tx, input.businessId);
    const [run] = await tx
      .insert(importRuns)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        status: "checking",
        sourceName: fileSourceName(biz.publicId),
        files: staged.map((s) => s.file),
        options: input.options ?? {},
        createdBy: actor(),
        createdByUserId: input.operatorUserId ?? null,
      })
      .returning();
    for (const s of staged)
      for (let i = 0; i < s.rows.length; i += INSERT_CHUNK)
        await tx.insert(importRows).values(
          s.rows.slice(i, i + INSERT_CHUNK).map((raw, j) => ({
            organizationId: input.organizationId,
            runId: run!.id,
            entity: s.file.entity,
            rowNumber: i + j + 1,
            raw,
          })),
        );
    await writeAuditLog(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        action: "import.upload",
        resourceType: "import",
        resourceId: run!.id,
        after: {
          files: staged.map((s) => ({
            entity: s.file.entity,
            filename: s.file.filename,
            rows: s.file.rows,
          })),
        },
      },
      tx,
    );
    await queueJob(tx, "import_check", run!.id);
    return serializeRun(run!);
  });
}

/** Check again with a changed mapping or options. Only before the run starts. */
export async function recheckImportRun(input: {
  organizationId: string;
  businessId: string;
  runId: string;
  mapping?: Partial<Record<ImportEntity, ColumnMapping>>;
  options?: RunOptions;
}): Promise<RunView> {
  return withTenant(input.organizationId, async (tx) => {
    const run = await lockRun(tx, input.businessId, input.runId);
    if (!["uploaded", "checked"].includes(run.status))
      throw new ImportConflictError(
        `This import is ${run.status}. You can change it only before it starts.`,
      );
    const files = (run.files as RunFile[]).map((f) => ({
      ...f,
      mapping: remap(f, input.mapping?.[f.entity]),
    }));
    const [row] = await tx
      .update(importRuns)
      .set({
        files,
        options: input.options ?? (run.options as RunOptions),
        status: "checking",
        summary: null,
        updatedAt: new Date(),
      })
      .where(eq(importRuns.id, run.id))
      .returning();
    await queueJob(tx, "import_check", run.id);
    return serializeRun(row!);
  });
}

/**
 * Start a checked run. A live business needs `confirm` equal to its name. The summary must
 * have no blockers; the runner checks the rows again before it writes.
 */
export async function startImportRun(input: {
  organizationId: string;
  businessId: string;
  runId: string;
  confirm?: string;
  operatorUserId?: string | null;
}): Promise<RunView> {
  return withTenant(input.organizationId, async (tx) => {
    const run = await lockRun(tx, input.businessId, input.runId);
    const biz = await businessRow(tx, input.businessId);
    if (run.status !== "checked")
      throw new ImportConflictError(
        run.status === "checking"
          ? "The check is not complete. Try again when it ends."
          : `This import is ${run.status}. You can start only a checked import.`,
      );
    const summary = run.summary as CheckSummary | null;
    if (!summary?.ready)
      throw new ImportConflictError(
        "Correct the problems that the check found first.",
        summary?.blockers ?? [],
      );
    if (biz.livemode === "live" && input.confirm?.trim() !== biz.name)
      throw new ImportError(`Type the business name, ${biz.name}, to import into a live business.`);
    const busy = await tx
      .select({ id: importRuns.id })
      .from(importRuns)
      .where(
        and(
          eq(importRuns.businessId, input.businessId),
          inArray(importRuns.status, ["queued", "running", "undoing"]),
        ),
      )
      .limit(1);
    if (busy.length)
      throw new ImportConflictError(
        "Another import into this business is in progress. Try again when it ends.",
      );
    const [row] = await tx
      .update(importRuns)
      .set({
        status: "queued",
        queuedAt: new Date(),
        startedBy: actor(),
        startedByUserId: input.operatorUserId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(importRuns.id, run.id))
      .returning();
    await writeAuditLog(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        action: "import.start",
        resourceType: "import",
        resourceId: run.id,
        after: {
          entities: summary.entities,
          subscriptions: summary.subscriptions,
          livemode: biz.livemode,
        },
      },
      tx,
    );
    await queueJob(tx, "import_run", run.id);
    return serializeRun(row!);
  });
}

/** Undo a finished run: refused once any record it created has billing activity. */
export async function undoImportRun(input: {
  organizationId: string;
  businessId: string;
  runId: string;
  confirm?: string;
  operatorUserId?: string | null;
}): Promise<RunView> {
  return withTenant(input.organizationId, async (tx) => {
    const run = await lockRun(tx, input.businessId, input.runId);
    const biz = await businessRow(tx, input.businessId);
    if (!["succeeded", "partially_failed", "failed"].includes(run.status))
      throw new ImportConflictError(
        `This import is ${run.status}. You can undo only a finished import.`,
      );
    if (biz.livemode === "live" && input.confirm?.trim() !== biz.name)
      throw new ImportError(
        `Type the business name, ${biz.name}, to undo an import in a live business.`,
      );
    const reasons = await undoBlockers(tx, run);
    if (reasons.length)
      throw new ImportConflictError(
        "You cannot undo this import. Records it created are in use.",
        reasons,
      );
    const [row] = await tx
      .update(importRuns)
      .set({
        status: "undoing",
        undoneBy: actor(),
        undoneByUserId: input.operatorUserId ?? null,
        undoNotifiedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(importRuns.id, run.id))
      .returning();
    await queueJob(tx, "import_undo", run.id);
    return serializeRun(row!);
  });
}

/** What would stop an undo now: shown on the run before the operator asks. */
export async function importUndoCheck(organizationId: string, businessId: string, runId: string) {
  return withTenant(organizationId, async (tx) => {
    const [run] = await tx
      .select()
      .from(importRuns)
      .where(and(eq(importRuns.id, runId), eq(importRuns.businessId, businessId)));
    if (!run) throw new ImportNotFoundError(`No such import: ${runId}`);
    if (!["succeeded", "partially_failed", "failed"].includes(run.status)) return null;
    return undoBlockers(tx, run);
  });
}

/** Throw away a run that has not started. Its rows go with it. */
export async function discardImportRun(
  organizationId: string,
  businessId: string,
  runId: string,
): Promise<RunView> {
  return withTenant(organizationId, async (tx) => {
    const run = await lockRun(tx, businessId, runId);
    if (!["uploaded", "checking", "checked"].includes(run.status))
      throw new ImportConflictError(
        `This import is ${run.status}. You can discard only an import that has not started.`,
      );
    await tx.delete(importRows).where(eq(importRows.runId, run.id));
    const [row] = await tx
      .update(importRuns)
      .set({ status: "discarded", summary: null, updatedAt: new Date() })
      .where(eq(importRuns.id, run.id))
      .returning();
    return serializeRun(row!);
  });
}

export async function getImportRun(
  organizationId: string,
  businessId: string,
  runId: string,
): Promise<RunView> {
  return withTenant(organizationId, async (tx) => {
    const [run] = await tx
      .select()
      .from(importRuns)
      .where(and(eq(importRuns.id, runId), eq(importRuns.businessId, businessId)));
    if (!run) throw new ImportNotFoundError(`No such import: ${runId}`);
    return serializeRun(run);
  });
}

export async function listImportRuns(
  organizationId: string,
  businessId: string,
  opts: { limit?: number; startingAfter?: string } = {},
): Promise<{ data: RunView[]; has_more: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  return withTenant(organizationId, async (tx) => {
    const conds: SQL[] = [
      eq(importRuns.businessId, businessId),
      sql`${importRuns.status} <> 'discarded'`,
    ];
    if (opts.startingAfter) conds.push(lt(importRuns.id, opts.startingAfter));
    const rows = await tx
      .select()
      .from(importRuns)
      .where(and(...conds))
      .orderBy(desc(importRuns.id))
      .limit(limit + 1);
    return { data: rows.slice(0, limit).map(serializeRun), has_more: rows.length > limit };
  });
}

export async function listImportRows(
  organizationId: string,
  businessId: string,
  runId: string,
  opts: {
    entity?: ImportEntity;
    state?: "new" | "existing" | "invalid" | "excluded";
    outcome?: "created" | "unchanged" | "failed" | "excluded";
    limit?: number;
    startingAfter?: string;
  } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  return withTenant(organizationId, async (tx) => {
    const [run] = await tx
      .select({ id: importRuns.id })
      .from(importRuns)
      .where(and(eq(importRuns.id, runId), eq(importRuns.businessId, businessId)));
    if (!run) throw new ImportNotFoundError(`No such import: ${runId}`);
    const conds: SQL[] = [eq(importRows.runId, runId)];
    if (opts.entity) conds.push(eq(importRows.entity, opts.entity));
    if (opts.state) conds.push(eq(importRows.state, opts.state));
    if (opts.outcome) conds.push(eq(importRows.outcome, opts.outcome));
    // File order, by (entity, row number): ids are uuid v7, random within one insert.
    if (opts.startingAfter) {
      const [after] = await tx
        .select({ entity: importRows.entity, rowNumber: importRows.rowNumber })
        .from(importRows)
        .where(and(eq(importRows.runId, runId), eq(importRows.id, opts.startingAfter)));
      if (!after) throw new ImportError(`No such row in this import: ${opts.startingAfter}`);
      conds.push(
        sql`(${importRows.entity}, ${importRows.rowNumber}) > (${after.entity}, ${after.rowNumber})`,
      );
    }
    const rows = await tx
      .select()
      .from(importRows)
      .where(and(...conds))
      .orderBy(asc(importRows.entity), asc(importRows.rowNumber))
      .limit(limit + 1);
    return { data: rows.slice(0, limit).map(serializeRow), has_more: rows.length > limit };
  });
}

/**
 * One file of the run as CSV: its own columns, then `import_errors` (each issue as
 * "column: message", separated by " | ") and, after the run, `import_result`.
 * Correct the errors in this file and upload it again.
 */
export async function importRowsCsv(
  organizationId: string,
  businessId: string,
  runId: string,
  entity: ImportEntity,
): Promise<{ filename: string; csv: string }> {
  return withTenant(organizationId, async (tx) => {
    const [run] = await tx
      .select()
      .from(importRuns)
      .where(and(eq(importRuns.id, runId), eq(importRuns.businessId, businessId)));
    if (!run) throw new ImportNotFoundError(`No such import: ${runId}`);
    const file = (run.files as RunFile[]).find((f) => f.entity === entity);
    if (!file) throw new ImportNotFoundError(`This import has no ${entity} file.`);
    const rows = await tx
      .select()
      .from(importRows)
      .where(and(eq(importRows.runId, runId), eq(importRows.entity, entity)))
      .orderBy(asc(importRows.rowNumber));
    const ran = rows.some((r) => r.outcome != null);
    const head = [...file.headers, "import_errors", ...(ran ? ["import_result"] : [])];
    const lines = [csvRow(head)];
    for (const r of rows) {
      const raw = r.raw as Record<string, string>;
      const issues = [...(r.errors as Issue[]), ...(r.warnings as Issue[])]
        .map((e) => (e.column ? `${e.column}: ${e.message}` : e.message))
        .join(" | ");
      const result = r.outcome
        ? [r.outcomeMessage ? `${r.outcome}: ${r.outcomeMessage}` : r.outcome]
        : [];
      lines.push(
        csvRow([...file.headers.map((h) => raw[h] ?? ""), issues, ...(ran ? result : [])]),
      );
    }
    const base = file.filename.replace(/\.(csv|json)$/i, "").replace(/[^\w.-]+/g, "-");
    return {
      filename: `${base}-${ran ? "results" : "errors"}.csv`,
      csv: `${lines.join("\r\n")}\r\n`,
    };
  });
}

interface Issue {
  column: string | null;
  field: string | null;
  message: string;
}

export interface RunView {
  object: "import";
  id: string;
  status: string;
  files: Array<RunFile & { missing_required: string[] }>;
  options: RunOptions;
  summary: CheckSummary | null;
  result: unknown;
  error: string | null;
  created_by: string | null;
  started_by: string | null;
  undone_by: string | null;
  created_at: string;
  checked_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  undone_at: string | null;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

export function serializeRun(r: RunRow): RunView {
  return {
    object: "import",
    id: r.id,
    status: r.status,
    files: (r.files as RunFile[]).map((f) => ({
      ...f,
      missing_required: ENTITY_FIELDS[f.entity]
        .filter((x) => x.required && !Object.values(f.mapping).includes(x.key))
        .map((x) => x.key),
    })),
    options: r.options as RunOptions,
    summary: (r.summary as CheckSummary | null) ?? null,
    result: r.result ?? null,
    error: r.error,
    created_by: r.createdBy,
    started_by: r.startedBy,
    undone_by: r.undoneBy,
    created_at: r.createdAt.toISOString(),
    checked_at: iso(r.checkedAt),
    started_at: iso(r.startedAt),
    finished_at: iso(r.finishedAt),
    undone_at: iso(r.undoneAt),
  };
}

export function serializeRow(r: typeof importRows.$inferSelect) {
  const raw = { ...(r.raw as Record<string, string>) };
  delete raw.__extra;
  return {
    object: "import_row",
    id: r.id,
    entity: r.entity,
    row_number: r.rowNumber,
    source_id: r.sourceId,
    state: r.state,
    outcome: r.outcome,
    outcome_message: r.outcomeMessage,
    errors: r.errors as Issue[],
    warnings: r.warnings as Issue[],
    values: raw,
  };
}

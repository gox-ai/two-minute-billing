"use server";

import {
  discardImportRun,
  getImportRun,
  listImportRows,
  listImportRuns,
  recheckImportRun,
  startImportRun,
  undoImportRun,
} from "@/lib/api/imports";
import type {
  ImportEntity,
  ImportOptions,
  ImportRowPage,
  ImportRun,
  ImportRunPage,
  RowQuery,
} from "@/lib/api/imports";
import {
  createExportRun,
  deleteExportRun,
  getExportRun,
  listExportRuns,
  previewExport,
} from "@/lib/api/exports";
import type { ExportPreview, ExportRequest, ExportRun, ExportRunPage } from "@/lib/api/exports";
import { requirePermission } from "@/lib/session";

export type ImportRunResult = { ok: true; run: ImportRun } | { ok: false; message: string };

type Write = { ok: boolean; error?: string; data?: unknown };

function runResult(result: Write, fallback: string): ImportRunResult {
  const run = result.data as ImportRun | undefined;
  if (result.ok && run?.object === "import") return { ok: true, run };
  return { ok: false, message: result.error ?? fallback };
}

/** One run with its undo check, for the poll and for a link from the history. */
export async function getImportAction(biz: string, run: string): Promise<ImportRun | null> {
  await requirePermission("imports:view", "admin");
  try {
    return await getImportRun(biz, run);
  } catch {
    return null;
  }
}

/** One page of a run's rows; null when the engine refuses. */
export async function listImportRowsAction(
  biz: string,
  run: string,
  query: RowQuery,
): Promise<ImportRowPage | null> {
  await requirePermission("imports:view", "admin");
  try {
    return await listImportRows(biz, run, query);
  } catch {
    return null;
  }
}

/** One page of past imports, newest first. */
export async function listImportsAction(
  biz: string,
  cursor?: string,
): Promise<ImportRunPage | null> {
  await requirePermission("imports:view", "admin");
  try {
    return await listImportRuns(biz, cursor);
  } catch {
    return null;
  }
}

/** Check again with changed columns or options. Writes no billing data. */
export async function recheckImportAction(
  biz: string,
  run: string,
  body: {
    mapping?: Partial<Record<ImportEntity, Record<string, string | null>>>;
    options?: ImportOptions;
  },
): Promise<ImportRunResult> {
  await requirePermission("imports:manage", "admin");
  return runResult(await recheckImportRun(biz, run, body), "We could not check the files.");
}

/** Queue a checked import. `confirm` is the business name, for a live business. */
export async function startImportAction(
  biz: string,
  run: string,
  confirm?: string,
): Promise<ImportRunResult> {
  await requirePermission("imports:manage", "admin");
  return runResult(await startImportRun(biz, run, confirm), "We could not start the import.");
}

/** Delete what a finished import added. `confirm` is the business name, for a live business. */
export async function undoImportAction(
  biz: string,
  run: string,
  confirm?: string,
): Promise<ImportRunResult> {
  await requirePermission("imports:manage", "admin");
  return runResult(await undoImportRun(biz, run, confirm), "We could not undo the import.");
}

/** Throw away an import that has not started. */
export async function discardImportAction(biz: string, run: string): Promise<ImportRunResult> {
  await requirePermission("imports:manage", "admin");
  return runResult(await discardImportRun(biz, run), "We could not discard the import.");
}

// ── Bulk export ────────────────────────────────────────────────────────────────

export type ExportRunResult = { ok: true; run: ExportRun } | { ok: false; message: string };

function exportResult(result: Write, fallback: string): ExportRunResult {
  const run = result.data as ExportRun | undefined;
  if (result.ok && run?.object === "export") return { ok: true, run };
  return { ok: false, message: result.error ?? fallback };
}

/** Records per file and the first rows, for the choices on screen. Writes nothing. */
export async function previewExportAction(
  biz: string,
  body: ExportRequest,
): Promise<{ ok: true; preview: ExportPreview } | { ok: false; message: string }> {
  await requirePermission("exports:view", "admin");
  const res = await previewExport(biz, body);
  const preview = res.data as ExportPreview | undefined;
  if (res.ok && preview?.object === "export_preview") return { ok: true, preview };
  return { ok: false, message: res.error ?? "We could not count the records." };
}

/** Start an export; its files are written in the background. */
export async function startExportAction(
  biz: string,
  body: ExportRequest,
): Promise<ExportRunResult> {
  await requirePermission("exports:manage", "admin");
  return exportResult(await createExportRun(biz, body), "We could not start the export.");
}

/** One export, for the poll and for a link from an email. */
export async function getExportAction(biz: string, id: string): Promise<ExportRun | null> {
  await requirePermission("exports:view", "admin");
  try {
    return await getExportRun(biz, id);
  } catch {
    return null;
  }
}

/** One page of past exports, newest first. */
export async function listExportsAction(
  biz: string,
  cursor?: string,
): Promise<ExportRunPage | null> {
  await requirePermission("exports:view", "admin");
  try {
    return await listExportRuns(biz, cursor);
  } catch {
    return null;
  }
}

/** Delete a finished export's files now. */
export async function deleteExportAction(biz: string, id: string): Promise<ExportRunResult> {
  await requirePermission("exports:manage", "admin");
  return exportResult(await deleteExportRun(biz, id), "We could not delete the files.");
}

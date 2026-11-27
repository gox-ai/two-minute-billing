/**
 * File-import fetchers — server-only. `/v1/businesses/:biz/imports`: upload, check, start,
 * undo, discard, the run list and each run's rows.
 */
import { apiGet, apiWrite } from "@/lib/api";
import type { ImportEntity } from "@/lib/import-entities";

export { IMPORT_ENTITIES, type ImportEntity } from "@/lib/import-entities";

export type ImportStatus =
  | "uploaded"
  | "checking"
  | "checked"
  | "queued"
  | "running"
  | "succeeded"
  | "partially_failed"
  | "failed"
  | "undoing"
  | "undone"
  | "discarded";

export interface ImportFile {
  entity: ImportEntity;
  filename: string;
  headers: string[];
  /** Column in the file → field key, or null: not imported. */
  mapping: Record<string, string | null>;
  rows: number;
  missing_required: string[];
}

export interface ImportOptions {
  skip_invalid_rows?: boolean;
  exclude_renewing_within_24h?: boolean;
  /** Open imported invoices enter the retry schedule. Off: owed, not collected. */
  collect_open_invoices?: boolean;
}

export interface EntityCounts {
  rows: number;
  new: number;
  existing: number;
  invalid: number;
  excluded: number;
}

export interface Notice {
  code: string;
  message: string;
  count?: number;
}

export interface CheckSummary {
  entities: Partial<Record<ImportEntity, EntityCounts>>;
  subscriptions: { new: number; existing: number; invalid: number; excluded: number };
  mrr: Array<{ currency: string; amount_minor: number }>;
  payment: {
    with_card_connected: number;
    with_card_not_connected: number;
    without_card: number;
    gateways_not_connected: string[];
  };
  renewals: { first_at: string | null; last_at: string | null; within_24h: number };
  test_limits: {
    customers: { used: number; adding: number; limit: number | null };
    subscriptions: { used: number; adding: number; limit: number | null };
  } | null;
  history?: {
    invoices: number;
    open_invoices: number;
    receivables: Array<{ currency: string; amount_minor: number }>;
    credit: Array<{ currency: string; amount_minor: number }>;
    next_invoice_number: number | null;
  };
  not_imported: string[];
  blockers: Notice[];
  warnings: Notice[];
  ready: boolean;
}

export interface EntityOutcome {
  created: number;
  unchanged: number;
  failed: number;
  excluded: number;
}

export interface ImportResult {
  /** While running. */
  progress?: { done: number; total: number };
  entities?: Partial<Record<ImportEntity, EntityOutcome>>;
  /** After an undo: records deleted, per record type. */
  undo?: Record<string, number>;
}

export interface ImportRun {
  object: "import";
  id: string;
  status: ImportStatus;
  files: ImportFile[];
  options: ImportOptions;
  summary: CheckSummary | null;
  result: ImportResult | null;
  error: string | null;
  created_by: string | null;
  started_by: string | null;
  undone_by: string | null;
  created_at: string;
  checked_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  undone_at: string | null;
  /** On a single read of a finished run: what stops an undo now (empty: it can be undone). */
  undo_blockers?: Notice[] | null;
}

export interface ImportRunPage {
  object: "list";
  data: ImportRun[];
  has_more: boolean;
}

export type RowState = "new" | "existing" | "invalid" | "excluded";
export type RowOutcome = "created" | "unchanged" | "failed" | "excluded";

export interface ImportRowIssue {
  column: string | null;
  field: string | null;
  message: string;
}

export interface ImportRow {
  object: "import_row";
  id: string;
  entity: ImportEntity;
  row_number: number;
  source_id: string | null;
  state: RowState | null;
  outcome: RowOutcome | null;
  outcome_message: string | null;
  errors: ImportRowIssue[];
  warnings: ImportRowIssue[];
  values: Record<string, string>;
}

export interface ImportRowPage {
  object: "list";
  data: ImportRow[];
  has_more: boolean;
}

export interface RowQuery {
  entity?: ImportEntity;
  state?: RowState;
  outcome?: RowOutcome;
  limit?: number;
  starting_after?: string;
}

export interface TemplateField {
  key: string;
  required: boolean;
  aliases: string[];
  example: string;
  help: string;
  values: string[] | null;
}

const base = (biz: string) => `/v1/businesses/${encodeURIComponent(biz)}/imports`;
const runPath = (biz: string, run: string, verb?: string) =>
  `${base(biz)}/${encodeURIComponent(run)}${verb ? `/${verb}` : ""}`;

const qs = (q: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const listImportRuns = (biz: string, cursor?: string) =>
  apiGet<ImportRunPage>(`${base(biz)}${qs({ limit: 20, starting_after: cursor })}`);

export const getImportRun = (biz: string, run: string) => apiGet<ImportRun>(runPath(biz, run));

export const listImportRows = (biz: string, run: string, q: RowQuery) =>
  apiGet<ImportRowPage>(`${runPath(biz, run, "rows")}${qs({ ...q })}`);

export const getTemplateFields = (biz: string, entity: ImportEntity) =>
  apiGet<{ object: "import_template"; entity: ImportEntity; fields: TemplateField[] }>(
    `${base(biz)}/templates/${entity}?format=json`,
  );

export const createImportRun = (
  biz: string,
  body: {
    files: Array<{ entity: ImportEntity | "json"; filename: string; content: string }>;
    options?: ImportOptions;
  },
) => apiWrite(base(biz), body);

export const recheckImportRun = (
  biz: string,
  run: string,
  body: {
    mapping?: Partial<Record<ImportEntity, Record<string, string | null>>>;
    options?: ImportOptions;
  },
) => apiWrite(runPath(biz, run, "check"), body);

export const startImportRun = (biz: string, run: string, confirm?: string) =>
  apiWrite(runPath(biz, run, "start"), confirm ? { confirm } : {});

export const undoImportRun = (biz: string, run: string, confirm?: string) =>
  apiWrite(runPath(biz, run, "undo"), confirm ? { confirm } : {});

export const discardImportRun = (biz: string, run: string) =>
  apiWrite(runPath(biz, run, "discard"), {});

/** The newest run of this business that has not ended its life on screen, or null. */
export async function currentImportRunId(biz: string): Promise<string | null> {
  const page = await listImportRuns(biz);
  const open = page.data.find((r) =>
    ["uploaded", "checking", "checked", "queued", "running", "undoing"].includes(r.status),
  );
  return open?.id ?? null;
}

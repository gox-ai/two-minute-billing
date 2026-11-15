/**
 * Transfer-domain fetchers — server-only.
 * Covers: async plans and runs (plan → items → apply → retry/cancel), the run history and
 * POST/DELETE sample_data.
 */
import { apiGet, apiGetOrNull, apiWrite } from "@/lib/api";

export type TransferSection =
  | "catalog"
  | "coupons"
  | "tax_rates"
  | "settings"
  | "company_profile"
  | "email_sending";

/** Sync runs use running/succeeded/failed; async runs use every value. */
export type TransferJobStatus =
  | "planned"
  | "queued"
  | "running"
  | "succeeded"
  | "partially_failed"
  | "failed"
  | "cancelled"
  | "superseded";

export type ConflictPolicy = "skip" | "update";
export type ItemAction = "create" | "update" | "unchanged" | "skip" | "blocked" | "delete";
export type ItemStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type SkipReason = "unchanged" | "excluded" | "dependency" | "cancelled" | "drift";

export interface RunCounts {
  total: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
  skipped: number;
}

export interface ValidationEntry {
  key: string;
  message: string;
}

export interface SectionReport {
  created: number;
  updated: number;
  skipped: number;
}

export interface TransferJob {
  object: "transfer_configuration";
  id: string;
  status: TransferJobStatus;
  source_business: string;
  destination_business: string;
  sections: TransferSection[];
  wipe_destination: boolean;
  options?: {
    numbering?: { invoicePrefix?: string; creditNotePrefix?: string };
    include_test_twins?: boolean;
  } | null;
  live_override?: boolean;
  twin_of?: string | null;
  report: Record<string, SectionReport> | null;
  error: string | null;
  twin?: TransferJob | null;
  run_kind?: "sync" | "async";
  /** Async runs only. */
  conflict_policy?: Partial<Record<TransferSection, ConflictPolicy>> | null;
  counts?: RunCounts | null;
  validation?: { errors: ValidationEntry[]; warnings: ValidationEntry[] } | null;
  planned_by?: string | null;
  started_by?: string | null;
  cancelled_by?: string | null;
  queued_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  heartbeat_at?: string | null;
  cancel_requested_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface TransferItem {
  /** `<pair>:<key>`, e.g. `main:price:pro-usd`. */
  key: string;
  pair: "main" | "twin";
  section: string;
  kind: string;
  label: string;
  action: ItemAction;
  excluded: boolean;
  /** Blocked by itself or by a dependency. */
  blocked: boolean;
  depends_on: string[];
  diff: Array<{ field: string; from: unknown; to: unknown }> | null;
  messages: Array<{ level: "error" | "warning"; message: string }>;
  status: ItemStatus;
  skip_reason: SkipReason | null;
  error: string | null;
  attempts: number;
  started_at: string | null;
  finished_at: string | null;
}

import type { ItemProgress, ResultKind } from "@/lib/transfer-items";
export type { ItemProgress, ResultKind };

export interface RunSummary {
  total: number;
  results: Record<ResultKind, number>;
  /** Twin pair first, then sections in apply order. `progress` counts queued items only. */
  sections: Array<{
    pair: "main" | "twin";
    section: string;
    results: Record<ResultKind, number>;
    progress: ItemProgress;
    /** Items the copy wrote, by result. */
    applied: { new: number; updated: number; deleted: number };
  }>;
  /** Blocked items not left out: the apply refuses while any remain. */
  blocked?: Array<{
    key: string;
    pair: "main" | "twin";
    section: string;
    label: string;
    messages: TransferItem["messages"];
  }>;
  /** Failed items and the items they held back. */
  retryable: number;
}

/** An async run (GET …/:job?items=none): its counts, never its items. Page those. */
export interface TransferRun extends TransferJob {
  run_kind: "async";
  destination_livemode: "test" | "live";
  live_override_needed: boolean;
  summary: RunSummary;
}

export interface ItemQuery {
  section?: string;
  /** A result, or `changes`: new, updated and deleted. */
  result?: ResultKind | "changes";
  /** Queued items only: all (`queued`), not done (`open`), or one status. */
  status?: "queued" | "open" | "done" | "failed" | "skipped";
  q?: string;
  limit?: number;
  starting_after?: string;
}

export interface TransferItemPage {
  object: "list";
  data: TransferItem[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface PlanRequest {
  destination_business: string;
  sections?: TransferSection[];
  conflict_policy?: Partial<Record<TransferSection, ConflictPolicy>>;
  numbering?: { invoice_prefix?: string; credit_note_prefix?: string };
  include_test_twins?: boolean;
  wipe_destination?: boolean;
  /** Item keys to leave out, carried from an earlier plan. */
  exclude?: string[];
}

export interface SampleDataSummary {
  object: "sample_data";
  products: number;
  prices: number;
  coupons: number;
  customers: number;
  deleted?: boolean;
}

export interface TransferHistoryPage {
  object: "list";
  data: TransferJob[];
  has_more: boolean;
  next_cursor: string | null;
}

export const listTransferJobs = (
  biz: string,
  scope: "business" | "organization",
  cursor?: string,
) =>
  apiGet<TransferHistoryPage>(
    `/v1/businesses/${biz}/transfer_configurations?scope=${scope}&limit=20${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`,
  );

export const getTransferJob = (biz: string, jobId: string) =>
  apiGet<TransferJob>(`/v1/businesses/${biz}/transfer_configurations/${jobId}`);

const runPath = (biz: string, run: string, verb?: string) =>
  `/v1/businesses/${encodeURIComponent(biz)}/transfer_configurations/${encodeURIComponent(run)}${verb ? `/${verb}` : ""}`;

/** Responses carry the run's counts, not its items: a plan can hold tens of thousands. */
const NO_ITEMS = "?items=none";

/** One run with its counts; null when it does not exist or is not from this business. */
export const getTransferRun = (biz: string, run: string) =>
  apiGetOrNull<TransferRun>(runPath(biz, run) + NO_ITEMS);

/** One page of a run's items in plan order, filtered by the engine. */
export function listTransferItems(biz: string, run: string, q: ItemQuery) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") params.set(k, String(v));
  const qs = params.toString();
  return apiGet<TransferItemPage>(`${runPath(biz, run, "items")}${qs ? `?${qs}` : ""}`);
}

/** The open plan or active run started FROM this business. */
export async function currentTransferRunId(biz: string): Promise<string | null> {
  const page = await apiGet<TransferHistoryPage>(
    `/v1/businesses/${encodeURIComponent(biz)}/transfer_configurations?status=planned,queued,running&run_kind=async&direction=outgoing&limit=1`,
  );
  return page.data[0]?.id ?? null;
}

export const createTransferPlan = (biz: string, body: PlanRequest) =>
  apiWrite(
    `/v1/businesses/${encodeURIComponent(biz)}/transfer_configurations/plans${NO_ITEMS}`,
    body,
    "POST",
  );

export const setTransferItems = (
  biz: string,
  run: string,
  body: { exclude?: string[]; include?: string[] },
) => apiWrite(runPath(biz, run, "items") + NO_ITEMS, body, "POST");

export const applyTransferRun = (biz: string, run: string, confirm?: string) =>
  apiWrite(runPath(biz, run, "apply") + NO_ITEMS, confirm ? { confirm } : {}, "POST");

export const retryTransferRun = (biz: string, run: string, confirm?: string) =>
  apiWrite(runPath(biz, run, "retry") + NO_ITEMS, confirm ? { confirm } : {}, "POST");

export const cancelTransferRun = (biz: string, run: string) =>
  apiWrite(runPath(biz, run, "cancel") + NO_ITEMS, {}, "POST");

export const seedSampleData = (biz: string) =>
  apiWrite(`/v1/businesses/${biz}/sample_data`, {}, "POST");

export const removeSampleData = (biz: string) =>
  apiWrite(`/v1/businesses/${biz}/sample_data`, {}, "DELETE");

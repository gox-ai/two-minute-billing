/**
 * Transfer-domain fetchers — server-only.
 * Covers: POST transfer_configurations (+ /preview), GET job status, POST/DELETE sample_data.
 */
import { apiGet, apiWrite } from "@/lib/api";

export type TransferSection =
  | "catalog"
  | "coupons"
  | "tax_rates"
  | "settings"
  | "company_profile"
  | "email_sending";

export type TransferJobStatus = "running" | "succeeded" | "failed";

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
  created_at: string;
  updated_at: string;
}

export interface TransferRequest {
  destination_business: string;
  sections?: TransferSection[];
  wipe_destination?: boolean;
  numbering?: { invoice_prefix?: string; credit_note_prefix?: string };
  include_test_twins?: boolean;
  live_override?: { confirm: string; plan_digest: string };
}

export interface PreviewField {
  field: string;
  from: unknown;
  to: unknown;
  changed: boolean;
  secret: boolean;
}

export interface PreviewSection {
  section: TransferSection | "numbering";
  status: "copy" | "needs_live_override";
  changes: number;
  objects?: {
    create: number;
    existing: number;
    existing_action: "update" | "keep";
    deleted?: number;
  };
  fields?: PreviewField[];
  tax?: Array<{
    text: string;
    action: "create" | "update" | "same" | "kept" | "rename" | "delete";
  }>;
}

export interface PreviewPair {
  source_business: string;
  destination_business: string;
  destination_name: string;
  destination_livemode: "test" | "live";
  clear_first: boolean;
  blockers: Array<{ section: TransferSection | "numbering"; message: string }>;
  sections: PreviewSection[];
}

export interface TransferPreview {
  object: "transfer_preview";
  source_business: string;
  destination_business: string;
  sections: TransferSection[];
  plan_digest: string;
  live_override_available: boolean;
  pairs: PreviewPair[];
}

export interface SampleDataSummary {
  object: "sample_data";
  products: number;
  prices: number;
  coupons: number;
  customers: number;
  deleted?: boolean;
}

export const previewTransfer = (biz: string, body: TransferRequest) =>
  apiWrite(`/v1/businesses/${biz}/transfer_configurations/preview`, body, "POST");

export const runTransfer = (biz: string, body: TransferRequest) =>
  apiWrite(`/v1/businesses/${biz}/transfer_configurations`, body, "POST");

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

export const seedSampleData = (biz: string) =>
  apiWrite(`/v1/businesses/${biz}/sample_data`, {}, "POST");

export const removeSampleData = (biz: string) =>
  apiWrite(`/v1/businesses/${biz}/sample_data`, {}, "DELETE");

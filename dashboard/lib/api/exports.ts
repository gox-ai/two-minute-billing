/**
 * Bulk-export fetchers — server-only. `/v1/businesses/:biz/exports`: preview, start, read,
 * list and delete. Downloads stream through `imports/export-file/route.ts`.
 */
import { apiGet, apiWrite } from "@/lib/api";
import type { ImportEntity } from "@/lib/import-entities";

export type ExportStatus = "queued" | "running" | "succeeded" | "failed" | "expired" | "deleted";

export interface ExportFilter {
  status?: string[];
  date_field?: "created" | "updated";
  from?: string | null;
  to?: string | null;
  include_archived?: boolean;
}

export interface ExportRequest {
  entities: ImportEntity[];
  filters?: Partial<Record<ImportEntity, ExportFilter>>;
  include_related?: boolean;
}

export interface ExportPreviewFile {
  entity: ImportEntity;
  rows: number;
  chosen: number;
  related: number;
  columns: string[];
  sample: string[][];
}

export interface ExportPreview {
  object: "export_preview";
  include_related: boolean;
  files: ExportPreviewFile[];
}

export interface ExportRun {
  object: "export";
  id: string;
  status: ExportStatus;
  entities: ImportEntity[];
  filters: Partial<
    Record<
      ImportEntity,
      {
        status?: string[];
        dateField?: "created" | "updated";
        from?: string | null;
        to?: string | null;
        includeArchived?: boolean;
      }
    >
  >;
  include_related: boolean;
  files: Array<{
    entity: ImportEntity;
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

export interface ExportRunPage {
  object: "list";
  data: ExportRun[];
  has_more: boolean;
}

const base = (biz: string) => `/v1/businesses/${encodeURIComponent(biz)}/exports`;

export const previewExport = (biz: string, body: ExportRequest) =>
  apiWrite(`${base(biz)}/preview`, body);

export const createExportRun = (biz: string, body: ExportRequest) => apiWrite(base(biz), body);

export const getExportRun = (biz: string, id: string) =>
  apiGet<ExportRun>(`${base(biz)}/${encodeURIComponent(id)}`);

export const listExportRuns = (biz: string, cursor?: string) =>
  apiGet<ExportRunPage>(
    `${base(biz)}?limit=20${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`,
  );

export const deleteExportRun = (biz: string, id: string) =>
  apiWrite(`${base(biz)}/${encodeURIComponent(id)}/delete`, {});

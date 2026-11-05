// Typed fetchers for the HubSpot integration (Settings → Integrations → HubSpot).
// Server-only. Shapes mirror src/api/hubspot-routes.ts.
import { apiGet, apiGetOrNull, apiWrite } from "@/lib/api";

export interface HubSpotSyncRun {
  object: "hubspot_sync_run";
  id: string;
  trigger: "event" | "autosync" | "manual" | "initial";
  status: "running" | "succeeded" | "partial" | "failed" | "interrupted";
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface HubSpotSyncItem {
  object: "hubspot_sync_item";
  local_type: string;
  local_id: string | null;
  remote_type: string | null;
  remote_id: string | null;
  action: "created" | "updated" | "skipped" | "failed";
  message: string | null;
  created_at: string;
}

interface Paged<T> {
  object: "list";
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export type HubSpotConnection =
  | {
      object: "hubspot_connection";
      status: "not_connected";
      configured: boolean;
      authorize_url: string | null;
    }
  | {
      object: "hubspot_connection";
      status: "active" | "reauth_required";
      configured: boolean;
      authorize_url: string | null;
      id: string;
      portal_id: string;
      hub_domain: string | null;
      installed_by: string | null;
      scopes: string[];
      autosync: boolean;
      settings: HubSpotSettings;
      initial_sync: "pending" | "queued" | "running" | "done";
      last_sync_at: string | null;
      last_error: string | null;
      connected_at: string;
      health: {
        last_run: HubSpotSyncRun | null;
        pending: number;
        retrying: number;
        synced_24h: number;
        failed_24h: number;
      };
    };

/** Mirrors `src/modules/hubspot/settings.ts` (the API returns it fully defaulted). */
export interface HubSpotFieldMapping {
  remote: string;
  local: string;
  direction: "to_remote" | "to_local" | "both";
}
export type HubSpotSubscriptionStatus =
  | "future"
  | "in_trial"
  | "active"
  | "non_renewing"
  | "paused"
  | "cancelled";
export interface HubSpotSettings {
  customers: {
    scope: "all" | "active_subscriptions";
    createMissing: boolean;
    contactMatch: { local: string; remote: string };
    companyMatch: { local: string; remote: string } | null;
    multipleCustomersPerCompany: boolean;
    onMatch: "overwrite" | "fill_empty" | "link_only";
    billingAddressViaCustomFields: boolean;
    contactFields: HubSpotFieldMapping[];
    companyFields: HubSpotFieldMapping[];
  };
  updates: {
    localChange: "overwrite_remote" | "nothing";
    remoteChange: "overwrite_local" | "nothing";
    conflict: "local_wins" | "remote_wins" | "flag";
    pullAddress: boolean;
    pullEmail: boolean;
  };
  deals: {
    enabled: boolean;
    statuses: HubSpotSubscriptionStatus[];
    mode: "link_or_create" | "create";
    subscriptionIdProperty: string | null;
    matchByAssociation: boolean;
    onChange: "update" | "nothing";
    amount: "mrr" | "arr" | "next_billing_amount";
    nameFormat: string;
    pipelineId: string | null;
    stageMap: Partial<Record<HubSpotSubscriptionStatus, string>>;
    fields: HubSpotFieldMapping[];
    discountMode: "price_override" | "coupon" | "ignore";
    editDealTypes: string[];
    manualCreate: boolean;
  };
  products: { enabled: boolean };
  /** `objectType` is the custom object's `objectTypeId` (`2-…`). */
  invoices: { enabled: boolean; objectType: string | null };
}

export interface HubSpotProperty {
  name: string;
  label: string;
  type: string | null;
  fieldType: string | null;
  group: string | null;
  unique: boolean;
  writable: boolean;
  options: Array<{ label: string; value: string }>;
}
export interface HubSpotPipeline {
  id: string;
  label: string;
  stages: Array<{ id: string; label: string; closed: boolean }>;
}

/** A connection that exists (active or awaiting reconnect) — what every settings section receives. */
export type ConnectedHubSpot = Exclude<HubSpotConnection, { status: "not_connected" }>;

const base = (biz: string) => `/v1/businesses/${biz}/integrations/hubspot`;

export const getHubSpotProperties = (
  biz: string,
  object: "contacts" | "companies" | "deals" | "products",
) => apiGet<{ object: "list"; data: HubSpotProperty[] }>(`${base(biz)}/properties/${object}`);
/** The portal's custom objects. `missing_scopes` is non-empty when the grant must be renewed. */
export interface HubSpotObjects {
  object: "list";
  data: Array<{ id: string; name: string; label: string }>;
  missing_scopes: string[];
  invoice_properties: string[];
}
export const getHubSpotObjects = (biz: string) => apiGet<HubSpotObjects>(`${base(biz)}/objects`);
export const getHubSpotPipelines = (biz: string) =>
  apiGet<{ object: "list"; data: HubSpotPipeline[] }>(`${base(biz)}/pipelines`);
export const getHubSpotLocalFields = (biz: string) =>
  apiGet<{ contacts: string[]; companies: string[]; deals: string[] }>(`${base(biz)}/local_fields`);
/** Partial per section; the API deep-merges and validates the whole. */
export const updateHubSpotSettings = (biz: string, settings: Record<string, unknown>) =>
  apiWrite(base(biz), { settings }, "PATCH");

export const getHubSpot = (biz: string) => apiGet<HubSpotConnection>(base(biz));

export function listHubSpotRuns(biz: string, startingAfter?: string) {
  const q = startingAfter ? `?starting_after=${encodeURIComponent(startingAfter)}` : "";
  return apiGet<Paged<HubSpotSyncRun>>(`${base(biz)}/sync_runs${q}`);
}

export function getHubSpotRun(biz: string, run: string, startingAfter?: string) {
  const q = startingAfter ? `?starting_after=${encodeURIComponent(startingAfter)}` : "";
  return apiGetOrNull<HubSpotSyncRun & { items: Paged<HubSpotSyncItem> }>(
    `${base(biz)}/sync_runs/${encodeURIComponent(run)}${q}`,
  );
}

export const connectHubSpot = (biz: string, code: string) =>
  apiWrite(`${base(biz)}/connect`, { code });
export const updateHubSpot = (biz: string, patch: { autosync?: boolean }) =>
  apiWrite(base(biz), patch, "PATCH");
export const startHubSpot = (biz: string) => apiWrite(`${base(biz)}/start`, {});
export const syncHubSpot = (biz: string, full: boolean) => apiWrite(`${base(biz)}/sync`, { full });
export const disconnectHubSpot = (biz: string) => apiWrite(base(biz), {}, "DELETE");

/** A record changed both here and in HubSpot under the `flag` rule. Mirrors src/api/hubspot-conflict-routes.ts. */
export interface HubSpotConflict {
  object: "hubspot_conflict";
  id: string;
  status: "open" | "resolved";
  local_type: "customer" | "subscription";
  local_id: string | null;
  remote_type: "contact" | "company" | "deal";
  remote_id: string;
  fields: Array<{
    field: string;
    label: string;
    remote_property: string;
    ours: string | null;
    theirs: string | null;
  }>;
  remote_updated_at: string | null;
  detected_at: string;
  resolution: "ours" | "theirs" | null;
  resolved_at: string | null;
}

export function listHubSpotConflicts(
  biz: string,
  opts: { limit?: number; startingAfter?: string } = {},
) {
  const q = new URLSearchParams();
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.startingAfter) q.set("starting_after", opts.startingAfter);
  const qs = q.toString();
  return apiGet<Paged<HubSpotConflict>>(`${base(biz)}/conflicts${qs ? `?${qs}` : ""}`);
}
export const resolveHubSpotConflict = (biz: string, id: string, keep: "ours" | "theirs") =>
  apiWrite(`${base(biz)}/conflicts/${encodeURIComponent(id)}/resolve`, { keep });

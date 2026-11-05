// Typed fetchers for business integrations (Settings → Integrations). Server-only.
// Shapes mirror src/api/integration-routes.ts. HubSpot's own routes live in ./hubspot.ts.
import { apiGet, apiWrite } from "@/lib/api";

/** One catalogue entry. Everything the directory and the connect form render comes from here. */
export interface Integration {
  object: "integration";
  key: string;
  label: string;
  /** `push`: one event, one partner call. `sync`: a two-way record sync with its own page. */
  kind: "push" | "sync";
  category: "crm" | "affiliate";
  blurb: string;
  /** `monogram` always present; `src` is a dashboard-local asset when one ships. */
  icon: { monogram: string; src?: string };
  connect_method: "api_key" | "oauth";
  /** Fixed by the integration; the operator cannot change them. */
  event_types: string[];
  /** In form order. `secret: false` is an identifier the partner prints openly. */
  credentials: Array<{ key: string; label: string; hint?: string; secret: boolean }>;
  fields: Array<{ key: string; label: string; placeholder?: string; help?: string }>;
  prerequisite?: { title: string; body: string };
}

export type IntegrationStatus = "not_connected" | "active" | "disabled" | "reauth_required";

/** A directory row: the catalogue entry plus this business's status. */
export interface BusinessIntegration extends Integration {
  status: IntegrationStatus;
  /** A one-line reading, e.g. HubSpot's hub domain. */
  summary: string | null;
}

export type IntegrationConnection =
  | {
      object: "integration_connection";
      integration: string;
      business: string;
      status: "not_connected";
    }
  | {
      object: "integration_connection";
      integration: string;
      business: string;
      id: string;
      status: "active" | "disabled";
      enabled: boolean;
      livemode: "test" | "live";
      /** Values the operator typed. Credentials are write-only and never come back. */
      config: Record<string, string>;
      connected_at: string | null;
      updated_at: string | null;
      stats: { pending: number; failed: number; delivered_24h: number };
    };

export type ConnectedIntegration = Exclude<IntegrationConnection, { status: "not_connected" }>;

export interface IntegrationDelivery {
  object: "integration_delivery";
  id: string;
  event: string;
  event_type: string;
  status: "pending" | "delivered" | "failed" | "skipped" | "superseded";
  attempts: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  last_response_status: number | null;
  last_error: string | null;
  created_at: string;
}

/** The one attempt a resend just made. Not stored anywhere: render it from the response. */
export interface IntegrationAttempt {
  outcome: string;
  latency_ms: number;
  error: string | null;
  request: { method: string; url: string; headers: Record<string, string>; body: string };
  response: { status: number; headers: Record<string, string>; body: string } | null;
}

export interface IntegrationRedelivery {
  object: "integration_delivery";
  id: string;
  status: IntegrationDelivery["status"];
  attempts: number;
  next_attempt_at: string | null;
  last_response_status: number | null;
  attempt: IntegrationAttempt;
}

const base = (biz: string, key: string) =>
  `/v1/businesses/${biz}/integrations/${encodeURIComponent(key)}`;

/** The catalogue. Static per deployment; no tenant data. */
export const listIntegrationCatalogue = () =>
  apiGet<{ object: "list"; data: Integration[] }>("/v1/integrations");

/** The directory for one business: every integration with its status. */
export const listBusinessIntegrations = (biz: string) =>
  apiGet<{ object: "list"; data: BusinessIntegration[] }>(`/v1/businesses/${biz}/integrations`);

export const getIntegration = (biz: string, key: string) =>
  apiGet<IntegrationConnection>(base(biz, key));

export const listIntegrationDeliveries = (biz: string, key: string) =>
  apiGet<{ object: "list"; data: IntegrationDelivery[] }>(`${base(biz, key)}/deliveries`);

export const connectIntegration = (
  biz: string,
  key: string,
  body: { credentials: Record<string, string>; config?: Record<string, string> },
) => apiWrite(`${base(biz, key)}/connect`, body);

/** `credentials` replaces ALL of them. A blank config value restores its default. */
export const updateIntegration = (
  biz: string,
  key: string,
  patch: {
    enabled?: boolean;
    credentials?: Record<string, string>;
    config?: Record<string, string>;
  },
) => apiWrite(base(biz, key), patch, "PATCH");

export const disconnectIntegration = (biz: string, key: string) =>
  apiWrite(base(biz, key), {}, "DELETE");

/** 200 with `attempt`, or 409 when a delivery of that event is already pending. */
export const redeliverIntegrationDelivery = (biz: string, key: string, delivery: string) =>
  apiWrite(`${base(biz, key)}/deliveries/${encodeURIComponent(delivery)}/redeliver`, {});

export const redeliverFailedIntegrationDeliveries = (biz: string, key: string) =>
  apiWrite(`${base(biz, key)}/redeliver_failed`, {});

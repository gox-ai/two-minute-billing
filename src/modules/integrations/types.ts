import type { EventType } from "@/modules/events/registry";
import type { events } from "@db/schema";
import type { Tx } from "@/platform/db";
import type { EventRow } from "@/modules/events/emit";

/**
 * An INTEGRATION connects one business to another tool. Every one has a static description
 * (`IntegrationInfo`, served by `GET /v1/integrations` and rendered by one generic directory)
 * and is one of two kinds:
 *
 * - `push` — one billing event becomes one partner API call (affiliate tracking, analytics,
 *   alerts). Implemented as a `PushIntegration`: `build` + `judge`. Connections live in
 *   `integration_connections`, deliveries in `integration_deliveries`, and the shared outbox
 *   gives it fan-out in the emit transaction, retries, the breaker, history and Resend.
 * - `sync` — a two-way record sync with its own engine (HubSpot). Implemented as a
 *   `SyncIntegration` adapter over the integration's own tables.
 *
 * Both are reached through ONE event sink (`sink.ts`), so a new integration of either kind is
 * a registry entry, not a new `registerEventSink`.
 */
export type IntegrationKind = "push" | "sync";

export type IntegrationCategory = "crm" | "affiliate";

export interface IntegrationInfo {
  /** Stored in `integration_connections.provider`; the URL segment. */
  key: string;
  label: string;
  kind: IntegrationKind;
  category: IntegrationCategory;
  /** One line: what starts happening once this is connected. */
  blurb: string;
  /**
   * `monogram` always renders; `src` is a path under the dashboard's `public/`, never a remote
   * URL (hotlinking leaks which organizations use the partner, on every render).
   */
  icon: { monogram: string; src?: string };
  /** `api_key`: the generic connect form below. `oauth`: the integration's own flow. */
  connect: ApiKeyConnect | { method: "oauth" };
}

export interface ApiKeyConnect {
  method: "api_key";
  /** The partner's base URL a new connection calls. Stored per row, so a sandbox is a column edit. */
  defaultUrl: string;
  /** The ONLY event types this integration is fanned out for. Fixed by the mapping, not the operator. */
  eventTypes: readonly EventType[];
  /**
   * The credentials, in form order. A list: most partners pair a token with an account id.
   * `secret: false` marks an identifier the partner prints openly — still stored encrypted,
   * but not masked in a transcript, where it tells two accounts apart.
   */
  credentials: ReadonlyArray<{ key: string; label: string; hint?: string; secret?: boolean }>;
  /** Extra settings, stored in `config`. Free text: each names something the merchant chose. */
  fields?: ReadonlyArray<{ key: string; label: string; placeholder?: string; help?: string }>;
  /** Something to do OUTSIDE tmbilling first, stated where it can still be acted on. */
  prerequisite?: { title: string; body: string };
}

export interface PushContext {
  event: typeof events.$inferSelect;
  /** The connection's base URL (`api_base`). */
  baseUrl: string;
  /** Decrypted partner credentials. Never logged, never put in a transcript. */
  credentials: Record<string, unknown>;
  config: Record<string, unknown>;
}

export interface PushRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Header names whose values are masked before the request is shown to anyone. */
  secretHeaders?: readonly string[];
}

/** What a partner's response status means for the delivery row. */
export type PushVerdict =
  /** Recorded at the partner, including "recorded earlier" — a duplicate is not a failure. */
  | "delivered"
  /** The partner will never accept this request; stop spending attempts on it. */
  | "terminal"
  /** Transient. Back off and try again. */
  | "retry";

export interface PushIntegration extends IntegrationInfo {
  connect: ApiKeyConnect;
  /**
   * The partner call for this event, or null when this event maps to nothing — the delivery
   * is then settled `skipped`. Free to read the database: an event's `data` carries ids only.
   */
  build(ctx: PushContext): Promise<PushRequest | null>;
  /**
   * Judge a response status; null defers to the default (2xx delivered, else retry). Takes the
   * request because one status can mean different things on different paths of one API.
   */
  judge(status: number, request?: PushRequest): PushVerdict | null;
}

/** A sync integration's view for the directory: whether it is connected, and a one-line value. */
export interface IntegrationStatus {
  status: "not_connected" | "active" | "disabled" | "reauth_required";
  /** e.g. the HubSpot portal domain. */
  summary: string | null;
}

export interface SyncIntegration {
  info: IntegrationInfo;
  /** Called by the shared sink, inside the emit transaction. Must contain its own failures. */
  onEvent(tx: Tx, event: EventRow): Promise<void>;
  status(organizationId: string, businessId: string): Promise<IntegrationStatus>;
}

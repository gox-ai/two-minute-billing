// Typed fetchers for operator notifications: the member's own settings, devices and bell,
// and the organization's destinations (owners and admins). Server-only.
// Shapes mirror src/api/notification-routes.ts and src/modules/notifications/service.ts.
import { apiGet, apiGetOrNull, apiWrite } from "@/lib/api";

export type NotificationTiming = "instant" | "summary" | "off";
export type NotificationTone = "destructive" | "warning" | "neutral";
export type NotificationChannel = "push" | "email";

/** Amount limits per currency, in minor units (`{ USD: 10000 }`). */
export type AboveLimits = Record<string, number>;

export interface KindPreference {
  timing: NotificationTiming;
  push: boolean;
  email: boolean;
  /** Only on kinds whose catalogue entry has `amount: true`. */
  above?: AboveLimits;
}

export interface CatalogueEntry {
  kind: string;
  group: string;
  label: string;
  help: string;
  tone: NotificationTone;
  /** The kind takes an "Only above" amount limit. */
  amount: boolean;
  /** False when the member's role lacks the kind's permission: they get nothing for it. */
  visible: boolean;
}

export type BusinessFilter = { mode: "all" } | { mode: "selected"; business_ids: string[] };

export interface SummarySetting {
  enabled: boolean;
  channels: NotificationChannel[];
}

export interface NotificationPreferences {
  object: "notification_preferences";
  /** False until the first save. A member who is not set up gets nothing. */
  set_up: boolean;
  catalogue: CatalogueEntry[];
  /** Every kind, the role's defaults under the stored values. */
  default: Record<string, KindPreference>;
  /** Per business (`biz_…`), only the kinds that differ from `default`. */
  exceptions: Array<{ business: string; kinds: Record<string, KindPreference> }>;
  business_filter: BusinessFilter;
  daily: SummarySetting;
  weekly: SummarySetting;
  send_empty: boolean;
  notice_dismissed_at: string | null;
  /** Owner or admin of an organization whose team alerts sent mail, not yet dismissed. */
  team_alerts_notice: boolean;
  /** Currencies of the live businesses, for the "Only above" control. */
  currencies: string[];
  /** Live businesses only: test businesses send no notifications. */
  businesses: Array<{ id: string; name: string }>;
}

/** What PUT takes. The GET object sent back whole is also accepted. */
export interface NotificationPreferencesInput {
  default?: Record<string, KindPreference>;
  /** When given, replaces every business exception. */
  exceptions?: Array<{ business: string; kinds: Record<string, KindPreference> }>;
  business_filter?: BusinessFilter;
  daily?: SummarySetting;
  weekly?: SummarySetting;
  send_empty?: boolean;
  notice_dismissed?: boolean;
}

export interface QuietHours {
  enabled: boolean;
  /** Local hour 0–23. */
  from: number;
  to: number;
  /** Disputes still push during quiet hours. */
  disputes_through: boolean;
}

/** Personal: the same in every organization of the person. */
export interface NotificationSettings {
  object: "notification_settings";
  /** False until the first save; the values are the defaults. */
  set: boolean;
  timezone: string;
  summary_hour: number;
  /** 1 = Monday … 7 = Sunday. */
  weekly_day: number;
  quiet: QuietHours;
}

export type NotificationSettingsInput = Partial<
  Pick<NotificationSettings, "timezone" | "summary_hour" | "weekly_day" | "quiet">
>;

export interface PushSubscription {
  object: "push_subscription";
  id: string;
  label: string | null;
  user_agent: string | null;
  created_at: string;
  last_success_at: string | null;
  last_failure_at: string | null;
}

/** `PushSubscription.toJSON()` from the browser, plus a label. */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label?: string;
  user_agent?: string;
}

export interface Notification {
  object: "notification";
  id: string;
  kind: string;
  tone: NotificationTone;
  timing: "instant" | "summary";
  title: string;
  body: string;
  /** Dashboard path. */
  url: string | null;
  record: { type: string; id: string } | null;
  business: { id: string; name: string } | null;
  amount_minor: number | null;
  currency: string | null;
  /** More than 1: a grouped row ("12 payments failed"). */
  group_count: number;
  /** From a test business: the bell shows it, no channel sends it. */
  test: boolean;
  read: boolean;
  read_at: string | null;
  created_at: string;
}

export interface NotificationPage {
  object: "list";
  data: Notification[];
  has_more: boolean;
  /** Pass as `cursor` for the next page. */
  next_cursor: string | null;
}

export interface NotificationSummary {
  object: "notification_summary";
  id: string;
  period: "daily" | "weekly";
  /** Local date (YYYY-MM-DD) in `timezone`. */
  period_start: string;
  timezone: string;
  business: { id: string; name: string };
  parts: unknown;
  built_at: string;
  /** The member's own summary items for this business and period. */
  items: Notification[];
}

export type DestinationStatus = "active" | "pending" | "not_working";

export interface DestinationKind {
  on: boolean;
  above?: AboveLimits;
}

export interface NotificationDestination {
  object: "notification_destination";
  id: string;
  type: "chat" | "email";
  name: string;
  /** Chat: "…" + the last 6 characters of the webhook URL. The URL is never returned. */
  url_hint: string | null;
  email: string | null;
  /** Email: `pending` until the outside address confirms. Chat: `not_working` after 5 failures. */
  status: DestinationStatus;
  business_filter: BusinessFilter;
  kinds: Record<string, DestinationKind>;
  daily: boolean;
  weekly: boolean;
  hide_names: boolean;
  last_error: string | null;
  last_sent_at: string | null;
  created_at: string;
}

interface DestinationCommon {
  business_filter?: BusinessFilter;
  kinds?: Record<string, DestinationKind>;
  daily?: boolean;
  weekly?: boolean;
  hide_names?: boolean;
}

export type DestinationCreateInput = DestinationCommon &
  (
    | {
        type: "chat";
        name: string;
        url: string;
        /** "Send test and add": a failed test message refuses the add with its reason. */
        send_test?: boolean;
      }
    | { type: "email"; email: string; name?: string }
  );

export type DestinationUpdateInput = DestinationCommon & { name?: string; url?: string };

// ── the member's own settings ──

export const getNotificationPreferences = () =>
  apiGet<NotificationPreferences>("/auth/notifications/preferences");

/** `data` is the saved `NotificationPreferences`. */
export const saveNotificationPreferences = (body: NotificationPreferencesInput) =>
  apiWrite("/auth/notifications/preferences", body, "PUT");

export const getNotificationSettings = () =>
  apiGet<NotificationSettings>("/auth/notifications/settings");

export const saveNotificationSettings = (body: NotificationSettingsInput) =>
  apiWrite("/auth/notifications/settings", body, "PUT");

/** Hides the team-alerts notice; does not set the member up. */
export const dismissTeamAlertsNotice = () => apiWrite("/auth/notifications/notice/dismiss", {});

// ── devices ──

/** `public_key` is null when this deployment cannot send push: offer no push then. */
export const getPushConfig = () =>
  apiGet<{ object: "push_config"; public_key: string | null }>("/auth/notifications/push/config");

export const listPushSubscriptions = () =>
  apiGet<{ object: "list"; data: PushSubscription[] }>("/auth/notifications/push/subscriptions");

/** 201 with the `PushSubscription`. Taking over an endpoint another person used is allowed. */
export const savePushSubscription = (body: PushSubscriptionInput) =>
  apiWrite("/auth/notifications/push/subscriptions", body);

export const deletePushSubscription = (id: string) =>
  apiWrite(`/auth/notifications/push/subscriptions/${encodeURIComponent(id)}`, {}, "DELETE");

/** One test push now. A failure carries the push service's reason in `error`. */
export const sendTestPush = (id: string) =>
  apiWrite(`/auth/notifications/push/subscriptions/${encodeURIComponent(id)}/test`, {});

// ── the bell ──

export function listNotifications(
  opts: { unread?: boolean; business?: string; cursor?: string | null; limit?: number } = {},
) {
  const q = new URLSearchParams();
  if (opts.unread) q.set("unread", "1");
  if (opts.business) q.set("business", opts.business);
  if (opts.cursor) q.set("cursor", opts.cursor);
  if (opts.limit) q.set("limit", String(opts.limit));
  const qs = q.toString();
  return apiGet<NotificationPage>(`/auth/notifications${qs ? `?${qs}` : ""}`);
}

/** `destructive`: at least one unread row is destructive, so the badge is red. */
export function getUnreadCount(business?: string) {
  const qs = business ? `?business=${encodeURIComponent(business)}` : "";
  return apiGet<{ object: "notification_unread_count"; count: number; destructive: boolean }>(
    `/auth/notifications/unread_count${qs}`,
  );
}

export const markNotificationRead = (id: string) =>
  apiWrite(`/auth/notifications/${encodeURIComponent(id)}/read`, {});

/** `data.marked`: how many rows. In one business when given. */
export const markAllNotificationsRead = (business?: string) =>
  apiWrite("/auth/notifications/read_all", business ? { business } : {});

/** Null when the summary does not exist (or is in another organization). */
export const getNotificationSummary = (id: string) =>
  apiGetOrNull<NotificationSummary>(`/auth/notifications/summaries/${encodeURIComponent(id)}`);

// ── destinations (owners and admins; others get 403) ──

export const listNotificationDestinations = () =>
  apiGet<{ object: "list"; data: NotificationDestination[] }>("/auth/notification_destinations");

/** 201 with the `NotificationDestination`. An outside email address starts `pending`. */
export const createNotificationDestination = (body: DestinationCreateInput) =>
  apiWrite("/auth/notification_destinations", body);

/** A new chat URL makes the space `active` again. */
export const updateNotificationDestination = (id: string, body: DestinationUpdateInput) =>
  apiWrite(`/auth/notification_destinations/${encodeURIComponent(id)}`, body, "PATCH");

export const removeNotificationDestination = (id: string) =>
  apiWrite(`/auth/notification_destinations/${encodeURIComponent(id)}`, {}, "DELETE");

export const sendTestToDestination = (id: string) =>
  apiWrite(`/auth/notification_destinations/${encodeURIComponent(id)}/test`, {});

/** "Send again" for a pending outside address. 429 over the send limits. */
export const resendDestinationConfirmation = (id: string) =>
  apiWrite(`/auth/notification_destinations/${encodeURIComponent(id)}/resend`, {});

/**
 * The public confirm page. No session: call it with a plain fetch from the page's action, as
 * the team alerts confirm page did. 404 when the link is not valid or is expired.
 */
export const DESTINATION_CONFIRM_PATH = "/auth/notification_destinations/confirm";

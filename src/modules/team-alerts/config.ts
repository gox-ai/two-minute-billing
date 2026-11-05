/**
 * Team alerts (0489, `businesses.team_alerts_config`): mail to the merchant's own staff about
 * high-value overdue invoices, webhook delivery failures, and a daily digest.
 *
 * Opt-in. NULL, absent or malformed resolves to every alert off and no recipients, which is
 * what every business had before the column existed. An alert runs only when its toggle is
 * on AND there is at least one recipient.
 */

/** Recipients per business. Also enforced by the PATCH schema. */
export const TEAM_ALERT_MAX_RECIPIENTS = 10;

/** The digest goes out at this local hour (business timezone), covering the previous day. */
export const DIGEST_LOCAL_HOUR = 8;

export const TEAM_ALERT_KINDS = ["overdue", "webhook_failures", "daily_digest"] as const;
export type TeamAlertKind = (typeof TEAM_ALERT_KINDS)[number];

export interface TeamAlertsConfig {
  recipients: string[];
  overdue: {
    enabled: boolean;
    /** Minor units per currency. An invoice in a currency with no threshold is never alerted. */
    thresholds: Record<string, number>;
  };
  webhookFailures: { enabled: boolean };
  dailyDigest: { enabled: boolean };
  /** Sent at the time of a free credit grant above `credit_config.grant_limits` (0495). */
  largeGrants: { enabled: boolean };
}

export const DEFAULT_TEAM_ALERTS: TeamAlertsConfig = {
  recipients: [],
  overdue: { enabled: false, thresholds: {} },
  webhookFailures: { enabled: false },
  dailyDigest: { enabled: false },
  largeGrants: { enabled: false },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Stored JSON (snake_case, as the API writes it) → the resolved config. Pure. */
export function resolveTeamAlertsConfig(
  row: { teamAlertsConfig?: unknown } | null | undefined,
): TeamAlertsConfig {
  const raw = row?.teamAlertsConfig;
  if (!isObj(raw)) return structuredClone(DEFAULT_TEAM_ALERTS);

  const seen = new Set<string>();
  const recipients: string[] = [];
  if (Array.isArray(raw.recipients))
    for (const r of raw.recipients) {
      if (typeof r !== "string") continue;
      const e = r.trim().toLowerCase();
      if (!EMAIL_RE.test(e) || seen.has(e)) continue;
      seen.add(e);
      recipients.push(e);
      if (recipients.length >= TEAM_ALERT_MAX_RECIPIENTS) break;
    }

  const thresholds: Record<string, number> = {};
  const od = isObj(raw.overdue) ? raw.overdue : {};
  if (isObj(od.thresholds))
    for (const [cur, v] of Object.entries(od.thresholds))
      if (CURRENCY_RE.test(cur) && typeof v === "number" && Number.isSafeInteger(v) && v >= 0)
        thresholds[cur] = v;

  const on = (v: unknown): boolean => isObj(v) && v.enabled === true;
  return {
    recipients,
    overdue: { enabled: od.enabled === true, thresholds },
    webhookFailures: { enabled: on(raw.webhook_failures) },
    dailyDigest: { enabled: on(raw.daily_digest) },
    largeGrants: { enabled: on(raw.large_grants) },
  };
}

/** The resolved config as the API returns it (every key present). */
export function serializeTeamAlertsConfig(cfg: TeamAlertsConfig) {
  return {
    recipients: cfg.recipients,
    overdue: { enabled: cfg.overdue.enabled, thresholds: cfg.overdue.thresholds },
    webhook_failures: { enabled: cfg.webhookFailures.enabled },
    daily_digest: { enabled: cfg.dailyDigest.enabled },
    large_grants: { enabled: cfg.largeGrants.enabled },
  };
}

/** Which hourly kinds will send: toggle on and at least one recipient. Large grants send at once. */
export function activeTeamAlertKinds(cfg: TeamAlertsConfig): TeamAlertKind[] {
  if (cfg.recipients.length === 0) return [];
  const out: TeamAlertKind[] = [];
  if (cfg.overdue.enabled && Object.keys(cfg.overdue.thresholds).length > 0) out.push("overdue");
  if (cfg.webhookFailures.enabled) out.push("webhook_failures");
  if (cfg.dailyDigest.enabled) out.push("daily_digest");
  return out;
}

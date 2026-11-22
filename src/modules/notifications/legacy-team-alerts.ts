/**
 * The old `team_alerts_config` shape (0489), kept for the deprecated API adapter in `service.ts`
 * and the one-time notice (`notice.ts`). Removed with that API.
 *
 * NULL, absent or malformed resolves to every alert off and no recipients.
 */

/** Recipients per business. Also enforced by the PATCH schema. */
export const TEAM_ALERT_MAX_RECIPIENTS = 10;

export interface TeamAlertsConfig {
  recipients: string[];
  overdue: {
    enabled: boolean;
    /** Minor units per currency. */
    thresholds: Record<string, number>;
  };
  webhookFailures: { enabled: boolean };
  dailyDigest: { enabled: boolean };
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

/** Stored JSON (snake_case, as the API wrote it) → the resolved config. Pure. */
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

/** At least one alert on and at least one recipient: the setup sent mail. */
export function hadTeamAlertOn(cfg: TeamAlertsConfig): boolean {
  return (
    cfg.recipients.length > 0 &&
    (cfg.overdue.enabled ||
      cfg.webhookFailures.enabled ||
      cfg.dailyDigest.enabled ||
      cfg.largeGrants.enabled)
  );
}

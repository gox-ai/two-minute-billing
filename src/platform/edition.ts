/**
 * The edition switch: Two Minute Billing Cloud (our hosted service) or a self-hosted install.
 *
 * `TMBILLING_EDITION=cloud|self_hosted`, default `self_hosted`; config refuses to boot on any
 * other value. Every Cloud-only behaviour asks `isCloud()` AND its own setting, so one stray
 * variable on a self-hosted install cannot switch on part of the hosted service.
 *
 * Read per call, not captured at import: verify suites flip `config` at run time.
 */
import { config } from "./config";

export type Edition = "cloud" | "self_hosted";

export const edition = (): Edition => config.TMBILLING_EDITION;

export const isCloud = (): boolean => edition() === "cloud";

/** Public self-serve sign-up: Cloud with SIGNUP_ENABLED. */
export const signupOffered = (): boolean => isCloud() && config.SIGNUP_ENABLED === "TRUE";

/**
 * Sign-ups start on the Free plan (`plan:free`), with live mode on and account billing measuring
 * their volume: Cloud with SIGNUP_SANDBOX. Without it a sign-up is an agreement, with no limit.
 * The setting keeps its 0354 name so existing settings files still work.
 */
export const signupOnFreePlan = (): boolean => isCloud() && config.SIGNUP_SANDBOX === "TRUE";

/** `live_access_enabled_by` of an organization on the Free plan (0356). */
export const FREE_PLAN_MARK = "plan:free";

/**
 * The organization's live access as this edition enforces it. Self-hosted has no plans, so
 * live mode is never locked, whatever the row says.
 */
export function effectiveLiveAccess(stored: string | null | undefined): "locked" | "enabled" {
  return isCloud() && (stored ?? "enabled") !== "enabled" ? "locked" : "enabled";
}

/** The organization's status as this edition enforces it: self-hosted is never read-only. */
export function effectiveOrganizationStatus(stored: string | null | undefined): string {
  return isCloud() ? (stored ?? "active") : "active";
}

/** Cloud-only settings that are set on a self-hosted install, and so do nothing. */
export function ignoredCloudSettings(): string[] {
  if (isCloud()) return [];
  return (["SIGNUP_ENABLED", "SIGNUP_SANDBOX"] as const).filter((k) => config[k] === "TRUE");
}

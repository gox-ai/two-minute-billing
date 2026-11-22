import { sql, type SQL } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { storefrontVisits } from "@db/schema";
import { parseUserAgent } from "./user-agent";
import { cleanUtm, countryFrom, referrerHostOf, trackingRefused } from "./privacy";
import { clampSteps, MAX_STEP_MS_TOTAL, type StorefrontSurface } from "./steps";

export type { StorefrontSurface } from "./steps";

export interface VisitScope {
  surface: StorefrontSurface;
  organizationId: string;
  businessId: string;
  sessionPublicId: string;
  /** Internal id of the checkout session (checkout only). */
  checkoutSessionId?: string;
}

export type VisitEvent =
  | {
      kind: "entry";
      referrer_host?: string | null;
      utm_source?: string | null;
      utm_medium?: string | null;
      utm_campaign?: string | null;
    }
  | { kind: "view" }
  | { kind: "engage"; steps: Record<string, number> }
  | { kind: "pdf" };

export type RecordOutcome = "recorded" | "refused_privacy" | "bot";

/**
 * Record one storefront event for the session. Request headers are read here and dropped:
 * only the derived words are stored. GPC/DNT and bots record nothing.
 */
export async function recordVisitEvent(
  scope: VisitScope,
  event: VisitEvent,
  headers: Record<string, string | string[] | undefined>,
): Promise<RecordOutcome> {
  if (trackingRefused(headers)) return "refused_privacy";
  const uaRaw = headers["user-agent"];
  const ua = parseUserAgent(Array.isArray(uaRaw) ? uaRaw[0] : uaRaw);
  if (!ua) return "bot";
  const country = countryFrom(headers);
  const now = sql`app_now()`;
  const v = storefrontVisits;

  const entry =
    event.kind === "entry"
      ? {
          referrerHost: referrerHostOf(event.referrer_host),
          utmSource: cleanUtm(event.utm_source),
          utmMedium: cleanUtm(event.utm_medium),
          utmCampaign: cleanUtm(event.utm_campaign),
        }
      : null;
  const steps = event.kind === "engage" ? clampSteps(scope.surface, event.steps) : {};
  const added = Object.values(steps).reduce((a, b) => a + b, 0);
  if (event.kind === "engage" && added === 0) return "recorded";

  // First touch: attribution is written once, by the first entry.
  const firstEntry = (col: SQL, value: SQL) =>
    sql`CASE WHEN ${v.enteredAt} IS NULL THEN ${value} ELSE ${col} END`;
  const set: Record<string, SQL> = {
    deviceCategory: sql`coalesce(${v.deviceCategory}, excluded.device_category)`,
    browser: sql`coalesce(${v.browser}, excluded.browser)`,
    os: sql`coalesce(${v.os}, excluded.os)`,
    country: sql`coalesce(${v.country}, excluded.country)`,
  };
  if (entry) {
    set.referrerHost = firstEntry(sql`${v.referrerHost}`, sql`excluded.referrer_host`);
    set.utmSource = firstEntry(sql`${v.utmSource}`, sql`excluded.utm_source`);
    set.utmMedium = firstEntry(sql`${v.utmMedium}`, sql`excluded.utm_medium`);
    set.utmCampaign = firstEntry(sql`${v.utmCampaign}`, sql`excluded.utm_campaign`);
    set.enteredAt = sql`coalesce(${v.enteredAt}, excluded.entered_at)`;
  } else {
    set.viewedAt = sql`coalesce(${v.viewedAt}, excluded.viewed_at)`;
  }
  if (event.kind === "engage") {
    let merged: SQL = sql`${v.stepMs}`;
    for (const [k, ms] of Object.entries(steps))
      merged = sql`jsonb_set(${merged}, ARRAY[${k}]::text[], to_jsonb(least(coalesce((${v.stepMs} ->> ${k})::bigint, 0) + ${ms}, ${MAX_STEP_MS_TOTAL})))`;
    set.stepMs = merged;
    set.engagedMs = sql`${v.engagedMs} + ${added}`;
  }
  if (event.kind === "pdf") set.pdfDownloads = sql`${v.pdfDownloads} + 1`;

  await withTenant(scope.organizationId, async (tx) => {
    await tx
      .insert(v)
      .values({
        organizationId: scope.organizationId,
        businessId: scope.businessId,
        surface: scope.surface,
        sessionPublicId: scope.sessionPublicId,
        checkoutSessionId: scope.surface === "checkout" ? (scope.checkoutSessionId ?? null) : null,
        portalSessionId:
          scope.surface === "portal"
            ? sql`(SELECT id FROM portal_sessions WHERE public_id = ${scope.sessionPublicId})`
            : null,
        enteredAt: entry ? now : null,
        viewedAt: entry ? null : now,
        ...(entry ?? {}),
        deviceCategory: ua.device,
        browser: ua.browser,
        os: ua.os,
        country,
        engagedMs: added,
        stepMs: steps,
        pdfDownloads: event.kind === "pdf" ? 1 : 0,
      })
      .onConflictDoUpdate({ target: [v.surface, v.sessionPublicId], set });
  });
  return "recorded";
}

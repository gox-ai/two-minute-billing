"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { actionError, actionOk, parseForm, type ActionResult } from "@/lib/action-result";
import {
  dismissTeamAlertsNotice,
  saveNotificationPreferences,
  saveNotificationSettings,
  type BusinessFilter,
  type KindPreference,
  type QuietHours,
  type SummarySetting,
} from "@/lib/api/notifications";

const PATH = "/account/notifications";

const pref = z.object({
  timing: z.enum(["instant", "summary", "off"]),
  push: z.boolean(),
  email: z.boolean(),
  above: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().int().min(0)).optional(),
});
const kinds = z.record(z.string().max(64), pref);
const summary = z.object({
  enabled: z.boolean(),
  channels: z.array(z.enum(["push", "email"])).max(2),
});
const hour = z.number().int().min(0).max(23);

/** What the settings form posts, as one JSON field (its controls live in client state). */
const payload = z.object({
  default: kinds,
  exceptions: z.array(z.object({ business: z.string().max(64), kinds })).max(500),
  business_filter: z.union([
    z.object({ mode: z.literal("all") }),
    z.object({ mode: z.literal("selected"), business_ids: z.array(z.string().max(64)).max(500) }),
  ]),
  daily: summary,
  weekly: summary,
  send_empty: z.boolean(),
  timezone: z.string().max(64),
  summary_hour: hour,
  weekly_day: z.number().int().min(1).max(7),
  quiet: z.object({ enabled: z.boolean(), from: hour, to: hour, disputes_through: z.boolean() }),
});

const schema = z.object({
  prefs: z
    .string()
    .max(200_000)
    .transform((s, ctx) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "We could not read the form. Reload the page." });
        return z.NEVER;
      }
    })
    .pipe(payload),
});

/** Your notifications: the member's settings for this organization, and the personal ones. */
export async function saveNotificationSettingsAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requireUser();
  const parsed = parseForm(schema, formData);
  if (parsed.error) return parsed.error;
  const p = parsed.data.prefs;
  if (p.business_filter.mode === "selected" && p.business_filter.business_ids.length === 0)
    return actionError("Correct the highlighted fields.", {
      errors: { business_filter: "Select at least one business." },
    });

  const prefs = await saveNotificationPreferences({
    default: p.default as Record<string, KindPreference>,
    exceptions: p.exceptions as Array<{ business: string; kinds: Record<string, KindPreference> }>,
    business_filter: p.business_filter as BusinessFilter,
    daily: p.daily as SummarySetting,
    weekly: p.weekly as SummarySetting,
    send_empty: p.send_empty,
    // Saving is reading the notice: it says to set notifications up.
    notice_dismissed: true,
  });
  if (!prefs.ok)
    return actionError(prefs.error ?? "We could not save your notifications.", {
      requestId: prefs.requestId,
    });
  const settings = await saveNotificationSettings({
    timezone: p.timezone,
    summary_hour: p.summary_hour,
    weekly_day: p.weekly_day,
    quiet: p.quiet as QuietHours,
  });
  revalidatePath(PATH);
  if (!settings.ok)
    return actionError(settings.error ?? "We could not save your summary time and quiet hours.", {
      requestId: settings.requestId,
    });
  return actionOk("Notifications saved.");
}

/** Hide the "Team alerts are now notifications" notice for good. Sends nothing. */
export async function dismissNotificationsNoticeAction(): Promise<{ ok: boolean }> {
  await requireUser();
  const r = await dismissTeamAlertsNotice();
  revalidatePath(PATH);
  return { ok: r.ok };
}

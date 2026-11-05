"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionError, actionOk, type ActionResult } from "@/lib/action-result";
import {
  resendTeamAlertConfirmation,
  updateBusiness,
  type BusinessSettingsPatch,
} from "@/lib/api/business-settings";
import { toMinor } from "@/lib/money";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 10;

/** Settings → Team alerts (`team_alerts_config`, 0489). The whole object is written every save. */
export async function saveTeamAlertsAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");

  const errors: Record<string, string> = {};
  const recipients = [
    ...new Set(
      str(fd, "recipients")
        .split(/[\s,;]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const bad = recipients.find((e) => !EMAIL_RE.test(e));
  if (bad) errors.recipients = `${bad} is not a valid email address.`;
  else if (recipients.length > MAX_RECIPIENTS)
    errors.recipients = `Enter ${MAX_RECIPIENTS} email addresses or fewer.`;

  const thresholds: Record<string, number> = {};
  for (const c of str(fd, "currencies")
    .split(",")
    .filter((x) => /^[A-Z]{3}$/.test(x))) {
    const raw = str(fd, `threshold_${c}`);
    if (!raw) continue;
    const major = Number(raw);
    if (!Number.isFinite(major) || major < 0)
      errors[`threshold_${c}`] = "Enter 0 or a positive amount.";
    else thresholds[c] = toMinor(major, c);
  }

  const overdue = fd.get("overdue_enabled") === "on";
  const webhooks = fd.get("webhook_failures_enabled") === "on";
  const digest = fd.get("daily_digest_enabled") === "on";
  const grants = fd.get("large_grants_enabled") === "on";
  if (overdue && Object.keys(thresholds).length === 0)
    errors.overdue_enabled = "Enter an amount for at least one currency.";
  if ((overdue || webhooks || digest || grants) && recipients.length === 0 && !errors.recipients)
    errors.recipients = "Enter at least one email address.";
  if (Object.keys(errors).length) return actionError("Correct the highlighted fields.", { errors });

  const body: BusinessSettingsPatch = {
    team_alerts_config: {
      recipients,
      overdue: { enabled: overdue, thresholds },
      webhook_failures: { enabled: webhooks },
      daily_digest: { enabled: digest },
      large_grants: { enabled: grants },
    },
  };
  const ev = Number(str(fd, "expected_version"));
  if (Number.isInteger(ev) && ev > 0) body.expected_version = ev;
  const res = await updateBusiness(biz, body);
  revalidatePath(`/businesses/${biz}/settings`);
  if (res.ok) return actionOk("Team alerts saved.");
  if (res.status === 409)
    return actionError(res.error ?? "Someone changed this business after you opened it.", {
      code: "conflict",
    });
  return actionError(res.error ?? "We could not save the team alerts.");
}

/** Settings → Team alerts → Send again: a new confirmation link to a pending address (0495). */
export async function resendTeamAlertConfirmationAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  const email = str(fd, "email");
  if (!biz || !email) return actionError("The business ID or the email address is missing.");
  const res = await resendTeamAlertConfirmation(biz, email);
  revalidatePath(`/businesses/${biz}/settings/team-alerts`);
  if (res.ok) return actionOk("Confirmation email sent.");
  return actionError(res.error ?? "We could not send the confirmation email.");
}

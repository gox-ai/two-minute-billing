"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionError, actionOk, type ActionResult } from "@/lib/action-result";
import { toMinor } from "@/lib/money";
import { updateBusiness } from "@/lib/api/business-settings";
import { LATE_USAGE_MIN_INTERVAL_HOURS, LATE_USAGE_WAIT_HOURS } from "@/lib/billing-rules";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const MAX_MINOR = 1_000_000_000;

/**
 * Billing rules → Late usage after a cancellation (`billing_rules_config.late_usage_invoices`).
 * Posts `late_usage_enabled` ("on" while checked) and, while on, `late_minimum:<CUR>` in major
 * units (blank = no minimum), `late_wait_hours` and `late_min_interval_hours`. Off posts only
 * `enabled`, so the stored values are kept.
 */
export async function saveLateUsageAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const enabled = fd.get("late_usage_enabled") === "on";
  const minimum: Record<string, number> = {};
  for (const [k, v] of fd.entries()) {
    if (!k.startsWith("late_minimum:")) continue;
    const cur = k.slice("late_minimum:".length).toUpperCase();
    const raw = String(v).trim();
    if (!raw) continue;
    const major = Number(raw);
    const minor = Number.isFinite(major) ? toMinor(major, cur) : NaN;
    if (!/^[A-Z]{3}$/.test(cur) || !Number.isSafeInteger(minor) || minor < 0 || minor > MAX_MINOR)
      return actionError("Correct the highlighted fields.", {
        errors: {
          late_minimum: `Enter an amount for ${cur} that is zero or more, or leave it empty.`,
        },
      });
    minimum[cur] = minor;
  }
  const hours = (key: string, b: { min: number; max: number }) => {
    const raw = str(fd, key);
    const n = Number(raw);
    return raw !== "" && Number.isInteger(n) && n >= b.min && n <= b.max ? n : null;
  };
  const wait = hours("late_wait_hours", LATE_USAGE_WAIT_HOURS);
  const interval = hours("late_min_interval_hours", LATE_USAGE_MIN_INTERVAL_HOURS);
  if (enabled && (wait == null || interval == null))
    return actionError("Correct the highlighted fields.", {
      errors: {
        ...(wait == null
          ? {
              late_wait_hours: `Enter ${LATE_USAGE_WAIT_HOURS.min} to ${LATE_USAGE_WAIT_HOURS.max} whole hours.`,
            }
          : {}),
        ...(interval == null
          ? {
              late_min_interval_hours: `Enter ${LATE_USAGE_MIN_INTERVAL_HOURS.min} to ${LATE_USAGE_MIN_INTERVAL_HOURS.max} whole hours.`,
            }
          : {}),
      },
    });
  const version = Number(str(fd, "expected_version"));
  const res = await updateBusiness(biz, {
    billing_rules_config: {
      late_usage_invoices: enabled
        ? { enabled, minimum, wait_hours: wait!, min_interval_hours: interval! }
        : { enabled },
    },
    ...(Number.isInteger(version) && version > 0 ? { expected_version: version } : {}),
  });
  revalidatePath(`/businesses/${biz}/settings`);
  if (res.ok) return actionOk("Billing rules saved.");
  if (res.status === 409)
    return actionError(res.error ?? "Someone changed this business after you opened it.", {
      code: "conflict",
    });
  return actionError(res.error ?? "We could not save the billing rules.");
}

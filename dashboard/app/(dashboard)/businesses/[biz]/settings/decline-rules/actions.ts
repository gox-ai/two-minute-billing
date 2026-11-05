"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionOk, actionError, type ActionResult } from "@/lib/action-result";
import {
  patchDeclineRule,
  resetDeclineRule,
  patchDeclineCode,
  resetDeclineCode,
} from "@/lib/api/decline-rules";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/**
 * A checkbox posts nothing when unchecked, so presence is the value — the same contract
 * every other form here reads (`CheckboxField` renders its hidden input only while
 * checked). That is why these read `fd.has(...)` rather than comparing a string.
 */
export async function setDeclineRuleAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  const rule = str(fd, "rule");
  if (!biz || !rule) return actionError("The business ID or the rule is missing. Reload the page.");

  try {
    await patchDeclineRule(biz, rule, {
      retriable: fd.has("retriable"),
      exposed_to_payer: fd.has("exposed_to_payer"),
    });
  } catch (e) {
    return actionError((e as Error).message);
  }
  revalidatePath(`/businesses/${biz}/settings/decline-rules`);
  return actionOk("Saved");
}

/**
 * Put the built-in answer back. The API answers 200 even when there was nothing to
 * remove, so clicking this twice is not an error and the button never needs disabling
 * based on state we might have stale.
 */
export async function resetDeclineRuleAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  const rule = str(fd, "rule");
  if (!biz || !rule) return actionError("The business ID or the rule is missing. Reload the page.");

  try {
    await resetDeclineRule(biz, rule);
  } catch (e) {
    return actionError((e as Error).message);
  }
  revalidatePath(`/businesses/${biz}/settings/decline-rules`);
  return actionOk("Reset to the built-in answer");
}

/**
 * The same two settings, made once for a canonical code instead of rule by rule.
 *
 * A rule that has its own setting keeps it — narrower wins — so this reaches the rules
 * nobody has touched, which is the point of having the level at all.
 */
export async function setDeclineCodeAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  const code = str(fd, "code");
  if (!biz || !code) return actionError("The business ID or the code is missing. Reload the page.");

  /**
   * Tri-state, unlike the rule form above: "" means leave it alone, so it must post as an
   * ABSENT key rather than as `false`. `fd.has()` cannot express that — a select always
   * posts something — which is why this reads the value instead of its presence.
   */
  const tri = (k: string) => {
    const v = str(fd, k);
    return v === "yes" ? true : v === "no" ? false : undefined;
  };
  const retriable = tri("retriable");
  const exposed = tri("exposed_to_payer");
  if (retriable === undefined && exposed === undefined)
    return actionError("Select at least one setting. To remove this setting, use Clear.");

  try {
    await patchDeclineCode(biz, code, {
      ...(retriable !== undefined ? { retriable } : {}),
      ...(exposed !== undefined ? { exposed_to_payer: exposed } : {}),
    });
  } catch (e) {
    return actionError((e as Error).message);
  }
  revalidatePath(`/businesses/${biz}/settings/decline-rules`);
  return actionOk("Saved for every rule with this code");
}

export async function resetDeclineCodeAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  const code = str(fd, "code");
  if (!biz || !code) return actionError("The business ID or the code is missing. Reload the page.");

  try {
    await resetDeclineCode(biz, code);
  } catch (e) {
    return actionError((e as Error).message);
  }
  revalidatePath(`/businesses/${biz}/settings/decline-rules`);
  return actionOk("Code-level setting removed");
}

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

/** "" = no code-level answer (each rule keeps its own). */
type Tri = "" | "yes" | "no";

export type DeclineChanges = {
  codes: Array<{ code: string; retriable: Tri; exposed_to_payer: Tri }>;
  rules: Array<
    { rule: string; reset: true } | { rule: string; retriable: boolean; exposed_to_payer: boolean }
  >;
};

const MAX_CHANGES = 2000;
const tri = (v: Tri) => (v === "yes" ? true : v === "no" ? false : null);

/**
 * The page's one Save: every pending code-level and rule-level change in one post.
 *
 * Codes go first, so a rule saved in the same batch still wins (narrower wins). A code
 * with neither answer set is a removal, not an empty override. Each write is idempotent,
 * so after a partial failure the client keeps its drafts and Save can simply run again.
 */
export async function saveDeclineRulesAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = String(fd.get("biz") ?? "").trim();
  if (!biz) return actionError("The business ID is missing. Reload the page.");

  let changes: DeclineChanges;
  try {
    changes = JSON.parse(String(fd.get("changes") ?? "")) as DeclineChanges;
  } catch {
    return actionError("We could not read the changes. Reload the page and try again.");
  }
  const codes = Array.isArray(changes?.codes) ? changes.codes : [];
  const rules = Array.isArray(changes?.rules) ? changes.rules : [];
  const total = codes.length + rules.length;
  if (total === 0) return actionError("There are no changes to save.");
  if (total > MAX_CHANGES) return actionError("Too many changes. Save fewer at a time.");

  let done = 0;
  try {
    for (const c of codes) {
      if (!c.retriable && !c.exposed_to_payer) await resetDeclineCode(biz, c.code);
      else
        await patchDeclineCode(biz, c.code, {
          retriable: tri(c.retriable),
          exposed_to_payer: tri(c.exposed_to_payer),
        });
      done++;
    }
    for (const r of rules) {
      if ("reset" in r) await resetDeclineRule(biz, r.rule);
      else
        await patchDeclineRule(biz, r.rule, {
          retriable: !!r.retriable,
          exposed_to_payer: !!r.exposed_to_payer,
        });
      done++;
    }
  } catch (e) {
    revalidatePath(`/businesses/${biz}/settings/decline-rules`);
    return actionError(
      done > 0
        ? `We saved ${done} of ${total} changes. ${(e as Error).message}`
        : (e as Error).message,
    );
  }
  revalidatePath(`/businesses/${biz}/settings/decline-rules`);
  return actionOk(total === 1 ? "Change saved." : `${total} changes saved.`);
}

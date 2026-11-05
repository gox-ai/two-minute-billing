"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { parseForm, actionOk, actionError, type ActionResult } from "@/lib/action-result";
import {
  startTimeTravel,
  advanceTimeTravel,
  stopTimeTravel,
  type TravelResult,
  type StopResult,
} from "@/lib/api/time-travel";
import { utcDateTime } from "@/lib/zod-utc";
import { fmtDate } from "@/lib/format";
import { businessTz } from "@/lib/business-tz-server";
import { requirePermission } from "@/lib/session";

// The forms send a full UTC instant: `DateTimeField granularity="date"` lets the operator
// pick a calendar day in the BUSINESS timezone and converts its 00:00 to UTC. Pinning the
// simulated clock to the business's day start (not the UTC day start, as this did before)
// matters because that clock drives the same term boundaries the engine anchors — on a
// day-anchored IST business a UTC-midnight genesis pinned the clock to 05:30 IST, i.e.
// mid-day, so each travel step landed inside a billing day instead of at its start.

const startSchema = z.object({ genesis: utcDateTime("Select a genesis date.") });
const travelSchema = z.object({
  destination: utcDateTime("Select a destination date."),
  // A blank input posts '' — treat as "not provided" (coerce would turn '' into 0 and fail).
  step_days: z.preprocess(
    (v) => (v == null || v === "" ? undefined : v),
    z.coerce.number().int().positive().max(366).optional(),
  ),
});

/** Map a write result → ActionResult, routing 403 (needs all-key) + 409 → conflict. */
function fromWrite(
  r: { ok: boolean; status: number; error?: string; requestId?: string },
  okMsg: string,
): ActionResult {
  if (r.ok) return actionOk(okMsg);
  if (r.status === 409) return actionError(r.error ?? "Conflict", { code: "conflict" });
  return actionError(r.error ?? `We could not complete the request (${r.status}).`, {
    requestId: r.requestId,
  });
}

export async function startTimeTravelAction(
  biz: string,
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("test_tools:manage", "admin");

  const parsed = parseForm(startSchema, formData);
  if (parsed.error) return parsed.error;
  const r = await startTimeTravel(biz, { genesis_time: parsed.data.genesis });
  const res = fromWrite(r, "Time Travel started. The clock is at the genesis date.");
  if (res.ok) revalidatePath(`/businesses/${biz}/time_travel`);
  return res;
}

export async function advanceTimeTravelAction(
  biz: string,
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("test_tools:manage", "admin");

  const parsed = parseForm(travelSchema, formData);
  if (parsed.error) return parsed.error;
  const r = await advanceTimeTravel(biz, {
    to_time: parsed.data.destination,
    step_days: parsed.data.step_days,
  });
  if (!r.ok) {
    if (r.status === 409) return actionError(r.error ?? "Conflict", { code: "conflict" });
    return actionError(r.error ?? `We could not travel forward (${r.status}).`);
  }
  // The travel endpoint serializes the machine + { steps, from, to }.
  const data = r.data as TravelResult | undefined;
  const summary = data
    ? `Traveled to ${fmtDate(data.to, await businessTz(biz))} in ${data.steps} tick${data.steps === 1 ? "" : "s"}.`
    : "Travel complete.";
  revalidatePath(`/businesses/${biz}/time_travel`);
  return actionOk(summary);
}

export async function stopTimeTravelAction(biz: string): Promise<ActionResult> {
  await requirePermission("test_tools:manage", "admin");

  const r = await stopTimeTravel(biz, { wipe: true });
  if (!r.ok) {
    if (r.status === 409) return actionError(r.error ?? "Conflict", { code: "conflict" });
    return actionError(r.error ?? `We could not stop Time Travel (${r.status}).`);
  }
  const data = r.data as StopResult | undefined;
  const wiped = data?.wiped ?? 0;
  revalidatePath(`/businesses/${biz}/time_travel`);
  return actionOk(`Time Travel stopped. Deleted ${wiped} simulated row${wiped === 1 ? "" : "s"}.`);
}

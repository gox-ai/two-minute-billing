/**
 * Put one fact on `notification_queue`, in the caller's transaction. The sink, the clocks and
 * direct callers (`credits/grant-limits.ts`) all come through here; `dedupe_key` makes a
 * repeat a no-op. The fan-out is woken after commit, so a rollback sends nothing.
 */
import { sql } from "drizzle-orm";
import { notificationQueue } from "@db/schema";
import { afterCommit, systemDb, type Tx } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import type { NotificationKind } from "./catalogue";
import type { NotificationPayload } from "./facts";

const log = createLogger("notifications.enqueue");

export interface EnqueueInput {
  organizationId: string;
  businessId: string;
  kinds: readonly NotificationKind[];
  dedupeKey: string;
  eventId?: string | null;
  payload?: NotificationPayload;
}

/** True when a row was added (false: the dedupe key was already there). */
export async function enqueueNotification(tx: Tx, input: EnqueueInput): Promise<boolean> {
  if (input.kinds.length === 0) return false;
  const rows = await tx
    .insert(notificationQueue)
    .values({
      organizationId: input.organizationId,
      businessId: input.businessId,
      eventId: input.eventId ?? null,
      dedupeKey: input.dedupeKey,
      kinds: [...input.kinds],
      payload: (input.payload ?? {}) as Record<string, unknown>,
    })
    .onConflictDoNothing({ target: notificationQueue.dedupeKey })
    .returning({ id: notificationQueue.id });
  if (rows.length === 0) return false;
  // After commit, through the no-argument SECURITY DEFINER wrapper (0533), as integrations do.
  if (!afterCommit(async () => requestNudge()))
    await tx.execute(sql`select public.app_nudge_notifications()`);
  return true;
}

let nudging: Promise<void> | null = null;
let nudgeAgain = false;
/** One nudge in flight per process; a request made meanwhile folds into one more after it. */
function requestNudge(): void {
  if (nudging) {
    nudgeAgain = true;
    return;
  }
  nudging = (async () => {
    do {
      nudgeAgain = false;
      try {
        await systemDb.execute(sql`select public.app_nudge_notifications()`);
      } catch (e) {
        log.warn("notification nudge failed; the minute drain will pick it up", {
          event: "notification_nudge_failed",
          error: (e as Error)?.message,
        });
      }
    } while (nudgeAgain);
    nudging = null;
  })();
}

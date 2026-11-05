import { setTimeout as sleep } from "node:timers/promises";
import { config } from "@/platform/config";

/**
 * Spaces charges to one gateway account at `GATEWAY_CHARGES_PER_S` per process, so a renewal
 * peak queues here instead of drawing 429s. A 429 has no booking (no error may strand), so the
 * cheap place to honour the gateway's limit is before the call. Per process: with N worker
 * processes, set it to the account's limit divided by N. 0 = no pacing.
 */
const nextSlotAt = new Map<string, number>();

export async function paceGatewayCharge(accountKey: string): Promise<void> {
  const perSecond = config.GATEWAY_CHARGES_PER_S;
  if (perSecond <= 0) return;
  const now = Date.now();
  const slot = Math.max(now, nextSlotAt.get(accountKey) ?? 0);
  nextSlotAt.set(accountKey, slot + 1000 / perSecond);
  if (slot > now) await sleep(slot - now);
}

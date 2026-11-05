/**
 * TM Billing Test Gateway — load profile (TMTEST_LOAD_PROFILE). Makes tmtest answer like a
 * production gateway: a sampled response time per charge and a share of declines on cards
 * that would otherwise succeed. Off by default; only the load-test harness turns it on.
 */
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "@/platform/config";

export interface LoadDecline {
  code: string;
  retriable: boolean;
}

/** Failed card charges by code over 30 days of production (2026-10-19), weights = counts. */
const DECLINE_MIX: Array<LoadDecline & { weight: number }> = [
  { code: "card_declined", retriable: true, weight: 47 },
  { code: "insufficient_funds", retriable: true, weight: 26 },
  { code: "do_not_honor", retriable: true, weight: 11 },
  { code: "incorrect_number", retriable: true, weight: 8 },
  { code: "processing_error", retriable: true, weight: 7 },
  { code: "card_velocity_exceeded", retriable: true, weight: 6 },
  { code: "card_restricted", retriable: true, weight: 4 },
  { code: "expired_card", retriable: false, weight: 3 },
  { code: "pickup_card", retriable: false, weight: 2 },
  { code: "lost_card", retriable: false, weight: 1 },
];
const TOTAL_WEIGHT = DECLINE_MIX.reduce((a, d) => a + d.weight, 0);

export const loadProfileOn = (): boolean => config.TMTEST_LOAD_PROFILE === "TRUE";

/** Log-normal through the configured P50 and P99 (z₉₉ = 2.326). */
export function sampleLatencyMs(): number {
  const p50 = config.TMTEST_LATENCY_P50_MS;
  if (p50 <= 0) return 0;
  const sigma = Math.log(Math.max(config.TMTEST_LATENCY_P99_MS, p50) / p50) / 2.326;
  const u1 = Math.random() || Number.MIN_VALUE;
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random());
  return Math.round(p50 * Math.exp(sigma * z));
}

/**
 * Requests per second the simulated gateway accepts (TMTEST_RATE_LIMIT_PER_S, 0 = no limit).
 * A token bucket per process, so N workers get N× the limit a real per-account cap allows.
 * Over the limit it waits one backoff and retries once, as an SDK does, then throws: an
 * unclassified throw is how a 429 leaves the real adapters.
 */
let tokens = Number.POSITIVE_INFINITY; // starts full: clamped to the rate on first use
let refilledAt = Date.now();
function takeToken(): boolean {
  const rate = config.TMTEST_RATE_LIMIT_PER_S;
  if (rate <= 0) return true;
  const now = Date.now();
  tokens = Math.min(rate, tokens + ((now - refilledAt) / 1000) * rate);
  refilledAt = now;
  if (tokens < 1) return false;
  tokens -= 1;
  return true;
}

export class LoadProfileRateLimited extends Error {
  constructor() {
    super("tmtest: 429 Too Many Requests (load profile rate limit)");
  }
}

export async function loadProfileWait(): Promise<void> {
  if (!loadProfileOn()) return;
  if (!takeToken()) {
    await sleep(1000);
    if (!takeToken()) throw new LoadProfileRateLimited();
  }
  await sleep(sampleLatencyMs());
}

/** Whether this charge declines, decided by its key so a replay gets the same answer. */
export function loadProfileDecline(key: string): LoadDecline | null {
  if (!loadProfileOn()) return null;
  const h = createHash("sha256").update(key).digest();
  const u = h.readUInt32BE(0) / 2 ** 32;
  if (u >= config.TMTEST_DECLINE_RATE) return null;
  let pick = (h.readUInt32BE(4) / 2 ** 32) * TOTAL_WEIGHT;
  for (const d of DECLINE_MIX) {
    pick -= d.weight;
    if (pick < 0) return { code: d.code, retriable: d.retriable };
  }
  return DECLINE_MIX[0]!;
}

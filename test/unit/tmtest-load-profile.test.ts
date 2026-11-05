import { afterEach, describe, expect, it } from "vitest";
import { config } from "@/platform/config";
import {
  LoadProfileRateLimited,
  loadProfileDecline,
  loadProfileWait,
  sampleLatencyMs,
} from "@/providers/tmtest/load-profile";

const cfg = config as unknown as Record<string, unknown>;
const saved = { ...cfg };
const set = (o: Record<string, unknown>) => Object.assign(cfg, o);
afterEach(() => Object.assign(cfg, saved));

describe("tmtest load profile", () => {
  it("declines nothing while off — the default", () => {
    expect(config.TMTEST_LOAD_PROFILE).toBe("FALSE");
    for (let i = 0; i < 1000; i++) expect(loadProfileDecline(`k${i}`)).toBeNull();
  });

  it("declines about TMTEST_DECLINE_RATE of charges, the same answer for the same key", () => {
    set({ TMTEST_LOAD_PROFILE: "TRUE", TMTEST_DECLINE_RATE: 0.11 });
    let declined = 0;
    for (let i = 0; i < 20_000; i++) if (loadProfileDecline(`key-${i}`)) declined++;
    expect(declined / 20_000).toBeGreaterThan(0.1);
    expect(declined / 20_000).toBeLessThan(0.12);
    const first = loadProfileDecline("replayed-key");
    for (let i = 0; i < 5; i++) expect(loadProfileDecline("replayed-key")).toEqual(first);
  });

  it("keeps hard declines non-retriable", () => {
    set({ TMTEST_LOAD_PROFILE: "TRUE", TMTEST_DECLINE_RATE: 1 });
    const seen = new Map<string, boolean>();
    for (let i = 0; i < 5000; i++) {
      const d = loadProfileDecline(`k${i}`)!;
      seen.set(d.code, d.retriable);
    }
    expect(seen.get("expired_card")).toBe(false);
    expect(seen.get("lost_card")).toBe(false);
    expect(seen.get("insufficient_funds")).toBe(true);
  });

  it("over the rate limit, retries once after a backoff and then throws like a 429", async () => {
    set({ TMTEST_LOAD_PROFILE: "TRUE", TMTEST_LATENCY_P50_MS: 0, TMTEST_RATE_LIMIT_PER_S: 1 });
    const outcomes = await Promise.allSettled([
      loadProfileWait(),
      loadProfileWait(),
      loadProfileWait(),
    ]);
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LoadProfileRateLimited);
  });

  it("samples response times around the configured P50", () => {
    set({ TMTEST_LATENCY_P50_MS: 2700, TMTEST_LATENCY_P99_MS: 8000 });
    const xs = Array.from({ length: 20_000 }, sampleLatencyMs).sort((a, b) => a - b);
    expect(xs[10_000]).toBeGreaterThan(2500);
    expect(xs[10_000]).toBeLessThan(2900);
    expect(xs[19_800]).toBeGreaterThan(7000);
    expect(xs[19_800]).toBeLessThan(9200);
  });
});

/** Customer / subscription usage of a TEST business against its limit. Server-only. */
import { apiGet } from "@/lib/api";

export interface TestLimitUsage {
  used: number;
  /** null = no limit. */
  limit: number | null;
}

export interface TestLimits {
  object: "test_limits";
  customers: TestLimitUsage;
  subscriptions: TestLimitUsage;
}

/** Null on failure: a missing usage figure must never cost the page. */
export function getTestLimits(biz: string): Promise<TestLimits | null> {
  return apiGet<TestLimits>(`/v1/businesses/${encodeURIComponent(biz)}/test_limits`).catch(
    () => null,
  );
}

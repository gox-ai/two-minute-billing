import { describe, expect, it } from "vitest";
import {
  PREVIOUS_WEBHOOK_SECRET_MS,
  WEBHOOK_SECRET_FALLBACK,
  previousWebhookSecretMs,
  setWebhookSecretFallback,
} from "@/modules/gateway/webhook-endpoint";

// A replaced secret must outlive the gateway's retries, or a late retry is refused as forged.

const DAY = 24 * 60 * 60 * 1000;

describe("replaced webhook secret window", () => {
  it("Adyen keeps the old HMAC key for its 30-day retry window", () => {
    expect(previousWebhookSecretMs("adyen")).toBe(30 * DAY);
  });

  it("other gateways keep 24 h", () => {
    expect(PREVIOUS_WEBHOOK_SECRET_MS).toBe(DAY);
    for (const key of ["stripe", "razorpay", "paypal", null, undefined, "no-such-gateway"]) {
      expect(previousWebhookSecretMs(key)).toBe(DAY);
    }
  });

  it("a rotation stamps the gateway's window", () => {
    const now = new Date("2026-10-27T00:00:00Z");
    const creds: Record<string, unknown> = {};
    setWebhookSecretFallback(creds, "old", "previous", "adyen", now);
    expect(creds[WEBHOOK_SECRET_FALLBACK.until]).toBe("2026-11-26T00:00:00.000Z");
    setWebhookSecretFallback(creds, "old", "previous", "stripe", now);
    expect(creds[WEBHOOK_SECRET_FALLBACK.until]).toBe("2026-10-28T00:00:00.000Z");
  });
});

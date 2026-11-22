import { describe, expect, it } from "vitest";
import { attributeAttempt } from "@/modules/invoicing/dunning-journey";

const row = (source: string, actor = "x", action = "invoice.collect") => ({
  source,
  actor,
  action,
});

describe("attributeAttempt: who started a collection attempt", () => {
  it("a gateway delivery's trace is the gateway, with no audit row", () => {
    expect(attributeAttempt("hook-abc", "razorpay", [])).toEqual({
      trigger: "webhook",
      actor: "razorpay",
    });
    expect(attributeAttempt("replay-abc", "stripe", []).trigger).toBe("webhook");
  });

  it("nothing recorded is unknown, not the API", () => {
    expect(attributeAttempt("api-abc", "razorpay", [])).toEqual({ trigger: null, actor: null });
    expect(attributeAttempt(null, "razorpay", [])).toEqual({ trigger: null, actor: null });
  });

  it("buyer surfaces by session actor or by source", () => {
    expect(attributeAttempt("api-1", "stripe", [row("api", "psess_1")]).trigger).toBe("portal");
    expect(attributeAttempt("api-1", "stripe", [row("portal", "psess_1")]).trigger).toBe("portal");
    expect(attributeAttempt("api-1", "stripe", [row("api", "cosess_1")]).trigger).toBe("checkout");
    expect(attributeAttempt("api-1", "stripe", [row("checkout")]).trigger).toBe("checkout");
  });

  it("people, the clock, agents and keys", () => {
    expect(attributeAttempt("api-1", "stripe", [row("dashboard", "a@example.com")])).toEqual({
      trigger: "dashboard",
      actor: "a@example.com",
    });
    expect(attributeAttempt("api-1", "stripe", [row("assistant", "a@example.com")]).trigger).toBe(
      "dashboard",
    );
    expect(attributeAttempt("job-1", "stripe", [row("api", "key_1")]).trigger).toBe(
      "billing_clock",
    );
    expect(attributeAttempt("api-1", "stripe", [row("mcp", "key_1")]).trigger).toBe("mcp");
    expect(attributeAttempt("api-1", "stripe", [row("api", "key_1")]).trigger).toBe("api");
    expect(attributeAttempt("api-1", "stripe", [row("system", "system")]).trigger).toBeNull();
  });

  it("a new payment method's charge wins over the surface that added it", () => {
    const rows = [row("portal", "psess_1", "customer.add_payment_method")];
    expect(attributeAttempt("hook-1", "razorpay", rows).trigger).toBe("new_payment_method");
  });
});

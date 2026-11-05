import { describe, expect, it } from "vitest";
import { shortReference } from "@/providers/short-reference";
import { BANK_DEBIT_METHODS, BUYER_METHOD_TYPES, METHOD_TYPES } from "@/providers/method-types";

describe("shortReference", () => {
  it("keeps a key that already fits", () => {
    expect(shortReference("pay_0192abc", { maxLength: 25 })).toBe("pay_0192abc");
  });

  it("is deterministic, so a retry sends the same reference", () => {
    const key = "pi_consume_pi_01JD4Z7Q3W8XKTV2M5N6P7R8S9_a2";
    const a = shortReference(key, { maxLength: 25 });
    expect(a).toBe(shortReference(key, { maxLength: 25 }));
    expect(a).toHaveLength(25);
  });

  it("separates different keys", () => {
    const a = shortReference("pi_consume_pi_x_a1".padEnd(40, "x"), { maxLength: 20 });
    const b = shortReference("pi_consume_pi_x_a2".padEnd(40, "x"), { maxLength: 20 });
    expect(a).not.toBe(b);
  });

  it("drops characters the gateway refuses", () => {
    const ref = shortReference("pay_0192abc", { maxLength: 30, alphanumericOnly: true });
    expect(ref).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("keeps the prefix inside the limit", () => {
    const ref = shortReference("x".repeat(80), { maxLength: 20, prefix: "tm" });
    expect(ref.startsWith("tm")).toBe(true);
    expect(ref).toHaveLength(20);
  });

  it("refuses a limit too short to stay collision-safe", () => {
    expect(() => shortReference("x".repeat(80), { maxLength: 12, prefix: "tm" })).toThrow();
  });
});

describe("method types", () => {
  it("accepts paypal as a buyer method type — a PayPal gateway offers nothing else", () => {
    expect(BUYER_METHOD_TYPES).toContain("paypal");
    expect(BUYER_METHOD_TYPES.length).toBe(METHOD_TYPES.length);
  });

  it("treats every direct-debit rail as a bank debit", () => {
    for (const m of ["bacs_debit", "au_becs_debit", "acss_debit", "autogiro", "payto"])
      expect(BANK_DEBIT_METHODS.has(m)).toBe(true);
    expect(BANK_DEBIT_METHODS.has("card")).toBe(false);
  });
});

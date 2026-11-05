/**
 * RazorPay `ensureCustomer`: a refusal is a `ProviderRefusalError` (the engine books it and
 * the API answers 400), an unknown outcome is a `ProviderIndeterminateError` (502, never
 * booked). Both used to be a plain Error, which a setup payment intent answered with 500.
 */
import { describe, it, expect } from "vitest";
import { RazorpayProvider } from "@/providers/razorpay";
import { ProviderIndeterminateError, ProviderRefusalError } from "@/providers/types";

function provider(api: () => Promise<unknown>): RazorpayProvider {
  const p = new RazorpayProvider({
    keyId: "rzp_test_unit",
    keySecret: "unit",
    apiBase: "https://api.invalid",
  });
  (p as unknown as { api: unknown }).api = api;
  return p;
}

const answering = (status: number, json: unknown) => provider(async () => ({ status, json }));
const INPUT = { customerRef: "cus_unit", email: "buyer@example.com" };

describe("razorpay ensureCustomer", () => {
  it("returns the customer on success", async () => {
    const ref = await answering(200, { id: "cust_XXXXXXXXXXXX01" }).ensureCustomer(INPUT);
    expect(ref.providerCustomerId).toBe("cust_XXXXXXXXXXXX01");
  });

  it("throws a refusal when the keys are rejected", async () => {
    const auth = { error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } };
    const p = answering(401, auth);
    await expect(p.ensureCustomer(INPUT)).rejects.toBeInstanceOf(ProviderRefusalError);
    await expect(p.ensureCustomer(INPUT)).rejects.toThrow(/Authentication failed/);
  });

  it("treats a 5xx as unknown, not a refusal", async () => {
    await expect(answering(503, {}).ensureCustomer(INPUT)).rejects.toBeInstanceOf(
      ProviderIndeterminateError,
    );
  });

  it("treats a lost answer as unknown, not a refusal", async () => {
    const lost = provider(async () => {
      throw new Error("fetch failed");
    });
    await expect(lost.ensureCustomer(INPUT)).rejects.toBeInstanceOf(ProviderIndeterminateError);
  });
});

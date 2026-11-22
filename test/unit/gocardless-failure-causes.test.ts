/**
 * GoCardless keeps WHY: a dead mandate's cause, a billing request the payer left or the bank
 * refused, and account-side API refusals hidden from the payer.
 */
import { describe, it, expect } from "vitest";
import { GoCardlessProvider } from "@/providers/gocardless";
import { declineHiddenFromPayer, normalizeGocardlessDecline } from "@/providers/decline-codes";

const gc = () =>
  new GoCardlessProvider({ accessToken: "unit", livemode: false, apiBase: "https://gc.invalid" });

type GcEvent = Parameters<GoCardlessProvider["mapEvent"]>[0];
const event = (
  resource_type: string,
  action: string,
  links: Record<string, string>,
  details: GcEvent["details"] = {},
): GcEvent => ({
  id: "EV0000000UNIT1",
  created_at: "2026-11-17T10:00:00Z",
  resource_type,
  action,
  links,
  details,
  resource_metadata: { tmbilling_ref: "pi_XXXXXXXXXXXX01" },
});

describe("gocardless mandate events carry the cause", () => {
  it("a cancelled mandate keeps its normalized cause and the scheme reason code", async () => {
    const [ev] = await gc().mapEvent(
      event(
        "mandates",
        "cancelled",
        { mandate: "MD0000000UNIT1" },
        {
          cause: "bank_account_closed",
          reason_code: "ADDACS-B",
          description: "The customer's bank account was closed.",
        },
      ),
    );
    expect(ev?.type).toBe("payment_method.mandate_updated");
    expect(ev?.failureCode).toBe("bank_account_closed");
    expect(ev?.providerFailureCode).toBe("bank_account_closed (ADDACS-B)");
    expect(ev?.failureMessage).toContain("closed");
  });

  it("a blocked mandate is a restricted account", async () => {
    const [ev] = await gc().mapEvent(
      event("mandates", "blocked", { mandate: "MD0000000UNIT1" }, { cause: "mandate_blocked" }),
    );
    expect(ev?.failureCode).toBe("bank_account_restricted");
  });

  it("a live mandate event carries no failure", async () => {
    const [ev] = await gc().mapEvent(
      event("mandates", "active", { mandate: "MD0000000UNIT1" }, { cause: "mandate_activated" }),
    );
    expect(ev?.failureCode).toBeUndefined();
  });
});

describe("gocardless billing request refusals stay on the open attempt", () => {
  const brq = (action: string, cause?: string) =>
    gc().mapEvent(
      event("billing_requests", action, { billing_request: "BRQ0000000UNIT1" }, { cause }),
    );

  it.each([
    ["flow_exited", "billing_request_flow_exited", "payment_abandoned"],
    [
      "bank_authorisation_expired",
      "billing_request_bank_authorisation_expired",
      "payment_abandoned",
    ],
    [
      "bank_authorisation_denied",
      "billing_request_bank_authorisation_denied",
      "debit_not_authorized",
    ],
    ["bank_authorisation_failed", "insufficient_funds", "insufficient_funds"],
  ])("%s → charge.failed %s", async (action, cause, code) => {
    const [ev] = await brq(action, cause);
    expect(ev?.type).toBe("charge.failed");
    expect(ev?.providerIntentId).toBe("BRQ0000000UNIT1");
    expect(ev?.providerChargeId).toBeUndefined();
    expect(ev?.failureCode).toBe(code);
  });

  it("an exit with no cause still reads as abandoned", async () => {
    const [ev] = await brq("flow_exited");
    expect(ev?.failureCode).toBe("payment_abandoned");
  });

  it("a cancelled billing request still ends the setup", async () => {
    const [ev] = await brq("cancelled", "billing_request_cancelled");
    expect(ev?.type).toBe("intent.setup_failed");
  });
});

describe("gocardless API refusals", () => {
  it.each(["access_token_revoked", "unauthorized", "insufficient_permissions"])(
    "%s is our request, hidden from the payer",
    (reason) => {
      const n = normalizeGocardlessDecline({ code: reason, category: "invalid_api_usage" });
      expect(n.code).toBe("gateway_request_rejected");
      expect(declineHiddenFromPayer(n.code)).toBe(true);
    },
  );

  it("any other invalid_api_usage reason is our request", () => {
    expect(
      normalizeGocardlessDecline({
        code: "invalid_document_structure",
        category: "invalid_api_usage",
      }).code,
    ).toBe("gateway_request_rejected");
  });

  it("rate_limit_exceeded is a retriable processing error", () => {
    const n = normalizeGocardlessDecline({
      code: "rate_limit_exceeded",
      category: "invalid_api_usage",
    });
    expect(n.code).toBe("processing_error");
    expect(n.retriable).toBe(true);
  });

  it("bank_account_disabled is a closed account", () => {
    const n = normalizeGocardlessDecline({
      code: "bank_account_disabled",
      category: "invalid_state",
    });
    expect(n.code).toBe("bank_account_closed");
    expect(n.retriable).toBe(false);
  });

  it("charge() classifies a revoked token from the refused create", async () => {
    const p = gc();
    (p as unknown as { create: unknown }).create = async () => ({
      ok: false,
      status: 401,
      error: {
        type: "invalid_api_usage",
        message: "Access token revoked",
        errors: [{ reason: "access_token_revoked", message: "Access token revoked" }],
      },
    });
    (p as unknown as { chargeDateFor: unknown }).chargeDateFor = async () => undefined;
    const r = await p.charge({
      idempotencyKey: "inv_unit_a1",
      amountMinor: 1_000n,
      currency: "GBP",
      customer: { providerKey: "gocardless", providerCustomerId: "CU0000000UNIT1" },
      paymentMethod: { providerKey: "gocardless", providerPaymentMethodId: "MD0000000UNIT1" },
    } as unknown as Parameters<GoCardlessProvider["charge"]>[0]);
    expect(r.failure?.code).toBe("gateway_request_rejected");
    expect(r.failure?.ruleId).toBe("gocardless.code.access_token_revoked");
  });
});

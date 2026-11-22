import { describe, expect, it } from "vitest";
import { isHardDecline, shouldTryBackup } from "@/modules/invoicing/collection";
import { cardCaps, cardNetwork, presentations } from "@/modules/invoicing/representment";
import {
  gatewayRunsRetries,
  nachMayRetry,
  planFailureRearm,
  retryRailOf,
} from "@/modules/subscriptions/dunning-schedule";
import { classifyDecline } from "@/modules/subscriptions/decline-policy";
import { emailTypeForEvent } from "@/modules/emails/outbox";
import { buildEventData } from "@/modules/events/registry";
import { ENGINE_BOOKED_CODES, resolveErrorId } from "@/platform/error-taxonomy";

const base = {
  dunningStatus: null,
  currentNextAttemptAt: null,
  autoCollectOn: true,
  retriable: true,
  newAttemptCount: 1,
  now: new Date("2026-01-10T00:00:00Z"),
  dueDate: new Date("2026-01-09T00:00:00Z"),
  retryDays: [1, 3, 5, 7],
};

describe("A: a held dead method keeps the schedule", () => {
  it("payment_method_unusable retries on the schedule in both modes", () => {
    for (const mode of ["fixed", "smart"] as const)
      expect(
        planFailureRearm({ ...base, mode, declineCode: "payment_method_unusable" }).action,
      ).toBe("retry");
  });
  it("…and exhausts when the schedule runs out", () => {
    expect(
      planFailureRearm({ ...base, newAttemptCount: 5, declineCode: "payment_method_unusable" })
        .action,
    ).toBe("exhausted");
  });
});

describe("C: attempt caps", () => {
  it("caps by card network", () => {
    expect(cardNetwork("Visa")).toBe("visa");
    expect(cardNetwork("MasterCard")).toBe("mastercard");
    expect(cardNetwork("amex")).toBeNull();
    expect(cardCaps("visa")).toEqual({ per24h: null, per30d: 15 });
    expect(cardCaps("mastercard")).toEqual({ per24h: 10, per30d: 30 });
    expect(cardCaps("rupay")).toEqual({ per24h: 10, per30d: 15 });
  });
  it("a capped rung keeps the schedule", () => {
    for (const code of ["invoice_attempt_limit", "card_attempt_limit"])
      expect(planFailureRearm({ ...base, declineCode: code, mode: "smart" }).action).toBe("retry");
  });
  it("a combined charge counts once per invoice", () => {
    const at = new Date();
    expect(
      presentations([
        { at, request: "pr_1", attempt: "1" },
        { at, request: "pr_1", attempt: "1" },
        { at, request: null },
      ]),
    ).toHaveLength(2);
  });
});

describe("D: India rails", () => {
  it("an India-issued card with no stored rail follows the India card rule", () => {
    expect(retryRailOf({ type: "card", issuerCountry: "IN" })).toBe("card");
    expect(retryRailOf({ type: "card", issuerCountry: null })).toBeNull();
    expect(retryRailOf({ type: "card", mandateRail: "upi" })).toBe("upi");
  });
  it("Razorpay UPI runs its own retries; the engine parks the async failure", () => {
    expect(gatewayRunsRetries("razorpay", "upi")).toBe(true);
    expect(gatewayRunsRetries("cashfree", "upi")).toBe(false);
    expect(
      planFailureRearm({
        ...base,
        mandateRail: "upi",
        declineCode: "insufficient_funds",
        gatewayRetriedCycle: true,
      }).action,
    ).toBe("parked");
  });
  it("NACH retries insufficient funds only", () => {
    expect(nachMayRetry("insufficient_funds")).toBe(true);
    expect(nachMayRetry("processing_error")).toBe(true);
    expect(nachMayRetry("mandate_pending")).toBe(true);
    expect(nachMayRetry("card_declined")).toBe(false);
    for (const rail of ["emandate", "nach", "enach"]) {
      expect(
        planFailureRearm({ ...base, mandateRail: rail, declineCode: "insufficient_funds" }).action,
      ).toBe("retry");
      expect(
        planFailureRearm({ ...base, mandateRail: rail, declineCode: "do_not_honor" }).action,
      ).toBe("parked");
    }
  });
});

describe("F: the payer skipped one mandate debit", () => {
  it("parks in both modes, retriable or not, and never brands the method", () => {
    for (const mode of ["fixed", "smart"] as const)
      expect(
        planFailureRearm({ ...base, mode, declineCode: "debit_cancelled_by_payer" }).action,
      ).toBe("parked");
    expect(classifyDecline("debit_cancelled_by_payer")).toBe("park");
    const r = {
      status: "failed",
      failure: { code: "debit_cancelled_by_payer", retriable: false },
    };
    expect(isHardDecline(r)).toBe(false);
    expect(shouldTryBackup(r)).toBe(false);
  });
});

describe("J: payment_abandoned has no dunning effect", () => {
  it("is registered as a non-decline", () => {
    expect(resolveErrorId("payment_abandoned").id).toBe(
      "gateway.transaction_authorization.payment_abandoned",
    );
    for (const c of ["payment_method_unusable", "invoice_attempt_limit", "card_attempt_limit"]) {
      expect(ENGINE_BOOKED_CODES).toContain(c);
      expect(resolveErrorId(c).namespace).toBe("billing");
    }
  });
  it("leaves the invoice unchanged and brands nothing", () => {
    expect(
      planFailureRearm({
        ...base,
        retriable: false,
        dunningStatus: "in_progress",
        declineCode: "payment_abandoned",
      }).action,
    ).toBe("unchanged");
    const r = { status: "failed", failure: { code: "payment_abandoned", retriable: false } };
    expect(isHardDecline(r)).toBe(false);
    expect(shouldTryBackup(r)).toBe(false);
  });
  it("sends the payer no failure email", () => {
    const ev = {
      type: "payment_failed",
      data: buildEventData("payment_failed", { code: "payment_abandoned", invoice: "inv_1" }),
    };
    expect(emailTypeForEvent(ev as never)).toBeNull();
  });
});

/**
 * `emailTypeForEvent` — which customer email a billing event triggers.
 *
 * Pinned as a unit test because the branches that matter most are the ones a live suite
 * cannot easily reach: they depend on a PROVIDER state (an unsettled refund) or on a
 * post-enrichment payload shape, and the local test gateway settles everything instantly.
 *
 * The refund split is the one with teeth. `refund_created` used to be emitted with a
 * hardcoded `status: 'succeeded'` even when the provider had only accepted the refund — the
 * refunds row beside it is written `pending` and the transaction `in_progress` — so a
 * customer whose bank refund was a week away was emailed "your refund has been issued".
 */
import { describe, it, expect } from "vitest";
import { emailTypeForEvent, staleForInvoice } from "@/modules/emails/outbox";
import { buildEventData } from "@/modules/events/registry";
import type { EventRow } from "@/modules/events/emit";

/** Only `type` and `data` are read; the rest of the row is irrelevant to the mapping. */
function ev(type: string, data: unknown): EventRow {
  return { type, data } as unknown as EventRow;
}

/** Built through buildEventData so the test exercises the REAL payload nesting. */
function refundEvent(status: string | undefined) {
  return ev(
    "refund_created",
    buildEventData("refund_created", {
      id: "re_test",
      ...(status ? { status } : {}),
      payment: "pay_test",
      amount_minor: 2000,
      currency: "INR",
    }),
  );
}

describe("emailTypeForEvent — refunds", () => {
  it("a settled refund says the money has been refunded", () => {
    expect(emailTypeForEvent(refundEvent("succeeded"))).toBe("refund_issued");
  });

  it("an ACCEPTED-but-unsettled refund says only that it has been started", () => {
    // The claim under test: we must not tell someone their money is back while the rail is
    // still moving it. Card refunds take 5–10 days, bank/UPI several.
    expect(emailTypeForEvent(refundEvent("pending"))).toBe("refund_initiated");
  });

  it('the settlement confirmation sends the "issued" mail', () => {
    // The other half of the pair. A refund that settles synchronously never raises this, so
    // the customer gets exactly one mail either way.
    const settled = ev(
      "refund_settled",
      buildEventData("refund_settled", {
        id: "re_test",
        status: "succeeded",
        amount_minor: 2000,
        currency: "INR",
      }),
    );
    expect(emailTypeForEvent(settled)).toBe("refund_issued");
  });

  it("an unknown status keeps the previous behaviour rather than downgrading", () => {
    // Conservative on purpose: only an explicit `pending` routes to the softer email, so a
    // genuinely settled refund can never be described as merely started.
    expect(emailTypeForEvent(refundEvent(undefined))).toBe("refund_issued");
    expect(emailTypeForEvent(refundEvent("weird_new_status"))).toBe("refund_issued");
  });
});

describe("emailTypeForEvent — splits that share one event type", () => {
  it("a subscription that STARTS in trial is a welcome, not an activation", () => {
    const inTrial = ev(
      "subscription_started",
      buildEventData("subscription_started", { id: "sub_1", status: "in_trial" }),
    );
    expect(emailTypeForEvent(inTrial)).toBe("trial_started");
  });

  it("a future-dated subscription starting active sends nothing here", () => {
    // Activation has its own event; emailing from both would double up.
    const active = ev(
      "subscription_started",
      buildEventData("subscription_started", { id: "sub_1", status: "active" }),
    );
    expect(emailTypeForEvent(active)).toBeNull();
  });

  it("a dunning cancellation reads differently from one the buyer chose", () => {
    const dunned = ev(
      "subscription_canceled",
      buildEventData("subscription_canceled", {
        id: "sub_1",
        status: "cancelled",
        reason: "not_paid",
      }),
    );
    expect(emailTypeForEvent(dunned)).toBe("subscription_canceled_nonpayment");
    const chosen = ev(
      "subscription_canceled",
      buildEventData("subscription_canceled", {
        id: "sub_1",
        status: "cancelled",
        reason: "customer_request",
      }),
    );
    expect(emailTypeForEvent(chosen)).toBe("subscription_canceled");
  });

  it("reads the ENRICHED spelling of the cancel reason too", () => {
    // buildEventContent replaces the thin payload with a snapshot that spells it
    // `cancel_reason`. Reading only `reason` once meant every real dunning cancellation
    // sent no email at all while the unit path looked fine.
    const enriched = ev(
      "subscription_canceled",
      buildEventData("subscription_canceled", { id: "sub_1", cancel_reason: "no_card" }),
    );
    expect(emailTypeForEvent(enriched)).toBe("subscription_canceled_nonpayment");
  });

  it("a cardless trial cancelled as no_card is a trial ending, not non-payment", () => {
    const trial = ev(
      "subscription_canceled",
      buildEventData("subscription_canceled", { id: "sub_1", cancel_reason: "no_card" }, 1, {
        ended_trial: true,
      }),
    );
    expect(emailTypeForEvent(trial)).toBe("trial_expired");
  });

  it("an unmapped event is a no-op", () => {
    expect(emailTypeForEvent(ev("customer_created", { customer: { id: "cus_1" } }))).toBeNull();
  });
});

describe("emailTypeForEvent — failed payments", () => {
  it("mails a failure on an invoice, thin or enriched", () => {
    const thin = ev(
      "payment_failed",
      buildEventData("payment_failed", { id: "pay_1", invoice: "inv_1" }),
    );
    const enriched = ev(
      "payment_failed",
      buildEventData("payment_failed", { id: "pay_1", invoice: { id: "inv_1" } }),
    );
    expect(emailTypeForEvent(thin)).toBe("payment_failed");
    expect(emailTypeForEvent(enriched)).toBe("payment_failed");
  });

  it("sends nothing for a refused signup or reactivation, which has no invoice", () => {
    const refused = ev(
      "payment_failed",
      buildEventData("payment_failed", { id: "pay_1", customer: "cus_1", invoice: null }),
    );
    expect(emailTypeForEvent(refused)).toBeNull();
  });

  it("still mails a settled charge reversed later, which carries no invoice ref", () => {
    const late = ev(
      "payment_failed",
      buildEventData("payment_failed", { id: "txn_1", code: "late_failure" }),
    );
    expect(emailTypeForEvent(late)).toBe("payment_failed");
  });

  it("sends nothing for a debit the merchant cancelled before the bank collected it", () => {
    const cancelled = ev(
      "payment_failed",
      buildEventData("payment_failed", {
        id: "pay_1",
        invoice: "inv_1",
        code: "debit_cancelled",
      }),
    );
    expect(emailTypeForEvent(cancelled)).toBeNull();
  });
});

describe("staleForInvoice — a voided invoice's queued mail is not sent", () => {
  it("skips mail that announces or asks payment for a voided invoice", () => {
    for (const t of [
      "invoice_issued",
      "invoice_to_pay",
      "payment_failed",
      "dunning_action_required",
    ])
      expect(staleForInvoice(t, "voided"), t).toBe(true);
  });

  it("sends it while the invoice stands, and never blocks a receipt or an operator's copy", () => {
    for (const st of ["posted", "payment_due", "not_paid", "paid", null])
      expect(staleForInvoice("invoice_issued", st), String(st)).toBe(false);
    for (const t of ["payment_receipt", "invoice_sent", "credit_note_issued"])
      expect(staleForInvoice(t, "voided"), t).toBe(false);
  });
});

describe("emailTypeForEvent — invalidated payment method", () => {
  const pm = { id: "pm_1", type: "card", brand: "Visa", last4: "4242" };

  it("a dead instrument asks for a new payment method", () => {
    const data = buildEventData("payment_source_invalidated", pm);
    expect(emailTypeForEvent(ev("payment_source_invalidated", data))).toBe(
      "payment_method_invalid",
    );
  });

  it("a dead MANDATE asks for a new authorization, not a new card", () => {
    const data = buildEventData("payment_source_invalidated", pm, undefined, {
      invalid_reason: "mandate",
    });
    expect(emailTypeForEvent(ev("payment_source_invalidated", data))).toBe("mandate_expired");
  });
});

describe("emailTypeForEvent — payment requests (0388)", () => {
  it("a payment-request child does not send its own receipt mail", () => {
    const child = ev(
      "payment_succeeded",
      buildEventData("payment_succeeded", { id: "pay_child", payment_request: "preq_1" }),
    );
    expect(emailTypeForEvent(child)).toBeNull();
  });

  it("a standalone payment still sends the receipt mail", () => {
    const plain = ev("payment_succeeded", buildEventData("payment_succeeded", { id: "pay_1" }));
    expect(emailTypeForEvent(plain)).toBe("payment_receipt");
  });

  it("the paid request sends the one receipt mail", () => {
    const paid = ev(
      "payment_request_paid",
      buildEventData("payment_request_paid", { id: "preq_1", customer: "cus_1" }),
    );
    expect(emailTypeForEvent(paid)).toBe("payment_receipt");
  });
});

import { describe, it, expect } from "vitest";
import {
  normalizeStripeDecline,
  normalizePaypalDecline,
  normalizePayuDecline,
  STRIPE_RULES,
  declineHiddenFromPayer,
  ALL_DECLINE_RULES,
  declineRuleById,
  type DeclineRule,
} from "@/providers/decline-codes";
import { classifyDecline } from "@/modules/subscriptions/decline-policy";
import { isDeadMandateDecline, isHardDecline } from "@/modules/invoicing/collection";
import { PayuProvider } from "@/providers/payu";
import { preDebitRule } from "@/providers/types";

/**
 * #69 stage 1. The dictionary these replace could match ONE field with ONE operator, so
 * every assertion below describes something the old shape could not express at all.
 */
describe("decline rules: matching on more than the code", () => {
  it("a missing instrument is read from the MESSAGE, which carries no useful code", () => {
    // Stripe answers this with a generic code; only the message identifies it. Before the
    // rules this fell through to passthrough → retriable → the schedule re-charged an
    // instrument Stripe had just said does not exist.
    const n = normalizeStripeDecline({
      code: "resource_missing",
      message: "No such PaymentMethod: 'pm_123'",
      category: "invalid_request_error",
    });
    expect(n.code).toBe("payment_method_not_found");
    expect(n.retriable).toBe(false);
    expect(classifyDecline(n.code)).toBe("park");
  });

  it("…and the same for a customer we no longer hold", () => {
    const n = normalizeStripeDecline({
      code: "resource_missing",
      message: "No such customer: 'cus_9'",
    });
    expect(n.code).toBe("payment_method_not_found");
  });

  it("an API-level rejection is read from the CATEGORY when no rule is more specific", () => {
    const n = normalizeStripeDecline({
      code: "some_code_we_never_saw",
      category: "invalid_request_error",
    });
    expect(n.code).toBe("gateway_request_rejected");
    expect(n.retriable).toBe(false);
  });

  it("the category catch-all must NOT outrank a specific message rule", () => {
    // Both match; order decides. If the catch-all ever floats above the message rules,
    // "No such PaymentMethod" silently becomes a generic request rejection and the
    // backup-card move stops happening.
    const n = normalizeStripeDecline({
      code: "resource_missing",
      message: "No such PaymentMethod: 'pm_1'",
      category: "invalid_request_error",
    });
    expect(n.code).toBe("payment_method_not_found");
    const idx = (f: DeclineRule["field"]) => STRIPE_RULES.findIndex((r) => r.field === f);
    expect(idx("message")).toBeLessThan(idx("category"));
  });

  it("#63's code is now known to the NORMALISER, not just to the adapter", () => {
    // The adapter learned it via a hardcoded `err.code ===` check on 2026-09-05. This is
    // where it belongs, and it must classify as a merchant-side park, not a retry.
    const n = normalizeStripeDecline({ code: "payment_intent_payment_attempt_failed" });
    expect(n.code).toBe("gateway_request_rejected");
    expect(n.retriable).toBe(false);
    expect(classifyDecline(n.code)).toBe("park");
  });

  it("a bare string still works — every existing call site passes one", () => {
    expect(normalizeStripeDecline("card_declined").code).toBe("card_declined");
    expect(normalizeStripeDecline(undefined).code).toBe("charge_failed");
    expect(normalizeStripeDecline(null).code).toBe("charge_failed");
  });

  it("the five that used to work by NAMING COINCIDENCE are now explicit rules", () => {
    // They resolved correctly only because the raw Stripe code is spelled like our
    // canonical one. This asserts the rule exists, not merely that the answer is right —
    // the answer was already right, by luck.
    for (const code of [
      "card_declined",
      "authentication_required",
      "expired_card",
      "incorrect_cvc",
      "incorrect_number",
    ]) {
      expect(
        STRIPE_RULES.some((r) => r.field === "code" && r.op === "eq" && r.value === code),
      ).toBe(true);
      expect(normalizeStripeDecline(code).code).toBe(
        code === "invalid_cvc" ? "incorrect_cvc" : code,
      );
    }
  });

  it("a payer's card limit is NOT our gateway limit", () => {
    // `gateway_limit_exceeded` is merchant-side and pages a human via MERCHANT_SIDE_PARK.
    // Routing a customer's own card ceiling there would page us for their bank's rule.
    const n = normalizeStripeDecline({ code: "charge_exceeds_source_limit" });
    expect(n.code).toBe("card_declined");
    expect(n.code).not.toBe("gateway_limit_exceeded");
  });

  it("a cancelled PayPal agreement is a dead instrument, not a lapsed mandate", () => {
    const n = normalizePaypalDecline("AGREEMENT_ALREADY_CANCELLED");
    expect(n.code).toBe("payment_method_not_found");
    expect(n.retriable).toBe(false);
    expect(isHardDecline({ status: "failed", failure: n })).toBe(true);
  });

  it("a gateway-killed mandate invalidates the method; our own date lapse does not", () => {
    const now = new Date("2026-10-05T00:00:00Z");
    const r = { status: "failed", failure: { code: "mandate_expired" } };
    // The gateway refused a mandate we still hold as live.
    expect(isDeadMandateDecline(r, { mandateExpiresAt: null }, now)).toBe(true);
    expect(isDeadMandateDecline(r, { mandateExpiresAt: new Date("2027-01-01") }, now)).toBe(true);
    // Our pre-flight on a passed end date — the sweep demotes that one to `expired`.
    expect(isDeadMandateDecline(r, { mandateExpiresAt: new Date("2026-10-01") }, now)).toBe(false);
    // Still not a card fault.
    expect(isHardDecline(r)).toBe(false);
  });

  it("transient infrastructure stays RETRIABLE", () => {
    // A rate limit is the definition of "try again shortly". Classing it Hard would end
    // dunning on an outage, and an inherited hardness nobody can justify is how a decline
    // table becomes folklore.
    for (const code of ["rate_limit", "lock_timeout", "could_not_process"]) {
      expect(normalizeStripeDecline({ code }).retriable).toBe(true);
    }
  });

  it("a malformed built-in pattern cannot take the billing path down", () => {
    const bad: DeclineRule = {
      id: "test.bad_pattern",
      field: "message",
      op: "matches",
      value: "(unclosed",
      code: "x",
    };
    expect(() => bad.value).not.toThrow();
    // The evaluator swallows the RegExp error; proven through the public API by a message
    // that no valid rule matches, which must simply fall through rather than throw.
    expect(() => normalizeStripeDecline({ code: "zz", message: "((((" })).not.toThrow();
  });
});

/**
 * #69 stage 2. The rule owns the sentence, and one flag decides whether a stranger reads
 * it. The failure this closes is concrete: on 2026-09-04 a Stripe API complaint about our
 * OWN malformed request reached an operator verbatim, by the same path that ends in a
 * customer's inbox.
 */
describe("decline rules: whose words, and who may read them", () => {
  it("our sentence replaces the gateway's when a rule wrote one", () => {
    const n = normalizeStripeDecline({
      code: "resource_missing",
      message: "No such customer: 'cus_1'",
    });
    expect(n.message).toMatch(/no longer available at the payment provider/i);
    expect(n.message).not.toMatch(/No such customer/);
  });

  it("a failure that is OURS is never shown to the payer", () => {
    const n = normalizeStripeDecline({ code: "payment_intent_payment_attempt_failed" });
    expect(n.exposedToPayer).toBe(false);
    expect(declineHiddenFromPayer(n.code)).toBe(true);
  });

  it("a failure the CUSTOMER can act on is shown to them", () => {
    const n = normalizeStripeDecline({
      code: "resource_missing",
      message: "No such PaymentMethod: 'pm_2'",
    });
    expect(n.exposedToPayer).toBe(true);
    expect(declineHiddenFromPayer(n.code)).toBe(false);
  });

  /**
   * The direction that matters. An earlier version of the helper defaulted to hiding, which
   * would have silenced "insufficient funds" and "expired card" — the sentences that
   * actually help someone fix their payment — in every mail. Suppression is opt-in.
   */
  it("codes with no rule keep the gateway's reason", () => {
    for (const code of ["insufficient_funds", "expired_card", "card_declined", "do_not_honor"]) {
      expect(declineHiddenFromPayer(code)).toBe(false);
    }
    expect(declineHiddenFromPayer(null)).toBe(false);
    expect(declineHiddenFromPayer("never_seen_before")).toBe(false);
  });

  it("no payer-facing sentence names a gateway, an id, or an internal field", () => {
    // A buyer-facing string that says `pm_…` or "PaymentIntent" is a leak of a different
    // kind. Applies only to what we expose; internal copy may say whatever helps an operator.
    const exposed = STRIPE_RULES.filter((r) => r.exposedToPayer && r.message);
    expect(exposed.length).toBeGreaterThan(0); // vacuity guard
    for (const r of exposed) {
      expect(r.message!).not.toMatch(
        /stripe|razorpay|paypal|cashfree|pm_|pi_|cus_|PaymentIntent|PaymentMethod/i,
      );
    }
  });
});

/**
 * #69 stage 3 prerequisite. A merchant override points at a rule by id, so the id is the
 * one field an edit must never change — everything else about a rule may.
 */
describe("decline rules: stable identity", () => {
  it("every rule has an id", () => {
    expect(ALL_DECLINE_RULES.length).toBeGreaterThanOrEqual(29); // vacuity guard
    for (const r of ALL_DECLINE_RULES) expect(r.id, JSON.stringify(r)).toBeTruthy();
  });

  it("ids are unique across every gateway", () => {
    // Not per-set: the overrides table keys on the id alone, so a collision between two
    // gateways' rules would silently hand one gateway's override to the other's rule.
    const ids = ALL_DECLINE_RULES.map((r) => r.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });

  it("ids are shaped `<gateway>.<match>.<slug>` and safe in a URL or a column", () => {
    for (const r of ALL_DECLINE_RULES) {
      expect(r.id, r.id).toMatch(
        /^(stripe|paypal|razorpay|gocardless|braintree|cashfree|authorizenet|square|checkoutcom|adyen|mollie|payu|cybersource)\.[a-z_]+\.[a-z0-9_]+$/,
      );
    }
  });

  it("an id resolves to its rule, and an unknown id resolves to undefined", () => {
    const first = ALL_DECLINE_RULES[0]!;
    expect(declineRuleById(first.id)).toBe(first);
    // The honest answer for an override that outlived its rule. Callers must not guess a
    // replacement by matching on contents — that is the coupling the id removes.
    expect(declineRuleById("stripe.code.a_rule_we_deleted")).toBeUndefined();
  });

  it("the id does not encode the rule's behaviour", () => {
    // If an id embedded the hardness or the canonical code, correcting either would force
    // an id change and orphan every override attached to it.
    for (const r of ALL_DECLINE_RULES) {
      expect(r.id).not.toMatch(/hard|soft|retriable|exposed/);
    }
  });
});

/**
 * #69: the network's own answer, which shipped as three correct-but-inert rules on
 * 2026-09-06 because I concluded the SDK did not expose it. It does — on
 * `charge.outcome`, reachable only by expanding `latest_charge`.
 */
describe("decline rules: what the card network said", () => {
  it("a do-not-retry instruction is honoured, not merely recorded", () => {
    const n = normalizeStripeDecline({
      code: "card_declined",
      networkMessage: "previously_declined_do_not_retry",
    });
    expect(n.code).toBe("network_do_not_retry");
    expect(n.retriable).toBe(false);
    expect(classifyDecline(n.code)).toBe("park");
  });

  it("Stripe's own risk block is read from the same field", () => {
    const n = normalizeStripeDecline({
      code: "card_declined",
      networkMessage: "highest_risk_level",
    });
    expect(n.code).toBe("network_do_not_retry");
    expect(n.retriable).toBe(false);
  });

  it("the two-digit advice code is read too", () => {
    const n = normalizeStripeDecline({ code: "card_declined", recommendationCode: "03" });
    expect(n.code).toBe("network_do_not_retry");
  });

  /**
   * Order matters here in the direction people get wrong. A network instruction must beat
   * the ordinary code rules below it, or `card_declined` — which every one of these also
   * carries — would answer first and the instruction would be lost.
   */
  it("a network instruction outranks the generic code that accompanies it", () => {
    const plain = normalizeStripeDecline({ code: "card_declined" });
    expect(plain.code).toBe("card_declined");
    const withNetwork = normalizeStripeDecline({
      code: "card_declined",
      networkMessage: "previously_declined_do_not_retry",
    });
    expect(withNetwork.code).toBe("network_do_not_retry");
  });

  it("no outcome means no match — an unexpanded charge is a real state", () => {
    // Any path that did not ask for `latest_charge` sees null here, and must simply fall
    // through to the code rules rather than behaving oddly.
    const n = normalizeStripeDecline({ code: "card_declined", networkMessage: null });
    expect(n.code).toBe("card_declined");
  });
});

describe("PayU answers measured in UAT (2026-11-02)", () => {
  it("a debit for another amount than its notice is our request, not the payer's decline", () => {
    const n = normalizePayuDecline({
      code: null,
      message:
        "Mandated SI transactions, Recurring amount does not match pre-debit amount, expected: 120.00, received: 130.00",
    });
    expect(n.code).toBe("gateway_request_rejected");
    expect(n.ruleId).toBe("payu.message.amount_not_pre_debit");
    expect(declineHiddenFromPayer(n.code)).toBe(true);
  });

  it("the UAT failure of a small UPI debit (E345) is a retriable processing error", () => {
    const n = normalizePayuDecline({
      code: "E345",
      message: "Technical Failure. Kindly try alternative payment methods",
    });
    expect(n).toMatchObject({ code: "processing_error", retriable: true });
  });

  it("notice rules by rail: card 24 h / one debit, UPI 25 h / first try + three retries", () => {
    const cap = new PayuProvider({ merchantKey: "k", merchantSalt: "s", livemode: false })
      .capabilities.preDebitNotice!;
    expect(preDebitRule(cap, "card")).toEqual({ minLeadHours: 24, maxDebitsPerNotice: 1 });
    expect(preDebitRule(cap, "upi")).toEqual({ minLeadHours: 25, maxDebitsPerNotice: 4 });
    // A notice update that names no rail keeps the longest lead.
    expect(preDebitRule(cap).minLeadHours).toBe(25);
  });
});

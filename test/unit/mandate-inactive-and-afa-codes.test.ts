import { describe, it, expect } from "vitest";
import {
  normalizeStripeDecline,
  normalizeRazorpayDecline,
  resolveStoredErrorId,
  declineHiddenFromPayer,
  ALL_DECLINE_RULES,
  STRIPE_RULES,
  RAZORPAY_RULES,
  type DeclineRule,
} from "@/providers/decline-codes";
import { classifyDecline, PARK_EVEN_IN_FIXED_MODE } from "@/modules/subscriptions/decline-policy";
import { isHardDecline } from "@/modules/invoicing/collection";

/**
 * Three documented e-mandate codes that fell through the passthrough.
 *
 * What regresses without this: the raw gateway string becomes our canonical code,
 * `retriable` computes to true, `classifyDecline` falls to its liberal `retry` default,
 * and the ladder re-presents a debit that cannot be approved — forever, against a dead
 * mandate or an approval nobody was asked for.
 */

/**
 * THE ANTI-PHANTOM GUARD, and it has to be inline here.
 *
 * `razorpay-documented-reasons.test.ts` re-reads its values out of committed captures in
 * `docs/references/`. Neither source page below is captured there, so the evidence is
 * pinned as text instead: the exact table a code appears in (which decides the FIELD) and
 * the exact resolution sentence (which decides the CODE). A rule whose remedy contradicts
 * the sentence beside it is the failure this file exists to stop — the same one that
 * deleted the `payment_intent_mandate_inactive` phantom.
 */
const DOCUMENTED = [
  {
    value: "transaction_not_approved",
    gateway: "stripe",
    /** Listed under "Decline code", NOT the "Error code" table on the same page. */
    field: "decline_code" as const,
    source: "https://docs.stripe.com/india-recurring-payments",
    description:
      "Attempting a subsequent payment when the customer has paused permissions to auto-debit, or doesn't authenticate the payment when it's required returns this code.",
    code: "afa_not_completed",
  },
  {
    value: "mandate_not_active",
    gateway: "razorpay",
    field: "code" as const,
    source: "https://razorpay.com/docs/payments/recurring-payments/emandate/errors/",
    description: "The registered mandate is no longer active.",
    resolution: "The customer must re-register for the mandate.",
    code: "mandate_expired",
  },
  {
    value: "payment_mandate_not_active",
    gateway: "razorpay",
    field: "code" as const,
    source: "https://razorpay.com/docs/payments/recurring-payments/emandate/errors/",
    description: "The registered mandate is not yet activated at the bank.",
    resolution: "Please retry after some time or reach out to Razorpay.",
    code: "processing_error",
  },
] as const;

const ruleFor = (value: string): DeclineRule | undefined =>
  ALL_DECLINE_RULES.find((r) => r.value.toLowerCase() === value.toLowerCase());

describe("e-mandate codes: each one is a rule, on the field the gateway sends it on", () => {
  it.each(DOCUMENTED)("$value is a rule keyed on $field", ({ value, field, code }) => {
    const rule = ruleFor(value);
    expect(rule, value).toBeDefined();
    // The field is not cosmetic: a `code` rule would never see a signal that carries the
    // value only in `decline_code`, and vice versa.
    expect(rule!.field, value).toBe(field);
    expect(rule!.op, value).toBe("eq");
    expect(rule!.code, value).toBe(code);
    // A rule, not a table entry — a table entry has no id for an override to point at
    // and never reaches the merchant's Error handling screen.
    expect(rule!.id, value).toMatch(/^(stripe|razorpay)\./);
  });

  it("no rule id is duplicated, and no rule needs a case twin", () => {
    const ids = ALL_DECLINE_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    // `ruleMatches` lowercases both sides, so the uppercase spelling resolves identically.
    expect(normalizeRazorpayDecline("MANDATE_NOT_ACTIVE").code).toBe("mandate_expired");
    expect(normalizeStripeDecline({ declineCode: "TRANSACTION_NOT_APPROVED" }).code).toBe(
      "afa_not_completed",
    );
  });

  it("the Stripe rule outranks the generic card decline it arrives beside", () => {
    // On a card decline Stripe puts the generic `card_declined` in `code` and the real
    // reason in `decline_code`. If `stripe.code.card_declined` were evaluated first the
    // specific reason would be lost.
    const withGeneric = normalizeStripeDecline({
      code: "card_declined",
      declineCode: "transaction_not_approved",
    });
    expect(withGeneric.code).toBe("afa_not_completed");
    expect(withGeneric.ruleId).toBe("stripe.decline_code.transaction_not_approved");
    const specific = STRIPE_RULES.findIndex(
      (r) => r.id === "stripe.decline_code.transaction_not_approved",
    );
    const generic = STRIPE_RULES.findIndex((r) => r.id === "stripe.code.card_declined");
    expect(specific).toBeGreaterThanOrEqual(0);
    expect(specific).toBeLessThan(generic);
  });
});

describe("e-mandate codes: what each one now does to the buyer", () => {
  /**
   * `park` means: the dunning ladder stops re-presenting and the invoice waits for the
   * buyer to act (complete the AFA approval, or re-register the mandate) until the park
   * deadline closes it. `retry` means the ordinary schedule runs, which is correct only
   * when the failure clears on its own.
   */
  it("transaction_not_approved parks — the debit was never approved, not refused", () => {
    const n = normalizeStripeDecline({ declineCode: "transaction_not_approved" });
    expect(n.code).toBe("afa_not_completed");
    expect(classifyDecline(n.code)).toBe("park");
    // Fixed-mode too: the buyer was never asked to pay, so exhausting a schedule and
    // cancelling would punish them for an approval nobody requested.
    expect(PARK_EVEN_IN_FIXED_MODE.has(n.code)).toBe(true);
  });

  it("mandate_not_active parks — only a new authorisation can pay this invoice", () => {
    const n = normalizeRazorpayDecline("mandate_not_active");
    expect(n.code).toBe("mandate_expired");
    expect(classifyDecline(n.code)).toBe("park");
    expect(PARK_EVEN_IN_FIXED_MODE.has(n.code)).toBe(true);
  });

  it("payment_mandate_not_active RETRIES — the mandate is pending, not dead", () => {
    // RazorPay: "not yet activated at the bank", next step "please retry after some
    // time". e-NACH activation lands days after registration, so the schedule is the fix.
    // Parking would tell the buyer to re-register an authorisation about to start working.
    const n = normalizeRazorpayDecline("payment_mandate_not_active");
    expect(n.code).toBe("processing_error");
    expect(classifyDecline(n.code)).toBe("retry");
    expect(PARK_EVEN_IN_FIXED_MODE.has(n.code)).toBe(false);
  });

  it("none of the three still passes through raw", () => {
    // The regression itself: an unmapped value becomes its own canonical code and gets
    // the liberal retry default.
    for (const { value } of DOCUMENTED) expect(ruleFor(value)!.code).not.toBe(value);
    expect(normalizeRazorpayDecline("mandate_not_active").code).not.toBe("mandate_not_active");
  });

  it("each one resolves to a taxonomy family when read back out of storage", () => {
    // Rows written before these rules existed hold the raw gateway spelling.
    for (const { value, code } of DOCUMENTED) {
      const r = resolveStoredErrorId(value);
      expect(r.known, value).toBe(true);
      expect(r.id, value).toBe(resolveStoredErrorId(code).id);
      // The stored spelling is preserved; only the id comes from the canonical form.
      expect(r.code, value).toBe(value);
    }
  });
});

describe("e-mandate codes: RazorPay's dead mandate answers exactly what Stripe's does", () => {
  /**
   * The point of the pair. Stripe's `payment_intent_mandate_invalid` — "Attempting a
   * recurring payment using an inactive mandate" — was fixed; RazorPay's twin spelling
   * still retried forever against the same dead authorisation.
   */
  it("mandate_not_active === payment_intent_mandate_invalid, field by field", () => {
    const theirs = normalizeRazorpayDecline("mandate_not_active");
    const stripe = normalizeStripeDecline("payment_intent_mandate_invalid");
    expect(theirs.code).toBe(stripe.code);
    expect(theirs.retriable).toBe(stripe.retriable);
    expect(classifyDecline(theirs.code)).toBe(classifyDecline(stripe.code));
    expect(isHardDecline({ status: "failed", failure: theirs })).toBe(
      isHardDecline({ status: "failed", failure: stripe }),
    );
  });

  it("…and payment_mandate_not_active deliberately does NOT", () => {
    // Guards the split. Collapsing the two onto one token would restore the wrong remedy
    // for whichever half lost.
    expect(normalizeRazorpayDecline("payment_mandate_not_active").code).not.toBe("mandate_expired");
  });
});

describe("e-mandate codes: no working instrument is branded invalid", () => {
  /**
   * `retriable: false` is what `isHardDecline` reads as a BAD INSTRUMENT — it marks the
   * payment method `invalid` and takes it out of collection for every future charge.
   * `mandate_expired` is exempt via `NOT_THE_INSTRUMENTS_FAULT`; `afa_not_completed` is
   * NOT, so it must stay retriable or a missed approval would condemn a healthy card.
   */
  it.each(DOCUMENTED)("$value never marks the payment method invalid", ({ value, gateway }) => {
    const n =
      gateway === "stripe"
        ? normalizeStripeDecline({ declineCode: value })
        : normalizeRazorpayDecline(value);
    expect(isHardDecline({ status: "failed", failure: n }), value).toBe(false);
  });

  it("afa_not_completed stays retriable, because it is not exempt from the hard-decline read", () => {
    // The trap: `retriable: false` here looks like the tidy way to stop the ladder, and
    // it would brand the card instead. The stop is the PARK.
    expect(normalizeStripeDecline({ declineCode: "transaction_not_approved" }).retriable).toBe(
      true,
    );
  });

  it("no new rule carries a message, so no dunning mail loses its reason", () => {
    // One unexposed sentence on any rule for a code silences that code everywhere.
    for (const { code } of DOCUMENTED) expect(declineHiddenFromPayer(code), code).toBe(false);
    for (const { value } of DOCUMENTED) expect(ruleFor(value)!.message).toBeUndefined();
  });
});

describe("e-mandate codes: the additions are the ones intended", () => {
  it("exactly one decline_code rule exists, and it is this one", () => {
    // A second one would need the same precedence argument made again; make adding it
    // deliberate rather than incidental.
    const byDeclineCode = ALL_DECLINE_RULES.filter((r) => r.field === "decline_code");
    expect(byDeclineCode.map((r) => r.id)).toEqual([
      "stripe.decline_code.transaction_not_approved",
    ]);
  });

  it("the RazorPay pair sits in RAZORPAY_RULES, not in the legacy table", () => {
    const ids = RAZORPAY_RULES.map((r) => r.id);
    expect(ids).toContain("razorpay.code.mandate_not_active");
    expect(ids).toContain("razorpay.code.payment_mandate_not_active");
  });
});

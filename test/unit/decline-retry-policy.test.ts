import { describe, expect, it } from "vitest";
import * as D from "@/providers/decline-codes";
import type { DeclineSignal, NormalizedDecline } from "@/providers/decline-codes";
import { ADYEN_DOCUMENTED_ERROR_CODES } from "@/providers/adyen-documented-codes";
import {
  AUTHORIZENET_DOCUMENTED_MESSAGE_CODES,
  AUTHORIZENET_DOCUMENTED_REASON_CODES,
} from "@/providers/authorizenet-documented-codes";
import {
  BRAINTREE_DOCUMENTED_PROCESSOR_CODES,
  BRAINTREE_DOCUMENTED_REJECTION_REASONS,
  BRAINTREE_DOCUMENTED_SETTLEMENT_CODES,
  BRAINTREE_DOCUMENTED_VALIDATION_CODES,
} from "@/providers/braintree-documented-codes";
import {
  CASHFREE_DOCUMENTED_ERROR_TYPES,
  CASHFREE_DOCUMENTED_PAYMENT_REASONS,
  CASHFREE_DOCUMENTED_SUBSCRIPTION_REASONS,
} from "@/providers/cashfree-documented-codes";
import { CHECKOUTCOM_DOCUMENTED_ERROR_CODES } from "@/providers/checkoutcom-documented-codes";
import { CYBERSOURCE_DOCUMENTED_ERROR_CODES } from "@/providers/cybersource-documented-codes";
import { GOCARDLESS_DOCUMENTED_ERROR_CODES } from "@/providers/gocardless-documented-codes";
import { MOLLIE_DOCUMENTED_ERROR_CODES } from "@/providers/mollie-documented-codes";
import {
  PAYPAL_DOCUMENTED_ADVICE_CODES,
  PAYPAL_DOCUMENTED_ISSUES,
  PAYPAL_DOCUMENTED_PROCESSOR_CODES,
} from "@/providers/paypal-documented-codes";
import { PAYU_DOCUMENTED_ERROR_CODES } from "@/providers/payu-documented-codes";
import { RAZORPAY_DOCUMENTED_ERROR_CODES } from "@/providers/razorpay-documented-codes";
import { SQUARE_DOCUMENTED_ERROR_CODES } from "@/providers/square-documented-codes";
import {
  STRIPE_DOCUMENTED_DECLINE_CODES,
  STRIPE_DOCUMENTED_ERROR_CODES,
} from "@/providers/stripe-documented-codes";

/**
 * Recognised is not enough: a code can have a rule and still be retried against a dead card.
 * Every documented code, in the shape its adapter sends, must land on the policy's side.
 */

/** Dead instrument or ended authorization: never re-presented. */
const DEAD = new Set([
  "expired_card",
  "lost_card",
  "stolen_card",
  "pickup_card",
  "fraudulent",
  "revocation_of_authorization",
  "bank_account_closed",
  "bank_account_not_found",
  "bank_account_invalid_details",
  "bank_account_restricted",
  "debit_not_authorized",
  "network_do_not_retry",
  "incorrect_number",
  "payment_method_not_found",
  "mandate_expired",
]);

/** Soft by policy: insufficient funds, generic refusals, transient and our own faults. */
const SOFT = new Set([
  "insufficient_funds",
  "card_declined",
  "do_not_honor",
  "processing_error",
  "try_again_later",
  "retry_too_soon",
  "authentication_required",
  "incorrect_cvc",
  "gateway_request_rejected",
  "gateway_error",
  "payment_abandoned",
  "charge_failed",
  "debit_cancelled_by_payer",
]);

/** Dead canonical code, soft on purpose: the gateway's own next step is to retry or re-enter. */
const SOFT_ON_PURPOSE: Record<string, string> = {
  "razorpay bank_account_validation_failed": "Razorpay: retry or contact Razorpay",
  "razorpay incorrect_card_details": "any field may be wrong, not the number",
  "cashfree account_number_missing": "the payer did not enter the account",
  "cashfree Payer Account Validation Failure": "TPV check; correct details pay",
};

type Norm = (s: string | DeclineSignal) => NormalizedDecline;
type Case = [gateway: string, raw: string, signal: string | DeclineSignal];

const each = (
  gateway: string,
  codes: readonly string[],
  never: Readonly<Record<string, string>>,
  shape: (c: string) => string | DeclineSignal = (c) => c,
): Case[] =>
  codes.filter((c) => !Object.hasOwn(never, c)).map((c) => [gateway, c, shape(c)] as Case);

const CASES: Case[] = [
  ...each("stripe", STRIPE_DOCUMENTED_ERROR_CODES, D.STRIPE_CODES_OUR_CALLS_NEVER_RAISE, (c) => ({
    code: c,
    category: "card_error",
  })),
  ...each("stripe", STRIPE_DOCUMENTED_DECLINE_CODES, {}, (c) => ({
    code: c,
    declineCode: c,
    category: "card_error",
  })),
  ...each("paypal", PAYPAL_DOCUMENTED_ISSUES, D.PAYPAL_CODES_OUR_CALLS_NEVER_RAISE),
  ...each(
    "paypal",
    PAYPAL_DOCUMENTED_PROCESSOR_CODES,
    D.PAYPAL_CODES_OUR_CALLS_NEVER_RAISE,
    (c) => ({
      code: "DECLINED",
      declineCode: c,
    }),
  ),
  ...each("paypal", PAYPAL_DOCUMENTED_ADVICE_CODES, D.PAYPAL_CODES_OUR_CALLS_NEVER_RAISE, (c) => ({
    code: "DECLINED",
    recommendationCode: c,
    cardBrand: "mastercard",
  })),
  ...each("razorpay", RAZORPAY_DOCUMENTED_ERROR_CODES, D.RAZORPAY_CODES_OUR_CALLS_NEVER_RAISE),
  ...each(
    "gocardless",
    GOCARDLESS_DOCUMENTED_ERROR_CODES,
    D.GOCARDLESS_CODES_OUR_CALLS_NEVER_RAISE,
  ),
  ...[
    BRAINTREE_DOCUMENTED_PROCESSOR_CODES,
    BRAINTREE_DOCUMENTED_SETTLEMENT_CODES,
    BRAINTREE_DOCUMENTED_REJECTION_REASONS,
  ].flatMap((l) => each("braintree", l, D.BRAINTREE_CODES_OUR_CALLS_NEVER_RAISE)),
  ...each(
    "braintree",
    BRAINTREE_DOCUMENTED_VALIDATION_CODES,
    D.BRAINTREE_CODES_OUR_CALLS_NEVER_RAISE,
    (c) => ({ code: c, category: "VALIDATION" }),
  ),
  ...each(
    "cashfree",
    CASHFREE_DOCUMENTED_PAYMENT_REASONS,
    D.CASHFREE_CODES_OUR_CALLS_NEVER_RAISE,
    (c) => ({
      code: c,
    }),
  ),
  ...each("cashfree", CASHFREE_DOCUMENTED_SUBSCRIPTION_REASONS, {}, (c) => ({ message: c })),
  ...each("cashfree", CASHFREE_DOCUMENTED_ERROR_TYPES, {}, (c) => ({ category: c })),
  ...[AUTHORIZENET_DOCUMENTED_MESSAGE_CODES, AUTHORIZENET_DOCUMENTED_REASON_CODES].flatMap((l) =>
    each("authorizenet", l, D.AUTHORIZENET_CODES_OUR_CALLS_NEVER_RAISE),
  ),
  ...each("adyen", ADYEN_DOCUMENTED_ERROR_CODES, D.ADYEN_CODES_OUR_CALLS_NEVER_RAISE),
  ...each(
    "checkoutcom",
    CHECKOUTCOM_DOCUMENTED_ERROR_CODES,
    D.CHECKOUTCOM_CODES_OUR_CALLS_NEVER_RAISE,
  ),
  ...each("mollie", MOLLIE_DOCUMENTED_ERROR_CODES, D.MOLLIE_CODES_OUR_CALLS_NEVER_RAISE),
  ...each("square", SQUARE_DOCUMENTED_ERROR_CODES, D.SQUARE_CODES_OUR_CALLS_NEVER_RAISE),
  ...each("payu", PAYU_DOCUMENTED_ERROR_CODES, D.PAYU_CODES_OUR_CALLS_NEVER_RAISE),
  ...each(
    "cybersource",
    CYBERSOURCE_DOCUMENTED_ERROR_CODES,
    D.CYBERSOURCE_CODES_OUR_CALLS_NEVER_RAISE,
  ),
];

const NORMALIZE: Record<string, Norm> = {
  stripe: D.normalizeStripeDecline,
  paypal: D.normalizePaypalDecline,
  razorpay: D.normalizeRazorpayDecline,
  gocardless: D.normalizeGocardlessDecline,
  braintree: D.normalizeBraintreeDecline,
  cashfree: D.normalizeCashfreeDecline,
  authorizenet: D.normalizeAuthorizenetDecline,
  adyen: D.normalizeAdyenDecline,
  checkoutcom: D.normalizeCheckoutcomDecline,
  mollie: D.normalizeMollieDecline,
  square: D.normalizeSquareDecline,
  payu: D.normalizePayuDecline,
  cybersource: D.normalizeCybersourceDecline,
};

const answer = ([gateway, , signal]: Case) => NORMALIZE[gateway]!(signal);

/**
 * `card_restricted` is in neither set: it also carries limits the payer can lift. These
 * pins hold each documented meaning on the side the 2026-11-18 audit put it.
 */
const RESTRICTED_HARD: Record<string, readonly string[]> = {
  stripe: [
    "invalid_account",
    "new_account_information_available",
    "restricted_card",
    "card_not_supported",
    "currency_not_supported",
    "recurring_not_supported_by_bank",
    "invalid_payment_information",
    "compliance_violation",
  ],
  paypal: ["CARD_TYPE_NOT_SUPPORTED", "CURRENCY_NOT_SUPPORTED_FOR_CARD_BRAND"],
  braintree: ["2015"],
  adyen: ["5", "10", "23"],
  checkoutcom: ["20057", "20040", "20081"],
  cybersource: ["INVALID_CARD_TYPE", "CARD_TYPE_NOT_ACCEPTED"],
  square: ["CARD_NOT_SUPPORTED", "UNSUPPORTED_CARD_BRAND", "CARDHOLDER_INSUFFICIENT_PERMISSIONS"],
  cashfree: ["card_type_not_allowed", "transaction_not_allowed", "not_permitted"],
  payu: ["E902", "E1642", "E4348"],
  razorpay: ["card_type_invalid"],
};
/** Blocked or not enabled, which the cardholder can undo: retried, then parked. */
const RESTRICTED_SOFT: Record<string, readonly string[]> = {
  razorpay: ["debit_instrument_blocked", "debit_instrument_inactive"],
  cashfree: ["inactive_card", "restricted_card", "psp_blocked"],
  payu: ["E1652", "E1664", "E325"],
  cybersource: ["UNAUTHORIZED_CARD"],
  braintree: ["2107"],
  square: ["AMOUNT_TOO_HIGH", "TRANSACTION_LIMIT"],
};

describe("every documented decline code is classified per the retry policy", () => {
  it("covers all 13 gateways", () => {
    expect(new Set(CASES.map(([g]) => g)).size).toBe(13);
  });

  it("a dead-instrument code is never retriable", () => {
    const wrong = CASES.filter((c) => {
      const n = answer(c);
      return DEAD.has(n.code) && n.retriable && !SOFT_ON_PURPOSE[`${c[0]} ${c[1]}`];
    }).map(([g, raw]) => `${g} ${raw}`);
    expect(wrong).toEqual([]);
  });

  it("a soft code is always retriable", () => {
    const wrong = CASES.filter((c) => {
      const n = answer(c);
      return SOFT.has(n.code) && !n.retriable;
    }).map(([g, raw]) => `${g} ${raw} → ${answer([g, raw, raw]).code}`);
    expect(wrong).toEqual([]);
  });

  it("the soft-on-purpose list names only codes that need it", () => {
    for (const key of Object.keys(SOFT_ON_PURPOSE)) {
      const c = CASES.find(([g, raw]) => `${g} ${raw}` === key);
      expect(c, key).toBeDefined();
      const n = answer(c!);
      expect([DEAD.has(n.code), n.retriable], key).toEqual([true, true]);
    }
  });

  it("a restricted card that only another card replaces is hard; one the payer can undo is not", () => {
    const find = (g: string, raw: string) => CASES.find(([cg, cr]) => cg === g && cr === raw);
    for (const [pins, hard] of [
      [RESTRICTED_HARD, true],
      [RESTRICTED_SOFT, false],
    ] as const)
      for (const [g, raws] of Object.entries(pins))
        for (const raw of raws) {
          const c = find(g, raw);
          expect(c, `${g} ${raw} is documented`).toBeDefined();
          expect([answer(c!).code, answer(c!).retriable], `${g} ${raw}`).toEqual([
            "card_restricted",
            !hard,
          ]);
        }
  });

  it("every Stripe decline code is mapped on purpose, never passed through", () => {
    const stray = STRIPE_DOCUMENTED_DECLINE_CODES.filter(
      (c) =>
        D.normalizeStripeDecline({ code: c, declineCode: c }).ruleId == null &&
        !Object.hasOwn(D.STRIPE_CODE_TABLE, c) &&
        !D.isTerminalDeclineCode(c),
    );
    expect(stray).toEqual([]);
  });
});

describe("the network's never-resubmit code hardens a restricted card too", () => {
  it("invalid_account with Visa 46 is hard, as a generic decline with Visa 46 is", () => {
    for (const code of ["invalid_account", "generic_decline"])
      expect(
        D.normalizeStripeDecline({
          code,
          declineCode: code,
          networkMessage: "46",
          cardBrand: "visa",
        }).retriable,
        code,
      ).toBe(false);
  });

  it("a table-mapped restricted card with Visa 46 keeps its code and turns hard", () => {
    const n = D.normalizeAdyenDecline({ code: "25", networkMessage: "46", cardBrand: "visa" });
    expect([n.code, n.retriable]).toEqual(["card_restricted", false]);
  });
});

describe("an unknown raw value never becomes our code", () => {
  it("a gateway sentence books charge_failed", () => {
    const n = D.normalizeRazorpayDecline({ code: "The bank said something new" });
    expect([n.code, n.retriable]).toEqual(["charge_failed", true]);
  });

  it("the sentence Razorpay sends for Visa 57 is a hard card_restricted", () => {
    const n = D.normalizeRazorpayDecline({
      code: "Transaction not permitted to issuer/cardholder",
    });
    expect([n.code, n.retriable]).toEqual(["card_restricted", false]);
  });
});

describe("the gateway's own code for operators", () => {
  it("reads the issuer's reason from each logged response shape", () => {
    const cases: [unknown, string | null][] = [
      [{ error: { code: "card_declined", decline_code: "invalid_account" } }, "invalid_account"],
      [{ error: { code: "BAD_REQUEST_ERROR", reason: "incorrect_otp" } }, "incorrect_otp"],
      [{ error_reason: "card_expired" }, "card_expired"],
      [
        {
          purchase_units: [
            { payments: { captures: [{ processor_response: { response_code: "5120" } }] } },
          ],
        },
        "5120",
      ],
      [{ details: [{ issue: "INSTRUMENT_DECLINED" }] }, "INSTRUMENT_DECLINED"],
      [{ refusalReasonCode: "25" }, "25"],
      [{ errorInformation: { reason: "INVALID_ACCOUNT" } }, "INVALID_ACCOUNT"],
      [{ status: "succeeded" }, null],
      [null, null],
    ];
    for (const [body, code] of cases) expect(D.gatewayCodeInResponse(body)).toBe(code);
  });
});

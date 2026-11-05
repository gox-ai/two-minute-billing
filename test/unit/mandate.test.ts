/**
 * Mandate rails — the rules that decide whether an INR renewal can be collected
 * at all.
 *
 * These are unit-testable on purpose. Every one of them was previously either
 * absent or expressed only as a comment, and each failure mode they cover shows
 * up not as an exception but as a renewal that quietly stops working weeks after
 * go-live: a debit above a ceiling nobody stored, a merchant-config refusal
 * retried forever, an INR mandate bound to the one rail never proven to debit.
 */
import { describe, it, expect } from "vitest";
import { chargeFlowLabel } from "@/modules/invoicing/charge-description";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";
import { RazorpayProvider } from "@/providers/razorpay";
import { RAZORPAY_WEBHOOK_EVENTS } from "@/providers/gateway-catalog";
import { MAX_INDIA_CARD_MANDATE_MINOR } from "@/providers/stripe";
import {
  mandateRefusal,
  mandateMissingRefusal,
  MANDATE_MISSING_CODE,
  mandatePendingRefusal,
  mandatePendingBackoff,
  MANDATE_PENDING_CODE,
  MANDATE_PENDING_RETRY_MS,
  MANDATE_PENDING_MAX_DEFERRALS,
  mandateSpentRefusal,
  MANDATE_SPENT_CODE,
  mandateExpiredRefusal,
  MANDATE_EXPIRED_CODE,
  isHardDecline,
  shouldTryBackup,
  pickPrimaryCandidate,
} from "@/modules/invoicing/collection";
import {
  decidePaymentSourceExpiry,
  MANDATE_EXPIRY_NOTICE_FROM,
} from "@/modules/payment-methods/sweep";
import {
  classifyDecline,
  PARK,
  PARK_EVEN_IN_FIXED_MODE,
  MERCHANT_SIDE_PARK,
} from "@/modules/subscriptions/decline-policy";
import { normalizeRazorpayDecline } from "@/providers/decline-codes";
import { describeStripeMandate } from "@/providers/stripe";
import {
  INR_AFA_FREE_CEILING_MINOR,
  requiresAfaPerDebit,
  debitNeedsBuyerAuthentication,
  MANDATE_HEADROOM_BPS,
  withMandateHeadroom,
  DEFAULT_MANDATE_HEADROOM_CONFIG,
  resolveMandateHeadroomConfig,
  mandateFallbackCeiling,
  MANDATE_RAIL_MAX_CEILING_MINOR,
  MANDATE_RAIL_CEILING_CURRENCY,
  SMALLEST_RAIL_CEILING_CAP_MINOR,
  railsOverCeilingCap,
  MANDATE_LIVE_STATUSES,
  MANDATE_PENDING_STATUSES,
  DEAD_MANDATE_STATUSES,
  MANDATE_SPENT_STATUSES,
  MANDATE_NORMALISED_STATUSES,
  mandateChargeability,
  mandateHasExpired,
  mandateBecameLive,
  MANDATE_MISSING_STATUS,
} from "@/modules/payment-methods/service";
import { __graceHoursFor, __afaAbandonHours } from "@/modules/payments/stale-pending";
import { EMAIL_TYPES } from "@/modules/emails/config";
import { DEFAULT_TEMPLATES, TEMPLATE_VARS } from "@/modules/emails/templates";
import { openapiDocument } from "@/api/openapi";
import { deriveEffectiveCurrency } from "@/modules/customers/serialize";

/** A payment_methods row, only the fields `mandateRefusal` reads. */
const pm = (over: Partial<Parameters<typeof mandateRefusal>[0]> = {}) =>
  ({
    publicId: "pm_test",
    mandateMaxAmountMinor: null,
    mandateCurrency: null,
    mandateRail: null,
    mandateExpiresAt: null,
    ...over,
  }) as Parameters<typeof mandateRefusal>[0];

/**
 * The fifth pre-flight refusal, and the reason it exists: the other four each read a
 * mandate FACT and bow out when their field is absent, so an instrument missing the
 * mandate ENTIRELY passed all four and reached the gateway. Stripe then answered what we
 * could have answered — and left a PaymentIntent behind that `orphaned_gateway_intents`
 * reported as unexplained money. Both intents on that alert on 2026-09-06/07 were this.
 */
/**
 * The gateway row has to say WHICH FLOW took the money — three of them charge a gateway and
 * read identically in Stripe's list. These labels reach the payer's RECEIPT and the dispute
 * record, not just our dashboard, so they are written to be read by a payer.
 */
describe("chargeFlowLabel — the flow, as a payer could read it", () => {
  it("labels all four flows", () => {
    expect(chargeFlowLabel("renewal")).toBe("Renewal");
    expect(chargeFlowLabel("manual_collection")).toBe("Manual collection");
    expect(chargeFlowLabel("portal_payment")).toBe("Portal payment");
    expect(chargeFlowLabel("new_subscription")).toBe("New subscription");
  });

  it("NEVER says PayNow — `paynow` is a Stripe payment method", () => {
    // Singapore's instant-transfer scheme. That word against a card debit would name a
    // rail nobody used, in a dashboard that also lists genuine PayNow payments. The same
    // reasoning rules out "Collect now" (a button's name means nothing to a payer) and
    // "Manual payment" (this product has `record an offline payment`, which is different).
    const all = (
      ["renewal", "manual_collection", "portal_payment", "new_subscription"] as const
    ).map((f) => chargeFlowLabel(f) ?? "");
    for (const label of all) {
      expect(label).not.toMatch(/paynow|collect now|manual payment/i);
    }
  });

  it("says nothing when the caller does not know the flow", () => {
    // A wrong flow on a receipt is worse than no flow, so an omitted one is dropped from
    // the description rather than guessed at.
    expect(chargeFlowLabel(undefined)).toBeNull();
  });
});

describe("mandateMissingRefusal — a mandate the GATEWAY says is absent", () => {
  /** Stripe: the only gateway whose off-session confirm reads the reference. */
  const STRIPE = { mandates: true, perDebitMandateReference: true };
  /** What the collection path writes after the gateway answers `mandate_missing` once. */
  const learned = { mandateStatus: MANDATE_MISSING_STATUS, mandateReference: null };

  it("refuses once the gateway's answer has been recorded", () => {
    const r = mandateMissingRefusal(pm(learned), STRIPE);
    expect(r?.failure?.code).toBe(MANDATE_MISSING_CODE);
    // Non-retriable: there is nothing for a retry to present. Dunning must park.
    expect(r?.failure?.retriable).toBe(false);
    // No gateway object exists, so there is no id to name — and nothing to strand.
    expect(r?.providerChargeId).toBe("");
  });

  it("NEVER GUESSES — an unannotated instrument is left alone, whatever the currency", () => {
    // The whole design. Two earlier cuts inferred this: from the pm row (which refused
    // every tmtest mandate fixture) and from the currency (which would decline an
    // international card billed in INR, needing no RBI e-mandate). All 13 migrated Stripe
    // methods are BARE — rail, status and ceiling NULL — so our data cannot tell them from
    // a plain card-on-file. The first attempt goes to the gateway; only the answer is kept.
    expect(mandateMissingRefusal(pm(), STRIPE)).toBeNull();
    expect(mandateMissingRefusal(pm({ mandateRail: "emandate" }), STRIPE)).toBeNull();
    expect(mandateMissingRefusal(pm({ mandateMaxAmountMinor: 1_500_000n }), STRIPE)).toBeNull();
  });

  it("says nothing about a gateway that does not read a reference", () => {
    // RazorPay debits with the recurring token and tmtest with the vaulted instrument, so
    // a null reference there is not a missing authorization.
    expect(mandateMissingRefusal(pm(learned), { mandates: true })).toBeNull();
    expect(mandateMissingRefusal(pm(learned), { mandates: false })).toBeNull();
    // An adapter declaring neither flag refuses NOTHING — the opposite reading from
    // `mandates` alone, and deliberately so: a new adapter must not start refusing every
    // renewal it cannot prove is authorized.
    expect(mandateMissingRefusal(pm(learned), {})).toBeNull();
  });

  it("stands down once a reference arrives, so re-authorising clears it", () => {
    // The remedy has to work without anyone clearing the status by hand.
    expect(
      mandateMissingRefusal(pm({ ...learned, mandateReference: "mandate_abc" }), STRIPE),
    ).toBeNull();
  });

  it("is its own chargeability, not `none` and not `dead`", () => {
    // `none` is "nothing reported", `dead` is "a mandate that existed and ended". This one
    // is "we asked and the gateway said one is required and absent" — a different fact,
    // and the only one that must not brand the instrument.
    expect(mandateChargeability({ mandateStatus: MANDATE_MISSING_STATUS })).toBe("missing");
    expect(mandateChargeability({ mandateStatus: null })).toBe("none");
  });

  it("never names an internal id to the payer", () => {
    // It rides `payment_failed` as `declineMessage` into the customer's inbox.
    const msg = mandateMissingRefusal(pm(learned), STRIPE)?.failure?.message ?? "";
    expect(msg).not.toMatch(/mandate_|pm_|seti_|SetupIntent/);
    expect(msg).toMatch(/authorize it again/i);
  });
});

describe("mandateRefusal — a debit the mandate forbids never reaches the gateway", () => {
  it("skips the check when no ceiling is stored (unknown is not unlimited)", () => {
    // A plain card-on-file, a provider that does not report the field, or a row
    // vaulted before 0179. The gateway stays the authority, as it always was.
    expect(mandateRefusal(pm(), 999_999_999n, "INR")).toBeNull();
  });

  it("allows a debit exactly AT the ceiling", () => {
    // The rails enforce "up to and including" — refusing here would reject a
    // renewal the mandate explicitly permits.
    expect(
      mandateRefusal(
        pm({ mandateMaxAmountMinor: 500_000n, mandateCurrency: "INR" }),
        500_000n,
        "INR",
      ),
    ).toBeNull();
  });

  it("refuses a debit above the ceiling", () => {
    const r = mandateRefusal(
      pm({ mandateMaxAmountMinor: 500_000n, mandateCurrency: "INR", mandateRail: "upi" }),
      500_001n,
      "INR",
    );
    expect(r?.status).toBe("failed");
    expect(r?.failure?.code).toBe("mandate_ceiling_exceeded");
    // Non-retriable: retrying the same instrument can never clear it, and the
    // backup card is a legitimate next candidate.
    expect(r?.failure?.retriable).toBe(false);
    // The message must name the remedy — this failure's whole value is that it
    // says what a plain decline cannot. Matched on the remedy, not on one phrasing of
    // it: the wording was rewritten for the payer on 2026-08-27 and the assertion that
    // pinned "re-authorized" failed for a message that says the same thing better.
    expect(r?.failure?.message).toMatch(/new authorization/i);
    expect(r?.failure?.message).toContain("upi");
    /**
     * BUYER-FACING, and these are the constraints that makes it so. The string rides
     * `payment_failed` as `{{declineMessage}}` into the mail the payer reads, so it must
     * carry both figures — what was charged against what they approved — and must NOT
     * carry our internal ids, which it used to (`pm_…`).
     */
    expect(r?.failure?.message).toContain("₹5,000.01");
    expect(r?.failure?.message).toContain("₹5,000.00");
    expect(r?.failure?.message).not.toContain("pm_");
    // No gateway call was made, so there is no charge id to claim one.
    expect(r?.providerChargeId).toBe("");
  });

  it("skips the check when the ceiling is in a different currency", () => {
    // Comparing across currencies would need an FX rate we do not have; guessing
    // one is worse than deferring to the gateway.
    expect(
      mandateRefusal(pm({ mandateMaxAmountMinor: 100n, mandateCurrency: "USD" }), 999_999n, "INR"),
    ).toBeNull();
  });

  it("compares case-insensitively on currency", () => {
    const r = mandateRefusal(
      pm({ mandateMaxAmountMinor: 100n, mandateCurrency: "inr" }),
      200n,
      "INR",
    );
    expect(r?.failure?.code).toBe("mandate_ceiling_exceeded");
  });
});

describe("the SECOND AFA trigger: above the mandate's own max, Stripe offers a link", () => {
  /**
   * Stripe's India page: "if the payment amount is above 15,000 INR OR THE MANDATE'S
   * MAXIMUM AMOUNT, the pre-debit notification contains a link to perform AFA (3DS) to
   * authorise the payment." We modelled only the ₹15,000 half and refused the other
   * locally, so the buyer was told to re-register a mandate for a payment Stripe would
   * have collected off one tap.
   */
  const OVER = { mandateMaxAmountMinor: 500_000n, mandateCurrency: "INR", mandateRail: "card" };

  it("lets an over-ceiling INR card debit reach a gateway that offers the link", () => {
    expect(mandateRefusal(pm(OVER), 500_001n, "INR", true)).toBeNull();
  });

  it("still refuses when the gateway offers no such link", () => {
    // RazorPay and PayPal. There the local refusal is strictly better: a gateway
    // ceiling refusal is indistinguishable from a decline, and dunning would burn the
    // schedule and the backup instrument on a debit that can never succeed.
    expect(mandateRefusal(pm(OVER), 500_001n, "INR")?.failure?.code).toBe(
      "mandate_ceiling_exceeded",
    );
    expect(mandateRefusal(pm(OVER), 500_001n, "INR", false)?.failure?.code).toBe(
      "mandate_ceiling_exceeded",
    );
  });

  it("is narrow: only the INR CARD e-mandate shape Stripe documents it for", () => {
    // The same gate `indiaCardMandateOptions` uses to register the ceiling. A UPI
    // mandate or a non-INR debit gets no link, so refusing locally is still right.
    expect(
      mandateRefusal(pm({ ...OVER, mandateRail: "upi" }), 500_001n, "INR", true)?.failure?.code,
    ).toBe("mandate_ceiling_exceeded");
    expect(
      mandateRefusal(pm({ ...OVER, mandateCurrency: "USD" }), 500_001n, "USD", true)?.failure?.code,
    ).toBe("mandate_ceiling_exceeded");
  });

  it("changes nothing at or below the ceiling", () => {
    expect(mandateRefusal(pm(OVER), 500_000n, "INR", true)).toBeNull();
    expect(mandateRefusal(pm(OVER), 500_000n, "INR")).toBeNull();
  });
});

describe("a ceiling refusal must not blame the instrument", () => {
  const refusal = mandateRefusal(
    pm({ mandateMaxAmountMinor: 1_500_000n, mandateCurrency: "INR" }),
    6_602_500n,
    "INR",
  )!;

  it("is not a hard decline, so the payment method is NOT marked invalid", () => {
    // Regression: a ₹66,025 Business signup was refused against a ₹15,000 mandate and
    // left the customer's card flagged `invalid` — taking it out of collection for the
    // smaller charges it can still pay. A ₹13,870 debit on that same mandate captured.
    expect(isHardDecline(refusal)).toBe(false);
  });

  it("still moves on to the backup instrument, which may carry a bigger mandate", () => {
    expect(shouldTryBackup(refusal)).toBe(true);
  });

  it("an ordinary hard decline still blames the instrument", () => {
    const dead = { status: "failed", failure: { retriable: false, code: "stolen_card" } };
    expect(isHardDecline(dead)).toBe(true);
    expect(shouldTryBackup(dead)).toBe(true);
  });
});

describe("smart dunning disposition for mandate failures", () => {
  it("parks a ceiling breach — recoverable, but only by the customer", () => {
    expect(classifyDecline("mandate_ceiling_exceeded")).toBe("park");
  });

  it("parks a merchant-config refusal rather than cancelling the subscription", () => {
    // The customer did nothing wrong; a human has to change the RazorPay account.
    expect(classifyDecline("recurring_not_enabled")).toBe("park");
  });

  it("still retries anything it cannot classify", () => {
    expect(classifyDecline("some_code_razorpay_invented_last_week")).toBe("retry");
  });
});

describe("RazorPay decline normalization", () => {
  it("maps recurring_payment_not_enabled to a canonical token, kept RETRIABLE", () => {
    const n = normalizeRazorpayDecline("recurring_payment_not_enabled");
    expect(n.code).toBe("recurring_not_enabled");
    // Load-bearing: `retriable: false` is what `isHardDecline` reads as a bad
    // instrument, which would mark a working card `invalid` and burn the backup
    // over a gateway misconfiguration. The park comes from classifyDecline above.
    expect(n.retriable).toBe(true);
  });

  it("maps invalid_otp onto the shared authentication_required token", () => {
    expect(normalizeRazorpayDecline("invalid_otp").code).toBe("authentication_required");
    expect(classifyDecline("authentication_required")).toBe("park");
  });

  it("gives RazorPay's per-CYCLE refusal its own token, not the ceiling one", () => {
    /**
     * ⚠ THIS TEST ASSERTED THE OPPOSITE UNTIL 2026-09-03, and its reasoning was wrong
     * rather than merely stale. It read `card_mandate_current_cycle_allowed_debit_exceeds`
     * as the RBI ₹15,000 per-debit rule and concluded "no retry interval makes ₹28,215 fit
     * under ₹15,000", so it mapped the code onto `mandate_ceiling_exceeded` deliberately.
     *
     * Measured on ONE card mandate (max ₹37,657.34), which
     * refutes that reading outright:
     *   31-Aug 16:17  ₹32,943.24  SUCCEEDED   ← far above ₹15,000
     *   31-Aug 17:59  ₹33,276.00  afa_not_completed
     *   31-Aug 18:01  ₹33,276.00  SUCCEEDED   ← the same amount, once AFA was completed
     *   03-Sep 11:50  ₹22,184.00  REFUSED "Maximum allowed debits in current cycle exceeded"
     *   03-Sep 12:56  ₹22,184.00  REFUSED, same words
     * A ₹22,184.00 debit was refused while ₹33,276.00 had already gone through on the same
     * mandate, well inside its ceiling. So it is not an AMOUNT limit of any kind — it is a
     * COUNT limit within the cycle, and the remedy is time, not a bigger mandate and not AFA.
     *
     * Both variants of the old collapsed code appeared within 90 minutes that day, which is
     * why the split matters: at 11:22 the SAME `mandate_ceiling_exceeded` came from our own
     * pre-flight on a genuine breach — ₹3,18,673.16 against a ₹37,657.34 mandate — and there
     * re-authorizing at a higher ceiling IS the remedy. One code, two opposite instructions.
     */
    const n = normalizeRazorpayDecline("card_mandate_current_cycle_allowed_debit_exceeds");
    expect(n.code).toBe("mandate_cycle_limit_exceeded");
    // Retriable: nothing is wrong with the instrument, and a later debit succeeds.
    expect(n.retriable).toBe(true);
    // But PARKED, not retried: card mandates register `frequency: 'monthly'`, so the next
    // cycle is further away than any fixed retry schedule reaches.
    expect(classifyDecline(n.code)).toBe("park");
    // The per-CHARGE sibling keeps its own answer, and they must not converge again.
    expect(classifyDecline("mandate_ceiling_exceeded")).toBe("park");
    expect(
      normalizeRazorpayDecline("card_mandate_current_cycle_allowed_debit_exceeds").code,
    ).not.toBe("mandate_ceiling_exceeded");
  });

  it("passes an unmapped code through so sync and async classify identically", () => {
    const n = normalizeRazorpayDecline("brand_new_reason");
    expect(n.code).toBe("brand_new_reason");
    expect(n.retriable).toBe(true);
  });
});

describe("RBI additional-factor-authentication threshold", () => {
  it("is ₹15,000 expressed in paise", () => {
    expect(INR_AFA_FREE_CEILING_MINOR).toBe(1_500_000n);
  });

  it("does not trigger AT the threshold, only above it", () => {
    expect(requiresAfaPerDebit("INR", 1_500_000n)).toBe(false);
    expect(requiresAfaPerDebit("INR", 1_500_001n)).toBe(true);
  });

  it("never applies outside INR — it is an RBI/NPCI rule, not a general one", () => {
    expect(requiresAfaPerDebit("USD", 99_999_999n)).toBe(false);
    expect(requiresAfaPerDebit("EUR", 99_999_999n)).toBe(false);
  });

  it("is case-insensitive about the currency code", () => {
    expect(requiresAfaPerDebit("inr", 2_000_000n)).toBe(true);
  });

  it("is the value an INR mandate falls back to when nothing can be derived", () => {
    // The signup order is vault-then-subscribe, so `deriveMandateCeiling` hits its
    // fallback on every new INR mandate. The currency-blind 100,000 minor units is
    // a defensible $1,000 and a useless ₹1,000 — measured 2026-08-13, a ₹2,595
    // subscription was refused on its FIRST invoice against exactly that mandate.
    //
    // Pinned to the AFA-free ceiling: the most a mandate can collect unattended.
    // Asserting the relationship rather than the number, so the two cannot drift.
    expect(INR_AFA_FREE_CEILING_MINOR).toBeGreaterThan(100_000n);
  });
});

describe("the headroom a mandate is registered with", () => {
  /**
   * ── THE REGRESSION, and it is a money one ─────────────────────────────────────
   * The INR monthly ladder (`platform-*-v202607-INR-Monthly`) is
   * lite ₹9,118 → pro ₹27,918 → business ₹56,118, i.e. one-step ratios of 3.0645× and
   * 2.0101×. At 25% (`MANDATE_HEADROOM_BPS = 12_500n`, the rule until 2026-09-01) NO
   * single-step upgrade on that ladder fits under the ceiling the previous plan was
   * registered with, so every upgrade was uncollectable by construction: the audited
   * subscription was sized 1.25 × ₹50,690.44 = ₹63,363.05, then billed ₹66,219.24, and
   * took three `mandate_ceiling_exceeded` refusals over an invoice that could never pay.
   *
   * These two assertions FAIL at 12_500n — the pro→business step measures 1.4×
   * (₹1,00,000 / ₹66,219.24 wants to be ≥ 1) and the lite→pro step lands under 1 — and
   * pass at 35_000n. That is the whole point of stating them as ladder RATIOS rather
   * than as the constant: restating the number would only pin whatever it happens to be.
   */
  const GST = (minor: bigint) => (minor * 118n + 99n) / 100n;
  const LITE = GST(911_800n); // ₹10,759.24 incl. 18% GST
  const PRO = GST(2_791_800n); // ₹32_943.24
  const BUSINESS = GST(5_611_800n); // ₹66_219.24

  it("does NOT carry a one-step upgrade — the accepted cost of a believable ceiling", () => {
    /**
     * INVERTED ON PURPOSE, 2026-09-03. At 3.5× both of these were `toBeGreaterThanOrEqual`
     * and a mandate carried the next plan up unattended. At 1.3× it cannot: the ladder
     * steps 3.06× (lite→pro) and 2.01× (pro→business), so no multiple a buyer finds
     * believable covers them — 3.5× is the smallest that does, and it asked a ₹10,759
     * customer to authorise ₹37,657, which reads as a merchant helping itself.
     *
     * So the upgrade now requires the customer to re-authorise, and this assertion exists
     * to make that a stated decision rather than a surprise. It is survivable only because
     * `mandate_shortfall` names the shortfall on the change screen BEFORE the operator
     * commits — the guard that did not exist during the three `mandate_ceiling_exceeded`
     * refusals recorded in the constant's docstring. If that warning is ever removed, or if
     * these ratios are ever met by the default again, this test is the one to revisit.
     */
    expect(withMandateHeadroom(LITE)).toBeLessThan(PRO);
    expect(withMandateHeadroom(PRO)).toBeLessThan(BUSINESS);
    // What a mandate DOES still carry: the bill it was sized for, plus the multiple.
    expect(withMandateHeadroom(LITE)).toBeGreaterThan(LITE);
    expect(withMandateHeadroom(PRO)).toBeGreaterThan(PRO);
  });

  it("applies the multiple the constant names, and carries no second copy of it", () => {
    // 25% until 2026-09-01, then 3.5×, then 1.3× on 2026-09-03 (buyer trust over unattended
    // upgrades — see the constant's docstring). ×3 before 2026-08-27, but on a PRE-tax
    // base, so its effective coverage was 3 / 1.18 = 2.54×; this one sits on the
    // tax-inclusive total.
    //
    // The EXPECTATION is derived from the constant. Restating the product as a literal is
    // what made changing the multiple a hunt through four files.
    expect(withMandateHeadroom(1_000_000n)).toBe((1_000_000n * MANDATE_HEADROOM_BPS) / 10_000n);
    // The one literal that belongs here: the decision itself.
    expect(MANDATE_HEADROOM_BPS).toBe(13_000n);
  });

  it("rounds UP, so the ceiling is never a rupee short of the debit", () => {
    // Stated as a PROPERTY rather than an arithmetic result, so it survives any multiple:
    // a ceiling that rounded DOWN would refuse the very debit it was sized for, which is
    // the one thing this function must never do.
    for (const amount of [1n, 3n, 7n, 999n, 306_210n]) {
      const ceiling = withMandateHeadroom(amount);
      // At least the exact multiple…
      expect(ceiling * 10_000n).toBeGreaterThanOrEqual(amount * MANDATE_HEADROOM_BPS);
      // …and the SMALLEST such value: one minor unit less would fall short.
      expect((ceiling - 1n) * 10_000n).toBeLessThan(amount * MANDATE_HEADROOM_BPS);
    }
  });

  it("never asks for more than the most constrained rail can register", () => {
    // At 3.5× a ₹66,219.24 debit would ask ₹2,31,767.34. NPCI caps UPI Autopay at
    // ₹1,00,000, RazorPay clamps the order to it anyway, and `railsOverCeilingCap`
    // compares the REQUESTED ceiling — so asking gets nothing and withdraws UPI from the
    // buyer's options. Clamped, UPI stays on offer for every debit UPI can carry.
    // An amount whose headroom would exceed the smallest rail cap, DERIVED from the
    // multiple so it keeps testing the clamp whatever the multiple becomes. (At 3.5× the
    // BUSINESS bill itself was over the cap; at 1.3× it is not, which is precisely why a
    // literal here would have turned into a test of nothing.)
    const overCap = (SMALLEST_RAIL_CEILING_CAP_MINOR * 10_000n) / MANDATE_HEADROOM_BPS + 100n;
    expect(withMandateHeadroom(overCap)).toBe(SMALLEST_RAIL_CEILING_CAP_MINOR);
    expect(railsOverCeilingCap(withMandateHeadroom(overCap), ["card", "upi", "emandate"])).toEqual(
      [],
    );
    // Derived from the cap table, so a corrected cap cannot leave this behind.
    expect(SMALLEST_RAIL_CEILING_CAP_MINOR).toBe(MANDATE_RAIL_MAX_CEILING_MINOR.upi);
  });

  it("NEVER clamps below the amount it is sizing", () => {
    // The clamp is about not over-asking on a rail that caps. An amount at or above the
    // cap takes the full multiple instead: clamping there would hand back a ceiling
    // smaller than the debit — a mandate guaranteed to refuse its own first charge. A
    // $150,000 monthly debit is the case that would have broken (the caps are INR
    // figures, and 10,000,000 minor units is $100,000).
    const huge = 15_000_000n;
    expect(withMandateHeadroom(huge)).toBeGreaterThan(huge);
    expect(withMandateHeadroom(SMALLEST_RAIL_CEILING_CAP_MINOR)).toBeGreaterThan(
      SMALLEST_RAIL_CEILING_CAP_MINOR,
    );
    // Monotonic across the clamp boundary — no amount is sized SMALLER than a smaller one.
    expect(withMandateHeadroom(huge)).toBeGreaterThan(withMandateHeadroom(huge - 1n));
  });

  it("holds for a real INR plan with GST inside the base figure", () => {
    // ₹2,595 plan + 18% GST = ₹3,062.10. Derived, so the worked example cannot rot: the
    // point is that GST is INSIDE the base, not what the multiple happens to be today.
    expect(withMandateHeadroom(306_210n)).toBe(
      (306_210n * MANDATE_HEADROOM_BPS + 9_999n) / 10_000n,
    );
  });

  it("is never zero or negative for a zero amount — there is nothing to size", () => {
    // The caller falls through to `mandateFallbackCeiling`; returning a 0 CEILING would
    // refuse every debit, which is worse than the currency-blind constant.
    expect(withMandateHeadroom(0n)).toBe(0n);
    expect(withMandateHeadroom(-500n)).toBe(0n);
  });

  it("raising the ceiling opts NOTHING extra into buyer authentication", () => {
    /**
     * Checked before the multiple was chosen, because a bigger ceiling that quietly made
     * more debits interactive would be a worse defect than the one being fixed. AFA is
     * keyed on the DEBIT, never on the ceiling: the same ₹12,000 debit needs no
     * authentication under either sizing, and the same ₹20,000 debit needs it under both.
     */
    const card = { mandateRail: "card", type: "card" };
    for (const bps of [12_500n, 35_000n]) {
      const ceiling = (1_200_000n * bps + 9_999n) / 10_000n; // what each rule would register
      expect(ceiling).toBeGreaterThanOrEqual(INR_AFA_FREE_CEILING_MINOR); // both reach ₹15,000
      expect(debitNeedsBuyerAuthentication(card, "INR", 1_200_000n)).toBe(false);
      expect(debitNeedsBuyerAuthentication(card, "INR", 2_000_000n)).toBe(true);
    }
  });

  it("still clears an 18% GST rise on a plan sized before tax applied", () => {
    // The headroom's remaining job. A ₹10,000 plan sized while tax-exempt is debited
    // ₹11,800 once GST applies — comfortably inside 3.5×, so the mandate survives it.
    expect(withMandateHeadroom(1_000_000n)).toBeGreaterThanOrEqual(1_180_000n);
  });
});

/**
 * `resolveMandateHeadroomConfig` — the businesses.mandate_config resolver, added so
 * `MANDATE_HEADROOM_BPS` and `SMALLEST_RAIL_CEILING_CAP_MINOR` stop being one exported
 * constant apiece with no per-business override (docs/PROGRESS.md, "what the mandate and
 * column work left behind"). Mirrors `resolveDunningConfig`'s contract test shape: every
 * absent or malformed key falls back to the platform default, so a business that has
 * never set `mandate_config` behaves byte-identically to before this resolver existed.
 */
describe("resolveMandateHeadroomConfig — per-business mandate sizing", () => {
  it("a business with no mandate_config gets exactly the platform default", () => {
    expect(resolveMandateHeadroomConfig(null)).toEqual(DEFAULT_MANDATE_HEADROOM_CONFIG);
    expect(resolveMandateHeadroomConfig({})).toEqual(DEFAULT_MANDATE_HEADROOM_CONFIG);
    expect(resolveMandateHeadroomConfig({ mandateConfig: null })).toEqual(
      DEFAULT_MANDATE_HEADROOM_CONFIG,
    );
    expect(DEFAULT_MANDATE_HEADROOM_CONFIG).toEqual({
      headroomBps: MANDATE_HEADROOM_BPS,
      railCeilingCapMinor: SMALLEST_RAIL_CEILING_CAP_MINOR,
    });
  });

  it("each key overrides independently", () => {
    const headroomOnly = resolveMandateHeadroomConfig({
      mandateConfig: { headroom_bps: 50_000 },
    });
    expect(headroomOnly.headroomBps).toBe(50_000n);
    expect(headroomOnly.railCeilingCapMinor).toBe(SMALLEST_RAIL_CEILING_CAP_MINOR);

    const capOnly = resolveMandateHeadroomConfig({
      mandateConfig: { rail_ceiling_cap_minor: 5_000_000 },
    });
    expect(capOnly.headroomBps).toBe(MANDATE_HEADROOM_BPS);
    expect(capOnly.railCeilingCapMinor).toBe(5_000_000n);
  });

  it("accepts a quoted string for a figure too large for a JS number", () => {
    // jsonb has no bigint of its own; a merchant (or an importer) quoting the figure is
    // the same accommodation `credits_flexibility`'s limits need.
    const cfg = resolveMandateHeadroomConfig({
      mandateConfig: { rail_ceiling_cap_minor: "20000000" },
    });
    expect(cfg.railCeilingCapMinor).toBe(20_000_000n);
  });

  it("a malformed or non-positive value falls back to the default, not to zero", () => {
    for (const bad of [0, -1, "not-a-number", "-5", NaN, {}, [], true]) {
      const cfg = resolveMandateHeadroomConfig({ mandateConfig: { headroom_bps: bad } });
      expect(cfg.headroomBps).toBe(MANDATE_HEADROOM_BPS);
    }
  });

  it("feeds straight into withMandateHeadroom's optional second argument", () => {
    // Every existing call site passes ONE argument, so this is the only way the resolved
    // config reaches the function at all — asserted here so the two cannot drift apart.
    const cfg = resolveMandateHeadroomConfig({
      mandateConfig: { headroom_bps: 20_000, rail_ceiling_cap_minor: 50_000_000 },
    });
    // The override's multiple, derived from the override rather than restated.
    expect(withMandateHeadroom(1_000_000n, cfg)).toBe((1_000_000n * cfg.headroomBps) / 10_000n);
    /**
     * An amount whose DEFAULT answer clamps, but whose answer under the raised cap does
     * not. Derived from the default multiple, not written as a figure: it was the audited
     * ₹66,219.24 debit, chosen because 3.5× of it cleared the ₹1,00,000 rail cap. At 1.3×
     * it no longer does, and the assertion silently became a test of nothing until it
     * failed. The lesson is the same one the constant's docstring makes: state the policy,
     * derive the arithmetic.
     */
    const clampsByDefault =
      (SMALLEST_RAIL_CEILING_CAP_MINOR * 10_000n) / MANDATE_HEADROOM_BPS + 100n;
    expect(withMandateHeadroom(clampsByDefault)).toBe(SMALLEST_RAIL_CEILING_CAP_MINOR);
    expect(withMandateHeadroom(clampsByDefault, cfg)).toBeGreaterThan(
      SMALLEST_RAIL_CEILING_CAP_MINOR,
    );
  });
});

describe("how high each rail can be registered", () => {
  /**
   * The engine's copy of the rail caps and the ADAPTER's copy must agree, and nothing but
   * this test can make them: `providers/` is a lower layer than `modules/` and does not
   * import from it, so `MANDATE_RAIL_MAX_CEILING_MINOR` and RazorPay's own
   * `MAX_UPI_MANDATE_MAX_AMOUNT` / `MAX_MANDATE_MAX_AMOUNT` are two literals. The engine
   * steers the buyer with its copy; the adapter clamps with its own. A cap corrected in
   * one place and not the other would recommend a rail that then silently registers lower.
   */
  const priv = RazorpayProvider as unknown as {
    MAX_UPI_MANDATE_MAX_AMOUNT: bigint;
    MAX_MANDATE_MAX_AMOUNT: bigint;
  };

  it("agrees with the RazorPay adapter about the UPI cap", () => {
    expect(MANDATE_RAIL_MAX_CEILING_MINOR.upi).toBe(priv.MAX_UPI_MANDATE_MAX_AMOUNT);
    expect(MANDATE_RAIL_MAX_CEILING_MINOR.upi).toBe(10_000_000n); // ₹1,00,000 — NPCI, per MCC
  });

  it("agrees with it about cards and netbanking", () => {
    expect(MANDATE_RAIL_MAX_CEILING_MINOR.card).toBe(priv.MAX_MANDATE_MAX_AMOUNT);
    expect(MANDATE_RAIL_MAX_CEILING_MINOR.emandate).toBe(priv.MAX_MANDATE_MAX_AMOUNT);
  });

  /**
   * The STRIPE adapter's copy, added 2026-09-04 with its clamp.
   *
   * `indiaCardMandateOptions` had no clamp at all: RazorPay reduced an over-cap ceiling to
   * the largest the rail can register, Stripe passed it through and would have come back a
   * 400. Now both clamp, and this pins the third literal to the other two — the cap is a
   * property of the RAIL (RBI/NPCI), so a gateway carrying a different number is a bug in
   * that gateway, not a gateway-specific rule.
   */
  it("agrees with the Stripe adapter about the card cap", () => {
    expect(MAX_INDIA_CARD_MANDATE_MINOR).toBe(MANDATE_RAIL_MAX_CEILING_MINOR.card);
    expect(MAX_INDIA_CARD_MANDATE_MINOR).toBe(priv.MAX_MANDATE_MAX_AMOUNT);
    expect(MAX_INDIA_CARD_MANDATE_MINOR).toBe(100_000_000n); // ₹10,00,000
  });

  it("names the rails that cannot carry a ceiling, and only those", () => {
    // ₹82,774.05 — inside every cap. Literal rather than routed through
    // `withMandateHeadroom`, which now clamps at UPI's cap: this test is about the cap
    // comparison itself, and it has to keep answering for ceilings the clamp would not
    // produce (an imported mandate, a provider-registered one, a future rail).
    expect(railsOverCeilingCap(8_277_405n, ["card", "upi", "emandate"])).toEqual([]);
    // ₹1,32,750 — past UPI's cap, fine on the others.
    expect(railsOverCeilingCap(13_275_000n, ["card", "upi", "emandate"])).toEqual(["upi"]);
  });

  it("treats an unknown rail as capable rather than inventing a limit", () => {
    // Hiding an option that works is worse than the caps being incomplete: the debit is
    // still guarded by `mandateRefusal` either way.
    expect(railsOverCeilingCap(99_999_999_999n, ["sepa_debit"])).toEqual([]);
  });
});

describe("the ceiling when nothing can be derived", () => {
  /**
   * Reverted 2026-09-04 after a brief change to the rail cap. The evidence for raising it
   * (₹66,025 collected off-session on netbanking) comes from a customer WITH a live
   * subscription, which `deriveMandateCeiling` sizes from the renewal estimate — it never
   * reaches this constant. The fallback fires only when nothing can be inferred, and there a
   * flat ₹1,00,000 would ask a stranger to authorise ₹1 lakh.
   */
  it("gives INR the AFA-free ceiling and everyone else the currency-blind constant", () => {
    expect(mandateFallbackCeiling("INR")).toBe(INR_AFA_FREE_CEILING_MINOR);
    expect(mandateFallbackCeiling("inr")).toBe(INR_AFA_FREE_CEILING_MINOR);
    expect(mandateFallbackCeiling("USD")).toBe(100_000n);
  });

  it("is a fallback, never a floor — headroom over a real amount may be smaller", () => {
    // A $49 subscriber must not be asked to authorise $1,000. Asserting the relationship
    // rather than restating the branch, so a future floor cannot slip in unnoticed.
    expect(withMandateHeadroom(4_900n)).toBeLessThan(mandateFallbackCeiling("USD"));
  });
});

describe("which rails actually stop and ask above ₹15,000", () => {
  // The amount rule and the rail rule are different questions, and conflating them
  // was the whole bug: `requiresAfaPerDebit` knew the threshold and nothing consulted
  // it, so a stalled card debit and a healthy netbanking one were indistinguishable.
  const rail = (r: string | null, type: string | null = null) => ({ mandateRail: r, type });

  it("a card debit above the threshold waits for the buyer", () => {
    // MEASURED with a control on one mandate: ₹13,870 captured, ₹28,215 sat in
    // `created` awaiting the issuer's AFA link.
    expect(debitNeedsBuyerAuthentication(rail("card"), "INR", 2_821_500n)).toBe(true);
  });

  it("a netbanking e-mandate does NOT — it authenticated once, at registration", () => {
    // MEASURED: ₹66,025 off-session against a real HDFC mandate, captured and settled.
    // This is the only rail that renews unattended above the
    // threshold, which is the whole commercial point of the distinction.
    expect(debitNeedsBuyerAuthentication(rail("emandate"), "INR", 6_602_500n)).toBe(false);
    expect(debitNeedsBuyerAuthentication(rail("nach"), "INR", 6_602_500n)).toBe(false);
    expect(debitNeedsBuyerAuthentication(rail(null, "bank_transfer"), "INR", 6_602_500n)).toBe(
      false,
    );
  });

  it("UPI is treated as needing it, on inference rather than evidence", () => {
    // The only UPI datum we hold above the threshold is a ₹66,025 SANDBOX debit that
    // settled — and `success@razorpay` auto-approves, so it says nothing about
    // production. Listed as needing AFA because the costs are asymmetric: a needless
    // notice is noise, a missing one is a silent stall.
    expect(debitNeedsBuyerAuthentication(rail("upi"), "INR", 6_602_500n)).toBe(true);
  });

  it("falls back to the method type when no mandate rail is recorded", () => {
    expect(debitNeedsBuyerAuthentication(rail(null, "card"), "INR", 2_000_000n)).toBe(true);
  });

  it("an unknown rail is not assumed to need it", () => {
    // This drives a customer-facing email. Telling someone their bank will ask them
    // to authenticate, when it never will, is its own defect.
    expect(debitNeedsBuyerAuthentication(rail("wallet"), "INR", 6_602_500n)).toBe(false);
    expect(debitNeedsBuyerAuthentication(rail(null, null), "INR", 6_602_500n)).toBe(false);
  });

  it("never fires below the threshold or outside INR, whatever the rail", () => {
    expect(debitNeedsBuyerAuthentication(rail("card"), "INR", 1_500_000n)).toBe(false);
    expect(debitNeedsBuyerAuthentication(rail("card"), "USD", 99_999_999n)).toBe(false);
  });
});

describe("a debit the buyer never authenticated", () => {
  it("is abandoned at the AFA link's expiry, and never before it", () => {
    // The sweep overrules the gateway exactly once, here, and RazorPay cannot void a
    // payment stuck in `created` (operator ask 5) — so firing while the debit could
    // still capture means the customer pays in the portal and the stale debit lands
    // on top. What bounds that hazard is the LINK's own life: past 72 hours the debit
    // cannot be authenticated by anyone, so it cannot capture either.
    //
    // This used to demand `> 72` — two extra days of margin on top of an expiry that
    // already made the margin unnecessary, and all it bought was a customer staring
    // at a blocked invoice for two days after the payment had died (2026-08-28).
    // Now the assertion is exactness in both directions: not a minute early (the
    // hazard) and not an hour late (the wait).
    expect(__afaAbandonHours).toBe(72);
  });

  it("is polled no later than it is abandoned, whatever the rail's ordinary grace", () => {
    // The grace decides when we ASK the gateway; the abandon decides when a `pending`
    // answer stops being accepted. A card's ordinary grace is longer than the AFA
    // window, so without the clamp in `sweepStalePendingCharges` an AFA card debit
    // would not even be SELECTED at the moment its authentication expired — the
    // deadline would silently become the card's 96h instead of 72h.
    expect(__afaAbandonHours).toBeLessThanOrEqual(__graceHoursFor("card", null));
  });

  it("parks rather than exhausts, in fixed mode as well as smart", () => {
    // Same shape as mandate_ceiling_exceeded: retrying the identical debit on the
    // identical rail stalls identically, so a retry is not a second chance. The
    // customer recovers it (portal Pay now, or re-authorising), so the invoice must
    // still be there when they do.
    expect(classifyDecline("afa_not_completed")).toBe("park");
    expect(PARK_EVEN_IN_FIXED_MODE.has("afa_not_completed")).toBe(true);
  });

  it('parks with a DEADLINE — park must not mean "forever"', () => {
    // `parked` sets `next_attempt_at = null`, and `runDunningPass` scans
    // `WHERE next_attempt_at IS NOT NULL`. So parking is not dunning-without-retries,
    // it is dunning switched off: nothing revisits the row, the period never ends, the
    // final action never fires, and a live subscription sits on an unpaid invoice
    // indefinitely. `sweepExpiredParkedDunning` closes the window — for EVERY park
    // since 2026-09-04, this one included.
    expect(PARK.has("afa_not_completed")).toBe(true);
  });

  it("gives MERCHANT-side parks a deadline too, guarded by an alert instead", () => {
    // ⚠️ This assertion is INVERTED from what it said until 2026-09-04. It used to pin
    // `recurring_not_enabled` and `gateway_limit_exceeded` as permanently exempt, on the
    // reading that cancelling over our own gateway configuration punishes a blameless
    // payer. The reading was right; the remedy was not — an exemption bought the invoice
    // immortality, and 35 subscriptions sat parked on one of these for 13 months. The
    // remedy is now an ops alert that reaches a human while the window is still open.
    for (const code of MERCHANT_SIDE_PARK) expect(PARK.has(code)).toBe(true);
    expect(MERCHANT_SIDE_PARK.size).toBe(4); // vacuity guard: an empty set proves nothing
    // 2 → 3 on 2026-09-05: `gateway_request_rejected` (#63). The number is asserted
    // exactly, not as a minimum, so adding a code stays a decision — a merchant-side
    // park now ends in the configured final action, so what lands here can cancel.
    // 3 → 4 on 2026-09-21: `gateway_account_unavailable`, the PM's gateway account
    // disabled or mode-mismatched. It was unclassified and `retriable`, so it ran the
    // whole ladder and exhausted — cancelling a subscription over our own configuration,
    // which is the exact harm this set exists to put a human in front of. It takes every
    // customer on that account down at once, so it is the shape most worth alerting on.
    expect(MERCHANT_SIDE_PARK.has("gateway_account_unavailable")).toBe(true);
    expect(PARK_EVEN_IN_FIXED_MODE.has("gateway_account_unavailable")).toBe(true);
    // Rail-side (NPCI's per-cycle allowance): nobody's misconfiguration, so it is not in
    // the alert set even though it parks. Alerting on it would train people to ignore it.
    expect(MERCHANT_SIDE_PARK.has("mandate_cycle_limit_exceeded")).toBe(false);
    expect(PARK.has("mandate_cycle_limit_exceeded")).toBe(true);
  });
});

describe("every email type is manageable by the merchant", () => {
  it("EMAIL_TYPES lists every type that has a template", () => {
    // `EMAIL_TYPES: readonly EmailType[]` makes a WRONG entry a compile error but a
    // MISSING one silent — and it is the list that drives the settings toggles, the
    // template editor and resolveEmailConfig's parse. `pre_debit_notification` was
    // absent and therefore shipped invisible: no toggle, no editor, and its stored
    // preference silently dropped on every read. DEFAULT_TEMPLATES is the exhaustive
    // `Record<EmailType, …>`, so it is the honest source to compare against.
    expect([...EMAIL_TYPES].sort()).toEqual(Object.keys(DEFAULT_TEMPLATES).sort());
  });

  it("the OpenAPI path enum matches EMAIL_TYPES", () => {
    // `src/api/openapi.ts` is a standalone literal with no imports, so its copy of
    // this list is maintained by hand — and it had drifted to 5 of 25, documenting
    // /emails/templates/{type} as rejecting twenty types it accepts. The spec cannot
    // import the constant, but a test can import both.
    const param = (
      openapiDocument as unknown as {
        paths: Record<
          string,
          Record<
            string,
            {
              parameters?: Array<{ name: string; schema?: { enum?: string[] } }>;
            }
          >
        >;
      }
    ).paths["/v1/businesses/{biz}/emails/templates/{type}"]?.get?.parameters?.find(
      (p) => p.name === "type",
    );
    expect(param?.schema?.enum?.slice().sort()).toEqual([...EMAIL_TYPES].sort());
  });
});

/**
 * `mandate_expired` — the rail-neutral template a lapsed MANDATE now routes to instead of
 * `payment_method_invalid` (a stand-in) or `card_expired` (which would print the wrong
 * fact: a card-rail mandate's own end date, not its printed expiry). Filed 2026-09-01 as
 * "a rail-neutral 'your auto-debit authorization ended' email template does not exist"
 * (docs/PROGRESS.md).
 */
describe("mandate_expired — the rail-neutral auto-debit-authorization template", () => {
  const tpl = DEFAULT_TEMPLATES.mandate_expired;

  it("names neither a card nor a date", () => {
    // The two things `card_expired` cannot avoid saying about a mandate lapse: a printed
    // card fact, or a specific date. This template must not reach for either.
    const text = `${tpl.subject} ${tpl.heading} ${tpl.body}`;
    expect(text).not.toMatch(/\{\{card(Brand|Last4|Expiry)\}\}/);
    expect(text).not.toMatch(/\{\{(cardExpiry|debitDate|renewalDate|cancelDate|dueDate)\}\}/);
  });

  it("uses only vars TEMPLATE_VARS advertises, and paymentMethodType is always present", () => {
    // A var the body references but the outbox never populates renders empty, silently
    // (templates.ts's own warning) — so every `{{key}}` in the body must be one this
    // type's contract actually offers.
    // `{{else}}` is template syntax, not a variable.
    const used = [...tpl.body.matchAll(/\{\{(\w+)\}\}/g)]
      .map((m) => m[1])
      .filter((k) => k !== "else");
    const advertised = new Set(TEMPLATE_VARS.mandate_expired.map((v) => v.key));
    for (const key of used) expect(advertised.has(key as never)).toBe(true);
    const paymentMethodTypeVar = TEMPLATE_VARS.mandate_expired.find(
      (v) => v.key === "paymentMethodType",
    );
    expect(paymentMethodTypeVar?.always).toBe(true);
  });

  it("names the one remedy: a fresh authorization, not a card or a repair", () => {
    expect(tpl.body.toLowerCase()).toContain("authoriz");
    expect(tpl.body.toLowerCase()).not.toContain("card");
  });
});

describe("the currency a mandate is registered in", () => {
  // `resolveCustomerCurrency` = this rule + a `getCustomerFinancials` read. The rule is
  // the part that was wrong in two places at once, so it is what gets pinned here.
  it("prefers the customer's explicit currency", () => {
    expect(deriveEffectiveCurrency("INR", { USD: 999_999 })).toBe("INR");
  });

  it("falls back to the currency of the live subscriptions, NOT the business default", () => {
    // Regression, measured 2026-08-14. `customers.currency` is optional and usually null
    // (the API accepts a customer without one; an import need not write it).
    // Both the portal's gateway list and `beginVaultSetup` went straight to the business
    // default — USD here — so an INR customer was offered a gateway list with the only
    // INR gateway missing, AND RazorPay Checkout offered them a mandate of "US$1 now,
    // up to US$1,000/month" on an INR-only account.
    expect(deriveEffectiveCurrency(null, { INR: 6_602_500 })).toBe("INR");
  });

  it("picks the heaviest currency when a customer has several", () => {
    expect(deriveEffectiveCurrency(null, { USD: 100, INR: 6_602_500 })).toBe("INR");
  });

  it("returns null when there is nothing to infer from, so the caller can use the business default", () => {
    // The business default is still the right last resort — it just must not PRE-EMPT
    // the customer's own subscriptions, which is what the bug did.
    expect(deriveEffectiveCurrency(null, {})).toBeNull();
  });

  it("counts a trialing subscription, which pins a currency while carrying no MRR", () => {
    expect(deriveEffectiveCurrency(null, { INR: 0 })).toBe("INR");
  });
});

describe("a netbanking mandate webhook must correlate to the auth link, not the hidden order", () => {
  const SECRET = "test-webhook-secret";
  const rzp = new RazorpayProvider({
    keyId: "rzp_test_x",
    keySecret: "x",
    apiBase: "https://api.razorpay.com/v1",
    webhookSecret: SECRET,
  });
  const deliver = (payment: Record<string, unknown>) => {
    const body = JSON.stringify({
      id: `evt_${payment.id}`,
      event: "payment.authorized",
      entity: "event",
      created_at: 1786681800,
      payload: { payment: { entity: payment } },
    });
    return rzp.normalizeWebhook({
      payload: body,
      headers: { "x-razorpay-signature": createHmac("sha256", SECRET).update(body).digest("hex") },
    });
  };

  it("correlates on invoice_id when the payment carries one (the auth-link rail)", async () => {
    // Regression, measured 2026-08-14 against a real delivery. The netbanking rail's
    // intent is an auth LINK, so `intentAtGateway` is an `inv_…` — but RazorPay mints
    // its own order behind that link and every webhook names THAT order. Correlating on
    // the order id found no intent, so `harvestSetupIntent` never ran and a mandate that
    // was live and chargeable at the gateway had no `payment_methods` row on our side.
    const [ev] = await deliver({
      id: "pay_XXXXXXXXXXXX01",
      invoice_id: "inv_XXXXXXXXXXXX01",
      order_id: "order_XXXXXXXXXXXX01",
      token_id: "token_XXXXXXXXXXXX01",
    });
    expect(ev?.providerIntentId).toBe("inv_XXXXXXXXXXXX01");
    // The charge handle stays the PAYMENT — that is what a later capture is keyed on.
    expect(ev?.providerChargeId).toBe("pay_XXXXXXXXXXXX01");
  });

  it("still correlates on order_id for the card and UPI rails, which send no invoice", async () => {
    // Verified on the same account: a card/UPI mandate payment carries `invoice_id: null`.
    // Preferring the invoice must not disturb the two rails that were already working.
    const [ev] = await deliver({
      id: "pay_XXXXXXXXXXXX02",
      invoice_id: null,
      order_id: "order_XXXXXXXXXXXX02",
      token_id: "token_XXXXXXXXXXXX02",
    });
    expect(ev?.providerIntentId).toBe("order_XXXXXXXXXXXX02");
  });
});

describe("stale-pending grace periods are per rail, not one global timeout", () => {
  it("gives netbanking a week — its debit alone takes up to 2 working days", () => {
    expect(__graceHoursFor("emandate", null)).toBe(24 * 7);
    expect(__graceHoursFor("nach", null)).toBe(24 * 7);
  });

  it("gives a card longer than the 72h AFA link it may be waiting on", () => {
    // Still true and still deliberate: this is the ORDINARY grace, for a card debit
    // that is not waiting on anyone. An AFA debit's grace is clamped down to the
    // abandon window at the call site — see the clamp test above.
    expect(__graceHoursFor("card", null)).toBeGreaterThan(72);
  });

  it("gives UPI the shortest window — it settles in minutes to hours", () => {
    expect(__graceHoursFor("upi", null)).toBeLessThan(__graceHoursFor("card", null));
  });

  it("falls back to the method type when no mandate rail is recorded", () => {
    expect(__graceHoursFor(null, "upi")).toBe(__graceHoursFor("upi", null));
  });

  it("uses a generous default for a rail it has not characterised", () => {
    // Sweeping early only costs a needless gateway call; the default must never
    // be tighter than a rail's real settlement time.
    expect(__graceHoursFor(null, null)).toBe(72);
  });

  it("the SQL pre-filter must key off the NARROWEST grace, not the widest", () => {
    // Regression: the coarse bound selects rows OLDER than a cutoff, so using the
    // widest grace excluded rows already due under a shorter rail. Measured against
    // a real RazorPay UPI debit — the fresh transaction was skipped entirely, and
    // UPI (48h) would not have been swept until 168h.
    //
    // Asserted as a property of the table rather than by reaching into the query:
    // the pre-filter is only correct if no rail's own grace is shorter than the
    // bound, i.e. the bound IS the minimum.
    const all = ["upi", "card", "emandate", "nach", "bank_transfer"].map((r) =>
      __graceHoursFor(r, null),
    );
    const bound = Math.min(__graceHoursFor(null, null), ...all);
    for (const g of all) expect(g).toBeGreaterThanOrEqual(bound);
    // And the two must genuinely differ, or the bug could not have been observed —
    // if every rail shared one grace period this test would pass vacuously.
    expect(Math.max(...all)).toBeGreaterThan(bound);
  });
});

/**
 * RazorPay webhook coverage — the subscription list and the settlement normalizer.
 *
 * Two failure modes, both silent. A handled event that is not SUBSCRIBED can never fire
 * (that was `token.updated` for months). A subscribed event with no normalizer arrives and
 * is discarded. The list and the map have to agree, and only a test keeps them agreeing.
 */
describe("razorpay webhook coverage", () => {
  const src = readFileSync(resolve(__dirname, "../../src/providers/razorpay.ts"), "utf8");
  // The list the adapter registers and the setup steps name (one source).
  const subscribed = new Set<string>(RAZORPAY_WEBHOOK_EVENTS);

  it("reads a non-empty subscription list", () => {
    // Guards the checks below: an empty set makes the coverage check pass vacuously.
    expect(subscribed.size).toBeGreaterThan(10);
  });

  it("does NOT subscribe to the two names RazorPay rejects", () => {
    // MEASURED: adding these produced
    //   PUT /v1/webhooks → 400 "Invalid event name/names: token.resumed, token.updated"
    // and since a failed registration falls back to `paste_required`, one bad name
    // silently downgrades an auto-provisioned endpoint to a manual one. RazorPay
    // validates the list as a whole, so a single invalid entry loses all of them.
    expect(subscribed.has("token.paused")).toBe(true);
    expect(subscribed.has("token.resumed")).toBe(false);
    expect(subscribed.has("token.updated")).toBe(false);
  });

  it("subscribes to settlement.processed — the payout the books reconcile against", () => {
    expect(subscribed.has("settlement.processed")).toBe(true);
  });

  it("maps every token event it subscribes to — a subscribed-but-unmapped event is discarded", () => {
    // Only this direction can be asserted. The reverse (mapped ⊆ subscribed) is FALSE by
    // design here: `token.resumed` and `token.updated` stay mapped so they work if
    // RazorPay ever ships them, while being unsubscribable today.
    const mapped = new Set(
      // Quote-agnostic for the same reason as above.
      [...src.matchAll(/['"](token\.[a-z]+)['"]:\s*['"]payment_method\./g)].map((m) => m[1]!),
    );
    for (const t of [...subscribed].filter((e) => e.startsWith("token."))) {
      expect(mapped.has(t)).toBe(true);
    }
  });
});

/**
 * ── F-11: the pending MIDDLE of the mandate lifecycle ─────────────────────────────
 *
 * The two ENDS were already handled: `applyMandateUpdate` invalidates the instrument on a
 * DEAD status and restores it on a resume. The middle was not, and it is the window with
 * money in it — a netbanking e-mandate is `initiated` from the moment the buyer finishes
 * at their bank until the bank confirms (HDFC/SBI: T+1), and for that whole window the
 * instrument is not chargeable while the row looks perfectly healthy.
 *
 * The two directions are tested as a PAIR on purpose: a guard blinded to `initiated` fails
 * the refusal cases, and a guard that refuses everything fails the `confirmed` /
 * no-status / unknown-status cases. Neither mutation can pass this block.
 */
describe("mandatePendingRefusal — an unconfirmed mandate never reaches the gateway", () => {
  it("refuses a debit against a mandate the bank has not confirmed", () => {
    const r = mandatePendingRefusal(
      pm({ mandateStatus: "initiated", mandateRail: "emandate" }),
      true,
    );
    expect(r?.status).toBe("failed");
    expect(r?.failure?.code).toBe(MANDATE_PENDING_CODE);
    // No gateway call was made, so there is no charge id to claim one.
    expect(r?.providerChargeId).toBe("");
    // Structured context for the operator, beside the prose for the payer.
    const raw = r!.raw as Record<string, unknown>;
    expect(raw.mandate_status).toBe("initiated");
    expect(raw.mandate_rail).toBe("emandate");
  });

  it("is RETRIABLE — the opposite of a ceiling breach, and for a reason", () => {
    // A ceiling breach is permanent until a human re-authorises at a higher limit
    // (`retriable: false`). A pending mandate clears ITSELF when the bank confirms, and
    // the very same debit then succeeds — so this is the one refusal in the file that
    // wants to be tried again unchanged.
    const r = mandatePendingRefusal(pm({ mandateStatus: "initiated" }), true);
    expect(r?.failure?.retriable).toBe(true);
    // …so not a hard decline — but the backup may pay while the bank confirms.
    expect(isHardDecline(r!)).toBe(false);
    expect(shouldTryBackup(r!)).toBe(true);
  });

  it("writes the payer a message that answers 'what did I do wrong' with 'nothing'", () => {
    // BUYER-FACING by the same route as `mandateRefusal`'s: it rides `payment_failed` as
    // `{{declineMessage}}` into the mail the payer reads. It must name the party being
    // waited on, promise the retry, and carry none of our internal ids.
    const r = mandatePendingRefusal(
      pm({ mandateStatus: "initiated", mandateRail: "emandate" }),
      true,
    );
    expect(r?.failure?.message).toMatch(/bank/i);
    expect(r?.failure?.message).toMatch(/You do not need to do anything/i);
    expect(r?.failure?.message).toContain("emandate");
    expect(r?.failure?.message).not.toContain("pm_");
    // It must NOT tell them to re-add the method: that registers a SECOND mandate and
    // leaves the first dangling at the bank.
    expect(r?.failure?.message).not.toMatch(/add (a |another )?(new )?payment method/i);
  });

  it("does NOT refuse a live mandate", () => {
    // The paired green case. An always-refusing guard dies here.
    expect(mandatePendingRefusal(pm({ mandateStatus: "confirmed" }), true)).toBeNull();
    expect(mandatePendingRefusal(pm({ mandateStatus: "active" }), true)).toBeNull();
  });

  it("does NOT refuse an instrument with no mandate status at all", () => {
    // A plain card-on-file, or a rail whose provider never reports one. The gateway stays
    // the authority, exactly as before.
    expect(mandatePendingRefusal(pm(), true)).toBeNull();
    expect(mandatePendingRefusal(pm({ mandateStatus: "" }), true)).toBeNull();
  });

  it("claims nothing about a status it has no rule for", () => {
    // An UNKNOWN status must not be folded into the nearest neighbour — assuming it is
    // pending would block collection on a guess.
    expect(mandatePendingRefusal(pm({ mandateStatus: "under_review" }), true)).toBeNull();
  });

  it("leaves a SPENT mandate to its own refusal — it is not pending, it is over", () => {
    // `spent` (a used single-use Stripe mandate) used to fall through here as `unknown`
    // and be charged. It is now refused by `mandateSpentRefusal`, with its own code and
    // its own message: telling the payer "your bank has not confirmed yet — we will try
    // again, there is nothing you need to do" about an authorization that is FINISHED
    // would be a promise nothing can keep.
    expect(mandatePendingRefusal(pm({ mandateStatus: "spent" }), true)).toBeNull();
  });

  it("leaves the DEAD end to `applyMandateUpdate`, which owns it", () => {
    // A dead mandate already flips `payment_methods.status` to `invalid`, which is what
    // takes the instrument out of collection. Refusing here too would be a second, weaker
    // copy of a rule that already works.
    for (const s of DEAD_MANDATE_STATUSES) {
      expect(mandatePendingRefusal(pm({ mandateStatus: s }), true)).toBeNull();
    }
  });

  it("compares the status case-insensitively", () => {
    expect(mandatePendingRefusal(pm({ mandateStatus: "INITIATED" }), true)?.failure?.code).toBe(
      MANDATE_PENDING_CODE,
    );
  });

  /**
   * ── `capabilities.mandates`, and why a null means two different things now ────────
   */
  it("never refuses on a gateway that has no mandate model (PayPal)", () => {
    // `mandates: false` says the gateway has no per-debit mandate concept on the flow we
    // use at all — a PayPal `usage_type: MERCHANT` billing agreement has no status to read
    // back. Refusing a PayPal debit for a mandate that never existed is the failure this
    // gate exists to prevent.
    expect(mandatePendingRefusal(pm({ mandateStatus: "initiated" }), false)).toBeNull();
  });

  it("treats an UNDECLARED capability as unknown, not as false", () => {
    // Same conservative reading the capability's own docstring takes: an adapter that has
    // not declared `mandates` must not silently switch the guard off. A status that IS
    // present is still a statement the gateway made.
    expect(
      mandatePendingRefusal(pm({ mandateStatus: "initiated" }), undefined)?.failure?.code,
    ).toBe(MANDATE_PENDING_CODE);
  });
});

/**
 * ── F-11, the expensive half: the refusal must not SPEND a dunning attempt ────────
 *
 * `recordFailedPayment` advances `invoices.attempt_count` on every non-manual failure, and
 * that counter is the INDEX into the retry offsets. Refusing locally instead of at the
 * gateway would otherwise save one round trip and still burn one of the customer's
 * scheduled retries — for an instrument we already knew was not live.
 */
describe("a pending-mandate refusal defers instead of consuming a dunning attempt", () => {
  const now = new Date("2026-08-30T00:00:00.000Z");

  it("returns an explicit backoff for the first refusal", () => {
    // The hold on `attempt_count` is not enough on its own: the retry offsets are absolute
    // from the DUE DATE and `nextRetryAt` clamps a past candidate to `now`, so re-planning
    // with an unchanged count would schedule the next attempt for immediately — a hot loop
    // that mails the payer once per tick.
    const at = mandatePendingBackoff({ failureCode: MANDATE_PENDING_CODE, deferralsSoFar: 1, now });
    expect(at).toBeInstanceOf(Date);
    expect(at!.getTime() - now.getTime()).toBe(MANDATE_PENDING_RETRY_MS);
    // Long enough that the payer is not mailed hourly about something they cannot act on.
    expect(MANDATE_PENDING_RETRY_MS).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000);
  });

  it("gives up after the cap so an abandoned mandate cannot defer for ever", () => {
    // A buyer who abandoned the authorisation at their bank leaves the mandate `initiated`
    // permanently. Deferring for ever means the invoice never dunns, never exhausts, the
    // final action never fires and the subscription stays active and unpaid — the exact
    // "parking is dunning switched OFF" failure `sweepExpiredParkedDunning` exists to end.
    expect(
      mandatePendingBackoff({
        failureCode: MANDATE_PENDING_CODE,
        deferralsSoFar: MANDATE_PENDING_MAX_DEFERRALS,
        now,
      }),
    ).toBeNull();
    // The grace it buys must still cover a T+1 bank confirmation with room to spare.
    expect(MANDATE_PENDING_MAX_DEFERRALS * MANDATE_PENDING_RETRY_MS).toBeGreaterThanOrEqual(
      24 * 60 * 60 * 1000,
    );
  });

  it("leaves every other failure to the ordinary dunning schedule", () => {
    // The deferral is keyed on the code, so nothing else on the failure path changes.
    for (const code of ["card_declined", "insufficient_funds", "mandate_ceiling_exceeded"]) {
      expect(mandatePendingBackoff({ failureCode: code, deferralsSoFar: 0, now })).toBeNull();
    }
  });
});

/**
 * ── F-43: a SPENT single-use mandate cannot carry another debit ───────────────────
 *
 * `describeStripeMandate` reports `spent` deliberately, because Stripe's `inactive`
 * means REVOKED on a `multi_use` mandate and merely "previously used" on a single-use
 * one. The word existed; nothing consumed it. It was in none of the status sets, so
 * `mandateChargeability` answered `unknown`, no guard refused it and collection kept
 * selecting it — while the buyer portal, which treats every unrecognised status as over,
 * had already told the payer the authorization was finished.
 */
describe("mandateSpentRefusal — a used one-shot mandate never reaches the gateway", () => {
  it("refuses a spent mandate, non-retriably", () => {
    const r = mandateSpentRefusal(pm({ mandateStatus: "spent", mandateRail: "sepa_debit" }), true);
    expect(r?.status).toBe("failed");
    expect(r?.failure?.code).toBe(MANDATE_SPENT_CODE);
    // Nothing fixes this by waiting: unlike `mandate_pending` the mandate does not come
    // alive, and unlike `mandate_ceiling_exceeded` not even a smaller debit succeeds.
    expect(r?.failure?.retriable).toBe(false);
    expect(r?.providerChargeId).toBe("");
  });

  it("tells the payer what actually happened, in their words and without blame", () => {
    // BUYER-FACING: it rides `payment_failed` as `declineMessage` into the mail the payer
    // receives. They authorised one payment and it was taken, exactly as agreed — so the
    // sentence names the authorization, not the customer, and it asks for the one thing
    // that clears it.
    const msg = mandateSpentRefusal(pm({ mandateStatus: "spent" }), true)!.failure!.message!;
    expect(msg).toContain("one-time payment authorization");
    expect(msg).toContain("is already used");
    // Never our vocabulary, and never an internal id.
    expect(msg).not.toContain("single_use");
    expect(msg).not.toContain("mandate");
    expect(msg).not.toContain("pm_");
  });

  it("does NOT refuse a live, pending, dead or absent mandate", () => {
    // The paired green case: a guard that fired on everything would stop all collection.
    for (const s of [...MANDATE_LIVE_STATUSES, ...MANDATE_PENDING_STATUSES]) {
      expect(mandateSpentRefusal(pm({ mandateStatus: s }), true)).toBeNull();
    }
    for (const s of DEAD_MANDATE_STATUSES) {
      // Dead is `applyMandateUpdate`'s end of the lifecycle, not this one's.
      expect(mandateSpentRefusal(pm({ mandateStatus: s }), true)).toBeNull();
    }
    expect(mandateSpentRefusal(pm(), true)).toBeNull();
    expect(mandateSpentRefusal(pm({ mandateStatus: "" }), true)).toBeNull();
    expect(mandateSpentRefusal(pm({ mandateStatus: "under_review" }), true)).toBeNull();
  });

  it("compares the status case-insensitively", () => {
    expect(mandateSpentRefusal(pm({ mandateStatus: "SPENT" }), true)?.failure?.code).toBe(
      MANDATE_SPENT_CODE,
    );
  });

  it("never refuses on a gateway that has no mandate model, and treats undeclared as unknown", () => {
    // Same two rules as `mandatePendingRefusal`, for the same reasons.
    expect(mandateSpentRefusal(pm({ mandateStatus: "spent" }), false)).toBeNull();
    expect(mandateSpentRefusal(pm({ mandateStatus: "spent" }), undefined)?.failure?.code).toBe(
      MANDATE_SPENT_CODE,
    );
  });
});

describe("a spent-mandate refusal must not blame the instrument either", () => {
  const refusal = mandateSpentRefusal(pm({ mandateStatus: "spent" }), true)!;

  it("is not a hard decline, so the payment method is NOT marked invalid", () => {
    // Our own pre-flight refused it — no issuer said a word about the card. `invalid` is
    // where a bank's verdict belongs, and the fact that matters is already recorded in
    // `payment_methods.mandate_status`.
    expect(isHardDecline(refusal)).toBe(false);
  });

  it("still moves on to the backup instrument, which may carry a live mandate", () => {
    expect(shouldTryBackup(refusal)).toBe(true);
  });

  it("does not weaken the ceiling exemption or ordinary hard declines", () => {
    expect(
      isHardDecline(
        mandateRefusal(pm({ mandateMaxAmountMinor: 100n, mandateCurrency: "INR" }), 200n, "INR")!,
      ),
    ).toBe(false);
    expect(
      isHardDecline({ status: "failed", failure: { retriable: false, code: "stolen_card" } }),
    ).toBe(true);
  });

  it("parks in BOTH dunning modes rather than exhausting on the first attempt", () => {
    // Smart mode classifies it; fixed mode needs the explicit carve-out, because the
    // refusal is non-retriable and "skip retries for hard failures" is on by default.
    // Without it a fixed-mode business exhausts dunning on attempt 1 — the measured
    // ₹66,025 failure in `planFailureRearm`, where the invoice dies and the subscription
    // stays live and unpaid forever.
    expect(classifyDecline(MANDATE_SPENT_CODE)).toBe("park");
    expect(PARK_EVEN_IN_FIXED_MODE.has(MANDATE_SPENT_CODE)).toBe(true);
    // Carries a cancellation deadline, like every park since 2026-09-04. Kept paired
    // with `mandate_ceiling_exceeded` because the two are the same shape: a refusal only
    // re-authorising clears. If one ever diverges, that is the bug.
    expect(PARK.has(MANDATE_SPENT_CODE)).toBe(PARK.has("mandate_ceiling_exceeded"));
  });
});

/**
 * ── THE EXPIRY AXIS, and the regression it pins ───────────────────────────────────
 *
 * `payment_methods.mandate_expires_at` has been written since 0179 and was never READ by
 * the charge path: every reference outside the migrations was a write (`webhooks/inbound`,
 * `payment-methods/service`) or a display (`payment-methods/serialize`). `expired` is not
 * in `DEAD_MANDATE_STATUSES`, and `paymentSourceSweep` looks only at the card's PRINTED
 * expiry — so a 01/2099 card whose mandate died yesterday was flagged nowhere and the
 * debit went to the gateway as an ordinary decline for dunning to retry.
 *
 * ⚠️ NOT the mechanism first offered for this. "The RazorPay ORDER validity leaks into the
 * mandate end-date field" was wrong and is retracted: `providers/razorpay.ts` sends
 * `expire_at = now + 10 years` on every rail, and the auth-link path's
 * `expire_by = now + 7 days` is the LINK's shelf life and reaches no mandate field. We
 * store what the gateway RETURNS, and on cards RazorPay returns its own, much shorter
 * date — measured 2026-09-01: 137 card mandates holding three distinct end-of-day IST
 * instants, 115 of them ALREADY PAST while still reporting `mandate_status: confirmed`.
 *
 * Every assertion below fails without the pre-flight: `mandateExpiredRefusal` did not
 * exist, so the expired mandate returned null from every guard in `collection.ts` and the
 * charge was sent.
 */
describe("mandateExpiredRefusal — a lapsed mandate never reaches the gateway", () => {
  const NOW = new Date("2026-09-01T06:00:00Z");
  /** The measured shape: RazorPay says `confirmed`, its own end date has gone by. */
  const lapsed = pm({
    mandateStatus: "confirmed",
    mandateRail: "card",
    mandateReference: "token_TESTexpired",
    mandateExpiresAt: new Date("2026-08-31T18:29:59Z"),
    mandateMaxAmountMinor: 10_000_000n,
    mandateCurrency: "INR",
  });

  it("refuses a debit against a mandate whose end date has passed", () => {
    const r = mandateExpiredRefusal(lapsed, true, NOW)!;
    expect(r).not.toBeNull();
    expect(r.status).toBe("failed");
    expect(r.failure?.code).toBe(MANDATE_EXPIRED_CODE);
    // Non-retriable: an authorisation that lapsed does not come back, and no retry
    // interval reaches a date in the past.
    expect(r.failure?.retriable).toBe(false);
    // The gateway was never called, so there is no charge id to report.
    expect(r.providerChargeId).toBe("");
  });

  it("reads a live-reported status as expired anyway — the two are separate axes", () => {
    // The whole defect. `mandateChargeability` says `live` because that is what RazorPay
    // reported; the clock says otherwise, and the clock is the fact that stops the debit.
    expect(mandateChargeability(lapsed)).toBe("live");
    expect(mandateHasExpired(lapsed, NOW)).toBe(true);
  });

  it("treats a NULL end date as unknown, never as expired", () => {
    // A plain card-on-file, a provider that reports no end date, every row vaulted before
    // 0179. Reading null as expired would refuse every card on the platform.
    expect(mandateExpiredRefusal(pm({ mandateStatus: "confirmed" }), true, NOW)).toBeNull();
    expect(mandateHasExpired({ mandateExpiresAt: null }, NOW)).toBe(false);
  });

  it("does not refuse a mandate that is still inside its term", () => {
    const good = pm({
      mandateStatus: "confirmed",
      mandateExpiresAt: new Date("2036-08-25T05:58:05Z"),
    });
    expect(mandateExpiredRefusal(good, true, NOW)).toBeNull();
    expect(mandateHasExpired(good, NOW)).toBe(false);
  });

  it("has no grace period — the boundary instant is already over", () => {
    // A grace would be us overriding the gateway's own end date with an invented one, and
    // the debit it let through would be refused by RazorPay anyway.
    const at = pm({ mandateExpiresAt: NOW });
    expect(mandateHasExpired(at, NOW)).toBe(true);
    expect(mandateHasExpired(pm({ mandateExpiresAt: new Date(NOW.getTime() + 1) }), NOW)).toBe(
      false,
    );
  });

  it("stays silent for a gateway with no mandate model, and not for an undeclared one", () => {
    // Same two exemptions as the pending and spent refusals. PayPal's MERCHANT billing
    // agreement has no mandate; an adapter that has not declared the capability is
    // UNKNOWN, and unknown is not false.
    expect(mandateExpiredRefusal(lapsed, false, NOW)).toBeNull();
    expect(mandateExpiredRefusal(lapsed, undefined, NOW)).not.toBeNull();
  });

  it("carries the facts an operator needs in `raw`, not in the prose", () => {
    const r = mandateExpiredRefusal(lapsed, true, NOW)!;
    expect(r.raw).toMatchObject({
      mandate_expires_at: "2026-08-31T18:29:59.000Z",
      mandate_rail: "card",
      mandate_reference: "token_TESTexpired",
    });
  });

  it("tells the payer the date and does not hand them an internal id", () => {
    const msg = mandateExpiredRefusal(lapsed, true, NOW)!.failure!.message!;
    // Buyer-facing: it rides `payment_failed` as `declineMessage` into the payer's mail.
    expect(msg).toContain("2026-08-31");
    expect(msg).toContain("authorize a payment method again".toLowerCase().slice(0, 8));
    expect(msg).not.toContain("pm_");
    expect(msg).not.toContain("mandate");
    expect(msg).not.toContain("token_");
  });
});

describe("an expired-mandate refusal must not blame the instrument, and must not exhaust dunning", () => {
  const refusal = mandateExpiredRefusal(
    pm({ mandateStatus: "confirmed", mandateExpiresAt: new Date("2020-01-01T00:00:00Z") }),
    true,
  )!;

  it("is not a hard decline, so the payment method is NOT marked invalid", () => {
    // The issuer was never asked. In the measured RazorPay case the card behind it is a
    // 01/2099 test card in perfect health, and `invalid` would outlive the mandate — the
    // row stays written off long after a new authorisation is registered on the same card.
    expect(isHardDecline(refusal)).toBe(false);
  });

  it("still moves on to the backup instrument, which may carry a live mandate", () => {
    expect(shouldTryBackup(refusal)).toBe(true);
  });

  /**
   * ⚠️ THE ASSERTION THAT MAKES THE FIX SAFE RATHER THAN HARMFUL.
   *
   * Fixed mode is the only selectable mode (`src/api/routes.ts`, the dunning settings
   * page), and there `planFailureRearm` turns a non-retriable failure into `exhausted` on
   * the FIRST attempt unless the code is in `PARK_EVEN_IN_FIXED_MODE`. Exhaustion at the
   * first bill means no dunning pass ever revisits the row, so the cancel-on-exhaust never
   * fires either: the invoice is dead, the subscription stays ACTIVE, and the customer is
   * served for free — silent, permanent revenue loss, measured at ₹66,025 and documented
   * in `planFailureRearm`. So a new non-retriable refusal without this classification is
   * strictly worse than no refusal at all.
   */
  it("parks in BOTH dunning modes rather than exhausting on the first attempt", () => {
    expect(classifyDecline(MANDATE_EXPIRED_CODE)).toBe("park");
    expect(PARK_EVEN_IN_FIXED_MODE.has(MANDATE_EXPIRED_CODE)).toBe(true);
    // Carries a cancellation deadline, like every park since 2026-09-04. Kept paired with
    // the other two re-authorise-to-recover refusals: all three must answer alike.
    expect(PARK.has(MANDATE_EXPIRED_CODE)).toBe(PARK.has("mandate_ceiling_exceeded"));
  });

  it("is not read as terminate, which would cancel the subscription outright", () => {
    // A lapsed authorisation is not `revocation_of_authorization`: nobody revoked
    // anything, and the customer can clear it in a minute.
    expect(classifyDecline(MANDATE_EXPIRED_CODE)).not.toBe("terminate");
  });
});

/**
 * ── F-42: the confirmation is a TRANSITION, and only a transition collects ────────
 *
 * `applyMandateUpdate` learns that a netbanking e-mandate the bank sat on until T+1 is
 * finally debitable, and until F-42 it told nobody: the add-card routes collect a
 * customer's open invoices against a newly usable instrument, the webhook that MAKES an
 * instrument usable did not. With F-11's pre-flight refusing debits while a mandate is
 * `initiated` and deferring 12 hours, the confirmation is the only prompt event the buyer
 * gets.
 */
describe("mandateBecameLive — what may trigger recovery collection", () => {
  it("fires when the bank confirms a mandate that was waiting", () => {
    expect(mandateBecameLive("initiated", "confirmed")).toBe(true);
    expect(mandateBecameLive("initiated", "active")).toBe(true);
  });

  it("does NOT fire on a redelivery that re-asserts the same live status", () => {
    // The guard that actually holds. Provider-event dedup keys on `provider_event_id`, so
    // two DIFFERENT events both asserting `confirmed` both pass it — and a delivery whose
    // prior outcome was `error` is deliberately let through to run again, which is exactly
    // the redelivery this handler can cause when a recovery charge throws.
    expect(mandateBecameLive("confirmed", "confirmed")).toBe(false);
    expect(mandateBecameLive("active", "confirmed")).toBe(false);
    expect(mandateBecameLive("confirmed", "active")).toBe(false);
  });

  it("fires on a resume from paused — an instrument becoming collectable again", () => {
    // The same situation as an add-card, and the un-pause branch already restores
    // `payment_methods.status` to `valid` for exactly that reason.
    expect(mandateBecameLive("paused", "confirmed")).toBe(true);
  });

  it("does NOT fire on a resume that lands somewhere not yet chargeable", () => {
    // `paused` → `initiated` un-invalidates the instrument but the bank has still not
    // confirmed. Collecting here would trip F-11's pending pre-flight and spend one of the
    // three 12-hour deferrals for nothing.
    expect(mandateBecameLive("paused", "initiated")).toBe(false);
  });

  it("fires when a mandate appears live out of nowhere, and never on a non-live status", () => {
    // No stored status at all (a row vaulted before the mandate columns, or a provider
    // that reported nothing until now) is not live, so a confirmation IS a transition.
    expect(mandateBecameLive(null, "confirmed")).toBe(true);
    expect(mandateBecameLive(undefined, "active")).toBe(true);
    // …and nothing that is not live can trigger collection, whatever it came from.
    for (const after of ["initiated", "rejected", "cancelled", "paused", "spent", "wat", null]) {
      expect(mandateBecameLive("initiated", after)).toBe(false);
    }
  });
});

describe("the mandate status vocabulary is canonical, not per-consumer", () => {
  it("classifies each set, and nothing else", () => {
    expect(mandateChargeability({ mandateStatus: "confirmed" })).toBe("live");
    expect(mandateChargeability({ mandateStatus: "initiated" })).toBe("pending");
    expect(mandateChargeability({ mandateStatus: "cancelled" })).toBe("dead");
    expect(mandateChargeability({ mandateStatus: "spent" })).toBe("spent");
    expect(mandateChargeability({ mandateStatus: "under_review" })).toBe("unknown");
    expect(mandateChargeability({ mandateStatus: null })).toBe("none");
  });

  it("keeps the four sets disjoint", () => {
    // A status in two of them would make the guard's answer depend on the order the sets
    // are tested, which is exactly the kind of bug nobody finds by reading.
    const all = [
      ...MANDATE_LIVE_STATUSES,
      ...MANDATE_PENDING_STATUSES,
      ...DEAD_MANDATE_STATUSES,
      ...MANDATE_SPENT_STATUSES,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it("PARTITIONS every status the adapters actually emit (F-43)", () => {
    // Open at the edge — `mandateChargeability` still answers `unknown` for a word we have
    // no rule for — but CLOSED over the normalised vocabulary. `spent` was the hole: a
    // status both adapters can emit that belonged to no set, so the pending guard did not
    // refuse it, `applyMandateUpdate` did not invalidate on it, and collection went on
    // debiting a single-use authorization that had already been used.
    const classified = new Set([
      ...MANDATE_LIVE_STATUSES,
      ...MANDATE_PENDING_STATUSES,
      ...DEAD_MANDATE_STATUSES,
      ...MANDATE_SPENT_STATUSES,
    ]);
    expect([...classified].sort()).toEqual([...MANDATE_NORMALISED_STATUSES].sort());
    for (const s of MANDATE_NORMALISED_STATUSES) {
      expect(mandateChargeability({ mandateStatus: s })).not.toBe("unknown");
    }
  });

  it("uses the same word both adapters normalise a waiting mandate to", () => {
    // RazorPay reports `recurring_details.status: initiated`; `describeStripeMandate` maps
    // Stripe's `pending` onto the same word. One value, not a guess at more.
    expect([...MANDATE_PENDING_STATUSES]).toEqual(["initiated"]);
  });
});

/**
 * ── F-24: the rail caps are RUPEES, and a bigint carries no denomination ──────────
 */
describe("rail ceiling caps are not comparable across currencies", () => {
  it("reports nothing over cap for a currency the caps are not denominated in", () => {
    // A USD checkout session asking a ceiling above 10,000,000 minor (~$100k) used to
    // report `upi` over cap — for a business with no Indian rail at all — and the buyer was
    // shown "UPI Autopay cannot be approved for $X per charge; your bank caps it lower".
    // No bank in that session caps anything and no UPI was on offer to be capped.
    // `mandateRefusal` sets the precedent one file over: SKIP on a currency mismatch
    // rather than invent an FX rate at the comparison site.
    expect(railsOverCeilingCap(13_275_000n, ["card", "upi", "emandate"], "USD")).toEqual([]);
    expect(railsOverCeilingCap(99_999_999_999n, ["upi"], "EUR")).toEqual([]);
  });

  it("still caps in the currency the figures actually are", () => {
    expect(railsOverCeilingCap(13_275_000n, ["card", "upi", "emandate"], "INR")).toEqual(["upi"]);
    expect(railsOverCeilingCap(13_275_000n, ["card", "upi", "emandate"], "inr")).toEqual(["upi"]);
    expect(MANDATE_RAIL_CEILING_CURRENCY).toBe("INR");
  });

  it("keeps the previous behaviour when no currency is passed", () => {
    // The parameter is optional so the one existing call site
    // (`resolveSessionMandateRequirement`, modules/checkout/service.ts) cannot change
    // meaning underneath itself. It should pass the session currency; until it does, an
    // INR session keeps the right answer rather than acquiring a new wrong one.
    expect(railsOverCeilingCap(13_275_000n, ["card", "upi", "emandate"])).toEqual(["upi"]);
  });
});

/**
 * ── F-45: the sweep's second expiry axis, and the mail cutover ────────────────────
 *
 * The charge path already refuses a debit against a lapsed mandate (the block above), so
 * the MONEY was correct before this. The INSTRUMENT was not: a lapsed mandate still read
 * `status: 'valid'`, so `pickPrimaryCandidate` preferred it over a live sibling (its
 * "usable" test is `status === 'valid'`), the operator's list and the buyer portal both
 * showed it as fine, and `assertChargeableForAutoCollect` — which filters on exactly
 * `status !== 'expired' && status !== 'invalid'` — would let a new auto-collect
 * subscription be created against a dead authorization.
 *
 * `paymentSourceSweep` could not close that, twice over: its candidate query required a
 * non-null PRINTED expiry (so a `upi` / `emandate` instrument never entered the scan at
 * all), and its transition was computed from that printed expiry alone (so a CARD mandate
 * did enter, was judged on 01/2099, and always answered "no transition").
 *
 * The second half of these assertions is the SUPPRESSION. Emitting
 * `payment_source_expired` is what mails the payer (`emails/outbox.ts` maps it to the
 * `card_expired` template) and what fans out to webhook subscribers, so "demote but do
 * not write to them" is expressed as `notify: false` — and it is scoped to the one
 * measured cohort: the 115 dev-database mandates that lapsed at `2026-08-31T18:29:59Z`
 * while nothing was reading the column.
 */
describe("decidePaymentSourceExpiry — mandate expiry demotes the instrument", () => {
  const NOW = new Date("2026-09-01T06:00:00Z");
  /** The measured shape: a card printed 01/2099 whose mandate RazorPay ended yesterday. */
  const CARD_2099 = { expMonth: 1, expYear: 2099 };

  it("demotes a card whose MANDATE has lapsed, however far off its printed expiry is", () => {
    // Fails without F-45: the printed expiry is 2099, so the sweep answered `valid` and
    // the row stayed selectable — the whole gap.
    const d = decidePaymentSourceExpiry(
      { ...CARD_2099, mandateExpiresAt: new Date("2026-08-31T18:29:59Z") },
      NOW,
    );
    expect(d.next).toBe("expired");
    expect(d.reason).toBe("mandate");
  });

  it("demotes an instrument with NO printed expiry at all (upi / emandate)", () => {
    // These rows carry null exp_month/exp_year and were excluded by the candidate query
    // itself, so the sweep was not merely wrong about them — it never saw them.
    const d = decidePaymentSourceExpiry(
      { expMonth: null, expYear: null, mandateExpiresAt: new Date("2026-08-31T18:29:59Z") },
      NOW,
    );
    expect(d.next).toBe("expired");
    expect(d.reason).toBe("mandate");
  });

  it("suppresses the mail for a mandate that lapsed BEFORE the cutover", () => {
    // The 115-row backlog. Demoted — the instrument must stop being selected — but the
    // payer is not written to about a state they have been in for weeks.
    const d = decidePaymentSourceExpiry(
      { ...CARD_2099, mandateExpiresAt: new Date("2026-08-31T18:29:59Z") },
      NOW,
    );
    expect(d.next).toBe("expired");
    expect(d.notify).toBe(false);
  });

  it("MAILS a mandate that lapses after the cutover", () => {
    // The feature half. A mandate that ends on its own schedule from here on is news, and
    // the customer hears about it on the tick that notices.
    const d = decidePaymentSourceExpiry(
      { ...CARD_2099, mandateExpiresAt: new Date("2026-09-30T18:29:59Z") },
      new Date("2026-10-01T06:00:00Z"),
    );
    expect(d.next).toBe("expired");
    expect(d.reason).toBe("mandate");
    expect(d.notify).toBe(true);
  });

  it("treats the cutover instant itself as backlog", () => {
    // "Everything up to here is old" — the boundary belongs to the suppressed side, so a
    // mandate that ended exactly at the cutover cannot slip through as news.
    const at = decidePaymentSourceExpiry(
      { ...CARD_2099, mandateExpiresAt: MANDATE_EXPIRY_NOTICE_FROM },
      NOW,
    );
    expect(at.notify).toBe(false);
    const after = decidePaymentSourceExpiry(
      { ...CARD_2099, mandateExpiresAt: new Date(MANDATE_EXPIRY_NOTICE_FROM.getTime() + 1) },
      NOW,
    );
    expect(after.notify).toBe(true);
  });

  it("clears the measured backlog cluster and lets the two later cohorts through", () => {
    // The three distinct end dates found in the dev database, asserted as a set so the
    // cutover cannot be moved without a test going red: 115 rows at end-of-day IST on
    // 2026-08-31 (backlog), 2 at 2026-09-30 and 20 at 2030-12-31 (news, when they lapse).
    expect(MANDATE_EXPIRY_NOTICE_FROM.getTime()).toBeGreaterThan(
      new Date("2026-08-31T18:29:59Z").getTime(),
    );
    expect(MANDATE_EXPIRY_NOTICE_FROM.getTime()).toBeLessThan(
      new Date("2026-09-30T18:29:59Z").getTime(),
    );
    expect(MANDATE_EXPIRY_NOTICE_FROM.getTime()).toBeLessThan(
      new Date("2030-12-31T18:29:59Z").getTime(),
    );
  });

  it("keeps the PRINTED expiry deciding first, so no existing mail is suppressed", () => {
    // The ordering regression this guards. A card past BOTH its printed expiry and its
    // mandate's end date is flagged and mailed TODAY. Reading the mandate first would
    // route it through the cutover and silence a notice we already send — a regression
    // dressed as a feature. Printed expiry wins, and says so in `reason`.
    const both = decidePaymentSourceExpiry(
      { expMonth: 7, expYear: 2026, mandateExpiresAt: new Date("2026-08-31T18:29:59Z") },
      NOW,
    );
    expect(both.next).toBe("expired");
    expect(both.reason).toBe("card");
    expect(both.notify).toBe(true);
  });

  it("keeps the pre-F-45 answers for every row the old sweep could reach", () => {
    // Bit-for-bit: an expired printed date, one expiring this month, one in the future,
    // each with no mandate at all. The mandate branch may only ADD rows.
    expect(
      decidePaymentSourceExpiry({ expMonth: 12, expYear: 2025, mandateExpiresAt: null }, NOW),
    ).toEqual({ next: "expired", reason: "card", notify: true });
    expect(
      decidePaymentSourceExpiry({ expMonth: 9, expYear: 2026, mandateExpiresAt: null }, NOW),
    ).toEqual({ next: "expiring", reason: "card", notify: true });
    expect(
      decidePaymentSourceExpiry({ expMonth: 10, expYear: 2026, mandateExpiresAt: null }, NOW),
    ).toEqual({ next: "valid", reason: null, notify: false });
  });

  it("reads a null end date as unknown, not as expired", () => {
    // The same rule `mandateHasExpired` documents: null is a plain card-on-file, a
    // provider that reports no end date, or a row vaulted before 0179. Reading it as
    // expired would demote every card on the platform.
    const d = decidePaymentSourceExpiry({ ...CARD_2099, mandateExpiresAt: null }, NOW);
    expect(d.next).toBe("valid");
    expect(d.notify).toBe(false);
  });

  it("does not demote a mandate still inside its term", () => {
    const d = decidePaymentSourceExpiry(
      { ...CARD_2099, mandateExpiresAt: new Date("2036-08-25T05:58:05Z") },
      NOW,
    );
    expect(d.next).toBe("valid");
    expect(d.reason).toBeNull();
  });

  it("demotes to a status the selection and creation guards actually read", () => {
    // `expired` is not decoration. `pickPrimaryCandidate` prefers `status === 'valid'`, and
    // `assertChargeableForAutoCollect` filters on `status !== 'expired' && !== 'invalid'` —
    // so this exact word is what stops a dead authorization from being picked over a live
    // sibling and from carrying a brand-new auto-collect subscription. Pinned because a
    // rename to anything else would silently restore the bug.
    const d = decidePaymentSourceExpiry(
      { ...CARD_2099, mandateExpiresAt: new Date("2026-08-31T18:29:59Z") },
      NOW,
    );
    expect(d.next).toBe("expired");
    expect(
      pickPrimaryCandidate([
        { role: null, status: d.next },
        { role: null, status: "valid" },
      ]),
    ).toEqual({ role: null, status: "valid" });
  });
});

/**
 * The per-debit ceiling of a Stripe INDIA CARD e-mandate.
 *
 * MEASURED 2026-09-04, and it is the third reading of this one field — the first two
 * were both wrong, in opposite directions, so it is pinned here rather than described
 * in a comment:
 *
 *   1. "Stripe publishes no documented per-debit cap field on this object" — no amount
 *      was read at all, so `mandate_max_amount_minor` was NULL on every Stripe
 *      instrument and `mandateRefusal` / the portal's per-charge line / the
 *      re-authorisation gate never fired.
 *   2. "`multi_use.amount` is exactly that field" — corrected to the wrong place. For a
 *      CARD rail Stripe populates neither `multi_use` nor `payment_method_details.card`,
 *      so the column stayed NULL and the symptom survived its own fix.
 *   3. The intent that MINTED the mandate is the only place Stripe reports what it
 *      registered. `indiaCardMandateOptions` asked for exactly this experiment before
 *      trusting the ceiling in production; the fixtures below are the real payloads it
 *      produced (India `tok_in` card vaulted through the buyer portal, e-mandate
 *      authorised in a real browser, then `mandates.retrieve`).
 */
describe("describeStripeMandate — India card ceiling", () => {
  // Verbatim from mandates.retrieve on a completed India card e-mandate.
  const REAL_INDIA_CARD_MANDATE = {
    id: "mandate_1XXXXXXXXXXXXXXXXXXXXXX1",
    object: "mandate",
    livemode: false,
    status: "active",
    type: "multi_use",
    multi_use: {},
    payment_method: "pm_1XXXXXXXXXXXXXXXXXXXXXX1",
    payment_method_details: { card: {}, type: "card" },
  } as unknown as Parameters<typeof describeStripeMandate>[0];

  // Verbatim from the SetupIntent that minted it.
  const ECHOED_MANDATE_OPTIONS = {
    amount: 1500000,
    amount_type: "maximum",
    currency: "inr",
    interval: "sporadic",
    supported_types: ["india"],
  };

  it("finds NO ceiling on the mandate object itself — multi_use and card are both empty", () => {
    const m = describeStripeMandate(REAL_INDIA_CARD_MANDATE);
    // The rest of the mandate still maps, which is why the NULL ceiling was invisible:
    // the instrument looked like a fully-described mandate.
    expect(m?.rail).toBe("card");
    expect(m?.status).toBe("confirmed");
    expect(m?.maxAmountMinor).toBeUndefined();
  });

  it("recovers the ceiling from the intent Stripe echoed it on", () => {
    const m = describeStripeMandate(REAL_INDIA_CARD_MANDATE, ECHOED_MANDATE_OPTIONS);
    expect(m?.maxAmountMinor).toBe(1500000n);
    expect(m?.currency).toBe("INR");
    expect(m?.rail).toBe("card");
    expect(m?.status).toBe("confirmed");
  });

  it("still prefers the mandate object when a future API version does populate it", () => {
    // Ordering matters: the intent is the fallback, not the override. If Stripe starts
    // reporting the registered ceiling on the Mandate, that is the more authoritative
    // reading and must win — otherwise a later divergence between the two would be
    // resolved silently in favour of the older source.
    const populated = {
      ...(REAL_INDIA_CARD_MANDATE as unknown as Record<string, unknown>),
      multi_use: { amount: 999_00, currency: "inr" },
    } as unknown as Parameters<typeof describeStripeMandate>[0];
    const m = describeStripeMandate(populated, ECHOED_MANDATE_OPTIONS);
    expect(m?.maxAmountMinor).toBe(99900n);
  });

  it("reports no mandate for a plain card-on-file, with or without an intent", () => {
    expect(describeStripeMandate(null)).toBeUndefined();
    expect(describeStripeMandate(undefined, ECHOED_MANDATE_OPTIONS)).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import {
  AWAITING_AUTHENTICATION_CODE,
  AUTHENTICATION_NOT_REQUIRED_CODE,
  debitAwaitsBuyerAuthentication,
  debitNeedsBuyerAuthentication,
  INR_AFA_FREE_CEILING_MINOR,
} from "@/modules/payment-methods/mandate-afa";

/**
 * WE ONLY CLAIM A BUYER MUST AUTHENTICATE WHEN WE KNOW IT.
 *
 * Replaces `authentication-probe-gateway-gate` and `authentication-wait-observed`, which
 * pinned an inference removed on 2026-09-12: the sweep used to stamp
 * `AWAITING_AUTHENTICATION_CODE` on any card/UPI debit a gateway still reported unsettled
 * after 15 minutes, reasoning that RazorPay fails an ordinary payment at 10.
 *
 * RazorPay's Late Authorisation page disproves the premise — after that timeout they poll
 * the bank for THREE DAYS and may authorise retroactively — and INV-100002 showed the cost:
 * a payment sat in `created` for 36 hours at ₹6,205.62 and failed
 * `insufficient_funds`. The inference would have told that buyer their bank was waiting on
 * them. RazorPay publishes nothing that separates the two in flight: one `created` status,
 * no field, no `payment.pending` webhook, and "Amount yet to be authenticated by the bank"
 * is dashboard copy over that same status.
 *
 * So there are exactly two grounds left, and this suite pins both.
 */
const CARD = { mandateRail: "card", type: "card" };
const UPI = { mandateRail: "upi", type: "upi" };
const BELOW = INR_AFA_FREE_CEILING_MINOR - 1n;
const ABOVE = INR_AFA_FREE_CEILING_MINOR + 1n;

describe("authentication is stated by the gateway, or ruled by the amount — never inferred", () => {
  it("GROUND 1 — above the AFA-free ceiling, RBI makes it compulsory", () => {
    // A rule, not a guess: this is the one thing we may assert without the gateway.
    for (const pm of [CARD, UPI])
      expect(debitNeedsBuyerAuthentication(pm, "INR", ABOVE), pm.mandateRail).toBe(true);
  });

  it("GROUND 2 — a gateway STATEMENT wins at any amount", () => {
    // ₹885 on INV-100001 is why: the issuer asked far below the ceiling.
    expect(
      debitAwaitsBuyerAuthentication(
        { errorCode: AWAITING_AUTHENTICATION_CODE },
        CARD,
        "INR",
        BELOW,
      ),
    ).toBe(true);
  });

  it("and its own later NO is a statement too", () => {
    expect(
      debitAwaitsBuyerAuthentication(
        { errorCode: AUTHENTICATION_NOT_REQUIRED_CODE },
        CARD,
        "INR",
        ABOVE,
      ),
    ).toBe(false);
  });

  it("SILENCE IS NOT A GROUND — below the ceiling with no statement we say nothing", () => {
    // The removed probe's exact case, and the one that mislabelled INV-100002's first
    // attempt. No rail, and no amount of waiting, may turn this into a yes.
    for (const pm of [CARD, UPI])
      expect(
        debitAwaitsBuyerAuthentication({ errorCode: null }, pm, "INR", BELOW),
        pm.mandateRail,
      ).toBe(false);
  });

  it("a rail that authenticates once at registration is never claimed either", () => {
    // Netbanking e-mandate: measured to renew unattended above the ceiling.
    expect(
      debitAwaitsBuyerAuthentication(
        { errorCode: null },
        { mandateRail: "emandate", type: "bank_account" },
        "INR",
        ABOVE,
      ),
    ).toBe(false);
  });
});

/**
 * RBI'S RULES BIND CARDS ISSUED IN INDIA, NOT DEBITS PRICED IN RUPEES.
 *
 * Until 2026-09-12 the prediction read the debit's CURRENCY, which is only a proxy for
 * the issuer's country — `mandate-afa.ts` said so in prose while the code relied on it.
 * An international card billed in INR was told its bank would ask it to authenticate,
 * under a regulation that does not govern it. Migration 0250 adds the column; both
 * gateways were already reporting the fact and we discarded it.
 */
describe("the AFA claim needs an Indian issuer, not an Indian currency", () => {
  const ABOVE_CEILING = INR_AFA_FREE_CEILING_MINOR + 1n;

  it("still claims it for a card the gateway says is Indian", () => {
    expect(
      debitNeedsBuyerAuthentication({ ...CARD, issuerCountry: "IN" }, "INR", ABOVE_CEILING),
    ).toBe(true);
  });

  it("stops claiming it for a card the gateway says is foreign", () => {
    for (const country of ["US", "GB", "SG", "ae"])
      expect(
        debitNeedsBuyerAuthentication({ ...CARD, issuerCountry: country }, "INR", ABOVE_CEILING),
        country,
      ).toBe(false);
  });

  it("UNKNOWN keeps the previous answer — silence is not 'foreign'", () => {
    // Every row vaulted before the column existed is null, and RazorPay and PayPal
    // report nothing here today. Reading that as foreign would switch the warning off
    // for the entire Indian book at a stroke.
    for (const issuerCountry of [null, undefined, ""])
      expect(
        debitNeedsBuyerAuthentication({ ...CARD, issuerCountry }, "INR", ABOVE_CEILING),
        String(issuerCountry),
      ).toBe(true);
  });

  it("cannot resurrect a claim the amount rule already refused", () => {
    // The issuer gate only ever SUPPRESSES. Below the ceiling an Indian card is still
    // not claimed, because there the issuer decides and we have no statement.
    expect(
      debitNeedsBuyerAuthentication(
        { ...CARD, issuerCountry: "IN" },
        "INR",
        INR_AFA_FREE_CEILING_MINOR - 1n,
      ),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { savedPayKind, savedPayOption } from "@/modules/customer-portal/pay-options";
import type { Pm } from "@/modules/invoicing/collection";

const pm = (over: Partial<Pm>): Pm =>
  ({
    publicId: "pm_XXXXXXXXXXXX01",
    providerKey: "stripe",
    type: "card",
    brand: "visa",
    last4: "4242",
    expMonth: 8,
    expYear: 2030,
    status: "valid",
    role: "primary",
    mandateMaxAmountMinor: null,
    mandateCurrency: null,
    mandateRail: null,
    issuerCountry: null,
    ...over,
  }) as Pm;

const NOW = new Date("2026-11-18T12:00:00Z");

describe("savedPayKind", () => {
  it("charges now only where the adapter uses the stored instrument on-session", () => {
    for (const k of [
      "stripe",
      "braintree",
      "adyen",
      "checkoutcom",
      "square",
      "authorizenet",
      "paypal",
    ])
      expect(savedPayKind(k)).toBe("now");
    for (const k of ["razorpay", "cashfree", "payu", "gocardless", "mollie"])
      expect(savedPayKind(k)).toBe("debit");
    // Not yet connectable, so not proven: never offered in step 1.
    expect(savedPayKind("cybersource")).toBeNull();
  });
});

describe("savedPayOption", () => {
  it("offers a working card to pay now", () => {
    expect(savedPayOption(pm({}), 4900n, "USD", NOW)).toMatchObject({
      kind: "now",
      available: true,
      reason: null,
    });
  });

  it("refuses an expired card with its date, by the printed month", () => {
    const o = savedPayOption(pm({ expMonth: 9, expYear: 2026 }), 4900n, "USD", NOW);
    expect(o).toMatchObject({ available: false });
    expect(o?.reason).toBe("This card expired at the end of 09/26. You cannot pay with it.");
    expect(savedPayOption(pm({ expMonth: 11, expYear: 2026 }), 4900n, "USD", NOW)?.available).toBe(
      true,
    );
  });

  it("labels an India mandate debit as taken in about 1 day", () => {
    const o = savedPayOption(
      pm({
        providerKey: "razorpay",
        type: "upi",
        mandateRail: "upi",
        mandateMaxAmountMinor: 500000n,
        mandateCurrency: "INR",
      }),
      199900n,
      "INR",
      NOW,
    );
    expect(o).toMatchObject({ kind: "debit", available: true });
    expect(o?.hint).toMatch(/^Taken in about 1 day\./);
  });

  it("refuses a mandate debit above its ceiling, and a card or UPI debit above ₹15,000", () => {
    const capped = savedPayOption(
      pm({
        providerKey: "razorpay",
        mandateRail: "card",
        mandateMaxAmountMinor: 1500000n,
        mandateCurrency: "INR",
      }),
      1849900n,
      "INR",
      NOW,
    );
    expect(capped?.available).toBe(false);
    expect(capped?.reason).toMatch(/auto-debit limit/);
    const afa = savedPayOption(
      pm({
        providerKey: "razorpay",
        mandateRail: "upi",
        type: "upi",
        mandateMaxAmountMinor: 10000000n,
        mandateCurrency: "INR",
      }),
      1849900n,
      "INR",
      NOW,
    );
    expect(afa?.available).toBe(false);
    expect(afa?.reason).toMatch(/approve each automatic payment/);
  });

  it("keeps a netbanking e-mandate payable above ₹15,000", () => {
    const o = savedPayOption(
      pm({
        providerKey: "razorpay",
        type: "emandate",
        mandateRail: "emandate",
        mandateMaxAmountMinor: 10000000n,
        mandateCurrency: "INR",
      }),
      1849900n,
      "INR",
      NOW,
    );
    expect(o?.available).toBe(true);
  });

  it("never offers a gateway whose saved method cannot pay in step 1", () => {
    expect(savedPayOption(pm({ providerKey: "cybersource" }), 4900n, "USD", NOW)).toBeNull();
  });
});

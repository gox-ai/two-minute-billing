import { describe, it, expect } from "vitest";
import { uniqueAddresses } from "@/modules/emails/contact-copies";
import { EMAIL_AUDIENCE } from "@/modules/emails/config";

describe("contact copies", () => {
  it("de-duplicates case-insensitively and drops excluded addresses", () => {
    expect(
      uniqueAddresses(["A@x.com", "a@x.com", " b@x.com ", "", "to@x.com"], ["TO@x.com"]),
    ).toEqual(["A@x.com", "b@x.com"]);
  });

  it("money mail goes to billing contacts, lifecycle mail to account contacts", () => {
    expect(EMAIL_AUDIENCE.invoice_issued).toBe("billing");
    expect(EMAIL_AUDIENCE.payment_failed).toBe("billing");
    expect(EMAIL_AUDIENCE.card_expiring).toBe("billing");
    expect(EMAIL_AUDIENCE.trial_ending).toBe("account");
    expect(EMAIL_AUDIENCE.subscription_canceled).toBe("account");
  });
});

describe("mandate rail wording", () => {
  it("reads as the payer knows it, never as a code", async () => {
    const { railLabel } = await import("@/modules/emails/outbox");
    expect(railLabel("upi")).toBe("UPI Autopay");
    expect(railLabel("emandate")).toBe("bank account");
    expect(railLabel("card")).toBe("card");
    expect(railLabel("something_new")).toBe("something_new");
    expect(railLabel(null)).toBe("");
  }, 30_000); // cold dynamic import of emails/outbox takes ~5s on its own; the default is 5s
});

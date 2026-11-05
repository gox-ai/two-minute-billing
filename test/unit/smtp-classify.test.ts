import { describe, it, expect } from "vitest";
import { classifySmtpError } from "@/providers/mailer/smtp";

/**
 * The two 5xx families have to be told apart, because `permanent` decides whether the
 * outbox marks a row `bounced` — and `bounced` means "the relay refused THIS ADDRESS,
 * fix the customer's data".
 *
 * An unverified From domain is a 5xx that says nothing about the customer. Filing it as a
 * bounce blamed every recipient of a correctly-addressed email and discarded the queue the
 * moment a merchant saved a From address their relay had not verified.
 *
 * The shapes below are MEASURED against a real relay, not invented: Resend answers the
 * From-domain case at DATA with `EMESSAGE` and no rejected recipients.
 */
describe("classifySmtpError: a sender problem is not a recipient bounce", () => {
  it("an unverified From domain is retriable, not a bounce", () => {
    const e = classifySmtpError({
      responseCode: 550,
      code: "EMESSAGE",
      command: "DATA",
      message: "Message failed: 550 This API key is not authorized to send emails from example.com",
    });
    expect(e.permanent, "a From-domain refusal must not bounce the recipient").toBe(false);
    expect(e.code).toBe(550);
    // The relay's own words survive, so the log says WHY without anyone guessing.
    expect(e.message).toContain("not authorized to send emails from example.com");
  });

  it("a refused RECIPIENT is still a permanent bounce", () => {
    // The case `bounced` exists for: nodemailer lists the address it could not deliver to.
    const e = classifySmtpError({
      responseCode: 550,
      code: "EENVELOPE",
      command: "RCPT TO",
      message: "550 5.1.1 no such mailbox",
      rejected: ["nobody@example.test"],
    });
    expect(e.permanent, "a real bounce must stay terminal").toBe(true);
  });

  it("any other message-level 5xx is retriable too", () => {
    // Message too large, content refused — still not the buyer's mailbox being wrong.
    const e = classifySmtpError({
      responseCode: 552,
      code: "EMESSAGE",
      message: "552 message too large",
    });
    expect(e.permanent).toBe(false);
  });

  it("bad credentials stay transient (the existing rule, unchanged)", () => {
    const e = classifySmtpError({ responseCode: 535, code: "EAUTH", message: "535 auth failed" });
    expect(e.permanent).toBe(false);
  });

  it("a 4xx is transient, with or without a rejected recipient", () => {
    expect(classifySmtpError({ responseCode: 451, message: "451 try later" }).permanent).toBe(
      false,
    );
    expect(
      classifySmtpError({
        responseCode: 450,
        message: "450 greylisted",
        rejected: ["a@b.test"],
      }).permanent,
    ).toBe(false);
  });

  it("an unknown failure is transient — the safe default", () => {
    // Losing mail to an unrecognised error is worse than retrying one that cannot succeed.
    expect(classifySmtpError(new Error("socket hang up")).permanent).toBe(false);
  });
});

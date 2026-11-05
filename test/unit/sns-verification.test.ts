/**
 * SNS message verification — the only thing standing between a public URL and a forged
 * bounce.
 *
 * `/v1/email_webhooks/ses` is unauthenticated by design: AWS posts to it with no shared
 * secret. So a break here is not "a webhook is wrong", it is anyone on the internet being
 * able to mark a real customer's address permanently undeliverable and suppress every future
 * invoice to them.
 *
 * Signed with a REAL generated RSA key rather than a stubbed verifier, so these exercise
 * node's actual crypto and the actual canonical string. A mocked verify would pass whether
 * or not the string we sign matches the string AWS signs.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import {
  verifySnsMessage,
  canonicalStringToSign,
  isTrustedSigningCertUrl,
  parseSesFeedback,
  SnsVerificationError,
  type SnsEnvelope,
} from "@/modules/emails/sns";

let privateKey: KeyObject;
let publicKey: KeyObject;

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
});

const BASE: SnsEnvelope = {
  Type: "Notification",
  MessageId: "11111111-2222-3333-4444-555555555555",
  TopicArn: "arn:aws:sns:us-east-1:844767323535:ses-feedback",
  Message: '{"notificationType":"Bounce"}',
  Timestamp: "2026-08-29T12:00:00.000Z",
  SignatureVersion: "1",
  Signature: "",
  SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem",
};

function sign(msg: SnsEnvelope, algorithm = "RSA-SHA1"): SnsEnvelope {
  const signer = createSign(algorithm);
  signer.update(canonicalStringToSign(msg), "utf8");
  return { ...msg, Signature: signer.sign(privateKey, "base64") };
}

const fetchKey = async () => publicKey;

describe("SNS signing-certificate URL allowlist", () => {
  it("accepts a genuine AWS certificate host", () => {
    expect(
      isTrustedSigningCertUrl(
        "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-a.pem",
      ),
    ).toBe(true);
    expect(isTrustedSigningCertUrl("https://sns.ap-south-1.amazonaws.com/x.pem")).toBe(true);
    // The China partitions are legitimate AWS.
    expect(isTrustedSigningCertUrl("https://sns.cn-north-1.amazonaws.com.cn/x.pem")).toBe(true);
  });

  it("rejects a look-alike host", () => {
    // THE attack this check exists for: the envelope names its own signing certificate, so
    // an attacker who could point it at a host they control would sign their forgery with
    // their own key and we would verify it happily. Both ends must be anchored.
    expect(isTrustedSigningCertUrl("https://sns.us-east-1.amazonaws.com.evil.test/x.pem")).toBe(
      false,
    );
    expect(isTrustedSigningCertUrl("https://evilsns.us-east-1.amazonaws.com/x.pem")).toBe(false);
    expect(isTrustedSigningCertUrl("https://amazonaws.com/x.pem")).toBe(false);
    expect(isTrustedSigningCertUrl("https://sns.us-east-1.amazonaws.com.attacker.io/x.pem")).toBe(
      false,
    );
  });

  it("rejects plain HTTP and rubbish", () => {
    expect(isTrustedSigningCertUrl("http://sns.us-east-1.amazonaws.com/x.pem")).toBe(false);
    expect(isTrustedSigningCertUrl("not a url")).toBe(false);
    expect(isTrustedSigningCertUrl(undefined)).toBe(false);
  });
});

describe("the canonical string is what AWS signs", () => {
  it("emits Key\\nValue\\n for each signed field, in AWS's order", () => {
    const s = canonicalStringToSign({ ...BASE, Subject: "hi" });
    expect(s).toBe(
      "Message\n" +
        BASE.Message +
        "\n" +
        "MessageId\n" +
        BASE.MessageId +
        "\n" +
        "Subject\nhi\n" +
        "Timestamp\n" +
        BASE.Timestamp +
        "\n" +
        "TopicArn\n" +
        BASE.TopicArn +
        "\n" +
        "Type\nNotification\n",
    );
  });

  it("omits an absent Subject rather than signing it empty", () => {
    // Most SES notifications carry no Subject. Including it as an empty value would break
    // verification for every one of them.
    expect(canonicalStringToSign(BASE)).not.toContain("Subject");
  });

  it("uses the subscription field set for a SubscriptionConfirmation", () => {
    const s = canonicalStringToSign({
      ...BASE,
      Type: "SubscriptionConfirmation",
      Token: "tok",
      SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription",
    });
    expect(s).toContain("SubscribeURL\n");
    expect(s).toContain("Token\ntok\n");
  });
});

describe("verifySnsMessage", () => {
  it("accepts a correctly signed message", async () => {
    await expect(verifySnsMessage(sign(BASE), { fetchKey })).resolves.toBeUndefined();
  });

  it("accepts SignatureVersion 2 (SHA256)", async () => {
    const msg = sign({ ...BASE, SignatureVersion: "2" }, "RSA-SHA256");
    await expect(verifySnsMessage(msg, { fetchKey })).resolves.toBeUndefined();
  });

  it("REJECTS a tampered message", async () => {
    // The forgery this endpoint must refuse: a valid signature over different content.
    const signed = sign(BASE);
    const tampered = { ...signed, Message: '{"notificationType":"Complaint"}' };
    await expect(verifySnsMessage(tampered, { fetchKey })).rejects.toThrow(SnsVerificationError);
  });

  it("REJECTS a message signed with the wrong key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const signer = createSign("RSA-SHA1");
    signer.update(canonicalStringToSign(BASE), "utf8");
    const forged = { ...BASE, Signature: signer.sign(other.privateKey, "base64") };
    await expect(verifySnsMessage(forged, { fetchKey })).rejects.toThrow(/does not match/);
  });

  it("REJECTS an untrusted certificate URL before fetching anything", async () => {
    const msg = sign({ ...BASE, SigningCertURL: "https://evil.test/x.pem" });
    await expect(
      verifySnsMessage(msg, {
        fetchKey: async () => {
          throw new Error("must not fetch from an untrusted host");
        },
      }),
    ).rejects.toThrow(/Untrusted SNS signing certificate URL/);
  });

  it("REJECTS an unknown SignatureVersion rather than defaulting", async () => {
    // Defaulting an unrecognised version to SHA1 is how a downgrade gets accepted.
    const msg = sign({ ...BASE, SignatureVersion: "9" });
    await expect(verifySnsMessage(msg, { fetchKey })).rejects.toThrow(
      /Unsupported SNS SignatureVersion/,
    );
  });

  it("REJECTS a message with no signature at all", async () => {
    await expect(verifySnsMessage({ ...BASE, Signature: "" }, { fetchKey })).rejects.toThrow();
  });
});

describe("parseSesFeedback", () => {
  const mail = { messageId: "0100-abc" };

  it("suppresses on a PERMANENT bounce", () => {
    const fb = parseSesFeedback(
      JSON.stringify({
        notificationType: "Bounce",
        mail,
        bounce: {
          bounceType: "Permanent",
          bounceSubType: "NoEmail",
          bouncedRecipients: [{ emailAddress: "dead@example.com" }],
        },
      }),
    );
    expect(fb?.kind).toBe("bounce");
    expect(fb?.suppress).toBe(true);
    expect(fb?.bounceType).toBe("permanent");
    expect(fb?.recipients).toEqual(["dead@example.com"]);
    expect(fb?.providerMessageId).toBe("0100-abc");
  });

  it("does NOT suppress on a transient bounce", () => {
    // A full mailbox or a greylist. Suppressing here would stop mailing a working address
    // for ever over a temporary condition.
    const fb = parseSesFeedback(
      JSON.stringify({
        notificationType: "Bounce",
        mail,
        bounce: { bounceType: "Transient", bounceSubType: "MailboxFull", bouncedRecipients: [] },
      }),
    );
    expect(fb?.suppress).toBe(false);
    expect(fb?.bounceType).toBe("transient");
  });

  it("suppresses on a complaint", () => {
    const fb = parseSesFeedback(
      JSON.stringify({
        notificationType: "Complaint",
        mail,
        complaint: {
          complainedRecipients: [{ emailAddress: "annoyed@example.com" }],
          complaintFeedbackType: "abuse",
        },
      }),
    );
    expect(fb?.suppress).toBe(true);
    expect(fb?.bounceType).toBe("complaint");
    expect(fb?.detail).toBe("abuse");
  });

  it("reads the configuration-set shape too (`eventType`)", () => {
    // The same AWS account emits BOTH: an identity's SNS destination sends
    // `notificationType`, a configuration-set event destination sends `eventType`. A parser
    // that knew only one would silently ignore half the feedback.
    const fb = parseSesFeedback(
      JSON.stringify({
        eventType: "Bounce",
        mail,
        bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "x@y.test" }] },
      }),
    );
    expect(fb?.kind).toBe("bounce");
    expect(fb?.suppress).toBe(true);
  });

  it("ignores events that are not delivery feedback", () => {
    expect(parseSesFeedback(JSON.stringify({ eventType: "Open", mail }))).toBeNull();
    expect(parseSesFeedback(JSON.stringify({ eventType: "Click", mail }))).toBeNull();
    expect(parseSesFeedback("not json")).toBeNull();
  });

  it("treats a delivery notification as informational only", () => {
    const fb = parseSesFeedback(JSON.stringify({ notificationType: "Delivery", mail }));
    expect(fb?.kind).toBe("delivery");
    expect(fb?.suppress).toBe(false);
  });
});

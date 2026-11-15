import { afterEach, describe, expect, it } from "vitest";
import { config } from "@/platform/config";
import { redactSecrets } from "@/modules/assistant/leaks";
import {
  cleanText,
  draftItems,
  failureIsOurs,
  keptItems,
} from "@/modules/assistant/support-context";
import { ToolError } from "@/modules/assistant-tools/catalog";
import { SUPPORT_SIGNATURE, serializeForMember, supportOffered } from "@/modules/assistant/support";
import { supportChatText, supportRequestLink } from "@/modules/assistant/support-notify";
import { systemPrompt } from "@/modules/assistant/prompt";

const saved = {
  TMBILLING_EDITION: config.TMBILLING_EDITION,
  BACKOFFICE_PUBLIC_URL: config.BACKOFFICE_PUBLIC_URL,
};
afterEach(() => Object.assign(config, saved));

describe("support request text: the secret guard", () => {
  it("removes keys, tokens, passwords and card numbers", () => {
    const text = [
      "Our key sk_live_AbCdEf1234567890 stopped working.",
      "Header: Bearer abcdefgh12345678.xyz",
      "password: hunter2hunter2",
      "webhook whsec_abcdefghijklmnop",
      "card 4242 4242 4242 4242 failed",
      "session tmb_session=abc123def456",
    ].join("\n");
    const r = redactSecrets(text);
    expect(r.text).not.toMatch(
      /sk_live_AbCd|abcdefgh12345678|hunter2|whsec_abcdef|4242 4242|abc123def456/,
    );
    expect(r.text).toContain("****4242");
    expect(r.text).toContain("password: [removed]");
    expect(r.removed).toBeGreaterThanOrEqual(6);
  });

  it("keeps ordinary text, ids and invoice numbers", () => {
    const text = "Renewal for sub_XXXXXXXXXXXX01 failed. Invoice INV-0042, 1234567890123 units.";
    expect(redactSecrets(text).text).toBe(text);
  });

  it("cleans the member's subject and description, and errors on the card", () => {
    expect(cleanText("  use sk_test_ZZZZZZZZZZZZ please  ", 200)).toBe("use [removed] please");
    const items = draftItems({
      page: {
        path: "/businesses/biz_1/subscriptions/sub_XXXXXXXXXXXX01?tab=x",
        screen: "Subscription",
      },
      records: ["sub_XXXXXXXXXXXX01", "sub_XXXXXXXXXXXX01", "not_a_record", "inv_XXXXXXXXXXXX02"],
      failures: [{ what: "Read API", error: "401 with Bearer abcdefghijklmnop" }],
      conversationId: "acv_1",
      browser: "Chrome on macOS",
    });
    expect(items.map((i) => i.key)).toEqual([
      "page",
      "record:sub_XXXXXXXXXXXX01",
      "record:inv_XXXXXXXXXXXX02",
      "error:0",
      "conversation",
      "browser",
    ]);
    expect(items[0]!.value).toBe("/businesses/biz_1/subscriptions/sub_XXXXXXXXXXXX01");
    expect(JSON.stringify(items)).not.toContain("abcdefghijklmnop");
    expect(keptItems(items, ["conversation", "browser"]).map((i) => i.kind)).not.toContain(
      "conversation",
    );
  });
});

describe("support requests are Cloud only", () => {
  it("is offered on Cloud and never self-hosted", () => {
    Object.assign(config, { TMBILLING_EDITION: "self_hosted" });
    expect(supportOffered()).toBe(false);
    Object.assign(config, { TMBILLING_EDITION: "cloud" });
    expect(supportOffered()).toBe(true);
  });

  it("the instructions mention the handoff only when it is offered", () => {
    const base = {
      business: {
        id: "biz_1",
        name: "B",
        livemode: "test" as const,
        currency: "USD",
        timezone: null,
      },
      memberName: null,
      today: "2026-11-09",
      page: null,
    };
    expect(systemPrompt({ ...base, support: false })).not.toContain("propose_support_request");
    const on = systemPrompt({ ...base, support: true });
    expect(on).toContain("propose_support_request");
    expect(on).toMatch(/Never promise a refund, a credit, a fix or a date/);
    expect(on).toMatch(/Never say a person saw the request/);
  });
});

describe("what the member's browser receives", () => {
  it("signs staff replies as support, never a person, and hides attached values", () => {
    const now = new Date();
    const view = serializeForMember(
      {
        id: "u",
        publicId: "sr_1",
        number: 1042,
        organizationId: "o",
        businessId: "b",
        userId: "m",
        conversationId: null,
        subject: "S",
        status: "waiting",
        context: [{ key: "browser", kind: "browser", label: "Browser: Chrome", value: "Chrome" }],
        idempotencyKey: "k",
        lastMemberReplyAt: now,
        lastStaffReplyAt: now,
        memberUnreadAt: now,
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
        resourceVersion: 1,
      },
      "biz_1",
      [
        {
          id: "x",
          publicId: "srm_1",
          organizationId: "o",
          requestId: "u",
          authorKind: "staff",
          body: "Retry the invoice.",
          attachments: null,
          staffBy: "agent@example.com",
          notifiedAt: now,
          createdAt: now,
        },
      ],
    );
    expect(view.reference).toBe("SR-1042");
    expect(view.unread).toBe(true);
    expect(view.messages![0]!.author).toBe("support");
    expect(view.messages![0]!.author_name).toBe(SUPPORT_SIGNATURE);
    expect(JSON.stringify(view)).not.toContain("agent@example.com");
    expect(view.context[0]).toEqual({ key: "browser", kind: "browser", label: "Browser: Chrome" });
  });
});

describe("which failed calls go on the support card", () => {
  it("never the assistant's own refused read or bad argument", () => {
    expect(failureIsOurs({ toolError: true, status: 404 })).toBe(false);
    expect(failureIsOurs({ toolError: true, status: 400 })).toBe(false);
    expect(failureIsOurs({ toolError: true })).toBe(false);
  });
  it("a failure on our side, or one that is not a refusal", () => {
    expect(failureIsOurs({ toolError: true, status: 502 })).toBe(true);
    expect(failureIsOurs({ toolError: false })).toBe(true);
  });
  it("a refused read keeps the route's status", () => {
    expect(new ToolError("We could not read it.", 404).status).toBe(404);
  });
});

describe("the support chat post", () => {
  it("carries organization, subject and the link, and nothing else", () => {
    const text = supportChatText({
      kind: "new",
      reference: "SR-1042",
      organization: "Larkfield Billing",
      subject: "Renewal failed for buyer@example.com",
      link: "https://backoffice.example.com/support/sr_1",
    });
    expect(text).toBe(
      "🆘 New support request SR-1042 · Larkfield Billing\nRenewal failed for [email]\n" +
        "https://backoffice.example.com/support/sr_1",
    );
  });

  it("has no field for the plan, the description or a reply body", () => {
    // The signature is the guard: the post cannot be handed what it must not show.
    const keys = ["kind", "reference", "organization", "subject", "link"];
    const text = supportChatText(
      Object.fromEntries(keys.map((k) => [k, k === "kind" ? "reply" : k])) as never,
    );
    expect(text).toBe("💬 Reply on reference · organization\nsubject\nlink");
  });

  it("links to the back-office request, and has no link line without its address", () => {
    Object.assign(config, { BACKOFFICE_PUBLIC_URL: "https://backoffice.example.com/" });
    expect(supportRequestLink("sr_1")).toBe("https://backoffice.example.com/support/sr_1");
    Object.assign(config, { BACKOFFICE_PUBLIC_URL: undefined });
    const link = supportRequestLink("sr_1");
    expect(link).toBeNull();
    const text = supportChatText({
      kind: "reply",
      reference: "SR-1",
      organization: "Org",
      subject: "S",
      link,
    });
    expect(text.split("\n")).toEqual(["💬 Reply on SR-1 · Org", "S"]);
  });
});

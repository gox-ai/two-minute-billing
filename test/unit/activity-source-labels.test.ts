import { describe, expect, it } from "vitest";
import { eventSentence, sourcePhrase } from "../../dashboard/lib/labels";
import { sourceByPhrase, sourceLabel } from "../../dashboard/components/audit/labels";
import {
  currentChannel,
  initialContextFor,
  runWithEventContext,
  type EventSource,
} from "../../src/platform/event-context";

describe("activity log source phrases", () => {
  it.each([
    ["api", null, "through the API"],
    ["dashboard", null, "in the dashboard"],
    ["portal", "psess_x", "in the customer portal"],
    ["checkout", "cosess_x", "in checkout"],
    ["webhook", "stripe", "from Stripe"],
    ["webhook", "razorpay", "from Razorpay"],
    ["webhook", "ses", "from Amazon SES"],
    ["webhook", "unknown_gw", "from a gateway notification"],
    ["webhook", null, "from a gateway notification"],
    ["mcp", "key_x", "through an AI agent (MCP)"],
    ["scheduled_job", "billing_clock", "by the billing clock"],
  ])("%s / %s", (source, actor, phrase) => {
    expect(sourceByPhrase(source, actor)).toBe(phrase);
    expect(sourcePhrase(source, actor)).toBe(phrase);
  });

  it("names the new sources in lists", () => {
    expect(sourceLabel("portal")).toBe("Customer portal");
    expect(sourceLabel("checkout")).toBe("Checkout");
    expect(sourceLabel("webhook")).toBe("Gateway notification");
  });
});

describe("eventSentence", () => {
  it.each([
    ["payment_intent_intent_consumed", "payment_intent", "Payment intent", "consumed."],
    ["payment_intent_intent_authorized", "payment_intent", "Payment intent", "authorized."],
    ["payment_intent_authorized", "payment_intent", "Payment intent", "authorized."],
    ["invoice_payment_due", "invoice", "Invoice", "payment due."],
    ["invoice_paid", "customer", "Invoice", "paid."],
    ["subscription_changed", "subscription", "Subscription", "changed."],
  ])("%s on %s", (type, res, noun, verb) => {
    expect(eventSentence(type, res)).toEqual({ noun, verb });
  });
});

describe("initial event context by route family", () => {
  it.each([
    ["/portal/v1/invoices/inv_1/pay", "portal", null],
    ["/portal/v1/payment_methods?x=1", "portal", null],
    ["/checkout/v1/session", "checkout", null],
    ["/v1/gateway_webhooks/stripe?id=gwa_1", "webhook", "stripe"],
    ["/v1/gateway_webhooks/authorizenet/gwa_1", "webhook", "authorizenet"],
    ["/v1/email_webhooks/ses", "webhook", "ses"],
    ["/v1/customers", "api", null],
  ])("%s", (url, source, actor) => {
    expect(initialContextFor(url)).toEqual({ source, actor });
  });

  it("keeps stored channel values unchanged", () => {
    const channel = (source: EventSource) =>
      runWithEventContext({ source }, () => currentChannel());
    for (const s of ["api", "portal", "checkout", "webhook", "mcp", "hubspot"] as const)
      expect(channel(s)).toBe("api");
    expect(channel("dashboard")).toBe("dashboard");
  });
});

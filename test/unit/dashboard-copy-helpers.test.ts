import { describe, expect, it } from "vitest";
// Relative, not `@/…`: the root `@/` alias points at src/.
import { declineReading, INTENT_STATUS_WORD } from "../../dashboard/lib/decline-reading";
import { providerName } from "../../dashboard/lib/model-providers";
import { planOverdraftChanges, zeroOrMoreMessage } from "../../dashboard/lib/credit-settings";
import { grantStatusKey } from "../../dashboard/lib/credits";
import { runwayMessage } from "@/modules/usage-controls/measure";

describe("declineReading: our reading sits above the gateway's text, never in its place", () => {
  it("reads a code we know", () => {
    // A gateway's own risk block can also say card_declined: we do not name the bank.
    expect(declineReading("card_declined", "Your card was declined.")).toBe("Card declined.");
    expect(declineReading("do_not_honor")).toBe("Card declined by the bank.");
    expect(declineReading("INSUFFICIENT_FUNDS")).toBe("Not enough money in the account.");
  });
  it("gives nothing for a code we do not know: never a guess", () => {
    expect(declineReading("some_new_code", "Declined")).toBeNull();
    expect(declineReading(null, "Declined")).toBeNull();
  });
  it("does not repeat a gateway text that already says it", () => {
    expect(declineReading("expired_card", "Card expired")).toBeNull();
  });
  it("engine status words get plain labels", () => {
    expect(INTENT_STATUS_WORD).toEqual({ inited: "open", consumed: "used" });
  });
});

describe("providerName", () => {
  it("names the providers we know", () => {
    expect(providerName("aws_polly")).toBe("Amazon Polly");
    expect(providerName("black_forest_labs")).toBe("Black Forest Labs");
    expect(providerName("openai")).toBe("OpenAI");
  });
  it("title-cases an id we do not know", () => {
    expect(providerName("north_wind_ai")).toBe("North Wind AI");
    expect(providerName("some-provider")).toBe("Some Provider");
    expect(providerName("")).toBe("");
  });
});

describe("credit messages read correctly for every count", () => {
  it("decimal places: 0, 1 and many", () => {
    expect(zeroOrMoreMessage(0)).toBe("Enter a whole number, 0 or more.");
    expect(zeroOrMoreMessage(1)).toBe("Enter 0 or more, with up to 1 decimal place.");
    expect(zeroOrMoreMessage(3, "a plan limit")).toBe(
      "Enter a plan limit of 0 or more, with up to 3 decimal places.",
    );
    expect(zeroOrMoreMessage(0, "a plan limit")).toBe(
      "Enter a plan limit that is a whole number, 0 or more.",
    );
  });
  it("one status word for a grant", () => {
    expect(grantStatusKey("pending", 5)).toBe("not_started");
    expect(grantStatusKey("active", 0)).toBe("used_up");
    expect(grantStatusKey("active", 5)).toBe("active");
    expect(grantStatusKey("voided", 0)).toBe("voided");
  });
  it("a runway of 0 days is 'Used up' or 'less than a day', never '0 days'", () => {
    expect(runwayMessage(0, true)).toBe("Used up");
    expect(runwayMessage(0, false)).toBe("Runs out in less than a day");
    expect(runwayMessage(1, false)).toBe("Runs out in about 1 day");
    expect(runwayMessage(5, false)).toBe("Runs out in about 5 days");
    expect(runwayMessage(null, false)).toBe("Not enough usage to estimate");
  });
});

describe("plan overdraft limits: a save removes only what the form loaded", () => {
  const stored = [
    { product: "pro", overdraft_limit: 10 },
    { product: "team", overdraft_limit: 20 },
  ];
  it("removes a loaded plan the form dropped", () => {
    expect(
      planOverdraftChanges(stored, [{ product: "team", steps: 20 }], new Set(["pro", "team"]))
        .remove,
    ).toEqual(["pro"]);
  });
  it("keeps a plan added elsewhere after the form loaded", () => {
    expect(planOverdraftChanges(stored, [], new Set(["pro"])).remove).toEqual(["pro"]);
  });
  it("removes nothing when the post has no loaded list", () => {
    expect(planOverdraftChanges(stored, [], new Set()).remove).toEqual([]);
  });
});

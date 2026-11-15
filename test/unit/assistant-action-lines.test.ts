import { describe, expect, it } from "vitest";
import { ACTION_OPS, previewBody, requestLines } from "@/modules/assistant/actions";

/** What the member reads on a line, without the edit control. */
const shown = (ls: Array<{ label: string; value: string; before?: string }>) =>
  ls.map(({ label, value, before }) =>
    before === undefined ? { label, value } : { label, value, before },
  );

describe("requestLines", () => {
  it("says a per-subscription credit cap the way the subscription screen does", () => {
    const lines = (v: number | null) =>
      shown(requestLines({ sub: "sub_1" }, { max_excess_payment_usage_minor: v }, "INR"));
    expect(lines(0)).toContainEqual({ label: "Excess payments", value: "Never auto-apply here" });
    expect(lines(null)).toContainEqual({
      label: "Excess payments",
      value: "Follow the business setting",
    });
    expect(lines(50000)).toContainEqual({
      label: "Excess payments",
      value: "Auto-apply up to ₹500.00 per invoice",
    });
    expect(
      shown(requestLines({}, { max_refundable_credits_usage_minor: 0 }, "INR")),
    ).toContainEqual({
      label: "Refundable credit",
      value: "Never auto-apply here",
    });
  });
  it("formats other amounts in the currency it is given", () => {
    expect(shown(requestLines({}, { amount_minor: 1500 }, "INR"))).toContainEqual({
      label: "Amount",
      value: "₹15.00",
    });
  });
});

describe("previewBody", () => {
  it("sends a preview only the fields its route accepts", () => {
    const sent = previewBody("subscriptions/{sub}/estimate", {
      changes: [{ item: "si_1", price: "price_1" }],
      timing: "now",
      invoice_immediately: true,
      quote: "q",
      change_option: "immediately",
    });
    expect(Object.keys(sent).sort()).toEqual(["change_option", "changes"]);
  });
  it("a subscription change previews with the same timing it books", () => {
    const op = ACTION_OPS["POST subscriptions/{sub}/change"]!;
    expect(op.preview!.body!({ timing: "end_of_term" })).toMatchObject({
      change_option: "end_of_term",
    });
    expect(op.preview!.body!({ timing: "now" })).toMatchObject({ change_option: "immediately" });
  });
});

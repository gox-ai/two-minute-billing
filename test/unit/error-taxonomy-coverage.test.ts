import { describe, expect, it } from "vitest";
import { ALL_DECLINE_RULES, knownDeclineCodesWithoutRules } from "@/providers/decline-codes";
import { ENGINE_BOOKED_CODES, resolveErrorId } from "@/platform/error-taxonomy";

// `gateway.general.unknown` is right for a stranger's vocabulary and wrong for ours.
describe("every code we emit has a family", () => {
  it("every canonical code a rule or table emits resolves directly", () => {
    const emitted = new Set(ALL_DECLINE_RULES.map((r) => r.code));
    for (const k of knownDeclineCodesWithoutRules()) emitted.add(k.code);
    const unknown = [...emitted].filter((c) => !resolveErrorId(c).known);
    expect(unknown).toEqual([]);
  });

  it("every code literal the engine books resolves", () => {
    const unknown = ENGINE_BOOKED_CODES.filter((c) => !resolveErrorId(c).known);
    expect(unknown).toEqual([]);
  });
});

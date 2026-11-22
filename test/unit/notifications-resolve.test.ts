import { describe, expect, it } from "vitest";
import { fixedRolePermissions } from "@/modules/auth/permissions";
import { defaultPreferences, type KindPreference } from "@/modules/notifications/catalogue";
import {
  inQuietHours,
  pickKindsForRecipient,
  quietEnd,
  resolveDestination,
  resolvePreference,
  type ResolveInput,
} from "@/modules/notifications/resolve";

const BIZ = "b-1";
const admin = fixedRolePermissions("admin");
const defaults = { kinds: defaultPreferences("admin") as Record<string, KindPreference> };
const base = (over: Partial<ResolveInput> = {}): ResolveInput => ({
  defaultRow: defaults,
  businessId: BIZ,
  kind: "payment_failed",
  permissions: admin,
  amountMinor: 499900,
  currency: "INR",
  now: new Date("2026-11-16T06:00:00Z"),
  timezone: "Asia/Kolkata",
  ...over,
});

describe("resolvePreference order", () => {
  it("nothing until set up", () => {
    expect(resolvePreference(base({ defaultRow: null }))).toMatchObject({
      timing: "off",
      reason: "not_set_up",
    });
  });

  it("default row applies; a business exception wins over it", () => {
    expect(resolvePreference(base())).toEqual({ timing: "instant", push: true, email: false });
    const ex = { kinds: { payment_failed: { timing: "summary", push: false, email: false } } };
    expect(resolvePreference(base({ businessRow: ex as never }))).toMatchObject({
      timing: "summary",
    });
    expect(
      resolvePreference(base({ businessRow: ex as never, kind: "dispute_opened" })),
    ).toMatchObject({ timing: "instant", email: true });
  });

  it("a kind missing from the default row takes the role default", () => {
    const row = { kinds: {} };
    expect(resolvePreference(base({ defaultRow: row, role: "admin" }))).toMatchObject({
      timing: "instant",
    });
    expect(resolvePreference(base({ defaultRow: row }))).toMatchObject({ timing: "off" });
  });

  it("business filter", () => {
    const filter = { mode: "selected" as const, business_ids: ["b-2"] };
    expect(resolvePreference(base({ filter }))).toMatchObject({ reason: "business_filter" });
    expect(
      resolvePreference(base({ filter: { mode: "selected", business_ids: [BIZ] } })),
    ).toMatchObject({
      timing: "instant",
    });
  });

  it("role permission, checked at send time", () => {
    expect(resolvePreference(base({ permissions: new Set(["invoices:view"]) }))).toMatchObject({
      reason: "permission",
    });
  });

  it("amount limit per currency; a currency with no limit gets every amount", () => {
    const row = {
      kinds: {
        ...defaults.kinds,
        payment_failed: { timing: "instant", push: true, email: false, above: { INR: 1_000_000 } },
      },
    } as never;
    expect(resolvePreference(base({ defaultRow: row }))).toMatchObject({ reason: "below_limit" });
    expect(resolvePreference(base({ defaultRow: row, amountMinor: 1_000_000 }))).toMatchObject({
      timing: "instant",
    });
    expect(
      resolvePreference(base({ defaultRow: row, currency: "USD", amountMinor: 1 })),
    ).toMatchObject({
      timing: "instant",
    });
  });

  it("off stays off; summary has no channels", () => {
    expect(resolvePreference(base({ kind: "trial_ending" }))).toMatchObject({ reason: "off" });
    expect(resolvePreference(base({ kind: "payment_received" }))).toEqual({
      timing: "summary",
      push: false,
      email: false,
    });
  });

  it("a test business makes a bell row only", () => {
    expect(resolvePreference(base({ test: true }))).toEqual({
      timing: "instant",
      push: false,
      email: false,
      reason: "test",
    });
    expect(resolvePreference(base({ test: true, kind: "trial_ending" }))).toMatchObject({
      timing: "off",
    });
  });
});

describe("quiet hours", () => {
  const quiet = { enabled: true, from: 22, to: 7, disputes_through: true };

  it("crosses midnight in the member's timezone", () => {
    // 23:30 in Kolkata.
    const night = new Date("2026-11-16T18:00:00Z");
    expect(inQuietHours(night, "Asia/Kolkata", 22, 7)).toBe(true);
    expect(inQuietHours(new Date("2026-11-16T02:00:00Z"), "Asia/Kolkata", 22, 7)).toBe(false);
    expect(inQuietHours(new Date("2026-11-16T01:00:00Z"), "Asia/Kolkata", 22, 7)).toBe(true);
    const r = resolvePreference(base({ now: night, quiet }));
    expect(r.push).toBe("held");
    expect(r.email).toBe(false);
    // Held until 07:00 Kolkata the next morning.
    expect(r.heldUntil?.toISOString()).toBe("2026-11-17T01:30:00.000Z");
  });

  it("a same-day window and an empty window", () => {
    expect(inQuietHours(new Date("2026-11-16T13:00:00Z"), "UTC", 12, 14)).toBe(true);
    expect(inQuietHours(new Date("2026-11-16T14:00:00Z"), "UTC", 12, 14)).toBe(false);
    expect(inQuietHours(new Date("2026-11-16T13:00:00Z"), "UTC", 5, 5)).toBe(false);
  });

  it("disputes pass when disputes_through is on", () => {
    const night = new Date("2026-11-16T18:00:00Z");
    expect(
      resolvePreference(base({ now: night, quiet, kind: "dispute_opened", isDispute: true })).push,
    ).toBe(true);
    expect(
      resolvePreference(
        base({
          now: night,
          quiet: { ...quiet, disputes_through: false },
          kind: "dispute_opened",
          isDispute: true,
        }),
      ).push,
    ).toBe("held");
  });

  it("ends at local 07:00 across a DST change", () => {
    // New York falls back on 2026-11-01 at 02:00. 23:00 EDT on 31 Oct = 03:00Z on 1 Nov.
    const end = quietEnd(new Date("2026-11-01T03:00:00Z"), "America/New_York", 7);
    expect(end.toISOString()).toBe("2026-11-01T12:00:00.000Z"); // 07:00 EST
    // Springs forward on 2026-03-08. 23:00 EST on 7 Mar = 04:00Z on 8 Mar.
    const spring = quietEnd(new Date("2026-03-08T04:00:00Z"), "America/New_York", 7);
    expect(spring.toISOString()).toBe("2026-03-08T11:00:00.000Z"); // 07:00 EDT
    expect(inQuietHours(new Date("2026-03-08T07:30:00Z"), "America/New_York", 22, 7)).toBe(true);
  });
});

describe("resolveDestination", () => {
  const dest = {
    status: "active",
    businessFilter: { mode: "all" as const },
    kinds: {
      payment_failed: { on: true, above: { INR: 1_000_000 } },
      dispute_opened: { on: true },
    },
  };
  const at = (over: object = {}) =>
    resolveDestination({
      dest,
      kind: "payment_failed",
      amountMinor: 2_000_000,
      currency: "INR",
      businessId: BIZ,
      ...over,
    });

  it("sends when on, in its businesses and above its limit", () => {
    expect(at()).toEqual({ send: true });
    expect(at({ amountMinor: 10 })).toEqual({ send: false, reason: "below_limit" });
    expect(at({ kind: "refund_failed" })).toEqual({ send: false, reason: "off" });
    expect(at({ test: true })).toEqual({ send: false, reason: "test" });
    expect(at({ dest: { ...dest, status: "pending" } })).toEqual({
      send: false,
      reason: "inactive",
    });
    expect(
      at({ dest: { ...dest, businessFilter: { mode: "selected", business_ids: ["x"] } } }),
    ).toEqual({ send: false, reason: "business_filter" });
  });
});

describe("pickKindsForRecipient", () => {
  it("a derived kind replaces its parent only when the recipient gets it", () => {
    const both = ["payment_failed", "possible_fraud"] as const;
    expect(pickKindsForRecipient(both, new Set(both))).toEqual(["possible_fraud"]);
    expect(pickKindsForRecipient(both, new Set(["payment_failed"] as const))).toEqual([
      "payment_failed",
    ]);
    expect(
      pickKindsForRecipient(
        ["subscription_cancelled", "customer_portal_change"],
        new Set(["subscription_cancelled", "customer_portal_change"] as const),
      ),
    ).toEqual(["customer_portal_change"]);
  });
});

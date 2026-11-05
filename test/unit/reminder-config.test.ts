import { describe, it, expect } from "vitest";
import {
  dueLeadDay,
  initialReminderConfig,
  leadAlreadySent,
  mergeReminderConfig,
  normalizeLeadDays,
  resolveReminderConfig,
} from "@/modules/subscriptions/reminder-config";

const DAY = 86_400_000;
const T = new Date("2026-10-01T00:00:00Z");
const at = (days: number) => new Date(T.getTime() + days * DAY);

describe("resolveReminderConfig", () => {
  it.each([[null], [undefined], [{}], [{ reminderConfig: null }], [{ reminderConfig: [1] }]])(
    "no config is today's constants (%j)",
    (biz) => {
      expect(resolveReminderConfig(biz as { reminderConfig?: unknown } | null).leadDays).toEqual({
        trial_ending: [3],
        renewal: [5],
        renewal_yearly: [30],
        cancellation: [5],
      });
    },
  );

  it("sorts largest first, drops duplicates, and rejects bad lists", () => {
    const r = resolveReminderConfig({
      reminderConfig: { renewal: [3, 15, 3], trial_ending: [0], cancellation: [1, 2, 3, 4, 5, 6] },
    });
    expect(r.leadDays.renewal).toEqual([15, 3]);
    expect(r.leadDays.trial_ending).toEqual([3]);
    expect(r.leadDays.cancellation).toEqual([5]);
    expect(normalizeLeadDays([91])).toBeNull();
    expect(normalizeLeadDays([1.5])).toBeNull();
  });
});

describe("mergeReminderConfig", () => {
  it("stamps changed_at only for kinds whose list changed", () => {
    const m = mergeReminderConfig(null, { renewal: [15, 3], cancellation: [5] }, T);
    expect(m).toEqual({
      renewal: [15, 3],
      cancellation: [5],
      changed_at: { renewal: T.toISOString() },
    });
    const again = mergeReminderConfig(m, { renewal: [3, 15] }, at(1));
    expect(again?.changed_at).toEqual({ renewal: T.toISOString() });
  });

  it("keeps kinds the patch leaves out; null resets every kind", () => {
    const m = mergeReminderConfig({ renewal: [15, 3] }, { trial_ending: [7] }, T);
    expect(m?.renewal).toEqual([15, 3]);
    const reset = mergeReminderConfig(m, null, at(1));
    expect(resolveReminderConfig({ reminderConfig: reset }).leadDays.renewal).toEqual([5]);
    expect(reset?.changed_at?.renewal).toBe(at(1).toISOString());
  });
});

describe("dueLeadDay", () => {
  const target = at(30);
  it("only the smallest lead day reached is due", () => {
    expect(dueLeadDay([15, 3], target, at(10))).toBeNull();
    expect(dueLeadDay([15, 3], target, at(16))).toBe(15);
    expect(dueLeadDay([15, 3], target, at(28))).toBe(3);
    expect(dueLeadDay([15, 3], target, at(30))).toBeNull();
  });

  it("does not back-fill a lead day that passed before the list changed", () => {
    const changedAt = at(20); // 10 days out: the 15-day mark is already gone
    expect(dueLeadDay([15, 3], target, at(20), { changedAt, knownSince: at(0) })).toBeNull();
    expect(dueLeadDay([15, 3], target, at(28), { changedAt, knownSince: at(0) })).toBe(3);
  });

  it("a date that became known after the change still gets its reminder", () => {
    expect(dueLeadDay([15, 3], target, at(21), { changedAt: at(20), knownSince: at(21) })).toBe(15);
  });
});

describe("leadAlreadySent", () => {
  it("a reminder at the same or a closer lead day blocks", () => {
    expect(leadAlreadySent([15], 3, 5)).toBe(false);
    expect(leadAlreadySent([15, 3], 3, 5)).toBe(true);
    expect(leadAlreadySent([3], 10, 5)).toBe(true);
  });

  it("an event from before lead days counts at the default", () => {
    expect(leadAlreadySent([null], 5, 5)).toBe(true);
    expect(leadAlreadySent([null], 3, 5)).toBe(false);
  });
});

describe("optional kinds and card expiry", () => {
  it("no config is today's behaviour: off, and the card notice in its expiry month", () => {
    const r = resolveReminderConfig(null);
    expect(r.optional).toEqual({ payment_due: [], pause: [], resume: [] });
    expect(r.cardExpiring).toBe("expiry_month");
  });

  it("[] is Off, more than 3 lead days is invalid", () => {
    const r = resolveReminderConfig({
      reminderConfig: { payment_due: [3, 10], pause: [], resume: [1, 2, 3, 4] },
    });
    expect(r.optional.payment_due).toEqual([10, 3]);
    expect(r.optional.pause).toEqual([]);
    expect(r.optional.resume).toEqual([]);
    expect(
      resolveReminderConfig({ reminderConfig: { card_expiring: [30, 7] } }).cardExpiring,
    ).toEqual([30, 7]);
    expect(resolveReminderConfig({ reminderConfig: { card_expiring: "soon" } }).cardExpiring).toBe(
      "expiry_month",
    );
  });

  it("a merge stamps changed_at for the new kinds and keeps Off", () => {
    const m = mergeReminderConfig(null, { payment_due: [3], card_expiring: [30, 7] }, T);
    expect(m?.payment_due).toEqual([3]);
    expect(m?.card_expiring).toEqual([30, 7]);
    expect(m?.changed_at).toEqual({ payment_due: T.toISOString(), card_expiring: T.toISOString() });
    const off = mergeReminderConfig(m, { payment_due: [], card_expiring: "expiry_month" }, at(1));
    expect(off?.payment_due).toEqual([]);
    expect(off?.card_expiring).toBe("expiry_month");
    expect(off?.changed_at?.payment_due).toBe(at(1).toISOString());
  });

  it("only a person-created business gets the recommended values", () => {
    expect(initialReminderConfig({ hasOperator: false })).toBeUndefined();
    expect(initialReminderConfig({})).toBeUndefined();
    expect(initialReminderConfig({ hasOperator: true })).toEqual({
      card_expiring: [30, 7],
      payment_due: [3],
      pause: [7],
      resume: [7],
    });
  });
});

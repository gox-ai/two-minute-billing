import { describe, it, expect } from "vitest";
import {
  calendarWindowOfShort,
  endAfterWindows,
  isCreditsLink,
  normalizeAllowanceReset,
  normalizeReset,
  foldPauseShifts,
  pauseShiftOf,
  prorateForRest,
  resetKey,
  resetRefusal,
  shiftedWindow,
  splitByWeights,
  windowAt,
  windowsStartingIn,
  type Reset,
  type WindowContext,
} from "@/modules/credits/reset-windows";
import { readResetSettings } from "@/modules/credits/reset-settings";
import { planGrantApplication, scaleSlices, type PlannerGrant } from "@/modules/credits/planner";
import { MONEY_RATE } from "@/modules/credits/units";

const d = (s: string) => new Date(s);
const iso = (w: { start: Date; end: Date | null }) => [
  w.start.toISOString(),
  w.end?.toISOString() ?? null,
];
const ctx = (over: Partial<WindowContext> = {}): WindowContext => ({
  termStart: d("2030-01-31T10:00:00Z"),
  termEnd: d("2031-01-31T10:00:00Z"),
  timeZone: "UTC",
  clockStart: d("2030-01-31T10:00:00Z"),
  ...over,
});
const sub = (every: Reset["every"], count = 1): Reset => ({ every, count, anchor: "subscription" });
const cal = (every: Reset["every"], count = 1): Reset => ({ every, count, anchor: "calendar" });

describe("reset shape", () => {
  it("normalizes defaults and refuses bad shapes", () => {
    expect(normalizeReset(null)).toBeNull();
    expect(normalizeReset({ every: "month" })).toEqual({
      every: "month",
      count: 1,
      anchor: "subscription",
    });
    expect(normalizeReset({ every: "term" })).toEqual({ every: "term" });
    expect(() => normalizeReset({ every: "fortnight" })).toThrow();
    expect(() => normalizeReset({ every: "never", count: 2 })).toThrow();
    expect(() => normalizeReset({ every: "day", count: 0 })).toThrow();
    expect(() => normalizeReset({ every: "day", extra: 1 })).toThrow();
  });
  it("refuses hourly credits and a window longer than the term", () => {
    expect(resetRefusal(sub("hour"), { target: "credits", interval: "month" })).toMatch(/hour/);
    expect(resetRefusal(sub("hour"), { target: "allowance", interval: "month" })).toBeNull();
    expect(resetRefusal(sub("year"), { target: "credits", interval: "month" })).toMatch(/term/);
    expect(resetRefusal(sub("month"), { target: "credits", interval: "year" })).toBeNull();
    expect(resetRefusal(sub("day", 31), { target: "credits", interval: "month" })).toMatch(/term/);
    expect(resetRefusal(sub("day", 30), { target: "credits", interval: "month" })).toBeNull();
    expect(
      resetRefusal(sub("quarter"), { target: "credits", interval: "month", intervalCount: 3 }),
    ).toBeNull();
  });
});

describe("subscription anchor", () => {
  it("steps months from the term start, end-of-month safe, never drifting", () => {
    const c = ctx();
    const ws = windowsStartingIn(sub("month"), c.termStart, c.termEnd, c);
    expect(ws).toHaveLength(12);
    expect(iso(ws[0]!)).toEqual(["2030-01-31T10:00:00.000Z", "2030-02-28T10:00:00.000Z"]);
    expect(iso(ws[1]!)).toEqual(["2030-02-28T10:00:00.000Z", "2030-03-31T10:00:00.000Z"]);
    expect(ws[11]!.end!.toISOString()).toBe("2031-01-31T10:00:00.000Z");
  });
  it("leap years: Feb 29 + 1 year clamps to Feb 28", () => {
    const c = ctx({ termStart: d("2028-02-29T00:00:00Z"), termEnd: d("2030-02-28T00:00:00Z") });
    expect(iso(windowAt(sub("year"), d("2029-03-01T00:00:00Z"), c))).toEqual([
      "2029-02-28T00:00:00.000Z",
      "2030-02-28T00:00:00.000Z",
    ]);
  });
  it("quarter, half year and year", () => {
    const c = ctx();
    expect(windowsStartingIn(sub("quarter"), c.termStart, c.termEnd, c)).toHaveLength(4);
    expect(windowsStartingIn(sub("half_year"), c.termStart, c.termEnd, c)).toHaveLength(2);
    expect(windowsStartingIn(sub("year"), c.termStart, c.termEnd, c)).toHaveLength(1);
    expect(iso(windowAt(sub("half_year"), d("2030-09-01T00:00:00Z"), c))).toEqual([
      "2030-07-31T10:00:00.000Z",
      "2031-01-31T10:00:00.000Z",
    ]);
  });
  it("hour, day, week from the signup instant; the last window is cut at the term end", () => {
    const c = ctx({ termStart: d("2030-03-01T13:20:00Z"), termEnd: d("2030-04-01T13:20:00Z") });
    expect(iso(windowAt(sub("day"), d("2030-03-02T01:00:00Z"), c))).toEqual([
      "2030-03-01T13:20:00.000Z",
      "2030-03-02T13:20:00.000Z",
    ]);
    expect(iso(windowAt(sub("hour", 6), d("2030-03-01T20:00:00Z"), c))).toEqual([
      "2030-03-01T19:20:00.000Z",
      "2030-03-02T01:20:00.000Z",
    ]);
    const weeks = windowsStartingIn(sub("week"), c.termStart, c.termEnd, c);
    expect(weeks).toHaveLength(5);
    expect(iso(weeks[4]!)).toEqual(["2030-03-29T13:20:00.000Z", "2030-04-01T13:20:00.000Z"]);
  });
  it("a pause shift moves every window on", () => {
    const c = ctx({ shiftMs: 3 * 86_400_000 });
    expect(windowAt(sub("month"), d("2030-03-10T00:00:00Z"), c).start.toISOString()).toBe(
      "2030-03-03T10:00:00.000Z",
    );
  });
  it("term and never", () => {
    const c = ctx();
    expect(iso(windowAt(null, d("2030-06-01T00:00:00Z"), c))).toEqual([
      "2030-01-31T10:00:00.000Z",
      "2031-01-31T10:00:00.000Z",
    ]);
    expect(windowAt({ every: "never" }, d("2035-06-01T00:00:00Z"), c).end).toBeNull();
  });
  it("rollover expiry counts reset windows, across the term end", () => {
    const c = ctx({ termStart: d("2030-01-01T00:00:00Z"), termEnd: d("2030-03-01T00:00:00Z") });
    const w = windowAt(sub("month"), d("2030-02-01T00:00:00Z"), c);
    expect(endAfterWindows(sub("month"), w, 1, c)!.toISOString()).toBe("2030-03-01T00:00:00.000Z");
    expect(endAfterWindows(sub("month"), w, 2, c)!.toISOString()).toBe("2030-04-01T00:00:00.000Z");
  });
});

describe("calendar anchor", () => {
  it("UTC: midnight, Monday, the 1st, quarter, half year and year", () => {
    const at = d("2030-05-15T13:45:00Z"); // a Wednesday
    const c = ctx();
    expect(iso(windowAt(cal("hour"), at, c))).toEqual([
      "2030-05-15T13:00:00.000Z",
      "2030-05-15T14:00:00.000Z",
    ]);
    expect(iso(windowAt(cal("day"), at, c))).toEqual([
      "2030-05-15T00:00:00.000Z",
      "2030-05-16T00:00:00.000Z",
    ]);
    expect(iso(windowAt(cal("week"), at, c))).toEqual([
      "2030-05-13T00:00:00.000Z",
      "2030-05-20T00:00:00.000Z",
    ]);
    expect(iso(windowAt(cal("month"), at, c))).toEqual([
      "2030-05-01T00:00:00.000Z",
      "2030-06-01T00:00:00.000Z",
    ]);
    expect(iso(windowAt(cal("quarter"), at, c))).toEqual([
      "2030-04-01T00:00:00.000Z",
      "2030-07-01T00:00:00.000Z",
    ]);
    expect(iso(windowAt(cal("half_year"), at, c))).toEqual([
      "2030-01-01T00:00:00.000Z",
      "2030-07-01T00:00:00.000Z",
    ]);
    expect(iso(windowAt(cal("year"), at, c))).toEqual([
      "2030-01-01T00:00:00.000Z",
      "2031-01-01T00:00:00.000Z",
    ]);
  });
  it("a +05:30 zone: Monday 00:00 and the hour fall on :30 UTC", () => {
    const c = ctx({ timeZone: "Asia/Kolkata" });
    expect(iso(windowAt(cal("week"), d("2030-05-15T13:45:00Z"), c))).toEqual([
      "2030-05-12T18:30:00.000Z",
      "2030-05-19T18:30:00.000Z",
    ]);
    expect(iso(windowAt(cal("hour"), d("2030-05-15T13:45:00Z"), c))).toEqual([
      "2030-05-15T13:30:00.000Z",
      "2030-05-15T14:30:00.000Z",
    ]);
    expect(windowAt(cal("month"), d("2030-05-31T20:00:00Z"), c).start.toISOString()).toBe(
      "2030-05-31T18:30:00.000Z",
    );
  });
  it("DST in the business zone: a day is 23 or 25 hours, hours stay contiguous", () => {
    const c = ctx({ timeZone: "America/New_York" });
    const spring = windowAt(cal("day"), d("2030-03-10T12:00:00Z"), c);
    expect(spring.end!.getTime() - spring.start.getTime()).toBe(23 * 3_600_000);
    expect(spring.start.toISOString()).toBe("2030-03-10T05:00:00.000Z");
    const fall = windowAt(cal("day"), d("2030-11-03T12:00:00Z"), c);
    expect(fall.end!.getTime() - fall.start.getTime()).toBe(25 * 3_600_000);
    const hours = windowsStartingIn(cal("hour"), spring.start, spring.end!, c);
    expect(hours).toHaveLength(23);
    for (let i = 1; i < hours.length; i++)
      expect(hours[i]!.start.getTime()).toBe(hours[i - 1]!.end!.getTime());
  });
  it("a calendar window may start before the subscription and cross the term end", () => {
    const c = ctx({ termStart: d("2030-01-15T00:00:00Z"), termEnd: d("2030-02-15T00:00:00Z") });
    const ws = windowsStartingIn(cal("month"), d("2030-01-01T00:00:00Z"), c.termEnd, c);
    expect(ws.map(iso)).toEqual([
      ["2030-01-01T00:00:00.000Z", "2030-02-01T00:00:00.000Z"],
      ["2030-02-01T00:00:00.000Z", "2030-03-01T00:00:00.000Z"],
    ]);
  });
});

describe("calendar pause shift", () => {
  const month = cal("month");
  it("extends the open window; the next one runs to the next 1st; then calendar months", () => {
    // Paused 10 days in March: [Mar 1, Apr 1) becomes [Mar 1, Apr 11).
    const c = ctx({
      pauseShift: shiftedWindow(windowAt(month, d("2030-03-20T00:00:00Z"), ctx()), 10 * 86_400_000),
    });
    expect(iso(windowAt(month, d("2030-03-15T00:00:00Z"), c))).toEqual([
      "2030-03-01T00:00:00.000Z",
      "2030-04-11T00:00:00.000Z",
    ]);
    expect(iso(windowAt(month, d("2030-04-05T00:00:00Z"), c))).toEqual([
      "2030-03-01T00:00:00.000Z",
      "2030-04-11T00:00:00.000Z",
    ]);
    expect(iso(windowAt(month, d("2030-04-20T00:00:00Z"), c))).toEqual([
      "2030-04-11T00:00:00.000Z",
      "2030-05-01T00:00:00.000Z",
    ]);
    expect(iso(windowAt(month, d("2030-02-10T00:00:00Z"), c))).toEqual([
      "2030-02-01T00:00:00.000Z",
      "2030-03-01T00:00:00.000Z",
    ]);
    const ws = windowsStartingIn(month, d("2030-03-01T00:00:00Z"), d("2030-07-01T00:00:00Z"), c);
    expect(ws.map(iso)).toEqual([
      ["2030-03-01T00:00:00.000Z", "2030-04-11T00:00:00.000Z"],
      ["2030-04-11T00:00:00.000Z", "2030-05-01T00:00:00.000Z"],
      ["2030-05-01T00:00:00.000Z", "2030-06-01T00:00:00.000Z"],
      ["2030-06-01T00:00:00.000Z", "2030-07-01T00:00:00.000Z"],
    ]);
  });
  it("skips the calendar boundaries the moved end covers; no zero or negative window", () => {
    // [Apr 1, May 1) + 45 days ends May 16: the next window is [May 16, Jun 1).
    const c = ctx({
      pauseShift: { start: d("2030-04-01T00:00:00Z"), end: d("2030-05-16T00:00:00Z") },
    });
    const ws = windowsStartingIn(month, d("2030-04-01T00:00:00Z"), d("2030-07-01T00:00:00Z"), c);
    expect(ws.map(iso)).toEqual([
      ["2030-04-01T00:00:00.000Z", "2030-05-16T00:00:00.000Z"],
      ["2030-05-16T00:00:00.000Z", "2030-06-01T00:00:00.000Z"],
      ["2030-06-01T00:00:00.000Z", "2030-07-01T00:00:00.000Z"],
    ]);
    // A moved end on a boundary: the next window is a full calendar month.
    const b = ctx({
      pauseShift: { start: d("2030-04-01T00:00:00Z"), end: d("2030-06-01T00:00:00Z") },
    });
    expect(iso(windowAt(month, d("2030-06-01T00:00:00Z"), b))).toEqual([
      "2030-06-01T00:00:00.000Z",
      "2030-07-01T00:00:00.000Z",
    ]);
    expect(endAfterWindows(month, windowAt(month, d("2030-04-02T00:00:00Z"), c), 2, c)).toEqual(
      d("2030-06-01T00:00:00Z"),
    );
  });
  it("finds the short window's calendar month, for the first-window rule", () => {
    // 100 credits, paused 10–20 March: March ends 11 April; 11 April → 1 May is 20 of 30 days.
    const c = ctx({
      pauseShift: { start: d("2030-03-01T00:00:00Z"), end: d("2030-04-11T00:00:00Z") },
    });
    const short = windowAt(month, d("2030-04-11T00:00:00Z"), c);
    const plain = calendarWindowOfShort(month, short, c);
    expect(plain && iso(plain)).toEqual(["2030-04-01T00:00:00.000Z", "2030-05-01T00:00:00.000Z"]);
    expect(prorateForRest(100n, plain!, short.start)).toBe(67n); // 20 of 30 days
    // Not short: the extended window, a full month, or a moved end on a boundary.
    expect(
      calendarWindowOfShort(month, windowAt(month, d("2030-03-05T00:00:00Z"), c), c),
    ).toBeNull();
    expect(
      calendarWindowOfShort(month, windowAt(month, d("2030-05-05T00:00:00Z"), c), c),
    ).toBeNull();
    const b = ctx({
      pauseShift: { start: d("2030-04-01T00:00:00Z"), end: d("2030-06-01T00:00:00Z") },
    });
    expect(
      calendarWindowOfShort(month, windowAt(month, d("2030-06-01T00:00:00Z"), b), b),
    ).toBeNull();
  });
  it("pauseShiftOf cuts the calendar shift the clock stores; term and never do not move", () => {
    expect(pauseShiftOf(month, ctx(), d("2030-03-20T00:00:00Z"), 10 * 86_400_000)).toEqual({
      start: d("2030-03-01T00:00:00Z"),
      end: d("2030-04-11T00:00:00Z"),
    });
    expect(pauseShiftOf({ every: "term" }, ctx(), d("2030-03-20T00:00:00Z"), 1)).toBeNull();
    expect(pauseShiftOf({ every: "never" }, ctx(), d("2030-03-20T00:00:00Z"), 1)).toBeNull();
    expect(pauseShiftOf(null, ctx(), d("2030-03-20T00:00:00Z"), 1)).toBeNull();
  });
});

describe("subscription anchor pause shift", () => {
  const m = sub("month");
  const DAY = 86_400_000;
  const c0 = ctx({ termStart: d("2030-03-01T00:00:00Z"), termEnd: d("2031-03-01T00:00:00Z") });
  // Paused 5 days from 10 March: [Mar 1, Apr 1) runs to Apr 6; later windows step from Mar 6.
  const s1 = pauseShiftOf(m, c0, d("2030-03-10T00:00:00Z"), 5 * DAY)!;
  const c1 = { ...c0, shiftMs: 5 * DAY, pauseShift: s1 };
  it("the open window keeps its start (usage before the pause counts) and ends late", () => {
    expect(iso(s1)).toEqual(["2030-03-01T00:00:00.000Z", "2030-04-06T00:00:00.000Z"]);
    expect(iso(windowAt(m, d("2030-03-05T00:00:00Z"), c1))).toEqual(iso(s1));
    expect(iso(windowAt(m, d("2030-04-03T00:00:00Z"), c1))).toEqual(iso(s1));
    expect(windowsStartingIn(m, c0.termStart, d("2030-06-07T00:00:00Z"), c1).map(iso)).toEqual([
      ["2030-03-01T00:00:00.000Z", "2030-04-06T00:00:00.000Z"],
      ["2030-04-06T00:00:00.000Z", "2030-05-06T00:00:00.000Z"],
      ["2030-05-06T00:00:00.000Z", "2030-06-06T00:00:00.000Z"],
      ["2030-06-06T00:00:00.000Z", "2030-07-06T00:00:00.000Z"],
    ]);
  });
  it("a second pause inside the moved window extends it again from the same start", () => {
    const s2 = pauseShiftOf(m, c1, d("2030-04-03T00:00:00Z"), 2 * DAY)!;
    const c2 = { ...c1, shiftMs: 7 * DAY, pauseShift: s2 };
    expect(iso(s2)).toEqual(["2030-03-01T00:00:00.000Z", "2030-04-08T00:00:00.000Z"]);
    expect(iso(windowAt(m, d("2030-04-07T00:00:00Z"), c2))).toEqual(iso(s2));
    expect(iso(windowAt(m, d("2030-04-09T00:00:00Z"), c2))).toEqual([
      "2030-04-08T00:00:00.000Z",
      "2030-05-08T00:00:00.000Z",
    ]);
  });
});

describe("allowance reset link", () => {
  it("accepts { same_as_credits: true } only", () => {
    expect(normalizeAllowanceReset({ same_as_credits: true })).toEqual({ same_as_credits: true });
    expect(isCreditsLink(normalizeAllowanceReset({ same_as_credits: true }))).toBe(true);
    expect(normalizeAllowanceReset({ every: "day" })).toEqual({
      every: "day",
      count: 1,
      anchor: "subscription",
    });
    expect(() => normalizeAllowanceReset({ same_as_credits: false })).toThrow();
    expect(() => normalizeAllowanceReset({ same_as_credits: true, every: "day" })).toThrow();
  });
  it("keys resets by schedule: absent = term", () => {
    expect(resetKey(null)).toBe(resetKey({ every: "term" }));
    expect(resetKey({ every: "month" } as Reset)).toBe(resetKey(sub("month")));
    expect(resetKey(sub("month"))).not.toBe(resetKey(cal("month")));
    expect(resetKey(sub("month"))).not.toBe(resetKey(sub("month", 2)));
  });
});

describe("proration and splitting", () => {
  it("prorates the rest of a window, rounded half-up", () => {
    const w = { start: d("2030-01-01T00:00:00Z"), end: d("2030-01-11T00:00:00Z") };
    expect(prorateForRest(25n, w, d("2030-01-06T00:00:00Z"))).toBe(13n); // 12.5
    expect(prorateForRest(25n, w, d("2029-12-01T00:00:00Z"))).toBe(25n);
  });
  it("splits by weight, the last piece taking the remainder", () => {
    expect(splitByWeights(100n, [1n, 1n, 1n])).toEqual([33n, 33n, 34n]);
    expect(splitByWeights(7n, [0n, 0n])).toEqual([0n, 7n]);
    expect(splitByWeights(1001n, [3n, 7n]).reduce((a, b) => a + b, 0n)).toBe(1001n);
    expect(
      scaleSlices(
        [
          { window: { start: d("2030-01-01"), end: d("2030-01-02") }, valueMinor: 30n },
          { window: { start: d("2030-01-02"), end: d("2030-01-03") }, valueMinor: 70n },
        ],
        50n,
      ),
    ).toEqual([15n, 35n]);
  });
});

describe("exact windows in the planner", () => {
  const g = (id: string, start: string, end: string, face: bigint): PlannerGrant => ({
    id,
    category: "promotional",
    source: "plan_cycle",
    priority: 50,
    effectiveAt: d(start),
    expiresAt: d(end),
    taxTreatment: null,
    unitId: null,
    applicability: { kind: "metered" },
    amount: face,
    costBasisMinor: 0n,
    rate: MONEY_RATE,
    remainingUnits: face,
    remainingFace: face,
    remainingCost: 0n,
    exactWindow: true,
  });
  const line = {
    key: "0",
    kind: "usage",
    pricePublicId: "p",
    valueMinor: 300n,
    window: { start: d("2030-01-01T00:00:00Z"), end: d("2031-01-01T00:00:00Z") },
    slices: [
      {
        window: { start: d("2030-01-01T00:00:00Z"), end: d("2030-01-02T00:00:00Z") },
        valueMinor: 100n,
      },
      {
        window: { start: d("2030-01-02T00:00:00Z"), end: d("2030-01-03T00:00:00Z") },
        valueMinor: 200n,
      },
      {
        window: { start: d("2030-01-03T00:00:00Z"), end: d("2031-01-01T00:00:00Z") },
        valueMinor: 0n,
      },
    ],
  };
  it("a daily grant pays only its own day's usage", () => {
    const plan = planGrantApplication({
      phase: "pre_tax",
      grants: [
        g("d1", "2030-01-01T00:00:00Z", "2030-01-02T00:00:00Z", 150n),
        g("d2", "2030-01-02T00:00:00Z", "2030-01-03T00:00:00Z", 150n),
      ],
      lines: [line],
    });
    const by = new Map(plan.draws.map((x) => [x.grantId, x.faceMinor]));
    expect(by.get("d1")).toBe(100n);
    expect(by.get("d2")).toBe(150n);
    expect(plan.totalMinor).toBe(250n);
  });
  it("without the flag a grant draws from any slice, as before", () => {
    const plan = planGrantApplication({
      phase: "pre_tax",
      grants: [
        { ...g("d1", "2030-01-01T00:00:00Z", "2030-01-02T00:00:00Z", 300n), exactWindow: false },
      ],
      lines: [line],
    });
    expect(plan.totalMinor).toBe(300n);
  });
});

describe("reset settings", () => {
  it("defaults to the best option; an invalid value resolves to the default", () => {
    expect(readResetSettings(null)).toEqual({
      planCredits: {
        onUpgrade: "full",
        onDowngrade: "next_window",
        firstWindow: "full",
        onPause: "skip",
        onCancelAtPeriodEnd: "grant_started_window",
      },
      allowances: { onUpgrade: "new_window" },
    });
    const s = readResetSettings({
      billingRulesConfig: {
        plan_credits: {
          on_upgrade: "prorated",
          on_pause: "bogus",
          first_window: "next_full_window",
        },
        allowances: { on_upgrade: "keep_used" },
      },
    });
    expect(s.planCredits.onUpgrade).toBe("prorated");
    expect(s.planCredits.onPause).toBe("skip");
    expect(s.planCredits.firstWindow).toBe("next_full_window");
    expect(s.allowances.onUpgrade).toBe("keep_used");
  });
});

describe("month-end anchors under a pause shift", () => {
  const m = sub("month");
  const DAY = 86_400_000;
  // A 5-day pause from the 10th of the month after the start: each later boundary moves by the
  // paused time, so every window starts where the one before it ends.
  const after = (start: string, until: string) => {
    const c0 = ctx({ termStart: d(start), termEnd: new Date(d(start).getTime() + 365 * DAY) });
    const pausedAt = new Date(d(start).getTime() + 10 * DAY);
    const s = pauseShiftOf(m, c0, pausedAt, 5 * DAY)!;
    return windowsStartingIn(m, c0.termStart, d(until), { ...c0, shiftMs: 5 * DAY, pauseShift: s });
  };
  const contiguous = (ws: ReturnType<typeof after>) =>
    ws.every((w, i) => i === 0 || w.start.getTime() === ws[i - 1]!.end!.getTime());
  it("the 30th: the open window ends Jun 4, the next one starts Jun 4 (not May 5)", () => {
    const ws = after("2030-04-30T00:00:00Z", "2030-09-01T00:00:00Z");
    expect(ws.map(iso)).toEqual([
      ["2030-04-30T00:00:00.000Z", "2030-06-04T00:00:00.000Z"],
      ["2030-06-04T00:00:00.000Z", "2030-07-05T00:00:00.000Z"],
      ["2030-07-05T00:00:00.000Z", "2030-08-04T00:00:00.000Z"],
      ["2030-08-04T00:00:00.000Z", "2030-09-04T00:00:00.000Z"],
    ]);
    expect(contiguous(ws)).toBe(true);
  });
  it("the 29th (February clamps): the next window starts at the moved end, Mar 5", () => {
    const ws = after("2030-01-29T00:00:00Z", "2030-05-01T00:00:00Z");
    expect(ws.map(iso)).toEqual([
      ["2030-01-29T00:00:00.000Z", "2030-03-05T00:00:00.000Z"],
      ["2030-03-05T00:00:00.000Z", "2030-04-03T00:00:00.000Z"],
      ["2030-04-03T00:00:00.000Z", "2030-05-04T00:00:00.000Z"],
    ]);
    expect(contiguous(ws)).toBe(true);
  });
  it("the 31st: the shifted boundaries fall on the 5th either way", () => {
    const ws = after("2030-01-31T00:00:00Z", "2030-05-01T00:00:00Z");
    expect(ws.map(iso)).toEqual([
      ["2030-01-31T00:00:00.000Z", "2030-03-05T00:00:00.000Z"],
      ["2030-03-05T00:00:00.000Z", "2030-04-05T00:00:00.000Z"],
      ["2030-04-05T00:00:00.000Z", "2030-05-05T00:00:00.000Z"],
    ]);
    expect(contiguous(ws)).toBe(true);
  });
});

describe("foldPauseShifts (a pause history without a stored window)", () => {
  const m = sub("month");
  const DAY = 86_400_000;
  const c0 = ctx({ termStart: d("2030-03-01T00:00:00Z"), termEnd: d("2031-03-01T00:00:00Z") });
  it("one pause: the same context the resume stores", () => {
    const f = foldPauseShifts(m, c0, [{ at: d("2030-03-10T00:00:00Z"), ms: 5 * DAY }]);
    expect(f.shiftMs).toBe(5 * DAY);
    expect(f.pauseShift).toEqual(pauseShiftOf(m, c0, d("2030-03-10T00:00:00Z"), 5 * DAY));
  });
  it("two pauses in one window: the open window keeps its start", () => {
    const f = foldPauseShifts(m, c0, [
      { at: d("2030-03-10T00:00:00Z"), ms: 5 * DAY },
      { at: d("2030-04-03T00:00:00Z"), ms: 2 * DAY },
    ]);
    expect(f.shiftMs).toBe(7 * DAY);
    expect(f.pauseShift && iso(f.pauseShift)).toEqual([
      "2030-03-01T00:00:00.000Z",
      "2030-04-08T00:00:00.000Z",
    ]);
  });
  it("a calendar reset folds the same way", () => {
    const c = cal("month");
    const f = foldPauseShifts(c, ctx(), [{ at: d("2030-03-20T00:00:00Z"), ms: 10 * DAY }]);
    expect(f.pauseShift && iso(f.pauseShift)).toEqual([
      "2030-03-01T00:00:00.000Z",
      "2030-04-11T00:00:00.000Z",
    ]);
  });
});

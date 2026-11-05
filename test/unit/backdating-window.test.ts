/**
 * Backdating window — the resolver's permissive defaults and the guard's predicate.
 *
 * Two things regress here and both are one-line mistakes:
 *
 * 1. A default that REFUSES. `backdating_config` is nullable with no column default, so
 *    every business resolves through the defaults on the day this ships — and backdating
 *    was unbounded before it existed. Any tightening of a default silently 400s callers
 *    that worked yesterday, so the "absent / null / malformed" cases below are the real
 *    contract, not paperwork.
 * 2. The cut-off answered in UTC. It is a day of the month, so it can only be answered in
 *    the business timezone; the tz cases pin both directions of the crossing, where UTC
 *    and the business disagree about which day — and which MONTH — it is.
 */
import { describe, it, expect } from "vitest";
import {
  resolveBackdatingConfig,
  isBackdateAllowed,
  DEFAULT_BACKDATING_CONFIG,
  BACKDATABLE_ACTIONS,
  type BackdatableAction,
  type BackdatingConfig,
} from "@/modules/subscriptions/backdating-config";

const cfg = (over: Partial<BackdatingConfig> = {}): BackdatingConfig => ({
  ...DEFAULT_BACKDATING_CONFIG,
  ...over,
});

/** Shorthand: no invoice raised, so the two invoice-date flags stay out of the way. */
const decide = (input: {
  config?: BackdatingConfig;
  action?: BackdatableAction;
  target: string;
  now: string;
  tz?: string | null;
  raisesInvoice?: boolean;
}) =>
  isBackdateAllowed({
    config: input.config ?? DEFAULT_BACKDATING_CONFIG,
    action: input.action ?? "create",
    target: new Date(input.target),
    now: new Date(input.now),
    businessTimezone: input.tz,
    raisesPastDatedInvoice: input.raisesInvoice ?? false,
  });

describe("resolveBackdatingConfig — an unconfigured business is fully permissive", () => {
  it("resolves an absent, null and empty stored value to the permissive default", () => {
    expect(resolveBackdatingConfig(null)).toEqual(DEFAULT_BACKDATING_CONFIG);
    expect(resolveBackdatingConfig(undefined)).toEqual(DEFAULT_BACKDATING_CONFIG);
    expect(resolveBackdatingConfig({})).toEqual(DEFAULT_BACKDATING_CONFIG);
    expect(resolveBackdatingConfig({ backdatingConfig: null })).toEqual(DEFAULT_BACKDATING_CONFIG);
    expect(resolveBackdatingConfig({ backdatingConfig: {} })).toEqual(DEFAULT_BACKDATING_CONFIG);
  });

  it("has every default set to what the routes did before migration 0242", () => {
    expect(DEFAULT_BACKDATING_CONFIG).toEqual({
      enabled: true,
      allowedActions: BACKDATABLE_ACTIONS,
      cutoffDayOfMonth: null,
      allowPastInvoiceDateOnCreate: true,
      allowPastInvoiceDateOnChange: true,
    });
  });
});

describe("resolveBackdatingConfig — malformed resolves PERMISSIVE, never restrictive", () => {
  it("reads a non-boolean flag as its (true) default rather than as false", () => {
    const r = resolveBackdatingConfig({
      backdatingConfig: {
        enabled: "false",
        allow_past_invoice_date_on_create: 0,
        allow_past_invoice_date_on_change: null,
      },
    });
    expect(r.enabled).toBe(true);
    expect(r.allowPastInvoiceDateOnCreate).toBe(true);
    expect(r.allowPastInvoiceDateOnChange).toBe(true);
  });

  it("honours an explicit false on each flag", () => {
    const r = resolveBackdatingConfig({
      backdatingConfig: {
        enabled: false,
        allow_past_invoice_date_on_create: false,
        allow_past_invoice_date_on_change: false,
      },
    });
    expect(r.enabled).toBe(false);
    expect(r.allowPastInvoiceDateOnCreate).toBe(false);
    expect(r.allowPastInvoiceDateOnChange).toBe(false);
  });

  it.each([0, 31, 11, -1, 5.5, "abc", "", NaN, true, null, {}, []])(
    "resolves an out-of-range cut-off (%p) to null = no restriction",
    (raw) => {
      expect(
        resolveBackdatingConfig({ backdatingConfig: { cutoff_day_of_month: raw } })
          .cutoffDayOfMonth,
      ).toBeNull();
    },
  );

  it("accepts 1..10, including a numeric string from an importer", () => {
    expect(
      resolveBackdatingConfig({ backdatingConfig: { cutoff_day_of_month: 1 } }).cutoffDayOfMonth,
    ).toBe(1);
    expect(
      resolveBackdatingConfig({ backdatingConfig: { cutoff_day_of_month: 10 } }).cutoffDayOfMonth,
    ).toBe(10);
    expect(
      resolveBackdatingConfig({ backdatingConfig: { cutoff_day_of_month: " 7 " } })
        .cutoffDayOfMonth,
    ).toBe(7);
  });

  it("reads a non-array allowed_actions as all five", () => {
    expect(
      resolveBackdatingConfig({ backdatingConfig: { allowed_actions: "create" } }).allowedActions,
    ).toEqual(BACKDATABLE_ACTIONS);
    expect(
      resolveBackdatingConfig({ backdatingConfig: { allowed_actions: null } }).allowedActions,
    ).toEqual(BACKDATABLE_ACTIONS);
  });

  it("reads an array of only UNKNOWN names as all five — a failed restriction is not a decision", () => {
    expect(
      resolveBackdatingConfig({
        backdatingConfig: { allowed_actions: ["subscription_create", 7, null] },
      }).allowedActions,
    ).toEqual(BACKDATABLE_ACTIONS);
  });

  it("filters a mixed array to the known names, in canonical order", () => {
    expect(
      resolveBackdatingConfig({
        backdatingConfig: { allowed_actions: ["cancel", "nope", "create", "create"] },
      }).allowedActions,
    ).toEqual(["create", "cancel"]);
  });

  it("honours an EXPLICITLY empty array — the merchant unchecked every box", () => {
    expect(
      resolveBackdatingConfig({ backdatingConfig: { allowed_actions: [] } }).allowedActions,
    ).toEqual([]);
  });
});

describe("isBackdateAllowed — the default config refuses nothing", () => {
  it.each(BACKDATABLE_ACTIONS)("allows a %s backdated by two years", (action) => {
    expect(decide({ action, target: "2024-03-01T00:00:00Z", now: "2026-09-08T00:00:00Z" })).toEqual(
      { allowed: true },
    );
  });

  it("allows a backdate that raises a past-dated invoice on both create and change", () => {
    for (const action of ["create", "change"] as const) {
      expect(
        decide({
          action,
          target: "2024-03-01T00:00:00Z",
          now: "2026-09-08T00:00:00Z",
          raisesInvoice: true,
        }),
      ).toEqual({ allowed: true });
    }
  });
});

describe("isBackdateAllowed — not a backdate at all", () => {
  it("allows the same calendar day and the future even with backdating switched off", () => {
    const off = cfg({ enabled: false });
    // Earlier INSTANT, same business day: a client clock a few hours behind must not be
    // refused its own "now".
    expect(
      decide({ config: off, target: "2026-09-08T01:00:00Z", now: "2026-09-08T23:00:00Z" }),
    ).toEqual({ allowed: true });
    expect(
      decide({ config: off, target: "2026-12-01T00:00:00Z", now: "2026-09-08T00:00:00Z" }),
    ).toEqual({ allowed: true });
  });
});

describe("isBackdateAllowed — enabled and allowed_actions", () => {
  it("refuses every action when disabled", () => {
    const d = decide({
      config: cfg({ enabled: false }),
      target: "2026-09-01T00:00:00Z",
      now: "2026-09-08T00:00:00Z",
    });
    expect(d.allowed).toBe(false);
    expect(d).toMatchObject({ code: "backdating_disabled" });
  });

  it.each(BACKDATABLE_ACTIONS)("gates %s independently of the other four", (action) => {
    const only = cfg({ allowedActions: [action] });
    expect(
      decide({ config: only, action, target: "2026-09-01T00:00:00Z", now: "2026-09-08T00:00:00Z" }),
    ).toEqual({ allowed: true });
    for (const other of BACKDATABLE_ACTIONS.filter((a) => a !== action)) {
      const d = decide({
        config: only,
        action: other,
        target: "2026-09-01T00:00:00Z",
        now: "2026-09-08T00:00:00Z",
      });
      expect(d.allowed).toBe(false);
      expect(d).toMatchObject({ code: "backdating_action_not_allowed" });
    }
  });

  it("refuses everything on an explicitly empty allowed list", () => {
    for (const action of BACKDATABLE_ACTIONS) {
      expect(
        decide({
          config: cfg({ allowedActions: [] }),
          action,
          target: "2026-09-01T00:00:00Z",
          now: "2026-09-08T00:00:00Z",
        }).allowed,
      ).toBe(false);
    }
  });
});

describe("isBackdateAllowed — past invoice date consent", () => {
  const target = "2026-09-01T00:00:00Z";
  const now = "2026-09-08T00:00:00Z";

  it("refuses a backdated CREATE that would invoice immediately", () => {
    const d = decide({
      config: cfg({ allowPastInvoiceDateOnCreate: false }),
      action: "create",
      target,
      now,
      raisesInvoice: true,
    });
    expect(d).toMatchObject({ allowed: false, code: "backdating_past_invoice_date_not_allowed" });
  });

  it("allows the same create when nothing is invoiced (a trial, or invoice_immediately: false)", () => {
    expect(
      decide({
        config: cfg({ allowPastInvoiceDateOnCreate: false }),
        action: "create",
        target,
        now,
        raisesInvoice: false,
      }),
    ).toEqual({ allowed: true });
  });

  it("keeps the create and change flags separate", () => {
    const createOff = cfg({ allowPastInvoiceDateOnCreate: false });
    expect(
      decide({ config: createOff, action: "change", target, now, raisesInvoice: true }),
    ).toEqual({ allowed: true });
    const changeOff = cfg({ allowPastInvoiceDateOnChange: false });
    expect(
      decide({ config: changeOff, action: "create", target, now, raisesInvoice: true }),
    ).toEqual({ allowed: true });
    expect(
      decide({ config: changeOff, action: "change", target, now, raisesInvoice: true }),
    ).toMatchObject({ allowed: false, code: "backdating_past_invoice_date_not_allowed" });
  });

  it("ignores both flags for cancel, the one action 0242 gives no flag", () => {
    const bothOff = cfg({
      allowPastInvoiceDateOnCreate: false,
      allowPastInvoiceDateOnChange: false,
    });
    // A cancel raises credit notes and collections, never a past-dated invoice, so the
    // route passes `raisesPastDatedInvoice: false` and neither consent applies. Asserted
    // with `raisesInvoice: true` anyway: the predicate must not consult the flags for an
    // action that has none, whatever the caller claims.
    expect(decide({ config: bothOff, action: "cancel", target, now, raisesInvoice: true })).toEqual(
      { allowed: true },
    );
  });
});

describe("resolveBackdatingConfig — withdrawn action names", () => {
  // `one_time` was an accepted value until the guard sites were wired and it turned out
  // not to take a past-dated instant. A row written against that contract must fall back
  // to EVERY action, not to none: an array with nothing recognisable in it is a failed
  // restriction, and a failed restriction must not refuse work.
  it("resolves a row of only withdrawn names to every action", () => {
    expect(
      resolveBackdatingConfig({
        backdatingConfig: { allowed_actions: ["one_time"] },
      }).allowedActions,
    ).toEqual(BACKDATABLE_ACTIONS);
  });

  it("keeps the recognisable names when a row mixes withdrawn ones in", () => {
    expect(
      resolveBackdatingConfig({
        backdatingConfig: { allowed_actions: ["cancel", "one_time"] },
      }).allowedActions,
    ).toEqual(["cancel"]);
  });
});

describe("isBackdateAllowed — the cut-off day", () => {
  const day10 = cfg({ cutoffDayOfMonth: 10 });

  it("does not restrict at all when the cut-off is null", () => {
    expect(decide({ target: "2019-01-01T00:00:00Z", now: "2026-09-28T00:00:00Z" })).toEqual({
      allowed: true,
    });
  });

  it("always allows a backdate inside the CURRENT month, however late in it", () => {
    expect(
      decide({ config: day10, target: "2026-09-02T00:00:00Z", now: "2026-09-28T00:00:00Z" }),
    ).toEqual({ allowed: true });
  });

  it("allows the previous month up to and including the cut-off day", () => {
    for (const now of ["2026-09-01", "2026-09-10"]) {
      expect(
        decide({ config: day10, target: "2026-08-20T00:00:00Z", now: `${now}T12:00:00Z` }),
      ).toEqual({ allowed: true });
    }
  });

  it("refuses the previous month once the month has passed the cut-off day", () => {
    const d = decide({
      config: day10,
      target: "2026-08-20T00:00:00Z",
      now: "2026-09-11T12:00:00Z",
    });
    expect(d).toMatchObject({ allowed: false, code: "backdating_cutoff_passed" });
    if (!d.allowed) expect(d.message).toContain("2026-08");
  });

  it("refuses anything older than the previous month whatever the day", () => {
    for (const now of ["2026-09-01", "2026-09-28"]) {
      const d = decide({
        config: day10,
        target: "2026-07-31T00:00:00Z",
        now: `${now}T12:00:00Z`,
      });
      expect(d).toMatchObject({ allowed: false, code: "backdating_period_closed" });
    }
  });

  it("treats December as January's previous month", () => {
    expect(
      decide({ config: day10, target: "2026-12-20T00:00:00Z", now: "2027-01-05T12:00:00Z" }),
    ).toEqual({ allowed: true });
    expect(
      decide({ config: day10, target: "2026-12-20T00:00:00Z", now: "2027-01-15T12:00:00Z" }),
    ).toMatchObject({ allowed: false, code: "backdating_cutoff_passed" });
    expect(
      decide({ config: day10, target: "2026-11-20T00:00:00Z", now: "2027-01-05T12:00:00Z" }),
    ).toMatchObject({ allowed: false, code: "backdating_period_closed" });
  });
});

describe("isBackdateAllowed — the cut-off is a BUSINESS-timezone calendar day", () => {
  const day10 = cfg({ cutoffDayOfMonth: 10 });
  const target = "2026-08-20T00:00:00Z";

  it("refuses where the business is already past the cut-off but UTC is not", () => {
    // 2026-09-10T20:00Z is still the 10th in UTC, but 01:30 on the 11th in Kolkata.
    const now = "2026-09-10T20:00:00Z";
    expect(decide({ config: day10, target, now, tz: "UTC" })).toEqual({ allowed: true });
    expect(decide({ config: day10, target, now, tz: "Asia/Kolkata" })).toMatchObject({
      allowed: false,
      code: "backdating_cutoff_passed",
    });
  });

  it("allows where the business has not reached the cut-off but UTC has passed it", () => {
    // 2026-09-11T04:00Z is the 11th in UTC, but 21:00 on the 10th in Los Angeles.
    const now = "2026-09-11T04:00:00Z";
    expect(decide({ config: day10, target, now, tz: "UTC" })).toMatchObject({
      allowed: false,
      code: "backdating_cutoff_passed",
    });
    expect(decide({ config: day10, target, now, tz: "America/Los_Angeles" })).toEqual({
      allowed: true,
    });
  });

  it("puts the TARGET in the business month too, not just `now`", () => {
    // 2026-08-31T20:00Z is August in UTC — a sealed previous month on the 20th — but
    // 01:30 on 1 September in Kolkata, which is the still-open current month.
    const now = "2026-09-20T12:00:00Z";
    expect(decide({ config: day10, target: "2026-08-31T20:00:00Z", now, tz: "UTC" })).toMatchObject(
      { allowed: false, code: "backdating_cutoff_passed" },
    );
    expect(
      decide({ config: day10, target: "2026-08-31T20:00:00Z", now, tz: "Asia/Kolkata" }),
    ).toEqual({ allowed: true });
  });

  it("falls back to UTC on a null, blank or unknown zone rather than throwing", () => {
    const now = "2026-09-11T12:00:00Z";
    for (const tz of [null, undefined, "  ", "Mars/Olympus_Mons"]) {
      expect(decide({ config: day10, target, now, tz })).toMatchObject({
        allowed: false,
        code: "backdating_cutoff_passed",
      });
    }
  });
});

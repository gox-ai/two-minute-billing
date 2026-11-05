import { describe, expect, it } from "vitest";
import {
  adaptiveNextRetryAt,
  retryClassOf,
  retryZoneFor,
  FUNDS_MAX_RETRIES,
} from "@/modules/subscriptions/adaptive-schedule";
import { readFileSync } from "node:fs";
import { normalizeRazorpayDecline, normalizeStripeDecline } from "@/providers/decline-codes";
import { planFailureRearm, nextRetryAt } from "@/modules/subscriptions/dunning-schedule";

const at = (iso: string) => new Date(iso);

// The seeded reference data `countries.timezones` is loaded from.
const GEO_ZONES: Record<string, string[]> = Object.fromEntries(
  (
    JSON.parse(readFileSync(new URL("../../db/seed-data/geo.json", import.meta.url), "utf8")) as {
      countries: Array<{ code: string; timezones: string[] }>;
    }
  ).countries.map((c) => [c.code, c.timezones]),
);

describe("retryClassOf", () => {
  it("classes the codes adaptive timing owns, and nothing else", () => {
    expect(retryClassOf("insufficient_funds")).toBe("funds");
    for (const c of ["processing_error", "gateway_error", "charge_failed", "retry_too_soon"])
      expect(retryClassOf(c)).toBe("transient");
    expect(retryClassOf("card_declined")).toBe("generic");
    expect(retryClassOf("DO_NOT_HONOR")).toBe("generic");
    for (const c of ["expired_card", "stolen_card", "something_new", "", null, undefined])
      expect(retryClassOf(c)).toBeNull();
  });
});

describe("adaptiveNextRetryAt", () => {
  const now = at("2026-09-25T12:00:00Z");
  const due = at("2026-09-24T00:00:00Z");

  it("transient: 4h, 1 day, 3 days after the failure, then spent", () => {
    const next = (n: number) =>
      adaptiveNextRetryAt({ retryClass: "transient", retryNumber: n, now, dueDate: due });
    expect(next(1)?.toISOString()).toBe("2026-09-25T16:00:00.000Z");
    expect(next(2)?.toISOString()).toBe("2026-09-26T12:00:00.000Z");
    expect(next(3)?.toISOString()).toBe("2026-09-28T12:00:00.000Z");
    expect(next(4)).toBeNull();
  });

  it("generic: 2, 3, 4 local days later at 10:00 in the business's timezone", () => {
    // 00:00 IST on the 26th — the local date is the 26th, not the UTC 25th.
    const failedAt = at("2026-09-25T18:30:00Z");
    const next = (n: number) =>
      adaptiveNextRetryAt({
        retryClass: "generic",
        retryNumber: n,
        now: failedAt,
        dueDate: due,
        timezone: "Asia/Kolkata",
      });
    expect(next(1)?.toISOString()).toBe("2026-09-28T04:30:00.000Z");
    expect(next(2)?.toISOString()).toBe("2026-09-29T04:30:00.000Z");
    expect(next(3)?.toISOString()).toBe("2026-09-30T04:30:00.000Z");
    expect(next(4)).toBeNull();
  });

  it("funds: the next 1st / 15th / month-end morning at least a day away", () => {
    const next = (iso: string, n = 1) =>
      adaptiveNextRetryAt({
        retryClass: "funds",
        retryNumber: n,
        now: at(iso),
        dueDate: at(iso),
      })?.toISOString();
    expect(next("2026-09-25T00:00:00Z")).toBe("2026-09-30T10:00:00.000Z");
    // Month-end is under 24h away, so the 1st.
    expect(next("2026-09-29T12:00:00Z")).toBe("2026-10-01T10:00:00.000Z");
    expect(next("2026-10-02T09:00:00Z")).toBe("2026-10-15T10:00:00.000Z");
    // February's last day, not the 30th.
    expect(next("2026-02-20T00:00:00Z")).toBe("2026-02-28T10:00:00.000Z");
    expect(next("2026-09-25T00:00:00Z", FUNDS_MAX_RETRIES + 1)).toBeUndefined();
  });

  it("never lands more than 30 days after the due date", () => {
    expect(
      adaptiveNextRetryAt({
        retryClass: "generic",
        retryNumber: 1,
        now: at("2026-08-29T12:00:00Z"),
        dueDate: at("2026-08-01T00:00:00Z"),
      }),
    ).toBeNull();
  });

  it("keeps 10:00 local across a DST change", () => {
    const next = (iso: string) =>
      adaptiveNextRetryAt({
        retryClass: "generic",
        retryNumber: 1,
        now: at(iso),
        dueDate: at(iso),
        timezone: "America/New_York",
      })?.toISOString();
    // Clocks go forward on 2026-03-08: 10:00 EDT.
    expect(next("2026-03-06T15:00:00Z")).toBe("2026-03-08T14:00:00.000Z");
    // Clocks go back on 2026-11-01: 10:00 EST.
    expect(next("2026-10-30T15:00:00Z")).toBe("2026-11-01T15:00:00.000Z");
  });

  it("falls back to UTC for a timezone Intl rejects", () => {
    expect(
      adaptiveNextRetryAt({
        retryClass: "generic",
        retryNumber: 1,
        now,
        dueDate: due,
        timezone: "Not/AZone",
      })?.toISOString(),
    ).toBe("2026-09-27T10:00:00.000Z");
  });
});

describe("planFailureRearm with adaptive timing", () => {
  const base = {
    dunningStatus: "in_progress",
    currentNextAttemptAt: null,
    autoCollectOn: true,
    retriable: true,
    newAttemptCount: 1,
    retryDays: [1, 3, 5, 7],
    now: at("2026-09-25T00:00:00Z"),
    dueDate: at("2026-09-24T00:00:00Z"),
    mode: "smart" as const,
    adaptiveTiming: true,
    timezone: "UTC",
  };
  const retryAt = (p: ReturnType<typeof planFailureRearm>) =>
    p.action === "retry" ? p.nextAttempt.toISOString() : p.action;

  it("times a card's insufficient-funds retry to the next payday", () => {
    expect(retryAt(planFailureRearm({ ...base, declineCode: "insufficient_funds" }))).toBe(
      "2026-09-30T10:00:00.000Z",
    );
  });

  it("leaves a mandate debit on the merchant's offsets", () => {
    const p = planFailureRearm({
      ...base,
      declineCode: "insufficient_funds",
      mandateRail: "upi",
    });
    expect(retryAt(p)).toBe(nextRetryAt(1, base.now, [1, 3, 5, 7], base.dueDate)!.toISOString());
  });

  it("changes nothing when the business has not opted in, or is in fixed mode", () => {
    const offsets = nextRetryAt(1, base.now, [1, 3, 5, 7], base.dueDate)!.toISOString();
    expect(
      retryAt(
        planFailureRearm({ ...base, adaptiveTiming: false, declineCode: "insufficient_funds" }),
      ),
    ).toBe(offsets);
    expect(
      retryAt(planFailureRearm({ ...base, mode: "fixed", declineCode: "insufficient_funds" })),
    ).toBe(offsets);
  });

  it("keeps the merchant's offsets for a code with no adaptive class", () => {
    expect(retryAt(planFailureRearm({ ...base, declineCode: "something_new" }))).toBe(
      nextRetryAt(1, base.now, [1, 3, 5, 7], base.dueDate)!.toISOString(),
    );
  });

  it("a generic refusal retries three times, then parks", () => {
    for (const n of [1, 2, 3])
      expect(
        planFailureRearm({ ...base, declineCode: "card_declined", newAttemptCount: n }).action,
      ).toBe("retry");
    expect(
      planFailureRearm({ ...base, declineCode: "card_declined", newAttemptCount: 4 }).action,
    ).toBe("parked");
  });

  it("exhausts insufficient funds once its retries are spent", () => {
    expect(
      planFailureRearm({
        ...base,
        declineCode: "insufficient_funds",
        newAttemptCount: FUNDS_MAX_RETRIES + 1,
      }).action,
    ).toBe("exhausted");
  });

  it("still honours the business's dunning period", () => {
    const deadline = at("2026-09-27T00:00:00Z");
    const p = planFailureRearm({
      ...base,
      declineCode: "insufficient_funds",
      periodEndsAt: deadline,
    });
    expect(retryAt(p)).toBe(deadline.toISOString());
  });
});

describe("retryZoneFor — the card's country, else the business's", () => {
  const sept = at("2026-09-25T12:00:00Z");
  const offsetHours = (zone: string) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
      })
        .formatToParts(sept)
        .filter((x) => x.type !== "literal")
        .map((x) => [x.type, Number(x.value)]),
    ) as Record<string, number>;
    return (Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!) - sept.getTime()) / 3_600_000;
  };

  it("uses a single-zone issuer country outright", () => {
    expect(
      retryZoneFor({ issuerZones: GEO_ZONES.GB, businessTimezone: "Asia/Kolkata", at: sept }),
    ).toBe("Europe/London");
    expect(retryZoneFor({ issuerZones: GEO_ZONES.IN, businessTimezone: "UTC", at: sept })).toBe(
      "Asia/Kolkata",
    );
  });

  it("keeps the business's zone when a multi-zone country shares its clock", () => {
    expect(
      retryZoneFor({ issuerZones: GEO_ZONES.US, businessTimezone: "America/New_York", at: sept }),
    ).toBe("America/New_York");
  });

  it("otherwise picks the middle of the country's offsets", () => {
    const zone = retryZoneFor({
      issuerZones: GEO_ZONES.US,
      businessTimezone: "Asia/Kolkata",
      at: sept,
    });
    expect(GEO_ZONES.US).toContain(zone);
    // Between Eastern and Pacific daylight time, not Hawaii or Adak.
    expect(offsetHours(zone)).toBeGreaterThanOrEqual(-7);
    expect(offsetHours(zone)).toBeLessThanOrEqual(-4);
  });

  it("falls back to the business when the country's zones are unknown", () => {
    for (const zones of [null, undefined, [], GEO_ZONES.ZZ])
      expect(retryZoneFor({ issuerZones: zones, businessTimezone: "Asia/Kolkata", at: sept })).toBe(
        "Asia/Kolkata",
      );
  });

  it("the seed carries a timezone for every country", () => {
    const codes = Object.keys(GEO_ZONES);
    expect(codes.length).toBeGreaterThan(240);
    expect(codes.filter((c) => !GEO_ZONES[c]?.length)).toEqual([]);
  });

  it("lands a UK card's retry at 10:00 London for an Indian business", () => {
    expect(
      adaptiveNextRetryAt({
        retryClass: "generic",
        retryNumber: 1,
        now: sept,
        dueDate: sept,
        timezone: "Asia/Kolkata",
        issuerZones: GEO_ZONES.GB,
      })?.toISOString(),
    ).toBe("2026-09-27T09:00:00.000Z");
  });
});

describe("network-stated waits", () => {
  it("reads a Mastercard 'retry after' advice code, and only on Mastercard", () => {
    const mc = normalizeStripeDecline({
      code: "card_declined",
      recommendationCode: "25",
      cardBrand: "mastercard",
    });
    expect(mc.code).toBe("card_declined");
    expect(mc.retryAfterMs).toBe(24 * 3_600_000);
    expect(
      normalizeStripeDecline({
        code: "card_declined",
        recommendationCode: "30",
        cardBrand: "mastercard",
      }).retryAfterMs,
    ).toBe(240 * 3_600_000);
    expect(
      normalizeStripeDecline({ code: "card_declined", recommendationCode: "25", cardBrand: "visa" })
        .retryAfterMs,
    ).toBeUndefined();
    expect(
      normalizeStripeDecline({
        code: "card_declined",
        recommendationCode: "02",
        cardBrand: "mastercard",
      }).retryAfterMs,
    ).toBeUndefined();
  });

  it("reads RazorPay's duplicate_request as a 30-minute wait", () => {
    expect(normalizeRazorpayDecline("duplicate_request").retryAfterMs).toBe(30 * 60_000);
    expect(normalizeRazorpayDecline("insufficient_funds").retryAfterMs).toBeUndefined();
  });

  it("floors the next attempt in both modes, and never pulls it earlier", () => {
    const base = {
      dunningStatus: "in_progress",
      currentNextAttemptAt: null,
      autoCollectOn: true,
      retriable: true,
      newAttemptCount: 1,
      retryDays: [1, 3, 5, 7],
      now: at("2026-09-25T00:00:00Z"),
      dueDate: at("2026-09-25T00:00:00Z"),
      declineCode: "insufficient_funds",
    };
    for (const mode of ["fixed", "smart"] as const) {
      const late = planFailureRearm({ ...base, mode, networkRetryAfterMs: 240 * 3_600_000 });
      expect(late.action === "retry" && late.nextAttempt.toISOString()).toBe(
        "2026-10-05T00:00:00.000Z",
      );
      const early = planFailureRearm({ ...base, mode, networkRetryAfterMs: 3_600_000 });
      expect(early.action === "retry" && early.nextAttempt.toISOString()).toBe(
        "2026-09-26T00:00:00.000Z",
      );
    }
  });
});

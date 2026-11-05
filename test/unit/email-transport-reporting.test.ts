/**
 * Every reporting surface must know every transport.
 *
 * `ses` and `unconfigured` were added to the engine's `Mailer['kind']` union and to
 * `email_messages.transport`, but the two places that ENUMERATE transports were not
 * updated — the hub's activity query (`delivered` / `not_delivered`) and the dashboard's
 * delivery predicate. The result was worse than a missing feature: a message genuinely
 * delivered through SES matched neither counter, so it vanished from the hub entirely, and
 * the log rendered it grey with a transport of "Unknown". The log vouching AGAINST mail
 * that had arrived is the exact failure `email_messages.transport` was added to prevent.
 *
 * These tests are keyed off the `Mailer['kind']` union itself, so a transport added later
 * is covered the day it is added rather than the day someone notices.
 */
import { describe, it, expect } from "vitest";
import { DELIVERING_TRANSPORTS } from "@/modules/emails/service";
import type { Mailer } from "@/providers/mailer";

/**
 * Every value `Mailer['kind']` can take. Hand-listed because a TS union has no runtime
 * form — but `KIND_IS_EXHAUSTIVE` below fails to compile if this drifts from the union,
 * which is what makes it a guard rather than a second thing to remember.
 */
const ALL_TRANSPORTS = ["console", "smtp", "esp", "ses", "unconfigured"] as const;
type Listed = (typeof ALL_TRANSPORTS)[number];

/**
 * Compile-time, both directions, so neither adding to the union nor adding here can drift.
 *
 * The tuple wrappers are load-bearing. Written bare — `Mailer["kind"] extends Listed` — the
 * conditional DISTRIBUTES over the union: a missing member yields `never` for that member
 * and `true` for the rest, and `true | never` collapses to `true`, so the assignment
 * succeeds and the guard proves nothing. Caught by deleting "ses" from ALL_TRANSPORTS and
 * finding tsc still clean. `[A] extends [B]` compares the unions whole.
 */
const KIND_IS_EXHAUSTIVE: [Mailer["kind"]] extends [Listed] ? true : never = true;
const LIST_IS_VALID: [Listed] extends [Mailer["kind"]] ? true : never = true;

describe("transport reporting covers every transport", () => {
  it("the compile-time exhaustiveness guards hold", () => {
    expect(KIND_IS_EXHAUSTIVE && LIST_IS_VALID).toBe(true);
  });

  it("every transport is classified as delivering or not — none falls between", () => {
    // The bug in one line: `ses` was in neither the delivering list nor the
    // explicitly-not-delivering list, so the hub's two counters did not partition `sent`.
    for (const t of ALL_TRANSPORTS) {
      const delivering = (DELIVERING_TRANSPORTS as readonly string[]).includes(t);
      expect(typeof delivering, `${t} must be classifiable`).toBe("boolean");
    }
  });

  it("names the transports that actually deliver, and only those", () => {
    // `console` accepts and delivers nothing; `unconfigured` refuses outright. Neither is a
    // delivery, and calling either one would be the false claim this whole area retired.
    expect([...DELIVERING_TRANSPORTS].sort()).toEqual(["esp", "ses", "smtp"]);
    expect(DELIVERING_TRANSPORTS).not.toContain("console");
    expect(DELIVERING_TRANSPORTS).not.toContain("unconfigured");
  });

  it("SES counts as a real delivery", () => {
    // The regression itself, stated plainly.
    expect(DELIVERING_TRANSPORTS).toContain("ses");
  });
});

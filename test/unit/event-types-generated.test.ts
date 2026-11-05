import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EVENT_TYPES } from "@/modules/events/registry";
import { OUT_PATH, renderEventTypes } from "../../scripts/gen-event-types";

/**
 * The dashboard's event-type list was hand-copied from the registry behind a
 * "keep in sync" comment. It drifted 20 types behind — the six dispute events,
 * `refund_settled`, `payment_authentication_required`,
 * `subscription_pre_debit_notification` and the payment-attempt/intent additions —
 * and the two pickers it feeds could not offer an event the engine emits.
 *
 * Adding an event type is now a two-file change: register it, then
 * `pnpm gen:event-types`. This test is what says so.
 */
describe("dashboard event-type registry copy", () => {
  it("matches what pnpm gen:event-types would write", () => {
    expect(readFileSync(OUT_PATH, "utf8")).toBe(renderEventTypes());
  });

  it("offers every type the engine can emit", () => {
    const committed = new Set(
      [...readFileSync(OUT_PATH, "utf8").matchAll(/^ {2}"([a-z0-9_]+)",$/gm)].map((m) => m[1]),
    );
    expect([...EVENT_TYPES].filter((t) => !committed.has(t))).toEqual([]);
  });
});

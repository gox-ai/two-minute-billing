import { describe, expect, it } from "vitest";
import { topupLeadInputs } from "../../dashboard/lib/topup-lead";

describe("automatic top-up form: lead-time inputs", () => {
  it("come from the saved config's lead_time, so the form warns before a save", () => {
    expect(
      topupLeadInputs({ lead_time: { lead_hours: 26, burn_minor_per_day: 24_000 } }, 5),
    ).toEqual({ leadHours: 26, burnPerDay: 24_000 });
  });
  it("fall back to the runway's burn and no lead when nothing is saved", () => {
    expect(topupLeadInputs(null, 1_200)).toEqual({ leadHours: null, burnPerDay: 1_200 });
  });
});

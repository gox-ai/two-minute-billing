import { describe, expect, it } from "vitest";
import { churnKindOf } from "@/modules/metrics/cancellations";

describe("churned MRR splits the way the Cancellations report does", () => {
  it("payment failure, a missing payment method and a chargeback are involuntary", () => {
    expect(churnKindOf("not_paid")).toBe("involuntary");
    expect(churnKindOf("no_card")).toBe("involuntary");
    expect(churnKindOf("Chargeback lost")).toBe("involuntary");
  });

  it("everything else is voluntary, a term that ran out included", () => {
    expect(churnKindOf(null)).toBe("voluntary");
    expect(churnKindOf("billing_cycles_exhausted")).toBe("voluntary");
    expect(churnKindOf("Pricing was high")).toBe("voluntary");
  });
});

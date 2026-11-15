import { describe, expect, it } from "vitest";
import { embeddingCostFixed12 } from "@/modules/assistant-docs/embed-cost";
import { fixed12ToCents } from "@/modules/assistant/allowance";
import { tokensCostFixed12, type ListPriceHit } from "@/modules/model-prices/resolve";

// $0.02 per 1M input tokens: 2 cents (× 10^12) per 1,000,000.
const price: ListPriceHit = {
  kind: "list",
  id: "00000000-0000-7000-8000-000000000001",
  publicId: "mpr_XXXXXXXXXXXX01",
  provider: "openai",
  model: "text-embedding-3-small",
  tokenType: "input",
  unit: "token",
  quality: "",
  resolution: "",
  currency: "USD",
  unitAmount: 2n * 10n ** 12n,
  quantityDivisor: 1_000_000n,
  effectiveFrom: null,
  source: "genai-prices",
  sourceVersion: null,
  sourceEffectiveFrom: null,
};

describe("embedding cost", () => {
  it("prices tokens at the list price, in Fixed12 cents", () => {
    expect(tokensCostFixed12(1_000_000, price)).toBe(2n * 10n ** 12n);
    expect(embeddingCostFixed12(1_000_000, price)).toBe("2000000000000");
    expect(fixed12ToCents(embeddingCostFixed12(1_000_000, price))).toBe(2);
  });

  it("keeps a search query's fraction of a cent", () => {
    // 12 tokens = 0.000024 cents.
    expect(embeddingCostFixed12(12, price)).toBe("24000000");
    expect(fixed12ToCents(embeddingCostFixed12(12, price))).toBeCloseTo(0.000024, 12);
  });

  it("a full index run (~800k tokens) costs 1.6 cents", () => {
    expect(fixed12ToCents(embeddingCostFixed12(800_000, price))).toBeCloseTo(1.6, 10);
  });

  it("is null when the model has no price, never zero", () => {
    expect(embeddingCostFixed12(1_000, { kind: null, reason: "not_found" })).toBeNull();
  });

  it("truncates, as the chat usage record does", () => {
    const odd = { unitAmount: 1n, quantityDivisor: 3n };
    expect(tokensCostFixed12(2, odd)).toBe(0n);
    expect(tokensCostFixed12(3, odd)).toBe(1n);
  });
});

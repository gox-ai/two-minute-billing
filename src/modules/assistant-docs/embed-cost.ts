/** Pricing of embedding calls (pure). */
import { tokensCostFixed12, type ListPriceResult } from "@/modules/model-prices/resolve";

export const EMBED_PROVIDER = "openai";
export const EMBED_MODEL = "text-embedding-3-small";

/** Fixed12 USD minor units at the list price, as numeric text; null when the model is unpriced. */
export function embeddingCostFixed12(tokens: number, price: ListPriceResult): string | null {
  return price.kind === "list" ? String(tokensCostFixed12(tokens, price)) : null;
}

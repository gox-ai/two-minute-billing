/**
 * Billy's included use per Cloud plan, in credits (1 credit ≈ 1 question), from the same
 * catalogue as /pricing. Copy never types the numbers: with none in the catalogue, callers fall
 * back to wording without figures.
 */

/** "50 credits", "1,000 credits". */
export function formatCredits(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "credit" : "credits"}`;
}

export interface AssistantUse {
  plan: string;
  credits: number;
  /** formatCredits(credits) */
  amount: string;
}

/**
 * Free first, then the paid plans by price, in the visitor's currency. All plans or none: a
 * partial list would read as if a plan had no Billy.
 */
export async function useAssistantUse(
  key: "plans" | "plans-visitor" = "plans",
): Promise<ComputedRef<AssistantUse[]>> {
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- a Nuxt composable, not a React hook
  const { data } = await useFetch("/api/plans", { key });
  return computed(() => {
    const cur = data.value?.preferred;
    const free = (data.value?.free ?? []).filter((p) => p.currency === cur);
    const paid = (data.value?.plans ?? []).filter(
      (p) => p.currency === cur && p.interval === "month" && p.amountMinor > 0,
    );
    const rows = [...free, ...paid].map((p) => ({ plan: p.name, credits: p.assistantCredits }));
    // A price without the amount (or with 0) reads as "Billy included", never "0 credits".
    if (!rows.length || rows.some((r) => !r.credits)) return [];
    return rows.map((r) => ({
      plan: r.plan,
      credits: r.credits!,
      amount: formatCredits(r.credits!),
    }));
  });
}

/** "50 credits on Free, 300 on Launch, 1,000 on Growth and 3,000 on Scale". */
export function listAssistantUse(rows: AssistantUse[]): string {
  const parts = rows.map((r, i) =>
    i === 0 ? `${r.amount} on ${r.plan}` : `${r.credits.toLocaleString("en-US")} on ${r.plan}`,
  );
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts.join("");
}

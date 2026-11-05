/**
 * How the subscription change screen uses the plan-change policy that comes back with
 * each estimate. Pure, so the rules are testable outside React.
 */

/**
 * The identity of an edit: the items, plus whatever else the estimate is priced from
 * (`extra`: the timing, the prorate sent, the term reset). A new key invalidates the
 * answer to the last.
 */
export const changeEditKey = (
  changes: unknown,
  adds: unknown,
  removes: unknown,
  extra: unknown = null,
) => JSON.stringify([changes, adds, removes, extra]);

/**
 * Whether the screen may submit line work: only once the estimate for THIS edit came back
 * (with a policy, or with an error). A policy from an earlier edit may be for the other
 * direction.
 */
export function policyReady(input: {
  hasLineWork: boolean;
  reactivating: boolean;
  /** The edit the last estimate answered; null while none has. */
  answeredKey: string | null;
  editKey: string;
}): boolean {
  if (!input.hasLineWork || input.reactivating) return true;
  return input.answeredKey === input.editKey;
}

/**
 * The `prorate` the apply sends: only the operator's own choice. Untouched, the server
 * resolves the business rule for the direction it computes, which is what the estimate
 * showed.
 */
export function prorateToSend(applies: boolean, choice: boolean | null): boolean | undefined {
  return applies && choice !== null ? choice : undefined;
}

/**
 * The portal's "Now" hint: what a change applied now does with money. Built from what the
 * change books: `prorate` covers the items that change, and an added or removed item is
 * always prorated. Never more than that.
 */
export function portalNowHint(p: {
  direction: "upgrade" | "downgrade" | "same";
  prorate: boolean;
  invoice_immediately: boolean;
  adds_items: boolean;
  removes_items: boolean;
}): string {
  const out = ["The change starts now."];
  if (p.prorate) {
    out.push(
      p.direction === "downgrade"
        ? "You get a credit for the unused part of this period. The price shows the result."
        : p.invoice_immediately
          ? "You pay the prorated difference for the rest of this period today."
          : "We add the prorated difference for the rest of this period to your next invoice.",
    );
    return out.join(" ");
  }
  if (p.adds_items)
    out.push(
      p.invoice_immediately
        ? "You pay a prorated amount today for each add-on that you add."
        : "We add a prorated amount for each add-on that you add to your next invoice.",
    );
  if (p.removes_items)
    out.push("You get a credit for the unused part of each add-on that you remove.");
  out.push(
    p.adds_items || p.removes_items
      ? "We do not prorate the other changes."
      : p.direction === "downgrade"
        ? "You get no credit for the rest of this period."
        : "We do not charge a prorated amount for the rest of this period.",
  );
  return out.join(" ");
}

/**
 * What of Billy's work reaches the member's browser. Research — searching the help, finding a
 * screen, checking the source, reading the API reference — is how Billy answers, not part of
 * the answer: it is never streamed or returned (owner, 2026-11-09). Raw tool output is sent
 * only for tools the panel draws as a record card. The stored message keeps everything, so a
 * conversation can still be investigated.
 */

/** Tools whose steps and output never leave the server. */
export const QUIET_TOOLS: ReadonlySet<string> = new Set([
  "search_docs",
  "find_screen",
  "search_source",
  "get_api_reference",
  "research",
]);

/** Tools whose output the panel draws as a card (`dashboard/components/assistant/tool-data.tsx`). */
export const CARD_TOOLS: ReadonlySet<string> = new Set([
  "get_invoice",
  "get_customer",
  "get_subscription",
  "list_invoices",
  "list_subscriptions",
  "list_payments",
  "search_customers",
  "get_payment_attempts",
  "explain_invoice",
  "explain_mrr_change",
  "get_metrics",
  "query_records",
  "get_catalog",
  "get_upcoming_charges",
  "get_timeline",
  "get_collections_queue",
  "explain_payment",
  "explain_balance",
]);

type Named = { name?: string | null };

/**
 * The steps a member sees: everything but research and what was read before the model was
 * called (`prefetched`). A step without a name is kept.
 */
export const memberSteps = <T extends Named & { prefetched?: boolean }>(
  steps: T[] | null | undefined,
): T[] => (steps ?? []).filter((s) => !s.prefetched && (!s.name || !QUIET_TOOLS.has(s.name)));

/** The tool output a member's browser receives: only what is drawn as a card. */
export const memberData = <T extends Named>(data: T[] | null | undefined): T[] =>
  (data ?? []).filter((d) => !!d.name && CARD_TOOLS.has(d.name));

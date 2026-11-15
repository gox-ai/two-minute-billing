/**
 * What a support request carries besides the member's words (pure). The assistant drafts it
 * from what the turn already knows; the member sees every item on the card and can remove any
 * of them before Send. Only what the member can already see goes in, and every text passes the
 * secret guard (`leaks.ts`).
 */
import { redactSecrets } from "./leaks";

export type SupportItemKind = "page" | "record" | "error" | "conversation" | "browser";

export interface SupportItem {
  /** Stable within one draft: what the member's "remove" names. */
  key: string;
  kind: SupportItemKind;
  /** What the card shows, e.g. "Subscription sub_…". */
  label: string;
  /** The detail staff read: a path, an id, an error. */
  value: string;
}

export type SupportReason = "asked_for_person" | "cannot_answer" | "request_failed";

/**
 * Whether a failed tool call goes on the card. Only failures on our side do: a refused read
 * (a wrong id, a 404) or a bad argument is the assistant's own mistake, not something staff
 * can act on.
 */
export const failureIsOurs = (f: { toolError: boolean; status?: number }): boolean =>
  !f.toolError || (f.status ?? 0) >= 500;

export interface SupportDraft {
  id: string;
  subject: string;
  description: string;
  reason: SupportReason;
  items: SupportItem[];
  /** Set once the member sent it. */
  sent?: { id: string; reference: string; at: string } | null;
}

/** Record pages a request may point at, by id prefix: the API path the member's read uses. */
export const RECORD_KINDS: Array<{ prefix: string; type: string; noun: string; api: string }> = [
  { prefix: "inv_", type: "invoice", noun: "Invoice", api: "invoices" },
  { prefix: "cus_", type: "customer", noun: "Customer", api: "customers" },
  { prefix: "sub_", type: "subscription", noun: "Subscription", api: "subscriptions" },
  { prefix: "cn_", type: "credit_note", noun: "Credit note", api: "credit_notes" },
  { prefix: "txn_", type: "transaction", noun: "Transaction", api: "transactions" },
  { prefix: "pi_", type: "payment", noun: "Payment", api: "payment_intents" },
];

export const recordKindOf = (id: string) =>
  /^[A-Za-z0-9_-]{4,100}$/.test(id) ? RECORD_KINDS.find((k) => id.startsWith(k.prefix)) : undefined;

export const MAX_RECORDS = 8;
export const MAX_ERRORS = 3;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The reference a member and staff quote. */
export const supportReference = (n: number) => `SR-${n}`;

export function draftItems(input: {
  page: { path: string; screen: string | null } | null;
  /** Records the member's own reads returned, or their page and mentions, checked by the caller. */
  records: string[];
  failures: Array<{ what: string; error: string }>;
  conversationId: string | null;
  browser: string | null;
}): SupportItem[] {
  const items: SupportItem[] = [];
  if (input.page?.path) {
    const path = clip(input.page.path.split(/[?#]/)[0]!, 300);
    items.push({
      key: "page",
      kind: "page",
      label: `Page: ${input.page.screen ?? path}`,
      value: path,
    });
  }
  for (const id of [...new Set(input.records)].slice(0, MAX_RECORDS)) {
    const k = recordKindOf(id);
    if (!k) continue;
    items.push({ key: `record:${id}`, kind: "record", label: `${k.noun} ${id}`, value: id });
  }
  input.failures.slice(-MAX_ERRORS).forEach((f, i) => {
    const error = redactSecrets(clip(f.error, 500)).text;
    items.push({
      key: `error:${i}`,
      kind: "error",
      label: `Error: ${clip(error, 80)}`,
      value: `${clip(f.what, 200)}: ${error}`,
    });
  });
  if (input.conversationId)
    items.push({
      key: "conversation",
      kind: "conversation",
      label: "This conversation",
      value: input.conversationId,
    });
  if (input.browser)
    items.push({
      key: "browser",
      kind: "browser",
      label: `Browser: ${input.browser}`,
      value: input.browser,
    });
  return items;
}

/** The member's words, without credentials or card numbers. */
export function cleanText(text: string, max: number): string {
  return redactSecrets(text.replace(/\r\n/g, "\n").trim()).text.slice(0, max);
}

/** The items the member kept: removed keys dropped, nothing added. */
export function keptItems(items: SupportItem[], remove: string[]): SupportItem[] {
  const gone = new Set(remove);
  return items.filter((i) => !gone.has(i.key));
}

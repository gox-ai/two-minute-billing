/** Client-safe helpers shared by the assistant panel, its launchers and the palette. */

/** The assistant's name. Every user-visible mention reads it from here. */
export const ASSISTANT_NAME = "Billy";

export const ASSISTANT_EVENT = "tmb:assistant";
/** A record page announces its readable label ("INV-1043") for the panel's welcome line. */
export const ASSISTANT_RECORD_EVENT = "tmb:assistant-record";

const recordLabels = new Map<string, string>();
const recordStates = new Map<string, string>();
/** Remember how a record reads to a person; the panel may mount after the page announces it. */
export function rememberRecordLabel(id: string, label: string, state?: string): void {
  recordLabels.set(id, label);
  if (state) recordStates.set(id, state);
  else recordStates.delete(id);
  window.dispatchEvent(new CustomEvent(ASSISTANT_RECORD_EVENT, { detail: { id, label, state } }));
}
export const recordLabel = (id: string): string | undefined => recordLabels.get(id);
/** The short state a record page announced ("unpaid", "paid", "cancelled"), if any. */
export const recordState = (id: string): string | undefined => recordStates.get(id);

export interface RecordRef {
  type: string;
  id: string;
}

export interface OpenAssistantDetail {
  /** Send this question at once, in a new conversation. */
  ask?: string;
  /** Anchor the panel to this record (no question is sent). */
  record?: RecordRef & { label?: string };
}

/** Open the panel; with `ask`, also send that question; with `record`, anchor it. */
export function openAssistant(detail: OpenAssistantDetail = {}): void {
  window.dispatchEvent(new CustomEvent(ASSISTANT_EVENT, { detail }));
}

const RECORD_SEGMENTS: Record<string, string> = {
  invoices: "invoice",
  customers: "customer",
  subscriptions: "subscription",
  credit_notes: "credit note",
  transactions: "transaction",
  payment_intents: "payment",
};

export interface PageContext {
  path: string;
  record: RecordRef | null;
}

/**
 * Literal pages beside a record id under the record folders (`customers/new`). Every other
 * segment there is a record id, used AS-IS: an imported record keeps its source id, which
 * may have no `cus_`/`inv_` prefix. A unit test keeps this list in step with the routes.
 */
export const RECORD_FOLDER_PAGES = new Set(["new"]);
const RECORD_ID = /^[A-Za-z0-9_-]{2,100}$/;

/** The business and the record the member is looking at, from the URL. */
export function pageContextOf(pathname: string): { biz: string | null; page: PageContext } {
  const m = /^\/businesses\/([^/?#]+)(?:\/([^/?#]+)\/([^/?#]+))?/.exec(pathname);
  const type = m?.[2] ? RECORD_SEGMENTS[m[2]] : undefined;
  const id = m?.[3];
  const record =
    type && id && RECORD_ID.test(id) && !RECORD_FOLDER_PAGES.has(id) ? { type, id } : null;
  return { biz: m?.[1] ?? null, page: { path: pathname, record } };
}

const ID_ROUTES: Array<[RegExp, string]> = [
  [/^inv_/, "invoices"],
  [/^cus_/, "customers"],
  [/^sub_/, "subscriptions"],
  [/^cn_/, "credit_notes"],
  [/^txn_/, "transactions"],
  [/^pi_/, "payment_intents"],
];

/** Record folders by the API's `object` name, for an id whose prefix says nothing. */
export const RECORD_ROUTES: Record<string, string> = {
  invoice: "invoices",
  customer: "customers",
  subscription: "subscriptions",
  credit_note: "credit_notes",
  transaction: "transactions",
  payment_intent: "payment_intents",
};

/**
 * The dashboard page of a record id, or null for an id with no page. A prefixed id names its
 * own folder; an imported id (no prefix) needs `route`, the folder of the record it came from.
 */
export function recordHref(biz: string, id: string, route?: string | null): string | null {
  const hit = ID_ROUTES.find(([re]) => re.test(id));
  const folder = hit?.[1] ?? (route && RECORD_ID.test(id) ? route : null);
  return folder ? `/businesses/${biz}/${folder}/${id}` : null;
}

const PAYMENT_STARTERS = [
  "Explain this payment.",
  "Why did this payment fail?",
  "Was any of it refunded?",
];

export const STARTERS: Record<string, string[]> = {
  invoice: [
    "Explain this invoice.",
    "Why is this invoice unpaid?",
    "What changed from the last invoice?",
  ],
  customer: [
    "Summarize this customer.",
    "Why did their last payment fail?",
    "What credit do they have?",
  ],
  subscription: [
    "When does this subscription renew, and for how much?",
    "What would adding one more seat cost today?",
    "What happens to money if they cancel now?",
  ],
  payment: PAYMENT_STARTERS,
  transaction: PAYMENT_STARTERS,
  default: [
    "Why did MRR change in the last 30 days?",
    "Which customers have unpaid invoices?",
    "How do I pause dunning for one customer?",
  ],
};

const INVOICE_OWED = ["unpaid", "in_dunning"];

/** Starters for a record type, tuned to its state when the page announced one. */
export function startersFor(type: string, state?: string): string[] {
  const base = STARTERS[type] ?? STARTERS.default!;
  if (type === "invoice" && state) {
    if (INVOICE_OWED.includes(state))
      return ["Why is this invoice unpaid?", "What will dunning do next?", "Explain this invoice."];
    if (state === "paid")
      return [
        "Explain this invoice.",
        "Was any of it refunded?",
        "What changed from the last invoice?",
      ];
  }
  if (type === "customer" && state === "unpaid")
    return [
      "Why did their last payment fail?",
      "Summarize this customer.",
      "What credit do they have?",
    ];
  if (type === "subscription" && state === "cancelled")
    return [
      "Why did this subscription end?",
      "What was refunded or credited?",
      "How do I reactivate it?",
    ];
  return base;
}

// ── The tools menu: a task names the first tool of the next turn ─────────────────

export type AssistantTask = "explain_invoice" | "explain_mrr_change";

export const TASKS: Array<{ id: AssistantTask; label: string }> = [
  { id: "explain_invoice", label: "Explain an invoice" },
  { id: "explain_mrr_change", label: "Explain an MRR change" },
];

// ── Attachments ──────────────────────────────────────────────────────────────────

/** Screenshots only. The API checks the same list and size. */
export const ATTACHMENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** Images on one question; the API refuses more. */
export const ATTACHMENT_MAX_COUNT = 4;

export interface AttachmentRef {
  id: string;
  name: string;
  content_type: string;
  size: number;
}

// ── Mentions ─────────────────────────────────────────────────────────────────────

/** Records mentioned in one question; the API refuses more. */
export const MENTION_MAX = 5;

export interface MentionRef {
  type: "customer" | "invoice" | "subscription" | "credit_note" | "payment";
  id: string;
  label: string;
  detail?: string | null;
}

// ── Stream events and stored message extras (POST /auth/assistant/messages) ──────

export interface QuestionOption {
  label: string;
  detail?: string | null;
  default?: boolean;
}

export interface AssistantQuestion {
  id: string;
  text: string;
  hint?: string | null;
  input: "choice" | "amount" | "text";
  options: QuestionOption[];
  allow_other: boolean;
  step?: { index: number; total: number } | null;
}

export interface ProposalLine {
  label: string;
  value: string;
  /** An update: the value now. The line reads "before → value". */
  before?: string;
  /** The body key, when the member may change this field on the card before Confirm. */
  key?: string;
  /** The control that changes it; set together with `key`. */
  input?: ProposalLineInput;
}

/** How the card edits one field. The engine converts what the member types back to the body. */
export interface ProposalLineInput {
  kind: "text" | "number" | "amount" | "date" | "datetime" | "select" | "boolean";
  /** `select` (and the two sides of a `boolean`): each API value with its label. */
  options?: Array<{ value: string; label: string }>;
  /** `minor`: typed in major units. `bps`: typed as a percent. */
  unit?: "minor" | "bps";
  /** `amount`: the currency of the figure. */
  currency?: string;
  /** The value as the member types it (`datetime`: local time in the business's zone). */
  value: string | boolean;
}

export type ProposalStatus =
  | "proposed"
  | "confirmed"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "expired";

export interface AssistantProposal {
  id: string;
  operation: string;
  title: string;
  tier: 1 | 2 | 3;
  livemode: "live" | "test" | boolean;
  /** Unset on cards stored before 2026-11-10. */
  kind?: "create" | "update" | "command";
  /** An operation that takes no body: its effect, in one sentence. */
  sentence?: string | null;
  /** How many lines are fields, not the records the change acts on. */
  fields?: number;
  lines: ProposalLine[];
  preview_lines: ProposalLine[];
  /** An email change: the email itself, as the customer will read it. */
  email?: {
    type: string;
    to: string;
    cc: string[];
    subject: string;
    text: string;
    sent_at?: string | null;
    removed?: boolean;
    html?: string;
    note?: string | null;
  };
  /** Tier 3: the money movement, in words. Shown in the second confirmation. */
  money: string | null;
  expires_at: string;
  status: ProposalStatus;
  /** Once decided: what happened, and where to see it. */
  result?: { message: string; link: string | null } | null;
}

export interface ActionResult {
  status: "done" | "failed";
  message: string;
  link?: string | null;
  /** A portal link from the confirm response: shown once, never stored. */
  share?: { url: string; expires_at: string | null } | null;
}

/** "Show me": a screen to open and the controls to highlight, in order. */
export interface AssistantGuide {
  id: string;
  path: string;
  screen: string;
  steps: Array<{ control: string; within: string | null; say: string; do?: StepAction }>;
}

/** What the member does with a step's control; absent on guides saved before it existed. */
export type StepAction = "click" | "enter" | "select" | "submit";

export interface MessageExtras {
  suggestions?: string[];
  question?: AssistantQuestion;
  proposal?: AssistantProposal;
  attachments?: AttachmentRef[];
  guide?: AssistantGuide;
  support_draft?: SupportDraft;
}

// ── Support requests (Cloud) ─────────────────────────────────────────────────────

export interface SupportItem {
  key: string;
  kind: "page" | "record" | "error" | "conversation" | "browser";
  label: string;
}

/** A request Billy drafted. Nothing is sent until the member selects Send. */
export interface SupportDraft {
  id: string;
  subject: string;
  description: string;
  items: SupportItem[];
  sent?: { id: string; reference: string; at: string } | null;
}

export type SupportStatus = "open" | "waiting" | "resolved";

export interface SupportMessage {
  id: string;
  /** `support` is our staff, always signed with `author_name`; never a person. */
  author: "member" | "support" | "system";
  author_name: string | null;
  body: string;
  attachments: AttachmentRef[];
  created_at: string;
}

export interface SupportRequestView {
  id: string;
  reference: string;
  subject: string;
  status: SupportStatus;
  business: string;
  context: SupportItem[];
  unread: boolean;
  created_at: string;
  updated_at: string;
  messages?: SupportMessage[];
}

/** Open the panel at the support requests, or at one of them. */
export const SUPPORT_EVENT = "tmb:assistant-support";
export function openSupport(id?: string): void {
  window.dispatchEvent(new CustomEvent(SUPPORT_EVENT, { detail: { id: id ?? null } }));
}

export type FeedbackRating = "up" | "down";

export interface AllowanceView {
  used_percent: number;
  renews_at: string;
}

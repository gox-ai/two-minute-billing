/**
 * Changes Billy prepares and the member confirms (0508).
 *
 * Only operations on this allowlist can be proposed: everyday billing work, in three tiers.
 * Tier 3 moves money and needs both the owner's money switch and a second confirmation.
 * Deletes, payment methods, settings, team and keys are never here; neither is anything on MCP.
 *
 * What the member confirms is built from the stored request and the engine's own preview,
 * never from the model's words, and what runs is exactly that stored request: one call
 * through the same /v1 route the dashboard uses, with the member's session (so the route's
 * permission check applies), one idempotency key per proposal, and "via assistant" in the
 * audit trail.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { assistantActions, assistantMessages, businesses } from "@db/schema";
import type { PermissionKey } from "@/modules/auth/permissions";
import { ToolError } from "@/modules/assistant-tools/catalog";
import {
  callRoute,
  routeErrorMessage,
  VIA_ASSISTANT_HEADER,
  type CallerHeaders,
  type RouteResult,
} from "@/modules/assistant-tools/route-call";
import { ASSISTANT_NAME } from "./name";
import { apiOperation } from "@/modules/assistant-docs/search";
import {
  cachedGet,
  changeLines,
  coerceEdit,
  lookupNames,
  previewLines,
  requestLines,
  type Line,
  type LineContext,
  type LineInput,
} from "./action-lines";
import {
  UPDATE_READS,
  bodyError,
  withSchema,
  changedFields,
  effectSentence,
  opKind,
  type OpKind,
} from "./action-rules";
import { AdhocEmailError, previewAdhocEmail } from "@/modules/emails/adhoc-service";
import type { EmailType } from "@/modules/emails/config";

export type Tier = 1 | 2 | 3;
type Body = Record<string, unknown>;

interface ActionOp {
  title: string;
  perm: PermissionKey;
  tier: Tier | ((body: Body) => Tier);
  /** The engine's dry run for this change, relative to the business. */
  preview?: { path: string; body?: (body: Body) => Body };
  /** When to use it, for the model: listed after the operation. */
  use?: string;
  /** The card shows the email itself: one already sent (`message`) or the one to send (`adhoc`). */
  email?: "message" | "adhoc";
}

/** `METHOD path/{param}` → the operation. Path params are record ids. */
export const ACTION_OPS: Record<string, ActionOp> = {
  // ── Tier 1: no money moves ──────────────────────────────────────────────────
  "POST customers": { title: "Create a customer", perm: "customers:manage", tier: 1 },
  "PATCH customers/{cus}": { title: "Edit a customer", perm: "customers:manage", tier: 1 },
  "POST customers/{cus}/contacts": { title: "Add a contact", perm: "customers:manage", tier: 1 },
  "POST customers/{cus}/shipping_addresses": {
    title: "Add a shipping address",
    perm: "customers:manage",
    tier: 1,
  },
  "POST comments": { title: "Add a comment", perm: "comments:manage", tier: 1 },
  "PATCH customers/{cus}/contacts/{con}": {
    title: "Edit a contact",
    perm: "customers:manage",
    tier: 1,
  },
  "PATCH customers/{cus}/shipping_addresses/{addr}": {
    title: "Edit a shipping address",
    perm: "customers:manage",
    tier: 1,
  },
  "POST customers/{cus}/validate_vat": {
    title: "Check a VAT number",
    perm: "customers:manage",
    tier: 1,
    use: "checks the customer's stored VAT number with the tax authority",
  },
  "POST payment_requests/{preq}/cancel": {
    title: "Cancel a payment request",
    perm: "payments:collect",
    tier: 1,
    use: "withdraws a payment request so its pay link stops working",
  },
  "POST payment_links": {
    title: "Create a payment link",
    perm: "payments:collect",
    tier: 1,
    use: "a reusable checkout link for a plan or price, to share",
  },
  "POST customers/{cus}/portal_sessions": {
    title: "Create a customer portal link",
    perm: "customers:manage",
    tier: 1,
    use: "a sign-in link to the customer's portal; the member sees it once after Confirm, never you. action opens one page directly (for example the payment method); link_kind email lasts 5 days instead of 1 hour",
  },
  "POST emails/{email}/resend": {
    title: "Resend a billing email",
    perm: "emails:manage",
    tier: 1,
    use: "sends an email already sent again, unchanged; only when the member asks for that same email",
    email: "message",
  },
  "POST emails/send": {
    title: "Send a billing email",
    perm: "emails:manage",
    tier: 1,
    use: "a new email. type payment_method_request + customer asks the customer to update their payment method; invoice_sent or payment_request + invoice; credit_note_sent + credit_note; subscription_restart + subscription (an ended one; restart_price current or keep) sends a pay-first restart link. note: the reason in plain words",
    email: "adhoc",
  },
  "POST customers/{cus}/payment_requests": {
    title: "Send a payment request",
    perm: "payments:collect",
    tier: 1,
  },
  "POST payment_requests/{preq}/send": {
    title: "Email a payment request again",
    perm: "payments:collect",
    tier: 1,
  },
  "PATCH invoices/{inv}": { title: "Edit an invoice", perm: "invoices:manage", tier: 1 },
  "POST invoices/{inv}/pause_dunning": {
    title: "Pause dunning",
    perm: "invoices:manage",
    tier: 1,
  },
  "POST invoices/{inv}/resume_dunning": {
    title: "Resume dunning",
    perm: "invoices:manage",
    tier: 1,
  },
  "POST invoices/{inv}/stop_dunning": { title: "Stop dunning", perm: "invoices:manage", tier: 1 },
  "PATCH subscriptions/{sub}": {
    title: "Edit a subscription's settings",
    perm: "subscriptions:manage",
    tier: 1,
  },
  "POST subscriptions/{sub}/remove_scheduled_cancellation": {
    title: "Remove a scheduled cancellation",
    perm: "subscriptions:lifecycle",
    tier: 1,
  },
  "DELETE scheduled_changes/{sch}": {
    title: "Cancel a scheduled change",
    perm: "subscriptions:manage",
    tier: 1,
  },
  "POST subscriptions/{sub}/skip_renewal": {
    title: "Skip a renewal",
    perm: "subscriptions:lifecycle",
    tier: 1,
  },
  "POST subscriptions/{sub}/unskip_renewal": {
    title: "Undo a skipped renewal",
    perm: "subscriptions:lifecycle",
    tier: 1,
  },

  // ── Tier 2: changes what the customer is billed ─────────────────────────────
  "POST customers/{cus}/subscriptions": {
    title: "Create a subscription",
    perm: "subscriptions:manage",
    tier: 2,
    preview: { path: "customers/{cus}/subscription_estimate" },
  },
  "POST subscriptions/{sub}/change": {
    title: "Change a subscription",
    perm: "subscriptions:manage",
    tier: 2,
    preview: {
      path: "subscriptions/{sub}/estimate",
      // The estimate says when as `change_option`; the change says it as `timing`.
      body: (b) =>
        b.timing === "end_of_term" || b.timing === "now"
          ? { ...b, change_option: b.timing === "now" ? "immediately" : "end_of_term" }
          : b,
    },
  },
  "POST subscriptions/{sub}/items": {
    title: "Add an item",
    perm: "subscriptions:manage",
    tier: 2,
  },
  "DELETE subscriptions/{sub}/items/{item}": {
    title: "Remove an item",
    perm: "subscriptions:manage",
    tier: 2,
  },
  "POST subscriptions/{sub}/discount": {
    title: "Apply a coupon",
    perm: "subscriptions:manage",
    tier: 2,
  },
  "DELETE subscriptions/{sub}/discount": {
    title: "Remove the discount",
    perm: "subscriptions:manage",
    tier: 2,
  },
  "POST subscriptions/{sub}/manual_discount": {
    title: "Apply a manual discount",
    perm: "subscriptions:lifecycle",
    tier: 2,
  },
  "POST subscriptions/{sub}/pause": {
    title: "Pause a subscription",
    perm: "subscriptions:lifecycle",
    tier: 2,
  },
  "POST subscriptions/{sub}/resume": {
    title: "Resume a subscription",
    perm: "subscriptions:lifecycle",
    tier: 2,
  },
  "POST subscriptions/{sub}/reactivate": {
    title: "Reactivate a subscription",
    perm: "subscriptions:manage",
    tier: 2,
    preview: { path: "subscriptions/{sub}/reactivate_estimate" },
  },
  "POST subscriptions/{sub}/cancel": {
    title: "Cancel a subscription",
    perm: "subscriptions:lifecycle",
    // At the end of the term nothing moves now; any other cancel can credit or refund.
    tier: (b) => (b.cancel_option === "end_of_term" || b.at_period_end === true ? 2 : 3),
    preview: {
      path: "subscriptions/{sub}/cancel_estimate",
      body: ({ cancel_reason: _r, cancel_reason_code: _c, ...rest }) => rest,
    },
  },
  "POST subscriptions/{sub}/schedule": {
    title: "Schedule a change",
    perm: "subscriptions:manage",
    tier: 2,
  },
  "POST subscriptions/{sub}/edit_trial_end": {
    title: "Edit the trial end",
    perm: "subscriptions:lifecycle",
    tier: 2,
  },
  "POST subscriptions/{sub}/change_term_end": {
    title: "Change the term end",
    perm: "subscriptions:lifecycle",
    tier: 2,
  },
  "POST customers/{cus}/change_billing_date": {
    title: "Change the billing date",
    perm: "customers:manage",
    tier: 2,
  },
  "POST subscriptions/{sub}/charges": {
    title: "Add a charge",
    perm: "subscriptions:manage",
    // A charge invoiced now can be collected at once; one added to the next renewal cannot.
    tier: (b) => (b.invoice_now === true ? 3 : 2),
  },
  "POST customers/{cus}/credit_grants": {
    title: "Give promotional credit",
    perm: "credits:manage",
    tier: 2,
  },
  "DELETE unbilled_charges/{charge}": {
    title: "Remove a pending charge",
    perm: "usage:manage",
    tier: 2,
    use: "removes a charge that is not invoiced yet",
  },
  "DELETE usages/{usage}": {
    title: "Remove a usage record",
    perm: "usage:manage",
    tier: 2,
    use: "removes a usage record that is not billed yet",
  },
  "POST subscriptions/{sub}/usage": {
    title: "Record usage",
    perm: "usage:manage",
    tier: 2,
    use: "records metered usage on this subscription; it is billed on the next invoice",
  },
  "PATCH subscriptions/{sub}/items/{item}": {
    title: "Set a custom price on an item",
    perm: "subscriptions:manage",
    tier: 2,
    use: "sets this customer's own selling price on one subscription item",
  },
  "POST customers/{cus}/spend_limits": {
    title: "Add a spend limit",
    perm: "usage_controls:manage",
    tier: 2,
  },
  "PATCH customers/{cus}/spend_limits/{limit}": {
    title: "Change a spend limit",
    perm: "usage_controls:manage",
    tier: 2,
  },
  "PUT customers/{cus}/auto_topup": {
    title: "Set automatic top-up",
    perm: "usage_controls:manage",
    tier: 2,
    use: "sets the threshold and amount of the customer's automatic top-up",
  },
  "POST customers/{cus}/auto_topup/enable": {
    title: "Turn on automatic top-up",
    perm: "usage_controls:manage",
    tier: 2,
  },
  "POST customers/{cus}/auto_topup/disable": {
    title: "Turn off automatic top-up",
    perm: "usage_controls:manage",
    tier: 2,
  },
  "POST coupons": { title: "Create a coupon", perm: "coupons:manage", tier: 2 },
  "POST invoices": { title: "Create an invoice", perm: "invoices:manage", tier: 2 },

  // ── Tier 3: moves money ─────────────────────────────────────────────────────
  "POST payments/{pay}/refund": { title: "Refund a payment", perm: "payments:refund", tier: 3 },
  "POST credit_notes": { title: "Issue a credit note", perm: "credit_notes:manage", tier: 3 },
  "POST credit_notes/{cn}/refund": {
    title: "Refund a credit note",
    perm: "credit_notes:manage",
    tier: 3,
  },
  "POST invoices/{inv}/collect": {
    title: "Collect an invoice now",
    perm: "invoices:collect",
    tier: 3,
  },
  "POST invoices/{inv}/retry": { title: "Retry a payment", perm: "invoices:collect", tier: 3 },
  "POST customers/{cus}/collect_payment": {
    title: "Collect a payment",
    perm: "payments:collect",
    tier: 3,
  },
  "POST payment_requests/{preq}/charge": {
    title: "Charge a payment request",
    perm: "payments:collect",
    tier: 3,
  },
  "POST unbilled_charges/invoice_now": {
    title: "Invoice unbilled charges now",
    perm: "usage:manage",
    tier: 3,
    preview: { path: "unbilled_charges/invoice_now_estimate" },
  },
  "POST invoices/{inv}/apply_credits": {
    title: "Apply credits to an invoice",
    perm: "credit_notes:manage",
    tier: 3,
  },
  "POST invoices/{inv}/pay": {
    title: "Record an offline payment",
    perm: "payments:collect",
    tier: 3,
  },
  "POST invoices/{inv}/void": { title: "Void an invoice", perm: "invoices:void", tier: 3 },
  "POST invoices/{inv}/write_off": {
    title: "Write off an invoice",
    perm: "invoices:void",
    tier: 3,
  },
  "POST invoices/{inv}/close": {
    title: "Finalize an invoice",
    perm: "invoices:manage",
    tier: 3,
    use: "finalizes a pending invoice: applies discounts, tax and credits, then collects",
  },
  "POST invoices/{inv}/regenerate": {
    title: "Regenerate an invoice",
    perm: "invoices:manage",
    tier: 3,
    use: "creates a fresh invoice for the same period after the old one was voided",
  },
  "POST credit_notes/{cn}/void": {
    title: "Void a credit note",
    perm: "credit_notes:manage",
    tier: 3,
    use: "reverses a credit note that is not refunded or applied",
  },
  "POST credit_notes/{cn}/record_refund": {
    title: "Record an offline refund",
    perm: "credit_notes:manage",
    tier: 3,
    use: "records a refund paid outside the gateway (bank transfer, cash, cheque)",
  },
  "POST payment_requests/{preq}/record_payment": {
    title: "Record a payment on a payment request",
    perm: "payments:collect",
    tier: 3,
    use: "records an offline payment against a payment request",
  },
  "POST customers/{cus}/record_excess_payment": {
    title: "Record an excess payment",
    perm: "credits:manage",
    tier: 3,
    use: "records money received with no invoice to pay; it becomes customer credit",
  },
  "POST customers/{cus}/promotional_credits": {
    title: "Change the promotional credit balance",
    perm: "credits:manage",
    tier: 3,
    use: "adds to, deducts from or sets the balance; to give new credit with an expiry use credit_grants",
  },
  "POST customers/{cus}/credit_grants/{grant}/void": {
    title: "Void a credit grant",
    perm: "credits:manage",
    tier: 3,
    use: "takes back the unused part of a credit grant",
  },
  "POST customers/{cus}/wallet/topup": {
    title: "Top up a wallet",
    perm: "credits:manage",
    tier: 3,
    use: "paid charges the customer's card; granted adds free credit",
  },
};

const PROPOSAL_TTL_MS = 15 * 60_000;
const ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Where a record opens in the dashboard, by its path param. */
const RECORD_PAGES: Record<string, string> = {
  cus: "customers",
  sub: "subscriptions",
  inv: "invoices",
  cn: "credit_notes",
  preq: "payment_requests",
};
/** When to use an existing operation, where a near neighbour is easy to pick by mistake. */
const USE: Record<string, string> = {
  "POST customers/{cus}/credit_grants": "gives new promotional credit, optionally with an expiry",
  "POST invoices/{inv}/collect": "charges the saved payment method for this invoice now",
  "POST invoices/{inv}/retry": "the dunning retry now, for an invoice in dunning",
  "POST customers/{cus}/collect_payment":
    "charges an amount to pay down open invoices; any excess becomes credit",
  "POST invoices/{inv}/void": "cancels an invoice that should not exist; nothing stays owed",
  "POST invoices/{inv}/write_off":
    "keeps the invoice and stops collecting: the debt is written off",
  "POST invoices/{inv}/pay": "records a payment received outside the gateway",
  "POST payments/{pay}/refund": "refunds a payment through the gateway",
  "POST credit_notes/{cn}/refund": "refunds a credit note through the gateway",
  "POST subscriptions/{sub}/cancel": "ends the subscription, now or at the end of the term",
  "POST subscriptions/{sub}/pause": "stops billing for a time, then it resumes",
  "POST subscriptions/{sub}/skip_renewal": "skips one renewal only",
  "POST customers/{cus}/payment_requests":
    "a new payment request with a pay link for open invoices",
  "POST payment_requests/{preq}/send": "emails an existing payment request again",
  "POST subscriptions/{sub}/charges":
    "adds a one-off charge, invoiced now or with the next renewal",
  "POST unbilled_charges/invoice_now": "invoices the charges already pending, now",
};
for (const [k, use] of Object.entries(USE)) if (ACTION_OPS[k]) ACTION_OPS[k]!.use ??= use;

export function tierOf(operation: string, body: Body): Tier | null {
  const op = ACTION_OPS[operation];
  if (!op) return null;
  return typeof op.tier === "function" ? op.tier(body) : op.tier;
}

/** The operations a member may propose: their role allows it, and money only when switched on. */
export function allowedOperations(perms: ReadonlySet<string>, money: boolean): string[] {
  return Object.entries(ACTION_OPS)
    .filter(([, op]) => perms.has(op.perm))
    .filter(([, op]) => money || op.tier !== 3)
    .map(([k]) => k);
}

function fillPath(operation: string, params: Record<string, string>): string {
  const template = operation.slice(operation.indexOf(" ") + 1);
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = params[name];
    if (!v || !ID.test(v)) throw new ToolError(`Give path parameter "${name}" as a record id.`);
    return encodeURIComponent(v);
  });
}

// ── what the member reads ──────────────────────────────────────────────────────
// The card's wording lives in `action-lines.ts`.
export { previewLines, requestLines, type Line } from "./action-lines";

/** The one figure that says what money moves: the amount sent, else the preview's refund, credit or total. */
function moneyNotice(lines: Line[], preview: Line[], title: string): string {
  // Match the figure's own name (the last part of "Cancellation credit · Credit"), not its group.
  const pick = (re: RegExp) => preview.find((l) => re.test(l.label.split(" · ").at(-1)!));
  const hit =
    lines.find((l) => /^Amount/.test(l.label)) ??
    pick(/refund/i) ??
    pick(/credit/i) ??
    pick(/amount due/i) ??
    pick(/total/i);
  const name = hit?.label.split(" · ").at(-1)!.toLowerCase();
  // No non-zero figure in the preview: say what the change can do, not that money moves now.
  return hit ? `${title}. Money moves: ${name} ${hit.value}.` : `${title}. This can move money.`;
}

// ── propose ────────────────────────────────────────────────────────────────────

/** The email a card sends: as rendered for the customer. */
export interface EmailPreview {
  type: string;
  to: string;
  cc: string[];
  subject: string;
  text: string;
  /** A resend: when the original went out. */
  sent_at?: string | null;
  /** The stored body was deleted after its retention period. */
  removed?: boolean;
  /** The email as the customer sees it; links in it are shown, not followed. */
  html?: string;
  /** A new email: the member's covering note, which they may change before Confirm. */
  note?: string | null;
}

export interface ProposalView {
  id: string;
  operation: string;
  title: string;
  tier: Tier;
  livemode: "test" | "live";
  /** Unset on cards stored before 2026-11-10. */
  kind?: OpKind;
  /** An operation that takes no body: its effect, in one sentence. */
  sentence?: string | null;
  /** The lines that are fields, not the records the change acts on. */
  fields?: number;
  lines: Line[];
  preview_lines: Line[];
  email?: EmailPreview;
  money: string | null;
  expires_at: string;
  status: "proposed" | "running" | "done" | "failed" | "cancelled" | "expired";
  result?: { message: string; link: string | null };
  /** A portal link, in the confirm response only: never stored, never shown to the model. */
  share?: { url: string; expires_at: string | null };
}

/** The currency of the record a change names: its subscription, invoice, credit note, payment request or customer. */
const RECORD_PATH: Array<[string, string]> = [
  ["sub", "subscriptions"],
  ["inv", "invoices"],
  ["cn", "credit_notes"],
  ["preq", "payment_requests"],
  ["cus", "customers"],
];
async function recordCurrency(input: {
  params: Record<string, string>;
  get: (rel: string) => Promise<RouteResult>;
}): Promise<string | null> {
  for (const [param, path] of RECORD_PATH) {
    const id = input.params[param];
    if (!id) continue;
    const r = await input.get(`${path}/${encodeURIComponent(id)}`).catch(() => null);
    const b = r && r.status >= 200 && r.status < 300 ? (r.body as Record<string, unknown>) : null;
    const c = b?.currency ?? b?.effective_currency;
    if (typeof c === "string" && c) return c;
  }
  return null;
}

/**
 * Only the fields the preview route accepts. A change carries booking-only fields (invoicing,
 * charge-failure handling, a quote) that its estimate refuses as unknown, and one refused field
 * left the member with no card and no answer. Read from the API document, so a new operation
 * cannot repeat it.
 */
export function previewBody(previewPath: string, body: Body): Body {
  const op = apiOperation("POST", `/v1/businesses/{biz}/${previewPath}`) as {
    requestBody?: { content?: { "application/json"?: { schema?: { properties?: object } } } };
  } | null;
  const props = op?.requestBody?.content?.["application/json"]?.schema?.properties;
  if (!props) return body;
  return Object.fromEntries(Object.entries(body).filter(([k]) => k in props));
}

/** A card the engine refused: `message` for the model, `member` for the member editing it. */
class CardRefusal extends ToolError {
  constructor(
    message: string,
    readonly member: string,
  ) {
    super(message);
  }
}

/** The first sentence of a refusal written for the model: what is wrong, not what to do next. */
const firstSentence = (s: string) => /^.*?[.!?](\s|$)/.exec(s)?.[0].trim() ?? s;

type Built = Omit<ProposalView, "id" | "expires_at" | "status"> & { body: Body };

/**
 * The card for a request: the engine's checks, the dry run when the operation has one, the
 * email as rendered, and the lines. Shared by propose and by the member's edit, so an edited
 * card is held to the same checks as a new one.
 */
async function buildCard(input: {
  organizationId: string;
  businessId: string;
  business: { livemode: "test" | "live"; currency: string; timezone?: string | null };
  post: (rel: string, body: unknown) => Promise<RouteResult>;
  get: (rel: string) => Promise<RouteResult>;
  operation: string;
  params: Record<string, string>;
  body: Body;
}): Promise<Built> {
  const op = ACTION_OPS[input.operation]!;
  const tier = tierOf(input.operation, input.body)!;
  const refused = bodyError(input.operation, input.body);
  if (refused) throw new CardRefusal(withSchema(refused, input.operation), firstSentence(refused));
  const kind = opKind(input.operation);
  // Each record is read once for the currency and the names.
  const get = cachedGet(input.get);
  // An update sends only what changes, read from the record as the member sees it.
  let body = input.body;
  let before: Body = {};
  if (kind === "update") {
    const current = await currentRecord(input.operation, input.params, get);
    if (!current)
      throw new CardRefusal(
        "We could not read the record this change edits. Read it first, then propose the change again.",
        "We could not read the record this change edits.",
      );
    const d = changedFields(input.operation, input.body, current);
    if (!Object.keys(d.changed).length)
      throw new CardRefusal(
        `Nothing would change: the record already has these values (${d.unchanged.join(", ")}). Tell the member. Do not propose it again.`,
        "Nothing would change: the record already has these values.",
      );
    body = d.changed;
    before = d.before;
  }
  // Amounts in the record's own currency (an INR subscription in a USD business).
  const currency = (await recordCurrency({ params: input.params, get })) ?? input.business.currency;
  const { names, units } = await lookupNames(input.params, body, get);
  if (kind === "update") {
    const was = await lookupNames({}, before, get);
    for (const [k, v] of was.names) names.set(k, v);
    for (const [k, v] of was.units) units.set(k, v);
  }
  const ctx: LineContext = {
    currency,
    timezone: input.business.timezone,
    operation: input.operation,
    names,
    units,
  };
  let preview: Line[] = [];
  if (op.preview) {
    const previewPath = fillPath(`POST ${op.preview.path}`, input.params);
    const r = await input.post(
      previewPath,
      previewBody(op.preview.path, op.preview.body ? op.preview.body(body) : body),
    );
    if (r.status < 200 || r.status >= 300) {
      const reason = routeErrorMessage(r) ?? `status ${r.status}`;
      throw new CardRefusal(
        withSchema(
          `The engine refused the preview: ${reason}. Correct the request and try again.`,
          input.operation,
        ),
        reason,
      );
    }
    preview = previewLines(r.body, ctx);
  }
  const email = op.email ? await emailFor(op.email, { ...input, body, get }) : undefined;
  const lines = email
    ? // An email card: only its note changes, in the note box.
      [
        ...requestLines({}, { type: email.type }, ctx),
        ...requestLines(
          Object.fromEntries(Object.entries(input.params).filter(([k]) => k !== "email")),
          pick(body, ["customer", "invoice", "credit_note"]),
          ctx,
        ),
      ].map(({ key: _k, input: _i, ...l }) => l)
    : kind === "update"
      ? changeLines(input.params, body, before, ctx)
      : requestLines(input.params, body, ctx);
  const fields = email ? lines.length : lines.length - Object.keys(input.params).length;
  // A card with nothing to review never reaches the member.
  if ((kind === "create" || kind === "update") && fields <= 0) {
    const why = bodyError(input.operation, {}) ?? "This change has no details to show.";
    throw new CardRefusal(withSchema(why, input.operation), firstSentence(why));
  }
  return {
    body,
    operation: input.operation,
    title: op.title,
    tier,
    livemode: input.business.livemode,
    kind,
    sentence: effectSentence(input.operation, input.params, names, tier),
    fields,
    lines,
    preview_lines: preview,
    ...(email ? { email } : {}),
    money: tier === 3 ? moneyNotice(lines, preview, op.title) : null,
  };
}

export async function proposeAction(input: {
  organizationId: string;
  businessId: string;
  business: { id: string; livemode: "test" | "live"; currency: string; timezone?: string | null };
  userId: string;
  conversationId: string;
  permissions: ReadonlySet<string>;
  moneyEnabled: boolean;
  post: (rel: string, body: unknown) => Promise<RouteResult>;
  get: (rel: string) => Promise<RouteResult>;
  operation: string;
  params: Record<string, string>;
  body: Body;
  /** Checked just before the proposal is stored: a reason to refuse it, or null. */
  fit?: () => string | null;
  now?: Date;
}): Promise<ProposalView> {
  const op = ACTION_OPS[input.operation];
  if (!op) {
    throw new ToolError(
      `That change is not one ${ASSISTANT_NAME} can prepare. Tell the member where to do it in the dashboard (the screen and its link).`,
    );
  }
  if (!input.permissions.has(op.perm))
    throw new ToolError("The member's role cannot make this change. Say so.");
  const tier = tierOf(input.operation, input.body)!;
  if (tier === 3 && !input.moneyEnabled) {
    throw new ToolError(
      "Money changes are switched off for this organization. Tell the member where to do it in the dashboard (the screen and its link).",
    );
  }
  const method = methodOf(input.operation);
  const path = fillPath(input.operation, input.params);
  const { body, ...card } = await buildCard(input);
  const misfit = input.fit?.();
  if (misfit) throw new ToolError(misfit);
  const now = input.now ?? new Date();
  const id = publicId("aact");
  const view: ProposalView = {
    id,
    ...card,
    expires_at: new Date(now.getTime() + PROPOSAL_TTL_MS).toISOString(),
    status: "proposed",
  };
  await withTenant(input.organizationId, (tx) =>
    tx.insert(assistantActions).values({
      publicId: id,
      organizationId: input.organizationId,
      businessId: input.businessId,
      conversationId: input.conversationId,
      userId: input.userId,
      operation: input.operation,
      method,
      path,
      body: method === "DELETE" ? null : body,
      tier,
      status: "proposed",
      idempotencyKey: `assistant_${id}`,
      summary: view,
      expiresAt: new Date(view.expires_at),
    }),
  );
  return view;
}

const methodOf = (operation: string) =>
  operation.slice(0, operation.indexOf(" ")) as "POST" | "PATCH" | "PUT" | "DELETE";

/** The record ids a stored path names, by the operation's params. */
export function paramsOf(operation: string, path: string): Record<string, string> {
  const template = operation.slice(operation.indexOf(" ") + 1).split("/");
  const parts = path.split("/");
  const out: Record<string, string> = {};
  template.forEach((seg, i) => {
    const m = /^\{(\w+)\}$/.exec(seg);
    if (m && parts[i] !== undefined) out[m[1]!] = decodeURIComponent(parts[i]!);
  });
  return out;
}

/** The record an update changes, as the member reads it; null when it cannot be read. */
async function currentRecord(
  operation: string,
  params: Record<string, string>,
  get: (rel: string) => Promise<RouteResult>,
): Promise<Body | null> {
  const read = UPDATE_READS[operation];
  if (!read) return null;
  const r = await get(fillPath(`GET ${read.path}`, params)).catch(() => null);
  const b = r && r.status >= 200 && r.status < 300 ? (r.body as Body | null) : null;
  if (!b || typeof b !== "object" || !read.id) return b;
  const list = read.list ? b[read.list] : b.data;
  const want = params[read.id];
  return Array.isArray(list)
    ? ((list.find((x) => !!x && typeof x === "object" && (x as Body).id === want) as Body) ?? null)
    : null;
}

const pick = (b: Body, keys: string[]): Body =>
  Object.fromEntries(Object.entries(b).filter(([k]) => keys.includes(k)));
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The email the member approves, word for word: the stored one, or a render that sends nothing. */
async function emailFor(
  kind: "message" | "adhoc",
  input: {
    organizationId: string;
    businessId: string;
    params: Record<string, string>;
    body: Body;
    get: (rel: string) => Promise<RouteResult>;
  },
): Promise<EmailPreview> {
  if (kind === "message") {
    const r = await input.get(fillPath("GET emails/{email}", input.params));
    if (r.status !== 200)
      throw new ToolError(
        `We could not read that email: ${routeErrorMessage(r) ?? `status ${r.status}`}.`,
      );
    const m = r.body as Record<string, unknown>;
    return {
      type: String(m.type ?? ""),
      to: String(m.to ?? ""),
      cc: Array.isArray(m.cc) ? m.cc.map(String) : [],
      subject: String(m.subject ?? ""),
      text: m.body_removed_at ? "" : String(m.body_text ?? ""),
      html: m.body_removed_at ? "" : String(m.body_html ?? ""),
      sent_at: str(m.sent_at) ?? str(m.created_at),
      removed: !!m.body_removed_at,
    };
  }
  try {
    const note = str(input.body.note);
    const preview = await previewAdhocEmail(input.organizationId, input.businessId, {
      type: String(input.body.type ?? "") as EmailType,
      customerId: str(input.body.customer),
      invoiceId: str(input.body.invoice),
      creditNoteId: str(input.body.credit_note),
      to: str(input.body.to),
      note,
    });
    return { ...preview, note };
  } catch (e) {
    if (e instanceof AdhocEmailError)
      throw new ToolError(`${e.message} Correct the request and try again.`);
    throw e;
  }
}

const PORTAL_LINK = "POST customers/{cus}/portal_sessions";

// ── confirm / cancel ───────────────────────────────────────────────────────────

export class ActionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type ActionRow = typeof assistantActions.$inferSelect;

/**
 * Why a stored proposal cannot run, checked again at Confirm whatever the card showed: its
 * body misses what the operation needs, or a create or update has no field to review. Cards
 * stored before these checks existed are held to them too.
 */
export function storedRefusal(row: {
  operation: string;
  body: unknown;
  summary: unknown;
}): string | null {
  const msg = `We could not make this change. ${ASSISTANT_NAME} did not include the details it needs. Ask ${ASSISTANT_NAME} again with the details.`;
  if (!ACTION_OPS[row.operation]) return msg;
  if (bodyError(row.operation, (row.body ?? {}) as Body)) return msg;
  const kind = opKind(row.operation);
  if (kind === "create" || kind === "update") {
    const v = (row.summary ?? {}) as Partial<ProposalView>;
    const records = (row.operation.match(/\{\w+\}/g) ?? []).length;
    const fields = typeof v.fields === "number" ? v.fields : (v.lines?.length ?? 0) - records;
    if (fields <= 0) return msg;
  }
  return null;
}

async function loadOwn(organizationId: string, userId: string, id: string): Promise<ActionRow> {
  const [row] = await withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(assistantActions)
      .where(and(eq(assistantActions.publicId, id), eq(assistantActions.userId, userId))),
  );
  if (!row) throw new ActionError("We could not find this change.", 404);
  return row;
}

async function settle(
  organizationId: string,
  row: ActionRow,
  status: ProposalView["status"],
  result?: ProposalView["result"],
) {
  const view: ProposalView = {
    ...(row.summary as ProposalView),
    status,
    ...(result ? { result } : {}),
  };
  await withTenant(organizationId, async (tx) => {
    await tx
      .update(assistantActions)
      .set({ status, summary: view, result: result ?? null, decidedAt: new Date() })
      .where(eq(assistantActions.id, row.id));
    await storeCard(tx, organizationId, row.publicId, view);
  });
  return view;
}

/** The card in the conversation shows the latest state when the conversation is opened again. */
async function storeCard(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  organizationId: string,
  publicId: string,
  view: ProposalView,
) {
  await tx
    .update(assistantMessages)
    .set({
      extras: sql`jsonb_set(coalesce(${assistantMessages.extras}, '{}'::jsonb), '{proposal}', ${JSON.stringify(view)}::jsonb)`,
    })
    .where(
      and(
        eq(assistantMessages.organizationId, organizationId),
        sql`${assistantMessages.extras}->'proposal'->>'id' = ${publicId}`,
      ),
    );
}

/**
 * The member corrects a prepared change on its card before Confirm: the plain fields the card
 * offers (each line with a `key`), and the note of a new email. The edited request goes through
 * the same checks, dry run and email render as a new proposal; a refused edit changes nothing.
 * Confirm then runs exactly what the card shows.
 */
export async function editAction(input: {
  organizationId: string;
  userId: string;
  id: string;
  fields?: Record<string, unknown>;
  /** A new email: the covering note. */
  note?: string;
  moneyEnabled: boolean;
  /** Reads and dry runs through the /v1 routes as the member, relative to the business. */
  routes: (businessPublicId: string) => {
    get: (rel: string) => Promise<RouteResult>;
    post: (rel: string, body: unknown) => Promise<RouteResult>;
  };
  now?: Date;
}): Promise<ProposalView> {
  const row = await loadOwn(input.organizationId, input.userId, input.id);
  if (row.status !== "proposed" || row.expiresAt < (input.now ?? new Date()))
    throw new ActionError("You can change only a change that waits for your confirmation.", 409);
  const op = ACTION_OPS[row.operation];
  if (!op) throw new ActionError("We could not find this change.", 404);
  const view = row.summary as ProposalView;
  const fields: Record<string, unknown> = { ...input.fields };
  if (input.note !== undefined) {
    if (op.email !== "adhoc")
      throw new ActionError("You can change the note only on a new email.", 400);
    fields.note = input.note;
  }
  if (!Object.keys(fields).length) throw new ActionError("Change at least one field.", 400);

  const editable = new Map<string, { label: string; input: LineInput }>();
  for (const l of view.lines ?? [])
    if (l.key && l.input) editable.set(l.key, { label: l.label, input: l.input });
  if (op.email === "adhoc")
    editable.set("note", { label: "Note", input: { kind: "text", value: "" } });

  const [biz] = await withTenant(input.organizationId, (tx) =>
    tx
      .select({
        publicId: businesses.publicId,
        livemode: businesses.livemode,
        currency: businesses.defaultCurrency,
        timezone: businesses.timezone,
      })
      .from(businesses)
      .where(eq(businesses.id, row.businessId)),
  );
  if (!biz) throw new ActionError("We could not find this change.", 404);

  const stored = (row.body ?? {}) as Body;
  const body: Body = { ...stored };
  const kind = opKind(row.operation);
  for (const [key, raw] of Object.entries(fields)) {
    const e = editable.get(key);
    if (!e)
      throw new ActionError(
        `You cannot change "${key}" on this card. Ask ${ASSISTANT_NAME} to prepare the change again.`,
        400,
      );
    const c = coerceEdit(e.input, raw, stored[key], biz.timezone);
    if ("error" in c) throw new ActionError(`${c.error} for ${e.label}.`, 400);
    // A cleared text field: an update clears it on the record; a new record leaves it out.
    if (c.value === null && kind !== "update") delete body[key];
    else body[key] = c.value;
  }

  const routes = input.routes(biz.publicId);
  let card: Built;
  try {
    card = await buildCard({
      organizationId: input.organizationId,
      businessId: row.businessId,
      business: {
        livemode: biz.livemode as "test" | "live",
        currency: biz.currency,
        timezone: biz.timezone,
      },
      post: routes.post,
      get: routes.get,
      operation: row.operation,
      params: paramsOf(row.operation, row.path),
      body,
    });
  } catch (e) {
    if (e instanceof CardRefusal)
      throw new ActionError(`We could not save your changes. ${e.member}`, 422);
    if (e instanceof ToolError) throw new ActionError(e.message, 422);
    throw e;
  }
  const { body: next, ...rest } = card;
  // The stored body comes back from jsonb with its keys reordered: keep the card's own order.
  rest.lines = inPreviousOrder(view.lines ?? [], rest.lines);
  if (rest.tier === 3 && !input.moneyEnabled)
    throw new ActionError(
      `This change now moves money, and money changes are off for ${ASSISTANT_NAME}. Make this change in the dashboard.`,
      403,
    );
  const updated: ProposalView = { ...view, ...rest };
  if (!rest.email) delete updated.email;
  const saved = await withTenant(input.organizationId, async (tx) => {
    const done = await tx
      .update(assistantActions)
      .set({ body: row.method === "DELETE" ? null : next, tier: rest.tier, summary: updated })
      .where(and(eq(assistantActions.id, row.id), eq(assistantActions.status, "proposed")))
      .returning({ id: assistantActions.id });
    if (done.length) await storeCard(tx, input.organizationId, row.publicId, updated);
    return done.length > 0;
  });
  if (!saved)
    throw new ActionError("You can change only a change that waits for your confirmation.", 409);
  return updated;
}

/** `lines` in the order `previous` showed them (by key, else label); new lines last. */
export function inPreviousOrder(previous: Line[], lines: Line[]): Line[] {
  const at = new Map<string, number>();
  previous.forEach((l, i) => at.set(l.key ?? `label:${l.label}`, i));
  const rank = (l: Line) => at.get(l.key ?? `label:${l.label}`) ?? Number.MAX_SAFE_INTEGER;
  return [...lines].sort((a, b) => rank(a) - rank(b));
}

function recordLink(
  bizPublicId: string,
  operation: string,
  path: string,
  body: unknown,
): string | null {
  const template = operation.slice(operation.indexOf(" ") + 1).split("/");
  const parts = path.split("/");
  for (let i = 0; i < template.length; i++) {
    const m = /^\{(\w+)\}$/.exec(template[i]!);
    if (m && RECORD_PAGES[m[1]!])
      return `/businesses/${bizPublicId}/${RECORD_PAGES[m[1]!]}/${parts[i]}`;
  }
  // A created record: its own id, when the route returned one we can open.
  const created = body as { id?: unknown; object?: unknown } | null;
  const page = {
    customer: "customers",
    subscription: "subscriptions",
    invoice: "invoices",
    credit_note: "credit_notes",
  }[String(created?.object ?? "")];
  return page && typeof created?.id === "string"
    ? `/businesses/${bizPublicId}/${page}/${created.id}`
    : null;
}

export async function confirmAction(input: {
  app: FastifyInstance;
  organizationId: string;
  userId: string;
  id: string;
  confirmMoney: boolean;
  settings: { actions_enabled: boolean; money_actions_enabled: boolean };
  caller: CallerHeaders;
  now?: Date;
}): Promise<ProposalView> {
  const row = await loadOwn(input.organizationId, input.userId, input.id);
  const now = input.now ?? new Date();
  if (row.status !== "proposed")
    throw new ActionError("This change was already confirmed, cancelled or has expired.", 409);
  if (row.expiresAt < now) {
    await settle(input.organizationId, row, "expired");
    throw new ActionError("This change expired. Ask again to prepare it again.", 409);
  }
  const invalid = storedRefusal(row);
  if (invalid) {
    await settle(input.organizationId, row, "failed", { message: invalid, link: null });
    throw new ActionError(invalid, 422);
  }
  if (!input.settings.actions_enabled)
    throw new ActionError(
      `${ASSISTANT_NAME} cannot make changes in this organization. An owner can turn this on in Settings → ${ASSISTANT_NAME}.`,
      403,
    );
  if (row.tier === 3) {
    if (!input.settings.money_actions_enabled)
      throw new ActionError(
        `Money changes are off for ${ASSISTANT_NAME}. Make this change in the dashboard.`,
        403,
      );
    if (!input.confirmMoney)
      throw new ActionError("Confirm the money step to make this change.", 400);
  }
  // Claim it: two clicks cannot both run it.
  const claimed = await withTenant(input.organizationId, (tx) =>
    tx
      .update(assistantActions)
      .set({ status: "running" })
      .where(and(eq(assistantActions.id, row.id), eq(assistantActions.status, "proposed")))
      .returning({ id: assistantActions.id }),
  );
  if (!claimed.length) throw new ActionError("This change is already running.", 409);

  const title = (row.summary as ProposalView).title;
  const [biz] = await withTenant(input.organizationId, (tx) =>
    tx
      .select({ publicId: businesses.publicId })
      .from(businesses)
      .where(eq(businesses.id, row.businessId)),
  );
  const bizPublicId = biz!.publicId;
  const r = await callRoute(input.app, input.caller, {
    method: row.method as "POST" | "PATCH" | "PUT" | "DELETE",
    path: `/v1/businesses/${encodeURIComponent(bizPublicId)}/${row.path}`,
    ...(row.method === "DELETE" ? {} : { body: row.body ?? {} }),
    headers: { "idempotency-key": row.idempotencyKey, [VIA_ASSISTANT_HEADER]: "assistant" },
  });
  // An email the mail server refused comes back 200 with ok: false.
  const refused = (r.body as { ok?: unknown; error?: unknown } | null)?.ok === false;
  if (r.status >= 200 && r.status < 300 && !refused && row.operation === PORTAL_LINK) {
    // A single-use sign-in link: the member gets it once, in this response. We store only
    // that it was made, so it never reaches the history, the model or the database.
    const b = r.body as { url?: unknown; access_expires_at?: unknown } | null;
    const url = typeof b?.url === "string" ? b.url : null;
    const view = await settle(input.organizationId, row, "done", {
      message: url
        ? "Link created. Copy it now: it works one time, and we do not keep it."
        : "The link was created, but this installation has no portal address, so there is no link to show.",
      link: recordLink(bizPublicId, row.operation, row.path, r.body),
    });
    return url
      ? {
          ...view,
          share: {
            url,
            expires_at: typeof b?.access_expires_at === "string" ? b.access_expires_at : null,
          },
        }
      : view;
  }
  if (r.status >= 200 && r.status < 300 && !refused) {
    return settle(input.organizationId, row, "done", {
      message: `Done: ${title.toLowerCase()}.`,
      link: recordLink(bizPublicId, row.operation, row.path, r.body),
    });
  }
  const reason = refused
    ? String((r.body as { error?: unknown }).error ?? "The mail server refused the email.")
    : (routeErrorMessage(r) ?? `The API answered ${r.status}.`);
  return settle(input.organizationId, row, "failed", {
    message: `We could not ${title.charAt(0).toLowerCase()}${title.slice(1)}. ${reason}`,
    link: null,
  });
}

export async function cancelAction(
  organizationId: string,
  userId: string,
  id: string,
): Promise<ProposalView> {
  const row = await loadOwn(organizationId, userId, id);
  if (row.status !== "proposed")
    throw new ActionError("This change was already confirmed, cancelled or has expired.", 409);
  return settle(organizationId, row, "cancelled");
}

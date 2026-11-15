/**
 * What a change Billy prepares must carry before the member sees a Confirm button, and the
 * checks that tie it to what the member asked for. Pure: no reads, no writes.
 *
 *  - a create carries the fields that give the record a meaning (`requiredGroups`);
 *  - an update changes at least one field (the record is read and compared in `actions.ts`);
 *  - an operation in `NO_BODY_OPS` may run with an empty body, and the card says its effect;
 *  - the operation fits the Show me guide of the same turn (`fitError`).
 */
import { apiOperation } from "@/modules/assistant-docs/search";

type Body = Record<string, unknown>;

export type OpKind = "create" | "update" | "command";

/** POST operations that make a new record, and what they make. */
export const CREATES: Record<string, string> = {
  "POST customers": "customer",
  "POST customers/{cus}/contacts": "contact",
  "POST customers/{cus}/shipping_addresses": "shipping_address",
  "POST comments": "comment",
  "POST payment_links": "payment_link",
  "POST customers/{cus}/payment_requests": "payment_request",
  "POST customers/{cus}/subscriptions": "subscription",
  "POST subscriptions/{sub}/items": "subscription_item",
  "POST subscriptions/{sub}/charges": "charge",
  "POST customers/{cus}/credit_grants": "credit",
  "POST subscriptions/{sub}/usage": "usage",
  "POST customers/{cus}/spend_limits": "spend_limit",
  "POST coupons": "coupon",
  "POST invoices": "invoice",
  "POST credit_notes": "credit_note",
};

/**
 * MEANING_RULES: where the API document's `required` is too loose. Each group needs at least
 * one of its fields; the document's own `required` fields are added one per group.
 */
export const MEANING_RULES: Record<string, (b: Body) => string[][]> = {
  "POST customers": () => [["email", "first_name", "last_name", "company"]],
  "POST customers/{cus}/shipping_addresses": () => [["line1"]],
  "POST coupons": (b) => [b.kind === "fixed_amount" ? ["amount_off_minor"] : ["percent_off_bps"]],
  "POST subscriptions/{sub}/change": () => [
    [
      "changes",
      "adds",
      "removes",
      "coupon_code",
      "coupon_ids",
      "coupons",
      "manual_discount",
      "remove_discount",
      "reset_term",
    ],
  ],
  "POST subscriptions/{sub}/edit_trial_end": () => [["trial_end"]],
  "POST unbilled_charges/invoice_now": () => [["subscription", "customer"]],
};

/** Body shapes the API accepts but that cannot do what was asked: the reason, or null. */
const SHAPE_RULES: Record<string, (b: Body) => string | null> = {
  // A coupon for "each specified item" that names no item discounts nothing.
  "POST coupons": (b) => {
    if (b.apply_on !== "each_specified_item") return null;
    const list = Array.isArray(b.item_constraints) ? (b.item_constraints as Body[]) : [];
    return list.some((c) => c && (c.constraint_type === "all" || c.constraint_type === "specific"))
      ? null
      : 'apply_on "each_specified_item" needs item_constraints that name the items: item_kind plan, addon or charge, and constraint_type "all", or "specific" with the product_ids or price_ids you read. Read the prices first if you have not.';
  },
};

/**
 * Operations that may run with an empty body: each field has a default. The card says the
 * effect in one sentence; `{param}` reads as the record's name.
 */
export const NO_BODY_OPS: Record<string, string> = {
  "POST customers/{cus}/validate_vat": "Check the VAT number of customer {cus}.",
  "POST payment_requests/{preq}/cancel":
    "Cancel payment request {preq}. Its pay link stops working.",
  "POST customers/{cus}/portal_sessions": "Create a portal sign-in link for customer {cus}.",
  "POST emails/{email}/resend": "Send this email again, unchanged.",
  "POST payment_requests/{preq}/send": "Email payment request {preq} again.",
  "POST invoices/{inv}/resume_dunning": "Resume dunning on invoice {inv}.",
  "POST invoices/{inv}/stop_dunning": "Stop dunning on invoice {inv}.",
  "POST subscriptions/{sub}/remove_scheduled_cancellation":
    "Remove the scheduled cancellation of subscription {sub}.",
  "DELETE scheduled_changes/{sch}": "Cancel scheduled change {sch}.",
  "DELETE subscriptions/{sub}/items/{item}": "Remove item {item} from subscription {sub}.",
  "DELETE subscriptions/{sub}/discount": "Remove the discount from subscription {sub}.",
  "POST subscriptions/{sub}/pause": "Pause subscription {sub}.",
  "POST subscriptions/{sub}/resume": "Resume subscription {sub}.",
  "POST subscriptions/{sub}/reactivate": "Reactivate subscription {sub}.",
  "POST subscriptions/{sub}/cancel": "Cancel subscription {sub}.",
  "DELETE unbilled_charges/{charge}": "Remove pending charge {charge}.",
  "DELETE usages/{usage}": "Remove usage record {usage}.",
  "POST customers/{cus}/auto_topup/enable": "Turn on automatic top-up for customer {cus}.",
  "POST customers/{cus}/auto_topup/disable": "Turn off automatic top-up for customer {cus}.",
  "POST payments/{pay}/refund": "Refund payment {pay}.",
  "POST credit_notes/{cn}/refund": "Refund credit note {cn}.",
  "POST invoices/{inv}/collect": "Charge the saved payment method for invoice {inv} now.",
  "POST invoices/{inv}/retry": "Retry the payment of invoice {inv} now.",
  "POST customers/{cus}/collect_payment": "Charge customer {cus} for their open invoices.",
  "POST payment_requests/{preq}/charge": "Charge payment request {preq}.",
  "POST invoices/{inv}/apply_credits": "Apply credits to invoice {inv}.",
  "POST invoices/{inv}/pay": "Record an offline payment on invoice {inv}.",
  "POST invoices/{inv}/void": "Void invoice {inv}.",
  "POST invoices/{inv}/write_off": "Write off invoice {inv}.",
  "POST invoices/{inv}/close": "Finalize invoice {inv}.",
  "POST invoices/{inv}/regenerate": "Regenerate invoice {inv}.",
  "POST credit_notes/{cn}/void": "Void credit note {cn}.",
  "POST customers/{cus}/credit_grants/{grant}/void": "Void credit grant {grant}.",
};

/** Where an update reads the record it changes, and the read's name for a body field. */
export const UPDATE_READS: Record<
  string,
  { path: string; list?: string; id?: string; alias?: Record<string, string> }
> = {
  "PATCH customers/{cus}": { path: "customers/{cus}" },
  "PATCH customers/{cus}/contacts/{con}": { path: "customers/{cus}/contacts", id: "con" },
  "PATCH customers/{cus}/shipping_addresses/{addr}": {
    path: "customers/{cus}/shipping_addresses",
    id: "addr",
  },
  "PATCH invoices/{inv}": { path: "invoices/{inv}" },
  "PATCH subscriptions/{sub}": {
    path: "subscriptions/{sub}",
    alias: { payment_method: "default_payment_method" },
  },
  "PATCH subscriptions/{sub}/items/{item}": {
    path: "subscriptions/{sub}",
    list: "items",
    id: "item",
  },
  "PATCH customers/{cus}/spend_limits/{limit}": {
    path: "customers/{cus}/spend_limits",
    id: "limit",
  },
};

export function opKind(operation: string): OpKind {
  if (operation.startsWith("PATCH ")) return "update";
  return CREATES[operation] ? "create" : "command";
}

/** The `required` list of the operation's documented request body. */
export function documentedRequired(operation: string): string[] {
  const [method, path] = operation.split(" ");
  const op = apiOperation(method!, `/v1/businesses/{biz}/${path}`) as {
    requestBody?: { content?: { "application/json"?: { schema?: { required?: unknown } } } };
  } | null;
  const req = op?.requestBody?.content?.["application/json"]?.schema?.required;
  return Array.isArray(req) ? req.filter((k): k is string => typeof k === "string") : [];
}

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  oneOf?: Schema[];
  anyOf?: Schema[];
};

function typeText(s: Schema | undefined, depth: number): string {
  if (!s) return "any";
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join("|");
  const alt = s.oneOf ?? s.anyOf;
  if (alt) return alt.map((x) => typeText(x, depth)).join(" or ");
  const t = Array.isArray(s.type) ? s.type.filter((x) => x !== "null").join("|") : s.type;
  if (t === "array") return `[${typeText(s.items, depth)}]`;
  if (s.properties && depth < 2) {
    const req = new Set(s.required ?? []);
    return `{${Object.entries(s.properties)
      .map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${typeText(v, depth + 1)}`)
      .join(", ")}}`;
  }
  return t ?? "object";
}

/**
 * The operation's request body in one line, from the OpenAPI document: each field, `?` when
 * optional, its type or allowed values. Null when the operation has no documented body.
 */
export function compactSchema(operation: string): string | null {
  const [method, path] = operation.split(" ");
  const op = apiOperation(method!, `/v1/businesses/{biz}/${path}`) as {
    requestBody?: { content?: { "application/json"?: { schema?: Schema } } };
  } | null;
  const schema = op?.requestBody?.content?.["application/json"]?.schema;
  if (!schema?.properties) return null;
  return `${operation} body: ${typeText(schema, 0)}`.slice(0, 3000);
}

/** A refusal about the body, with the body's fields, so the next try can be right. */
export function withSchema(message: string, operation: string): string {
  const s = compactSchema(operation);
  return s ? `${message} ${s}` : message;
}

/** A value the member gave: not empty text, an empty list or an empty object. */
export function present(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

export function requiredGroups(operation: string, body: Body): string[][] {
  return [
    ...documentedRequired(operation).map((k) => [k]),
    ...(MEANING_RULES[operation]?.(body) ?? []),
  ];
}

/** The groups the body does not satisfy. */
export function missingGroups(operation: string, body: Body): string[][] {
  return requiredGroups(operation, body).filter((g) => !g.some((k) => present(body[k])));
}

const groupText = (g: string[]) => (g.length > 1 ? `one of ${g.join(", ")}` : g[0]!);

/**
 * Why this body cannot be proposed, written for the model; null when it can. An update is
 * compared with the record later; here it only has to send a field.
 */
export function bodyError(operation: string, body: Body): string | null {
  if (opKind(operation) === "update") {
    return Object.keys(body).length
      ? null
      : "This change sends no field. Ask the member what to change, then propose only those fields.";
  }
  const missing = missingGroups(operation, body);
  if (!missing.length) return SHAPE_RULES[operation]?.(body) ?? null;
  const list = missing.map(groupText).join(" and ");
  return `This change needs ${list}, and the request does not have it. Ask the member for it in one short question (for example: "What is the customer's email?"). Never fill in a value the member did not give.`;
}

// ── fit: the operation matches what was asked ──────────────────────────────────

/** Path segments and body keys that name a kind of record. */
const SEGMENT: Record<string, string> = {
  customers: "customer",
  contacts: "customer",
  shipping_addresses: "customer",
  coupons: "coupon",
  invoices: "invoice",
  subscriptions: "subscription",
  credit_notes: "credit_note",
  payment_links: "payment_link",
  payment_requests: "payment_request",
  payments: "payment",
  plans: "plan",
  prices: "plan",
  products: "plan",
  addons: "plan",
};
const BODY_REFS: Record<string, string> = {
  customer: "customer",
  invoice: "invoice",
  invoices: "invoice",
  invoice_ids: "invoice",
  subscription: "subscription",
  credit_note: "credit_note",
  price: "plan",
  prices: "plan",
  price_ids: "plan",
  product_ids: "plan",
  coupon_ids: "coupon",
  coupon_code: "coupon",
};

/** The kinds of record a guide's screen is about, from its path. */
export function guideKinds(path: string): Set<string> {
  return new Set(
    path
      .split(/[?#]/)[0]!
      .split("/")
      .map((s) => SEGMENT[s])
      .filter((k): k is string => !!k),
  );
}

/** The kinds of record an operation touches: its path, what it creates and the ids it sends. */
export function operationKinds(operation: string, body: Body): Set<string> {
  const out = new Set<string>();
  for (const s of operation.slice(operation.indexOf(" ") + 1).split("/"))
    if (SEGMENT[s]) out.add(SEGMENT[s]);
  if (CREATES[operation]) out.add(CREATES[operation]);
  for (const [k, kind] of Object.entries(BODY_REFS)) if (present(body[k])) out.add(kind);
  return out;
}

const KIND_WORD: Record<string, string> = {
  customer: "a customer",
  coupon: "a coupon",
  invoice: "an invoice",
  subscription: "a subscription",
  credit_note: "a credit note",
  payment_link: "a payment link",
  payment_request: "a payment request",
  plan: "a plan or price",
  payment: "a payment",
};

/**
 * Why the operation does not fit the turn, for the model; null when it fits or nothing is
 * known. Refuses only a clear mismatch: the Show me guide of this turn is about a different
 * kind of record. Read from structure (the guide's path, the operation, the ids it sends),
 * never from the member's wording: required fields and the confirm card cover the rest.
 */
export function fitError(a: {
  operation: string;
  body: Body;
  /** The path of the Show me guide in this turn, if any. */
  guidePath?: string | null;
  /** Operations this member may propose: the hint names only these. */
  allowed: string[];
}): string | null {
  const created = CREATES[a.operation];
  const hint = (kinds: Set<string>) => {
    const ops = a.allowed.filter((op) => CREATES[op] && kinds.has(CREATES[op]!));
    return ops.length ? ` The operation for that is ${ops.join(" or ")}.` : "";
  };
  if (a.guidePath && (created || /\/new$/.test(a.guidePath.split(/[?#]/)[0]!))) {
    const g = guideKinds(a.guidePath);
    const o = operationKinds(a.operation, a.body);
    if (g.size && o.size && ![...g].some((k) => o.has(k))) {
      const words = [...g].map((k) => KIND_WORD[k] ?? k).join(" or ");
      return `Wrong operation: the Show me guide in this answer is about ${words}, and ${a.operation} is not.${hint(g)} Propose the change that matches the guide, or ask the member.`;
    }
  }
  return null;
}

/** The card's sentence for an operation in `NO_BODY_OPS`, with each record by name. */
export function effectSentence(
  operation: string,
  params: Record<string, string>,
  names: ReadonlyMap<string, string> | undefined,
  tier: 1 | 2 | 3,
): string | null {
  const t = NO_BODY_OPS[operation];
  if (!t) return null;
  const s = t.replace(/\{(\w+)\}/g, (_m, p: string) => {
    const id = params[p];
    return id ? (names?.get(id) ?? id) : p;
  });
  return tier === 3 ? `${s} You cannot undo this.` : s;
}

// ── updates: drop what does not change ─────────────────────────────────────────

const isObj = (v: unknown): v is Body => !!v && typeof v === "object" && !Array.isArray(v);
const empty = (v: unknown) => !present(v) && typeof v !== "boolean" && typeof v !== "number";

function asInstant(v: unknown): number | null {
  if (typeof v === "number" && v > 1e8) return v < 1e11 ? v * 1000 : v;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** True when the record already has the value the body sends. */
export function sameValue(key: string, sent: unknown, current: unknown): boolean {
  if (empty(sent) && empty(current)) return true;
  if (empty(sent) !== empty(current)) return false;
  if (typeof sent === "string" && typeof current === "string") {
    const a = sent.trim();
    const b = current.trim();
    return /email/.test(key) ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
  const ta = asInstant(sent);
  const tb = asInstant(current);
  if (ta !== null && tb !== null) return ta === tb;
  if (typeof sent === "number" || typeof current === "number")
    return Number(sent) === Number(current);
  if (Array.isArray(sent) && Array.isArray(current)) {
    if (sent.length !== current.length) return false;
    if (sent.every((x) => !isObj(x)) && current.every((x) => !isObj(x))) {
      const a = sent.map(String).sort();
      const b = current.map(String).sort();
      return a.every((x, i) => x === b[i]);
    }
    return sent.every((x, i) => sameValue(key, x, current[i]));
  }
  if (isObj(sent) && isObj(current)) {
    const keys = new Set([...Object.keys(sent), ...Object.keys(current)]);
    return [...keys].every((k) => sameValue(k, sent[k], current[k]));
  }
  return sent === current;
}

/**
 * The fields that change the record, and the record's values for them. A field the read does
 * not show counts as a change, with no value before.
 */
export function changedFields(
  operation: string,
  body: Body,
  current: Body,
): { changed: Body; before: Body; unchanged: string[] } {
  const alias = UPDATE_READS[operation]?.alias ?? {};
  const changed: Body = {};
  const before: Body = {};
  const unchanged: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    const ck = alias[k] ?? k;
    if (ck in current && sameValue(k, v, current[ck])) {
      unchanged.push(k);
      continue;
    }
    changed[k] = v;
    if (ck in current) before[k] = current[ck];
  }
  return { changed, before, unchanged };
}

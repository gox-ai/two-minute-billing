/**
 * The words of every notification: bell row, push, email and Google Chat card, from one
 * source. Pure. In-app text, so ASD-STE100. Amounts carry their currency; dates use the
 * business timezone.
 */
import { currencyExponent, formatMoney } from "../../platform/currency";
import { escapeHtml } from "../emails/sanitize";
import { kindDef, type NotificationKind } from "./catalogue";

/** What the fan-out knows about one event. Dates are ISO strings (stored as jsonb). */
export interface Facts {
  amountMinor?: number | null;
  currency?: string | null;
  /** Replaces the money text, for a credit unit with no money rate. */
  amountText?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  planName?: string | null;
  /** "monthly", "yearly", "every 3 months". */
  billingCycle?: string | null;
  invoiceNumber?: string | null;
  /** A short sentence: "Card declined", "Product not received". */
  reason?: string | null;
  /** The deadline or the date the kind is about: evidence, due date, trial end, renewal. */
  dueAt?: string | null;
  nextRetryAt?: string | null;
  gatewayName?: string | null;
  endpointUrl?: string | null;
  /** Webhook deliveries that failed. */
  failedCount?: number | null;
  outcome?: "won" | "lost" | null;
  businessName?: string | null;
  businessPublicId?: string | null;
  record?: { type: string; id: string } | null;
  /** Dashboard path of the record. */
  url?: string | null;
  occurredAt?: string | null;
}

export interface Grouped {
  /** Every event in the window, the first one included. */
  count: number;
  /** Per currency, minor units, the first one included. */
  totals?: Record<string, number>;
  from?: string | null;
  to?: string | null;
}

export interface RenderOptions {
  /** The business timezone. */
  timezone: string;
  hideNames?: boolean;
  /** The member sees more than one business: name it. */
  showBusiness?: boolean;
  /** Render the group. `facts` are the first event's. */
  grouped?: Grouped;
  /** Dashboard origin for absolute links (`config.DASHBOARD_BASE_URL`). */
  baseUrl?: string | null;
  /** Push tag; the group's key, so the "N more" push replaces the first. */
  tag?: string | null;
  /** Email footer: a member's setting, or a destination an admin added. */
  audience?: "member" | "destination";
  /** The setting that sent it is this business's exception. */
  exceptionBusinessName?: string | null;
  now?: Date;
}

export interface Rendered {
  title: string;
  body: string;
  url: string | null;
  push: { title: string; body: string; url: string | null; tag: string };
  email: { subject: string; html: string; text: string };
  chat: { cardsV2: unknown[] };
}

// ── formatting ──

/** "₹4,999", "$249.50": no ".00" on a whole amount. */
export function shortMoney(amountMinor: number | bigint, currency: string): string {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      trailingZeroDisplay: "stripIfInteger",
    }).format(Number(amountMinor) / 10 ** currencyExponent(currency));
  } catch {
    return formatMoney(amountMinor, currency);
  }
}

const dateFmt = (tz: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts });

/** "18 Nov". */
export function shortDate(iso: string, tz: string): string {
  return dateFmt(tz, { day: "numeric", month: "short" }).format(new Date(iso));
}
/** "19 Nov 2026, 23:59 (Asia/Kolkata)". */
function longDateTime(iso: string, tz: string): string {
  const s = dateFmt(tz, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
  return `${s} (${tz})`;
}
function clock(iso: string, tz: string): string {
  return dateFmt(tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    new Date(iso),
  );
}

const host = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const sentence = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);
const sentences = (parts: Array<string | null | undefined | false>): string =>
  parts
    .filter((p): p is string => !!p && p.trim() !== "")
    .map(sentence)
    .join(" ");
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

// ── per kind ──

interface Ctx {
  f: Facts;
  tz: string;
  now: Date;
  amt: string | null;
  who: string | null;
  /** "Meera Iyer · Studio Pro, monthly", plus the business when shown. */
  line: string | null;
  /** The business name, when the member sees more than one. */
  biz: string | null;
  d: (iso: string | null | undefined) => string | null;
}

interface KindText {
  title: (c: Ctx) => string;
  body: (c: Ctx) => string;
  /** Longer first paragraph for email. Defaults to the body. */
  intro?: (c: Ctx) => string;
  /** Singular and plural nouns for a group: "payment failed", "payments failed". */
  one: string;
  many: string;
  /** Email and chat label for `dueAt`. */
  dueLabel?: string;
  /** What names one item in a list row, when the invoice, plan or reason do not. */
  item?: (c: Ctx) => string | null;
}

const titled = (label: string, amt: string | null) => (amt ? `${label}: ${amt}` : label);

const TEXT: Record<NotificationKind, KindText> = {
  payment_failed: {
    title: (c) => titled("Payment failed", c.amt),
    body: (c) =>
      sentences([
        c.line,
        c.f.reason,
        c.f.nextRetryAt ? `We try again on ${c.d(c.f.nextRetryAt)}` : null,
      ]),
    one: "payment failed",
    many: "payments failed",
  },
  payment_received: {
    title: (c) => titled("Payment received", c.amt),
    body: (c) => sentences([c.line]),
    one: "payment received",
    many: "payments received",
  },
  refund_failed: {
    title: (c) => titled("Refund failed", c.amt),
    body: (c) => sentences([c.line, c.f.reason, "Check the refund in the gateway"]),
    one: "refund failed",
    many: "refunds failed",
  },
  payment_needs_attention: {
    title: (c) => titled("Payment needs attention", c.amt),
    body: (c) =>
      sentences([
        c.line,
        "We do not know the result of this payment",
        `Check it in ${c.f.gatewayName ?? "the gateway"}`,
      ]),
    one: "payment needs attention",
    many: "payments need attention",
  },
  late_payment_failure: {
    title: (c) => titled("Late payment failure", c.amt),
    body: (c) => sentences([c.line, "This payment showed as paid, then failed", c.f.reason]),
    one: "late payment failure",
    many: "late payment failures",
  },
  possible_fraud: {
    title: (c) => titled("Possible fraud", c.amt),
    body: (c) =>
      sentences([
        c.line,
        c.f.reason
          ? `The gateway refused the payment: ${lowerFirst(c.f.reason)}`
          : "The gateway refused the payment as possible fraud",
      ]),
    one: "payment refused as possible fraud",
    many: "payments refused as possible fraud",
  },
  dispute_opened: {
    title: (c) => titled("Dispute opened", c.amt),
    body: (c) =>
      sentences([
        c.line,
        c.f.reason ? `Reason: ${lowerFirst(c.f.reason)}` : null,
        c.f.dueAt ? `Evidence due ${c.d(c.f.dueAt)}` : null,
      ]),
    intro: (c) =>
      sentences([
        `${c.who ?? "A customer"} disputed a payment with their bank`,
        "Send evidence before the deadline, or the bank can decide for the customer",
      ]),
    one: "dispute opened",
    many: "disputes opened",
    dueLabel: "Evidence due",
  },
  dispute_evidence_due: {
    title: (c) => {
      if (!c.f.dueAt) return "Evidence due soon";
      const days = Math.ceil((Date.parse(c.f.dueAt) - c.now.getTime()) / 86_400_000);
      if (days <= 0) return "Evidence due today";
      return `Evidence due in ${days} ${days === 1 ? "day" : "days"}`;
    },
    body: (c) => {
      const what = c.amt ? `${c.amt} dispute` : "Dispute";
      const from = c.who ? `${what} from ${c.who}` : what;
      return sentences([
        c.biz ? `${from} · ${c.biz}` : from,
        c.f.dueAt ? `Send evidence before ${c.d(c.f.dueAt)}` : "Send evidence soon",
      ]);
    },
    one: "dispute needs evidence soon",
    many: "disputes need evidence soon",
    dueLabel: "Evidence due",
    item: (c) => (c.f.dueAt ? `Evidence due ${c.d(c.f.dueAt)}` : null),
  },
  dispute_closed: {
    title: (c) =>
      titled(
        c.f.outcome === "won"
          ? "Dispute won"
          : c.f.outcome === "lost"
            ? "Dispute lost"
            : "Dispute closed",
        c.amt,
      ),
    body: (c) => sentences([c.line, c.f.reason ? `Reason: ${lowerFirst(c.f.reason)}` : null]),
    one: "dispute closed",
    many: "disputes closed",
  },
  retries_exhausted: {
    title: (c) => titled("All payment retries failed", c.amt),
    body: (c) =>
      sentences([
        invoiceFrom(c) ? `${invoiceFrom(c)} is now unpaid` : "The invoice is now unpaid",
        "We do not try again",
      ]),
    one: "invoice unpaid after all retries",
    many: "invoices unpaid after all retries",
  },
  invoice_overdue: {
    title: (c) => titled("Invoice overdue", c.amt),
    body: (c) => sentences([invoiceFrom(c), c.f.dueAt ? `It was due on ${c.d(c.f.dueAt)}` : null]),
    one: "invoice overdue",
    many: "invoices overdue",
    dueLabel: "Due date",
  },
  payment_method_unusable: {
    title: () => "Payment method no longer works",
    body: (c) => sentences([c.line, c.f.reason, "The customer has a live subscription"]),
    one: "payment method no longer works",
    many: "payment methods no longer work",
  },
  new_revenue: {
    title: (c) => titled("New revenue", c.amt),
    body: (c) =>
      sentences([
        c.line,
        c.f.invoiceNumber ? `First invoice ${c.f.invoiceNumber}` : "First invoice",
      ]),
    one: "first invoice",
    many: "first invoices",
  },
  subscription_created: {
    title: () => "New subscription",
    body: (c) => sentences([c.line]),
    one: "new subscription",
    many: "new subscriptions",
  },
  subscription_cancelled: {
    title: () => "Subscription cancelled",
    body: (c) => sentences([c.line, c.f.reason ? `Reason: ${lowerFirst(c.f.reason)}` : null]),
    one: "subscription cancelled",
    many: "subscriptions cancelled",
  },
  cancellation_scheduled: {
    title: () => "Cancellation scheduled",
    body: (c) =>
      sentences([c.line, c.f.dueAt ? `The subscription ends on ${c.d(c.f.dueAt)}` : null]),
    one: "cancellation scheduled",
    many: "cancellations scheduled",
    dueLabel: "Ends on",
  },
  subscription_reactivated: {
    title: () => "Subscription reactivated",
    body: (c) => sentences([c.line]),
    one: "subscription reactivated",
    many: "subscriptions reactivated",
  },
  trial_ending: {
    title: () => "Trial ends soon",
    body: (c) => sentences([c.line, c.f.dueAt ? `The trial ends on ${c.d(c.f.dueAt)}` : null]),
    one: "trial ends soon",
    many: "trials end soon",
    dueLabel: "Trial ends",
  },
  customer_portal_change: {
    title: () => "Changed by the customer",
    body: (c) => sentences([c.line, c.f.reason]),
    one: "change by a customer",
    many: "changes by customers",
  },
  large_renewal: {
    title: (c) => titled("Large renewal soon", c.amt),
    body: (c) => sentences([c.line, c.f.dueAt ? `It renews on ${c.d(c.f.dueAt)}` : null]),
    one: "large renewal soon",
    many: "large renewals soon",
    dueLabel: "Renews on",
    item: (c) => {
      const on = c.d(c.f.dueAt);
      if (!on) return c.f.planName ?? null;
      return c.f.planName ? `${c.f.planName}, renews on ${on}` : `Renews on ${on}`;
    },
  },
  spend_limit_reached: {
    title: () => "Spending limit reached",
    body: (c) =>
      sentences([
        `${c.who ?? "A customer"} reached ${c.amt ? `the ${c.amt} spending limit` : "a spending limit"}`,
        c.f.reason ?? "New usage is refused",
        businessOnly(c),
      ]),
    one: "spending limit reached",
    many: "spending limits reached",
  },
  usage_alert: {
    title: () => "Usage alert",
    body: (c) => sentences([c.line, c.f.reason]),
    one: "usage alert",
    many: "usage alerts",
  },
  auto_topup_failed: {
    title: (c) => titled("Automatic top-up failed", c.amt),
    body: (c) => sentences([c.line, c.f.reason]),
    one: "automatic top-up failed",
    many: "automatic top-ups failed",
  },
  large_credit_grant: {
    title: (c) => titled("Large free credit grant", c.amt),
    body: (c) =>
      sentences([
        `${c.who ?? "A customer"} got free credit above your grant limit`,
        c.f.reason,
        businessOnly(c),
      ]),
    one: "large free credit grant",
    many: "large free credit grants",
  },
  webhook_failing: {
    title: () => "Webhook endpoint failing",
    body: (c) => {
      const n = c.f.failedCount ?? 1;
      const to = c.f.endpointUrl ? ` to ${host(c.f.endpointUrl)}` : "";
      return sentences([
        `${n} ${n === 1 ? "delivery" : "deliveries"}${to} failed after all retries`,
        businessOnly(c),
      ]);
    },
    one: "webhook endpoint failing",
    many: "webhook endpoints failing",
    item: (c) => {
      const n = c.f.failedCount ?? 1;
      const at = c.f.endpointUrl ? host(c.f.endpointUrl) : "Endpoint";
      return `${at}: ${n} ${n === 1 ? "delivery" : "deliveries"} failed`;
    },
  },
  gateway_attention: {
    title: () => "Payment gateway needs attention",
    body: (c) =>
      sentences([
        `${c.f.gatewayName ?? "The gateway"} refused a payment because of your account with it`,
        c.f.reason,
        businessOnly(c),
      ]),
    one: "payment gateway needs attention",
    many: "payment gateways need attention",
    item: (c) => c.f.gatewayName ?? null,
  },
};

function invoiceFrom(c: Ctx): string | null {
  const inv = c.f.invoiceNumber ? `Invoice ${c.f.invoiceNumber}` : null;
  const s =
    inv && c.who ? `${inv} from ${c.who}` : (inv ?? (c.who ? `An invoice from ${c.who}` : null));
  return s && c.biz ? `${s} · ${c.biz}` : (s ?? c.biz);
}

/** The business name alone, for bodies that do not use `line`. */
const businessOnly = (c: Ctx): string | null => c.biz;

/** Where a group of each kind opens. */
function listPath(
  kind: NotificationKind,
  biz: string | null | undefined,
): { path: string; label: string } {
  const b = biz ? `/businesses/${biz}` : "";
  switch (kindDef(kind).group) {
    case "Payments":
      return {
        path: `${b}/transactions`,
        label: kind === "payment_failed" ? "View failed payments" : "View payments",
      };
    case "Disputes":
      return { path: `${b}/disputes`, label: "View disputes" };
    case "Collections":
      return { path: `${b}/invoices`, label: "View invoices" };
    case "Subscriptions":
      return { path: `${b}/subscriptions`, label: "View subscriptions" };
    case "Usage and credits":
      return { path: `${b}/customers`, label: "View customers" };
    case "Operations":
      return kind === "webhook_failing"
        ? { path: "/developer/webhooks", label: "View webhook endpoints" }
        : { path: `${b}/settings/gateways`, label: "View payment gateways" };
  }
}

const RECORD_LABEL: Record<string, string> = {
  transaction: "View payment",
  invoice: "View invoice",
  dispute: "View dispute",
  customer: "View customer",
  subscription: "View subscription",
  credit_grant: "View credits",
  webhook_endpoint: "View webhook endpoint",
  gateway_account: "View payment gateway",
};

const moneyList = (totals: Record<string, number>, fmt: (m: number, c: string) => string) =>
  Object.entries(totals)
    .filter(([, v]) => v > 0)
    .map(([cur, v]) => fmt(v, cur))
    .join(" and ");

/** "3 payments failed", "1 dispute opened". */
export function countText(kind: NotificationKind, n: number): string {
  const t = TEXT[kind];
  return `${n} ${n === 1 ? t.one : t.many}`;
}

function contextOf(
  kind: NotificationKind,
  facts: Facts,
  opts: RenderOptions,
): { ctx: Ctx; plan: string | null } {
  const tz = opts.timezone || "UTC";
  const who = opts.hideNames ? null : facts.customerName?.trim() || null;
  const amt =
    facts.amountText ??
    (facts.amountMinor != null && facts.currency
      ? shortMoney(facts.amountMinor, facts.currency)
      : null);
  const plan = facts.planName
    ? facts.billingCycle
      ? `${facts.planName}, ${facts.billingCycle}`
      : facts.planName
    : facts.invoiceNumber && kind !== "new_revenue"
      ? `Invoice ${facts.invoiceNumber}`
      : null;
  const biz = opts.showBusiness && facts.businessName ? facts.businessName : null;
  const lineParts = [who, plan, biz].filter((p): p is string => !!p);
  return {
    plan,
    ctx: {
      f: facts,
      tz,
      now: opts.now ?? new Date(),
      amt,
      who,
      line: lineParts.length ? lineParts.join(" · ") : null,
      biz,
      d: (iso) => (iso ? shortDate(iso, tz) : null),
    },
  };
}

function emailFooter(kind: NotificationKind, opts: RenderOptions) {
  const base = opts.baseUrl?.replace(/\/$/, "") ?? null;
  const footer =
    opts.audience === "destination"
      ? "You get this email because an owner or admin of the organization added this address to its notifications."
      : `You get this email because "${kindDef(kind).label}" is set to Instant${
          opts.exceptionBusinessName ? ` for ${opts.exceptionBusinessName}` : ""
        } in your notifications.`;
  const settings =
    opts.audience !== "destination" && base
      ? { label: "Change your notifications", href: `${base}/account/notifications` }
      : null;
  return { footer, settings };
}

export function renderNotification(
  kind: NotificationKind,
  facts: Facts,
  opts: RenderOptions,
): Rendered {
  const t = TEXT[kind];
  const { ctx, plan } = contextOf(kind, facts, opts);
  const { tz, now, amt, who } = ctx;

  const base = opts.baseUrl?.replace(/\/$/, "") ?? null;
  const list = listPath(kind, facts.businessPublicId);
  const recordUrl = facts.url ?? list.path;
  const recordLabel = (facts.record && RECORD_LABEL[facts.record.type]) ?? list.label;

  let title = t.title(ctx);
  let body = t.body(ctx);
  let url = recordUrl;
  let linkLabel = recordLabel;

  // The bell's row for a burst: "12 payments failed", the first one included.
  const g = opts.grouped;
  const grouped = !!g && g.count > 1;
  if (g && g.count > 1) {
    const all = moneyList(g.totals ?? {}, shortMoney);
    const span =
      g.from && g.to ? `from ${clock(g.from, tz)} to ${clock(g.to, tz)}` : "in the last 5 minutes";
    const first = amt ? `The first was ${amt}${who ? ` from ${who}` : ""}` : null;
    title = countText(kind, g.count);
    body = sentences([
      all ? `${all} in total, ${span}` : span.charAt(0).toUpperCase() + span.slice(1),
      first,
    ]);
    url = list.path;
    linkLabel = list.label;
  }

  // Key and value rows for email and chat.
  const rows: Array<[string, string]> = [];
  if (!grouped) {
    if (who) rows.push(["Customer", who]);
    if (facts.amountText) rows.push(["Amount", facts.amountText]);
    else if (facts.amountMinor != null && facts.currency)
      rows.push(["Amount", formatMoney(facts.amountMinor, facts.currency)]);
    if (facts.planName) rows.push(["Plan", plan!]);
    if (facts.invoiceNumber) rows.push(["Invoice", facts.invoiceNumber]);
    if (facts.reason) rows.push(["Reason", facts.reason]);
    if (facts.nextRetryAt) rows.push(["Next attempt", longDateTime(facts.nextRetryAt, tz)]);
    if (facts.dueAt && t.dueLabel) rows.push([t.dueLabel, longDateTime(facts.dueAt, tz)]);
    if (facts.gatewayName) rows.push(["Gateway", facts.gatewayName]);
    if (facts.endpointUrl) rows.push(["Endpoint", facts.endpointUrl]);
  }
  if (facts.businessName) rows.push(["Business", facts.businessName]);

  const abs = (p: string | null) => (p && base ? `${base}${p}` : null);
  const link = abs(url) ? { label: linkLabel, href: abs(url)! } : null;
  const email = emailLayout({
    heading: title,
    preheader: facts.businessName ?? null,
    intro: grouped ? body : (t.intro?.(ctx) ?? body),
    rows,
    link,
    ...emailFooter(kind, opts),
  });

  const when = facts.occurredAt ?? now.toISOString();
  const subtitle = [facts.businessName, clock(when, tz)].filter(Boolean).join(" · ");
  // The header already carries the amount (title) and the business (subtitle).
  const chatRows = rows.filter(
    ([k]) => k !== "Business" && !(k === "Amount" && amt != null && title.includes(amt)),
  );
  const chat = chatCard({
    id: kind,
    title,
    subtitle,
    widgets: chatFactWidgets(chatRows),
    link,
  });

  return {
    title,
    body,
    url,
    push: {
      title,
      body,
      url,
      tag: opts.tag ?? `${kind}:${facts.record?.id ?? facts.businessPublicId ?? ""}`,
    },
    email: { subject: title, html: email.html, text: email.text },
    chat,
  };
}

// ── lists ──

/** Rows a list shows; push shows two. */
export const LIST_ROWS = 5;
const PUSH_ROWS = 2;

/** What a list stands for. */
export interface ListInfo {
  /** Every item, though `items` can hold fewer (a group keeps 20). */
  count: number;
  /** Per currency, minor units, of these items only. */
  totals: Record<string, number>;
  /** The events after a first one that went out alone: "3 more …". */
  more?: boolean;
}

/** One list row: "Invoice 2026-1184 · ₹4,999 · Meera Iyer". */
export function itemRow(kind: NotificationKind, facts: Facts, opts: RenderOptions): string {
  const t = TEXT[kind];
  const { ctx, plan } = contextOf(kind, facts, { ...opts, showBusiness: false });
  const id =
    t.item?.(ctx) ??
    (facts.invoiceNumber ? `Invoice ${facts.invoiceNumber}` : null) ??
    plan ??
    facts.reason ??
    t.title({ ...ctx, amt: null });
  return [id, ctx.amt, ctx.who].filter(Boolean).join(" · ");
}

const andMore = (k: number) => (k > 0 ? `and ${k} more` : null);

/**
 * Several events of one kind and business in one message: the events after the first of a
 * burst ("3 more invoices overdue · $2,385"), or what one clock run found ("2 invoices overdue").
 */
export function renderList(
  kind: NotificationKind,
  items: Facts[],
  opts: RenderOptions,
  info: ListInfo,
): Rendered {
  const t = TEXT[kind];
  const tz = opts.timezone || "UTC";
  const now = opts.now ?? new Date();
  const first: Facts = items[0] ?? {};
  const noun = info.count === 1 ? t.one : t.many;
  const head = info.more ? `${info.count} more ${noun}` : `${info.count} ${noun}`;
  const total = moneyList(info.totals, shortMoney);
  const title = total ? `${head} · ${total}` : head;

  const base = opts.baseUrl?.replace(/\/$/, "") ?? null;
  const abs = (p: string | null | undefined) => (p && base ? `${base}${p}` : null);
  const rows = items.map((f) => ({ text: itemRow(kind, f, opts), href: abs(f.url) }));
  const shown = rows.slice(0, LIST_ROWS);
  const left = info.count - shown.length;
  const rest = andMore(left);
  const bizName = opts.showBusiness ? (first.businessName ?? null) : null;

  const pushRows = rows.slice(0, PUSH_ROWS);
  const pushBody = [...pushRows.map((r) => r.text), andMore(info.count - pushRows.length), bizName]
    .filter(Boolean)
    .join("\n");
  const body = sentences([
    total ? `${total} in total` : null,
    ...shown.map((r) => r.text),
    left > 0 ? `And ${left} more` : null,
    bizName,
  ]);

  const list = listPath(kind, first.businessPublicId);
  const link = abs(list.path) ? { label: list.label, href: abs(list.path)! } : null;
  const email = emailLayout({
    heading: title,
    preheader: first.businessName ?? null,
    intro: null,
    rows: [],
    items: shown,
    more: rest,
    link,
    ...emailFooter(kind, opts),
  });

  const widgets: unknown[] = shown.map((r) => ({
    decoratedText: {
      text: escapeHtml(r.text),
      wrapText: true,
      ...(r.href ? { onClick: { openLink: { url: r.href } } } : {}),
    },
  }));
  if (rest) widgets.push({ textParagraph: { text: rest } });
  const chat = chatCard({
    id: kind,
    title,
    subtitle: [first.businessName, clock(now.toISOString(), tz)].filter(Boolean).join(" · "),
    widgets,
    link,
  });

  return {
    title,
    body,
    url: list.path,
    push: {
      title,
      body: pushBody,
      url: list.path,
      tag: opts.tag ?? `${kind}:list:${first.record?.id ?? first.businessPublicId ?? ""}`,
    },
    email: { subject: title, html: email.html, text: email.text },
    chat,
  };
}

/** One item reads as a normal notification; more as a list. */
export function renderItems(
  kind: NotificationKind,
  items: Facts[],
  opts: RenderOptions,
  info: ListInfo,
): Rendered {
  return info.count === 1 && items[0]
    ? renderNotification(kind, items[0], opts)
    : renderList(kind, items, opts, info);
}

// ── email and chat layouts ──

const cell = 'style="padding:4px 12px 4px 0;vertical-align:top"';

/** The deployment-mail layout of team alerts: a key and value table or a list, and a footer. */
function emailLayout(m: {
  heading: string;
  preheader: string | null;
  intro: string | null;
  rows: Array<[string, string]>;
  items?: Array<{ text: string; href: string | null }>;
  more?: string | null;
  link: { label: string; href: string } | null;
  footer: string;
  settings: { label: string; href: string } | null;
}): { html: string; text: string } {
  const items = m.items ?? [];
  const html = [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#222">',
    m.preheader
      ? `<p style="font-size:12px;color:#666;margin:0 0 8px">${escapeHtml(m.preheader)}</p>`
      : "",
    `<h2 style="font-size:18px;margin:0 0 16px">${escapeHtml(m.heading)}</h2>`,
    m.intro
      ? `<p style="font-size:14px;line-height:1.6;margin:0 0 12px">${escapeHtml(m.intro)}</p>`
      : "",
    m.rows.length
      ? [
          '<table style="font-size:13px;line-height:1.5;border-collapse:collapse;margin:0 0 16px">',
          ...m.rows.map(
            ([k, v]) =>
              `<tr><th ${cell} align="left">${escapeHtml(k)}</th><td ${cell}>${escapeHtml(v)}</td></tr>`,
          ),
          "</table>",
        ].join("")
      : "",
    items.length
      ? [
          '<ul style="font-size:14px;line-height:1.6;margin:0 0 12px;padding-left:20px">',
          ...items.map(
            (i) =>
              `<li>${
                i.href
                  ? `<a href="${escapeHtml(i.href)}" style="color:#222">${escapeHtml(i.text)}</a>`
                  : escapeHtml(i.text)
              }</li>`,
          ),
          "</ul>",
        ].join("")
      : "",
    m.more
      ? `<p style="font-size:14px;line-height:1.6;margin:0 0 12px">${escapeHtml(m.more)}</p>`
      : "",
    m.link
      ? `<p style="margin:24px 0"><a href="${escapeHtml(m.link.href)}" style="background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(m.link.label)}</a></p>`
      : "",
    `<p style="font-size:12px;color:#666;margin:24px 0 0">${escapeHtml(m.footer)}${
      m.settings
        ? ` <a href="${escapeHtml(m.settings.href)}" style="color:#666">${escapeHtml(m.settings.label)}</a>`
        : ""
    }</p>`,
    "</div>",
  ].join("");
  const text = [
    m.heading,
    m.intro,
    m.rows.map(([k, v]) => `${k}: ${v}`).join("\n"),
    [...items.map((i) => `- ${i.text}`), m.more].filter(Boolean).join("\n"),
    m.link ? `${m.link.label}: ${m.link.href}` : null,
    m.settings ? `${m.footer} ${m.settings.label}: ${m.settings.href}` : m.footer,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { html, text };
}

/**
 * Key and value rows as Google Chat widgets: two columns, filled alternately (left, right, left…),
 * so four facts make a 2×2 grid. Chat stacks the columns on a narrow screen.
 */
export function chatFactWidgets(rows: Array<[string, string]>): unknown[] {
  const fact = ([k, v]: [string, string]) => ({
    decoratedText: { topLabel: k, text: escapeHtml(v) },
  });
  if (rows.length < 2) return rows.map(fact);
  const column = (widgets: unknown[]) => ({
    horizontalSizeStyle: "FILL_AVAILABLE_SPACE",
    horizontalAlignment: "START",
    verticalAlignment: "TOP",
    widgets,
  });
  return [
    {
      columns: {
        columnItems: [
          column(rows.filter((_, i) => i % 2 === 0).map(fact)),
          column(rows.filter((_, i) => i % 2 === 1).map(fact)),
        ],
      },
    },
  ];
}

/** A Google Chat cardsV2 message: header, the widgets, one button. */
function chatCard(m: {
  id: string;
  title: string;
  subtitle: string;
  widgets: unknown[];
  link: { label: string; href: string } | null;
}): { cardsV2: unknown[] } {
  const widgets = [...m.widgets];
  if (m.link)
    widgets.push({
      buttonList: {
        buttons: [{ text: m.link.label, onClick: { openLink: { url: m.link.href } } }],
      },
    });
  return {
    cardsV2: [
      {
        cardId: m.id,
        card: {
          header: { title: m.title, subtitle: m.subtitle },
          sections: [{ widgets }],
        },
      },
    ],
  };
}

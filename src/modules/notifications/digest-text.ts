/**
 * The words of the daily and weekly summary: bell row, push, email and Google Chat card.
 * Pure. In-app text, so ASD-STE100.
 */
import { escapeHtml } from "@/modules/emails/sanitize";
import { kindDef, type NotificationKind } from "./catalogue";
import { chatFactWidgets, shortMoney } from "./text";
import type { DigestParts, Money, NeedsAction, Period } from "./digest";

export interface SummaryItem {
  kind: NotificationKind;
  title: string;
  body: string;
  url: string | null;
  amountMinor: number | null;
  currency: string | null;
}

/** One business in a member's summary: the built parts, their summary items, the page. */
export interface MemberPart {
  parts: DigestParts;
  items: SummaryItem[];
  url: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const moneyText = (totals: Record<string, number>) =>
  Object.entries(totals)
    .filter(([, v]) => v !== 0)
    .map(([c, v]) => shortMoney(v, c))
    .join(" and ");

const signed = (totals: Record<string, number>) =>
  Object.entries(totals)
    .filter(([, v]) => v !== 0)
    .map(([c, v]) => `${v > 0 ? "+" : "−"}${shortMoney(Math.abs(v), c)}`)
    .join(" and ");

/** "15 Nov" from a local date. */
const dayText = (
  day: string,
  opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" },
) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...opts }).format(
    new Date(`${day}T12:00:00Z`),
  );

const lastDay = (p: DigestParts) => {
  const [y, m, d] = p.end.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
};

export function periodTitle(period: Period, parts: DigestParts): string {
  return period === "daily"
    ? `Daily summary for ${dayText(parts.start)}`
    : `Weekly summary for ${dayText(parts.start, { day: "numeric" })} to ${dayText(lastDay(parts))}`;
}

/** "▲ 8%" against the previous period, for one currency; "▲ 3" for counts. */
function moneyDelta(cur: Money, prev: Money): string {
  const cs = Object.keys(cur.totals);
  if (cs.length !== 1) return "";
  const c = cs[0]!;
  const a = cur.totals[c] ?? 0;
  const b = prev.totals[c] ?? 0;
  if (b <= 0 || a === b) return "";
  const pct = Math.round(((a - b) / b) * 100);
  return pct === 0 ? "" : ` ${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}%`;
}
const countDelta = (a: number, b: number) =>
  a === b ? "" : ` ${a > b ? "▲" : "▼"} ${Math.abs(a - b)}`;

function needsText(n: NeedsAction): string {
  const amt = moneyText(n.totals);
  const tail = amt ? ` · ${amt}` : "";
  switch (n.kind) {
    case "payment_needs_attention":
      return `${plural(n.count, "payment", "payments")} with no result from the gateway${tail}`;
    case "dispute_evidence_due":
      return `${plural(n.count, "dispute", "disputes")} with evidence due in 7 days${tail}`;
    case "retries_exhausted":
      return `${plural(n.count, "invoice", "invoices")} unpaid after all retries`;
    case "gateway_attention":
      return `${plural(n.count, "payment", "payments")} refused because of your gateway account`;
    case "webhook_failing":
      return `${plural(n.count, "webhook endpoint", "webhook endpoints")} failing`;
    default:
      return `${kindDef(n.kind).label}: ${n.count}${tail}`;
  }
}

const reasonText = (code: string) => {
  const s = code.replace(/[_-]+/g, " ").trim().toLowerCase();
  return code === "other" ? "other reasons" : s;
};

/** Key and value rows for part 2. */
function figureRows(p: DigestParts): Array<[string, string]> {
  const f = p.figures;
  const rows: Array<[string, string]> = [];
  const m = (x: Money) => [String(x.count), moneyText(x.totals)].filter(Boolean).join(" · ");
  if (f.collected.count || f.collected.previous.count)
    rows.push(["Collected", `${m(f.collected)}${moneyDelta(f.collected, f.collected.previous)}`]);
  if (f.failed.count || f.failed.previous.count)
    rows.push(["Failed", `${m(f.failed)}${countDelta(f.failed.count, f.failed.previous.count)}`]);
  if (f.recovered?.count) {
    const pct = f.failed.count
      ? ` · ${Math.round((f.recovered.count / f.failed.count) * 100)}% of failed`
      : "";
    rows.push(["Recovered by retries", `${m(f.recovered)}${pct}`]);
  }
  if (f.refunded.count) rows.push(["Refunded", m(f.refunded)]);
  if (f.new_subscriptions.count || f.new_subscriptions.previous)
    rows.push([
      "New subscriptions",
      `${f.new_subscriptions.count}${countDelta(f.new_subscriptions.count, f.new_subscriptions.previous)}`,
    ]);
  if (f.cancelled.count) {
    const why = Object.entries(f.cancelled.reasons)
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${n} ${reasonText(c)}`)
      .join(", ");
    rows.push(["Cancelled", why ? `${f.cancelled.count} · ${why}` : String(f.cancelled.count)]);
  }
  if (f.mrr.start && f.mrr.end && (moneyText(f.mrr.start) || moneyText(f.mrr.end)))
    rows.push(["MRR", `${moneyText(f.mrr.start) || "0"} → ${moneyText(f.mrr.end) || "0"}`]);
  const change = signed(f.mrr.change);
  if (change) rows.push(["MRR change", change]);
  if (p.period === "weekly")
    for (const [reason, totals] of Object.entries(f.mrr.by_reason)) {
      const v = signed(totals);
      if (v) rows.push([`MRR ${reason}`, v]);
    }
  return rows;
}

function comingRows(p: DigestParts): Array<[string, string]> {
  const c = p.coming_up;
  const rows: Array<[string, string]> = [];
  if (c.renewals) rows.push(["Renewals in 7 days", String(c.renewals)]);
  if (c.trials_ending) rows.push(["Trials that end", String(c.trials_ending)]);
  if (c.invoices_due.count)
    rows.push([
      "Invoices that fall due",
      [String(c.invoices_due.count), moneyText(c.invoices_due.totals)].filter(Boolean).join(" · "),
    ]);
  if (c.cards_expiring)
    rows.push(["Cards that expire this month or next", String(c.cards_expiring)]);
  return rows;
}

/** Part 3: per kind, the count and the 5 largest. */
function itemGroups(items: SummaryItem[]) {
  const byKind = new Map<NotificationKind, SummaryItem[]>();
  for (const i of items) byKind.set(i.kind, [...(byKind.get(i.kind) ?? []), i]);
  return [...byKind.entries()].map(([kind, list]) => {
    const top = [...list].sort((a, b) => (b.amountMinor ?? 0) - (a.amountMinor ?? 0)).slice(0, 5);
    return {
      kind,
      label: kindDef(kind)?.label ?? kind,
      count: list.length,
      top,
      more: list.length - top.length,
    };
  });
}

/** "Lumenfold Studio: ₹6,84,210 collected, 14 failed." */
function shortLine(p: DigestParts, named: boolean): string | null {
  const f = p.figures;
  const bits: string[] = [];
  const got = moneyText(f.collected.totals);
  if (got) bits.push(`${got} collected`);
  if (f.failed.count) bits.push(`${f.failed.count} failed`);
  if (!bits.length && f.new_subscriptions.count)
    bits.push(plural(f.new_subscriptions.count, "new subscription", "new subscriptions"));
  if (!bits.length) return null;
  return `${named ? `${p.business.name}: ` : ""}${bits.join(", ")}.`;
}

const cell = 'style="padding:4px 12px 4px 0;vertical-align:top"';
const table = (rows: Array<[string, string]>) =>
  rows.length
    ? `<table style="font-size:13px;line-height:1.5;border-collapse:collapse;margin:0 0 12px">${rows
        .map(
          ([k, v]) =>
            `<tr><th ${cell} align="left">${escapeHtml(k)}</th><td ${cell}>${escapeHtml(v)}</td></tr>`,
        )
        .join("")}</table>`
    : "";
const h = (level: 2 | 3 | 4, s: string) =>
  `<h${level} style="font-size:${level === 2 ? 18 : level === 3 ? 16 : 14}px;margin:16px 0 8px">${escapeHtml(s)}</h${level}>`;
const para = (s: string, small = false) =>
  `<p style="font-size:${small ? 12 : 14}px;line-height:1.6;margin:0 0 8px${small ? ";color:#666" : ""}">${escapeHtml(s)}</p>`;
const button = (label: string, href: string) =>
  `<p style="margin:16px 0"><a href="${escapeHtml(href)}" style="background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(label)}</a></p>`;
const wrap = (inner: string) =>
  `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#222">${inner}</div>`;

/** Parts 1, 2 and 4 (and 3 when given) of one business, as HTML and as text. */
function businessSection(p: DigestParts, items: SummaryItem[] | null, named: boolean) {
  const html: string[] = [];
  const text: string[] = [];
  if (named) {
    html.push(h(3, p.business.name));
    text.push(p.business.name.toUpperCase());
  }
  const needs = p.needs_action.reduce((s, n) => s + n.count, 0);
  if (needs) {
    html.push(h(4, `Needs action · ${needs}`));
    html.push(
      `<ul style="font-size:13px;margin:0 0 12px;padding-left:18px">${p.needs_action
        .map((n) => `<li>${escapeHtml(needsText(n))}</li>`)
        .join("")}</ul>`,
    );
    text.push(`Needs action · ${needs}`, ...p.needs_action.map((n) => `- ${needsText(n)}`));
  }
  const figs = figureRows(p);
  if (figs.length) {
    html.push(table(figs));
    text.push(...figs.map(([k, v]) => `${k}: ${v}`));
  }
  for (const g of items ? itemGroups(items) : []) {
    html.push(h(4, `${g.label} · ${g.count}`));
    const lines = g.top.map((i) => `${i.title} · ${i.body}`);
    if (g.more > 0) lines.push(`and ${g.more} more`);
    html.push(
      `<ul style="font-size:13px;margin:0 0 12px;padding-left:18px">${lines
        .map((l) => `<li>${escapeHtml(l)}</li>`)
        .join("")}</ul>`,
    );
    text.push(`${g.label} · ${g.count}`, ...lines.map((l) => `- ${l}`));
  }
  const coming = comingRows(p);
  if (coming.length) {
    html.push(h(4, "Coming up in 7 days"));
    html.push(table(coming));
    text.push("Coming up in 7 days", ...coming.map(([k, v]) => `${k}: ${v}`));
  }
  if (!figs.length && !needs && !coming.length && !items?.length) {
    html.push(para("No activity."));
    text.push("No activity.");
  }
  return { html: html.join(""), text: text.join("\n") };
}

export function renderMemberSummary(
  list: MemberPart[],
  o: { period: Period; baseUrl: string | null; timezone: string; now: Date },
) {
  const first = list[0]!.parts;
  const title = periodTitle(o.period, first);
  const named = list.length > 1;
  const needs = list.reduce((s, p) => s + p.parts.needs_action.reduce((t, n) => t + n.count, 0), 0);
  const lines = list.map((p) => shortLine(p.parts, named)).filter((x): x is string => !!x);
  const body = lines.length ? lines.join(" ") : needs ? "Some items need action." : "No activity.";
  const label = o.period === "daily" ? "Daily summary" : "Weekly summary";
  const pushTitle = needs ? `${label} · ${needs} need action` : label;
  const abs = (p: string) => (o.baseUrl ? `${o.baseUrl}${p}` : null);

  const intro =
    o.period === "daily"
      ? `For ${dayText(first.start, { weekday: "long", day: "numeric", month: "long" })}, in the timezone of each business.`
      : `For ${dayText(first.start, { day: "numeric", month: "long" })} to ${dayText(lastDay(first), { day: "numeric", month: "long" })}, Monday to Sunday, in the timezone of each business.`;
  const sections = list.map((p) => businessSection(p.parts, p.items, named));
  const view = abs(list[0]!.url);
  const settings = abs("/account/notifications");
  const footer = `You get this email because the ${o.period} summary is on in your notifications.`;
  const html = wrap(
    [
      h(2, `Your ${o.period} summary`),
      para(intro),
      ...sections.map((s) => s.html),
      view ? button("View the full summary", view) : "",
      `<p style="font-size:12px;color:#666;margin:24px 0 0">${escapeHtml(footer)}${
        settings
          ? ` <a href="${escapeHtml(settings)}" style="color:#666">Change your notifications</a>`
          : ""
      }</p>`,
    ].join(""),
  );
  const text = [
    `Your ${o.period} summary`,
    intro,
    ...sections.map((s) => s.text),
    view ? `View the full summary: ${view}` : null,
    settings ? `${footer} Change your notifications: ${settings}` : footer,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    title,
    body,
    push: { title: pushTitle, body, tag: `${o.period}_summary` },
    email: { subject: title, html, text },
  };
}

/** Parts 1, 2 and 4 of one business, for a Google Chat space or an outside address. */
export function renderDestinationSummary(
  p: DigestParts,
  o: { baseUrl: string | null; url: string; hideNames?: boolean },
) {
  const title = `${periodTitle(p.period, p)} · ${p.business.name}`;
  const needs = p.needs_action.reduce((s, n) => s + n.count, 0);
  const href = o.baseUrl ? `${o.baseUrl}${o.url}` : null;
  const section = businessSection(p, null, false);
  const footer =
    "You get this email because an owner or admin of the organization turned on summaries for this address.";
  const html = wrap(
    [
      h(2, title),
      section.html,
      href ? button("View the summary", href) : "",
      para(footer, true),
    ].join(""),
  );
  const text = [title, section.text, href ? `View the summary: ${href}` : null, footer]
    .filter(Boolean)
    .join("\n\n");

  const rows: Array<[string, string]> = [];
  if (needs) rows.push(["Needs action", p.needs_action.map(needsText).join(" · ")]);
  rows.push(...figureRows(p), ...comingRows(p));
  const widgets = chatFactWidgets(rows);
  if (href)
    widgets.push({
      buttonList: { buttons: [{ text: "View summary", onClick: { openLink: { url: href } } }] },
    });
  const subtitle = needs ? `${plural(needs, "item needs", "items need")} action` : p.business.name;
  return {
    email: { subject: title, html, text },
    chat: {
      cardsV2: [
        {
          cardId: `${p.period}_summary`,
          card: { header: { title, subtitle }, sections: [{ widgets }] },
        },
      ],
    },
  };
}

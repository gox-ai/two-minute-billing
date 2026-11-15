// Billy's chat history: the list shape, date groups in the business time zone, search-match
// ranges and the optimistic list updates. Relative imports only: root unit tests load it.
import { fmtAxisDate, fmtDate, fmtDateTime } from "./format-date";

export interface ChatSummary {
  id: string;
  title: string;
  business: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  pinned_at: string | null;
  shared_at: string | null;
  /** Search only: text around the match, or null when the title matched. */
  snippet: string | null;
}

export type ChatView = "active" | "archived";

export interface ChatPage {
  data: ChatSummary[];
  has_more: boolean;
  next_cursor: string | null;
}

export const TITLE_MAX = 120;
export const PAGE_SIZE = 30;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** A conversation from the API. Fields an older engine leaves out read as null. */
export function toChat(raw: unknown): ChatSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const updated = str(r.updated_at) ?? str(r.created_at) ?? new Date(0).toISOString();
  return {
    id,
    title: str(r.title) ?? "New chat",
    business: str(r.business),
    created_at: str(r.created_at) ?? updated,
    updated_at: updated,
    archived_at: str(r.archived_at),
    pinned_at: str(r.pinned_at),
    shared_at: str(r.shared_at),
    snippet: str(r.snippet),
  };
}

export function toChatPage(raw: unknown): ChatPage {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const data = (Array.isArray(r.data) ? r.data : [])
    .map(toChat)
    .filter((c): c is ChatSummary => !!c);
  const hasMore = r.has_more === true && data.length > 0;
  return {
    data,
    has_more: hasMore,
    next_cursor: hasMore ? (str(r.next_cursor) ?? data[data.length - 1]!.id) : null,
  };
}

// ── dates ─────────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

type Day = { y: number; m: number; d: number; n: number };

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
function dayIn(input: string | Date, tz: string | null | undefined): Day | null {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  const zone = tz || "UTC";
  let f = dayFormatters.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-GB", {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        timeZone: zone,
      });
    } catch {
      return dayIn(date, "UTC");
    }
    dayFormatters.set(zone, f);
  }
  const p: Record<string, string> = {};
  for (const { type, value } of f.formatToParts(date)) p[type] = value;
  const y = Number(p.year);
  const m = Number(p.month);
  const d = Number(p.day);
  return { y, m, d, n: Date.UTC(y, m - 1, d) / 86_400_000 };
}

export interface ChatGroup {
  key: string;
  label: string;
  items: ChatSummary[];
}

const RELATIVE = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["week", "Earlier this week"],
  ["month", "Earlier this month"],
] as const;

/**
 * Pinned (when any), Today, Yesterday, Earlier this week (from Monday), Earlier this month,
 * then one group per month, newest first. Days are calendar days in `tz`.
 */
export function groupChats(
  items: ChatSummary[],
  tz: string | null | undefined,
  now: Date = new Date(),
): ChatGroup[] {
  const today = dayIn(now, tz);
  const pinned: ChatSummary[] = [];
  const buckets = new Map<string, { label: string; order: number; items: ChatSummary[] }>();
  const put = (key: string, label: string, order: number, c: ChatSummary) => {
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { label, order, items: [] }));
    b.items.push(c);
  };
  for (const c of items) {
    if (c.pinned_at && !c.archived_at) {
      pinned.push(c);
      continue;
    }
    const day = dayIn(c.updated_at, tz);
    if (!day || !today) {
      put("today", "Today", 0, c);
      continue;
    }
    // Monday starts the week; a clock ahead of ours still counts as today.
    const weekStart = today.n - ((new Date(today.n * 86_400_000).getUTCDay() + 6) % 7);
    const rel =
      day.n >= today.n
        ? 0
        : day.n === today.n - 1
          ? 1
          : day.n >= weekStart
            ? 2
            : day.y === today.y && day.m === today.m
              ? 3
              : -1;
    if (rel >= 0) {
      const [key, label] = RELATIVE[rel as 0 | 1 | 2 | 3];
      put(key, label, rel, c);
    } else {
      // Older months sort after the relative groups, newest first.
      put(`${day.y}-${day.m}`, `${MONTH_NAMES[day.m - 1]} ${day.y}`, 1e6 - (day.y * 12 + day.m), c);
    }
  }
  const groups = [...buckets.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([key, b]) => ({ key, label: b.label, items: b.items }));
  return pinned.length ? [{ key: "pinned", label: "Pinned", items: pinned }, ...groups] : groups;
}

/** The time for a row: "14:05" today, "12 Oct" this year, "12 Oct 2025" before. */
export function chatTime(
  iso: string,
  tz: string | null | undefined,
  now: Date = new Date(),
): string {
  const day = dayIn(iso, tz);
  const today = dayIn(now, tz);
  if (!day || !today) return fmtDate(iso, tz);
  if (day.n === today.n) return fmtDateTime(iso, tz).split(", ")[1] ?? fmtDate(iso, tz);
  return day.y === today.y ? fmtAxisDate(iso, tz) : fmtDate(iso, tz);
}

// ── search ────────────────────────────────────────────────────────────────────

export interface TextPart {
  text: string;
  match: boolean;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `[start, end)` ranges of every query word in `text`, case-insensitive, merged when they touch. */
export function matchRanges(text: string, q: string): Array<[number, number]> {
  const words = [...new Set(q.trim().toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
  if (!text || !words.length) return [];
  // One pass per word, so overlapping words ("ab", "bc") both count.
  const hits: Array<[number, number]> = [];
  for (const w of words)
    for (const m of text.matchAll(new RegExp(escapeRe(w), "gi")))
      hits.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  hits.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [start, end] of hits) {
    const prev = out[out.length - 1];
    if (prev && start <= prev[1]) prev[1] = Math.max(prev[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** `text` cut into plain and matched parts, in order. */
export function highlightParts(text: string, q: string): TextPart[] {
  const ranges = matchRanges(text, q);
  if (!ranges.length) return text ? [{ text, match: false }] : [];
  const parts: TextPart[] = [];
  let at = 0;
  for (const [s, e] of ranges) {
    if (s > at) parts.push({ text: text.slice(at, s), match: false });
    parts.push({ text: text.slice(s, e), match: true });
    at = e;
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}

/** "1 chat found", "12 chats found", "30+ chats found" when more pages wait. */
export function resultLabel(count: number, hasMore: boolean): string {
  return `${count}${hasMore ? "+" : ""} ${count === 1 && !hasMore ? "chat" : "chats"} found`;
}

// ── the list ──────────────────────────────────────────────────────────────────

/** The engine's order: pinned first, then the newest activity. */
export function sortChats(list: ChatSummary[]): ChatSummary[] {
  const t = (s: string | null) => (s ? Date.parse(s) || 0 : 0);
  return [...list].sort(
    (a, b) => Number(!!b.pinned_at) - Number(!!a.pinned_at) || t(b.updated_at) - t(a.updated_at),
  );
}

export const belongsIn = (c: ChatSummary, view: ChatView) =>
  view === "archived" ? !!c.archived_at : !c.archived_at;

/**
 * Puts `c` in its place in `list`: replaced, dropped when it left this view, or added when it
 * came into it (`insert` false keeps a search's results to what the server matched).
 */
export function upsertChat(
  list: ChatSummary[],
  c: ChatSummary,
  view: ChatView,
  insert = true,
): ChatSummary[] {
  const had = list.some((x) => x.id === c.id);
  const rest = list.filter((x) => x.id !== c.id);
  if (!belongsIn(c, view) || (!had && !insert)) return had ? rest : list;
  return sortChats([...rest, c]);
}

export const removeChat = (list: ChatSummary[], id: string) => list.filter((x) => x.id !== id);

export interface ChatPatch {
  title?: string;
  archived?: boolean;
  pinned?: boolean;
  shared?: boolean;
}

/** What the engine will return for `patch`, to show before it answers. Archiving unpins. */
export function patchChat(c: ChatSummary, patch: ChatPatch, nowIso: string): ChatSummary {
  const next = { ...c };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.archived !== undefined) {
    next.archived_at = patch.archived ? (c.archived_at ?? nowIso) : null;
    if (patch.archived) next.pinned_at = null;
  }
  if (patch.pinned !== undefined) next.pinned_at = patch.pinned ? (c.pinned_at ?? nowIso) : null;
  if (patch.shared !== undefined) next.shared_at = patch.shared ? (c.shared_at ?? nowIso) : null;
  return next;
}

/** A title the engine accepts (1–120 characters), or null for an empty one. */
export function cleanTitle(raw: string): string | null {
  const t = raw.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX).trim();
  return t ? t : null;
}

// ── sharing ───────────────────────────────────────────────────────────────────

export const SHARED_PARAM = "billy";
const CHAT_ID = /^acv_[A-Za-z0-9]{6,80}$/;

/** The link another member opens: the business home with the panel on that chat. */
export function sharedChatUrl(origin: string, biz: string, id: string): string {
  return `${origin}/businesses/${encodeURIComponent(biz)}?${SHARED_PARAM}=${encodeURIComponent(id)}`;
}

/** The chat id in a `?billy=` link, or null. */
export function sharedChatId(search: string): string | null {
  const id = new URLSearchParams(search).get(SHARED_PARAM);
  return id && CHAT_ID.test(id) ? id : null;
}

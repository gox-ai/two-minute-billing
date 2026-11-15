/**
 * The figure check: every number in an answer must come from what the tools returned.
 *
 * Evidence is every number in the turn's tool results, in the forms a reader meets it: as
 * stored, a minor amount as major (÷100), a fraction as a percent (×100), and numbers inside
 * strings, and the length of every list (a count of the records returned). A figure that
 * matches none is UNVERIFIED and the panel marks it. Small integers (≤ 31: days, counts,
 * ordinals) and years are not claims worth checking.
 *
 * A figure is read as written: Indian digit groups (1,23,456), a scale word or suffix ($47.9k,
 * $1.2 million, ₹2.5 lakh), and rounding to the precision shown — "$47,908" and "4.2%" match
 * 47,908.47 and 4.18. Two decimals or more must match exactly.
 *
 * Record ids (`inv_…`, `cus_…`, …) in the answer are links when a tool returned them, and a
 * docs URL is a link only when a tool returned it: a model that shortens or builds a URL
 * produces a page that does not exist, so that URL is `unverified_links` and shows as text.
 */

const NUM_IN_TEXT = /-?\d[\d,]*(?:\.\d+)?/g;
const FIGURE =
  /(?<![\w./-]|\d,)[-−]?(?:\d{1,3}(?:,\d{3})+|\d{1,3}(?:,\d{2})+,\d{3}|\d+)(?!,\d)(?:\.\d+)?(?:%|\s?(?:k|K|M|bn)\b|\s(?:thousand|million|billion|lakh|crore)\b)?(?![\w/])/g;
const SCALE: Record<string, number> = {
  k: 1e3,
  K: 1e3,
  thousand: 1e3,
  M: 1e6,
  million: 1e6,
  bn: 1e9,
  billion: 1e9,
  lakh: 1e5,
  crore: 1e7,
};
const RECORD_ID = /\b(?:cus|sub|inv|cn|txn|pi|pm|evt|key|biz)_[A-Za-z0-9]{8,}\b/g;
const URL_IN_TEXT = /https:\/\/[^\s)<>"'`\]]+/g;
const noFragment = (u: string) => u.split("#")[0]!.replace(/[.,;:]+$/, "");

function addNumber(set: Set<number>, n: number) {
  if (!Number.isFinite(n)) return;
  // A decrease is stored signed but written without its sign ("fell by $2,091.53", "churn of
  // $3,913.82"), so the unsigned value is evidence too.
  for (const v of n < 0 ? [n, -n] : [n]) {
    set.add(round(v));
    set.add(round(v / 100));
    set.add(round(v * 100));
  }
}

const round = (n: number) => Math.round(n * 100) / 100;

export function collectEvidence(results: unknown[]): {
  numbers: Set<number>;
  ids: Set<string>;
  urls: Set<string>;
} {
  const numbers = new Set<number>();
  const ids = new Set<string>();
  const urls = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "number") addNumber(numbers, v);
    else if (Array.isArray(v)) {
      numbers.add(v.length);
      v.forEach(walk);
    } else if (typeof v === "string") {
      for (const m of v.match(NUM_IN_TEXT) ?? []) addNumber(numbers, Number(m.replace(/,/g, "")));
      for (const m of v.match(RECORD_ID) ?? []) ids.add(m);
      for (const m of v.match(URL_IN_TEXT) ?? []) urls.add(noFragment(m));
      // A dashboard path a tool returned (find_screen), e.g. /businesses/biz_…/settings/dunning.
      if (/^\/[a-z][\w/{}.-]*$/i.test(v)) urls.add(noFragment(v));
    } else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  results.forEach(walk);
  return { numbers, ids, urls };
}

/**
 * Exact at two decimals or more; otherwise any evidence that rounds to the figure as written
 * ("47,908" ← 47,908.47, "4.2" ← 4.18, "47.9k" ← 47,908.47).
 */
function matches(numbers: Set<number>, n: number, decimals: number, scale: number): boolean {
  if (scale === 1 && decimals >= 2) return numbers.has(round(n));
  const half = (0.5 * scale) / 10 ** decimals + 1e-9;
  for (const e of numbers) if (Math.abs(Math.abs(e) - n) <= half) return true;
  return false;
}

export interface FigureCheck {
  checked: number;
  unverified: string[];
  links: string[];
  unknown_ids: string[];
  /** URLs in the answer that no tool returned (fragments ignored). */
  unverified_links: string[];
}

export function checkFigures(answer: string, results: unknown[]): FigureCheck {
  const { numbers, ids, urls } = collectEvidence(results);
  // Dates are not figures: drop ISO dates and times before scanning.
  const text = answer
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}\b/g, " ");
  const unverified: string[] = [];
  let checked = 0;
  for (const raw of text.match(FIGURE) ?? []) {
    const word = raw.match(/[a-zA-Z]+$/)?.[0];
    const digits = raw.replace(/[a-zA-Z%,\s]/g, "").replace("−", "-");
    const scale = word ? (SCALE[word] ?? 1) : 1;
    const n = Number(digits) * scale;
    if (!Number.isFinite(n)) continue;
    if (scale === 1 && Number.isInteger(n) && Math.abs(n) <= 31) continue;
    if (scale === 1 && Number.isInteger(n) && n >= 1990 && n <= 2100 && !raw.includes(","))
      continue;
    checked++;
    if (!matches(numbers, Math.abs(n), (digits.split(".")[1] ?? "").length, scale))
      unverified.push(raw);
  }
  const mentioned = [...new Set(answer.match(RECORD_ID) ?? [])];
  // Dashboard screens linked as markdown with a relative path: `[API keys](/developer)`.
  const internal = [...answer.matchAll(/\]\((\/[^)\s]+)\)/g)].map((m) => m[1]!);
  const cited = [
    ...new Set([
      ...(answer.match(URL_IN_TEXT) ?? []).map((u) => u.replace(/[.,;:]+$/, "")),
      ...internal,
    ]),
  ];
  return {
    unverified_links: cited.filter((u) => !urls.has(noFragment(u))),
    checked,
    unverified: [...new Set(unverified)],
    links: mentioned.filter((id) => ids.has(id)),
    unknown_ids: mentioned.filter((id) => !ids.has(id)),
  };
}

/** Each page's title by its URL (fragment dropped), from tool results that carry both. */
export function urlTitles(results: unknown[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.url === "string" && typeof o.title === "string" && o.title.trim())
        if (!out.has(noFragment(o.url))) out.set(noFragment(o.url), o.title.trim());
      Object.values(o).forEach(walk);
    }
  };
  results.forEach(walk);
  return out;
}

/** A bare URL whose page title a tool returned becomes a markdown link; other text stays. */
export function linkBareUrls(answer: string, titles: ReadonlyMap<string, string>): string {
  if (!titles.size) return answer;
  return answer.replace(URL_IN_TEXT, (u: string, at: number, all: string) => {
    const before = all.slice(Math.max(0, at - 2), at);
    if (before === "](" || before.endsWith("<")) return u;
    const url = u.replace(/[.,;:]+$/, "");
    const title = titles.get(noFragment(url));
    return title ? `[${title.replace(/[[\]]/g, "")}](${url})${u.slice(url.length)}` : u;
  });
}

/**
 * The answer without links no tool returned: a markdown link keeps its text, a bare URL goes.
 * The panel already shows such links as text; the stored answer should not carry them either.
 */
export function dropUnverifiedLinks(answer: string, unverified: string[]): string {
  if (!unverified.length) return answer;
  const bad = new Set(unverified.map(noFragment));
  return answer
    .replace(/\[([^\]]*)\]\(\s*([^)\s]+)\s*\)/g, (m, label: string, url: string) =>
      bad.has(noFragment(url.replace(/[.,;:]+$/, ""))) ? label : m,
    )
    .replace(URL_IN_TEXT, (u) => (bad.has(noFragment(u.replace(/[.,;:]+$/, ""))) ? "" : u))
    .replace(/[ \t]+([.,;:])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]+$/gm, "");
}

/** Dashboard pages of the records a turn read, which an answer may link. */
export function recordPaths(business: string, ids: Iterable<string>): string[] {
  const route: Record<string, string> = {
    inv: "invoices",
    cus: "customers",
    sub: "subscriptions",
    cn: "credit_notes",
    txn: "transactions",
    pi: "payment_intents",
  };
  const out: string[] = [];
  for (const id of ids) {
    const r = route[id.split("_")[0]!];
    if (r) out.push(`/businesses/${business}/${r}/${id}`);
  }
  return out;
}

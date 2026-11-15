/**
 * Full-text search over the docs index, and exact API operations from the OpenAPI document.
 *
 * A section matches on ANY word of the question (keyword-only: plus the docs' own term for
 * common synonyms, which widens the match but never ranks), ranked by cover density, and gains a bonus when it holds ALL of them. Requiring
 * every word missed most natural questions ("how do I authenticate API requests?").
 * Results are one per page (its best section); help pages outrank API reference pages,
 * which outrank engine notes, in the keyword and the meaning list alike (`SOURCE_WEIGHT`).
 *
 * The database ranks candidates; `rescore` then picks the section: a heading that names the
 * question's words wins over body text that merely contains them, a page's opening summary and
 * index pages give way to a matching section, and developer pages (the API reference, the
 * webhook event list) yield to guides for an operator and lead for a developer (`Audience`).
 */
import { sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { openapiDocument } from "@/api/openapi";
import { vectorIndexVersion, vectorSearch, vectorsConfigured } from "./vectors";

export type DocSource = "help" | "api" | "engine" | "ui" | "code";

export interface DocHit {
  source: DocSource;
  title: string;
  heading: string | null;
  url: string | null;
  path: string;
  excerpt: string;
  /** The whole section (≤ ~2,000 characters). */
  body: string;
  rank: number;
}

/**
 * How much a match on each source counts, in both lists. The API reference is one page per
 * operation, so some operation always matches a question about its resource, by word and by
 * meaning alike.
 */
export const SOURCE_WEIGHT: Record<DocSource, number> = {
  help: 1,
  api: 0.45,
  engine: 0.4,
  ui: 0.4,
  code: 0.4,
};
const WEIGHT = sql.raw(
  `case c.source ${Object.entries(SOURCE_WEIGHT)
    .map(([s, w]) => `when '${s}' then ${w}`)
    .join(" ")} end`,
);

/**
 * Words people use → the term the docs use: general billing vocabulary, for finding pages in
 * keyword-only search (no embeddings). It widens the OR query only; it never ranks. With
 * embeddings the meaning search covers this, so the list stays out of the query.
 */
const SYNONYMS: Array<[RegExp, string[]]> = [
  [/\bchargebacks?\b/, ["dispute"]],
  [/\b(cents?|decimals?)\b/, ["minor <-> unit", "money"]],
  [/\b(page through|paginat\w*|next page)\b/, ["pagination", "cursor"]],
  [/\b(too many|throttl\w*|429)\b/, ["rate <-> limit"]],
  [/\b(twice|duplicate\w*|retried|double)\b/, ["idempotency", "idempotent"]],
  [/\b(authenticat\w*|log ?in|bearer)\b/, ["authentication", "api <-> key"]],
  [/\bsignatures?\b/, ["signing", "verify"]],
  [/\b(prorat\w*|mid-?cycle|middle of the month)\b/, ["proration", "upgrade"]],
  [/\b(upi|autopay|e-?mandates?)\b/, ["mandate"]],
  [/\b(seats?|feature access|features per plan)\b/, ["entitlement"]],
  [/\b(organi[sz]ations?)\b/, ["hierarchy"]],
  [/\b(real payments?|production)\b/, ["go <-> live", "live <-> mode"]],
  [/\b(first product|catalog)\b/, ["catalogue"]],
  [/\bsales tax\b/, ["tax <-> rate", "tax <-> region"]],
  [/\bevent types?\b|\bwhich webhook events\b/, ["event <-> reference"]],
  [/\brefunds?\b/, ["credit <-> note"]],
];

/** The OR query: each word of the question, plus (keyword-only) the docs' terms for its synonyms. */
export function orQuery(question: string, synonyms = false): string | null {
  const q = question.toLowerCase();
  const words = q.match(/[a-z0-9]{2,}/g) ?? [];
  const extra = synonyms ? SYNONYMS.filter(([re]) => re.test(q)).flatMap(([, t]) => t) : [];
  const parts = [...new Set([...words.slice(0, 20), ...extra.map((t) => `(${t})`)])];
  return parts.length ? parts.join(" | ") : null;
}

const SOURCES: readonly DocSource[] = ["help", "api", "engine", "ui", "code"];

const STOP = new Set(
  "a an and are be by can do does for from how i in is it my of on or the to what when where which who why will with you your me we our this that there".split(
    " ",
  ),
);
const stem = (words: string[]) => [
  ...new Set(words.filter((w) => !STOP.has(w)).map((w) => w.slice(0, 5))),
];
/** The words that carry the question, cut to a crude stem ("exemptions" → "exemp"). */
export function keyStems(question: string): string[] {
  return stem(question.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []);
}
/** Words on half the pages: a heading that names only these says little about the section. */
const GENERIC = new Set(
  "custo invoi payme subsc billi plan plans price accou busin add set use make get new chang creat api".split(
    " ",
  ),
);
interface Candidate extends DocHit {
  sqlRank: number;
  /** Search notes: a context line, then one phrase per line. */
  notes?: string | null;
}

/** A developer page: the API reference, or anything under the help's developer section. */
export const isDeveloperPage = (h: Pick<DocHit, "source" | "url">) =>
  h.source === "api" || (h.url ?? "").includes("/help/developers/");

/** Who is asking: an operator gets guides first, a developer the API. Unset: no preference. */
export type Audience = "operator" | "developer";

/** Who the page is for, against who is asking. */
function pageWeight(
  question: string,
  r: Pick<DocHit, "source" | "url" | "path">,
  audience?: Audience,
): number {
  const url = r.url ?? "";
  let weight = 1;
  if (audience === "operator") {
    if (r.source === "api") weight *= 0.6;
    // Concept pages too: they explain the product to someone writing code.
    else if (url.includes("/help/developers/")) weight *= 0.8;
  } else if (audience === "developer") {
    if (r.source === "api") weight *= 1.6;
    else if (!url.includes("/help/developers/")) weight *= 0.85;
  }
  // The event list names every object: it answers only questions about webhooks or events.
  if (url.includes("/developers/webhooks/events") && !/\b(webhooks?|events?)\b/i.test(question))
    weight *= 0.6;
  if (/(^|\/)(index|\d+\.index)\.md$/.test(r.path)) weight *= 0.6;
  return weight;
}

/** Words in code or a label list: identifiers split ("maxExcessPayment" → "max excess payment"). */
function codeWords(text: string): string[] {
  return (
    text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z0-9]{2,}/g) ?? []
  ).filter((h) => !STOP.has(h));
}
/** A capitalised constant is usually a registry (every event, every permission): it names everything. */
const REGISTRY = /^[A-Z][A-Z0-9_]+$/;

/**
 * The final keyword order: database rank × page weight + a bonus for a heading that names the
 * question. With `notes` (hybrid search), a search-note phrase that names the question counts
 * like a heading, and a matching heading still wins a tie.
 */
export function rescore(
  question: string,
  rows: Candidate[],
  notes = false,
  audience?: Audience,
): Candidate[] {
  const own = keyStems(question);
  const stems = own;
  // A word found on half the pages counts a little.
  const w = (st: string) => (GENERIC.has(st) ? 0.3 : 1);
  return rows.map((r) => {
    // Code, engine notes and screens: database rank favours a long list that repeats many
    // words. Rank by the share of the member's words the section covers instead, plus the
    // symbol name (code) or the single best control label (a screen) that names them.
    if (r.source === "code" || r.source === "engine" || r.source === "ui") {
      const total = own.reduce((n, st) => n + w(st), 0);
      const share = (words: string[]) =>
        total
          ? stems
              .filter((st) =>
                words.some((h) => h.startsWith(st) || (h.length >= 3 && st.startsWith(h))),
              )
              .reduce((n, st) => n + w(st), 0) / total
          : 0;
      const covered = Math.min(1, share(codeWords(`${r.heading ?? ""} ${r.body}`)));
      const best =
        r.source === "ui"
          ? Math.max(
              0,
              ...(/On this screen: (.*)$/m.exec(r.body)?.[1] ?? "")
                .split(" · ")
                .map((c) => Math.min(1, share(codeWords(c)))),
              Math.min(1, share(codeWords(r.heading ?? r.title))),
            )
          : Math.min(1, share(codeWords(r.heading ?? "")));
      const registry = r.source === "code" && REGISTRY.test(r.heading ?? "") ? 0.5 : 1;
      return { ...r, rank: (covered + 0.5 * best + 0.2 * Math.min(1, r.sqlRank)) * registry };
    }
    // A page's opening has no heading: its title names it (an API page's title is the operation).
    const heads = ((r.heading ?? r.title).toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).filter(
      (h) => !STOP.has(h),
    );
    // Share of the member's own words the heading names.
    const total = own.reduce((n, st) => n + w(st), 0);
    const named = total
      ? Math.min(
          1,
          stems
            // "too" must not match "to": a heading word names a stem only from 3 letters up.
            .filter((st) =>
              heads.some((h) => h.startsWith(st) || (h.length >= 3 && st.startsWith(h))),
            )
            .reduce((n, st) => n + w(st), 0) / total,
        )
      : 0;
    // The phrase from the section's notes that best matches the member's words.
    const asked = total
      ? Math.max(
          0,
          ...(r.notes ?? "")
            .split("\n")
            .slice(1)
            .map((ask) => {
              const words = (ask.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).filter(
                (h) => !STOP.has(h),
              );
              return (
                own
                  .filter((st) =>
                    words.some((h) => h.startsWith(st) || (h.length >= 3 && st.startsWith(h))),
                  )
                  .reduce((n, st) => n + w(st), 0) / total
              );
            }),
        )
      : 0;
    let weight = pageWeight(question, r, audience);
    if (!r.heading && stems.length > 1) weight *= 0.9;
    if (!notes) return { ...r, rank: r.sqlRank * weight + 0.35 * named };
    // A heading is the docs' own statement, a note phrase only a hint: on a tie the heading wins.
    return { ...r, rank: (r.sqlRank + 0.35 * Math.max(named, asked) + 0.1 * named) * weight };
  });
}

/** Reciprocal rank fusion constant: the usual 60, so neither list's top ranks dominate. */
const RRF_K = 60;
/**
 * A page found only by meaning must be at least this close (cosine) to count. Code's shortened
 * vectors sit higher on the scale: nonsense reaches ~0.43 there, real questions 0.49–0.65.
 */
const MIN_SIMILARITY = 0.3;
const MIN_CODE_SIMILARITY = 0.45;

/**
 * A section's closeness in meaning, at its source's weight: the weight scales only what lies
 * above the floor of "unrelated", so it orders sources as the keyword list does without pushing
 * a close API page below an unrelated guide. One source alone keeps its order.
 */
export function meaningScore(cosine: number, source: DocSource): number {
  return MIN_SIMILARITY + (cosine - MIN_SIMILARITY) * SOURCE_WEIGHT[source];
}

/**
 * Hybrid search: keyword (with the section notes) and meaning (embeddings of each section with
 * its notes) run side by side and merge by rank, one result per page. Keyword-only when vectors
 * are off (`vectors: false`, no platform key, or the embedding call fails).
 */
type SearchOpts = {
  limit?: number;
  sources?: DocSource[];
  vectors?: boolean;
  paths?: string[];
  /** Who asked, for the embedding usage record; absent = platform-wide. */
  organizationId?: string | null;
  /** Who the answer is for: ranks guides or the API first. */
  audience?: Audience;
};

/** Repeated searches: the index changes only on deploy, so results are kept per index version. */
const RESULT_CACHE = 500;
const results = new Map<string, Promise<DocHit[]>>();
let keywordVersion: { at: number; hash: string } | null = null;

/** Forget cached results (the index was rebuilt in this process). */
export function clearSearchCache(): void {
  results.clear();
  keywordVersion = null;
}

async function indexVersion(hybrid: boolean): Promise<string> {
  if (hybrid) {
    const v = await vectorIndexVersion();
    if (v) return v;
  }
  if (!keywordVersion || Date.now() - keywordVersion.at > 60_000) {
    const [row] = (await systemDb.execute(
      sql`select content_hash from assistant_doc_index where id = 1`,
    )) as unknown as Array<{ content_hash: string | null }>;
    keywordVersion = { at: Date.now(), hash: row?.content_hash ?? "" };
  }
  return keywordVersion.hash;
}

export async function searchDocs(question: string, opts: SearchOpts = {}): Promise<DocHit[]> {
  const hybrid = opts.vectors !== false && vectorsConfigured();
  const key = JSON.stringify([
    await indexVersion(hybrid),
    hybrid,
    question.trim().slice(0, 300),
    [...(opts.sources ?? [])].sort(),
    opts.limit ?? 5,
    opts.paths ?? null,
    opts.audience ?? null,
  ]);
  let hit = results.get(key);
  if (hit) {
    results.delete(key);
  } else {
    hit = runSearch(question, opts);
    hit.catch(() => results.delete(key));
    if (results.size >= RESULT_CACHE) results.delete(results.keys().next().value!);
  }
  results.set(key, hit);
  return (await hit).map((h) => ({ ...h }));
}

async function runSearch(question: string, opts: SearchOpts): Promise<DocHit[]> {
  const q = question.trim().slice(0, 300);
  const hybrid = opts.vectors !== false && vectorsConfigured();
  const any = orQuery(q, !hybrid);
  if (!any) return [];
  // The help and the API reference unless the caller names the sources (screens, code).
  const sources = (opts.sources ?? ["help", "api"]).filter((s) => SOURCES.includes(s));
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 10);
  // Code and screens rank by coverage after the query, so they need a wider first cut; their
  // excerpt is never shown, so skip the highlighter for them.
  const wide = sources.every((s) => s === "code" || s === "ui" || s === "engine");
  const pool = wide ? 500 : 120;
  // Only these pages (a screen's route); null = any.
  const paths = opts.paths?.length ? opts.paths : null;
  const pathOk = (h: { path: string }) => !paths || paths.includes(h.path);
  const excerpt = wide
    ? sql`left(body, 240)`
    : sql`ts_headline('english', body, (select q from qo), 'MaxFragments=2, MaxWords=35, MinWords=12')`;
  // Keyword-only search leaves the notes out (weight D), as it ranked before they existed.
  const vec = hybrid ? sql`c.search` : sql`ts_filter(c.search, '{a,b,c}')`;
  const [rows, near] = await Promise.all([
    systemDb.execute(sql`
      with qa as (select websearch_to_tsquery('english', ${q}) as q),
      qo as (select to_tsquery('english', ${any}) as q),
      hits as (
        select c.id, c.source, c.title, c.heading, c.url, c.path, c.body, c.notes,
               (ts_rank_cd(${vec}, qo.q, 1 | 32) + case when ${vec} @@ qa.q then 0.2 else 0 end)
                 * ${WEIGHT} as rank
        from assistant_doc_chunks c, qa, qo
        where c.search @@ qo.q and ${vec} @@ qo.q
          and c.source = any(${sql.raw(`array[${sources.map((s) => `'${s}'`).join(",")}]`)})
          ${
            paths
              ? sql`and c.path in (${sql.join(
                  paths.map((x) => sql`${x}`),
                  sql`, `,
                )})`
              : sql``
          }
      ),
      top as (select * from hits order by rank desc limit ${pool})
      select id, source, title, heading, url, path, rank, body, notes, ${excerpt} as excerpt
      from top
    `) as unknown as Promise<Array<Hit & { rank: string | number; notes: string | null }>>,
    hybrid
      ? vectorSearch(q, sources, wide ? 600 : 100, opts.organizationId ?? null)
      : Promise.resolve(null),
  ]);
  const scored = rescore(
    q,
    rows.map((r) => ({
      ...r,
      sqlRank: Number(r.rank),
      rank: Number(r.rank),
      excerpt: String(r.excerpt ?? "").replace(/<\/?b>/g, ""),
    })),
    hybrid,
    opts.audience,
  ).sort((a, b) => b.rank - a.rank);
  // Every row carries its id from the query above.
  const keyword = scored.map(({ sqlRank: _sql, notes: _notes, ...hit }) => hit) as Hit[];
  const close = (near ?? [])
    .filter((n) => n.score >= (n.source === "code" ? MIN_CODE_SIMILARITY : MIN_SIMILARITY))
    .map((n) => ({ ...n, score: meaningScore(n.score, n.source as DocSource) }))
    .sort((a, b) => b.score - a.score);
  if (!close.length) return onePerPage(keyword).slice(0, limit);
  return (await fuse(keyword, close, any)).filter(pathOk).slice(0, limit);
}

type Hit = DocHit & { id: string };

/** One result per page: its best section, in order. */
function onePerPage<T extends DocHit>(hits: T[], max = 10): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const h of hits) {
    if (seen.has(h.path)) continue;
    seen.add(h.path);
    out.push(h);
    if (out.length === max) break;
  }
  return out.map(({ id: _id, ...h }: T & { id?: string }) => h as T);
}

/**
 * Merge keyword and meaning by reciprocal rank, at two levels. Pages are ordered by their rank
 * in each list; within a page, the section is the one with the best combined rank, so each list
 * can correct the other's pick.
 */
async function fuse(
  keyword: Hit[],
  near: Array<{ id: string; score: number }>,
  any: string,
): Promise<DocHit[]> {
  const known = new Set(keyword.map((h) => h.id));
  const missing = near.filter((n) => !known.has(n.id)).map((n) => n.id.replace(/[^0-9a-f-]/gi, ""));
  const fetched = missing.length
    ? ((await systemDb.execute(sql`
        select id, source, title, heading, url, path, body,
               ts_headline('english', body, to_tsquery('english', ${any}), 'MaxFragments=2, MaxWords=35, MinWords=12') as excerpt
        from assistant_doc_chunks where id = any(${sql.raw(`array[${missing.map((id) => `'${id}'::uuid`).join(",")}]`)})
      `)) as unknown as Hit[])
    : [];
  const rows = new Map<string, Hit>(keyword.map((h) => [h.id, h]));
  for (const r of fetched) {
    const excerpt = String(r.excerpt ?? "").replace(/<\/?b>/g, "") || r.body.slice(0, 240);
    rows.set(r.id, { ...r, excerpt, rank: 0 });
  }
  const rrf = (i: number) => (i < 0 ? 0 : 1 / (RRF_K + i));
  const kwSection = new Map(keyword.map((h, i) => [h.id, i]));
  const nearSection = new Map(near.map((n, i) => [n.id, i]));
  // Page ranks: the keyword's ten best pages, and every page the vectors found close enough.
  const kwPages = onePerPage(keyword).map((h) => h.path);
  const nearPages = [...new Set(near.map((n) => rows.get(n.id)?.path).filter(Boolean))] as string[];
  const pages = new Set([...kwPages, ...nearPages]);
  const out: DocHit[] = [];
  for (const path of pages) {
    let best: Hit | null = null;
    let bestScore = -1;
    for (const h of rows.values()) {
      if (h.path !== path) continue;
      const sc = rrf(kwSection.get(h.id) ?? -1) + rrf(nearSection.get(h.id) ?? -1);
      if (sc > bestScore) [best, bestScore] = [h, sc];
    }
    if (!best) continue;
    // No audience weight here: rank scores sit close together, and keyword ranks already carry it.
    const score = rrf(kwPages.indexOf(path)) + rrf(nearPages.indexOf(path));
    const { id: _id, ...hit } = best;
    out.push({ ...hit, rank: score });
  }
  return out.sort((a, b) => b.rank - a.rank);
}

type Doc = {
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
};

/** Resolve `$ref`s to component schemas, a few levels deep. */
function deref(v: unknown, depth = 0): unknown {
  if (depth > 4 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => deref(x, depth + 1));
  const ref = (v as { $ref?: string }).$ref;
  if (typeof ref === "string") {
    const name = ref.split("/").pop()!;
    return deref((openapiDocument as unknown as Doc).components?.schemas?.[name] ?? {}, depth + 1);
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = deref(x, depth + 1);
  return out;
}

/** One operation, exactly as documented. `path` may use `{biz}` or `:biz` placeholders. */
export function apiOperation(method: string, path: string): Record<string, unknown> | null {
  const doc = openapiDocument as unknown as Doc;
  const want = path
    .trim()
    .replace(/:([A-Za-z_]+)/g, "{$1}")
    .replace(/\/+$/, "");
  const ops = doc.paths[want];
  const op = ops?.[method.toLowerCase()];
  if (!op) return null;
  return { method: method.toUpperCase(), path: want, ...(deref(op) as Record<string, unknown>) };
}

/** Operations whose path or summary contains every word of `query`. */
export function findApiOperations(
  query: string,
  limit = 10,
): Array<{ method: string; path: string; summary: string }> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: Array<{ method: string; path: string; summary: string }> = [];
  for (const [path, ops] of Object.entries((openapiDocument as unknown as Doc).paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const summary = String((op as { summary?: string }).summary ?? "");
      const hay = `${method} ${path} ${summary}`.toLowerCase();
      if (words.every((w) => hay.includes(w)))
        out.push({ method: method.toUpperCase(), path, summary });
    }
  }
  return out.slice(0, limit);
}

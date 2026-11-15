/**
 * Embeddings for hybrid docs search. Every section is embedded (help and API with their search
 * notes, screens with their controls, engine notes, code), stored once per distinct text in
 * `assistant_doc_vectors`, and held in memory for search: ~4,200 sections × 1,536 floats, and
 * ~17,500 code sections × 256 floats (the model's shortened vectors; the query vector is cut to
 * the same length, so one embedding call serves both).
 *
 * Only the platform OpenAI key is used, never an organization's own key: the docs are the same
 * for everyone. Without that key, search is keyword-only.
 */
import { createHash } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import { embed, embedMany } from "ai";
import { eq, sql } from "drizzle-orm";
import { config } from "@/platform/config";
import { systemDb } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { resolveListPrice } from "@/modules/model-prices/resolve";
import { assistantDocIndex, assistantDocVectors, assistantEmbeddingUsage } from "@db/schema";
import type { DocChunk } from "./chunk";
import { EMBED_MODEL, EMBED_PROVIDER, embeddingCostFixed12 } from "./embed-cost";

const log = createLogger("assistant-docs");

const DIMS = 1536;
/** Code is most of the index: shortened vectors keep it at ~18 MB in memory. */
const CODE_DIMS = 256;
const dimsOf = (source: string) => (source === "code" ? CODE_DIMS : DIMS);
/** Part of the index hash: a new model or length re-keys every section, so it is re-embedded. */
export const EMBED_SETTINGS = `${EMBED_MODEL}:${DIMS}:${CODE_DIMS}`;
/** ~1,500 tokens: inside the model's limit, and a batch stays under the request limit. */
const MAX_CHARS = 6000;
const BATCH = 100;

export function vectorsConfigured(): boolean {
  return (
    config.ASSISTANT_DOCS_VECTORS !== "off" &&
    config.ASSISTANT_PROVIDER === "openai" &&
    !!config.ASSISTANT_API_KEY &&
    !config.ASSISTANT_BASE_URL
  );
}

const model = () => createOpenAI({ apiKey: config.ASSISTANT_API_KEY! }).embeddingModel(EMBED_MODEL);

/** What is embedded: where the section sits, its notes, then its text. */
export function embedText(c: Pick<DocChunk, "title" | "heading" | "body" | "notes">): string {
  return `${c.title}${c.heading ? ` — ${c.heading}` : ""}\n${c.notes ? `${c.notes}\n` : ""}${c.body}`.slice(
    0,
    MAX_CHARS,
  );
}

/** Every section; code at its own length, so its hash names the length too. */
export function embedHash(c: DocChunk): string | null {
  const model = c.source === "code" ? `${EMBED_MODEL}:${CODE_DIMS}` : EMBED_MODEL;
  return createHash("sha256")
    .update(`${model}\0${embedText(c)}`)
    .digest("hex")
    .slice(0, 32);
}

/** Batches of at most `size` sections that share one vector length (code, then the rest). */
export function embedBatches<T extends { source: string }>(
  rows: T[],
  size = BATCH,
): Array<{ dims: number; rows: T[] }> {
  const out: Array<{ dims: number; rows: T[] }> = [];
  for (const dims of [CODE_DIMS, DIMS]) {
    const same = rows.filter((r) => dimsOf(r.source) === dims);
    for (let i = 0; i < same.length; i += size) out.push({ dims, rows: same.slice(i, i + size) });
  }
  return out;
}

/**
 * One row of embedding use on our key, at the list price: we pay the provider, so an
 * organization's own cost rows do not apply. Never throws; a failure is logged.
 */
export async function recordEmbeddingUsage(u: {
  kind: "index" | "query";
  organizationId: string | null;
  inputs: number;
  tokens: number;
}): Promise<void> {
  try {
    await systemDb.transaction(async (tx) => {
      const price = await resolveListPrice(
        tx,
        { provider: EMBED_PROVIDER, model: EMBED_MODEL, tokenType: "input", currency: "USD" },
        new Date(),
      );
      await tx.insert(assistantEmbeddingUsage).values({
        organizationId: u.organizationId,
        kind: u.kind,
        provider: EMBED_PROVIDER,
        model: EMBED_MODEL,
        inputs: u.inputs,
        inputTokens: u.tokens,
        costFixed12: embeddingCostFixed12(u.tokens, price),
      });
    });
  } catch (e) {
    log.warn("embedding usage not recorded", {
      event: "assistant_embedding_usage_failed",
      kind: u.kind,
      error: String(e).slice(0, 200),
    });
  }
}

/** Embed the sections that have no vector yet; drop vectors no section uses. */
export async function ensureDocVectors(): Promise<{ embedded: number }> {
  if (!vectorsConfigured()) return { embedded: 0 };
  // Counted per batch, so a run that fails halfway still records what it spent.
  const spent = { inputs: 0, tokens: 0 };
  try {
    return await embedPending(spent);
  } finally {
    if (spent.tokens > 0)
      void recordEmbeddingUsage({ kind: "index", organizationId: null, ...spent });
  }
}

async function embedPending(spent: {
  inputs: number;
  tokens: number;
}): Promise<{ embedded: number }> {
  const embedded = await systemDb.transaction(async (tx) => {
    const [lock] = (await tx.execute(
      sql`select pg_try_advisory_xact_lock(hashtext('assistant_doc_vectors')) as ok`,
    )) as unknown as Array<{ ok: boolean }>;
    if (!lock?.ok) return 0;
    const todo = (await tx.execute(sql`
      select distinct on (c.embed_hash) c.embed_hash as hash, c.source, c.title, c.heading, c.body, c.notes
      from assistant_doc_chunks c
      where c.embed_hash is not null
        and not exists (select 1 from assistant_doc_vectors v where v.hash = c.embed_hash)
    `)) as unknown as Array<{
      hash: string;
      source: string;
      title: string;
      heading: string | null;
      body: string;
      notes: string | null;
    }>;
    for (const { dims, rows: batch } of embedBatches(todo)) {
      const { embeddings, usage } = await embedMany({
        model: model(),
        values: batch.map((r) => embedText(r)),
        maxParallelCalls: 2,
        ...(dims === DIMS ? {} : { providerOptions: { openai: { dimensions: dims } } }),
      });
      spent.inputs += batch.length;
      spent.tokens += usage.tokens;
      await tx
        .insert(assistantDocVectors)
        .values(
          batch.map((r, j) => ({
            hash: r.hash,
            model: EMBED_MODEL,
            dims,
            vector: Buffer.from(new Float32Array(embeddings[j]!).buffer),
          })),
        )
        .onConflictDoNothing();
    }
    await tx.execute(sql`
      delete from assistant_doc_vectors v
      where not exists (select 1 from assistant_doc_chunks c where c.embed_hash = v.hash)
    `);
    return todo.length;
  });
  if (embedded) log.info("docs vectors embedded", { event: "assistant_docs_embedded", embedded });
  return { embedded };
}

interface Block {
  dims: number;
  ids: string[];
  sources: string[];
  vec: Float32Array;
}
interface Matrix {
  indexHash: string;
  checkedAt: number;
  blocks: Block[];
}
let matrix: Matrix | null = null;
const size = (m: Matrix) => m.blocks.reduce((n, b) => n + b.ids.length, 0);

/**
 * The vectors of the current index, checked once a minute and reloaded when the index or the
 * number of vectors changed: another API process may still be embedding when this one loads.
 */
async function loadMatrix(): Promise<Matrix | null> {
  if (matrix && Date.now() - matrix.checkedAt < 60_000) return size(matrix) ? matrix : null;
  const [state] = await systemDb
    .select()
    .from(assistantDocIndex)
    .where(eq(assistantDocIndex.id, 1));
  const [count] = (await systemDb.execute(
    sql`select count(*)::int as n from assistant_doc_vectors`,
  )) as unknown as Array<{ n: number }>;
  const indexHash = `${state?.contentHash ?? ""}:${count?.n ?? 0}`;
  if (matrix && matrix.indexHash === indexHash) {
    matrix.checkedAt = Date.now();
    return size(matrix) ? matrix : null;
  }
  const blocks: Block[] = [];
  for (const dims of [DIMS, CODE_DIMS]) {
    const rows = (await systemDb.execute(sql`
      select c.id, c.source, v.vector
      from assistant_doc_chunks c join assistant_doc_vectors v on v.hash = c.embed_hash
      where v.dims = ${dims}
    `)) as unknown as Array<{ id: string; source: string; vector: Buffer }>;
    const vec = new Float32Array(rows.length * dims);
    rows.forEach((r, i) => {
      const b = r.vector;
      vec.set(new Float32Array(b.buffer, b.byteOffset, dims), i * dims);
    });
    blocks.push({ dims, ids: rows.map((r) => r.id), sources: rows.map((r) => r.source), vec });
  }
  matrix = { indexHash, checkedAt: Date.now(), blocks };
  return size(matrix) ? matrix : null;
}

/** The first `dims` values of a vector, scaled back to length 1 (how the model shortens). */
function shorten(v: number[], dims: number): Float32Array {
  const out = Float32Array.from(v.slice(0, dims));
  const norm = Math.hypot(...out) || 1;
  for (let i = 0; i < dims; i++) out[i]! /= norm;
  return out;
}

/** Query embeddings by text: a repeated question (or one searched in several sources) costs one call. */
const QUERY_CACHE = 500;
const queryVectors = new Map<string, Promise<number[]>>();

function queryEmbedding(question: string, organizationId: string | null): Promise<number[]> {
  const hit = queryVectors.get(question);
  if (hit) {
    // Most recent last, so the oldest is evicted first.
    queryVectors.delete(question);
    queryVectors.set(question, hit);
    return hit;
  }
  const p = embed({
    model: model(),
    value: question,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(2500),
  }).then((r) => {
    void recordEmbeddingUsage({ kind: "query", organizationId, inputs: 1, tokens: r.usage.tokens });
    return r.embedding;
  });
  queryVectors.set(question, p);
  p.catch(() => queryVectors.delete(question));
  if (queryVectors.size > QUERY_CACHE) queryVectors.delete(queryVectors.keys().next().value!);
  return p;
}

/** Load the vectors now, so the first question after a start does not wait for them. */
export async function warmDocVectors(): Promise<void> {
  if (vectorsConfigured()) await loadMatrix();
}

/** The vectors' version: changes when the index is rebuilt or re-embedded. */
export async function vectorIndexVersion(): Promise<string | null> {
  if (!vectorsConfigured()) return null;
  return (await loadMatrix())?.indexHash ?? null;
}

/**
 * The `limit` sections closest in meaning to the question, best first, with their cosine.
 * Null when vectors are off or unavailable: the caller then searches by keyword only.
 */
export async function vectorSearch(
  question: string,
  sources: readonly string[],
  limit = 100,
  /** The organization asking, for the usage record; null = platform-wide. */
  organizationId: string | null = null,
): Promise<Array<{ id: string; source: string; score: number }> | null> {
  if (!vectorsConfigured()) return null;
  try {
    const [m, q] = await Promise.all([loadMatrix(), queryEmbedding(question, organizationId)]);
    if (!m) return null;
    const hits: Array<{ id: string; source: string; score: number }> = [];
    for (const blk of m.blocks) {
      const qv = blk.dims === DIMS ? q : shorten(q, blk.dims);
      for (let i = 0; i < blk.ids.length; i++) {
        if (!sources.includes(blk.sources[i]!)) continue;
        let s = 0;
        const o = i * blk.dims;
        for (let d = 0; d < blk.dims; d++) s += qv[d]! * blk.vec[o + d]!;
        hits.push({ id: blk.ids[i]!, source: blk.sources[i]!, score: s });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  } catch (e) {
    log.warn("docs vector search failed; keyword only", {
      event: "assistant_docs_vector_failed",
      error: String(e).slice(0, 200),
    });
    return null;
  }
}

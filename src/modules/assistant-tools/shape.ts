/**
 * Prepares a tool result for a language model: invisible characters out, size capped.
 *
 * Customer-written fields (names, notes, metadata, memos) reach the model through these
 * results. Zero-width, bidi-override and Unicode tag characters are a known way to hide
 * instructions in them, and none of them is ever meaningful billing data.
 */

// Zero-width + joiners, bidi overrides/isolates, word joiner..invisible plus, BOM.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/gu;

export function stripInvisible<T>(value: T): T {
  if (typeof value === "string") return value.replace(INVISIBLE, "") as T;
  if (Array.isArray(value)) return value.map(stripInvisible) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripInvisible(v);
    return out as T;
  }
  return value;
}

/** ~15k tokens. Clients cap results too (Claude Code at 25k); stay well under. */
export const MAX_RESULT_CHARS = 60_000;

/**
 * Serialize, shrinking `data` arrays (anywhere one level down) until the text fits.
 * A cut result says so, and how to get the rest.
 */
export function capResult(value: unknown, max = MAX_RESULT_CHARS): string {
  let text = JSON.stringify(value);
  if (text.length <= max) return text;
  const copy = structuredClone(value) as Record<string, unknown>;
  const lists = findDataArrays(copy);
  while (text.length > max && lists.some((l) => l.arr.length > 1)) {
    for (const l of lists) {
      if (l.arr.length > 1) l.arr.length = Math.ceil(l.arr.length / 2);
      l.owner["truncated"] =
        "Only the first rows are shown. Ask for fewer rows with limit, or page with starting_after.";
    }
    text = JSON.stringify(copy);
  }
  if (text.length <= max) return text;
  return JSON.stringify({
    truncated: "The result was too large to return. Ask for less detail or a smaller page.",
    preview: text.slice(0, max - 200),
  });
}

/** What the in-app assistant's model receives per tool result (~5k tokens). MCP keeps 60k. */
export const MODEL_RESULT_CHARS = 20_000;
/** Rows of a list the model sees unless it asked for a limit. */
export const MODEL_LIST_ROWS = 10;
/** A metadata object larger than this is left out (the model can read the record for it). */
const METADATA_CHARS = 400;
/** Strings longer than this are cut when a result is still too large. */
const LONG_STRING = 1_500;

const isEmpty = (v: unknown) =>
  v === null ||
  v === undefined ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);

/**
 * Drop what carries no answer: null and empty fields, large metadata blobs, and `object` type
 * tags. In a list, a field with the same value in every row is said once (`same_in_every_row`).
 */
export function lean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(lean).filter((v) => !isEmpty(v));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(value)) {
    if (k === "object" && typeof raw === "string") continue;
    if (k === "metadata" && JSON.stringify(raw ?? null).length > METADATA_CHARS) {
      out.metadata = "(left out: large; read the record alone to see it)";
      continue;
    }
    const v = lean(raw);
    if (!isEmpty(v)) out[k] = v;
  }
  const rows = out.data;
  if (Array.isArray(rows) && rows.length > 2 && rows.every((r) => r && typeof r === "object")) {
    const first = rows[0] as Record<string, unknown>;
    const same: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(first)) {
      if (k === "id" || (v !== null && typeof v === "object")) continue;
      if (rows.every((r) => (r as Record<string, unknown>)[k] === v)) same[k] = v;
    }
    if (Object.keys(same).length) {
      out.data = rows.map((r) => {
        const o = { ...(r as Record<string, unknown>) };
        for (const k of Object.keys(same)) delete o[k];
        return o;
      });
      out.same_in_every_row = same;
    }
  }
  return out;
}

/**
 * A tool result as the in-app model receives it: lean, lists at `rows` unless the model asked
 * for more, then capped at `max` by halving lists and cutting long strings, never mid-JSON.
 */
export function shapeForModel(value: unknown, opts: { rows?: number; max?: number } = {}): string {
  const max = opts.max ?? MODEL_RESULT_CHARS;
  const copy = lean(structuredClone(value)) as Record<string, unknown>;
  if (opts.rows) {
    for (const l of copy && typeof copy === "object" ? findDataArrays(copy) : []) {
      if (l.arr.length <= opts.rows) continue;
      const total = l.arr.length;
      l.arr.length = opts.rows;
      // Paging from here would skip the rows left out: ask again with a larger limit instead.
      delete l.owner.next_cursor;
      l.owner.more_rows = `Showing ${opts.rows} of the ${total} rows read${l.owner.has_more ? " (more exist)" : ""}. To see more, call again with limit.`;
    }
  }
  let text = JSON.stringify(copy);
  if (text.length <= max) return text;
  const cut = (v: unknown): unknown => {
    if (typeof v === "string")
      return v.length > LONG_STRING ? `${v.slice(0, LONG_STRING)}… (cut)` : v;
    if (Array.isArray(v)) return v.map(cut);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x)]));
    return v;
  };
  return capResult(cut(copy), max);
}

function findDataArrays(
  root: Record<string, unknown>,
): Array<{ owner: Record<string, unknown>; arr: unknown[] }> {
  const found: Array<{ owner: Record<string, unknown>; arr: unknown[] }> = [];
  const visit = (o: unknown, depth: number) => {
    if (!o || typeof o !== "object" || Array.isArray(o) || depth > 2) return;
    const rec = o as Record<string, unknown>;
    if (Array.isArray(rec.data)) found.push({ owner: rec, arr: rec.data });
    for (const v of Object.values(rec)) visit(v, depth + 1);
  };
  visit(root, 0);
  return found;
}

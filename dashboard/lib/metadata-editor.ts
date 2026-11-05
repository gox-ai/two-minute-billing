// The pure half of the metadata editor: rule tree, path edits, and the form-state ↔ value
// mapping. No React, so it is unit-tested. Relative imports only (vitest maps `@/` to src/).
import { checkValue, resolvePath, segmentsOf, type RuleSpec } from "./metadata-rules-check";

export type Meta = Record<string, unknown>;

/**
 * The rule fields the editor reads: a structural subset of the API's `MetadataKeyRule`, declared
 * here so this file imports nothing from the server-only API client.
 */
export interface EditorRule {
  key: string;
  data_type: "string" | "number" | "boolean" | "date" | "email" | "enum" | "object" | "array";
  enum_options: string[] | null;
  pattern: string | null;
  max_length: number | null;
  integer: boolean;
  min: number | null;
  max: number | null;
  item_type: "string" | "number" | "boolean" | null;
  item_enum_options: string[] | null;
  min_items: number | null;
  max_items: number | null;
  description: string | null;
}

/** A path the API has seen in this business's records (`GET …/metadata_observed_keys`). */
export interface ObservedKey {
  path: string;
  rows: number;
  type: "string" | "number" | "boolean" | "object" | "array" | "null";
  distinct_values: number;
  values: Array<{ value: string | number | boolean; rows: number }> | null;
  item_values: Array<{ value: string | number | boolean; rows: number }> | null;
}

export function toSpec(r: EditorRule): RuleSpec {
  return {
    key: r.key,
    dataType: r.data_type,
    enumOptions: r.enum_options,
    pattern: r.pattern,
    maxLength: r.max_length,
    integerOnly: r.integer,
    minValue: r.min,
    maxValue: r.max,
    itemType: r.item_type,
    itemEnumOptions: r.item_enum_options,
    minItems: r.min_items,
    maxItems: r.max_items,
  };
}

const isObj = (v: unknown): v is Meta => typeof v === "object" && v !== null && !Array.isArray(v);

// ── the rule tree ─────────────────────────────────────────────────────────────

export interface RuleNode {
  path: string;
  segs: string[];
  /** The last segment: what the control is labelled. */
  label: string;
  /** Null for an ancestor that only exists because a rule sits below it. */
  rule: EditorRule | null;
  children: RuleNode[];
}

/** Rules → a tree by dot path. An ancestor with no rule of its own becomes a plain group. */
export function buildRuleTree(rules: EditorRule[]): RuleNode[] {
  const roots: RuleNode[] = [];
  const byPath = new Map<string, RuleNode>();
  const ensure = (segs: string[]): RuleNode => {
    const path = segs.join(".");
    const found = byPath.get(path);
    if (found) return found;
    const node: RuleNode = { path, segs, label: segs[segs.length - 1]!, rule: null, children: [] };
    byPath.set(path, node);
    if (segs.length === 1) roots.push(node);
    else ensure(segs.slice(0, -1)).children.push(node);
    return node;
  };
  for (const r of [...rules].sort((a, b) => a.key.localeCompare(b.key)))
    ensure(segmentsOf(r.key)).rule = r;
  return roots;
}

/** True when `segs` has its own rule or a rule below it. */
export function isCovered(rules: EditorRule[], segs: string[]): boolean {
  return rules.some((r) => {
    const p = segmentsOf(r.key);
    return p.length >= segs.length && segs.every((s, i) => p[i] === s);
  });
}

// ── path edits (immutable, key order kept) ────────────────────────────────────

/** Set `segs` to `value`, creating object parents as needed. Key order is kept. */
export function setAt(meta: Meta | null, segs: string[], value: unknown): Meta {
  const [head, ...rest] = segs;
  const base = meta ?? {};
  const out: Meta = {};
  let placed = false;
  for (const [k, v] of Object.entries(base)) {
    if (k === head) {
      out[k] = rest.length ? setAt(isObj(v) ? v : {}, rest, value) : value;
      placed = true;
    } else out[k] = v;
  }
  if (!placed) out[head!] = rest.length ? setAt({}, rest, value) : value;
  return out;
}

/** Remove `segs`. A parent object that this leaves empty is removed too. */
export function deleteAt(meta: Meta | null, segs: string[]): Meta {
  const [head, ...rest] = segs;
  const base = meta ?? {};
  if (!(head! in base)) return base;
  const out: Meta = {};
  for (const [k, v] of Object.entries(base)) {
    if (k !== head) out[k] = v;
    else if (rest.length && isObj(v)) {
      const inner = deleteAt(v, rest);
      if (Object.keys(inner).length) out[k] = inner;
    }
  }
  return out;
}

/** The top-level keys no rule covers: the "Other keys" area. */
export function otherKeys(meta: Meta | null, rules: EditorRule[]): Meta {
  const out: Meta = {};
  for (const [k, v] of Object.entries(meta ?? {})) if (!isCovered(rules, [k])) out[k] = v;
  return out;
}

/**
 * Replace the uncovered top-level keys with `other`. Covered keys keep their place; a key that
 * stays keeps its place; new keys go at the end.
 */
export function withOtherKeys(meta: Meta | null, rules: EditorRule[], other: Meta): Meta {
  const out: Meta = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (isCovered(rules, [k])) out[k] = v;
    else if (k in other) out[k] = other[k];
  }
  for (const [k, v] of Object.entries(other)) if (!(k in out)) out[k] = v;
  return out;
}

/** Keys stored inside a group that no rule covers. Kept on save; shown as a note. */
export function uncoveredChildren(
  meta: Meta | null,
  rules: EditorRule[],
  node: RuleNode,
): string[] {
  const r = resolvePath(meta, node.segs);
  if (r.state !== "value" || !isObj(r.value)) return [];
  return Object.keys(r.value).filter((k) => !isCovered(rules, [...node.segs, k]));
}

export const emptyMeta = (m: Meta | null | undefined) => !m || Object.keys(m).length === 0;

/** The text the form posts: pretty JSON, or "" for none. Matches the old textarea's format. */
export const metaText = (m: Meta | null | undefined) =>
  emptyMeta(m) ? "" : JSON.stringify(m, null, 2);

// ── one rule's control ────────────────────────────────────────────────────────

export type FieldKind =
  | "select"
  | "tristate"
  | "number"
  | "text"
  | "email"
  | "date"
  | "chips"
  | "list"
  | "json";

/** A rule → the control that edits it. `hasChildren`: the node has rules below it. */
export function fieldKind(r: EditorRule): FieldKind {
  switch (r.data_type) {
    case "enum":
      return "select";
    case "boolean":
      return "tristate";
    case "number":
      return "number";
    case "email":
      return "email";
    case "date":
      return "date";
    case "string":
      return "text";
    case "array":
      if (r.item_enum_options?.length) return "chips";
      return r.item_type ? "list" : "json";
    default:
      return "json";
  }
}

/** What a control shows. `raw` is a string, or a string list for chips and list controls. */
export interface FieldDisplay {
  raw: string | string[];
  /** The stored value does not fit the control; it is shown as text and kept as stored. */
  readOnly: boolean;
}

const scalarText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** A stored value → the control's display. Absent shows empty. */
export function displayOf(
  r: EditorRule,
  kind: FieldKind,
  present: boolean,
  v: unknown,
): FieldDisplay {
  if (!present || v === null)
    return { raw: kind === "chips" || kind === "list" ? [] : "", readOnly: false };
  const ro = { raw: JSON.stringify(v), readOnly: true };
  switch (kind) {
    case "select":
      return typeof v === "string" && (r.enum_options ?? []).includes(v)
        ? { raw: v, readOnly: false }
        : ro;
    case "tristate":
      return typeof v === "boolean" ? { raw: String(v), readOnly: false } : ro;
    case "number":
      return typeof v === "number" ? { raw: String(v), readOnly: false } : ro;
    case "text":
    case "email":
    case "date":
      return typeof v === "string" ? { raw: v, readOnly: false } : ro;
    case "chips":
      return Array.isArray(v) &&
        v.every((x) => typeof x === "string" && (r.item_enum_options ?? []).includes(x))
        ? { raw: v as string[], readOnly: false }
        : ro;
    case "list": {
      const ok =
        Array.isArray(v) &&
        v.every((x) =>
          r.item_type
            ? typeof x === r.item_type
            : ["string", "number", "boolean"].includes(typeof x),
        );
      return ok ? { raw: (v as unknown[]).map(scalarText), readOnly: false } : ro;
    }
    default:
      return { raw: JSON.stringify(v, null, 2), readOnly: false };
  }
}

export type Parsed = { absent: true } | { absent: false; value: unknown } | { error: string };

/** A control's raw input → the value to store. Empty is absent: every path is optional. */
export function parseField(r: EditorRule, kind: FieldKind, raw: string | string[]): Parsed {
  if (Array.isArray(raw)) {
    const items = raw.map((s) => s.trim()).filter((s) => s !== "");
    if (!items.length) return { absent: true };
    if (kind === "chips") return { absent: false, value: items };
    const out: unknown[] = [];
    for (const [i, s] of items.entries()) {
      if (r.item_type === "number") {
        const n = Number(s);
        if (!Number.isFinite(n)) return { error: `Item ${i + 1} must be a number.` };
        out.push(n);
      } else if (r.item_type === "boolean") {
        if (s !== "true" && s !== "false") return { error: `Item ${i + 1} must be true or false.` };
        out.push(s === "true");
      } else out.push(s);
    }
    return { absent: false, value: out };
  }
  const s = raw.trim();
  if (s === "") return { absent: true };
  switch (kind) {
    case "tristate":
      return { absent: false, value: s === "true" };
    case "number": {
      const n = Number(s);
      return Number.isFinite(n) ? { absent: false, value: n } : { error: "Enter a number." };
    }
    case "json":
      try {
        return { absent: false, value: JSON.parse(s) };
      } catch {
        return { error: "Enter valid JSON." };
      }
    default:
      return { absent: false, value: raw };
  }
}

/** The rule's own check on a value: the same function the API runs. */
export const ruleError = (r: EditorRule, value: unknown) => checkValue(toSpec(r), value);

/** Pull the path out of a server refusal: `Metadata path "a.b" …`. */
export function pathOfError(message: string | null | undefined): string | null {
  const m = /Metadata path "([^"]+)"/.exec(message ?? "");
  return m ? m[1]! : null;
}

// ── suggestions ───────────────────────────────────────────────────────────────

/** Observed top-level keys no rule covers and not already in use: for an "Add key" row. */
export function keySuggestions(
  observed: ObservedKey[],
  rules: EditorRule[],
  used: string[],
): ObservedKey[] {
  return observed.filter(
    (o) => !o.path.includes(".") && !isCovered(rules, [o.path]) && !used.includes(o.path),
  );
}

/** Observed paths with no rule, for "Suggested from your data". Nested paths included. */
export function ruleSuggestions(observed: ObservedKey[], rules: EditorRule[]): ObservedKey[] {
  const ruled = new Set(rules.map((r) => r.key));
  const segment = /^[A-Za-z0-9_-]+$/;
  return observed.filter(
    (o) =>
      !ruled.has(o.path) && o.type !== "null" && o.path.split(".").every((s) => segment.test(s)),
  );
}

/** A rule pre-filled from an observed path: its type, and its values when they are few. */
export function draftRuleFrom(o: ObservedKey): {
  key: string;
  data_type: EditorRule["data_type"];
  enum_options: string[] | null;
  item_type: EditorRule["item_type"];
  item_enum_options: string[] | null;
} {
  const strings = (vs: ObservedKey["values"]) =>
    vs && vs.length && vs.every((v) => typeof v.value === "string" && v.value !== "")
      ? vs.map((v) => v.value as string)
      : null;
  if (o.type === "string") {
    const opts = o.distinct_values <= 10 ? strings(o.values) : null;
    return {
      key: o.path,
      data_type: opts ? "enum" : "string",
      enum_options: opts,
      item_type: null,
      item_enum_options: null,
    };
  }
  if (o.type === "array") {
    const items = o.item_values;
    const t0 = items?.length ? (typeof items[0]!.value as "string" | "number" | "boolean") : null;
    const itemType = t0 && items!.every((v) => typeof v.value === t0) ? t0 : null;
    return {
      key: o.path,
      data_type: "array",
      enum_options: null,
      item_type: itemType,
      item_enum_options: itemType === "string" ? strings(items) : null,
    };
  }
  const t = o.type === "number" || o.type === "boolean" || o.type === "object" ? o.type : "string";
  return {
    key: o.path,
    data_type: t,
    enum_options: null,
    item_type: null,
    item_enum_options: null,
  };
}

/** Top values of an observed key, as text, for a value suggestion list. */
export const valueHints = (o: ObservedKey | undefined) =>
  (o?.values ?? []).map((v) => ({
    text: scalarText(v.value),
    rows: v.rows,
    json: typeof v.value !== "string",
  }));

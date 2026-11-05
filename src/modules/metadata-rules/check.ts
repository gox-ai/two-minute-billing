import { z } from "zod";

// Pure: no database, so the rules can be unit-tested and reused by any writer.

export const METADATA_RULE_ENTITIES = ["customer", "subscription"] as const;
export type MetadataRuleEntity = (typeof METADATA_RULE_ENTITIES)[number];

export const METADATA_RULE_TYPES = [
  "string",
  "number",
  "boolean",
  "date",
  "email",
  "enum",
  "object",
  "array",
] as const;
export type MetadataRuleType = (typeof METADATA_RULE_TYPES)[number];

/** Types whose value is a string, so `pattern` and `max_length` apply. */
const TEXT_TYPES: readonly MetadataRuleType[] = ["string", "email", "enum", "date"];

/** Bounds on a rule's own config. A path segment shares the metadata key bound in `src/api/limits.ts`. */
export const RULE_LIMITS = {
  segment: 64,
  depth: 5,
  pattern: 200,
  description: 500,
  enumOptions: 100,
  enumOption: 200,
  maxLength: 16_000,
  /** Longest value a pattern is run against. Bounds the cost of an admin-written regex. */
  patternInput: 1024,
  /** Largest magnitude for a number rule's `min`/`max`: stays exact in a double. */
  bound: Number.MAX_SAFE_INTEGER,
  /** Largest `min_items` / `max_items`. */
  items: 10_000,
} as const;

/** Types an array rule can require of each item. */
export const METADATA_ITEM_TYPES = ["string", "number", "boolean"] as const;
export type MetadataItemType = (typeof METADATA_ITEM_TYPES)[number];

/**
 * How a writer applies the rules.
 * - `enforce`: types and strict.
 * - `supplied_only`: types only, no strict. For writers that cannot know a business's paths:
 *   hosted checkout, and integrations writing their own keys.
 * - `off`: nothing. For the importer and internal markers, which store data verbatim.
 */
export type MetadataRuleScope = "enforce" | "supplied_only" | "off";

/** A refused rule or metadata write. `statusCode` makes it a 400 wherever it is thrown. */
export class MetadataRuleError extends Error {
  readonly statusCode = 400;
  readonly errorType = "invalid_request_error";
  constructor(
    message: string,
    readonly param: string = "metadata",
  ) {
    super(message);
    this.name = "MetadataRuleError";
  }
}

/** The fields the validator reads. A subset of the row, so tests need no database. */
export interface RuleSpec {
  /** A dot path into `metadata`, e.g. `billing.po`. */
  key: string;
  dataType: string;
  enumOptions: unknown;
  pattern: string | null;
  maxLength: number | null;
  /** number rules: whole numbers only, and inclusive bounds. */
  integerOnly?: boolean | null;
  minValue?: number | null;
  maxValue?: number | null;
  /** array rules: the type and allowed values of each item, and the item count. */
  itemType?: string | null;
  itemEnumOptions?: unknown;
  minItems?: number | null;
  maxItems?: number | null;
}

const emailSchema = z.string().email();
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;
// A group that repeats and holds a repeat of its own, e.g. `(a+)+`. The classic
// catastrophic-backtracking shape; refused at config time.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[*+](?:[^()\\]|\\.)*\)\s*(?:[*+]|\{\d)/;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function isValidDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Split a rule path into its segments. Assumes the path passed `assertValidPath`. */
export const segmentsOf = (path: string) => path.split(".");

/** Compile a rule pattern as a full-value match, or throw a config error. */
export function compilePattern(pattern: string): RegExp {
  if (pattern.length > RULE_LIMITS.pattern)
    throw new MetadataRuleError(
      `pattern is too long. The maximum is ${RULE_LIMITS.pattern} characters.`,
      "pattern",
    );
  if (NESTED_QUANTIFIER.test(pattern))
    throw new MetadataRuleError(
      "pattern has a repeated group that contains a repeat, such as (a+)+. This can make each check very slow. Remove the inner or the outer repeat.",
      "pattern",
    );
  try {
    return new RegExp(`^(?:${pattern})$`, "u");
  } catch {
    throw new MetadataRuleError("pattern is not a valid regular expression.", "pattern");
  }
}

const describe = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "an array" : typeof v);

/** "a whole number of 0 or more", "a number from 1 to 10" … for a number rule's message. */
function numberPhrase(rule: RuleSpec): string {
  const what = rule.integerOnly ? "a whole number" : "a number";
  const lo = rule.minValue ?? null;
  const hi = rule.maxValue ?? null;
  if (lo !== null && hi !== null) return `${what} from ${lo} to ${hi}`;
  if (lo !== null) return `${what} of ${lo} or more`;
  if (hi !== null) return `${what} of ${hi} or less`;
  return what;
}

/** One array item against the rule's item constraints. */
function checkItem(rule: RuleSpec, at: string, item: unknown): string | null {
  const type = rule.itemType ?? null;
  if (type === "string" && typeof item !== "string")
    return `${at} must be a string, not ${describe(item)}.`;
  if (type === "number" && (typeof item !== "number" || !Number.isFinite(item)))
    return `${at} must be a number, not ${describe(item)}.`;
  if (type === "boolean" && typeof item !== "boolean")
    return `${at} must be true or false, not ${describe(item)}.`;
  const opts = Array.isArray(rule.itemEnumOptions) ? (rule.itemEnumOptions as string[]) : null;
  if (opts && opts.length > 0 && (typeof item !== "string" || !opts.includes(item)))
    return `${at} must be one of: ${opts.join(", ")}.`;
  return null;
}

/** One value against one rule. Returns the refusal message, or null when the value is valid. */
export function checkValue(rule: RuleSpec, value: unknown): string | null {
  const k = `Metadata path "${rule.key}"`;
  if (value === null || value === undefined) return null; // every path is optional
  switch (rule.dataType as MetadataRuleType) {
    case "string":
      if (typeof value !== "string") return `${k} must be a string, not ${describe(value)}.`;
      break;
    case "email":
      if (typeof value !== "string" || !emailSchema.safeParse(value).success)
        return `${k} must be a valid email address.`;
      break;
    case "enum": {
      const opts = Array.isArray(rule.enumOptions) ? (rule.enumOptions as string[]) : [];
      if (typeof value !== "string" || !opts.includes(value))
        return `${k} must be one of: ${opts.join(", ")}.`;
      break;
    }
    case "date":
      if (typeof value !== "string" || !isValidDate(value))
        return `${k} must be a date in the format YYYY-MM-DD, or an ISO 8601 date and time.`;
      break;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value))
        return `${k} must be a number, not ${describe(value)}.`;
      const lo = rule.minValue ?? null;
      const hi = rule.maxValue ?? null;
      if (
        (rule.integerOnly && !Number.isInteger(value)) ||
        (lo !== null && value < lo) ||
        (hi !== null && value > hi)
      )
        return `${k} must be ${numberPhrase(rule)}.`;
      break;
    }
    case "boolean":
      if (typeof value !== "boolean") return `${k} must be true or false, not ${describe(value)}.`;
      break;
    case "object":
      if (!isPlainObject(value)) return `${k} must be an object, not ${describe(value)}.`;
      break;
    case "array": {
      if (!Array.isArray(value)) return `${k} must be an array, not ${describe(value)}.`;
      if (rule.minItems != null && value.length < rule.minItems)
        return `${k} must have ${rule.minItems} or more items.`;
      if (rule.maxItems != null && value.length > rule.maxItems)
        return `${k} must have ${rule.maxItems} or fewer items.`;
      for (let i = 0; i < value.length; i++) {
        const msg = checkItem(rule, `${k}[${i}]`, value[i]);
        if (msg) return msg;
      }
      break;
    }
    default:
      return `${k} has a rule with an unknown type (${rule.dataType}).`;
  }
  if (typeof value === "string" && TEXT_TYPES.includes(rule.dataType as MetadataRuleType)) {
    if (rule.maxLength != null && value.length > rule.maxLength)
      return `${k} is too long. The maximum is ${rule.maxLength} characters.`;
    if (rule.pattern) {
      if (value.length > RULE_LIMITS.patternInput)
        return `${k} is too long to check against its pattern. The maximum is ${RULE_LIMITS.patternInput} characters.`;
      if (!compilePattern(rule.pattern).test(value))
        return `${k} does not match the pattern ${rule.pattern}.`;
    }
  }
  return null;
}

/** Where a path lands in a metadata object. */
type Resolved =
  | { state: "value"; value: unknown }
  | { state: "absent" }
  /** An intermediate exists but is not an object, so the path cannot be read. */
  | { state: "blocked"; at: string; value: unknown };

export function resolvePath(root: Record<string, unknown> | null, segs: string[]): Resolved {
  let cur: unknown = root ?? {};
  for (let i = 0; i < segs.length; i++) {
    if (cur === null || cur === undefined) return { state: "absent" };
    if (!isPlainObject(cur))
      return { state: "blocked", at: segs.slice(0, i).join("."), value: cur };
    if (!Object.prototype.hasOwnProperty.call(cur, segs[i]!)) return { state: "absent" };
    cur = cur[segs[i]!];
  }
  return { state: "value", value: cur };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameResolution = (a: Resolved, b: Resolved) =>
  a.state === b.state &&
  (a.state === "absent" ||
    (a.state === "value" && sameJson(a.value, (b as { value: unknown }).value)) ||
    (a.state === "blocked" && sameJson(a.value, (b as { value: unknown }).value)));

/**
 * Check a metadata write against a business's rules. Pure.
 *
 * ── WHAT IS JUDGED ──────────────────────────────────────────────────────────────
 * Writes REPLACE `metadata` wholesale, nested objects included — nothing is deep-merged — so
 * `next` is exactly the object that will be stored. A rule is judged only when the value at
 * its path differs from what is stored (`existing`). A value stored before its rule existed,
 * and sent back unchanged, still passes; that is what lets an old record be edited without
 * first fixing every key on it.
 *
 * ── PER RULE ────────────────────────────────────────────────────────────────────
 * The path is resolved in `next`. A missing intermediate means the path is absent. An
 * intermediate that exists but is not an object refuses the rule: the path cannot be read.
 * A present value that is not null must match the rule's type, pattern and length. An absent
 * path never fails: every path is optional. (A business that needs a mandatory value uses a
 * custom field, which has `required`.)
 *
 * ── STRICT (`enforce` only) ──────────────────────────────────────────────────────
 * Read level by level. The top level is always checked. A nested object is checked when at
 * least one active rule sits strictly below it (`billing` is checked when `billing.po` has a
 * rule). At a checked level, every key must be COVERED: it has its own rule, or it is an
 * ancestor of one. An uncovered key whose value is new or changed is refused. The contents of a
 * key whose rule has no child rules — an `object` rule with nothing under it, an `array`, a
 * scalar — are not checked further: they are free-form.
 *
 * ── THE SWITCH ───────────────────────────────────────────────────────────────────
 * With `validation` off (the business's default) nothing is checked, strict included.
 *
 * Throws `MetadataRuleError` on the first refusal.
 */
export function checkMetadataWrite(input: {
  /** The business's `metadata_validation` switch for this entity. */
  validation: "on" | "off";
  rules: RuleSpec[];
  strict: boolean;
  next: Record<string, unknown> | null;
  existing: Record<string, unknown> | null;
  mode: "create" | "update";
  scope: MetadataRuleScope;
}): void {
  if (input.validation !== "on" || input.scope === "off") return;
  const full = input.scope === "enforce";
  const next = input.next ?? {};
  const existing = input.mode === "create" ? {} : (input.existing ?? {});

  for (const rule of input.rules) {
    const segs = segmentsOf(rule.key);
    const now = resolvePath(next, segs);
    const before = resolvePath(existing, segs);
    const changed = !sameResolution(now, before);
    if (now.state === "blocked") {
      if (changed)
        throw new MetadataRuleError(
          `Metadata path "${rule.key}" cannot be checked: "${now.at}" is ${describe(now.value)}, not an object.`,
        );
      continue;
    }
    if (now.state === "value" && changed) {
      const msg = checkValue(rule, now.value);
      if (msg) throw new MetadataRuleError(msg);
    }
  }

  if (full && input.strict) checkStrict(input.rules, next, existing);
}

function checkStrict(
  rules: RuleSpec[],
  next: Record<string, unknown>,
  existing: Record<string, unknown>,
) {
  const paths = rules.map((r) => segmentsOf(r.key));
  const prefixOf = (p: string[], q: string[]) =>
    p.length < q.length && p.every((s, i) => q[i] === s);
  const same = (p: string[], q: string[]) => p.length === q.length && p.every((s, i) => q[i] === s);
  const hasChildRules = (p: string[]) => paths.some((q) => prefixOf(p, q));
  const covered = (p: string[]) => paths.some((q) => same(p, q)) || hasChildRules(p);

  const walk = (level: string[], node: unknown) => {
    if (!isPlainObject(node)) return; // a blocked path is the per-rule check's concern
    for (const [key, value] of Object.entries(node)) {
      const p = [...level, key];
      if (!covered(p)) {
        const before = resolvePath(existing, p);
        if (before.state === "value" && sameJson(before.value, value)) continue;
        throw new MetadataRuleError(
          `Metadata path "${p.join(".")}" is not allowed. This business accepts only the paths in its metadata rules.`,
        );
      }
      if (hasChildRules(p)) walk(p, value);
    }
  };
  walk([], next);
}

// ── config validation ─────────────────────────────────────────────────────────

/** A rule path: 1 to `depth` dot-separated segments of letters, digits, `_` and `-`. */
export function assertValidPath(path: string) {
  const segs = path.split(".");
  if (segs.length > RULE_LIMITS.depth)
    throw new MetadataRuleError(
      `key can have at most ${RULE_LIMITS.depth} levels, such as a.b.c.d.e.`,
      "key",
    );
  for (const s of segs) {
    if (!s || s.length > RULE_LIMITS.segment)
      throw new MetadataRuleError(
        `Each part of key must have 1 to ${RULE_LIMITS.segment} characters. Use a dot only between parts, such as billing.po.`,
        "key",
      );
    if (!SEGMENT.test(s))
      throw new MetadataRuleError(
        "key can contain only letters, digits, _ and -, with a dot between levels, such as billing.po.",
        "key",
      );
  }
}

/** Kept for callers of the flat-key era; a flat key is a one-level path. */
export const assertValidKey = assertValidPath;

export interface RuleConfigPatch {
  enumOptions?: string[] | null;
  pattern?: string | null;
  maxLength?: number | null;
  description?: string | null;
  integerOnly?: boolean | null;
  minValue?: number | null;
  maxValue?: number | null;
  itemType?: MetadataItemType | null;
  itemEnumOptions?: string[] | null;
  minItems?: number | null;
  maxItems?: number | null;
}

/** A list of 1 to `enumOptions` different non-empty strings. Shared by enum and item options. */
const isOptionList = (o: unknown): o is string[] =>
  Array.isArray(o) &&
  o.length > 0 &&
  o.length <= RULE_LIMITS.enumOptions &&
  o.every((s) => typeof s === "string" && s.length > 0 && s.length <= RULE_LIMITS.enumOption) &&
  new Set(o).size === o.length;

/**
 * The number and array options. Takes the rule's MERGED config (stored values with the patch on
 * top), so `min > max` is refused even when a patch changes only one bound.
 */
export function assertValidBounds(dataType: string, c: RuleConfigPatch) {
  const isNumber = dataType === "number";
  const isArray = dataType === "array";
  if ((c.integerOnly || c.minValue != null || c.maxValue != null) && !isNumber)
    throw new MetadataRuleError(
      "integer, min and max apply only to the number type.",
      c.integerOnly ? "integer" : c.minValue != null ? "min" : "max",
    );
  for (const [name, v] of [
    ["min", c.minValue],
    ["max", c.maxValue],
  ] as const) {
    if (v == null) continue;
    if (!Number.isFinite(v) || Math.abs(v) > RULE_LIMITS.bound)
      throw new MetadataRuleError(
        `${name} must be a finite number from -${RULE_LIMITS.bound} to ${RULE_LIMITS.bound}.`,
        name,
      );
  }
  if (c.minValue != null && c.maxValue != null && c.minValue > c.maxValue)
    throw new MetadataRuleError("min must be less than or equal to max.", "min");

  const itemSet =
    c.itemType != null || c.itemEnumOptions != null || c.minItems != null || c.maxItems != null;
  if (itemSet && !isArray)
    throw new MetadataRuleError(
      "item_type, item_enum_options, min_items and max_items apply only to the array type.",
      c.itemType != null
        ? "item_type"
        : c.itemEnumOptions != null
          ? "item_enum_options"
          : "min_items",
    );
  if (c.itemType != null && !(METADATA_ITEM_TYPES as readonly string[]).includes(c.itemType))
    throw new MetadataRuleError(
      `item_type must be one of: ${METADATA_ITEM_TYPES.join(", ")}.`,
      "item_type",
    );
  if (c.itemEnumOptions != null) {
    if (!isOptionList(c.itemEnumOptions))
      throw new MetadataRuleError(
        `item_enum_options must be a list of 1 to ${RULE_LIMITS.enumOptions} different values, each with 1 to ${RULE_LIMITS.enumOption} characters.`,
        "item_enum_options",
      );
    if (c.itemType !== "string")
      throw new MetadataRuleError("item_enum_options needs item_type string.", "item_enum_options");
  }
  for (const [name, v] of [
    ["min_items", c.minItems],
    ["max_items", c.maxItems],
  ] as const) {
    if (v == null) continue;
    if (!Number.isInteger(v) || v < 0 || v > RULE_LIMITS.items)
      throw new MetadataRuleError(
        `${name} must be a whole number from 0 to ${RULE_LIMITS.items}.`,
        name,
      );
  }
  if (c.minItems != null && c.maxItems != null && c.minItems > c.maxItems)
    throw new MetadataRuleError("min_items must be less than or equal to max_items.", "min_items");
}

export function assertValidOptions(dataType: string, input: RuleConfigPatch) {
  const text = TEXT_TYPES.includes(dataType as MetadataRuleType);
  if (input.pattern != null) {
    if (!text)
      throw new MetadataRuleError(
        "pattern applies only to the string, email, enum and date types.",
        "pattern",
      );
    compilePattern(input.pattern);
  }
  if (input.maxLength != null) {
    if (!text)
      throw new MetadataRuleError(
        "max_length applies only to the string, email, enum and date types.",
        "max_length",
      );
    if (
      !Number.isInteger(input.maxLength) ||
      input.maxLength < 1 ||
      input.maxLength > RULE_LIMITS.maxLength
    )
      throw new MetadataRuleError(
        `max_length must be a whole number from 1 to ${RULE_LIMITS.maxLength}.`,
        "max_length",
      );
  }
  if (input.enumOptions !== undefined && input.enumOptions !== null && dataType !== "enum")
    throw new MetadataRuleError("enum_options applies only to the enum type.", "enum_options");
  if (dataType === "enum" && input.enumOptions !== undefined) {
    if (!isOptionList(input.enumOptions))
      throw new MetadataRuleError(
        `enum_options must be a list of 1 to ${RULE_LIMITS.enumOptions} different values, each with 1 to ${RULE_LIMITS.enumOption} characters.`,
        "enum_options",
      );
  }
  if (input.description != null && input.description.length > RULE_LIMITS.description)
    throw new MetadataRuleError(
      `description is too long. The maximum is ${RULE_LIMITS.description} characters.`,
      "description",
    );
}

/**
 * Refuse a rule that would contradict the business's other active rules for the same entity:
 * - a path that already has a rule (active or archived — the path is the rule's identity);
 * - a rule below an ancestor whose rule is not `object` (the ancestor cannot hold children);
 * - a non-`object` rule at a path that already has rules below it.
 */
export function assertNoConflict(
  candidate: { key: string; dataType: string },
  others: Array<{ key: string; dataType: string; archived?: boolean }>,
) {
  const segs = segmentsOf(candidate.key);
  for (const o of others) {
    if (o.key === candidate.key)
      throw new MetadataRuleError(`A rule for the path "${candidate.key}" already exists.`, "key");
  }
  for (const o of others) {
    if (o.archived) continue;
    const os = segmentsOf(o.key);
    const oIsAncestor = os.length < segs.length && os.every((s, i) => segs[i] === s);
    const oIsDescendant = segs.length < os.length && segs.every((s, i) => os[i] === s);
    if (oIsAncestor && o.dataType !== "object")
      throw new MetadataRuleError(
        `"${o.key}" has a ${o.dataType} rule, so it cannot hold "${candidate.key}". Only an object rule can have rules below it.`,
        "key",
      );
    if (oIsDescendant && candidate.dataType !== "object")
      throw new MetadataRuleError(
        `"${candidate.key}" has rules below it, such as "${o.key}", so its type must be object.`,
        "data_type",
      );
  }
}

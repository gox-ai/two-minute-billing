/**
 * JSON with exact numbers. `JSON.parse` turns `0.1234567890123456789` into the nearest binary
 * float before any check can see it, so the ingest routes parse with the reviver's
 * `context.source` (Node ≥ 22.12) and keep every JSON number as its source text.
 */

/** A JSON number as written, with any exponent expanded. Serializes back as a raw number. */
export class JsonNumber {
  constructor(readonly text: string) {}
  toJSON(): unknown {
    return (JSON as unknown as { rawJSON: (t: string) => unknown }).rawJSON(this.text);
  }
  toString(): string {
    return this.text;
  }
}

/**
 * `1.5e-3` → `0.0015`, `-2E+2` → `-200`. Exact: digits are moved, never computed. A number
 * with no exponent comes back as written.
 */
export function expandExponent(src: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(src);
  if (!m) return src;
  const [, sign, int, frac = "", exp] = m;
  if (exp === undefined) return src;
  const e = parseInt(exp, 10);
  const digits = int! + frac;
  const point = int!.length + e;
  let whole: string;
  let rest: string;
  if (point <= 0) {
    whole = "0";
    rest = "0".repeat(-point) + digits;
  } else if (point >= digits.length) {
    whole = digits + "0".repeat(point - digits.length);
    rest = "";
  } else {
    whole = digits.slice(0, point);
    rest = digits.slice(point);
  }
  whole = whole.replace(/^0+(?=\d)/, "");
  rest = rest.replace(/0+$/, "");
  return `${sign}${whole}${rest ? `.${rest}` : ""}`;
}

/** `JSON.parse`, every number kept as a `JsonNumber`. */
export function parseJsonExact(text: string): unknown {
  return JSON.parse(text, function (_key, value, context?: { source?: string }) {
    if (typeof value === "number")
      return new JsonNumber(expandExponent(context?.source ?? String(value)));
    return value;
  });
}

/** A flat property object as JSON text, numbers written as received. */
export function propertiesJson(props: Record<string, unknown>): string {
  const parts = Object.entries(props).map(([k, v]) => {
    const val = v instanceof JsonNumber ? v.text : JSON.stringify(v);
    return `${JSON.stringify(k)}:${val}`;
  });
  return `{${parts.join(",")}}`;
}

/** A property value as the text a meter compares and parses. */
export function propertyText(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (v instanceof JsonNumber) return v.text;
  return String(v);
}

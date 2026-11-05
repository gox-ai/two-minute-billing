// Metadata as key/value rows: the model behind the catalog editor and the customer and
// subscription metadata editor. A non-string value is kept as JSON text and posted parsed.

export interface MetaRow {
  key: string;
  value: string;
  /** The stored value was not a string; `value` holds its JSON and posts parsed. */
  json: boolean;
}

export function metaRows(m: Record<string, unknown> | null | undefined): MetaRow[] {
  return Object.entries(m ?? {}).map(([key, v]) =>
    typeof v === "string"
      ? { key, value: v, json: false }
      : { key, value: JSON.stringify(v), json: true },
  );
}

/** Rows → the JSON the action stores, or an error naming the first bad row. */
export function metaJson(rows: MetaRow[]): { json: string; error?: string } {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (!key && !r.value.trim()) continue;
    if (!key) return { json: "", error: "Every value needs a key" };
    if (key.length > 64)
      return { json: "", error: `Key "${key.slice(0, 20)}…" is over 64 characters` };
    if (key in out) return { json: "", error: `Key "${key}" appears twice` };
    if (r.json) {
      try {
        out[key] = JSON.parse(r.value);
      } catch {
        return { json: "", error: `The value of "${key}" is not valid JSON` };
      }
    } else out[key] = r.value;
  }
  return { json: Object.keys(out).length ? JSON.stringify(out) : "" };
}

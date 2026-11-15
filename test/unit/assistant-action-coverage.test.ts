import { describe, expect, it } from "vitest";
import { ACTION_OPS } from "@/modules/assistant/actions";
import {
  cachedGet,
  fieldWording,
  lookupNames,
  requestLines,
  words,
  type Line,
} from "@/modules/assistant/action-lines";
import {
  NAMED,
  choiceFields,
  requestSchema,
  sampleBody,
  sampleParams,
  stubGet,
} from "./fixtures/assistant-action-bodies";

/** What the member reads on a line, without the edit control. */
const shown = (ls: Array<{ label: string; value: string; before?: string }>) =>
  ls.map(({ label, value, before }) =>
    before === undefined ? { label, value } : { label, value, before },
  );

const OPS = Object.keys(ACTION_OPS);
// Operations whose body the API reference does not describe: they take no body.
const NO_SCHEMA = new Set([
  "POST emails/{email}/resend",
  "DELETE unbilled_charges/{charge}",
  "DELETE usages/{usage}",
]);

async function render(op: string, body: Record<string, unknown>): Promise<Line[]> {
  const params = sampleParams(op);
  const get = cachedGet(stubGet);
  const { names, units } = await lookupNames(params, body, get);
  return requestLines(params, body, {
    currency: "INR",
    timezone: "Asia/Kolkata",
    operation: op,
    names,
    units,
  });
}

/** Every key in a body, with its parent's key. */
function keysOf(o: unknown, parent = ""): Array<[string, string]> {
  if (Array.isArray(o)) return o.flatMap((x) => keysOf(x, parent));
  if (!o || typeof o !== "object") return [];
  return Object.entries(o).flatMap(([k, v]) => [[parent, k] as [string, string], ...keysOf(v, k)]);
}

describe("every operation's card reads as the dashboard does", () => {
  it("covers every operation", () => {
    expect(OPS.length).toBeGreaterThanOrEqual(70);
    for (const op of OPS) if (!NO_SCHEMA.has(op)) expect(requestSchema(op), op).toBeTruthy();
  });

  for (const op of OPS) {
    it(op, async () => {
      const body = sampleBody(op);
      const lines = await render(op, body);
      for (const l of lines) {
        const where = `${op} → ${l.label}: ${l.value}`;
        expect(l.value, where).not.toMatch(/\[\{|\{"|":/);
        // A raw unix timestamp (seconds or ms) or an ISO instant.
        expect(l.value, where).not.toMatch(/\b1[5-9]\d{8}\b|\b\d{13}\b|\d{4}-\d{2}-\d{2}T/);
        expect(l.label, where).not.toMatch(/_/);
        // A record with a name shows the name, never its id.
        for (const id of Object.keys(NAMED)) expect(l.value, where).not.toContain(id);
        // The record is in INR.
        expect(l.value, where).not.toContain("$");
      }
      // Every field sent has its own label, not words(field).
      for (const k of Object.keys(body)) expect(fieldWording(op, k), `${op} → ${k}`).toBeTruthy();
      for (const [parent, k] of keysOf(body)) {
        if (!parent || fieldWording(op, parent)?.formatted) continue;
        if (fieldWording(op, `${parent}.${k}`) || fieldWording(op, k)) continue;
        expect(
          lines.some((l) => l.label === words(k)),
          `${op} → ${parent}.${k} has no label`,
        ).toBe(false);
      }
    });
  }

  it("says every option and switch in the dashboard's words, not Yes/No or the API value", () => {
    const missing: string[] = [];
    for (const op of OPS)
      for (const { path, values } of choiceFields(op)) {
        const parent = path.length > 1 ? fieldWording(op, path[0]!) : undefined;
        if (parent?.formatted) continue;
        const key = path.at(-1)!;
        const f = fieldWording(op, path.join(".")) ?? fieldWording(op, key);
        if (f?.formatted) continue;
        for (const v of values)
          if (!f?.options?.[String(v)]) missing.push(`${op} → ${path.join(".")} = ${String(v)}`);
      }
    expect(missing).toEqual([]);
  });

  it("formats dates in the business's zone and the dashboard's format", async () => {
    const lines = await render("POST subscriptions/{sub}/change_term_end", {
      term_ends_at: 1797638400,
      prorate: true,
    });
    expect(shown(lines)).toContainEqual({ label: "Term ends at", value: "19-Dec-2026 05:30" });
    expect(shown(lines)).toContainEqual({ label: "Proration", value: "Prorate the difference" });
  });

  it("lists items by name and quantity", async () => {
    const lines = await render("POST customers/{cus}/subscriptions", {
      items: [{ price: "price_T1", quantity: 2 }],
    });
    expect(shown(lines)).toContainEqual({ label: "Item", value: "Pro Monthly × 2" });
  });

  it("says a cancel at the end of the term the way the cancel dialog does", async () => {
    const lines = await render("POST subscriptions/{sub}/cancel", {
      cancel_option: "end_of_term",
      credit_option_for_current_term_charges: "prorate",
    });
    expect(lines.map((l) => l.value)).toEqual([
      "sub_T1",
      "Cancel at end of current term",
      "Issue prorated credits",
    ]);
  });

  it("says customer switches the way the customer form does", async () => {
    const lines = await render("PATCH customers/{cus}", { dunning_excluded: true });
    expect(shown(lines)).toEqual([
      { label: "Customer", value: "Halyard Analytics" },
      { label: "Dunning", value: "Exclude from dunning" },
    ]);
  });

  it("falls back to the id when a lookup fails", async () => {
    const lines = await render("POST invoices", { customer: "cus_UNKNOWN" });
    expect(shown(lines)).toContainEqual({ label: "Customer", value: "cus_UNKNOWN" });
  });
});

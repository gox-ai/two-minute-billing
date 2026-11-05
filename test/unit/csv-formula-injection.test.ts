import { describe, it, expect } from "vitest";
import { csvField, csvRow as serverRow } from "../../src/platform/csv";
import { csvCell, csvRow as dashboardRow } from "../../dashboard/lib/csv";

// Customer names reach exports from the public checkout and the portal, so a cell a
// spreadsheet would evaluate must arrive as text.
describe.each([
  ["engine (always quoted)", csvField],
  ["dashboard (quoted when needed)", csvCell],
] as const)("%s", (_, cell) => {
  const unquote = (s: string) => (s.startsWith('"') ? s.slice(1, -1).replaceAll('""', '"') : s);

  it.each([
    '=HYPERLINK("http://evil.example.com","Click")',
    "+1+1",
    "-2+3+cmd|' /C calc'!A0",
    "@SUM(A1)",
    "\t=1",
    "\r=1",
    "-",
    "+919876543210",
  ])("neutralises %j", (v) => {
    expect(unquote(cell(v))).toBe(`'${v}`);
  });

  it("quotes the neutralised formula so its quotes and commas stay in one field", () => {
    expect(cell('=HYPERLINK("x","y")')).toBe(`"'=HYPERLINK(""x"",""y"")"`);
  });

  it.each(["-12.50", "-3", "-0.5", "-1e-7", "12", "0"])(
    "keeps the plain number %j numeric",
    (v) => {
      expect(unquote(cell(v))).toBe(v);
    },
  );

  it.each([-12.5, -3, Number.NEGATIVE_INFINITY, -12n])("never prefixes a number value %s", (v) => {
    expect(unquote(cell(v))).toBe(String(v));
  });

  it("still quotes a comma", () => {
    expect(cell("Smith, John")).toBe('"Smith, John"');
  });

  it("leaves ordinary text and empty values alone", () => {
    expect(unquote(cell("Acme Ltd"))).toBe("Acme Ltd");
    expect(unquote(cell("2026-10-24T00:00:00Z"))).toBe("2026-10-24T00:00:00Z");
    expect(unquote(cell(null))).toBe("");
  });
});

describe("rows", () => {
  it("engine row quotes every field", () => {
    expect(serverRow(["=1+1", "-5", null])).toBe(`"'=1+1","-5",""`);
  });
  it("dashboard row quotes a carriage return", () => {
    expect(dashboardRow(["a\rb", "=1"])).toBe(`"a\rb",'=1`);
  });
});

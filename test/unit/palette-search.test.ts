import { describe, expect, it } from "vitest";
import { matches, orgBusinessPages, type OrgBusiness } from "../../dashboard/lib/palette-search";

const NORTH: OrgBusiness = { id: "biz_n", name: "Northwind", livemode: "live" };
const SAND: OrgBusiness = { id: "biz_s", name: "Sandbox Co", livemode: "test" };

const pagesOf = (b: OrgBusiness) => [
  { href: `/businesses/${b.id}`, label: "Home" },
  { href: `/businesses/${b.id}/customers`, label: "Customers", section: "Billing" },
  { href: `/businesses/${b.id}/invoices`, label: "Invoices", section: "Billing" },
  {
    href: `/businesses/${b.id}/settings/credit-units`,
    label: "Credit units",
    section: "Settings",
    keywords: ["custom units"],
  },
  {
    href: `/businesses/${b.id}/settings/invoices`,
    label: "Invoices",
    section: "Settings",
    keywords: ["numbering"],
  },
  { href: `/businesses/${b.id}/customers`, label: "Customers", section: "Billing" },
];

describe("matches", () => {
  it("needs every word somewhere in the text", () => {
    expect(matches("dunning north", "Dunning", "Northwind")).toBe(true);
    expect(matches("dunning south", "Dunning", "Northwind")).toBe(false);
  });
});

describe("orgBusinessPages", () => {
  it("finds each business's main page by its full word", () => {
    const hits = orgBusinessPages("customers", [NORTH, SAND], pagesOf);
    expect(hits.map((h) => [h.page.label, h.scope])).toEqual([
      ["Customers", "Northwind"],
      ["Customers", "Sandbox Co · Test"],
    ]);
  });
  it("ranks a page named by the word before a keyword match", () => {
    const hits = orgBusinessPages("cus", [NORTH], pagesOf);
    expect(hits.map((h) => h.page.label)).toEqual(["Customers", "Credit units"]);
  });
  it("lists a page once per business", () => {
    const hits = orgBusinessPages("customers", [NORTH], pagesOf);
    expect(hits.filter((h) => h.page.label === "Customers")).toHaveLength(1);
  });
  it("puts the main page before a settings page of the same name", () => {
    const hits = orgBusinessPages("invoices", [NORTH], pagesOf);
    expect(hits.map((h) => h.page.href)).toEqual([
      "/businesses/biz_n/invoices",
      "/businesses/biz_n/settings/invoices",
    ]);
  });
  it("narrows by the business name", () => {
    const hits = orgBusinessPages("invoices sandbox", [NORTH, SAND], pagesOf);
    expect(hits.every((h) => h.biz.id === "biz_s")).toBe(true);
    expect(hits).toHaveLength(2);
  });
  it("does not list every page for a business name alone", () => {
    expect(orgBusinessPages("northwind", [NORTH], pagesOf)).toEqual([]);
  });
  it("lists nothing for an empty query, and caps the rest", () => {
    expect(orgBusinessPages("  ", [NORTH], pagesOf)).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `biz_${i}`,
      name: `Biz ${i}`,
      livemode: "live",
    }));
    expect(orgBusinessPages("customers", many, pagesOf)).toHaveLength(8);
  });

  it("a top-level page ranks before a nested one, and twins are told apart", () => {
    const biz = [{ id: "b1", name: "Nimbus", livemode: "live" }];
    const hits = orgBusinessPages("invoices", biz, () => [
      { href: "/businesses/b1/settings/invoices", label: "Invoices" },
      { href: "/businesses/b1/invoices", label: "Invoices" },
    ]);
    expect(hits.map((h) => h.title)).toEqual(["Invoices", "Invoices (Settings)"]);
  });
});

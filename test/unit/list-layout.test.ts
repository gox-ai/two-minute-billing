import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chooseListLayout } from "../../dashboard/lib/list-layout";

const read = (p: string) => readFileSync(new URL(`../../dashboard/${p}`, import.meta.url), "utf8");

describe("chooseListLayout", () => {
  it("mounts both layouts until the card's verdict may be read", () => {
    expect(chooseListLayout(null)).toBe("both");
  });
  it("then mounts only the one the card's container query shows", () => {
    expect(chooseListLayout(true)).toBe("phone");
    expect(chooseListLayout(false)).toBe("table");
  });
});

describe("the list-narrow threshold", () => {
  const defs = [...read("app/globals.css").matchAll(/@custom-variant list-narrow \((.+)\);/g)];

  it("is defined once, as a rem container query on the list card", () => {
    expect(defs).toHaveLength(1);
    // rem, not px: px container queries sort first and lose.
    expect(defs[0]?.[1]).toBe("@container list (width < 52.5rem)");
  });

  it("is the only rule DataTable stacks by: no viewport breakpoint decides the layout", () => {
    for (const file of [
      "components/data-table.tsx",
      "components/patterns/list-page.tsx",
      "components/patterns/list-views.tsx",
    ]) {
      expect(read(file), file).not.toMatch(/(?<![\w-])(max-)?sm:/);
    }
    const table = read("components/data-table.tsx");
    expect(table).toContain("@container/list");
    expect(table).not.toContain("matchMedia");
    expect(read("lib/use-list-layout.ts")).not.toContain("matchMedia");
  });
});

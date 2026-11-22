import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chooseListLayout } from "../../dashboard/lib/list-layout";
import { shouldStack } from "../../dashboard/lib/use-fit-stack";

const read = (p: string) => readFileSync(new URL(`../../dashboard/${p}`, import.meta.url), "utf8");

describe("chooseListLayout", () => {
  it("mounts both layouts until the card's verdict may be read", () => {
    expect(chooseListLayout(null)).toBe("both");
    expect(chooseListLayout(null, true)).toBe("both");
  });
  it("then mounts only the one the card's container query shows", () => {
    expect(chooseListLayout(true)).toBe("phone");
    expect(chooseListLayout(false)).toBe("table");
  });
  it("stacks a wide card whose table does not fit it", () => {
    expect(chooseListLayout(false, true)).toBe("phone");
    expect(chooseListLayout(true, true)).toBe("phone");
  });
});

describe("shouldStack", () => {
  it("stacks a grid wider than its room", () => {
    expect(shouldStack(901, 900, false)).toBe(true);
    expect(shouldStack(900, 900, false)).toBe(false);
  });
  it("goes back to the grid only with room to spare, so it cannot flip back and forth", () => {
    expect(shouldStack(890, 900, true)).toBe(true);
    expect(shouldStack(876, 900, true)).toBe(false);
  });
});

describe("the list-narrow threshold", () => {
  const css = read("app/globals.css");
  const def = /@custom-variant list-narrow \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";

  it("is defined once, as a rem container query on the list card", () => {
    expect(css.match(/@custom-variant list-narrow\b/g)).toHaveLength(1);
    // rem, not px: px container queries sort first and lose.
    expect(def).toContain("@container list (width < 52.5rem)");
    // A wide card stacked because its table does not fit draws its rows the same way.
    expect(def).toContain('[data-list-layout="phone"] &');
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

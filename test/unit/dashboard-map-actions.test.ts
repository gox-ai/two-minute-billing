import { readFileSync } from "node:fs";
import { parse } from "@babel/parser";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ACTIONS,
  MAP_PATH,
  buildDashboardMap,
  emptyCtx,
  evaluate,
  literals,
  unresolved,
  type Screen,
} from "../../scripts/generate-dashboard-map";
import { ACTION_BAR } from "@/modules/assistant/guide";

const bar = (s: Screen | undefined) => s?.groups.find((g) => g.title === ACTIONS)?.controls;

describe("dashboard map: action bars", () => {
  let screens: Screen[];
  beforeAll(async () => {
    screens = await buildDashboardMap();
  }, 180_000); // ~7 s idle; the walk is CPU-bound, so a loaded runner needs headroom
  const at = (route: string) => screens.find((s) => s.route === `/businesses/{business}${route}`);

  it("lists the sticky bar's submit and cancel on the coupon edit screen", () => {
    const edit = at("/catalog/coupons/{cpn}/edit");
    expect(bar(edit)).toEqual(expect.arrayContaining(["Save changes", "Cancel"]));
    expect(edit?.controls).toEqual(expect.arrayContaining(["Save changes", "Cancel"]));
  });
  it("keeps a create screen's submit, though it is also the screen's name", () => {
    const create = at("/catalog/coupons/new");
    expect(create?.label).toBe("Create coupon");
    expect(bar(create)).toEqual(expect.arrayContaining(["Create coupon", "Cancel"]));
  });
  it("reads a slot button, a save prop and its default", () => {
    expect(bar(at("/credit_notes/new"))).toEqual(["Create credit note", "Cancel"]);
    expect(bar(at("/settings/invoices"))).toEqual(["Save invoice settings"]);
    expect(bar(at("/settings/dunning"))).toEqual(["Save"]);
  });
  it("reads a templated submit label as the screen's own value", () => {
    // `Create ${lower}`: the route passes kind, ProductForm maps it to the noun.
    expect(bar(at("/catalog/plans/new"))).toEqual(["Create plan", "Cancel"]);
    expect(bar(at("/catalog/addons/new"))).toEqual(["Create add-on", "Cancel"]);
    expect(bar(at("/catalog/charges/new"))).toEqual(["Create one-time product", "Cancel"]);
    // The product edit screen passes a product, so it only ever saves.
    expect(bar(at("/catalog/products/{prod}/edit"))).toEqual(["Save changes", "Cancel"]);
    expect(bar(at("/catalog/products/{prod}/prices/new"))).toEqual(["Create price", "Cancel"]);
  });
  it("reports a template it cannot read", () => {
    // By file, not by line: an edit above the template must not fail this.
    expect(
      [...unresolved].some((u) =>
        u.startsWith("dashboard/components/settings/currency-rates.tsx:"),
      ),
    ).toBe(true);
  });
  it("matches the committed map and the guide's group name", () => {
    const committed = JSON.parse(readFileSync(MAP_PATH, "utf8")) as Screen[];
    expect(bar(committed.find((s) => s.route.endsWith("/coupons/{cpn}/edit")))).toContain(
      "Save changes",
    );
    expect(ACTIONS).toBe(ACTION_BAR);
  });
});

describe("literals", () => {
  const expr = (code: string) =>
    (
      parse(`x = ${code}`, { plugins: ["typescript"] }).program.body[0] as never as {
        expression: { right: never };
      }
    ).expression.right;
  it("takes each literal branch of a computed label", () => {
    expect(literals(expr(`isEdit ? "Save changes" : "Create coupon"`))).toEqual([
      "Save changes",
      "Create coupon",
    ]);
    expect(literals(expr("label ?? `Save`"))).toEqual(["Save"]);
    expect(literals(expr("`Create ${noun}`"))).toEqual([]);
  });
  it("resolves a template from the file's own constants", () => {
    const code = `const NOUN = { plan: "Plan", addon: "Addon" } as const;
      const lower = NOUN["addon"].toLowerCase();
      x = editing ? "Save changes" : \`Create \${lower}\`;`;
    const ast = parse(code, { plugins: ["typescript"] }) as never as { program: never };
    const ctx = emptyCtx("x.ts", ast);
    const last = (ast.program as { body: Array<{ expression: { right: never } }> }).body[2]!;
    expect(literals(last.expression.right)).toEqual(["Save changes"]);
    expect(evaluate(last.expression.right, ctx).filter((v) => typeof v === "string")).toEqual([
      "Save changes",
      "Create addon",
    ]);
  });
});

describe("dashboard map: controls inside a menu", () => {
  let screens: Screen[];
  beforeAll(async () => {
    screens = await buildDashboardMap();
  }, 180_000);
  const at = (route: string) => screens.find((s) => s.route === `/businesses/{business}${route}`);

  it("names the MoreMenu trigger for an item, and leaves a control outside the menu untagged", () => {
    const inv = at("/invoices/{inv}");
    expect(inv?.menus?.["Issue a refund"]).toBe("More");
    expect(inv?.menus?.["Record an offline refund"]).toBe("More");
    expect(inv?.controls).toContain("Pause dunning");
    expect(inv?.menus?.["Pause dunning"]).toBeUndefined();
  });
  it("names a Radix menu's trigger by its aria-label", () => {
    expect(at("/catalog/coupons")?.menus?.["Clone Coupon"]).toBe("Row actions");
  });
  it("keeps only controls the screen lists", () => {
    for (const s of screens)
      for (const k of Object.keys(s.menus ?? {})) expect(s.controls).toContain(k);
  });
});

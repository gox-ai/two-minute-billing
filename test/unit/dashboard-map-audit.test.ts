import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OPTION_SOURCES,
  labelsIn,
  loadOptionSources,
  type LabelKind,
  type Screen,
} from "../../scripts/generate-dashboard-map";
import { auditScreen, inText } from "../../scripts/dashboard-map-audit";

// A page frame that takes a breadcrumb trail, as PageHeader and SettingsPage do.
const FRAME = `
type Crumb = { label: string; href?: string };
export function Frame({ title, crumbs, children }: { title: string; crumbs: Crumb[]; children?: unknown }) {
  return <div>{children}</div>;
}
export function Card({ title, children }: { title: string; children?: unknown }) {
  return <section>{children}</section>;
}`;
const PAGE = `
import { Frame } from "./frame";
import { SettingsCard } from "./card";
export default function Page() {
  const crumbs = [{ label: "Payments setup", href: "/x" }, { label: "Add" }];
  return (
    <Frame title="Add a provider" crumbs={crumbs}>
      <SettingsCard title="Select a provider">
        <ul data-map-options="gateways"><li>cards</li></ul>
        <Button>Change provider</Button>
      </SettingsCard>
      <h3>Connection</h3>
      <label>Label</label>
    </Frame>
  );
}`;

let dir: string;
let labels: Array<{ label: string; kind: LabelKind }>;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dash-map-"));
  writeFileSync(join(dir, "frame.tsx"), FRAME);
  writeFileSync(join(dir, "card.tsx"), "export { Card as SettingsCard } from './frame';\n");
  writeFileSync(join(dir, "page.tsx"), PAGE);
  await loadOptionSources();
  labels = labelsIn(join(dir, "page.tsx"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const kindsOf = (l: string) => new Set(labels.filter((x) => x.label === l).map((x) => x.kind));

describe("dashboard map: what counts as a control", () => {
  it("reads a breadcrumb trail and the page title as chrome, never as controls", () => {
    expect(kindsOf("Payments setup")).toEqual(new Set(["crumb"]));
    expect(kindsOf("Add")).toEqual(new Set(["crumb"]));
    expect(kindsOf("Add a provider")).toEqual(new Set(["title"]));
  });
  it("reads a heading as a place, and buttons and field labels as controls", () => {
    expect(kindsOf("Connection")).toEqual(new Set(["heading"]));
    expect(kindsOf("Change provider")).toEqual(new Set(["control"]));
    expect(kindsOf("Label")).toEqual(new Set(["control"]));
  });
  it("lists a declared catalogue's labels as options", async () => {
    const names = await OPTION_SOURCES.gateways!.labels();
    expect(names).toContain("Cashfree");
    for (const n of names) expect(kindsOf(n)).toEqual(new Set(["option"]));
  });
  it("refuses a source that is not declared", async () => {
    writeFileSync(
      join(dir, "bad.tsx"),
      `export default function P() { return <ul data-map-options="nowhere" />; }`,
    );
    expect(() => labelsIn(join(dir, "bad.tsx"))).toThrow(/names no source in OPTION_SOURCES/);
  });
});

// A create page → its form → the price card → the price fields: three imports deep.
const PRICE_PAGE = `
import { Form } from "./form";
export default function Page() { return <Form kind="plan" />; }`;
const PRICE_FORM = `
import { PriceCard } from "./price-card";
export function Form({ kind }: { kind: string }) { return <PriceCard />; }`;
const PRICE_CARD = `
import { PriceFields } from "./price-fields";
export function PriceCard() {
  return (
    <FormCard title="First price">
      <Field name="pp_currency" label="Currency"><CurrencySelect /></Field>
      <PriceFields model="flat" />
    </FormCard>
  );
}`;
const PRICE_FIELDS = `
export function PriceFields({ model }: { model: string }) {
  const amountLabel = model === "per_unit" ? "Price per unit" : "Price";
  const hint = model === "flat" ? "One amount" : "Each unit";
  return (
    <Field name="amount_minor" label={amountLabel} help={hint}>
      <Banner title={hint} />
    </Field>
  );
}`;

describe("dashboard map: fields three imports deep", () => {
  let found: Array<{ label: string; kind: LabelKind; group: string | null; field?: true }>;
  beforeAll(() => {
    writeFileSync(join(dir, "price-page.tsx"), PRICE_PAGE);
    writeFileSync(join(dir, "form.tsx"), PRICE_FORM);
    writeFileSync(join(dir, "price-card.tsx"), PRICE_CARD);
    writeFileSync(join(dir, "price-fields.tsx"), PRICE_FIELDS);
    found = labelsIn(join(dir, "price-page.tsx"));
  });
  const of = (l: string) => found.filter((x) => x.label === l);

  it("reads a field label from a variable, in the card that renders it", () => {
    expect(of("Price").map((x) => [x.group, x.kind, x.field])).toEqual([
      ["First price", "control", true],
    ]);
    expect(of("Price per unit")).toHaveLength(0);
  });
  it("marks a field label so the common-chrome filter keeps it", () => {
    expect(of("Currency").map((x) => x.field)).toEqual([true]);
  });
  it("reads a computed title only on a field, never a hint", () => {
    expect(of("One amount")).toHaveLength(0);
  });
});

describe("dashboard map audit", () => {
  const screen = (controls: string[], extra: Partial<Screen> = {}): Screen => ({
    route: "/r",
    scope: "biz",
    label: "R",
    section: "S",
    controls,
    groups: [{ title: null, controls }],
    headings: [],
    ...extra,
  });
  const kinds = (o: Record<string, LabelKind[]>) =>
    new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));

  it("fails a control read only from a breadcrumb, a title or a heading", () => {
    const f = auditScreen(screen(["Add", "Overview", "Save"]), {
      kinds: kinds({ Add: ["crumb"], Overview: ["heading"], Save: ["control"] }),
    });
    expect(f.map((x) => [x.rule, x.label])).toEqual([
      ["chrome", "Add"],
      ["heading", "Overview"],
    ]);
  });
  it("passes a label that is both a heading and a control", () => {
    const f = auditScreen(screen(["Add codes"]), {
      kinds: kinds({ "Add codes": ["heading", "control"] }),
    });
    expect(f).toEqual([]);
  });
  it("fails code and a label the screen does not render; an option needs no source text", () => {
    const f = auditScreen(
      screen(["mt-4 border-t", "Retry schedule", "Cashfree"], { options: ["Cashfree"] }),
      {
        text: "<Button>Save</Button>",
      },
    );
    expect(f.map((x) => [x.rule, x.label])).toEqual([
      ["code", "mt-4 border-t"],
      ["rendered", "mt-4 border-t"],
      ["rendered", "Retry schedule"],
    ]);
  });
  it("reads a templated label by its words", () => {
    expect(inText("Create plan", '`Create ${lower}` … plan: "Plan"')).toBe(true);
    expect(inText("Create plan", "`Create ${lower}`")).toBe(false);
  });
});

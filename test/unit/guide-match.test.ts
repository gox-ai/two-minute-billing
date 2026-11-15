import { describe, expect, it } from "vitest";
import {
  chooseExact,
  chooseTarget,
  isActionLabel,
  isSubmitStep,
  labelMatch,
  pickPrimary,
  spotlight,
  stepIntent,
  type Candidates,
  type ControlKind,
} from "../../dashboard/lib/guide-match";

describe("labelMatch", () => {
  it("matches exactly, then by leading words or all words", () => {
    expect(labelMatch("Save changes", "Save changes")).toBe("exact");
    expect(labelMatch("save changes:", " Save  changes ")).toBe("exact");
    expect(labelMatch("Save", "Save changes")).toBe("close");
    expect(labelMatch("Create coupon", "Create a coupon")).toBe("close");
  });
  it("refuses a label missing one of the control's words, or a run of text", () => {
    expect(labelMatch("Save coupon", "Save changes")).toBeNull();
    expect(labelMatch("Save", "Saved")).toBeNull();
    expect(labelMatch("Save", `Save ${"x".repeat(80)}`)).toBeNull();
  });
});

describe("a step's do decides, not its words", () => {
  it("submit, enter and select come from do", () => {
    expect(isSubmitStep({ control: "Coupon info", say: "Done here.", do: "submit" })).toBe(true);
    expect(
      isSubmitStep({ control: "Save changes", say: "Select Save changes.", do: "click" }),
    ).toBe(false);
    expect(stepIntent({ control: "Percentage", say: "Select Percentage.", do: "enter" })).toBe(
      "enter",
    );
    expect(stepIntent({ control: "Percentage", say: "Set Percentage to 40.", do: "select" })).toBe(
      "select",
    );
    expect(stepIntent({ control: "Plans", say: "Open Plans.", do: "click" })).toBeNull();
  });
});

describe("isSubmitStep", () => {
  it("reads the control or the instruction", () => {
    expect(isSubmitStep({ control: "Save changes", say: "Select it." })).toBe(true);
    expect(isSubmitStep({ control: "Coupon info", say: "Save the coupon changes." })).toBe(true);
    expect(isSubmitStep({ control: "Coupon info", say: "Select Save changes." })).toBe(true);
    expect(isSubmitStep({ control: "Percentage", say: "Enter 40 in Percentage." })).toBe(false);
    expect(
      isSubmitStep({ control: "Excess payments", say: "Find Excess payments, then save." }),
    ).toBe(false);
  });
  it("names button-like controls", () => {
    expect(isActionLabel("Save changes")).toBe(true);
    expect(isActionLabel("Add charge")).toBe(true);
    expect(isActionLabel("Coupon info")).toBe(false);
  });
});

describe("chooseTarget", () => {
  const none: Candidates<string> = {
    exact: null,
    exactClickable: false,
    close: null,
    submit: null,
    row: null,
    last: null,
    within: null,
  };
  const save = { control: "Save changes", say: "Select Save changes." };
  const pick = (c: Partial<Candidates<string>>, step = save) =>
    chooseTarget({ ...none, ...c }, step);

  it("takes exact, then close, then the page's submit for a save step", () => {
    const all = { exact: "E", exactClickable: true, close: "C", submit: "S", within: "W" };
    expect(pick(all)).toEqual({ el: "E", via: "exact" });
    expect(pick({ ...all, exact: null })).toEqual({ el: "C", via: "close" });
    expect(pick({ ...all, exact: null, close: null })).toEqual({ el: "S", via: "submit" });
  });
  it("takes the submit before any row or card fallback", () => {
    expect(pick({ submit: "S", row: "R", last: "L", within: "W" }).via).toBe("submit");
  });
  it("never outlines a card for a button-like control", () => {
    expect(pick({ within: "Coupon info card" })).toEqual({ el: null, via: "none" });
    expect(pick({ within: "W" }, { control: "Excess payments", say: "Find it." }).via).toBe(
      "within",
    );
  });
  it("a save step whose exact match is a heading takes the submit button", () => {
    // The production case: control "Coupon info", say "Save the coupon changes."
    const step = { control: "Coupon info", say: "Save the coupon changes." };
    expect(pick({ exact: "H", exactClickable: false, submit: "S" }, step).via).toBe("submit");
    expect(pick({ exact: "H", exactClickable: false }, step).via).toBe("exact");
    // A field step keeps its heading match.
    expect(
      pick({ exact: "H", submit: "S" }, { control: "Coupon info", say: "Open Coupon info." }).via,
    ).toBe("exact");
  });
  it("keeps the row fallbacks for other steps", () => {
    const step = { control: "Never auto-apply here", say: "Under Excess payments, select it." };
    expect(pick({ row: "R", last: "L", within: "W" }, step).via).toBe("row");
    expect(pick({ last: "L", within: "W" }, step).via).toBe("last");
  });
});

describe("pickPrimary", () => {
  const c = (el: string, o: Partial<{ inBar: boolean; inDialog: boolean; submit: boolean }>) => ({
    el,
    inBar: false,
    inDialog: false,
    submit: false,
    ...o,
  });
  it("takes an open dialog's button first, then the action bar's last", () => {
    expect(
      pickPrimary([c("bar", { inBar: true }), c("dlg", { inDialog: true, submit: true })]),
    ).toBe("dlg");
    expect(
      pickPrimary([c("cancel", { inBar: true }), c("save", { inBar: true, submit: true })]),
    ).toBe("save");
  });
  it("takes the only submit button, and guesses nothing among several", () => {
    expect(pickPrimary([c("one", { submit: true })])).toBe("one");
    expect(pickPrimary([c("a", { submit: true }), c("b", { submit: true })])).toBeNull();
    expect(pickPrimary([])).toBeNull();
  });
});

describe("chooseExact", () => {
  // The coupon form: the "Percentage" option card comes first, its number field below it.
  const percentage: Array<{ el: string; kind: ControlKind }> = [
    { el: "option card", kind: "choice" },
    { el: "number field", kind: "field" },
  ];
  const pick = (say: string, found = percentage) =>
    chooseExact(found, { control: "Percentage", say });

  it("a step that enters a value takes the field", () => {
    expect(pick("Set Percentage to 40.")).toBe("number field");
    expect(pick("Enter 40 in Percentage.")).toBe("number field");
    expect(pick("Change Percentage to 12.5.")).toBe("number field");
    expect(pick("Percentage: 40")).toBe("number field");
  });
  it("a step that selects takes the option", () => {
    expect(pick("Select Percentage.")).toBe("option card");
    expect(pick("Switch to Percentage.")).toBe("option card");
    expect(pick("Set Discount type to Percentage.")).toBe("option card");
  });
  it("an ambiguous step keeps the first match, or the row it names", () => {
    expect(pick("Find Percentage.")).toBe("option card");
    expect(
      pick(
        "Set Percentage to 40.",
        [...percentage].reverse().map((f) => ({ ...f, kind: "other" as const })),
      ),
    ).toBe("number field");
    expect(
      pick("Find Percentage.", [
        { el: "a", kind: "other" },
        { el: "b", kind: "other", rowNamed: true } as never,
      ]),
    ).toBe("b");
    expect(chooseExact([], { control: "x", say: "y" })).toBeNull();
  });
  it("takes a match the member can use over a heading or column title", () => {
    const amount = [
      { el: "column heading", kind: "other" as const, usable: false },
      { el: "amount field", kind: "field" as const, usable: true },
    ];
    expect(chooseExact(amount, { control: "Amount", say: "Select Amount.", do: "click" })).toBe(
      "amount field",
    );
    // Nothing usable: the first match stands, and the runner shows the step unanchored.
    expect(
      chooseExact([{ el: "heading", kind: "other" as const, usable: false }], {
        control: "CRM",
        say: "Open CRM.",
      }),
    ).toBe("heading");
  });
  it("reads the intent from the verb nearest the control", () => {
    expect(stepIntent({ control: "Percentage", say: "Switch to Percentage, then enter 40." })).toBe(
      "select",
    );
    expect(stepIntent({ control: "Create plan", say: "Select Create plan." })).toBe("select");
    expect(stepIntent({ control: "Coupon info", say: "Open Coupon info." })).toBeNull();
  });
});

describe("spotlight", () => {
  it("rings an outline that holds a control the member uses", () => {
    expect(spotlight([{ el: "provider card", interactive: true }])).toEqual(["provider card"]);
    expect(
      spotlight([
        { el: "row label", interactive: false },
        { el: "Change", interactive: true },
      ]),
    ).toEqual(["row label", "Change"]);
  });
  it("rings nothing for a heading, a breadcrumb or a container: the step shows unanchored", () => {
    expect(spotlight([{ el: "breadcrumb Add", interactive: false }])).toBeNull();
    expect(spotlight([{ el: "card", interactive: false }])).toBeNull();
    expect(spotlight([])).toBeNull();
  });
});

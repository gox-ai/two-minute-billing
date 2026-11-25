import { describe, expect, it } from "vitest";
import { ACTION_BAR, idsIn, resolveGuide, type MapScreen } from "@/modules/assistant/guide";
import { screenForPath } from "@/modules/assistant-docs/screens";

const screens: MapScreen[] = [
  {
    route: "/businesses/{business}/subscriptions/{sub}",
    scope: "biz",
    label: "Subscription",
    section: "Billing",
    controls: ["Subscription configurations", "Excess payments", "Change", "Save"],
  },
  {
    route: "/businesses/{business}/settings/billing-rules/credits-flexibility",
    scope: "biz",
    label: "Credits flexibility",
    section: "Billing rules",
    controls: ["Excess payments", "On recurring invoices"],
  },
];
const base = { businessId: "biz_A1", screens, id: "call_1" };

describe("resolveGuide", () => {
  it("names the menu a control sits in, from the map, so the runner can open it first", () => {
    const invoice: MapScreen = {
      route: "/businesses/{business}/invoices/{inv}",
      scope: "biz",
      label: "Invoice",
      section: "Billing",
      controls: ["Download PDF", "Issue a refund", "Delete"],
      menus: { "Issue a refund": "More", Delete: "" },
    };
    const r = resolveGuide({
      ...base,
      screens: [invoice],
      known: new Set(["inv_7"]),
      input: {
        screen: "/businesses/biz_A1/invoices/inv_7",
        steps: [
          { control: "Download PDF", say: "Select Download PDF." },
          { control: "issue a refund", say: "Select Issue a refund." },
          { control: "Delete", say: "Select Delete." },
        ],
      },
    });
    const steps = "guide" in r ? r.guide.steps : [];
    expect(steps.map((s) => s.menu)).toEqual([undefined, "More", ""]);
    expect("menu" in steps[0]!).toBe(false);
  });
  it("fills the record id and keeps labels as the screen writes them", () => {
    const r = resolveGuide({
      ...base,
      known: new Set(["sub_9"]),
      input: {
        screen: "/businesses/biz_A1/subscriptions/{sub}",
        params: { sub: "sub_9" },
        steps: [
          { control: "change", within: "excess payments", say: "Select Never auto-apply here." },
        ],
      },
    });
    expect(r).toEqual({
      guide: {
        id: "call_1",
        path: "/businesses/biz_A1/subscriptions/sub_9",
        screen: "Subscription",
        steps: [
          { control: "Change", within: "Excess payments", say: "Select Never auto-apply here." },
        ],
      },
    });
  });
  it("accepts the {business} template and a trailing ellipsis or colon on a label", () => {
    const r = resolveGuide({
      ...base,
      known: new Set(),
      input: {
        screen: "/businesses/{business}/settings/billing-rules/credits-flexibility",
        steps: [{ control: "On recurring invoices:", say: "Select Do not auto-apply." }],
      },
    });
    expect("guide" in r && r.guide.path).toBe(
      "/businesses/biz_A1/settings/billing-rules/credits-flexibility",
    );
  });
  it("refuses a screen, a control or a record the turn did not see", () => {
    const go = (input: Parameters<typeof resolveGuide>[0]["input"], known = ["sub_9"]) =>
      resolveGuide({ ...base, known: new Set(known), input });
    expect(
      go({ screen: "/businesses/biz_A1/nowhere", steps: [{ control: "Save", say: "x x" }] }),
    ).toHaveProperty("error", expect.stringMatching(/Unknown screen/));
    expect(
      go({
        screen: "/businesses/biz_A1/subscriptions/{sub}",
        params: { sub: "sub_9" },
        steps: [{ control: "Hold excess", say: "Select it." }],
      }),
    ).toHaveProperty("error", expect.stringMatching(/Not on this screen: "Hold excess"/));
    // An id the model made up, and one that is missing.
    expect(
      go({
        screen: "/businesses/biz_A1/subscriptions/{sub}",
        params: { sub: "sub_invented" },
        steps: [{ control: "Save", say: "Select Save." }],
      }),
    ).toHaveProperty("error", expect.stringMatching(/Unknown id/));
    expect(
      go({
        screen: "/businesses/biz_A1/subscriptions/{sub}",
        steps: [{ control: "Save", say: "x x" }],
      }),
    ).toHaveProperty("error", expect.stringMatching(/needs a record id/));
  });
  it("takes a real path with its ids, as find_screen links the member's page", () => {
    const r = resolveGuide({
      ...base,
      known: new Set(["sub_9"]),
      input: {
        screen: "/businesses/biz_A1/subscriptions/sub_9",
        steps: [{ control: "Change", within: "Excess payments", say: "Select Change." }],
      },
    });
    expect("guide" in r && r.guide.path).toBe("/businesses/biz_A1/subscriptions/sub_9");
    expect(
      resolveGuide({
        ...base,
        known: new Set(),
        input: {
          screen: "/businesses/biz_A1/subscriptions/sub_x",
          steps: [{ control: "Save", say: "Save it." }],
        },
      }),
    ).toHaveProperty("error", expect.stringMatching(/Unknown id/));
  });
  it("collects id-like strings from tool results", () => {
    const ids = idsIn([{ subscriptions: { data: [{ id: "sub_9", note: "two words" }] } }]);
    expect(ids.has("sub_9")).toBe(true);
    expect(ids.has("two words")).toBe(false);
  });
});

describe("resolveGuide: a form's action bar", () => {
  const edit: MapScreen = {
    route: "/businesses/{business}/catalog/coupons/{cpn}/edit",
    scope: "biz",
    label: "Edit Coupon",
    section: "Catalog",
    controls: ["Coupon info", "Percentage", "Save changes", "Cancel"],
    groups: [
      { title: "Coupon info", controls: ["Coupon info", "Percentage"] },
      { title: ACTION_BAR, controls: ["Save changes", "Cancel"] },
    ],
  };
  it("names the save button as its own step; the bar is not a within", () => {
    const r = resolveGuide({
      businessId: "biz_A1",
      screens: [edit],
      id: "g",
      known: new Set(["cpn_7"]),
      input: {
        screen: "/businesses/{business}/catalog/coupons/{cpn}/edit",
        params: { cpn: "cpn_7" },
        steps: [
          { control: "Percentage", within: "Coupon info", say: "Enter 40." },
          { control: "Save changes", within: ACTION_BAR, say: "Select Save changes." },
        ],
      },
    });
    expect("guide" in r && r.guide.steps.at(-1)).toEqual({
      control: "Save changes",
      within: null,
      say: "Select Save changes.",
    });
  });
});

describe("screenForPath", () => {
  const list = [
    {
      route: "/businesses/{business}/subscriptions/{sub}",
      scope: "biz",
      label: "Subscription",
      section: "Billing",
      controls: [],
    },
    {
      route: "/businesses/{business}/subscriptions/new",
      scope: "biz",
      label: "New subscription",
      section: "Billing",
      controls: [],
    },
  ] as MapScreen[];
  it("names the screen a path shows; a literal segment beats a record id", () => {
    expect(screenForPath("/businesses/biz_1/subscriptions/sub_2", list)?.label).toBe(
      "Subscription",
    );
    expect(screenForPath("/businesses/biz_1/subscriptions/new", list)?.label).toBe(
      "New subscription",
    );
    expect(screenForPath("/businesses/biz_1/subscriptions/sub_2/", list)?.label).toBe(
      "Subscription",
    );
    expect(screenForPath("/businesses/biz_1/nowhere/x", list)).toBeNull();
  });
});

describe("resolveGuide: options, headings and page chrome", () => {
  // As the map lists the Add a gateway screen: provider cards from the catalogue are controls;
  // the card title is a heading; the breadcrumb and page title are in neither list.
  const gateways: MapScreen = {
    route: "/businesses/{business}/settings/gateways/new",
    scope: "biz",
    label: "Add a gateway",
    section: "Settings",
    controls: ["Change provider", "Stripe", "Cashfree", "Label", "Create gateway account"],
    groups: [
      { title: null, controls: ["Change provider", "Stripe", "Cashfree", "Label"] },
      { title: ACTION_BAR, controls: ["Create gateway account"] },
    ],
    headings: ["Select a provider"],
    options: ["Stripe", "Cashfree"],
  };
  const go = (steps: Array<{ control: string; within?: string; say: string }>) =>
    resolveGuide({
      businessId: "biz_A1",
      screens: [gateways],
      id: "g",
      known: new Set(),
      input: { screen: "/businesses/{business}/settings/gateways/new", steps },
    });

  it("takes a declared option as a control, within its heading", () => {
    const r = go([
      { control: "Cashfree", within: "Select a provider", say: "Select Cashfree." },
      { control: "Label", say: "Enter a name." },
    ]);
    expect("guide" in r && r.guide.steps.map((s) => [s.control, s.within])).toEqual([
      ["Cashfree", "Select a provider"],
      ["Label", null],
    ]);
  });
  it("refuses a heading as a control and says to name what is in it", () => {
    expect(go([{ control: "Select a provider", say: "Select Cashfree." }])).toHaveProperty(
      "error",
      expect.stringMatching(/"Select a provider" is a heading on this screen, not a control/),
    );
  });
  it("refuses the page title, a breadcrumb and a provider the catalogue does not have", () => {
    for (const control of ["Add a gateway", "Add", "Payment gateways", "Unlisted provider"])
      expect(go([{ control, say: "Select it." }])).toHaveProperty(
        "error",
        expect.stringMatching(/Not on this screen/),
      );
  });
});

describe("resolveGuide scope", () => {
  const go = (screen: string, scope: "one_record" | "whole_business") =>
    resolveGuide({
      ...base,
      known: new Set(["sub_9"]),
      input: {
        screen,
        scope,
        params: { sub: "sub_9" },
        steps: [{ control: "Excess payments", say: "Select Excess payments." }],
      },
    });
  it("refuses a business-wide screen for a question about one record", () => {
    expect(
      go("/businesses/{business}/settings/billing-rules/credits-flexibility", "one_record"),
    ).toHaveProperty("error", expect.stringMatching(/whole business/));
  });
  it("keeps the record's own screen, and a settings screen for a business-wide question", () => {
    expect(go("/businesses/biz_A1/subscriptions/{sub}", "one_record")).toHaveProperty("guide");
    expect(
      go("/businesses/{business}/settings/billing-rules/credits-flexibility", "whole_business"),
    ).toHaveProperty("guide");
  });
});

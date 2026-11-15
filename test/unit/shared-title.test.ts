import { describe, expect, it } from "vitest";
import { onScreen, pickLink, sharedTitlePlan } from "../../dashboard/lib/shared-title";

const box = (top: number, left = 10, width = 80, height = 20) => ({
  top,
  left,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

describe("shared title: onScreen", () => {
  it("accepts a box partly inside the viewport", () => {
    expect(onScreen(box(-10), 1000, 800)).toBe(true);
    expect(onScreen(box(790), 1000, 800)).toBe(true);
  });
  it("rejects a box above, below or beside the viewport", () => {
    expect(onScreen(box(-20), 1000, 800)).toBe(false);
    expect(onScreen(box(800), 1000, 800)).toBe(false);
    expect(onScreen(box(100, 1000), 1000, 800)).toBe(false);
  });
  it("rejects an empty box (a hidden row)", () => {
    expect(onScreen(box(100, 10, 0, 0), 1000, 800)).toBe(false);
  });
});

describe("shared title: pickLink", () => {
  const links = [
    { path: "/b/x/customers/a", box: box(-100) },
    { path: "/b/x/customers/b", box: box(100) },
    { path: "/b/x/customers/a", box: box(200) },
    { path: "/b/x/customers/a", box: box(300) },
  ];
  it("picks the first on-screen link to the path, so only one is ever named", () => {
    expect(pickLink(links, "/b/x/customers/a", 1000, 800)).toBe(2);
  });
  it("returns -1 when the row is not rendered or not on screen", () => {
    expect(pickLink(links, "/b/x/customers/z", 1000, 800)).toBe(-1);
    expect(pickLink(links.slice(0, 1), "/b/x/customers/a", 1000, 800)).toBe(-1);
  });
});

describe("shared title: sharedTitlePlan", () => {
  it("push leaves from the row link and lands on the title of the destination", () => {
    expect(sharedTitlePlan("push", "/b/x/customers", "/b/x/customers/a")).toEqual({
      from: "link",
      to: "title",
      recordPath: "/b/x/customers/a",
    });
  });
  it("pop leaves from the title and lands on the row that links to the page left", () => {
    expect(sharedTitlePlan("pop", "/b/x/customers/a", "/b/x/customers")).toEqual({
      from: "title",
      to: "link",
      recordPath: "/b/x/customers/a",
    });
  });
  it("a tab switch shares nothing", () => {
    expect(sharedTitlePlan("tab", "/b/x/customers", "/b/x/invoices")).toBeNull();
  });
});

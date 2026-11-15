import { describe, expect, it } from "vitest";
import {
  BILLY_DEFAULT_W,
  BILLY_LAYOUT_SCRIPT,
  MODE_KEY,
  OPEN_KEY,
  WIDTH_KEY,
  billyDocks,
  billyLayout,
  parseStoredMode,
  parseStoredWidth,
  type BillyMode,
} from "../../dashboard/lib/billy-width";

describe("billyLayout limits", () => {
  it.each([
    // viewport, collapsed, max
    [1920, false, 640],
    [1920, true, 640],
    [1440, false, 416],
    [1280, false, 552],
    [1280, true, 440],
    [1100, false, 372],
    [1024, true, 480],
  ])("at %ipx (collapsed %s) the widest panel is %ipx", (vw, collapsed, max) => {
    const l = billyLayout(vw, collapsed, 9999);
    expect(l.resizable).toBe(true);
    expect(l.max).toBe(max);
    expect(l.width).toBe(max);
    expect(l.min).toBe(320);
  });

  it("keeps the 400px floating panel where the minimum does not fit", () => {
    for (const vw of [1024, 1047, 800]) {
      const l = billyLayout(vw, false, 320);
      expect(l.resizable).toBe(false);
      expect(l.width).toBe(BILLY_DEFAULT_W);
      expect(l.push).toBe(false);
    }
    expect(billyLayout(1048, false, 400).resizable).toBe(true);
  });

  it("has no handle on a phone or below the drawer breakpoint", () => {
    expect(billyLayout(390, false, 500)).toMatchObject({ resizable: false, width: 400 });
    expect(billyLayout(767, true, 500)).toMatchObject({ resizable: false, width: 400 });
  });

  it("clamps a preference to the window and leaves the preference alone", () => {
    expect(billyLayout(1920, false, 200).width).toBe(320);
    expect(billyLayout(1280, false, 600).width).toBe(552);
    expect(billyLayout(1920, false, 600).width).toBe(600);
    expect(billyLayout(1920, false, 455.6).width).toBe(456);
  });
});

describe("push decision", () => {
  it("a docked panel stays docked: its width stops where the page keeps 776px", () => {
    // 1440 − 248 − w ≥ 776 ⇔ w ≤ 416
    expect(billyLayout(1440, false, 416)).toMatchObject({ push: true, width: 416 });
    expect(billyLayout(1440, false, 417)).toMatchObject({ push: true, width: 416 });
    expect(billyLayout(1424, false, 400)).toMatchObject({ push: true, width: 400 });
    expect(billyLayout(1423, false, 400)).toMatchObject({ push: true, width: 399 });
    // collapsed: 1280 − 64 − w ≥ 776 ⇔ w ≤ 440
    expect(billyLayout(1280, true, 441)).toMatchObject({ push: true, width: 440 });
    // No room to dock even at the minimum: it floats, and may grow to the float limit.
    expect(billyLayout(1280, false, 400)).toMatchObject({ push: false, room: false, width: 400 });
    expect(billyLayout(1440, false, 600, "float")).toMatchObject({ push: false, width: 600 });
    expect(billyLayout(1920, false, 640).push).toBe(true);
  });

  it("floats when the operator chose float, at any width", () => {
    expect(billyLayout(1920, false, 400, "float")).toMatchObject({ push: false, room: true });
    expect(billyLayout(1024, false, 400, "float")).toMatchObject({ push: false, room: false });
  });

  it("floats when docked but out of room", () => {
    expect(billyLayout(1280, false, 400, "dock")).toMatchObject({ push: false, room: false });
    expect(billyDocks("dock", true)).toBe(true);
    expect(billyDocks("dock", false)).toBe(false);
    expect(billyDocks("float", true)).toBe(false);
  });
});

describe("stored values", () => {
  it("accepts a number inside the limits", () => {
    expect(parseStoredWidth("320")).toBe(320);
    expect(parseStoredWidth("640")).toBe(640);
    expect(parseStoredWidth("455.4")).toBe(455);
  });
  it.each([
    null,
    undefined,
    "",
    " ",
    "abc",
    "319",
    "641",
    "NaN",
    "Infinity",
    "1e9",
    "400px",
    "400;}",
  ])("falls back to the default for %j", (raw) =>
    expect(parseStoredWidth(raw)).toBe(BILLY_DEFAULT_W),
  );
  it("knows only the two modes", () => {
    expect(parseStoredMode("float")).toBe("float");
    expect(parseStoredMode("dock")).toBe("dock");
    for (const raw of [null, "", "FLOAT", "x", 1]) expect(parseStoredMode(raw)).toBe("dock");
  });
});

/** Runs the head script against a fake <html> and storage. */
function runScript(
  vw: number,
  store: Record<string, string> | "throws",
  collapsed = false,
  session: Record<string, string> = {},
) {
  const props: Record<string, string> = {};
  const attrs = new Set<string>();
  const html = {
    dataset: collapsed ? { nav: "collapsed" } : {},
    style: { setProperty: (k: string, v: string) => (props[k] = v) },
    setAttribute: (k: string) => attrs.add(k),
  };
  const localStorage = {
    getItem: (k: string) => {
      if (store === "throws") throw new Error("blocked");
      return store[k] ?? null;
    },
  };
  const sessionStorage = {
    getItem: (k: string) => {
      if (store === "throws") throw new Error("blocked");
      return session[k] ?? null;
    },
  };
  new Function("document", "window", "localStorage", "sessionStorage", BILLY_LAYOUT_SCRIPT)(
    { documentElement: html },
    { innerWidth: vw },
    localStorage,
    sessionStorage,
  );
  return {
    width: props["--billy-w"],
    push: attrs.has("data-billy-push"),
    open: attrs.has("data-billy-open"),
  };
}

describe("head script", () => {
  it("agrees with billyLayout everywhere", () => {
    const raws = [undefined, "320", "400", "455.4", "640", "641", "junk", ""];
    const modes: Array<string | undefined> = [undefined, "dock", "float", "bad"];
    for (let vw = 360; vw <= 2000; vw += 7)
      for (const collapsed of [false, true])
        for (const raw of raws)
          for (const m of modes) {
            const store: Record<string, string> = {};
            if (raw !== undefined) store[WIDTH_KEY] = raw;
            if (m !== undefined) store[MODE_KEY] = m;
            const got = runScript(vw, store, collapsed);
            const want = billyLayout(
              vw,
              collapsed,
              parseStoredWidth(raw ?? null),
              parseStoredMode(m) as BillyMode,
            );
            expect(got).toEqual({ width: `${want.width}px`, push: want.push, open: false });
          }
  });

  it("stamps the open state of this tab only", () => {
    expect(runScript(1920, {}, false, { [OPEN_KEY]: "1" }).open).toBe(true);
    expect(runScript(1920, {}, false, { [OPEN_KEY]: "0" }).open).toBe(false);
  });

  it("starts closed on a new launch, whatever an earlier session left in localStorage", () => {
    expect(runScript(1920, { [OPEN_KEY]: "1" }).open).toBe(false);
  });

  it("still stamps the default width when storage throws", () => {
    expect(runScript(1920, "throws")).toEqual({ width: "400px", push: true, open: false });
  });
});

import { describe, expect, it } from "vitest";

import { brandCss, buttonLabel, contrastRatio, onColor } from "../../dashboard/lib/brand";

const hex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

describe("onColor: the label on a merchant-coloured button", () => {
  it("reaches AA (4.5:1) on every brand colour", () => {
    let worst = Infinity;
    for (let r = 0; r < 256; r += 5)
      for (let g = 0; g < 256; g += 5)
        for (let b = 0; b < 256; b += 5) {
          const fill = hex(r, g, b);
          worst = Math.min(worst, contrastRatio(onColor(fill), fill));
        }
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps white where white passes, and near-black where it passes", () => {
    expect(onColor("#4e4eda")).toBe("#ffffff");
    expect(onColor("#ea580c")).toBe("#111111");
  });

  it("falls back to pure black in the mid-tone band", () => {
    // White 4.4:1 and #111 4.4:1 here: neither passes, black does.
    const fill = "#7260ff";
    expect(contrastRatio("#ffffff", fill)).toBeLessThan(4.5);
    expect(onColor(fill)).toBe("#000000");
    expect(contrastRatio("#000000", fill)).toBeGreaterThanOrEqual(4.5);
  });

  it("puts that label in the storefront stylesheet", () => {
    expect(brandCss("#7260ff")).toContain("--solid-foreground:#000000");
  });
});

describe("buttonLabel: the merchant's text color, or the automatic one", () => {
  it("keeps a readable text color", () => {
    // White on #0f5fa6 is 6.6:1.
    expect(buttonLabel("#0f5fa6", "#FFFFFF")).toBe("#ffffff");
    // Near-black on an orange that would get #111 anyway, set by hand as a custom hex.
    expect(buttonLabel("#ea580c", "#1a1a1a")).toBe("#1a1a1a");
  });

  it("keeps the merchant's text color even when it is hard to read (their choice)", () => {
    // White on orange is 3.6:1: Brand Styles warns, but the color is used as set.
    expect(contrastRatio("#ffffff", "#ea580c")).toBeLessThan(4.5);
    expect(buttonLabel("#ea580c", "#ffffff")).toBe("#ffffff");
  });

  it("gives onColor when no text color is set, or it is not a hex", () => {
    for (const unset of [null, undefined, "", "white", "#fff"])
      expect(buttonLabel("#7260ff", unset)).toBe(onColor("#7260ff"));
  });

  it("reaches AA (4.5:1) on every brand color when no text color is set", () => {
    let worst = Infinity;
    for (let r = 0; r < 256; r += 15)
      for (let g = 0; g < 256; g += 15)
        for (let b = 0; b < 256; b += 15) {
          const fill = hex(r, g, b);
          worst = Math.min(worst, contrastRatio(buttonLabel(fill, null), fill));
        }
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });

  it("puts the chosen text color in the storefront stylesheet, and onColor without one", () => {
    expect(brandCss("#0f5fa6", "#FFFFFF")).toContain("--solid-foreground:#ffffff");
    expect(brandCss("#ea580c", "#ffffff")).toContain("--solid-foreground:#ffffff");
    expect(brandCss("#7260ff", null)).toBe(brandCss("#7260ff"));
  });
});

describe("email button label: the same rule as the hosted pages", () => {
  it("matches buttonLabel for every brand colour, with and without a text colour", async () => {
    const { emailButtonLabel } = await import("../../src/modules/emails/button-label");
    const { buttonLabel } = await import("../../dashboard/lib/brand");
    const texts = [null, "#ffffff", "#111111", "#000000", "#ff6700", "#1d4ed8", "#ffff00"];
    for (let r = 0; r < 256; r += 17)
      for (let g = 0; g < 256; g += 17)
        for (let b = 0; b < 256; b += 17) {
          const fill = "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
          for (const t of texts) expect(emailButtonLabel(fill, t)).toBe(buttonLabel(fill, t));
        }
  });

  it("puts a dark label on a pale brand button (white on #ffff00 was 1.07:1)", async () => {
    const { emailButtonLabel } = await import("../../src/modules/emails/button-label");
    expect(emailButtonLabel("#ffff00")).toBe("#111111");
    expect(emailButtonLabel("#111111")).toBe("#ffffff");
  });
});

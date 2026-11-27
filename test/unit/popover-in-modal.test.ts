import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * A popover list inside a dialog must scroll. The dialog locks scrolling outside its content
 * and the popover content is portalled outside it, so `Popover` turns modal inside a modal
 * (`InModalContext`, provided by `DialogContent` and `SheetContent`). Reported on the segment
 * filter dialog, 2026-11-26: the attribute list did not scroll under the wheel.
 *
 * Source-level: the guarantee holds only while every popover and every modal goes through
 * these primitives, so a raw Radix Popover or Dialog elsewhere fails here.
 */
const DASH = join(import.meta.dirname, "..", "..", "dashboard");
const read = (p: string) => readFileSync(join(DASH, p), "utf8");

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("popover inside a modal", () => {
  it("Popover defaults to modal inside a Dialog or Sheet", () => {
    expect(read("components/ui/popover.tsx")).toMatch(/modal=\{modal \?\? inModal\}/);
    for (const f of ["components/ui/dialog.tsx", "components/ui/sheet.tsx"])
      expect(read(f), f).toMatch(
        /<InModalContext\.Provider value=\{true\}>\{children\}<\/InModalContext\.Provider>/,
      );
  });

  it("no screen uses Radix Popover or Dialog directly", () => {
    const allowed: Record<string, string[]> = {
      Popover: ["components/ui/popover.tsx"],
      Dialog: ["components/ui/dialog.tsx", "components/ui/sheet.tsx"],
      AlertDialog: [],
    };
    const offenders: string[] = [];
    for (const f of [
      ...files(join(DASH, "components")),
      ...files(join(DASH, "app")),
      ...files(join(DASH, "lib")),
    ]) {
      const src = readFileSync(f, "utf8");
      const rel = relative(DASH, f);
      for (const [prim, ok] of Object.entries(allowed)) {
        const re = new RegExp(
          `\\{[^}]*\\b${prim} as \\w+[^}]*\\}\\s*from "radix-ui"|from "@radix-ui/react-${prim.toLowerCase()}"`,
        );
        if (re.test(src) && !ok.includes(rel)) offenders.push(`${rel} (${prim})`);
      }
      if (/\bpopover\b[^\n]*modal=\{false\}|<Popover[^>]*modal=\{false\}/.test(src))
        offenders.push(`${rel} (Popover modal={false})`);
    }
    expect(offenders).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  THEME_CHOICE_SCRIPT,
  readThemeCookie,
  themeChoice,
  themeCookieString,
} from "../../dashboard/lib/theme-cookie";

describe("theme cookie", () => {
  it("reads only a known choice from the cookie header", () => {
    expect(readThemeCookie("a=1; tmb_theme=dark; b=2")).toBe("dark");
    expect(readThemeCookie("tmb_theme=system")).toBe("system");
    expect(readThemeCookie("tmb_theme=purple")).toBeNull();
    expect(readThemeCookie("xtmb_theme=dark")).toBeNull();
    expect(readThemeCookie("")).toBeNull();
  });

  it("writes a first-party, one-year, Lax cookie with no other data", () => {
    expect(themeCookieString("light", false)).toBe(
      "tmb_theme=light; Path=/; Max-Age=31536000; SameSite=Lax",
    );
    expect(themeCookieString("dark", true)).toMatch(/; Secure$/);
  });

  it("stamps the cookie, else the account's saved theme", () => {
    expect(themeChoice("dark", "light")).toBe("dark");
    expect(themeChoice(undefined, "light")).toBe("light");
    expect(themeChoice("junk", "system")).toBe("system");
    expect(themeChoice(undefined, null)).toBeNull();
  });
});

/** Runs the head script against a stub <html> and localStorage. */
function runScript(choice: string | undefined, stored: string | null, prefersDark = false) {
  const classes = new Set<string>(["font", stored === "dark" ? "dark" : "light"]);
  const html = {
    dataset: choice ? { themeChoice: choice } : {},
    style: {} as { colorScheme?: string },
    classList: {
      add: (c: string) => classes.add(c),
      remove: (...cs: string[]) => cs.forEach((c) => classes.delete(c)),
    },
  };
  const store = new Map<string, string>(stored ? [["theme", stored]] : []);
  new Function("document", "localStorage", "matchMedia", THEME_CHOICE_SCRIPT)(
    { documentElement: html },
    {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    },
    () => ({ matches: prefersDark }),
  );
  return {
    classes: [...classes].sort(),
    scheme: html.style.colorScheme,
    stored: store.get("theme"),
  };
}

describe("theme head script", () => {
  it("paints the stamped choice over localStorage and copies it there", () => {
    expect(runScript("dark", "light")).toEqual({
      classes: ["dark", "font"],
      scheme: "dark",
      stored: "dark",
    });
  });

  it("resolves system from the device", () => {
    expect(runScript("system", "light", true)).toEqual({
      classes: ["dark", "font"],
      scheme: "dark",
      stored: "system",
    });
  });

  it("leaves next-themes alone when nothing is stamped", () => {
    expect(runScript(undefined, "dark")).toEqual({
      classes: ["dark", "font"],
      scheme: undefined,
      stored: "dark",
    });
  });
});

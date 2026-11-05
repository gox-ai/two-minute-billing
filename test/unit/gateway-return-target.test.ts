import { describe, expect, it } from "vitest";
// Relative, not `@/…`: this lives in the dashboard app and the root `@/` alias points at src/.
import { gatewayReturnTarget } from "../../dashboard/lib/gateway-return";

describe("gateway return bounce", () => {
  it("keeps a same-origin page with its query and hash", () => {
    expect(gatewayReturnTarget("/portal/s/abc?x=1#pay")).toBe("/portal/s/abc?x=1#pay");
  });

  it.each([
    null,
    "",
    "https://evil.example/",
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "/..//evil.example",
    "/.//evil.example",
    "/a/..//evil.example/x",
    "/a/../\\evil.example",
  ])("never leaves this origin: %j", (next) => {
    const out = gatewayReturnTarget(next);
    expect(out.startsWith("/")).toBe(true);
    expect(out[1] === "/" || out[1] === "\\").toBe(false);
  });
});

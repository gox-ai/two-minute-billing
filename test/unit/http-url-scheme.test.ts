/**
 * The two URL helpers in src/api/limits.ts, and the difference between them is the point.
 *
 * Plain `z.string().url()` validates parseability, not scheme: `javascript:` and `data:`
 * both pass it. So both helpers exist to turn those into a clear 400.
 *
 * · `httpUrl` — http(s) ONLY. For a URL WE fetch or embed: a logo, a website, a webhook
 *   endpoint. Nothing legitimate there is a custom scheme.
 * · `redirectUrl` — for a URL a BUYER'S BROWSER is sent to. It must also accept a mobile
 *   deep link (`myapp://done`), because a checkout finishing inside an app returns to
 *   one, and those worked before these fields were validated at all. Narrowing them to
 *   http(s) turned a working integration into a 400 for no security gain, which is the
 *   regression the second helper exists to prevent.
 */
import { describe, it, expect } from "vitest";
import { httpUrl, redirectUrl, LIMITS } from "@/api/limits";

describe("httpUrl", () => {
  it("accepts an https:// URL", () => {
    expect(httpUrl().safeParse("https://example.com/return").success).toBe(true);
  });

  it("accepts an http:// URL", () => {
    expect(httpUrl().safeParse("http://example.com/return").success).toBe(true);
  });

  it("rejects a javascript: URL", () => {
    expect(httpUrl().safeParse("javascript:alert(1)").success).toBe(false);
  });

  it("rejects a data: URL", () => {
    expect(httpUrl().safeParse("data:text/html,<script>alert(1)</script>").success).toBe(false);
  });

  it("rejects an ftp: URL", () => {
    expect(httpUrl().safeParse("ftp://example.com/file").success).toBe(false);
  });

  it("rejects a string that isn't a URL at all", () => {
    expect(httpUrl().safeParse("not a url").success).toBe(false);
  });

  it("still enforces the shared LIMITS.url length cap", () => {
    const tooLong = "https://example.com/" + "a".repeat(LIMITS.url);
    expect(httpUrl().safeParse(tooLong).success).toBe(false);
  });

  // Nullable/optional behaviour must survive chaining exactly as it did before this
  // change — the fields below wrap httpUrl() the same way the routes do.
  it("optional() still accepts undefined", () => {
    expect(httpUrl().optional().safeParse(undefined).success).toBe(true);
  });

  it("optional() still rejects a bad scheme when the value IS present", () => {
    expect(httpUrl().optional().safeParse("javascript:alert(1)").success).toBe(false);
  });

  it("nullable().optional() still accepts null", () => {
    expect(httpUrl().nullable().optional().safeParse(null).success).toBe(true);
  });

  it("nullable().optional() still accepts undefined", () => {
    expect(httpUrl().nullable().optional().safeParse(undefined).success).toBe(true);
  });

  it("nullable().optional() still rejects a bad scheme when present", () => {
    expect(httpUrl().nullable().optional().safeParse("data:text/plain,x").success).toBe(false);
  });

  it("required (no optional/nullable) still rejects a missing value", () => {
    expect(httpUrl().safeParse(undefined).success).toBe(false);
  });
});

describe("redirectUrl — permissive about schemes, strict about executable ones", () => {
  it("accepts http and https, like httpUrl", () => {
    expect(redirectUrl().safeParse("https://example.com/done").success).toBe(true);
    expect(redirectUrl().safeParse("http://example.com/done").success).toBe(true);
  });

  it("ACCEPTS a mobile deep link — the whole reason it is separate from httpUrl", () => {
    for (const url of [
      "myapp://billing/done",
      "com.acme.app:/callback",
      "acme-billing://checkout/complete",
    ]) {
      expect(redirectUrl().safeParse(url).success).toBe(true);
      // ...and httpUrl would have rejected every one of them.
      expect(httpUrl().safeParse(url).success).toBe(false);
    }
  });

  it("rejects every scheme that can execute in the page after the redirect", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://example.com/abc",
    ]) {
      expect(redirectUrl().safeParse(url).success).toBe(false);
    }
  });

  it("is not fooled by case or leading whitespace", () => {
    // A prefix check on the raw string is only a control if it normalises first.
    for (const url of [
      "JavaScript:alert(1)",
      "  javascript:alert(1)",
      "\tDATA:text/html,x",
      "JAVASCRIPT:alert(1)",
    ]) {
      expect(redirectUrl().safeParse(url).success).toBe(false);
    }
  });

  it("still enforces the length cap", () => {
    expect(redirectUrl().safeParse(`https://e.test/${"a".repeat(LIMITS.url)}`).success).toBe(false);
  });
});

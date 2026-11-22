import { describe, expect, it } from "vitest";
import {
  addPixel,
  classifyEngagement,
  clickUrl,
  instrumentHtml,
  isAppleProxyIp,
  linkShape,
  pixelUrl,
  rewriteLinks,
  signToken,
  verifyToken,
} from "@/modules/emails/tracking";
import { initialEmailConfig, resolveEmailConfig } from "@/modules/emails/config";

const ID = "0192f3a4-7b1c-7d2e-8a3b-4c5d6e7f8091";
const BASE = "https://api.example.com";
const HUMAN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

describe("token sign and verify", () => {
  it("round-trips an open and a link", () => {
    expect(verifyToken("o", signToken("o", ID))).toEqual({ emailId: ID, position: 0 });
    expect(verifyToken("c", signToken("c", ID, 7))).toEqual({ emailId: ID, position: 7 });
  });
  it("refuses a token of the other kind, a tampered one and junk", () => {
    const t = signToken("c", ID, 1);
    expect(verifyToken("o", t)).toBeNull();
    const bad = (t[0] === "A" ? "B" : "A") + t.slice(1);
    expect(verifyToken("c", bad)).toBeNull();
    expect(verifyToken("c", t.slice(0, -1) + (t.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(verifyToken("c", "")).toBeNull();
    expect(verifyToken("c", "x".repeat(40))).toBeNull();
  });
});

describe("rewriteLinks", () => {
  const redirect = (p: number) => `${BASE}/e/c/T${p}`;
  it("rewrites http(s) links and keeps the other attributes and the text", () => {
    const html = `<p><a style="color:red" href="https://shop.example.com/pay?x=1&amp;y=2" target="_blank">Pay now</a></p>`;
    const r = rewriteLinks(html, redirect);
    expect(r.html).toBe(
      `<p><a style="color:red" href="${BASE}/e/c/T1" target="_blank">Pay now</a></p>`,
    );
    expect(r.links).toEqual([
      { position: 1, url: "https://shop.example.com/pay?x=1&y=2", label: "Pay now" },
    ]);
  });
  it("skips mailto, tel, anchors, unsubscribe and relative links", () => {
    const html = [
      `<a href="mailto:a@example.com">m</a>`,
      `<a href="tel:+15550100">t</a>`,
      `<a href="#top">a</a>`,
      `<a href="https://x.example.com/unsubscribe?u=1">u</a>`,
      `<a href='https://x.example.com/Unsubscribe'>u</a>`,
      `<a href="/relative">r</a>`,
      `<a name="x">n</a>`,
    ].join("");
    const r = rewriteLinks(html, redirect);
    expect(r.html).toBe(html);
    expect(r.links).toEqual([]);
  });
  it("numbers links in order and handles single quotes", () => {
    const r = rewriteLinks(
      `<a href='https://a.example.com'>A</a><a href="https://b.example.com">B</a>`,
      redirect,
    );
    expect(r.html).toBe(`<a href='${BASE}/e/c/T1'>A</a><a href="${BASE}/e/c/T2">B</a>`);
    expect(r.links.map((l) => l.position)).toEqual([1, 2]);
  });
  it("never keeps an address in a label", () => {
    const r = rewriteLinks(`<a href="https://a.example.com">Write to me@example.com</a>`, redirect);
    expect(r.links[0]!.label).toBeNull();
  });
});

describe("pixel", () => {
  it("goes before </body>, else at the end", () => {
    const px = pixelUrl(BASE, ID);
    expect(addPixel("<html><body><p>x</p></body></html>", px)).toMatch(
      /<p>x<\/p><img src="[^"]+\.gif"[^>]*\/><\/body>/,
    );
    expect(addPixel("<p>x</p>", px).startsWith("<p>x</p><img ")).toBe(true);
  });
  it("instrumentHtml changes only the HTML it is given and ties links to the email", () => {
    const r = instrumentHtml(`<body><a href="https://a.example.com/p">Go</a></body>`, ID, BASE);
    expect(r.html).toContain(clickUrl(BASE, ID, 1));
    expect(r.html).toContain(pixelUrl(BASE, ID));
    expect(r.links).toHaveLength(1);
  });
});

describe("linkShape", () => {
  it("drops the query and masks ids and tokens", () => {
    expect(linkShape("https://Portal.Example.com/portal/s/abcDEF123456789xyz?next=/x#y")).toEqual({
      host: "portal.example.com",
      path: "/portal/s/:id",
    });
    expect(linkShape("https://a.example.com/")).toEqual({ host: "a.example.com", path: "/" });
  });
});

describe("classifyEngagement", () => {
  const base = { method: "GET", userAgent: HUMAN_UA, ip: "203.0.113.9", sinceSentMs: 3_600_000 };
  it("a person is not machine", () => {
    expect(classifyEngagement({ kind: "open", ...base }).machine).toBe(false);
    expect(classifyEngagement({ kind: "click", ...base }).machine).toBe(false);
  });
  it("Apple proxy addresses are machine opens", () => {
    expect(isAppleProxyIp("17.58.1.2")).toBe(true);
    expect(isAppleProxyIp("::ffff:17.58.1.2")).toBe(true);
    expect(isAppleProxyIp("172.16.0.1")).toBe(false);
    expect(classifyEngagement({ kind: "open", ...base, ip: "17.58.1.2" })).toEqual({
      machine: true,
      reason: "apple_proxy",
    });
  });
  it("the Google image proxy is machine only right after the send", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)";
    expect(
      classifyEngagement({ kind: "open", ...base, userAgent: ua, sinceSentMs: 2_000 }).machine,
    ).toBe(true);
    expect(classifyEngagement({ kind: "open", ...base, userAgent: ua }).machine).toBe(false);
  });
  it("scanner agents, HEAD, bots and a click within seconds are machine", () => {
    expect(
      classifyEngagement({
        kind: "click",
        ...base,
        userAgent: "Mozilla/5.0 Proofpoint URL Defense",
      }).reason,
    ).toBe("scanner");
    expect(classifyEngagement({ kind: "click", ...base, method: "HEAD" }).reason).toBe(
      "head_request",
    );
    expect(classifyEngagement({ kind: "open", ...base, userAgent: "curl/8.0.1" }).reason).toBe(
      "bot",
    );
    expect(classifyEngagement({ kind: "click", ...base, userAgent: null }).machine).toBe(true);
    expect(classifyEngagement({ kind: "click", ...base, sinceSentMs: 1_000 }).reason).toBe(
      "too_fast",
    );
    expect(classifyEngagement({ kind: "open", ...base, sinceSentMs: 1_000 }).machine).toBe(false);
  });
});

describe("the setting", () => {
  it("is off when unset, on for a business a person creates", () => {
    expect(resolveEmailConfig(null).trackEngagement).toBe(false);
    expect(resolveEmailConfig({ emailConfig: { enabled: true } }).trackEngagement).toBe(false);
    expect(resolveEmailConfig({ emailConfig: { trackEngagement: true } }).trackEngagement).toBe(
      true,
    );
    expect(
      resolveEmailConfig({ emailConfig: initialEmailConfig({ hasOperator: true }) })
        .trackEngagement,
    ).toBe(true);
    expect(resolveEmailConfig({ emailConfig: initialEmailConfig({}) }).trackEngagement).toBe(true);
  });
});

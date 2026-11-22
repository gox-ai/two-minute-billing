import { describe, expect, it } from "vitest";
import { isBot, parseUserAgent } from "@/modules/storefront-analytics/user-agent";
import { channelOf, mediumOf, sourceOf } from "@/modules/storefront-analytics/channels";
import {
  cleanUtm,
  countryFrom,
  referrerHostOf,
  trackingRefused,
} from "@/modules/storefront-analytics/privacy";
import { clampSteps, MAX_STEP_MS_PER_BEACON } from "@/modules/storefront-analytics/steps";

const UA = {
  chromeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  edgeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  chromeIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  androidPhone:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  samsung:
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
};

describe("parseUserAgent", () => {
  it.each([
    [UA.chromeWin, "desktop", "Chrome", "Windows"],
    [UA.edgeWin, "desktop", "Edge", "Windows"],
    [UA.safariMac, "desktop", "Safari", "macOS"],
    [UA.safariIphone, "mobile", "Safari", "iOS"],
    [UA.chromeIos, "mobile", "Chrome", "iOS"],
    [UA.ipad, "tablet", "Safari", "iOS"],
    [UA.androidPhone, "mobile", "Chrome", "Android"],
    [UA.androidTablet, "tablet", "Chrome", "Android"],
    [UA.samsung, "mobile", "Samsung Internet", "Android"],
    [UA.firefoxLinux, "desktop", "Firefox", "Linux"],
  ])("%s", (ua, device, browser, os) => {
    expect(parseUserAgent(ua)).toEqual({ device, browser, os });
  });
});

describe("bot filter", () => {
  it.each([
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36",
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "curl/8.5.0",
    "python-requests/2.32.3",
    "Mozilla/5.0",
    "",
  ])("drops %s", (ua) => {
    expect(isBot(ua)).toBe(true);
    expect(parseUserAgent(ua)).toBeNull();
  });
  it("drops a missing user agent", () => expect(parseUserAgent(undefined)).toBeNull());
  it("keeps real browsers", () => {
    for (const ua of Object.values(UA)) expect(isBot(ua)).toBe(false);
  });
});

describe("channel grouping", () => {
  const v = (p: Partial<Parameters<typeof channelOf>[0]>) => ({
    referrerHost: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    ...p,
  });
  it.each([
    [v({}), "Direct"],
    [v({ utmMedium: "cpc", utmSource: "google" }), "Campaign"],
    [v({ utmMedium: "paid", utmSource: "social", utmCampaign: "bf-2026" }), "Campaign"],
    [v({ utmCampaign: "launch" }), "Campaign"],
    [v({ utmMedium: "email", utmSource: "newsletter" }), "Email"],
    [v({ referrerHost: "mail.google.com" }), "Email"],
    [v({ referrerHost: "google.co.uk" }), "Organic search"],
    [v({ referrerHost: "duckduckgo.com" }), "Organic search"],
    [v({ utmMedium: "organic", utmSource: "bing" }), "Organic search"],
    [v({ referrerHost: "t.co" }), "Social"],
    [v({ referrerHost: "m.facebook.com" }), "Social"],
    [v({ referrerHost: "partner.example.com" }), "Referral"],
    [v({ utmSource: "partner" }), "Referral"],
    // A tagged medium decides over the referrer.
    [v({ referrerHost: "google.com", utmMedium: "email" }), "Email"],
  ])("%o → %s", (input, channel) => expect(channelOf(input)).toBe(channel));

  it("names source and medium for untagged visits", () => {
    expect(sourceOf(v({}))).toBe("(direct)");
    expect(mediumOf(v({}))).toBe("(none)");
    expect(sourceOf(v({ referrerHost: "google.com" }))).toBe("google.com");
    expect(mediumOf(v({ referrerHost: "google.com" }))).toBe("organic");
    expect(mediumOf(v({ referrerHost: "partner.example.com" }))).toBe("referral");
  });
});

describe("privacy rules", () => {
  it("GPC or DNT refuses tracking", () => {
    expect(trackingRefused({ "sec-gpc": "1" })).toBe(true);
    expect(trackingRefused({ dnt: "1" })).toBe(true);
    expect(trackingRefused(new Headers({ "Sec-GPC": "1" }))).toBe(true);
    expect(trackingRefused({ dnt: "0" })).toBe(false);
    expect(trackingRefused({})).toBe(false);
  });
  it("keeps only the referrer host", () => {
    expect(referrerHostOf("https://www.Partner.example.com/pricing?ref=abc#x")).toBe(
      "partner.example.com",
    );
    expect(referrerHostOf("partner.example.com")).toBe("partner.example.com");
    expect(referrerHostOf("https://pay.example.com/x", "pay.example.com:443")).toBeNull();
    expect(referrerHostOf("not a url at all")).toBeNull();
    expect(referrerHostOf(null)).toBeNull();
  });
  it("reads a country only from the edge header", () => {
    expect(countryFrom({ "cf-ipcountry": "in" })).toBe("IN");
    expect(countryFrom({ "cf-ipcountry": "XX" })).toBeNull();
    expect(countryFrom({ "cf-ipcountry": "T1" })).toBeNull();
    expect(countryFrom({})).toBeNull();
  });
  it("normalises UTM values", () => {
    expect(cleanUtm("  News-Letter ")).toBe("news-letter");
    expect(cleanUtm("")).toBeNull();
    expect(cleanUtm("x".repeat(300))).toHaveLength(100);
  });
  it("keeps known steps only, capped per beacon", () => {
    expect(clampSteps("checkout", { details: 1200.6, invoices: 5, evil: 9 })).toEqual({
      details: 1201,
    });
    expect(clampSteps("portal", { invoices: 1e12, plan: -4 })).toEqual({
      invoices: MAX_STEP_MS_PER_BEACON,
    });
  });
});

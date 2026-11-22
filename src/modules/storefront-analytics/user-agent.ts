/**
 * User agent → device category, browser family, OS family. The raw string is read once and
 * dropped; only these three words are stored. Order matters in every table: the first match
 * wins, so a browser built on another (Edge on Chrome, Chrome on Safari) comes first.
 */

export type DeviceCategory = "desktop" | "mobile" | "tablet";

export interface ParsedUserAgent {
  device: DeviceCategory;
  browser: string;
  os: string;
}

/** Crawlers, link scanners, previewers, monitors and HTTP libraries. */
const BOT =
  /bot\b|bot\/|crawl|spider|slurp|scan|preview|monitor|uptime|headless|phantom|lighthouse|pingdom|facebookexternalhit|whatsapp|slack|discord|telegram|embedly|python-|python\/|curl\/|wget|go-http|java\/|okhttp|axios|node-fetch|undici|httpclient|libwww|postman|insomnia|feedfetcher|mediapartners|proofpoint|mimecast|barracuda|safelinks|^mozilla\/5\.0$/i;

const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/edg(e|a|ios)?\//i, "Edge"],
  [/opr\/|opera/i, "Opera"],
  [/samsungbrowser\//i, "Samsung Internet"],
  [/yabrowser\//i, "Yandex"],
  [/ucbrowser\//i, "UC Browser"],
  [/firefox\/|fxios\//i, "Firefox"],
  [/crios\/|chrome\/|chromium\//i, "Chrome"],
  [/version\/[\d.]+.*safari\//i, "Safari"],
  [/(iphone|ipad|ipod).*applewebkit/i, "Safari"],
];

const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/windows phone/i, "Windows Phone"],
  [/windows/i, "Windows"],
  [/iphone|ipad|ipod/i, "iOS"],
  [/android/i, "Android"],
  [/cros/i, "ChromeOS"],
  [/mac os x|macintosh/i, "macOS"],
  [/linux/i, "Linux"],
];

export function isBot(ua: string | null | undefined): boolean {
  if (!ua || ua.trim().length < 10) return true;
  return BOT.test(ua);
}

function deviceOf(ua: string): DeviceCategory {
  if (/ipad|tablet|kindle|silk|playbook/i.test(ua)) return "tablet";
  // Android without "Mobile" is a tablet by Google's own convention.
  if (/android/i.test(ua) && !/mobile/i.test(ua)) return "tablet";
  if (/mobi|iphone|ipod|android|windows phone/i.test(ua)) return "mobile";
  return "desktop";
}

/** Null for a bot or no user agent: such a request records nothing. */
export function parseUserAgent(ua: string | null | undefined): ParsedUserAgent | null {
  if (isBot(ua)) return null;
  const s = ua!.slice(0, 512);
  return {
    device: deviceOf(s),
    browser: BROWSERS.find(([re]) => re.test(s))?.[1] ?? "Other",
    os: SYSTEMS.find(([re]) => re.test(s))?.[1] ?? "Other",
  };
}

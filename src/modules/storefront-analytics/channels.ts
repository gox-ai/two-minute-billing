/**
 * Channel grouping for "Where buyers come from", as plain data. A visit takes the FIRST rule
 * that matches; the last rule always matches. Change the lists here, not the code below.
 */

export type Channel = "Campaign" | "Email" | "Organic search" | "Social" | "Referral" | "Direct";

export interface VisitSource {
  referrerHost: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
}

/** Paid mediums: a link a business paid to show. */
export const PAID_MEDIUMS = [
  "cpc",
  "ppc",
  "paid",
  "paidsearch",
  "paid_search",
  "paid-search",
  "paidsocial",
  "paid_social",
  "paid-social",
  "display",
  "banner",
  "cpm",
  "affiliate",
] as const;
export const EMAIL_MEDIUMS = ["email", "e-mail", "newsletter", "mail"] as const;
export const SOCIAL_MEDIUMS = ["social", "social-network", "social_media", "sm"] as const;
export const ORGANIC_MEDIUMS = ["organic"] as const;

/** Hosts matched on the whole label sequence: `google.co.uk` matches `google`. */
export const SEARCH_HOSTS = [
  "google",
  "bing",
  "duckduckgo",
  "yahoo",
  "yandex",
  "baidu",
  "ecosia",
  "brave",
  "startpage",
  "qwant",
  "naver",
] as const;
export const EMAIL_HOSTS = [
  "mail.google.com",
  "outlook.live.com",
  "outlook.office.com",
  "outlook.office365.com",
  "mail.yahoo.com",
  "mail.proton.me",
  "app.fastmail.com",
  "mail.zoho.com",
  "webmail",
] as const;
export const SOCIAL_HOSTS = [
  "facebook.com",
  "fb.com",
  "instagram.com",
  "linkedin.com",
  "lnkd.in",
  "t.co",
  "twitter.com",
  "x.com",
  "reddit.com",
  "youtube.com",
  "tiktok.com",
  "pinterest.com",
  "threads.net",
  "news.ycombinator.com",
] as const;

const hostIs = (host: string, list: readonly string[]) =>
  list.some((h) => host === h || host.endsWith(`.${h}`) || host.startsWith(`${h}.`));
const searchHost = (host: string) =>
  SEARCH_HOSTS.some((s) => host === `${s}.com` || host.split(".").includes(s));

export const CHANNEL_RULES: ReadonlyArray<{
  channel: Channel;
  when: string;
  test: (v: VisitSource) => boolean;
}> = [
  {
    channel: "Campaign",
    when: "utm_medium is a paid medium, or utm_campaign is set with no other medium",
    test: (v) =>
      (v.utmMedium != null && (PAID_MEDIUMS as readonly string[]).includes(v.utmMedium)) ||
      (v.utmCampaign != null && v.utmMedium == null && v.utmSource == null),
  },
  {
    channel: "Email",
    when: "utm_medium is an email medium, or the referrer is a webmail host",
    test: (v) =>
      (v.utmMedium != null && (EMAIL_MEDIUMS as readonly string[]).includes(v.utmMedium)) ||
      (v.referrerHost != null && hostIs(v.referrerHost, EMAIL_HOSTS)),
  },
  {
    channel: "Organic search",
    when: "utm_medium is organic, or the referrer is a search engine",
    test: (v) =>
      (v.utmMedium != null && (ORGANIC_MEDIUMS as readonly string[]).includes(v.utmMedium)) ||
      (v.referrerHost != null && v.utmMedium == null && searchHost(v.referrerHost)),
  },
  {
    channel: "Social",
    when: "utm_medium is a social medium, or the referrer is a social network",
    test: (v) =>
      (v.utmMedium != null && (SOCIAL_MEDIUMS as readonly string[]).includes(v.utmMedium)) ||
      (v.referrerHost != null && v.utmMedium == null && hostIs(v.referrerHost, SOCIAL_HOSTS)),
  },
  {
    channel: "Referral",
    when: "any other referrer or UTM tag",
    test: (v) =>
      v.referrerHost != null || v.utmSource != null || v.utmMedium != null || v.utmCampaign != null,
  },
  { channel: "Direct", when: "no referrer and no UTM tag", test: () => true },
];

export function channelOf(v: VisitSource): Channel {
  return CHANNEL_RULES.find((r) => r.test(v))!.channel;
}

/** What the report shows as the source: the UTM source, else the referrer host. */
export function sourceOf(v: VisitSource): string {
  return v.utmSource ?? v.referrerHost ?? "(direct)";
}
export function mediumOf(v: VisitSource): string {
  if (v.utmMedium) return v.utmMedium;
  const c = channelOf(v);
  return c === "Direct"
    ? "(none)"
    : c === "Organic search"
      ? "organic"
      : c === "Email"
        ? "email"
        : c === "Social"
          ? "social"
          : "referral";
}

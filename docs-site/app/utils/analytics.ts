import { COOKIE_CONSENT_KEY } from "./cookie-consent";

/**
 * One GA4 event, when analytics is on in this build. Consent mode decides what gtag may store,
 * so a visitor who refused still sends only a cookieless ping.
 */
export function track(name: string, params: Record<string, string | number | undefined> = {}) {
  if (import.meta.server) return;
  window.gtag?.("event", name, params);
}

/**
 * The visitor's choice as a cookie for the whole domain, so the sign-up page on the app's
 * subdomain applies the same consent (local storage is per origin).
 */
export function shareConsent(choice: string) {
  if (import.meta.server) return;
  const domain = location.hostname.replace(/^www\./, "");
  const secure = location.protocol === "https:" ? "; secure" : "";
  document.cookie = `${COOKIE_CONSENT_KEY}=${choice}; domain=${domain}; path=/; max-age=31536000; samesite=lax${secure}`;
}

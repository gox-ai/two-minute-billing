import { cookies, headers } from "next/headers";

/**
 * Google Analytics 4 for the sign-up page only (Cloud's funnel from the website). Unset
 * GA_MEASUREMENT_ID = nothing loads and nothing is sent.
 *
 * Consent follows the website: analytics are on unless the visitor refused, and in the
 * countries below they stay off until accepted. The website shares the visitor's choice as the
 * `tmb-cookie-consent` cookie on the parent domain.
 */
export const CONSENT_COOKIE = "tmb-cookie-consent";
export const CONSENT_COUNTRIES = Object.freeze([
  ...["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE"],
  ...["IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"],
  ...["IS", "LI", "NO", "GB", "CH"],
]);

export function gaMeasurementId(): string | undefined {
  const id = process.env.GA_MEASUREMENT_ID?.trim();
  return id && /^G-[A-Z0-9]+$/.test(id) ? id : undefined;
}

/**
 * `sign_up` through the Measurement Protocol once an account exists. Server-side because both
 * paths (the emailed link, Google) redirect straight into the dashboard, where GA does not
 * load. It joins the visitor's website session through the `_ga` cookies on the parent
 * domain; without them, or without consent, nothing is sent. Never throws.
 */
export function signUpEvent(input: {
  method: "email" | "google";
  choice?: string;
  country?: string;
  ga?: string;
  gaSession?: string;
}): { client_id: string; events: unknown[] } | null {
  if (input.choice === "denied") return null;
  const country = input.country?.toUpperCase() ?? "";
  if (input.choice !== "granted" && (!country || CONSENT_COUNTRIES.includes(country))) return null;
  // _ga = GA1.1.<random>.<timestamp>; the client id is the last two parts.
  const clientId = input.ga?.split(".").slice(-2).join(".");
  if (!clientId || !/^\d+\.\d+$/.test(clientId)) return null;
  // _ga_<stream> = GS1.1.<session>.… or GS2.1.s<session>$…
  const session = input.gaSession?.match(/^GS\d\.\d\.s?(\d+)/)?.[1];
  return {
    client_id: clientId,
    events: [
      {
        name: "sign_up",
        params: {
          method: input.method,
          engagement_time_msec: 1,
          ...(session && { session_id: session }),
        },
      },
    ],
  };
}

export async function trackSignUp(method: "email" | "google"): Promise<void> {
  const id = gaMeasurementId();
  const secret = process.env.GA_API_SECRET?.trim();
  if (!id || !secret) return;
  try {
    const jar = await cookies();
    const body = signUpEvent({
      method,
      choice: jar.get(CONSENT_COOKIE)?.value,
      country: (await headers()).get("cf-ipcountry") ?? undefined,
      ga: jar.get("_ga")?.value,
      gaSession: jar.get(`_ga_${id.slice(2)}`)?.value,
    });
    if (!body) return;
    await fetch(
      `https://www.google-analytics.com/mp/collect?measurement_id=${id}&api_secret=${encodeURIComponent(secret)}`,
      { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(3000) },
    );
  } catch {
    // Analytics never blocks or breaks a sign-up.
  }
}

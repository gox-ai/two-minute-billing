import { CONSENT_REQUIRED, visitorCountry } from "../lib/regions";

/** Whether this visitor must accept analytics cookies first. An unknown country asks. */
export default defineEventHandler((event) => {
  setHeader(event, "cache-control", "private, no-store");
  const country = visitorCountry(event);
  return { consent_required: !country || CONSENT_REQUIRED.has(country) };
});

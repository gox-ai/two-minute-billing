import { cache } from "react";
import { getMe } from "@/lib/api";

/**
 * The organization's display timezone, for **server** code that formats a date on an
 * org-scoped screen (`/audit`, `/developer`) — the org-level sibling of
 * `businessTz()` in `lib/business-tz-server.ts`.
 *
 * Client components must NOT use this; they read `useDisplayTz()`, whose context the
 * signed-in layout already populates.
 *
 * `cache()` because one page with several server panels asks for it and one
 * `/v1/me` round trip per page is enough; React clears it between requests, so a
 * setting saved on /settings is live on the very next render.
 *
 * Falls back to UTC — the value every org-scoped screen used before this setting
 * existed — rather than throwing: a formatting helper must never be the thing that
 * blanks a monitoring page mid-incident.
 */
export const orgTz = cache(async (): Promise<string> => {
  try {
    return (await getMe()).timezone ?? "UTC";
  } catch {
    return "UTC";
  }
});

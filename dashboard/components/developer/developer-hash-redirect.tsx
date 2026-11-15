"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

/** The section anchors of the one-page Developer screen, and the tab each one is now. */
const HASH_TAB: Record<string, string> = {
  "webhook-endpoints": "/developer/webhooks",
  webhooks: "/developer/webhooks",
  "recent-events": "/developer/events",
  events: "/developer/events",
  "connected-apps": "/developer/connected-apps",
  "request-logs": "/developer/logs",
};

/** Opens the tab an old `/developer#<section>` link meant. `#api-keys` stays here. */
export function DeveloperHashRedirect() {
  const router = useRouter();
  React.useEffect(() => {
    const go = () => {
      const to = HASH_TAB[window.location.hash.slice(1)];
      if (to) router.replace(to);
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, [router]);
  return null;
}

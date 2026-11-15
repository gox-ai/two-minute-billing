"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

/** Sections of the old one-page /settings, by anchor, and the page each moved to. */
const MOVED: Record<string, string> = {
  "#security": "/settings/security",
};

/** Sends a link to an old /settings anchor on to the page that holds that section now. */
export function OldAnchorRedirect() {
  const router = useRouter();
  React.useEffect(() => {
    const to = MOVED[window.location.hash];
    if (to) router.replace(to);
  }, [router]);
  return null;
}

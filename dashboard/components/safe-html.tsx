"use client";

import * as React from "react";
import { sanitizeHtml } from "@/lib/sanitize-html";

const noop = () => () => {};

/** False on the server and the hydrating render, true after — for browser-only work. */
export function useIsClient(): boolean {
  return React.useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

/**
 * API-supplied HTML, sanitised with DOMPurify. Empty on the server and on the hydrating
 * render (DOMPurify needs a DOM), filled in on the client right after — the server snapshot
 * keeps hydration matching without a setState-in-effect.
 */
export function SafeHtml({
  html,
  ...props
}: { html: string } & Omit<React.HTMLAttributes<HTMLDivElement>, "dangerouslySetInnerHTML">) {
  const client = useIsClient();
  const clean = React.useMemo(() => (client ? sanitizeHtml(html) : ""), [client, html]);
  return <div {...props} dangerouslySetInnerHTML={{ __html: clean }} />;
}

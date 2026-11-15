import type { H3Event } from "h3";

/** 301 to a dashboard path, keeping the query string (campaign tags survive). */
export function redirectToApp(event: H3Event, appUrl: string, path: string) {
  const app = appUrl.replace(/\/+$/, "");
  return sendRedirect(event, `${app}${path}${getRequestURL(event).search}`, 301);
}

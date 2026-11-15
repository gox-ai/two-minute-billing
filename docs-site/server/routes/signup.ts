import { redirectToApp } from "../lib/app-redirect";

// Sign-up lives in the dashboard; a typed or shared site link should still reach it.
export default defineEventHandler((event) =>
  redirectToApp(event, useRuntimeConfig(event).public.appUrl, "/signup"),
);

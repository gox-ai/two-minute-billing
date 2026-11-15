import { redirectToApp } from "../lib/app-redirect";

export default defineEventHandler((event) =>
  redirectToApp(event, useRuntimeConfig(event).public.appUrl, "/login"),
);

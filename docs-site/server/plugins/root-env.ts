import { loadDocsRootEnv } from "../lib/root-env";

// The allowlisted NUXT_* keys from the root `.env`, before the first request (see ../lib/root-env).
export default defineNitroPlugin(() => {
  loadDocsRootEnv();
});

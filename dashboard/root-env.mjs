/**
 * The dashboard's share of the repository's one settings file, the root `.env`.
 *
 * That file also holds the database URL, gateway keys and the engine's secrets. The dashboard
 * holds no credential by design, so only the keys in ROOT_ENV_KEYS are copied in; nothing else
 * from the file enters this process.
 *
 * Precedence: the real environment > `dashboard/.env.local` (Next loads it before
 * `next.config.mjs` runs) > the root `.env`. An empty value in the root file counts as unset.
 * `DOTENV_CONFIG_PATH` names another root file (a worktree points it at the main checkout's).
 *
 * Gate: `pnpm verify:env-allowlist` — every `process.env.X` the dashboard reads is listed here,
 * and nothing listed looks like a secret.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

/** Keys the dashboard takes from the root `.env`. */
export const ROOT_ENV_KEYS = Object.freeze([
  "TMBILLING_API_URL",
  "TMBILLING_PUBLIC_API_URL",
  "TMBILLING_EDITION",
  "ALLOW_INSECURE_COOKIES",
  "CSP_REPORT_ONLY",
  "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
  "NEXT_PUBLIC_GOOGLE_CLIENT_ID",
  "NEXT_PUBLIC_GOOGLE_REDIRECT_URI",
  "ACCOUNT_BILLING_URL",
  "ACCOUNT_BILLING_TOKEN",
  "ACCOUNT_BILLING_CONTACT_URL",
  "GA_MEASUREMENT_ID",
  "GA_API_SECRET",
]);

/**
 * Read by the dashboard but never taken from the file: NODE_ENV belongs to the runtime,
 * NEXT_DIST_DIR is set per build by `deploy/reload.sh` (a value in `.env` would point
 * `next start` at the staging directory), and NEXT_OUTPUT by the Docker image build.
 */
export const PROCESS_ONLY_KEYS = Object.freeze(["NODE_ENV", "NEXT_DIST_DIR", "NEXT_OUTPUT"]);

/**
 * Listed although the name looks like a secret. ACCOUNT_BILLING_TOKEN is a bearer the dashboard
 * needs for Settings → Billing. The service at ACCOUNT_BILLING_URL accepts it for
 * `/v1/account_billing/*` and nothing else, and it is read server-side only (not `NEXT_PUBLIC_`).
 */
export const SECRET_NAME_EXCEPTIONS = Object.freeze({
  ACCOUNT_BILLING_TOKEN: "scoped to /v1/account_billing/*, server-side only",
  GA_API_SECRET: "sends sign_up events to our GA4 property only, server-side only",
});

/** The root `.env` this checkout reads. */
export function rootEnvPath(env = process.env) {
  return env.DOTENV_CONFIG_PATH || fileURLToPath(new URL("../.env", import.meta.url));
}

/**
 * Copy the allowlisted keys that are still unset from the root `.env` into `env`.
 * Returns the names it set (never values).
 */
export function loadRootEnv(env = process.env, path = rootEnvPath(env)) {
  if (!existsSync(path)) return [];
  const parsed = parse(readFileSync(path));
  const applied = [];
  for (const key of ROOT_ENV_KEYS) {
    const value = parsed[key];
    if (value === undefined || value === "" || env[key] !== undefined) continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

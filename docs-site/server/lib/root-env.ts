/**
 * The docs server's share of the repository's one settings file, the root `.env`.
 *
 * Nitro reads `NUXT_*` overrides from process.env on each request, so copying them in at server
 * start is enough. Only DOCS_ROOT_ENV_KEYS are copied; nothing else in the file (database URL,
 * gateway keys) enters this process. Precedence: the real environment > `docs-site/.env`
 * (`nuxt dev` / `nuxt build` only) > the root `.env`. An empty value counts as unset.
 *
 * The root file is `DOTENV_CONFIG_PATH` when set, else `.env` beside the nearest
 * `pnpm-workspace.yaml` above the working directory, so `node .output/server/index.mjs` from
 * `docs-site/` reads `../.env`. Gate: `pnpm verify:env-allowlist`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "dotenv";

/**
 * Every runtimeConfig key in nuxt.config.ts as its env name. NUXT_PUBLIC_EDITION and
 * NUXT_PUBLIC_GA_ID are left out on purpose: the build bakes them into the pages (one edition,
 * one gtag script), so the server must not change them.
 */
export const DOCS_ROOT_ENV_KEYS = [
  "NUXT_PRICING_API_URL",
  "NUXT_PRICING_BUSINESS",
  "NUXT_CONTACT_TO",
  "NUXT_CONTACT_FROM",
  "NUXT_CONTACT_SMTP_URL",
  "NUXT_CONTACT_SES_REGION",
  "NUXT_CONTACT_SES_KEY_ID",
  "NUXT_CONTACT_SES_SECRET",
  "NUXT_CONTACT_CHAT_WEBHOOK_URL",
  "NUXT_TURNSTILE_SECRET",
  "NUXT_PUBLIC_TURNSTILE_SITE_KEY",
  "NUXT_PUBLIC_APP_URL",
  "NUXT_PUBLIC_SITE_URL",
] as const;

/**
 * The Studio copy's keys (staff only). Staff sign in once, through Cloudflare Access; Studio
 * trusts the token Access signs (docs-site/cms/server/access-signin.ts) for the team and
 * application below, and only for emails on BACKOFFICE_ALLOWED_DOMAIN. Studio commits with one
 * fine-grained GitHub token. Read only by a Studio build: the public site's bundle has
 * TM_STUDIO_BUILD replaced with "" (nuxt.config.ts), so it never loads them.
 */
export const DOCS_STUDIO_ENV_KEYS = [
  "NUXT_STUDIO_AUTH_SESSION_SECRET",
  "NUXT_STUDIO_GIT_GITHUB_TOKEN",
  "DOCS_STUDIO_ACCESS_TEAM",
  "DOCS_STUDIO_ACCESS_AUD",
  "BACKOFFICE_ALLOWED_DOMAIN",
];

/**
 * A docs key left unset takes another root key's value: lead messages reach the back-office
 * alert channel until a channel of their own is set.
 */
export const DOCS_ROOT_ENV_FALLBACKS: Record<string, string> = {
  NUXT_CONTACT_CHAT_WEBHOOK_URL: "OPS_ALERT_WEBHOOK_URL",
};

type Env = Record<string, string | undefined>;

/** The root `.env` for this process, or undefined when there is none to find. */
export function docsRootEnvPath(env: Env = process.env, cwd = process.cwd()): string | undefined {
  if (env.DOTENV_CONFIG_PATH) return env.DOTENV_CONFIG_PATH;
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return join(dir, ".env");
    if (dirname(dir) === dir) return undefined;
  }
}

/** Copy the allowlisted keys that are still unset into `env`. Returns the names it set. */
export function loadDocsRootEnv(env: Env = process.env, path = docsRootEnvPath(env)): string[] {
  if (!path || !existsSync(path)) return [];
  const parsed = parse(readFileSync(path));
  const applied: string[] = [];
  const keys = process.env.TM_STUDIO_BUILD
    ? [...DOCS_ROOT_ENV_KEYS, ...DOCS_STUDIO_ENV_KEYS]
    : DOCS_ROOT_ENV_KEYS;
  for (const key of keys) {
    const value = parsed[key];
    if (value === undefined || value === "" || env[key] !== undefined) continue;
    env[key] = value;
    applied.push(key);
  }
  for (const [key, from] of Object.entries(DOCS_ROOT_ENV_FALLBACKS)) {
    const value = env[from] || parsed[from];
    if (env[key] || !value) continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

// The API calls the new commands share. Never prints the key.
import { randomUUID } from "node:crypto";

export class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

export function settings({ needBusiness = false, business } = {}) {
  const url = (process.env.TMBILLING_URL ?? "").replace(/\/$/, "");
  const key = process.env.TMBILLING_API_KEY ?? "";
  if (!url || !key)
    throw new CliError(
      "TMBILLING_URL and TMBILLING_API_KEY must be set (in the environment, ./.env or --env-file).",
    );
  if (!/^https?:\/\//.test(url))
    throw new CliError("TMBILLING_URL must start with http:// or https://.");
  const biz = business ?? process.env.TMBILLING_BUSINESS_ID ?? "";
  if (needBusiness && !biz)
    throw new CliError("pass --business biz_… or set TMBILLING_BUSINESS_ID.");
  return { url, key, biz };
}

/** One request. Returns { status, body, date } and throws CliError on a failed answer. */
export async function call(s, method, path, body, { allow = [], timeout = 30000 } = {}) {
  const headers = { Authorization: `Bearer ${s.key}` };
  if (method !== "GET")
    Object.assign(headers, { "Content-Type": "application/json", "Idempotency-Key": randomUUID() });
  let res;
  try {
    res = await fetch(`${s.url}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new CliError(`${method} ${path} failed: ${e?.cause?.code ?? e?.message ?? e}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok && !allow.includes(res.status))
    throw new CliError(
      `${method} ${path} answered ${res.status}: ${json?.error?.message ?? JSON.stringify(json).slice(0, 300)}`,
    );
  return { status: res.status, body: json, date: res.headers.get("date") };
}

/** Exit 3 unless the server says the key is a test key (the prefix only for older servers). */
export async function requireTestKey(s, what) {
  const { body: me } = await call(s, "GET", "/v1/me");
  const mode = me.credential?.livemode ?? (s.key.startsWith("sk_test_") ? "test" : "other");
  if (mode !== "test")
    throw new CliError(`refused: this key's mode is "${mode}". ${what} needs a test key.`, 3);
  return me;
}

/** The business, which must be a test business the key can see. */
export async function testBusiness(s) {
  const r = await call(s, "GET", `/v1/businesses/${encodeURIComponent(s.biz)}`, undefined, {
    allow: [404],
  });
  if (r.status === 404)
    throw new CliError(
      `no test business ${s.biz} for this key. A test key sees test businesses only.`,
    );
  if (r.body.livemode !== "test") throw new CliError(`refused: ${s.biz} is a live business.`, 3);
  return r.body;
}

/** `--name value` from an argument list. */
export function opt(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** The arguments that are not flags or flag values. */
export function positionals(argv, valueFlags) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) out.push(argv[i]);
    else if (valueFlags.includes(argv[i].slice(2))) i++;
  }
  return out;
}

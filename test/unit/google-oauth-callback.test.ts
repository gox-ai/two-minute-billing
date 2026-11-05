import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Dashboard `GET /auth/google/callback`: `state` must be one this browser was issued
 * (its cookie), and single-use. The backend code exchange is mocked; a refusal must
 * never reach it.
 */

const env = vi.hoisted(() => ({ jar: new Map<string, string>() }));

// The routes resolve `next` from dashboard/node_modules, so mock it by that path.
const fromDashboard = createRequire(new URL("../../dashboard/package.json", import.meta.url));
const nextPath = (m: string) => realpathSync(fromDashboard.resolve(m));

vi.doMock(nextPath("next/headers"), () => ({
  cookies: async () => ({
    get: (name: string) => (env.jar.has(name) ? { name, value: env.jar.get(name)! } : undefined),
    set: (name: string, value: string) => {
      if (value === "") env.jar.delete(name);
      else env.jar.set(name, value);
    },
  }),
  headers: async () => new Headers(),
}));

class Redirect extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}
vi.doMock(nextPath("next/navigation"), () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));

// Loaded by a computed path so the root tsc does not type the dashboard (its own `@/lib`).
type Route = { GET: (req: Request) => Promise<unknown> };
const route = (name: string) => `../../dashboard/app/auth/google/${name}/route`;
const { GET: start } = (await import(/* @vite-ignore */ route("start"))) as Route;
const { GET: callback } = (await import(/* @vite-ignore */ route("callback"))) as Route;
const { GOOGLE_STATE_COOKIE, SESSION_COOKIE } = await import("../../dashboard/lib/auth-cookies");

const exchange = vi.fn();
const where = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.catch((x: unknown) => x);
  if (!(e instanceof Redirect)) throw e;
  return e.url;
};
/** Run the start route; returns the `state` it put in the Google URL. */
const begin = async () => {
  const url = await where(start(new Request("https://dash.example.com/auth/google/start")));
  return new URL(url).searchParams.get("state")!;
};
const back = (state: string) =>
  where(
    callback(new Request(`https://dash.example.com/auth/google/callback?code=c1&state=${state}`)),
  );
const refused = (url: string) => url.startsWith("/login?error=");

beforeEach(() => {
  env.jar.clear();
  process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = "client-id";
  process.env.NEXT_PUBLIC_GOOGLE_REDIRECT_URI = "https://dash.example.com/auth/google/callback";
  exchange.mockReset();
  exchange.mockImplementation(async () => Response.json({ token: "tmb_session_token" }));
  vi.stubGlobal("fetch", exchange);
});
afterEach(() => vi.unstubAllGlobals());

describe("Google callback state checks", () => {
  it("control: the issued state with its cookie signs in", async () => {
    const state = await begin();
    expect(env.jar.get(GOOGLE_STATE_COOKIE)).toBe(state);
    const url = await back(state);
    expect(refused(url)).toBe(false);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(env.jar.get(SESSION_COOKIE)).toBe("tmb_session_token");
  });

  it("a state that was never issued is refused", async () => {
    await begin();
    const url = await back("never-issued-state-value-of-the-same-length-000");
    expect(refused(url)).toBe(true);
    expect(exchange).not.toHaveBeenCalled();
    expect(env.jar.has(SESSION_COOKIE)).toBe(false);
  });

  it("a real state without its cookie (another browser) is refused", async () => {
    const state = await begin();
    env.jar.delete(GOOGLE_STATE_COOKIE);
    const url = await back(state);
    expect(refused(url)).toBe(true);
    expect(exchange).not.toHaveBeenCalled();
  });

  it("a state is single-use: the second callback with it is refused", async () => {
    const state = await begin();
    expect(refused(await back(state))).toBe(false);
    env.jar.delete(SESSION_COOKIE);
    const again = await back(state);
    expect(refused(again)).toBe(true);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(env.jar.has(SESSION_COOKIE)).toBe(false);
  });

  it("a refused state still clears the state cookie", async () => {
    const state = await begin();
    await back(state.slice(0, -1) + (state.endsWith("A") ? "B" : "A"));
    expect(env.jar.has(GOOGLE_STATE_COOKIE)).toBe(false);
    expect(refused(await back(state))).toBe(true);
    expect(exchange).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { rejectPassword } from "@/modules/auth/password-policy";
import { registerSecurityHeaders } from "@/platform/security-headers";
import { TMTEST_FORM_POST_PATH } from "@/providers/tmtest/form-post";

const opts = { breachCheckEnabled: false };
const COMMON = "That password is too common. Use a different password.";

describe("common-password list catches composition-satisfying variants", () => {
  it.each(["Password1!", "Admin123!", "Welcome1!", "Qwerty123!", "P@ssw0rd!", "Letmein2024#"])(
    "%s is refused",
    async (pw) => {
      expect(await rejectPassword(pw, undefined, opts)).toBe(COMMON);
    },
  );
  it.each(["Tangerine-Sail-42!", "Mydragonisgreen9!"])("%s is accepted", async (pw) => {
    expect(await rejectPassword(pw, undefined, opts)).toBeNull();
  });
});

let app: FastifyInstance | undefined;
afterEach(() => app?.close());

async function build() {
  app = Fastify();
  registerSecurityHeaders(app);
  app.get("/v1/secret", async () => ({ secret: "sk_test_XXXX" }));
  app.get("/v1/cached", async (_req, reply) =>
    reply.header("cache-control", "public, max-age=60").send({}),
  );
  app.post(TMTEST_FORM_POST_PATH, async (req, reply) =>
    (req.query as { html?: string }).html
      ? reply.type("text/html; charset=utf-8").send("<form></form>")
      : reply
          .code(400)
          .send({ error: { type: "invalid_request_error", message: "bad signature" } }),
  );
  await app.ready();
  return app;
}

describe("security headers", () => {
  it("every response defaults to no-store", async () => {
    const r = await (await build()).inject({ method: "GET", url: "/v1/secret" });
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect(r.headers["pragma"]).toBe("no-cache");
  });
  it("a route's own cache policy is kept", async () => {
    const r = await (await build()).inject({ method: "GET", url: "/v1/cached" });
    expect(r.headers["cache-control"]).toBe("public, max-age=60");
  });
  it("the test gateway's JSON error keeps the strict policy; only its HTML page is loosened", async () => {
    const a = await build();
    const json = await a.inject({ method: "POST", url: TMTEST_FORM_POST_PATH });
    expect(json.headers["content-security-policy"]).toContain("form-action 'none'");
    const html = await a.inject({ method: "POST", url: `${TMTEST_FORM_POST_PATH}?html=1` });
    expect(html.headers["content-security-policy"]).toContain("form-action http: https:");
  });
});

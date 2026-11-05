import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

// The gateway log write is not the subject; keep it off Postgres.
vi.mock("@/platform/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/db")>();
  return {
    ...actual,
    systemDb: { insert: () => ({ values: () => Promise.resolve() }) },
  };
});

const { providerFetch } = await import("@/providers/http");

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function listen(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe("providerFetch never follows a redirect", () => {
  it.each([302, 307, 308])(
    "a %i is an unknown outcome, and the target never sees the credentials",
    async (status) => {
      let targetHits = 0;
      const target = await listen((_req, res) => {
        targetHits += 1;
        res.end("{}");
      });
      const origin = await listen((_req, res) => {
        res.writeHead(status, { location: `${target}/steal` });
        res.end();
      });
      await expect(
        providerFetch({
          gatewayKey: "razorpay",
          operation: "charge",
          method: "POST",
          url: `${origin}/v1/payments`,
          headers: { Authorization: "Basic c2VjcmV0" },
          body: "{}",
        }),
      ).rejects.toThrow(/Redirects are not followed\. The outcome is UNKNOWN/);
      expect(targetHits).toBe(0);
    },
  );

  it("an ordinary answer is returned unchanged", async () => {
    const origin = await listen((_req, res) => {
      res.writeHead(402, { "content-type": "application/json" });
      res.end('{"error":"declined"}');
    });
    const r = await providerFetch({
      gatewayKey: "razorpay",
      operation: "charge",
      method: "POST",
      url: `${origin}/v1/payments`,
      headers: {},
      body: "{}",
    });
    expect(r.status).toBe(402);
    expect(r.text).toContain("declined");
  });
});

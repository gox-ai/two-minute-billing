import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { trustProxyHops } from "@/platform/trust-proxy";

/**
 * Over a real socket, because `inject()` fakes the peer address. The API's rate limiter
 * keys on `req.ip`, so a wrong answer here is either a no-op limiter (trusts too much)
 * or one bucket for every client (trusts too little).
 */
let app: FastifyInstance | undefined;
afterEach(() => app?.close());

async function ipFor(hops: number, xff?: string): Promise<string> {
  app = Fastify({ trustProxy: trustProxyHops(hops) });
  app.get("/", async (req) => ({ ip: req.ip }));
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const res = await fetch(base, { headers: xff ? { "x-forwarded-for": xff } : {} });
  return ((await res.json()) as { ip: string }).ip;
}

describe("trustProxyHops", () => {
  it("one hop: the address nginx appended, not the one the client wrote", async () => {
    expect(await ipFor(1, "6.6.6.6, 203.0.113.7")).toBe("203.0.113.7");
  });

  it("zero hops: the socket peer, whatever the header claims", async () => {
    expect(await ipFor(0, "203.0.113.7")).toBe("127.0.0.1");
  });

  it("one hop, no header: the socket peer", async () => {
    expect(await ipFor(1)).toBe("127.0.0.1");
  });
});

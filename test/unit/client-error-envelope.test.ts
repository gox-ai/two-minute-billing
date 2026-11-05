import { describe, it, expect, afterAll } from "vitest";
import net from "node:net";
import Fastify from "fastify";
import { clientErrorHandler } from "@/platform/client-error";

const app = Fastify({ logger: false, clientErrorHandler });
app.get("/health", async () => ({ ok: true }));
afterAll(() => app.close());

/** Send raw bytes and return the full response text. */
async function raw(request: string): Promise<string> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as net.AddressInfo;
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(request));
    let out = "";
    s.on("data", (d) => (out += d.toString()));
    s.on("close", () => resolve(out));
    s.on("error", reject);
  });
}

describe("parser-level errors use the API error envelope", () => {
  it("an unknown HTTP method gets {error:{type,message}}, not the framework body", async () => {
    const res = await raw("FOOBAR /health HTTP/1.1\r\nHost: x\r\n\r\n");
    expect(res.startsWith("HTTP/1.1 400 ")).toBe(true);
    const body = JSON.parse(res.slice(res.indexOf("\r\n\r\n") + 4));
    expect(body).toEqual({
      error: { type: "invalid_request_error", message: expect.any(String) },
    });
    expect(res).not.toContain("Client Error");
    expect(res).not.toContain("statusCode");
  });
});

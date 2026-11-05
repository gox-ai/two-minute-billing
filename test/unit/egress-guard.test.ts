/**
 * The private-target guard for operator-typed URLs (src/platform/egress.ts).
 * A range missing here is a way for a tenant to make our worker call our own network.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "@/platform/config";
import {
  checkPublicUrl,
  describeEgressError,
  EgressRefusedError,
  guardedFetch,
  isPrivateAddress,
} from "@/platform/egress";

const guard = config as { WEBHOOK_ALLOW_PRIVATE_TARGETS: boolean };

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.0.9",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "0.1.2.3",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "fd00::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "64:ff9b::a9fe:a9fe", // NAT64 of 169.254.169.254
    "2002:a00:1::", // 6to4 of 10.0.0.1
    "[::1]",
    "fe80::1%eth0",
    "localhost",
    "not-an-ip",
  ])("refuses %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",
    "100.128.0.1",
    "2606:4700::1111",
    "64:ff9b::808:808",
  ])("allows %s", (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe("checkPublicUrl", () => {
  it("refuses literal private hosts and localhost names", async () => {
    guard.WEBHOOK_ALLOW_PRIVATE_TARGETS = false;
    for (const url of [
      "http://127.0.0.1:4000/x",
      "http://169.254.169.254/latest/meta-data/",
      "http://2130706433/",
      "http://[::1]/",
      "http://localhost/",
      "http://api.localhost./",
    ]) {
      expect(await checkPublicUrl(url), url).toMatch(/private or reserved/);
    }
  });

  it("passes a public literal", async () => {
    guard.WEBHOOK_ALLOW_PRIVATE_TARGETS = false;
    expect(await checkPublicUrl("https://1.1.1.1/hook")).toBeNull();
  });

  it("allows everything when the opt-out is set", async () => {
    guard.WEBHOOK_ALLOW_PRIVATE_TARGETS = true;
    expect(await checkPublicUrl("http://127.0.0.1/")).toBeNull();
    guard.WEBHOOK_ALLOW_PRIVATE_TARGETS = false;
  });
});

describe("guardedFetch", () => {
  let server: Server;
  let base = "";
  const hits: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/redirect") res.writeHead(302, { Location: "/landing" }).end();
      else res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => {
    guard.WEBHOOK_ALLOW_PRIVATE_TARGETS = false;
    server.close();
  });

  it("refuses a private target without connecting", async () => {
    guard.WEBHOOK_ALLOW_PRIVATE_TARGETS = false;
    await expect(
      guardedFetch(`${base}/private`, { method: "POST", body: "{}" }),
    ).rejects.toBeInstanceOf(EgressRefusedError);
    expect(hits).not.toContain("/private");
  });

  it("returns a 3xx instead of following it", async () => {
    guard.WEBHOOK_ALLOW_PRIVATE_TARGETS = true;
    const res = await guardedFetch(`${base}/redirect`, { method: "POST", body: "{}" });
    expect(res.status).toBe(302);
    expect(hits).not.toContain("/landing");
  });

  it("reads a normal response", async () => {
    guard.WEBHOOK_ALLOW_PRIVATE_TARGETS = true;
    const res = await guardedFetch(`${base}/ok`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("describeEgressError", () => {
  it("never carries the raw address", () => {
    const e = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:6379"), {
      code: "ECONNREFUSED",
    });
    expect(describeEgressError(e)).toBe("The endpoint host refused the connection");
    expect(describeEgressError(new Error("getaddrinfo ENOTFOUND db.internal"))).toBe(
      "We could not connect to the endpoint",
    );
  });
});

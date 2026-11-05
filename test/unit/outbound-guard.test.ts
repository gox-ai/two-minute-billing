import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Pinned off whatever the local .env says: these tests are about the default.
const flag = vi.hoisted(() => ({ value: "FALSE" as "TRUE" | "FALSE" }));
vi.mock("@/platform/config", async (importActual) => {
  const actual = await importActual<typeof import("@/platform/config")>();
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get: (t, k) => (k === "ALLOW_PRIVATE_OUTBOUND_URLS" ? flag.value : t[k as keyof typeof t]),
    }),
  };
});

const { assertPublicUrl, isBlockedAddress, outboundFetch, OutboundTargetError } =
  await import("@/platform/outbound");

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "169.254.169.254",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "[::1]",
    "::",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a9fe:a9fe",
    "fe80::1%eth0",
    "fd00::1",
    "localhost",
  ])("blocks %s", (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("allows %s", (ip) =>
    expect(isBlockedAddress(ip)).toBe(false),
  );
});

describe("assertPublicUrl", () => {
  it.each([
    "http://127.0.0.1:4000/healthz",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://2130706433/", // URL parsing normalises this to 127.0.0.1
    "http://localhost/",
  ])("refuses %s", async (url) => {
    await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(OutboundTargetError);
  });

  it("passes a public literal", async () => {
    await expect(assertPublicUrl("https://1.1.1.1/hook")).resolves.toBeUndefined();
  });
});

describe("outboundFetch", () => {
  let server: Server;
  let hits = 0;
  let port = 0;
  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.end("internal secret");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("refuses a loopback literal without sending the request", async () => {
    await expect(
      outboundFetch(`http://127.0.0.1:${port}/`, { method: "POST" }),
    ).rejects.toBeInstanceOf(OutboundTargetError);
    expect(hits).toBe(0);
  });

  it("refuses a name that resolves to loopback", async () => {
    await expect(outboundFetch(`http://localhost:${port}/`)).rejects.toBeInstanceOf(
      OutboundTargetError,
    );
    expect(hits).toBe(0);
  });

  it("reaches it when ALLOW_PRIVATE_OUTBOUND_URLS=TRUE", async () => {
    flag.value = "TRUE";
    try {
      const res = await outboundFetch(`http://localhost:${port}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("internal secret");
      expect(hits).toBe(1);
    } finally {
      flag.value = "FALSE";
    }
  });
});

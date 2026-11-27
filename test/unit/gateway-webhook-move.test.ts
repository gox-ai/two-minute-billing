/**
 * Gateway webhooks move to `GATEWAY_WEBHOOK_BASE_URL` without breaking the URL an account is
 * registered under. Regresses if: a stored registration reads as another URL (removal and
 * Square's signature check miss it), or a move creates a second registration instead of
 * changing the URL of the existing one (every event then arrives twice).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "@/platform/config";
import {
  accountNotificationUrl,
  accountNotificationUrlCandidates,
  gatewayNotificationUrl,
} from "@/providers/notification-url";
import { RazorpayProvider } from "@/providers/razorpay";
import { PayPalProvider } from "@/providers/paypal";
import { StripeProvider } from "@/providers/stripe";
import { SquareProvider } from "@/providers/square";

const OLD = "https://old.example.com/prefix";
const NEW = "https://webhooks.example.com";
const ROW = { gatewayKey: "razorpay", publicId: "gwa_XXXXXXXXXXXX01" };
const OLD_URL = `${OLD}/v1/gateway_webhooks/razorpay?id=gwa_XXXXXXXXXXXX01`;
const NEW_URL = `${NEW}/v1/gateway_webhooks/razorpay?id=gwa_XXXXXXXXXXXX01`;

const saved = { base: config.ADVERTISED_API_URL, gateway: config.GATEWAY_WEBHOOK_BASE_URL };
beforeEach(() => {
  config.ADVERTISED_API_URL = OLD;
  config.GATEWAY_WEBHOOK_BASE_URL = NEW;
});
afterEach(() => {
  config.ADVERTISED_API_URL = saved.base;
  config.GATEWAY_WEBHOOK_BASE_URL = saved.gateway;
});

describe("account notification URL", () => {
  it("new registrations use the gateway webhook base", () => {
    expect(gatewayNotificationUrl(ROW.gatewayKey, ROW.publicId)).toBe(NEW_URL);
  });

  it("an account keeps the URL it is registered under", () => {
    expect(accountNotificationUrl(ROW, { webhook_endpoint_id: "wh_1", webhook_url: OLD_URL })).toBe(
      OLD_URL,
    );
  });

  it("a stored URL wins; an unregistered account gets the new URL", () => {
    expect(accountNotificationUrl(ROW, { webhook_endpoint_id: "wh_1", webhook_url: NEW_URL })).toBe(
      NEW_URL,
    );
    expect(accountNotificationUrl(ROW, { webhook_secret: "s" })).toBe(NEW_URL);
  });

  it("unset gateway base = the public API URL", () => {
    config.GATEWAY_WEBHOOK_BASE_URL = undefined;
    expect(accountNotificationUrl(ROW, {})).toBe(OLD_URL);
  });

  it("signature candidates: the registered URL first, then the current base, no duplicates", () => {
    const creds = { webhook_endpoint_id: "wh_1", webhook_url: OLD_URL };
    expect(accountNotificationUrlCandidates(ROW, creds)).toEqual([OLD_URL, NEW_URL]);
    expect(accountNotificationUrlCandidates(ROW, { webhook_url: NEW_URL })).toEqual([NEW_URL]);
  });
});

type Call = { method: string; path: string; body?: unknown };

describe("move in place", () => {
  it("razorpay rewrites the URL of the registration at the old address", async () => {
    const calls: Call[] = [];
    const p = new RazorpayProvider({
      keyId: "rzp_test_x",
      keySecret: "x",
      apiBase: "https://api.invalid",
    });
    (p as unknown as { api: unknown }).api = async (
      _op: string,
      method: string,
      path: string,
      body?: unknown,
    ) => {
      calls.push({ method, path, body });
      if (method === "GET")
        return { status: 200, json: { items: [{ id: "wh_old", url: OLD_URL }] } };
      return { status: 200, json: { id: "wh_old" } };
    };
    const r = await p.provisionWebhookEndpoint({ url: NEW_URL, secret: "s", previousUrl: OLD_URL });
    expect(r).toMatchObject({ providerEndpointId: "wh_old", movedFromPreviousUrl: true });
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(calls.at(-1)).toMatchObject({ method: "PUT", path: "/webhooks/wh_old" });
    expect((calls.at(-1)!.body as { url: string }).url).toBe(NEW_URL);
  });

  it("razorpay with a registration already at the new URL leaves the old one to the caller", async () => {
    const p = new RazorpayProvider({
      keyId: "rzp_test_x",
      keySecret: "x",
      apiBase: "https://api.invalid",
    });
    (p as unknown as { api: unknown }).api = async (_op: string, method: string) =>
      method === "GET"
        ? {
            status: 200,
            json: {
              items: [
                { id: "wh_old", url: OLD_URL },
                { id: "wh_new", url: NEW_URL },
              ],
            },
          }
        : { status: 200, json: { id: "wh_new" } };
    const r = await p.provisionWebhookEndpoint({ url: NEW_URL, secret: "s", previousUrl: OLD_URL });
    expect(r.providerEndpointId).toBe("wh_new");
    expect(r.movedFromPreviousUrl).toBeUndefined();
  });

  it("paypal patches the URL and keeps the webhook id", async () => {
    const calls: Call[] = [];
    const p = new PayPalProvider({
      clientId: "cid",
      clientSecret: "csec",
      apiBase: "https://api.sandbox.paypal.test",
    });
    (p as unknown as { api: unknown }).api = async (
      _op: string,
      method: string,
      path: string,
      body?: unknown,
    ) => {
      calls.push({ method, path, body });
      if (method === "GET")
        return { status: 200, json: { webhooks: [{ id: "WH-OLD", url: OLD_URL }] } };
      return { status: 200, json: { id: "WH-OLD" } };
    };
    const r = await p.provisionWebhookEndpoint({ url: NEW_URL, previousUrl: OLD_URL });
    expect(r).toEqual({
      webhookId: "WH-OLD",
      providerEndpointId: "WH-OLD",
      movedFromPreviousUrl: true,
    });
    expect(calls.at(-1)).toEqual({
      method: "PATCH",
      path: "/v1/notifications/webhooks/WH-OLD",
      body: [{ op: "replace", path: "/url", value: NEW_URL }],
    });
  });

  it("stripe updates the endpoint URL and mints no new secret", async () => {
    const p = new StripeProvider("sk_test_x", "whsec_x", "pk_test_x");
    const update = vi.fn(async (id: string) => ({ id }));
    const create = vi.fn();
    (p as unknown as { stripe: unknown }).stripe = {
      webhookEndpoints: {
        list: async () => ({ data: [{ id: "we_old", url: OLD_URL }] }),
        update,
        create,
        del: vi.fn(),
      },
    };
    const r = await p.provisionWebhookEndpoint({ url: NEW_URL, previousUrl: OLD_URL });
    expect(r).toEqual({ providerEndpointId: "we_old", movedFromPreviousUrl: true });
    expect(update).toHaveBeenCalledWith("we_old", { url: NEW_URL });
    expect(create).not.toHaveBeenCalled();
  });

  it("square updates the subscription URL and keeps its signature key", async () => {
    const p = new SquareProvider({
      accessToken: "x",
      applicationId: "sandbox-sq0idb-x",
      locationId: "LXXXXXXX",
      livemode: false,
    });
    const calls: Call[] = [];
    Object.assign(p as unknown as Record<string, unknown>, {
      listWebhookSubscriptions: async () => [{ id: "sub_old", notification_url: OLD_URL }],
      request: async (_op: string, method: string, path: string, body?: unknown) => {
        calls.push({ method, path, body });
        return method === "GET" ? { subscription: { signature_key: "key_same" } } : {};
      },
    });
    const r = await p.provisionWebhookEndpoint({ url: NEW_URL, previousUrl: OLD_URL });
    expect(r).toEqual({
      webhookSecret: "key_same",
      providerEndpointId: "sub_old",
      movedFromPreviousUrl: true,
    });
    expect(calls[0]).toMatchObject({ method: "PUT", path: "/v2/webhooks/subscriptions/sub_old" });
    expect(
      (calls[0]!.body as { subscription: { notification_url: string } }).subscription
        .notification_url,
    ).toBe(NEW_URL);
  });
});

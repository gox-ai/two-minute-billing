import { describe, it, expect } from "vitest";
import { GATEWAYS, serializeDashboardLinks } from "@/providers/gateway-catalog";
// Relative, not `@/…`: this lives in the dashboard app and the root `@/` alias points
// at src/ (same reasoning as `storefront-return-params.test.ts`).
import {
  gatewayObjectUrl,
  type GatewayCatalogEntry,
} from "../../dashboard/components/gateways/gateway-meta";

// The catalogue as the API serves it, only the fields the helper reads.
const catalog = Object.values(GATEWAYS).map(
  (g) =>
    ({
      key: g.key,
      dashboard_links: serializeDashboardLinks(g.dashboardLinks),
    }) as GatewayCatalogEntry,
);
const url = (key: string | null, id: string | null, mode: "live" | "test" | null = "test") =>
  gatewayObjectUrl(catalog, key, id, mode);

describe("gatewayObjectUrl", () => {
  it("puts Stripe's mode in the path, so a test charge never opens a live URL", () => {
    expect(url("stripe", "pi_1XXXXXXXXXXXXXXXXXXXXXXX", "live")).toBe(
      "https://dashboard.stripe.com/payments/pi_1XXXXXXXXXXXXXXXXXXXXXXX",
    );
    expect(url("stripe", "pi_1XXXXXXXXXXXXXXXXXXXXXXX", "test")).toBe(
      "https://dashboard.stripe.com/test/payments/pi_1XXXXXXXXXXXXXXXXXXXXXXX",
    );
  });

  it("routes a Stripe charge to the same page as an intent", () => {
    expect(url("stripe", "ch_3XXXXXXXXXXXXX01")).toBe(
      "https://dashboard.stripe.com/test/payments/ch_3XXXXXXXXXXXXX01",
    );
  });

  it("links a Stripe setup intent, per mode", () => {
    expect(url("stripe", "seti_XXXXXXXXXXXX01", "live")).toBe(
      "https://dashboard.stripe.com/setup_intents/seti_XXXXXXXXXXXX01",
    );
    expect(url("stripe", "seti_XXXXXXXXXXXX01", "test")).toBe(
      "https://dashboard.stripe.com/test/setup_intents/seti_XXXXXXXXXXXX01",
    );
  });

  it("links Razorpay payments, which carry no mode segment", () => {
    expect(url("razorpay", "pay_XXXXXXXXXXXXXX", "live")).toBe(
      "https://dashboard.razorpay.com/app/payments/pay_XXXXXXXXXXXXXX",
    );
    expect(url("razorpay", "pay_XXXXXXXXXXXXXX", "test")).toBe(
      "https://dashboard.razorpay.com/app/payments/pay_XXXXXXXXXXXXXX",
    );
  });

  it("links a PayPal CAPTURE id, per host, and never an order id", () => {
    // 17 chars = a transaction/capture id; 19 = an order id, which opens nothing.
    expect(url("paypal", "1XX00000000000001", "live")).toBe(
      "https://www.paypal.com/activity/payment/1XX00000000000001",
    );
    expect(url("paypal", "1XX00000000000001", "test")).toBe(
      "https://www.sandbox.paypal.com/activity/payment/1XX00000000000001",
    );
    expect(url("paypal", "5XX00000000000000XY", "live")).toBeNull();
  });

  it("links GoCardless payments and mandates, per host", () => {
    expect(url("gocardless", "PM00000000AA01", "live")).toBe(
      "https://manage.gocardless.com/payments/PM00000000AA01",
    );
    expect(url("gocardless", "PM00000000AA01", "test")).toBe(
      "https://manage-sandbox.gocardless.com/payments/PM00000000AA01",
    );
    expect(url("gocardless", "MD00000000AA01", "live")).toBe(
      "https://manage.gocardless.com/mandates/MD00000000AA01",
    );
    expect(url("gocardless", "MD00000000AA01", "test")).toBe(
      "https://manage-sandbox.gocardless.com/mandates/MD00000000AA01",
    );
  });

  it("links an Adyen pspReference, per Customer Area host", () => {
    expect(url("adyen", "XXXXXXXXXXXXXX01", "live")).toBe(
      "https://ca-live.adyen.com/ca/ca/accounts/showTx.shtml?pspReference=XXXXXXXXXXXXXX01",
    );
    expect(url("adyen", "7900000000000001", "test")).toBe(
      "https://ca-test.adyen.com/ca/ca/accounts/showTx.shtml?pspReference=7900000000000001",
    );
  });

  it("links a Square payment, per host, and never a refund", () => {
    expect(url("square", "PXXXXXXXXXXXXXXXXXXXXXXXXX01", "live")).toBe(
      "https://squareup.com/dashboard/sales/transactions/PXXXXXXXXXXXXXXXXXXXXXXXXX01",
    );
    expect(url("square", "PXXXXXXXXXXXXXXXXXXXXXXXXX01", "test")).toBe(
      "https://squareupsandbox.com/dashboard/sales/transactions/PXXXXXXXXXXXXXXXXXXXXXXXXX01",
    );
    expect(url("square", "PXXXXXXXXXXXXXXXXXXXXXXXXX01_RXXXXXXXXXX01")).toBeNull();
  });

  it("assumes test mode when the business mode is unknown", () => {
    expect(url("stripe", "pi_XXXXXXXXXXXX01", null)).toBe(
      "https://dashboard.stripe.com/test/payments/pi_XXXXXXXXXXXX01",
    );
  });

  it("returns null where no page is declared, rather than a link to a 404", () => {
    // Stripe reaches a refund through its payment's timeline; there is no refund page.
    expect(url("stripe", "re_3XXXXXXXXXXXXX01")).toBeNull();
    expect(url("stripe", "cus_XXXXXXXXXXXX01")).toBeNull();
    expect(url("razorpay", "rfnd_XXXXXXXXXXXX01")).toBeNull();
    expect(url("razorpay", "order_XXXXXXXXXXXX01")).toBeNull();
    expect(url("tmtest", "tmch_XXXXXXXXXXXX01")).toBeNull();
    // Our own wrapped intent ids never reach a gateway page.
    expect(url("adyen", "adyses_XXXXXXXXXXXX01")).toBeNull();
    expect(url("adyen", "adypl_XXXXXXXXXXXX01")).toBeNull();
    expect(url("square", "sqh_OXXXXXXXXXXXXXXXXXXXXXXX01")).toBeNull();
    expect(url("gocardless", "RF00000000AA01")).toBeNull();
    expect(url("gocardless", "BRQ0000000XS01")).toBeNull();
    // No official per-object link, or a URL that needs an account id we do not template.
    expect(url("braintree", "bbxf4arp")).toBeNull();
    expect(url("mollie", "tr_XXXXXXXXXX01")).toBeNull();
    expect(url("checkoutcom", "pay_xxxxxxxxxxxxxxxxxxxxxxxx01")).toBeNull();
    expect(url("authorizenet", "120000000001")).toBeNull();
    expect(url("cybersource", "7900000000000000000002")).toBeNull();
    expect(url("cashfree", "ord:tmo_XXXXXXXXXXXXXXXXXXXXXX01:5000000001")).toBeNull();
    expect(url("payu", "tmpyXXXXXXXXXXXXXXXXXXX01")).toBeNull();
    expect(url("offline_check", "CHQ-0001")).toBeNull();
    expect(url(null, "pi_XXXXXXXXXXXX01")).toBeNull();
    expect(url("stripe", null)).toBeNull();
    expect(url("stripe", "   ")).toBeNull();
    // A prefix alone is not a match: the whole id must fit the shape.
    expect(url("stripe", "pi_XXXX/../../x")).toBeNull();
  });

  it("returns null with no catalogue, or an older API without declarations", () => {
    expect(gatewayObjectUrl(null, "stripe", "pi_XXXXXXXXXXXX01", "live")).toBeNull();
    expect(
      gatewayObjectUrl(
        [{ key: "stripe" } as GatewayCatalogEntry],
        "stripe",
        "pi_XXXXXXXXXXXX01",
        "live",
      ),
    ).toBeNull();
  });
});

describe("gateway dashboard-link declarations", () => {
  const all = Object.values(GATEWAYS);

  it("every gateway declares its links, even when it has none", () => {
    for (const g of all) expect(Array.isArray(g.dashboardLinks), g.key).toBe(true);
  });

  it("a simulated gateway has no dashboard to link to", () => {
    for (const g of all.filter((x) => x.simulated)) expect(g.dashboardLinks, g.key).toEqual([]);
  });

  it.each(all.flatMap((g) => g.dashboardLinks.map((l) => [g.key, l] as const)))(
    "%s %o is anchored, https, and places the id once per mode",
    (_key, l) => {
      expect(() => new RegExp(l.idPattern)).not.toThrow();
      expect(l.idPattern.startsWith("^") && l.idPattern.endsWith("$")).toBe(true);
      for (const u of [l.url.live, l.url.test]) {
        expect(u.startsWith("https://")).toBe(true);
        expect(u.split("{id}").length).toBe(2);
      }
      expect(l.confirmedBy === false || l.confirmedBy.length > 0).toBe(true);
    },
  );

  it("names exactly the shapes still waiting on a live URL", () => {
    const unconfirmed = all.flatMap((g) =>
      g.dashboardLinks.filter((l) => l.confirmedBy === false).map((l) => `${g.key}:${l.object}`),
    );
    expect(unconfirmed.sort()).toEqual(["paypal:payment", "square:payment"]);
  });

  it("no two links of one gateway match the same id", () => {
    const samples: Record<string, string[]> = {
      stripe: ["pi_XXXXXXXXXXXX01", "ch_XXXXXXXXXXXX01", "seti_XXXXXXXXXXXX01"],
      razorpay: ["pay_XXXXXXXXXXXX01"],
      paypal: ["1XX00000000000001"],
      gocardless: ["PM00000000AA01", "MD00000000AA01"],
      adyen: ["XXXXXXXXXXXXXX01", "7900000000000001"],
      square: ["PXXXXXXXXXXXXXXXXXXXXXXXXX01"],
    };
    for (const [key, ids] of Object.entries(samples))
      for (const id of ids)
        expect(
          GATEWAYS[key as keyof typeof GATEWAYS].dashboardLinks.filter((l) =>
            new RegExp(l.idPattern).test(id),
          ).length,
          `${key} ${id}`,
        ).toBe(1);
  });

  it("the catalogue serves each declaration with its confirmation flag", () => {
    const stripe = serializeDashboardLinks(GATEWAYS.stripe.dashboardLinks);
    expect(stripe.find((l) => l.object === "setup")?.confirmed).toBe(true);
    expect(stripe.find((l) => l.object === "payment")?.confirmed).toBe(true);
    const paypal = serializeDashboardLinks(GATEWAYS.paypal.dashboardLinks);
    expect(paypal.find((l) => l.object === "payment")?.confirmed).toBe(false);
    const square = serializeDashboardLinks(GATEWAYS.square.dashboardLinks);
    expect(square.find((l) => l.object === "payment")?.confirmed).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import {
  resolveStorefrontConfig,
  resolveCheckoutRedirect,
  DEFAULT_STOREFRONT_CONFIG,
  type StorefrontConfig,
} from "@/modules/checkout/storefront-config";

describe("resolveStorefrontConfig — defaults (0243)", () => {
  it("null/undefined/absent business resolves to DEFAULT_STOREFRONT_CONFIG", () => {
    expect(resolveStorefrontConfig(null)).toEqual(DEFAULT_STOREFRONT_CONFIG);
    expect(resolveStorefrontConfig(undefined)).toEqual(DEFAULT_STOREFRONT_CONFIG);
    expect(resolveStorefrontConfig({})).toEqual(DEFAULT_STOREFRONT_CONFIG);
  });

  it("an explicit null storefrontConfig resolves to the default, not a throw", () => {
    expect(resolveStorefrontConfig({ storefrontConfig: null })).toEqual(DEFAULT_STOREFRONT_CONFIG);
  });

  it("every default is today's behaviour: shown lines, no PO prompt, no fallback URLs", () => {
    expect(DEFAULT_STOREFRONT_CONFIG).toEqual({
      // The three portal permissions default TRUE: each gates a route that is open to
      // every buyer today, so `false` would silently withdraw a working feature.
      allowInvoiceDownload: true,
      allowInvoicePayment: true,
      allowRemovePaymentMethod: true,
      // Cancellation defaults the OTHER way — the route is new, so granting it is the
      // change. Same rule, opposite answer: the default leaves a business as it was.
      allowCancelSubscription: false,
      cancelTiming: "end_of_term",
      allowPauseResume: false,
      allowReactivate: false,
      allowSkipRenewal: false,
      skipRenewalLimit: 3,
      hideZeroValueLines: false,
      collectPoNumber: false,
      defaultReturnUrl: null,
      defaultCancelUrl: null,
      // No custom copy: the portal shows its built-in "link can't be used" message.
      portalLinkErrorHtml: null,
      oneTimeSavePaymentMethod: "ask",
      // Usage on (it is what the buyer is billed for), the projection off (it reads as a promise).
      portalShowUsage: true,
      portalShowUsageProjection: false,
      // Checkout (Phase 1): today's steps layout, no consent boxes, no bot check.
      checkoutLayout: "steps",
      walletsFirst: false,
      recurringConsent: false,
      requireTerms: false,
      termsUrl: null,
      privacyUrl: null,
      marketingConsent: false,
      botCheckAfterFailures: null,
      // Portal plan changes (Phase 2): off; the timing follows the business rule.
      allowPlanChanges: false,
      seatChanges: "off",
      seatMin: null,
      seatMax: null,
      allowAddonChanges: false,
      shorterPeriod: "always",
      chargeUpgrade: "business_default",
      changeStatuses: ["active", "in_trial"],
      allowCancelScheduledChange: true,
      // Cancel flow (Phase 3): today's optional reason, no offers. Offer-once only matters
      // once an offer is on.
      cancelReason: "optional",
      retentionPause: false,
      retentionPauseMonths: 3,
      retentionPauseChoice: false,
      retentionDowngradePrice: null,
      retentionCoupon: null,
      retentionContactUrl: null,
      retentionOfferOnce: true,
      // Portal access (Phase 4): links only, built-in lifetimes, every record listed.
      portalEmailCode: false,
      portalLinkHours: null,
      portalEmailLinkDays: null,
      portalSessionHours: null,
      portalHideCancelledSubscriptions: false,
      portalHideZeroInvoices: false,
      portalHideVoidedInvoices: false,
      // Single-action links (Phase 4b): every task on, back link from default_return_url.
      portalActions: { payInvoice: true, updateCard: true, changePlan: true, cancel: true },
      portalReturnUrl: null,
    });
  });

  it("a malformed jsonb blob (wrong types) resolves every field to its default, never a throw", () => {
    const resolved = resolveStorefrontConfig({
      storefrontConfig: {
        hide_zero_value_lines: "yes", // not a boolean
        collect_po_number: 1, // not a boolean
        default_return_url: 42, // not a string
        default_cancel_url: {}, // not a string
      },
    });
    expect(resolved).toEqual(DEFAULT_STOREFRONT_CONFIG);
  });

  it("truthiness must not opt a flag in — only a literal boolean true does", () => {
    // A non-empty string is truthy in JS but is not `true`; the house rule is
    // typeof === 'boolean', never truthiness.
    const resolved = resolveStorefrontConfig({
      storefrontConfig: { hide_zero_value_lines: "true", collect_po_number: "on" },
    });
    expect(resolved.hideZeroValueLines).toBe(false);
    expect(resolved.collectPoNumber).toBe(false);
  });
});

describe("resolveStorefrontConfig — explicit valid values opt out", () => {
  it("hide_zero_value_lines: true and collect_po_number: true flip the switches", () => {
    const resolved = resolveStorefrontConfig({
      storefrontConfig: { hide_zero_value_lines: true, collect_po_number: true },
    });
    expect(resolved.hideZeroValueLines).toBe(true);
    expect(resolved.collectPoNumber).toBe(true);
  });

  it("explicit false stays false, distinct from absent", () => {
    const resolved = resolveStorefrontConfig({
      storefrontConfig: { hide_zero_value_lines: false, collect_po_number: false },
    });
    expect(resolved.hideZeroValueLines).toBe(false);
    expect(resolved.collectPoNumber).toBe(false);
  });

  it("a valid https URL is kept for both default_return_url and default_cancel_url", () => {
    const resolved = resolveStorefrontConfig({
      storefrontConfig: {
        default_return_url: "https://acme.example/return",
        default_cancel_url: "https://acme.example/cancel",
      },
    });
    expect(resolved.defaultReturnUrl).toBe("https://acme.example/return");
    expect(resolved.defaultCancelUrl).toBe("https://acme.example/cancel");
  });

  it("a valid plain http URL is kept too", () => {
    const resolved = resolveStorefrontConfig({
      storefrontConfig: { default_return_url: "http://localhost:3000/return" },
    });
    expect(resolved.defaultReturnUrl).toBe("http://localhost:3000/return");
  });
});

describe("resolveStorefrontConfig — URL sanitisation never yields a broken redirect", () => {
  it("a non-string URL resolves to null", () => {
    expect(
      resolveStorefrontConfig({ storefrontConfig: { default_return_url: 12345 } }).defaultReturnUrl,
    ).toBeNull();
    expect(
      resolveStorefrontConfig({ storefrontConfig: { default_return_url: {} } }).defaultReturnUrl,
    ).toBeNull();
    expect(
      resolveStorefrontConfig({ storefrontConfig: { default_return_url: [] } }).defaultReturnUrl,
    ).toBeNull();
  });

  it("an unparseable string resolves to null", () => {
    expect(
      resolveStorefrontConfig({ storefrontConfig: { default_return_url: "not a url at all" } })
        .defaultReturnUrl,
    ).toBeNull();
    expect(
      resolveStorefrontConfig({ storefrontConfig: { default_return_url: "" } }).defaultReturnUrl,
    ).toBeNull();
    expect(
      resolveStorefrontConfig({ storefrontConfig: { default_return_url: "   " } }).defaultReturnUrl,
    ).toBeNull();
  });

  it("a non-http(s) scheme resolves to null — never a script-executing redirect", () => {
    expect(
      resolveStorefrontConfig({
        storefrontConfig: { default_return_url: "javascript:alert(1)" },
      }).defaultReturnUrl,
    ).toBeNull();
    expect(
      resolveStorefrontConfig({
        storefrontConfig: { default_cancel_url: "data:text/html,<script>1</script>" },
      }).defaultCancelUrl,
    ).toBeNull();
    expect(
      resolveStorefrontConfig({ storefrontConfig: { default_return_url: "ftp://acme.example/x" } })
        .defaultReturnUrl,
    ).toBeNull();
  });

  it("an over-long URL resolves to null rather than being silently truncated", () => {
    const huge = "https://acme.example/" + "a".repeat(3000);
    expect(
      resolveStorefrontConfig({ storefrontConfig: { default_return_url: huge } }).defaultReturnUrl,
    ).toBeNull();
  });
});

describe("resolveCheckoutRedirect — the mint's fallback and its refusal", () => {
  const noDefaults: StorefrontConfig = DEFAULT_STOREFRONT_CONFIG;
  const withDefaults: StorefrontConfig = {
    ...DEFAULT_STOREFRONT_CONFIG,
    defaultReturnUrl: "https://biz.example/return",
    defaultCancelUrl: "https://biz.example/cancel",
  };

  it("an explicit call-level value always wins over the configured default", () => {
    const resolved = resolveCheckoutRedirect(withDefaults, {
      returnUrl: "https://buyer.example/return",
      cancelUrl: "https://buyer.example/cancel",
    });
    expect(resolved).toEqual({
      returnUrl: "https://buyer.example/return",
      cancelUrl: "https://buyer.example/cancel",
    });
  });

  it("falls back to the business default when the call sends neither", () => {
    const resolved = resolveCheckoutRedirect(withDefaults, {});
    expect(resolved).toEqual({
      returnUrl: "https://biz.example/return",
      cancelUrl: "https://biz.example/cancel",
    });
  });

  it("mixes a call-level value for one leg with the default for the other", () => {
    const resolved = resolveCheckoutRedirect(withDefaults, {
      returnUrl: "https://buyer.example/return",
    });
    expect(resolved).toEqual({
      returnUrl: "https://buyer.example/return",
      cancelUrl: "https://biz.example/cancel",
    });
  });

  /**
   * The whole safety property: a call with NEITHER an argument NOR a configured default
   * must be refused, not silently minted with no redirect at all. The route turns this
   * `null` into a 400 — see `POST /checkout/v1/setup` in checkout-routes.ts.
   */
  it("no return_url/cancel_url anywhere (no argument, no configured default) → null", () => {
    expect(resolveCheckoutRedirect(noDefaults, {})).toBeNull();
    expect(
      resolveCheckoutRedirect(noDefaults, { returnUrl: undefined, cancelUrl: undefined }),
    ).toBeNull();
  });

  it("one leg missing everywhere still refuses, even if the other leg is fully covered", () => {
    // Explicit return_url + a configured cancel default, but no cancel argument and no
    // return default — return_url is covered, cancel_url is not, so the pair must refuse.
    const returnOnlyDefault: StorefrontConfig = {
      ...DEFAULT_STOREFRONT_CONFIG,
      defaultReturnUrl: "https://biz.example/return",
    };
    expect(resolveCheckoutRedirect(returnOnlyDefault, {})).toBeNull();

    const cancelOnlyDefault: StorefrontConfig = {
      ...DEFAULT_STOREFRONT_CONFIG,
      defaultCancelUrl: "https://biz.example/cancel",
    };
    expect(resolveCheckoutRedirect(cancelOnlyDefault, { returnUrl: undefined })).toBeNull();
  });

  it("an empty-string argument is NOT nullish, so it does not fall back — and is refused", () => {
    // `??` only substitutes on null/undefined; an empty string survives it and then trips
    // the final `!returnUrl` check. Unreachable through the API today (zod's `.url()`
    // already refuses an empty string), but the helper's own behaviour is worth pinning.
    expect(resolveCheckoutRedirect(withDefaults, { returnUrl: "", cancelUrl: "" })).toBeNull();
  });
});

describe("portal self-service permissions (2026-09-09)", () => {
  const cfg = (stored: unknown): StorefrontConfig =>
    resolveStorefrontConfig({ storefrontConfig: stored });

  it("all three default TRUE, because all three routes are open today", () => {
    const c = cfg(null);
    expect(c.allowInvoiceDownload).toBe(true);
    expect(c.allowInvoicePayment).toBe(true);
    expect(c.allowRemovePaymentMethod).toBe(true);
  });

  it("only an explicit false withdraws a permission", () => {
    expect(cfg({ allow_invoice_payment: false }).allowInvoicePayment).toBe(false);
    expect(cfg({ allow_invoice_download: false }).allowInvoiceDownload).toBe(false);
    expect(cfg({ allow_remove_payment_method: false }).allowRemovePaymentMethod).toBe(false);
  });

  it("a MALFORMED value leaves the buyer able to do what they can do today", () => {
    // The failure mode that matters: a hand-edited blob must never accidentally lock a
    // buyer out of paying their own invoice. `flag` checks the literal type, so every
    // one of these is ignored rather than read as falsey.
    for (const junk of [0, "", "false", "no", null, [], {}, undefined]) {
      expect(cfg({ allow_invoice_payment: junk }).allowInvoicePayment).toBe(true);
      expect(cfg({ allow_invoice_download: junk }).allowInvoiceDownload).toBe(true);
      expect(cfg({ allow_remove_payment_method: junk }).allowRemovePaymentMethod).toBe(true);
    }
  });

  it("an explicit true is honoured, so a merchant can pin the default", () => {
    expect(cfg({ allow_invoice_payment: true }).allowInvoicePayment).toBe(true);
  });

  it("the three are independent — turning one off leaves the others alone", () => {
    const c = cfg({ allow_invoice_payment: false });
    expect(c.allowInvoiceDownload).toBe(true);
    expect(c.allowRemovePaymentMethod).toBe(true);
    // ...and does not disturb the 0243 switches either.
    expect(c.hideZeroValueLines).toBe(false);
    expect(c.collectPoNumber).toBe(false);
  });
});

describe("buyer-initiated cancellation (2026-09-09)", () => {
  const cfg = (stored: unknown): StorefrontConfig =>
    resolveStorefrontConfig({ storefrontConfig: stored });

  it("is OFF by default, because granting it is the change", () => {
    expect(cfg(null).allowCancelSubscription).toBe(false);
  });

  it("defaults to end_of_term, the outcome neither party can object to", () => {
    // `immediately` decides whether the merchant keeps a term already paid for, so it has
    // to be chosen rather than inherited.
    expect(cfg(null).cancelTiming).toBe("end_of_term");
  });

  it("honours both explicit timings", () => {
    expect(cfg({ cancel_timing: "immediately" }).cancelTiming).toBe("immediately");
    expect(cfg({ cancel_timing: "end_of_term" }).cancelTiming).toBe("end_of_term");
  });

  it("never reads an unrecognised timing as `immediately`", () => {
    // The one that would cost a merchant a term's revenue on a typo, so it is checked
    // against the literals rather than coerced.
    for (const junk of ["right-now", "IMMEDIATELY", "now", "", 1, true, null, {}, []]) {
      expect(cfg({ cancel_timing: junk }).cancelTiming).toBe("end_of_term");
    }
  });

  it("a malformed allow flag leaves cancellation OFF", () => {
    for (const junk of ["true", 1, {}, [], null]) {
      expect(cfg({ allow_cancel_subscription: junk }).allowCancelSubscription).toBe(false);
    }
  });

  it("the timing is independent of the permission", () => {
    const c = cfg({ cancel_timing: "immediately" });
    expect(c.cancelTiming).toBe("immediately");
    // Timing set but cancellation not granted: the route still refuses.
    expect(c.allowCancelSubscription).toBe(false);
  });
});

describe("pause / resume / reactivate (2026-09-09)", () => {
  const cfg = (stored: unknown): StorefrontConfig =>
    resolveStorefrontConfig({ storefrontConfig: stored });

  it("both default OFF — every one of these is a new action", () => {
    expect(cfg(null).allowPauseResume).toBe(false);
    expect(cfg(null).allowReactivate).toBe(false);
  });

  it("pause and resume are ONE key, so a buyer can never be trapped paused", () => {
    // The reason this is not two flags: `allow_pause` without `allow_resume` would let a
    // merchant offer a state a buyer cannot leave. One key makes that unrepresentable.
    const c = cfg({ allow_pause_resume: true });
    expect(c.allowPauseResume).toBe(true);
    expect(Object.keys(c)).not.toContain("allowPause");
    expect(Object.keys(c)).not.toContain("allowResume");
  });

  it("a malformed value leaves each one OFF", () => {
    for (const junk of ["true", 1, {}, [], null, "yes"]) {
      expect(cfg({ allow_pause_resume: junk }).allowPauseResume).toBe(false);
      expect(cfg({ allow_reactivate: junk }).allowReactivate).toBe(false);
    }
  });

  it("each is independent of the others", () => {
    const c = cfg({ allow_pause_resume: true });
    expect(c.allowReactivate).toBe(false);
    expect(c.allowCancelSubscription).toBe(false);
    // ...and the three permissions that default ON are untouched.
    expect(c.allowInvoicePayment).toBe(true);
  });
});

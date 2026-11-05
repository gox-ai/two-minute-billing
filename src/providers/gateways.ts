/**
 * Adapter factories, one per gateway. The rest of each gateway's definition lives in
 * `./gateway-catalog.ts`, which must stay importable without an environment.
 */
import { config } from "@/platform/config";
import type { PaymentProvider, ProviderKey } from "./types";
import { StripeProvider } from "./stripe";
import { PayPalProvider } from "./paypal";
import { RazorpayProvider } from "./razorpay";
import { GoCardlessProvider } from "./gocardless";
import { BraintreeProvider } from "./braintree";
import { CashfreeProvider } from "./cashfree";
import { AdyenProvider } from "./adyen";
import { CheckoutcomProvider } from "./checkoutcom";
import { AuthorizenetProvider } from "./authorizenet";
import { SquareProvider } from "./square";
import { MollieProvider } from "./mollie";
import { PayuProvider } from "./payu";
import { CybersourceProvider } from "./cybersource";
import { TmtestProvider } from "./tmtest";
import { preDebitOptionsFromCredentials } from "./tmtest/pre-debit";

/** A gateway account's stored credentials could not build an adapter. */
export class GatewayResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayResolveError";
  }
}

export type GatewayCredentials = Record<string, string | undefined>;

export interface GatewayFactory {
  /**
   * Build an adapter from an account's decrypted credentials. Throws `GatewayResolveError`.
   * `livemode` is the account's (always equal to its business's): gateways whose keys do not
   * reveal their environment pick the sandbox or live host from it.
   */
  build(
    creds: GatewayCredentials,
    ctx: {
      businessId: string;
      livemode: boolean;
      /** This account's public webhook URL, when the deployment has one (Mollie sends it per payment). */
      notificationUrl?: string;
    },
  ): PaymentProvider;
  /** The env-configured adapter behind the legacy `getProvider` fallback, if configured. */
  fromEnv?(): PaymentProvider | undefined;
}

/** Pages that embed Microform: the storefront and the dashboard. */
const cybersourceOrigins = () =>
  [config.PORTAL_BASE_URL, config.DASHBOARD_BASE_URL].filter((u): u is string => Boolean(u));

// `decryptCredentials` casts the stored JSON, so a JSON `false` is a boolean at runtime.
const isCredFalse = (v: unknown): boolean =>
  v === false || v === "false" || v === "off" || v === "0";

export const GATEWAY_FACTORIES: Record<ProviderKey, GatewayFactory> = {
  tmtest: {
    build: (creds, ctx) =>
      new TmtestProvider(ctx.businessId, {
        magicAmounts: !isCredFalse(creds.magic_amounts),
        createIntentFault:
          creds.create_intent_fault === "reject" ||
          creds.create_intent_fault === "reject_stranding" ||
          creds.create_intent_fault === "indeterminate"
            ? creds.create_intent_fault
            : null,
        perDebitMandateReference: creds.per_debit_mandate_reference === "true",
        chargeFault: creds.charge_fault === "mandate_missing" ? "mandate_missing" : null,
        ensureCustomerFault:
          creds.ensure_customer_fault === "reject" ||
          creds.ensure_customer_fault === "indeterminate"
            ? creds.ensure_customer_fault
            : null,
        buyerAuthMode:
          creds.buyer_auth_mode === "sdk" || creds.buyer_auth_mode === "form_post"
            ? creds.buyer_auth_mode
            : null,
        preDebit: preDebitOptionsFromCredentials(creds),
        gatewayNotifiesPayer: String(creds.gateway_notifies_payer ?? "")
          .split(",")
          .map((m) => m.trim())
          .filter((m): m is "card" | "upi" => m === "card" || m === "upi"),
        setupFirstCharge: creds.setup_first_charge === "card",
        settlementReport:
          creds.settlement_report === "true"
            ? "on"
            : creds.settlement_report === "fault"
              ? "fault"
              : null,
      }),
  },
  stripe: {
    build: (creds) => {
      if (!creds.secret_key)
        throw new GatewayResolveError("stripe gateway account missing secret_key");
      return new StripeProvider(
        creds.secret_key,
        creds.webhook_secret,
        creds.publishable_key ?? config.STRIPE_TEST_PUBLISHABLE_KEY,
        // The new endpoint's secret while an endpoint is replaced; both verify.
        creds.webhook_secret_next,
      );
    },
    fromEnv: () =>
      config.STRIPE_TEST_SECRET_KEY
        ? new StripeProvider(
            config.STRIPE_TEST_SECRET_KEY,
            config.STRIPE_WEBHOOK_SECRET,
            config.STRIPE_TEST_PUBLISHABLE_KEY,
          )
        : undefined,
  },
  paypal: {
    build: (creds) => {
      if (!creds.client_id || !creds.client_secret)
        throw new GatewayResolveError("paypal gateway account missing client_id/client_secret");
      return new PayPalProvider({
        clientId: creds.client_id,
        clientSecret: creds.client_secret,
        apiBase: creds.api_base ?? config.PAYPAL_API_BASE,
        webhookId: creds.webhook_id,
      });
    },
    fromEnv: () =>
      config.PAYPAL_TEST_BUSINESS_US_CLIENT_ID && config.PAYPAL_TEST_BUSINESS_US_CLIENT_SECRET
        ? new PayPalProvider({
            clientId: config.PAYPAL_TEST_BUSINESS_US_CLIENT_ID,
            clientSecret: config.PAYPAL_TEST_BUSINESS_US_CLIENT_SECRET,
            apiBase: config.PAYPAL_API_BASE,
            webhookId: config.PAYPAL_WEBHOOK_ID,
          })
        : undefined,
  },
  razorpay: {
    build: (creds) => {
      if (!creds.key_id || !creds.key_secret)
        throw new GatewayResolveError("razorpay gateway account missing key_id/key_secret");
      return new RazorpayProvider({
        keyId: creds.key_id,
        keySecret: creds.key_secret,
        apiBase: creds.api_base ?? config.RAZORPAY_API_BASE,
        webhookSecret: creds.webhook_secret,
      });
    },
    fromEnv: () =>
      config.RAZORPAY_TEST_KEY_ID && config.RAZORPAY_TEST_KEY_SECRET
        ? new RazorpayProvider({
            keyId: config.RAZORPAY_TEST_KEY_ID,
            keySecret: config.RAZORPAY_TEST_KEY_SECRET,
            apiBase: config.RAZORPAY_API_BASE,
            webhookSecret: config.RAZORPAY_WEBHOOK_SECRET,
          })
        : undefined,
  },
  gocardless: {
    // The token does not reveal its environment, so the host follows the account's livemode.
    build: (creds, ctx) => {
      if (!creds.access_token)
        throw new GatewayResolveError("gocardless gateway account missing access_token");
      try {
        return new GoCardlessProvider({
          accessToken: creds.access_token,
          webhookSecret: creds.webhook_secret,
          livemode: ctx.livemode,
          ...(creds.api_base ? { apiBase: creds.api_base } : {}),
          ...(creds.payto_purpose_code ? { paytoPurposeCode: creds.payto_purpose_code } : {}),
        });
      } catch (e) {
        throw new GatewayResolveError((e as Error).message);
      }
    },
    fromEnv: () =>
      config.GOCARDLESS_TEST_ACCESS_TOKEN
        ? new GoCardlessProvider({
            accessToken: config.GOCARDLESS_TEST_ACCESS_TOKEN,
            webhookSecret: config.GOCARDLESS_WEBHOOK_SECRET,
            livemode: false,
          })
        : undefined,
  },
  braintree: {
    build: (creds, ctx) => {
      if (!creds.merchant_id || !creds.public_key || !creds.private_key)
        throw new GatewayResolveError(
          "braintree gateway account missing merchant_id/public_key/private_key",
        );
      try {
        return new BraintreeProvider({
          merchantId: creds.merchant_id,
          publicKey: creds.public_key,
          privateKey: creds.private_key,
          livemode: ctx.livemode,
          merchantAccounts: creds.merchant_accounts,
        });
      } catch (e) {
        throw new GatewayResolveError((e as Error).message);
      }
    },
    fromEnv: () =>
      config.BRAINTREE_TEST_MERCHANT_ID &&
      config.BRAINTREE_TEST_PUBLIC_KEY &&
      config.BRAINTREE_TEST_PRIVATE_KEY
        ? new BraintreeProvider({
            merchantId: config.BRAINTREE_TEST_MERCHANT_ID,
            publicKey: config.BRAINTREE_TEST_PUBLIC_KEY,
            privateKey: config.BRAINTREE_TEST_PRIVATE_KEY,
            livemode: false,
          })
        : undefined,
  },
  cashfree: {
    // App IDs carry no test/live prefix, so the account's mode picks the host.
    build: (creds, ctx) => {
      if (!creds.app_id || !creds.secret_key)
        throw new GatewayResolveError("cashfree gateway account missing app_id/secret_key");
      return new CashfreeProvider({
        appId: creds.app_id,
        secretKey: creds.secret_key,
        webhookSecret: creds.webhook_secret,
        livemode: ctx.livemode,
      });
    },
    fromEnv: () =>
      config.CASHFREE_TEST_APP_ID && config.CASHFREE_TEST_SECRET_KEY
        ? new CashfreeProvider({
            appId: config.CASHFREE_TEST_APP_ID,
            secretKey: config.CASHFREE_TEST_SECRET_KEY,
            webhookSecret: config.CASHFREE_WEBHOOK_SECRET,
            livemode: false,
          })
        : undefined,
  },
  adyen: {
    // Test keys reach the test host; a live account names its live URL prefix.
    build: (creds, ctx) => {
      if (!creds.api_key || !creds.client_key || !creds.merchant_account)
        throw new GatewayResolveError(
          "adyen gateway account missing api_key/client_key/merchant_account",
        );
      try {
        return new AdyenProvider({
          apiKey: creds.api_key,
          clientKey: creds.client_key,
          merchantAccount: creds.merchant_account,
          livemode: ctx.livemode,
          ...(creds.live_url_prefix ? { liveUrlPrefix: creds.live_url_prefix } : {}),
          ...(creds.webhook_secret ? { hmacKey: creds.webhook_secret } : {}),
        });
      } catch (e) {
        throw new GatewayResolveError((e as Error).message);
      }
    },
    fromEnv: () =>
      config.ADYEN_TEST_API_KEY &&
      config.ADYEN_TEST_CLIENT_KEY &&
      config.ADYEN_TEST_MERCHANT_ACCOUNT
        ? new AdyenProvider({
            apiKey: config.ADYEN_TEST_API_KEY,
            clientKey: config.ADYEN_TEST_CLIENT_KEY,
            merchantAccount: config.ADYEN_TEST_MERCHANT_ACCOUNT,
            livemode: false,
            ...(config.ADYEN_WEBHOOK_HMAC_KEY ? { hmacKey: config.ADYEN_WEBHOOK_HMAC_KEY } : {}),
          })
        : undefined,
  },
  checkoutcom: {
    // The key prefix names the environment; the factory refuses a key for the other mode.
    build: (creds, ctx) => {
      const missing = [
        "secret_key",
        "public_key",
        "processing_channel_id",
        "api_prefix",
        "default_country",
        "entity_id",
      ].filter((k) => !creds[k]);
      if (missing.length)
        throw new GatewayResolveError(`checkoutcom gateway account missing ${missing.join("/")}`);
      try {
        return new CheckoutcomProvider({
          secretKey: creds.secret_key!,
          publicKey: creds.public_key!,
          processingChannelId: creds.processing_channel_id!,
          apiPrefix: creds.api_prefix!,
          defaultCountry: creds.default_country!,
          entityId: creds.entity_id!,
          webhookSecret: creds.webhook_secret,
          livemode: ctx.livemode,
        });
      } catch (e) {
        throw new GatewayResolveError((e as Error).message);
      }
    },
    fromEnv: () =>
      config.CHECKOUT_TEST_SECRET_KEY &&
      config.CHECKOUT_TEST_PUBLIC_KEY &&
      config.CHECKOUT_TEST_PROCESSING_CHANNEL_ID &&
      config.CHECKOUT_TEST_API_PREFIX &&
      config.CHECKOUT_TEST_ENTITY_ID
        ? new CheckoutcomProvider({
            secretKey: config.CHECKOUT_TEST_SECRET_KEY,
            publicKey: config.CHECKOUT_TEST_PUBLIC_KEY,
            processingChannelId: config.CHECKOUT_TEST_PROCESSING_CHANNEL_ID,
            apiPrefix: config.CHECKOUT_TEST_API_PREFIX,
            // Sandbox only: the env adapter has no business to read a country from.
            defaultCountry: "US",
            entityId: config.CHECKOUT_TEST_ENTITY_ID,
            webhookSecret: config.CHECKOUT_TEST_WEBHOOK_SECRET,
            livemode: false,
          })
        : undefined,
  },
  authorizenet: {
    // Sandbox and live keys look alike, so the account's mode picks the host.
    build: (creds, ctx) => {
      if (!creds.api_login_id || !creds.transaction_key || !creds.signature_key)
        throw new GatewayResolveError(
          "authorizenet gateway account missing api_login_id/transaction_key/signature_key",
        );
      const signatureKey = creds.signature_key.trim();
      if (!/^[0-9a-fA-F]{128}$/.test(signatureKey))
        throw new GatewayResolveError(
          "authorizenet signature_key must be the 128 hexadecimal characters the Merchant Interface shows",
        );
      return new AuthorizenetProvider({
        apiLoginId: creds.api_login_id.trim(),
        transactionKey: creds.transaction_key.trim(),
        signatureKey,
        livemode: ctx.livemode,
        ...(creds.api_base ? { apiHost: creds.api_base } : {}),
      });
    },
    fromEnv: () =>
      config.AUTHORIZENET_TEST_API_LOGIN_ID &&
      config.AUTHORIZENET_TEST_TRANSACTION_KEY &&
      config.AUTHORIZENET_TEST_SIGNATURE_KEY
        ? new AuthorizenetProvider({
            apiLoginId: config.AUTHORIZENET_TEST_API_LOGIN_ID,
            transactionKey: config.AUTHORIZENET_TEST_TRANSACTION_KEY,
            signatureKey: config.AUTHORIZENET_TEST_SIGNATURE_KEY,
            livemode: false,
          })
        : undefined,
  },
  square: {
    // Sandbox and live tokens look alike; the Application ID says which, and must agree with the mode.
    build: (creds, ctx) => {
      if (!creds.access_token || !creds.application_id || !creds.location_id)
        throw new GatewayResolveError(
          "square gateway account missing access_token/application_id/location_id",
        );
      const applicationId = creds.application_id.trim();
      if (!/^(sandbox-)?sq0id[a-z]-[A-Za-z0-9_-]+$/.test(applicationId))
        throw new GatewayResolveError(
          "square application_id must be the Application ID from the Square Developer Console (sq0idp-… or sandbox-sq0idb-…)",
        );
      if (applicationId.startsWith("sandbox-") === ctx.livemode)
        throw new GatewayResolveError(
          ctx.livemode
            ? "square: a live business needs the Production Application ID and access token, not the Sandbox ones"
            : "square: a test business needs the Sandbox Application ID and access token",
        );
      const locationId = creds.location_id.trim();
      if (!/^[A-Za-z0-9]{6,32}$/.test(locationId))
        throw new GatewayResolveError("square location_id must be a Square location ID");
      return new SquareProvider({
        accessToken: creds.access_token.trim(),
        applicationId,
        locationId,
        ...(creds.webhook_secret ? { signatureKey: creds.webhook_secret } : {}),
        ...(creds.notification_url ? { notificationUrl: creds.notification_url } : {}),
        livemode: ctx.livemode,
        ...(creds.api_base ? { apiHost: creds.api_base } : {}),
      });
    },
    fromEnv: () =>
      config.SQUARE_TEST_ACCESS_TOKEN &&
      config.SQUARE_TEST_APPLICATION_ID &&
      config.SQUARE_TEST_LOCATION_ID
        ? new SquareProvider({
            accessToken: config.SQUARE_TEST_ACCESS_TOKEN,
            applicationId: config.SQUARE_TEST_APPLICATION_ID,
            locationId: config.SQUARE_TEST_LOCATION_ID,
            ...(config.SQUARE_TEST_SIGNATURE_KEY
              ? { signatureKey: config.SQUARE_TEST_SIGNATURE_KEY }
              : {}),
            livemode: false,
          })
        : undefined,
  },
  mollie: {
    // The key prefix (test_ / live_) names the environment; the factory refuses a mismatch.
    build: (creds, ctx) => {
      if (!creds.api_key) throw new GatewayResolveError("mollie gateway account missing api_key");
      try {
        return new MollieProvider({
          apiKey: creds.api_key,
          livemode: ctx.livemode,
          ...(ctx.notificationUrl ? { notificationUrl: ctx.notificationUrl } : {}),
          ...(creds.webhook_secret ? { webhookSecret: creds.webhook_secret } : {}),
          ...(creds.api_base ? { apiBase: creds.api_base } : {}),
        });
      } catch (e) {
        throw new GatewayResolveError((e as Error).message);
      }
    },
    fromEnv: () =>
      config.MOLLIE_TEST_API_KEY
        ? new MollieProvider({ apiKey: config.MOLLIE_TEST_API_KEY, livemode: false })
        : undefined,
  },
  payu: {
    // Keys carry no test/live marker, so the account's mode picks the host.
    build: (creds, ctx) => {
      const merchantKey = creds.merchant_key?.trim();
      const merchantSalt = creds.merchant_salt?.trim();
      if (!merchantKey || !merchantSalt)
        throw new GatewayResolveError("payu gateway account missing merchant_key/merchant_salt");
      return new PayuProvider({ merchantKey, merchantSalt, livemode: ctx.livemode });
    },
    fromEnv: () =>
      config.PAYU_TEST_KEY && config.PAYU_TEST_SALT
        ? new PayuProvider({
            merchantKey: config.PAYU_TEST_KEY,
            merchantSalt: config.PAYU_TEST_SALT,
            livemode: false,
          })
        : undefined,
  },
  cybersource: {
    // Sandbox and live keys look alike, so the account's mode picks the host.
    build: (creds, ctx) => {
      if (!creds.organization_id || !creds.key_id || !creds.shared_secret)
        throw new GatewayResolveError(
          "cybersource gateway account missing organization_id/key_id/shared_secret",
        );
      const keyId = creds.key_id.trim();
      const sharedSecret = creds.shared_secret.trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(keyId))
        throw new GatewayResolveError(
          "cybersource key_id must be the Key the Business Center shows",
        );
      if (!/^[A-Za-z0-9+/]{43}=$/.test(sharedSecret))
        throw new GatewayResolveError(
          "cybersource shared_secret must be the 44-character Shared Secret the Business Center shows",
        );
      return new CybersourceProvider({
        organizationId: creds.organization_id.trim(),
        keyId,
        sharedSecret,
        livemode: ctx.livemode,
        defaultOrigins: cybersourceOrigins(),
        ...(creds.webhook_secret ? { webhookSecret: creds.webhook_secret } : {}),
        ...(creds.api_base ? { apiHost: creds.api_base } : {}),
      });
    },
    fromEnv: () =>
      config.CYBERSOURCE_TEST_ORGANIZATION_ID &&
      config.CYBERSOURCE_TEST_KEY_ID &&
      config.CYBERSOURCE_TEST_SECRET_KEY
        ? new CybersourceProvider({
            organizationId: config.CYBERSOURCE_TEST_ORGANIZATION_ID,
            keyId: config.CYBERSOURCE_TEST_KEY_ID,
            sharedSecret: config.CYBERSOURCE_TEST_SECRET_KEY,
            livemode: false,
            defaultOrigins: cybersourceOrigins(),
          })
        : undefined,
  },
};

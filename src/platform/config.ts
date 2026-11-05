import "dotenv/config";
import { z } from "zod";

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    /**
     * Interface the API binds. Defaults to all interfaces, which is what a container
     * needs; set `127.0.0.1` to put the socket behind a reverse proxy for real.
     *
     * Added for a deployment that holds a full copy of a production customer book and
     * where only the proxy should be reachable. Previously the bind was hardcoded to
     * `0.0.0.0`, so "internal only" could be expressed as a firewall rule but never as a
     * closed socket — and a filter in front of an open port fails open the moment the
     * filter is wrong.
     */
    HOST: z.string().default("0.0.0.0"),

    /**
     * Declares that this deployment is NOT served over HTTPS. It clears `Secure` from
     * every cookie we set and suppresses HSTS — see `secureTransport()` below.
     *
     * Spelled as an opt-OUT on purpose. The obvious alternative is to derive it from
     * `NODE_ENV !== 'production'`, and that is a known failure shape: a CORS
     * policy that hangs on one variable matching one exact string, so an unset or
     * misspelled value silently disables the protection — in production, with no error and no log line. `NODE_ENV` here
     * defaults to `development`, which means deriving from it would fail OPEN exactly
     * when the variable goes missing on a real host.
     *
     * Inverted, the failure mode inverts with it: forget this and you get a `Secure`
     * cookie your local HTTP browser declines, which you notice in seconds. Nothing
     * about a missing variable can quietly ship an insecure cookie to production.
     *
     * Most local development needs it anyway: browsers treat `http://localhost` as a
     * secure context and accept `Secure` cookies from it. Set this only when serving
     * plain HTTP on something that is not localhost (a LAN IP, a bare container host).
     */
    ALLOW_INSECURE_COOKIES: z.enum(["TRUE", "FALSE"]).default("FALSE"),

    /**
     * Lets webhook endpoints and logo URLs reach private, loopback and link-local addresses
     * (`platform/outbound.ts`). Off by default: on, any API key can make this server call
     * its own network, cloud metadata included. Set TRUE for local development, where the
     * receivers are on localhost, or for a self-hosted install that delivers to an internal
     * service on purpose.
     */
    ALLOW_PRIVATE_OUTBOUND_URLS: z.enum(["TRUE", "FALSE"]).default("FALSE"),

    /**
     * How many reverse proxies sit in front of this process — i.e. how much of
     * `X-Forwarded-For` may be believed when resolving `req.ip`. Required wherever the
     * public rate limiter is expected to count callers apart; see the `trustProxy` note
     * in `src/index.ts` for what each wrong answer looks like.
     *
     * A HOP COUNT, not the boolean this used to be (audit H3). `trustProxy: true` believes
     * the WHOLE chain and resolves `req.ip` to its LEFTMOST entry — the one the client
     * wrote. Caddy and nginx both APPEND the real peer rather than replacing the header, so
     * a forged value survives in front of the true one and becomes `req.ip`; every per-IP
     * limit then counts against a bucket the caller picked, and rotating one header per
     * request makes login, signup and password reset effectively unlimited. The boolean
     * could only say "believe everything" or "believe nothing" — the safe answer, believe
     * exactly the hops we operate, had no spelling.
     *
     * 0 = the socket faces the internet directly. 1 = one proxy (the
     * `deploy/README.md` shape — one nginx). Raise only when a hop is actually added.
     */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(4).default(0),

    /**
     * Screen new passwords against Have I Been Pwned's range API (audit M4).
     *
     * Default FALSE, and that is deliberate rather than lazy: the check reaches a third
     * party on the password-setting path, so leaving it on by default would make every
     * verify suite and seed depend on the network — slow, flaky offline, and the repo
     * treats suite hermeticity as load-bearing. The LOCAL common-password list in
     * `modules/auth/password-policy.ts` always runs and needs no network.
     *
     * Set TRUE in any real deployment. k-anonymity: only the first five hex characters of
     * the SHA-1 leave this process, so the password itself is never transmitted and no API
     * key is needed. Fails OPEN — an unreachable HIBP must not stop a password reset.
     */
    PASSWORD_BREACH_CHECK: z.enum(["TRUE", "FALSE"]).default("FALSE"),

    /**
     * scrypt's cost parameter N, as a power of two (audit L1).
     *
     * Measured on the dev machine: 2^14 = 36ms, 2^15 = 83ms, 2^16 = 172ms, 2^17 = 335ms per
     * hash. 16 is the default because `login_signup_system.md` §4.1 asks for roughly 130ms
     * and it is the first step past that. OWASP's current guidance is 2^17, which is also
     * correct — and nine times the old cost, which shows up directly in CI: `verify-security`
     * §F alone performs ~80 hashes, so 2^17 adds ~25s to a suite set that runs in 2m43s.
     *
     * Raising this does NOT invalidate stored passwords: the hash records the parameters it
     * was made with (`scrypt$N$r$p$salt$hash`) and `verifyPassword` reads them from the row,
     * re-hashing on the next successful login. That is the actual fix behind L1 — the number
     * is a knob, the self-describing format is what makes the knob turnable.
     */
    SCRYPT_COST_LOG2: z.coerce.number().int().min(14).max(20).default(16),

    /**
     * How long a row in `login_attempts` is kept (audit M5). 90 days is the standard's §9.3
     * figure, and the trade is explicit: long enough that an incident found late still has its
     * evidence, short enough that the table is not a permanent record of every address anyone
     * ever tried. The addresses are hashed regardless.
     */
    LOGIN_ATTEMPT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
    /**
     * How long a `security_events` row is kept (0328). A year: these are rare, per-person rows
     * that answer "when was 2FA turned off, and from where?" — often asked months later.
     */
    SECURITY_EVENT_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
    /**
     * Days between support filing a 2FA reset and it taking effect (0328). The wait is the
     * defence: the real owner gets an email with a cancel link before anything changes.
     */
    MFA_RESET_WAIT_DAYS: z.coerce.number().int().min(1).default(3),
    /**
     * Where operators reach whoever runs this deployment — shown on the sign-in code step and
     * in account-security emails. Unset ⇒ the copy says "your administrator" instead.
     */
    SUPPORT_EMAIL: z.string().email().optional(),

    /**
     * How long the "your password was correct, now the code" token lives (audit M3).
     *
     * Five minutes: long enough to open an authenticator app and read a rotating code, short
     * enough that a stolen challenge is worth little — and it is useless on its own, since the
     * second factor is exactly what it is still waiting for.
     */
    MFA_CHALLENGE_TTL_MINUTES: z.coerce.number().int().positive().default(5),

    /**
     * Roles that MUST hold a second factor (audit M3.1). Comma-separated; empty = nobody.
     *
     * ⚠ DEPRECATED (0329). An organization's own "Require two-factor authentication" setting
     * (Settings → Security) is the control: per organization, with a grace period, visible to
     * the admins who own the decision. This deployment-wide switch keeps working for the
     * deployments that set it, and will be removed once none do.
     *
     * ── WHY IT DEFAULTS TO OFF, AND WHY THAT IS NOT TIMIDITY ────────────────────────
     * The mechanism is complete and gated; the POLICY is a decision about how a real team signs
     * in, and it is not one a config default should make on their behalf. Setting
     * `MFA_REQUIRED_ROLES=owner,admin` is the intended production value and is a one-line change.
     *
     * ── WHY IT FORCES ENROLMENT INSTEAD OF REFUSING THE LOGIN ───────────────────────
     * The obvious implementation — refuse to sign in an owner who has no second factor — locks
     * the entire team out permanently on the deploy that enables it, because the enrolment page
     * is BEHIND the login. There is no way in and no way to enrol. So a mandated role still gets
     * a session; what it does not get is any of `/v1/*`, until the factor is confirmed. The
     * `/auth/mfa/*` routes stay open, which is exactly the set needed to enrol and nothing more.
     *
     * The flag is DERIVED per request from the role and the enrolment state, never stored: it
     * clears itself the instant the factor is confirmed, and no migration or backfill can leave
     * a stale copy of it behind.
     */
    MFA_REQUIRED_ROLES: z
      .string()
      .default("")
      .transform((v) =>
        v
          .split(",")
          .map((r) => r.trim().toLowerCase())
          .filter(Boolean),
      ),

    /**
     * How long a step-up re-authentication stays fresh (audit M3.3). A sign-in counts as one.
     *
     * Enforced ONLY on 2FA and passkey management (`refuseUnlessSteppedUp` in auth-routes,
     * restored 2026-11-04, audit P2-PASSKEY). Every other route lost step-up on 2026-09-02 on
     * our user's instruction and stays without it. Fifteen minutes matches `sudo`'s default.
     */
    STEP_UP_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),

    /**
     * Cloudflare Turnstile server-side secret (audit M3.2). Absent = the challenge is OFF.
     *
     * Absent means SKIP rather than refuse: there is nothing to verify against, and refusing
     * every caller because an optional control is unconfigured would be an outage. But once it IS
     * set, an unreachable verifier REFUSES — see the note in platform/turnstile.ts for why that
     * is the opposite of the HIBP choice.
     *
     * The matching public site key belongs in the dashboard as NEXT_PUBLIC_TURNSTILE_SITE_KEY;
     * the widget renders only when that is set, so there is never a challenge box with no
     * server-side check behind it, nor a check with no box in front of it.
     */
    TURNSTILE_SECRET_KEY: z.string().optional(),

    /**
     * Whether `POST /auth/signup` accepts anyone (audit H2 / M9). **Default FALSE.**
     *
     * The route reveals no account (M9): a password sign-up answers the same 202 for every
     * address and signs in only through the emailed link; an address that already has an
     * account is emailed "sign in instead". A Google sign-up is verified by Google and signs in
     * at once. Turnstile, when configured, guards it.
     *
     * The importer, the seed and every fixture call the `signup()` SERVICE function directly,
     * in-process, and are unaffected by this flag.
     */
    SIGNUP_ENABLED: z.enum(["TRUE", "FALSE"]).default("FALSE"),
    /**
     * Which product this deployment is (`platform/edition.ts`). `cloud` is our hosted service:
     * public sign-up, plans and the live-mode lock, account billing. `self_hosted`, the
     * default, has none of them, whatever their own settings say. Any other value refuses to
     * boot: a typo must not quietly pick an edition.
     */
    TMBILLING_EDITION: z
      .enum(["cloud", "self_hosted", ""])
      .default("self_hosted")
      .transform((v) => v || "self_hosted"),
    /**
     * Sign-ups start on the Free plan (0356): live mode on, `plan:free`, measured by account
     * billing. Off = a sign-up is an agreement with no limit. Name kept from 0354 (it meant
     * "locked" then). Cloud only: both sign-up flags do nothing unless TMBILLING_EDITION=cloud.
     */
    SIGNUP_SANDBOX: z.enum(["TRUE", "FALSE"]).default("FALSE"),
    /**
     * Where an access request made while sign-up is locked is emailed (Cloud). Unset = no email;
     * the request is still stored and listed in the back-office.
     */
    SIGNUP_REQUEST_NOTIFY_TO: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().email().optional(),
    ),
    /**
     * Google Chat incoming-webhook URL that each access request is also posted to. The URL is
     * the credential: keep it in `.env` only. Unset = OPS_ALERT_WEBHOOK_URL; both unset = no post.
     */
    LEAD_CHAT_WEBHOOK_URL: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().url().optional(),
    ),
    /** The back-office alert channel (backoffice/config.ts). Read here only as the lead fallback. */
    OPS_ALERT_WEBHOOK_URL: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().url().optional(),
    ),
    /**
     * Most customers / subscriptions one TEST business may hold (`tenancy/test-limits.ts`).
     * Unset: 1,000 on Cloud, no limit on self-hosted. A number applies on every edition; 0 =
     * no limit. A business's own override (set by staff) wins over both.
     */
    TEST_BUSINESS_CUSTOMER_LIMIT: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.coerce.number().int().nonnegative().optional(),
    ),
    TEST_BUSINESS_SUBSCRIPTION_LIMIT: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.coerce.number().int().nonnegative().optional(),
    ),

    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    /**
     * ── Google Cloud Logging ───────────────────────────────────────────────────
     * We deploy to a plain VPS under pm2 (deploy/README.md), not to GCP, so there is
     * no logging agent scraping stdout: entries are pushed to the Cloud Logging API
     * by `platform/cloud-logging.ts`. One service account and one Logs Explorer query
     * can cover several services — a traceId minted upstream lands on tmbilling's
     * lines too.
     *
     * The sink is OFF unless `CLOUD_LOGGING=TRUE` *and* a project id is set. Off, the
     * logger is exactly what it was before: pino to stdout. This is deliberate —
     * every verify script, test and CLI in this repo imports the logger, and none of
     * them should open a gRPC channel or need credentials to run.
     */
    CLOUD_LOGGING: z.enum(["TRUE", "FALSE"]).default("FALSE"),
    GOOGLE_CLOUD_PROJECT_ID: z.string().optional(),
    /** Path to the service-account JSON. Omit to use ambient ADC (`GOOGLE_APPLICATION_CREDENTIALS`, metadata server). */
    GOOGLE_CLOUD_CREDENTIALS_PATH: z.string().optional(),
    /** The Cloud Logging log name entries are written under — the `logName` you filter on. */
    GOOGLE_CLOUD_LOG_NAME: z.string().default("tmbilling"),
    /**
     * `serviceContext.service` for Error Reporting, which groups by it. Distinct per
     * deployment (`tmbilling-api`, `tmbilling-worker`) so a worker crash loop doesn't
     * get folded into an API error group; the process sets it, this is the default.
     */
    GOOGLE_CLOUD_SERVICE_CONTEXT: z.string().default("tmbilling"),
    /** Minimum level pushed to the cloud sink. Independent of LOG_LEVEL: keep stdout chatty locally, the sink lean. */
    CLOUD_LOGGING_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
    /** Free-form label on every entry (`hetzner`, `aws`, …). */
    CLOUD_PROVIDER: z.string().optional(),

    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    API_KEY_SECRET: z.string().min(16, "API_KEY_SECRET must be at least 16 chars"),

    /**
     * PINNED gateway-account public ids, per gateway key — `stripe=gwa_…,paypal=gwa_…`.
     *
     * The inbound webhook URL is `…/v1/gateway_webhooks/<gateway>?id=<public id>`, and
     * that URL is registered **in the provider's own dashboard**. So the id is not an
     * internal detail: it is a value another system already holds. A migration import
     * (and especially a reset-and-reimport, which truncates first) otherwise mints a
     * new one, and every registered endpoint starts 404ing — silently, because a gateway
     * that 404s looks identical to one that stopped sending.
     *
     * The migration source only exposes a `gateway_account_id` for some gateways
     * (RazorPay; not Stripe or PayPal), so the source id alone cannot pin every provider.
     * This closes that gap: set it to whatever the provider dashboards already point at.
     *
     * Precedence when the importer creates an account:
     *   existing account for that gateway → this pin → the source id → a fresh `gwa_…`
     */
    GATEWAY_ACCOUNT_IDS: z.string().optional(),

    // Symmetric key for encrypting gateway credentials at rest (C1). Any passphrase;
    // hashed to a 32-byte AES-256 key. Optional in dev — falls back to a key derived
    // from API_KEY_SECRET so local/test runs work without extra config.
    GATEWAY_CREDENTIALS_KEY: z.string().optional(),
    /**
     * The PREVIOUS credentials key, kept readable during a rotation. Set it to the old
     * value when changing `GATEWAY_CREDENTIALS_KEY`, run `pnpm gateway:rotate-credentials
     * --write`, then remove it. Without it a rotation is a cliff: every existing
     * `credentials_enc` becomes unreadable the moment the key changes.
     */
    GATEWAY_CREDENTIALS_KEY_PREVIOUS: z.string().optional(),

    // Provider credentials (optional — adapters only activate when present).
    STRIPE_TEST_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    // Publishable key handed to the buyer's browser (Stripe.js/Elements setup flows).
    //
    // Spelled to match its sibling `STRIPE_TEST_SECRET_KEY`. The schema used to call it
    // `STRIPE_PUBLISHABLE_KEY` while `.env.example` and every real `.env` wrote
    // `STRIPE_TEST_PUBLISHABLE_KEY`, so it always parsed as undefined. Measured 2026-08-14:
    // the portal's add-card then dropped through its Stripe branch (which requires a
    // publishable key) into the TM Test "Card token" input — a box that cannot vault a
    // Stripe card — so Stripe's add-card was unreachable for every buyer, silently.
    STRIPE_TEST_PUBLISHABLE_KEY: z.string().optional(),
    // Base URL of the buyer-facing portal (the dashboard app), e.g. http://localhost:3001.
    // Used to compose the copyable /portal/s/<token> link on portal-session mint — the
    // EXCHANGE route, never the portal page itself (W1).
    PORTAL_BASE_URL: z.string().optional(),

    // Public base URL this API is reachable at, used to build the per-gateway-account
    // webhook Notification URL we hand to providers. Must be publicly reachable for
    // real gateway traffic — in local dev this is a tunnel (`stripe listen` / ngrok)
    // origin.
    WEBHOOK_BASE_URL: z.string().optional(),

    /**
     * Let outbound requests to operator-typed URLs (webhook endpoints, the invoice logo)
     * reach private and reserved addresses: loopback, RFC 1918, link-local, metadata.
     * **Default FALSE** — a tenant must not point our worker at our own network
     * (`platform/egress.ts`). Set TRUE for a self-hosted install whose receivers live on a
     * private network, or for local dev. Redirects stay unfollowed either way.
     */
    WEBHOOK_ALLOW_PRIVATE_TARGETS: z
      .preprocess((v) => (typeof v === "string" ? v.toUpperCase() : v), z.enum(["TRUE", "FALSE"]))
      .default("FALSE")
      .transform((v) => v === "TRUE"),

    // PayPal (sandbox). The adapter defaults to the US business account.
    PAYPAL_TEST_BUSINESS_US_CLIENT_ID: z.string().optional(),
    PAYPAL_TEST_BUSINESS_US_CLIENT_SECRET: z.string().optional(),
    PAYPAL_TEST_BUSINESS_INDIA_CLIENT_ID: z.string().optional(),
    PAYPAL_TEST_BUSINESS_INDIA_CLIENT_SECRET: z.string().optional(),
    PAYPAL_WEBHOOK_ID: z.string().optional(),
    PAYPAL_API_BASE: z.string().default("https://api-m.sandbox.paypal.com"),

    // RazorPay (test mode).
    RAZORPAY_TEST_KEY_ID: z.string().optional(),
    RAZORPAY_TEST_KEY_SECRET: z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
    RAZORPAY_API_BASE: z.string().default("https://api.razorpay.com/v1"),

    // GoCardless (sandbox). The host follows the account's livemode.
    GOCARDLESS_TEST_ACCESS_TOKEN: z.string().optional(),
    GOCARDLESS_WEBHOOK_SECRET: z.string().optional(),
    // Braintree (sandbox). Absent = the env adapter is off; accounts carry their own keys.
    BRAINTREE_TEST_MERCHANT_ID: z.string().optional(),
    BRAINTREE_TEST_PUBLIC_KEY: z.string().optional(),
    BRAINTREE_TEST_PRIVATE_KEY: z.string().optional(),
    // Authorize.net (sandbox). Absent = the env adapter is off; accounts carry their own keys.
    AUTHORIZENET_TEST_API_LOGIN_ID: z.string().optional(),
    AUTHORIZENET_TEST_TRANSACTION_KEY: z.string().optional(),
    AUTHORIZENET_TEST_SIGNATURE_KEY: z.string().optional(),
    // Square (sandbox). Absent = the env adapter is off; accounts carry their own keys.
    SQUARE_TEST_APPLICATION_ID: z.string().optional(),
    SQUARE_TEST_ACCESS_TOKEN: z.string().optional(),
    SQUARE_TEST_LOCATION_ID: z.string().optional(),
    SQUARE_TEST_SIGNATURE_KEY: z.string().optional(),
    // Mollie (test). Feeds `fromEnv` and the scripts; accounts store their own keys.
    MOLLIE_TEST_API_KEY: z
      .string()
      .optional()
      .transform((v) => v?.replace(/\s+#.*$/, "").trim() || undefined),
    // Cashfree (sandbox). Feeds `fromEnv` and the scripts; accounts store their own keys.
    CASHFREE_TEST_APP_ID: z.string().optional(),
    CASHFREE_TEST_SECRET_KEY: z.string().optional(),
    CASHFREE_WEBHOOK_SECRET: z.string().optional(),
    // Adyen (test). Feeds `fromEnv` and the scripts; accounts store their own keys.
    ADYEN_TEST_API_KEY: z.string().optional(),
    ADYEN_TEST_CLIENT_KEY: z.string().optional(),
    ADYEN_TEST_MERCHANT_ACCOUNT: z.string().optional(),
    ADYEN_WEBHOOK_HMAC_KEY: z.string().optional(),
    // Checkout.com (sandbox). Absent = the env adapter is off; accounts carry their own keys.
    CHECKOUT_TEST_SECRET_KEY: z.string().optional(),
    CHECKOUT_TEST_PUBLIC_KEY: z.string().optional(),
    CHECKOUT_TEST_PROCESSING_CHANNEL_ID: z.string().optional(),
    CHECKOUT_TEST_API_PREFIX: z.string().optional(),
    CHECKOUT_TEST_WEBHOOK_SECRET: z.string().optional(),
    CHECKOUT_TEST_ENTITY_ID: z.string().optional(),
    // PayU (test.payu.in). Feeds `fromEnv` and the scripts; accounts store their own keys.
    PAYU_TEST_KEY: z.string().optional(),
    PAYU_TEST_SALT: z.string().optional(),
    // CyberSource (sandbox). The Organization ID signs requests.
    CYBERSOURCE_TEST_ORGANIZATION_ID: z.string().optional(),
    CYBERSOURCE_TEST_KEY_ID: z.string().optional(),
    CYBERSOURCE_TEST_SECRET_KEY: z.string().optional(),
    /** Charges per second per gateway account, per process (`gateway/charge-pace.ts`). 0 = off. */
    GATEWAY_CHARGES_PER_S: z.coerce.number().nonnegative().default(0),

    // Load-test profile for the TM Billing Test Gateway (scripts/loadtest). Off by default.
    // On, every tmtest charge waits a sampled gateway response time (log-normal through
    // P50/P99) and TMTEST_DECLINE_RATE of success-card charges decline with a real code mix,
    // so a synthetic book renews at gateway speed instead of instantly.
    TMTEST_LOAD_PROFILE: z.enum(["TRUE", "FALSE"]).default("FALSE"),
    TMTEST_LATENCY_P50_MS: z.coerce.number().int().nonnegative().default(2700),
    TMTEST_LATENCY_P99_MS: z.coerce.number().int().nonnegative().default(8000),
    TMTEST_DECLINE_RATE: z.coerce.number().min(0).max(1).default(0.11),
    TMTEST_RATE_LIMIT_PER_S: z.coerce.number().int().nonnegative().default(0),

    // Customer-facing email delivery. Provider-agnostic mailer adapter (like the
    // payment providers): `console` is the default dev sink (logs nothing out; the DB row
    // is the record of truth, and `email_messages.transport` records that no relay was
    // involved). `smtp` is real delivery via the SMTP_* settings below; `ses` is Amazon SES
    // over the SESv2 API via the AWS_EMAIL_* settings; `esp` is still a stub.
    // MAIL_FROM is the envelope From; MAIL_FROM_NAME the display name.
    //
    // These describe the DEPLOYMENT-WIDE relay — the fallback for businesses that have not
    // configured their own, and the transport that carries PLATFORM mail that belongs to no
    // tenant at all (operator invites and password resets, which send through
    // `resolveMailer(null)` in src/modules/auth/service.ts). A business with
    // `smtp_config.enabled` or `ses_config.enabled` overrides it for its own customer mail
    // (src/modules/emails/mailer-resolver.ts).
    MAILER_PROVIDER: z.enum(["console", "smtp", "esp", "ses"]).default("console"),
    /** Milliseconds the `console` sink waits per message, to stand in for a relay in load tests. */
    MAILER_CONSOLE_DELAY_MS: z.coerce.number().int().nonnegative().default(0),
    /** Console mailer also logs each email's text body (links included). Local stacks only. */
    MAILER_CONSOLE_BODY: z.enum(["TRUE", "FALSE"]).default("FALSE"),
    MAIL_FROM: z.string().default("billing@tmbilling.local"),
    MAIL_FROM_NAME: z.string().default("tmbilling"),

    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_ENCRYPTION: z.enum(["tls", "starttls", "none"]).default("starttls"),
    SMTP_USERNAME: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),

    // Amazon SES (SESv2 API), used when MAILER_PROVIDER=ses. Named AWS_EMAIL_* rather than
    // AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY on purpose: those are the SDK's own ambient
    // variables, and reusing them would let any other AWS client in the process silently
    // inherit the mail credential — and would make the default provider chain pick them up
    // even when MAILER_PROVIDER is not `ses`. The key should be scoped to `ses:SendEmail`
    // and nothing else. NOTE it is `ses:SendRawEmail`, not `ses:SendEmail`: we send raw
    // MIME (attachments require it) and AWS authorises raw content under the separate
    // SendRaw action, so a key granted only `ses:SendEmail` is refused on every identity.
    //
    // Note SES can also be driven through the SMTP_* settings above via its SMTP endpoint;
    // the API transport is preferred because it gives typed errors and an account-status
    // check. See the header of src/providers/mailer/ses.ts.
    AWS_EMAIL_REGION: z.string().default("us-east-1"),
    AWS_EMAIL_KEY: z.string().optional(),
    AWS_EMAIL_SECRET: z.string().optional(),
    // Optional SES configuration set — the hook for bounce/complaint notifications via SNS.
    AWS_EMAIL_CONFIGURATION_SET: z.string().optional(),

    // ── Object storage for merchant brand assets ───────────────────────────────
    // Cloudflare R2, S3-compatible. All optional: tmbilling runs
    // fine without them and the upload route refuses cleanly when unset (see
    // `platform/object-store.ts`) rather than failing at the first upload.
    //
    // The bucket may be shared with another app, under the `tmbilling/` prefix. So
    // R2_KEY_PREFIX is load-bearing, not cosmetic — it is the only thing separating the
    // two apps' objects inside one bucket. It stays
    // config rather than a constant so a second deployment can take its own prefix.
    R2_ACCOUNT_ID: z.string().optional(),
    R2_BUCKET_NAME: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_KEY_PREFIX: z.string().default("tmbilling"),
    // Any other S3-compatible store (MinIO, AWS S3). Set = R2_ACCOUNT_ID is not needed; the
    // R2_BUCKET_NAME / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY settings still name the bucket.
    OBJECT_STORE_ENDPOINT: z.string().url().optional(),
    OBJECT_STORE_REGION: z.string().default("auto"),
    OBJECT_STORE_FORCE_PATH_STYLE: z.enum(["TRUE", "FALSE"]).default("FALSE"),
    // Where the stored objects are served from. Must be http(s): it becomes the value of
    // `businesses.logo_url`, which is now scheme-restricted.
    CDN_URL: z.string().url().optional(),

    // Tax-ID (VAT number) validation backend. `noop` records 'undetermined' for any
    // present number without an external lookup. `vies` performs a live EU VIES lookup
    // (src/modules/customers/vies.ts). Unset: `vies` on Cloud, `noop` otherwise, so
    // tests and self-hosted installs make no outside call unless they opt in.
    TAX_ID_VALIDATOR: z.enum(["noop", "vies"]).optional(),
    // Override the VIES REST base (tests point this at a local stub server).
    VIES_API_BASE: z.string().default("https://ec.europa.eu/taxation_customs/vies/rest-api"),
    // Per-request timeout for the VIES lookup (ms); on timeout we return 'undetermined'.
    VIES_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

    // ── API rate limiting (#6) ────────────────────────────────────────────────
    /**
     * Requests per minute per API KEY, for organizations that have not set their own
     * `organizations.rate_limit_per_minute`.
     *
     * 600 (10/s) is chosen to be a ceiling on runaway integrations rather than a traffic
     * shaper: our own dashboard authenticates with a `dashboard` credential of the same
     * organization and a single page can fan out a dozen or more fetches, so a
     * 100/min ceiling would rate-limit the operator console before it ever
     * caught a misbehaving script. Per-organization overrides are the tool for tighter
     * commercial limits.
     */
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().nonnegative().default(600),

    /**
     * ── Limits for the UNAUTHENTICATED surface (W3) ────────────────────────────
     * Deliberately an order of magnitude tighter than `RATE_LIMIT_PER_MINUTE` above,
     * because they are measuring something else. That one is a ceiling on a trusted
     * integration's throughput; these are the number of times a stranger may guess.
     *
     * A human logs in once or twice a minute. Anything above single digits on a
     * credential route is a script, so the limits are set where a real person will
     * never meet them and a script always will.
     */

    /**
     * Credential attempts per FIFTEEN MINUTES from one client address (`AUTH_WINDOW_MS`).
     *
     * ⚠ The unit changed on 2026-08-28 (audit M1). This was 30 per MINUTE, so the effective
     * allowance was 450 per fifteen minutes — 45× the policy. The count below is unchanged;
     * the window is the fix.
     *
     * ⚠ DELIBERATE DEVIATION: §3.3 and §7.1 of the standard say 10 per IP per 15 minutes.
     * This stays at 30, for the reason the previous comment here gave and which still holds:
     * one address is not one person. An office NAT, a corporate VPN and carrier-grade NAT all
     * put many legitimate users behind a single address, and the dashboard is internet-facing,
     * so 10 per fifteen minutes would refuse a real team on a Monday morning — five people
     * mistyping twice exhausts it.
     *
     * The economics barely move: at 30 an attacker probes 30 accounts per quarter-hour from
     * one address, at 10 they probe 10, and either way they rotate addresses instead. What
     * actually stops targeted guessing is the per-email axis below, and what stops spraying is
     * that plus MFA (M3). Set `RATE_LIMIT_AUTH_PER_IP=10` if strict compliance is wanted —
     * it is one environment variable, and the availability risk is the trade.
     */
    RATE_LIMIT_AUTH_PER_IP: z.coerce.number().int().nonnegative().default(30),
    /**
     * Credential attempts per FIFTEEN MINUTES against one email address, counted
     * independently of the address they come from — this is the axis that survives a botnet,
     * and it matches §3.3 and §7.1 exactly.
     */
    RATE_LIMIT_AUTH_PER_EMAIL: z.coerce.number().int().nonnegative().default(5),
    /**
     * Signups per HOUR from one client address (`SIGNUP_WINDOW_MS`) — §3.1, "max 10 signups
     * per IP per hour", and the one credential route the standard states in hours rather than
     * quarter-hours.
     *
     * Separate from `RATE_LIMIT_AUTH_PER_IP` because the shapes genuinely differ: a person
     * logs in repeatedly and signs up once, so the NAT argument above does not apply here and
     * the specified number can be used as written. Before this, signup shared the per-minute
     * auth limit — 30 per minute is 1,800 per hour against a policy of 10.
     */
    RATE_LIMIT_SIGNUP_PER_IP: z.coerce.number().int().nonnegative().default(10),
    /**
     * Payment-link opens and pricing-page reads per FIFTEEN MINUTES from one address. Each
     * open mints a checkout session, so this bounds what a script can create through a
     * public link while leaving room for a buyer who opens it a few times.
     */
    RATE_LIMIT_PAYMENT_LINK_PER_IP: z.coerce.number().int().nonnegative().default(30),
    /**
     * Platform-originated mail per minute to one RECIPIENT, whoever asked for it.
     * Keyed on the victim rather than the requester on purpose: spreading requests
     * across addresses is free, and the damage — an inbox full of our mail, and our
     * sending domain's reputation with it — lands on the recipient either way.
     */
    RATE_LIMIT_MAIL_PER_RECIPIENT: z.coerce.number().int().nonnegative().default(3),
    /**
     * Image uploads per HOUR. Uploads do not grant access, so these fail open; they exist to
     * bound bucket growth and the CPU a signed-in caller can spend on image decoding.
     */
    RATE_LIMIT_AVATAR_UPLOADS_PER_USER: z.coerce.number().int().nonnegative().default(10),
    RATE_LIMIT_BRAND_UPLOADS_PER_USER: z.coerce.number().int().nonnegative().default(30),
    RATE_LIMIT_BRAND_UPLOADS_PER_ORG: z.coerce.number().int().nonnegative().default(60),
    /**
     * Product images per HOUR per organization — its own counter, because setting up a
     * catalog uploads one per product and the brand limits above are sized for a logo.
     */
    RATE_LIMIT_PRODUCT_IMAGE_UPLOADS_PER_ORG: z.coerce.number().int().nonnegative().default(300),
    /**
     * Dashboard (operator session) requests per MINUTE per person. Separate from the
     * per-organization API limit; one page load makes about 10-30 calls.
     */
    RATE_LIMIT_SESSION_PER_MINUTE: z.coerce.number().int().nonnegative().default(1200),
    /** Team invites per HOUR. Each one sends an email from our domain to an address the caller chose. */
    RATE_LIMIT_INVITES_PER_USER: z.coerce.number().int().nonnegative().default(20),
    RATE_LIMIT_INVITES_PER_ORG: z.coerce.number().int().nonnegative().default(50),
    /**
     * Webhook resends and test sends per MINUTE. The per-delivery, latest and test routes POST to
     * the subscriber inline, so each call is an outbound request to a URL the caller chose.
     */
    RATE_LIMIT_WEBHOOK_SENDS_PER_ENDPOINT: z.coerce.number().int().nonnegative().default(10),
    RATE_LIMIT_WEBHOOK_SENDS_PER_ORG: z.coerce.number().int().nonnegative().default(30),
    /** Ad hoc emails per HOUR: per business, and per recipient (the `to` override can be any address). */
    RATE_LIMIT_ADHOC_EMAILS_PER_BUSINESS: z.coerce.number().int().nonnegative().default(200),
    RATE_LIMIT_ADHOC_EMAILS_PER_RECIPIENT: z.coerce.number().int().nonnegative().default(10),
    /**
     * Invoice collect/retry: per invoice per HOUR, per organization per MINUTE. Each call is a
     * real gateway charge attempt; gateways flag a card retried in a tight loop.
     */
    RATE_LIMIT_COLLECTS_PER_INVOICE: z.coerce.number().int().nonnegative().default(10),
    RATE_LIMIT_COLLECTS_PER_ORG: z.coerce.number().int().nonnegative().default(120),
    /** Buyer coupon-code tries per FIFTEEN MINUTES, per checkout session and per address. */
    RATE_LIMIT_COUPON_TRIES_PER_SESSION: z.coerce.number().int().nonnegative().default(10),
    RATE_LIMIT_COUPON_TRIES_PER_IP: z.coerce.number().int().nonnegative().default(30),

    /**
     * ── Google sign-in for OPERATORS (0194) ────────────────────────────────────
     * ⚠ This file also holds `GOOGLE_CLOUD_*` for the Cloud Logging service account — a
     * completely different Google credential. Two things called `GOOGLE_…` in one `.env`
     * is how one gets pasted where the other belongs; check which you are editing.
     * The adapter is inert unless BOTH are set: `/auth/google/start` answers 404, and
     * the dashboard hides the button. So an unconfigured deployment offers no
     * half-working control, and no test or CLI needs Google credentials to run.
     *
     * Sign-in is INVITE-ONLY: Google authenticates a user who already holds a
     * membership. Nothing here can create an account or an organization, which is why
     * these being public knowledge (the client id is, by design) grants nothing.
     */
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    /**
     * Where Google sends the browser back. Must match a redirect URI registered in the
     * Google Cloud console EXACTLY — Google compares the whole string, so a trailing
     * slash or http-vs-https difference is a `redirect_uri_mismatch` and nothing else.
     *
     * Points at the API (`…/auth/google/callback`), not the dashboard: the code must be
     * exchanged using the client SECRET, which only the server holds.
     */
    GOOGLE_REDIRECT_URI: z.string().optional(),
    /** Where to send the browser once sign-in succeeds or fails. The dashboard's origin. */
    DASHBOARD_BASE_URL: z.string().optional(),

    /**
     * Passkeys (0330). A passkey is bound to the origin the BROWSER is on — the dashboard,
     * never this API. Unset, the RP ID and origins derive from `DASHBOARD_BASE_URL` (else local
     * dev's http://localhost:4100) — see `passkeyRp()`.
     */
    /** Hostname passkeys bind to. Default: DASHBOARD_BASE_URL's hostname. Changing it invalidates every passkey. */
    WEBAUTHN_RP_ID: z.string().optional(),
    /** Shown by the browser's passkey dialog. */
    WEBAUTHN_RP_NAME: z.string().default("Two Minute Billing"),
    /** Comma-separated origins allowed to complete a ceremony. Default: DASHBOARD_BASE_URL's origin. */
    WEBAUTHN_ORIGINS: z.string().optional(),

    /**
     * The HubSpot app merchants install (`hubspot-app/`). The redirect URI is the
     * DASHBOARD's callback — it owns `state` — and must match the app's registered
     * `redirectUrls` exactly. The secret never leaves this service.
     */
    HUBSPOT_CLIENT_ID: z.string().optional(),
    HUBSPOT_CLIENT_SECRET: z.string().optional(),
    HUBSPOT_REDIRECT_URI: z.string().optional(),
    HUBSPOT_APP_ID: z.string().optional(),
    /** Overridable so a verify suite can stand in for HubSpot. */
    HUBSPOT_API_BASE: z.string().url().default("https://api.hubapi.com"),
    HUBSPOT_AUTH_BASE: z.string().url().default("https://app.hubspot.com"),

    /**
     * How long a hosted-checkout link stays usable, in hours (W10). See the long note on
     * `CHECKOUT_SESSION_TTL_MS` in `modules/checkout/service.ts` for why checkout stays
     * REUSABLE while the portal link became single-use — they are worth different things.
     */
    CHECKOUT_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24),

    /**
     * How long an invite link stays usable, in hours (0197). Longer than a password reset:
     * a reset is something you asked for seconds ago; an invite arrives unannounced and may
     * sit until someone is back at their desk.
     */
    INVITE_TTL_HOURS: z.coerce.number().int().positive().default(72),

    /**
     * How long a password-reset link stays usable. Short, because it is a credential
     * sitting in an inbox: NIST and OWASP both put this in minutes, not days, and the
     * cost of expiry is one more click on "forgot password".
     */
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(30),

    /**
     * How long an IDLE operator session survives, in minutes.
     *
     * The absolute ceiling below has always existed; this bound did not, so an
     * unattended session stayed live for the full week — an abandoned laptop was good
     * for six more days. 30 minutes (with an absolute 7 days) sits inside OWASP's 15–30 minute
     * band. The deadline is pushed forward on use, so this only ever bites someone who
     * has actually stopped working.
     */
    SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(30),

    /**
     * The ceiling on a session's total life, in hours, measured from sign-in and never
     * extended. 168h = 7 days, the value this has always used and the one §4.3 asks for.
     * Refreshing on activity must not let a session live forever: that is what separates
     * "you are still working" from "this credential is old".
     */
    SESSION_ABSOLUTE_TTL_HOURS: z.coerce.number().int().positive().default(168),

    /** Consecutive failed logins before the account is locked. */
    LOGIN_LOCKOUT_THRESHOLD: z.coerce.number().int().positive().default(10),
    /**
     * How long a locked account stays locked. Short by design: the lock exists to make
     * sustained guessing against one account pointless, not to punish, and a long lock
     * is a denial-of-service weapon against any address an attacker knows.
     */
    LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),
    /**
     * Kill switch. `FALSE` skips the counter entirely (no write, no headers) — for a
     * deployment that terminates rate limiting at the proxy instead, and as the escape
     * hatch if the limit itself ever becomes the incident. Counting stays ON by default:
     * a limit nobody enabled is the "deferred" state this work existed to close.
     */
    RATE_LIMIT_ENABLED: z.enum(["TRUE", "FALSE"]).default("TRUE"),

    /**
     * Usage ingest requests per second per organization (a batch is one request). An org's
     * `ingest_rate_limit_per_second` overrides it. Raise only after the ingest load test.
     */
    USAGE_INGEST_RATE_PER_SECOND: z.coerce.number().int().nonnegative().default(100),
    /** Months of usage events kept live; older partitions are archived, then dropped. */
    USAGE_EVENTS_LIVE_MONTHS: z.coerce.number().int().min(2).default(25),
    /**
     * Where expired usage partitions are archived: `s3://bucket/prefix` (S3-compatible; uses
     * the OBJECT_STORE_* credentials and endpoint) or `file:///path`. Unset = nothing is
     * dropped and a back-office alert says so.
     */
    USAGE_ARCHIVE_URL: z.string().optional(),
    /** `drop` deletes expired partitions with no archive, for a self-host that wants that. */
    USAGE_ARCHIVE_MODE: z.enum(["archive", "drop"]).default("archive"),

    /** The AI model price feed (genai-prices v2, MIT). A mirror works for a self-hosted install. */
    MODEL_PRICES_SOURCE_URL: z
      .string()
      .url()
      .default(
        "https://raw.githubusercontent.com/pydantic/genai-prices/main/prices/new_data/v2/data_slim.json",
      ),
    /** `off` stops the twice-daily price sync (air-gapped installs); the stored list still bills. */
    MODEL_PRICES_SYNC: z.enum(["on", "off"]).default("on"),

    /**
     * A request key the route does not declare. `reject` (default): 400 `Unknown
     * parameter: <path>`. `warn`: log `request_unknown_parameters` with the route and keys,
     * then ignore them — the rollback if a live caller turns out to send extras.
     */
    API_UNKNOWN_PARAMS: z.enum(["reject", "warn"]).default("reject"),

    // ── Worker / billing clock ────────────────────────────────────────────────
    // Previously hardcoded in platform/jobs.ts, so capacity could not be tuned per
    // environment without a code change.
    WORKER_CONCURRENCY: z.coerce.number().int().positive().max(300).default(5),
    /**
     * Charges in flight in a process running the collection pump (batch numbering). A charge
     * mostly waits on the gateway, so this can sit well above WORKER_CONCURRENCY without the
     * job slots growing with it. Unset = WORKER_CONCURRENCY.
     */
    COLLECT_LANES: z.coerce.number().int().positive().max(300).optional(),
    WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
    /**
     * graphile-worker's local queue: the pool fetches and locks this many jobs at once and
     * hands them to its slots, instead of one lookup per job per slot. 0 = off. Start at
     * `WORKER_CONCURRENCY + 1`. Jobs sit locked in the queue (a crash leaves them to the
     * stranded-lock sweep), and a new higher-priority job waits for the next fetch.
     */
    WORKER_LOCAL_QUEUE_SIZE: z.coerce.number().int().min(0).default(0),
    /**
     * Batch graphile-worker's complete/fail writes within this many ms. -1 = one write per
     * job. A crash before the batch lands leaves finished jobs locked, and they run again once
     * released, so only idempotent tasks belong behind it — all of ours are.
     */
    WORKER_JOB_BATCH_DELAY_MS: z.coerce.number().int().min(-1).default(-1),
    /**
     * How long a graceful shutdown may take before the worker stops waiting for
     * in-flight jobs and exits non-zero.
     *
     * `runner.stop()` waits for the running job, and a tick has no upper bound, so an
     * unbounded wait outlives every orchestrator grace period and gets SIGKILLed
     * mid-tick — the worst outcome, since nothing is stamped and the tick row is
     * abandoned. 25s sits under the common 30s default so WE decide the outcome.
     *
     * 25s suits a stop-then-start restart, where the drain is also a billing gap. Several jobs
     * run far longer (metric_windows_refresh ~46 s every run, hubspot sync ~10 min), so
     * `deploy/pm2/tmbilling-worker-cluster.json` starts the new worker FIRST and raises this
     * to 30 min: the old process can finish its jobs without holding up the clock.
     */
    WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),
    /**
     * Port for the worker's liveness/readiness listener (`/healthz`, `/readyz`).
     *
     * The worker is not an HTTP service, so without this it has no probe surface at all
     * and an orchestrator can only ask "is the PID there?" — which stays true for a process
     * that has lost its database and is failing every job. `0` disables the listener for a
     * deployment that monitors the `worker_heartbeats` row instead.
     */
    WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(4002),
    /**
     * Loopback by default, like every other internal socket in `deploy/README.md`. The
     * probe bodies name the process's role, pid and which dependency is down, and there is
     * no authentication in front of them — bind it wider only behind the firewall.
     */
    WORKER_HEALTH_HOST: z.string().default("127.0.0.1"),
    /**
     * Max rows one pass of the billing clock will claim in a single tick. Bounds a
     * tick's duration: the outbox/renewal scans are otherwise "every due row", so a
     * backlog turns one tick into an hours-long sweep holding a worker slot. Passes
     * report `capped: 1` when they hit it, and the next tick continues — every pass
     * scans for due work, so nothing is lost, only deferred by a minute.
     */
    TICK_SCAN_LIMIT: z.coerce.number().int().positive().default(500),
    /**
     * Wall-clock budget for any ONE pass of the billing clock.
     *
     * The row cap alone does not bound a tick: 500 webhook deliveries that each hit their
     * 10s HTTP timeout is 83 minutes inside a single pass. Loops that make a network call
     * per row check this budget between rows and stop early, reporting `capped` — the work
     * is claimed-and-deferred, never lost, and the next tick continues.
     *
     * 90s ORIGINALLY, and deliberately larger than TICK_OVERRUN_MS (60s), so an ordinary
     * busy tick was flagged as an overrun (visible) before it was truncated (degraded).
     * That reasoning holds for ONE busy tick and fails as a steady state, because nothing
     * reads the overrun flag: cron enqueues another tick every 60s regardless. Measured
     * 2026-09-01 with one business's SMTP host unreachable — the `email_outbox` pass spent
     * 103s of a 115s tick (9 dead rows x the 10s connect timeout, plus the 10th overshooting
     * the deadline), every tick overran, and the serialized `billing_clock` queue grew to
     * 1,456 jobs with the oldest 24h old. Arrival 1/60s against a drain of 1/115s can only
     * diverge.
     *
     * Now BELOW the 60s interval, so a single pathological pass cannot by itself push a
     * tick past its own cadence. The trade is deliberate: a genuinely busy pass truncates
     * sooner and reports `capped`, which is the visible-and-bounded failure rather than the
     * invisible-and-unbounded one. Still env-overridable, so a deployment that wants the
     * old behaviour sets it without a release.
     *
     * This is a CEILING on the damage, not a cure. A dead dependency still costs a full
     * connect timeout per attempt; only a per-dependency circuit breaker makes that cost
     * nothing. See docs/PROGRESS.md — billing clock, phase 1.
     */
    TICK_PASS_BUDGET_MS: z.coerce.number().int().positive().default(15_000),

    /**
     * How many renewals the billing clock may have IN FLIGHT at once.
     *
     * **Defaults to 1, which is exactly the behaviour this replaces** — the pass was a
     * `for…await` loop, so a deploy changes nothing until someone states a number. That is
     * deliberate: this is the money path, the engine is in production, and a config default
     * that silently multiplies gateway traffic by twenty is not a change anyone opted into.
     *
     * ── WHY RAISING IT IS THE WHOLE FIX ─────────────────────────────────────────────────
     * A renewal is one gateway round trip, and the loop waited for each before starting the
     * next: measured 2026-09-11, Stripe `payment_intent` means 593ms over 14,216 real calls
     * and Razorpay `charge` 681ms over 15,126, so a 15s pass managed 25 and 22 respectively.
     * Concurrency N multiplies that by N until something else binds. The work is I/O-bound on
     * someone else's socket, so this costs almost no local CPU.
     *
     * ── WHAT BINDS NEXT, IN ORDER ───────────────────────────────────────────────────────
     *  1. `TICK_SCAN_LIMIT` — the pass never sees row 501. Raise it or concurrency does
     *     nothing past 500 per tick, and the symptom is a flat ceiling with no error.
     *  2. `TICK_PASS_BUDGET_MS` — N renewals still have to FIT. 1,000 at N=20 is ~30s.
     *  3. The pg pool (`platform/db.ts`, `max`). The gateway call is outside the
     *     transaction, so each renewal holds a connection only for its short writes — but
     *     20 in flight still collide on a pool of 10.
     *  4. The gateway's own rate limit, which is the real ceiling and is PER ACCOUNT: Stripe
     *     publishes 100 req/s live and 25 req/s sandbox, and since each Business carries its
     *     own credentials that allowance is per business. Razorpay and PayPal publish no
     *     number at all — both document 429 + backoff and nothing more, so treat anything
     *     above ~10 there as unmeasured until you have watched for 429s.
     *
     * Safe to raise because the concurrency guard already existed: `renewSubscription` claims
     * the period advance with a compare-and-swap (`subscriptions/renewal.ts`), so a
     * subscription cannot be renewed twice however many callers race for it.
     */
    TICK_RENEWAL_CONCURRENCY: z.coerce.number().int().positive().max(100).default(1),
    /**
     * TRUE: the tick only FINDS due subscriptions and queues one `renew_subscription` job each;
     * workers renew them in parallel (`WORKER_CONCURRENCY` jobs in flight per process). FALSE
     * keeps renewals inside the tick, bounded by `TICK_PASS_BUDGET_MS`. A tick scoped to one
     * business (Time Travel, verify suites) always renews inline.
     */
    RENEWAL_FANOUT: z.enum(["TRUE", "FALSE"]).default("FALSE"),
    /** Jobs queued per business per tick — the fair share that stops one business starving the rest. */
    RENEWAL_FANOUT_PER_BUSINESS: z.coerce.number().int().positive().default(6000),
    /**
     * Renewal jobs kept queued across all businesses: a minute of work at 100/s. Every job
     * lookup scans the queue, so a deeper backlog costs Postgres CPU and renews nothing sooner.
     */
    RENEWAL_FANOUT_LIMIT: z.coerce.number().int().positive().default(6000),
    /**
     * TRUE: a fanned-out renewal commits its invoice unnumbered; `number_invoices` numbers a
     * business's waiting invoices in batches and queues their collection. Lifts the per-business
     * ceiling the invoice counter sets (one lock per batch, not per renewal).
     */
    RENEWAL_BATCH_NUMBERING: z.enum(["TRUE", "FALSE"]).default("FALSE"),
    /** Invoices numbered per counter update. */
    INVOICE_NUMBER_BATCH: z.coerce.number().int().positive().max(5000).default(1000),

    /**
     * How many outbox rows — emails or webhook deliveries — may be IN FLIGHT at once.
     *
     * Defaults to 1, the serial behaviour it replaces, for the same reason
     * `TICK_RENEWAL_CONCURRENCY` does: these passes talk to machines we do not own, and a
     * default that multiplies that traffic is not a change a deployment opted into.
     *
     * ⚠️ Raising this WITHOUT the fair-share fix would have bought nothing — `fairShareFor`
     * (platform/clock.ts) is what removed the 50-rows-per-business ceiling on the SCAN, and
     * until that landed the pass could not see row 51 whatever the loop did.
     *
     * ── WHAT BINDS, AND IT IS NOT US ────────────────────────────────────────────────────
     * The relay, every time. An SES account starts around 14 sends/second and says so in its
     * own console; an SMTP relay caps concurrent connections; a webhook subscriber's server
     * is whatever it is. All of those are lower than anything this process imposes. And
     * sending volume a domain has never sent before is a DELIVERABILITY problem — reputation,
     * not capacity — which no amount of concurrency here solves and some of it worsens.
     * Check the account's stated limit before raising this; the circuit breaker will absorb
     * the 429s but a throttled relay is still mail arriving late.
     *
     * Ordering: parallel delivery means a subscriber can receive `invoice.paid` before
     * `invoice.created`. Stripe does not guarantee webhook order either, and
     * the delivery rows carry their event ids, but a subscriber that ASSUMED order will
     * notice. If that ever matters, shard on the endpoint rather than lowering this.
     */
    TICK_EGRESS_CONCURRENCY: z.coerce.number().int().positive().max(100).default(1),

    /**
     * Size of this process's Postgres connection pool.
     *
     * Was a hardcoded `max: 10` in `platform/db.ts`, which was invisible from the one place
     * anybody tunes capacity and is now the fourth thing that binds when concurrency rises.
     * The gateway call happens OUTSIDE the transaction, so a renewal holds a connection only
     * for its short writes rather than across a 600ms round trip — but 20 renewals in flight
     * still collide on a pool of 10, and the symptom is queueing inside the driver, which
     * looks exactly like a slow gateway and is not visible in `gateway_request_logs`.
     *
     * Default unchanged at 10. Raise it WITH `TICK_RENEWAL_CONCURRENCY` /
     * `TICK_EGRESS_CONCURRENCY`, not instead of them, and remember every process gets its
     * own pool: the API, each worker, the importer and every verify suite draw on the same
     * `max_connections` (Postgres ships with 100), so this is a number to raise deliberately
     * rather than generously.
     */
    DB_POOL_MAX: z.coerce.number().int().positive().max(200).default(10),

    /**
     * Whether the egress scan's per-business share is DERIVED from how many businesses have
     * work due, instead of the fixed `TICK_FAIR_SHARE_PER_BUSINESS`.
     *
     * **Defaults to FALSE, so a deploy changes nothing.** The dynamic share is a bug fix —
     * the fixed cap contradicted its own documented promise that "a business alone in the
     * queue is not slowed by it" — but it is still a behaviour change, and one with a visible
     * side effect: a larger share means `picked.length` reaches `TICK_SCAN_LIMIT` where it
     * previously could not, so a pass that was quietly under-serving a tenant starts
     * reporting `capped: true` honestly. `deploy/README.md` treats a pass capping every
     * minute as an alerting signal, so switching this on unannounced would page someone for
     * a condition that was always true and merely unreported.
     *
     * Turn it on together with `TICK_EGRESS_CONCURRENCY`: on its own it selects more rows
     * that a serial loop has no budget to send, which buys nothing and only makes `capped`
     * fire sooner.
     */
    TICK_FAIR_SHARE_DYNAMIC: z.enum(["TRUE", "FALSE"]).default("FALSE"),
    /**
     * Postgres `statement_timeout` (ms) for this process's connections. Unset by
     * default: the API, the importer and the verify suites legitimately run long
     * queries, and a global cap would break them. Set it for the WORKER process
     * (see `pnpm worker`), where a query that never returns means a tick that never
     * ends and a shutdown that cannot drain.
     */
    PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().optional(),

    /**
     * Stop calling an outbound dependency that is not answering
     * (`platform/circuit-breaker.ts`).
     *
     * ON by default, which is the unusual direction for a new guard and is deliberate.
     * The failure it prevents is not hypothetical: it is the 2026-09-01 incident, where
     * a timeout, a retry backoff and a pass budget all worked exactly as written and the
     * billing clock still fell three days behind. Off by default would mean every
     * deployment inherits that failure until someone reads a changelog.
     *
     * The kill switch exists for one honest reason: a breaker SUPPRESSES SENDS, so a
     * misclassified error would silence mail that should have gone out. Set FALSE and
     * every attempt is made exactly as it was before.
     */
    CIRCUIT_BREAKER_ENABLED: z
      .enum(["TRUE", "FALSE"])
      .default("TRUE")
      .transform((v) => v === "TRUE"),

    /**
     * Consecutive TRANSPORT faults before a dependency is cut off.
     *
     * 3, not 1: a single connect timeout is ordinary internet weather, and opening on it
     * would add a cooldown to every transient blip. Three in a row against the same host,
     * with any success resetting the count, is a host that is genuinely not there. The cost
     * of the threshold is bounded and small — three timeouts, once per cooldown.
     */
    CIRCUIT_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),

    /**
     * How long to wait before letting ONE probe through, after the breaker opens.
     *
     * 60s to start. Short enough that a relay coming back is noticed within a minute — the
     * breaker must not become the reason mail is late — and long enough that a dead host
     * costs one attempt per minute instead of one per message.
     */
    CIRCUIT_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(60_000),

    /**
     * Ceiling for the doubling cooldown.
     *
     * The wait doubles on each failed probe, so a host that stays down backs off to this and
     * stops there: 15 minutes turns a day-long outage into roughly a hundred attempts rather
     * than the ~17,000 the same volume of mail would otherwise produce. Capped rather than
     * unbounded because a recovered host must never wait hours to be noticed.
     */
    CIRCUIT_BREAKER_MAX_COOLDOWN_MS: z.coerce.number().int().positive().default(900_000),

    /**
     * First wait before re-asking the gateway about a settlement it has not resolved.
     *
     * One tick. The sweep's first poll after a charge passes its rail grace period is still
     * immediate — only a REPEAT of an unchanged answer is deferred — so this is the gap
     * between the first fruitless poll and the second, and 60s means a charge that settles
     * right after we looked is still noticed on the next tick.
     */
    SETTLEMENT_POLL_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(60_000),

    /**
     * Ceiling for the doubling settlement poll.
     *
     * The wait doubles per fruitless poll and stops here, so a charge the gateway calls
     * `pending` indefinitely costs one question an hour instead of 1,440 a day. Measured on
     * dev 2026-09-02: 103 such rows were 6,180 polls an hour and 98% of every tick; at this
     * ceiling the same rows cost ~103 an hour, and they reach it after about six fruitless
     * polls (~2 hours).
     *
     * Capped rather than unbounded for the same reason the breaker's cooldown is: the
     * settlement webhook is the primary path and this sweep is the backstop, but a backstop
     * that waits half a day is not one. An hour bounds how late a missed webhook can be
     * noticed.
     */
    SETTLEMENT_POLL_MAX_BACKOFF_MS: z.coerce.number().int().positive().default(3_600_000),

    /**
     * Most rows ONE business may take from an egress pass.
     *
     * Both outboxes drained `order by next_attempt_at` across a global scan, with no notion
     * of whose work it was. That is FIFO, and FIFO is how one tenant starves the rest: a
     * business whose relay is down accumulates the OLDEST due rows, so it sorts to the front
     * of every pass and pushes every other business's invoices behind it. Measured
     * 2026-09-01 — one business held 3,095 of the 7,654 due messages, all of them older than
     * anyone else's, on a scan capped at 500.
     *
     * 50, against a `TICK_SCAN_LIMIT` of 500: no tenant can take more than a tenth of a pass,
     * and ten busy tenants still fill it. Raising it toward the scan limit restores the old
     * behaviour; lowering it favours breadth over throughput for any single tenant.
     *
     * This is a SHARE, not a rate limit — a business alone in the queue is not slowed by it,
     * because the pass simply comes round again a minute later with the same cap and no
     * competition.
     */
    TICK_FAIR_SHARE_PER_BUSINESS: z.coerce.number().int().positive().default(50),

    /**
     * How long a job may hold its lock before the ops page calls it ABANDONED rather than
     * running.
     *
     * The distinction is the one that matters most on that page: a locked job whose worker
     * is gone blocks every job behind it on a named queue, and reporting it as "running" is
     * what let the 2026-08-29 outage read as healthy for 46 minutes.
     *
     * It used to be judged on `attempts >= max_attempts` instead, which was wrong in a way
     * that inverted the alarm — graphile increments `attempts` when it LOCKS a job, so any
     * job with `max_attempts = 1` (the billing tick, every cron line here) matched for the
     * whole of its healthy life and was reported abandoned once a minute, forever.
     *
     * 5 minutes: an order of magnitude above the slowest legitimate job in this system
     * (`ops_invariants` at ~20 s, a sweep bounded by TICK_BUDGET_MS at 45 s), and far below
     * graphile's own 4-hour lock timeout, which is safe but far too slow to catch an outage
     * while it is happening. Matches `TICK_ABANDONED_AFTER_MS`, which makes the same
     * judgement about an unfinished `clock_ticks` row.
     */
    JOB_ABANDONED_AFTER_MS: z.coerce.number().int().positive().default(300_000),

    /**
     * Wall-clock budget for the WHOLE sweep, drawn down by each pass in turn.
     *
     * `TICK_PASS_BUDGET_MS` above bounds one pass; this bounds the tick, and the difference
     * is the one that actually mattered on 2026-09-01. Twenty-two passes each individually
     * within their own budget still add up to a sweep that outlives its 60s cadence — at the
     * 90s that budget used to be, a theoretical thirty-three-minute tick — and once a sweep
     * outlives its cadence the queue can only grow. No per-pass number can prevent that,
     * because the failure is in the sum.
     *
     * 45s against a 60s interval: enough headroom that an ordinary sweep never notices, and
     * a hard stop before the next one is due. A sweep that hits it records the passes it did
     * not reach as `skipped`, and since passes run in priority order those are always the
     * most deferrable — never renewals.
     */
    TICK_BUDGET_MS: z.coerce.number().int().positive().default(45_000),
  })
  .superRefine((cfg, ctx) => {
    // `CLOUD_LOGGING=TRUE` with no project id would boot a service that believes it
    // is shipping logs and ships none — the failure you discover during the incident
    // you have no logs for. Refuse instead.
    if (cfg.CLOUD_LOGGING === "TRUE" && !cfg.GOOGLE_CLOUD_PROJECT_ID) {
      ctx.addIssue({
        code: "custom",
        path: ["GOOGLE_CLOUD_PROJECT_ID"],
        message: "GOOGLE_CLOUD_PROJECT_ID is required when CLOUD_LOGGING=TRUE",
      });
    }

    // Google sign-in is all-or-nothing. A deployment holding a client id but no secret
    // (or no redirect URI) would render the button, send the operator to Google, and then
    // fail the callback with an error they cannot act on — the same "believes it is
    // configured and is not" failure the CLOUD_LOGGING guard above exists to prevent.
    // Refuse to boot instead. Set all three, or none.
    {
      const google = [
        ["GOOGLE_CLIENT_ID", cfg.GOOGLE_CLIENT_ID],
        ["GOOGLE_CLIENT_SECRET", cfg.GOOGLE_CLIENT_SECRET],
        ["GOOGLE_REDIRECT_URI", cfg.GOOGLE_REDIRECT_URI],
      ] as const;
      const set = google.filter(([, v]) => v);
      if (set.length > 0 && set.length < google.length) {
        const missing = google.filter(([, v]) => !v).map(([k]) => k);
        ctx.addIssue({
          code: "custom",
          path: ["GOOGLE_CLIENT_ID"],
          message:
            `Google sign-in is partly configured — missing ${missing.join(", ")}. ` +
            `Set all three or none; a half-configured provider renders a button that cannot work.`,
        });
      }
    }

    // HubSpot, same rule: a client id without its secret renders "Connect HubSpot" and then
    // fails the token exchange after the merchant has already approved the install.
    {
      const hubspot = [
        ["HUBSPOT_CLIENT_ID", cfg.HUBSPOT_CLIENT_ID],
        ["HUBSPOT_CLIENT_SECRET", cfg.HUBSPOT_CLIENT_SECRET],
        ["HUBSPOT_REDIRECT_URI", cfg.HUBSPOT_REDIRECT_URI],
      ] as const;
      const set = hubspot.filter(([, v]) => v);
      if (set.length > 0 && set.length < hubspot.length) {
        const missing = hubspot.filter(([, v]) => !v).map(([k]) => k);
        ctx.addIssue({
          code: "custom",
          path: ["HUBSPOT_CLIENT_ID"],
          message: `HubSpot is partly configured — missing ${missing.join(", ")}. Set all three or none.`,
        });
      }
    }

    // A production deployment must NOT silently fall back to the API_KEY_SECRET-
    // derived gateway credential key: real gateway secrets deserve a real key.
    if (cfg.NODE_ENV === "production" && (cfg.GATEWAY_CREDENTIALS_KEY?.length ?? 0) < 32) {
      ctx.addIssue({
        code: "custom",
        path: ["GATEWAY_CREDENTIALS_KEY"],
        message: "GATEWAY_CREDENTIALS_KEY (min 32 chars) is required in production",
      });
    }

    /**
     * PRODUCTION SECURITY FLOOR (2026-08-29, audit follow-up).
     *
     * The settings below each default to their LEAST-SECURE value, and each default is
     * correct for the reason its own comment gives — a developer's laptop has no proxy in
     * front of it, and a test suite must not reach HIBP over the network. The problem is
     * that a real host inherits the same defaults by saying nothing, so a control that was
     * built, reviewed and merged protects nobody, with no error and no log line. That is
     * the shape of SR-2026-008 Finding 2, restated: the dangerous state is the SILENT one.
     *
     * So the dev-friendly defaults stay, and production stops being allowed to accept them
     * by default. This is deliberately a BOOT FAILURE rather than a warning: a warning at
     * startup is read once, by whoever is watching the first deploy, and never again.
     *
     * Extends the same pattern as the GATEWAY_CREDENTIALS_KEY check above, which already
     * decided that a missing security-relevant setting is a failed deploy and not a quiet
     * weakening. This block is that decision applied to the rest of them.
     */
    if (cfg.NODE_ENV === "production") {
      /**
       * Read from `process.env`, not `cfg`: the schema defaults this to 0, so the parsed
       * value cannot tell "the operator stated zero" from "nobody said anything". Those two
       * must not be treated alike here — 0 is a legitimate ANSWER (the socket really does
       * face the internet) but never a legitimate GUESS, because when it is wrong every
       * per-IP limit silently collapses into ONE bucket holding the proxy's address: the
       * whole internet then shares one login allowance, and `login_attempts` records the
       * proxy for every row. Requiring the statement is the only way to tell the two apart.
       */
      if (process.env.TRUST_PROXY_HOPS === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["TRUST_PROXY_HOPS"],
          message:
            "TRUST_PROXY_HOPS must be set explicitly in production — it is a fact about the " +
            "deployment, not a preference. 0 = this socket faces the internet directly; 1 = one " +
            "reverse proxy (the deploy/README.md shape — one nginx). Count the hops you actually " +
            "operate: too LOW attributes every caller to the proxy and merges all per-IP limits " +
            "into one bucket, too HIGH believes a hop the client can forge, which is audit H3.",
        });
      }

      // Already an opt-OUT that defaults to safe, so this cannot fire by omission — only by
      // someone carrying a local `.env` line onto a real host, which is exactly the mistake
      // worth refusing. HSTS and the cookie `Secure` flag both read `secureTransport()`, so
      // this one variable silently disarms both at once.
      if (cfg.ALLOW_INSECURE_COOKIES === "TRUE") {
        ctx.addIssue({
          code: "custom",
          path: ["ALLOW_INSECURE_COOKIES"],
          message:
            "ALLOW_INSECURE_COOKIES=TRUE is refused in production: it strips `Secure` from every " +
            "session cookie and suppresses HSTS. Unset it, or serve over HTTPS.",
        });
      }

      /**
       * The local common-password list always runs; this is the HIBP corpus on top. Its
       * default is FALSE to keep the suites hermetic — the right long-term fix is to inject
       * a stub in tests rather than carry a production switch, and until that lands this
       * guard makes the switch impossible to forget where it matters. The check already
       * fails OPEN, so an unreachable HIBP degrades a password reset rather than blocking it.
       */
      if (cfg.PASSWORD_BREACH_CHECK !== "TRUE") {
        ctx.addIssue({
          code: "custom",
          path: ["PASSWORD_BREACH_CHECK"],
          message:
            "PASSWORD_BREACH_CHECK must be TRUE in production. k-anonymity means only the first " +
            "five hex characters of the SHA-1 leave this process, no API key is needed, and the " +
            "lookup fails open — so there is no deployment-shaped reason to run without it.",
        });
      }

      /**
       * Cloud logging is MANDATORY in production (operator decision, 2026-08-29).
       *
       * `CLOUD_LOGGING` defaults to FALSE for the same dev-friendly reason as the settings
       * above — a laptop has no service account and a test suite must not ship to Google.
       * And, exactly as above, a real host inherits that default by saying nothing: it
       * boots, serves, and ships NOTHING, with no error anywhere. You discover it during
       * the incident you have no logs for, which is the sentence already written over the
       * `GOOGLE_CLOUD_PROJECT_ID` guard at the top of this block. This is that guard's
       * other half — that one catches "on but misconfigured", this one catches "never
       * turned on at all".
       *
       * ── THIS DOES NOT CONTRADICT "LOSING LOGS MUST NEVER BECOME LOSING BILLING" ──────
       * That principle governs RUNTIME and is untouched: an unreachable sink still logs
       * `[cloud-logging] write failed` to stdout and keeps serving, a full queue still
       * drops entries and says how many, and no Google outage can stop a renewal. What is
       * refused here is a CONFIGURATION — a production box that was never told where to
       * send logs — and it fails before the process serves its first request, where the
       * only cost is a deploy that stops and names what is missing.
       *
       * A boot failure rather than a warning, for the reason this block already gives:
       * a warning at startup is read once, by whoever is watching the first deploy, and
       * never again.
       *
       * It also carries the alerting: a `page` reaches a human by way of the log sink — so a production
       * deployment with logging off has monitoring that cannot notify anyone, which looks
       * exactly like a system with nothing to report.
       */
      //
      // Cloud only (2026-10-25). A self-hosted production deployment must STATE the setting
      // (TRUE or FALSE), read from `process.env` like TRUST_PROXY_HOPS: silence is refused,
      // an answer is not. Self-hosters keep logs through their own log driver.
      if (cfg.TMBILLING_EDITION !== "cloud") {
        if (process.env.CLOUD_LOGGING === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["CLOUD_LOGGING"],
            message:
              "CLOUD_LOGGING must be set explicitly in production: TRUE ships logs to Google " +
              "Cloud Logging (also set GOOGLE_CLOUD_PROJECT_ID), FALSE keeps them on stdout for " +
              "your own log driver. Alerts reach a human only through a sink you watch.",
          });
        }
      } else if (cfg.CLOUD_LOGGING !== "TRUE") {
        ctx.addIssue({
          code: "custom",
          path: ["CLOUD_LOGGING"],
          message:
            "CLOUD_LOGGING must be TRUE in production. pm2 keeps stdout on the box, which is " +
            "fine until the box is the thing you cannot reach — and the alert evaluator reaches " +
            "a human through the sink, so a deployment without it has monitoring that cannot " +
            "notify anyone. Set CLOUD_LOGGING=TRUE plus GOOGLE_CLOUD_PROJECT_ID and " +
            "GOOGLE_CLOUD_CREDENTIALS_PATH (deploy/README.md § Logs). The sink still degrades " +
            "safely at runtime: an unreachable Google logs to stdout and keeps billing.",
        });
      }

      /**
       * ⚠ MFA_REQUIRED_ROLES is deliberately NOT floored here, and the omission is the
       * decision rather than an oversight. Which roles must carry a second factor is a
       * per-customer policy in a product sold to other organizations — a one-owner account
       * mandated into TOTP with no second admin is one lost phone away from a support
       * ticket nobody can answer. `owner,admin` is the intended value and `.env.example`
       * says so; forcing it at boot would be this file overruling a customer's own risk
       * decision, which the three settings above are not doing.
       */
    }
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast and loud — a billing service must not boot half-configured.
  //
  // These two are the ONLY `console.*` calls left in src/ and must stay: the
  // logger (`platform/logger.ts`) imports THIS module for LOG_LEVEL, so reaching
  // for it here would be a circular import — and there is no valid config to
  // build a logger from anyway. Everything past boot uses `createLogger`.
  console.error("❌ Invalid environment configuration:");
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;

/**
 * Is this deployment served over HTTPS? The single fact behind two controls that must
 * never disagree: the `Secure` attribute on cookies (`api/auth-routes.ts`, and the
 * buyer session the storefront sets) and the `Strict-Transport-Security` header
 * (`platform/security-headers.ts`).
 *
 * They used to be two independent judgements waiting to drift — a deployment that
 * sends HSTS while issuing cookies without `Secure` is telling the browser to enforce
 * a guarantee it is not itself keeping. One function, so that cannot happen.
 */
export const secureTransport = (): boolean => config.ALLOW_INSECURE_COOKIES !== "TRUE";

/**
 * The pinned public id for a gateway key, from `GATEWAY_ACCOUNT_IDS`
 * (`stripe=gwa_…,paypal=gwa_…,razorpay=gw_…`). Returns null when unset or unparseable —
 * a malformed entry must never take down an import, it just falls through to the next
 * id source. See the schema comment above for why pinning matters at all.
 */
export function pinnedGatewayAccountId(gatewayKey: string): string | null {
  const raw = config.GATEWAY_ACCOUNT_IDS;
  if (!raw) return null;
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim().toLowerCase();
    const id = pair.slice(eq + 1).trim();
    if (key === gatewayKey.toLowerCase() && id) return id;
  }
  return null;
}

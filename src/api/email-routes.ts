import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import {
  resolveBusiness,
  notFound,
  badRequest,
  conflict,
  parseListQuery,
  listResponse,
  requirePerm,
  refusedByRateLimit,
} from "./helpers";
import { config } from "@/platform/config";
import { HOUR_WINDOW_MS } from "@/platform/rate-limit";
import {
  listEmailsPage,
  EMAIL_FILTER_OPS,
  EMAIL_SORT_FIELDS,
  getEmail,
  getEmailActivity,
  resendEmail,
  serializeEmail,
} from "@/modules/emails/service";
import {
  getSmtpSettings,
  saveSmtpSettings,
  testSmtpConnection,
  sendTestEmail,
  SmtpConfigError,
} from "@/modules/emails/smtp-service";
import { getSesSettings, saveSesSettings, SesConfigError } from "@/modules/emails/ses-service";
import { listSuppressions, unsuppressAddress } from "@/modules/emails/suppression";
import {
  listTemplates,
  getTemplate,
  upsertTemplate,
  resetTemplate,
  previewTemplate,
  TemplateError,
} from "@/modules/emails/template-service";
import { sendAdhocEmail, AdhocEmailError } from "@/modules/emails/adhoc-service";
import { EMAIL_TYPES, ADHOC_EMAIL_TYPES } from "@/modules/emails/config";
import { REMINDER_LEAD_DAYS } from "@/modules/subscriptions/reminders";
import { resolveReminderConfig } from "@/modules/subscriptions/reminder-config";
import { parseRequest } from "./strict-params";

const smtpSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  host: z.string().max(255).nullable().optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  encryption: z.enum(["tls", "starttls", "none"]).optional(),
  username: z.string().max(255).nullable().optional(),
  // Absent keeps the stored password, '' clears it, a value replaces it — see
  // SmtpSettingsInput. `.optional()` without `.nullable()` on purpose: null and absent
  // would otherwise both arrive as undefined and the distinction would be unreachable.
  password: z.string().max(1024).optional(),
});

const sesSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  region: z.string().max(64).nullable().optional(),
  accessKeyId: z.string().max(128).nullable().optional(),
  configurationSet: z.string().max(255).nullable().optional(),
  // Absent keeps the stored key, '' clears it, a value replaces it — see SesSettingsInput.
  // `.optional()` without `.nullable()` for the same reason as `password` above.
  secretAccessKey: z.string().max(1024).optional(),
});

const BLOCK_KEY = z.enum(["body", "action", "facts", "footer"]);

const layoutSchema = {
  /** This email's own footer; null or "" uses the business footer. */
  footer: z.string().trim().max(20_000).nullable().optional(),
  /** Button text; null or omitted keeps the engine's label. */
  cta_label: z.string().trim().max(60).nullable().optional(),
  show_facts: z.boolean().optional(),
  /** A permutation of body / action / facts / footer; null resets to the default. */
  block_order: z.array(BLOCK_KEY).length(4).nullable().optional(),
};

const templateBodySchema = z.object({
  subject: z.string().trim().min(1).max(500),
  heading: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20_000),
  ...layoutSchema,
});

/** API snake_case → the engine's TemplateDef. Omitted layout keys stay omitted. */
function toDef<
  T extends {
    footer?: string | null;
    cta_label?: string | null;
    show_facts?: boolean;
    block_order?: Array<"body" | "action" | "facts" | "footer"> | null;
  },
>(d: T) {
  const { cta_label, show_facts, block_order, ...rest } = d;
  return {
    ...rest,
    ...(cta_label !== undefined ? { ctaLabel: cta_label } : {}),
    ...(show_facts !== undefined ? { showFacts: show_facts } : {}),
    ...(block_order !== undefined ? { blockOrder: block_order } : {}),
  };
}

const previewSchema = z.object({
  // All optional: an empty body previews what is currently in effect. The editor sends
  // its unsaved draft here so the merchant previews what they are typing, not what is
  // stored — a preview of the saved version would be useless while editing.
  subject: z.string().max(500).optional(),
  heading: z.string().max(200).optional(),
  body: z.string().max(20_000).optional(),
  ...layoutSchema,
});

const testEmailSchema = z.object({
  to: z.string().email().max(320),
  type: z.enum(EMAIL_TYPES as unknown as [string, ...string[]]),
  /** An unsaved editor draft to send instead of the stored template. */
  draft: z
    .object({
      subject: z.string().trim().min(1).max(500),
      heading: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(20_000),
      ...layoutSchema,
    })
    .optional(),
});

/**
 * Operator-initiated send. `type` is restricted to ADHOC_EMAIL_TYPES rather than
 * EMAIL_TYPES: the other twenty are engine-fired and carry variables only the event that
 * produced them can supply, so offering them here would advertise sends that could only
 * ever render half-filled.
 *
 * The three record ids are all optional at the schema level because which one is required
 * depends on `type`; the service resolves that and rejects a missing one by name, which
 * gives a better message than a discriminated union would ("An invoice is required to send
 * an 'invoice_sent' email" vs. a zod union path dump).
 */
const adhocEmailSchema = z.object({
  type: z.enum(ADHOC_EMAIL_TYPES as unknown as [string, ...string[]]),
  customer: z.string().max(64).optional(),
  invoice: z.string().max(64).optional(),
  credit_note: z.string().max(64).optional(),
  to: z.string().email().max(320).optional(),
  note: z.string().max(2000).optional(),
});

/**
 * Customer billing-email log (Tier-1 M13) plus the per-business SMTP transport settings.
 * The log is a read-only inspector + resend, mirroring the gateway request-log routes;
 * emails are produced by the event-driven outbox (src/modules/emails/outbox.ts), so there
 * is no create endpoint — `/emails/test` is an operator diagnostic, not a send API.
 */
export async function registerEmailRoutes(app: FastifyInstance) {
  /**
   * List emails — paginated, filtered and sorted server-side (§3.4 of
   * docs/GUIDE.md). Filters: `id`, `type`, `status`, `to`, `subject`,
   * `created_at`, `customer`.
   *
   * The legacy flat params (`?type=`, `?status=`, `?customer=`) still work —
   * the dashboard's customer/subscription detail pages use them — and are
   * folded into the same filter set.
   */
  app.get(
    "/v1/businesses/:biz/emails",
    { preHandler: [authenticate, requirePerm("emails:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseListQuery(req, reply, {
        includeDeleted: "none",
        filterOps: EMAIL_FILTER_OPS,
        sortFields: EMAIL_SORT_FIELDS,
        bareParams: ["type", "status", "customer"],
      });
      if (!parsed) return;
      const q = req.query as Record<string, string | undefined>;
      const flat: Array<[string, string | undefined]> = [
        ["type", q.type],
        ["status", q.status],
        ["customer", q.customer],
      ];
      for (const [field, value] of flat) {
        if (value) parsed.filters.push({ field, op: "is", value });
      }
      const page = await listEmailsPage(req.organization!.id, business.id, parsed);
      return listResponse(page, serializeEmail);
    },
  );

  /**
   * Send-activity counts for the settings hub, so "is mail actually going out?" is
   * answerable without paging the log. Registered before `/emails/:id` for the same
   * reason as the template routes below.
   *
   * `delivered` and `not_delivered` are separate counts, not one "sent" total — the
   * console sink marks rows sent while delivering nothing, and a single figure would
   * vouch for mail that never left.
   */
  app.get(
    "/v1/businesses/:biz/emails/activity",
    { preHandler: [authenticate, requirePerm("emails:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = req.query as { window_days?: string };
      const parsed = z.coerce
        .number()
        .int()
        .min(1)
        .max(365)
        .default(30)
        .safeParse(q.window_days ?? 30);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const activity = await getEmailActivity(req.organization!.id, business.id, parsed.data);
      if (!activity) return notFound(reply, "Business not found");
      return { object: "email_activity", ...activity };
    },
  );

  /**
   * When each time-relative reminder fires, for this business. Trial, renewal and
   * cancellation come from `reminder_config` (0376); the pre-debit notice is fixed by the
   * mandate rules, so its row says `configurable: false`. `days_before` is the first
   * (largest) lead day, kept for callers that read one number. The payment-due, pause,
   * resume and card-expiry rows can be Off (`lead_days` []).
   */
  app.get(
    "/v1/businesses/:biz/emails/reminders",
    { preHandler: [authenticate, requirePerm("emails:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { leadDays, optional, cardExpiring } = resolveReminderConfig(business);
      const lists: Partial<Record<keyof typeof REMINDER_LEAD_DAYS, number[]>> = {
        trial_ending: leadDays.trial_ending,
        renewal_reminder: leadDays.renewal,
        cancellation_reminder: leadDays.cancellation,
      };
      // Off by default: `lead_days` [] and `days_before` null. Card expiry sends in the expiry
      // month unless it has lead days (`expiry_month` says which).
      const optionalRows: Array<Record<string, unknown>> = (
        [
          ["payment_due_reminder", optional.payment_due],
          ["pause_reminder", optional.pause],
          ["resume_reminder", optional.resume],
          ["card_expiring", Array.isArray(cardExpiring) ? cardExpiring : []],
        ] as const
      ).map(([type, list]) => ({
        type,
        days_before: list[0] ?? null,
        lead_days: [...list],
        configurable: true,
        ...(type === "card_expiring" ? { expiry_month: !Array.isArray(cardExpiring) } : {}),
      }));
      return {
        object: "email_reminder_schedule",
        configurable: true,
        data: [
          ...(Object.keys(REMINDER_LEAD_DAYS) as Array<keyof typeof REMINDER_LEAD_DAYS>).map(
            (type) => {
              const list = lists[type] ?? [REMINDER_LEAD_DAYS[type]];
              return {
                type,
                days_before: list[0]!,
                lead_days: list,
                configurable: type in lists,
                // Renewal notice timing depends on the plan: yearly ones have their own list.
                ...(type === "renewal_reminder"
                  ? {
                      yearly_days_before: leadDays.renewal_yearly[0]!,
                      yearly_lead_days: leadDays.renewal_yearly,
                    }
                  : {}),
              };
            },
          ),
          ...optionalRows,
        ],
      };
    },
  );

  app.get(
    "/v1/businesses/:biz/emails/:id",
    { preHandler: [authenticate, requirePerm("emails:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      const row = await getEmail(req.organization!.id, business.id, id);
      if (!row) return notFound(reply, "Email not found");
      return serializeEmail(row);
    },
  );

  app.post(
    "/v1/businesses/:biz/emails/:id/resend",
    {
      preHandler: [authenticate, requirePerm("emails:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      const row = await resendEmail(req.organization!.id, business.id, id);
      if (!row) return notFound(reply, "Email not found");
      if (row === "body_removed")
        return conflict(
          reply,
          "We could not resend this email. We deleted its content after the retention period.",
        );
      return serializeEmail(row);
    },
  );

  // ── Templates ─────────────────────────────────────────────────────────────────
  // Registered BEFORE /emails/:id so intent is obvious to a reader; find-my-way prefers
  // the static segment regardless of order, but relying on that silently would be fragile.

  /** Every type, built-ins included, each flagged `customized`. */
  app.get(
    "/v1/businesses/:biz/emails/templates",
    { preHandler: [authenticate, requirePerm("emails:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      return { object: "list", data: await listTemplates(req.organization!.id, business.id) };
    },
  );

  app.get(
    "/v1/businesses/:biz/emails/templates/:type",
    { preHandler: [authenticate, requirePerm("emails:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { type } = req.params as { type: string };
      try {
        return await getTemplate(req.organization!.id, business.id, type);
      } catch (e) {
        if (e instanceof TemplateError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.put(
    "/v1/businesses/:biz/emails/templates/:type",
    {
      preHandler: [authenticate, requirePerm("emails:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { type } = req.params as { type: string };
      const parsed = parseRequest(templateBodySchema, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        return await upsertTemplate(req.organization!.id, business.id, type, toDef(parsed.data));
      } catch (e) {
        if (e instanceof TemplateError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  /**
   * Reset to the built-in. DELETE because the store is sparse — absence IS "not
   * customised" — so this genuinely removes a row rather than writing defaults into one.
   * Returns the built-in that now applies, so a caller re-renders it without a second GET.
   */
  app.delete(
    "/v1/businesses/:biz/emails/templates/:type",
    {
      preHandler: [authenticate, requirePerm("emails:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { type } = req.params as { type: string };
      try {
        return await resetTemplate(req.organization!.id, business.id, type);
      } catch (e) {
        if (e instanceof TemplateError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  /** Render with sample data. Sends nothing, saves nothing — no idempotency key needed. */
  app.post(
    "/v1/businesses/:biz/emails/templates/:type/preview",
    { preHandler: [authenticate, requirePerm("emails:preview")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { type } = req.params as { type: string };
      const parsed = parseRequest(previewSchema, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        return {
          object: "email_preview",
          ...(await previewTemplate(req.organization!.id, business.id, type, toDef(parsed.data))),
        };
      } catch (e) {
        if (e instanceof TemplateError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // ── SMTP transport settings ───────────────────────────────────────────────────
  // These sit under /emails rather than /settings because they are the transport for
  // this resource, and because the password must never travel through the generic
  // business PATCH — that route echoes what it wrote.

  app.get(
    "/v1/businesses/:biz/emails/smtp",
    { preHandler: [authenticate, requirePerm("emails:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const settings = await getSmtpSettings(req.organization!.id, business.id);
      if (!settings) return notFound(reply, "Business not found");
      return { object: "smtp_settings", ...settings };
    },
  );

  app.patch(
    "/v1/businesses/:biz/emails/smtp",
    {
      preHandler: [authenticate, requirePerm("emails:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(smtpSettingsSchema, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const settings = await saveSmtpSettings(req.organization!.id, business.id, parsed.data);
        if (!settings) return notFound(reply, "Business not found");
        return { object: "smtp_settings", ...settings };
      } catch (e) {
        if (e instanceof SmtpConfigError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  /**
   * Handshake + authenticate against the configured relay. Not idempotency-keyed: it
   * writes nothing, and an operator retrying a connection test wants a fresh answer,
   * which is exactly what a replayed cached response would deny them.
   */
  app.post(
    "/v1/businesses/:biz/emails/smtp/test-connection",
    { preHandler: [authenticate, requirePerm("emails:manage")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      try {
        return {
          object: "smtp_connection_test",
          ...(await testSmtpConnection(req.organization!.id, business.id)),
        };
      } catch (e) {
        if (e instanceof SmtpConfigError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // ── SES transport settings ────────────────────────────────────────────────────
  // The SES half of the same choice, alongside /emails/smtp rather than replacing it: a
  // business runs one transport, and enabling either switches the other off (see
  // saveSesSettings). Separate routes because the two carry different credentials and a
  // shared body would make "which fields did you mean to clear?" ambiguous.

  app.get(
    "/v1/businesses/:biz/emails/ses",
    { preHandler: [authenticate, requirePerm("emails:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const settings = await getSesSettings(req.organization!.id, business.id);
      if (!settings) return notFound(reply, "Business not found");
      return { object: "ses_settings", ...settings };
    },
  );

  app.patch(
    "/v1/businesses/:biz/emails/ses",
    {
      preHandler: [authenticate, requirePerm("emails:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(sesSettingsSchema, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const settings = await saveSesSettings(req.organization!.id, business.id, parsed.data);
        if (!settings) return notFound(reply, "Business not found");
        return { object: "ses_settings", ...settings };
      } catch (e) {
        if (e instanceof SesConfigError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // ── Suppression list ──────────────────────────────────────────────────────────
  // Addresses this business must not write to again, after a hard bounce or a complaint.
  // Exposed because an invisible block is its own failure mode: "we stopped emailing this
  // customer and nobody can say why" is a support call no amount of correct bounce handling
  // excuses. Small by nature, so returned whole rather than paginated.

  app.get(
    "/v1/businesses/:biz/emails/suppressions",
    { preHandler: [authenticate, requirePerm("emails:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const rows = await listSuppressions(req.organization!.id, business.id);
      return {
        object: "list",
        data: rows.map((r) => ({
          object: "email_suppression",
          address: r.address,
          reason: r.reason,
          detail: r.detail,
          created_at: r.createdAt,
        })),
      };
    },
  );

  /**
   * Lift a suppression. A mailbox that was full in March may be fine in June, and a customer
   * who complained may have resubscribed — so this is deliberately reversible rather than a
   * permanent verdict.
   *
   * DELETE on the address itself: the list has no ids of its own because `(business, address)`
   * IS the identity, and inventing a public id would only add a lookup.
   */
  app.delete(
    "/v1/businesses/:biz/emails/suppressions/:address",
    // Idempotency-keyed like every other write in this file. It was the one that was
    // not, and nothing caught it: `verify:idempotency-race`'s coverage check could not
    // resolve a route path in a reformatted file, so all 22 documented exemptions read
    // as unprotected and the verdict was noise. A DELETE reaching the same state twice
    // is a weak excuse for skipping the pair while five sibling writes carry it — the
    // point of the structural lock is that route N+1 cannot ship without it.
    {
      preHandler: [authenticate, requirePerm("emails:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const address = decodeURIComponent((req.params as { address: string }).address);
      const removed = await unsuppressAddress(req.organization!.id, business.id, address);
      if (!removed) return notFound(reply, `${address} is not suppressed for this business`);
      return { object: "email_suppression", address, deleted: true };
    },
  );

  /**
   * Render one email type with sample data and send it now. Idempotency-keyed because it
   * does write (an email_messages row) and does have an outside effect (a real message).
   *
   * A transport failure is reported as `ok: false` with a 200, not a 5xx: the request was
   * handled correctly and the answer — "your relay refused this, here is what it said" —
   * is the useful result, not an error condition of the API.
   */
  app.post(
    "/v1/businesses/:biz/emails/test",
    {
      preHandler: [authenticate, requirePerm("emails:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(testEmailSchema, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const result = await sendTestEmail(req.organization!.id, business.id, {
          to: parsed.data.to,
          type: parsed.data.type as (typeof EMAIL_TYPES)[number],
          ...(parsed.data.draft ? { draft: toDef(parsed.data.draft) } : {}),
        });
        return { object: "email_test", ...result };
      } catch (e) {
        if (e instanceof SmtpConfigError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  /**
   * Send an ad-hoc billing email — the per-record `Email` action. Unlike every
   * other email in the system this one is not produced by the engine, so it is the only
   * create endpoint on this resource.
   *
   * Deliberately NOT gated on `email_config.enabled`: that flag governs automatic mail,
   * and an operator pressing Send has already decided for this one message. See the
   * header of adhoc-service.ts.
   *
   * Same 200-with-`ok:false` contract as `/emails/test` above, for the same reason — a
   * relay refusing the message is an answer, not an API error.
   */
  app.post(
    "/v1/businesses/:biz/emails/send",
    {
      preHandler: [authenticate, requirePerm("emails:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(adhocEmailSchema, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      // `to` may be any address, so the recipient is counted as well as the business.
      const d = parsed.data;
      const target = d.to ?? d.customer ?? d.invoice ?? d.credit_note;
      // Per business: a global recipient key would let one org block another's mail to a customer.
      const recipient = target ? `${business.id}:${target}` : null;
      if (
        await refusedByRateLimit(
          req,
          reply,
          {
            scope: "adhoc_email",
            keys: [
              {
                kind: "resource",
                value: business.id,
                limit: config.RATE_LIMIT_ADHOC_EMAILS_PER_BUSINESS,
              },
              {
                kind: "recipient",
                value: recipient,
                limit: config.RATE_LIMIT_ADHOC_EMAILS_PER_RECIPIENT,
              },
            ],
            windowMs: HOUR_WINDOW_MS,
          },
          "You sent too many emails in one hour. Try again later.",
        )
      )
        return;
      try {
        const result = await sendAdhocEmail(req.organization!.id, business.id, {
          type: parsed.data.type as (typeof ADHOC_EMAIL_TYPES)[number],
          customerId: parsed.data.customer,
          invoiceId: parsed.data.invoice,
          creditNoteId: parsed.data.credit_note,
          to: parsed.data.to,
          note: parsed.data.note,
        });
        return { object: "email_send", ...result };
      } catch (e) {
        if (e instanceof AdhocEmailError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );
}

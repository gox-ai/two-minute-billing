/**
 * Proves the Amazon SES transport.
 *
 * The headline claims under test:
 *   1. `SesMailer` really speaks SESv2 — asserted against a local server that receives the
 *      actual signed HTTP request, not a mock that returns what it was told to. A mocked
 *      client would pass whether or not the adapter can form a valid SendEmail call.
 *   2. Every field of an OutboundEmail survives the crossing: CC/BCC stay distinct, the
 *      display name is RFC-correct, and the idempotency key rides as a header.
 *   3. `classifySesError` never blames a customer's mailbox for our configuration. This is
 *      the one with teeth: `permanent` is written to the database as `bounced`, which this
 *      system defines as "the far side refused this address".
 *   4. `resolveMailer` prefers a business's SES over its SMTP, pools per business, and
 *      re-resolves when settings change.
 *
 * No database and no network: (4) drives resolveMailer with plain row objects, which is all
 * its structural signature needs.
 *
 *   pnpm verify:ses-transport
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  SesMailer,
  classifySesError,
  formatFromAddress,
  MailerSendError,
  type OutboundEmail,
} from "@/providers/mailer";
import { resolveMailer, closeAllMailers, invalidateMailer } from "@/modules/emails/mailer-resolver";
import { writeSesSecret } from "@/modules/emails/ses-config";
import { writeSmtpPassword } from "@/modules/emails/smtp-config";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log("✓", label);
  } else {
    fail++;
    console.log("✗", label, detail ?? "");
  }
}

// ── A minimal SESv2 sink ──────────────────────────────────────────────────────
// Speaks just enough of the SESv2 HTTP/JSON protocol for the AWS SDK to complete a call,
// and records the request body so the test can assert on what actually crossed the wire.
interface Received {
  path: string;
  body: Record<string, unknown>;
  auth: string | undefined;
}

interface Sink {
  endpoint: string;
  received: Received[];
  /** Make the next request fail with this SES error name and message. */
  failNext(name: string, message: string, statusCode?: number): void;
  close(): Promise<void>;
}

async function startSink(): Promise<Sink> {
  const received: Received[] = [];
  let failure: { name: string; message: string; statusCode: number } | null = null;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        /* recorded as {} */
      }
      received.push({ path: req.url ?? "", body, auth: req.headers.authorization });

      if (failure) {
        const f = failure;
        failure = null;
        res.writeHead(f.statusCode, {
          "content-type": "application/json",
          // The SDK reads the error name from this header or from __type in the body.
          "x-amzn-errortype": f.name,
        });
        res.end(JSON.stringify({ __type: f.name, message: f.message }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      // SendEmail is the only call this transport makes now — `GetAccount` went with the
      // connection test, because `ses:GetAccount` is a separate IAM permission a send-only
      // key does not carry.
      res.end(JSON.stringify({ MessageId: "ses-msg-0001" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    received,
    failNext(name, message, statusCode = 400) {
      failure = { name, message, statusCode };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const SAMPLE: OutboundEmail = {
  to: "buyer@example.com",
  from: "billing@acme.test",
  fromName: "Acme Billing",
  replyTo: "support@acme.test",
  cc: ["cc@example.com"],
  bcc: ["archive@acme.test"],
  subject: "Your invoice",
  html: "<p>Invoice</p>",
  text: "Invoice",
  idempotencyKey: "em_test_0001",
};

async function main() {
  const sink = await startSink();
  const mailer = new SesMailer({
    region: "us-east-1",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    configurationSet: "billing-events",
    endpoint: sink.endpoint,
  });

  // ── 1. A real SESv2 send ────────────────────────────────────────────────────
  const res = await mailer.send(SAMPLE);
  ok("send returns the provider message id", res.providerMessageId === "ses-msg-0001", res);
  ok("send reports status sent", res.status === "sent");
  ok("the transport identifies itself as ses", mailer.kind === "ses");

  const sent = sink.received[0];
  ok("the request was signed with SigV4", !!sent?.auth?.startsWith("AWS4-HMAC-SHA256"), sent?.auth);

  const body = sent?.body as {
    FromEmailAddress?: string;
    Destination?: { ToAddresses?: string[]; CcAddresses?: string[]; BccAddresses?: string[] };
    ConfigurationSetName?: string;
    Content?: { Raw?: { Data?: string } };
  };
  ok(
    "From carries the display name",
    body?.FromEmailAddress === "Acme Billing <billing@acme.test>",
    body?.FromEmailAddress,
  );
  ok("To is the recipient", body?.Destination?.ToAddresses?.[0] === "buyer@example.com");
  ok("CC stays in CC", body?.Destination?.CcAddresses?.[0] === "cc@example.com");
  ok(
    "BCC is delivered via the API envelope",
    body?.Destination?.BccAddresses?.[0] === "archive@acme.test",
  );
  ok("the configuration set is applied", body?.ConfigurationSetName === "billing-events");

  /**
   * The message itself is now RAW MIME (Content.Raw), so these assertions read the actual
   * bytes rather than named API fields — which is stricter: it is what the recipient's mail
   * client will parse. The SDK base64-encodes the Uint8Array into JSON.
   */
  const mime = Buffer.from(body?.Content?.Raw?.Data ?? "", "base64").toString("utf8");
  ok(
    "the payload is raw MIME, not Simple content",
    mime.includes("MIME-Version: 1.0"),
    mime.slice(0, 60),
  );
  ok("From is in the MIME headers", /^From: Acme Billing <billing@acme\.test>$/m.test(mime));
  ok("To is in the MIME headers", /^To: buyer@example\.com$/m.test(mime));
  ok("CC is in the MIME headers", /^Cc: cc@example\.com$/m.test(mime));
  ok("reply-to rides the MIME, not the API call", /^Reply-To: support@acme\.test$/m.test(mime));
  ok("subject crosses intact", /^Subject: Your invoice$/m.test(mime));
  ok("html body crosses intact", mime.includes("<p>Invoice</p>"));
  ok("text body crosses intact", mime.includes("Invoice"));
  ok(
    "the idempotency key rides as X-Entity-Ref-ID",
    /^X-Entity-Ref-ID: em_test_0001$/im.test(mime),
  );

  /**
   * THE disclosure guard, and Raw is what made it newly reachable: nodemailer's MailComposer
   * writes a `Bcc:` header for any bcc handed to it, so passing BCC to the composer instead
   * of to SES's Destination would print an internal archive address in the message every
   * customer receives. It must be in the envelope and NOWHERE in the bytes — the same claim
   * `verify:email-transport` makes against a real SMTP conversation (RCPT TO vs DATA).
   */
  ok(
    "BCC appears NOWHERE in the raw message",
    !/archive@acme\.test/i.test(mime),
    mime.match(/^Bcc:.*$/m)?.[0],
  );
  ok("…and no Bcc header is emitted at all", !/^Bcc:/im.test(mime));

  // Empty CC/BCC must be absent, not `[]`.
  await mailer.send({ ...SAMPLE, cc: [], bcc: [], replyTo: null, idempotencyKey: undefined });
  const bare = sink.received[1]?.body as {
    Destination?: Record<string, unknown>;
    Content?: { Raw?: { Data?: string } };
  };
  ok("empty cc is omitted rather than sent as []", !("CcAddresses" in (bare?.Destination ?? {})));
  ok("empty bcc is omitted rather than sent as []", !("BccAddresses" in (bare?.Destination ?? {})));
  const bareMime = Buffer.from(bare?.Content?.Raw?.Data ?? "", "base64").toString("utf8");
  ok("absent reply-to emits no Reply-To header", !/^Reply-To:/im.test(bareMime));
  ok("absent idempotency key emits no ref header", !/^X-Entity-Ref-ID:/im.test(bareMime));

  // ── 1b. Attachments — the reason Raw exists ─────────────────────────────────
  // Billing notifications carry the invoice PDF, and `Content.Simple` cannot carry one
  // at all — which is what forced this transport to Raw.
  const pdf = Buffer.from("%PDF-1.4\nfake invoice bytes\n%%EOF");
  await mailer.send({
    ...SAMPLE,
    attachments: [
      { filename: "invoice-INV-0001.pdf", content: pdf, contentType: "application/pdf" },
    ],
  });
  const withPdf = Buffer.from(
    (sink.received[2]?.body as { Content?: { Raw?: { Data?: string } } })?.Content?.Raw?.Data ?? "",
    "base64",
  ).toString("utf8");
  ok("an attachment is declared as a PDF", /Content-Type: application\/pdf/i.test(withPdf));
  ok("…named as the recipient will see it", /filename=.?invoice-INV-0001\.pdf/i.test(withPdf));
  ok("…marked as an attachment, not inline", /Content-Disposition: attachment/i.test(withPdf));
  ok("…base64 encoded", /Content-Transfer-Encoding: base64/i.test(withPdf));
  // The bytes themselves must survive, not just the headers describing them.
  ok("…and its bytes survive the crossing", withPdf.includes(pdf.toString("base64").slice(0, 40)));
  ok("the body is still present alongside it", withPdf.includes("<p>Invoice</p>"));

  // ── 3. Permanence classification ────────────────────────────────────────────
  // `permanent` becomes `bounced`, i.e. "this ADDRESS was refused". Configuration problems
  // must never claim that — they must stay queued for when the merchant fixes them.
  const cases: [string, string, boolean][] = [
    ["AccountSuspendedException", "account suspended", false],
    ["SendingPausedException", "sending paused", false],
    ["MailFromDomainNotVerifiedException", "domain not verified", false],
    ["NotFoundException", "no such configuration set", false],
    ["TooManyRequestsException", "slow down", false],
    ["LimitExceededException", "limit exceeded", false],
    ["BadRequestException", "malformed", false],
    ["MessageRejected", "Email address is not verified in region US-EAST-1", false],
    ["MessageRejected", "Message rejected: Address blacklisted.", true],
  ];
  for (const [name, message, expected] of cases) {
    const classified = classifySesError({ name, message });
    ok(
      `${name} (${message.slice(0, 28)}…) → permanent=${expected}`,
      classified.permanent === expected,
      classified.permanent,
    );
  }

  // The same claim, end to end through a real failed request rather than a synthetic object.
  sink.failNext("MailFromDomainNotVerifiedException", "Domain acme.test is not verified");
  let thrown: unknown;
  try {
    await mailer.send(SAMPLE);
  } catch (e) {
    thrown = e;
  }
  ok("a failed send throws MailerSendError", thrown instanceof MailerSendError, thrown);
  ok(
    "an unverified sending domain is NOT a customer bounce",
    thrown instanceof MailerSendError && thrown.permanent === false,
  );
  ok(
    "the SES error name is preserved as the code",
    thrown instanceof MailerSendError && thrown.code === "MailFromDomainNotVerifiedException",
    (thrown as MailerSendError)?.code,
  );

  // ── 4. From-address formatting ──────────────────────────────────────────────
  ok("a plain name is used as-is", formatFromAddress("a@b.test", "Acme") === "Acme <a@b.test>");
  ok("no name yields a bare address", formatFromAddress("a@b.test", null) === "a@b.test");
  ok("a blank name yields a bare address", formatFromAddress("a@b.test", "   ") === "a@b.test");
  // Unquoted, the comma would parse as two addresses and the mail would go astray.
  ok(
    "a name containing a comma is quoted",
    formatFromAddress("a@b.test", "Acme, Inc.") === '"Acme, Inc." <a@b.test>',
    formatFromAddress("a@b.test", "Acme, Inc."),
  );
  ok(
    "an embedded quote is escaped",
    formatFromAddress("a@b.test", 'Say "hi"') === '"Say \\"hi\\"" <a@b.test>',
    formatFromAddress("a@b.test", 'Say "hi"'),
  );
  // SES requires 7-bit ASCII headers, so a non-ASCII name must be an RFC 2047 encoded-word.
  ok(
    "a non-ASCII name is RFC 2047 encoded",
    formatFromAddress("a@b.test", "Café") === "=?UTF-8?B?Q2Fmw6k=?= <a@b.test>",
    formatFromAddress("a@b.test", "Café"),
  );

  // ── 5. Per-business resolution ──────────────────────────────────────────────
  // Structural rows: resolveMailer needs no database.
  const sesRow = {
    id: "biz_ses",
    sesConfig: { enabled: true, region: "us-east-1", accessKeyId: "AKIA1", configurationSet: null },
    sesCredentialsEnc: writeSesSecret("secret-1"),
  };
  const resolved = resolveMailer(sesRow);
  ok(
    "a business with SES settings resolves to the SES transport",
    resolved.kind === "ses",
    resolved.kind,
  );
  ok("the same settings resolve to the SAME pooled instance", resolveMailer(sesRow) === resolved);

  // SES wins over SMTP. The database forbids both being enabled, but the resolver must still
  // be deterministic for a row written before that constraint existed.
  const bothRow = {
    ...sesRow,
    id: "biz_both",
    smtpConfig: {
      enabled: true,
      host: "smtp.test",
      port: 587,
      encryption: "starttls",
      username: "u",
    },
    smtpCredentialsEnc: writeSmtpPassword("pw"),
  };
  ok("SES takes precedence over SMTP", resolveMailer(bothRow).kind === "ses");

  const smtpOnly = {
    id: "biz_smtp",
    smtpConfig: {
      enabled: true,
      host: "smtp.test",
      port: 587,
      encryption: "starttls",
      username: "u",
    },
    smtpCredentialsEnc: writeSmtpPassword("pw"),
  };
  ok("a business with only SMTP still resolves to SMTP", resolveMailer(smtpOnly).kind === "smtp");

  // A business brings its own transport or its mail does not leave. Falling through to the
  // deployment relay would send from the platform's domain, fail the merchant's SPF/DKIM, and
  // report success while doing it.
  const none = resolveMailer({ id: "biz_none" });
  ok(
    "a business with NO transport does not get the deployment mailer",
    none.kind === "unconfigured",
    none.kind,
  );
  let refused: unknown;
  try {
    await none.send({ to: "a@b.test", from: "c@d.test", subject: "s", html: "h", text: "t" });
  } catch (e) {
    refused = e;
  }
  ok("…it refuses the send", refused instanceof MailerSendError);
  // Transient: `permanent` becomes `bounced`, which would blame the customer's mailbox for the
  // merchant not having set up a relay.
  ok(
    "…transiently, so the mail stays queued",
    refused instanceof MailerSendError && refused.permanent === false,
  );
  ok(
    "…naming the fix",
    refused instanceof MailerSendError && /SMTP or Amazon SES/.test(refused.message),
  );

  // Platform mail belongs to no tenant and legitimately rides the deployment transport.
  ok(
    "platform mail (no business) still uses the deployment mailer",
    resolveMailer(null).kind === "console",
  );

  // An access key id with no stored secret cannot sign anything. It must refuse rather than
  // build a client that fails later with an opaque signing error.
  ok(
    "SES enabled with no secret refuses rather than silently using the platform relay",
    resolveMailer({
      id: "biz_halfses",
      sesConfig: {
        enabled: true,
        region: "us-east-1",
        accessKeyId: "AKIA1",
        configurationSet: null,
      },
      sesCredentialsEnc: null,
    }).kind === "unconfigured",
  );

  // Changed settings must take effect on the next send, not at the next restart.
  const rotated = { ...sesRow, sesCredentialsEnc: writeSesSecret("secret-2") };
  ok("rotating the secret re-resolves to a NEW instance", resolveMailer(rotated) !== resolved);
  invalidateMailer("biz_ses");
  ok(
    "invalidateMailer drops the cached instance",
    resolveMailer(rotated) !== resolveMailer(sesRow),
  );

  // Switching transports must not collide in the cache.
  const switched = { ...smtpOnly, id: "biz_switch" };
  const asSmtp = resolveMailer(switched);
  const asSes = resolveMailer({ ...switched, ...sesRow, id: "biz_switch" });
  ok(
    "switching SMTP → SES yields a different transport",
    asSmtp.kind === "smtp" && asSes.kind === "ses",
  );

  closeAllMailers();
  mailer.close();
  await sink.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

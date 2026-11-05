/**
 * Proves the email TRANSPORT layer — the half that was previously a stub.
 *
 * The headline claim under test: an email row that says `sent` now also says WHAT sent
 * it, and a business can carry its own SMTP relay. Before this, `MAILER_PROVIDER=console`
 * marked every row sent while delivering nothing, and there was no way to tell from the
 * data that nothing had left the building.
 *
 * A real SMTP conversation is exercised against a throwaway in-process sink server, so
 * "nodemailer is wired correctly" is proven rather than assumed — a mocked transport would
 * pass whether or not the adapter speaks SMTP at all.
 *
 *   pnpm verify:email-transport
 */
import net from "node:net";
import { eq, sql } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { deliverPendingEmails } from "@/modules/emails/outbox";
import {
  setMailer,
  getMailer,
  SmtpMailer,
  MailerSendError,
  classifySmtpError,
  type OutboundEmail,
} from "@/providers/mailer";
import { resolveMailer, closeAllMailers, invalidateMailer } from "@/modules/emails/mailer-resolver";
import { resolveEmailConfig, resolveSender, applySubjectPrefix } from "@/modules/emails/config";
import {
  resolveSmtpConfig,
  readSmtpPassword,
  writeSmtpPassword,
} from "@/modules/emails/smtp-config";
import {
  getSmtpSettings,
  saveSmtpSettings,
  sendTestEmail,
  SmtpConfigError,
} from "@/modules/emails/smtp-service";
import { getEmailActivity } from "@/modules/emails/service";
import { businesses, emailMessages } from "@db/schema";
import { publicId } from "@/platform/ids";
import { asTeamMembers } from "./lib/team-addresses";

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

// ── A minimal SMTP sink ───────────────────────────────────────────────────────
// Speaks just enough of RFC 5321 for nodemailer to complete a delivery, and records
// the envelope + body it received so the test can assert on what actually crossed
// the wire (not on what we asked to be sent).
interface Received {
  from: string;
  to: string[];
  data: string;
}

/**
 * `rejectRcptWith` makes the sink refuse every recipient with a given reply line, which is
 * how a real relay says "no such mailbox" (5xx) or "greylisted" (4xx). Refusing at RCPT TO
 * rather than at DATA matters: that is the stage nodemailer reports as `EENVELOPE`, and it
 * is the classification we actually have to get right.
 */
function startSmtpSink(
  opts: { rejectRcptWith?: string } = {},
): Promise<{ port: number; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = net.createServer((socket) => {
    let inData = false;
    let current: Received = { from: "", to: [], data: "" };
    socket.write("220 localhost ESMTP sink\r\n");
    socket.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (inData) {
        current.data += text;
        // The lone-dot terminator ends the message body.
        if (/\r\n\.\r\n$/.test(current.data)) {
          current.data = current.data.replace(/\r\n\.\r\n$/, "");
          received.push(current);
          current = { from: "", to: [], data: "" };
          inData = false;
          socket.write("250 2.0.0 Ok: queued\r\n");
        }
        return;
      }
      for (const line of text.split("\r\n").filter(Boolean)) {
        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
          // Multi-line greeting; deliberately advertises no AUTH and no STARTTLS, which
          // is what makes `encryption: 'none'` the correct mode for this sink.
          socket.write("250-localhost\r\n250 SIZE 10240000\r\n");
        } else if (upper.startsWith("MAIL FROM")) {
          current.from = line.slice(line.indexOf(":") + 1).trim();
          socket.write("250 2.1.0 Ok\r\n");
        } else if (upper.startsWith("RCPT TO")) {
          if (opts.rejectRcptWith) {
            socket.write(`${opts.rejectRcptWith}\r\n`);
            continue;
          }
          current.to.push(line.slice(line.indexOf(":") + 1).trim());
          socket.write("250 2.1.5 Ok\r\n");
        } else if (upper.startsWith("DATA")) {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (upper.startsWith("QUIT")) {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        } else {
          socket.write("250 2.0.0 Ok\r\n");
        }
      }
    });
    socket.on("error", () => {
      /* client hang-ups are normal here */
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        received,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function newBusiness(name: string) {
  const org = await createOrganization({ name });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: "USD",
    livemode: "test",
  });
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({ emailConfig: { enabled: true } })
      .where(eq(businesses.id, biz.id)),
  );
  return { orgId, bizId: biz.id };
}

async function main() {
  const sink = await startSmtpSink();

  // ── 1. Credentials round-trip through the encryption envelope ───────────────
  const envelope = writeSmtpPassword("Sparrow-Lantern-9134");
  ok(
    "password is stored encrypted, not in plaintext",
    !envelope.includes("Sparrow-Lantern-9134"),
    envelope.slice(0, 24),
  );
  ok(
    "password decrypts back to the original",
    readSmtpPassword(envelope) === "Sparrow-Lantern-9134",
  );

  // ── 2. Settings service: validation, secrecy, tri-state password ────────────
  const { orgId, bizId } = await newBusiness("SMTP Co");

  let threw: Error | null = null;
  try {
    await saveSmtpSettings(orgId, bizId, { enabled: true, host: "127.0.0.1", port: sink.port });
  } catch (e) {
    threw = e as Error;
  }
  ok(
    "enabling SMTP without a password is rejected",
    threw instanceof SmtpConfigError,
    threw?.message,
  );

  const saved = await saveSmtpSettings(orgId, bizId, {
    enabled: true,
    host: "127.0.0.1",
    port: sink.port,
    encryption: "none",
    username: null,
    password: "Sparrow-Lantern-9134",
  });
  ok("settings save reports the password as configured", saved?.password_configured === true);
  ok(
    "settings never echo the password itself",
    !JSON.stringify(saved).includes("Sparrow-Lantern-9134"),
    JSON.stringify(saved),
  );

  // The distinction this exists for: editing an unrelated field must not wipe the secret.
  const afterEdit = await saveSmtpSettings(orgId, bizId, { encryption: "none", port: sink.port });
  ok("omitting password keeps the stored one", afterEdit?.password_configured === true);

  const read = await getSmtpSettings(orgId, bizId);
  ok(
    "read-back reports host/port/encryption",
    read?.host === "127.0.0.1" && read?.port === sink.port && read?.encryption === "none",
    JSON.stringify(read),
  );
  ok(
    "read-back never contains the password",
    !JSON.stringify(read).includes("Sparrow-Lantern-9134"),
  );

  // ── 3. The DB CHECK is the backstop, independent of the service ─────────────
  let dbRejected = false;
  try {
    await systemDb.execute(
      sql`UPDATE businesses SET smtp_config = '{"enabled":true}'::jsonb, smtp_credentials_enc = NULL WHERE id = ${bizId}`,
    );
  } catch {
    dbRejected = true;
  }
  ok("DB CHECK rejects an enabled SMTP config with no credentials", dbRejected);

  // ── 4. Per-business resolution, with no test override installed ─────────────
  setMailer(null);
  const bizRow = await withTenant(orgId, async (tx) => {
    const [b] = await tx.select().from(businesses).where(eq(businesses.id, bizId)).limit(1);
    return b;
  });
  const resolved = resolveMailer(bizRow);
  ok(
    "a business with SMTP settings resolves to the smtp transport",
    resolved.kind === "smtp",
    resolved.kind,
  );
  ok("the same settings resolve to the SAME pooled instance", resolveMailer(bizRow) === resolved);

  const plain = await newBusiness("No SMTP Co");
  // Test mode emails only team members; nobody@ too, so the relay is what refuses it.
  await asTeamMembers(plain.orgId, "nobody@acme.test", "later@acme.test", "payer@example.com");
  const plainRow = await withTenant(plain.orgId, async (tx) => {
    const [b] = await tx.select().from(businesses).where(eq(businesses.id, plain.bizId)).limit(1);
    return b;
  });
  // Was: "falls back to the deployment mailer". It no longer does, deliberately — a business
  // brings its own transport or its customer mail does not leave, because the platform relay
  // would send from the wrong domain and report success while doing it.
  const plainMailer = resolveMailer(plainRow);
  ok(
    "a business with no transport of its own does NOT get the deployment mailer",
    plainMailer.kind === "unconfigured",
    plainMailer.kind,
  );
  let refused: unknown;
  try {
    await plainMailer.send({
      to: "a@b.test",
      from: "c@d.test",
      subject: "s",
      html: "h",
      text: "t",
    });
  } catch (e) {
    refused = e;
  }
  ok("…it refuses the send", refused instanceof MailerSendError);
  // Transient, not permanent: `permanent` would mark the row `bounced`, blaming a customer
  // mailbox for the merchant not having configured a relay.
  ok(
    "…transiently, so the mail stays queued rather than bouncing",
    refused instanceof MailerSendError && refused.permanent === false,
  );
  // Identity against `getMailer()`, NOT `kind === 'console'`, which is what this asserted
  // first and why it went red on a developer machine with `MAILER_PROVIDER=smtp` in `.env`.
  // The claim worth gating is that platform mail (`biz === null`) routes to the DEPLOYMENT
  // transport rather than falling into the `unconfigured` path the four assertions above
  // establish for a business. Which transport the deployment selected is a config question
  // (`config.MAILER_PROVIDER`, console by default), and pinning it here just makes the suite
  // report the tester's `.env` as an engine defect — CI leaves it unset and would never have
  // caught the regression a reader assumes this line covers.
  const platformMailer = resolveMailer(null);
  ok(
    "…and platform mail still routes to the deployment transport",
    platformMailer === getMailer(),
    platformMailer.kind,
  );

  // ── 5. A real SMTP conversation reaches the sink ────────────────────────────
  const direct = new SmtpMailer({ host: "127.0.0.1", port: sink.port, encryption: "none" });
  const sendResult = await direct.send({
    to: "payer@example.com",
    from: "billing@acme.test",
    fromName: "Acme Billing",
    replyTo: "support@acme.test",
    subject: "Transport proof",
    html: "<p>hello</p>",
    text: "hello",
    idempotencyKey: "em_proof",
  });
  direct.close();
  ok(
    "a real SMTP send returns a provider message id",
    !!sendResult.providerMessageId,
    sendResult.providerMessageId,
  );
  const got = sink.received.at(-1);
  ok("the sink received the message", !!got);
  ok(
    "envelope recipient crossed the wire",
    !!got && got.to.some((t) => t.includes("payer@example.com")),
    got?.to,
  );
  ok("display name is on the From header", !!got && /From:.*Acme Billing/.test(got.data));
  ok("reply-to is set", !!got && /Reply-To:.*support@acme\.test/i.test(got.data));
  ok(
    "idempotency key travels as a dedupe header",
    !!got && /X-Entity-Ref-ID:\s*em_proof/i.test(got.data),
  );

  // ── 5b. CC is visible, BCC is NOT ──────────────────────────────────────────
  // The whole point of bcc is that the customer cannot see it. That is a property of
  // the DATA body (no Bcc header) combined with the envelope (an extra RCPT TO), so it
  // can only be checked by reading what crossed the wire — asserting on the object we
  // passed to send() would prove nothing about either.
  const copies = new SmtpMailer({ host: "127.0.0.1", port: sink.port, encryption: "none" });
  await copies.send({
    to: "payer@example.com",
    from: "billing@acme.test",
    cc: ["accounts@acme.test"],
    bcc: ["archive@acme.test"],
    subject: "[Acme] Your invoice",
    html: "<p>hello</p>",
    text: "hello",
  });
  copies.close();
  const cp = sink.received.at(-1);
  ok(
    "cc recipient is in the envelope",
    !!cp && cp.to.some((t) => t.includes("accounts@acme.test")),
    cp?.to,
  );
  ok("cc is disclosed in the headers", !!cp && /^Cc:.*accounts@acme\.test/im.test(cp.data));
  ok(
    "bcc recipient is in the envelope",
    !!cp && cp.to.some((t) => t.includes("archive@acme.test")),
    cp?.to,
  );
  ok(
    "bcc is NOT disclosed in the headers",
    !!cp && !/^Bcc:/im.test(cp.data) && !cp.data.includes("archive@acme.test"),
    cp?.data
      .split("\r\n")
      .filter((l) => /^(To|Cc|Bcc):/i.test(l))
      .join(" | "),
  );
  ok(
    "the subject prefix crossed the wire",
    !!cp && /Subject:.*\[Acme\] Your invoice/.test(cp.data),
  );

  // An empty list must produce NO header — nodemailer renders `Cc: ` for [], and an empty
  // header is not the same as an absent one to every relay.
  const empties = new SmtpMailer({ host: "127.0.0.1", port: sink.port, encryption: "none" });
  await empties.send({
    to: "payer@example.com",
    from: "billing@acme.test",
    cc: [],
    bcc: [],
    subject: "No copies",
    html: "<p>x</p>",
    text: "x",
  });
  empties.close();
  const ec = sink.received.at(-1);
  ok(
    "an empty cc/bcc emits no header at all",
    !!ec && !/^Cc:/im.test(ec.data) && !/^Bcc:/im.test(ec.data),
  );
  ok("an empty cc/bcc leaves one envelope recipient", !!ec && ec.to.length === 1, ec?.to);

  // ── 5c. resolveSender / applySubjectPrefix are what the senders use ─────────
  // These are the single source of the From + copies + prefix rules. They were open-coded
  // in three send paths and a fourth read, and the fourth copy was wrong for two years.
  const withCopies = resolveEmailConfig({
    emailConfig: {
      enabled: true,
      fromAddress: "me@acme.test",
      cc: ["a@acme.test"],
      bcc: ["b@acme.test"],
      subjectPrefix: "[Acme]",
    },
  });
  ok(
    "resolveEmailConfig parses cc/bcc/subjectPrefix",
    withCopies.cc.length === 1 &&
      withCopies.bcc.length === 1 &&
      withCopies.subjectPrefix === "[Acme]",
  );
  ok(
    "applySubjectPrefix prepends once",
    applySubjectPrefix(withCopies, "Invoice") === "[Acme] Invoice",
  );
  ok(
    "applySubjectPrefix is a no-op with no prefix",
    applySubjectPrefix(resolveEmailConfig({ emailConfig: { enabled: true } }), "Invoice") ===
      "Invoice",
  );
  ok(
    "resolveSender carries the copies through",
    resolveSender(withCopies).cc[0] === "a@acme.test" &&
      resolveSender(withCopies).bcc[0] === "b@acme.test",
  );
  // A stored list that predates the cap must be truncated on READ, not trusted.
  const flood = resolveEmailConfig({
    emailConfig: { enabled: true, bcc: Array.from({ length: 40 }, (_, i) => `x${i}@acme.test`) },
  });
  ok(
    "a stored over-long bcc is truncated to the cap on read",
    flood.bcc.length === 10,
    String(flood.bcc.length),
  );
  const dupes = resolveEmailConfig({
    emailConfig: { enabled: true, cc: ["A@acme.test", "a@acme.test ", "a@ACME.test"] },
  });
  ok("cc de-duplicates case-insensitively", dupes.cc.length === 1, JSON.stringify(dupes.cc));

  // ── 5d. Permanent vs transient: a 5xx must NOT be retried ──────────────────
  // Driven through a sink that refuses at RCPT TO, because the classification has to work
  // on what nodemailer actually throws — hand-building an error object would test my
  // assumption about its shape rather than the shape.
  const rude = await startSmtpSink({ rejectRcptWith: "550 5.1.1 No such mailbox" });
  const rudeMailer = new SmtpMailer({ host: "127.0.0.1", port: rude.port, encryption: "none" });
  let permErr: unknown;
  try {
    await rudeMailer.send({
      to: "nobody@acme.test",
      from: "billing@acme.test",
      subject: "s",
      html: "h",
      text: "t",
    });
  } catch (e) {
    permErr = e;
  }
  rudeMailer.close();
  ok("a 5xx refusal throws MailerSendError", permErr instanceof MailerSendError);
  ok(
    "a 5xx refusal is classified PERMANENT",
    permErr instanceof MailerSendError && permErr.permanent === true,
    permErr instanceof MailerSendError
      ? `permanent=${permErr.permanent} code=${permErr.code}`
      : String(permErr),
  );
  ok(
    "the SMTP reply code is carried for the log",
    permErr instanceof MailerSendError && permErr.code === 550,
    permErr instanceof MailerSendError ? String(permErr.code) : "—",
  );

  // Transient side, via the same real path: a 4xx must stay retryable.
  const greylist = await startSmtpSink({ rejectRcptWith: "451 4.7.1 Greylisted, try later" });
  const greyMailer = new SmtpMailer({ host: "127.0.0.1", port: greylist.port, encryption: "none" });
  let tmpErr: unknown;
  try {
    await greyMailer.send({
      to: "later@acme.test",
      from: "billing@acme.test",
      subject: "s",
      html: "h",
      text: "t",
    });
  } catch (e) {
    tmpErr = e;
  }
  greyMailer.close();
  await greylist.close();
  ok(
    "a 4xx refusal is classified TRANSIENT",
    tmpErr instanceof MailerSendError && tmpErr.permanent === false,
    tmpErr instanceof MailerSendError
      ? `permanent=${tmpErr.permanent} code=${tmpErr.code}`
      : String(tmpErr),
  );

  // Bad credentials are a misconfiguration the merchant will fix — the mail must still be
  // in the queue when they do, so EAUTH is transient DESPITE usually being a 535.
  ok(
    "EAUTH is transient even though it is a 5xx",
    classifySmtpError({ code: "EAUTH", responseCode: 535, message: "bad creds" }).permanent ===
      false,
  );
  ok(
    "an unclassifiable error defaults to TRANSIENT (never discard mail on a guess)",
    classifySmtpError(new Error("socket exploded")).permanent === false,
  );

  // ── 5e. The outbox makes a permanent refusal TERMINAL on attempt 1 ─────────
  // The point of the whole change: six retries over six hours against "no such mailbox"
  // achieve nothing and bury the reason under "gave up after 6 attempts".
  await withTenant(plain.orgId, (tx) =>
    tx
      .update(businesses)
      .set({
        smtpConfig: {
          enabled: true,
          host: "127.0.0.1",
          port: rude.port,
          encryption: "none",
          username: null,
        },
        smtpCredentialsEnc: writeSmtpPassword("x"),
      })
      .where(eq(businesses.id, plain.bizId)),
  );
  invalidateMailer(plain.bizId);
  setMailer(null); // let the per-business SmtpMailer resolve, so a REAL socket hits the sink
  const bounceId = publicId("em");
  await withTenant(plain.orgId, (tx) =>
    tx.insert(emailMessages).values({
      publicId: bounceId,
      organizationId: plain.orgId,
      businessId: plain.bizId,
      type: "invoice_issued",
      toAddress: "nobody@acme.test",
      subject: "Bounce me",
      bodyHtml: "<p>hi</p>",
      bodyText: "hi",
      status: "pending",
      nextAttemptAt: new Date(Date.now() - 1000),
    }),
  );
  const bounceRun = await deliverPendingEmails(new Date());
  const [bouncedRow] = await withTenant(plain.orgId, (tx) =>
    tx.select().from(emailMessages).where(eq(emailMessages.publicId, bounceId)).limit(1),
  );
  ok(
    "a permanently refused row is marked bounced, not failed",
    bouncedRow?.status === "bounced",
    bouncedRow?.status,
  );
  ok("it is terminal after ONE attempt", bouncedRow?.attempts === 1, String(bouncedRow?.attempts));
  // NOT `nextAttemptAt === null`: the bounce path deliberately leaves that column alone —
  // what makes the row terminal is the STATUS, since the claim query only takes `pending`.
  // So assert the property that actually matters: a later tick must not touch it again.
  const secondRun = await deliverPendingEmails(new Date());
  const [afterSecond] = await withTenant(plain.orgId, (tx) =>
    tx.select().from(emailMessages).where(eq(emailMessages.publicId, bounceId)).limit(1),
  );
  ok(
    "a later tick does not re-attempt a bounced row",
    afterSecond?.attempts === 1 && secondRun.attempted === 0,
    JSON.stringify({ attempts: afterSecond?.attempts, attempted: secondRun.attempted }),
  );
  ok(
    "the relay reason is recorded",
    !!bouncedRow?.lastError && /550|mailbox/i.test(bouncedRow.lastError),
    bouncedRow?.lastError,
  );
  ok(
    "the transport is recorded on a bounce",
    bouncedRow?.transport === "smtp",
    bouncedRow?.transport,
  );
  ok(
    "deliverPendingEmails reports it as bounced, not failed",
    bounceRun.bounced === 1 && bounceRun.failed === 0,
    JSON.stringify(bounceRun),
  );
  await rude.close();
  invalidateMailer(plain.bizId);

  // The complement, and the guard against "everything bounces": a TRANSIENT failure must
  // still retry. Without this check, a classifier that returned permanent for everything
  // would pass every assertion above while silently discarding recoverable mail.
  setMailer({
    kind: "console",
    /** In-process fake: reaches no network, so it can never be circuit-broken. */
    target: null,
    async send() {
      throw new MailerSendError("greylisted", false, 451);
    },
  });
  const retryId = publicId("em");
  await withTenant(plain.orgId, (tx) =>
    tx.insert(emailMessages).values({
      publicId: retryId,
      organizationId: plain.orgId,
      businessId: plain.bizId,
      type: "invoice_issued",
      toAddress: "later@acme.test",
      subject: "Retry me",
      bodyHtml: "<p>hi</p>",
      bodyText: "hi",
      status: "pending",
      nextAttemptAt: new Date(Date.now() - 1000),
    }),
  );
  const retryRun = await deliverPendingEmails(new Date());
  const [retryRow] = await withTenant(plain.orgId, (tx) =>
    tx.select().from(emailMessages).where(eq(emailMessages.publicId, retryId)).limit(1),
  );
  ok("a transient failure stays pending", retryRow?.status === "pending", retryRow?.status);
  ok(
    "a transient failure is rescheduled",
    !!retryRow?.nextAttemptAt && retryRow.nextAttemptAt > new Date(),
    String(retryRow?.nextAttemptAt),
  );
  ok(
    "a transient failure is not counted as bounced",
    retryRun.bounced === 0,
    JSON.stringify(retryRun),
  );
  setMailer(null);

  // A relay that is not listening must throw, so the outbox retries rather than
  // recording a delivery that never happened.
  const dead = new SmtpMailer({ host: "127.0.0.1", port: 1, encryption: "none", timeoutMs: 1500 });
  let sendThrew = false;
  try {
    await dead.send({ to: "a@b.test", from: "c@d.test", subject: "s", html: "h", text: "t" });
  } catch {
    sendThrew = true;
  }
  dead.close();
  ok("an unreachable relay throws rather than reporting success", sendThrew);

  // ── 6. deliverPendingEmails records the transport it used ───────────────────
  const captured: OutboundEmail[] = [];
  setMailer({
    kind: "console",
    /** In-process fake: reaches no network, so it can never be circuit-broken. */
    target: null,
    async send(msg) {
      captured.push(msg);
      return { providerMessageId: "fake", status: "sent" };
    },
  });
  const rowId = publicId("em");
  await withTenant(plain.orgId, (tx) =>
    tx.insert(emailMessages).values({
      publicId: rowId,
      organizationId: plain.orgId,
      businessId: plain.bizId,
      type: "invoice_issued",
      toAddress: "payer@example.com",
      subject: "Your invoice",
      bodyHtml: "<p>hi</p>",
      bodyText: "hi",
      status: "pending",
      nextAttemptAt: new Date(Date.now() - 1000),
    }),
  );
  await deliverPendingEmails(new Date());
  const [delivered] = await withTenant(plain.orgId, (tx) =>
    tx.select().from(emailMessages).where(eq(emailMessages.publicId, rowId)).limit(1),
  );
  ok("the delivered row is marked sent", delivered?.status === "sent", delivered?.status);
  ok(
    "the delivered row records WHICH transport carried it",
    delivered?.transport === "console",
    delivered?.transport,
  );

  // ── 7. Test send: immediate, recorded, and marked as a test ─────────────────
  const test = await sendTestEmail(plain.orgId, plain.bizId, {
    to: "ops@acme.test",
    type: "payment_receipt",
  });
  ok("test send succeeds through the resolved transport", test.ok, test.error);
  ok("test send reports the transport used", test.transport === "console", test.transport);
  const [testRow] = await withTenant(plain.orgId, (tx) =>
    tx.select().from(emailMessages).where(eq(emailMessages.publicId, test.email_id)).limit(1),
  );
  ok("test send is recorded in the email log", !!testRow);
  ok(
    "test send is labelled [Test] in the subject",
    !!testRow && testRow.subject.startsWith("[Test]"),
    testRow?.subject,
  );
  ok("test send is attached to no customer", testRow?.customerId === null);
  // A test must never be handed to the billing clock — six retries over six hours of an
  // operator's diagnostic is not a retry policy, it is a mail loop.
  ok(
    "test send is terminal, never left pending for the clock",
    testRow?.status !== "pending" && testRow?.nextAttemptAt === null,
    `${testRow?.status}/${testRow?.nextAttemptAt}`,
  );

  let badType = false;
  try {
    await sendTestEmail(plain.orgId, plain.bizId, {
      to: "ops@acme.test",
      type: "not_a_type" as never,
    });
  } catch (e) {
    badType = e instanceof SmtpConfigError;
  }
  ok("an unknown email type is rejected", badType);

  // ── 8. Cache invalidation on settings change ────────────────────────────────
  setMailer(null);
  invalidateMailer(bizId);
  const afterInvalidate = resolveMailer(bizRow);
  ok(
    "invalidating drops the cached instance",
    afterInvalidate !== resolved && afterInvalidate.kind === "smtp",
  );

  // ── The hub's activity counters must know every transport ───────────────────
  // Untested until now, which is how `ses` came to match NEITHER counter: a genuine SES
  // delivery vanished from "N delivered in 30 days" entirely. The claim under test is not
  // just that SES counts — it is that the two buckets PARTITION `sent`, so a transport
  // added later cannot fall between them again.
  {
    const act = await createOrganization({ name: "Activity Org" });
    const actOrg = act.organization.id;
    const actBiz = await createBusiness({
      organizationId: actOrg,
      name: "Activity Biz",
      defaultCurrency: "USD",
      livemode: "test",
    });
    const transports = ["smtp", "esp", "ses", "console", "unconfigured", null] as const;
    await withTenant(actOrg, async (tx) => {
      for (const t of transports) {
        await tx.insert(emailMessages).values({
          publicId: publicId("em"),
          organizationId: actOrg,
          businessId: actBiz.id,
          type: "invoice_issued",
          toAddress: "a@b.test",
          subject: `transport ${t ?? "null"}`,
          bodyHtml: "<p>x</p>",
          bodyText: "x",
          status: "sent",
          transport: t,
          attempts: 1,
          sentAt: new Date(),
        });
      }
    });

    const activity = await getEmailActivity(actOrg, actBiz.id, 30);
    ok("activity: SES counts as DELIVERED", (activity?.delivered ?? 0) === 3, activity);
    ok(
      "activity: console, unconfigured and NULL count as not-delivered",
      (activity?.not_delivered ?? 0) === 3,
      activity,
    );
    // The structural claim: no `sent` row may belong to neither bucket.
    ok(
      "activity: the two buckets partition every sent row",
      (activity?.delivered ?? 0) + (activity?.not_delivered ?? 0) === transports.length,
      activity,
    );
  }

  closeAllMailers();
  await sink.close();

  console.log(`\n${fail === 0 ? "✅" : "❌"} email transport: ${pass} passed, ${fail} failed`);
  await closeDb();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(1);
});

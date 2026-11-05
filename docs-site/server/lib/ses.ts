/**
 * One plain-text email through Amazon SES's HTTPS Query API (SendRawEmail), signed with AWS
 * Signature Version 4. HTTPS on 443 works where a host blocks the SMTP ports (our docs host
 * blocks 465, 587 and 2587). SendRawEmail needs only `ses:SendRawEmail`, the one action AWS's
 * SMTP sending policy grants, so an SMTP user's access key works unchanged. Node's crypto only:
 * no AWS SDK in the docs site.
 */
import { createHash, createHmac } from "node:crypto";

export interface SesMessage {
  region: string;
  keyId: string;
  secret: string;
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  text: string;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: string | Buffer, s: string) =>
  createHmac("sha256", key).update(s, "utf8").digest();

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
/** A header value on one line; non-ASCII text as an RFC 2047 encoded word. */
const word = (s: string) => {
  const flat = s.replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(flat) ? flat : `=?UTF-8?B?${b64(flat)}?=`;
};
/** `Name <a@b.c>` with the display name encoded; a bare address as is. */
const address = (s: string) => {
  const m = /^(.*)<([^<>\s]+)>\s*$/.exec(s.replace(/[\r\n]+/g, " "));
  if (!m) return s.replace(/[\r\n\s]+/g, "");
  const name = m[1].trim().replace(/["\\]/g, "");
  return name ? `${/^[\x20-\x7e]*$/.test(name) ? `"${name}"` : word(name)} <${m[2]}>` : m[2];
};

function mime(m: SesMessage): string {
  const body = b64(m.text).replace(/.{76}/g, "$&\r\n");
  return [
    `From: ${address(m.from)}`,
    `To: ${address(m.to)}`,
    `Reply-To: ${address(m.replyTo)}`,
    `Subject: ${word(m.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

export async function sendWithSes(m: SesMessage, timeoutMs = 10_000): Promise<void> {
  const host = `email.${m.region}.amazonaws.com`;
  const contentType = "application/x-www-form-urlencoded";
  const body = new URLSearchParams({
    Action: "SendRawEmail",
    Version: "2010-12-01",
    "RawMessage.Data": b64(mime(m)),
  }).toString();

  // YYYYMMDDTHHMMSSZ
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const signedHeaders = "content-type;host;x-amz-date";
  const canonical = [
    "POST",
    "/",
    "",
    `content-type:${contentType}\nhost:${host}\nx-amz-date:${amzDate}\n`,
    signedHeaders,
    sha256(body),
  ].join("\n");
  const scope = `${day}/${m.region}/ses/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${m.secret}`, day), m.region), "ses"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");

  const res = await fetch(`https://${host}/`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-amz-date": amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${m.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    // SES explains a refusal in the body (unverified address, sandbox, bad key); never credentials.
    const xml = await res.text().catch(() => "");
    const detail = /<Message>([\s\S]*?)<\/Message>/.exec(xml)?.[1] ?? xml.slice(0, 300);
    throw new Error(`SES ${res.status}: ${detail}`);
  }
}

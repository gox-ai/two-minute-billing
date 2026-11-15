/**
 * verify:email-report — the email delivery report (GET /v1/businesses/:biz/emails/report).
 * Rows are inserted directly, so the suite checks the counting, not the outbox.
 */
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createBusiness, createOrganization } from "@/modules/tenancy/service";
import { getEmailDeliveryReport } from "@/modules/emails/service";
import { businesses, emailMessages } from "@db/schema";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log("✓", label);
  } else {
    fail++;
    console.log("✗", label, detail === undefined ? "" : JSON.stringify(detail));
  }
}

const DAY = 86_400_000;
const { organization: org, secret } = await createOrganization({
  name: `Email report ${Date.now().toString(36)}`,
});
const biz = await createBusiness({
  organizationId: org.id,
  name: "Report Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const other = await createBusiness({
  organizationId: org.id,
  name: "Other Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
// India: UTC+5:30, no daylight saving, so the week boundary is a fixed UTC instant.
await systemDb
  .update(businesses)
  .set({ timezone: "Asia/Kolkata" })
  .where(eq(businesses.id, biz.id));

async function add(
  businessId: string,
  type: string,
  status: string,
  createdAt: Date,
  extra: { transport?: string | null; bounceType?: string | null } = {},
) {
  await systemDb.insert(emailMessages).values({
    publicId: publicId("em"),
    organizationId: org.id,
    businessId,
    type,
    toAddress: "payer@example.com",
    subject: "s",
    bodyHtml: "<p>b</p>",
    bodyText: "b",
    status,
    transport:
      extra.transport === undefined ? (status === "sent" ? "smtp" : null) : extra.transport,
    bounceType: extra.bounceType ?? null,
    createdAt,
  });
}

// Week boundaries in Asia/Kolkata, from the report itself.
const empty = await getEmailDeliveryReport(org.id, biz.id, 2);
ok("an empty business has a report", !!empty && empty.totals.delivered === 0);
ok("two weeks give two weekly rows", empty?.weekly.length === 2, empty?.weekly);
ok("the time zone is the business's", empty?.timezone === "Asia/Kolkata", empty?.timezone);
const prevMonday = Date.parse(`${empty!.from}T00:00:00Z`);
const thisMonday = prevMonday + 7 * DAY;
const IST = 5.5 * 3600_000;
// 00:30 local on this Monday = Sunday 19:00 UTC; 23:30 local on the Sunday before.
const justAfter = new Date(thisMonday - IST + 30 * 60_000);
const justBefore = new Date(thisMonday - IST - 30 * 60_000);

await add(biz.id, "invoice_issued", "sent", justAfter);
await add(biz.id, "invoice_issued", "sent", justAfter, { transport: "ses" });
await add(biz.id, "invoice_issued", "sent", justAfter, { transport: "console" });
await add(biz.id, "invoice_issued", "sent", justAfter, { transport: null });
await add(biz.id, "invoice_issued", "failed", justAfter);
await add(biz.id, "payment_failed", "bounced", justAfter, { bounceType: "permanent" });
await add(biz.id, "payment_failed", "bounced", justAfter, { bounceType: "complaint" });
await add(biz.id, "payment_failed", "sent", justAfter, { bounceType: "transient" });
await add(biz.id, "payment_receipt", "skipped", justAfter);
await add(biz.id, "payment_receipt", "pending", justAfter);
await add(biz.id, "payment_receipt", "sent", justBefore);
// Outside a two-week window, and another business's email.
await add(biz.id, "payment_receipt", "sent", new Date(prevMonday - IST - DAY));
await add(other.id, "invoice_issued", "sent", justAfter);

const r = (await getEmailDeliveryReport(org.id, biz.id, 2))!;
const t = r.totals;
ok(
  "totals: 4 delivered (smtp, ses, a transient bounce, last week's receipt)",
  t.delivered === 4,
  t,
);
ok("totals: 2 not delivered (console and no transport)", t.not_delivered === 2, t);
ok(
  "totals: 1 failed, 1 skipped, 1 waiting",
  t.failed === 1 && t.skipped === 1 && t.pending === 1,
  t,
);
ok("a complaint counts as complained, not bounced", t.complained === 1 && t.bounced === 1, t);
ok("an email before the window is left out", r.weekly.length === 2 && t.delivered === 4, r.weekly);

const [prev, cur] = r.weekly as [(typeof r.weekly)[number], (typeof r.weekly)[number]];
ok("weeks are oldest first", prev.week_start < cur.week_start, r.weekly);
ok(
  "23:30 local on Sunday counts in the week before",
  prev.delivered === 1 && prev.week_start === empty!.from,
  prev,
);
ok("00:30 local on Monday counts in this week", cur.delivered === 3 && cur.failed === 1, cur);

const byType = Object.fromEntries(r.by_type.map((x) => [x.type, x]));
ok(
  "by type: invoice_issued 2 delivered (not the other business's), 2 not delivered, 1 failed",
  byType.invoice_issued?.delivered === 2 &&
    byType.invoice_issued?.not_delivered === 2 &&
    byType.invoice_issued?.failed === 1,
  byType.invoice_issued,
);
ok(
  "by type: payment_failed 1 bounced, 1 complaint, 1 delivered",
  byType.payment_failed?.bounced === 1 &&
    byType.payment_failed?.complained === 1 &&
    byType.payment_failed?.delivered === 1,
  byType.payment_failed,
);
ok("by type: the busiest type comes first", r.by_type[0]?.type === "invoice_issued", r.by_type);
const otherReport = (await getEmailDeliveryReport(org.id, other.id, 2))!;
ok(
  "the other business sees only its own email",
  otherReport.totals.delivered === 1,
  otherReport.totals,
);

// ── API ─────────────────────────────────────────────────────────────────────────
const app = await buildApp({ logger: false });
const get = (q: string) =>
  app.inject({
    method: "GET",
    url: `/v1/businesses/${biz.publicId}/emails/report${q}`,
    headers: { authorization: `Bearer ${secret}` },
  });
const res = await get("");
const body = res.json();
ok("API: 200 with the default of 12 weeks", res.statusCode === 200 && body.weeks === 12, body);
ok("API: object email_delivery_report", body.object === "email_delivery_report");
ok("API: 12 weekly rows", body.weekly?.length === 12);
ok("API: weeks=4 gives 4 rows", (await get("?weeks=4")).json().weekly?.length === 4);
ok("API: weeks=0 → 400", (await get("?weeks=0")).statusCode === 400);
ok("API: weeks=53 → 400", (await get("?weeks=53")).statusCode === 400);
ok("API: weeks=abc → 400", (await get("?weeks=abc")).statusCode === 400);
const missing = await app.inject({
  method: "GET",
  url: `/v1/businesses/biz_XXXXXXXXXXXXXXXXXXXXXXX1/emails/report`,
  headers: { authorization: `Bearer ${secret}` },
});
ok("API: an unknown business → 404", missing.statusCode === 404, missing.statusCode);

await app.close();
await closeDb();
console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) {
  console.log("❌ verify:email-report FAILED");
  process.exit(1);
}
console.log("✅ verify:email-report passed");

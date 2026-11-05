/**
 * Team alerts (0489): each alert fires when on, stays silent when off, reports a fact in one
 * window only, and the daily summary equals the source rows.
 *
 *   pnpm verify:team-alerts
 */
import { eq, sql } from "drizzle-orm";
import { businesses as businessesTable } from "@db/schema";
import { withTenant, closeDb, systemDb } from "@/platform/db";
import {
  createOrganization,
  createBusiness,
  ensureTestTwin,
  updateBusiness,
} from "@/modules/tenancy/service";
import { setMailer, type OutboundEmail } from "@/providers/mailer";
import { publicId } from "@/platform/ids";
import { WORKER_CRONTAB } from "@/platform/jobs";
import {
  customers,
  events,
  invoices,
  paymentMethods,
  payments,
  transactions,
  webhookDeliveries,
  webhookEndpoints,
} from "@db/schema";
import { planTeamAlerts, runTeamAlertsFanout } from "@/modules/team-alerts/fanout";
import { collectDigest, loadAlertBusiness, sendTeamAlert } from "@/modules/team-alerts/service";
import { digestDay } from "@/modules/team-alerts/windows";
import { rowsOf } from "@/modules/metering/usage-sql";
import { config } from "@/platform/config";
import { resolveTeamAlertsConfig } from "@/modules/team-alerts/config";
import {
  confirmTeamAlertRecipient,
  listRecipientStates,
  resendConfirmation,
  syncTeamAlertRecipients,
  TeamAlertRecipientError,
} from "@/modules/team-alerts/recipients";
import { teamAlertRecipients, memberships, users } from "@db/schema";
import { randomUUID } from "node:crypto";

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

const sent: OutboundEmail[] = [];
setMailer({
  kind: "smtp",
  target: null,
  async send(msg) {
    sent.push(msg);
    return { providerMessageId: `p-${sent.length}`, status: "sent" };
  },
});
const take = () => sent.splice(0, sent.length);

// 03:00Z = 08:30 in Asia/Kolkata: the digest hour, and the hour every window is cut from.
const H = new Date("2026-06-10T03:00:00Z");
const NEXT = new Date(H.getTime() + 3_600_000);
const at = (minutesFromH: number) => new Date(H.getTime() + minutesFromH * 60_000);

const org = await createOrganization({ name: "Alerts Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Fernhill Alerts",
  defaultCurrency: "USD",
  livemode: "live",
  timezone: "Asia/Kolkata",
});
const quiet = await createBusiness({
  organizationId: orgId,
  name: "Quiet Biz",
  defaultCurrency: "USD",
  livemode: "live",
});

// Unique per run: the confirmation send limit counts per address across businesses.
const RUN = randomUUID().slice(0, 8);
const OPS = `ops-${RUN}@example.com`;
const FIN = `finance-${RUN}@example.com`;
// The confirmation link needs the dashboard address.
(config as { DASHBOARD_BASE_URL?: string }).DASHBOARD_BASE_URL ??= "https://app.example.com";
const tokenIn = (m: OutboundEmail) =>
  /\/team-alerts\/confirm\/s\/(tar_[A-Za-z0-9_-]+)/.exec(m.text ?? "")?.[1];
const isConfirmMail = (m: OutboundEmail) =>
  m.subject.startsWith("Confirm that you want team alerts");

const fullConfig = {
  recipients: [OPS, FIN],
  overdue: { enabled: true, thresholds: { USD: 100_000 } },
  webhook_failures: { enabled: true },
  daily_digest: { enabled: true },
};
/**
 * Save the config as PATCH does (sync + confirmation mail), then confirm every address
 * through its emailed link, unless `confirm` is false. Confirmation mail is taken off `sent`.
 */
const setConfig = async (businessPublicId: string, cfg: unknown, confirm = true) => {
  const [before] = await systemDb
    .select()
    .from(businessesTable)
    .where(eq(businessesTable.publicId, businessPublicId));
  const b = await updateBusiness(orgId, businessPublicId, { teamAlertsConfig: cfg });
  await syncTeamAlertRecipients({
    organizationId: orgId,
    businessId: b!.id,
    businessName: b!.name,
    before: resolveTeamAlertsConfig(before).recipients,
    after: resolveTeamAlertsConfig(b).recipients,
  });
  const mails = sent.filter(isConfirmMail);
  for (const m of mails) sent.splice(sent.indexOf(m), 1);
  if (confirm) for (const m of mails) await confirmTeamAlertRecipient(tokenIn(m)!);
  return mails;
};

// ── Defaults: nothing configured → nothing planned, every kind off ────────────
{
  const plan = await planTeamAlerts(H, { onlyBusinessId: biz.id });
  ok("an unconfigured business plans no alerts", plan.length === 0, plan);
  const r = await sendTeamAlert({
    organizationId: orgId,
    businessId: biz.id,
    kind: "daily_digest",
    hour: H,
  });
  ok("…and a send for it is refused as off", r === "off", r);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const cust = await withTenant(orgId, async (tx) => {
  const [c] = await tx
    .insert(customers)
    .values({
      organizationId: orgId,
      businessId: biz.id,
      publicId: publicId("cus"),
      company: "Acorn <b>Labs</b>",
    })
    .returning();
  return c!;
});

async function invoice(v: {
  number: string;
  currency?: string;
  amount: bigint;
  due: Date;
  status?: string;
  dunning?: string | null;
}) {
  return withTenant(orgId, async (tx) => {
    const [i] = await tx
      .insert(invoices)
      .values({
        organizationId: orgId,
        businessId: biz.id,
        customerId: cust.id,
        publicId: publicId("inv"),
        number: v.number,
        currency: v.currency ?? "USD",
        subtotalMinor: v.amount,
        totalMinor: v.amount,
        amountDueMinor: v.amount,
        status: v.status ?? "payment_due",
        dunningStatus: v.dunning === undefined ? "in_progress" : v.dunning,
        dueDate: v.due,
      })
      .returning();
    return i!;
  });
}

await invoice({ number: "TA-HIGH", amount: 150_000n, due: at(-90) });
await invoice({ number: "TA-LOW", amount: 50_000n, due: at(-90) });
const partly = await invoice({ number: "TA-PARTPAID", amount: 150_000n, due: at(-90) });
await invoice({ number: "TA-LATER", amount: 200_000n, due: at(-30) });
await invoice({ number: "TA-PAID", amount: 300_000n, due: at(-90), status: "paid", dunning: null });
await invoice({ number: "TA-EUR", currency: "EUR", amount: 999_999n, due: at(-90) });
await invoice({ number: "TA-EARLIER", amount: 500_000n, due: at(-150) });
await withTenant(orgId, (tx) =>
  tx.insert(payments).values({
    organizationId: orgId,
    businessId: biz.id,
    customerId: cust.id,
    invoiceId: partly.id,
    publicId: publicId("pay"),
    status: "succeeded",
    amountMinor: 100_000n,
    currency: "USD",
    providerKey: "tmtest",
  }),
);

const endpoint = await withTenant(orgId, async (tx) => {
  const [e] = await tx
    .insert(webhookEndpoints)
    .values({
      organizationId: orgId,
      businessId: biz.id,
      publicId: publicId("whe"),
      url: "https://hooks.example.com/billing",
      signingSecret: "whsec_test",
      livemode: "live",
    })
    .returning();
  const [ev] = await tx
    .insert(events)
    .values({
      organizationId: orgId,
      businessId: biz.id,
      publicId: publicId("evt"),
      type: "invoice_generated",
      data: {},
    })
    .returning();
  const row = (status: string, last: Date | null, code: number | null) => ({
    organizationId: orgId,
    eventId: ev!.id,
    businessId: biz.id,
    endpointId: e!.id,
    status,
    attempts: 6,
    lastAttemptAt: last,
    lastResponseStatus: code,
  });
  // H reports last attempts in [H−2h, H−1h): -90 and -70. -1 (its `failed` lands after H)
  // is reported at NEXT; -150 belongs to an earlier run.
  await tx
    .insert(webhookDeliveries)
    .values([
      row("failed", at(-90), 500),
      row("failed", at(-70), 502),
      row("failed", at(-150), 500),
      row("failed", at(-1), 503),
      row("pending", at(-80), 500),
      row("delivered", at(-75), 200),
    ]);
  return e!;
});

// Digest day = 2026-06-09 in Asia/Kolkata = [06-08T18:30Z, 06-09T18:30Z).
await withTenant(orgId, (tx) =>
  tx.insert(transactions).values(
    (
      [
        ["payment", "succeeded", 1_000n, "2026-06-09T10:00:00Z"],
        ["payment", "succeeded", 2_500n, "2026-06-09T18:00:00Z"],
        ["payment", "succeeded", 9_000n, "2026-06-09T19:00:00Z"], // next local day
        ["payment", "succeeded", 4_000n, "2026-06-08T18:00:00Z"], // previous local day
        ["payment", "failed", 700n, "2026-06-09T05:00:00Z"],
        ["refund", "succeeded", 300n, "2026-06-09T06:00:00Z"],
      ] as const
    ).map(([type, status, amount, when]) => ({
      organizationId: orgId,
      businessId: biz.id,
      customerId: cust.id,
      publicId: publicId("txn"),
      type,
      status,
      amountMinor: amount,
      currency: "USD",
      occurredAt: new Date(when),
      finalisedAt: new Date(when),
    })),
  ),
);
await withTenant(orgId, (tx) =>
  tx.insert(paymentMethods).values(
    (
      [
        ["card", "valid", 6, 2026],
        ["card", "expiring", 7, 2026],
        ["card", "valid", 8, 2026],
        ["card", "expired", 6, 2026],
        ["upi", "valid", 6, 2026],
      ] as const
    ).map(([type, status, m, y]) => ({
      organizationId: orgId,
      businessId: biz.id,
      customerId: cust.id,
      publicId: publicId("pm"),
      providerKey: "tmtest",
      providerCustomerId: `pc_${publicId("x")}`,
      providerPaymentMethodId: `ppm_${publicId("x")}`,
      type,
      status,
      expMonth: m,
      expYear: y,
    })),
  ),
);

await setConfig(biz.publicId, fullConfig);
await setConfig(quiet.publicId, {
  recipients: [OPS],
  overdue: { enabled: false, thresholds: { USD: 1 } },
  webhook_failures: { enabled: false },
  daily_digest: { enabled: false },
});

// ── Planning ─────────────────────────────────────────────────────────────────
{
  const plan = await planTeamAlerts(H, { onlyBusinessId: biz.id });
  ok(
    "the digest hour plans all three kinds",
    plan
      .map((p) => p.kind)
      .sort()
      .join(",") === "daily_digest,overdue,webhook_failures",
    plan,
  );
  const next = await planTeamAlerts(NEXT, { onlyBusinessId: biz.id });
  ok(
    "the next hour plans no digest",
    next
      .map((p) => p.kind)
      .sort()
      .join(",") === "overdue,webhook_failures",
    next,
  );
  const q = await planTeamAlerts(H, { onlyBusinessId: quiet.id });
  ok("a business with every toggle off plans nothing", q.length === 0, q);
  const ex = await planTeamAlerts(H, { onlyBusinessId: biz.id, excludeBusinessIds: [biz.id] });
  ok("an excluded (time-travelled) business plans nothing", ex.length === 0);

  // A twin created after alerts were set does not copy them; a test business plans nothing.
  await systemDb.delete(businessesTable).where(eq(businessesTable.liveBusinessId, biz.id));
  const twin = await ensureTestTwin(orgId, biz.id);
  ok(
    "a new test twin does not copy team alerts",
    twin.teamAlertsConfig === null,
    twin.teamAlertsConfig,
  );
  await setConfig(twin.publicId, fullConfig);
  const tp = await planTeamAlerts(H, { onlyBusinessId: twin.id });
  ok("a test business with alerts on plans nothing", tp.length === 0, tp);

  const queued: Array<{ task: string; key: string }> = [];
  const r = await runTeamAlertsFanout(
    H,
    async (task, _p, spec) => void queued.push({ task, key: spec.jobKey }),
    {
      onlyBusinessId: biz.id,
    },
  );
  ok(
    "fan-out queues one send per kind",
    r.enqueued === 3 && queued.every((q) => q.task === "team_alert_send"),
  );
  ok(
    "…keyed by kind, business and hour",
    new Set(queued.map((q) => q.key)).size === 3 &&
      queued.every((q) => q.key.endsWith(`${biz.id}:${H.toISOString()}`)),
    queued,
  );
}

// ── Overdue ──────────────────────────────────────────────────────────────────
{
  take();
  const r = await sendTeamAlert({
    organizationId: orgId,
    businessId: biz.id,
    kind: "overdue",
    hour: H,
  });
  const mail = take();
  ok("overdue alert is sent", r === "sent" && mail.length === 1, r);
  const body = mail[0]?.text ?? "";
  ok("…naming the high-value invoice", body.includes("TA-HIGH"));
  ok("…not the one below the limit", !body.includes("TA-LOW"));
  ok("…not the one whose part payment left it below the limit", !body.includes("TA-PARTPAID"));
  ok("…not a paid one", !body.includes("TA-PAID"));
  ok("…not a currency with no limit", !body.includes("TA-EUR"));
  ok("…not one due in another hour", !body.includes("TA-LATER") && !body.includes("TA-EARLIER"));
  ok("…to the first recipient, the rest in CC", mail[0]?.to === OPS && mail[0]?.cc?.join() === FIN);
  ok(
    "…with HTML escaped",
    !!mail[0]?.html.includes("Acorn &lt;b&gt;Labs&lt;/b&gt;") && !mail[0]?.html.includes("<b>Labs"),
  );

  const r2 = await sendTeamAlert({
    organizationId: orgId,
    businessId: biz.id,
    kind: "overdue",
    hour: NEXT,
  });
  const next = take();
  ok(
    "next hour reports the invoice that became overdue then",
    r2 === "sent" && (next[0]?.text ?? "").includes("TA-LATER"),
  );
  ok("…and does not repeat the earlier one", !(next[0]?.text ?? "").includes("TA-HIGH"));
}

// ── Webhook failures ─────────────────────────────────────────────────────────
{
  const r = await sendTeamAlert({
    organizationId: orgId,
    businessId: biz.id,
    kind: "webhook_failures",
    hour: H,
  });
  const mail = take();
  ok("webhook alert is sent", r === "sent" && mail.length === 1, r);
  ok(
    "…counting the two deliveries that failed in the hour",
    !!mail[0]?.subject.includes("2 webhooks"),
    mail[0]?.subject,
  );
  ok(
    "…naming the endpoint and its last response",
    !!mail[0]?.text.includes(endpoint.url) && !!mail[0]?.text.includes("HTTP 502"),
  );
  const r2 = await sendTeamAlert({
    organizationId: orgId,
    businessId: biz.id,
    kind: "webhook_failures",
    hour: NEXT,
  });
  const late = take();
  ok(
    "a failure just before the hour is reported the next hour, not missed",
    r2 === "sent" &&
      late.length === 1 &&
      !!late[0]?.text.includes("HTTP 503") &&
      !!late[0]?.subject.includes("1 webhook"),
    late[0]?.subject,
  );
  const r3 = await sendTeamAlert({
    organizationId: orgId,
    businessId: biz.id,
    kind: "webhook_failures",
    hour: new Date(NEXT.getTime() + 3_600_000),
  });
  ok(
    "the hour after has nothing new to report",
    r3 === "nothing_to_report" && take().length === 0,
    r3,
  );
}

// ── Daily digest ─────────────────────────────────────────────────────────────
{
  const b = (await loadAlertBusiness(orgId, biz.id))!;
  const day = digestDay(H, "Asia/Kolkata")!;
  ok(
    "digest covers the previous local day",
    day.day === "2026-06-09" && day.start.toISOString() === "2026-06-08T18:30:00.000Z",
  );
  const d = await withTenant(orgId, (tx) => collectDigest(tx, b, day));
  const src = await withTenant(orgId, async (tx) => {
    const one = async (q: ReturnType<typeof sql>) =>
      rowsOf<{ v: string | null }>(await tx.execute(q))[0]?.v;
    return {
      collected:
        await one(sql`select sum(amount_minor)::text as v from transactions where business_id = ${biz.id}
        and type = 'payment' and status = 'succeeded'
        and finalised_at >= ${day.start.toISOString()}::timestamptz and finalised_at < ${day.end.toISOString()}::timestamptz`),
      failed:
        await one(sql`select sum(amount_minor)::text as v from transactions where business_id = ${biz.id}
        and type = 'payment' and status in ('failed', 'late_failed')
        and finalised_at >= ${day.start.toISOString()}::timestamptz and finalised_at < ${day.end.toISOString()}::timestamptz`),
      dunning: await one(sql`select count(*)::text as v from invoices where business_id = ${biz.id}
        and status = 'payment_due' and dunning_status in ('in_progress', 'parked')`),
    };
  });
  const collected = d.collected.find((c) => c.currency === "USD");
  ok(
    "collected equals the source rows (3,500 in 2 payments)",
    collected?.amountMinor === 3_500n && collected.count === 2 && src.collected === "3500",
    { d, src },
  );
  const failed = d.failedPayments.find((c) => c.currency === "USD");
  ok(
    "failed equals the source rows (700 in 1)",
    failed?.amountMinor === 700n && failed.count === 1 && src.failed === "700",
  );
  ok("invoices in dunning equal the source rows", String(d.inDunning) === src.dunning, {
    d: d.inDunning,
    src: src.dunning,
  });
  ok(
    "cards expiring this or next month: 2 (not expired, not later, not UPI)",
    d.expiringCards === 2,
    d.expiringCards,
  );

  const r = await sendTeamAlert({
    organizationId: orgId,
    businessId: biz.id,
    kind: "daily_digest",
    hour: H,
  });
  const mail = take();
  ok("digest is sent in the digest hour", r === "sent" && mail.length === 1, r);
  ok("…with the collected figure", !!mail[0]?.text.includes("$35.00"), mail[0]?.text);
  const r2 = await sendTeamAlert({
    organizationId: orgId,
    businessId: biz.id,
    kind: "daily_digest",
    hour: NEXT,
  });
  ok("…and not in any other hour", r2 === "not_due" && take().length === 0, r2);

  // Every top-of-hour instant of a day: exactly one is the digest hour, in every zone.
  for (const tz of [
    "UTC",
    "Asia/Kolkata",
    "America/New_York",
    "Australia/Adelaide",
    "Asia/Kathmandu",
  ]) {
    for (const dayStart of [
      "2026-03-08T00:00:00Z",
      "2026-11-01T00:00:00Z",
      "2026-06-10T00:00:00Z",
    ]) {
      const days = new Set<string>();
      let hits = 0;
      for (let h = -24; h < 48; h++) {
        const d2 = digestDay(new Date(Date.parse(dayStart) + h * 3_600_000), tz);
        if (d2) {
          hits++;
          days.add(d2.day);
        }
      }
      ok(
        `${tz} around ${dayStart.slice(0, 10)}: one digest per local day`,
        hits === days.size && hits === 3,
        { hits, days },
      );
    }
  }
}

// ── Off means off ────────────────────────────────────────────────────────────
{
  await setConfig(biz.publicId, { ...fullConfig, webhook_failures: { enabled: false } });
  const r = await sendTeamAlert({
    organizationId: orgId,
    businessId: biz.id,
    kind: "webhook_failures",
    hour: H,
  });
  ok("a toggle turned off stops an already queued send", r === "off" && take().length === 0, r);
  await setConfig(biz.publicId, { ...fullConfig, recipients: [] });
  const plan = await planTeamAlerts(H, { onlyBusinessId: biz.id });
  ok("no recipients → nothing planned", plan.length === 0, plan);
  await setConfig(biz.publicId, null);
  const r2 = await sendTeamAlert({
    organizationId: orgId,
    businessId: biz.id,
    kind: "overdue",
    hour: H,
  });
  ok("null config → off", r2 === "off" && take().length === 0, r2);
}

// ── Recipients outside the organization confirm first (0495) ─────────────────
{
  const send = () =>
    sendTeamAlert({ organizationId: orgId, businessId: biz.id, kind: "daily_digest", hour: H });
  const OUT = `outside-${RUN}@example.com`;
  // A member of the organization: the user behind the org's own sign-up.
  const member = `member-${RUN}@example.com`;
  const [u] = await systemDb
    .insert(users)
    .values({ publicId: publicId("usr"), email: member, name: "Member" })
    .returning();
  await systemDb.insert(memberships).values({ organizationId: orgId, userId: u!.id, role: "ops" });

  const mails = await setConfig(biz.publicId, { ...fullConfig, recipients: [OUT, member] }, false);
  ok(
    "a non-member gets one confirmation email; a member gets none",
    mails.length === 1 && mails[0]!.to === OUT && !!tokenIn(mails[0]!),
    mails.map((m) => m.to),
  );
  const first = await send();
  const firstMail = take();
  ok(
    "until confirmed, alerts go to the member only",
    first === "sent" && firstMail.length === 1 && firstMail[0]!.to === member && !firstMail[0]!.cc,
    firstMail.map((m) => [m.to, m.cc]),
  );
  const states = await listRecipientStates(orgId, biz.id, [OUT, member]);
  ok(
    "the settings list shows pending and member",
    states[0]?.state === "pending" && states[1]?.state === "member" && !!states[0]?.lastSentAt,
    states,
  );
  await setConfig(biz.publicId, { ...fullConfig, recipients: [OUT] }, false);
  ok(
    "only a pending address on the list → no alert is sent",
    (await send()) === "no_recipients" && take().length === 0,
  );

  const token = tokenIn(mails[0]!)!;
  // An expired link does nothing.
  await systemDb
    .update(teamAlertRecipients)
    .set({ tokenExpiresAt: new Date(Date.now() - 60_000) })
    .where(eq(teamAlertRecipients.email, OUT));
  ok("an expired link is refused", (await confirmTeamAlertRecipient(token)) === false);
  await systemDb
    .update(teamAlertRecipients)
    .set({ tokenExpiresAt: new Date(Date.now() + 3_600_000) })
    .where(eq(teamAlertRecipients.email, OUT));
  ok("a forged link is refused", (await confirmTeamAlertRecipient(`tar_${RUN}x`)) === false);
  ok("the link confirms the address", (await confirmTeamAlertRecipient(token)) === true);
  ok("…once only", (await confirmTeamAlertRecipient(token)) === false);
  const afterConfirm = await send();
  ok(
    "a confirmed address gets alerts",
    afterConfirm === "sent" && take()[0]?.to === OUT,
    afterConfirm,
  );

  // Remove, then add back: it must confirm again.
  await setConfig(biz.publicId, { ...fullConfig, recipients: [member] }, false);
  take();
  const tooSoon = await setConfig(biz.publicId, { ...fullConfig, recipients: [OUT] }, false);
  ok("adding it back within 10 minutes sends no mail (the send limit)", tooSoon.length === 0);
  await setConfig(biz.publicId, { ...fullConfig, recipients: [member] }, false);
  // Eleven minutes later.
  await systemDb
    .update(teamAlertRecipients)
    .set({ lastSentAt: new Date(Date.now() - 11 * 60_000) })
    .where(eq(teamAlertRecipients.email, OUT));
  const readd = await setConfig(biz.publicId, { ...fullConfig, recipients: [OUT] }, false);
  ok("removing and adding an address back sends a new confirmation", readd.length === 1);
  ok("…and it gets no alert until it confirms again", (await send()) === "no_recipients");
  ok("…and the old link does not work", (await confirmTeamAlertRecipient(token)) === false);

  // Send again is rate-limited per address.
  let limited = false;
  try {
    await resendConfirmation({
      organizationId: orgId,
      businessId: biz.id,
      businessName: biz.name,
      recipients: [OUT],
      email: OUT,
    });
  } catch (e) {
    limited = e instanceof TeamAlertRecipientError && e.code === "rate_limited";
  }
  ok(
    "Send again within 10 minutes is refused",
    limited && take().filter(isConfirmMail).length === 0,
  );
  ok("the new link confirms", (await confirmTeamAlertRecipient(tokenIn(readd[0]!)!)) === true);
  await setConfig(biz.publicId, fullConfig);
  take();
}

// ── The schedule ─────────────────────────────────────────────────────────────
{
  const line = WORKER_CRONTAB.split("\n").find((l) => l.includes(" team_alerts_hourly "));
  ok(
    "team_alerts_hourly runs on the hour",
    !!line?.startsWith("0 * * * * team_alerts_hourly"),
    line,
  );
  ok(
    "…on its own lane, no retries, six hours of backfill",
    !!line && /queue=team_alerts\b/.test(line) && /max=1\b/.test(line) && /fill=6h\b/.test(line),
  );
  ok("…with no jobKey (replace mode would drop a pending hour)", !!line && !/jobKey=/.test(line));
}

setMailer(null);
await closeDb();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

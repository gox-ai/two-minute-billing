/**
 * Move gateway webhook registrations to `GATEWAY_WEBHOOK_BASE_URL`.
 *
 *   pnpm gateway:webhooks-move                      # dry run: what would move
 *   pnpm gateway:webhooks-move -- --apply           # move them, one account at a time
 *   pnpm gateway:webhooks-move -- --apply --account gwa_… [--gateway razorpay]
 *
 * Each move is `provisionWebhookEndpoint`: Stripe, PayPal, Razorpay and Square change the
 * URL of the existing registration (same secret); other gateways register the new URL and
 * then remove the old one. The old URL keeps working, so retries in flight still land.
 * Accounts the operator set up by hand are listed: only the operator can change those.
 */
import "dotenv/config";
import { closeDb, systemDb } from "@/platform/db";
import { config } from "@/platform/config";
import { decryptCredentials } from "@/platform/secrets";
import { gatewayDefinition } from "@/providers/gateway-catalog";
import {
  accountNotificationUrl,
  gatewayNotificationUrl,
  gatewayWebhookBaseUrl,
} from "@/providers/notification-url";
import { resolveAdapter } from "@/providers/registry";
import { provisionWebhookEndpoint } from "@/modules/gateway/webhook-endpoint";
import { gatewayAccounts } from "@db/schema";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const onlyAccount = opt("account");
const onlyGateway = opt("gateway");

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "(no host)";
  }
};

async function main() {
  const target = gatewayWebhookBaseUrl();
  if (!config.GATEWAY_WEBHOOK_BASE_URL || !target)
    throw new Error("GATEWAY_WEBHOOK_BASE_URL is not set. There is nothing to move to.");
  console.log(`${apply ? "APPLY" : "DRY RUN"} — target host ${host(target)}\n`);

  const rows = (await systemDb.select().from(gatewayAccounts)).filter(
    (r) =>
      (!onlyAccount || r.publicId === onlyAccount) &&
      (!onlyGateway || r.gatewayKey === onlyGateway) &&
      (gatewayDefinition(r.gatewayKey)?.webhook.secret ?? "none") !== "none",
  );

  const tally = { onTarget: 0, move: 0, stays: 0, manual: 0, unreadable: 0, moved: 0, failed: 0 };
  for (const row of rows) {
    const tag = `${row.publicId} ${row.gatewayKey} ${row.livemode ? "live" : "test"}`;
    let creds: Record<string, unknown>;
    try {
      creds = decryptCredentials(row.credentialsEnc);
    } catch {
      tally.unreadable++;
      console.log(`  unreadable  ${tag} — credentials do not decrypt`);
      continue;
    }
    const current = accountNotificationUrl(row, creds);
    const next = gatewayNotificationUrl(row.gatewayKey, row.publicId);
    const registered = Boolean(creds.webhook_endpoint_id || creds.webhook_id);
    if (!registered) {
      // Shown with the new URL already; the gateway may still hold the old one.
      tally.manual++;
      console.log(`  manual      ${tag} — set up by hand; the operator changes it at the gateway`);
      continue;
    }
    if (current === next) {
      tally.onTarget++;
      continue;
    }
    let canRemove = false;
    try {
      canRemove = Boolean(resolveAdapter(row).removeWebhookEndpoint);
    } catch {
      canRemove = false;
    }
    if (!canRemove) {
      tally.stays++;
      console.log(`  stays       ${tag} — the gateway cannot remove the old registration`);
      continue;
    }
    tally.move++;
    if (!apply) {
      console.log(`  would move  ${tag} — ${host(current)} → ${host(next)}`);
      continue;
    }
    try {
      const info = await provisionWebhookEndpoint({
        organizationId: row.organizationId,
        businessId: row.businessId,
        gatewayAccountPublicId: row.publicId,
      });
      if (info.notification_url !== next) throw new Error("the stored URL did not change");
      tally.moved++;
      console.log(`  moved       ${tag}`);
    } catch (e) {
      tally.failed++;
      console.log(`  FAILED      ${tag} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(
    `\n${rows.length} accounts: ${tally.onTarget} on target, ${tally.move} to move` +
      (apply ? ` (${tally.moved} moved, ${tally.failed} failed)` : "") +
      `, ${tally.stays} stay, ${tally.manual} manual, ${tally.unreadable} unreadable`,
  );
  if (tally.failed) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());

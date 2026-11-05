/**
 * File a support 2FA reset for someone who lost every method and every recovery code.
 * Dry run unless --commit. Takes effect MFA_RESET_WAIT_DAYS later unless the owner cancels from
 * the emailed link; the security_sweep job completes it.
 *
 *   pnpm tsx scripts/support/request-mfa-reset.ts --email <addr> --proof "<what you checked>" \
 *     [--admin <you>] [--commit]
 *
 * --proof says which second proof you checked (e.g. "signed in with Google on a known browser").
 * Never paste a credential into it — it is stored.
 */
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import { requestMfaReset, MfaResetRefusedError } from "@/modules/auth/mfa-reset";
import { flushSecurityMail } from "@/modules/auth/security-events";
import { closeDb } from "@/platform/db";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    proof: { type: "string" },
    admin: { type: "string" },
    commit: { type: "boolean", default: false },
  },
});

if (!values.email || !values.proof?.trim()) {
  console.error(
    'Usage: pnpm tsx scripts/support/request-mfa-reset.ts --email <addr> --proof "<what you checked>" [--admin <you>] [--commit]',
  );
  process.exit(1);
}

let code = 0;
try {
  const r = await requestMfaReset({
    email: values.email,
    proof: values.proof.trim(),
    requestedBy: values.admin?.trim() || userInfo().username,
    commit: values.commit,
  });
  console.log(r.filed ? "✅ 2FA reset filed for" : "Dry run — would file a 2FA reset for", r.email);
  console.log("  takes effect:", r.effectiveAt.toISOString());
  console.log(
    r.filed
      ? "  the owner was emailed a link to cancel it"
      : "  nothing was written; re-run with --commit to file it",
  );
} catch (e) {
  if (!(e instanceof MfaResetRefusedError)) throw e;
  console.error(`❌ Refused (${e.reason}): ${e.message}`);
  code = 2;
} finally {
  await flushSecurityMail();
  await closeDb();
}
process.exit(code);

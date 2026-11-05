/**
 * Bootstrap a fresh deploy's FIRST org + dashboard login (deploy/README.md Stage 4
 * step 11) — production/staging use, not local dev (that's `pnpm seed`, which also
 * seeds demo catalog data this deliberately does not).
 *
 *   pnpm tsx deploy/create-admin.ts --email <email> --org-name <name>
 *
 * Both flags are required. The password is
 * always GENERATED, never accepted as input — that keeps a strong secret out of
 * shell history and any deploy script's argv. It is printed once; there is no way
 * to recover it afterward (only reset via the dashboard's own flow).
 */
import { signup } from "@/modules/auth/service";
import { generatePassword } from "@/modules/auth/password-policy";
import { closeDb } from "@/platform/db";

const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const email = flag("email");
const organizationName = flag("org-name");
if (!email || !organizationName) {
  console.error("usage: pnpm tsx deploy/create-admin.ts --email <email> --org-name <name>");
  process.exit(2);
}
// Same generator as a minted API key's secret (src/platform/api-key.ts) — 24
// random bytes, base64url so it's shell/URL-safe to paste around.
// `generatePassword()`, not a bare base64url string: that alphabet is `A-Za-z0-9-_`, so
// 36% of draws contain no special character and `signup` refused them outright — a
// production admin-bootstrap script that failed a third of the time on its own generated
// credential. See auth/password-policy.ts § generatePassword.
const password = generatePassword();

const result = await signup({ email, password, organizationName, name: "Admin" });

console.log("✅ organization + dashboard admin created");
console.log("  org id (uuid):", result.user.organizationId);
console.log("  org public id:", result.user.organizationPublicId);
console.log("  login email  :", email);
console.log("");
console.log("  PASSWORD (shown once — copy it into a password manager now):");
console.log("   ", password);
console.log("");
console.log("  dashboard credential (kind=dashboard, NOT an API key — TMBILLING_API_KEY):");
console.log("   ", result.dashboardKeySecret);
console.log("");
console.log("  To mint a real integration API key later:");
console.log(`    pnpm tsx scripts/create-api-key.ts --org ${result.user.organizationPublicId}`);

await closeDb();

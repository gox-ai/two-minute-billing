/**
 * Authorization guard on every dashboard entry point (audit H4, M8).
 *
 * A source scan with a RATCHETING BUDGET, modelled on `verify:input-bounds` and
 * `verify:ui`. The numbers may only ever go down.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 * A Next.js server action is a POST endpoint in its own right, addressed by an action id
 * that ships in the PUBLIC client bundle. A guard on the page that renders the form does
 * not protect the action — only a check inside the action body does. `dashboard/app/
 * actions.ts` has said so in a comment since the beginning, and 159 of 182 actions
 * followed it; the other 23 did not, and nothing noticed for as long as they existed.
 *
 * That is the real finding. Every omission the audit turned up except two was an
 * omission against a rule the team had already written down — they shipped because
 * nothing measured them. This measures them.
 *
 * It has already earned its keep: writing it surfaced `resendEmailAction` and
 * `setModeAction`, neither of which appeared in the audit's list of seven files.
 *
 * ── WHY SOURCE TEXT ─────────────────────────────────────────────────────────────
 * Same reasoning as `verify-input-bounds`: importing every action file to introspect
 * would execute module side effects, and nothing here computes a guard at runtime. If
 * something ever does, this failing loudly is the correct outcome.
 *
 * ── WHAT COUNTS AS A GUARD ──────────────────────────────────────────────────────
 * `requirePermission()` (role-checked), `requireUser()` (session-only, for things every
 * role may do), or `readStorefrontToken` (the buyer surfaces authorize on their own
 * HttpOnly cookie, not on an operator session).
 *
 *   pnpm verify:action-guards
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * May only ever DECREASE. Currently zero — every exported server action authorizes its
 * caller, or is listed below with a reason. If you are raising this, you are shipping a
 * network-invokable POST that authorizes nobody: don't.
 */
const ACTION_BUDGET = 0;

/** May only ever DECREASE. Currently zero. Same rule, for pages. */
const PAGE_BUDGET = 0;

const APP_DIR = new URL("../dashboard/app/", import.meta.url).pathname;

const GUARD = /requirePermission\(|requireUser\(|readStorefrontToken/;

/**
 * Exempt, each for a stated reason — not "we forgot". A bare allow-list decays into a
 * place to hide things, so every entry says why, and an entry whose reason no longer
 * holds should be deleted rather than kept for the green tick.
 *
 * The auth actions ARE the sign-in path: requiring a session to sign in is circular.
 * Where one of them is privileged, the ENGINE authorizes it — `inviteAction` reaches
 * `POST /auth/invite`, which is the single route in the whole API that consults `can()`
 * (`src/api/auth-routes.ts`). `changePasswordAction` and `switchOrganizationAction` act
 * only on the caller's own account and are validated against the session server-side.
 */
const EXEMPT_ACTIONS = new Map<string, string>([
  ["auth-actions.ts::loginAction", "IS the sign-in path"],
  ["auth-actions.ts::logoutAction", "must work for a half-valid session too"],
  ["auth-actions.ts::forgotPasswordAction", "public by design; rate-limited + uniform answer"],
  ["auth-actions.ts::resetPasswordAction", "authorizes on the emailed single-use token"],
  ["(auth)/signup/actions.ts::signupAction", "IS self-serve sign-up; rate-limited, uniform answer"],
  ["(auth)/signup/actions.ts::confirmSignupAction", "authorizes on the emailed single-use token"],
  [
    "(auth)/signup/actions.ts::signupRequestAction",
    "public by design while sign-up is locked; rate-limited, Turnstile, uniform 202",
  ],
  ["(auth)/signup/actions.ts::signupInviteAction", "authorizes on the staff-sent single-use token"],
  [
    "(auth)/signup/actions.ts::cancelGoogleSignupAction",
    "only clears the visitor's own pending-Google cookie",
  ],
  ["auth-actions.ts::acceptInviteAction", "authorizes on the invite token"],
  [
    "auth-actions.ts::inviteAction",
    "engine-checked: /auth/invite consults can(actor.role,'admin')",
  ],
  ["auth-actions.ts::changePasswordAction", "acts on the caller only; needs the current password"],
  [
    "auth-actions.ts::switchOrganizationAction",
    "acts on the caller only; membership checked server-side",
  ],
  ["auth-actions.ts::mfaLoginAction", "IS the sign-in path — the second step of it (audit M3)"],
  [
    "auth-actions.ts::cancelMfaResetAction",
    "authorizes on the emailed cancel token, which can only STOP a 2FA reset",
  ],
  [
    "passkey-actions.ts::passkeySignInOptionsAction",
    "IS the sign-in path — passkey sign-in (0330)",
  ],
  ["passkey-actions.ts::passkeySignInAction", "IS the sign-in path — the API verifies the passkey"],
  [
    "passkey-actions.ts::mfaPasskeyOptionsAction",
    "the sign-in second step; bound to the HttpOnly challenge cookie",
  ],
  [
    "passkey-actions.ts::mfaPasskeyLoginAction",
    "the sign-in second step; bound to the HttpOnly challenge cookie",
  ],
  [
    "(storefront)/portal/(session)/actions.ts::portalLoginRequestAction",
    "IS the buyer's portal sign-in; rate-limited per IP and email, bot check, says nothing of the account",
  ],
  [
    "(storefront)/portal/(session)/actions.ts::portalLoginVerifyAction",
    "IS the buyer's portal sign-in; the API spends the single-use emailed code",
  ],
  [
    "(storefront)/portal/continue/[token]/actions.ts::continuePortalLinkAction",
    "authorizes on the emailed portal link, which the API exchange spends once",
  ],
  [
    "(auth)/team-alerts/confirm/actions.ts::confirmTeamAlertsAction",
    "authorizes on the emailed single-use team alert token; the reader is often not a member",
  ],
]);

/** Pages that are public by design. Everything else needs a guard. */
const EXEMPT_PAGES = new Map<string, string>([
  ["(auth)/login/page.tsx", "the sign-in form"],
  ["(auth)/forgot-password/page.tsx", "public by design"],
  ["(auth)/reset-password/page.tsx", "reached with a single-use token"],
  ["(auth)/invite/page.tsx", "reached with an invite token"],
  ["(auth)/two-factor-reset/page.tsx", "reached with a 2FA-reset cancel token"],
  ["(auth)/signup/page.tsx", "the self-serve sign-up form"],
  ["(auth)/signup/confirm/page.tsx", "reached with the emailed sign-up token"],
  ["(auth)/signup/invite/page.tsx", "reached with the staff-sent sign-up token"],
  ["(auth)/team-alerts/confirm/page.tsx", "reached with the emailed team alert token"],
  ["(storefront)/buy/unavailable/page.tsx", "public: where a dead payment link lands"],
  ["(storefront)/pricing/[biz]/page.tsx", "public: a business's pricing page (E2)"],
  [
    "(storefront)/portal/continue/[token]/page.tsx",
    "reached with the emailed portal link; the peek spends nothing",
  ],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const rel = (p: string) => p.slice(p.indexOf("/dashboard/app/") + "/dashboard/app/".length);

const actionOffenders: string[] = [];
const pageOffenders: string[] = [];
let guardedActions = 0;
let guardedPages = 0;
const staleActionExemptions = new Set(EXEMPT_ACTIONS.keys());
const stalePageExemptions = new Set(EXEMPT_PAGES.keys());

for (const file of walk(APP_DIR)) {
  const src = readFileSync(file, "utf8");
  const name = rel(file);

  if (file.endsWith("page.tsx")) {
    if (EXEMPT_PAGES.has(name)) stalePageExemptions.delete(name);
    else if (GUARD.test(src)) guardedPages++;
    else pageOffenders.push(name);
  }

  // `'use server'` must be the file's own directive, so look only at its head — a
  // string mentioning it deeper down is not a server-action file.
  //
  // BOTH quote styles, and that is not defensive noise. `oxfmt` owns formatting in this
  // repo and rewrites string quotes as it reformats; when it reached `auth-actions.ts`
  // this matcher stopped recognising the file, every action in it fell out of the scan,
  // and the suite reported nine STALE EXEMPTIONS while `unguarded actions` sat at 0.
  // Red for nothing, which is how a guard stops being read. A check that greps source
  // must not care how the source is punctuated.
  const head = src.slice(0, 200);
  if (!head.includes("'use server'") && !head.includes('"use server"')) continue;

  const fns = [...src.matchAll(/^export async function (\w+)/gm)];
  for (let i = 0; i < fns.length; i++) {
    const start = fns[i]!.index!;
    const end = i + 1 < fns.length ? fns[i + 1]!.index! : src.length;
    const key = `${name}::${fns[i]![1]}`;
    if (EXEMPT_ACTIONS.has(key)) {
      staleActionExemptions.delete(key);
      continue;
    }
    if (GUARD.test(src.slice(start, end))) guardedActions++;
    else actionOffenders.push(key);
  }
}

console.log(`  guarded actions   ${guardedActions}`);
console.log(`  unguarded actions ${actionOffenders.length} (budget ${ACTION_BUDGET})`);
for (const o of actionOffenders) console.log(`     ↳ ${o}`);
console.log(`  guarded pages     ${guardedPages}`);
console.log(`  unguarded pages   ${pageOffenders.length} (budget ${PAGE_BUDGET})`);
for (const o of pageOffenders) console.log(`     ↳ ${o}`);

if (actionOffenders.length > 0) {
  console.log("");
  console.log("  Add `await requirePermission(<perm>)` as the FIRST statement — before any");
  console.log("  try/catch, or a redirect() from it is swallowed by the catch and returned as a");
  console.log("  result. Pick the permission the PAGE that renders the action uses: stricter");
  console.log("  ships a control that always fails, looser is escalation via server action.");
}

// A stale exemption is its own failure: it means the action was renamed or deleted and
// the list now carries a line that protects nothing, which is how allow-lists rot into
// cover for real gaps.
const stale = [...staleActionExemptions, ...stalePageExemptions];
if (stale.length > 0) {
  console.log("");
  console.log("  STALE EXEMPTIONS — these no longer match anything; delete them:");
  for (const s of stale) console.log(`     ↳ ${s}`);
}

console.log("");
const pass =
  actionOffenders.length <= ACTION_BUDGET &&
  pageOffenders.length <= PAGE_BUDGET &&
  stale.length === 0;
console.log(pass ? "✅ ACTION GUARDS: PASS" : "❌ ACTION GUARDS: FAIL");
if (pass && actionOffenders.length < ACTION_BUDGET) {
  console.log(`   ↳ lower ACTION_BUDGET to ${actionOffenders.length} in this commit.`);
}
if (pass && pageOffenders.length < PAGE_BUDGET) {
  console.log(`   ↳ lower PAGE_BUDGET to ${pageOffenders.length} in this commit.`);
}
process.exit(pass ? 0 : 1);

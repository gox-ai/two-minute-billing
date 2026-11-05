/**
 * Dashboard guard: a server action stays on the page it was submitted from.
 *
 * A `redirect()` out of a server action is a full navigation: the page scrolls to the
 * top and a form that was mid-edit is thrown away. Success therefore returns an
 * `ActionResult` (`revalidatePath` + `actionOk(message)`), which `ActionForm` toasts in
 * place. A redirect is kept only where the URL must change — create → the new record,
 * delete → the list, auth and session flows — and each one is listed below with why.
 *
 * Counts every `redirect(` / `permanentRedirect(` in a `"use server"` module or inline
 * `"use server"` function, including calls routed through a local helper that redirects.
 * Keyed by `file::function`; the count must match exactly, so the list only shrinks:
 * lower (or delete) an entry in the same commit that removes a redirect.
 *
 * A small lexer rather than a parser: the repo's `typescript` is the native 7.x build,
 * which ships no JS API.
 *
 *   pnpm verify:no-success-redirect
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const DASH = join(ROOT, "dashboard");
const SCAN = ["app", "components", "lib"];

type Allow = Record<string, { n: number; why: string }>;

const AUTH = "auth flow — the next URL is the next step of signing in";
const NO_SESSION = "no session → /login";
const MFA = "MFA enrolment — the account page re-renders a different step";

/** Every "use server" file except app/actions.ts. */
const ALLOW: Allow = {
  "app/(dashboard)/businesses/[biz]/settings/dunning/policies/actions.ts::createDunningPolicyAction":
    {
      n: 1,
      why: "create → the new policy's page",
    },
  "app/auth-actions.ts::loginAction": { n: 2, why: `${AUTH} (MFA step, then the destination)` },
  "app/auth-actions.ts::mfaLoginAction": {
    n: 4,
    why: `${AUTH} (timed out, the destination, or the recovery-code notice)`,
  },
  "app/auth-actions.ts::inviteAction": { n: 1, why: NO_SESSION },
  "app/auth-actions.ts::changePasswordAction": { n: 1, why: NO_SESSION },
  "app/auth-actions.ts::switchOrganizationAction": {
    n: 3,
    why: "switching org re-scopes every page, so it lands on the org home",
  },
  "app/auth-actions.ts::forgotPasswordAction": { n: 1, why: AUTH },
  "app/auth-actions.ts::stepUpAction": { n: 1, why: NO_SESSION },
  "app/auth-actions.ts::signInAgainAction": {
    n: 1,
    why: `${AUTH} (signs out, then back to the sign-in page for a fresh sign-in)`,
  },
  "app/auth-actions.ts::acceptInvitationAction": {
    n: 2,
    why: "accepting opens the organization (via the switch); a failure returns to /invitations",
  },
  "app/auth-actions.ts::declineInvitationAction": {
    n: 3,
    why: `${NO_SESSION}; plain form on /invitations, which re-renders without the invite`,
  },
  "app/(auth)/signup/actions.ts::signupAction": {
    n: 2,
    why: `${AUTH} ("check your email", or signed in by Google)`,
  },
  "app/(auth)/signup/actions.ts::confirmSignupAction": {
    n: 2,
    why: `${AUTH} (expired link, or signed in)`,
  },
  "app/(auth)/signup/actions.ts::signupRequestAction": {
    n: 1,
    why: `${AUTH} (the "request received" notice replaces the form, like "check your email")`,
  },
  "app/(auth)/signup/actions.ts::signupInviteAction": {
    n: 1,
    why: `${AUTH} (signed in with the staff-sent link)`,
  },
  "app/(auth)/signup/actions.ts::cancelGoogleSignupAction": {
    n: 1,
    why: "back to the email sign-up form",
  },
  "app/(dashboard)/settings/billing/actions.ts::choosePlanAction": {
    n: 1,
    why: "leaves for our hosted checkout to pay for the plan",
  },
  "app/auth-actions.ts::resetPasswordAction": { n: 3, why: AUTH },
  "app/auth-actions.ts::acceptInviteAction": { n: 4, why: `${AUTH} (incl. the 2FA step)` },
  "app/auth-actions.ts::logoutAction": { n: 1, why: "sign-out — the session is gone" },
  "app/auth-actions.ts::enrollMfaAction": { n: 3, why: `${NO_SESSION}; ${MFA}` },
  "app/auth-actions.ts::confirmMfaAction": { n: 5, why: `${NO_SESSION}; ${MFA}` },
  "app/auth-actions.ts::cancelMfaSetupAction": { n: 1, why: MFA },
  "app/auth-actions.ts::disableMfaAction": { n: 1, why: NO_SESSION },
  "app/auth-actions.ts::regenerateRecoveryCodesAction": { n: 1, why: NO_SESSION },
  "app/(dashboard)/account/actions.ts::updateProfileAction": { n: 1, why: NO_SESSION },
  "app/(dashboard)/account/actions.ts::removeAvatarAction": { n: 1, why: NO_SESSION },
  "app/(dashboard)/account/actions.ts::setThemeAction": { n: 1, why: NO_SESSION },
  "app/(dashboard)/account/actions.ts::revokeSessionAction": { n: 1, why: NO_SESSION },
  "app/(dashboard)/account/actions.ts::revokeOtherSessionsAction": { n: 1, why: NO_SESSION },
  "app/(dashboard)/account/actions.ts::forgetTrustedBrowserAction": { n: 1, why: NO_SESSION },
  "app/(dashboard)/account/actions.ts::forgetAllTrustedBrowsersAction": { n: 1, why: NO_SESSION },
  "app/(dashboard)/settings/security-actions.ts::setRequireTwoFactorAction": {
    n: 1,
    why: NO_SESSION,
  },
  "app/(dashboard)/settings/security-actions.ts::saveSessionPolicyAction": {
    n: 1,
    why: NO_SESSION,
  },
  "app/auth-actions.ts::acknowledgeRecoveryCodesAction": { n: 1, why: NO_SESSION },
  "app/auth-actions.ts::cancelMfaResetAction": {
    n: 2,
    why: "2FA-reset cancel — the outcome is its own page; the token cookie is spent",
  },
  "app/auth-actions.ts::changeMemberRoleAction": { n: 1, why: `${NO_SESSION} (member helper)` },
  "app/auth-actions.ts::removeMemberAction": { n: 1, why: `${NO_SESSION} (member helper)` },
  "app/auth-actions.ts::resendMemberInviteAction": { n: 1, why: `${NO_SESSION} (member helper)` },
  "app/(storefront)/portal/(session)/actions.ts::portalLogoutAction": {
    n: 1,
    why: "buyer sign-out — leaves for the merchant's redirect_url",
  },
  "app/(storefront)/portal/continue/[token]/actions.ts::continuePortalLinkAction": {
    n: 1,
    why: "buyer sign-in — the emailed link opens the portal (or its expired card)",
  },
};

/** app/actions.ts — built once its conversion lands. */
const ALLOW_APP_ACTIONS: Allow = {
  "app/actions.ts::createBusiness": {
    n: 1,
    why: "a free-plan org cannot change its live business, so it lands in the new test mode",
  },
  "app/actions.ts::openTestModeAction": {
    n: 1,
    why: "Mode switch → the same section of the business's new test mode",
  },
  "app/actions.ts::createCustomer": {
    n: 1,
    why: "create → the new customer (called from a server page, no onSuccess)",
  },
  "app/actions.ts::createProductAction": {
    n: 1,
    why: "product created but its first price failed → that product's price form, prefilled",
  },
  "app/actions.ts::editCustomerAction": {
    n: 1,
    why: "full-page edit returns to the customer record",
  },
  "app/actions.ts::deleteSubscriptionAction": { n: 1, why: "delete → the list" },
  "app/actions.ts::addSubscriptionChargesAction": {
    n: 1,
    why: "add-charge takeover route returns to the subscription",
  },
};

// ─────────────────────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Blank comments, strings and regex literals (newlines kept, so offsets and brace depth
 * stay true). String contents are returned separately so directives can be found.
 */
function lex(src: string): { code: string; strings: Array<{ at: number; text: string }> } {
  const out = src.split("");
  const strings: Array<{ at: number; text: string }> = [];
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const tplDepth: number[] = []; // brace depth at each open `${`
  let depth = 0;
  let prev = ""; // last significant code char, for regex-vs-divide
  let i = 0;
  const readQuoted = (q: string) => {
    const start = i++;
    while (i < src.length && src[i] !== q && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
    strings.push({ at: start, text: src.slice(start + 1, i) });
    i++;
    blank(start, i);
  };
  const readTemplate = () => {
    // from just after ` or }, up to the closing ` or the next ${
    const start = i;
    while (i < src.length) {
      if (src[i] === "\\") i += 2;
      else if (src[i] === "`") {
        blank(start, ++i);
        return;
      } else if (src[i] === "$" && src[i + 1] === "{") {
        i += 2;
        blank(start, i);
        tplDepth.push(depth++);
        return;
      } else i++;
    }
  };
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const s = i;
      while (i < src.length && src[i] !== "\n") i++;
      blank(s, i);
    } else if (c === "/" && n === "*") {
      const s = i;
      i = src.indexOf("*/", i + 2);
      i = i < 0 ? src.length : i + 2;
      blank(s, i);
    } else if (c === '"' || c === "'") {
      readQuoted(c);
      prev = "a";
    } else if (c === "`") {
      i++;
      readTemplate();
      prev = "a";
    } else if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%~^".includes(prev))) {
      const s = i++;
      let cls = false;
      while (i < src.length && src[i] !== "\n") {
        if (src[i] === "\\") i++;
        else if (src[i] === "[") cls = true;
        else if (src[i] === "]") cls = false;
        else if (src[i] === "/" && !cls) break;
        i++;
      }
      i++;
      while (/[a-z]/i.test(src[i] ?? "")) i++;
      blank(s, i);
      prev = "a";
    } else {
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (tplDepth.length && tplDepth[tplDepth.length - 1] === depth) {
          tplDepth.pop();
          out[i] = " ";
          i++;
          readTemplate();
          prev = "a";
          continue;
        }
      }
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return { code: out.join(""), strings };
}

interface Decl {
  name: string;
  exported: boolean;
  start: number;
  end: number;
}

/** Top-level declarations (depth 0) with their extent. */
function topLevel(code: string): Decl[] {
  const decls: Decl[] = [];
  const re =
    /^(export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|(?:const|let|var)\s+(\w+))/gm;
  const depthAt: number[] = new Array(code.length + 1);
  let d = 0;
  for (let k = 0; k < code.length; k++) {
    depthAt[k] = d;
    if (code[k] === "{" || code[k] === "(" || code[k] === "[") d++;
    else if (code[k] === "}" || code[k] === ")" || code[k] === "]") d--;
  }
  for (const m of code.matchAll(re)) {
    if (depthAt[m.index!] !== 0) continue;
    decls.push({ name: (m[2] ?? m[3])!, exported: !!m[1], start: m.index!, end: code.length });
  }
  for (let k = 0; k < decls.length - 1; k++) decls[k]!.end = decls[k + 1]!.start;
  return decls;
}

/** [start, end) of the `{…}` block that contains `at`. */
function enclosingBlock(code: string, at: number): [number, number] {
  let d = 0;
  let s = at;
  for (; s >= 0; s--) {
    if (code[s] === "}") d++;
    else if (code[s] === "{") {
      if (d === 0) break;
      d--;
    }
  }
  d = 0;
  let e = s;
  for (; e < code.length; e++) {
    if (code[e] === "{") d++;
    else if (code[e] === "}" && --d === 0) break;
  }
  return [s, e + 1];
}

const found = new Map<string, number>();

for (const file of SCAN.flatMap((dir) => walk(join(DASH, dir)))) {
  const src = readFileSync(file, "utf8");
  if (!src.includes("use server")) continue;
  const { code, strings } = lex(src);
  const directives = strings.filter((s) => s.text === "use server");
  if (!directives.length) continue;
  const rel = relative(DASH, file);

  // A module-level directive is the first statement; anything else is an inline action.
  const firstCode = code.search(/\S/);
  const moduleLevel = directives.some((s) => firstCode === -1 || s.at <= firstCode);
  const regions: Array<[number, number]> = moduleLevel
    ? [[0, code.length]]
    : directives.map((s) => enclosingBlock(code, s.at));

  const decls = topLevel(code);
  const ownerAt = (at: number) =>
    decls.find((dcl) => at >= dcl.start && at < dcl.end)?.name ?? "<top-level>";

  // Local helpers that redirect are counted where they are called, not where defined.
  const redirectors = new Set(["redirect", "permanentRedirect"]);
  const callRe = () => new RegExp(`(?<![\\w.$])(${[...redirectors].join("|")})\\s*\\(`, "g");
  for (let grew = true; grew;) {
    grew = false;
    for (const dcl of decls) {
      if (dcl.exported || redirectors.has(dcl.name)) continue;
      if (callRe().test(code.slice(dcl.start, dcl.end))) {
        redirectors.add(dcl.name);
        grew = true;
      }
    }
  }

  for (const m of code.matchAll(callRe())) {
    const at = m.index!;
    if (!regions.some(([s, e]) => at >= s && at < e)) continue;
    const owner = ownerAt(at);
    if (redirectors.has(owner) && !decls.find((x) => x.name === owner)?.exported) continue;
    // Skip the declaration of a helper itself (`const back = (…) =>` matches `back(`? no —
    // but `function back(` does).
    if (/function\s*\*?\s*$/.test(code.slice(Math.max(0, at - 12), at))) continue;
    const key = `${rel}::${owner}`;
    found.set(key, (found.get(key) ?? 0) + 1);
  }
}

function check(label: string, allow: Allow, keys: string[]): boolean {
  const problems: string[] = [];
  for (const key of keys) {
    const n = found.get(key)!;
    const a = allow[key];
    if (!a) problems.push(`  ✗ ${key} ×${n} — not on the allow-list`);
    else if (n > a.n) problems.push(`  ✗ ${key} ×${n} — allowed ${a.n}`);
    else if (n < a.n) problems.push(`  ✗ ${key} ×${n} — allow-list says ${a.n}: lower it`);
  }
  for (const key of Object.keys(allow))
    if (!found.has(key)) problems.push(`  ✗ ${key} — no longer redirects: delete the entry`);
  const total = keys.reduce((s, k) => s + found.get(k)!, 0);
  console.log(`${label}: ${total} redirect(s) in ${keys.length} function(s)`);
  for (const k of keys.sort()) {
    const a = allow[k];
    if (a && a.n === found.get(k)) console.log(`  · ${k} ×${a.n} — ${a.why}`);
  }
  for (const p of problems) console.log(p);
  console.log("");
  return problems.length === 0;
}

const APP_ACTIONS = "app/actions.ts::";
const keys = [...found.keys()];
const results = [
  check(
    "server actions",
    ALLOW,
    keys.filter((k) => !k.startsWith(APP_ACTIONS)),
  ),
  check(
    "app/actions.ts",
    ALLOW_APP_ACTIONS,
    keys.filter((k) => k.startsWith(APP_ACTIONS)),
  ),
];
const pass = results.every(Boolean);

if (!pass) {
  console.log("  Return actionOk(message) after revalidatePath — ActionForm toasts it in place.");
  console.log("  Only a create (actionOk(msg, redirectTo)), a delete or an auth flow navigates.");
  console.log("");
}
console.log(pass ? "✅ NO SUCCESS REDIRECT: PASS" : "❌ NO SUCCESS REDIRECT: FAIL");
process.exit(pass ? 0 : 1);

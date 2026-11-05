import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { forwardedFor } from "@/lib/forwarded-for";
import type { PermissionKey } from "@/lib/permissions.generated";

// The portal forwards the user's session cookie to the API. (The org API key in
// lib/api.ts is the BFF's data credential; this is the human's login identity,
// used for /auth/me + gating which views/nav a role sees.)

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

export type FixedRole = "owner" | "admin" | "manager" | "ops" | "developer";
/** `custom` when the member holds a custom role (`custom_role` names it). */
export type Role = FixedRole | "custom";
/** The four page levels fixed roles have always been checked by. */
export type Level = "manager" | "ops" | "developer" | "admin";
export interface SessionUser {
  id: string;
  email: string;
  role: Role;
  custom_role?: { id: string; name: string } | null;
  /** The member's effective permission keys (`/auth/me`). */
  permissions?: string[];
  organization: string;
  /**
   * The role is required to hold a second factor and has not enrolled one (audit M3.1).
   * Derived server-side per request, so it clears itself the moment enrolment is confirmed.
   */
  mfa_enrollment_required?: boolean;
  /**
   * The account has a password hash. FALSE means Google-only (invited, settled with Google,
   * never set one) — such a person has no "current password" to give, so the forms that would
   * ask for one must not. Derived server-side per request, like the flag above.
   */
  has_password?: boolean;
  /**
   * How many release notes this person had acknowledged — the What's-new highwater. NULL means
   * never initialised, which this side reads as CAUGHT UP: a brand-new operator should not be
   * met by the whole archive. See `lib/release-note-types.ts` § unreadNotes.
   */
  release_notes_seen_count?: number | null;
  /** Profile (0327). NULL name = show the email; NULL avatar = initials. */
  name?: string | null;
  /** The photo to show: the uploaded one, else the Google account's (0331). */
  avatar_url?: string | null;
  avatar_source?: "upload" | "google" | null;
  /** NULL = never chosen on the account, so the browser's own choice stands. */
  theme?: "light" | "dark" | "system" | null;
  /** The current organization's "Require two-factor authentication" standing (0329). */
  organization_two_factor?: OrganizationTwoFactor | null;
  /** Live-mode lock (0354). Only staff lock it since the Free plan (0356). */
  organization_live_access?: "locked" | "enabled";
  /** `restricted` = read-only (0354). */
  organization_status?: "active" | "restricted";
  /** Why it is read-only (0356). */
  organization_restricted_reason?: "unpaid" | "over_limit" | null;
  /** This month's live volume is above the plan's limit (0356). A notice only. */
  organization_over_limit?: boolean;
  /** ISO country given at sign-up; presets a new business's currency. */
  organization_country?: string | null;
  /** The gateway named at sign-up (`stripe`, `razorpay`, `paypal`, `other`, `none`). */
  organization_signup_gateway?: string | null;
  /** Finished or dismissed the product tour (0500). Absent = an older API: treat as seen. */
  product_tour_seen?: boolean;
}

export interface OrganizationTwoFactor {
  organization: { id: string; name: string };
  required: boolean;
  satisfied: boolean;
  /** First instant the API refuses them (ISO). */
  deadline: string | null;
  /** The last day they still have, YYYY-MM-DD in the organization's zone. */
  deadline_day: string | null;
  /** Past the deadline without 2FA: every /v1/* call answers 403 `two_factor_required`. */
  blocked: boolean;
}

/** Where a member locked out by the organization's 2FA requirement is sent. */
export const TWO_FACTOR_GATE_PATH = "/two-factor-required";

/**
 * Where a mandated role is sent until it enrols, and the one page exempt from the redirect —
 * it is where the enrolment card lives, so redirecting it to itself would be a loop.
 */
const ENROLL_PATH = "/account";

/**
 * Thrown when the engine could not be ASKED who the operator is — not when it answered
 * "nobody". Caught by `app/(dashboard)/error.tsx`; the dashboard layout handles its own case
 * inline, because a layout's throw has no boundary above it (each route group owns its
 * `<html>`, so there is no root layout to host one).
 */
export class SessionUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(`tmbilling API could not confirm the session: ${detail}`);
    this.name = "SessionUnavailableError";
  }
}

export type SessionLookup =
  | { state: "authenticated"; user: SessionUser }
  /** No cookie, or the engine actively refused it. Signing in is the right answer. */
  | { state: "anonymous" }
  /** The engine could not be reached or failed. The session may be perfectly fine. */
  | { state: "unavailable"; detail: string };

/**
 * Who is signed in — with "we could not ask" kept DISTINCT from "nobody is".
 *
 * ── THE BUG THIS EXISTS TO KILL ────────────────────────────────────────────────
 * This collapsed every outcome into `null`: no cookie, a 401, a 500, a timeout, a refused
 * connection. `requireUser()` reads `null` as "not signed in" and redirects to `/login` — so
 * ANY blip signed the operator out of a session that was still valid and threw away whatever
 * form they had open.
 *
 * Observed, not theorised: on 2026-09-09 the engine's `tsx watch` restarted mid-session
 * (pid 1536975 → 1621490) and a protected route answered 307 → /login while the very same
 * cookie returned 200 from `/auth/me` moments later. The failure mode is worst exactly when it
 * matters most — during an incident, operators get bounced to the login screen repeatedly
 * while trying to diagnose the incident.
 *
 * A 401/403 IS "anonymous": the engine looked at this credential and said no. Anything else is
 * `unavailable`, and the caller must say so rather than pretend the person logged out.
 */
export async function lookupSession(): Promise<SessionLookup> {
  const token = (await cookies()).get("tmb_session")?.value;
  if (!token) return { state: "anonymous" };
  try {
    const res = await fetch(`${BASE}/auth/me`, {
      headers: { cookie: `tmb_session=${token}`, ...(await forwardedFor()) },
      cache: "no-store",
    });
    if (res.status === 401 || res.status === 403) return { state: "anonymous" };
    if (!res.ok) return { state: "unavailable", detail: `/auth/me → ${res.status}` };
    return { state: "authenticated", user: (await res.json()) as SessionUser };
  } catch (e) {
    return { state: "unavailable", detail: (e as Error).message };
  }
}

/**
 * The soft read: `null` for both "nobody" and "could not ask".
 *
 * Kept for the BFF route handlers (`/api/lists`, `/api/search`, `/api/list-views`,
 * `/api/email-preview`), which answer 401 either way — a browser fetch retries or surfaces its
 * own error, and there is no navigation to lose. Page and layout guards use `lookupSession`
 * instead, so a blip cannot read as a logout.
 */
export async function currentUser(): Promise<SessionUser | null> {
  const found = await lookupSession();
  return found.state === "authenticated" ? found.user : null;
}

export interface OrgMembership {
  id: string;
  name: string;
  /** The organization's sidebar logo, or null. */
  icon_url?: string | null;
  role: Role;
  current: boolean;
}

/**
 * Every organization the signed-in operator belongs to (0194). Drives the switcher.
 *
 * Returns `[]` rather than throwing when the call fails: the switcher is navigation
 * furniture, and a transient API hiccup should hide it, not take down every page in the
 * shell that renders it.
 */
export async function currentUserOrganizations(): Promise<OrgMembership[]> {
  const token = (await cookies()).get("tmb_session")?.value;
  if (!token) return [];
  try {
    const res = await fetch(`${BASE}/auth/organizations`, {
      headers: { cookie: `tmb_session=${token}`, ...(await forwardedFor()) },
      cache: "no-store",
    });
    if (!res.ok) return [];
    return ((await res.json()) as { data?: OrgMembership[] }).data ?? [];
  } catch {
    return [];
  }
}

/** An invite to another organization that waits for the signed-in operator (0498). */
export interface PendingInvite {
  organization: { id: string; name: string; icon_url: string | null };
  role: Role;
  custom_role: { name: string } | null;
  invited_at: string;
}

/** The signed-in operator's pending invites. `[]` on failure, like the switcher. */
export async function currentUserInvites(): Promise<PendingInvite[]> {
  const token = (await cookies()).get("tmb_session")?.value;
  if (!token) return [];
  try {
    const res = await fetch(`${BASE}/auth/invitations`, {
      headers: { cookie: `tmb_session=${token}`, ...(await forwardedFor()) },
      cache: "no-store",
    });
    if (!res.ok) return [];
    return ((await res.json()) as { data?: PendingInvite[] }).data ?? [];
  } catch {
    return [];
  }
}

/**
 * One row of the Team screen (2026-08-30). `snake_case` because it is the API's shape verbatim —
 * renaming on the way in would give the same fact two names across the reader, the action
 * and the table.
 */
export interface TeamMember {
  /** `usr_…`, the id the write endpoints take. */
  id: string;
  email: string;
  name: string | null;
  /** Profile photo (0327), or the Google account's (0331); NULL = initials. */
  avatar_url?: string | null;
  role: Role;
  custom_role?: { id: string; name: string } | null;
  /** `invited` = the invite is outstanding: no credential yet, or not accepted yet. */
  status: "active" | "invited";
  mfa_enabled: boolean;
  /**
   * Required to hold a second factor — the organization requires 2FA, or the deprecated
   * MFA_REQUIRED_ROLES names their role. `mfa_required && !mfa_enabled` ⇒ they owe one.
   */
  mfa_required: boolean;
  /** The organization's requirement: their last day without 2FA (YYYY-MM-DD). */
  mfa_deadline_day?: string | null;
  /** Past that day without 2FA: locked out of this organization until they set it up. */
  mfa_blocked?: boolean;
  last_login_at: string | null;
  member_since: string;
  /** The signed-in operator's own row. */
  is_self: boolean;
}

/**
 * Everyone in the current organization. Drives the Team screen.
 *
 * THROWS on failure, deliberately unlike `currentUserOrganizations` above: that list is
 * navigation furniture and hiding it on a hiccup is the right degradation, whereas this
 * list IS the page. Returning `[]` here would render "no team members yet" to an admin
 * whose colleagues are all still there — a screen that lies about who has access is worse
 * than one that says it could not load.
 */
export async function listTeamMembers(): Promise<TeamMember[]> {
  const token = (await cookies()).get("tmb_session")?.value;
  if (!token) redirect("/login");
  const res = await fetch(`${BASE}/auth/members`, {
    headers: { cookie: `tmb_session=${token}`, ...(await forwardedFor()) },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`tmbilling API /auth/members → ${res.status}`);
  return ((await res.json()) as { data?: TeamMember[] }).data ?? [];
}

const PERMS: Record<FixedRole, Level[]> = {
  owner: ["manager", "ops", "developer", "admin"],
  admin: ["manager", "ops", "developer", "admin"],
  manager: ["manager", "ops"],
  ops: ["ops"],
  developer: ["developer"],
};
/** A fixed role's page level. A custom role holds no level: use `allows`. */
export function can(role: Role, perm: Level): boolean {
  return role !== "custom" && (PERMS[role]?.includes(perm) ?? false);
}

/**
 * May this member use a page or control? A fixed role keeps its page `level` exactly as before
 * custom roles (when one is given); a custom role needs every key.
 */
export function allows(
  user: Pick<SessionUser, "role" | "permissions">,
  key: PermissionKey | readonly PermissionKey[],
  level?: Level,
): boolean {
  if (user.role !== "custom" && level) return can(user.role, level);
  const held = user.permissions ?? [];
  return (Array.isArray(key) ? key : [key]).every((k) => held.includes(k));
}

/** Require a signed-in user → redirect to /login otherwise. For page guards. */
export async function requireUser(): Promise<SessionUser> {
  const found = await lookupSession();
  // A blip is NOT a logout. Redirect only when the engine actually said "nobody"; otherwise
  // throw, so the error boundary offers a retry and the session survives.
  if (found.state === "unavailable") throw new SessionUnavailableError(found.detail);
  if (found.state === "anonymous") redirect("/login");
  const user = found.user;
  /**
   * A mandated role that has not enrolled goes to the enrolment screen (audit M3.1).
   *
   * This is UX, not the control. The control is the API refusing every `/v1/*` call with
   * `mfa_enrollment_required`; without this redirect the person would simply meet that refusal
   * on every page and have to find `/account` themselves. Worth being explicit, because a guard
   * that looks like enforcement but is only navigation is exactly the kind of thing someone
   * later "optimises" away believing the API is unprotected.
   *
   * `/account` is exempt or it would redirect to itself. Its shell already tolerates the 403 on
   * `/v1/businesses` (the layout catches and renders an empty business list), so the enrolment
   * card is reachable with the rest of the dashboard shut.
   */
  if (user.mfa_enrollment_required) {
    const path = (await headers()).get("x-tmb-path") ?? "";
    if (path !== ENROLL_PATH) redirect(`${ENROLL_PATH}?enroll=mfa`);
  }
  /**
   * Past the organization's 2FA deadline (0329): the gate screen, which offers setup, another
   * organization, or sign-out. Navigation again, not the control — the API refuses `/v1/*`.
   * `/account` stays reachable because setup lives there.
   */
  if (user.organization_two_factor?.blocked) {
    const path = (await headers()).get("x-tmb-path") ?? "";
    if (path !== ENROLL_PATH && path !== TWO_FACTOR_GATE_PATH) redirect(TWO_FACTOR_GATE_PATH);
  }
  return user;
}

/**
 * Require a permission → redirect home if the member lacks it. `level` keeps a fixed role's
 * page check exactly as before custom roles; a custom role is checked by `key`.
 */
export async function requirePermission(
  key: PermissionKey | readonly PermissionKey[],
  level?: Level,
): Promise<SessionUser> {
  const user = await requireUser();
  if (!allows(user, key, level)) {
    redirect("/?denied=" + (user.role !== "custom" && level ? level : [key].flat()[0]));
  }
  return user;
}

import { eq } from "drizzle-orm";
import { config } from "@/platform/config";
import { systemDb } from "@/platform/db";
import { organizations, userMfa, users } from "@db/schema";
import { writeAuditLog } from "@/modules/audit/service";
import { FIXED_ROLES } from "./permissions";
import { TwoFactorSetupRequiredError } from "./org-two-factor";

/**
 * An organization's dashboard session policy (0482): idle timeout, absolute lifetime and the
 * roles that must use two-factor authentication. Each column overrides the deployment value
 * (`SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_TTL_HOURS`, `MFA_REQUIRED_ROLES`) but can only
 * make it STRICTER: the effective window is the shorter one and the roles are the union. NULL
 * is the deployment value, so an organization that never sets one is unchanged.
 */
export interface OrgSessionPolicy {
  sessionIdleMinutes: number | null;
  sessionAbsoluteTtlHours: number | null;
  mfaRequiredRoles: string[] | null;
}

/** The shortest idle timeout an organization may set: a person must be able to read a page. */
export const MIN_IDLE_MINUTES = 5;
/** The shortest absolute lifetime. */
export const MIN_ABSOLUTE_HOURS = 1;

const stricter = (deployment: number, org: number | null | undefined) =>
  org != null && Number.isInteger(org) && org >= 1 ? Math.min(deployment, org) : deployment;

export function effectiveIdleMinutes(org?: Partial<OrgSessionPolicy> | null): number {
  return stricter(config.SESSION_IDLE_MINUTES, org?.sessionIdleMinutes);
}

export function effectiveAbsoluteTtlHours(org?: Partial<OrgSessionPolicy> | null): number {
  return stricter(config.SESSION_ABSOLUTE_TTL_HOURS, org?.sessionAbsoluteTtlHours);
}

/** The deployment's roles plus the organization's, lower-cased and distinct. */
export function rolesRequiringMfa(org?: Partial<OrgSessionPolicy> | null): string[] {
  const out = new Set(config.MFA_REQUIRED_ROLES);
  for (const r of org?.mfaRequiredRoles ?? []) out.add(r.toLowerCase());
  return [...out];
}

/**
 * Refuse a policy that is looser than the deployment's or names an unknown role. Returns the
 * message to show, or null when the policy can be saved. Null fields are always valid.
 */
export function sessionPolicyError(p: OrgSessionPolicy): string | null {
  const idle = p.sessionIdleMinutes;
  if (idle != null) {
    if (!Number.isInteger(idle) || idle < MIN_IDLE_MINUTES)
      return `The idle timeout must be ${MIN_IDLE_MINUTES} minutes or more.`;
    if (idle > config.SESSION_IDLE_MINUTES)
      return `The idle timeout cannot be more than ${config.SESSION_IDLE_MINUTES} minutes, the limit of this installation.`;
  }
  const abs = p.sessionAbsoluteTtlHours;
  if (abs != null) {
    if (!Number.isInteger(abs) || abs < MIN_ABSOLUTE_HOURS)
      return `The session lifetime must be ${MIN_ABSOLUTE_HOURS} hour or more.`;
    if (abs > config.SESSION_ABSOLUTE_TTL_HOURS)
      return `The session lifetime cannot be more than ${config.SESSION_ABSOLUTE_TTL_HOURS} hours, the limit of this installation.`;
  }
  for (const r of p.mfaRequiredRoles ?? [])
    if (!(FIXED_ROLES as readonly string[]).includes(r))
      return `${r} is not a role. Select from ${FIXED_ROLES.join(", ")}.`;
  return null;
}

/** The organization's stored policy, or every field null. */
export async function organizationSessionPolicy(organizationId: string): Promise<OrgSessionPolicy> {
  const [row] = await systemDb
    .select({
      sessionIdleMinutes: organizations.sessionIdleMinutes,
      sessionAbsoluteTtlHours: organizations.sessionAbsoluteTtlHours,
      mfaRequiredRoles: organizations.mfaRequiredRoles,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return {
    sessionIdleMinutes: row?.sessionIdleMinutes ?? null,
    sessionAbsoluteTtlHours: row?.sessionAbsoluteTtlHours ?? null,
    mfaRequiredRoles: row?.mfaRequiredRoles?.length ? row.mfaRequiredRoles : null,
  };
}

export class SessionPolicyError extends Error {}

/**
 * Save the organization's policy. Refuses a looser value (`sessionPolicyError`), and a role list
 * that includes the caller's own role while the caller has no 2FA, which would lock them out
 * of the API on save. Takes effect on each session's next request.
 */
export async function setOrganizationSessionPolicy(input: {
  organizationId: string;
  actorUserId: string;
  actorRole: string;
  policy: OrgSessionPolicy;
}): Promise<{ changed: boolean; policy: OrgSessionPolicy }> {
  const roles = input.policy.mfaRequiredRoles?.length
    ? [...new Set(input.policy.mfaRequiredRoles.map((r) => r.toLowerCase()))].sort()
    : null;
  const next: OrgSessionPolicy = { ...input.policy, mfaRequiredRoles: roles };
  const error = sessionPolicyError(next);
  if (error) throw new SessionPolicyError(error);

  if (roles?.includes(input.actorRole.toLowerCase())) {
    const [mfa] = await systemDb
      .select({ at: userMfa.confirmedAt })
      .from(userMfa)
      .where(eq(userMfa.userId, input.actorUserId))
      .limit(1);
    if (!mfa?.at)
      throw new TwoFactorSetupRequiredError(
        "Enable two-factor authentication for yourself before you make it necessary for your own role.",
      );
  }

  const before = await organizationSessionPolicy(input.organizationId);
  const same =
    before.sessionIdleMinutes === next.sessionIdleMinutes &&
    before.sessionAbsoluteTtlHours === next.sessionAbsoluteTtlHours &&
    (before.mfaRequiredRoles ?? []).join() === (next.mfaRequiredRoles ?? []).join();
  if (same) return { changed: false, policy: before };

  const [org] = await systemDb
    .update(organizations)
    .set({
      sessionIdleMinutes: next.sessionIdleMinutes,
      sessionAbsoluteTtlHours: next.sessionAbsoluteTtlHours,
      mfaRequiredRoles: next.mfaRequiredRoles,
    })
    .where(eq(organizations.id, input.organizationId))
    .returning({ publicId: organizations.publicId });
  const [actor] = await systemDb
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, input.actorUserId))
    .limit(1);
  await writeAuditLog({
    organizationId: input.organizationId,
    action: "organization.session_policy.update",
    resourceType: "organization",
    resourceId: org?.publicId ?? input.organizationId,
    before: policyView(before),
    after: policyView(next),
    actor: actor?.email ?? null,
    source: "dashboard",
  });
  return { changed: true, policy: next };
}

/** The API shape of a policy. */
export function policyView(p: OrgSessionPolicy) {
  return {
    session_idle_minutes: p.sessionIdleMinutes,
    session_absolute_ttl_hours: p.sessionAbsoluteTtlHours,
    mfa_required_roles: p.mfaRequiredRoles ?? [],
  };
}

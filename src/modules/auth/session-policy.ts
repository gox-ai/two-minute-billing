import { eq } from "drizzle-orm";
import { config } from "@/platform/config";
import { systemDb } from "@/platform/db";
import { organizations, userMfa, users } from "@db/schema";
import { writeAuditLog } from "@/modules/audit/service";
import { FIXED_ROLES } from "./permissions";
import { TwoFactorSetupRequiredError } from "./org-two-factor";

/**
 * An organization's dashboard session policy (0482). Only `mfa_required_roles` is the
 * organization's: the roles that must use two-factor authentication, added to the deployment's
 * `MFA_REQUIRED_ROLES`. The idle timeout and the absolute lifetime are set by the installation
 * only (`SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_TTL_HOURS`, decision 2026-11-06). The
 * organization columns from 0482 stay in the schema and are no longer read or written.
 */
export interface OrgSessionPolicy {
  mfaRequiredRoles: string[] | null;
}

/** The installation's idle timeout. The organization argument is ignored. */
export function effectiveIdleMinutes(_org?: unknown): number {
  return config.SESSION_IDLE_MINUTES;
}

/** The installation's absolute session lifetime. The organization argument is ignored. */
export function effectiveAbsoluteTtlHours(_org?: unknown): number {
  return config.SESSION_ABSOLUTE_TTL_HOURS;
}

/** The deployment's roles plus the organization's, lower-cased and distinct. */
export function rolesRequiringMfa(org?: Partial<OrgSessionPolicy> | null): string[] {
  const out = new Set(config.MFA_REQUIRED_ROLES);
  for (const r of org?.mfaRequiredRoles ?? []) out.add(r.toLowerCase());
  return [...out];
}

/** Refuse a role that does not exist. Returns the message to show, or null. */
export function sessionPolicyError(p: OrgSessionPolicy): string | null {
  for (const r of p.mfaRequiredRoles ?? [])
    if (!(FIXED_ROLES as readonly string[]).includes(r))
      return `${r} is not a role. Select from ${FIXED_ROLES.join(", ")}.`;
  return null;
}

/** The organization's stored policy, or every field null. */
export async function organizationSessionPolicy(organizationId: string): Promise<OrgSessionPolicy> {
  const [row] = await systemDb
    .select({ mfaRequiredRoles: organizations.mfaRequiredRoles })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return {
    mfaRequiredRoles: row?.mfaRequiredRoles?.length ? row.mfaRequiredRoles : null,
  };
}

export class SessionPolicyError extends Error {}

/**
 * Save the organization's policy. Refuses an unknown role (`sessionPolicyError`), and a role list
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
  const same = (before.mfaRequiredRoles ?? []).join() === (next.mfaRequiredRoles ?? []).join();
  if (same) return { changed: false, policy: before };

  const [org] = await systemDb
    .update(organizations)
    .set({ mfaRequiredRoles: next.mfaRequiredRoles })
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
  return { mfa_required_roles: p.mfaRequiredRoles ?? [] };
}

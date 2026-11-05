import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { memberships, organizations, orgMfaReminders, userMfa, users } from "@db/schema";
import { nextDay, zonedDayEndExclusive, zonedDayString } from "@/platform/timezones";
import { createLogger } from "@/platform/logger";
import { securityEvent, type SecurityContext } from "./security-events";
import { writeAuditLog } from "@/modules/audit/service";

const log = createLogger("auth.org-two-factor");

/**
 * An organization's "Require two-factor authentication" setting (0329), and what it means for
 * one member. The API gate (`platform/auth.ts`), the team list, the toggle and the reminder
 * sweep all read the rule from here.
 *
 * Self-contained on purpose: `service.ts` imports this module, so it reads `user_mfa` itself
 * rather than calling `hasConfirmedMfa` back.
 */

export const DEFAULT_GRACE_DAYS = 7;

type OrgRow = typeof organizations.$inferSelect;

/** The fields of an organization the rule reads. A full row satisfies it. */
export type OrgPolicy = Pick<
  OrgRow,
  "requireMfa" | "mfaRequiredSince" | "mfaGraceDays" | "timezone"
>;

export interface TwoFactorStanding {
  required: boolean;
  /** The member has a confirmed second factor. */
  satisfied: boolean;
  /** First instant they are refused (exclusive). Null when nothing is required. */
  deadline: Date | null;
  /** The last day they still have, YYYY-MM-DD in the organization's zone. */
  deadlineDay: string | null;
  /** Required, not satisfied, and the deadline has passed. */
  blocked: boolean;
}

const addDays = (day: string, n: number) => {
  let d = day;
  for (let i = 0; i < n; i++) d = nextDay(d);
  return d;
};

/**
 * The last day this member may still go without 2FA, in the organization's zone. Everyone gets
 * the day `mfaGraceDays` after the requirement started; someone who joined after it started gets
 * the rest of the day they joined. Calendar days, so a DST change moves the instant, not the day.
 */
export function memberDeadlineDay(org: OrgPolicy, joinedAt: Date): string | null {
  if (!org.requireMfa || !org.mfaRequiredSince) return null;
  if (joinedAt.getTime() > org.mfaRequiredSince.getTime()) {
    return zonedDayString(joinedAt, org.timezone);
  }
  return addDays(zonedDayString(org.mfaRequiredSince, org.timezone), org.mfaGraceDays);
}

/** One member against one organization's requirement. Pure. */
export function twoFactorStanding(input: {
  org: OrgPolicy;
  joinedAt: Date;
  satisfied: boolean;
  now?: Date;
}): TwoFactorStanding {
  const { org, joinedAt, satisfied } = input;
  if (!org.requireMfa) {
    return { required: false, satisfied, deadline: null, deadlineDay: null, blocked: false };
  }
  const deadlineDay = memberDeadlineDay(org, joinedAt);
  // A requirement with no start cannot have a deadline: it blocks rather than switching itself
  // off. The CHECK in 0329 makes that state unreachable; this is the belt to its braces.
  const deadline = deadlineDay ? zonedDayEndExclusive(deadlineDay, org.timezone) : null;
  const now = (input.now ?? new Date()).getTime();
  return {
    required: true,
    satisfied,
    deadline,
    deadlineDay,
    blocked: !satisfied && (deadline === null || now >= deadline.getTime()),
  };
}

async function hasConfirmedFactor(userId: string): Promise<boolean> {
  const [row] = await systemDb
    .select({ at: userMfa.confirmedAt })
    .from(userMfa)
    .where(eq(userMfa.userId, userId))
    .limit(1);
  return !!row?.at;
}

/**
 * This person's standing in this organization. Costs no query when the organization requires
 * nothing, which is the hot path of every authenticated request.
 */
export async function standingFor(
  userId: string,
  org: OrgRow,
  now: Date = new Date(),
): Promise<TwoFactorStanding> {
  if (!org.requireMfa) {
    return { required: false, satisfied: false, deadline: null, deadlineDay: null, blocked: false };
  }
  const [m] = await systemDb
    .select({ joinedAt: memberships.acceptedAt })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.organizationId, org.id),
        isNotNull(memberships.acceptedAt),
      ),
    )
    .limit(1);
  return twoFactorStanding({
    org,
    // No membership row cannot reach here through a session; treat it as joining now.
    joinedAt: m?.joinedAt ?? now,
    satisfied: await hasConfirmedFactor(userId),
    now,
  });
}

/** Every organization this person belongs to that requires 2FA. */
export async function organizationsRequiringTwoFactor(
  userId: string,
): Promise<Array<{ id: string; publicId: string; name: string }>> {
  return systemDb
    .select({ id: organizations.id, publicId: organizations.publicId, name: organizations.name })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(organizations.requireMfa, true),
        isNotNull(memberships.acceptedAt),
      ),
    );
}

/** Turning the requirement on needs the caller's own confirmed 2FA. */
export class TwoFactorSetupRequiredError extends Error {
  constructor(
    message = "Enable two-factor authentication for yourself before you make it necessary.",
  ) {
    super(message);
    this.name = "TwoFactorSetupRequiredError";
  }
}

/** Turning 2FA off is refused while an organization the person is in requires it. */
export class OrganizationRequiresTwoFactorError extends Error {
  constructor(readonly organizations: Array<{ publicId: string; name: string }>) {
    super(
      organizations.length === 1
        ? `${organizations[0]!.name} requires two-factor authentication. You cannot disable it.`
        : `${organizations[0]!.name} and ${organizations.length - 1} other organization${
            organizations.length > 2 ? "s" : ""
          } require two-factor authentication, so you cannot disable it.`,
    );
    this.name = "OrganizationRequiresTwoFactorError";
  }
}

/** "8 Oct 2026" for a YYYY-MM-DD day. */
export function formatDay(day: string): string {
  const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

interface MemberRow {
  userId: string;
  email: string;
  name: string | null;
  joinedAt: Date;
  satisfied: boolean;
}

async function membersOf(organizationId: string): Promise<MemberRow[]> {
  const rows = await systemDb
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      joinedAt: memberships.acceptedAt,
      confirmedAt: userMfa.confirmedAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(userMfa, eq(userMfa.userId, memberships.userId))
    // Pending invites (0498) are not members yet, and their account is not the org's to see.
    .where(and(eq(memberships.organizationId, organizationId), isNotNull(memberships.acceptedAt)))
    .orderBy(memberships.createdAt);
  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    name: r.name,
    joinedAt: r.joinedAt!,
    satisfied: !!r.confirmedAt,
  }));
}

/**
 * Turn the requirement on or off. Repeating the current state changes nothing, so nobody's
 * grace period restarts because an admin pressed Save twice.
 *
 * On: the caller must hold 2FA themselves, and every member without it is emailed.
 */
export async function setOrganizationRequireMfa(input: {
  organizationId: string;
  actorUserId: string;
  enabled: boolean;
  ctx?: SecurityContext;
  now?: Date;
}): Promise<{ changed: boolean; notified: number }> {
  const now = input.now ?? new Date();
  const [org] = await systemDb
    .select()
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1);
  if (!org) throw new Error("organization not found");
  if (org.requireMfa === input.enabled) return { changed: false, notified: 0 };

  if (input.enabled && !(await hasConfirmedFactor(input.actorUserId))) {
    throw new TwoFactorSetupRequiredError();
  }

  // Guarded on the current value, so two admins toggling at once cannot both "turn it on" and
  // send two rounds of mail.
  const [updated] = await systemDb
    .update(organizations)
    .set(
      input.enabled
        ? { requireMfa: true, mfaRequiredSince: now, mfaRequiredBy: input.actorUserId }
        : { requireMfa: false, mfaRequiredSince: null, mfaRequiredBy: null },
    )
    .where(and(eq(organizations.id, org.id), eq(organizations.requireMfa, !input.enabled)))
    .returning();
  if (!updated) return { changed: false, notified: 0 };

  const [actor] = await systemDb
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, input.actorUserId))
    .limit(1);
  await writeAuditLog({
    organizationId: org.id,
    action: input.enabled ? "organization.two_factor.enable" : "organization.two_factor.disable",
    resourceType: "organization",
    resourceId: org.publicId,
    before: { require_two_factor: org.requireMfa, grace_days: org.mfaGraceDays },
    after: {
      require_two_factor: updated.requireMfa,
      grace_days: updated.mfaGraceDays,
      required_since: updated.mfaRequiredSince,
    },
    actor: actor?.email ?? null,
    source: "dashboard",
  });

  const ctx = input.ctx ?? {};
  await securityEvent(
    input.actorUserId,
    input.enabled ? "org_two_factor_required_on" : "org_two_factor_required_off",
    { ctx, metadata: { organization: org.publicId } },
  );
  if (!input.enabled) {
    log.info("organization no longer requires 2FA", { organizationId: org.publicId });
    return { changed: true, notified: 0 };
  }

  const requiredBy = actor?.name || actor?.email || "An admin";
  let notified = 0;
  for (const m of await membersOf(org.id)) {
    if (m.satisfied || m.userId === input.actorUserId) continue;
    const day = memberDeadlineDay(updated, m.joinedAt);
    await securityEvent(m.userId, "org_two_factor_required", {
      metadata: { organization: org.publicId },
      email: {
        organizationName: org.name,
        requiredBy,
        deadlineDay: day ? formatDay(day) : null,
      },
    });
    notified++;
  }
  log.info("organization now requires 2FA", { organizationId: org.publicId, notified });
  return { changed: true, notified };
}

export interface OrgTwoFactorSummary {
  required: boolean;
  requiredSince: Date | null;
  requiredBy: { email: string; name: string | null } | null;
  graceDays: number;
  /** The grace deadline for members who were there when it started. */
  deadline: Date | null;
  deadlineDay: string | null;
  members: number;
  membersWithTwoFactor: number;
  /** Without 2FA and still inside their deadline. */
  inGrace: number;
  /**
   * The day every member still in grace must set it up by, when they share one. Null when they
   * differ (someone joined after the requirement started) or nobody is in grace.
   */
  inGraceDeadlineDay: string | null;
  /** Without 2FA and past their deadline. */
  blocked: number;
}

/** What the Settings → Security card shows. */
export async function organizationTwoFactorSummary(
  organizationId: string,
  now: Date = new Date(),
): Promise<OrgTwoFactorSummary> {
  const [org] = await systemDb
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!org) throw new Error("organization not found");
  const members = await membersOf(org.id);
  let inGrace = 0;
  let blocked = 0;
  const graceDays = new Set<string | null>();
  for (const m of members) {
    if (m.satisfied) continue;
    const s = twoFactorStanding({ org, joinedAt: m.joinedAt, satisfied: false, now });
    if (!s.required) continue;
    if (s.blocked) blocked++;
    else {
      inGrace++;
      graceDays.add(s.deadlineDay);
    }
  }
  let requiredBy: OrgTwoFactorSummary["requiredBy"] = null;
  if (org.mfaRequiredBy) {
    const [u] = await systemDb
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, org.mfaRequiredBy))
      .limit(1);
    requiredBy = u ?? null;
  }
  const deadlineDay =
    org.requireMfa && org.mfaRequiredSince
      ? addDays(zonedDayString(org.mfaRequiredSince, org.timezone), org.mfaGraceDays)
      : null;
  return {
    required: org.requireMfa,
    requiredSince: org.requireMfa ? org.mfaRequiredSince : null,
    requiredBy,
    graceDays: org.mfaGraceDays,
    deadline: deadlineDay ? zonedDayEndExclusive(deadlineDay, org.timezone) : null,
    deadlineDay,
    members: members.length,
    membersWithTwoFactor: members.filter((m) => m.satisfied).length,
    inGrace,
    inGraceDeadlineDay: graceDays.size === 1 ? [...graceDays][0]! : null,
    blocked,
  };
}

/**
 * Remind members whose deadline is today or tomorrow (organization zone). One reminder per
 * member, organization and deadline: the INSERT into `org_mfa_reminders` is the claim, and only
 * the request whose insert landed sends.
 *
 * The window opens the day before because deadlines are the end of a day — a strict "within 24
 * hours" would only open on the deadline day itself.
 */
export async function sendOrgMfaDeadlineReminders(
  now: Date = new Date(),
): Promise<{ sent: number }> {
  const orgs = await systemDb
    .select()
    .from(organizations)
    .where(and(eq(organizations.requireMfa, true), isNotNull(organizations.mfaRequiredSince)));
  let sent = 0;
  for (const org of orgs) {
    const today = zonedDayString(now, org.timezone);
    const tomorrow = nextDay(today);
    const rows = await systemDb
      .select({ userId: users.id, joinedAt: memberships.acceptedAt })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(userMfa, eq(userMfa.userId, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, org.id),
          isNull(userMfa.confirmedAt),
          isNotNull(memberships.acceptedAt),
        ),
      );
    for (const r of rows) {
      const s = twoFactorStanding({ org, joinedAt: r.joinedAt!, satisfied: false, now });
      if (!s.deadline || !s.deadlineDay || s.blocked) continue;
      if (s.deadlineDay !== today && s.deadlineDay !== tomorrow) continue;
      const claimed = await systemDb
        .insert(orgMfaReminders)
        .values({ organizationId: org.id, userId: r.userId, deadline: s.deadline })
        .onConflictDoNothing()
        .returning();
      if (claimed.length === 0) continue;
      await securityEvent(r.userId, "org_two_factor_deadline_reminder", {
        metadata: { organization: org.publicId, deadline_day: s.deadlineDay },
        email: {
          organizationName: org.name,
          deadlineDay: formatDay(s.deadlineDay),
          deadlineIsToday: s.deadlineDay === today,
        },
      });
      sent++;
    }
  }
  return { sent };
}

/**
 * A member without 2FA may not mint a new API key while the organization requires 2FA — inside
 * the grace period too, since a key outlives any deadline. Existing keys keep working.
 */
export async function newApiKeyRefusedFor(
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const [org] = await systemDb
    .select({ requireMfa: organizations.requireMfa })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!org?.requireMfa) return false;
  return !(await hasConfirmedFactor(userId));
}

/** `standingFor`, by organization id. For routes that hold only an id. */
export async function standingInOrganization(
  userId: string,
  organizationId: string,
  now: Date = new Date(),
): Promise<TwoFactorStanding & { organizationName: string; organizationPublicId: string }> {
  const [org] = await systemDb
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!org) throw new Error("organization not found");
  return {
    ...(await standingFor(userId, org, now)),
    organizationName: org.name,
    organizationPublicId: org.publicId,
  };
}

import Link from "next/link";
import type { OrganizationTwoFactor } from "@/lib/session";

/**
 * "{Org} requires two-factor authentication" (0329), under the top of the shell while a member
 * without 2FA is inside the grace period. Past the deadline the gate page replaces the app, so
 * this only ever counts down.
 */
const ymd = (d: Date, tz: string | null) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: tz ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

const long = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/** The grace period's deadline in words, or null when no 2FA is due. Shared with the sign-in dialog. */
export function twoFactorGrace(
  standing: OrganizationTwoFactor | null | undefined,
  /** The organization's zone: its deadline is a day there. */
  tz: string | null,
): { org: string; date: string; when: string } | null {
  if (!standing?.required || standing.satisfied || standing.blocked || !standing.deadline_day)
    return null;
  const left = daysBetween(ymd(new Date(), tz), standing.deadline_day);
  const when = left <= 0 ? "today" : left === 1 ? "tomorrow" : `${left} days from now`;
  return { org: standing.organization.name, date: long(standing.deadline_day), when };
}

export function TwoFactorGraceBanner({
  standing,
  tz,
}: {
  standing: OrganizationTwoFactor | null | undefined;
  tz: string | null;
}) {
  const grace = twoFactorGrace(standing, tz);
  if (!grace) return null;
  return (
    <div
      role="status"
      className="z-40 flex flex-none flex-wrap items-center justify-center gap-x-2 gap-y-1 bg-warning-soft px-3 py-1.5 text-center text-sm text-warning"
    >
      <span>
        <strong className="font-semibold">{grace.org}</strong> requires two-factor authentication.
        Enable it by {grace.date} ({grace.when}) to keep access.
      </span>
      <Link href="/account#two-factor" className="font-semibold underline underline-offset-2">
        Enable 2FA
      </Link>
    </div>
  );
}

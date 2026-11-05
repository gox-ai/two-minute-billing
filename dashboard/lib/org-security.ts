import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE } from "@/lib/auth-cookies";
import { forwardedFor } from "@/lib/forwarded-for";

/**
 * The organization's "Require two-factor authentication" setting (0329), for Settings →
 * Security. A plain module: exporting a read from a `'use server'` file would make it an endpoint.
 */
const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

export interface OrganizationSecurity {
  require_two_factor: boolean;
  required_since: string | null;
  required_by: { email: string; name: string | null } | null;
  grace_days: number;
  deadline: string | null;
  /** The grace period's last day, YYYY-MM-DD in the organization's zone. */
  deadline_day: string | null;
  members: number;
  members_with_two_factor: number;
  members_in_grace: number;
  /** The day everyone still in grace shares, or null when their deadlines differ. */
  members_in_grace_deadline_day: string | null;
  members_blocked: number;
  caller_has_two_factor: boolean;
  caller_role?: string;
  /** The organization's own session policy (0482). Null = the installation value. */
  session_idle_minutes?: number | null;
  session_absolute_ttl_hours?: number | null;
  mfa_required_roles?: string[];
  /** The installation values the policy can only tighten. */
  deployment?: {
    session_idle_minutes: number;
    session_absolute_ttl_hours: number;
    mfa_required_roles: string[];
  };
}

/** Null when the engine could not answer; the card says so rather than guessing a state. */
export async function getOrganizationSecurity(): Promise<OrganizationSecurity | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");
  try {
    const res = await fetch(`${BASE}/auth/organization/security`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}`, ...(await forwardedFor()) },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as OrganizationSecurity;
  } catch {
    return null;
  }
}

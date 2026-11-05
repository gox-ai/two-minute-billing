import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { TEAM_ALERT_CONFIRM_COOKIE, teamAlertCookieOptions } from "@/lib/auth-cookies";

/**
 * The link in the team alert confirmation email (0495). Parks the token in a cookie and shows
 * a button: a GET that spent the token would let a mail scanner confirm the address. Not
 * validated here, so this route reveals nothing.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  (await cookies()).set(TEAM_ALERT_CONFIRM_COOKIE, token, teamAlertCookieOptions());
  redirect("/team-alerts/confirm");
}

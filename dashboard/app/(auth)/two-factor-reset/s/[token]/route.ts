import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { MFA_RESET_COOKIE, mfaResetCookieOptions } from "@/lib/auth-cookies";

/**
 * Entry point for the "Cancel the reset" link in a support 2FA-reset email. Moves the token into
 * a path-scoped HttpOnly cookie and redirects to a clean `/two-factor-reset`, like the password
 * reset exchange. A GET here cancels nothing — a mail scanner prefetching the link only sets a
 * cookie in its own jar; the page asks for a click.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  (await cookies()).set(MFA_RESET_COOKIE, token, mfaResetCookieOptions());
  redirect("/two-factor-reset");
}

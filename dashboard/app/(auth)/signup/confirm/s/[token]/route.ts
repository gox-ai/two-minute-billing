import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SIGNUP_CONFIRM_COOKIE, signupCookieOptions } from "@/lib/auth-cookies";

/**
 * The emailed confirmation link. Parks the token in a cookie and shows a button: a GET that
 * spent the token would let a mail scanner that opens links create the account and expire it
 * before the person clicks. Not validated here, so this route reveals nothing.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  (await cookies()).set(SIGNUP_CONFIRM_COOKIE, token, signupCookieOptions());
  redirect("/signup/confirm");
}

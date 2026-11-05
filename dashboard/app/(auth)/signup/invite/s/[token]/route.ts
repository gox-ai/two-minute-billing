import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SIGNUP_INVITE_COOKIE, signupCookieOptions } from "@/lib/auth-cookies";

/**
 * The emailed sign-up link (0405). Parks the token in a cookie and shows the form: the token
 * stays out of the page URL, and a mail scanner that opens the link spends nothing.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  (await cookies()).set(SIGNUP_INVITE_COOKIE, token, signupCookieOptions());
  redirect("/signup/invite");
}

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DESTINATION_CONFIRM_COOKIE, destinationCookieOptions } from "@/lib/auth-cookies";

/**
 * The link in an outside address's confirmation email (0533). Parks the token in a cookie and
 * shows a button: a GET that spent the token would let a mail scanner confirm the address.
 * Not checked here, so this route reveals nothing.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  (await cookies()).set(DESTINATION_CONFIRM_COOKIE, token, destinationCookieOptions());
  redirect("/notifications/confirm");
}

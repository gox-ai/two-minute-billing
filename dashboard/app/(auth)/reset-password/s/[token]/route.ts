import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { RESET_COOKIE, resetCookieOptions } from '@/lib/auth-cookies'

/**
 * Reset-link entry. The URL in the reset email points here and nowhere else.
 *
 * Its only job is to move the reset token out of the URL into a short-lived HttpOnly
 * cookie and redirect to a clean `/reset-password` — the same exchange 0193 established
 * for the buyer portal, for the same reasons. A reset token is a credential that grants
 * an account, and a URL is not a private place: it leaves through the `Referer` on every
 * cross-origin subresource, browser history, and any proxy access log in the path.
 *
 * The token is NOT validated here. Doing so would make this route an oracle telling a
 * caller whether a guessed token is live; handing a bad one to the form costs one
 * rejected POST and shows the same "invalid or expired" message a real stale link gets.
 */
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  ;(await cookies()).set(RESET_COOKIE, token, resetCookieOptions())
  redirect('/reset-password')
}

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { INVITE_COOKIE, inviteCookieOptions } from '@/lib/auth-cookies'

/**
 * Invite entry. The link in the invite email points here and nowhere else.
 *
 * Moves the single-use invite token out of the URL into a short-lived HttpOnly cookie and
 * redirects to a clean `/invite` — the same exchange 0193 established for the buyer portal
 * and 0194 for password resets. An invite token grants the ability to SET a password on an
 * account, so it is a credential, and a URL is not a private place: it leaks through the
 * `Referer` on every cross-origin subresource, browser history, and any proxy access log
 * in the path.
 *
 * Not validated here, deliberately — doing so would make this route an oracle telling a
 * caller whether a guessed token is live. A bad one costs a rejected POST and shows the
 * same "invalid or expired" message a genuinely stale invite gets.
 */
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  ;(await cookies()).set(INVITE_COOKIE, token, inviteCookieOptions())
  redirect('/invite')
}

import { getBusiness } from '@/lib/api/business-settings'

/**
 * The business's IANA timezone, for **server** code that must format a date — server
 * actions building a success toast, and server components that cannot read the
 * `useBusinessTz()` context.
 *
 * Client components must NOT use this; they read the context, which is already populated
 * by the `/businesses/[biz]` layout.
 *
 * Falls back to UTC so a formatting helper never throws inside an action that already
 * succeeded — a toast rendering in the wrong zone is bad, but losing the confirmation for
 * a write that went through is worse.
 */
export async function businessTz(biz: string): Promise<string> {
  try {
    return (await getBusiness(biz))?.timezone ?? 'UTC'
  } catch {
    return 'UTC'
  }
}

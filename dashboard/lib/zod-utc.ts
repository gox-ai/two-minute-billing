import { z } from 'zod'
import { NOT_UTC_MESSAGE, isZoneQualified } from '@/lib/tz'

/**
 * Zod schemas for dated form fields, enforcing that the value arrived as an absolute
 * **UTC** instant rather than a bare wall clock.
 *
 * Every dated control in the dashboard goes through `DateTimeField`, which shows the
 * operator a business-timezone clock and submits UTC. These schemas are the second half
 * of that contract: if a form is ever wired with a raw `<input type="datetime-local">`
 * again, the action fails with a field error naming the cause instead of accepting
 * `2026-08-21T00:00` and letting `new Date()` resolve it in the SERVER's zone — which is
 * how every dated write on an Asia/Kolkata business ended up 5h30m off.
 *
 * The check is deliberately at the schema, not the call site: a new dated field gets it by
 * declaring its type, and cannot forget a guard.
 */
const zoneQualified = (v: string) => isZoneQualified(v)

/** A required dated field: must be present AND zone-qualified. */
export const utcDateTime = (whenMissing: string) =>
  z.string().min(1, whenMissing).refine(zoneQualified, NOT_UTC_MESSAGE)

/**
 * An optional dated field. `''` (an empty input) becomes undefined; anything present must
 * be zone-qualified.
 */
export const optUtcDateTime = z.preprocess(
  (v) => (v === '' || v == null ? undefined : v),
  z.string().refine(zoneQualified, NOT_UTC_MESSAGE).optional(),
)

/** Guard for dated values not routed through a zod schema (raw payload objects). */
export function assertUtc(value: string, field: string): string {
  if (!isZoneQualified(value)) throw new Error(`${field}: ${NOT_UTC_MESSAGE}`)
  return new Date(value).toISOString()
}

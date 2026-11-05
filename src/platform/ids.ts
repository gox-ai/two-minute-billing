import { randomBytes } from "node:crypto";
import { customAlphabet } from "nanoid";

// URL-safe, unambiguous-ish alphabet for public object ids.
const tail = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", 15);

/**
 * Stable, customer-facing id with a type prefix, e.g. `ten_…`, `cus_…`, `sub_…`.
 * Distinct from the internal UUID PK so ids are safe to expose and migration-stable.
 *
 * 24 characters after the prefix: the creation time in ms (9 chars, base36 lowercase, so text
 * order is time order under any collation), then 15 random (~89 bits). Time first keeps inserts at
 * the right edge of each `public_id` index instead of a random page (D4.10).
 */
export function publicId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36).padStart(9, "0")}${tail()}`;
}

/** RFC 9562 UUIDv7 (48-bit ms timestamp, then random), the app-side twin of SQL `uuid_v7()`. */
export function uuidv7(): string {
  const b = randomBytes(16);
  b.writeUIntBE(Date.now(), 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

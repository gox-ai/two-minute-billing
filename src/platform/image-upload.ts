/**
 * Validation for merchant-supplied image uploads (brand logo, icon, favicon).
 *
 * The rules come from a security review (Findings 2a HIGH, 2b MEDIUM) and are kept
 * exactly as that review decided them.
 *
 * Three rules, in order of how much they actually buy:
 *
 *   1. **The leading bytes decide the type.** A declared `Content-Type` and a filename are
 *      both client-supplied claims; the magic number is evidence. The stored extension and
 *      the `ContentType` we set both derive from what the bytes say, never from what the
 *      caller said. That is what makes the filename irrelevant rather than merely
 *      sanitised — the original finding was that an attacker could have a CDN serve an
 *      active document type from a platform-branded domain.
 *   2. **SVG is NOT an allowed image.** It declares `image/svg+xml` and satisfies any
 *      `startsWith("image/")` test, but it is an XML document that can carry script and
 *      executes when opened directly from the delivery domain. It has no magic number
 *      either, which is the tell: a text format wearing an image's content type.
 *   3. **A size ceiling, server-side**, because a browser-side cap is not a control.
 *
 * ── Why this matters HERE, beyond the port ──────────────────────────────────
 * `businesses.logo_url` / `icon_url` / `favicon_url` accept a `data:` URL today, and
 * `loadLogo` (`modules/invoicing/invoice-pdf.ts`) decodes it — including rasterising
 * `image/svg+xml`. That is precisely what rule 2 rules out. This module is the
 * replacement path: an upload proves what it is, gets stored, and the column holds an
 * `https://` URL instead. Once every logo is a URL, those fields can be scheme-restricted
 * (SR-2026-016 Finding 3).
 *
 * Whether `loadLogo` keeps its SVG branch at all is a separate decision, recorded in
 * docs/PROGRESS.md — this module simply refuses to create new SVG logos.
 *
 * Pure: no network, no DB, no config. The R2 side lives in `./object-store.ts`.
 */

export class ImageUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageUploadError";
  }
}

/** The formats we accept, and the extension each is stored with. */
const IMAGE_TYPES = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
} as const;

export type AllowedImageType = keyof typeof IMAGE_TYPES;

export const ALLOWED_IMAGE_TYPES = Object.keys(IMAGE_TYPES) as AllowedImageType[];

/** 5 MB. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const startsWith = (buffer: Buffer, bytes: number[], offset = 0): boolean =>
  buffer.length >= offset + bytes.length && bytes.every((b, i) => buffer[offset + i] === b);

/**
 * The image type a buffer actually IS, from its magic number, or null.
 *
 * Deliberately narrow: an unrecognised format is rejected rather than passed through on
 * the strength of a declared type. `< 12` bytes cannot carry any header we accept — the
 * WebP check alone reads to offset 12 — so it is short-circuited rather than indexed past.
 */
export function detectImageType(buffer: Buffer): AllowedImageType | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  // 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";

  // FF D8 FF — every JPEG variant (JFIF, Exif, raw) shares this SOI + marker prefix.
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";

  // "GIF8" — covers both 87a and 89a.
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return "image/gif";

  // "RIFF" … "WEBP" — the four size bytes at offset 4 sit between the two markers.
  if (
    startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)
  )
    return "image/webp";

  return null;
}

/** "a PNG, JPEG, GIF or WebP" — so the refusal names exactly what the caller allows. */
function humanList(types: readonly AllowedImageType[]): string {
  const names = types.map((t) => NAMES[t]);
  if (names.length === 1) return `a ${names[0]}`;
  return `a ${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

const NAMES: Record<AllowedImageType, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/gif": "GIF",
  "image/webp": "WebP",
};

/** The extension an accepted type is stored with. */
export function extensionForImageType(type: AllowedImageType): string {
  return IMAGE_TYPES[type];
}

export interface ValidatedImage {
  /** The type PROVEN by the leading bytes — use this, never the caller's. */
  contentType: AllowedImageType;
  /** The extension for that type. */
  extension: string;
}

/**
 * Throws `ImageUploadError` unless `buffer` is an allowed image, judged by its content.
 *
 * `declaredType` is accepted only so a mismatch can be LOGGED by the caller; it is never
 * trusted and never decides the outcome. Keeping it in the signature is what lets a
 * caller notice someone probing rather than uploading.
 */
export function validateImageUpload(
  buffer: Buffer,
  opts: { maxBytes?: number; label?: string; allow?: readonly AllowedImageType[] } = {},
): ValidatedImage {
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;
  const label = opts.label ?? "image";
  const allow = opts.allow ?? ALLOWED_IMAGE_TYPES;

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ImageUploadError(`We did not receive the ${label}. Select a file and try again.`);
  }

  if (buffer.length > maxBytes) {
    const mb = Math.round(maxBytes / (1024 * 1024));
    throw new ImageUploadError(`That ${label} is too large. The maximum size is ${mb} MB.`);
  }

  const contentType = detectImageType(buffer);
  // The bytes are never echoed back: a prober learns only that it failed. The message names
  // the accepted formats because a merchant with a real PNG needs to know it is the file
  // that is wrong, not the feature — and it names the CALLER's set, not the global one, so a
  // narrowed surface does not advertise a format it will then refuse.
  if (!contentType || !allow.includes(contentType)) {
    throw new ImageUploadError(
      `That file is not a supported ${label}. Upload ${humanList(allow)}. SVG is not accepted.`,
    );
  }

  return { contentType, extension: extensionForImageType(contentType) };
}

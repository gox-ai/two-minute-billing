/**
 * Object storage for merchant brand assets — Cloudflare R2 over the S3 API, or any
 * S3-compatible store when `OBJECT_STORE_ENDPOINT` is set (MinIO, AWS S3).
 *
 * Deliberately thin: byte-level validation lives in `./image-upload.ts`.
 *
 * ── THREE STATES, and the middle one is why this module exists ───────────────
 *   not configured  → `uploadBrandImage` REFUSES, naming the unset variables.
 *   configured, ok  → store the object, return an `https://` CDN URL.
 *   configured, but R2 rejects the write → the SDK's error propagates unchanged.
 *
 * The refusal is checked BEFORE any bytes are read and is reachable without credentials
 * (`objectStoreStatus`), so the dashboard can hide the upload control on a deployment that
 * has no bucket instead of offering one that fails on click. tmbilling runs fine with none
 * of this set — the whole feature is optional, like `TURNSTILE_*` and `SMTP_*` — and an
 * unconfigured deployment must fail at the door, not at the first upload.
 *
 * ── Why the S3 client is lazy ────────────────────────────────────────────────
 * Constructing it eagerly would make importing this module a credential read, and both the
 * test suite and every `tsx` script import the platform layer. It is built on first use and
 * memoised; when unconfigured it is never built at all.
 *
 * ── Brand images are never deleted; profile photos are ────────────────────────
 * Replacing a logo leaves the old object in the bucket. That is the intended trade: keys
 * carry a random suffix, so a stored URL is never silently repointed, and an email sent last
 * month still resolves the logo it was sent with (the outbox copies `logoUrl` into each
 * queued message). Orphans cost storage, which the upload rate limits bound; a delete costs
 * a broken image in someone's inbox.
 *
 * A profile photo appears in no email or document, so a replaced or removed one IS deleted
 * (`deleteStoredImage`), and only when its URL is provably ours and the owner's own.
 */
import { randomBytes } from "node:crypto";
import { config } from "./config";
import { createLogger } from "./logger";
import { ALLOWED_IMAGE_TYPES, validateImageUpload, type AllowedImageType } from "./image-upload";

const log = createLogger("object-store");

/**
 * The deployment has no bucket. Distinct from `ImageUploadError` on purpose: that one is
 * the merchant's file being wrong (a 400), this one is our own configuration being absent
 * (a 503) — and conflating them would tell a merchant to fix a file that is fine.
 */
export class ObjectStoreNotConfiguredError extends Error {
  constructor(readonly missing: string[]) {
    super(
      `Object storage is not configured on this deployment (unset: ${missing.join(", ")}). ` +
        `Brand image uploads are unavailable until it is.`,
    );
    this.name = "ObjectStoreNotConfiguredError";
  }
}

/** Which brand asset an upload is for. Decides the key prefix and the error wording. */
/** `avatar` is a person's profile photo — uploaded by `/auth/me/avatar`, never a brand route. */
export type BrandAsset = "logo" | "icon" | "favicon" | "signature" | "avatar" | "product";

const ASSET_LABELS: Record<BrandAsset, string> = {
  logo: "logo",
  icon: "icon",
  favicon: "favicon",
  signature: "signature image",
  avatar: "profile photo",
  product: "product image",
};

/**
 * What each asset accepts — NARROWER than the org-wide set for the two that get printed.
 *
 * `loadLogo` (`modules/invoicing/invoice-pdf.ts`) can embed PNG and JPEG, and rasterise an
 * SVG; it cannot embed GIF or WebP and logs "not a format the PDF can embed" before falling
 * back to the seller's name. So a WebP logo would render on the portal, the checkout and the
 * email and leave the invoice with NO letterhead — a control that works on three surfaces out
 * of four is the kind of half-truth CLAUDE.md rule 0 is about.
 *
 * Icons and favicons never reach a PDF, so they keep the full set. If `loadLogo` ever grows a
 * converter, widening these two lines is the whole change.
 */
const PRINTABLE = ["image/png", "image/jpeg"] as const satisfies readonly AllowedImageType[];

const ASSET_ALLOWS: Record<BrandAsset, readonly AllowedImageType[]> = {
  logo: PRINTABLE,
  signature: PRINTABLE,
  icon: ALLOWED_IMAGE_TYPES,
  favicon: ALLOWED_IMAGE_TYPES,
  avatar: ALLOWED_IMAGE_TYPES,
  // Shown on web pages only, never embedded in a PDF.
  product: ALLOWED_IMAGE_TYPES,
};

/** The formats an asset accepts — the dashboard reads this to set its file picker's filter. */
export const allowedTypesFor = (asset: BrandAsset): readonly AllowedImageType[] =>
  ASSET_ALLOWS[asset];

/** The settings a working upload needs, all of them. */
const REQUIRED = [
  "R2_ACCOUNT_ID",
  "R2_BUCKET_NAME",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "CDN_URL",
] as const;

export interface ObjectStoreStatus {
  configured: boolean;
  /** The required settings that are unset. Empty iff `configured`. */
  missing: string[];
}

/**
 * Whether uploads can work here, and what is missing if not.
 *
 * Safe to call with nothing configured — this is the check the route and the dashboard both
 * use, and it must never throw.
 */
export function objectStoreStatus(): ObjectStoreStatus {
  // Any S3-compatible endpoint replaces the R2 account id.
  const required = config.OBJECT_STORE_ENDPOINT
    ? REQUIRED.filter((k) => k !== "R2_ACCOUNT_ID")
    : REQUIRED;
  const missing = required.filter((k) => !config[k]);
  return { configured: missing.length === 0, missing: [...missing] };
}

export const isObjectStoreConfigured = (): boolean => objectStoreStatus().configured;

/** What `uploadBrandImage` stores an object with. Mirrors `PutObjectCommand`'s input. */
export interface PutObject {
  Bucket: string;
  Key: string;
  Body: Buffer;
  ContentType: string;
  CacheControl?: string;
}

/** The write itself, isolated so the branches above are testable without a bucket. */
export type ObjectSender = (put: PutObject) => Promise<void>;

/** The delete, isolated the same way. */
export type ObjectDeleter = (del: { Bucket: string; Key: string }) => Promise<void>;

let cachedSender: ObjectSender | null = null;
let cachedDeleter: ObjectDeleter | null = null;

/**
 * Replace the R2 write and delete for this process, for suites that drive the real routes.
 * `null` restores the real client.
 */
let testDriver: { sender: ObjectSender; deleter: ObjectDeleter } | null = null;
export function setObjectStoreDriverForTests(
  driver: { sender: ObjectSender; deleter: ObjectDeleter } | null,
): void {
  testDriver = driver;
}

/**
 * The real R2 write. Built on first use, then memoised — see the header on why it is not
 * constructed at import time.
 */
async function r2Client() {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({
    // R2 is single-region by design; "auto" is what Cloudflare documents for the S3 API.
    region: config.OBJECT_STORE_REGION,
    endpoint:
      config.OBJECT_STORE_ENDPOINT ?? `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    // MinIO and most self-hosted stores do not serve bucket subdomains.
    forcePathStyle: config.OBJECT_STORE_FORCE_PATH_STYLE === "TRUE",
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID!,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY!,
    },
  });
}

async function r2Sender(): Promise<ObjectSender> {
  if (testDriver) return testDriver.sender;
  if (cachedSender) return cachedSender;
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const client = await r2Client();
  cachedSender = async (put) => {
    await client.send(new PutObjectCommand(put));
  };
  return cachedSender;
}

async function r2Deleter(): Promise<ObjectDeleter> {
  if (testDriver) return testDriver.deleter;
  if (cachedDeleter) return cachedDeleter;
  const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  const client = await r2Client();
  cachedDeleter = async (del) => {
    await client.send(new DeleteObjectCommand(del));
  };
  return cachedDeleter;
}

/** Drop the memoised client. For tests, and after a config change in a long-lived process. */
export function resetObjectStore(): void {
  cachedSender = null;
  cachedDeleter = null;
}

/**
 * Whose image this is. The PUBLIC id (`biz_...` / `org_...` / `usr_...`) becomes a path segment of the
 * object key, so it is validated below — a value carrying `/` or `..` would be key injection.
 */
export interface BrandImageOwner {
  kind: "business" | "organization" | "user";
  publicId: string;
}

/** Key folder per owner kind. `business_assets` predates the organization and must not move. */
const OWNER_FOLDERS: Record<BrandImageOwner["kind"], string> = {
  business: "business_assets",
  organization: "organization_assets",
  user: "user_assets",
};

export interface UploadBrandImageInput {
  owner: BrandImageOwner;
  asset: BrandAsset;
  buffer: Buffer;
  /**
   * The `Content-Type` the client claimed. Never trusted and never decides the outcome —
   * kept only so a mismatch can be logged, which is what distinguishes someone probing
   * from someone uploading.
   */
  declaredType?: string | null;
  /** Test seam. Defaults to the real R2 write. */
  sender?: ObjectSender;
}

export interface UploadedImage {
  /** An `https://` CDN URL — this is what goes in `businesses.logo_url`. */
  url: string;
  key: string;
  contentType: AllowedImageType;
  bytes: number;
}

/**
 * Validate an image by its leading bytes, store it, and return the URL to persist.
 *
 * Throws `ObjectStoreNotConfiguredError` when the deployment has no bucket, and
 * `ImageUploadError` when the file is not an allowed image. The order matters: the
 * configuration check runs first, so a merchant on a deployment without storage is told
 * that rather than being told their perfectly good PNG was rejected.
 */
export async function uploadBrandImage(input: UploadBrandImageInput): Promise<UploadedImage> {
  const status = objectStoreStatus();
  if (!status.configured) throw new ObjectStoreNotConfiguredError(status.missing);

  // The id is interpolated into an object key. Every id we mint satisfies this, so a
  // failure here means the caller passed something that was not one — refuse rather than
  // write to a key someone else chose the shape of.
  const ownerId = input.owner.publicId;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(ownerId)) {
    throw new Error(`Refusing to build an object key from ${JSON.stringify(ownerId)}`);
  }

  const label = ASSET_LABELS[input.asset];
  const { contentType, extension } = validateImageUpload(input.buffer, {
    label,
    allow: ASSET_ALLOWS[input.asset],
  });

  if (input.declaredType && input.declaredType !== contentType) {
    log.warn("upload content type mismatch", {
      event: "object_store_type_mismatch",
      asset: input.asset,
      declared: input.declaredType,
      actual: contentType,
      owner: input.owner.kind,
      ownerId,
    });
  }

  // Random suffix, not a content hash: it makes the URL unguessable from the owner's id
  // and it means a replacement never reuses a key a rendered PDF already points at.
  const key =
    `${config.R2_KEY_PREFIX}/${OWNER_FOLDERS[input.owner.kind]}/${ownerId}/` +
    `${input.asset}-${randomBytes(8).toString("hex")}${extension}`;

  const send = input.sender ?? (await r2Sender());
  await send({
    Bucket: config.R2_BUCKET_NAME!,
    Key: key,
    Body: input.buffer,
    ContentType: contentType,
    // Immutable: the key changes on every upload, so the object at a given key never does.
    CacheControl: "public, max-age=31536000, immutable",
  });

  const url = `${config.CDN_URL!.replace(/\/+$/, "")}/${key}`;
  log.info("brand image stored", {
    event: "brand_image_stored",
    asset: input.asset,
    owner: input.owner.kind,
    ownerId,
    key,
    bytes: input.buffer.length,
    contentType,
  });
  return { url, key, contentType, bytes: input.buffer.length };
}

/**
 * The object key behind `url`, or null when the URL is not one this deployment stored for
 * `owner`. The URL must start with our CDN base, and the key must sit directly in the owner's
 * own folder under our prefix, so a Google photo, another host, another owner's object or a
 * path with `..` never maps to a key.
 */
export function storedKeyFor(url: string, owner: BrandImageOwner): string | null {
  if (!config.CDN_URL || !/^[A-Za-z0-9_-]{1,128}$/.test(owner.publicId)) return null;
  const base = `${config.CDN_URL.replace(/\/+$/, "")}/`;
  if (!url.startsWith(base)) return null;
  const key = url.slice(base.length);
  const folder = `${config.R2_KEY_PREFIX}/${OWNER_FOLDERS[owner.kind]}/${owner.publicId}/`;
  if (!key.startsWith(folder)) return null;
  return /^[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(key.slice(folder.length)) ? key : null;
}

/**
 * Delete an image this deployment stored for `owner`. Anything else is left alone. Never
 * throws: the caller has already committed the change that orphaned the object, and a failed
 * delete costs storage, not correctness. Returns whether a delete was sent.
 */
export async function deleteStoredImage(input: {
  url: string | null;
  owner: BrandImageOwner;
  deleter?: ObjectDeleter;
}): Promise<boolean> {
  if (!input.url || !objectStoreStatus().configured) return false;
  const key = storedKeyFor(input.url, input.owner);
  if (!key) return false;
  try {
    const del = input.deleter ?? (await r2Deleter());
    await del({ Bucket: config.R2_BUCKET_NAME!, Key: key });
    log.info("stored image deleted", {
      event: "stored_image_deleted",
      owner: input.owner.kind,
      ownerId: input.owner.publicId,
      key,
    });
    return true;
  } catch (e) {
    log.error("stored image delete failed", {
      event: "stored_image_delete_failed",
      owner: input.owner.kind,
      ownerId: input.owner.publicId,
      key,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

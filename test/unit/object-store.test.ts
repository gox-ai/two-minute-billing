/**
 * The object store's three states, exercised WITHOUT a bucket.
 *
 * The point of this file is the middle state: a deployment with no R2 credentials must
 * refuse at the door and name what is unset, rather than construct an S3 client with
 * `undefined` credentials and discover the problem on the first merchant's upload. If this
 * suite ever needs real credentials to run, that property has been lost.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { config } from "@/platform/config";
import {
  ObjectStoreNotConfiguredError,
  isObjectStoreConfigured,
  objectStoreStatus,
  allowedTypesFor,
  resetObjectStore,
  uploadBrandImage,
  deleteStoredImage,
  storedKeyFor,
  type PutObject,
} from "@/platform/object-store";
import { ImageUploadError } from "@/platform/image-upload";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8),
]);

const BIZ = { kind: "business", publicId: "biz_1" } as const;

/** The five settings an upload needs, saved so each test can put them back. */
const KEYS = [
  "R2_ACCOUNT_ID",
  "R2_BUCKET_NAME",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "CDN_URL",
  "R2_KEY_PREFIX",
  "OBJECT_STORE_ENDPOINT",
] as const;

const saved: Record<string, unknown> = {};
const set = (values: Partial<Record<(typeof KEYS)[number], string | undefined>>) => {
  for (const [k, v] of Object.entries(values)) (config as Record<string, unknown>)[k] = v;
};

beforeEach(() => {
  for (const k of KEYS) saved[k] = config[k];
  resetObjectStore();
});
afterEach(() => {
  for (const k of KEYS) (config as Record<string, unknown>)[k] = saved[k];
  resetObjectStore();
  vi.restoreAllMocks();
});

/** Configured, with a sender that records instead of writing to R2. */
function configured() {
  set({
    R2_ACCOUNT_ID: "acct123",
    R2_BUCKET_NAME: "gox-assets",
    R2_ACCESS_KEY_ID: "ak",
    R2_SECRET_ACCESS_KEY: "sk",
    CDN_URL: "https://assets.example.com",
    R2_KEY_PREFIX: "tmbilling",
  });
  const puts: PutObject[] = [];
  return {
    puts,
    sender: async (p: PutObject) => {
      puts.push(p);
    },
  };
}

describe("not configured — the state this module exists for", () => {
  it("reports every unset setting rather than just failing", () => {
    set({
      R2_ACCOUNT_ID: undefined,
      R2_BUCKET_NAME: undefined,
      R2_ACCESS_KEY_ID: undefined,
      R2_SECRET_ACCESS_KEY: undefined,
      CDN_URL: undefined,
    });
    const s = objectStoreStatus();
    expect(s.configured).toBe(false);
    expect(s.missing).toEqual([
      "R2_ACCOUNT_ID",
      "R2_BUCKET_NAME",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "CDN_URL",
    ]);
    expect(isObjectStoreConfigured()).toBe(false);
  });

  it("treats a PARTIAL configuration as unconfigured and names only the gap", () => {
    // The failure mode worth catching: four of five set looks configured from a distance
    // and would build an S3 client that authenticates with `undefined`.
    const { sender } = configured();
    set({ R2_SECRET_ACCESS_KEY: undefined });
    expect(objectStoreStatus()).toEqual({
      configured: false,
      missing: ["R2_SECRET_ACCESS_KEY"],
    });
    return expect(
      uploadBrandImage({ owner: BIZ, asset: "logo", buffer: PNG, sender }),
    ).rejects.toThrow(ObjectStoreNotConfiguredError);
  });

  it("refuses BEFORE looking at the bytes, so the message is about us and not the file", async () => {
    set({ R2_BUCKET_NAME: undefined, CDN_URL: undefined });
    // A file that would also fail validation — the configuration error must still win,
    // because telling a merchant their file is wrong when our bucket is missing sends
    // them to fix the one thing that is fine.
    const notAnImage = Buffer.from("<svg/>                    ");
    await expect(
      uploadBrandImage({ owner: BIZ, asset: "logo", buffer: notAnImage }),
    ).rejects.toThrow(ObjectStoreNotConfiguredError);
  });

  it("names the missing settings in the message an operator will read", async () => {
    set({ R2_ACCOUNT_ID: undefined });
    await expect(uploadBrandImage({ owner: BIZ, asset: "logo", buffer: PNG })).rejects.toThrow(
      /R2_ACCOUNT_ID/,
    );
  });

  it("an S3-compatible endpoint replaces the R2 account id, and nothing else", () => {
    configured();
    set({ R2_ACCOUNT_ID: undefined, OBJECT_STORE_ENDPOINT: "http://minio.example.com:9000" });
    expect(objectStoreStatus()).toEqual({ configured: true, missing: [] });
    set({ R2_BUCKET_NAME: undefined });
    expect(objectStoreStatus().missing).toEqual(["R2_BUCKET_NAME"]);
  });

  it("is importable and answerable with nothing set — no client is ever constructed", () => {
    set({
      R2_ACCOUNT_ID: undefined,
      R2_BUCKET_NAME: undefined,
      R2_ACCESS_KEY_ID: undefined,
      R2_SECRET_ACCESS_KEY: undefined,
      CDN_URL: undefined,
    });
    expect(() => objectStoreStatus()).not.toThrow();
  });
});

describe("what each asset accepts — the PDF decides, not the org-wide set", () => {
  const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(8)]);
  const WEBP = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.from([0x1a, 0, 0, 0]),
    Buffer.from("WEBP"),
    Buffer.alloc(4),
  ]);

  it("narrows the two PRINTED assets to what loadLogo can embed", () => {
    // A WebP logo would render on the portal, checkout and email and leave the invoice
    // PDF with no letterhead. That is the whole reason these two are narrower.
    expect([...allowedTypesFor("logo")]).toEqual(["image/png", "image/jpeg"]);
    expect([...allowedTypesFor("signature")]).toEqual(["image/png", "image/jpeg"]);
  });

  it("leaves icon and favicon on the full set, because neither reaches a PDF", () => {
    expect([...allowedTypesFor("icon")].sort()).toEqual([
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
    expect([...allowedTypesFor("favicon")]).toEqual([...allowedTypesFor("icon")]);
  });

  it("refuses a GIF or WebP LOGO, and says so in terms of the logo", async () => {
    const { puts, sender } = configured();
    for (const buf of [GIF, WEBP]) {
      await expect(
        uploadBrandImage({ owner: BIZ, asset: "logo", buffer: buf, sender }),
      ).rejects.toThrow(/not a supported logo\. Upload a PNG or JPEG/i);
    }
    expect(puts).toHaveLength(0);
  });

  it("accepts the same GIF as an ICON", async () => {
    const { sender } = configured();
    const out = await uploadBrandImage({
      owner: BIZ,
      asset: "icon",
      buffer: GIF,
      sender,
    });
    expect(out.contentType).toBe("image/gif");
  });

  it("still accepts a PNG logo — the narrowing is not a ban on uploading one", async () => {
    const { sender } = configured();
    const out = await uploadBrandImage({ owner: BIZ, asset: "logo", buffer: PNG, sender });
    expect(out.contentType).toBe("image/png");
  });
});

describe("configured — what gets stored", () => {
  it("stores the object and returns the CDN URL to persist", async () => {
    const { puts, sender } = configured();
    const out = await uploadBrandImage({
      owner: BIZ,
      asset: "logo",
      buffer: PNG,
      sender,
    });

    expect(puts).toHaveLength(1);
    expect(puts[0]!.Bucket).toBe("gox-assets");
    expect(puts[0]!.Body).toBe(PNG);
    // The stored ContentType comes from the BYTES, never from a caller's claim.
    expect(puts[0]!.ContentType).toBe("image/png");
    expect(out.contentType).toBe("image/png");
    expect(out.bytes).toBe(PNG.length);
    expect(out.url).toBe(`https://assets.example.com/${out.key}`);
  });

  it("keys under the configured prefix and the business, with a random suffix", async () => {
    const { sender } = configured();
    const a = await uploadBrandImage({ owner: BIZ, asset: "logo", buffer: PNG, sender });
    const b = await uploadBrandImage({ owner: BIZ, asset: "logo", buffer: PNG, sender });

    expect(a.key).toMatch(/^tmbilling\/business_assets\/biz_1\/logo-[0-9a-f]{16}\.png$/);
    // Two uploads of the SAME bytes must not share a key — a stored URL is never
    // repointed, which is what lets an old invoice PDF keep resolving its letterhead.
    expect(b.key).not.toBe(a.key);
  });

  it("keys an organization's image under its own folder, never the business one", async () => {
    const { sender } = configured();
    const out = await uploadBrandImage({
      owner: { kind: "organization", publicId: "org_1" },
      asset: "icon",
      buffer: PNG,
      sender,
    });
    expect(out.key).toMatch(/^tmbilling\/organization_assets\/org_1\/icon-[0-9a-f]{16}\.png$/);
  });

  it("honours a changed prefix, because the bucket may be shared with another app", async () => {
    const { sender } = configured();
    set({ R2_KEY_PREFIX: "tmbilling-staging" });
    const out = await uploadBrandImage({
      owner: BIZ,
      asset: "favicon",
      buffer: PNG,
      sender,
    });
    expect(out.key.startsWith("tmbilling-staging/")).toBe(true);
  });

  it("does not double the slash when CDN_URL has a trailing one", async () => {
    const { sender } = configured();
    set({ CDN_URL: "https://assets.example.com/" });
    const out = await uploadBrandImage({ owner: BIZ, asset: "icon", buffer: PNG, sender });
    expect(out.url).toBe(`https://assets.example.com/${out.key}`);
    expect(out.url).not.toContain("//tmbilling");
  });

  it("separates the four assets by key", async () => {
    const { sender } = configured();
    for (const asset of ["logo", "icon", "favicon", "signature"] as const) {
      const out = await uploadBrandImage({ owner: BIZ, asset, buffer: PNG, sender });
      expect(out.key).toContain(`/${asset}-`);
    }
  });

  it("still rejects a non-image once configured, and stores nothing", async () => {
    const { puts, sender } = configured();
    await expect(
      uploadBrandImage({
        owner: BIZ,
        asset: "logo",
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        sender,
      }),
    ).rejects.toThrow(ImageUploadError);
    expect(puts).toHaveLength(0);
  });

  it("ignores a lying declared type instead of trusting or refusing it", async () => {
    const { puts, sender } = configured();
    const out = await uploadBrandImage({
      owner: BIZ,
      asset: "logo",
      buffer: PNG,
      declaredType: "image/svg+xml",
      sender,
    });
    // Neither the extension nor the ContentType follows the claim; the upload succeeds
    // because the bytes are a real PNG. The mismatch is logged, not enforced.
    expect(out.key.endsWith(".png")).toBe(true);
    expect(puts[0]!.ContentType).toBe("image/png");
  });

  it("marks the object immutable, which the random key makes true", async () => {
    const { puts, sender } = configured();
    await uploadBrandImage({ owner: BIZ, asset: "logo", buffer: PNG, sender });
    expect(puts[0]!.CacheControl).toMatch(/immutable/);
  });
});

describe("deleting a replaced profile photo — only ever our own object", () => {
  const ME = { kind: "user", publicId: "usr_1" } as const;
  const ours = "https://assets.example.com/tmbilling/user_assets/usr_1/avatar-0123456789abcdef.png";

  it("maps our own URL to its key and deletes it", async () => {
    configured();
    expect(storedKeyFor(ours, ME)).toBe("tmbilling/user_assets/usr_1/avatar-0123456789abcdef.png");
    const keys: string[] = [];
    const sent = await deleteStoredImage({
      url: ours,
      owner: ME,
      deleter: async (d) => void keys.push(d.Key),
    });
    expect(sent).toBe(true);
    expect(keys).toEqual(["tmbilling/user_assets/usr_1/avatar-0123456789abcdef.png"]);
  });

  it("works when CDN_URL has a trailing slash", () => {
    configured();
    set({ CDN_URL: "https://assets.example.com/" });
    expect(storedKeyFor(ours, ME)).not.toBeNull();
  });

  it.each([
    [
      "a foreign host",
      "https://evil.example.net/tmbilling/user_assets/usr_1/avatar-0123456789abcdef.png",
    ],
    ["a Google photo", "https://lh3.googleusercontent.com/a/ACg8ocXXXXXXXXXX=s96-c"],
    [
      "another owner's folder",
      "https://assets.example.com/tmbilling/user_assets/usr_2/avatar-0123456789abcdef.png",
    ],
    [
      "a business folder",
      "https://assets.example.com/tmbilling/business_assets/usr_1/logo-0123456789abcdef.png",
    ],
    [
      "a path that climbs out",
      "https://assets.example.com/tmbilling/user_assets/usr_1/../usr_2/avatar-0123456789abcdef.png",
    ],
    [
      "a host that only starts like ours",
      "https://assets.example.com.evil.net/tmbilling/user_assets/usr_1/avatar-0123456789abcdef.png",
    ],
  ])("refuses %s and sends no delete", async (_label, url) => {
    configured();
    expect(storedKeyFor(url, ME)).toBeNull();
    let calls = 0;
    expect(await deleteStoredImage({ url, owner: ME, deleter: async () => void calls++ })).toBe(
      false,
    );
    expect(calls).toBe(0);
  });

  it("never throws when the delete fails", async () => {
    configured();
    const sent = await deleteStoredImage({
      url: ours,
      owner: ME,
      deleter: async () => {
        throw new Error("R2 down");
      },
    });
    expect(sent).toBe(false);
  });
});

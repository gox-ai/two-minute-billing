/**
 * Image-upload validation (security-review Findings 2a and 2b); the cases ARE the finding.
 *
 * The original defect: the stored object's extension came from the client's filename and
 * its `ContentType` from the client's header, so a caller could have a CDN serve an active
 * document type from a platform-branded domain. So the cases that matter are the
 * DISGUISES — a payload wearing an image filename, an image content type, or both. None
 * may be accepted, because neither is evidence.
 *
 * The SVG case is the one specific to tmbilling: `loadLogo` currently rasterises
 * `data:image/svg+xml` logos, and this module is what stops new ones being created.
 */
import { describe, it, expect } from "vitest";
import {
  ALLOWED_IMAGE_TYPES,
  ImageUploadError,
  MAX_IMAGE_BYTES,
  detectImageType,
  extensionForImageType,
  validateImageUpload,
} from "@/platform/image-upload";

/** A minimal but GENUINE header for each format — 12+ bytes, as the detector requires. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(8)]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x1a, 0, 0, 0]),
  Buffer.from("WEBP"),
  Buffer.alloc(4),
]);

describe("detectImageType — the bytes are the evidence", () => {
  it("recognises each allowed format from its leading bytes", () => {
    expect(detectImageType(PNG)).toBe("image/png");
    expect(detectImageType(JPEG)).toBe("image/jpeg");
    expect(detectImageType(GIF)).toBe("image/gif");
    expect(detectImageType(WEBP)).toBe("image/webp");
  });

  it("covers both GIF versions and every JPEG variant", () => {
    for (const header of ["GIF87a", "GIF89a"]) {
      expect(detectImageType(Buffer.concat([Buffer.from(header), Buffer.alloc(8)]))).toBe(
        "image/gif",
      );
    }
    // JFIF, Exif and raw all share FF D8 FF; only the fourth byte differs.
    for (const marker of [0xe0, 0xe1, 0xdb]) {
      expect(
        detectImageType(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, marker]), Buffer.alloc(8)])),
      ).toBe("image/jpeg");
    }
  });

  // The whole point of the finding: every one of these CLAIMS to be an image.
  it("rejects an SVG, which has no magic number", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    expect(detectImageType(svg)).toBeNull();
  });

  it("rejects HTML, a shell script and a PDF", () => {
    expect(detectImageType(Buffer.from("<html><script>alert(1)</script></html>"))).toBeNull();
    expect(detectImageType(Buffer.from("#!/bin/sh\nrm -rf / --no-preserve-root\n"))).toBeNull();
    expect(detectImageType(Buffer.from("%PDF-1.7\n%\xc7\xec\x8f\xa2\n"))).toBeNull();
  });

  it("rejects a RIFF container that is not WebP (e.g. a WAV)", () => {
    const wav = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.from([0x1a, 0, 0, 0]),
      Buffer.from("WAVE"),
      Buffer.alloc(4),
    ]);
    expect(detectImageType(wav)).toBeNull();
  });

  it("rejects a truncated header rather than indexing past the end", () => {
    expect(detectImageType(Buffer.from([0x89, 0x50, 0x4e]))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
  });

  it("rejects a non-buffer", () => {
    expect(detectImageType("PNG" as unknown as Buffer)).toBeNull();
  });
});

describe("validateImageUpload — the disguises", () => {
  it("accepts a genuine image and reports the proven type and extension", () => {
    expect(validateImageUpload(PNG)).toEqual({ contentType: "image/png", extension: ".png" });
    expect(validateImageUpload(JPEG)).toEqual({ contentType: "image/jpeg", extension: ".jpg" });
  });

  it("rejects a script even though nothing about the call says it is one", () => {
    // This is the finding in one line: the caller could have named it logo.png and
    // declared image/png, and neither would appear here — only the bytes are consulted.
    expect(() => validateImageUpload(Buffer.from("<script>alert(1)</script>"))).toThrow(
      ImageUploadError,
    );
  });

  it("names SVG explicitly when refusing, because a merchant will try one", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    expect(() => validateImageUpload(svg)).toThrow(/SVG is not accepted/i);
  });

  it("rejects an empty upload", () => {
    expect(() => validateImageUpload(Buffer.alloc(0))).toThrow(/We did not receive the image/i);
  });

  it("enforces the size cap server-side", () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    expect(() => validateImageUpload(huge)).toThrow(/too large/i);
  });

  it("honours a caller-supplied lower cap and names it in the message", () => {
    const img = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]);
    expect(() => validateImageUpload(img, { maxBytes: 1024 * 1024 })).toThrow(
      /maximum size is 1 MB/i,
    );
  });

  it('uses the label in its messages, so a favicon error does not say "image"', () => {
    expect(() => validateImageUpload(Buffer.alloc(0), { label: "favicon" })).toThrow(
      /We did not receive the favicon/i,
    );
  });

  it("checks the size BEFORE the bytes, so a huge non-image is not fully scanned", () => {
    const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    expect(() => validateImageUpload(huge)).toThrow(/too large/i);
  });
});

describe("the accepted set", () => {
  it("is exactly PNG, JPEG, GIF and WebP — no SVG", () => {
    expect([...ALLOWED_IMAGE_TYPES].sort()).toEqual([
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
    expect(ALLOWED_IMAGE_TYPES).not.toContain("image/svg+xml" as never);
  });

  it("maps every accepted type to an extension", () => {
    for (const t of ALLOWED_IMAGE_TYPES) {
      expect(extensionForImageType(t)).toMatch(/^\.[a-z]+$/);
    }
  });
});

import { describe, it, expect } from "vitest";
import {
  MAX_UPLOAD_BYTES,
  MULTIPART_OVERHEAD_BYTES,
  uploadBodyRefusal,
} from "../../dashboard/lib/upload-limit";

describe("uploadBodyRefusal — refuse before the body is buffered", () => {
  it("lets a body at the cap plus multipart overhead through", () => {
    expect(
      uploadBodyRefusal(String(MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES), "photo"),
    ).toBeNull();
  });
  it("refuses one byte more", () => {
    expect(
      uploadBodyRefusal(String(MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES + 1), "photo"),
    ).toMatch(/photo is too large/);
  });
  it("refuses a body with no declared length", () => {
    expect(uploadBodyRefusal(null, "image")).toMatch(/no size/);
  });
  it("refuses a length that is not a number", () => {
    expect(uploadBodyRefusal("12abc", "image")).toMatch(/no size/);
  });
});

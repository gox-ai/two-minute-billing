/** 5 MB, the engine's own cap on one image. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Room for the multipart boundary, the part headers and the small text fields beside the
 * file. Measured multipart overhead for one file part is well under 1 KB; 64 KB is generous
 * without letting a materially larger body through.
 */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * Why a multipart upload must be refused before its body is read, or null when it may be
 * read. `req.formData()` buffers the WHOLE body, so the size check after it comes too late
 * to protect memory; this one reads only the declared length.
 */
export function uploadBodyRefusal(contentLength: string | null, noun: string): string | null {
  const max = `The maximum size is ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`;
  if (contentLength == null || !/^\d+$/.test(contentLength.trim()))
    return `The upload has no size. Try again. ${max}`;
  if (Number(contentLength) > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES)
    return `The ${noun} is too large. ${max}`;
  return null;
}

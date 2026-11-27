/**
 * The most an import upload through the dashboard may carry, all files together. `proxy.ts`
 * buffers request bodies up to 15 MB (`proxyClientMaxBodySize` in next.config), so a larger
 * body would reach the route cut short. The API itself takes 50 MB per request.
 */
export const MAX_IMPORT_UPLOAD_BYTES = 14 * 1024 * 1024;

const MAX_TEXT = `The maximum is ${MAX_IMPORT_UPLOAD_BYTES / (1024 * 1024)} MB for all files together.`;

/** Why an upload must be refused before its body is read, or null. */
export function importUploadRefusal(contentLength: string | null): string | null {
  if (contentLength == null || !/^\d+$/.test(contentLength.trim()))
    return `The upload has no size. Try again. ${MAX_TEXT}`;
  if (Number(contentLength) > MAX_IMPORT_UPLOAD_BYTES + 64 * 1024)
    return `The files are too large. ${MAX_TEXT} For larger files, use the API.`;
  return null;
}

export const IMPORT_SIZE_TEXT = MAX_TEXT;

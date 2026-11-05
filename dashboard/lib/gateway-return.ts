/** `next` as a same-origin path, or "/" for anything that could leave this origin. */
export function gatewayReturnTarget(next: string | null): string {
  if (!next || !next.startsWith("/") || next[1] === "/" || next[1] === "\\") return "/";
  // Browsers drop tabs and newlines inside URLs, so "/\t/evil.example" becomes "//evil...".
  for (let i = 0; i < next.length; i++) {
    const c = next.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return "/";
  }
  const base = "http://bounce.invalid";
  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    return "/";
  }
  if (url.origin !== base) return "/";
  // Dot-segments normalise "/..//evil.example" to "//evil.example", a protocol-relative
  // Location, so the check runs again on the result.
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (path[1] === "/" || path[1] === "\\") return "/";
  return path;
}

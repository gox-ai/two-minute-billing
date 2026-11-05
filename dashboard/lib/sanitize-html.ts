import DOMPurify from "dompurify";

/**
 * The ONE way HTML from the API reaches the DOM. Email bodies carry merchant-edited
 * templates and customer-supplied values; the engine escapes and allowlists them, and this
 * is the second wall in case either ever lets markup through.
 *
 * Browser only. Without a DOM, DOMPurify returns its input UNCHANGED, so this returns ''
 * instead — never call it during SSR and render the result; use `<SafeHtml>`.
 */

/** Tags that would let a fragment restyle the dashboard or pose as our own UI. */
const EMBED_FORBID = [
  "style",
  "link",
  "meta",
  "base",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "iframe",
  "frame",
  "object",
  "embed",
];

let hooked = false;
function purifier() {
  if (!hooked) {
    // A link in a previewed email must not navigate the dashboard tab, nor hand it an opener.
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A" && node.hasAttribute("href")) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    });
    hooked = true;
  }
  return DOMPurify;
}

/** A fragment rendered inside a dashboard page. */
export function sanitizeHtml(html: string): string {
  if (typeof window === "undefined" || !DOMPurify.isSupported) return "";
  return purifier().sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: EMBED_FORBID,
  });
}

/**
 * A whole email document for a sandboxed iframe: its own `<style>` is kept (it cannot
 * reach the dashboard from inside the frame); scripts, handlers and form controls are not.
 */
export function sanitizeHtmlDocument(html: string): string {
  if (typeof window === "undefined" || !DOMPurify.isSupported) return "";
  return purifier().sanitize(html, {
    USE_PROFILES: { html: true },
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ["style", "meta"],
    FORBID_TAGS: EMBED_FORBID.filter((t) => t !== "style" && t !== "meta"),
  });
}

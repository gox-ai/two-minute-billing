/**
 * Image modifiers that pin a product screenshot to this build.
 *
 * A re-shot screenshot keeps its file name, and the CDN in front of the site caches images for
 * hours by that URL — so a deploy kept serving the old picture. `ver_<buildId>` changes the URL
 * every build; IPX ignores a modifier it has no handler for, so the image itself is untouched.
 */
export function useShotModifiers(): Record<string, string> {
  return { ver: useRuntimeConfig().app.buildId };
}

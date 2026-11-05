/**
 * Buyer-facing wording shared by the checkout SERVER actions and the CLIENT flow.
 *
 * Its own module because of the boundary, not for tidiness. `lib/checkout-api.ts` imports
 * `next/headers` (to forward the buyer's IP — see `lib/forwarded-for.ts`), which makes it
 * server-only: a client component that imports ANY runtime value from it drags
 * `next/headers` into the browser bundle and the build fails. Types are safe (`import type`
 * is erased); a `const` is not. So the one string both sides need lives here, where neither
 * side pulls the other's dependencies in.
 */

/**
 * The single wording for "this checkout session is gone".
 *
 * NOT in the `'use server'` actions file: such a module may only export async functions, and
 * exporting a const from one is a BUILD error rather than a type error — `tsc` passes and the
 * page fails to compile. The actions return it; the flow recognises it, to show a terminal
 * card instead of one more red toast.
 */
export const NO_SESSION = "This checkout session expired. Ask for a new link.";

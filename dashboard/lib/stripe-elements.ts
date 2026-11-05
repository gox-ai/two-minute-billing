import type { Appearance } from '@stripe/stripe-js'
import { brandAccent } from './brand'

/**
 * How Stripe Elements is dressed on our hosted pages.
 *
 * Elements renders in a cross-origin iframe, so it can read neither `globals.css`
 * nor the `[data-brand]` custom properties — every value has to be handed over as a
 * literal. That is why our light-palette hexes are repeated here instead of being
 * referenced: it is a copy by necessity. If a token below moves in `globals.css`,
 * move it here too.
 *
 * LIGHT ONLY, deliberately: the storefront pins the light theme (see the storefront
 * layout), so there is no dark variant to resolve and no `.dark` probe whose answer
 * is always the same.
 *
 * `fontFamily` is left alone on purpose. The page uses Inter self-hosted through
 * next/font, and an iframe can only load a face we point it at with a public
 * stylesheet URL — matching the page would mean pulling Inter from Google Fonts at
 * card-entry time, which is a third-party request on the one screen that least wants
 * one. Stripe's own system stack is the closer neighbour of the two evils.
 */
export function stripeAppearance(brandColor?: string | null): Appearance {
  // No brand → our own accent (`--primary`), so an unbranded merchant's card form
  // still matches the page rather than Stripe's default indigo.
  const accent = brandAccent(brandColor) ?? '#0f5fa6'
  return {
    theme: 'stripe',
    variables: {
      colorPrimary: accent,
      colorBackground: '#ffffff',
      colorText: '#15181d',
      colorTextSecondary: '#666d78',
      colorTextPlaceholder: '#666d78',
      colorDanger: '#a3342a',
      // --radius 0.5rem puts controls on rounded-md (6px); the dialog around this
      // form is rounded-lg, so a matching field radius is what makes it read as one
      // sheet instead of an embed.
      borderRadius: '6px',
      // text-sm — the workhorse step, and 12px is the floor for anything smaller
      // Elements derives from it.
      fontSizeBase: '14px',
      spacingUnit: '4px',
    },
    rules: {
      '.Input': { borderColor: '#dcdee3', boxShadow: 'none' },
      // Our focus ring is 2px of the accent at low alpha (see globals.css `--ring`).
      '.Input:focus': { borderColor: accent, boxShadow: `0 0 0 2px ${accent}33` },
      '.Label': { color: '#666d78' },
    },
  }
}

# public/logos — gateway and integration logos

Each company's own logo, rendered by `components/partner-logo.tsx` and keyed by the catalogue
`gateway_key` or integration key. `<key>.svg` is for a light ground and `<key>-dark.svg` for a
dark one. A key with no file here shows its name as text in the same box.

Rules:

- Only these files. Nothing from a third-party icon set, and no drawn approximations.
- Every logo covers the same area: height = sqrt(area / aspect), capped by the box width.
- SVG where the company publishes one. PayPal and Razorpay publish PNG only: those are WebP at
  2x and 3x of a 32px-tall render (`<key>@2x.webp`, `<key>@3x.webp`).

All fetched 2026-10-29 (PayU 2026-10-31). Sources: the company's brand, press or partner page; where a company
publishes no brand kit (Braintree, Checkout.com, Authorize.net, Cashfree, FirstPromoter), the
logo it serves on its own website. PayU: the logo on payu.in, PayU India's own site, not the
global brand portal's mark.

| key | light | dark | brand rule we follow |
|---|---|---|---|
| `stripe` | blurple wordmark | white wordmark | blurple, slate or white only |
| `paypal` | black wordmark (2024) | white wordmark | |
| `razorpay` | white wordmark on a `#0c2451` navy plate | white wordmark | published white only |
| `square` | black lockup | white lockup | never the wordmark without the square mark |
| `braintree` | "PayPal Braintree" lockup | same, on a white plate | no dark version served |
| `checkoutcom` | site header logo | site header logo, dark nav | |
| `adyen` | green wordmark | same green wordmark | always green on dark grounds |
| `mollie` | black wordmark | white wordmark | |
| `authorizenet` | site header logo | site footer logo | |
| `gocardless` | Darkmatter wordmark | Dawn wordmark | |
| `cashfree` | site header logo | white site logo | |
| `payu` | payu.in header logo (PayU India) | payu.in inverse logo | |
| `hubspot` | primary wordmark (2025) | cream wordmark | |
| `firstpromoter` | docs logo | white site logo | |

Changes to the artwork: none, except the SVG `viewBox`, which is trimmed to the ink on
`square`, `braintree`, `checkoutcom`, `adyen` (whose file carries its clear space),
`gocardless-dark` and `cashfree`, so that the area rule measures the logo and not its margin.
The FirstPromoter files had no `viewBox`; one was added from their width and height. PNGs are
trimmed to the ink before the WebP export.

The logos remain the trademarks of their owners and are used to name the gateway or tool an
account connects to.

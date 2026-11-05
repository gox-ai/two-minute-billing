# public/brands — payment network marks

Card-network, UPI and wallet artwork, served as static SVG and rendered through
`components/brand/payment-mark.tsx`. They identify an instrument the buyer actually holds
(`payment_methods.brand`) or a rail they can pick — never decoration, and never a claim we
have not got a field for.

They are the one place colour is allowed to leave our token palette: a network mark is
somebody else's identity and is recognised BY its colour, so it is rendered as published,
on a light plate, inside our own tile.

| file | source | licence |
|---|---|---|
| `amex` `diners` `discover` `elo` `jcb` `maestro` `mastercard` `paypal` `unionpay` `visa` | [`payment-icons`](https://github.com/muffinresearch/payment-icons) `svg/flat/*` v1.2.1 | MPL-2.0 |
| `upi` | Wikimedia Commons `UPI-Logo-vector.svg` (strapline cropped off the viewBox — illegible at 28px) | public domain |
| `rupay` | Wikimedia Commons `RuPay.svg` | public domain |

Two marks are **not files here** — Apple Pay and Google Pay are inline paths in
`payment-mark.tsx`, drawn in `currentColor`. Neither owner distributes a colour mark under a
licence we can vendor, and both publish a monochrome one for exactly this use, so ink is a
published form rather than a recolouring. Paths from [`simple-icons`](https://github.com/simple-icons/simple-icons)
v16.30.0 (CC0-1.0); an `<img>` cannot inherit `currentColor`, which is why they are inline.

**Stripe Link, Cartes Bancaires, Interac and eftpos have no mark** and fall to the generic card
glyph. So do netbanking banks, deliberately: RazorPay alone enumerates ~60 of them, each a
separate trademark, and a wrong bank logo on a payment screen is read as fact.

Editor metadata (RDF/Inkscape/Sketch namespaces, `<metadata>`, `<title>`, `<desc>`) is
stripped; the artwork itself is unmodified apart from the UPI viewBox crop noted above.
The marks remain the trademarks of their owners and are used nominatively, to name the
instrument being charged.

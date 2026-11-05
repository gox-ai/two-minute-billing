import qrcode from 'qrcode-generator'

/**
 * A QR code, rendered as inline SVG (audit M3).
 *
 * ── WHY A LIBRARY HERE, WHEN TOTP WAS WRITTEN BY HAND ───────────────────────────
 * TOTP is an HMAC and a modulo, and RFC 6238 publishes test vectors — so a hand-written
 * implementation could be PROVEN right before anything depended on it. QR is Reed-Solomon
 * plus masking plus format-info BCH, and there are no vectors to check it against offline. A
 * QR that fails to scan is an annoyance; a QR that scans to the WRONG secret silently enrols
 * someone against an authenticator that will never produce a working code. That asymmetry is
 * what buys the dependency: `qrcode-generator` is MIT, has no dependencies of its own, and
 * renders on an authenticated settings page rather than anywhere near the sign-in path.
 *
 * ── WHY IT IS BUILT WITH REACT AND NOT `createSvgTag()` ─────────────────────────
 * The library can emit an SVG string, which would need `dangerouslySetInnerHTML`. Reading the
 * module matrix and drawing it here keeps markup out of a raw-HTML sink for something a person
 * points a camera at.
 *
 * ── WHY THE COLOURS ARE LITERAL, AND NOT TOKENS ─────────────────────────────────
 * Deliberate, and the one place in this dashboard where that is right. A QR is not chrome, it
 * is a machine-readable image, and its contrast is FUNCTIONAL: scanners expect dark modules on
 * a light field, and a code rendered in dark-theme tokens can come out inverted and simply not
 * read. Themed colours here would trade a working feature for consistency nobody can see.
 */
export function QrCode({ value, size = 168, alt }: { value: string; size?: number; alt: string }) {
  // Type 0 = pick the smallest version that fits. 'M' recovers ~15%, the level authenticator
  // apps are tuned for; higher correction makes a denser code for no practical gain here.
  const qr = qrcode(0, 'M')
  qr.addData(value)
  qr.make()

  const count = qr.getModuleCount()
  // Four modules of quiet zone, which the spec requires and scanners genuinely need — without
  // it a code butted against a card edge is unreliable.
  const quiet = 4
  const total = count + quiet * 2

  const paths: string[] = []
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) paths.push(`M${col + quiet},${row + quiet}h1v1h-1z`)
    }
  }

  return (
    <svg
      viewBox={`0 0 ${total} ${total}`}
      width={size}
      height={size}
      role="img"
      aria-label={alt}
      shapeRendering="crispEdges"
      className="rounded-md"
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path d={paths.join('')} fill="#000000" />
    </svg>
  )
}

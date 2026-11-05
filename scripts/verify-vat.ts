/**
 * Proves the live VIES VAT-ID validator (src/modules/customers/vies.ts):
 *  - valid EU number         → 'valid'
 *  - invalid EU number       → 'invalid'
 *  - member-state 5xx/down   → 'undetermined' (never fatal)
 *  - timeout                 → 'undetermined'
 *  - non-EU / no number      → 'undetermined' / 'not_validated'
 *  - GR→EL and embedded country prefix handling
 *
 * Runs fully offline against a local stub HTTP server (no real VIES calls).
 * Overrides config at runtime via env before importing the module.
 *
 *   pnpm verify:vat
 */
import { createServer, type Server } from 'node:http'

let pass = 0
let fail = 0
function ok(label: string, cond: boolean) {
  if (cond) { pass++; console.log('✓', label) } else { fail++; console.log('✗', label) }
}

// A tiny fake VIES: URL shape is /ms/{CC}/vat/{NUMBER}. We drive responses off
// the number so a single server covers every case.
const server: Server = createServer((req, res) => {
  const url = req.url ?? ''
  if (url.includes('/vat/SLOW')) {
    // Never respond in time — exercises the client abort/timeout path.
    return
  }
  if (url.includes('/vat/BOOM')) {
    res.writeHead(503); res.end('service unavailable'); return
  }
  const isValid = url.includes('/vat/GOOD') || /\/vat\/\d*GOOD/.test(url)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ isValid, userError: isValid ? 'VALID' : 'INVALID', requestDate: '2026-07-22' }))
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const addr = server.address()
const port = typeof addr === 'object' && addr ? addr.port : 0
process.env.VIES_API_BASE = `http://127.0.0.1:${port}`
process.env.VIES_TIMEOUT_MS = '400'

// Import AFTER env is set so config picks up the stub base + short timeout.
const { viesTaxIdValidator: v } = await import('@/modules/customers/vies')

ok('valid EU number → valid', (await v.validate({ country: 'DE', vatNumber: 'GOOD' })) === 'valid')
ok('invalid EU number → invalid', (await v.validate({ country: 'DE', vatNumber: 'BAD' })) === 'invalid')
ok('member-state 503 → undetermined', (await v.validate({ country: 'FR', vatNumber: 'BOOM' })) === 'undetermined')
ok('timeout → undetermined', (await v.validate({ country: 'IT', vatNumber: 'SLOW' })) === 'undetermined')
ok('non-EU country → undetermined', (await v.validate({ country: 'US', vatNumber: 'GOOD' })) === 'undetermined')
ok('empty number → not_validated', (await v.validate({ country: 'DE', vatNumber: '' })) === 'not_validated')
ok('null number → not_validated', (await v.validate({ country: 'DE', vatNumber: null })) === 'not_validated')
// Greece is EL in VIES, not ISO GR — must still resolve to an EU lookup.
ok('GR mapped to EL → valid', (await v.validate({ country: 'GR', vatNumber: 'GOOD' })) === 'valid')
// Country prefix embedded in the number wins over the customer country field.
ok('embedded DE prefix, no country → valid', (await v.validate({ country: null, vatNumber: 'DEGOOD' })) === 'valid')
ok('no country + bare number → undetermined', (await v.validate({ country: null, vatNumber: 'GOOD' })) === 'undetermined')

server.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

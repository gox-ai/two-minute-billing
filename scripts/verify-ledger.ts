/**
 * Proves the ledger: balanced posts succeed, imbalances are rejected, balances
 * derive correctly, and the ledger is append-only (UPDATE denied).
 *
 *   pnpm verify:ledger
 */
import { createOrganization, createBusiness } from '@/modules/tenancy/service'
import { postEntries, accountBalance, LedgerImbalanceError } from '@/modules/ledger/service'
import { withTenant, closeDb } from '@/platform/db'
import { sql } from 'drizzle-orm'

const org = await createOrganization({ name: 'Ledger Test Org' })
const biz = await createBusiness({
  organizationId: org.organization.id,
  name: 'Ledger Biz',
  defaultCurrency: 'USD',
})

// 1) Balanced post: bill a customer 1000 (AR debit, revenue credit).
const { transactionId } = await postEntries({
  organizationId: org.organization.id,
  businessId: biz.id,
  sourceType: 'invoice',
  sourceId: 'inv_test_1',
  lines: [
    { account: 'accounts_receivable', direction: 'debit', amountMinor: 1000n, currency: 'USD' },
    { account: 'revenue', direction: 'credit', amountMinor: 1000n, currency: 'USD' },
  ],
})
console.log('posted balanced txn:', transactionId)

const ar = await accountBalance(org.organization.id, biz.id, 'accounts_receivable', 'USD')
const rev = await accountBalance(org.organization.id, biz.id, 'revenue', 'USD')
console.log(`AR balance: ${ar}   revenue balance: ${rev}`)

// 2) Unbalanced post must be rejected.
let imbalanceRejected = false
try {
  await postEntries({
    organizationId: org.organization.id,
    businessId: biz.id,
    sourceType: 'invoice',
    sourceId: 'inv_bad',
    lines: [
      { account: 'accounts_receivable', direction: 'debit', amountMinor: 1000n, currency: 'USD' },
      { account: 'revenue', direction: 'credit', amountMinor: 900n, currency: 'USD' },
    ],
  })
} catch (e) {
  imbalanceRejected = e instanceof LedgerImbalanceError
}
console.log('unbalanced rejected:', imbalanceRejected)

// 3) Append-only: UPDATE on the ledger must be denied at the privilege level.
let updateBlocked = false
try {
  await withTenant(org.organization.id, async (tx) => {
    await tx.execute(sql`update ledger_entries set memo = 'tamper' where transaction_id = ${transactionId}`)
  })
} catch {
  updateBlocked = true
}
console.log('ledger UPDATE blocked:', updateBlocked)

const pass = ar === 1000n && rev === -1000n && imbalanceRejected && updateBlocked
console.log('')
console.log(pass ? '✅ LEDGER: PASS' : '❌ LEDGER: FAIL')

await closeDb()
process.exit(pass ? 0 : 1)

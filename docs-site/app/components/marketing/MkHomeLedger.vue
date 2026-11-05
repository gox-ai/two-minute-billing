<script setup lang="ts">
/**
 * Two example transactions as the ledger books them: an INR invoice with 18% GST, then its
 * payment. Account names follow the engine's accounts (receivable, revenue, tax, cash).
 */
const entries = [
  {
    what: "Invoice issued",
    lines: [
      { account: "Accounts receivable", debit: "₹11,800", credit: "" },
      { account: "Revenue", debit: "", credit: "₹10,000" },
      { account: "Tax payable (GST)", debit: "", credit: "₹1,800" },
    ],
  },
  {
    what: "Payment received",
    lines: [
      { account: "Cash", debit: "₹11,800", credit: "" },
      { account: "Accounts receivable", debit: "", credit: "₹11,800" },
    ],
  },
];
</script>

<template>
  <div class="lg">
    <table class="w-full text-sm">
      <caption class="sr-only">
        Example ledger entries. Each transaction has equal debits and credits.
      </caption>
      <thead>
        <tr class="lg-head">
          <th scope="col" class="text-left font-normal">Ledger · example entries</th>
          <th scope="col" class="text-right font-normal">Debit</th>
          <th scope="col" class="text-right font-normal">Credit</th>
        </tr>
      </thead>
      <tbody v-for="e in entries" :key="e.what" class="lg-entry">
        <tr>
          <th scope="rowgroup" colspan="3" class="lg-what">{{ e.what }}</th>
        </tr>
        <tr v-for="l in e.lines" :key="l.account" class="lg-line">
          <td>{{ l.account }}</td>
          <td class="text-right">
            <span v-if="l.debit">{{ l.debit }}</span
            ><span v-else class="lg-none" aria-label="None">—</span>
          </td>
          <td class="text-right">
            <span v-if="l.credit">{{ l.credit }}</span
            ><span v-else class="lg-none" aria-label="None">—</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.lg {
  overflow: hidden;
  border-radius: 1.125rem;
  border: 1px solid var(--mk-accent-line);
  background: var(--mk-card);
  box-shadow: 0 20px 50px -30px rgb(16 24 40 / 0.25);
}
.lg-head th {
  padding: 0.875rem 1.25rem;
  border-bottom: 1px solid var(--ui-border-muted);
  font-size: 0.8125rem;
  color: var(--ui-text-muted);
}
.lg-entry + .lg-entry .lg-what {
  border-top: 1px solid var(--ui-border-muted);
}
.lg-what {
  padding: 0.875rem 1.25rem 0.25rem;
  text-align: left;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.lg-line td {
  padding: 0.1875rem 1.25rem;
  color: var(--ui-text-toned);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.lg-line td:first-child {
  white-space: normal;
}
.lg-line td + td {
  padding-left: 0.5rem;
}
.lg-entry .lg-line:last-child td {
  padding-bottom: 0.875rem;
}
.lg-none {
  color: var(--ui-text-dimmed);
}
</style>

<script setup lang="ts">
/**
 * One renewal invoice and the attempts that recovered it, drawn in HTML. The backup card is
 * tried inside the failed attempt; retries follow the business's schedule.
 */
const attempts = [
  {
    title: "The gateway declines the card",
    body: "The invoice records the attempt and the reason from the gateway.",
    pill: "Renewal · Declined",
    tone: "bad",
  },
  {
    title: "We try a backup card",
    body: "We charge the next saved card after the default card.",
    pill: "Same attempt · Backup card",
    tone: "step",
  },
  {
    title: "Smart retries",
    body: "Retries run on the schedule that you set. They stop when the invoice is paid.",
    pill: "Your schedule · Retry",
    tone: "step",
  },
  {
    title: "Paid in one click",
    body: "The customer opens the link in the email and pays the invoice.",
    pill: "Email · Paid",
    tone: "ok",
  },
] as const;
</script>

<template>
  <div class="att">
    <div class="att-head">
      <div>
        <div class="text-[0.8125rem] text-muted">INV-1042 · Northgate Dental</div>
        <div class="mt-0.5 text-[1.0625rem] font-semibold text-highlighted tabular-nums">
          $249.00 USD
        </div>
      </div>
      <UBadge color="success" variant="subtle">Paid</UBadge>
    </div>
    <ol class="att-list">
      <li v-for="a in attempts" :key="a.title" class="att-row">
        <span class="att-dot" :class="`att-${a.tone}`" aria-hidden="true" />
        <div class="min-w-0">
          <div class="text-[0.9375rem] font-medium text-highlighted">{{ a.title }}</div>
          <div class="mt-0.5 text-sm leading-normal text-muted">{{ a.body }}</div>
        </div>
        <UBadge
          class="att-pill"
          :color="a.tone === 'bad' ? 'error' : a.tone === 'ok' ? 'success' : 'primary'"
          variant="subtle"
        >
          {{ a.pill }}
        </UBadge>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.att {
  position: relative;
  box-sizing: border-box;
  overflow: hidden;
  padding: 1.375rem 1.625rem 0 clamp(1.25rem, 3vw, 2.5rem);
  border-radius: 0 16px 0 0;
  border: 1px solid var(--mk-accent-line);
  border-left: 0;
  border-bottom: 0;
  background: var(--mk-card);
  box-shadow: 24px 24px 60px -30px rgb(42 42 202 / 0.45);
}
.att-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding-bottom: 0.875rem;
  border-bottom: 1px solid var(--ui-border-muted);
}
.att-row {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  gap: 0.875rem;
  padding: 1rem 0;
  border-bottom: 1px solid var(--ui-border-muted);
}
.att-row:last-child {
  border-bottom: 0;
}
.att-dot {
  margin-top: 0.3125rem;
  width: 10px;
  height: 10px;
  border-radius: 999px;
}
.att-bad {
  background: var(--ui-error);
  box-shadow: 0 0 0 4px color-mix(in oklab, var(--ui-error) 14%, transparent);
}
.att-step {
  background: var(--mk-accent);
  box-shadow: 0 0 0 4px var(--mk-accent-soft);
}
.att-ok {
  background: var(--ui-success);
  box-shadow: 0 0 0 4px color-mix(in oklab, var(--ui-success) 14%, transparent);
}
.att-pill {
  align-self: start;
  white-space: nowrap;
}
@media (max-width: 600px) {
  .att-row {
    grid-template-columns: 20px minmax(0, 1fr);
  }
  .att-pill {
    grid-column: 2;
    justify-self: start;
  }
}
</style>

/**
 * verify:committed-mrr — committed MRR at a past instant depends on what was booked BY then,
 * never on the row's flags today. Pure: no database.
 */
import { committedAt, type StockRow } from "@/modules/metrics/stocks";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean) {
  if (cond) pass++;
  else fail++;
  console.log(cond ? "✓" : "✗", label);
}
const d = (s: string) => new Date(`${s}T00:00:00Z`);
const sub = (over: Partial<StockRow>): StockRow => ({
  id: "sub",
  status: "active",
  currency: "USD",
  createdAt: d("2024-01-01"),
  startDate: d("2024-01-01"),
  startedAt: d("2024-01-01"),
  canceledAt: null,
  cancelAtPeriodEnd: false,
  cancelScheduledAt: null,
  currentPeriodStart: d("2026-09-10"),
  currentPeriodEnd: d("2026-10-10"),
  trialEnd: null,
  trialStart: null,
  billingPeriod: 1,
  billingPeriodUnit: "month",
  remainingBillingCycles: null,
  ...over,
});

// Cancelled this morning, immediately: it was committed for the two years before.
const cancelledToday = sub({ status: "cancelled", canceledAt: d("2026-09-25") });
ok(
  "a subscription cancelled today was committed in 2025",
  committedAt(cancelledToday, d("2025-06-01")),
);
ok("…and the day before it was cancelled", committedAt(cancelledToday, d("2026-09-24")));
ok("…and is not committed once cancelled", !committedAt(cancelledToday, d("2026-09-26")));

// Booked to stop at term end: leaves at the start of its final term, not at creation.
const atTermEnd = sub({ cancelAtPeriodEnd: true });
ok(
  "a stop at term end is committed before its final term",
  committedAt(atTermEnd, d("2026-09-01")),
);
ok("…and not during it (the stop is on the books)", !committedAt(atTermEnd, d("2026-09-15")));

// Scheduled for a later term: only its final term is affected.
const scheduled = sub({ cancelScheduledAt: d("2027-01-10") });
ok(
  "a stop scheduled for January is committed in November",
  committedAt(scheduled, d("2026-11-01")),
);
ok("…and not in its final term (from mid-December)", !committedAt(scheduled, d("2026-12-20")));

// The guards that were already right stay right.
ok("nothing is committed before the subscription existed", !committedAt(sub({}), d("2023-12-01")));
ok("an untouched active subscription is committed", committedAt(sub({}), d("2026-09-25")));
ok(
  "a cancelled row with no stop on record is not counted",
  !committedAt(sub({ status: "cancelled" }), d("2025-06-01")),
);

console.log(
  `\n${fail === 0 ? "✅" : "❌"} COMMITTED MRR: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`,
);
process.exit(fail === 0 ? 0 : 1);

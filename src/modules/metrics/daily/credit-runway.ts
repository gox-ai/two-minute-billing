import { sql } from "drizzle-orm";

/**
 * Credit runway pools, shared by the customer field `credit_runway_days` and the measure
 * `credit_runway_customers` so the two agree. Credit with a money rate pools by currency and
 * counts face value; each unit with no money rate is its own pool and counts units. A
 * customer's runway is the pool that runs out first. Columns: `g` grant, `m` movement.
 */
export const RUNWAY_POOL = sql.raw(
  `case when g.unit_rated then 'money:' || upper(g.currency) else g.unit_id::text end`,
);
export const RUNWAY_AMOUNT = sql.raw(`case when g.unit_rated then m.face_minor else m.units end`);

/**
 * `accountHolderName`, expressed in SQL — for WHERE clauses that have to agree
 * with what the list rendered.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────────
 * The operator list APIs resolve the Customer column through `accountHolderName`
 * (`./names.ts`), so a customer created with `first_name`/`last_name` shows up as
 * "Priya Raghunathan". The `customer_name` FILTER on those same lists compared the
 * legacy `customers.name` column alone, so typing the name that is on screen returned
 * an empty page — a filter that doesn't filter, on the one column an operator is most
 * likely to filter by.
 *
 * A filter cannot call the TypeScript helper (the predicate runs in Postgres, before
 * any row reaches us), so the precedence is mirrored here. ⚠️ The two must move
 * together: this is the SQL of `holderName()`, and if that chain changes this changes
 * with it, or the list shows one name and the filter matches another — which is worse
 * than either bug on its own, because the operator can see the row they are being told
 * doesn't exist.
 *
 * ── WHY EMAIL IS NOT IN THE CHAIN ───────────────────────────────────────────────
 * `accountHolderName` falls through to the email as a last resort, so a row with no
 * name at all still renders as something. This expression stops one step earlier, on
 * purpose:
 *   · `customer_email` is its own filter field on every list that has this one, so
 *     nothing is unreachable — the operator has a field for exactly that.
 *   · `customer_name[is_present]=false` has to be answerable. Email is effectively
 *     always set, so folding it in would make "has no name" true for every row and
 *     the operator would have no way to ask the question at all.
 *
 * ── THE LEGACY `name` COLUMN IS NOT IN THIS CHAIN (2026-08-23) ───────────────────
 * It used to be the last `coalesce` arm. Removed with the rest of the deprecation
 * (see `./names.ts`), which also makes `customer_name[is_present]=false` finally mean
 * what it says: "no first/last and no company", rather than "…and also not the one
 * column our own seed scripts happened to fill in".
 */
import { sql, type Column, type SQL } from 'drizzle-orm'
import { customers } from '@db/schema'

/** A column's value with blank-vs-null collapsed, matching `clean()` in `./names.ts`. */
const cleaned = (col: Column | SQL) => sql`nullif(btrim(${col}), '')`

/**
 * The account holder's display name as Postgres computes it: `first last` → `company`,
 * NULL when the row has neither. The SQL mirror of `holderName()` in `./names.ts`.
 *
 * `concat_ws` skips NULLs, so a half-filled person ("Payable", no first name) joins
 * without a stray space — the same shape `joined()` produces in TypeScript.
 *
 * Safe as a `FilterSpec.column` (see `platform/list-query.ts`: every operator
 * interpolates a virtual expression exactly as it does a real column), and cheap: the
 * `customers` row is already joined on these lists, and `contains` was never
 * index-servable anyway — a leading-wildcard ILIKE against columns that carry no
 * index at all.
 */
export const accountHolderNameSql = sql<string | null>`coalesce(
  ${cleaned(sql`concat_ws(' ', ${cleaned(customers.firstName)}, ${cleaned(customers.lastName)})`)},
  ${cleaned(customers.company)}
)`

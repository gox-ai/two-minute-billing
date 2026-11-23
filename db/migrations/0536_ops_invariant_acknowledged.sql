-- Violating rows that an operator acknowledged as handled are counted apart from
-- `violations`, so a row a person already dealt with stops alerting. NULL where the check
-- produced no answer, like `violations`.
ALTER TABLE ops_invariant_results ADD COLUMN acknowledged bigint;
--> statement-breakpoint
-- [{ acknowledgement, row_key }] for each acknowledged row the run matched.
ALTER TABLE ops_invariant_results ADD COLUMN acknowledged_rows jsonb;

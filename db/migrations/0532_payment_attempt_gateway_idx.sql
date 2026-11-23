-- A gateway webhook finds the attempt it is about by the object's id, to log its calls under
-- the attempt's span. Partial: most setup rows before the gateway answers have no id yet.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_attempts_gateway_idx
  ON payment_attempts (id_at_gateway) WHERE id_at_gateway IS NOT NULL;
--> statement-breakpoint
-- drizzle runs a batch of migrations in one transaction: do not hand the timeout to the next one.
SET LOCAL lock_timeout TO DEFAULT;

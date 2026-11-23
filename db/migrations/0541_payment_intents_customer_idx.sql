-- "Every intent for this customer", newest first: the customer page's Payment intents
-- tab and `GET …/payment_intents?customer=`. Same keyset shape as
-- payment_intents_business_created_idx, led by the customer.
CREATE INDEX IF NOT EXISTS "payment_intents_customer_created_idx"
  ON "payment_intents" USING btree ("customer_id", "created_at" DESC, "public_id" DESC);

-- Whether the buyer named a saved method for this payment (true), or the gateway's form
-- collects one (false). NULL on rows created before this column: read as "form", so an
-- open checkout from before the deploy still resumes. The portal's Pay now reads it to
-- close a saved-card attempt when the buyer then selects a new card.

ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS saved_method_chosen boolean;

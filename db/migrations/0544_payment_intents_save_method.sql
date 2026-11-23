-- A payment the buyer asked to keep the method of: the gateway stores the instrument while it
-- charges, and the consume saves it with the payer's consent. NULL = not asked (every row
-- before this column). `save_consent` is the consent the buyer accepted (text, version, when,
-- from where), kept on the intent so a consume from the gateway's webhook records it too.

ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS save_method boolean;
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS save_consent jsonb;

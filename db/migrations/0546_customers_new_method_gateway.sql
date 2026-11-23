-- Per-customer override (customer page, "Gateway for new payment methods"): the gwa_… a new
-- payment method of this customer goes to, ahead of the business routing. NULL = the business
-- setting. Saved methods are unaffected: they stay on the gateway that holds them.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS new_method_gateway_account text;

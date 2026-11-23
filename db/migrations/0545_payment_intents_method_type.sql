-- The rail the buyer selected for a new method in Pay now (`card`, `upi`, `paypal`…): the
-- gateway's form was pinned to it. A retry asks for the same rail, and a second request on
-- the same invoice resumes the open intent only when it asks for the same rail. NULL = the
-- gateway's own form offered its rails, or a saved method paid (every row before this column).

ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS method_type text;

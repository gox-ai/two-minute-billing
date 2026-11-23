-- Why a mandate died, from the gateway's event (GoCardless `details.cause`), so an operator can
-- see it on the payment method. Our canonical code and the operator text. Null while the
-- mandate is alive, or when the gateway gave no cause.
alter table payment_methods add column if not exists mandate_failure_code text;
alter table payment_methods add column if not exists mandate_failure_text text;

-- The payment intent and attempt a gateway webhook is about, resolved when the event is
-- applied (by the gateway's id, else by our public id read back off the gateway object).
-- Lets an attempt list every event the gateway sent about it, whatever the event type.
-- No FK: provider_events is platform-global (no RLS), the same reason as
-- transaction_public_id (0141).
alter table provider_events add column if not exists payment_intent_id uuid;
alter table provider_events add column if not exists payment_attempt_id uuid;

create index if not exists provider_events_payment_intent_idx
  on provider_events (payment_intent_id)
  where payment_intent_id is not null;
create index if not exists provider_events_payment_attempt_idx
  on provider_events (payment_attempt_id)
  where payment_attempt_id is not null;

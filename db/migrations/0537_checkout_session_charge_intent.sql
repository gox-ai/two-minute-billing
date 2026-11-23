-- The first-charge intent a hosted checkout is waiting on, so the WEBHOOK can finish it.
--
-- A first charge that needs the bank step answers 402; the page opens the gateway's sheet and
-- posts /complete again with the intent. When that second post never comes (the page lost the
-- sheet's answer, or the buyer closed the tab), the money stayed authorized at the gateway and
-- the intent expired. 0200 did the same for setup intents.
--
-- `charge_completion` keeps what the second post would repeat: the instrument, the gateway
-- account, the PO number, and the consent answers with their IP and time.
alter table checkout_sessions add column if not exists charge_payment_intent text;
alter table checkout_sessions add column if not exists charge_completion jsonb;

create unique index if not exists checkout_sessions_charge_intent_uq
  on checkout_sessions (charge_payment_intent)
  where charge_payment_intent is not null;

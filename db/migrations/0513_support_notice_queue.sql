-- Support notices go out from the engine's job queue (Cloud). A member's support message queues
-- one `support_notice_send` job per channel (chat, email) in the transaction that stores it, so a
-- worker sends it within seconds and a rollback sends nothing.
--
-- The member path runs as `tmbilling_app`, which cannot call graphile_worker.add_job (0201 says
-- why). This SECURITY DEFINER wrapper can queue only the notices for a member message of the
-- caller's own organization: the task, payload, attempts and keys are fixed here. The trace id is
-- the one free value; the worker reads it only when it is a valid trace id.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
create or replace function public.app_queue_support_notice(p_message uuid, p_trace text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_public text;
  v_channel text;
begin
  select m.public_id into v_public
    from public.support_messages m
   where m.id = p_message
     and m.author_kind = 'member'
     and m.organization_id = nullif(current_setting('app.org_id', true), '')::uuid;
  if v_public is null then
    raise exception 'app_queue_support_notice: no member message % in this organization', p_message;
  end if;
  foreach v_channel in array array['chat', 'email'] loop
    perform graphile_worker.add_job(
      'support_notice_send',
      json_strip_nulls(json_build_object(
        'message', v_public,
        'channel', v_channel,
        '_trace', case when p_trace is null then null else json_build_object('traceId', p_trace) end
      )),
      max_attempts => 10,
      -- One job per message and channel: a retry re-sends only the channel that failed.
      job_key => 'support_notice:' || v_channel || ':' || v_public
    );
  end loop;
end
$$;
--> statement-breakpoint
revoke all on function public.app_queue_support_notice(uuid, text) from public;
--> statement-breakpoint
grant execute on function public.app_queue_support_notice(uuid, text) to tmbilling_app;
--> statement-breakpoint
-- The back-office pass that read unnotified messages is gone; notified_at is now set on delivery.
DROP INDEX IF EXISTS support_messages_unnotified_idx;

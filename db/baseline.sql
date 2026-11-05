--
-- tmbilling — baseline schema
--
-- The complete schema as one file: every table, index, constraint, trigger and
-- row-level-security policy. Generated from the full migration history and verified
-- against it, so it is exactly what that history produces.
--
--   pnpm db:setup     # or the Docker image's `init` service
--
-- Both install graphile_worker's schema first (a trigger in this file calls
-- graphile_worker.add_job()), apply this file once, record the cut below in
-- drizzle.__drizzle_migrations, then apply the migrations newer than the cut.
--
-- baseline-cut: 0502_payment_method_collect_open_invoices 1793790000000
--

-- withTenant switches to this role; the grants below are what it may touch.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tmbilling_app') THEN
    CREATE ROLE tmbilling_app NOLOGIN;
  END IF;
END $$;
--
-- PostgreSQL database dump
--


-- Dumped from database version 17.10 (Debian 17.10-1.pgdg13+1)
-- Dumped by pg_dump version 17.10 (Debian 17.10-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: SCHEMA "public"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA "public" IS 'standard public schema';


--
-- Name: btree_gist; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "btree_gist" WITH SCHEMA "public";


--
-- Name: EXTENSION "btree_gist"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "btree_gist" IS 'support for indexing common datatypes in GiST';


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";


--
-- Name: EXTENSION "pg_trgm"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "pg_trgm" IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: app_now(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."app_now"() RETURNS timestamp with time zone
    LANGUAGE "sql" STABLE PARALLEL SAFE
    AS $$
  SELECT coalesce(nullif(current_setting('app.business_now', true), '')::timestamptz, now())
$$;


--
-- Name: app_nudge_integration_outbox(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."app_nudge_integration_outbox"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  PERFORM graphile_worker.add_job(
    'integration_outbox_nudge',
    max_attempts => 1,
    job_key => 'integration_outbox_nudge'
  );
END
$$;


--
-- Name: app_nudge_webhook_outbox(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."app_nudge_webhook_outbox"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  perform graphile_worker.add_job(
    'webhook_outbox_nudge',
    max_attempts => 1,
    -- Coalesce a burst of events into ONE pending nudge rather than one per event.
    job_key => 'webhook_outbox_nudge'
  );
end
$$;


--
-- Name: app_wipe_test_ledger("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."app_wipe_test_ledger"("p_business" "uuid") RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  n bigint;
begin
  if not exists (select 1 from public.businesses b where b.id = p_business and b.livemode = 'test') then
    raise exception 'app_wipe_test_ledger: % is not a test business', p_business;
  end if;
  delete from public.ledger_entries where business_id = p_business;
  get diagnostics n = row_count;
  return n;
end
$$;


--
-- Name: bump_row_version(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."bump_row_version"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at := app_now();
  END IF;
  NEW.resource_version := COALESCE(OLD.resource_version, 0) + 1;
  RETURN NEW;
END;
$$;


--
-- Name: due_work_sync(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."due_work_sync"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  ent uuid;
  biz uuid;
  org uuid;
BEGIN
  -- On DELETE the row is gone, so the diary entries go with it and there is nothing
  -- to recompute. OLD is the only record available.
  IF TG_OP = 'DELETE' THEN
    DELETE FROM due_work WHERE entity_id = OLD.id;
    RETURN OLD;
  END IF;

  ent := NEW.id;
  biz := NEW.business_id;
  org := NEW.organization_id;

  -- Clear this entity's rows, then re-derive. Delete-then-insert rather than upsert
  -- because a status change can REMOVE a kind (an active subscription that cancels
  -- owes no renewal), and an upsert cannot express a row that should stop existing.
  -- Safe inside a trigger in a way it is not in the periodic refresh: the whole thing
  -- runs in the caller's transaction, so no reader ever observes the gap.
  DELETE FROM due_work WHERE entity_id = ent;

  IF TG_TABLE_NAME = 'subscriptions' THEN
    -- Mirrors DUE_SOURCES.renewal and DUE_SOURCES.trial_end. `trial_end` coalesces to
    -- the term end because rows created before 0189 carry the boundary on the term.
    IF NEW.status = 'active' AND NEW.current_period_end IS NOT NULL THEN
      INSERT INTO due_work (shard, due_at, kind, entity_id, business_id, organization_id, updated_at)
      VALUES (abs(hashtext(coalesce(biz::text, ''))) % 1024,
              NEW.current_period_end, 'renewal', ent, biz, org, now());
    ELSIF NEW.status = 'in_trial'
      AND coalesce(NEW.trial_end, NEW.current_period_end) IS NOT NULL THEN
      INSERT INTO due_work (shard, due_at, kind, entity_id, business_id, organization_id, updated_at)
      VALUES (abs(hashtext(coalesce(biz::text, ''))) % 1024,
              coalesce(NEW.trial_end, NEW.current_period_end), 'trial_end', ent, biz, org, now());
    END IF;

  ELSIF TG_TABLE_NAME = 'scheduled_changes' THEN
    IF NEW.status = 'scheduled' THEN
      INSERT INTO due_work (shard, due_at, kind, entity_id, business_id, organization_id, updated_at)
      VALUES (abs(hashtext(coalesce(biz::text, ''))) % 1024,
              NEW.effective_at, 'scheduled_change', ent, biz, org, now());
    END IF;

  ELSIF TG_TABLE_NAME = 'invoices' THEN
    -- `autoCollectionOnSql()` is deliberately NOT applied, matching DUE_SOURCES: it
    -- depends on customer and business settings that can change between the diary
    -- being written and the work being done, and a diary that pre-judged a live
    -- setting would drop work the moment a merchant re-enabled auto-collection.
    IF NEW.status = 'payment_due' AND NEW.next_attempt_at IS NOT NULL THEN
      INSERT INTO due_work (shard, due_at, kind, entity_id, business_id, organization_id, updated_at)
      VALUES (abs(hashtext(coalesce(biz::text, ''))) % 1024,
              NEW.next_attempt_at, 'dunning_retry', ent, biz, org, now());
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: invoice_line_items_fill_decimals(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."invoice_line_items_fill_decimals"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.quantity IS DISTINCT FROM OLD.quantity
       AND NEW.quantity_decimal IS NOT DISTINCT FROM OLD.quantity_decimal THEN
      NEW.quantity_decimal := NEW.quantity;
    END IF;
    IF NEW.unit_amount_minor IS DISTINCT FROM OLD.unit_amount_minor
       AND NEW.unit_amount_decimal IS NOT DISTINCT FROM OLD.unit_amount_decimal THEN
      NEW.unit_amount_decimal := NEW.unit_amount_minor;
    END IF;
  END IF;
  IF NEW.quantity_decimal IS NULL THEN
    NEW.quantity_decimal := NEW.quantity;
  END IF;
  IF NEW.unit_amount_decimal IS NULL THEN
    NEW.unit_amount_decimal := NEW.unit_amount_minor;
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: invoices_dunning_status_rename(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."invoices_dunning_status_rename"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NEW.dunning_status = 'success' THEN
    NEW.dunning_status := 'succeeded';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: invoices_touch(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."invoices_touch"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at := app_now();
  NEW.resource_version := OLD.resource_version + 1;
  RETURN NEW;
END;
$$;


--
-- Name: transactions_status_rename(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."transactions_status_rename"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.status := CASE NEW.status
                  WHEN 'success' THEN 'succeeded'
                  WHEN 'failure' THEN 'failed'
                  WHEN 'late_failure' THEN 'late_failed'
                  ELSE NEW.status
                END;
  RETURN NEW;
END;
$$;


--
-- Name: usage_create_partition("text", "date"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."usage_create_partition"("p_table" "text", "p_month" "date") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  m date := make_date(extract(year FROM p_month)::int, extract(month FROM p_month)::int, 1);
  n date := (m + interval '1 month')::date;
  child text := p_table || '_y' || to_char(m, 'YYYY') || 'm' || to_char(m, 'MM');
BEGIN
  IF p_table NOT IN ('usage_events', 'usage_rollups') THEN
    RAISE EXCEPTION 'usage_create_partition: unknown table %', p_table;
  END IF;
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
    child, p_table, to_char(m, 'YYYY-MM-DD') || ' 00:00:00+00', to_char(n, 'YYYY-MM-DD') || ' 00:00:00+00'
  );
  EXECUTE format('REVOKE ALL ON public.%I FROM tmbilling_app', child);
  RETURN child;
END
$$;


--
-- Name: usage_drop_partition("text", "date"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."usage_drop_partition"("p_table" "text", "p_month" "date") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    SET "lock_timeout" TO '5s'
    AS $$
DECLARE
  m date := make_date(extract(year FROM p_month)::int, extract(month FROM p_month)::int, 1);
  child text := p_table || '_y' || to_char(m, 'YYYY') || 'm' || to_char(m, 'MM');
BEGIN
  IF p_table NOT IN ('usage_events', 'usage_rollups') THEN
    RAISE EXCEPTION 'usage_drop_partition: unknown table %', p_table;
  END IF;
  IF to_regclass('public.' || quote_ident(child)) IS NULL THEN
    RETURN NULL;
  END IF;
  EXECUTE format('ALTER TABLE public.%I DETACH PARTITION public.%I', p_table, child);
  EXECUTE format('DROP TABLE public.%I', child);
  RETURN child;
END
$$;


--
-- Name: usage_records_detach(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."usage_records_detach"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM subscriptions WHERE id = OLD.subscription_id) THEN
    UPDATE usage_records
       SET subscription_id = OLD.subscription_id, price_id = OLD.price_id
     WHERE subscription_item_id = OLD.id;
  ELSE
    DELETE FROM usage_records WHERE subscription_item_id = OLD.id;
  END IF;
  RETURN OLD;
END $$;


--
-- Name: uuid_v7(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."uuid_v7"() RETURNS "uuid"
    LANGUAGE "sql" PARALLEL SAFE
    AS $$
  SELECT encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid())
              PLACING substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
              FROM 1 FOR 6),
      52, 1), 53, 1),
    'hex')::uuid
$$;


SET default_tablespace = '';

SET default_table_access_method = "heap";

--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."api_keys" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "prefix" "text" NOT NULL,
    "hashed_key" "text" NOT NULL,
    "livemode" "text" DEFAULT 'test'::"text" NOT NULL,
    "last_used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "revoked_at" timestamp with time zone,
    "kind" "text" DEFAULT 'api'::"text" NOT NULL,
    "scope" "text" DEFAULT 'write'::"text" NOT NULL,
    "name" "text",
    "expires_at" timestamp with time zone,
    "permissions" "jsonb",
    CONSTRAINT "api_keys_kind_ck" CHECK (("kind" = ANY (ARRAY['api'::"text", 'dashboard'::"text"]))),
    CONSTRAINT "api_keys_livemode_ck" CHECK (("livemode" = ANY (ARRAY['test'::"text", 'live'::"text", 'all'::"text"]))),
    CONSTRAINT "api_keys_mode_kind_ck" CHECK ((("livemode" <> 'all'::"text") OR ("kind" = 'dashboard'::"text"))),
    CONSTRAINT "api_keys_permissions_kind_ck" CHECK ((("kind" <> 'dashboard'::"text") OR ("permissions" IS NULL))),
    CONSTRAINT "api_keys_permissions_object_ck" CHECK ((("permissions" IS NULL) OR ("jsonb_typeof"("permissions") = 'object'::"text"))),
    CONSTRAINT "api_keys_scope_ck" CHECK (("scope" = ANY (ARRAY['read'::"text", 'write'::"text"])))
);


--
-- Name: api_request_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."api_request_logs" (
    "id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid",
    "livemode" "text",
    "source" "text" NOT NULL,
    "api_key_id" "uuid",
    "member_user_id" "uuid",
    "method" "text" NOT NULL,
    "path" "text" NOT NULL,
    "route" "text",
    "query" "text",
    "kind" "text" NOT NULL,
    "status" smallint,
    "duration_ms" integer,
    "idempotency_key" "text",
    "idempotency_outcome" "text",
    "error_type" "text",
    "trace_id" "text",
    "customer_id" "text",
    "ip" "inet",
    "user_agent" "text",
    "request_body" "jsonb",
    "response_body" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "api_request_logs_kind_check" CHECK (("kind" = ANY (ARRAY['read'::"text", 'write'::"text"]))),
    CONSTRAINT "api_request_logs_livemode_check" CHECK (("livemode" = ANY (ARRAY['test'::"text", 'live'::"text"]))),
    CONSTRAINT "api_request_logs_source_check" CHECK (("source" = ANY (ARRAY['api'::"text", 'dashboard'::"text"])))
);


--
-- Name: api_server_errors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."api_server_errors" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "method" "text" NOT NULL,
    "route" "text" NOT NULL,
    "status" integer NOT NULL,
    "error_name" "text" NOT NULL,
    "error_code" "text",
    "message" "text" NOT NULL,
    "stack" "text",
    "organization_ref" "text",
    "business_ref" "text",
    "trace_id" "text"
);


--
-- Name: applied_coupons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."applied_coupons" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "coupon_id" "uuid",
    "subscription_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "remaining_periods" integer,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "source" "text" DEFAULT 'coupon'::"text" NOT NULL,
    "manual_kind" "text",
    "manual_percent_off_bps" integer,
    "manual_amount_off_minor" bigint,
    "manual_currency" character(3),
    "manual_note" "text",
    "total_periods" integer,
    "period_anchor" timestamp with time zone,
    "period_used_minor" bigint DEFAULT 0 NOT NULL,
    "entered_by_customer" boolean DEFAULT false NOT NULL,
    CONSTRAINT "applied_coupons_period_used_non_negative" CHECK (("period_used_minor" >= 0))
);


--
-- Name: applied_taxes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."applied_taxes" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "invoice_line_item_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "rate_bps" integer NOT NULL,
    "amount_minor" bigint NOT NULL,
    "taxability_reason" "text" DEFAULT 'standard_rated'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "tax_component_id" "uuid"
);


--
-- Name: attached_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."attached_items" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "item_product_id" "uuid" NOT NULL,
    "plan_product_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "applicability" "text" DEFAULT 'optional'::"text" NOT NULL,
    "charge_on_event" "text" DEFAULT 'subscription_creation'::"text" NOT NULL,
    "charge_once" boolean DEFAULT false NOT NULL,
    "default_quantity" integer DEFAULT 1 NOT NULL,
    "billing_cycles" integer,
    "min_quantity" integer,
    "max_quantity" integer,
    "quantity_step" integer DEFAULT 1 NOT NULL,
    "customer_can_change_quantity" boolean DEFAULT true NOT NULL
);


--
-- Name: audit_log_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."audit_log_snapshots" (
    "audit_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "before_full" "jsonb",
    "after_full" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."audit_logs" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid",
    "actor" "text" NOT NULL,
    "source" "text" NOT NULL,
    "action" "text" NOT NULL,
    "resource_type" "text",
    "resource_id" "text",
    "before" "jsonb",
    "after" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "actor_ip" "inet",
    "trace_id" "text"
);


--
-- Name: auth_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."auth_tokens" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "user_id" "uuid",
    "token_hash" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "consumed_at" timestamp with time zone,
    "requested_ip" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "purpose" "text" DEFAULT 'password_reset'::"text" NOT NULL,
    "payload" "text",
    CONSTRAINT "auth_tokens_purpose_ck" CHECK (("purpose" = ANY (ARRAY['password_reset'::"text", 'invite'::"text", 'mfa_challenge'::"text", 'mfa_setup'::"text", 'signup'::"text", 'signup_invite'::"text"]))),
    CONSTRAINT "auth_tokens_user_ck" CHECK ((("user_id" IS NOT NULL) OR ("purpose" = ANY (ARRAY['signup'::"text", 'signup_invite'::"text"]))))
);


--
-- Name: TABLE "auth_tokens"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."auth_tokens" IS 'Single-use, short-lived operator credentials — password resets and invites. SHA-256 only. Purpose is checked when spending, so the two kinds are not interchangeable. Operator identity, not tenant data, so no RLS.';


--
-- Name: businesses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."businesses" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "default_currency" character(3) NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "address" "jsonb",
    "contact_email" "text",
    "support_email" "text",
    "phone" "text",
    "website" "text",
    "logo_url" "text",
    "timezone" "text",
    "tax_registration_number" "text",
    "invoice_prefix" "text" DEFAULT 'INV'::"text" NOT NULL,
    "invoice_next_number" bigint DEFAULT 1 NOT NULL,
    "default_invoice_notes" "text",
    "default_due_days" integer,
    "dunning_retry_days" "jsonb",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    "livemode" "text" DEFAULT 'live'::"text" NOT NULL,
    "currencies" "jsonb",
    "default_gateway_account_id" "uuid",
    "create_pending_invoices" boolean DEFAULT false NOT NULL,
    "auto_close_pending_after_days" integer,
    "dunning_config" "jsonb",
    "invoice_rounding" "text" DEFAULT 'none'::"text" NOT NULL,
    "default_prorate_on_change" boolean DEFAULT false NOT NULL,
    "default_invoice_immediately" boolean DEFAULT false NOT NULL,
    "default_cancel_option" "text" DEFAULT 'immediately'::"text" NOT NULL,
    "default_credit_option_for_cancel" "text" DEFAULT 'none'::"text" NOT NULL,
    "default_unbilled_on_cancel" "text" DEFAULT 'no_action'::"text" NOT NULL,
    "credit_note_prefix" "text" DEFAULT 'CN'::"text" NOT NULL,
    "credit_note_next_number" bigint DEFAULT 1 NOT NULL,
    "exchange_rates" "jsonb",
    "billing_frequencies" "jsonb",
    "email_config" "jsonb",
    "default_tax_behavior" "text" DEFAULT 'exclusive'::"text" NOT NULL,
    "anchor_granularity" "text" DEFAULT 'instant'::"text" NOT NULL,
    "proration_granularity" "text" DEFAULT 'exact'::"text" NOT NULL,
    "smtp_config" "jsonb",
    "smtp_credentials_enc" "text",
    "default_tax_code" "text",
    "icon_url" "text",
    "favicon_url" "text",
    "brand_color" "text",
    "ses_config" "jsonb",
    "ses_credentials_enc" "text",
    "credits_flexibility" "jsonb",
    "mandate_config" "jsonb",
    "exchange_rate_sources" "jsonb",
    "invoice_issuer" "text" DEFAULT 'business'::"text" NOT NULL,
    "allow_customer_coupons" boolean DEFAULT false NOT NULL,
    "invoice_customization" "jsonb",
    "default_ar_handling_on_cancel" "text" DEFAULT 'no_action'::"text" NOT NULL,
    "default_refundable_credits_on_cancel" "text" DEFAULT 'no_action'::"text" NOT NULL,
    "unbilled_charges_config" "jsonb",
    "pause_config" "jsonb",
    "backdating_config" "jsonb",
    "default_credit_note_on_void" boolean DEFAULT false NOT NULL,
    "vies_validation_enabled" boolean DEFAULT true NOT NULL,
    "prorate_fixed_amount_coupons" boolean DEFAULT false NOT NULL,
    "storefront_config" "jsonb",
    "chargeback_config" "jsonb",
    "checkout_field_config" "jsonb",
    "inherit_subscription_po_number" boolean DEFAULT true NOT NULL,
    "week_start" "text" DEFAULT 'sunday'::"text" NOT NULL,
    "fiscal_year_start_month" integer DEFAULT 1 NOT NULL,
    "metadata_rules_config" "jsonb",
    "portal_field_config" "jsonb",
    "live_business_id" "uuid",
    "live_business_mode" "text" GENERATED ALWAYS AS ('live'::"text") STORED,
    "reminder_config" "jsonb",
    "receipt_prefix" "text" DEFAULT 'RCPT'::"text" NOT NULL,
    "receipt_next_number" bigint DEFAULT 1 NOT NULL,
    "test_customer_limit" integer,
    "test_subscription_limit" integer,
    "usage_close_delay_minutes" smallint DEFAULT 0 NOT NULL,
    "credit_config" "jsonb",
    "usage_widget_origins" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "usage_controls_active" boolean DEFAULT false NOT NULL,
    "billing_rules_config" "jsonb",
    "card_payment_limits" "jsonb",
    "invoice_rules_config" "jsonb",
    "tax_settings" "jsonb",
    "team_alerts_config" "jsonb",
    "max_customer_coupon_codes" smallint DEFAULT 1 NOT NULL,
    CONSTRAINT "businesses_billing_mode_ck" CHECK ((((("anchor_granularity" = 'instant'::"text") AND ("proration_granularity" = 'exact'::"text")) OR (("anchor_granularity" = 'instant'::"text") AND ("proration_granularity" = 'whole_day'::"text"))) OR (("anchor_granularity" = 'day'::"text") AND ("proration_granularity" = 'whole_day'::"text")))),
    CONSTRAINT "businesses_brand_color_hex" CHECK ((("brand_color" IS NULL) OR ("brand_color" ~ '^#[0-9A-Fa-f]{6}$'::"text"))),
    CONSTRAINT "businesses_credit_config_ck" CHECK ((("credit_config" IS NULL) OR ("jsonb_typeof"("credit_config") = 'object'::"text"))),
    CONSTRAINT "businesses_fiscal_year_start_month_check" CHECK ((("fiscal_year_start_month" >= 1) AND ("fiscal_year_start_month" <= 12))),
    CONSTRAINT "businesses_invoice_issuer_ck" CHECK (("invoice_issuer" = ANY (ARRAY['business'::"text", 'organization'::"text"]))),
    CONSTRAINT "businesses_live_business_ck" CHECK ((("live_business_id" IS NULL) OR ("livemode" = 'test'::"text"))),
    CONSTRAINT "businesses_mail_transport_ck" CHECK ((NOT ((NOT (("smtp_config" ->> 'enabled'::"text") IS DISTINCT FROM 'true'::"text")) AND (NOT (("ses_config" ->> 'enabled'::"text") IS DISTINCT FROM 'true'::"text"))))),
    CONSTRAINT "businesses_max_customer_coupon_codes_ck" CHECK ((("max_customer_coupon_codes" >= 1) AND ("max_customer_coupon_codes" <= 10))),
    CONSTRAINT "businesses_ses_config_ck" CHECK ((("ses_config" IS NULL) OR ((("ses_config" ->> 'enabled'::"text") IS DISTINCT FROM 'true'::"text") OR ((COALESCE(("ses_config" ->> 'region'::"text"), ''::"text") <> ''::"text") AND (COALESCE(("ses_config" ->> 'accessKeyId'::"text"), ''::"text") <> ''::"text") AND ("ses_credentials_enc" IS NOT NULL))))),
    CONSTRAINT "businesses_smtp_config_ck" CHECK ((("smtp_config" IS NULL) OR ((("smtp_config" ->> 'enabled'::"text") IS DISTINCT FROM 'true'::"text") OR ((COALESCE(("smtp_config" ->> 'host'::"text"), ''::"text") <> ''::"text") AND (("smtp_config" ->> 'port'::"text") ~ '^[0-9]+$'::"text") AND ("smtp_credentials_enc" IS NOT NULL))))),
    CONSTRAINT "businesses_test_limits_nonneg" CHECK (((("test_customer_limit" IS NULL) OR ("test_customer_limit" >= 0)) AND (("test_subscription_limit" IS NULL) OR ("test_subscription_limit" >= 0)))),
    CONSTRAINT "businesses_usage_close_delay_minutes_ck" CHECK ((("usage_close_delay_minutes" >= 0) AND ("usage_close_delay_minutes" <= 24))),
    CONSTRAINT "businesses_week_start_check" CHECK (("week_start" = ANY (ARRAY['sunday'::"text", 'monday'::"text"])))
);


--
-- Name: COLUMN "businesses"."default_tax_code"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."businesses"."default_tax_code" IS 'Default HSN/SAC classification for this business''s output supplies (India GST). Overridden per product by products.tax_code.';


--
-- Name: COLUMN "businesses"."exchange_rate_sources"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."businesses"."exchange_rate_sources" IS 'Per-currency provenance for exchange_rates: {"INR":{"source":"auto|manual","updated_at":ISO,"provider":"ecb","last_error":null}}. A currency absent here is manual. Reporting + invoice-snapshot only; never rates or settles a charge.';


--
-- Name: COLUMN "businesses"."invoice_customization"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."businesses"."invoice_customization" IS 'What the printed invoice/credit note shows: field toggles, titles, address format, signature, credit-note note, dynamic number prefix. NULL = pre-0239 rendering. Resolved by resolveInvoiceCustomization; governs documents only, never the API resource.';


--
-- Name: buyer_request_rejections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."buyer_request_rejections" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "surface" "text" NOT NULL,
    "method" "text" NOT NULL,
    "route" "text" NOT NULL,
    "session_public_id" "text" NOT NULL,
    "organization_id" "uuid",
    "business_id" "uuid",
    "customer_id" "uuid",
    "message" "text" NOT NULL,
    "fields" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "trace_id" "text"
);


--
-- Name: checkout_session_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."checkout_session_items" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "checkout_session_id" "uuid" NOT NULL,
    "price_id" "uuid" NOT NULL,
    "quantity" integer DEFAULT 1 NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: checkout_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."checkout_sessions" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "public_id" "text" NOT NULL,
    "token_hash" "text" NOT NULL,
    "created_by" "text",
    "resulting_customer_id" "uuid",
    "resulting_subscription_id" "uuid",
    "expires_at" timestamp with time zone NOT NULL,
    "last_used_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "mode" "text" DEFAULT 'create'::"text" NOT NULL,
    "subscription_id" "uuid",
    "coupon_codes" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "replace_items_list" boolean DEFAULT false NOT NULL,
    "reset_term" boolean DEFAULT false NOT NULL,
    "metadata" "jsonb",
    "setup_payment_intent" "text",
    "reactivate" boolean DEFAULT false NOT NULL,
    "reactivate_from" timestamp with time zone,
    "replace_coupon_list" boolean DEFAULT false NOT NULL,
    "redirect_url" "text",
    "cancel_url" "text",
    "pass_thru_content" "text",
    "prefill" "jsonb",
    "payment_started_at" timestamp with time zone,
    "resulting_invoice_id" "uuid",
    "customer_pinned" boolean DEFAULT false NOT NULL,
    "payment_link_id" "uuid",
    "reminder_count" integer DEFAULT 0 NOT NULL,
    "last_reminded_at" timestamp with time zone,
    "resume_token_hash" "text",
    "first_viewed_at" timestamp with time zone,
    "details_submitted_at" timestamp with time zone,
    "payment_attempt_count" integer DEFAULT 0 NOT NULL,
    "payment_failure_count" integer DEFAULT 0 NOT NULL,
    "last_payment_failure" "text",
    "layout" "text",
    "device_class" "text",
    "recurring_consent_text" "text",
    "consented_at" timestamp with time zone,
    "terms_accepted_at" timestamp with time zone,
    "consent_ip" "text",
    "setup_consent" "jsonb",
    "customer_coupon_codes" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    CONSTRAINT "checkout_sessions_device_class_ck" CHECK ((("device_class" IS NULL) OR ("device_class" = ANY (ARRAY['mobile'::"text", 'tablet'::"text", 'desktop'::"text"])))),
    CONSTRAINT "checkout_sessions_layout_ck" CHECK ((("layout" IS NULL) OR ("layout" = ANY (ARRAY['steps'::"text", 'one_page'::"text"])))),
    CONSTRAINT "checkout_sessions_mode_target_ck" CHECK (((("mode" = ANY (ARRAY['create'::"text", 'purchase'::"text"])) AND ("subscription_id" IS NULL)) OR (("mode" = 'change'::"text") AND ("subscription_id" IS NOT NULL))))
);


--
-- Name: COLUMN "checkout_sessions"."replace_items_list"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."checkout_sessions"."replace_items_list" IS 'mode=change: the posted item list is exhaustive — unlisted non-plan items are removed on completion. Default false = upsert.';


--
-- Name: COLUMN "checkout_sessions"."reset_term"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."checkout_sessions"."reset_term" IS 'mode=change: restart the billing term from the change date instead of prorating into the current one.';


--
-- Name: clock_ticks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."clock_ticks" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "started_at" timestamp with time zone NOT NULL,
    "finished_at" timestamp with time zone,
    "scheduled_applied" integer DEFAULT 0 NOT NULL,
    "renewed" integer DEFAULT 0 NOT NULL,
    "dunning_retried" integer DEFAULT 0 NOT NULL,
    "dunning_recovered" integer DEFAULT 0 NOT NULL,
    "dunning_canceled" integer DEFAULT 0 NOT NULL,
    "webhooks_delivered" integer DEFAULT 0 NOT NULL,
    "webhooks_failed" integer DEFAULT 0 NOT NULL,
    "errors" "jsonb",
    "overran" boolean DEFAULT false NOT NULL,
    "lag_ms" integer,
    "downtime_gap" boolean DEFAULT false NOT NULL,
    "passes" "jsonb",
    "trace_id" "text"
);


--
-- Name: COLUMN "clock_ticks"."lag_ms"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."clock_ticks"."lag_ms" IS 'ms between the previous tick finishing and this one starting; NULL for the first tick';


--
-- Name: COLUMN "clock_ticks"."downtime_gap"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."clock_ticks"."downtime_gap" IS 'the gap exceeded TICK_LAG_MS but no worker process spanned it — restart/deploy/outage, not clock lag';


--
-- Name: comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."comments" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "resource_type" "text" NOT NULL,
    "resource_id" "text" NOT NULL,
    "author" "text" NOT NULL,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL
);


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."contacts" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "first_name" "text",
    "last_name" "text",
    "email" "text" NOT NULL,
    "phone" "text",
    "label" "text",
    "enabled" boolean DEFAULT true NOT NULL,
    "send_account_email" boolean DEFAULT false NOT NULL,
    "send_billing_email" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL
);


--
-- Name: countries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."countries" (
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "dial_code" "text",
    "phone_pattern" "text",
    "phone_lengths" integer[],
    "region_label" "text" DEFAULT 'State / Province'::"text" NOT NULL,
    "postal_label" "text" DEFAULT 'Postal code'::"text" NOT NULL,
    "has_postal_code" boolean DEFAULT true NOT NULL,
    "postal_regex" "text",
    "postal_redundant" "text",
    "postal_hint" "text",
    "subdivision_strict" boolean DEFAULT false NOT NULL,
    "timezones" "text"[]
);


--
-- Name: country_subdivision_aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."country_subdivision_aliases" (
    "country_code" "text" NOT NULL,
    "alias" "text" NOT NULL,
    "code" "text" NOT NULL
);


--
-- Name: country_subdivisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."country_subdivisions" (
    "country_code" "text" NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "type" "text"
);


--
-- Name: coupon_item_constraints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."coupon_item_constraints" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "coupon_id" "uuid" NOT NULL,
    "item_kind" "text" NOT NULL,
    "constraint_type" "text" NOT NULL,
    "product_ids" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "price_ids" "jsonb"
);


--
-- Name: coupon_set_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."coupon_set_codes" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "coupon_set_id" "uuid" NOT NULL,
    "code" "text" NOT NULL,
    "status" "text" DEFAULT 'not_redeemed'::"text" NOT NULL,
    "redeemed_at" timestamp with time zone,
    "applied_coupon_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: coupon_sets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."coupon_sets" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "coupon_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    "metadata" "jsonb"
);


--
-- Name: coupons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."coupons" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "code" "text" NOT NULL,
    "name" "text",
    "kind" "text" NOT NULL,
    "percent_off_bps" integer,
    "amount_off_minor" bigint,
    "currency" character(3),
    "duration_type" "text" DEFAULT 'once'::"text" NOT NULL,
    "duration_in_periods" integer,
    "max_redemptions" integer,
    "times_redeemed" integer DEFAULT 0 NOT NULL,
    "redeem_by" timestamp with time zone,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    "metadata" "jsonb",
    "apply_on" "text" DEFAULT 'invoice_amount'::"text" NOT NULL,
    "valid_from" timestamp with time zone,
    "invoice_name" "text",
    "max_redemptions_per_customer" integer,
    CONSTRAINT "coupons_max_redemptions_per_customer_ck" CHECK ((("max_redemptions_per_customer" IS NULL) OR ("max_redemptions_per_customer" > 0)))
);


--
-- Name: credit_auto_topup_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."credit_auto_topup_runs" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "config_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "trigger" "text" NOT NULL,
    "trigger_key" "text",
    "amount_minor" bigint NOT NULL,
    "currency" character(3) NOT NULL,
    "status" "text" DEFAULT 'created'::"text" NOT NULL,
    "invoice_id" "uuid",
    "payment_id" "uuid",
    "notice_id" "uuid",
    "charge_after" timestamp with time zone,
    "decline_code" "text",
    "failure_message" "text",
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    CONSTRAINT "credit_auto_topup_runs_amount_minor_check" CHECK (("amount_minor" > 0)),
    CONSTRAINT "credit_auto_topup_runs_status_check" CHECK (("status" = ANY (ARRAY['created'::"text", 'notice_sent'::"text", 'charging'::"text", 'pending'::"text", 'succeeded'::"text", 'failed'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "credit_auto_topup_runs_trigger_check" CHECK (("trigger" = ANY (ARRAY['threshold'::"text", 'schedule'::"text"])))
);


--
-- Name: credit_auto_topups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."credit_auto_topups" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "currency" character(3) NOT NULL,
    "unit_id" "uuid",
    "trigger" "text" NOT NULL,
    "threshold_minor" bigint,
    "schedule" "jsonb",
    "method" "text" NOT NULL,
    "amount_minor" bigint,
    "target_minor" bigint,
    "monthly_cap_minor" bigint NOT NULL,
    "max_runs_per_day" smallint DEFAULT 3 NOT NULL,
    "payment_method_id" "uuid",
    "grant_config" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "disabled_reason" "text",
    "disabled_at" timestamp with time zone,
    "threshold_low_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    CONSTRAINT "credit_auto_topups_amount_minor_check" CHECK ((("amount_minor" IS NULL) OR ("amount_minor" > 0))),
    CONSTRAINT "credit_auto_topups_disabled_ck" CHECK ((("status" = 'disabled'::"text") = ("disabled_at" IS NOT NULL))),
    CONSTRAINT "credit_auto_topups_fixed_ck" CHECK ((("method" = 'fixed'::"text") = ("amount_minor" IS NOT NULL))),
    CONSTRAINT "credit_auto_topups_grant_config_check" CHECK (("jsonb_typeof"("grant_config") = 'object'::"text")),
    CONSTRAINT "credit_auto_topups_max_runs_per_day_check" CHECK ((("max_runs_per_day" >= 1) AND ("max_runs_per_day" <= 10))),
    CONSTRAINT "credit_auto_topups_method_check" CHECK (("method" = ANY (ARRAY['fixed'::"text", 'target'::"text"]))),
    CONSTRAINT "credit_auto_topups_monthly_cap_minor_check" CHECK (("monthly_cap_minor" > 0)),
    CONSTRAINT "credit_auto_topups_reason_ck" CHECK ((("disabled_reason" IS NULL) OR ("status" = 'disabled'::"text"))),
    CONSTRAINT "credit_auto_topups_schedule_check" CHECK ((("schedule" IS NULL) OR ("jsonb_typeof"("schedule") = 'object'::"text"))),
    CONSTRAINT "credit_auto_topups_schedule_ck" CHECK ((("trigger" = 'schedule'::"text") = ("schedule" IS NOT NULL))),
    CONSTRAINT "credit_auto_topups_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'disabled'::"text"]))),
    CONSTRAINT "credit_auto_topups_target_ck" CHECK ((("method" = 'target'::"text") = ("target_minor" IS NOT NULL))),
    CONSTRAINT "credit_auto_topups_target_minor_check" CHECK ((("target_minor" IS NULL) OR ("target_minor" > 0))),
    CONSTRAINT "credit_auto_topups_threshold_ck" CHECK ((("trigger" = 'threshold'::"text") = ("threshold_minor" IS NOT NULL))),
    CONSTRAINT "credit_auto_topups_threshold_minor_check" CHECK ((("threshold_minor" IS NULL) OR ("threshold_minor" >= 0))),
    CONSTRAINT "credit_auto_topups_trigger_check" CHECK (("trigger" = ANY (ARRAY['threshold'::"text", 'schedule'::"text"])))
);


--
-- Name: credit_grant_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."credit_grant_movements" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "grant_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "units" bigint NOT NULL,
    "face_minor" bigint NOT NULL,
    "cost_minor" bigint DEFAULT 0 NOT NULL,
    "invoice_id" "uuid",
    "ledger_transaction_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    CONSTRAINT "credit_grant_movements_kind_check" CHECK (("kind" = ANY (ARRAY['grant'::"text", 'draw'::"text", 'expire'::"text", 'void'::"text", 'restore'::"text", 'rollover_in'::"text", 'rollover_out'::"text", 'activate'::"text"]))),
    CONSTRAINT "credit_grant_movements_sign_ck" CHECK (
CASE
    WHEN ("kind" = ANY (ARRAY['grant'::"text", 'restore'::"text", 'rollover_in'::"text"])) THEN (("units" >= 0) AND ("face_minor" >= 0) AND ("cost_minor" >= 0))
    WHEN ("kind" = ANY (ARRAY['draw'::"text", 'expire'::"text", 'void'::"text", 'rollover_out'::"text"])) THEN (("units" <= 0) AND ("face_minor" <= 0) AND ("cost_minor" <= 0))
    ELSE true
END)
);


--
-- Name: credit_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."credit_grants" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "currency" character(3) NOT NULL,
    "unit_id" "uuid",
    "amount" bigint NOT NULL,
    "face_minor" bigint NOT NULL,
    "cost_basis_minor" bigint DEFAULT 0 NOT NULL,
    "category" "text" NOT NULL,
    "priority" smallint DEFAULT 50 NOT NULL,
    "effective_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "expires_at" timestamp with time zone,
    "applicability" "jsonb" DEFAULT '{"kind": "metered"}'::"jsonb" NOT NULL,
    "source" "text" NOT NULL,
    "source_ref" "text",
    "invoice_id" "uuid",
    "subscription_item_id" "uuid",
    "restored_from_id" "uuid",
    "tax_treatment" "text",
    "on_exhausted" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "metadata" "jsonb",
    "created_by_user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    CONSTRAINT "credit_grants_amount_check" CHECK (("amount" > 0)),
    CONSTRAINT "credit_grants_applicability_check" CHECK (("jsonb_typeof"("applicability") = 'object'::"text")),
    CONSTRAINT "credit_grants_category_check" CHECK (("category" = ANY (ARRAY['paid'::"text", 'promotional'::"text"]))),
    CONSTRAINT "credit_grants_cost_basis_minor_check" CHECK (("cost_basis_minor" >= 0)),
    CONSTRAINT "credit_grants_expiry_ck" CHECK ((("expires_at" IS NULL) OR ("expires_at" > "effective_at"))),
    CONSTRAINT "credit_grants_face_minor_check" CHECK (("face_minor" > 0)),
    CONSTRAINT "credit_grants_on_exhausted_check" CHECK (("on_exhausted" = ANY (ARRAY['block'::"text", 'bill'::"text"]))),
    CONSTRAINT "credit_grants_paid_invoice_ck" CHECK ((("category" <> 'paid'::"text") OR ("invoice_id" IS NOT NULL) OR ("restored_from_id" IS NOT NULL))),
    CONSTRAINT "credit_grants_priority_check" CHECK ((("priority" >= 0) AND ("priority" <= 100))),
    CONSTRAINT "credit_grants_promotional_cost_ck" CHECK ((("category" = 'paid'::"text") OR ("cost_basis_minor" = 0))),
    CONSTRAINT "credit_grants_restore_ck" CHECK ((("source" = 'restore'::"text") = ("restored_from_id" IS NOT NULL))),
    CONSTRAINT "credit_grants_source_check" CHECK (("source" = ANY (ARRAY['purchase'::"text", 'plan_cycle'::"text", 'manual'::"text", 'restore'::"text", 'auto_top_up'::"text"]))),
    CONSTRAINT "credit_grants_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'active'::"text", 'expired'::"text", 'voided'::"text"]))),
    CONSTRAINT "credit_grants_tax_treatment_check" CHECK (("tax_treatment" = ANY (ARRAY['taxed_at_purchase'::"text", 'taxed_at_use'::"text"]))),
    CONSTRAINT "credit_grants_taxed_at_use_money_ck" CHECK ((("tax_treatment" IS DISTINCT FROM 'taxed_at_use'::"text") OR ("unit_id" IS NULL))),
    CONSTRAINT "credit_grants_treatment_ck" CHECK ((("category" = 'paid'::"text") = ("tax_treatment" IS NOT NULL)))
);


--
-- Name: credit_holds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."credit_holds" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "currency" character(3) NOT NULL,
    "amount_minor" bigint NOT NULL,
    "meter_id" "uuid",
    "scope" "jsonb",
    "status" "text" DEFAULT 'held'::"text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "captured_minor" bigint,
    "usage_event_id" "uuid",
    "overdraft" boolean DEFAULT false NOT NULL,
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    CONSTRAINT "credit_holds_amount_minor_check" CHECK (("amount_minor" > 0)),
    CONSTRAINT "credit_holds_captured_ck" CHECK ((("status" = 'captured'::"text") = ("captured_minor" IS NOT NULL))),
    CONSTRAINT "credit_holds_captured_minor_check" CHECK ((("captured_minor" IS NULL) OR ("captured_minor" >= 0))),
    CONSTRAINT "credit_holds_scope_check" CHECK ((("scope" IS NULL) OR ("jsonb_typeof"("scope") = 'object'::"text"))),
    CONSTRAINT "credit_holds_status_check" CHECK (("status" = ANY (ARRAY['held'::"text", 'captured'::"text", 'released'::"text", 'expired'::"text"])))
);


--
-- Name: credit_note_allocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."credit_note_allocations" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "credit_note_id" "uuid" NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "amount_minor" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL
);


--
-- Name: credit_note_discounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."credit_note_discounts" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "credit_note_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "amount_minor" bigint NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    CONSTRAINT "credit_note_discounts_amount_minor_check" CHECK (("amount_minor" >= 0)),
    CONSTRAINT "credit_note_discounts_type_check" CHECK (("type" = ANY (ARRAY['promotional_credits'::"text", 'excess_payments'::"text", 'credit_grants'::"text", 'item_level_coupon'::"text", 'document_level_coupon'::"text", 'prorated_credits'::"text"])))
);


--
-- Name: credit_note_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."credit_note_items" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "credit_note_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "description" "text" NOT NULL,
    "amount_minor" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "period_start" timestamp with time zone,
    "period_end" timestamp with time zone,
    "invoice_line_item_id" "uuid",
    "kind" "text"
);


--
-- Name: credit_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."credit_notes" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "credit_method" "text" NOT NULL,
    "status" "text" DEFAULT 'refund_due'::"text" NOT NULL,
    "total_minor" bigint NOT NULL,
    "currency" character(3) NOT NULL,
    "reason" "text",
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "imported" boolean DEFAULT false NOT NULL,
    "metadata" "jsonb",
    "kind" "text" DEFAULT 'refundable'::"text" NOT NULL,
    "reason_code" "text",
    "allocated_minor" bigint DEFAULT 0 NOT NULL,
    "refunded_minor" bigint DEFAULT 0 NOT NULL,
    "paid_out_minor" bigint DEFAULT 0 NOT NULL,
    "number" "text",
    "voided_at" timestamp with time zone,
    "channel" "text",
    "subtotal_minor" bigint,
    "payout_attempt_at" timestamp with time zone,
    "exchange_rate" numeric(20,10),
    "exchange_rate_base" character(3),
    "customer_notes" "text",
    "refund_id" "uuid",
    "payout_unconfirmed_minor" bigint DEFAULT 0 NOT NULL,
    "payout_duplicated_minor" bigint DEFAULT 0 NOT NULL,
    "payout_out_of_order_minor" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "credit_notes_exchange_rate_valid" CHECK (((("exchange_rate" IS NULL) AND ("exchange_rate_base" IS NULL)) OR (("exchange_rate" > (0)::numeric) AND ("exchange_rate_base" IS NOT NULL)))),
    CONSTRAINT "credit_notes_status_ck" CHECK (("status" = ANY (ARRAY['adjusted'::"text", 'refund_due'::"text", 'refunded'::"text", 'voided'::"text"])))
);


--
-- Name: COLUMN "credit_notes"."exchange_rate"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."credit_notes"."exchange_rate" IS 'Inherited from the invoice this note credits, so a reversal converts at the same rate as the document it reverses.';


--
-- Name: credit_units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."credit_units" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "key" "text" NOT NULL,
    "name" "text" NOT NULL,
    "plural_name" "text" NOT NULL,
    "currency" character(3) NOT NULL,
    "minor_per_unit_e12" bigint NOT NULL,
    "decimals" smallint DEFAULT 0 NOT NULL,
    "locked_at" timestamp with time zone,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    CONSTRAINT "credit_units_decimals_check" CHECK ((("decimals" >= 0) AND ("decimals" <= 4))),
    CONSTRAINT "credit_units_minor_per_unit_e12_check" CHECK (("minor_per_unit_e12" > 0))
);


--
-- Name: custom_field_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."custom_field_definitions" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "public_id" "text" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "entity_type" "text" NOT NULL,
    "api_name" "text" NOT NULL,
    "label" "text" NOT NULL,
    "data_type" "text" NOT NULL,
    "enum_options" "jsonb",
    "required" boolean DEFAULT false NOT NULL,
    "is_pii" boolean DEFAULT false NOT NULL,
    "show_in_portal" boolean DEFAULT false NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "archived" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    "show_on_invoice" boolean DEFAULT false NOT NULL
);


--
-- Name: COLUMN "custom_field_definitions"."show_on_invoice"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."custom_field_definitions"."show_on_invoice" IS 'Print this field on the invoice PDF/HTML. At most MAX_INVOICE_CUSTOM_FIELDS are rendered, ordered by position; the cap is applied on read, not by a constraint.';


--
-- Name: customer_addresses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."customer_addresses" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "label" "text",
    "first_name" "text",
    "last_name" "text",
    "company" "text",
    "phone" "text",
    "line1" "text",
    "line2" "text",
    "line3" "text",
    "city" "text",
    "state" "text",
    "state_code" "text",
    "postal_code" "text",
    "country" character(2),
    "is_default" boolean DEFAULT false NOT NULL,
    "archived_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL
);


--
-- Name: customer_limit_tier_reached; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."customer_limit_tier_reached" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "tier_id" "uuid" NOT NULL,
    "currency" character(3) NOT NULL,
    "lifetime_paid_minor" bigint NOT NULL,
    "reached_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL
);


--
-- Name: customer_meter_billing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."customer_meter_billing" (
    "customer_id" "uuid" NOT NULL,
    "meter_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "subscription_id" "uuid",
    "generation" bigint DEFAULT 0 NOT NULL,
    "usage_through" timestamp with time zone,
    "cutoff_generation" bigint,
    "cutoff_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL
);


--
-- Name: customer_segments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."customer_segments" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "filters" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "starter_key" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    CONSTRAINT "customer_segments_filters_is_array_check" CHECK (("jsonb_typeof"("filters") = 'array'::"text")),
    CONSTRAINT "customer_segments_not_empty_check" CHECK (("jsonb_array_length"("filters") > 0))
);


--
-- Name: customer_usage_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."customer_usage_keys" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "key" "text" NOT NULL,
    "match_pending" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    CONSTRAINT "customer_usage_keys_key_check" CHECK ((("char_length"("key") >= 1) AND ("char_length"("key") <= 255)))
);


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."customers" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "email" "text",
    "name" "text",
    "currency" character(3),
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "address_line1" "text",
    "address_line2" "text",
    "city" "text",
    "state" "text",
    "postal_code" "text",
    "country" character(2),
    "active" boolean DEFAULT true NOT NULL,
    "tax_exempt" boolean DEFAULT false NOT NULL,
    "vat_number" "text",
    "withholding_rate_bps" integer DEFAULT 0 NOT NULL,
    "first_name" "text",
    "last_name" "text",
    "company" "text",
    "phone" "text",
    "locale" "text",
    "auto_collection" "text" DEFAULT 'on'::"text" NOT NULL,
    "net_term_days" integer DEFAULT 0 NOT NULL,
    "invoice_notes" "text",
    "address_line3" "text",
    "state_code" "text",
    "billing_first_name" "text",
    "billing_last_name" "text",
    "billing_company" "text",
    "billing_phone" "text",
    "shipping_address" "jsonb",
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    "vat_number_status" "text" DEFAULT 'not_validated'::"text" NOT NULL,
    "vat_validated_at" timestamp with time zone,
    "billing_date" integer,
    "billing_date_mode" "text" DEFAULT 'using_defaults'::"text" NOT NULL,
    "pii_cleared" "text",
    "custom_fields" "jsonb",
    "tax_treatment" "text" DEFAULT 'default'::"text" NOT NULL,
    "tax_registration_number" "text",
    "email_notifications" boolean DEFAULT true NOT NULL,
    "dunning_excluded" boolean DEFAULT false NOT NULL,
    "dunning_excluded_at" timestamp with time zone,
    "dunning_policy_id" "uuid",
    "credit_settings" "jsonb",
    "marketing_opt_in" boolean,
    "marketing_opt_in_at" timestamp with time zone,
    "exclude_from_reporting" boolean DEFAULT false NOT NULL,
    "billing_cc_emails" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "billing_bcc_emails" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "tax_behavior" "text",
    CONSTRAINT "customers_credit_settings_ck" CHECK ((("credit_settings" IS NULL) OR ("jsonb_typeof"("credit_settings") = 'object'::"text"))),
    CONSTRAINT "customers_tax_behavior_ck" CHECK ((("tax_behavior" IS NULL) OR ("tax_behavior" = ANY (ARRAY['inclusive'::"text", 'exclusive'::"text"]))))
);


--
-- Name: decline_rule_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."decline_rule_overrides" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "gateway_account_id" "uuid",
    "decline_rule_id" "text",
    "retriable" boolean,
    "message" "text",
    "exposed_to_payer" boolean,
    "updated_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "decline_code" "text",
    CONSTRAINT "decline_rule_overrides_one_target" CHECK ((("decline_rule_id" IS NULL) <> ("decline_code" IS NULL)))
);


--
-- Name: dependency_health; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."dependency_health" (
    "key" "text" NOT NULL,
    "state" "text" DEFAULT 'closed'::"text" NOT NULL,
    "consecutive_failures" integer DEFAULT 0 NOT NULL,
    "opened_at" timestamp with time zone,
    "next_probe_at" timestamp with time zone,
    "last_error" "text",
    "kind" "text" NOT NULL,
    "business_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "dependency_health_state_check" CHECK (("state" = ANY (ARRAY['closed'::"text", 'open'::"text", 'half_open'::"text"])))
);


--
-- Name: differential_prices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."differential_prices" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "addon_product_id" "uuid" NOT NULL,
    "plan_product_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "currency" character(3) NOT NULL,
    "interval" "text",
    "amount_minor" bigint,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "tiers" "jsonb"
);


--
-- Name: disputes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."disputes" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "public_id" "text" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid",
    "customer_id" "uuid",
    "payment_id" "uuid",
    "invoice_id" "uuid",
    "provider_key" "text" NOT NULL,
    "provider_dispute_id" "text" NOT NULL,
    "provider_charge_id" "text",
    "status" "text" DEFAULT 'needs_response'::"text" NOT NULL,
    "reason" "text",
    "amount_minor" bigint NOT NULL,
    "currency" character(3) NOT NULL,
    "funds_withdrawn" "text" DEFAULT 'false'::"text" NOT NULL,
    "evidence_due_by" timestamp with time zone,
    "opened_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "closed_at" timestamp with time zone,
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "source" "text" DEFAULT 'gateway'::"text" NOT NULL,
    "processor_reference" "text",
    CONSTRAINT "disputes_source_ck" CHECK (("source" = ANY (ARRAY['gateway'::"text", 'operator'::"text"])))
);


--
-- Name: due_work; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."due_work" (
    "shard" integer NOT NULL,
    "due_at" timestamp with time zone NOT NULL,
    "kind" "text" NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "business_id" "uuid",
    "organization_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "due_work_kind_check" CHECK (("kind" = ANY (ARRAY['renewal'::"text", 'trial_end'::"text", 'scheduled_change'::"text", 'dunning_retry'::"text"])))
);


--
-- Name: dunning_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."dunning_policies" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "code" "text" NOT NULL,
    "description" "text",
    "config" "jsonb" NOT NULL,
    "archived_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL
);


--
-- Name: email_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."email_messages" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "public_id" "text" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid",
    "customer_id" "uuid",
    "event_id" "uuid",
    "type" "text" NOT NULL,
    "to_address" "text" NOT NULL,
    "subject" "text" NOT NULL,
    "body_html" "text" NOT NULL,
    "body_text" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "last_error" "text",
    "provider_message_id" "text",
    "last_attempt_at" timestamp with time zone,
    "next_attempt_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "sent_at" timestamp with time zone,
    "transport" "text",
    "invoice_id" "uuid",
    "bounce_type" "text",
    "credit_note_id" "uuid",
    "duration_ms" integer,
    "cc_addresses" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "body_removed_at" timestamp with time zone,
    "bcc_addresses" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    CONSTRAINT "email_messages_bounce_type_ck" CHECK ((("bounce_type" IS NULL) OR ("bounce_type" = ANY (ARRAY['permanent'::"text", 'transient'::"text", 'undetermined'::"text", 'complaint'::"text"])))),
    CONSTRAINT "email_messages_one_document_ck" CHECK ((("invoice_id" IS NULL) OR ("credit_note_id" IS NULL))),
    CONSTRAINT "email_messages_transport_ck" CHECK ((("transport" IS NULL) OR ("transport" = ANY (ARRAY['console'::"text", 'smtp'::"text", 'esp'::"text", 'ses'::"text", 'unconfigured'::"text"]))))
);


--
-- Name: COLUMN "email_messages"."invoice_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."email_messages"."invoice_id" IS 'The invoice this message is about, when it is about one. Set at enqueue so delivery can render and attach its PDF (email_config.attachInvoicePdf, default true).';


--
-- Name: COLUMN "email_messages"."duration_ms"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."email_messages"."duration_ms" IS 'Wall-clock ms of the LAST send attempt, INCLUDING any attachment build (an invoice PDF render is our own work but the pass waits on it just the same). NULL = never attempted, or written before 0249.';


--
-- Name: email_suppressions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."email_suppressions" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "address" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "detail" "text",
    "source_email_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "email_suppressions_reason_ck" CHECK (("reason" = ANY (ARRAY['bounce'::"text", 'complaint'::"text", 'manual'::"text"])))
);


--
-- Name: email_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."email_templates" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "public_id" "text" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "subject" "text" NOT NULL,
    "heading" "text" NOT NULL,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "cta_label" "text",
    "show_facts" boolean DEFAULT true NOT NULL,
    "block_order" "text"[],
    "footer" "text",
    CONSTRAINT "email_templates_block_order_ck" CHECK ((("block_order" IS NULL) OR (("cardinality"("block_order") = 4) AND ("block_order" @> ARRAY['body'::"text", 'action'::"text", 'facts'::"text", 'footer'::"text"])))),
    CONSTRAINT "email_templates_not_blank_ck" CHECK ((("length"("btrim"("subject")) > 0) AND ("length"("btrim"("heading")) > 0) AND ("length"("btrim"("body")) > 0)))
);


--
-- Name: TABLE "email_templates"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."email_templates" IS 'Sparse per-business overrides of the built-in billing email templates; absence = use the built-in.';


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."events" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid",
    "public_id" "text" NOT NULL,
    "type" "text" NOT NULL,
    "data" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "source" "text" DEFAULT 'api'::"text" NOT NULL,
    "actor" "text",
    "resource_type" "text",
    "resource_id" "text",
    "api_version" "text" DEFAULT 'v1'::"text" NOT NULL,
    "trace_id" "text"
);


--
-- Name: exchange_rate_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."exchange_rate_history" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "currency" character(3) NOT NULL,
    "base_currency" character(3) NOT NULL,
    "rate" numeric,
    "effective_from" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: features; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."features" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "key" "text" NOT NULL,
    "name" "text" NOT NULL,
    "type" "text" NOT NULL,
    "unit" "text",
    "description" "text",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "meter_id" "uuid"
);


--
-- Name: gateway_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."gateway_accounts" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "gateway_key" "text" NOT NULL,
    "label" "text" NOT NULL,
    "livemode" boolean DEFAULT false NOT NULL,
    "credentials_enc" "text" NOT NULL,
    "currencies" "jsonb",
    "method_types" "jsonb",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    "livemode_mode" "text" GENERATED ALWAYS AS (
CASE
    WHEN "livemode" THEN 'live'::"text"
    ELSE 'test'::"text"
END) STORED,
    "international_enabled" boolean DEFAULT false NOT NULL
);


--
-- Name: gateway_request_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."gateway_request_logs" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "business_id" "uuid",
    "gateway_account_id" "uuid",
    "gateway_key" "text" NOT NULL,
    "method" "text" NOT NULL,
    "url" "text" NOT NULL,
    "status" integer,
    "duration_ms" integer,
    "operation" "text",
    "source" "text",
    "actor" "text",
    "request_headers" "jsonb",
    "request_body" "jsonb",
    "response_headers" "jsonb",
    "response_body" "jsonb",
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "trace_id" "text",
    "span_id" "text"
);


--
-- Name: gateway_settlement_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."gateway_settlement_cursors" (
    "gateway_account_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "polled_until" timestamp with time zone NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL
);


--
-- Name: hubspot_action_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."hubspot_action_executions" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "connection_id" "uuid" NOT NULL,
    "callback_id" "text" NOT NULL,
    "action" "text" NOT NULL,
    "status" "text" NOT NULL,
    "result" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: hubspot_conflicts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."hubspot_conflicts" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "connection_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "local_type" "text" NOT NULL,
    "local_id" "uuid" NOT NULL,
    "local_ref" "text",
    "remote_type" "text" NOT NULL,
    "remote_id" "text" NOT NULL,
    "fields" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "remote_updated_at" timestamp with time zone,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "resolution" "text",
    "resolved_by" "text",
    "resolved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL
);


--
-- Name: hubspot_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."hubspot_connections" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "portal_id" "text" NOT NULL,
    "hub_domain" "text",
    "installed_by" "text",
    "scopes" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "access_token_enc" "text",
    "refresh_token_enc" "text",
    "token_expires_at" timestamp with time zone,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "autosync" boolean DEFAULT true NOT NULL,
    "settings" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "api_base" "text" NOT NULL,
    "initial_sync" "text" DEFAULT 'pending'::"text" NOT NULL,
    "last_sync_at" timestamp with time zone,
    "last_error" "text",
    "connected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "disconnected_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    "contacts_watermark" timestamp with time zone,
    "companies_watermark" timestamp with time zone,
    "deals_watermark" timestamp with time zone
);


--
-- Name: hubspot_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."hubspot_links" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "connection_id" "uuid" NOT NULL,
    "local_type" "text" NOT NULL,
    "local_id" "uuid" NOT NULL,
    "remote_type" "text" NOT NULL,
    "remote_id" "text" NOT NULL,
    "last_pushed_hash" "text",
    "last_pushed_at" timestamp with time zone,
    "last_pulled_at" timestamp with time zone,
    "remote_updated_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    "remote_values" "jsonb"
);


--
-- Name: hubspot_sync_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."hubspot_sync_items" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "run_id" "uuid" NOT NULL,
    "local_type" "text" NOT NULL,
    "local_ref" "text",
    "remote_type" "text",
    "remote_id" "text",
    "action" "text" NOT NULL,
    "message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: hubspot_sync_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."hubspot_sync_queue" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "connection_id" "uuid" NOT NULL,
    "resource_type" "text" NOT NULL,
    "resource_id" "uuid" NOT NULL,
    "reason" "text",
    "attempts" integer DEFAULT 0 NOT NULL,
    "next_attempt_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "locked_at" timestamp with time zone,
    "last_error" "text",
    "enqueued_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: hubspot_sync_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."hubspot_sync_runs" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "connection_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "trigger" "text" NOT NULL,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "created" integer DEFAULT 0 NOT NULL,
    "updated" integer DEFAULT 0 NOT NULL,
    "skipped" integer DEFAULT 0 NOT NULL,
    "failed" integer DEFAULT 0 NOT NULL,
    "error" "text",
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL
);


--
-- Name: idempotency_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."idempotency_keys" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "key" "text" NOT NULL,
    "request_fingerprint" "text" NOT NULL,
    "status" "text" DEFAULT 'in_progress'::"text" NOT NULL,
    "response_status" integer,
    "response_body" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "locked_at" timestamp with time zone
);


--
-- Name: import_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."import_records" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "source" "text" NOT NULL,
    "source_type" "text" NOT NULL,
    "source_id" "text" NOT NULL,
    "target_type" "text" NOT NULL,
    "target_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: imported_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."imported_events" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "source" "text" NOT NULL,
    "source_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "occurred_at" timestamp with time zone NOT NULL,
    "payload" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: ingest_rate_counters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ingest_rate_counters" (
    "organization_id" "uuid" NOT NULL,
    "window_start" timestamp with time zone NOT NULL,
    "count" integer DEFAULT 0 NOT NULL
);


--
-- Name: integration_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."integration_connections" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "provider" "text" NOT NULL,
    "livemode" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "credentials_enc" "text",
    "config" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "api_base" "text" NOT NULL,
    "connected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "disconnected_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    CONSTRAINT "integration_connections_active_credentials_ck" CHECK ((("status" <> 'active'::"text") OR ("credentials_enc" IS NOT NULL))),
    CONSTRAINT "integration_connections_livemode_ck" CHECK (("livemode" = ANY (ARRAY['test'::"text", 'live'::"text"]))),
    CONSTRAINT "integration_connections_status_ck" CHECK (("status" = ANY (ARRAY['active'::"text", 'disconnected'::"text"])))
);


--
-- Name: integration_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."integration_deliveries" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "connection_id" "uuid" NOT NULL,
    "event_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "last_attempt_at" timestamp with time zone,
    "next_attempt_at" timestamp with time zone,
    "last_response_status" integer,
    "duration_ms" integer,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: invoice_line_discounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."invoice_line_discounts" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "invoice_line_item_id" "uuid" NOT NULL,
    "applied_coupon_id" "uuid",
    "label" "text",
    "scope" "text" NOT NULL,
    "amount_minor" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    CONSTRAINT "invoice_line_discounts_amount_minor_check" CHECK (("amount_minor" >= 0)),
    CONSTRAINT "invoice_line_discounts_scope_check" CHECK (("scope" = ANY (ARRAY['item_level'::"text", 'document_level'::"text"])))
);


--
-- Name: invoice_line_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."invoice_line_items" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "description" "text" NOT NULL,
    "price_id" "uuid",
    "quantity" integer DEFAULT 1 NOT NULL,
    "unit_amount_minor" bigint NOT NULL,
    "amount_minor" bigint NOT NULL,
    "kind" "text" NOT NULL,
    "period_start" timestamp with time zone,
    "period_end" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "applied_coupon_id" "uuid",
    "discount_minor" bigint DEFAULT 0 NOT NULL,
    "tax_code" "text",
    "seq" bigint NOT NULL,
    "rating" "jsonb",
    "adjustment" "text",
    "quantity_decimal" numeric(38,12),
    "unit_amount_decimal" numeric(38,12),
    "cost_minor" bigint,
    "cost_basis" "text",
    CONSTRAINT "invoice_line_items_cost_basis_ck" CHECK (((("cost_basis" IS NULL) AND ("cost_minor" IS NULL)) OR ("cost_basis" = ANY (ARRAY['event'::"text", 'price_list'::"text", 'mixed'::"text", 'partial'::"text", 'none'::"text", 'no_rate'::"text"]))))
);


--
-- Name: COLUMN "invoice_line_items"."tax_code"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."invoice_line_items"."tax_code" IS 'SNAPSHOT of the HSN/SAC that classified this line at issue. Never re-derived — an issued invoice must keep saying what it said.';


--
-- Name: invoice_line_items_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."invoice_line_items_seq_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invoice_line_items_seq_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."invoice_line_items_seq_seq" OWNED BY "public"."invoice_line_items"."seq";


--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."invoices" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "subscription_id" "uuid",
    "public_id" "text" NOT NULL,
    "status" "text" DEFAULT 'posted'::"text" NOT NULL,
    "currency" character(3) NOT NULL,
    "subtotal_minor" bigint NOT NULL,
    "total_minor" bigint NOT NULL,
    "period_start" timestamp with time zone,
    "period_end" timestamp with time zone,
    "attempt_count" integer DEFAULT 0 NOT NULL,
    "paid_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "next_attempt_at" timestamp with time zone,
    "amount_due_minor" bigint,
    "due_date" timestamp with time zone,
    "withholding_minor" bigint DEFAULT 0 NOT NULL,
    "number" "text",
    "imported" boolean DEFAULT false NOT NULL,
    "metadata" "jsonb",
    "promotional_credits_applied_minor" bigint DEFAULT 0 NOT NULL,
    "refundable_credits_applied_minor" bigint DEFAULT 0 NOT NULL,
    "excess_payments_applied_minor" bigint DEFAULT 0 NOT NULL,
    "dunning_status" "text",
    "written_off" boolean DEFAULT false NOT NULL,
    "origin_token" "text",
    "voided_at" timestamp with time zone,
    "po_number" "text",
    "expected_payment_date" timestamp with time zone,
    "channel" "text",
    "billing_address" "jsonb",
    "shipping_address" "jsonb",
    "seller_state_code" "text",
    "place_of_supply_code" "text",
    "tax_treatment" "text",
    "tax_note" "text",
    "collecting_at" timestamp with time zone,
    "exchange_rate" numeric(20,10),
    "exchange_rate_base" character(3),
    "dunning_parked_at" timestamp with time zone,
    "dunning_exhausted_at" timestamp with time zone,
    "dunning_next_reminder_at" timestamp with time zone,
    "void_reason_code" "text",
    "dunning_pause" "jsonb",
    "customer_tax_id" "text",
    "seller_tax_id" "text",
    "seller_tax_country" character(2),
    "price_type" "text",
    "notes" "text",
    "net_term_days" integer,
    "finalized_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    "seller_name" "text",
    "seller_address" "jsonb",
    "awaiting_number" boolean DEFAULT false NOT NULL,
    "collect_due_at" timestamp with time zone,
    "opens_period" boolean DEFAULT false NOT NULL,
    "dunning_held_ms" bigint DEFAULT 0 NOT NULL,
    "grant_credits_pre_tax_minor" bigint DEFAULT 0 NOT NULL,
    "grant_credits_post_tax_minor" bigint DEFAULT 0 NOT NULL,
    "purpose" "text",
    "dunning_exhausted_code" "text",
    "retry_hold_until" timestamp with time zone,
    "collect_trace_id" "text",
    CONSTRAINT "invoices_dunning_status_ck" CHECK ((("dunning_status" IS NULL) OR ("dunning_status" = ANY (ARRAY['in_progress'::"text", 'parked'::"text", 'succeeded'::"text", 'exhausted'::"text", 'stopped'::"text"])))),
    CONSTRAINT "invoices_exchange_rate_valid" CHECK (((("exchange_rate" IS NULL) AND ("exchange_rate_base" IS NULL)) OR (("exchange_rate" > (0)::numeric) AND ("exchange_rate_base" IS NOT NULL)))),
    CONSTRAINT "invoices_grant_credits_nonneg" CHECK ((("grant_credits_pre_tax_minor" >= 0) AND ("grant_credits_post_tax_minor" >= 0))),
    CONSTRAINT "invoices_purpose_ck" CHECK ((("purpose" IS NULL) OR ("purpose" = ANY (ARRAY['usage_interim'::"text", 'credit_purchase'::"text"])))),
    CONSTRAINT "invoices_status_ck" CHECK (("status" = ANY (ARRAY['pending'::"text", 'posted'::"text", 'payment_due'::"text", 'not_paid'::"text", 'paid'::"text", 'voided'::"text"])))
);


--
-- Name: COLUMN "invoices"."collecting_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."invoices"."collecting_at" IS 'Set while a collection attempt is in flight; claimed by conditional UPDATE so exactly one collector proceeds. Cleared in a finally. A value older than the stale window (see COLLECTION_CLAIM_STALE_MS) is treated as abandoned and may be re-claimed — a crashed worker must not strand an invoice uncollectable.';


--
-- Name: COLUMN "invoices"."exchange_rate"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."invoices"."exchange_rate" IS 'Units of this invoice''s currency per 1 unit of exchange_rate_base, snapshotted at finalize. NULL = not recorded. Reporting/audit only — never rates or settles a charge.';


--
-- Name: job_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."job_runs" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "job" "text" NOT NULL,
    "started_at" timestamp with time zone NOT NULL,
    "finished_at" timestamp with time zone,
    "ok" boolean,
    "error" "text"
);


--
-- Name: ledger_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ledger_entries" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "transaction_id" "uuid" NOT NULL,
    "account" "text" NOT NULL,
    "direction" "text" NOT NULL,
    "amount_minor" bigint NOT NULL,
    "currency" character(3) NOT NULL,
    "source_type" "text" NOT NULL,
    "source_id" "text" NOT NULL,
    "memo" "text",
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "customer_id" "uuid"
);


--
-- Name: list_views; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."list_views" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid",
    "public_id" "text" NOT NULL,
    "entity" "text" NOT NULL,
    "name" "text" NOT NULL,
    "owner" "text" NOT NULL,
    "visibility" "text" DEFAULT 'private'::"text" NOT NULL,
    "filters" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "search" "text",
    "sort_field" "text",
    "sort_desc" boolean,
    "hidden_columns" "jsonb",
    "is_default" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    CONSTRAINT "list_views_filters_is_array_check" CHECK (("jsonb_typeof"("filters") = 'array'::"text")),
    CONSTRAINT "list_views_not_empty_check" CHECK ((("jsonb_array_length"("filters") > 0) OR ("search" IS NOT NULL) OR ("sort_field" IS NOT NULL) OR ("hidden_columns" IS NOT NULL))),
    CONSTRAINT "list_views_visibility_check" CHECK (("visibility" = ANY (ARRAY['private'::"text", 'everyone'::"text"])))
);


--
-- Name: login_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."login_attempts" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "outcome" "text" NOT NULL,
    "user_id" "uuid",
    "email_hash" "text" NOT NULL,
    "ip" "inet",
    "user_agent" "text",
    CONSTRAINT "login_attempts_outcome_check" CHECK (("outcome" = ANY (ARRAY['success'::"text", 'bad_password'::"text", 'unknown_user'::"text", 'locked'::"text", 'unverified'::"text", 'mfa_failed'::"text"])))
);


--
-- Name: memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."memberships" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "custom_role_id" "uuid",
    "accepted_at" timestamp with time zone DEFAULT "now"(),
    "invite_id" "text",
    "invite_name" "text",
    CONSTRAINT "memberships_custom_role_ck" CHECK ((("role" = 'custom'::"text") = ("custom_role_id" IS NOT NULL))),
    CONSTRAINT "memberships_role_ck" CHECK (("role" = ANY (ARRAY['owner'::"text", 'admin'::"text", 'manager'::"text", 'ops'::"text", 'developer'::"text", 'custom'::"text"])))
);


--
-- Name: metadata_key_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."metadata_key_rules" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "public_id" "text" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "entity_type" "text" NOT NULL,
    "key" "text" NOT NULL,
    "data_type" "text" NOT NULL,
    "enum_options" "jsonb",
    "pattern" "text",
    "max_length" integer,
    "description" "text",
    "archived" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    "integer_only" boolean DEFAULT false NOT NULL,
    "min_value" double precision,
    "max_value" double precision,
    "item_type" "text",
    "item_enum_options" "jsonb",
    "min_items" integer,
    "max_items" integer,
    CONSTRAINT "metadata_key_rules_bounds_ck" CHECK (((("min_value" IS NULL) OR ("max_value" IS NULL) OR ("min_value" <= "max_value")) AND (("item_type" IS NULL) OR ("item_type" = ANY (ARRAY['string'::"text", 'number'::"text", 'boolean'::"text"]))) AND (("min_items" IS NULL) OR ("min_items" >= 0)) AND (("max_items" IS NULL) OR ("max_items" >= 0)) AND (("min_items" IS NULL) OR ("max_items" IS NULL) OR ("min_items" <= "max_items")) AND (((NOT "integer_only") AND ("min_value" IS NULL) AND ("max_value" IS NULL)) OR ("data_type" = 'number'::"text")) AND ((("item_type" IS NULL) AND ("item_enum_options" IS NULL) AND ("min_items" IS NULL) AND ("max_items" IS NULL)) OR ("data_type" = 'array'::"text")))),
    CONSTRAINT "metadata_key_rules_data_type_check" CHECK (("data_type" = ANY (ARRAY['string'::"text", 'number'::"text", 'boolean'::"text", 'date'::"text", 'email'::"text", 'enum'::"text", 'object'::"text", 'array'::"text"]))),
    CONSTRAINT "metadata_key_rules_entity_type_check" CHECK (("entity_type" = ANY (ARRAY['customer'::"text", 'subscription'::"text"]))),
    CONSTRAINT "metadata_key_rules_max_length_check" CHECK ((("max_length" IS NULL) OR ("max_length" > 0)))
);


--
-- Name: meters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."meters" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "key" "text" NOT NULL,
    "name" "text" NOT NULL,
    "event_name" "text" NOT NULL,
    "aggregation" "text" NOT NULL,
    "value_property" "text",
    "unique_property" "text",
    "recurring" boolean DEFAULT false NOT NULL,
    "time_unit" "text",
    "filters" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "group_by" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "folded_from" timestamp with time zone,
    "backfilled_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    "price_list" "jsonb",
    "cost_currency" character(3),
    "limit_dimensions" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    CONSTRAINT "meters_aggregation_check" CHECK (("aggregation" = ANY (ARRAY['sum'::"text", 'count'::"text", 'min'::"text", 'max'::"text", 'avg'::"text", 'last'::"text", 'unique'::"text", 'weighted_sum'::"text"]))),
    CONSTRAINT "meters_filters_check" CHECK (("jsonb_typeof"("filters") = 'object'::"text")),
    CONSTRAINT "meters_group_by_check" CHECK (("cardinality"("group_by") <= 5)),
    CONSTRAINT "meters_limit_dimensions_ck" CHECK (("cardinality"("limit_dimensions") <= 3)),
    CONSTRAINT "meters_price_list_ck" CHECK ((("price_list" IS NULL) OR ("jsonb_typeof"("price_list") = 'object'::"text"))),
    CONSTRAINT "meters_recurring_ck" CHECK (((NOT "recurring") OR ("aggregation" = ANY (ARRAY['sum'::"text", 'last'::"text", 'max'::"text", 'unique'::"text"])))),
    CONSTRAINT "meters_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'archived'::"text"]))),
    CONSTRAINT "meters_time_unit_check" CHECK ((("time_unit" IS NULL) OR ("time_unit" = ANY (ARRAY['hour'::"text", 'day'::"text"])))),
    CONSTRAINT "meters_time_unit_ck" CHECK ((("aggregation" = 'weighted_sum'::"text") = ("time_unit" IS NOT NULL))),
    CONSTRAINT "meters_unique_property_ck" CHECK ((("aggregation" = 'unique'::"text") = ("unique_property" IS NOT NULL))),
    CONSTRAINT "meters_value_property_ck" CHECK ((("aggregation" = ANY (ARRAY['count'::"text", 'unique'::"text"])) OR ("value_property" IS NOT NULL)))
);


--
-- Name: metric_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."metric_daily" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "grain" "text" DEFAULT 'day'::"text" NOT NULL,
    "period_end" "date" NOT NULL,
    "measure" "text" NOT NULL,
    "dim" "text" DEFAULT ''::"text" NOT NULL,
    "dim_value" "text" DEFAULT ''::"text" NOT NULL,
    "currency" character(3) NOT NULL,
    "value" bigint,
    "denominator" bigint,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: metric_windows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."metric_windows" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "window_name" "text" NOT NULL,
    "period_start" "date" NOT NULL,
    "period_end" "date" NOT NULL,
    "measure" "text" NOT NULL,
    "dim" "text" DEFAULT ''::"text" NOT NULL,
    "dim_value" "text" DEFAULT ''::"text" NOT NULL,
    "currency" character(3) NOT NULL,
    "value" bigint,
    "denominator" bigint,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: mfa_reset_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."mfa_reset_requests" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "proof" "text" NOT NULL,
    "requested_by" "text" NOT NULL,
    "cancel_token_hash" "text" NOT NULL,
    "requested_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "effective_at" timestamp with time zone NOT NULL,
    "cancelled_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    CONSTRAINT "mfa_reset_requests_one_outcome_ck" CHECK ((("cancelled_at" IS NULL) OR ("completed_at" IS NULL)))
);


--
-- Name: model_cost_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."model_cost_overrides" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "provider" "text",
    "model" "text" NOT NULL,
    "token_type" "text" NOT NULL,
    "currency" character(3) NOT NULL,
    "unit_amount_decimal" numeric(38,12) NOT NULL,
    "quantity_divisor" bigint DEFAULT 1 NOT NULL,
    "effective_from" timestamp with time zone NOT NULL,
    "effective_to" timestamp with time zone,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    CONSTRAINT "model_cost_overrides_model_check" CHECK ((("char_length"("model") >= 1) AND ("char_length"("model") <= 200))),
    CONSTRAINT "model_cost_overrides_note_check" CHECK ((("note" IS NULL) OR ("char_length"("note") <= 500))),
    CONSTRAINT "model_cost_overrides_provider_check" CHECK ((("provider" IS NULL) OR (("char_length"("provider") >= 1) AND ("char_length"("provider") <= 100)))),
    CONSTRAINT "model_cost_overrides_quantity_divisor_check" CHECK (("quantity_divisor" > 0)),
    CONSTRAINT "model_cost_overrides_token_type_check" CHECK ((("char_length"("token_type") >= 1) AND ("char_length"("token_type") <= 100))),
    CONSTRAINT "model_cost_overrides_unit_amount_decimal_check" CHECK (("unit_amount_decimal" >= (0)::numeric)),
    CONSTRAINT "model_cost_overrides_window_ck" CHECK ((("effective_to" IS NULL) OR ("effective_to" > "effective_from")))
);


--
-- Name: model_price_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."model_price_models" (
    "provider" "text" NOT NULL,
    "model" "text" NOT NULL,
    "name" "text",
    "aliases" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "context_tiers" "jsonb",
    "first_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "model_price_models_model_check" CHECK ((("char_length"("model") >= 1) AND ("char_length"("model") <= 200))),
    CONSTRAINT "model_price_models_provider_check" CHECK ((("char_length"("provider") >= 1) AND ("char_length"("provider") <= 100)))
);


--
-- Name: model_price_notices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."model_price_notices" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "sync_run_id" "uuid" NOT NULL,
    "changes" "jsonb" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "next_attempt_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sent_at" timestamp with time zone,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    CONSTRAINT "model_price_notices_attempts_check" CHECK (("attempts" >= 0)),
    CONSTRAINT "model_price_notices_changes_check" CHECK (("jsonb_typeof"("changes") = 'array'::"text")),
    CONSTRAINT "model_price_notices_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'failed'::"text", 'skipped'::"text"])))
);


--
-- Name: model_prices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."model_prices" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "public_id" "text" NOT NULL,
    "provider" "text" NOT NULL,
    "model" "text" NOT NULL,
    "token_type" "text" NOT NULL,
    "currency" character(3) NOT NULL,
    "unit_amount_decimal" numeric(38,12) NOT NULL,
    "quantity_divisor" bigint NOT NULL,
    "effective_from" timestamp with time zone NOT NULL,
    "source" "text" NOT NULL,
    "source_version" "text",
    "source_effective_from" "date",
    "source_checked_on" "date",
    "rounded" boolean DEFAULT false NOT NULL,
    "sync_run_id" "uuid" NOT NULL,
    "released_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "model_prices_quantity_divisor_check" CHECK (("quantity_divisor" > 0)),
    CONSTRAINT "model_prices_token_type_check" CHECK ((("char_length"("token_type") >= 1) AND ("char_length"("token_type") <= 100))),
    CONSTRAINT "model_prices_unit_amount_decimal_check" CHECK (("unit_amount_decimal" >= (0)::numeric))
);


--
-- Name: mrr_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."mrr_movements" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "subscription_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "reason" "text" NOT NULL,
    "currency" character(3) NOT NULL,
    "previous_mrr_minor" bigint NOT NULL,
    "new_mrr_minor" bigint NOT NULL,
    "delta_minor" bigint NOT NULL,
    "occurred_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "plan_product_id" "uuid",
    "previous_plan_product_id" "uuid",
    "exchange_rate" numeric(20,10),
    "exchange_rate_base" character(3),
    CONSTRAINT "mrr_movements_exchange_rate_valid" CHECK (((("exchange_rate" IS NULL) AND ("exchange_rate_base" IS NULL)) OR (("exchange_rate" > (0)::numeric) AND ("exchange_rate_base" IS NOT NULL))))
);


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."subscriptions" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "status" "text" NOT NULL,
    "currency" character(3) NOT NULL,
    "current_period_start" timestamp with time zone,
    "current_period_end" timestamp with time zone,
    "trial_end" timestamp with time zone,
    "default_payment_method_id" "uuid",
    "cancel_at_period_end" boolean DEFAULT false NOT NULL,
    "canceled_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "start_date" timestamp with time zone,
    "started_at" timestamp with time zone,
    "activated_at" timestamp with time zone,
    "trial_start" timestamp with time zone,
    "billing_period" integer,
    "billing_period_unit" "text",
    "remaining_billing_cycles" integer,
    "auto_collection" "text",
    "net_term_days" integer,
    "po_number" "text",
    "invoice_notes" "text",
    "cancel_reason" "text",
    "mrr" bigint,
    "metadata" "jsonb",
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    "billing_anchor_day" integer,
    "create_pending_invoices" boolean,
    "cancel_reason_code" "text",
    "custom_fields" "jsonb",
    "cancel_scheduled_at" timestamp with time zone,
    "max_refundable_credits_usage_minor" bigint,
    "max_excess_payment_usage_minor" bigint,
    "deleted_at" timestamp with time zone,
    "deleted_by" "text",
    "last_earning_mrr" bigint,
    "cancel_booked_at" timestamp with time zone,
    "shipping_address_id" "uuid",
    "bill_usage_monthly" boolean DEFAULT false NOT NULL,
    "current_sub_period_start" timestamp with time zone,
    "current_sub_period_end" timestamp with time zone,
    "commitment_amount_minor" bigint,
    "commitment_segments" "jsonb",
    "pause_source" "text",
    "reset_state" "jsonb",
    CONSTRAINT "subscriptions_max_excess_payment_usage_ck" CHECK ((("max_excess_payment_usage_minor" IS NULL) OR ("max_excess_payment_usage_minor" >= 0))),
    CONSTRAINT "subscriptions_max_refundable_credits_usage_ck" CHECK ((("max_refundable_credits_usage_minor" IS NULL) OR ("max_refundable_credits_usage_minor" >= 0)))
);


--
-- Name: COLUMN "subscriptions"."cancel_scheduled_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."subscriptions"."cancel_scheduled_at" IS 'When a specific_date cancel is pending, the instant it fires. Derives non_renewing + canceled_at, mirroring cancel_at_period_end for end_of_term. Cleared on remove_scheduled_cancellation / reactivate / when the scheduled change is deleted; consumed when the cancel applies.';


--
-- Name: COLUMN "subscriptions"."last_earning_mrr"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."subscriptions"."last_earning_mrr" IS 'Netted MRR this subscription last carried while in an earning status. History only — never current revenue. NULL = never recorded.';


--
-- Name: mrr_movement_summary_mv; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW "public"."mrr_movement_summary_mv" AS
 WITH "cut" AS (
         SELECT ("now"() - '01:00:00'::interval) AS "cutoff"
        ), "netted" AS (
         SELECT "m_1"."organization_id",
            "m_1"."business_id",
            "m_1"."subscription_id",
            "m_1"."currency",
            "m_1"."occurred_at",
            "m_1"."reason",
            "m_1"."plan_product_id",
            "m_1"."previous_plan_product_id",
            ("sum"("m_1"."delta_minor"))::bigint AS "delta_minor"
           FROM "public"."mrr_movements" "m_1"
          WHERE ("m_1"."created_at" < ( SELECT "cut_1"."cutoff"
                   FROM "cut" "cut_1"))
          GROUP BY "m_1"."organization_id", "m_1"."business_id", "m_1"."subscription_id", "m_1"."currency", "m_1"."occurred_at", "m_1"."reason", "m_1"."plan_product_id", "m_1"."previous_plan_product_id"
         HAVING ("sum"("m_1"."delta_minor") <> (0)::numeric)
        )
 SELECT "m"."organization_id",
    "m"."business_id",
    ("date_trunc"('month'::"text", ("m"."occurred_at" AT TIME ZONE 'UTC'::"text")))::"date" AS "period_month",
    "m"."currency",
        CASE "m"."reason"
            WHEN 'new'::"text" THEN
            CASE
                WHEN ("t"."id" IS NOT NULL) THEN 'free_to_paid'::"text"
                ELSE 'new'::"text"
            END
            WHEN 'expansion'::"text" THEN
            CASE
                WHEN (("m"."previous_plan_product_id" IS NOT NULL) AND ("m"."previous_plan_product_id" IS DISTINCT FROM "m"."plan_product_id")) THEN 'upgrade'::"text"
                ELSE 'expansion'::"text"
            END
            WHEN 'contraction'::"text" THEN
            CASE
                WHEN (("m"."previous_plan_product_id" IS NOT NULL) AND ("m"."previous_plan_product_id" IS DISTINCT FROM "m"."plan_product_id")) THEN 'downgrade'::"text"
                ELSE 'contraction'::"text"
            END
            WHEN 'reactivation'::"text" THEN 'reactivation'::"text"
            WHEN 'resume'::"text" THEN 'resumed'::"text"
            WHEN 'pause'::"text" THEN 'paused'::"text"
            ELSE 'churn'::"text"
        END AS "column_key",
    "m"."delta_minor",
    "count"(*) AS "movements",
    "cut"."cutoff"
   FROM (("netted" "m"
     CROSS JOIN "cut")
     LEFT JOIN "public"."subscriptions" "t" ON ((("t"."id" = "m"."subscription_id") AND ("t"."trial_start" IS NOT NULL) AND ("t"."deleted_at" IS NULL))))
  GROUP BY "m"."organization_id", "m"."business_id", (("date_trunc"('month'::"text", ("m"."occurred_at" AT TIME ZONE 'UTC'::"text")))::"date"), "m"."currency",
        CASE "m"."reason"
            WHEN 'new'::"text" THEN
            CASE
                WHEN ("t"."id" IS NOT NULL) THEN 'free_to_paid'::"text"
                ELSE 'new'::"text"
            END
            WHEN 'expansion'::"text" THEN
            CASE
                WHEN (("m"."previous_plan_product_id" IS NOT NULL) AND ("m"."previous_plan_product_id" IS DISTINCT FROM "m"."plan_product_id")) THEN 'upgrade'::"text"
                ELSE 'expansion'::"text"
            END
            WHEN 'contraction'::"text" THEN
            CASE
                WHEN (("m"."previous_plan_product_id" IS NOT NULL) AND ("m"."previous_plan_product_id" IS DISTINCT FROM "m"."plan_product_id")) THEN 'downgrade'::"text"
                ELSE 'contraction'::"text"
            END
            WHEN 'reactivation'::"text" THEN 'reactivation'::"text"
            WHEN 'resume'::"text" THEN 'resumed'::"text"
            WHEN 'pause'::"text" THEN 'paused'::"text"
            ELSE 'churn'::"text"
        END, "m"."delta_minor", "cut"."cutoff"
  WITH NO DATA;


--
-- Name: mrr_movement_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW "public"."mrr_movement_summary" AS
 SELECT "organization_id",
    "business_id",
    "period_month",
    "currency",
    "column_key",
    "delta_minor",
    "movements",
    "cutoff"
   FROM "public"."mrr_movement_summary_mv"
  WHERE ("organization_id" = (NULLIF("current_setting"('app.org_id'::"text", true), ''::"text"))::"uuid");


--
-- Name: ops_http_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ops_http_stats" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "bucket_started_at" timestamp with time zone NOT NULL,
    "process" "text" NOT NULL,
    "method" "text" NOT NULL,
    "route" "text" NOT NULL,
    "status_class" integer NOT NULL,
    "requests" integer DEFAULT 0 NOT NULL,
    "duration_ms_total" bigint DEFAULT 0 NOT NULL,
    "duration_ms_max" integer DEFAULT 0 NOT NULL,
    "buckets" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: COLUMN "ops_http_stats"."route"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."ops_http_stats"."route" IS 'Route PATTERN (/v1/businesses/:biz/subscriptions), never the raw path — bounded cardinality.';


--
-- Name: COLUMN "ops_http_stats"."buckets"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."ops_http_stats"."buckets" IS 'Cumulative-count latency histogram by upper-bound ms; percentiles stay recoverable after SUM.';


--
-- Name: ops_invariant_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."ops_invariant_results" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "check_key" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "violations" bigint,
    "sample" "jsonb",
    "sample_truncated" boolean DEFAULT false NOT NULL,
    "duration_ms" integer,
    "error" "text",
    "trace_id" "text",
    "ran_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: COLUMN "ops_invariant_results"."severity"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."ops_invariant_results"."severity" IS 'critical | warn — snapshotted at run time so re-grading a check does not rewrite history.';


--
-- Name: COLUMN "ops_invariant_results"."violations"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."ops_invariant_results"."violations" IS 'Number of violating rows. NULL = the check produced no answer (see error); NULL is NOT zero.';


--
-- Name: org_mfa_reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."org_mfa_reminders" (
    "organization_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "deadline" timestamp with time zone NOT NULL,
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: organization_retention; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."organization_retention" (
    "organization_id" "uuid" NOT NULL,
    "mode" "text",
    "events_days" integer,
    "webhook_deliveries_days" integer,
    "gateway_logs_days" integer,
    "email_body_days" integer,
    "idempotency_hours" integer,
    "updated_at" timestamp with time zone,
    "updated_by" "text",
    "last_run_at" timestamp with time zone,
    "last_run_mode" "text",
    "last_run" "jsonb",
    "api_log_writes_days" integer,
    "api_log_reads_days" integer,
    CONSTRAINT "organization_retention_api_log_reads_days_check" CHECK (("api_log_reads_days" >= 0)),
    CONSTRAINT "organization_retention_api_log_writes_days_check" CHECK (("api_log_writes_days" >= 0)),
    CONSTRAINT "organization_retention_email_body_days_check" CHECK (("email_body_days" >= 0)),
    CONSTRAINT "organization_retention_events_days_check" CHECK ((("events_days" = 0) OR ("events_days" >= 31))),
    CONSTRAINT "organization_retention_gateway_logs_days_check" CHECK (("gateway_logs_days" >= 0)),
    CONSTRAINT "organization_retention_idempotency_hours_check" CHECK (("idempotency_hours" >= 0)),
    CONSTRAINT "organization_retention_mode_check" CHECK (("mode" = ANY (ARRAY['off'::"text", 'dry_run'::"text", 'on'::"text"]))),
    CONSTRAINT "organization_retention_webhook_deliveries_days_check" CHECK (("webhook_deliveries_days" >= 0))
);


--
-- Name: organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."organizations" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "public_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "rate_limit_per_minute" integer,
    "is_platform" boolean DEFAULT false NOT NULL,
    "timezone" "text",
    "legal_name" "text",
    "address" "jsonb",
    "tax_registration_number" "text",
    "base_currency" character(3),
    "exchange_rates" "jsonb",
    "exchange_rate_sources" "jsonb",
    "icon_url" "text",
    "require_mfa" boolean DEFAULT false NOT NULL,
    "mfa_required_since" timestamp with time zone,
    "mfa_required_by" "uuid",
    "mfa_grace_days" integer DEFAULT 7 NOT NULL,
    "live_access" "text" DEFAULT 'enabled'::"text" NOT NULL,
    "live_access_enabled_at" timestamp with time zone,
    "live_access_enabled_by" "text",
    "country" character(2),
    "signup_answers" "jsonb",
    "restricted_reason" "text",
    "over_limit_since" timestamp with time zone,
    "ingest_rate_limit_per_second" integer,
    "session_idle_minutes" integer,
    "session_absolute_ttl_hours" integer,
    "mfa_required_roles" "text"[],
    CONSTRAINT "organizations_ingest_rate_limit_per_second_ck" CHECK ((("ingest_rate_limit_per_second" IS NULL) OR ("ingest_rate_limit_per_second" >= 0))),
    CONSTRAINT "organizations_live_access_ck" CHECK (("live_access" = ANY (ARRAY['locked'::"text", 'enabled'::"text"]))),
    CONSTRAINT "organizations_mfa_grace_days_ck" CHECK ((("mfa_grace_days" >= 0) AND ("mfa_grace_days" <= 90))),
    CONSTRAINT "organizations_rate_limit_per_minute_ck" CHECK ((("rate_limit_per_minute" IS NULL) OR ("rate_limit_per_minute" >= 0))),
    CONSTRAINT "organizations_require_mfa_since_ck" CHECK (((NOT "require_mfa") OR ("mfa_required_since" IS NOT NULL))),
    CONSTRAINT "organizations_restricted_reason_ck" CHECK ((("restricted_reason" IS NULL) OR ("restricted_reason" = ANY (ARRAY['unpaid'::"text", 'over_limit'::"text"])))),
    CONSTRAINT "organizations_session_policy_valid" CHECK (((("session_idle_minutes" IS NULL) OR ("session_idle_minutes" >= 1)) AND (("session_absolute_ttl_hours" IS NULL) OR ("session_absolute_ttl_hours" >= 1))))
);


--
-- Name: payment_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."payment_attempts" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "payment_intent_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "attempt_number" integer NOT NULL,
    "status" "text" DEFAULT 'inited'::"text" NOT NULL,
    "payment_method_id" "uuid",
    "id_at_gateway" "text",
    "error_code" "text",
    "error_text" "text",
    "trace_id" "text",
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    "method_used" "text",
    "span_id" "text",
    CONSTRAINT "payment_attempts_attempt_number_check" CHECK (("attempt_number" >= 1))
);


--
-- Name: COLUMN "payment_attempts"."trace_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."payment_attempts"."trace_id" IS 'Correlation key into gateway_request_logs. Deliberately NOT a foreign key: gateway_request_logs is platform-global with no RLS, so an FK from this tenant table would cross the isolation boundary. Correlate by trace id only.';


--
-- Name: payment_instructions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."payment_instructions" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "public_id" "text" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "section_title" "text" NOT NULL,
    "section_id" "text",
    "description" "text",
    "fields" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "currencies" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "countries" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "archived" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL
);


--
-- Name: payment_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."payment_intents" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "public_id" "text" NOT NULL,
    "status" "text" DEFAULT 'inited'::"text" NOT NULL,
    "amount_minor" bigint,
    "currency" character(3),
    "gateway_account_id" "uuid",
    "payment_method_id" "uuid",
    "intent_at_gateway" "text",
    "next_action" "jsonb",
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    "purpose" "text" DEFAULT 'payment'::"text" NOT NULL,
    "attempt_count" integer DEFAULT 0 NOT NULL,
    "voided_at" timestamp with time zone,
    "invoice_id" "uuid",
    "subscription_id" "uuid",
    "max_amount_minor" bigint,
    "authorized_at" timestamp with time zone,
    "last_attempt_status" "text",
    "first_charge_minor" bigint,
    "first_charge_claim" "text"
);


--
-- Name: COLUMN "payment_intents"."amount_minor"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."payment_intents"."amount_minor" IS 'Minor units. ZERO IS LEGAL and expected when purpose = ''setup'' (a vault-only SetupIntent moves no money). No CHECK constraint has ever existed on this column.';


--
-- Name: COLUMN "payment_intents"."purpose"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."payment_intents"."purpose" IS 'payment = collect an amount; setup = authorise and vault a payment method at amount 0.';


--
-- Name: COLUMN "payment_intents"."max_amount_minor"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."payment_intents"."max_amount_minor" IS 'Ceiling for any single future debit under a mandate registered by this intent, in minor units of `currency`. Set for purpose = ''setup'' only; always NULL for ''payment'', which registers no mandate. Adapters on non-mandate rails ignore it. Persisted so retryPaymentIntent re-registers the mandate with the SAME ceiling instead of the adapter default.';


--
-- Name: payment_link_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."payment_link_items" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "payment_link_id" "uuid" NOT NULL,
    "price_id" "uuid" NOT NULL,
    "quantity" integer DEFAULT 1 NOT NULL,
    "min_quantity" integer,
    "max_quantity" integer,
    "optional" boolean DEFAULT false NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "payment_link_items_check" CHECK ((("min_quantity" IS NULL) OR ("max_quantity" IS NULL) OR ("min_quantity" <= "max_quantity"))),
    CONSTRAINT "payment_link_items_max_quantity_check" CHECK ((("max_quantity" IS NULL) OR ("max_quantity" >= 1))),
    CONSTRAINT "payment_link_items_min_quantity_check" CHECK ((("min_quantity" IS NULL) OR ("min_quantity" >= 0))),
    CONSTRAINT "payment_link_items_quantity_check" CHECK (("quantity" >= 0))
);


--
-- Name: payment_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."payment_links" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "public_id" "text" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "show_on_pricing_page" boolean DEFAULT false NOT NULL,
    "redirect_url" "text",
    "cancel_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL
);


--
-- Name: payment_method_authorizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."payment_method_authorizations" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "payment_method_id" "uuid" NOT NULL,
    "payment_method_public_id" "text" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "gateway_key" "text" NOT NULL,
    "method_type" "text" NOT NULL,
    "text_version" "text" NOT NULL,
    "text" "text" NOT NULL,
    "accepted_at" timestamp with time zone NOT NULL,
    "ip_address" "inet",
    "user_agent" "text",
    "payer_name" "text",
    "payer_email" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: payment_methods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."payment_methods" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "provider_key" "text" NOT NULL,
    "provider_customer_id" "text" NOT NULL,
    "provider_payment_method_id" "text" NOT NULL,
    "type" "text" NOT NULL,
    "brand" "text",
    "last4" "text",
    "exp_month" integer,
    "exp_year" integer,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "metadata" "jsonb",
    "gateway_account_id" "uuid",
    "status" "text" DEFAULT 'valid'::"text" NOT NULL,
    "role" "text" DEFAULT 'backup'::"text" NOT NULL,
    "mandate_max_amount_minor" bigint,
    "mandate_currency" "text",
    "mandate_rail" "text",
    "mandate_status" "text",
    "mandate_expires_at" timestamp with time zone,
    "mandate_reference" "text",
    "avs_line1_check" "text",
    "avs_postal_check" "text",
    "cvc_check" "text",
    "avs_checked_at" timestamp with time zone,
    "issuer_country" "text",
    "instrument_funding" "text",
    "issuer_name" "text",
    "instrument_fingerprint" "text",
    "instrument_sub_type" "text",
    "supports_recurring" boolean,
    "supports_international" boolean,
    "three_d_secure_supported" boolean,
    "credentials_changed_at" timestamp with time zone,
    "mandate_status_at" timestamp with time zone,
    "authorized_at" timestamp with time zone,
    "collect_open_invoices" boolean
);


--
-- Name: COLUMN "payment_methods"."mandate_max_amount_minor"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."payment_methods"."mandate_max_amount_minor" IS 'Ceiling for any single debit under this instrument''s mandate, in minor units of `mandate_currency`, as the PROVIDER registered it (not as we requested it — see payment_intents.max_amount_minor for that). NULL means unknown or no mandate rail, never unlimited: the charge-time pre-flight skips the check rather than assuming headroom.';


--
-- Name: COLUMN "payment_methods"."mandate_currency"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."payment_methods"."mandate_currency" IS 'ISO 4217 currency the mandate ceiling is denominated in. Always INR for RazorPay: UPI Autopay and netbanking are NPCI domestic rails, and a foreign-currency card mandate is refused at the order.';


--
-- Name: COLUMN "payment_methods"."mandate_rail"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."payment_methods"."mandate_rail" IS 'The provider-native rail the mandate rides, in the PROVIDER''s vocabulary (razorpay: upi | card | emandate | nach). Deliberately not mapped onto `type`, which collapses emandate/nach into bank_transfer for routing — settlement lag and authentication rules are properties of the rail.';


--
-- Name: COLUMN "payment_methods"."mandate_status"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."payment_methods"."mandate_status" IS 'Provider-reported mandate state (razorpay recurring_details.status: initiated | confirmed | rejected | cancelled | paused). Only `confirmed` can be debited off-session.';


--
-- Name: COLUMN "payment_methods"."mandate_expires_at"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."payment_methods"."mandate_expires_at" IS 'When the mandate lapses and must be re-registered. NULL = unknown or no expiry reported.';


--
-- Name: COLUMN "payment_methods"."mandate_reference"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."payment_methods"."mandate_reference" IS 'The provider''s own mandate/token reference, for support tickets and reconciliation against the gateway dashboard.';


--
-- Name: payment_request_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."payment_request_invoices" (
    "request_id" "uuid" NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "position" integer NOT NULL,
    "created_outstanding_minor" bigint NOT NULL,
    "state" "text" DEFAULT 'open'::"text" NOT NULL,
    CONSTRAINT "payment_request_invoices_state_check" CHECK (("state" = ANY (ARRAY['open'::"text", 'paid'::"text", 'settled_elsewhere'::"text", 'removed'::"text"])))
);


--
-- Name: payment_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."payment_requests" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "mode" "text" NOT NULL,
    "currency" character(3) NOT NULL,
    "created_amount_minor" bigint NOT NULL,
    "payment_method_id" "uuid",
    "email" "text",
    "provider_key" "text",
    "provider_charge_id" "text",
    "gateway_account_id" "uuid",
    "attempt_count" integer DEFAULT 0 NOT NULL,
    "last_payment_error" "jsonb",
    "cancel_reason" "text",
    "expires_at" timestamp with time zone NOT NULL,
    "paid_at" timestamp with time zone,
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    "origin" "text" DEFAULT 'manual'::"text" NOT NULL,
    CONSTRAINT "payment_requests_mode_check" CHECK (("mode" = ANY (ARRAY['charge'::"text", 'link'::"text"]))),
    CONSTRAINT "payment_requests_origin_ck" CHECK (("origin" = ANY (ARRAY['manual'::"text", 'dunning'::"text", 'portal'::"text"]))),
    CONSTRAINT "payment_requests_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'processing'::"text", 'paid'::"text", 'canceled'::"text", 'expired'::"text"])))
);


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."payments" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "invoice_id" "uuid",
    "payment_method_id" "uuid",
    "public_id" "text" NOT NULL,
    "status" "text" NOT NULL,
    "amount_minor" bigint NOT NULL,
    "currency" character(3) NOT NULL,
    "provider_key" "text" NOT NULL,
    "provider_charge_id" "text",
    "failure_code" "text",
    "failure_message" "text",
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "imported" boolean DEFAULT false NOT NULL,
    "metadata" "jsonb",
    "payment_request_id" "uuid",
    "method_type" "text",
    "reversal_code" "text"
);


--
-- Name: plan_entitlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."plan_entitlements" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "feature_id" "uuid" NOT NULL,
    "value" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reset" "jsonb"
);


--
-- Name: portal_login_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."portal_login_codes" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "email_hash" "text" NOT NULL,
    "code_hash" "text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL
);


--
-- Name: portal_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."portal_sessions" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "token_hash" "text",
    "created_by" "text",
    "expires_at" timestamp with time zone NOT NULL,
    "last_used_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "access_token_hash" "text",
    "access_expires_at" timestamp with time zone,
    "consumed_at" timestamp with time zone,
    "status" "text" DEFAULT 'created'::"text" NOT NULL,
    "login_at" timestamp with time zone,
    "login_ip" "text",
    "logout_at" timestamp with time zone,
    "logout_ip" "text",
    "access_kind" "text" DEFAULT 'api'::"text" NOT NULL,
    "redirect_url" "text",
    "forward_url" "text",
    CONSTRAINT "portal_sessions_access_kind_ck" CHECK (("access_kind" = ANY (ARRAY['api'::"text", 'email'::"text"]))),
    CONSTRAINT "portal_sessions_status_ck" CHECK (("status" = ANY (ARRAY['created'::"text", 'logged_in'::"text", 'logged_out'::"text"])))
);


--
-- Name: COLUMN "portal_sessions"."token_hash"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."portal_sessions"."token_hash" IS 'SHA-256 of the session credential (psst_) minted BY the exchange and held only in the buyer HttpOnly cookie. NULL before exchange and after logout.';


--
-- Name: COLUMN "portal_sessions"."access_token_hash"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."portal_sessions"."access_token_hash" IS 'SHA-256 of the single-use entry credential (pstk_) that appears in the portal link. Consumed by the exchange; nothing else accepts it.';


--
-- Name: COLUMN "portal_sessions"."access_kind"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."portal_sessions"."access_kind" IS 'Where the entry link was destined: api (1h window, 0193) or email (5d). Chooses access_expires_at at mint; never read afterwards.';


--
-- Name: pre_debit_notices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."pre_debit_notices" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "payment_method_id" "uuid" NOT NULL,
    "gateway_account_id" "uuid",
    "subscription_id" "uuid",
    "invoice_id" "uuid",
    "amount_minor" bigint NOT NULL,
    "currency" "text" NOT NULL,
    "debit_at" timestamp with time zone NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "notification_ref" "text",
    "executable_after" timestamp with time zone,
    "expires_at" timestamp with time zone,
    "debits_used" integer DEFAULT 0 NOT NULL,
    "failure_code" "text",
    "failure_message" "text",
    "idempotency_key" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "purpose" "text" DEFAULT 'invoice'::"text" NOT NULL,
    CONSTRAINT "pre_debit_notices_amount_minor_check" CHECK (("amount_minor" > 0)),
    CONSTRAINT "pre_debit_notices_purpose_ck" CHECK (("purpose" = ANY (ARRAY['invoice'::"text", 'wallet_topup'::"text", 'credit_topup'::"text"]))),
    CONSTRAINT "pre_debit_notices_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'failed'::"text", 'superseded'::"text", 'exhausted'::"text"])))
);


--
-- Name: price_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."price_rates" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "price_id" "uuid" NOT NULL,
    "match" "jsonb" NOT NULL,
    "unit_amount_decimal" numeric(38,12),
    "tiers" "jsonb",
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    "markup_percent" numeric(12,6),
    CONSTRAINT "price_rates_amount_or_markup_ck" CHECK ((("markup_percent" IS NULL) = (("unit_amount_decimal" IS NOT NULL) OR ("tiers" IS NOT NULL)))),
    CONSTRAINT "price_rates_markup_percent_nonneg" CHECK ((("markup_percent" IS NULL) OR ("markup_percent" >= (0)::numeric))),
    CONSTRAINT "price_rates_match_check" CHECK (("jsonb_typeof"("match") = 'object'::"text")),
    CONSTRAINT "price_rates_tiers_check" CHECK ((("tiers" IS NULL) OR ("jsonb_typeof"("tiers") = 'array'::"text"))),
    CONSTRAINT "price_rates_unit_amount_decimal_check" CHECK ((("unit_amount_decimal" IS NULL) OR ("unit_amount_decimal" >= (0)::numeric)))
);


--
-- Name: prices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."prices" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "type" "text" DEFAULT 'recurring'::"text" NOT NULL,
    "model" "text" NOT NULL,
    "currency" character(3) NOT NULL,
    "amount_minor" bigint,
    "interval" "text",
    "interval_count" integer DEFAULT 1 NOT NULL,
    "usage_aggregation" "text",
    "tiers" "jsonb",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "package_size" integer,
    "free_units" integer,
    "percentage_bps" integer,
    "name" "text",
    "is_taxable" boolean DEFAULT true NOT NULL,
    "tax_behavior" "text" DEFAULT 'exclusive'::"text" NOT NULL,
    "external_name" "text",
    "description" "text",
    "trial_period" integer,
    "trial_period_unit" "text",
    "trial_end_action" "text",
    "billing_cycles" integer,
    "free_quantity" integer,
    "invoice_notes" "text",
    "show_description_in_invoices" boolean DEFAULT false NOT NULL,
    "metadata" "jsonb",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    "show_description_in_quotes" boolean DEFAULT false NOT NULL,
    "tax_code" "text",
    "sku" "text",
    "accounting_code" "text",
    "accounting_category_code" "text",
    "minimum_amount_minor" bigint,
    "usage_recurring" boolean DEFAULT false NOT NULL,
    "usage_time_unit" "text",
    "bill_usage_monthly" boolean DEFAULT false NOT NULL,
    "commitment_amount_minor" bigint,
    "meter_id" "uuid",
    "unit_amount_decimal" numeric(38,12),
    "quantity_divisor" bigint DEFAULT 1 NOT NULL,
    "amount_source" "text" DEFAULT 'rate'::"text" NOT NULL,
    "markup_percent" numeric(12,6),
    "markup_base" "text",
    "grants_credit" "jsonb",
    "portal_min_quantity" integer,
    "portal_max_quantity" integer,
    CONSTRAINT "prices_grants_credit_ck" CHECK ((("grants_credit" IS NULL) OR ("jsonb_typeof"("grants_credit") = 'object'::"text"))),
    CONSTRAINT "prices_markup_base_ck" CHECK ((("markup_base" IS NULL) OR ("markup_base" = ANY (ARRAY['list'::"text", 'cost'::"text"])))),
    CONSTRAINT "prices_markup_percent_nonneg" CHECK ((("markup_percent" IS NULL) OR ("markup_percent" >= (0)::numeric))),
    CONSTRAINT "prices_quantity_divisor_pos" CHECK (("quantity_divisor" >= 1)),
    CONSTRAINT "prices_unit_amount_decimal_nonneg" CHECK ((("unit_amount_decimal" IS NULL) OR ("unit_amount_decimal" >= (0)::numeric))),
    CONSTRAINT "prices_usage_time_unit_check" CHECK ((("usage_time_unit" IS NULL) OR ("usage_time_unit" = ANY (ARRAY['hour'::"text", 'day'::"text"]))))
);


--
-- Name: COLUMN "prices"."show_description_in_quotes"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."prices"."show_description_in_quotes" IS 'Show the description on quotes. Stored and exposed on the API; no quote renderer exists yet to honour it.';


--
-- Name: COLUMN "prices"."tax_code"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."prices"."tax_code" IS 'HSN/SAC for this price — the finest level of price → product → business default. Null means "use the product''s".';


--
-- Name: COLUMN "prices"."sku"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."prices"."sku" IS 'SKU / alternative name. Descriptive only — the engine reads it nowhere.';


--
-- Name: COLUMN "prices"."accounting_code"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."prices"."accounting_code" IS 'Accounting code ("Account Name"). Descriptive only — NOT a ledger_accounts reference and never resolved to one.';


--
-- Name: COLUMN "prices"."accounting_category_code"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."prices"."accounting_category_code" IS 'Accounting category code ("Class"). Descriptive only — the engine reads it nowhere.';


--
-- Name: product_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."product_groups" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL
);


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."products" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "kind" "text" DEFAULT 'plan'::"text" NOT NULL,
    "addon_applies_to_all" boolean DEFAULT false NOT NULL,
    "product_group_id" "uuid" NOT NULL,
    "external_name" "text",
    "unit_of_measure" "text",
    "metered" boolean DEFAULT false NOT NULL,
    "enabled_for_checkout" boolean DEFAULT false NOT NULL,
    "enabled_in_portal" boolean DEFAULT false NOT NULL,
    "redirect_url" "text",
    "metadata" "jsonb",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    "tax_profile_id" "uuid",
    "tax_code" "text",
    "image_url" "text"
);


--
-- Name: COLUMN "products"."tax_code"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."products"."tax_code" IS 'HSN/SAC for this product, overriding businesses.default_tax_code. Separate from tax_profile_id: profiles group by RATE, this groups by what the service is.';


--
-- Name: promotional_credit_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."promotional_credit_movements" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "ledger_transaction_id" "uuid" NOT NULL,
    "credit_type" "text" DEFAULT 'general'::"text" NOT NULL,
    "reference" "text",
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    CONSTRAINT "promotional_credit_movements_credit_type_check" CHECK (("credit_type" = ANY (ARRAY['general'::"text", 'referral_rewards'::"text", 'loyalty_credits'::"text"])))
);


--
-- Name: provider_customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."provider_customers" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "provider_key" "text" NOT NULL,
    "gateway_account_id" "uuid",
    "provider_customer_id" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL
);


--
-- Name: provider_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."provider_events" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "provider_key" "text" NOT NULL,
    "provider_event_id" "text" NOT NULL,
    "type" "text" NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone,
    "business_id" "uuid",
    "payload" "jsonb",
    "outcome" "text",
    "error" "text",
    "headers" "jsonb",
    "response_status" integer,
    "request_url" "text",
    "transaction_public_id" "text",
    "normalized" "jsonb"
);


--
-- Name: public_rate_limit_counters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."public_rate_limit_counters" (
    "bucket" "text" NOT NULL,
    "window_start" timestamp with time zone NOT NULL,
    "count" integer DEFAULT 0 NOT NULL
);


--
-- Name: TABLE "public_rate_limit_counters"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."public_rate_limit_counters" IS 'Fixed-window request counters for unauthenticated routes, one row per (bucket, minute). Bucket is a namespaced key such as login:ip:<addr> or login:email:<sha256>. Read before tenant context exists, so no RLS. Swept by the billing clock.';


--
-- Name: rate_limit_counters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."rate_limit_counters" (
    "api_key_id" "uuid" NOT NULL,
    "window_start" timestamp with time zone NOT NULL,
    "count" integer DEFAULT 0 NOT NULL
);


--
-- Name: TABLE "rate_limit_counters"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."rate_limit_counters" IS 'Fixed-window API request counters, one row per (api_key, minute). Read by the auth layer before tenant context exists, so no RLS. Swept by the billing clock.';


--
-- Name: reason_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."reason_codes" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "public_id" "text" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "applies_to" "text" NOT NULL,
    "code" "text" NOT NULL,
    "label" "text" NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL
);


--
-- Name: receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."receipts" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "number" "text",
    "payment_id" "uuid",
    "payment_request_id" "uuid",
    "transaction_id" "uuid",
    "amount_minor" bigint NOT NULL,
    "currency" character(3) NOT NULL,
    "paid_at" timestamp with time zone NOT NULL,
    "snapshot" "jsonb" NOT NULL,
    "numbered_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    CONSTRAINT "receipts_amount_minor_check" CHECK (("amount_minor" > 0)),
    CONSTRAINT "receipts_one_source_ck" CHECK ((("payment_id" IS NULL) <> ("transaction_id" IS NULL)))
);


--
-- Name: reference_data_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."reference_data_sources" (
    "source" "text" NOT NULL,
    "seeded_version" "text",
    "seeded_at" timestamp with time zone,
    "upstream_version" "text",
    "upstream_published_at" timestamp with time zone,
    "checked_at" timestamp with time zone,
    "check_error" "text",
    "last_success_at" timestamp with time zone,
    "held_batch" "jsonb"
);


--
-- Name: refunds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."refunds" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "payment_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "status" "text" NOT NULL,
    "amount_minor" bigint NOT NULL,
    "currency" character(3) NOT NULL,
    "reason" "text",
    "provider_key" "text" NOT NULL,
    "provider_refund_id" "text",
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "imported" boolean DEFAULT false NOT NULL,
    "metadata" "jsonb",
    "not_found_state" "text",
    "on_decline" "text"
);


--
-- Name: renewal_skips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."renewal_skips" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "subscription_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "renewal_at" timestamp with time zone NOT NULL,
    "status" "text" DEFAULT 'scheduled'::"text" NOT NULL,
    "source" "text" NOT NULL,
    "invoice_id" "uuid",
    "applied_at" timestamp with time zone,
    "cancelled_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    CONSTRAINT "renewal_skips_source_check" CHECK (("source" = ANY (ARRAY['api'::"text", 'dashboard'::"text", 'portal'::"text"]))),
    CONSTRAINT "renewal_skips_status_check" CHECK (("status" = ANY (ARRAY['scheduled'::"text", 'applied'::"text", 'cancelled'::"text", 'void'::"text"])))
);


--
-- Name: report_dashboard_tiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."report_dashboard_tiles" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "dashboard_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "report_key" "text" NOT NULL,
    "range" "text",
    "currency" "text",
    "group_by" "text",
    "granularity" "text",
    "size" "text" DEFAULT 'md'::"text" NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    "width_units" integer DEFAULT 6 NOT NULL,
    "height_units" integer DEFAULT 4 NOT NULL,
    "shape" "text",
    "segment_id" "text",
    CONSTRAINT "report_dashboard_tiles_height_units_check" CHECK ((("height_units" >= 2) AND ("height_units" <= 12))),
    CONSTRAINT "report_dashboard_tiles_report_key_check" CHECK ((("length"("report_key") >= 1) AND ("length"("report_key") <= 80))),
    CONSTRAINT "report_dashboard_tiles_shape_check" CHECK (("shape" = ANY (ARRAY['series'::"text", 'totals'::"text"]))),
    CONSTRAINT "report_dashboard_tiles_size_check" CHECK (("size" = ANY (ARRAY['sm'::"text", 'md'::"text", 'lg'::"text", 'full'::"text"]))),
    CONSTRAINT "report_dashboard_tiles_width_units_check" CHECK ((("width_units" >= 1) AND ("width_units" <= 12)))
);


--
-- Name: COLUMN "report_dashboard_tiles"."width_units"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."report_dashboard_tiles"."width_units" IS 'Columns of 12 this tile spans.';


--
-- Name: COLUMN "report_dashboard_tiles"."height_units"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."report_dashboard_tiles"."height_units" IS 'Rows of 80px this tile stands.';


--
-- Name: COLUMN "report_dashboard_tiles"."shape"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."report_dashboard_tiles"."shape" IS 'series | totals; NULL = series.';


--
-- Name: COLUMN "report_dashboard_tiles"."segment_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."report_dashboard_tiles"."segment_id" IS 'Public id of the segment this tile answers for; NULL = the whole book.';


--
-- Name: report_dashboards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."report_dashboards" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid",
    "public_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "owner" "text" NOT NULL,
    "visibility" "text" DEFAULT 'private'::"text" NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    CONSTRAINT "report_dashboards_visibility_check" CHECK (("visibility" = ANY (ARRAY['private'::"text", 'everyone'::"text"])))
);


--
-- Name: retention_defaults; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."retention_defaults" (
    "id" boolean DEFAULT true NOT NULL,
    "mode" "text" DEFAULT 'dry_run'::"text" NOT NULL,
    "events_days" integer DEFAULT 90 NOT NULL,
    "webhook_deliveries_days" integer DEFAULT 30 NOT NULL,
    "gateway_logs_days" integer DEFAULT 90 NOT NULL,
    "email_body_days" integer DEFAULT 90 NOT NULL,
    "idempotency_hours" integer DEFAULT 24 NOT NULL,
    "clock_ticks_days" integer DEFAULT 30 NOT NULL,
    "invariant_results_days" integer DEFAULT 30 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "text",
    "last_run_at" timestamp with time zone,
    "last_run_mode" "text",
    "last_run" "jsonb",
    "api_log_writes_days" integer DEFAULT 90 NOT NULL,
    "api_log_reads_days" integer DEFAULT 30 NOT NULL,
    CONSTRAINT "retention_defaults_api_log_reads_days_check" CHECK (("api_log_reads_days" >= 0)),
    CONSTRAINT "retention_defaults_api_log_writes_days_check" CHECK (("api_log_writes_days" >= 0)),
    CONSTRAINT "retention_defaults_clock_ticks_days_check" CHECK (("clock_ticks_days" >= 0)),
    CONSTRAINT "retention_defaults_email_body_days_check" CHECK (("email_body_days" >= 0)),
    CONSTRAINT "retention_defaults_events_days_check" CHECK ((("events_days" = 0) OR ("events_days" >= 31))),
    CONSTRAINT "retention_defaults_gateway_logs_days_check" CHECK (("gateway_logs_days" >= 0)),
    CONSTRAINT "retention_defaults_id_check" CHECK ("id"),
    CONSTRAINT "retention_defaults_idempotency_hours_check" CHECK (("idempotency_hours" >= 0)),
    CONSTRAINT "retention_defaults_invariant_results_days_check" CHECK (("invariant_results_days" >= 0)),
    CONSTRAINT "retention_defaults_mode_check" CHECK (("mode" = ANY (ARRAY['off'::"text", 'dry_run'::"text", 'on'::"text"]))),
    CONSTRAINT "retention_defaults_webhook_deliveries_days_check" CHECK (("webhook_deliveries_days" >= 0))
);


--
-- Name: retention_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."retention_events" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "subscription_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "offer" "text",
    "reason_code" "text",
    "offers_shown" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    CONSTRAINT "retention_events_kind_check" CHECK (("kind" = ANY (ARRAY['offer_accepted'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "retention_events_offer_check" CHECK ((("offer" IS NULL) OR ("offer" = ANY (ARRAY['pause'::"text", 'downgrade'::"text", 'discount'::"text", 'contact'::"text"]))))
);


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."roles" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "name_key" "text" NOT NULL,
    "description" "text",
    "permissions" "text"[] NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "roles_permissions_check" CHECK ((("cardinality"("permissions") >= 1) AND ("cardinality"("permissions") <= 200)))
);


--
-- Name: scheduled_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."scheduled_changes" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "subscription_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "type" "text" NOT NULL,
    "effective_at" timestamp with time zone NOT NULL,
    "payload" "jsonb",
    "status" "text" DEFAULT 'scheduled'::"text" NOT NULL,
    "applied_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "last_error" "text",
    "failed_at" timestamp with time zone,
    "mrr_delta_minor" bigint
);


--
-- Name: COLUMN "scheduled_changes"."status"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."scheduled_changes"."status" IS 'scheduled | applied | canceled | failed. canceled = the merchant withdrew it; failed = the clock gave up after attempts exhausted (see last_error).';


--
-- Name: COLUMN "scheduled_changes"."attempts"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."scheduled_changes"."attempts" IS 'How many times the billing clock has tried to apply this row. At SCHEDULED_CHANGE_MAX_ATTEMPTS the row goes status=failed rather than retrying every tick forever.';


--
-- Name: COLUMN "scheduled_changes"."last_error"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."scheduled_changes"."last_error" IS 'The message from the most recent failed apply. Also surfaced per-tick in clock_ticks.errors.';


--
-- Name: COLUMN "scheduled_changes"."mrr_delta_minor"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."scheduled_changes"."mrr_delta_minor" IS 'Expected change in monthly recurring revenue when this scheduled change lands, in minor units; positive = upgrade. GROSS and priced at schedule time: it excludes coupons and manual discounts, rates added/repriced items from the catalog price of the moment rather than the snapshot frozen at apply time (so a plan-scoped differential add-on price is not applied), ignores one-time and usage prices, and is not restated if the subscription or catalog moves before the change lands. An estimate for reporting, never a booked amount.';


--
-- Name: security_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."security_events" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "ip" "inet",
    "user_agent" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."sessions" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "token_hash" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_ip" "inet",
    "user_agent" "text",
    "step_up_at" timestamp with time zone,
    "auth_method" "text",
    "mfa_at" timestamp with time zone,
    "last_active_at" timestamp with time zone
);


--
-- Name: settlement_poll_schedule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."settlement_poll_schedule" (
    "transaction_id" "uuid" NOT NULL,
    "pass" "text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "next_at" timestamp with time zone NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: signup_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."signup_requests" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "public_id" "text" NOT NULL,
    "email" "text" NOT NULL,
    "name" "text" NOT NULL,
    "company" "text" NOT NULL,
    "country" character(2),
    "billing_volume" "text",
    "gateway" "text",
    "message" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "requested_ip" "text",
    "invited_at" timestamp with time zone,
    "invited_by" "text",
    "dismissed_at" timestamp with time zone,
    "dismissed_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "signup_requests_status_ck" CHECK (("status" = ANY (ARRAY['pending'::"text", 'invited'::"text", 'dismissed'::"text"])))
);


--
-- Name: spend_limit_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."spend_limit_states" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "limit_id" "uuid" NOT NULL,
    "subject_key" "text" NOT NULL,
    "interval_start" timestamp with time zone NOT NULL,
    "reached_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL
);


--
-- Name: spend_limit_tiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."spend_limit_tiers" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "currency" character(3) NOT NULL,
    "level_minor" bigint NOT NULL,
    "amounts" "jsonb" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    CONSTRAINT "spend_limit_tiers_amounts_check" CHECK (("jsonb_typeof"("amounts") = 'object'::"text")),
    CONSTRAINT "spend_limit_tiers_level_minor_check" CHECK (("level_minor" >= 0))
);


--
-- Name: spend_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."spend_limits" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "subscription_id" "uuid",
    "scope" "text" NOT NULL,
    "property_key" "text",
    "property_value" "text",
    "meter_ids" "uuid"[],
    "interval" "text" NOT NULL,
    "amount_minor" bigint NOT NULL,
    "currency" character(3) NOT NULL,
    "mode" "text" NOT NULL,
    "set_by" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    CONSTRAINT "spend_limits_amount_minor_check" CHECK (("amount_minor" >= 0)),
    CONSTRAINT "spend_limits_buyer_ck" CHECK ((("set_by" = 'operator'::"text") OR (("mode" = 'hard'::"text") AND ("scope" = ANY (ARRAY['customer'::"text", 'property'::"text"]))))),
    CONSTRAINT "spend_limits_interval_check" CHECK (("interval" = ANY (ARRAY['day'::"text", 'week'::"text", 'month'::"text", 'period'::"text"]))),
    CONSTRAINT "spend_limits_meter_ids_ck" CHECK ((("meter_ids" IS NULL) OR ("cardinality"("meter_ids") > 0))),
    CONSTRAINT "spend_limits_mode_check" CHECK (("mode" = ANY (ARRAY['hard'::"text", 'soft'::"text"]))),
    CONSTRAINT "spend_limits_property_ck" CHECK ((("scope" = 'property'::"text") = ("property_key" IS NOT NULL))),
    CONSTRAINT "spend_limits_property_value_ck" CHECK ((("property_value" IS NULL) OR ("scope" = 'property'::"text"))),
    CONSTRAINT "spend_limits_scope_check" CHECK (("scope" = ANY (ARRAY['customer'::"text", 'subscription'::"text", 'property'::"text"]))),
    CONSTRAINT "spend_limits_set_by_check" CHECK (("set_by" = ANY (ARRAY['operator'::"text", 'customer'::"text"]))),
    CONSTRAINT "spend_limits_subscription_ck" CHECK ((("scope" = 'subscription'::"text") = ("subscription_id" IS NOT NULL)))
);


--
-- Name: subscription_charge_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."subscription_charge_log" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "subscription_id" "uuid" NOT NULL,
    "item_product_id" "uuid" NOT NULL,
    "charge_event" "text" NOT NULL,
    "invoice_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL
);


--
-- Name: subscription_entitlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."subscription_entitlements" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "subscription_id" "uuid" NOT NULL,
    "feature_id" "uuid" NOT NULL,
    "value" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "reset" "jsonb"
);


--
-- Name: subscription_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."subscription_items" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "subscription_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "price_id" "uuid" NOT NULL,
    "quantity" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "price_snapshot" "jsonb",
    "free_quantity" integer,
    "billing_cycles" integer,
    "metadata" "jsonb",
    "cycles_billed" integer DEFAULT 0 NOT NULL,
    "usage_billed_through" timestamp with time zone,
    "next_credit_reset_at" timestamp with time zone
);


--
-- Name: tax_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."tax_profiles" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL
);


--
-- Name: tax_rate_components; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."tax_rate_components" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "tax_region_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "state_code" "text",
    "name" "text" NOT NULL,
    "rate_bps" integer NOT NULL,
    "applies_to" "text" DEFAULT 'both'::"text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL
);


--
-- Name: tax_regions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."tax_regions" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "tax_profile_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "country" character(2) NOT NULL,
    "regime" "text" DEFAULT 'flat'::"text" NOT NULL,
    "price_type" "text" DEFAULT 'exclusive'::"text" NOT NULL,
    "home_state_code" "text",
    "registration_label" "text",
    "registration_number" "text",
    "collect_registration_number" boolean DEFAULT false NOT NULL,
    "reverse_charge_enabled" boolean DEFAULT false NOT NULL,
    "show_reverse_charge_note" boolean DEFAULT false NOT NULL,
    "reverse_charge_note" "text",
    "sez_igst_enabled" boolean DEFAULT false NOT NULL,
    "sez_igst_note" "text",
    "sez_zero_rated_enabled" boolean DEFAULT false NOT NULL,
    "sez_zero_rated_note" "text",
    "export_igst_enabled" boolean DEFAULT false NOT NULL,
    "export_igst_note" "text",
    "export_zero_rated_enabled" boolean DEFAULT false NOT NULL,
    "export_zero_rated_note" "text",
    "enabled" boolean DEFAULT true NOT NULL,
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL
);


--
-- Name: tax_state_registrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."tax_state_registrations" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "tax_region_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "state_code" "text" NOT NULL,
    "state_name" "text",
    "registration_number" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL
);


--
-- Name: team_alert_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."team_alert_recipients" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "token_hash" "text",
    "token_expires_at" timestamp with time zone,
    "confirmed_at" timestamp with time zone,
    "last_sent_at" timestamp with time zone,
    "send_count" integer DEFAULT 0 NOT NULL,
    "send_window_start" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    CONSTRAINT "team_alert_recipients_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'confirmed'::"text", 'removed'::"text"])))
);


--
-- Name: time_travels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."time_travels" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'not_enabled'::"text" NOT NULL,
    "genesis_time" timestamp with time zone,
    "simulated_now" timestamp with time zone,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    "travel_lease_until" timestamp with time zone
);


--
-- Name: tmtest_charges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."tmtest_charges" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "charge_id" "text" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "vault_id" "text",
    "kind" "text" DEFAULT 'charge'::"text" NOT NULL,
    "parent_charge_id" "text",
    "amount_minor" bigint NOT NULL,
    "currency" character(3) NOT NULL,
    "status" "text" NOT NULL,
    "error_code" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "idempotency_key" "text",
    "consume_idempotency_key" "text",
    "checkout_params" "jsonb"
);


--
-- Name: tmtest_outbound; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."tmtest_outbound" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "event_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "signature" "text" NOT NULL,
    "deliver_after" timestamp with time zone NOT NULL,
    "delivered_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: tmtest_vault; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."tmtest_vault" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "vault_id" "text" NOT NULL,
    "token" "text" NOT NULL,
    "instrument" "text" NOT NULL,
    "last4" "text",
    "exp_month" integer,
    "exp_year" integer,
    "status" "text" DEFAULT 'valid'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."transactions" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "public_id" "text" NOT NULL,
    "type" "text" NOT NULL,
    "status" "text" NOT NULL,
    "amount_minor" bigint NOT NULL,
    "currency" character(3) NOT NULL,
    "gateway_account_id" "uuid",
    "gateway_key" "text",
    "id_at_gateway" "text",
    "payment_method_id" "uuid",
    "error_code" "text",
    "error_text" "text",
    "invoice_id" "uuid",
    "payment_id" "uuid",
    "refund_id" "uuid",
    "credit_note_id" "uuid",
    "occurred_at" timestamp with time zone NOT NULL,
    "settled_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    "retriable" boolean,
    "payment_intent_id" "uuid",
    "payment_attempt_id" "uuid",
    "trace_id" "text",
    "finalised_at" timestamp with time zone,
    "payment_request_id" "uuid",
    "ownership_ref" "text",
    "idempotency_key" "text",
    "subscription_id" "uuid",
    "span_id" "text",
    CONSTRAINT "transactions_status_ck" CHECK (("status" = ANY (ARRAY['in_progress'::"text", 'succeeded'::"text", 'failed'::"text", 'voided'::"text", 'timeout'::"text", 'needs_attention'::"text", 'late_failed'::"text"])))
);


--
-- Name: transfer_configurations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."transfer_configurations" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "source_business_id" "uuid" NOT NULL,
    "destination_business_id" "uuid" NOT NULL,
    "sections" "jsonb" NOT NULL,
    "wipe_destination" boolean DEFAULT false NOT NULL,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "report" "jsonb",
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "live_override" boolean DEFAULT false NOT NULL,
    "plan_digest" "text",
    "options" "jsonb",
    "twin_of" "uuid"
);


--
-- Name: trusted_browsers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."trusted_browsers" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "token_hash" "text" NOT NULL,
    "user_agent" "text",
    "ip" "inet",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_used_at" timestamp with time zone,
    "expires_at" timestamp with time zone NOT NULL,
    "revoked_at" timestamp with time zone
);


--
-- Name: unbilled_charges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."unbilled_charges" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "subscription_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "description" "text" NOT NULL,
    "amount_minor" bigint NOT NULL,
    "currency" character(3) NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "invoice_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "period_start" timestamp with time zone,
    "period_end" timestamp with time zone,
    "price_id" "uuid",
    "quantity" integer DEFAULT 1 NOT NULL,
    "entity_type" "text" DEFAULT 'adhoc'::"text" NOT NULL,
    "rating" "jsonb"
);


--
-- Name: usage_alert_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_alert_observations" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "alert_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "subject_key" "text" NOT NULL,
    "period_key" timestamp with time zone NOT NULL,
    "last_value" numeric NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL
);


--
-- Name: usage_alert_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_alert_states" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "alert_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "subject_key" "text" NOT NULL,
    "period_key" timestamp with time zone NOT NULL,
    "threshold" numeric NOT NULL,
    "last_value" numeric,
    "triggered_at" timestamp with time zone,
    "resolved_at" timestamp with time zone,
    "resolve_reason" "text",
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    CONSTRAINT "usage_alert_states_reason_ck" CHECK ((("resolved_at" IS NULL) = ("resolve_reason" IS NULL))),
    CONSTRAINT "usage_alert_states_resolved_ck" CHECK ((("resolved_at" IS NULL) OR ("triggered_at" IS NOT NULL)))
);


--
-- Name: usage_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_alerts" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "scope" "text" NOT NULL,
    "customer_id" "uuid",
    "product_id" "uuid",
    "meter_id" "uuid",
    "interval" "text",
    "currency" character(3),
    "unit_id" "uuid",
    "thresholds" "jsonb" NOT NULL,
    "email" boolean DEFAULT false NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    CONSTRAINT "usage_alerts_currency_ck" CHECK ((("kind" = 'usage_quantity'::"text") OR ("currency" IS NOT NULL))),
    CONSTRAINT "usage_alerts_customer_ck" CHECK ((("scope" = 'customer'::"text") = ("customer_id" IS NOT NULL))),
    CONSTRAINT "usage_alerts_interval_check" CHECK (("interval" = ANY (ARRAY['day'::"text", 'week'::"text", 'month'::"text", 'period'::"text"]))),
    CONSTRAINT "usage_alerts_interval_ck" CHECK ((("kind" = ANY (ARRAY['usage_quantity'::"text", 'spend'::"text"])) = ("interval" IS NOT NULL))),
    CONSTRAINT "usage_alerts_kind_check" CHECK (("kind" = ANY (ARRAY['usage_quantity'::"text", 'spend'::"text", 'credit_balance'::"text", 'credit_runway'::"text"]))),
    CONSTRAINT "usage_alerts_meter_ck" CHECK ((("kind" <> 'usage_quantity'::"text") OR ("meter_id" IS NOT NULL))),
    CONSTRAINT "usage_alerts_meter_kind_ck" CHECK ((("meter_id" IS NULL) OR ("kind" = ANY (ARRAY['usage_quantity'::"text", 'spend'::"text"])))),
    CONSTRAINT "usage_alerts_product_ck" CHECK ((("scope" = 'plan'::"text") = ("product_id" IS NOT NULL))),
    CONSTRAINT "usage_alerts_scope_check" CHECK (("scope" = ANY (ARRAY['customer'::"text", 'plan'::"text"]))),
    CONSTRAINT "usage_alerts_thresholds_ck" CHECK (
CASE
    WHEN ("jsonb_typeof"("thresholds") = 'array'::"text") THEN (("jsonb_array_length"("thresholds") >= 1) AND ("jsonb_array_length"("thresholds") <= 10))
    ELSE false
END),
    CONSTRAINT "usage_alerts_unit_ck" CHECK ((("unit_id" IS NULL) OR ("kind" = ANY (ARRAY['credit_balance'::"text", 'credit_runway'::"text"]))))
);


--
-- Name: usage_archives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_archives" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "partition_name" "text" NOT NULL,
    "month" "date" NOT NULL,
    "row_count" bigint NOT NULL,
    "byte_count" bigint NOT NULL,
    "sha256" "text" NOT NULL,
    "object_key" "text" NOT NULL,
    "archived_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "dropped_at" timestamp with time zone,
    CONSTRAINT "usage_archives_sha256_check" CHECK (("sha256" ~ '^[0-9a-f]{64}$'::"text"))
);


--
-- Name: usage_control_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_control_cursors" (
    "customer_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "evaluated_at" timestamp with time zone NOT NULL
);


--
-- Name: usage_control_dirty; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_control_dirty" (
    "customer_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "marked_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL
);


--
-- Name: usage_event_dedup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_event_dedup" (
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "key" "text" NOT NULL,
    "event_id" "uuid" NOT NULL,
    "event_timestamp" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: usage_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_events" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "customer_key" "text" NOT NULL,
    "event_name" "text" NOT NULL,
    "properties" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "timestamp" timestamp with time zone NOT NULL,
    "key" "text" NOT NULL,
    "amount" numeric,
    "cost" numeric,
    "currency" character(3),
    "matched_at" timestamp with time zone,
    "voided_at" timestamp with time zone,
    "void_reason" "text",
    CONSTRAINT "usage_events_key_check" CHECK ((("char_length"("key") >= 1) AND ("char_length"("key") <= 255)))
)
PARTITION BY RANGE ("timestamp");


--
-- Name: usage_events_y2026m09; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_events_y2026m09" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "customer_key" "text" NOT NULL,
    "event_name" "text" NOT NULL,
    "properties" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "timestamp" timestamp with time zone NOT NULL,
    "key" "text" NOT NULL,
    "amount" numeric,
    "cost" numeric,
    "currency" character(3),
    "matched_at" timestamp with time zone,
    "voided_at" timestamp with time zone,
    "void_reason" "text",
    CONSTRAINT "usage_events_key_check" CHECK ((("char_length"("key") >= 1) AND ("char_length"("key") <= 255)))
);


--
-- Name: usage_events_y2026m10; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_events_y2026m10" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "customer_key" "text" NOT NULL,
    "event_name" "text" NOT NULL,
    "properties" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "timestamp" timestamp with time zone NOT NULL,
    "key" "text" NOT NULL,
    "amount" numeric,
    "cost" numeric,
    "currency" character(3),
    "matched_at" timestamp with time zone,
    "voided_at" timestamp with time zone,
    "void_reason" "text",
    CONSTRAINT "usage_events_key_check" CHECK ((("char_length"("key") >= 1) AND ("char_length"("key") <= 255)))
);


--
-- Name: usage_events_y2026m11; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_events_y2026m11" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "customer_key" "text" NOT NULL,
    "event_name" "text" NOT NULL,
    "properties" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "timestamp" timestamp with time zone NOT NULL,
    "key" "text" NOT NULL,
    "amount" numeric,
    "cost" numeric,
    "currency" character(3),
    "matched_at" timestamp with time zone,
    "voided_at" timestamp with time zone,
    "void_reason" "text",
    CONSTRAINT "usage_events_key_check" CHECK ((("char_length"("key") >= 1) AND ("char_length"("key") <= 255)))
);


--
-- Name: usage_events_y2026m12; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_events_y2026m12" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "customer_key" "text" NOT NULL,
    "event_name" "text" NOT NULL,
    "properties" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "timestamp" timestamp with time zone NOT NULL,
    "key" "text" NOT NULL,
    "amount" numeric,
    "cost" numeric,
    "currency" character(3),
    "matched_at" timestamp with time zone,
    "voided_at" timestamp with time zone,
    "void_reason" "text",
    CONSTRAINT "usage_events_key_check" CHECK ((("char_length"("key") >= 1) AND ("char_length"("key") <= 255)))
);


--
-- Name: usage_events_y2027m01; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_events_y2027m01" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "customer_key" "text" NOT NULL,
    "event_name" "text" NOT NULL,
    "properties" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "timestamp" timestamp with time zone NOT NULL,
    "key" "text" NOT NULL,
    "amount" numeric,
    "cost" numeric,
    "currency" character(3),
    "matched_at" timestamp with time zone,
    "voided_at" timestamp with time zone,
    "void_reason" "text",
    CONSTRAINT "usage_events_key_check" CHECK ((("char_length"("key") >= 1) AND ("char_length"("key") <= 255)))
);


--
-- Name: usage_invoice_thresholds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_invoice_thresholds" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "scope" "text" NOT NULL,
    "product_id" "uuid",
    "subscription_id" "uuid",
    "steps" "jsonb",
    "currency" character(3) NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "resource_version" bigint DEFAULT 1 NOT NULL,
    CONSTRAINT "usage_invoice_thresholds_product_ck" CHECK ((("scope" = 'plan'::"text") = ("product_id" IS NOT NULL))),
    CONSTRAINT "usage_invoice_thresholds_scope_check" CHECK (("scope" = ANY (ARRAY['plan'::"text", 'subscription'::"text"]))),
    CONSTRAINT "usage_invoice_thresholds_steps_ck" CHECK (
CASE
    WHEN ("steps" IS NULL) THEN true
    WHEN ("jsonb_typeof"("steps") <> 'array'::"text") THEN false
    WHEN ("jsonb_array_length"("steps") <> 1) THEN false
    WHEN ("jsonb_typeof"(("steps" -> 0)) <> 'object'::"text") THEN false
    WHEN ((("steps" -> 0) -> 'recurring'::"text") IS DISTINCT FROM 'true'::"jsonb") THEN false
    WHEN ("jsonb_typeof"((("steps" -> 0) -> 'amount_minor'::"text")) IS DISTINCT FROM 'number'::"text") THEN false
    ELSE (((("steps" -> 0) ->> 'amount_minor'::"text"))::numeric > (0)::numeric)
END),
    CONSTRAINT "usage_invoice_thresholds_steps_present_ck" CHECK ((("steps" IS NOT NULL) OR (NOT "active"))),
    CONSTRAINT "usage_invoice_thresholds_subscription_ck" CHECK ((("scope" = 'subscription'::"text") = ("subscription_id" IS NOT NULL)))
);


--
-- Name: usage_meter_levels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_meter_levels" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "meter_id" "uuid" NOT NULL,
    "group_values" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "at" timestamp with time zone NOT NULL,
    "level" numeric NOT NULL,
    "active_keys" "text"[],
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL
);


--
-- Name: usage_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_records" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "subscription_item_id" "uuid",
    "public_id" "text" NOT NULL,
    "quantity" bigint NOT NULL,
    "timestamp" timestamp with time zone NOT NULL,
    "idempotency_key" "text",
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "unique_key" "text",
    "note" "text",
    "subscription_id" "uuid",
    "price_id" "uuid",
    "operation" "text" DEFAULT 'add'::"text" NOT NULL,
    CONSTRAINT "usage_records_operation_check" CHECK (("operation" = ANY (ARRAY['add'::"text", 'remove'::"text"])))
);


--
-- Name: usage_rollup_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_rollup_state" (
    "business_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "watermark" timestamp with time zone NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "rollup_version" bigint DEFAULT 0 NOT NULL
);


--
-- Name: usage_rollup_version_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE "public"."usage_rollup_version_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: usage_rollups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_rollups" (
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "meter_id" "uuid" NOT NULL,
    "bucket_start" timestamp with time zone NOT NULL,
    "group_values" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "currency" "text" DEFAULT ''::"text" NOT NULL,
    "generation" bigint NOT NULL,
    "event_count" bigint DEFAULT 0 NOT NULL,
    "value_sum" numeric DEFAULT 0 NOT NULL,
    "value_min" numeric,
    "value_max" numeric,
    "last_value" numeric,
    "last_at" timestamp with time zone,
    "last_event_id" "uuid",
    "amount_sum" numeric DEFAULT 0 NOT NULL,
    "cost_sum" numeric DEFAULT 0 NOT NULL,
    "uncosted_quantity" numeric DEFAULT 0 NOT NULL
)
PARTITION BY RANGE ("bucket_start");


--
-- Name: usage_rollups_y2026m09; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_rollups_y2026m09" (
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "meter_id" "uuid" NOT NULL,
    "bucket_start" timestamp with time zone NOT NULL,
    "group_values" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "currency" "text" DEFAULT ''::"text" NOT NULL,
    "generation" bigint NOT NULL,
    "event_count" bigint DEFAULT 0 NOT NULL,
    "value_sum" numeric DEFAULT 0 NOT NULL,
    "value_min" numeric,
    "value_max" numeric,
    "last_value" numeric,
    "last_at" timestamp with time zone,
    "last_event_id" "uuid",
    "amount_sum" numeric DEFAULT 0 NOT NULL,
    "cost_sum" numeric DEFAULT 0 NOT NULL,
    "uncosted_quantity" numeric DEFAULT 0 NOT NULL
);


--
-- Name: usage_rollups_y2026m10; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_rollups_y2026m10" (
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "meter_id" "uuid" NOT NULL,
    "bucket_start" timestamp with time zone NOT NULL,
    "group_values" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "currency" "text" DEFAULT ''::"text" NOT NULL,
    "generation" bigint NOT NULL,
    "event_count" bigint DEFAULT 0 NOT NULL,
    "value_sum" numeric DEFAULT 0 NOT NULL,
    "value_min" numeric,
    "value_max" numeric,
    "last_value" numeric,
    "last_at" timestamp with time zone,
    "last_event_id" "uuid",
    "amount_sum" numeric DEFAULT 0 NOT NULL,
    "cost_sum" numeric DEFAULT 0 NOT NULL,
    "uncosted_quantity" numeric DEFAULT 0 NOT NULL
);


--
-- Name: usage_rollups_y2026m11; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_rollups_y2026m11" (
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "meter_id" "uuid" NOT NULL,
    "bucket_start" timestamp with time zone NOT NULL,
    "group_values" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "currency" "text" DEFAULT ''::"text" NOT NULL,
    "generation" bigint NOT NULL,
    "event_count" bigint DEFAULT 0 NOT NULL,
    "value_sum" numeric DEFAULT 0 NOT NULL,
    "value_min" numeric,
    "value_max" numeric,
    "last_value" numeric,
    "last_at" timestamp with time zone,
    "last_event_id" "uuid",
    "amount_sum" numeric DEFAULT 0 NOT NULL,
    "cost_sum" numeric DEFAULT 0 NOT NULL,
    "uncosted_quantity" numeric DEFAULT 0 NOT NULL
);


--
-- Name: usage_rollups_y2026m12; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_rollups_y2026m12" (
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "meter_id" "uuid" NOT NULL,
    "bucket_start" timestamp with time zone NOT NULL,
    "group_values" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "currency" "text" DEFAULT ''::"text" NOT NULL,
    "generation" bigint NOT NULL,
    "event_count" bigint DEFAULT 0 NOT NULL,
    "value_sum" numeric DEFAULT 0 NOT NULL,
    "value_min" numeric,
    "value_max" numeric,
    "last_value" numeric,
    "last_at" timestamp with time zone,
    "last_event_id" "uuid",
    "amount_sum" numeric DEFAULT 0 NOT NULL,
    "cost_sum" numeric DEFAULT 0 NOT NULL,
    "uncosted_quantity" numeric DEFAULT 0 NOT NULL
);


--
-- Name: usage_rollups_y2027m01; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_rollups_y2027m01" (
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "meter_id" "uuid" NOT NULL,
    "bucket_start" timestamp with time zone NOT NULL,
    "group_values" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "currency" "text" DEFAULT ''::"text" NOT NULL,
    "generation" bigint NOT NULL,
    "event_count" bigint DEFAULT 0 NOT NULL,
    "value_sum" numeric DEFAULT 0 NOT NULL,
    "value_min" numeric,
    "value_max" numeric,
    "last_value" numeric,
    "last_at" timestamp with time zone,
    "last_event_id" "uuid",
    "amount_sum" numeric DEFAULT 0 NOT NULL,
    "cost_sum" numeric DEFAULT 0 NOT NULL,
    "uncosted_quantity" numeric DEFAULT 0 NOT NULL
);


--
-- Name: usage_widget_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_widget_tokens" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "token_hash" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "created_by" "text",
    "last_used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL
);


--
-- Name: user_mfa; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."user_mfa" (
    "user_id" "uuid" NOT NULL,
    "secret_enc" "text",
    "confirmed_at" timestamp with time zone,
    "recovery_codes_hashed" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_used_step" bigint,
    "last_used_at" timestamp with time zone,
    "recovery_codes_confirmed_at" timestamp with time zone,
    "totp_added_at" timestamp with time zone
);


--
-- Name: user_passkeys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."user_passkeys" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "credential_id" "text" NOT NULL,
    "public_key" "bytea" NOT NULL,
    "counter" bigint DEFAULT 0 NOT NULL,
    "transports" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "aaguid" "text",
    "name" "text" NOT NULL,
    "backed_up" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_used_at" timestamp with time zone
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."users" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "public_id" "text" NOT NULL,
    "email" "text" NOT NULL,
    "name" "text",
    "password_hash" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "failed_login_count" integer DEFAULT 0 NOT NULL,
    "locked_until" timestamp with time zone,
    "google_sub" "text",
    "email_verified_at" timestamp with time zone,
    "last_organization_id" "uuid",
    "last_login_at" timestamp with time zone,
    "last_login_ip" "inet",
    "release_notes_seen_count" integer,
    "avatar_url" "text",
    "theme" "text",
    "webauthn_user_id" "text",
    "google_picture_url" "text",
    "product_tour_seen_at" timestamp with time zone,
    CONSTRAINT "users_theme_ck" CHECK ((("theme" IS NULL) OR ("theme" = ANY (ARRAY['light'::"text", 'dark'::"text", 'system'::"text"]))))
);


--
-- Name: COLUMN "users"."password_hash"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."users"."password_hash" IS 'scrypt salt:hash. NULL means the account was invited and the invite has not been accepted — it cannot be signed into. Never seed a random hash here: that would be indistinguishable from a real account.';


--
-- Name: COLUMN "users"."failed_login_count"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."users"."failed_login_count" IS 'Consecutive failed logins. Reset to 0 on any success. Drives locked_until.';


--
-- Name: COLUMN "users"."locked_until"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."users"."locked_until" IS 'Login refused until this instant. Self-expiring on purpose — a lock only an operator can clear is a denial-of-service primitive against any known address.';


--
-- Name: COLUMN "users"."google_sub"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."users"."google_sub" IS 'Google OIDC subject claim — the stable per-account identity. Email is used only to find an invited user on first sign-in; the sub is the link thereafter.';


--
-- Name: COLUMN "users"."last_organization_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."users"."last_organization_id" IS 'Preference for which org to open next sign-in. NEVER an authorization — every reader re-checks the membership still exists.';


--
-- Name: wallet_topups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."wallet_topups" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "credit_type" "text" NOT NULL,
    "amount_minor" bigint NOT NULL,
    "currency" character(3) NOT NULL,
    "payment_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "public"."app_now"() NOT NULL,
    "metadata" "jsonb"
);


--
-- Name: webauthn_challenges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."webauthn_challenges" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "handle_hash" "text" NOT NULL,
    "purpose" "text" NOT NULL,
    "user_id" "uuid",
    "challenge" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "consumed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "webauthn_challenges_purpose_ck" CHECK (("purpose" = ANY (ARRAY['register'::"text", 'sign_in'::"text", 'second_step'::"text"]))),
    CONSTRAINT "webauthn_challenges_user_ck" CHECK ((("purpose" = 'sign_in'::"text") OR ("user_id" IS NOT NULL)))
);


--
-- Name: webhook_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."webhook_deliveries" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "event_id" "uuid" NOT NULL,
    "endpoint_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "last_attempt_at" timestamp with time zone,
    "next_attempt_at" timestamp with time zone,
    "last_response_status" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "duration_ms" integer,
    "last_error" "text",
    "business_id" "uuid"
);


--
-- Name: COLUMN "webhook_deliveries"."duration_ms"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."webhook_deliveries"."duration_ms" IS 'Wall-clock ms of the LAST delivery attempt (POST round trip). NULL = never attempted, or written before 0249.';


--
-- Name: webhook_endpoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."webhook_endpoints" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "public_id" "text" NOT NULL,
    "url" "text" NOT NULL,
    "signing_secret" "text" NOT NULL,
    "enabled" "text" DEFAULT 'true'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "business_id" "uuid",
    "event_types" "jsonb",
    "description" "text",
    "livemode" "text" DEFAULT 'test'::"text" NOT NULL,
    CONSTRAINT "webhook_endpoints_livemode_ck" CHECK (("livemode" = ANY (ARRAY['test'::"text", 'live'::"text"])))
);


--
-- Name: worker_heartbeats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."worker_heartbeats" (
    "id" "uuid" DEFAULT "public"."uuid_v7"() NOT NULL,
    "worker_id" "text" NOT NULL,
    "hostname" "text" NOT NULL,
    "pid" integer NOT NULL,
    "concurrency" integer NOT NULL,
    "tasks" "jsonb",
    "crontab" "text",
    "jobs_active" integer DEFAULT 0 NOT NULL,
    "jobs_succeeded" integer DEFAULT 0 NOT NULL,
    "jobs_failed" integer DEFAULT 0 NOT NULL,
    "started_at" timestamp with time zone NOT NULL,
    "last_beat_at" timestamp with time zone NOT NULL,
    "stopped_at" timestamp with time zone,
    "role" "text",
    "graphile_worker_ids" "text"[],
    "stopped_forced" boolean
);


--
-- Name: COLUMN "worker_heartbeats"."role"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."worker_heartbeats"."role" IS 'billing | shadow | all — which worker this process is. NULL = pre-split build.';


--
-- Name: COLUMN "worker_heartbeats"."graphile_worker_ids"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."worker_heartbeats"."graphile_worker_ids" IS 'graphile-worker in-pool worker ids owned by this process, for stranded-queue-lock detection. NULL = predates the column (sweep abstains); empty = holds none.';


--
-- Name: COLUMN "worker_heartbeats"."stopped_forced"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."worker_heartbeats"."stopped_forced" IS 'TRUE when the graceful drain timed out or threw and the process exited anyway — in-flight work may have been cut off. NULL = still running or predates the column.';


--
-- Name: usage_events_y2026m09; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_events" ATTACH PARTITION "public"."usage_events_y2026m09" FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');


--
-- Name: usage_events_y2026m10; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_events" ATTACH PARTITION "public"."usage_events_y2026m10" FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');


--
-- Name: usage_events_y2026m11; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_events" ATTACH PARTITION "public"."usage_events_y2026m11" FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');


--
-- Name: usage_events_y2026m12; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_events" ATTACH PARTITION "public"."usage_events_y2026m12" FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');


--
-- Name: usage_events_y2027m01; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_events" ATTACH PARTITION "public"."usage_events_y2027m01" FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');


--
-- Name: usage_rollups_y2026m09; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_rollups" ATTACH PARTITION "public"."usage_rollups_y2026m09" FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');


--
-- Name: usage_rollups_y2026m10; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_rollups" ATTACH PARTITION "public"."usage_rollups_y2026m10" FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');


--
-- Name: usage_rollups_y2026m11; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_rollups" ATTACH PARTITION "public"."usage_rollups_y2026m11" FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');


--
-- Name: usage_rollups_y2026m12; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_rollups" ATTACH PARTITION "public"."usage_rollups_y2026m12" FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');


--
-- Name: usage_rollups_y2027m01; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_rollups" ATTACH PARTITION "public"."usage_rollups_y2027m01" FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');


--
-- Name: invoice_line_items seq; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."invoice_line_items" ALTER COLUMN "seq" SET DEFAULT "nextval"('"public"."invoice_line_items_seq_seq"'::"regclass");


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id");


--
-- Name: api_request_logs api_request_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."api_request_logs"
    ADD CONSTRAINT "api_request_logs_pkey" PRIMARY KEY ("id");


--
-- Name: api_server_errors api_server_errors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."api_server_errors"
    ADD CONSTRAINT "api_server_errors_pkey" PRIMARY KEY ("id");


--
-- Name: applied_coupons applied_coupons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."applied_coupons"
    ADD CONSTRAINT "applied_coupons_pkey" PRIMARY KEY ("id");


--
-- Name: applied_taxes applied_taxes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."applied_taxes"
    ADD CONSTRAINT "applied_taxes_pkey" PRIMARY KEY ("id");


--
-- Name: attached_items attached_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."attached_items"
    ADD CONSTRAINT "attached_items_pkey" PRIMARY KEY ("id");


--
-- Name: audit_log_snapshots audit_log_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."audit_log_snapshots"
    ADD CONSTRAINT "audit_log_snapshots_pkey" PRIMARY KEY ("audit_id");


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id");


--
-- Name: businesses businesses_id_livemode_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."businesses"
    ADD CONSTRAINT "businesses_id_livemode_uq" UNIQUE ("id", "livemode");


--
-- Name: businesses businesses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."businesses"
    ADD CONSTRAINT "businesses_pkey" PRIMARY KEY ("id");


--
-- Name: buyer_request_rejections buyer_request_rejections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."buyer_request_rejections"
    ADD CONSTRAINT "buyer_request_rejections_pkey" PRIMARY KEY ("id");


--
-- Name: checkout_session_items checkout_session_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."checkout_session_items"
    ADD CONSTRAINT "checkout_session_items_pkey" PRIMARY KEY ("id");


--
-- Name: checkout_sessions checkout_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."checkout_sessions"
    ADD CONSTRAINT "checkout_sessions_pkey" PRIMARY KEY ("id");


--
-- Name: clock_ticks clock_ticks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."clock_ticks"
    ADD CONSTRAINT "clock_ticks_pkey" PRIMARY KEY ("id");


--
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_pkey" PRIMARY KEY ("id");


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_pkey" PRIMARY KEY ("id");


--
-- Name: countries countries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."countries"
    ADD CONSTRAINT "countries_pkey" PRIMARY KEY ("code");


--
-- Name: country_subdivision_aliases country_subdivision_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."country_subdivision_aliases"
    ADD CONSTRAINT "country_subdivision_aliases_pkey" PRIMARY KEY ("country_code", "alias");


--
-- Name: country_subdivisions country_subdivisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."country_subdivisions"
    ADD CONSTRAINT "country_subdivisions_pkey" PRIMARY KEY ("country_code", "code");


--
-- Name: coupon_item_constraints coupon_item_constraints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."coupon_item_constraints"
    ADD CONSTRAINT "coupon_item_constraints_pkey" PRIMARY KEY ("id");


--
-- Name: coupon_set_codes coupon_set_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."coupon_set_codes"
    ADD CONSTRAINT "coupon_set_codes_pkey" PRIMARY KEY ("id");


--
-- Name: coupon_sets coupon_sets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."coupon_sets"
    ADD CONSTRAINT "coupon_sets_pkey" PRIMARY KEY ("id");


--
-- Name: coupons coupons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."coupons"
    ADD CONSTRAINT "coupons_pkey" PRIMARY KEY ("id");


--
-- Name: credit_auto_topup_runs credit_auto_topup_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_auto_topup_runs"
    ADD CONSTRAINT "credit_auto_topup_runs_pkey" PRIMARY KEY ("id");


--
-- Name: credit_auto_topups credit_auto_topups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_auto_topups"
    ADD CONSTRAINT "credit_auto_topups_pkey" PRIMARY KEY ("id");


--
-- Name: credit_grant_movements credit_grant_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_grant_movements"
    ADD CONSTRAINT "credit_grant_movements_pkey" PRIMARY KEY ("id");


--
-- Name: credit_grants credit_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_grants"
    ADD CONSTRAINT "credit_grants_pkey" PRIMARY KEY ("id");


--
-- Name: credit_holds credit_holds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_holds"
    ADD CONSTRAINT "credit_holds_pkey" PRIMARY KEY ("id");


--
-- Name: credit_note_allocations credit_note_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_note_allocations"
    ADD CONSTRAINT "credit_note_allocations_pkey" PRIMARY KEY ("id");


--
-- Name: credit_note_discounts credit_note_discounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_note_discounts"
    ADD CONSTRAINT "credit_note_discounts_pkey" PRIMARY KEY ("id");


--
-- Name: credit_note_items credit_note_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_note_items"
    ADD CONSTRAINT "credit_note_items_pkey" PRIMARY KEY ("id");


--
-- Name: credit_notes credit_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_notes"
    ADD CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id");


--
-- Name: credit_units credit_units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_units"
    ADD CONSTRAINT "credit_units_pkey" PRIMARY KEY ("id");


--
-- Name: custom_field_definitions custom_field_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."custom_field_definitions"
    ADD CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id");


--
-- Name: customer_addresses customer_addresses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_addresses"
    ADD CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id");


--
-- Name: customer_limit_tier_reached customer_limit_tier_reached_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_limit_tier_reached"
    ADD CONSTRAINT "customer_limit_tier_reached_pkey" PRIMARY KEY ("id");


--
-- Name: customer_meter_billing customer_meter_billing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_meter_billing"
    ADD CONSTRAINT "customer_meter_billing_pkey" PRIMARY KEY ("customer_id", "meter_id");


--
-- Name: customer_segments customer_segments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_segments"
    ADD CONSTRAINT "customer_segments_pkey" PRIMARY KEY ("id");


--
-- Name: customer_usage_keys customer_usage_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_usage_keys"
    ADD CONSTRAINT "customer_usage_keys_pkey" PRIMARY KEY ("id");


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_pkey" PRIMARY KEY ("id");


--
-- Name: decline_rule_overrides decline_rule_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."decline_rule_overrides"
    ADD CONSTRAINT "decline_rule_overrides_pkey" PRIMARY KEY ("id");


--
-- Name: dependency_health dependency_health_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."dependency_health"
    ADD CONSTRAINT "dependency_health_pkey" PRIMARY KEY ("key");


--
-- Name: differential_prices differential_prices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."differential_prices"
    ADD CONSTRAINT "differential_prices_pkey" PRIMARY KEY ("id");


--
-- Name: disputes disputes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."disputes"
    ADD CONSTRAINT "disputes_pkey" PRIMARY KEY ("id");


--
-- Name: due_work due_work_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."due_work"
    ADD CONSTRAINT "due_work_pkey" PRIMARY KEY ("entity_id", "kind");


--
-- Name: dunning_policies dunning_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."dunning_policies"
    ADD CONSTRAINT "dunning_policies_pkey" PRIMARY KEY ("id");


--
-- Name: email_messages email_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."email_messages"
    ADD CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id");


--
-- Name: email_suppressions email_suppressions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."email_suppressions"
    ADD CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id");


--
-- Name: email_templates email_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."email_templates"
    ADD CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id");


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_pkey" PRIMARY KEY ("id");


--
-- Name: exchange_rate_history exchange_rate_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exchange_rate_history"
    ADD CONSTRAINT "exchange_rate_history_pkey" PRIMARY KEY ("id");


--
-- Name: features features_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."features"
    ADD CONSTRAINT "features_pkey" PRIMARY KEY ("id");


--
-- Name: gateway_accounts gateway_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."gateway_accounts"
    ADD CONSTRAINT "gateway_accounts_pkey" PRIMARY KEY ("id");


--
-- Name: gateway_request_logs gateway_request_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."gateway_request_logs"
    ADD CONSTRAINT "gateway_request_logs_pkey" PRIMARY KEY ("id");


--
-- Name: gateway_settlement_cursors gateway_settlement_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."gateway_settlement_cursors"
    ADD CONSTRAINT "gateway_settlement_cursors_pkey" PRIMARY KEY ("gateway_account_id");


--
-- Name: hubspot_action_executions hubspot_action_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_action_executions"
    ADD CONSTRAINT "hubspot_action_executions_pkey" PRIMARY KEY ("id");


--
-- Name: hubspot_conflicts hubspot_conflicts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_conflicts"
    ADD CONSTRAINT "hubspot_conflicts_pkey" PRIMARY KEY ("id");


--
-- Name: hubspot_connections hubspot_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_connections"
    ADD CONSTRAINT "hubspot_connections_pkey" PRIMARY KEY ("id");


--
-- Name: hubspot_links hubspot_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_links"
    ADD CONSTRAINT "hubspot_links_pkey" PRIMARY KEY ("id");


--
-- Name: hubspot_sync_items hubspot_sync_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_sync_items"
    ADD CONSTRAINT "hubspot_sync_items_pkey" PRIMARY KEY ("id");


--
-- Name: hubspot_sync_queue hubspot_sync_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_sync_queue"
    ADD CONSTRAINT "hubspot_sync_queue_pkey" PRIMARY KEY ("id");


--
-- Name: hubspot_sync_runs hubspot_sync_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_sync_runs"
    ADD CONSTRAINT "hubspot_sync_runs_pkey" PRIMARY KEY ("id");


--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id");


--
-- Name: import_records import_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."import_records"
    ADD CONSTRAINT "import_records_pkey" PRIMARY KEY ("id");


--
-- Name: imported_events imported_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."imported_events"
    ADD CONSTRAINT "imported_events_pkey" PRIMARY KEY ("id");


--
-- Name: ingest_rate_counters ingest_rate_counters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ingest_rate_counters"
    ADD CONSTRAINT "ingest_rate_counters_pkey" PRIMARY KEY ("organization_id", "window_start");


--
-- Name: integration_connections integration_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."integration_connections"
    ADD CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id");


--
-- Name: integration_deliveries integration_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."integration_deliveries"
    ADD CONSTRAINT "integration_deliveries_pkey" PRIMARY KEY ("id");


--
-- Name: invoice_line_discounts invoice_line_discounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."invoice_line_discounts"
    ADD CONSTRAINT "invoice_line_discounts_pkey" PRIMARY KEY ("id");


--
-- Name: invoice_line_items invoice_line_items_adjustment_chk; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE "public"."invoice_line_items"
    ADD CONSTRAINT "invoice_line_items_adjustment_chk" CHECK ((("adjustment" IS NULL) OR ("adjustment" = ANY (ARRAY['minimum_spend'::"text", 'commitment'::"text"])))) NOT VALID;


--
-- Name: invoice_line_items invoice_line_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."invoice_line_items"
    ADD CONSTRAINT "invoice_line_items_pkey" PRIMARY KEY ("id");


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_pkey" PRIMARY KEY ("id");


--
-- Name: job_runs job_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."job_runs"
    ADD CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id");


--
-- Name: ledger_entries ledger_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ledger_entries"
    ADD CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id");


--
-- Name: list_views list_views_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."list_views"
    ADD CONSTRAINT "list_views_pkey" PRIMARY KEY ("id");


--
-- Name: login_attempts login_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."login_attempts"
    ADD CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id");


--
-- Name: memberships memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_pkey" PRIMARY KEY ("id");


--
-- Name: metadata_key_rules metadata_key_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."metadata_key_rules"
    ADD CONSTRAINT "metadata_key_rules_pkey" PRIMARY KEY ("id");


--
-- Name: meters meters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."meters"
    ADD CONSTRAINT "meters_pkey" PRIMARY KEY ("id");


--
-- Name: metric_daily metric_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."metric_daily"
    ADD CONSTRAINT "metric_daily_pkey" PRIMARY KEY ("id");


--
-- Name: metric_windows metric_windows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."metric_windows"
    ADD CONSTRAINT "metric_windows_pkey" PRIMARY KEY ("id");


--
-- Name: mfa_reset_requests mfa_reset_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."mfa_reset_requests"
    ADD CONSTRAINT "mfa_reset_requests_pkey" PRIMARY KEY ("id");


--
-- Name: model_cost_overrides model_cost_overrides_no_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."model_cost_overrides"
    ADD CONSTRAINT "model_cost_overrides_no_overlap" EXCLUDE USING "gist" ("organization_id" WITH =, COALESCE("provider", ''::"text") WITH =, "model" WITH =, "token_type" WITH =, "currency" WITH =, "tstzrange"("effective_from", "effective_to", '[)'::"text") WITH &&);


--
-- Name: model_cost_overrides model_cost_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."model_cost_overrides"
    ADD CONSTRAINT "model_cost_overrides_pkey" PRIMARY KEY ("id");


--
-- Name: model_price_models model_price_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."model_price_models"
    ADD CONSTRAINT "model_price_models_pkey" PRIMARY KEY ("provider", "model");


--
-- Name: model_price_notices model_price_notices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."model_price_notices"
    ADD CONSTRAINT "model_price_notices_pkey" PRIMARY KEY ("id");


--
-- Name: model_prices model_prices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."model_prices"
    ADD CONSTRAINT "model_prices_pkey" PRIMARY KEY ("id");


--
-- Name: mrr_movements mrr_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."mrr_movements"
    ADD CONSTRAINT "mrr_movements_pkey" PRIMARY KEY ("id");


--
-- Name: ops_http_stats ops_http_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ops_http_stats"
    ADD CONSTRAINT "ops_http_stats_pkey" PRIMARY KEY ("id");


--
-- Name: ops_invariant_results ops_invariant_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ops_invariant_results"
    ADD CONSTRAINT "ops_invariant_results_pkey" PRIMARY KEY ("id");


--
-- Name: org_mfa_reminders org_mfa_reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."org_mfa_reminders"
    ADD CONSTRAINT "org_mfa_reminders_pkey" PRIMARY KEY ("organization_id", "user_id", "deadline");


--
-- Name: organization_retention organization_retention_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."organization_retention"
    ADD CONSTRAINT "organization_retention_pkey" PRIMARY KEY ("organization_id");


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_pkey" PRIMARY KEY ("id");


--
-- Name: auth_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."auth_tokens"
    ADD CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id");


--
-- Name: payment_attempts payment_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_attempts"
    ADD CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id");


--
-- Name: payment_instructions payment_instructions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_instructions"
    ADD CONSTRAINT "payment_instructions_pkey" PRIMARY KEY ("id");


--
-- Name: payment_intents payment_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_intents"
    ADD CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id");


--
-- Name: payment_link_items payment_link_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_link_items"
    ADD CONSTRAINT "payment_link_items_pkey" PRIMARY KEY ("id");


--
-- Name: payment_links payment_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_links"
    ADD CONSTRAINT "payment_links_pkey" PRIMARY KEY ("id");


--
-- Name: payment_method_authorizations payment_method_authorizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_method_authorizations"
    ADD CONSTRAINT "payment_method_authorizations_pkey" PRIMARY KEY ("id");


--
-- Name: payment_methods payment_methods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_methods"
    ADD CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id");


--
-- Name: payment_request_invoices payment_request_invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_request_invoices"
    ADD CONSTRAINT "payment_request_invoices_pkey" PRIMARY KEY ("request_id", "invoice_id");


--
-- Name: payment_requests payment_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_requests"
    ADD CONSTRAINT "payment_requests_pkey" PRIMARY KEY ("id");


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");


--
-- Name: plan_entitlements plan_entitlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."plan_entitlements"
    ADD CONSTRAINT "plan_entitlements_pkey" PRIMARY KEY ("id");


--
-- Name: portal_login_codes portal_login_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portal_login_codes"
    ADD CONSTRAINT "portal_login_codes_pkey" PRIMARY KEY ("id");


--
-- Name: portal_sessions portal_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portal_sessions"
    ADD CONSTRAINT "portal_sessions_pkey" PRIMARY KEY ("id");


--
-- Name: pre_debit_notices pre_debit_notices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pre_debit_notices"
    ADD CONSTRAINT "pre_debit_notices_pkey" PRIMARY KEY ("id");


--
-- Name: price_rates price_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."price_rates"
    ADD CONSTRAINT "price_rates_pkey" PRIMARY KEY ("id");


--
-- Name: prices prices_commitment_amount_minor_pos; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE "public"."prices"
    ADD CONSTRAINT "prices_commitment_amount_minor_pos" CHECK ((("commitment_amount_minor" IS NULL) OR ("commitment_amount_minor" > 0))) NOT VALID;


--
-- Name: prices prices_minimum_amount_minor_nonneg; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE "public"."prices"
    ADD CONSTRAINT "prices_minimum_amount_minor_nonneg" CHECK ((("minimum_amount_minor" IS NULL) OR ("minimum_amount_minor" >= 0))) NOT VALID;


--
-- Name: prices prices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."prices"
    ADD CONSTRAINT "prices_pkey" PRIMARY KEY ("id");


--
-- Name: product_groups product_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."product_groups"
    ADD CONSTRAINT "product_groups_pkey" PRIMARY KEY ("id");


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_pkey" PRIMARY KEY ("id");


--
-- Name: promotional_credit_movements promotional_credit_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."promotional_credit_movements"
    ADD CONSTRAINT "promotional_credit_movements_pkey" PRIMARY KEY ("id");


--
-- Name: provider_customers provider_customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."provider_customers"
    ADD CONSTRAINT "provider_customers_pkey" PRIMARY KEY ("id");


--
-- Name: provider_events provider_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."provider_events"
    ADD CONSTRAINT "provider_events_pkey" PRIMARY KEY ("id");


--
-- Name: public_rate_limit_counters public_rate_limit_counters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."public_rate_limit_counters"
    ADD CONSTRAINT "public_rate_limit_counters_pkey" PRIMARY KEY ("bucket", "window_start");


--
-- Name: rate_limit_counters rate_limit_counters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rate_limit_counters"
    ADD CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY ("api_key_id", "window_start");


--
-- Name: reason_codes reason_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."reason_codes"
    ADD CONSTRAINT "reason_codes_pkey" PRIMARY KEY ("id");


--
-- Name: receipts receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."receipts"
    ADD CONSTRAINT "receipts_pkey" PRIMARY KEY ("id");


--
-- Name: reference_data_sources reference_data_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."reference_data_sources"
    ADD CONSTRAINT "reference_data_sources_pkey" PRIMARY KEY ("source");


--
-- Name: refunds refunds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."refunds"
    ADD CONSTRAINT "refunds_pkey" PRIMARY KEY ("id");


--
-- Name: renewal_skips renewal_skips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."renewal_skips"
    ADD CONSTRAINT "renewal_skips_pkey" PRIMARY KEY ("id");


--
-- Name: report_dashboard_tiles report_dashboard_tiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."report_dashboard_tiles"
    ADD CONSTRAINT "report_dashboard_tiles_pkey" PRIMARY KEY ("id");


--
-- Name: report_dashboards report_dashboards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."report_dashboards"
    ADD CONSTRAINT "report_dashboards_pkey" PRIMARY KEY ("id");


--
-- Name: retention_defaults retention_defaults_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."retention_defaults"
    ADD CONSTRAINT "retention_defaults_pkey" PRIMARY KEY ("id");


--
-- Name: retention_events retention_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."retention_events"
    ADD CONSTRAINT "retention_events_pkey" PRIMARY KEY ("id");


--
-- Name: roles roles_org_id_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."roles"
    ADD CONSTRAINT "roles_org_id_uq" UNIQUE ("organization_id", "id");


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."roles"
    ADD CONSTRAINT "roles_pkey" PRIMARY KEY ("id");


--
-- Name: scheduled_changes scheduled_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."scheduled_changes"
    ADD CONSTRAINT "scheduled_changes_pkey" PRIMARY KEY ("id");


--
-- Name: security_events security_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."security_events"
    ADD CONSTRAINT "security_events_pkey" PRIMARY KEY ("id");


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sessions"
    ADD CONSTRAINT "sessions_pkey" PRIMARY KEY ("id");


--
-- Name: settlement_poll_schedule settlement_poll_schedule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."settlement_poll_schedule"
    ADD CONSTRAINT "settlement_poll_schedule_pkey" PRIMARY KEY ("transaction_id", "pass");


--
-- Name: signup_requests signup_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."signup_requests"
    ADD CONSTRAINT "signup_requests_pkey" PRIMARY KEY ("id");


--
-- Name: spend_limit_states spend_limit_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."spend_limit_states"
    ADD CONSTRAINT "spend_limit_states_pkey" PRIMARY KEY ("id");


--
-- Name: spend_limit_tiers spend_limit_tiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."spend_limit_tiers"
    ADD CONSTRAINT "spend_limit_tiers_pkey" PRIMARY KEY ("id");


--
-- Name: spend_limits spend_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."spend_limits"
    ADD CONSTRAINT "spend_limits_pkey" PRIMARY KEY ("id");


--
-- Name: subscription_charge_log subscription_charge_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscription_charge_log"
    ADD CONSTRAINT "subscription_charge_log_pkey" PRIMARY KEY ("id");


--
-- Name: subscription_entitlements subscription_entitlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscription_entitlements"
    ADD CONSTRAINT "subscription_entitlements_pkey" PRIMARY KEY ("id");


--
-- Name: subscription_items subscription_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscription_items"
    ADD CONSTRAINT "subscription_items_pkey" PRIMARY KEY ("id");


--
-- Name: subscriptions subscriptions_commitment_amount_minor_pos; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_commitment_amount_minor_pos" CHECK ((("commitment_amount_minor" IS NULL) OR ("commitment_amount_minor" > 0))) NOT VALID;


--
-- Name: subscriptions subscriptions_pause_source_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_pause_source_check" CHECK ((("pause_source" IS NULL) OR ("pause_source" = ANY (ARRAY['operator'::"text", 'retention_offer'::"text"])))) NOT VALID;


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id");


--
-- Name: tax_profiles tax_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tax_profiles"
    ADD CONSTRAINT "tax_profiles_pkey" PRIMARY KEY ("id");


--
-- Name: tax_rate_components tax_rate_components_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tax_rate_components"
    ADD CONSTRAINT "tax_rate_components_pkey" PRIMARY KEY ("id");


--
-- Name: tax_regions tax_regions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tax_regions"
    ADD CONSTRAINT "tax_regions_pkey" PRIMARY KEY ("id");


--
-- Name: tax_state_registrations tax_state_registrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tax_state_registrations"
    ADD CONSTRAINT "tax_state_registrations_pkey" PRIMARY KEY ("id");


--
-- Name: team_alert_recipients team_alert_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."team_alert_recipients"
    ADD CONSTRAINT "team_alert_recipients_pkey" PRIMARY KEY ("id");


--
-- Name: time_travels time_travels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."time_travels"
    ADD CONSTRAINT "time_travels_pkey" PRIMARY KEY ("id");


--
-- Name: tmtest_charges tmtest_charges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tmtest_charges"
    ADD CONSTRAINT "tmtest_charges_pkey" PRIMARY KEY ("id");


--
-- Name: tmtest_outbound tmtest_outbound_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tmtest_outbound"
    ADD CONSTRAINT "tmtest_outbound_pkey" PRIMARY KEY ("id");


--
-- Name: tmtest_vault tmtest_vault_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tmtest_vault"
    ADD CONSTRAINT "tmtest_vault_pkey" PRIMARY KEY ("id");


--
-- Name: transactions transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_pkey" PRIMARY KEY ("id");


--
-- Name: transfer_configurations transfer_configurations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transfer_configurations"
    ADD CONSTRAINT "transfer_configurations_pkey" PRIMARY KEY ("id");


--
-- Name: trusted_browsers trusted_browsers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."trusted_browsers"
    ADD CONSTRAINT "trusted_browsers_pkey" PRIMARY KEY ("id");


--
-- Name: unbilled_charges unbilled_charges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."unbilled_charges"
    ADD CONSTRAINT "unbilled_charges_pkey" PRIMARY KEY ("id");


--
-- Name: usage_alert_observations usage_alert_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_alert_observations"
    ADD CONSTRAINT "usage_alert_observations_pkey" PRIMARY KEY ("id");


--
-- Name: usage_alert_states usage_alert_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_alert_states"
    ADD CONSTRAINT "usage_alert_states_pkey" PRIMARY KEY ("id");


--
-- Name: usage_alerts usage_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_alerts"
    ADD CONSTRAINT "usage_alerts_pkey" PRIMARY KEY ("id");


--
-- Name: usage_archives usage_archives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_archives"
    ADD CONSTRAINT "usage_archives_pkey" PRIMARY KEY ("id");


--
-- Name: usage_control_cursors usage_control_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_control_cursors"
    ADD CONSTRAINT "usage_control_cursors_pkey" PRIMARY KEY ("customer_id");


--
-- Name: usage_control_dirty usage_control_dirty_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_control_dirty"
    ADD CONSTRAINT "usage_control_dirty_pkey" PRIMARY KEY ("customer_id");


--
-- Name: usage_event_dedup usage_event_dedup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_event_dedup"
    ADD CONSTRAINT "usage_event_dedup_pkey" PRIMARY KEY ("business_id", "key");


--
-- Name: usage_events usage_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_events"
    ADD CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id", "timestamp");


--
-- Name: usage_events_y2026m09 usage_events_y2026m09_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_events_y2026m09"
    ADD CONSTRAINT "usage_events_y2026m09_pkey" PRIMARY KEY ("id", "timestamp");


--
-- Name: usage_events_y2026m10 usage_events_y2026m10_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_events_y2026m10"
    ADD CONSTRAINT "usage_events_y2026m10_pkey" PRIMARY KEY ("id", "timestamp");


--
-- Name: usage_events_y2026m11 usage_events_y2026m11_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_events_y2026m11"
    ADD CONSTRAINT "usage_events_y2026m11_pkey" PRIMARY KEY ("id", "timestamp");


--
-- Name: usage_events_y2026m12 usage_events_y2026m12_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_events_y2026m12"
    ADD CONSTRAINT "usage_events_y2026m12_pkey" PRIMARY KEY ("id", "timestamp");


--
-- Name: usage_events_y2027m01 usage_events_y2027m01_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_events_y2027m01"
    ADD CONSTRAINT "usage_events_y2027m01_pkey" PRIMARY KEY ("id", "timestamp");


--
-- Name: usage_invoice_thresholds usage_invoice_thresholds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_invoice_thresholds"
    ADD CONSTRAINT "usage_invoice_thresholds_pkey" PRIMARY KEY ("id");


--
-- Name: usage_meter_levels usage_meter_levels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_meter_levels"
    ADD CONSTRAINT "usage_meter_levels_pkey" PRIMARY KEY ("id");


--
-- Name: usage_records usage_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_records"
    ADD CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id");


--
-- Name: usage_rollup_state usage_rollup_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_rollup_state"
    ADD CONSTRAINT "usage_rollup_state_pkey" PRIMARY KEY ("business_id");


--
-- Name: usage_rollups usage_rollups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_rollups"
    ADD CONSTRAINT "usage_rollups_pkey" PRIMARY KEY ("customer_id", "meter_id", "bucket_start", "group_values", "currency", "generation");


--
-- Name: usage_rollups_y2026m09 usage_rollups_y2026m09_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_rollups_y2026m09"
    ADD CONSTRAINT "usage_rollups_y2026m09_pkey" PRIMARY KEY ("customer_id", "meter_id", "bucket_start", "group_values", "currency", "generation");


--
-- Name: usage_rollups_y2026m10 usage_rollups_y2026m10_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_rollups_y2026m10"
    ADD CONSTRAINT "usage_rollups_y2026m10_pkey" PRIMARY KEY ("customer_id", "meter_id", "bucket_start", "group_values", "currency", "generation");


--
-- Name: usage_rollups_y2026m11 usage_rollups_y2026m11_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_rollups_y2026m11"
    ADD CONSTRAINT "usage_rollups_y2026m11_pkey" PRIMARY KEY ("customer_id", "meter_id", "bucket_start", "group_values", "currency", "generation");


--
-- Name: usage_rollups_y2026m12 usage_rollups_y2026m12_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_rollups_y2026m12"
    ADD CONSTRAINT "usage_rollups_y2026m12_pkey" PRIMARY KEY ("customer_id", "meter_id", "bucket_start", "group_values", "currency", "generation");


--
-- Name: usage_rollups_y2027m01 usage_rollups_y2027m01_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_rollups_y2027m01"
    ADD CONSTRAINT "usage_rollups_y2027m01_pkey" PRIMARY KEY ("customer_id", "meter_id", "bucket_start", "group_values", "currency", "generation");


--
-- Name: usage_widget_tokens usage_widget_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_widget_tokens"
    ADD CONSTRAINT "usage_widget_tokens_pkey" PRIMARY KEY ("id");


--
-- Name: user_mfa user_mfa_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."user_mfa"
    ADD CONSTRAINT "user_mfa_pkey" PRIMARY KEY ("user_id");


--
-- Name: user_passkeys user_passkeys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."user_passkeys"
    ADD CONSTRAINT "user_passkeys_pkey" PRIMARY KEY ("id");


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");


--
-- Name: wallet_topups wallet_topups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."wallet_topups"
    ADD CONSTRAINT "wallet_topups_pkey" PRIMARY KEY ("id");


--
-- Name: webauthn_challenges webauthn_challenges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."webauthn_challenges"
    ADD CONSTRAINT "webauthn_challenges_pkey" PRIMARY KEY ("id");


--
-- Name: webhook_deliveries webhook_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."webhook_deliveries"
    ADD CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id");


--
-- Name: webhook_endpoints webhook_endpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."webhook_endpoints"
    ADD CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id");


--
-- Name: worker_heartbeats worker_heartbeats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."worker_heartbeats"
    ADD CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("id");


--
-- Name: api_keys_hashed_key_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "api_keys_hashed_key_uq" ON "public"."api_keys" USING "btree" ("hashed_key");


--
-- Name: api_keys_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "api_keys_org_idx" ON "public"."api_keys" USING "btree" ("organization_id");


--
-- Name: api_keys_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "api_keys_public_id_uq" ON "public"."api_keys" USING "btree" ("public_id");


--
-- Name: api_request_logs_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "api_request_logs_customer_idx" ON "public"."api_request_logs" USING "btree" ("organization_id", "customer_id", "created_at" DESC) WHERE ("customer_id" IS NOT NULL);


--
-- Name: api_request_logs_idem_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "api_request_logs_idem_idx" ON "public"."api_request_logs" USING "btree" ("organization_id", "idempotency_key") WHERE ("idempotency_key" IS NOT NULL);


--
-- Name: api_request_logs_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "api_request_logs_org_created_idx" ON "public"."api_request_logs" USING "btree" ("organization_id", "created_at" DESC, "id" DESC);


--
-- Name: api_request_logs_trace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "api_request_logs_trace_idx" ON "public"."api_request_logs" USING "btree" ("organization_id", "trace_id") WHERE ("trace_id" IS NOT NULL);


--
-- Name: api_server_errors_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "api_server_errors_created_idx" ON "public"."api_server_errors" USING "btree" ("created_at");


--
-- Name: applied_coupons_active_manual_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "applied_coupons_active_manual_uq" ON "public"."applied_coupons" USING "btree" ("subscription_id") WHERE (("status" = 'active'::"text") AND ("source" = 'manual'::"text"));


--
-- Name: applied_coupons_active_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "applied_coupons_active_uq" ON "public"."applied_coupons" USING "btree" ("coupon_id", "subscription_id") WHERE (("status" = 'active'::"text") AND ("coupon_id" IS NOT NULL));


--
-- Name: applied_coupons_coupon_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "applied_coupons_coupon_created_idx" ON "public"."applied_coupons" USING "btree" ("coupon_id", "created_at" DESC, "public_id" DESC);


--
-- Name: applied_coupons_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "applied_coupons_public_id_uq" ON "public"."applied_coupons" USING "btree" ("public_id");


--
-- Name: applied_coupons_sub_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "applied_coupons_sub_idx" ON "public"."applied_coupons" USING "btree" ("subscription_id", "status");


--
-- Name: applied_taxes_invoice_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "applied_taxes_invoice_idx" ON "public"."applied_taxes" USING "btree" ("invoice_id");


--
-- Name: applied_taxes_line_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "applied_taxes_line_idx" ON "public"."applied_taxes" USING "btree" ("invoice_line_item_id");


--
-- Name: attached_items_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "attached_items_item_idx" ON "public"."attached_items" USING "btree" ("item_product_id");


--
-- Name: attached_items_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "attached_items_uq" ON "public"."attached_items" USING "btree" ("item_product_id", "plan_product_id");


--
-- Name: audit_logs_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "audit_logs_org_idx" ON "public"."audit_logs" USING "btree" ("organization_id", "created_at");


--
-- Name: audit_logs_resource_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "audit_logs_resource_idx" ON "public"."audit_logs" USING "btree" ("business_id", "resource_type", "resource_id");


--
-- Name: audit_logs_trace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "audit_logs_trace_idx" ON "public"."audit_logs" USING "btree" ("organization_id", "trace_id") WHERE ("trace_id" IS NOT NULL);


--
-- Name: auth_tokens_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "auth_tokens_expires_idx" ON "public"."auth_tokens" USING "btree" ("expires_at");


--
-- Name: auth_tokens_token_hash_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "auth_tokens_token_hash_uq" ON "public"."auth_tokens" USING "btree" ("token_hash");


--
-- Name: businesses_live_business_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "businesses_live_business_uq" ON "public"."businesses" USING "btree" ("live_business_id");


--
-- Name: businesses_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "businesses_org_idx" ON "public"."businesses" USING "btree" ("organization_id");


--
-- Name: businesses_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "businesses_public_id_uq" ON "public"."businesses" USING "btree" ("public_id");


--
-- Name: buyer_request_rejections_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "buyer_request_rejections_created_idx" ON "public"."buyer_request_rejections" USING "btree" ("created_at");


--
-- Name: buyer_request_rejections_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "buyer_request_rejections_session_idx" ON "public"."buyer_request_rejections" USING "btree" ("session_public_id", "created_at");


--
-- Name: checkout_session_items_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "checkout_session_items_org_idx" ON "public"."checkout_session_items" USING "btree" ("organization_id");


--
-- Name: checkout_session_items_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "checkout_session_items_session_idx" ON "public"."checkout_session_items" USING "btree" ("checkout_session_id");


--
-- Name: checkout_session_items_session_price_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "checkout_session_items_session_price_uq" ON "public"."checkout_session_items" USING "btree" ("checkout_session_id", "price_id");


--
-- Name: checkout_sessions_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "checkout_sessions_business_idx" ON "public"."checkout_sessions" USING "btree" ("business_id");


--
-- Name: checkout_sessions_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "checkout_sessions_org_idx" ON "public"."checkout_sessions" USING "btree" ("organization_id");


--
-- Name: checkout_sessions_payment_link_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "checkout_sessions_payment_link_idx" ON "public"."checkout_sessions" USING "btree" ("payment_link_id");


--
-- Name: checkout_sessions_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "checkout_sessions_public_id_uq" ON "public"."checkout_sessions" USING "btree" ("public_id");


--
-- Name: checkout_sessions_reminder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "checkout_sessions_reminder_idx" ON "public"."checkout_sessions" USING "btree" ("last_used_at") WHERE (("status" = 'open'::"text") AND ("resulting_customer_id" IS NOT NULL));


--
-- Name: checkout_sessions_resume_token_hash_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "checkout_sessions_resume_token_hash_uq" ON "public"."checkout_sessions" USING "btree" ("resume_token_hash") WHERE ("resume_token_hash" IS NOT NULL);


--
-- Name: checkout_sessions_setup_intent_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "checkout_sessions_setup_intent_uq" ON "public"."checkout_sessions" USING "btree" ("setup_payment_intent") WHERE ("setup_payment_intent" IS NOT NULL);


--
-- Name: checkout_sessions_subscription_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "checkout_sessions_subscription_idx" ON "public"."checkout_sessions" USING "btree" ("subscription_id");


--
-- Name: checkout_sessions_token_hash_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "checkout_sessions_token_hash_uq" ON "public"."checkout_sessions" USING "btree" ("token_hash");


--
-- Name: clock_ticks_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "clock_ticks_started_idx" ON "public"."clock_ticks" USING "btree" ("started_at" DESC);


--
-- Name: comments_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "comments_public_id_uq" ON "public"."comments" USING "btree" ("public_id");


--
-- Name: comments_resource_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "comments_resource_idx" ON "public"."comments" USING "btree" ("business_id", "resource_type", "resource_id", "created_at");


--
-- Name: contacts_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "contacts_customer_idx" ON "public"."contacts" USING "btree" ("customer_id");


--
-- Name: contacts_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "contacts_public_id_uq" ON "public"."contacts" USING "btree" ("public_id");


--
-- Name: country_subdivisions_country_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "country_subdivisions_country_idx" ON "public"."country_subdivisions" USING "btree" ("country_code");


--
-- Name: coupon_item_constraints_coupon_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "coupon_item_constraints_coupon_idx" ON "public"."coupon_item_constraints" USING "btree" ("coupon_id");


--
-- Name: coupon_item_constraints_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "coupon_item_constraints_uq" ON "public"."coupon_item_constraints" USING "btree" ("coupon_id", "item_kind");


--
-- Name: coupon_set_codes_code_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "coupon_set_codes_code_uq" ON "public"."coupon_set_codes" USING "btree" ("business_id", "code");


--
-- Name: coupon_set_codes_set_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "coupon_set_codes_set_idx" ON "public"."coupon_set_codes" USING "btree" ("coupon_set_id", "status");


--
-- Name: coupon_sets_biz_slug_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "coupon_sets_biz_slug_uq" ON "public"."coupon_sets" USING "btree" ("business_id", "public_id");


--
-- Name: coupon_sets_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "coupon_sets_business_idx" ON "public"."coupon_sets" USING "btree" ("business_id");


--
-- Name: coupons_code_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "coupons_code_uq" ON "public"."coupons" USING "btree" ("business_id", "code");


--
-- Name: credit_auto_topup_runs_config_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_auto_topup_runs_config_created_idx" ON "public"."credit_auto_topup_runs" USING "btree" ("config_id", "created_at" DESC);


--
-- Name: credit_auto_topup_runs_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_auto_topup_runs_customer_idx" ON "public"."credit_auto_topup_runs" USING "btree" ("customer_id", "created_at" DESC);


--
-- Name: credit_auto_topup_runs_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_auto_topup_runs_due_idx" ON "public"."credit_auto_topup_runs" USING "btree" ("status", "charge_after");


--
-- Name: credit_auto_topup_runs_invoice_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_auto_topup_runs_invoice_idx" ON "public"."credit_auto_topup_runs" USING "btree" ("invoice_id") WHERE ("invoice_id" IS NOT NULL);


--
-- Name: credit_auto_topup_runs_open_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "credit_auto_topup_runs_open_uq" ON "public"."credit_auto_topup_runs" USING "btree" ("config_id") WHERE ("status" = ANY (ARRAY['created'::"text", 'notice_sent'::"text", 'charging'::"text", 'pending'::"text"]));


--
-- Name: credit_auto_topup_runs_payment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_auto_topup_runs_payment_idx" ON "public"."credit_auto_topup_runs" USING "btree" ("payment_id") WHERE ("payment_id" IS NOT NULL);


--
-- Name: credit_auto_topup_runs_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "credit_auto_topup_runs_public_id_uq" ON "public"."credit_auto_topup_runs" USING "btree" ("public_id");


--
-- Name: credit_auto_topup_runs_trigger_key_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "credit_auto_topup_runs_trigger_key_uq" ON "public"."credit_auto_topup_runs" USING "btree" ("config_id", "trigger_key") WHERE ("trigger_key" IS NOT NULL);


--
-- Name: credit_auto_topups_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_auto_topups_active_idx" ON "public"."credit_auto_topups" USING "btree" ("business_id") WHERE ("status" = 'active'::"text");


--
-- Name: credit_auto_topups_customer_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "credit_auto_topups_customer_uq" ON "public"."credit_auto_topups" USING "btree" ("customer_id", "currency", COALESCE("unit_id", '00000000-0000-0000-0000-000000000000'::"uuid"));


--
-- Name: credit_auto_topups_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "credit_auto_topups_public_id_uq" ON "public"."credit_auto_topups" USING "btree" ("public_id");


--
-- Name: credit_grant_movements_customer_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_grant_movements_customer_created_idx" ON "public"."credit_grant_movements" USING "btree" ("customer_id", "created_at" DESC);


--
-- Name: credit_grant_movements_grant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_grant_movements_grant_idx" ON "public"."credit_grant_movements" USING "btree" ("grant_id");


--
-- Name: credit_grant_movements_invoice_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_grant_movements_invoice_idx" ON "public"."credit_grant_movements" USING "btree" ("invoice_id") WHERE ("invoice_id" IS NOT NULL);


--
-- Name: credit_grant_movements_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "credit_grant_movements_public_id_uq" ON "public"."credit_grant_movements" USING "btree" ("public_id");


--
-- Name: credit_grants_customer_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_grants_customer_live_idx" ON "public"."credit_grants" USING "btree" ("customer_id", "currency") WHERE ("status" = ANY (ARRAY['active'::"text", 'expired'::"text"]));


--
-- Name: credit_grants_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_grants_expiry_idx" ON "public"."credit_grants" USING "btree" ("expires_at") WHERE (("status" = 'active'::"text") AND ("expires_at" IS NOT NULL));


--
-- Name: credit_grants_invoice_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_grants_invoice_idx" ON "public"."credit_grants" USING "btree" ("invoice_id") WHERE ("invoice_id" IS NOT NULL);


--
-- Name: credit_grants_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_grants_pending_idx" ON "public"."credit_grants" USING "btree" ("status") WHERE ("status" = 'pending'::"text");


--
-- Name: credit_grants_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "credit_grants_public_id_uq" ON "public"."credit_grants" USING "btree" ("public_id");


--
-- Name: credit_grants_source_ref_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "credit_grants_source_ref_uq" ON "public"."credit_grants" USING "btree" ("business_id", "source", "source_ref") WHERE ("source_ref" IS NOT NULL);


--
-- Name: credit_holds_customer_held_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_holds_customer_held_idx" ON "public"."credit_holds" USING "btree" ("customer_id") WHERE ("status" = 'held'::"text");


--
-- Name: credit_holds_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_holds_expiry_idx" ON "public"."credit_holds" USING "btree" ("expires_at") WHERE ("status" = 'held'::"text");


--
-- Name: credit_holds_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "credit_holds_public_id_uq" ON "public"."credit_holds" USING "btree" ("public_id");


--
-- Name: credit_note_allocations_cn_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_note_allocations_cn_idx" ON "public"."credit_note_allocations" USING "btree" ("credit_note_id");


--
-- Name: credit_note_allocations_invoice_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_note_allocations_invoice_idx" ON "public"."credit_note_allocations" USING "btree" ("invoice_id");


--
-- Name: credit_note_discounts_cn_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_note_discounts_cn_idx" ON "public"."credit_note_discounts" USING "btree" ("credit_note_id");


--
-- Name: credit_note_items_invoice_line_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_note_items_invoice_line_idx" ON "public"."credit_note_items" USING "btree" ("invoice_line_item_id");


--
-- Name: credit_note_items_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "credit_note_items_public_id_uq" ON "public"."credit_note_items" USING "btree" ("public_id");


--
-- Name: credit_notes_business_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_notes_business_created_idx" ON "public"."credit_notes" USING "btree" ("business_id", "created_at" DESC, "public_id" DESC);


--
-- Name: credit_notes_invoice_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_notes_invoice_idx" ON "public"."credit_notes" USING "btree" ("invoice_id");


--
-- Name: credit_notes_number_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "credit_notes_number_uq" ON "public"."credit_notes" USING "btree" ("business_id", "number") WHERE ("number" IS NOT NULL);


--
-- Name: credit_notes_payout_sweep_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_notes_payout_sweep_idx" ON "public"."credit_notes" USING "btree" ("payout_attempt_at") WHERE ("refunded_minor" > "paid_out_minor");


--
-- Name: credit_notes_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "credit_notes_public_id_uq" ON "public"."credit_notes" USING "btree" ("public_id");


--
-- Name: credit_notes_refund_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_notes_refund_idx" ON "public"."credit_notes" USING "btree" ("refund_id") WHERE ("refund_id" IS NOT NULL);


--
-- Name: credit_notes_voided_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "credit_notes_voided_at_idx" ON "public"."credit_notes" USING "btree" ("business_id", "voided_at" DESC) WHERE ("voided_at" IS NOT NULL);


--
-- Name: credit_units_business_key_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "credit_units_business_key_uq" ON "public"."credit_units" USING "btree" ("business_id", "key");


--
-- Name: custom_field_defs_biz_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "custom_field_defs_biz_entity_idx" ON "public"."custom_field_definitions" USING "btree" ("business_id", "entity_type");


--
-- Name: custom_field_defs_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "custom_field_defs_public_id_uq" ON "public"."custom_field_definitions" USING "btree" ("public_id");


--
-- Name: custom_field_defs_scope_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "custom_field_defs_scope_uq" ON "public"."custom_field_definitions" USING "btree" ("business_id", "entity_type", "api_name");


--
-- Name: customer_addresses_biz_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "customer_addresses_biz_public_id_uq" ON "public"."customer_addresses" USING "btree" ("business_id", "public_id");


--
-- Name: customer_addresses_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "customer_addresses_customer_idx" ON "public"."customer_addresses" USING "btree" ("customer_id", "created_at");


--
-- Name: customer_addresses_one_default_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "customer_addresses_one_default_uq" ON "public"."customer_addresses" USING "btree" ("customer_id") WHERE ("is_default" AND ("archived_at" IS NULL));


--
-- Name: customer_limit_tier_reached_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "customer_limit_tier_reached_customer_idx" ON "public"."customer_limit_tier_reached" USING "btree" ("customer_id", "currency");


--
-- Name: customer_limit_tier_reached_tier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "customer_limit_tier_reached_tier_idx" ON "public"."customer_limit_tier_reached" USING "btree" ("tier_id");


--
-- Name: customer_limit_tier_reached_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "customer_limit_tier_reached_uq" ON "public"."customer_limit_tier_reached" USING "btree" ("customer_id", "tier_id");


--
-- Name: customer_meter_billing_meter_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "customer_meter_billing_meter_idx" ON "public"."customer_meter_billing" USING "btree" ("meter_id");


--
-- Name: customer_meter_billing_subscription_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "customer_meter_billing_subscription_idx" ON "public"."customer_meter_billing" USING "btree" ("subscription_id") WHERE ("subscription_id" IS NOT NULL);


--
-- Name: customer_segments_name_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "customer_segments_name_uq" ON "public"."customer_segments" USING "btree" ("organization_id", "business_id", "lower"("name"));


--
-- Name: customer_segments_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "customer_segments_public_id_uq" ON "public"."customer_segments" USING "btree" ("public_id");


--
-- Name: customer_segments_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "customer_segments_scope_idx" ON "public"."customer_segments" USING "btree" ("organization_id", "business_id");


--
-- Name: customer_usage_keys_business_key_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "customer_usage_keys_business_key_uq" ON "public"."customer_usage_keys" USING "btree" ("business_id", "key");


--
-- Name: customer_usage_keys_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "customer_usage_keys_customer_idx" ON "public"."customer_usage_keys" USING "btree" ("customer_id");


--
-- Name: customer_usage_keys_match_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "customer_usage_keys_match_pending_idx" ON "public"."customer_usage_keys" USING "btree" ("business_id") WHERE "match_pending";


--
-- Name: customers_biz_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "customers_biz_public_id_uq" ON "public"."customers" USING "btree" ("business_id", "public_id");


--
-- Name: customers_business_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "customers_business_created_idx" ON "public"."customers" USING "btree" ("business_id", "created_at" DESC, "public_id" DESC);


--
-- Name: customers_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "customers_business_idx" ON "public"."customers" USING "btree" ("business_id");


--
-- Name: customers_dunning_policy_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "customers_dunning_policy_idx" ON "public"."customers" USING "btree" ("dunning_policy_id") WHERE ("dunning_policy_id" IS NOT NULL);


--
-- Name: customers_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "customers_email_idx" ON "public"."customers" USING "btree" ("business_id", "email");


--
-- Name: customers_reporting_excluded_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "customers_reporting_excluded_idx" ON "public"."customers" USING "btree" ("business_id") WHERE "exclude_from_reporting";


--
-- Name: customers_search_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "customers_search_trgm_idx" ON "public"."customers" USING "gin" ("public_id" "public"."gin_trgm_ops", "email" "public"."gin_trgm_ops", "first_name" "public"."gin_trgm_ops", "last_name" "public"."gin_trgm_ops", "company" "public"."gin_trgm_ops", "phone" "public"."gin_trgm_ops");


--
-- Name: decline_rule_overrides_acct_code_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "decline_rule_overrides_acct_code_uq" ON "public"."decline_rule_overrides" USING "btree" ("business_id", "gateway_account_id", "decline_code") WHERE (("decline_code" IS NOT NULL) AND ("gateway_account_id" IS NOT NULL));


--
-- Name: decline_rule_overrides_acct_rule_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "decline_rule_overrides_acct_rule_uq" ON "public"."decline_rule_overrides" USING "btree" ("business_id", "gateway_account_id", "decline_rule_id") WHERE ("gateway_account_id" IS NOT NULL);


--
-- Name: decline_rule_overrides_biz_code_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "decline_rule_overrides_biz_code_uq" ON "public"."decline_rule_overrides" USING "btree" ("business_id", "decline_code") WHERE (("decline_code" IS NOT NULL) AND ("gateway_account_id" IS NULL));


--
-- Name: decline_rule_overrides_biz_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "decline_rule_overrides_biz_idx" ON "public"."decline_rule_overrides" USING "btree" ("business_id");


--
-- Name: decline_rule_overrides_biz_rule_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "decline_rule_overrides_biz_rule_uq" ON "public"."decline_rule_overrides" USING "btree" ("business_id", "decline_rule_id") WHERE ("gateway_account_id" IS NULL);


--
-- Name: dependency_health_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "dependency_health_open_idx" ON "public"."dependency_health" USING "btree" ("state", "next_probe_at");


--
-- Name: differential_prices_addon_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "differential_prices_addon_idx" ON "public"."differential_prices" USING "btree" ("addon_product_id");


--
-- Name: differential_prices_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "differential_prices_public_id_uq" ON "public"."differential_prices" USING "btree" ("public_id");


--
-- Name: differential_prices_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "differential_prices_uq" ON "public"."differential_prices" USING "btree" ("addon_product_id", "plan_product_id", "currency", "interval");


--
-- Name: disputes_biz_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "disputes_biz_created_idx" ON "public"."disputes" USING "btree" ("business_id", "created_at");


--
-- Name: disputes_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "disputes_org_idx" ON "public"."disputes" USING "btree" ("organization_id");


--
-- Name: disputes_payment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "disputes_payment_idx" ON "public"."disputes" USING "btree" ("payment_id") WHERE ("payment_id" IS NOT NULL);


--
-- Name: disputes_provider_dispute_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "disputes_provider_dispute_uq" ON "public"."disputes" USING "btree" ("organization_id", "provider_dispute_id");


--
-- Name: disputes_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "disputes_public_id_uq" ON "public"."disputes" USING "btree" ("public_id");


--
-- Name: disputes_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "disputes_status_idx" ON "public"."disputes" USING "btree" ("status");


--
-- Name: due_work_shard_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "due_work_shard_due_idx" ON "public"."due_work" USING "btree" ("shard", "due_at");


--
-- Name: dunning_policies_business_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "dunning_policies_business_created_idx" ON "public"."dunning_policies" USING "btree" ("business_id", "created_at" DESC, "public_id" DESC);


--
-- Name: dunning_policies_code_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "dunning_policies_code_uq" ON "public"."dunning_policies" USING "btree" ("business_id", "code") WHERE ("archived_at" IS NULL);


--
-- Name: dunning_policies_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "dunning_policies_public_id_uq" ON "public"."dunning_policies" USING "btree" ("public_id");


--
-- Name: email_messages_biz_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "email_messages_biz_created_idx" ON "public"."email_messages" USING "btree" ("business_id", "created_at");


--
-- Name: email_messages_credit_note_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "email_messages_credit_note_id_idx" ON "public"."email_messages" USING "btree" ("credit_note_id") WHERE ("credit_note_id" IS NOT NULL);


--
-- Name: email_messages_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "email_messages_customer_idx" ON "public"."email_messages" USING "btree" ("customer_id");


--
-- Name: email_messages_invoice_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "email_messages_invoice_id_idx" ON "public"."email_messages" USING "btree" ("invoice_id") WHERE ("invoice_id" IS NOT NULL);


--
-- Name: email_messages_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "email_messages_org_idx" ON "public"."email_messages" USING "btree" ("organization_id");


--
-- Name: email_messages_provider_message_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "email_messages_provider_message_id_idx" ON "public"."email_messages" USING "btree" ("provider_message_id") WHERE ("provider_message_id" IS NOT NULL);


--
-- Name: email_messages_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "email_messages_public_id_uq" ON "public"."email_messages" USING "btree" ("public_id");


--
-- Name: email_messages_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "email_messages_status_idx" ON "public"."email_messages" USING "btree" ("status", "next_attempt_at");


--
-- Name: email_suppressions_business_address_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "email_suppressions_business_address_uq" ON "public"."email_suppressions" USING "btree" ("business_id", "lower"("address"));


--
-- Name: email_templates_biz_type_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "email_templates_biz_type_uq" ON "public"."email_templates" USING "btree" ("business_id", "type");


--
-- Name: email_templates_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "email_templates_org_idx" ON "public"."email_templates" USING "btree" ("organization_id");


--
-- Name: email_templates_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "email_templates_public_id_uq" ON "public"."email_templates" USING "btree" ("public_id");


--
-- Name: events_biz_type_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "events_biz_type_created_idx" ON "public"."events" USING "btree" ("business_id", "type", "created_at");


--
-- Name: events_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "events_org_idx" ON "public"."events" USING "btree" ("organization_id");


--
-- Name: events_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "events_public_id_uq" ON "public"."events" USING "btree" ("public_id");


--
-- Name: events_resource_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "events_resource_idx" ON "public"."events" USING "btree" ("resource_type", "resource_id");


--
-- Name: events_trace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "events_trace_idx" ON "public"."events" USING "btree" ("trace_id") WHERE ("trace_id" IS NOT NULL);


--
-- Name: events_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "events_type_idx" ON "public"."events" USING "btree" ("type");


--
-- Name: exchange_rate_history_business_currency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "exchange_rate_history_business_currency_idx" ON "public"."exchange_rate_history" USING "btree" ("business_id", "currency", "effective_from");


--
-- Name: exchange_rate_history_observation_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "exchange_rate_history_observation_key" ON "public"."exchange_rate_history" USING "btree" ("business_id", "currency", "effective_from");


--
-- Name: features_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "features_business_idx" ON "public"."features" USING "btree" ("business_id");


--
-- Name: features_business_key_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "features_business_key_uq" ON "public"."features" USING "btree" ("business_id", "key");


--
-- Name: features_meter_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "features_meter_idx" ON "public"."features" USING "btree" ("meter_id") WHERE ("meter_id" IS NOT NULL);


--
-- Name: features_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "features_public_id_uq" ON "public"."features" USING "btree" ("public_id");


--
-- Name: gateway_accounts_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "gateway_accounts_business_idx" ON "public"."gateway_accounts" USING "btree" ("business_id");


--
-- Name: gateway_accounts_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "gateway_accounts_public_id_uq" ON "public"."gateway_accounts" USING "btree" ("public_id");


--
-- Name: gateway_request_logs_business_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "gateway_request_logs_business_created_idx" ON "public"."gateway_request_logs" USING "btree" ("business_id", "created_at" DESC);


--
-- Name: gateway_request_logs_span_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "gateway_request_logs_span_idx" ON "public"."gateway_request_logs" USING "btree" ("span_id") WHERE ("span_id" IS NOT NULL);


--
-- Name: gateway_request_logs_trace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "gateway_request_logs_trace_idx" ON "public"."gateway_request_logs" USING "btree" ("trace_id");


--
-- Name: hubspot_action_executions_callback_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "hubspot_action_executions_callback_uq" ON "public"."hubspot_action_executions" USING "btree" ("connection_id", "callback_id");


--
-- Name: hubspot_conflicts_list_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "hubspot_conflicts_list_idx" ON "public"."hubspot_conflicts" USING "btree" ("connection_id", "status", "created_at", "public_id");


--
-- Name: hubspot_conflicts_open_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "hubspot_conflicts_open_uq" ON "public"."hubspot_conflicts" USING "btree" ("connection_id", "local_type", "local_id", "remote_type") WHERE ("status" = 'open'::"text");


--
-- Name: hubspot_conflicts_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "hubspot_conflicts_public_id_uq" ON "public"."hubspot_conflicts" USING "btree" ("public_id");


--
-- Name: hubspot_connections_business_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "hubspot_connections_business_uq" ON "public"."hubspot_connections" USING "btree" ("business_id");


--
-- Name: hubspot_connections_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "hubspot_connections_public_id_uq" ON "public"."hubspot_connections" USING "btree" ("public_id");


--
-- Name: hubspot_connections_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "hubspot_connections_status_idx" ON "public"."hubspot_connections" USING "btree" ("status");


--
-- Name: hubspot_links_local_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "hubspot_links_local_uq" ON "public"."hubspot_links" USING "btree" ("connection_id", "local_type", "local_id", "remote_type");


--
-- Name: hubspot_links_remote_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "hubspot_links_remote_idx" ON "public"."hubspot_links" USING "btree" ("connection_id", "remote_type", "remote_id");


--
-- Name: hubspot_sync_items_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "hubspot_sync_items_run_idx" ON "public"."hubspot_sync_items" USING "btree" ("run_id", "created_at");


--
-- Name: hubspot_sync_queue_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "hubspot_sync_queue_due_idx" ON "public"."hubspot_sync_queue" USING "btree" ("connection_id", "next_attempt_at");


--
-- Name: hubspot_sync_queue_pending_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "hubspot_sync_queue_pending_uq" ON "public"."hubspot_sync_queue" USING "btree" ("connection_id", "resource_type", "resource_id") WHERE ("locked_at" IS NULL);


--
-- Name: hubspot_sync_runs_connection_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "hubspot_sync_runs_connection_started_idx" ON "public"."hubspot_sync_runs" USING "btree" ("connection_id", "started_at", "public_id");


--
-- Name: hubspot_sync_runs_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "hubspot_sync_runs_public_id_uq" ON "public"."hubspot_sync_runs" USING "btree" ("public_id");


--
-- Name: idempotency_org_key_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "idempotency_org_key_uq" ON "public"."idempotency_keys" USING "btree" ("organization_id", "key");


--
-- Name: import_records_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "import_records_business_idx" ON "public"."import_records" USING "btree" ("business_id");


--
-- Name: import_records_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "import_records_uq" ON "public"."import_records" USING "btree" ("organization_id", "source", "source_type", "source_id");


--
-- Name: imported_events_business_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "imported_events_business_time_idx" ON "public"."imported_events" USING "btree" ("business_id", "occurred_at");


--
-- Name: imported_events_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "imported_events_public_id_uq" ON "public"."imported_events" USING "btree" ("public_id");


--
-- Name: imported_events_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "imported_events_uq" ON "public"."imported_events" USING "btree" ("organization_id", "source", "source_id");


--
-- Name: ingest_rate_counters_window_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ingest_rate_counters_window_idx" ON "public"."ingest_rate_counters" USING "btree" ("window_start");


--
-- Name: integration_connections_business_provider_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "integration_connections_business_provider_uq" ON "public"."integration_connections" USING "btree" ("business_id", "provider");


--
-- Name: integration_connections_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "integration_connections_public_id_uq" ON "public"."integration_connections" USING "btree" ("public_id");


--
-- Name: integration_deliveries_connection_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "integration_deliveries_connection_idx" ON "public"."integration_deliveries" USING "btree" ("connection_id", "created_at");


--
-- Name: integration_deliveries_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "integration_deliveries_event_idx" ON "public"."integration_deliveries" USING "btree" ("event_id");


--
-- Name: integration_deliveries_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "integration_deliveries_status_idx" ON "public"."integration_deliveries" USING "btree" ("status", "next_attempt_at");


--
-- Name: invoice_line_discounts_coupon_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "invoice_line_discounts_coupon_idx" ON "public"."invoice_line_discounts" USING "btree" ("applied_coupon_id");


--
-- Name: invoice_line_discounts_invoice_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "invoice_line_discounts_invoice_idx" ON "public"."invoice_line_discounts" USING "btree" ("invoice_id");


--
-- Name: invoice_line_discounts_line_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "invoice_line_discounts_line_idx" ON "public"."invoice_line_discounts" USING "btree" ("invoice_line_item_id", "scope");


--
-- Name: invoice_line_items_invoice_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "invoice_line_items_invoice_idx" ON "public"."invoice_line_items" USING "btree" ("invoice_id");


--
-- Name: invoice_line_items_invoice_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "invoice_line_items_invoice_seq_idx" ON "public"."invoice_line_items" USING "btree" ("invoice_id", "seq");


--
-- Name: invoice_line_items_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "invoice_line_items_public_id_uq" ON "public"."invoice_line_items" USING "btree" ("public_id");


--
-- Name: invoices_awaiting_number_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "invoices_awaiting_number_idx" ON "public"."invoices" USING "btree" ("business_id", "created_at", "id") WHERE "awaiting_number";


--
-- Name: invoices_business_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "invoices_business_created_idx" ON "public"."invoices" USING "btree" ("business_id", "created_at" DESC, "public_id" DESC);


--
-- Name: invoices_business_number_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "invoices_business_number_uq" ON "public"."invoices" USING "btree" ("business_id", "number") WHERE ("number" IS NOT NULL);


--
-- Name: invoices_collect_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "invoices_collect_due_idx" ON "public"."invoices" USING "btree" ("collect_due_at") WHERE ("collect_due_at" IS NOT NULL);


--
-- Name: invoices_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "invoices_customer_idx" ON "public"."invoices" USING "btree" ("customer_id");


--
-- Name: invoices_dunning_exhausted_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "invoices_dunning_exhausted_at_idx" ON "public"."invoices" USING "btree" ("business_id", "dunning_exhausted_at") WHERE ("dunning_exhausted_at" IS NOT NULL);


--
-- Name: invoices_dunning_next_reminder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "invoices_dunning_next_reminder_idx" ON "public"."invoices" USING "btree" ("dunning_next_reminder_at") WHERE ("dunning_next_reminder_at" IS NOT NULL);


--
-- Name: invoices_opens_period_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "invoices_opens_period_uq" ON "public"."invoices" USING "btree" ("subscription_id", "period_start") WHERE ("opens_period" AND ("status" <> 'voided'::"text"));


--
-- Name: invoices_origin_token_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "invoices_origin_token_uq" ON "public"."invoices" USING "btree" ("business_id", "origin_token") WHERE ("origin_token" IS NOT NULL);


--
-- Name: invoices_po_number_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "invoices_po_number_idx" ON "public"."invoices" USING "btree" ("business_id", "po_number") WHERE ("po_number" IS NOT NULL);


--
-- Name: invoices_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "invoices_public_id_uq" ON "public"."invoices" USING "btree" ("public_id");


--
-- Name: invoices_retry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "invoices_retry_idx" ON "public"."invoices" USING "btree" ("business_id", "next_attempt_at", "public_id") WHERE (("status" = ANY (ARRAY['payment_due'::"text", 'not_paid'::"text"])) OR (("dunning_status" IS NOT NULL) AND ("status" <> 'voided'::"text")));


--
-- Name: invoices_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "invoices_status_idx" ON "public"."invoices" USING "btree" ("status");


--
-- Name: invoices_subscription_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "invoices_subscription_idx" ON "public"."invoices" USING "btree" ("subscription_id");


--
-- Name: invoices_usage_interim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "invoices_usage_interim_idx" ON "public"."invoices" USING "btree" ("subscription_id", "period_start") WHERE ("purpose" = 'usage_interim'::"text");


--
-- Name: invoices_voided_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "invoices_voided_at_idx" ON "public"."invoices" USING "btree" ("business_id", "voided_at" DESC) WHERE ("voided_at" IS NOT NULL);


--
-- Name: job_runs_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "job_runs_started_idx" ON "public"."job_runs" USING "btree" ("started_at");


--
-- Name: ledger_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ledger_business_idx" ON "public"."ledger_entries" USING "btree" ("business_id");


--
-- Name: ledger_customer_balance_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ledger_customer_balance_idx" ON "public"."ledger_entries" USING "btree" ("customer_id", "account", "currency") WHERE ("customer_id" IS NOT NULL);


--
-- Name: ledger_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ledger_org_idx" ON "public"."ledger_entries" USING "btree" ("organization_id");


--
-- Name: ledger_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ledger_source_idx" ON "public"."ledger_entries" USING "btree" ("source_type", "source_id");


--
-- Name: ledger_txn_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ledger_txn_idx" ON "public"."ledger_entries" USING "btree" ("transaction_id");


--
-- Name: list_views_default_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "list_views_default_uq" ON "public"."list_views" USING "btree" ("organization_id", COALESCE("business_id", '00000000-0000-0000-0000-000000000000'::"uuid"), "entity", "owner") WHERE "is_default";


--
-- Name: list_views_name_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "list_views_name_uq" ON "public"."list_views" USING "btree" ("organization_id", COALESCE("business_id", '00000000-0000-0000-0000-000000000000'::"uuid"), "entity", "owner", "lower"("name"));


--
-- Name: list_views_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "list_views_public_id_uq" ON "public"."list_views" USING "btree" ("public_id");


--
-- Name: list_views_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "list_views_scope_idx" ON "public"."list_views" USING "btree" ("organization_id", "business_id", "entity");


--
-- Name: login_attempts_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "login_attempts_at_idx" ON "public"."login_attempts" USING "btree" ("at" DESC);


--
-- Name: login_attempts_email_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "login_attempts_email_at_idx" ON "public"."login_attempts" USING "btree" ("email_hash", "at" DESC);


--
-- Name: login_attempts_ip_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "login_attempts_ip_at_idx" ON "public"."login_attempts" USING "btree" ("ip", "at" DESC);


--
-- Name: memberships_custom_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "memberships_custom_role_idx" ON "public"."memberships" USING "btree" ("custom_role_id") WHERE ("custom_role_id" IS NOT NULL);


--
-- Name: memberships_invite_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "memberships_invite_id_uq" ON "public"."memberships" USING "btree" ("invite_id") WHERE ("invite_id" IS NOT NULL);


--
-- Name: memberships_org_user_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "memberships_org_user_uq" ON "public"."memberships" USING "btree" ("organization_id", "user_id");


--
-- Name: metadata_key_rules_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "metadata_key_rules_public_id_uq" ON "public"."metadata_key_rules" USING "btree" ("public_id");


--
-- Name: metadata_key_rules_scope_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "metadata_key_rules_scope_uq" ON "public"."metadata_key_rules" USING "btree" ("business_id", "entity_type", "key");


--
-- Name: meters_business_event_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "meters_business_event_active_idx" ON "public"."meters" USING "btree" ("business_id", "event_name") WHERE ("status" = 'active'::"text");


--
-- Name: meters_business_key_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "meters_business_key_uq" ON "public"."meters" USING "btree" ("business_id", "key");


--
-- Name: metric_daily_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "metric_daily_key" ON "public"."metric_daily" USING "btree" ("business_id", "grain", "period_end", "measure", "dim", "dim_value", "currency");


--
-- Name: metric_daily_read_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "metric_daily_read_idx" ON "public"."metric_daily" USING "btree" ("business_id", "measure", "grain", "period_end");


--
-- Name: metric_windows_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "metric_windows_key" ON "public"."metric_windows" USING "btree" ("business_id", "period_start", "period_end", "measure", "dim", "dim_value", "currency");


--
-- Name: mfa_reset_requests_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "mfa_reset_requests_due_idx" ON "public"."mfa_reset_requests" USING "btree" ("effective_at") WHERE (("cancelled_at" IS NULL) AND ("completed_at" IS NULL));


--
-- Name: mfa_reset_requests_open_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "mfa_reset_requests_open_uq" ON "public"."mfa_reset_requests" USING "btree" ("user_id") WHERE (("cancelled_at" IS NULL) AND ("completed_at" IS NULL));


--
-- Name: mfa_reset_requests_token_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "mfa_reset_requests_token_uq" ON "public"."mfa_reset_requests" USING "btree" ("cancel_token_hash");


--
-- Name: model_cost_overrides_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "model_cost_overrides_lookup_idx" ON "public"."model_cost_overrides" USING "btree" ("organization_id", "model", "token_type", "effective_from" DESC);


--
-- Name: model_cost_overrides_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "model_cost_overrides_public_id_uq" ON "public"."model_cost_overrides" USING "btree" ("public_id");


--
-- Name: model_price_models_aliases_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "model_price_models_aliases_idx" ON "public"."model_price_models" USING "gin" ("aliases");


--
-- Name: model_price_models_model_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "model_price_models_model_idx" ON "public"."model_price_models" USING "btree" ("model");


--
-- Name: model_price_notices_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "model_price_notices_due_idx" ON "public"."model_price_notices" USING "btree" ("next_attempt_at") WHERE ("status" = 'pending'::"text");


--
-- Name: model_price_notices_org_run_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "model_price_notices_org_run_uq" ON "public"."model_price_notices" USING "btree" ("organization_id", "sync_run_id");


--
-- Name: model_prices_key_from_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "model_prices_key_from_uq" ON "public"."model_prices" USING "btree" ("provider", "model", "token_type", "currency", "effective_from");


--
-- Name: model_prices_model_token_from_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "model_prices_model_token_from_idx" ON "public"."model_prices" USING "btree" ("model", "token_type", "effective_from" DESC);


--
-- Name: model_prices_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "model_prices_public_id_uq" ON "public"."model_prices" USING "btree" ("public_id");


--
-- Name: model_prices_sync_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "model_prices_sync_run_idx" ON "public"."model_prices" USING "btree" ("sync_run_id");


--
-- Name: mrr_movement_summary_mv_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "mrr_movement_summary_mv_key" ON "public"."mrr_movement_summary_mv" USING "btree" ("business_id", "period_month", "currency", "column_key", "delta_minor");


--
-- Name: mrr_movements_business_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "mrr_movements_business_created_idx" ON "public"."mrr_movements" USING "btree" ("business_id", "created_at");


--
-- Name: mrr_movements_business_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "mrr_movements_business_occurred_idx" ON "public"."mrr_movements" USING "btree" ("business_id", "occurred_at");


--
-- Name: mrr_movements_business_plan_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "mrr_movements_business_plan_idx" ON "public"."mrr_movements" USING "btree" ("business_id", "plan_product_id", "occurred_at");


--
-- Name: mrr_movements_business_plan_pair_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "mrr_movements_business_plan_pair_idx" ON "public"."mrr_movements" USING "btree" ("business_id", "previous_plan_product_id", "plan_product_id", "occurred_at");


--
-- Name: mrr_movements_net_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "mrr_movements_net_idx" ON "public"."mrr_movements" USING "btree" ("business_id", "subscription_id", "occurred_at", "reason");


--
-- Name: mrr_movements_subscription_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "mrr_movements_subscription_idx" ON "public"."mrr_movements" USING "btree" ("subscription_id", "occurred_at");


--
-- Name: ops_http_stats_bucket_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ops_http_stats_bucket_idx" ON "public"."ops_http_stats" USING "btree" ("bucket_started_at" DESC);


--
-- Name: ops_http_stats_route_bucket_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ops_http_stats_route_bucket_idx" ON "public"."ops_http_stats" USING "btree" ("route", "bucket_started_at" DESC);


--
-- Name: ops_invariant_results_key_ran_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ops_invariant_results_key_ran_idx" ON "public"."ops_invariant_results" USING "btree" ("check_key", "ran_at" DESC);


--
-- Name: organizations_is_platform_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "organizations_is_platform_idx" ON "public"."organizations" USING "btree" ("is_platform") WHERE ("is_platform" = true);


--
-- Name: organizations_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "organizations_public_id_uq" ON "public"."organizations" USING "btree" ("public_id");


--
-- Name: payment_attempts_business_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payment_attempts_business_created_idx" ON "public"."payment_attempts" USING "btree" ("business_id", "created_at" DESC, "public_id" DESC);


--
-- Name: payment_attempts_intent_number_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "payment_attempts_intent_number_uq" ON "public"."payment_attempts" USING "btree" ("payment_intent_id", "attempt_number");


--
-- Name: payment_attempts_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "payment_attempts_public_id_uq" ON "public"."payment_attempts" USING "btree" ("public_id");


--
-- Name: payment_attempts_span_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payment_attempts_span_idx" ON "public"."payment_attempts" USING "btree" ("span_id") WHERE ("span_id" IS NOT NULL);


--
-- Name: payment_attempts_trace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payment_attempts_trace_idx" ON "public"."payment_attempts" USING "btree" ("trace_id");


--
-- Name: payment_instructions_biz_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payment_instructions_biz_idx" ON "public"."payment_instructions" USING "btree" ("business_id", "position");


--
-- Name: payment_instructions_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "payment_instructions_public_id_uq" ON "public"."payment_instructions" USING "btree" ("public_id");


--
-- Name: payment_intents_business_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payment_intents_business_created_idx" ON "public"."payment_intents" USING "btree" ("business_id", "created_at" DESC, "public_id" DESC);


--
-- Name: payment_intents_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payment_intents_business_idx" ON "public"."payment_intents" USING "btree" ("business_id");


--
-- Name: payment_intents_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payment_intents_expiry_idx" ON "public"."payment_intents" USING "btree" ("status", "expires_at");


--
-- Name: payment_intents_gateway_intent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payment_intents_gateway_intent_idx" ON "public"."payment_intents" USING "btree" ("intent_at_gateway") WHERE ("intent_at_gateway" IS NOT NULL);


--
-- Name: payment_intents_invoice_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payment_intents_invoice_idx" ON "public"."payment_intents" USING "btree" ("invoice_id");


--
-- Name: payment_intents_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "payment_intents_public_id_uq" ON "public"."payment_intents" USING "btree" ("public_id");


--
-- Name: payment_intents_subscription_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payment_intents_subscription_idx" ON "public"."payment_intents" USING "btree" ("subscription_id");


--
-- Name: payment_link_items_link_price_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "payment_link_items_link_price_uq" ON "public"."payment_link_items" USING "btree" ("payment_link_id", "price_id");


--
-- Name: payment_links_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payment_links_business_idx" ON "public"."payment_links" USING "btree" ("business_id", "created_at");


--
-- Name: payment_links_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "payment_links_public_id_uq" ON "public"."payment_links" USING "btree" ("public_id");


--
-- Name: payment_method_authorizations_pm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payment_method_authorizations_pm_idx" ON "public"."payment_method_authorizations" USING "btree" ("payment_method_id", "accepted_at");


--
-- Name: payment_method_authorizations_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "payment_method_authorizations_public_id_uq" ON "public"."payment_method_authorizations" USING "btree" ("public_id");


--
-- Name: payment_methods_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payment_methods_customer_idx" ON "public"."payment_methods" USING "btree" ("customer_id");


--
-- Name: payment_methods_expiry_sweep_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payment_methods_expiry_sweep_idx" ON "public"."payment_methods" USING "btree" ("exp_year", "exp_month") WHERE ("status" = ANY (ARRAY['valid'::"text", 'expiring'::"text"]));


--
-- Name: payment_methods_instrument_fingerprint_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payment_methods_instrument_fingerprint_idx" ON "public"."payment_methods" USING "btree" ("organization_id", "instrument_fingerprint") WHERE ("instrument_fingerprint" IS NOT NULL);


--
-- Name: payment_methods_mandate_sweep_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payment_methods_mandate_sweep_idx" ON "public"."payment_methods" USING "btree" ("mandate_expires_at") WHERE (("status" = ANY (ARRAY['valid'::"text", 'expiring'::"text"])) AND ("mandate_expires_at" IS NOT NULL));


--
-- Name: payment_methods_provider_pm_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "payment_methods_provider_pm_uq" ON "public"."payment_methods" USING "btree" ("customer_id", "provider_key", "provider_payment_method_id");


--
-- Name: INDEX "payment_methods_provider_pm_uq"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX "public"."payment_methods_provider_pm_uq" IS 'One row per provider-side instrument. Two paths vault the same token (the buyer''s browser and the setup-intent webhook harvest) — this is what makes the second one a no-op instead of a duplicate payment method.';


--
-- Name: payment_methods_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "payment_methods_public_id_uq" ON "public"."payment_methods" USING "btree" ("public_id");


--
-- Name: payment_request_invoices_open_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "payment_request_invoices_open_uq" ON "public"."payment_request_invoices" USING "btree" ("invoice_id") WHERE ("state" = 'open'::"text");


--
-- Name: payment_requests_business_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payment_requests_business_created_idx" ON "public"."payment_requests" USING "btree" ("business_id", "created_at" DESC, "public_id" DESC);


--
-- Name: payment_requests_charge_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "payment_requests_charge_uq" ON "public"."payment_requests" USING "btree" ("business_id", "provider_charge_id") WHERE (("provider_charge_id" IS NOT NULL) AND ("provider_charge_id" <> ''::"text"));


--
-- Name: payment_requests_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payment_requests_customer_idx" ON "public"."payment_requests" USING "btree" ("customer_id", "created_at" DESC);


--
-- Name: payment_requests_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payment_requests_expiry_idx" ON "public"."payment_requests" USING "btree" ("expires_at") WHERE ("status" = 'open'::"text");


--
-- Name: payment_requests_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "payment_requests_public_id_uq" ON "public"."payment_requests" USING "btree" ("public_id");


--
-- Name: payments_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payments_customer_idx" ON "public"."payments" USING "btree" ("customer_id");


--
-- Name: payments_invoice_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payments_invoice_idx" ON "public"."payments" USING "btree" ("invoice_id");


--
-- Name: payments_payment_method_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payments_payment_method_idx" ON "public"."payments" USING "btree" ("payment_method_id") WHERE ("payment_method_id" IS NOT NULL);


--
-- Name: payments_payment_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "payments_payment_request_idx" ON "public"."payments" USING "btree" ("payment_request_id") WHERE ("payment_request_id" IS NOT NULL);


--
-- Name: payments_provider_charge_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "payments_provider_charge_uq" ON "public"."payments" USING "btree" ("business_id", "provider_charge_id") WHERE (("provider_charge_id" IS NOT NULL) AND ("provider_charge_id" <> ''::"text") AND ("provider_key" <> 'offline'::"text"));


--
-- Name: INDEX "payments_provider_charge_uq"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX "public"."payments_provider_charge_uq" IS 'One gateway charge books at most one payment. Backstop for concurrent collectors whose idempotency keys agreed, so the gateway deduplicated but we booked twice.';


--
-- Name: payments_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "payments_public_id_uq" ON "public"."payments" USING "btree" ("public_id");


--
-- Name: plan_entitlements_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "plan_entitlements_business_idx" ON "public"."plan_entitlements" USING "btree" ("business_id");


--
-- Name: plan_entitlements_product_feature_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "plan_entitlements_product_feature_uq" ON "public"."plan_entitlements" USING "btree" ("product_id", "feature_id");


--
-- Name: plan_entitlements_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "plan_entitlements_public_id_uq" ON "public"."plan_entitlements" USING "btree" ("public_id");


--
-- Name: portal_login_codes_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "portal_login_codes_lookup_idx" ON "public"."portal_login_codes" USING "btree" ("business_id", "email_hash", "created_at");


--
-- Name: portal_sessions_access_token_hash_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "portal_sessions_access_token_hash_uq" ON "public"."portal_sessions" USING "btree" ("access_token_hash");


--
-- Name: portal_sessions_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "portal_sessions_customer_idx" ON "public"."portal_sessions" USING "btree" ("customer_id");


--
-- Name: portal_sessions_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "portal_sessions_org_idx" ON "public"."portal_sessions" USING "btree" ("organization_id");


--
-- Name: portal_sessions_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "portal_sessions_public_id_uq" ON "public"."portal_sessions" USING "btree" ("public_id");


--
-- Name: portal_sessions_token_hash_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "portal_sessions_token_hash_uq" ON "public"."portal_sessions" USING "btree" ("token_hash");


--
-- Name: pre_debit_notices_idem_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "pre_debit_notices_idem_uq" ON "public"."pre_debit_notices" USING "btree" ("business_id", "idempotency_key");


--
-- Name: pre_debit_notices_pm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "pre_debit_notices_pm_idx" ON "public"."pre_debit_notices" USING "btree" ("payment_method_id", "purpose", "created_at" DESC);


--
-- Name: pre_debit_notices_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "pre_debit_notices_public_id_uq" ON "public"."pre_debit_notices" USING "btree" ("public_id");


--
-- Name: pre_debit_notices_ref_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "pre_debit_notices_ref_idx" ON "public"."pre_debit_notices" USING "btree" ("gateway_account_id", "notification_ref");


--
-- Name: price_rates_price_match_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "price_rates_price_match_uq" ON "public"."price_rates" USING "btree" ("price_id", "match");


--
-- Name: prices_biz_slug_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "prices_biz_slug_uq" ON "public"."prices" USING "btree" ("business_id", "public_id");


--
-- Name: prices_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "prices_business_idx" ON "public"."prices" USING "btree" ("business_id");


--
-- Name: prices_meter_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "prices_meter_idx" ON "public"."prices" USING "btree" ("meter_id") WHERE ("meter_id" IS NOT NULL);


--
-- Name: prices_product_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "prices_product_idx" ON "public"."prices" USING "btree" ("product_id");


--
-- Name: product_groups_biz_slug_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "product_groups_biz_slug_uq" ON "public"."product_groups" USING "btree" ("business_id", "public_id");


--
-- Name: product_groups_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "product_groups_business_idx" ON "public"."product_groups" USING "btree" ("business_id");


--
-- Name: products_biz_slug_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "products_biz_slug_uq" ON "public"."products" USING "btree" ("business_id", "public_id");


--
-- Name: products_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "products_business_idx" ON "public"."products" USING "btree" ("business_id");


--
-- Name: products_tax_profile_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "products_tax_profile_idx" ON "public"."products" USING "btree" ("tax_profile_id");


--
-- Name: promotional_credit_movements_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "promotional_credit_movements_customer_idx" ON "public"."promotional_credit_movements" USING "btree" ("customer_id");


--
-- Name: promotional_credit_movements_txn_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "promotional_credit_movements_txn_uq" ON "public"."promotional_credit_movements" USING "btree" ("ledger_transaction_id");


--
-- Name: provider_customers_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "provider_customers_customer_idx" ON "public"."provider_customers" USING "btree" ("customer_id");


--
-- Name: provider_customers_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "provider_customers_org_idx" ON "public"."provider_customers" USING "btree" ("organization_id");


--
-- Name: provider_customers_scope_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "provider_customers_scope_uq" ON "public"."provider_customers" USING "btree" ("customer_id", "provider_key", "gateway_account_id");


--
-- Name: provider_events_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "provider_events_business_idx" ON "public"."provider_events" USING "btree" ("business_id");


--
-- Name: provider_events_business_received_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "provider_events_business_received_idx" ON "public"."provider_events" USING "btree" ("business_id", "received_at" DESC, "id" DESC);


--
-- Name: provider_events_business_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "provider_events_business_uq" ON "public"."provider_events" USING "btree" ("provider_key", "business_id", "provider_event_id") NULLS NOT DISTINCT;


--
-- Name: provider_events_error_received_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "provider_events_error_received_idx" ON "public"."provider_events" USING "btree" ("received_at") WHERE ("outcome" = 'error'::"text");


--
-- Name: public_rate_limit_counters_window_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "public_rate_limit_counters_window_idx" ON "public"."public_rate_limit_counters" USING "btree" ("window_start");


--
-- Name: rate_limit_counters_window_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "rate_limit_counters_window_idx" ON "public"."rate_limit_counters" USING "btree" ("window_start");


--
-- Name: reason_codes_biz_applies_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "reason_codes_biz_applies_idx" ON "public"."reason_codes" USING "btree" ("business_id", "applies_to");


--
-- Name: reason_codes_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "reason_codes_public_id_uq" ON "public"."reason_codes" USING "btree" ("public_id");


--
-- Name: reason_codes_scope_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "reason_codes_scope_uq" ON "public"."reason_codes" USING "btree" ("business_id", "applies_to", "code");


--
-- Name: receipts_business_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "receipts_business_created_idx" ON "public"."receipts" USING "btree" ("business_id", "created_at" DESC, "public_id" DESC);


--
-- Name: receipts_business_number_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "receipts_business_number_uq" ON "public"."receipts" USING "btree" ("business_id", "number") WHERE ("number" IS NOT NULL);


--
-- Name: receipts_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "receipts_customer_idx" ON "public"."receipts" USING "btree" ("customer_id", "created_at" DESC);


--
-- Name: receipts_payment_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "receipts_payment_uq" ON "public"."receipts" USING "btree" ("payment_id") WHERE ("payment_id" IS NOT NULL);


--
-- Name: receipts_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "receipts_public_id_uq" ON "public"."receipts" USING "btree" ("public_id");


--
-- Name: receipts_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "receipts_request_idx" ON "public"."receipts" USING "btree" ("payment_request_id") WHERE ("payment_request_id" IS NOT NULL);


--
-- Name: receipts_transaction_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "receipts_transaction_uq" ON "public"."receipts" USING "btree" ("transaction_id") WHERE ("transaction_id" IS NOT NULL);


--
-- Name: receipts_unnumbered_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "receipts_unnumbered_idx" ON "public"."receipts" USING "btree" ("business_id", "created_at") WHERE ("number" IS NULL);


--
-- Name: refunds_payment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "refunds_payment_idx" ON "public"."refunds" USING "btree" ("payment_id");


--
-- Name: refunds_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "refunds_public_id_uq" ON "public"."refunds" USING "btree" ("public_id");


--
-- Name: renewal_skips_live_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "renewal_skips_live_uq" ON "public"."renewal_skips" USING "btree" ("subscription_id", "renewal_at") WHERE ("status" = ANY (ARRAY['scheduled'::"text", 'applied'::"text"]));


--
-- Name: renewal_skips_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "renewal_skips_public_id_uq" ON "public"."renewal_skips" USING "btree" ("public_id");


--
-- Name: renewal_skips_sub_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "renewal_skips_sub_idx" ON "public"."renewal_skips" USING "btree" ("subscription_id", "renewal_at");


--
-- Name: report_dashboard_tiles_dashboard_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "report_dashboard_tiles_dashboard_idx" ON "public"."report_dashboard_tiles" USING "btree" ("dashboard_id", "position");


--
-- Name: report_dashboard_tiles_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "report_dashboard_tiles_public_id_uq" ON "public"."report_dashboard_tiles" USING "btree" ("public_id");


--
-- Name: report_dashboards_default_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "report_dashboards_default_uq" ON "public"."report_dashboards" USING "btree" ("organization_id", COALESCE("business_id", '00000000-0000-0000-0000-000000000000'::"uuid"), "owner") WHERE "is_default";


--
-- Name: report_dashboards_name_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "report_dashboards_name_uq" ON "public"."report_dashboards" USING "btree" ("organization_id", COALESCE("business_id", '00000000-0000-0000-0000-000000000000'::"uuid"), "owner", "lower"("name"));


--
-- Name: report_dashboards_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "report_dashboards_public_id_uq" ON "public"."report_dashboards" USING "btree" ("public_id");


--
-- Name: report_dashboards_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "report_dashboards_scope_idx" ON "public"."report_dashboards" USING "btree" ("organization_id", "business_id");


--
-- Name: retention_events_business_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "retention_events_business_created_idx" ON "public"."retention_events" USING "btree" ("business_id", "created_at");


--
-- Name: retention_events_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "retention_events_customer_idx" ON "public"."retention_events" USING "btree" ("customer_id", "kind");


--
-- Name: roles_org_name_key_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "roles_org_name_key_uq" ON "public"."roles" USING "btree" ("organization_id", "name_key") WHERE ("deleted_at" IS NULL);


--
-- Name: roles_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "roles_public_id_uq" ON "public"."roles" USING "btree" ("public_id");


--
-- Name: scheduled_changes_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "scheduled_changes_due_idx" ON "public"."scheduled_changes" USING "btree" ("status", "effective_at");


--
-- Name: scheduled_changes_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "scheduled_changes_public_id_uq" ON "public"."scheduled_changes" USING "btree" ("public_id");


--
-- Name: scheduled_changes_sub_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "scheduled_changes_sub_idx" ON "public"."scheduled_changes" USING "btree" ("subscription_id");


--
-- Name: security_events_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "security_events_at_idx" ON "public"."security_events" USING "btree" ("at");


--
-- Name: security_events_user_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "security_events_user_at_idx" ON "public"."security_events" USING "btree" ("user_id", "at" DESC);


--
-- Name: sessions_token_hash_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "public"."sessions" USING "btree" ("token_hash");


--
-- Name: sessions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "sessions_user_idx" ON "public"."sessions" USING "btree" ("user_id");


--
-- Name: settlement_poll_schedule_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "settlement_poll_schedule_due_idx" ON "public"."settlement_poll_schedule" USING "btree" ("pass", "next_at");


--
-- Name: signup_requests_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "signup_requests_created_idx" ON "public"."signup_requests" USING "btree" ("created_at" DESC);


--
-- Name: signup_requests_open_email_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "signup_requests_open_email_uq" ON "public"."signup_requests" USING "btree" ("email") WHERE ("status" = 'pending'::"text");


--
-- Name: signup_requests_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "signup_requests_public_id_uq" ON "public"."signup_requests" USING "btree" ("public_id");


--
-- Name: spend_limit_states_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "spend_limit_states_uq" ON "public"."spend_limit_states" USING "btree" ("limit_id", "subject_key", "interval_start");


--
-- Name: spend_limit_tiers_level_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "spend_limit_tiers_level_uq" ON "public"."spend_limit_tiers" USING "btree" ("business_id", "currency", "level_minor") WHERE "active";


--
-- Name: spend_limit_tiers_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "spend_limit_tiers_public_id_uq" ON "public"."spend_limit_tiers" USING "btree" ("public_id");


--
-- Name: spend_limits_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "spend_limits_public_id_uq" ON "public"."spend_limits" USING "btree" ("public_id");


--
-- Name: spend_limits_subject_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "spend_limits_subject_uq" ON "public"."spend_limits" USING "btree" ("customer_id", "scope", COALESCE("subscription_id", '00000000-0000-0000-0000-000000000000'::"uuid"), COALESCE("property_key", ''::"text"), COALESCE("property_value", ''::"text"), (("property_value" IS NULL)), "interval", "mode", "set_by") WHERE "active";


--
-- Name: subscription_charge_log_sub_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "subscription_charge_log_sub_idx" ON "public"."subscription_charge_log" USING "btree" ("subscription_id");


--
-- Name: subscription_charge_log_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "subscription_charge_log_uq" ON "public"."subscription_charge_log" USING "btree" ("subscription_id", "item_product_id", "charge_event");


--
-- Name: subscription_entitlements_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "subscription_entitlements_business_idx" ON "public"."subscription_entitlements" USING "btree" ("business_id");


--
-- Name: subscription_entitlements_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "subscription_entitlements_public_id_uq" ON "public"."subscription_entitlements" USING "btree" ("public_id");


--
-- Name: subscription_entitlements_sub_feature_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "subscription_entitlements_sub_feature_uq" ON "public"."subscription_entitlements" USING "btree" ("subscription_id", "feature_id");


--
-- Name: subscription_items_mandatory_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "subscription_items_mandatory_uq" ON "public"."subscription_items" USING "btree" ("subscription_id", "price_id") WHERE (("metadata" ->> 'auto_included'::"text") = 'mandatory'::"text");


--
-- Name: subscription_items_next_credit_reset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "subscription_items_next_credit_reset_idx" ON "public"."subscription_items" USING "btree" ("next_credit_reset_at") WHERE ("next_credit_reset_at" IS NOT NULL);


--
-- Name: subscription_items_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "subscription_items_public_id_uq" ON "public"."subscription_items" USING "btree" ("public_id");


--
-- Name: subscription_items_sub_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "subscription_items_sub_idx" ON "public"."subscription_items" USING "btree" ("subscription_id");


--
-- Name: subscriptions_biz_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "subscriptions_biz_public_id_uq" ON "public"."subscriptions" USING "btree" ("business_id", "public_id");


--
-- Name: subscriptions_business_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "subscriptions_business_created_idx" ON "public"."subscriptions" USING "btree" ("business_id", "created_at" DESC, "public_id" DESC);


--
-- Name: subscriptions_business_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "subscriptions_business_due_idx" ON "public"."subscriptions" USING "btree" ("business_id", "status", "current_period_end") WHERE ("deleted_at" IS NULL);


--
-- Name: subscriptions_business_sub_period_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "subscriptions_business_sub_period_due_idx" ON "public"."subscriptions" USING "btree" ("business_id", "current_sub_period_end") WHERE (("current_sub_period_end" IS NOT NULL) AND ("deleted_at" IS NULL));


--
-- Name: subscriptions_business_trial_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "subscriptions_business_trial_due_idx" ON "public"."subscriptions" USING "btree" ("business_id", "status", "trial_end") WHERE ("deleted_at" IS NULL);


--
-- Name: subscriptions_cancel_scheduled_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "subscriptions_cancel_scheduled_at_idx" ON "public"."subscriptions" USING "btree" ("cancel_scheduled_at") WHERE ("cancel_scheduled_at" IS NOT NULL);


--
-- Name: subscriptions_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "subscriptions_customer_idx" ON "public"."subscriptions" USING "btree" ("customer_id");


--
-- Name: subscriptions_deleted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "subscriptions_deleted_idx" ON "public"."subscriptions" USING "btree" ("business_id", "deleted_at") WHERE ("deleted_at" IS NOT NULL);


--
-- Name: subscriptions_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "subscriptions_due_idx" ON "public"."subscriptions" USING "btree" ("status", "current_period_end");


--
-- Name: subscriptions_trial_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "subscriptions_trial_due_idx" ON "public"."subscriptions" USING "btree" ("status", "trial_end");


--
-- Name: tax_profiles_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "tax_profiles_business_idx" ON "public"."tax_profiles" USING "btree" ("business_id");


--
-- Name: tax_profiles_name_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "tax_profiles_name_uq" ON "public"."tax_profiles" USING "btree" ("business_id", "name");


--
-- Name: tax_profiles_one_default_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "tax_profiles_one_default_uq" ON "public"."tax_profiles" USING "btree" ("business_id") WHERE "is_default";


--
-- Name: tax_profiles_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "tax_profiles_public_id_uq" ON "public"."tax_profiles" USING "btree" ("public_id");


--
-- Name: tax_rate_components_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "tax_rate_components_public_id_uq" ON "public"."tax_rate_components" USING "btree" ("public_id");


--
-- Name: tax_rate_components_region_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "tax_rate_components_region_idx" ON "public"."tax_rate_components" USING "btree" ("tax_region_id", "state_code");


--
-- Name: tax_rate_components_region_state_name_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "tax_rate_components_region_state_name_uq" ON "public"."tax_rate_components" USING "btree" ("tax_region_id", COALESCE("state_code", ''::"text"), "name");


--
-- Name: tax_regions_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "tax_regions_lookup_idx" ON "public"."tax_regions" USING "btree" ("business_id", "country");


--
-- Name: tax_regions_profile_country_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "tax_regions_profile_country_uq" ON "public"."tax_regions" USING "btree" ("tax_profile_id", "country");


--
-- Name: tax_regions_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "tax_regions_public_id_uq" ON "public"."tax_regions" USING "btree" ("public_id");


--
-- Name: tax_state_registrations_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "tax_state_registrations_public_id_uq" ON "public"."tax_state_registrations" USING "btree" ("public_id");


--
-- Name: tax_state_registrations_region_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "tax_state_registrations_region_idx" ON "public"."tax_state_registrations" USING "btree" ("tax_region_id");


--
-- Name: tax_state_registrations_state_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "tax_state_registrations_state_uq" ON "public"."tax_state_registrations" USING "btree" ("tax_region_id", "state_code");


--
-- Name: team_alert_recipients_biz_email_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "team_alert_recipients_biz_email_uq" ON "public"."team_alert_recipients" USING "btree" ("business_id", "email");


--
-- Name: team_alert_recipients_email_sent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "team_alert_recipients_email_sent_idx" ON "public"."team_alert_recipients" USING "btree" ("email", "last_sent_at");


--
-- Name: team_alert_recipients_token_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "team_alert_recipients_token_uq" ON "public"."team_alert_recipients" USING "btree" ("token_hash") WHERE ("token_hash" IS NOT NULL);


--
-- Name: time_travels_business_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "time_travels_business_uq" ON "public"."time_travels" USING "btree" ("business_id");


--
-- Name: tmtest_charges_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "tmtest_charges_business_idx" ON "public"."tmtest_charges" USING "btree" ("business_id");


--
-- Name: tmtest_charges_charge_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "tmtest_charges_charge_id_uq" ON "public"."tmtest_charges" USING "btree" ("charge_id");


--
-- Name: tmtest_charges_idem_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "tmtest_charges_idem_uq" ON "public"."tmtest_charges" USING "btree" ("business_id", "idempotency_key") WHERE ("idempotency_key" IS NOT NULL);


--
-- Name: tmtest_outbound_event_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "tmtest_outbound_event_id_uq" ON "public"."tmtest_outbound" USING "btree" ("event_id");


--
-- Name: tmtest_outbound_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "tmtest_outbound_pending_idx" ON "public"."tmtest_outbound" USING "btree" ("deliver_after");


--
-- Name: tmtest_vault_vault_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "tmtest_vault_vault_id_uq" ON "public"."tmtest_vault" USING "btree" ("vault_id");


--
-- Name: transactions_business_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "transactions_business_created_idx" ON "public"."transactions" USING "btree" ("business_id", "created_at" DESC, "public_id" DESC);


--
-- Name: transactions_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "transactions_business_idx" ON "public"."transactions" USING "btree" ("business_id");


--
-- Name: transactions_business_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "transactions_business_occurred_idx" ON "public"."transactions" USING "btree" ("business_id", "occurred_at");


--
-- Name: transactions_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "transactions_customer_idx" ON "public"."transactions" USING "btree" ("customer_id");


--
-- Name: transactions_gateway_charge_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "transactions_gateway_charge_idx" ON "public"."transactions" USING "btree" ("id_at_gateway");


--
-- Name: transactions_invoice_failure_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "transactions_invoice_failure_idx" ON "public"."transactions" USING "btree" ("business_id", "invoice_id", "occurred_at" DESC) WHERE ("status" = 'failure'::"text");


--
-- Name: transactions_invoice_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "transactions_invoice_idx" ON "public"."transactions" USING "btree" ("invoice_id");


--
-- Name: transactions_lost_answer_ref_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "transactions_lost_answer_ref_idx" ON "public"."transactions" USING "btree" ("gateway_key", "ownership_ref") WHERE ("ownership_ref" IS NOT NULL);


--
-- Name: transactions_payment_attempt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "transactions_payment_attempt_idx" ON "public"."transactions" USING "btree" ("payment_attempt_id");


--
-- Name: transactions_payment_intent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "transactions_payment_intent_idx" ON "public"."transactions" USING "btree" ("payment_intent_id");


--
-- Name: transactions_payment_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "transactions_payment_request_idx" ON "public"."transactions" USING "btree" ("payment_request_id") WHERE ("payment_request_id" IS NOT NULL);


--
-- Name: transactions_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "transactions_public_id_uq" ON "public"."transactions" USING "btree" ("public_id");


--
-- Name: transactions_trace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "transactions_trace_idx" ON "public"."transactions" USING "btree" ("trace_id") WHERE ("trace_id" IS NOT NULL);


--
-- Name: transfer_configurations_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "transfer_configurations_org_idx" ON "public"."transfer_configurations" USING "btree" ("organization_id", "created_at");


--
-- Name: trusted_browsers_token_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "trusted_browsers_token_uq" ON "public"."trusted_browsers" USING "btree" ("token_hash");


--
-- Name: trusted_browsers_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "trusted_browsers_user_idx" ON "public"."trusted_browsers" USING "btree" ("user_id");


--
-- Name: unbilled_charges_commitment_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "unbilled_charges_commitment_uq" ON "public"."unbilled_charges" USING "btree" ("subscription_id", "period_start") WHERE (("entity_type" = 'commitment'::"text") AND ("status" <> 'voided'::"text"));


--
-- Name: unbilled_charges_price_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "unbilled_charges_price_idx" ON "public"."unbilled_charges" USING "btree" ("price_id") WHERE ("price_id" IS NOT NULL);


--
-- Name: unbilled_charges_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "unbilled_charges_public_id_uq" ON "public"."unbilled_charges" USING "btree" ("public_id");


--
-- Name: unbilled_charges_sub_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "unbilled_charges_sub_idx" ON "public"."unbilled_charges" USING "btree" ("subscription_id", "status");


--
-- Name: usage_alert_observations_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_alert_observations_customer_idx" ON "public"."usage_alert_observations" USING "btree" ("customer_id");


--
-- Name: usage_alert_observations_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "usage_alert_observations_uq" ON "public"."usage_alert_observations" USING "btree" ("alert_id", "subject_key", "period_key");


--
-- Name: usage_alert_states_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_alert_states_customer_idx" ON "public"."usage_alert_states" USING "btree" ("customer_id");


--
-- Name: usage_alert_states_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_alert_states_open_idx" ON "public"."usage_alert_states" USING "btree" ("period_key") WHERE (("triggered_at" IS NOT NULL) AND ("resolved_at" IS NULL));


--
-- Name: usage_alert_states_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "usage_alert_states_uq" ON "public"."usage_alert_states" USING "btree" ("alert_id", "subject_key", "period_key", "threshold");


--
-- Name: usage_alerts_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_alerts_customer_idx" ON "public"."usage_alerts" USING "btree" ("customer_id") WHERE ("active" AND ("customer_id" IS NOT NULL));


--
-- Name: usage_alerts_product_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_alerts_product_idx" ON "public"."usage_alerts" USING "btree" ("product_id") WHERE ("active" AND ("product_id" IS NOT NULL));


--
-- Name: usage_alerts_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "usage_alerts_public_id_uq" ON "public"."usage_alerts" USING "btree" ("public_id");


--
-- Name: usage_archives_partition_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "usage_archives_partition_uq" ON "public"."usage_archives" USING "btree" ("partition_name");


--
-- Name: usage_control_dirty_marked_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_control_dirty_marked_idx" ON "public"."usage_control_dirty" USING "btree" ("marked_at");


--
-- Name: usage_event_dedup_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_event_dedup_created_idx" ON "public"."usage_event_dedup" USING "btree" ("created_at");


--
-- Name: usage_events_business_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_business_key_idx" ON ONLY "public"."usage_events" USING "btree" ("business_id", "key");


--
-- Name: usage_events_customer_event_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_customer_event_time_idx" ON ONLY "public"."usage_events" USING "btree" ("business_id", "customer_id", "event_name", "timestamp");


--
-- Name: usage_events_late_match_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_late_match_idx" ON ONLY "public"."usage_events" USING "btree" ("business_id", "customer_id", "matched_at") WHERE ("matched_at" IS NOT NULL);


--
-- Name: usage_events_unmatched_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_unmatched_idx" ON ONLY "public"."usage_events" USING "btree" ("business_id", "customer_key") WHERE ("customer_id" IS NULL);


--
-- Name: usage_events_y2026m09_business_id_customer_id_event_name_ti_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_y2026m09_business_id_customer_id_event_name_ti_idx" ON "public"."usage_events_y2026m09" USING "btree" ("business_id", "customer_id", "event_name", "timestamp");


--
-- Name: usage_events_y2026m09_business_id_customer_id_matched_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_y2026m09_business_id_customer_id_matched_at_idx" ON "public"."usage_events_y2026m09" USING "btree" ("business_id", "customer_id", "matched_at") WHERE ("matched_at" IS NOT NULL);


--
-- Name: usage_events_y2026m09_business_id_customer_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_y2026m09_business_id_customer_key_idx" ON "public"."usage_events_y2026m09" USING "btree" ("business_id", "customer_key") WHERE ("customer_id" IS NULL);


--
-- Name: usage_events_y2026m09_business_id_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_y2026m09_business_id_key_idx" ON "public"."usage_events_y2026m09" USING "btree" ("business_id", "key");


--
-- Name: usage_events_y2026m10_business_id_customer_id_event_name_ti_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_y2026m10_business_id_customer_id_event_name_ti_idx" ON "public"."usage_events_y2026m10" USING "btree" ("business_id", "customer_id", "event_name", "timestamp");


--
-- Name: usage_events_y2026m10_business_id_customer_id_matched_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_y2026m10_business_id_customer_id_matched_at_idx" ON "public"."usage_events_y2026m10" USING "btree" ("business_id", "customer_id", "matched_at") WHERE ("matched_at" IS NOT NULL);


--
-- Name: usage_events_y2026m10_business_id_customer_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_y2026m10_business_id_customer_key_idx" ON "public"."usage_events_y2026m10" USING "btree" ("business_id", "customer_key") WHERE ("customer_id" IS NULL);


--
-- Name: usage_events_y2026m10_business_id_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_y2026m10_business_id_key_idx" ON "public"."usage_events_y2026m10" USING "btree" ("business_id", "key");


--
-- Name: usage_events_y2026m11_business_id_customer_id_event_name_ti_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_y2026m11_business_id_customer_id_event_name_ti_idx" ON "public"."usage_events_y2026m11" USING "btree" ("business_id", "customer_id", "event_name", "timestamp");


--
-- Name: usage_events_y2026m11_business_id_customer_id_matched_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_y2026m11_business_id_customer_id_matched_at_idx" ON "public"."usage_events_y2026m11" USING "btree" ("business_id", "customer_id", "matched_at") WHERE ("matched_at" IS NOT NULL);


--
-- Name: usage_events_y2026m11_business_id_customer_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_y2026m11_business_id_customer_key_idx" ON "public"."usage_events_y2026m11" USING "btree" ("business_id", "customer_key") WHERE ("customer_id" IS NULL);


--
-- Name: usage_events_y2026m11_business_id_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_y2026m11_business_id_key_idx" ON "public"."usage_events_y2026m11" USING "btree" ("business_id", "key");


--
-- Name: usage_events_y2026m12_business_id_customer_id_event_name_ti_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_y2026m12_business_id_customer_id_event_name_ti_idx" ON "public"."usage_events_y2026m12" USING "btree" ("business_id", "customer_id", "event_name", "timestamp");


--
-- Name: usage_events_y2026m12_business_id_customer_id_matched_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_y2026m12_business_id_customer_id_matched_at_idx" ON "public"."usage_events_y2026m12" USING "btree" ("business_id", "customer_id", "matched_at") WHERE ("matched_at" IS NOT NULL);


--
-- Name: usage_events_y2026m12_business_id_customer_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_y2026m12_business_id_customer_key_idx" ON "public"."usage_events_y2026m12" USING "btree" ("business_id", "customer_key") WHERE ("customer_id" IS NULL);


--
-- Name: usage_events_y2026m12_business_id_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_y2026m12_business_id_key_idx" ON "public"."usage_events_y2026m12" USING "btree" ("business_id", "key");


--
-- Name: usage_events_y2027m01_business_id_customer_id_event_name_ti_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_y2027m01_business_id_customer_id_event_name_ti_idx" ON "public"."usage_events_y2027m01" USING "btree" ("business_id", "customer_id", "event_name", "timestamp");


--
-- Name: usage_events_y2027m01_business_id_customer_id_matched_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_y2027m01_business_id_customer_id_matched_at_idx" ON "public"."usage_events_y2027m01" USING "btree" ("business_id", "customer_id", "matched_at") WHERE ("matched_at" IS NOT NULL);


--
-- Name: usage_events_y2027m01_business_id_customer_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_y2027m01_business_id_customer_key_idx" ON "public"."usage_events_y2027m01" USING "btree" ("business_id", "customer_key") WHERE ("customer_id" IS NULL);


--
-- Name: usage_events_y2027m01_business_id_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_events_y2027m01_business_id_key_idx" ON "public"."usage_events_y2027m01" USING "btree" ("business_id", "key");


--
-- Name: usage_invoice_thresholds_plan_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "usage_invoice_thresholds_plan_uq" ON "public"."usage_invoice_thresholds" USING "btree" ("product_id", "currency") WHERE ("scope" = 'plan'::"text");


--
-- Name: usage_invoice_thresholds_subscription_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "usage_invoice_thresholds_subscription_uq" ON "public"."usage_invoice_thresholds" USING "btree" ("subscription_id") WHERE ("scope" = 'subscription'::"text");


--
-- Name: usage_meter_levels_meter_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_meter_levels_meter_idx" ON "public"."usage_meter_levels" USING "btree" ("meter_id");


--
-- Name: usage_meter_levels_point_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "usage_meter_levels_point_uq" ON "public"."usage_meter_levels" USING "btree" ("customer_id", "meter_id", "group_values", "at");


--
-- Name: usage_records_detached_sub_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_records_detached_sub_idx" ON "public"."usage_records" USING "btree" ("subscription_id", "timestamp") WHERE ("subscription_id" IS NOT NULL);


--
-- Name: usage_records_idem_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "usage_records_idem_uq" ON "public"."usage_records" USING "btree" ("subscription_item_id", "idempotency_key");


--
-- Name: usage_records_item_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_records_item_time_idx" ON "public"."usage_records" USING "btree" ("subscription_item_id", "timestamp");


--
-- Name: usage_records_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "usage_records_public_id_uq" ON "public"."usage_records" USING "btree" ("public_id");


--
-- Name: usage_widget_tokens_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_widget_tokens_customer_idx" ON "public"."usage_widget_tokens" USING "btree" ("customer_id");


--
-- Name: usage_widget_tokens_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "usage_widget_tokens_expires_idx" ON "public"."usage_widget_tokens" USING "btree" ("expires_at");


--
-- Name: usage_widget_tokens_token_hash_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "usage_widget_tokens_token_hash_uq" ON "public"."usage_widget_tokens" USING "btree" ("token_hash");


--
-- Name: user_passkeys_credential_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "user_passkeys_credential_uq" ON "public"."user_passkeys" USING "btree" ("credential_id");


--
-- Name: user_passkeys_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "user_passkeys_user_idx" ON "public"."user_passkeys" USING "btree" ("user_id");


--
-- Name: users_email_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "users_email_uq" ON "public"."users" USING "btree" ("email");


--
-- Name: users_google_sub_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "users_google_sub_uq" ON "public"."users" USING "btree" ("google_sub");


--
-- Name: users_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "users_public_id_uq" ON "public"."users" USING "btree" ("public_id");


--
-- Name: users_webauthn_user_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "users_webauthn_user_id_uq" ON "public"."users" USING "btree" ("webauthn_user_id");


--
-- Name: wallet_topups_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "wallet_topups_customer_idx" ON "public"."wallet_topups" USING "btree" ("customer_id", "currency");


--
-- Name: wallet_topups_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "wallet_topups_public_id_uq" ON "public"."wallet_topups" USING "btree" ("public_id");


--
-- Name: webauthn_challenges_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "webauthn_challenges_expires_idx" ON "public"."webauthn_challenges" USING "btree" ("expires_at");


--
-- Name: webauthn_challenges_handle_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "webauthn_challenges_handle_uq" ON "public"."webauthn_challenges" USING "btree" ("handle_hash");


--
-- Name: webhook_deliveries_endpoint_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "webhook_deliveries_endpoint_created_idx" ON "public"."webhook_deliveries" USING "btree" ("endpoint_id", "created_at", "id");


--
-- Name: webhook_deliveries_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "webhook_deliveries_event_idx" ON "public"."webhook_deliveries" USING "btree" ("event_id", "status");


--
-- Name: webhook_deliveries_failed_biz_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "webhook_deliveries_failed_biz_idx" ON "public"."webhook_deliveries" USING "btree" ("business_id", "last_attempt_at") WHERE ("status" = 'failed'::"text");


--
-- Name: webhook_deliveries_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "webhook_deliveries_org_idx" ON "public"."webhook_deliveries" USING "btree" ("organization_id");


--
-- Name: webhook_deliveries_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "webhook_deliveries_status_idx" ON "public"."webhook_deliveries" USING "btree" ("status", "next_attempt_at");


--
-- Name: webhook_endpoints_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "webhook_endpoints_org_idx" ON "public"."webhook_endpoints" USING "btree" ("organization_id");


--
-- Name: webhook_endpoints_public_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "webhook_endpoints_public_id_uq" ON "public"."webhook_endpoints" USING "btree" ("public_id");


--
-- Name: worker_heartbeats_beat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "worker_heartbeats_beat_idx" ON "public"."worker_heartbeats" USING "btree" ("last_beat_at");


--
-- Name: worker_heartbeats_role_beat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "worker_heartbeats_role_beat_idx" ON "public"."worker_heartbeats" USING "btree" ("role", "last_beat_at" DESC);


--
-- Name: worker_heartbeats_worker_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "worker_heartbeats_worker_id_uq" ON "public"."worker_heartbeats" USING "btree" ("worker_id");


--
-- Name: usage_events_y2026m09_business_id_customer_id_event_name_ti_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_customer_event_time_idx" ATTACH PARTITION "public"."usage_events_y2026m09_business_id_customer_id_event_name_ti_idx";


--
-- Name: usage_events_y2026m09_business_id_customer_id_matched_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_late_match_idx" ATTACH PARTITION "public"."usage_events_y2026m09_business_id_customer_id_matched_at_idx";


--
-- Name: usage_events_y2026m09_business_id_customer_key_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_unmatched_idx" ATTACH PARTITION "public"."usage_events_y2026m09_business_id_customer_key_idx";


--
-- Name: usage_events_y2026m09_business_id_key_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_business_key_idx" ATTACH PARTITION "public"."usage_events_y2026m09_business_id_key_idx";


--
-- Name: usage_events_y2026m09_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_pkey" ATTACH PARTITION "public"."usage_events_y2026m09_pkey";


--
-- Name: usage_events_y2026m10_business_id_customer_id_event_name_ti_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_customer_event_time_idx" ATTACH PARTITION "public"."usage_events_y2026m10_business_id_customer_id_event_name_ti_idx";


--
-- Name: usage_events_y2026m10_business_id_customer_id_matched_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_late_match_idx" ATTACH PARTITION "public"."usage_events_y2026m10_business_id_customer_id_matched_at_idx";


--
-- Name: usage_events_y2026m10_business_id_customer_key_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_unmatched_idx" ATTACH PARTITION "public"."usage_events_y2026m10_business_id_customer_key_idx";


--
-- Name: usage_events_y2026m10_business_id_key_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_business_key_idx" ATTACH PARTITION "public"."usage_events_y2026m10_business_id_key_idx";


--
-- Name: usage_events_y2026m10_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_pkey" ATTACH PARTITION "public"."usage_events_y2026m10_pkey";


--
-- Name: usage_events_y2026m11_business_id_customer_id_event_name_ti_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_customer_event_time_idx" ATTACH PARTITION "public"."usage_events_y2026m11_business_id_customer_id_event_name_ti_idx";


--
-- Name: usage_events_y2026m11_business_id_customer_id_matched_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_late_match_idx" ATTACH PARTITION "public"."usage_events_y2026m11_business_id_customer_id_matched_at_idx";


--
-- Name: usage_events_y2026m11_business_id_customer_key_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_unmatched_idx" ATTACH PARTITION "public"."usage_events_y2026m11_business_id_customer_key_idx";


--
-- Name: usage_events_y2026m11_business_id_key_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_business_key_idx" ATTACH PARTITION "public"."usage_events_y2026m11_business_id_key_idx";


--
-- Name: usage_events_y2026m11_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_pkey" ATTACH PARTITION "public"."usage_events_y2026m11_pkey";


--
-- Name: usage_events_y2026m12_business_id_customer_id_event_name_ti_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_customer_event_time_idx" ATTACH PARTITION "public"."usage_events_y2026m12_business_id_customer_id_event_name_ti_idx";


--
-- Name: usage_events_y2026m12_business_id_customer_id_matched_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_late_match_idx" ATTACH PARTITION "public"."usage_events_y2026m12_business_id_customer_id_matched_at_idx";


--
-- Name: usage_events_y2026m12_business_id_customer_key_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_unmatched_idx" ATTACH PARTITION "public"."usage_events_y2026m12_business_id_customer_key_idx";


--
-- Name: usage_events_y2026m12_business_id_key_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_business_key_idx" ATTACH PARTITION "public"."usage_events_y2026m12_business_id_key_idx";


--
-- Name: usage_events_y2026m12_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_pkey" ATTACH PARTITION "public"."usage_events_y2026m12_pkey";


--
-- Name: usage_events_y2027m01_business_id_customer_id_event_name_ti_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_customer_event_time_idx" ATTACH PARTITION "public"."usage_events_y2027m01_business_id_customer_id_event_name_ti_idx";


--
-- Name: usage_events_y2027m01_business_id_customer_id_matched_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_late_match_idx" ATTACH PARTITION "public"."usage_events_y2027m01_business_id_customer_id_matched_at_idx";


--
-- Name: usage_events_y2027m01_business_id_customer_key_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_unmatched_idx" ATTACH PARTITION "public"."usage_events_y2027m01_business_id_customer_key_idx";


--
-- Name: usage_events_y2027m01_business_id_key_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_business_key_idx" ATTACH PARTITION "public"."usage_events_y2027m01_business_id_key_idx";


--
-- Name: usage_events_y2027m01_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_events_pkey" ATTACH PARTITION "public"."usage_events_y2027m01_pkey";


--
-- Name: usage_rollups_y2026m09_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_rollups_pkey" ATTACH PARTITION "public"."usage_rollups_y2026m09_pkey";


--
-- Name: usage_rollups_y2026m10_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_rollups_pkey" ATTACH PARTITION "public"."usage_rollups_y2026m10_pkey";


--
-- Name: usage_rollups_y2026m11_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_rollups_pkey" ATTACH PARTITION "public"."usage_rollups_y2026m11_pkey";


--
-- Name: usage_rollups_y2026m12_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_rollups_pkey" ATTACH PARTITION "public"."usage_rollups_y2026m12_pkey";


--
-- Name: usage_rollups_y2027m01_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX "public"."usage_rollups_pkey" ATTACH PARTITION "public"."usage_rollups_y2027m01_pkey";


--
-- Name: businesses bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."businesses" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: comments bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."comments" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: contacts bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."contacts" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: coupons bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."coupons" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: credit_auto_topup_runs bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."credit_auto_topup_runs" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: credit_auto_topups bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."credit_auto_topups" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: credit_grants bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."credit_grants" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: credit_holds bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."credit_holds" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: credit_units bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."credit_units" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: custom_field_definitions bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."custom_field_definitions" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: customer_addresses bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."customer_addresses" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: customer_meter_billing bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."customer_meter_billing" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: customer_segments bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."customer_segments" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: customer_usage_keys bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."customer_usage_keys" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: customers bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."customers" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: dunning_policies bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."dunning_policies" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: gateway_accounts bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."gateway_accounts" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: hubspot_conflicts bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."hubspot_conflicts" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: hubspot_connections bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."hubspot_connections" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: hubspot_links bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."hubspot_links" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: hubspot_sync_runs bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."hubspot_sync_runs" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: integration_connections bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."integration_connections" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: list_views bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."list_views" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: metadata_key_rules bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."metadata_key_rules" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: meters bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."meters" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: model_cost_overrides bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."model_cost_overrides" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: model_price_notices bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."model_price_notices" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: payment_attempts bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."payment_attempts" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: payment_instructions bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."payment_instructions" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: payment_intents bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."payment_intents" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: payment_links bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."payment_links" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: payment_requests bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."payment_requests" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: price_rates bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."price_rates" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: prices bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."prices" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: product_groups bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."product_groups" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: products bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."products" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: reason_codes bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."reason_codes" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: report_dashboard_tiles bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."report_dashboard_tiles" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: report_dashboards bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."report_dashboards" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: spend_limit_tiers bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."spend_limit_tiers" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: spend_limits bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."spend_limits" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: subscriptions bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."subscriptions" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: tax_profiles bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."tax_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: tax_rate_components bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."tax_rate_components" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: tax_regions bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."tax_regions" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: tax_state_registrations bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."tax_state_registrations" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: time_travels bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."time_travels" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: transactions bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."transactions" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: usage_alert_observations bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."usage_alert_observations" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: usage_alert_states bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."usage_alert_states" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: usage_alerts bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."usage_alerts" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: usage_invoice_thresholds bump_row_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "bump_row_version" BEFORE UPDATE ON "public"."usage_invoice_thresholds" FOR EACH ROW EXECUTE FUNCTION "public"."bump_row_version"();


--
-- Name: invoices due_work_sync_invoices_del; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "due_work_sync_invoices_del" AFTER DELETE ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."due_work_sync"();


--
-- Name: invoices due_work_sync_invoices_ins; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "due_work_sync_invoices_ins" AFTER INSERT ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."due_work_sync"();


--
-- Name: invoices due_work_sync_invoices_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "due_work_sync_invoices_upd" AFTER UPDATE ON "public"."invoices" FOR EACH ROW WHEN ((("old"."status" IS DISTINCT FROM "new"."status") OR ("old"."next_attempt_at" IS DISTINCT FROM "new"."next_attempt_at"))) EXECUTE FUNCTION "public"."due_work_sync"();


--
-- Name: scheduled_changes due_work_sync_scheduled_changes_del; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "due_work_sync_scheduled_changes_del" AFTER DELETE ON "public"."scheduled_changes" FOR EACH ROW EXECUTE FUNCTION "public"."due_work_sync"();


--
-- Name: scheduled_changes due_work_sync_scheduled_changes_ins; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "due_work_sync_scheduled_changes_ins" AFTER INSERT ON "public"."scheduled_changes" FOR EACH ROW EXECUTE FUNCTION "public"."due_work_sync"();


--
-- Name: scheduled_changes due_work_sync_scheduled_changes_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "due_work_sync_scheduled_changes_upd" AFTER UPDATE ON "public"."scheduled_changes" FOR EACH ROW WHEN ((("old"."status" IS DISTINCT FROM "new"."status") OR ("old"."effective_at" IS DISTINCT FROM "new"."effective_at"))) EXECUTE FUNCTION "public"."due_work_sync"();


--
-- Name: subscriptions due_work_sync_subscriptions_del; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "due_work_sync_subscriptions_del" AFTER DELETE ON "public"."subscriptions" FOR EACH ROW EXECUTE FUNCTION "public"."due_work_sync"();


--
-- Name: subscriptions due_work_sync_subscriptions_ins; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "due_work_sync_subscriptions_ins" AFTER INSERT ON "public"."subscriptions" FOR EACH ROW EXECUTE FUNCTION "public"."due_work_sync"();


--
-- Name: subscriptions due_work_sync_subscriptions_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "due_work_sync_subscriptions_upd" AFTER UPDATE ON "public"."subscriptions" FOR EACH ROW WHEN ((("old"."status" IS DISTINCT FROM "new"."status") OR ("old"."current_period_end" IS DISTINCT FROM "new"."current_period_end") OR ("old"."trial_end" IS DISTINCT FROM "new"."trial_end"))) EXECUTE FUNCTION "public"."due_work_sync"();


--
-- Name: invoice_line_items invoice_line_items_fill_decimals; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "invoice_line_items_fill_decimals" BEFORE INSERT OR UPDATE ON "public"."invoice_line_items" FOR EACH ROW EXECUTE FUNCTION "public"."invoice_line_items_fill_decimals"();


--
-- Name: invoices invoices_dunning_status_rename; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "invoices_dunning_status_rename" BEFORE INSERT OR UPDATE OF "dunning_status" ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."invoices_dunning_status_rename"();


--
-- Name: invoices invoices_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "invoices_touch" BEFORE UPDATE ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."invoices_touch"();


--
-- Name: subscription_items subscription_items_detach_usage; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "subscription_items_detach_usage" BEFORE DELETE ON "public"."subscription_items" FOR EACH ROW EXECUTE FUNCTION "public"."usage_records_detach"();


--
-- Name: transactions transactions_status_rename; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "transactions_status_rename" BEFORE INSERT OR UPDATE OF "status" ON "public"."transactions" FOR EACH ROW EXECUTE FUNCTION "public"."transactions_status_rename"();


--
-- Name: api_keys api_keys_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: api_request_logs api_request_logs_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."api_request_logs"
    ADD CONSTRAINT "api_request_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: applied_coupons applied_coupons_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."applied_coupons"
    ADD CONSTRAINT "applied_coupons_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: applied_coupons applied_coupons_coupon_id_coupons_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."applied_coupons"
    ADD CONSTRAINT "applied_coupons_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE RESTRICT;


--
-- Name: applied_coupons applied_coupons_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."applied_coupons"
    ADD CONSTRAINT "applied_coupons_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: applied_coupons applied_coupons_subscription_id_subscriptions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."applied_coupons"
    ADD CONSTRAINT "applied_coupons_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE CASCADE;


--
-- Name: applied_taxes applied_taxes_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."applied_taxes"
    ADD CONSTRAINT "applied_taxes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: applied_taxes applied_taxes_invoice_id_invoices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."applied_taxes"
    ADD CONSTRAINT "applied_taxes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE CASCADE;


--
-- Name: applied_taxes applied_taxes_invoice_line_item_id_invoice_line_items_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."applied_taxes"
    ADD CONSTRAINT "applied_taxes_invoice_line_item_id_invoice_line_items_id_fk" FOREIGN KEY ("invoice_line_item_id") REFERENCES "public"."invoice_line_items"("id") ON DELETE CASCADE;


--
-- Name: applied_taxes applied_taxes_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."applied_taxes"
    ADD CONSTRAINT "applied_taxes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: applied_taxes applied_taxes_tax_component_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."applied_taxes"
    ADD CONSTRAINT "applied_taxes_tax_component_id_fkey" FOREIGN KEY ("tax_component_id") REFERENCES "public"."tax_rate_components"("id") ON DELETE SET NULL;


--
-- Name: attached_items attached_items_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."attached_items"
    ADD CONSTRAINT "attached_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: attached_items attached_items_item_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."attached_items"
    ADD CONSTRAINT "attached_items_item_product_id_fkey" FOREIGN KEY ("item_product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;


--
-- Name: attached_items attached_items_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."attached_items"
    ADD CONSTRAINT "attached_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: attached_items attached_items_plan_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."attached_items"
    ADD CONSTRAINT "attached_items_plan_product_id_fkey" FOREIGN KEY ("plan_product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;


--
-- Name: audit_log_snapshots audit_log_snapshots_audit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."audit_log_snapshots"
    ADD CONSTRAINT "audit_log_snapshots_audit_id_fkey" FOREIGN KEY ("audit_id") REFERENCES "public"."audit_logs"("id") ON DELETE CASCADE;


--
-- Name: audit_log_snapshots audit_log_snapshots_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."audit_log_snapshots"
    ADD CONSTRAINT "audit_log_snapshots_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: audit_logs audit_logs_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: audit_logs audit_logs_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: businesses businesses_live_business_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."businesses"
    ADD CONSTRAINT "businesses_live_business_fk" FOREIGN KEY ("live_business_id", "live_business_mode") REFERENCES "public"."businesses"("id", "livemode") ON DELETE CASCADE;


--
-- Name: businesses businesses_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."businesses"
    ADD CONSTRAINT "businesses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: checkout_session_items checkout_session_items_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."checkout_session_items"
    ADD CONSTRAINT "checkout_session_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: checkout_session_items checkout_session_items_checkout_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."checkout_session_items"
    ADD CONSTRAINT "checkout_session_items_checkout_session_id_fkey" FOREIGN KEY ("checkout_session_id") REFERENCES "public"."checkout_sessions"("id") ON DELETE CASCADE;


--
-- Name: checkout_session_items checkout_session_items_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."checkout_session_items"
    ADD CONSTRAINT "checkout_session_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: checkout_session_items checkout_session_items_price_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."checkout_session_items"
    ADD CONSTRAINT "checkout_session_items_price_id_fkey" FOREIGN KEY ("price_id") REFERENCES "public"."prices"("id") ON DELETE CASCADE;


--
-- Name: checkout_sessions checkout_sessions_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."checkout_sessions"
    ADD CONSTRAINT "checkout_sessions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: checkout_sessions checkout_sessions_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."checkout_sessions"
    ADD CONSTRAINT "checkout_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: checkout_sessions checkout_sessions_payment_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."checkout_sessions"
    ADD CONSTRAINT "checkout_sessions_payment_link_id_fkey" FOREIGN KEY ("payment_link_id") REFERENCES "public"."payment_links"("id") ON DELETE SET NULL;


--
-- Name: checkout_sessions checkout_sessions_resulting_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."checkout_sessions"
    ADD CONSTRAINT "checkout_sessions_resulting_customer_id_fkey" FOREIGN KEY ("resulting_customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;


--
-- Name: checkout_sessions checkout_sessions_resulting_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."checkout_sessions"
    ADD CONSTRAINT "checkout_sessions_resulting_invoice_id_fkey" FOREIGN KEY ("resulting_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE SET NULL;


--
-- Name: checkout_sessions checkout_sessions_resulting_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."checkout_sessions"
    ADD CONSTRAINT "checkout_sessions_resulting_subscription_id_fkey" FOREIGN KEY ("resulting_subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE SET NULL;


--
-- Name: checkout_sessions checkout_sessions_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."checkout_sessions"
    ADD CONSTRAINT "checkout_sessions_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE CASCADE;


--
-- Name: comments comments_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: comments comments_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: contacts contacts_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: contacts contacts_customer_id_customers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: contacts contacts_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: country_subdivision_aliases country_subdivision_aliases_country_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."country_subdivision_aliases"
    ADD CONSTRAINT "country_subdivision_aliases_country_code_fkey" FOREIGN KEY ("country_code") REFERENCES "public"."countries"("code") ON DELETE CASCADE;


--
-- Name: country_subdivisions country_subdivisions_country_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."country_subdivisions"
    ADD CONSTRAINT "country_subdivisions_country_code_fkey" FOREIGN KEY ("country_code") REFERENCES "public"."countries"("code") ON DELETE CASCADE;


--
-- Name: coupon_item_constraints coupon_item_constraints_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."coupon_item_constraints"
    ADD CONSTRAINT "coupon_item_constraints_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: coupon_item_constraints coupon_item_constraints_coupon_id_coupons_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."coupon_item_constraints"
    ADD CONSTRAINT "coupon_item_constraints_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE CASCADE;


--
-- Name: coupon_item_constraints coupon_item_constraints_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."coupon_item_constraints"
    ADD CONSTRAINT "coupon_item_constraints_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: coupon_set_codes coupon_set_codes_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."coupon_set_codes"
    ADD CONSTRAINT "coupon_set_codes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: coupon_set_codes coupon_set_codes_coupon_set_id_coupon_sets_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."coupon_set_codes"
    ADD CONSTRAINT "coupon_set_codes_coupon_set_id_coupon_sets_id_fk" FOREIGN KEY ("coupon_set_id") REFERENCES "public"."coupon_sets"("id") ON DELETE CASCADE;


--
-- Name: coupon_set_codes coupon_set_codes_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."coupon_set_codes"
    ADD CONSTRAINT "coupon_set_codes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: coupon_sets coupon_sets_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."coupon_sets"
    ADD CONSTRAINT "coupon_sets_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: coupon_sets coupon_sets_coupon_id_coupons_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."coupon_sets"
    ADD CONSTRAINT "coupon_sets_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE RESTRICT;


--
-- Name: coupon_sets coupon_sets_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."coupon_sets"
    ADD CONSTRAINT "coupon_sets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: coupons coupons_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."coupons"
    ADD CONSTRAINT "coupons_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: coupons coupons_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."coupons"
    ADD CONSTRAINT "coupons_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: credit_auto_topup_runs credit_auto_topup_runs_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_auto_topup_runs"
    ADD CONSTRAINT "credit_auto_topup_runs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: credit_auto_topup_runs credit_auto_topup_runs_config_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_auto_topup_runs"
    ADD CONSTRAINT "credit_auto_topup_runs_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "public"."credit_auto_topups"("id");


--
-- Name: credit_auto_topup_runs credit_auto_topup_runs_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_auto_topup_runs"
    ADD CONSTRAINT "credit_auto_topup_runs_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: credit_auto_topup_runs credit_auto_topup_runs_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_auto_topup_runs"
    ADD CONSTRAINT "credit_auto_topup_runs_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id");


--
-- Name: credit_auto_topup_runs credit_auto_topup_runs_notice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_auto_topup_runs"
    ADD CONSTRAINT "credit_auto_topup_runs_notice_id_fkey" FOREIGN KEY ("notice_id") REFERENCES "public"."pre_debit_notices"("id") ON DELETE SET NULL;


--
-- Name: credit_auto_topup_runs credit_auto_topup_runs_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_auto_topup_runs"
    ADD CONSTRAINT "credit_auto_topup_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: credit_auto_topup_runs credit_auto_topup_runs_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_auto_topup_runs"
    ADD CONSTRAINT "credit_auto_topup_runs_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE SET NULL;


--
-- Name: credit_auto_topups credit_auto_topups_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_auto_topups"
    ADD CONSTRAINT "credit_auto_topups_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: credit_auto_topups credit_auto_topups_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_auto_topups"
    ADD CONSTRAINT "credit_auto_topups_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: credit_auto_topups credit_auto_topups_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_auto_topups"
    ADD CONSTRAINT "credit_auto_topups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: credit_auto_topups credit_auto_topups_payment_method_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_auto_topups"
    ADD CONSTRAINT "credit_auto_topups_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE SET NULL;


--
-- Name: credit_auto_topups credit_auto_topups_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_auto_topups"
    ADD CONSTRAINT "credit_auto_topups_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "public"."credit_units"("id");


--
-- Name: credit_grant_movements credit_grant_movements_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_grant_movements"
    ADD CONSTRAINT "credit_grant_movements_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: credit_grant_movements credit_grant_movements_grant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_grant_movements"
    ADD CONSTRAINT "credit_grant_movements_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "public"."credit_grants"("id") ON DELETE CASCADE;


--
-- Name: credit_grant_movements credit_grant_movements_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_grant_movements"
    ADD CONSTRAINT "credit_grant_movements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: credit_grants credit_grants_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_grants"
    ADD CONSTRAINT "credit_grants_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: credit_grants credit_grants_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_grants"
    ADD CONSTRAINT "credit_grants_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;


--
-- Name: credit_grants credit_grants_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_grants"
    ADD CONSTRAINT "credit_grants_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: credit_grants credit_grants_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_grants"
    ADD CONSTRAINT "credit_grants_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id");


--
-- Name: credit_grants credit_grants_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_grants"
    ADD CONSTRAINT "credit_grants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: credit_grants credit_grants_restored_from_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_grants"
    ADD CONSTRAINT "credit_grants_restored_from_id_fkey" FOREIGN KEY ("restored_from_id") REFERENCES "public"."credit_grants"("id");


--
-- Name: credit_grants credit_grants_subscription_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_grants"
    ADD CONSTRAINT "credit_grants_subscription_item_id_fkey" FOREIGN KEY ("subscription_item_id") REFERENCES "public"."subscription_items"("id") ON DELETE SET NULL;


--
-- Name: credit_grants credit_grants_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_grants"
    ADD CONSTRAINT "credit_grants_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "public"."credit_units"("id");


--
-- Name: credit_holds credit_holds_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_holds"
    ADD CONSTRAINT "credit_holds_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: credit_holds credit_holds_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_holds"
    ADD CONSTRAINT "credit_holds_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: credit_holds credit_holds_meter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_holds"
    ADD CONSTRAINT "credit_holds_meter_id_fkey" FOREIGN KEY ("meter_id") REFERENCES "public"."meters"("id") ON DELETE SET NULL;


--
-- Name: credit_holds credit_holds_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_holds"
    ADD CONSTRAINT "credit_holds_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: credit_note_allocations credit_note_allocations_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_note_allocations"
    ADD CONSTRAINT "credit_note_allocations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: credit_note_allocations credit_note_allocations_credit_note_id_credit_notes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_note_allocations"
    ADD CONSTRAINT "credit_note_allocations_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE CASCADE;


--
-- Name: credit_note_allocations credit_note_allocations_invoice_id_invoices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_note_allocations"
    ADD CONSTRAINT "credit_note_allocations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE RESTRICT;


--
-- Name: credit_note_allocations credit_note_allocations_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_note_allocations"
    ADD CONSTRAINT "credit_note_allocations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: credit_note_discounts credit_note_discounts_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_note_discounts"
    ADD CONSTRAINT "credit_note_discounts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: credit_note_discounts credit_note_discounts_credit_note_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_note_discounts"
    ADD CONSTRAINT "credit_note_discounts_credit_note_id_fkey" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE CASCADE;


--
-- Name: credit_note_discounts credit_note_discounts_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_note_discounts"
    ADD CONSTRAINT "credit_note_discounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: credit_note_items credit_note_items_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_note_items"
    ADD CONSTRAINT "credit_note_items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: credit_note_items credit_note_items_credit_note_id_credit_notes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_note_items"
    ADD CONSTRAINT "credit_note_items_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE CASCADE;


--
-- Name: credit_note_items credit_note_items_invoice_line_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_note_items"
    ADD CONSTRAINT "credit_note_items_invoice_line_item_id_fkey" FOREIGN KEY ("invoice_line_item_id") REFERENCES "public"."invoice_line_items"("id") ON DELETE SET NULL;


--
-- Name: credit_note_items credit_note_items_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_note_items"
    ADD CONSTRAINT "credit_note_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: credit_notes credit_notes_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_notes"
    ADD CONSTRAINT "credit_notes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: credit_notes credit_notes_customer_id_customers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_notes"
    ADD CONSTRAINT "credit_notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: credit_notes credit_notes_invoice_id_invoices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_notes"
    ADD CONSTRAINT "credit_notes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE RESTRICT;


--
-- Name: credit_notes credit_notes_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_notes"
    ADD CONSTRAINT "credit_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: credit_units credit_units_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_units"
    ADD CONSTRAINT "credit_units_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: credit_units credit_units_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_units"
    ADD CONSTRAINT "credit_units_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: custom_field_definitions custom_field_definitions_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."custom_field_definitions"
    ADD CONSTRAINT "custom_field_definitions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: custom_field_definitions custom_field_definitions_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."custom_field_definitions"
    ADD CONSTRAINT "custom_field_definitions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: customer_addresses customer_addresses_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_addresses"
    ADD CONSTRAINT "customer_addresses_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: customer_addresses customer_addresses_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_addresses"
    ADD CONSTRAINT "customer_addresses_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: customer_addresses customer_addresses_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_addresses"
    ADD CONSTRAINT "customer_addresses_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: customer_limit_tier_reached customer_limit_tier_reached_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_limit_tier_reached"
    ADD CONSTRAINT "customer_limit_tier_reached_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: customer_limit_tier_reached customer_limit_tier_reached_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_limit_tier_reached"
    ADD CONSTRAINT "customer_limit_tier_reached_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: customer_limit_tier_reached customer_limit_tier_reached_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_limit_tier_reached"
    ADD CONSTRAINT "customer_limit_tier_reached_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: customer_limit_tier_reached customer_limit_tier_reached_tier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_limit_tier_reached"
    ADD CONSTRAINT "customer_limit_tier_reached_tier_id_fkey" FOREIGN KEY ("tier_id") REFERENCES "public"."spend_limit_tiers"("id");


--
-- Name: customer_meter_billing customer_meter_billing_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_meter_billing"
    ADD CONSTRAINT "customer_meter_billing_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: customer_meter_billing customer_meter_billing_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_meter_billing"
    ADD CONSTRAINT "customer_meter_billing_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: customer_meter_billing customer_meter_billing_meter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_meter_billing"
    ADD CONSTRAINT "customer_meter_billing_meter_id_fkey" FOREIGN KEY ("meter_id") REFERENCES "public"."meters"("id") ON DELETE CASCADE;


--
-- Name: customer_meter_billing customer_meter_billing_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_meter_billing"
    ADD CONSTRAINT "customer_meter_billing_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: customer_meter_billing customer_meter_billing_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_meter_billing"
    ADD CONSTRAINT "customer_meter_billing_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE SET NULL;


--
-- Name: customer_segments customer_segments_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_segments"
    ADD CONSTRAINT "customer_segments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: customer_segments customer_segments_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_segments"
    ADD CONSTRAINT "customer_segments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: customer_usage_keys customer_usage_keys_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_usage_keys"
    ADD CONSTRAINT "customer_usage_keys_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: customer_usage_keys customer_usage_keys_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_usage_keys"
    ADD CONSTRAINT "customer_usage_keys_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: customer_usage_keys customer_usage_keys_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customer_usage_keys"
    ADD CONSTRAINT "customer_usage_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: customers customers_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: customers customers_dunning_policy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_dunning_policy_id_fkey" FOREIGN KEY ("dunning_policy_id") REFERENCES "public"."dunning_policies"("id") ON DELETE RESTRICT;


--
-- Name: customers customers_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: decline_rule_overrides decline_rule_overrides_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."decline_rule_overrides"
    ADD CONSTRAINT "decline_rule_overrides_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: decline_rule_overrides decline_rule_overrides_gateway_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."decline_rule_overrides"
    ADD CONSTRAINT "decline_rule_overrides_gateway_account_id_fkey" FOREIGN KEY ("gateway_account_id") REFERENCES "public"."gateway_accounts"("id") ON DELETE CASCADE;


--
-- Name: decline_rule_overrides decline_rule_overrides_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."decline_rule_overrides"
    ADD CONSTRAINT "decline_rule_overrides_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: differential_prices differential_prices_addon_product_id_products_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."differential_prices"
    ADD CONSTRAINT "differential_prices_addon_product_id_products_id_fk" FOREIGN KEY ("addon_product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;


--
-- Name: differential_prices differential_prices_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."differential_prices"
    ADD CONSTRAINT "differential_prices_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: differential_prices differential_prices_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."differential_prices"
    ADD CONSTRAINT "differential_prices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: differential_prices differential_prices_plan_product_id_products_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."differential_prices"
    ADD CONSTRAINT "differential_prices_plan_product_id_products_id_fk" FOREIGN KEY ("plan_product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;


--
-- Name: disputes disputes_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."disputes"
    ADD CONSTRAINT "disputes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: dunning_policies dunning_policies_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."dunning_policies"
    ADD CONSTRAINT "dunning_policies_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: dunning_policies dunning_policies_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."dunning_policies"
    ADD CONSTRAINT "dunning_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: email_messages email_messages_credit_note_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."email_messages"
    ADD CONSTRAINT "email_messages_credit_note_id_fkey" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE SET NULL;


--
-- Name: email_messages email_messages_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."email_messages"
    ADD CONSTRAINT "email_messages_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE SET NULL;


--
-- Name: email_messages email_messages_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."email_messages"
    ADD CONSTRAINT "email_messages_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE SET NULL;


--
-- Name: email_messages email_messages_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."email_messages"
    ADD CONSTRAINT "email_messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: email_suppressions email_suppressions_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."email_suppressions"
    ADD CONSTRAINT "email_suppressions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: email_suppressions email_suppressions_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."email_suppressions"
    ADD CONSTRAINT "email_suppressions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: email_suppressions email_suppressions_source_email_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."email_suppressions"
    ADD CONSTRAINT "email_suppressions_source_email_id_fkey" FOREIGN KEY ("source_email_id") REFERENCES "public"."email_messages"("id") ON DELETE SET NULL;


--
-- Name: email_templates email_templates_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."email_templates"
    ADD CONSTRAINT "email_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: events events_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: exchange_rate_history exchange_rate_history_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exchange_rate_history"
    ADD CONSTRAINT "exchange_rate_history_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE RESTRICT;


--
-- Name: exchange_rate_history exchange_rate_history_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."exchange_rate_history"
    ADD CONSTRAINT "exchange_rate_history_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;


--
-- Name: features features_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."features"
    ADD CONSTRAINT "features_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: features features_meter_id_meters_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."features"
    ADD CONSTRAINT "features_meter_id_meters_id_fk" FOREIGN KEY ("meter_id") REFERENCES "public"."meters"("id");


--
-- Name: features features_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."features"
    ADD CONSTRAINT "features_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: gateway_accounts gateway_accounts_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."gateway_accounts"
    ADD CONSTRAINT "gateway_accounts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: gateway_accounts gateway_accounts_business_livemode_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."gateway_accounts"
    ADD CONSTRAINT "gateway_accounts_business_livemode_fk" FOREIGN KEY ("business_id", "livemode_mode") REFERENCES "public"."businesses"("id", "livemode") ON DELETE CASCADE;


--
-- Name: gateway_accounts gateway_accounts_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."gateway_accounts"
    ADD CONSTRAINT "gateway_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: gateway_settlement_cursors gateway_settlement_cursors_gateway_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."gateway_settlement_cursors"
    ADD CONSTRAINT "gateway_settlement_cursors_gateway_account_id_fkey" FOREIGN KEY ("gateway_account_id") REFERENCES "public"."gateway_accounts"("id") ON DELETE CASCADE;


--
-- Name: gateway_settlement_cursors gateway_settlement_cursors_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."gateway_settlement_cursors"
    ADD CONSTRAINT "gateway_settlement_cursors_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: hubspot_action_executions hubspot_action_executions_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_action_executions"
    ADD CONSTRAINT "hubspot_action_executions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: hubspot_action_executions hubspot_action_executions_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_action_executions"
    ADD CONSTRAINT "hubspot_action_executions_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."hubspot_connections"("id") ON DELETE CASCADE;


--
-- Name: hubspot_action_executions hubspot_action_executions_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_action_executions"
    ADD CONSTRAINT "hubspot_action_executions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: hubspot_conflicts hubspot_conflicts_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_conflicts"
    ADD CONSTRAINT "hubspot_conflicts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: hubspot_conflicts hubspot_conflicts_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_conflicts"
    ADD CONSTRAINT "hubspot_conflicts_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."hubspot_connections"("id") ON DELETE CASCADE;


--
-- Name: hubspot_conflicts hubspot_conflicts_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_conflicts"
    ADD CONSTRAINT "hubspot_conflicts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: hubspot_connections hubspot_connections_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_connections"
    ADD CONSTRAINT "hubspot_connections_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: hubspot_connections hubspot_connections_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_connections"
    ADD CONSTRAINT "hubspot_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: hubspot_links hubspot_links_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_links"
    ADD CONSTRAINT "hubspot_links_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: hubspot_links hubspot_links_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_links"
    ADD CONSTRAINT "hubspot_links_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."hubspot_connections"("id") ON DELETE CASCADE;


--
-- Name: hubspot_links hubspot_links_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_links"
    ADD CONSTRAINT "hubspot_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: hubspot_sync_items hubspot_sync_items_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_sync_items"
    ADD CONSTRAINT "hubspot_sync_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: hubspot_sync_items hubspot_sync_items_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_sync_items"
    ADD CONSTRAINT "hubspot_sync_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: hubspot_sync_items hubspot_sync_items_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_sync_items"
    ADD CONSTRAINT "hubspot_sync_items_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."hubspot_sync_runs"("id") ON DELETE CASCADE;


--
-- Name: hubspot_sync_queue hubspot_sync_queue_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_sync_queue"
    ADD CONSTRAINT "hubspot_sync_queue_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: hubspot_sync_queue hubspot_sync_queue_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_sync_queue"
    ADD CONSTRAINT "hubspot_sync_queue_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."hubspot_connections"("id") ON DELETE CASCADE;


--
-- Name: hubspot_sync_queue hubspot_sync_queue_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_sync_queue"
    ADD CONSTRAINT "hubspot_sync_queue_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: hubspot_sync_runs hubspot_sync_runs_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_sync_runs"
    ADD CONSTRAINT "hubspot_sync_runs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: hubspot_sync_runs hubspot_sync_runs_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_sync_runs"
    ADD CONSTRAINT "hubspot_sync_runs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."hubspot_connections"("id") ON DELETE CASCADE;


--
-- Name: hubspot_sync_runs hubspot_sync_runs_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."hubspot_sync_runs"
    ADD CONSTRAINT "hubspot_sync_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: idempotency_keys idempotency_keys_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: import_records import_records_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."import_records"
    ADD CONSTRAINT "import_records_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: import_records import_records_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."import_records"
    ADD CONSTRAINT "import_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: imported_events imported_events_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."imported_events"
    ADD CONSTRAINT "imported_events_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: imported_events imported_events_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."imported_events"
    ADD CONSTRAINT "imported_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: ingest_rate_counters ingest_rate_counters_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ingest_rate_counters"
    ADD CONSTRAINT "ingest_rate_counters_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: integration_connections integration_connections_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."integration_connections"
    ADD CONSTRAINT "integration_connections_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: integration_connections integration_connections_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."integration_connections"
    ADD CONSTRAINT "integration_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: integration_deliveries integration_deliveries_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."integration_deliveries"
    ADD CONSTRAINT "integration_deliveries_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE CASCADE;


--
-- Name: integration_deliveries integration_deliveries_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."integration_deliveries"
    ADD CONSTRAINT "integration_deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;


--
-- Name: integration_deliveries integration_deliveries_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."integration_deliveries"
    ADD CONSTRAINT "integration_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: invoice_line_discounts invoice_line_discounts_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."invoice_line_discounts"
    ADD CONSTRAINT "invoice_line_discounts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: invoice_line_discounts invoice_line_discounts_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."invoice_line_discounts"
    ADD CONSTRAINT "invoice_line_discounts_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE CASCADE;


--
-- Name: invoice_line_discounts invoice_line_discounts_invoice_line_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."invoice_line_discounts"
    ADD CONSTRAINT "invoice_line_discounts_invoice_line_item_id_fkey" FOREIGN KEY ("invoice_line_item_id") REFERENCES "public"."invoice_line_items"("id") ON DELETE CASCADE;


--
-- Name: invoice_line_discounts invoice_line_discounts_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."invoice_line_discounts"
    ADD CONSTRAINT "invoice_line_discounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: invoice_line_items invoice_line_items_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."invoice_line_items"
    ADD CONSTRAINT "invoice_line_items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: invoice_line_items invoice_line_items_invoice_id_invoices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."invoice_line_items"
    ADD CONSTRAINT "invoice_line_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE CASCADE;


--
-- Name: invoice_line_items invoice_line_items_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."invoice_line_items"
    ADD CONSTRAINT "invoice_line_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: invoice_line_items invoice_line_items_price_id_prices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."invoice_line_items"
    ADD CONSTRAINT "invoice_line_items_price_id_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."prices"("id") ON DELETE SET NULL;


--
-- Name: invoices invoices_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: invoices invoices_customer_id_customers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: invoices invoices_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: invoices invoices_subscription_id_subscriptions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE SET NULL;


--
-- Name: ledger_entries ledger_entries_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ledger_entries"
    ADD CONSTRAINT "ledger_entries_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE RESTRICT;


--
-- Name: ledger_entries ledger_entries_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."ledger_entries"
    ADD CONSTRAINT "ledger_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;


--
-- Name: list_views list_views_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."list_views"
    ADD CONSTRAINT "list_views_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: list_views list_views_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."list_views"
    ADD CONSTRAINT "list_views_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: memberships memberships_custom_role_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_custom_role_fk" FOREIGN KEY ("organization_id", "custom_role_id") REFERENCES "public"."roles"("organization_id", "id");


--
-- Name: memberships memberships_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: memberships memberships_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


--
-- Name: metadata_key_rules metadata_key_rules_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."metadata_key_rules"
    ADD CONSTRAINT "metadata_key_rules_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: metadata_key_rules metadata_key_rules_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."metadata_key_rules"
    ADD CONSTRAINT "metadata_key_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: meters meters_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."meters"
    ADD CONSTRAINT "meters_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: meters meters_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."meters"
    ADD CONSTRAINT "meters_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: metric_daily metric_daily_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."metric_daily"
    ADD CONSTRAINT "metric_daily_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: metric_daily metric_daily_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."metric_daily"
    ADD CONSTRAINT "metric_daily_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;


--
-- Name: metric_windows metric_windows_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."metric_windows"
    ADD CONSTRAINT "metric_windows_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: metric_windows metric_windows_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."metric_windows"
    ADD CONSTRAINT "metric_windows_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;


--
-- Name: mfa_reset_requests mfa_reset_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."mfa_reset_requests"
    ADD CONSTRAINT "mfa_reset_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


--
-- Name: model_cost_overrides model_cost_overrides_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."model_cost_overrides"
    ADD CONSTRAINT "model_cost_overrides_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: model_price_notices model_price_notices_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."model_price_notices"
    ADD CONSTRAINT "model_price_notices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: model_prices model_prices_model_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."model_prices"
    ADD CONSTRAINT "model_prices_model_fk" FOREIGN KEY ("provider", "model") REFERENCES "public"."model_price_models"("provider", "model");


--
-- Name: mrr_movements mrr_movements_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."mrr_movements"
    ADD CONSTRAINT "mrr_movements_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE RESTRICT;


--
-- Name: mrr_movements mrr_movements_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."mrr_movements"
    ADD CONSTRAINT "mrr_movements_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: mrr_movements mrr_movements_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."mrr_movements"
    ADD CONSTRAINT "mrr_movements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;


--
-- Name: mrr_movements mrr_movements_plan_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."mrr_movements"
    ADD CONSTRAINT "mrr_movements_plan_product_id_fkey" FOREIGN KEY ("plan_product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;


--
-- Name: mrr_movements mrr_movements_previous_plan_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."mrr_movements"
    ADD CONSTRAINT "mrr_movements_previous_plan_product_id_fkey" FOREIGN KEY ("previous_plan_product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;


--
-- Name: mrr_movements mrr_movements_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."mrr_movements"
    ADD CONSTRAINT "mrr_movements_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE CASCADE;


--
-- Name: org_mfa_reminders org_mfa_reminders_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."org_mfa_reminders"
    ADD CONSTRAINT "org_mfa_reminders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: org_mfa_reminders org_mfa_reminders_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."org_mfa_reminders"
    ADD CONSTRAINT "org_mfa_reminders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


--
-- Name: organization_retention organization_retention_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."organization_retention"
    ADD CONSTRAINT "organization_retention_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: organizations organizations_mfa_required_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_mfa_required_by_fkey" FOREIGN KEY ("mfa_required_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;


--
-- Name: auth_tokens password_reset_tokens_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."auth_tokens"
    ADD CONSTRAINT "password_reset_tokens_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


--
-- Name: payment_attempts payment_attempts_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_attempts"
    ADD CONSTRAINT "payment_attempts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: payment_attempts payment_attempts_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_attempts"
    ADD CONSTRAINT "payment_attempts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: payment_attempts payment_attempts_payment_intent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_attempts"
    ADD CONSTRAINT "payment_attempts_payment_intent_id_fkey" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE CASCADE;


--
-- Name: payment_instructions payment_instructions_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_instructions"
    ADD CONSTRAINT "payment_instructions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: payment_instructions payment_instructions_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_instructions"
    ADD CONSTRAINT "payment_instructions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: payment_intents payment_intents_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_intents"
    ADD CONSTRAINT "payment_intents_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: payment_intents payment_intents_customer_id_customers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_intents"
    ADD CONSTRAINT "payment_intents_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;


--
-- Name: payment_intents payment_intents_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_intents"
    ADD CONSTRAINT "payment_intents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: payment_link_items payment_link_items_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_link_items"
    ADD CONSTRAINT "payment_link_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: payment_link_items payment_link_items_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_link_items"
    ADD CONSTRAINT "payment_link_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: payment_link_items payment_link_items_payment_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_link_items"
    ADD CONSTRAINT "payment_link_items_payment_link_id_fkey" FOREIGN KEY ("payment_link_id") REFERENCES "public"."payment_links"("id") ON DELETE CASCADE;


--
-- Name: payment_link_items payment_link_items_price_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_link_items"
    ADD CONSTRAINT "payment_link_items_price_id_fkey" FOREIGN KEY ("price_id") REFERENCES "public"."prices"("id");


--
-- Name: payment_links payment_links_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_links"
    ADD CONSTRAINT "payment_links_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: payment_links payment_links_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_links"
    ADD CONSTRAINT "payment_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: payment_method_authorizations payment_method_authorizations_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_method_authorizations"
    ADD CONSTRAINT "payment_method_authorizations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: payment_method_authorizations payment_method_authorizations_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_method_authorizations"
    ADD CONSTRAINT "payment_method_authorizations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: payment_methods payment_methods_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_methods"
    ADD CONSTRAINT "payment_methods_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: payment_methods payment_methods_customer_id_customers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_methods"
    ADD CONSTRAINT "payment_methods_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: payment_methods payment_methods_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_methods"
    ADD CONSTRAINT "payment_methods_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: payment_request_invoices payment_request_invoices_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_request_invoices"
    ADD CONSTRAINT "payment_request_invoices_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: payment_request_invoices payment_request_invoices_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_request_invoices"
    ADD CONSTRAINT "payment_request_invoices_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE CASCADE;


--
-- Name: payment_request_invoices payment_request_invoices_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_request_invoices"
    ADD CONSTRAINT "payment_request_invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: payment_request_invoices payment_request_invoices_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_request_invoices"
    ADD CONSTRAINT "payment_request_invoices_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."payment_requests"("id") ON DELETE CASCADE;


--
-- Name: payment_requests payment_requests_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_requests"
    ADD CONSTRAINT "payment_requests_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: payment_requests payment_requests_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_requests"
    ADD CONSTRAINT "payment_requests_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: payment_requests payment_requests_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_requests"
    ADD CONSTRAINT "payment_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: payment_requests payment_requests_payment_method_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payment_requests"
    ADD CONSTRAINT "payment_requests_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE SET NULL;


--
-- Name: payments payments_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: payments payments_customer_id_customers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: payments payments_invoice_id_invoices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE SET NULL;


--
-- Name: payments payments_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: payments payments_payment_method_id_payment_methods_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE SET NULL;


--
-- Name: payments payments_payment_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_payment_request_id_fkey" FOREIGN KEY ("payment_request_id") REFERENCES "public"."payment_requests"("id") ON DELETE SET NULL;


--
-- Name: plan_entitlements plan_entitlements_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."plan_entitlements"
    ADD CONSTRAINT "plan_entitlements_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: plan_entitlements plan_entitlements_feature_id_features_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."plan_entitlements"
    ADD CONSTRAINT "plan_entitlements_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE CASCADE;


--
-- Name: plan_entitlements plan_entitlements_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."plan_entitlements"
    ADD CONSTRAINT "plan_entitlements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: plan_entitlements plan_entitlements_product_id_products_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."plan_entitlements"
    ADD CONSTRAINT "plan_entitlements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;


--
-- Name: portal_login_codes portal_login_codes_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portal_login_codes"
    ADD CONSTRAINT "portal_login_codes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: portal_login_codes portal_login_codes_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portal_login_codes"
    ADD CONSTRAINT "portal_login_codes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: portal_sessions portal_sessions_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portal_sessions"
    ADD CONSTRAINT "portal_sessions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: portal_sessions portal_sessions_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portal_sessions"
    ADD CONSTRAINT "portal_sessions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: portal_sessions portal_sessions_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."portal_sessions"
    ADD CONSTRAINT "portal_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: pre_debit_notices pre_debit_notices_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pre_debit_notices"
    ADD CONSTRAINT "pre_debit_notices_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: pre_debit_notices pre_debit_notices_gateway_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pre_debit_notices"
    ADD CONSTRAINT "pre_debit_notices_gateway_account_id_fkey" FOREIGN KEY ("gateway_account_id") REFERENCES "public"."gateway_accounts"("id") ON DELETE SET NULL;


--
-- Name: pre_debit_notices pre_debit_notices_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pre_debit_notices"
    ADD CONSTRAINT "pre_debit_notices_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE SET NULL;


--
-- Name: pre_debit_notices pre_debit_notices_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pre_debit_notices"
    ADD CONSTRAINT "pre_debit_notices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: pre_debit_notices pre_debit_notices_payment_method_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pre_debit_notices"
    ADD CONSTRAINT "pre_debit_notices_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE CASCADE;


--
-- Name: pre_debit_notices pre_debit_notices_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."pre_debit_notices"
    ADD CONSTRAINT "pre_debit_notices_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE SET NULL;


--
-- Name: price_rates price_rates_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."price_rates"
    ADD CONSTRAINT "price_rates_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: price_rates price_rates_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."price_rates"
    ADD CONSTRAINT "price_rates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: price_rates price_rates_price_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."price_rates"
    ADD CONSTRAINT "price_rates_price_id_fkey" FOREIGN KEY ("price_id") REFERENCES "public"."prices"("id") ON DELETE CASCADE;


--
-- Name: prices prices_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."prices"
    ADD CONSTRAINT "prices_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: prices prices_meter_id_meters_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."prices"
    ADD CONSTRAINT "prices_meter_id_meters_id_fk" FOREIGN KEY ("meter_id") REFERENCES "public"."meters"("id");


--
-- Name: prices prices_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."prices"
    ADD CONSTRAINT "prices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: prices prices_product_id_products_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."prices"
    ADD CONSTRAINT "prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;


--
-- Name: product_groups product_groups_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."product_groups"
    ADD CONSTRAINT "product_groups_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: product_groups product_groups_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."product_groups"
    ADD CONSTRAINT "product_groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: products products_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: products products_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: products products_product_group_id_product_groups_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_product_group_id_product_groups_id_fk" FOREIGN KEY ("product_group_id") REFERENCES "public"."product_groups"("id");


--
-- Name: products products_tax_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_tax_profile_id_fkey" FOREIGN KEY ("tax_profile_id") REFERENCES "public"."tax_profiles"("id") ON DELETE SET NULL;


--
-- Name: promotional_credit_movements promotional_credit_movements_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."promotional_credit_movements"
    ADD CONSTRAINT "promotional_credit_movements_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: promotional_credit_movements promotional_credit_movements_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."promotional_credit_movements"
    ADD CONSTRAINT "promotional_credit_movements_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: promotional_credit_movements promotional_credit_movements_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."promotional_credit_movements"
    ADD CONSTRAINT "promotional_credit_movements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: provider_customers provider_customers_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."provider_customers"
    ADD CONSTRAINT "provider_customers_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: provider_customers provider_customers_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."provider_customers"
    ADD CONSTRAINT "provider_customers_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: provider_customers provider_customers_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."provider_customers"
    ADD CONSTRAINT "provider_customers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: rate_limit_counters rate_limit_counters_api_key_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."rate_limit_counters"
    ADD CONSTRAINT "rate_limit_counters_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE CASCADE;


--
-- Name: reason_codes reason_codes_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."reason_codes"
    ADD CONSTRAINT "reason_codes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: reason_codes reason_codes_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."reason_codes"
    ADD CONSTRAINT "reason_codes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: receipts receipts_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."receipts"
    ADD CONSTRAINT "receipts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: receipts receipts_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."receipts"
    ADD CONSTRAINT "receipts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: receipts receipts_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."receipts"
    ADD CONSTRAINT "receipts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: receipts receipts_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."receipts"
    ADD CONSTRAINT "receipts_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE RESTRICT;


--
-- Name: refunds refunds_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."refunds"
    ADD CONSTRAINT "refunds_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: refunds refunds_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."refunds"
    ADD CONSTRAINT "refunds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: refunds refunds_payment_id_payments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."refunds"
    ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE RESTRICT;


--
-- Name: renewal_skips renewal_skips_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."renewal_skips"
    ADD CONSTRAINT "renewal_skips_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: renewal_skips renewal_skips_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."renewal_skips"
    ADD CONSTRAINT "renewal_skips_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE SET NULL;


--
-- Name: renewal_skips renewal_skips_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."renewal_skips"
    ADD CONSTRAINT "renewal_skips_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: renewal_skips renewal_skips_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."renewal_skips"
    ADD CONSTRAINT "renewal_skips_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE CASCADE;


--
-- Name: report_dashboard_tiles report_dashboard_tiles_dashboard_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."report_dashboard_tiles"
    ADD CONSTRAINT "report_dashboard_tiles_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "public"."report_dashboards"("id") ON DELETE CASCADE;


--
-- Name: report_dashboard_tiles report_dashboard_tiles_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."report_dashboard_tiles"
    ADD CONSTRAINT "report_dashboard_tiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: report_dashboards report_dashboards_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."report_dashboards"
    ADD CONSTRAINT "report_dashboards_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: report_dashboards report_dashboards_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."report_dashboards"
    ADD CONSTRAINT "report_dashboards_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: retention_events retention_events_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."retention_events"
    ADD CONSTRAINT "retention_events_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: retention_events retention_events_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."retention_events"
    ADD CONSTRAINT "retention_events_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: retention_events retention_events_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."retention_events"
    ADD CONSTRAINT "retention_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: retention_events retention_events_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."retention_events"
    ADD CONSTRAINT "retention_events_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE CASCADE;


--
-- Name: roles roles_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."roles"
    ADD CONSTRAINT "roles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: scheduled_changes scheduled_changes_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."scheduled_changes"
    ADD CONSTRAINT "scheduled_changes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: scheduled_changes scheduled_changes_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."scheduled_changes"
    ADD CONSTRAINT "scheduled_changes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: scheduled_changes scheduled_changes_subscription_id_subscriptions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."scheduled_changes"
    ADD CONSTRAINT "scheduled_changes_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE CASCADE;


--
-- Name: sessions sessions_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sessions"
    ADD CONSTRAINT "sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."sessions"
    ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


--
-- Name: settlement_poll_schedule settlement_poll_schedule_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."settlement_poll_schedule"
    ADD CONSTRAINT "settlement_poll_schedule_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: settlement_poll_schedule settlement_poll_schedule_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."settlement_poll_schedule"
    ADD CONSTRAINT "settlement_poll_schedule_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE CASCADE;


--
-- Name: spend_limit_states spend_limit_states_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."spend_limit_states"
    ADD CONSTRAINT "spend_limit_states_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: spend_limit_states spend_limit_states_limit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."spend_limit_states"
    ADD CONSTRAINT "spend_limit_states_limit_id_fkey" FOREIGN KEY ("limit_id") REFERENCES "public"."spend_limits"("id") ON DELETE CASCADE;


--
-- Name: spend_limit_states spend_limit_states_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."spend_limit_states"
    ADD CONSTRAINT "spend_limit_states_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: spend_limit_tiers spend_limit_tiers_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."spend_limit_tiers"
    ADD CONSTRAINT "spend_limit_tiers_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: spend_limit_tiers spend_limit_tiers_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."spend_limit_tiers"
    ADD CONSTRAINT "spend_limit_tiers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: spend_limits spend_limits_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."spend_limits"
    ADD CONSTRAINT "spend_limits_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: spend_limits spend_limits_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."spend_limits"
    ADD CONSTRAINT "spend_limits_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: spend_limits spend_limits_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."spend_limits"
    ADD CONSTRAINT "spend_limits_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: spend_limits spend_limits_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."spend_limits"
    ADD CONSTRAINT "spend_limits_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE CASCADE;


--
-- Name: subscription_charge_log subscription_charge_log_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscription_charge_log"
    ADD CONSTRAINT "subscription_charge_log_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: subscription_charge_log subscription_charge_log_item_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscription_charge_log"
    ADD CONSTRAINT "subscription_charge_log_item_product_id_fkey" FOREIGN KEY ("item_product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;


--
-- Name: subscription_charge_log subscription_charge_log_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscription_charge_log"
    ADD CONSTRAINT "subscription_charge_log_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: subscription_charge_log subscription_charge_log_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscription_charge_log"
    ADD CONSTRAINT "subscription_charge_log_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE CASCADE;


--
-- Name: subscription_entitlements subscription_entitlements_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscription_entitlements"
    ADD CONSTRAINT "subscription_entitlements_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: subscription_entitlements subscription_entitlements_feature_id_features_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscription_entitlements"
    ADD CONSTRAINT "subscription_entitlements_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE CASCADE;


--
-- Name: subscription_entitlements subscription_entitlements_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscription_entitlements"
    ADD CONSTRAINT "subscription_entitlements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: subscription_entitlements subscription_entitlements_subscription_id_subscriptions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscription_entitlements"
    ADD CONSTRAINT "subscription_entitlements_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE CASCADE;


--
-- Name: subscription_items subscription_items_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscription_items"
    ADD CONSTRAINT "subscription_items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: subscription_items subscription_items_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscription_items"
    ADD CONSTRAINT "subscription_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: subscription_items subscription_items_price_id_prices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscription_items"
    ADD CONSTRAINT "subscription_items_price_id_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."prices"("id") ON DELETE RESTRICT;


--
-- Name: subscription_items subscription_items_subscription_id_subscriptions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscription_items"
    ADD CONSTRAINT "subscription_items_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_customer_id_customers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_default_payment_method_id_payment_methods_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_default_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("default_payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE SET NULL;


--
-- Name: subscriptions subscriptions_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_shipping_address_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_shipping_address_id_fkey" FOREIGN KEY ("shipping_address_id") REFERENCES "public"."customer_addresses"("id") ON DELETE SET NULL;


--
-- Name: tax_profiles tax_profiles_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tax_profiles"
    ADD CONSTRAINT "tax_profiles_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: tax_profiles tax_profiles_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tax_profiles"
    ADD CONSTRAINT "tax_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: tax_rate_components tax_rate_components_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tax_rate_components"
    ADD CONSTRAINT "tax_rate_components_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: tax_rate_components tax_rate_components_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tax_rate_components"
    ADD CONSTRAINT "tax_rate_components_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: tax_rate_components tax_rate_components_tax_region_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tax_rate_components"
    ADD CONSTRAINT "tax_rate_components_tax_region_id_fkey" FOREIGN KEY ("tax_region_id") REFERENCES "public"."tax_regions"("id") ON DELETE CASCADE;


--
-- Name: tax_regions tax_regions_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tax_regions"
    ADD CONSTRAINT "tax_regions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: tax_regions tax_regions_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tax_regions"
    ADD CONSTRAINT "tax_regions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: tax_regions tax_regions_tax_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tax_regions"
    ADD CONSTRAINT "tax_regions_tax_profile_id_fkey" FOREIGN KEY ("tax_profile_id") REFERENCES "public"."tax_profiles"("id") ON DELETE CASCADE;


--
-- Name: tax_state_registrations tax_state_registrations_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tax_state_registrations"
    ADD CONSTRAINT "tax_state_registrations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: tax_state_registrations tax_state_registrations_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tax_state_registrations"
    ADD CONSTRAINT "tax_state_registrations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: tax_state_registrations tax_state_registrations_tax_region_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."tax_state_registrations"
    ADD CONSTRAINT "tax_state_registrations_tax_region_id_fkey" FOREIGN KEY ("tax_region_id") REFERENCES "public"."tax_regions"("id") ON DELETE CASCADE;


--
-- Name: team_alert_recipients team_alert_recipients_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."team_alert_recipients"
    ADD CONSTRAINT "team_alert_recipients_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: team_alert_recipients team_alert_recipients_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."team_alert_recipients"
    ADD CONSTRAINT "team_alert_recipients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: time_travels time_travels_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."time_travels"
    ADD CONSTRAINT "time_travels_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: time_travels time_travels_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."time_travels"
    ADD CONSTRAINT "time_travels_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: transactions transactions_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: transactions transactions_customer_id_customers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;


--
-- Name: transactions transactions_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: transfer_configurations transfer_configurations_destination_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transfer_configurations"
    ADD CONSTRAINT "transfer_configurations_destination_business_id_fkey" FOREIGN KEY ("destination_business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: transfer_configurations transfer_configurations_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transfer_configurations"
    ADD CONSTRAINT "transfer_configurations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: transfer_configurations transfer_configurations_source_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transfer_configurations"
    ADD CONSTRAINT "transfer_configurations_source_business_id_fkey" FOREIGN KEY ("source_business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: transfer_configurations transfer_configurations_twin_of_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transfer_configurations"
    ADD CONSTRAINT "transfer_configurations_twin_of_fkey" FOREIGN KEY ("twin_of") REFERENCES "public"."transfer_configurations"("id") ON DELETE SET NULL;


--
-- Name: trusted_browsers trusted_browsers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."trusted_browsers"
    ADD CONSTRAINT "trusted_browsers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


--
-- Name: unbilled_charges unbilled_charges_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."unbilled_charges"
    ADD CONSTRAINT "unbilled_charges_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: unbilled_charges unbilled_charges_invoice_id_invoices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."unbilled_charges"
    ADD CONSTRAINT "unbilled_charges_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE SET NULL;


--
-- Name: unbilled_charges unbilled_charges_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."unbilled_charges"
    ADD CONSTRAINT "unbilled_charges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: unbilled_charges unbilled_charges_price_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."unbilled_charges"
    ADD CONSTRAINT "unbilled_charges_price_id_fkey" FOREIGN KEY ("price_id") REFERENCES "public"."prices"("id") ON DELETE SET NULL;


--
-- Name: unbilled_charges unbilled_charges_subscription_id_subscriptions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."unbilled_charges"
    ADD CONSTRAINT "unbilled_charges_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE CASCADE;


--
-- Name: usage_alert_observations usage_alert_observations_alert_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_alert_observations"
    ADD CONSTRAINT "usage_alert_observations_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "public"."usage_alerts"("id") ON DELETE CASCADE;


--
-- Name: usage_alert_observations usage_alert_observations_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_alert_observations"
    ADD CONSTRAINT "usage_alert_observations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: usage_alert_observations usage_alert_observations_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_alert_observations"
    ADD CONSTRAINT "usage_alert_observations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: usage_alert_observations usage_alert_observations_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_alert_observations"
    ADD CONSTRAINT "usage_alert_observations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: usage_alert_states usage_alert_states_alert_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_alert_states"
    ADD CONSTRAINT "usage_alert_states_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "public"."usage_alerts"("id") ON DELETE CASCADE;


--
-- Name: usage_alert_states usage_alert_states_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_alert_states"
    ADD CONSTRAINT "usage_alert_states_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: usage_alert_states usage_alert_states_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_alert_states"
    ADD CONSTRAINT "usage_alert_states_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: usage_alert_states usage_alert_states_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_alert_states"
    ADD CONSTRAINT "usage_alert_states_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: usage_alerts usage_alerts_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_alerts"
    ADD CONSTRAINT "usage_alerts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: usage_alerts usage_alerts_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_alerts"
    ADD CONSTRAINT "usage_alerts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: usage_alerts usage_alerts_meter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_alerts"
    ADD CONSTRAINT "usage_alerts_meter_id_fkey" FOREIGN KEY ("meter_id") REFERENCES "public"."meters"("id");


--
-- Name: usage_alerts usage_alerts_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_alerts"
    ADD CONSTRAINT "usage_alerts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: usage_alerts usage_alerts_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_alerts"
    ADD CONSTRAINT "usage_alerts_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;


--
-- Name: usage_alerts usage_alerts_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_alerts"
    ADD CONSTRAINT "usage_alerts_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "public"."credit_units"("id");


--
-- Name: usage_control_cursors usage_control_cursors_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_control_cursors"
    ADD CONSTRAINT "usage_control_cursors_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: usage_control_cursors usage_control_cursors_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_control_cursors"
    ADD CONSTRAINT "usage_control_cursors_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: usage_control_cursors usage_control_cursors_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_control_cursors"
    ADD CONSTRAINT "usage_control_cursors_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: usage_control_dirty usage_control_dirty_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_control_dirty"
    ADD CONSTRAINT "usage_control_dirty_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: usage_control_dirty usage_control_dirty_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_control_dirty"
    ADD CONSTRAINT "usage_control_dirty_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: usage_control_dirty usage_control_dirty_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_control_dirty"
    ADD CONSTRAINT "usage_control_dirty_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: usage_invoice_thresholds usage_invoice_thresholds_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_invoice_thresholds"
    ADD CONSTRAINT "usage_invoice_thresholds_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: usage_invoice_thresholds usage_invoice_thresholds_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_invoice_thresholds"
    ADD CONSTRAINT "usage_invoice_thresholds_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: usage_invoice_thresholds usage_invoice_thresholds_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_invoice_thresholds"
    ADD CONSTRAINT "usage_invoice_thresholds_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;


--
-- Name: usage_invoice_thresholds usage_invoice_thresholds_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_invoice_thresholds"
    ADD CONSTRAINT "usage_invoice_thresholds_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE CASCADE;


--
-- Name: usage_meter_levels usage_meter_levels_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_meter_levels"
    ADD CONSTRAINT "usage_meter_levels_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: usage_meter_levels usage_meter_levels_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_meter_levels"
    ADD CONSTRAINT "usage_meter_levels_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: usage_meter_levels usage_meter_levels_meter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_meter_levels"
    ADD CONSTRAINT "usage_meter_levels_meter_id_fkey" FOREIGN KEY ("meter_id") REFERENCES "public"."meters"("id") ON DELETE CASCADE;


--
-- Name: usage_meter_levels usage_meter_levels_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_meter_levels"
    ADD CONSTRAINT "usage_meter_levels_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: usage_records usage_records_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_records"
    ADD CONSTRAINT "usage_records_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: usage_records usage_records_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_records"
    ADD CONSTRAINT "usage_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: usage_records usage_records_price_id_prices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_records"
    ADD CONSTRAINT "usage_records_price_id_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."prices"("id") ON DELETE SET NULL;


--
-- Name: usage_records usage_records_subscription_id_subscriptions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_records"
    ADD CONSTRAINT "usage_records_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE CASCADE;


--
-- Name: usage_records usage_records_subscription_item_id_subscription_items_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_records"
    ADD CONSTRAINT "usage_records_subscription_item_id_subscription_items_id_fk" FOREIGN KEY ("subscription_item_id") REFERENCES "public"."subscription_items"("id") ON DELETE SET NULL;


--
-- Name: usage_rollup_state usage_rollup_state_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_rollup_state"
    ADD CONSTRAINT "usage_rollup_state_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: usage_rollup_state usage_rollup_state_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_rollup_state"
    ADD CONSTRAINT "usage_rollup_state_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: usage_widget_tokens usage_widget_tokens_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_widget_tokens"
    ADD CONSTRAINT "usage_widget_tokens_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: usage_widget_tokens usage_widget_tokens_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_widget_tokens"
    ADD CONSTRAINT "usage_widget_tokens_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: usage_widget_tokens usage_widget_tokens_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_widget_tokens"
    ADD CONSTRAINT "usage_widget_tokens_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: user_mfa user_mfa_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."user_mfa"
    ADD CONSTRAINT "user_mfa_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


--
-- Name: user_passkeys user_passkeys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."user_passkeys"
    ADD CONSTRAINT "user_passkeys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


--
-- Name: users users_last_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_last_organization_id_fk" FOREIGN KEY ("last_organization_id") REFERENCES "public"."organizations"("id") ON DELETE SET NULL;


--
-- Name: wallet_topups wallet_topups_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."wallet_topups"
    ADD CONSTRAINT "wallet_topups_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: wallet_topups wallet_topups_customer_id_customers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."wallet_topups"
    ADD CONSTRAINT "wallet_topups_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;


--
-- Name: wallet_topups wallet_topups_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."wallet_topups"
    ADD CONSTRAINT "wallet_topups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: wallet_topups wallet_topups_payment_id_payments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."wallet_topups"
    ADD CONSTRAINT "wallet_topups_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE SET NULL;


--
-- Name: webauthn_challenges webauthn_challenges_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."webauthn_challenges"
    ADD CONSTRAINT "webauthn_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


--
-- Name: webhook_deliveries webhook_deliveries_event_id_events_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."webhook_deliveries"
    ADD CONSTRAINT "webhook_deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;


--
-- Name: webhook_deliveries webhook_deliveries_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."webhook_deliveries"
    ADD CONSTRAINT "webhook_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: webhook_endpoints webhook_endpoints_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."webhook_endpoints"
    ADD CONSTRAINT "webhook_endpoints_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;


--
-- Name: webhook_endpoints webhook_endpoints_business_livemode_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."webhook_endpoints"
    ADD CONSTRAINT "webhook_endpoints_business_livemode_fk" FOREIGN KEY ("business_id", "livemode") REFERENCES "public"."businesses"("id", "livemode") ON DELETE CASCADE;


--
-- Name: webhook_endpoints webhook_endpoints_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."webhook_endpoints"
    ADD CONSTRAINT "webhook_endpoints_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;


--
-- Name: api_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."api_keys" ENABLE ROW LEVEL SECURITY;

--
-- Name: api_request_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."api_request_logs" ENABLE ROW LEVEL SECURITY;

--
-- Name: applied_coupons; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."applied_coupons" ENABLE ROW LEVEL SECURITY;

--
-- Name: applied_taxes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."applied_taxes" ENABLE ROW LEVEL SECURITY;

--
-- Name: attached_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."attached_items" ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_log_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."audit_log_snapshots" ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."audit_logs" ENABLE ROW LEVEL SECURITY;

--
-- Name: gateway_request_logs business_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "business_isolation" ON "public"."gateway_request_logs" USING (("business_id" IN ( SELECT "businesses"."id"
   FROM "public"."businesses"))) WITH CHECK (("business_id" IN ( SELECT "businesses"."id"
   FROM "public"."businesses")));


--
-- Name: tmtest_charges business_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "business_isolation" ON "public"."tmtest_charges" USING (("business_id" IN ( SELECT "businesses"."id"
   FROM "public"."businesses"))) WITH CHECK (("business_id" IN ( SELECT "businesses"."id"
   FROM "public"."businesses")));


--
-- Name: tmtest_outbound business_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "business_isolation" ON "public"."tmtest_outbound" USING (("business_id" IN ( SELECT "businesses"."id"
   FROM "public"."businesses"))) WITH CHECK (("business_id" IN ( SELECT "businesses"."id"
   FROM "public"."businesses")));


--
-- Name: businesses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."businesses" ENABLE ROW LEVEL SECURITY;

--
-- Name: buyer_request_rejections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."buyer_request_rejections" ENABLE ROW LEVEL SECURITY;

--
-- Name: checkout_session_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."checkout_session_items" ENABLE ROW LEVEL SECURITY;

--
-- Name: checkout_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."checkout_sessions" ENABLE ROW LEVEL SECURITY;

--
-- Name: comments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."comments" ENABLE ROW LEVEL SECURITY;

--
-- Name: contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."contacts" ENABLE ROW LEVEL SECURITY;

--
-- Name: coupon_item_constraints; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."coupon_item_constraints" ENABLE ROW LEVEL SECURITY;

--
-- Name: coupon_set_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."coupon_set_codes" ENABLE ROW LEVEL SECURITY;

--
-- Name: coupon_sets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."coupon_sets" ENABLE ROW LEVEL SECURITY;

--
-- Name: coupons; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."coupons" ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_auto_topup_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."credit_auto_topup_runs" ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_auto_topups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."credit_auto_topups" ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_grant_movements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."credit_grant_movements" ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_grants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."credit_grants" ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_holds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."credit_holds" ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_note_allocations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."credit_note_allocations" ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_note_discounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."credit_note_discounts" ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_note_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."credit_note_items" ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."credit_notes" ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_units; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."credit_units" ENABLE ROW LEVEL SECURITY;

--
-- Name: custom_field_definitions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."custom_field_definitions" ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_addresses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."customer_addresses" ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_limit_tier_reached; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."customer_limit_tier_reached" ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_meter_billing; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."customer_meter_billing" ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_segments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."customer_segments" ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_usage_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."customer_usage_keys" ENABLE ROW LEVEL SECURITY;

--
-- Name: customers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."customers" ENABLE ROW LEVEL SECURITY;

--
-- Name: decline_rule_overrides; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."decline_rule_overrides" ENABLE ROW LEVEL SECURITY;

--
-- Name: decline_rule_overrides decline_rule_overrides_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "decline_rule_overrides_tenant" ON "public"."decline_rule_overrides" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: differential_prices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."differential_prices" ENABLE ROW LEVEL SECURITY;

--
-- Name: disputes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."disputes" ENABLE ROW LEVEL SECURITY;

--
-- Name: due_work; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."due_work" ENABLE ROW LEVEL SECURITY;

--
-- Name: dunning_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."dunning_policies" ENABLE ROW LEVEL SECURITY;

--
-- Name: email_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."email_messages" ENABLE ROW LEVEL SECURITY;

--
-- Name: email_suppressions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."email_suppressions" ENABLE ROW LEVEL SECURITY;

--
-- Name: email_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."email_templates" ENABLE ROW LEVEL SECURITY;

--
-- Name: events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."events" ENABLE ROW LEVEL SECURITY;

--
-- Name: exchange_rate_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."exchange_rate_history" ENABLE ROW LEVEL SECURITY;

--
-- Name: features; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."features" ENABLE ROW LEVEL SECURITY;

--
-- Name: gateway_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."gateway_accounts" ENABLE ROW LEVEL SECURITY;

--
-- Name: gateway_request_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."gateway_request_logs" ENABLE ROW LEVEL SECURITY;

--
-- Name: gateway_settlement_cursors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."gateway_settlement_cursors" ENABLE ROW LEVEL SECURITY;

--
-- Name: hubspot_action_executions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."hubspot_action_executions" ENABLE ROW LEVEL SECURITY;

--
-- Name: hubspot_conflicts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."hubspot_conflicts" ENABLE ROW LEVEL SECURITY;

--
-- Name: hubspot_connections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."hubspot_connections" ENABLE ROW LEVEL SECURITY;

--
-- Name: hubspot_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."hubspot_links" ENABLE ROW LEVEL SECURITY;

--
-- Name: hubspot_sync_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."hubspot_sync_items" ENABLE ROW LEVEL SECURITY;

--
-- Name: hubspot_sync_queue; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."hubspot_sync_queue" ENABLE ROW LEVEL SECURITY;

--
-- Name: hubspot_sync_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."hubspot_sync_runs" ENABLE ROW LEVEL SECURITY;

--
-- Name: idempotency_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."idempotency_keys" ENABLE ROW LEVEL SECURITY;

--
-- Name: import_records; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."import_records" ENABLE ROW LEVEL SECURITY;

--
-- Name: imported_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."imported_events" ENABLE ROW LEVEL SECURITY;

--
-- Name: ingest_rate_counters; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ingest_rate_counters" ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_connections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."integration_connections" ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_deliveries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."integration_deliveries" ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice_line_discounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."invoice_line_discounts" ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice_line_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."invoice_line_items" ENABLE ROW LEVEL SECURITY;

--
-- Name: invoices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."invoices" ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."ledger_entries" ENABLE ROW LEVEL SECURITY;

--
-- Name: list_views; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."list_views" ENABLE ROW LEVEL SECURITY;

--
-- Name: user_mfa member_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "member_isolation" ON "public"."user_mfa" USING ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE ("m"."user_id" = "user_mfa"."user_id")))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE ("m"."user_id" = "user_mfa"."user_id"))));


--
-- Name: users member_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "member_isolation" ON "public"."users" USING ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE ("m"."user_id" = "users"."id")))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE ("m"."user_id" = "users"."id"))));


--
-- Name: memberships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."memberships" ENABLE ROW LEVEL SECURITY;

--
-- Name: metadata_key_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."metadata_key_rules" ENABLE ROW LEVEL SECURITY;

--
-- Name: meters; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."meters" ENABLE ROW LEVEL SECURITY;

--
-- Name: metric_daily; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."metric_daily" ENABLE ROW LEVEL SECURITY;

--
-- Name: metric_windows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."metric_windows" ENABLE ROW LEVEL SECURITY;

--
-- Name: model_cost_overrides; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."model_cost_overrides" ENABLE ROW LEVEL SECURITY;

--
-- Name: model_price_notices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."model_price_notices" ENABLE ROW LEVEL SECURITY;

--
-- Name: mrr_movements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."mrr_movements" ENABLE ROW LEVEL SECURITY;

--
-- Name: api_keys org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."api_keys" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: api_request_logs org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."api_request_logs" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: applied_coupons org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."applied_coupons" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: applied_taxes org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."applied_taxes" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: attached_items org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."attached_items" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: audit_log_snapshots org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."audit_log_snapshots" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: audit_logs org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."audit_logs" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: businesses org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."businesses" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: buyer_request_rejections org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."buyer_request_rejections" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: checkout_session_items org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."checkout_session_items" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: checkout_sessions org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."checkout_sessions" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: comments org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."comments" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: contacts org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."contacts" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: coupon_item_constraints org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."coupon_item_constraints" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: coupon_set_codes org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."coupon_set_codes" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: coupon_sets org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."coupon_sets" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: coupons org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."coupons" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: credit_auto_topup_runs org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."credit_auto_topup_runs" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: credit_auto_topups org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."credit_auto_topups" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: credit_grant_movements org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."credit_grant_movements" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: credit_grants org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."credit_grants" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: credit_holds org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."credit_holds" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: credit_note_allocations org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."credit_note_allocations" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: credit_note_discounts org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."credit_note_discounts" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: credit_note_items org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."credit_note_items" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: credit_notes org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."credit_notes" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: credit_units org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."credit_units" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: custom_field_definitions org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."custom_field_definitions" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: customer_addresses org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."customer_addresses" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: customer_limit_tier_reached org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."customer_limit_tier_reached" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: customer_meter_billing org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."customer_meter_billing" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: customer_segments org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."customer_segments" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: customer_usage_keys org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."customer_usage_keys" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: customers org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."customers" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: differential_prices org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."differential_prices" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: disputes org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."disputes" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: due_work org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."due_work" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: dunning_policies org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."dunning_policies" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: email_messages org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."email_messages" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: email_suppressions org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."email_suppressions" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: email_templates org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."email_templates" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: events org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."events" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: exchange_rate_history org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."exchange_rate_history" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: features org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."features" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: gateway_accounts org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."gateway_accounts" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: gateway_settlement_cursors org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."gateway_settlement_cursors" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: hubspot_action_executions org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."hubspot_action_executions" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: hubspot_conflicts org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."hubspot_conflicts" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: hubspot_connections org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."hubspot_connections" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: hubspot_links org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."hubspot_links" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: hubspot_sync_items org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."hubspot_sync_items" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: hubspot_sync_queue org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."hubspot_sync_queue" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: hubspot_sync_runs org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."hubspot_sync_runs" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: idempotency_keys org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."idempotency_keys" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: import_records org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."import_records" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: imported_events org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."imported_events" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: ingest_rate_counters org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."ingest_rate_counters" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: integration_connections org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."integration_connections" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: integration_deliveries org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."integration_deliveries" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: invoice_line_discounts org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."invoice_line_discounts" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: invoice_line_items org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."invoice_line_items" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: invoices org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."invoices" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: ledger_entries org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."ledger_entries" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: list_views org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."list_views" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: memberships org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."memberships" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: metadata_key_rules org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."metadata_key_rules" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: meters org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."meters" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: metric_daily org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."metric_daily" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: metric_windows org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."metric_windows" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: model_cost_overrides org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."model_cost_overrides" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: model_price_notices org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."model_price_notices" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: mrr_movements org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."mrr_movements" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: org_mfa_reminders org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."org_mfa_reminders" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: organization_retention org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."organization_retention" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: organizations org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."organizations" USING (("id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: payment_attempts org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."payment_attempts" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: payment_instructions org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."payment_instructions" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: payment_intents org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."payment_intents" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: payment_link_items org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."payment_link_items" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: payment_links org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."payment_links" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: payment_method_authorizations org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."payment_method_authorizations" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: payment_methods org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."payment_methods" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: payment_request_invoices org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."payment_request_invoices" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: payment_requests org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."payment_requests" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: payments org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."payments" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: plan_entitlements org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."plan_entitlements" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: portal_login_codes org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."portal_login_codes" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: portal_sessions org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."portal_sessions" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: pre_debit_notices org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."pre_debit_notices" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: price_rates org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."price_rates" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: prices org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."prices" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: product_groups org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."product_groups" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: products org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."products" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: promotional_credit_movements org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."promotional_credit_movements" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: provider_customers org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."provider_customers" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: reason_codes org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."reason_codes" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: receipts org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."receipts" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: refunds org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."refunds" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: renewal_skips org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."renewal_skips" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: report_dashboard_tiles org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."report_dashboard_tiles" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: report_dashboards org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."report_dashboards" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: retention_events org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."retention_events" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: roles org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."roles" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: scheduled_changes org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."scheduled_changes" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: sessions org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."sessions" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: spend_limit_states org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."spend_limit_states" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: spend_limit_tiers org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."spend_limit_tiers" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: spend_limits org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."spend_limits" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: subscription_charge_log org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."subscription_charge_log" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: subscription_entitlements org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."subscription_entitlements" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: subscription_items org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."subscription_items" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: subscriptions org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."subscriptions" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: tax_profiles org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."tax_profiles" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: tax_rate_components org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."tax_rate_components" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: tax_regions org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."tax_regions" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: tax_state_registrations org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."tax_state_registrations" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: team_alert_recipients org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."team_alert_recipients" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: time_travels org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."time_travels" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: transactions org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."transactions" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: transfer_configurations org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."transfer_configurations" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: unbilled_charges org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."unbilled_charges" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: usage_alert_observations org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."usage_alert_observations" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: usage_alert_states org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."usage_alert_states" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: usage_alerts org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."usage_alerts" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: usage_control_cursors org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."usage_control_cursors" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: usage_control_dirty org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."usage_control_dirty" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: usage_event_dedup org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."usage_event_dedup" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: usage_events org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."usage_events" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: usage_invoice_thresholds org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."usage_invoice_thresholds" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: usage_meter_levels org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."usage_meter_levels" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: usage_records org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."usage_records" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: usage_rollup_state org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."usage_rollup_state" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: usage_rollups org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."usage_rollups" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: usage_widget_tokens org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."usage_widget_tokens" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: wallet_topups org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."wallet_topups" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: webhook_deliveries org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."webhook_deliveries" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: webhook_endpoints org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org_isolation" ON "public"."webhook_endpoints" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: org_mfa_reminders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."org_mfa_reminders" ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_retention; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."organization_retention" ENABLE ROW LEVEL SECURITY;

--
-- Name: organizations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."organizations" ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."payment_attempts" ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_instructions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."payment_instructions" ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_intents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."payment_intents" ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_link_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."payment_link_items" ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."payment_links" ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_method_authorizations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."payment_method_authorizations" ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_methods; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."payment_methods" ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_request_invoices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."payment_request_invoices" ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."payment_requests" ENABLE ROW LEVEL SECURITY;

--
-- Name: payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;

--
-- Name: plan_entitlements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."plan_entitlements" ENABLE ROW LEVEL SECURITY;

--
-- Name: portal_login_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."portal_login_codes" ENABLE ROW LEVEL SECURITY;

--
-- Name: portal_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."portal_sessions" ENABLE ROW LEVEL SECURITY;

--
-- Name: pre_debit_notices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."pre_debit_notices" ENABLE ROW LEVEL SECURITY;

--
-- Name: price_rates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."price_rates" ENABLE ROW LEVEL SECURITY;

--
-- Name: prices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."prices" ENABLE ROW LEVEL SECURITY;

--
-- Name: product_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."product_groups" ENABLE ROW LEVEL SECURITY;

--
-- Name: products; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."products" ENABLE ROW LEVEL SECURITY;

--
-- Name: promotional_credit_movements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."promotional_credit_movements" ENABLE ROW LEVEL SECURITY;

--
-- Name: provider_customers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."provider_customers" ENABLE ROW LEVEL SECURITY;

--
-- Name: reason_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."reason_codes" ENABLE ROW LEVEL SECURITY;

--
-- Name: receipts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."receipts" ENABLE ROW LEVEL SECURITY;

--
-- Name: refunds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."refunds" ENABLE ROW LEVEL SECURITY;

--
-- Name: renewal_skips; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."renewal_skips" ENABLE ROW LEVEL SECURITY;

--
-- Name: report_dashboard_tiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."report_dashboard_tiles" ENABLE ROW LEVEL SECURITY;

--
-- Name: report_dashboards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."report_dashboards" ENABLE ROW LEVEL SECURITY;

--
-- Name: retention_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."retention_events" ENABLE ROW LEVEL SECURITY;

--
-- Name: roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."roles" ENABLE ROW LEVEL SECURITY;

--
-- Name: scheduled_changes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."scheduled_changes" ENABLE ROW LEVEL SECURITY;

--
-- Name: sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."sessions" ENABLE ROW LEVEL SECURITY;

--
-- Name: settlement_poll_schedule; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."settlement_poll_schedule" ENABLE ROW LEVEL SECURITY;

--
-- Name: settlement_poll_schedule settlement_poll_schedule_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "settlement_poll_schedule_tenant" ON "public"."settlement_poll_schedule" USING (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid")) WITH CHECK (("organization_id" = ("current_setting"('app.org_id'::"text", true))::"uuid"));


--
-- Name: spend_limit_states; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."spend_limit_states" ENABLE ROW LEVEL SECURITY;

--
-- Name: spend_limit_tiers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."spend_limit_tiers" ENABLE ROW LEVEL SECURITY;

--
-- Name: spend_limits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."spend_limits" ENABLE ROW LEVEL SECURITY;

--
-- Name: subscription_charge_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."subscription_charge_log" ENABLE ROW LEVEL SECURITY;

--
-- Name: subscription_entitlements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."subscription_entitlements" ENABLE ROW LEVEL SECURITY;

--
-- Name: subscription_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."subscription_items" ENABLE ROW LEVEL SECURITY;

--
-- Name: subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."subscriptions" ENABLE ROW LEVEL SECURITY;

--
-- Name: tax_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."tax_profiles" ENABLE ROW LEVEL SECURITY;

--
-- Name: tax_rate_components; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."tax_rate_components" ENABLE ROW LEVEL SECURITY;

--
-- Name: tax_regions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."tax_regions" ENABLE ROW LEVEL SECURITY;

--
-- Name: tax_state_registrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."tax_state_registrations" ENABLE ROW LEVEL SECURITY;

--
-- Name: team_alert_recipients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."team_alert_recipients" ENABLE ROW LEVEL SECURITY;

--
-- Name: time_travels; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."time_travels" ENABLE ROW LEVEL SECURITY;

--
-- Name: tmtest_charges; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."tmtest_charges" ENABLE ROW LEVEL SECURITY;

--
-- Name: tmtest_outbound; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."tmtest_outbound" ENABLE ROW LEVEL SECURITY;

--
-- Name: transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."transactions" ENABLE ROW LEVEL SECURITY;

--
-- Name: transfer_configurations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."transfer_configurations" ENABLE ROW LEVEL SECURITY;

--
-- Name: unbilled_charges; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."unbilled_charges" ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_alert_observations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."usage_alert_observations" ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_alert_states; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."usage_alert_states" ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_alerts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."usage_alerts" ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_control_cursors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."usage_control_cursors" ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_control_dirty; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."usage_control_dirty" ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_event_dedup; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."usage_event_dedup" ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."usage_events" ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_invoice_thresholds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."usage_invoice_thresholds" ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_meter_levels; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."usage_meter_levels" ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_records; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."usage_records" ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_rollup_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."usage_rollup_state" ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_rollups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."usage_rollups" ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_widget_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."usage_widget_tokens" ENABLE ROW LEVEL SECURITY;

--
-- Name: user_mfa; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."user_mfa" ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;

--
-- Name: wallet_topups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."wallet_topups" ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_deliveries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."webhook_deliveries" ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_endpoints; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."webhook_endpoints" ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA "public"; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA "public" TO "tmbilling_app";


--
-- Name: FUNCTION "app_nudge_integration_outbox"(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."app_nudge_integration_outbox"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."app_nudge_integration_outbox"() TO "tmbilling_app";


--
-- Name: FUNCTION "app_nudge_webhook_outbox"(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."app_nudge_webhook_outbox"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."app_nudge_webhook_outbox"() TO "tmbilling_app";


--
-- Name: FUNCTION "app_wipe_test_ledger"("p_business" "uuid"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."app_wipe_test_ledger"("p_business" "uuid") FROM PUBLIC;


--
-- Name: FUNCTION "usage_create_partition"("p_table" "text", "p_month" "date"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."usage_create_partition"("p_table" "text", "p_month" "date") FROM PUBLIC;


--
-- Name: FUNCTION "usage_drop_partition"("p_table" "text", "p_month" "date"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION "public"."usage_drop_partition"("p_table" "text", "p_month" "date") FROM PUBLIC;


--
-- Name: TABLE "api_keys"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."api_keys" TO "tmbilling_app";


--
-- Name: TABLE "api_request_logs"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE "public"."api_request_logs" TO "tmbilling_app";


--
-- Name: TABLE "applied_coupons"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."applied_coupons" TO "tmbilling_app";


--
-- Name: TABLE "applied_taxes"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."applied_taxes" TO "tmbilling_app";


--
-- Name: TABLE "attached_items"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."attached_items" TO "tmbilling_app";


--
-- Name: TABLE "audit_log_snapshots"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE "public"."audit_log_snapshots" TO "tmbilling_app";


--
-- Name: TABLE "audit_logs"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE "public"."audit_logs" TO "tmbilling_app";


--
-- Name: TABLE "businesses"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."businesses" TO "tmbilling_app";


--
-- Name: TABLE "checkout_session_items"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."checkout_session_items" TO "tmbilling_app";


--
-- Name: TABLE "checkout_sessions"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."checkout_sessions" TO "tmbilling_app";


--
-- Name: TABLE "comments"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."comments" TO "tmbilling_app";


--
-- Name: TABLE "contacts"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."contacts" TO "tmbilling_app";


--
-- Name: TABLE "countries"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE "public"."countries" TO "tmbilling_app";


--
-- Name: TABLE "coupon_item_constraints"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."coupon_item_constraints" TO "tmbilling_app";


--
-- Name: TABLE "coupon_set_codes"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."coupon_set_codes" TO "tmbilling_app";


--
-- Name: TABLE "coupon_sets"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."coupon_sets" TO "tmbilling_app";


--
-- Name: TABLE "coupons"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."coupons" TO "tmbilling_app";


--
-- Name: TABLE "credit_auto_topup_runs"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE "public"."credit_auto_topup_runs" TO "tmbilling_app";


--
-- Name: TABLE "credit_auto_topups"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE "public"."credit_auto_topups" TO "tmbilling_app";


--
-- Name: TABLE "credit_grant_movements"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE "public"."credit_grant_movements" TO "tmbilling_app";


--
-- Name: TABLE "credit_grants"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE "public"."credit_grants" TO "tmbilling_app";


--
-- Name: TABLE "credit_holds"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE "public"."credit_holds" TO "tmbilling_app";


--
-- Name: TABLE "credit_note_allocations"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."credit_note_allocations" TO "tmbilling_app";


--
-- Name: TABLE "credit_note_discounts"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."credit_note_discounts" TO "tmbilling_app";


--
-- Name: TABLE "credit_note_items"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."credit_note_items" TO "tmbilling_app";


--
-- Name: TABLE "credit_notes"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."credit_notes" TO "tmbilling_app";


--
-- Name: TABLE "credit_units"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE "public"."credit_units" TO "tmbilling_app";


--
-- Name: TABLE "custom_field_definitions"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."custom_field_definitions" TO "tmbilling_app";


--
-- Name: TABLE "customer_addresses"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."customer_addresses" TO "tmbilling_app";


--
-- Name: TABLE "customer_limit_tier_reached"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE "public"."customer_limit_tier_reached" TO "tmbilling_app";


--
-- Name: TABLE "customer_meter_billing"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."customer_meter_billing" TO "tmbilling_app";


--
-- Name: TABLE "customer_segments"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."customer_segments" TO "tmbilling_app";


--
-- Name: TABLE "customer_usage_keys"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."customer_usage_keys" TO "tmbilling_app";


--
-- Name: TABLE "customers"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."customers" TO "tmbilling_app";


--
-- Name: TABLE "decline_rule_overrides"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."decline_rule_overrides" TO "tmbilling_app";


--
-- Name: TABLE "differential_prices"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."differential_prices" TO "tmbilling_app";


--
-- Name: TABLE "disputes"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."disputes" TO "tmbilling_app";


--
-- Name: TABLE "due_work"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."due_work" TO "tmbilling_app";


--
-- Name: TABLE "dunning_policies"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."dunning_policies" TO "tmbilling_app";


--
-- Name: TABLE "email_messages"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."email_messages" TO "tmbilling_app";


--
-- Name: TABLE "email_suppressions"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."email_suppressions" TO "tmbilling_app";


--
-- Name: TABLE "email_templates"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."email_templates" TO "tmbilling_app";


--
-- Name: TABLE "events"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."events" TO "tmbilling_app";


--
-- Name: TABLE "exchange_rate_history"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE "public"."exchange_rate_history" TO "tmbilling_app";


--
-- Name: TABLE "features"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."features" TO "tmbilling_app";


--
-- Name: TABLE "gateway_accounts"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."gateway_accounts" TO "tmbilling_app";


--
-- Name: TABLE "gateway_request_logs"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."gateway_request_logs" TO "tmbilling_app";


--
-- Name: TABLE "gateway_settlement_cursors"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."gateway_settlement_cursors" TO "tmbilling_app";


--
-- Name: TABLE "hubspot_action_executions"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."hubspot_action_executions" TO "tmbilling_app";


--
-- Name: TABLE "hubspot_conflicts"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."hubspot_conflicts" TO "tmbilling_app";


--
-- Name: TABLE "hubspot_connections"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."hubspot_connections" TO "tmbilling_app";


--
-- Name: TABLE "hubspot_links"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."hubspot_links" TO "tmbilling_app";


--
-- Name: TABLE "hubspot_sync_items"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."hubspot_sync_items" TO "tmbilling_app";


--
-- Name: TABLE "hubspot_sync_queue"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."hubspot_sync_queue" TO "tmbilling_app";


--
-- Name: TABLE "hubspot_sync_runs"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."hubspot_sync_runs" TO "tmbilling_app";


--
-- Name: TABLE "idempotency_keys"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."idempotency_keys" TO "tmbilling_app";


--
-- Name: TABLE "import_records"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."import_records" TO "tmbilling_app";


--
-- Name: TABLE "imported_events"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."imported_events" TO "tmbilling_app";


--
-- Name: TABLE "ingest_rate_counters"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."ingest_rate_counters" TO "tmbilling_app";


--
-- Name: TABLE "integration_connections"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."integration_connections" TO "tmbilling_app";


--
-- Name: TABLE "integration_deliveries"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."integration_deliveries" TO "tmbilling_app";


--
-- Name: TABLE "invoice_line_discounts"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."invoice_line_discounts" TO "tmbilling_app";


--
-- Name: TABLE "invoice_line_items"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."invoice_line_items" TO "tmbilling_app";


--
-- Name: SEQUENCE "invoice_line_items_seq_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE "public"."invoice_line_items_seq_seq" TO "tmbilling_app";


--
-- Name: TABLE "invoices"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."invoices" TO "tmbilling_app";


--
-- Name: TABLE "ledger_entries"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE "public"."ledger_entries" TO "tmbilling_app";


--
-- Name: TABLE "list_views"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."list_views" TO "tmbilling_app";


--
-- Name: TABLE "memberships"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."memberships" TO "tmbilling_app";


--
-- Name: TABLE "metadata_key_rules"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."metadata_key_rules" TO "tmbilling_app";


--
-- Name: TABLE "meters"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."meters" TO "tmbilling_app";


--
-- Name: TABLE "metric_daily"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."metric_daily" TO "tmbilling_app";


--
-- Name: TABLE "metric_windows"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."metric_windows" TO "tmbilling_app";


--
-- Name: TABLE "model_cost_overrides"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."model_cost_overrides" TO "tmbilling_app";


--
-- Name: TABLE "model_price_models"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE "public"."model_price_models" TO "tmbilling_app";


--
-- Name: TABLE "model_price_notices"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE "public"."model_price_notices" TO "tmbilling_app";


--
-- Name: TABLE "model_prices"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE "public"."model_prices" TO "tmbilling_app";


--
-- Name: TABLE "mrr_movements"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE "public"."mrr_movements" TO "tmbilling_app";


--
-- Name: COLUMN "mrr_movements"."plan_product_id"; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE("plan_product_id") ON TABLE "public"."mrr_movements" TO "tmbilling_app";


--
-- Name: COLUMN "mrr_movements"."previous_plan_product_id"; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE("previous_plan_product_id") ON TABLE "public"."mrr_movements" TO "tmbilling_app";


--
-- Name: TABLE "subscriptions"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."subscriptions" TO "tmbilling_app";


--
-- Name: TABLE "mrr_movement_summary"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE "public"."mrr_movement_summary" TO "tmbilling_app";


--
-- Name: TABLE "organization_retention"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."organization_retention" TO "tmbilling_app";


--
-- Name: TABLE "organizations"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."organizations" TO "tmbilling_app";


--
-- Name: TABLE "payment_attempts"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."payment_attempts" TO "tmbilling_app";


--
-- Name: TABLE "payment_instructions"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."payment_instructions" TO "tmbilling_app";


--
-- Name: TABLE "payment_intents"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."payment_intents" TO "tmbilling_app";


--
-- Name: TABLE "payment_link_items"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."payment_link_items" TO "tmbilling_app";


--
-- Name: TABLE "payment_links"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."payment_links" TO "tmbilling_app";


--
-- Name: TABLE "payment_method_authorizations"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE "public"."payment_method_authorizations" TO "tmbilling_app";


--
-- Name: TABLE "payment_methods"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."payment_methods" TO "tmbilling_app";


--
-- Name: TABLE "payment_request_invoices"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."payment_request_invoices" TO "tmbilling_app";


--
-- Name: TABLE "payment_requests"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."payment_requests" TO "tmbilling_app";


--
-- Name: TABLE "payments"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."payments" TO "tmbilling_app";


--
-- Name: TABLE "plan_entitlements"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."plan_entitlements" TO "tmbilling_app";


--
-- Name: TABLE "portal_login_codes"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE "public"."portal_login_codes" TO "tmbilling_app";


--
-- Name: TABLE "portal_sessions"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."portal_sessions" TO "tmbilling_app";


--
-- Name: TABLE "pre_debit_notices"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."pre_debit_notices" TO "tmbilling_app";


--
-- Name: TABLE "price_rates"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."price_rates" TO "tmbilling_app";


--
-- Name: TABLE "prices"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."prices" TO "tmbilling_app";


--
-- Name: TABLE "product_groups"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."product_groups" TO "tmbilling_app";


--
-- Name: TABLE "products"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."products" TO "tmbilling_app";


--
-- Name: TABLE "promotional_credit_movements"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."promotional_credit_movements" TO "tmbilling_app";


--
-- Name: TABLE "provider_customers"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."provider_customers" TO "tmbilling_app";


--
-- Name: TABLE "reason_codes"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."reason_codes" TO "tmbilling_app";


--
-- Name: TABLE "receipts"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE "public"."receipts" TO "tmbilling_app";


--
-- Name: TABLE "refunds"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."refunds" TO "tmbilling_app";


--
-- Name: TABLE "renewal_skips"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."renewal_skips" TO "tmbilling_app";


--
-- Name: TABLE "report_dashboard_tiles"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."report_dashboard_tiles" TO "tmbilling_app";


--
-- Name: TABLE "report_dashboards"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."report_dashboards" TO "tmbilling_app";


--
-- Name: TABLE "retention_events"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE "public"."retention_events" TO "tmbilling_app";


--
-- Name: TABLE "roles"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE "public"."roles" TO "tmbilling_app";


--
-- Name: TABLE "scheduled_changes"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."scheduled_changes" TO "tmbilling_app";


--
-- Name: TABLE "sessions"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."sessions" TO "tmbilling_app";


--
-- Name: TABLE "settlement_poll_schedule"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."settlement_poll_schedule" TO "tmbilling_app";


--
-- Name: TABLE "spend_limit_states"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE "public"."spend_limit_states" TO "tmbilling_app";


--
-- Name: TABLE "spend_limit_tiers"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE "public"."spend_limit_tiers" TO "tmbilling_app";


--
-- Name: TABLE "spend_limits"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."spend_limits" TO "tmbilling_app";


--
-- Name: TABLE "subscription_charge_log"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."subscription_charge_log" TO "tmbilling_app";


--
-- Name: TABLE "subscription_entitlements"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."subscription_entitlements" TO "tmbilling_app";


--
-- Name: TABLE "subscription_items"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."subscription_items" TO "tmbilling_app";


--
-- Name: TABLE "tax_profiles"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."tax_profiles" TO "tmbilling_app";


--
-- Name: TABLE "tax_rate_components"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."tax_rate_components" TO "tmbilling_app";


--
-- Name: TABLE "tax_regions"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."tax_regions" TO "tmbilling_app";


--
-- Name: TABLE "tax_state_registrations"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."tax_state_registrations" TO "tmbilling_app";


--
-- Name: TABLE "team_alert_recipients"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."team_alert_recipients" TO "tmbilling_app";


--
-- Name: TABLE "time_travels"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."time_travels" TO "tmbilling_app";


--
-- Name: TABLE "tmtest_charges"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."tmtest_charges" TO "tmbilling_app";


--
-- Name: TABLE "tmtest_outbound"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."tmtest_outbound" TO "tmbilling_app";


--
-- Name: TABLE "transactions"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."transactions" TO "tmbilling_app";


--
-- Name: TABLE "transfer_configurations"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."transfer_configurations" TO "tmbilling_app";


--
-- Name: TABLE "unbilled_charges"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."unbilled_charges" TO "tmbilling_app";


--
-- Name: TABLE "usage_alert_observations"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."usage_alert_observations" TO "tmbilling_app";


--
-- Name: TABLE "usage_alert_states"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."usage_alert_states" TO "tmbilling_app";


--
-- Name: TABLE "usage_alerts"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."usage_alerts" TO "tmbilling_app";


--
-- Name: TABLE "usage_control_cursors"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."usage_control_cursors" TO "tmbilling_app";


--
-- Name: TABLE "usage_control_dirty"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE "public"."usage_control_dirty" TO "tmbilling_app";


--
-- Name: TABLE "usage_event_dedup"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE "public"."usage_event_dedup" TO "tmbilling_app";


--
-- Name: TABLE "usage_events"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE "public"."usage_events" TO "tmbilling_app";


--
-- Name: TABLE "usage_invoice_thresholds"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."usage_invoice_thresholds" TO "tmbilling_app";


--
-- Name: TABLE "usage_meter_levels"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."usage_meter_levels" TO "tmbilling_app";


--
-- Name: TABLE "usage_records"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."usage_records" TO "tmbilling_app";


--
-- Name: TABLE "usage_rollup_state"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE "public"."usage_rollup_state" TO "tmbilling_app";


--
-- Name: SEQUENCE "usage_rollup_version_seq"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE "public"."usage_rollup_version_seq" TO "tmbilling_app";


--
-- Name: TABLE "usage_rollups"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."usage_rollups" TO "tmbilling_app";


--
-- Name: TABLE "usage_widget_tokens"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."usage_widget_tokens" TO "tmbilling_app";


--
-- Name: TABLE "user_mfa"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."user_mfa" TO "tmbilling_app";


--
-- Name: TABLE "users"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."users" TO "tmbilling_app";


--
-- Name: TABLE "wallet_topups"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."wallet_topups" TO "tmbilling_app";


--
-- Name: TABLE "webhook_deliveries"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."webhook_deliveries" TO "tmbilling_app";


--
-- Name: TABLE "webhook_endpoints"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."webhook_endpoints" TO "tmbilling_app";


--
-- PostgreSQL database dump complete
--



--
-- Read access to graphile_worker's tables (installed by db:bootstrap).
--

GRANT USAGE ON SCHEMA "graphile_worker" TO "tmbilling_app";
GRANT SELECT ON TABLE "graphile_worker"."_private_jobs" TO "tmbilling_app";
GRANT SELECT ON TABLE "graphile_worker"."_private_job_queues" TO "tmbilling_app";
GRANT SELECT ON TABLE "graphile_worker"."_private_known_crontabs" TO "tmbilling_app";
GRANT SELECT ON TABLE "graphile_worker"."_private_tasks" TO "tmbilling_app";
GRANT SELECT ON TABLE "graphile_worker"."jobs" TO "tmbilling_app";

-- Why an operator voided credit (a closed list plus a note), one row per voided grant, written
-- in the void's transaction. And the full refund option of a credit note on a credit pack line.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS credit_grant_void_reasons (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  grant_id uuid NOT NULL REFERENCES credit_grants(id) ON DELETE CASCADE,
  reason text NOT NULL,
  note text,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  CONSTRAINT credit_grant_void_reasons_reason_ck CHECK (reason IN (
    'customer_request', 'fraud', 'goodwill_reversal', 'billing_error', 'migration', 'other')),
  CONSTRAINT credit_grant_void_reasons_note_ck CHECK (note IS NULL OR char_length(note) <= 500),
  CONSTRAINT credit_grant_void_reasons_other_ck CHECK (reason <> 'other' OR note IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS credit_grant_void_reasons_grant_uq ON credit_grant_void_reasons (grant_id);
--> statement-breakpoint
REVOKE ALL ON credit_grant_void_reasons FROM tmbilling_app;
--> statement-breakpoint
-- Append-only for the app role.
GRANT SELECT, INSERT ON credit_grant_void_reasons TO tmbilling_app;
--> statement-breakpoint
ALTER TABLE credit_grant_void_reasons ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'credit_grant_void_reasons' AND policyname = 'org_isolation') THEN
    CREATE POLICY org_isolation ON credit_grant_void_reasons
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
END $$;
--> statement-breakpoint
-- NULL = the note credits only the unused part of a pack line (the rule before this column).
ALTER TABLE credit_notes ADD COLUMN IF NOT EXISTS pack_refund text;
--> statement-breakpoint
ALTER TABLE credit_notes DROP CONSTRAINT IF EXISTS credit_notes_pack_refund_ck;
--> statement-breakpoint
ALTER TABLE credit_notes ADD CONSTRAINT credit_notes_pack_refund_ck
  CHECK (pack_refund IS NULL OR pack_refund = 'full') NOT VALID;
--> statement-breakpoint
ALTER TABLE credit_notes VALIDATE CONSTRAINT credit_notes_pack_refund_ck;

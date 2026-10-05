-- A pause is authorized and audited without requiring an operator explanation.
-- Existing reasons remain intact; enabling updates still requires a reason.
ALTER TABLE channels.sync_settings
  ALTER COLUMN change_reason DROP NOT NULL,
  DROP CONSTRAINT sync_settings_change_reason_chk,
  ADD CONSTRAINT sync_settings_change_reason_chk CHECK (
    (global_enabled = FALSE AND change_reason IS NULL)
    OR (change_reason IS NOT NULL AND change_reason = btrim(change_reason) AND change_reason <> '')
  );

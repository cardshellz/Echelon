-- Routine channel-inventory draft saves no longer require a written reason.
--
-- Owner decision (docs/INVENTORY-CHANNEL-CONTROLS-DESIGNER-HANDOFF.md §10):
-- auditability is not the same as forcing people to justify ordinary edits.
-- Every draft save still records the authenticated actor, time, scope,
-- request identity, and before/after values in audit_events; an operator note
-- is stored when one was written and is NULL otherwise. Nothing fabricates a
-- reason on the operator's behalf.
--
-- Scope: the versioned draft definitions (channel rules, supply bindings,
-- exact SKU identities), their head pointers, and disabled destination
-- registration. Sensitive publication commands (readiness inclusion, stop,
-- resume, global control, cutover) keep their required reasons; their tables
-- and contracts are untouched here. No data is rewritten.

ALTER TABLE inventory.channel_exposure_policy_versions
  ALTER COLUMN change_reason DROP NOT NULL,
  DROP CONSTRAINT channel_exposure_policy_versions_actor_chk,
  ADD CONSTRAINT channel_exposure_policy_versions_actor_chk CHECK (
    char_length(btrim(created_by)) BETWEEN 1 AND 100
    AND (change_reason IS NULL OR char_length(btrim(change_reason)) BETWEEN 1 AND 1000)
  );

ALTER TABLE inventory.channel_exposure_policy_heads
  ALTER COLUMN update_reason DROP NOT NULL,
  DROP CONSTRAINT channel_exposure_policy_heads_actor_chk,
  ADD CONSTRAINT channel_exposure_policy_heads_actor_chk CHECK (
    char_length(btrim(updated_by)) BETWEEN 1 AND 100
    AND (update_reason IS NULL OR char_length(btrim(update_reason)) BETWEEN 1 AND 1000)
  );

ALTER TABLE inventory.publication_source_binding_versions
  ALTER COLUMN change_reason DROP NOT NULL,
  DROP CONSTRAINT publication_source_binding_versions_actor_chk,
  ADD CONSTRAINT publication_source_binding_versions_actor_chk CHECK (
    char_length(btrim(created_by)) BETWEEN 1 AND 100
    AND (change_reason IS NULL OR char_length(btrim(change_reason)) BETWEEN 1 AND 1000)
  );

ALTER TABLE inventory.publication_source_binding_heads
  ALTER COLUMN update_reason DROP NOT NULL,
  DROP CONSTRAINT publication_source_binding_heads_actor_chk,
  ADD CONSTRAINT publication_source_binding_heads_actor_chk CHECK (
    char_length(btrim(updated_by)) BETWEEN 1 AND 100
    AND (update_reason IS NULL OR char_length(btrim(update_reason)) BETWEEN 1 AND 1000)
  );

ALTER TABLE inventory.publication_variant_mapping_versions
  ALTER COLUMN change_reason DROP NOT NULL,
  DROP CONSTRAINT publication_variant_mapping_versions_actor_chk,
  ADD CONSTRAINT publication_variant_mapping_versions_actor_chk CHECK (
    char_length(btrim(created_by)) BETWEEN 1 AND 100
    AND (change_reason IS NULL OR char_length(btrim(change_reason)) BETWEEN 1 AND 1000)
  );

ALTER TABLE inventory.publication_variant_mapping_heads
  ALTER COLUMN update_reason DROP NOT NULL,
  DROP CONSTRAINT publication_variant_mapping_heads_actor_chk,
  ADD CONSTRAINT publication_variant_mapping_heads_actor_chk CHECK (
    char_length(btrim(updated_by)) BETWEEN 1 AND 100
    AND (update_reason IS NULL OR char_length(btrim(update_reason)) BETWEEN 1 AND 1000)
  );

-- Destination registration creates a disabled target only; it is setup work
-- with edit permission, not a publication command.
ALTER TABLE inventory.inventory_publication_targets
  ALTER COLUMN change_reason DROP NOT NULL,
  DROP CONSTRAINT inventory_publication_targets_actor_chk,
  ADD CONSTRAINT inventory_publication_targets_actor_chk CHECK (
    btrim(created_by) <> ''
    AND (change_reason IS NULL OR btrim(change_reason) <> '')
  );

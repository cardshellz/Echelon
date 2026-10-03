-- Preserve sealed model hashes, claims and inventory. The first reviewed edit
-- creates a successor carrying the explicit product behavior; no legacy flag is
-- copied into operational authority and no active head is changed here.
ALTER TABLE inventory.transformation_model_versions
  ADD COLUMN IF NOT EXISTS inventory_behavior varchar(30);

ALTER TABLE inventory.transformation_model_versions
  ADD CONSTRAINT transformation_model_versions_behavior_chk
  CHECK (inventory_behavior IS NULL OR inventory_behavior IN
    ('physical_only', 'package_hierarchy', 'build_managed'));

-- Validate the final transaction state, after the model and its members have
-- been written. Existing lifecycle guards already make sealed definitions
-- immutable (including this column).
CREATE FUNCTION inventory.guard_model_inventory_behavior() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_id integer;
  selected_mode varchar(30);
  promise_builds boolean;
  selected_validation varchar(20);
BEGIN
  IF TG_TABLE_NAME = 'transformation_model_versions' THEN
    target_id := COALESCE(NEW.id, OLD.id);
  ELSE
    target_id := COALESCE(NEW.model_id, OLD.model_id);
  END IF;
  SELECT inventory_behavior, build_to_promise_enabled, validation_state
    INTO selected_mode, promise_builds, selected_validation
    FROM inventory.transformation_model_versions WHERE id = target_id;
  IF selected_mode IS NULL OR selected_validation <> 'valid' THEN RETURN NULL; END IF;

  IF selected_mode <> 'build_managed' AND (promise_builds OR EXISTS (
    SELECT 1 FROM inventory.transformation_recipe_bindings WHERE model_id = target_id
  )) THEN
    RAISE EXCEPTION 'model % inventory behavior does not permit recipes', target_id
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM inventory.transformation_model_paths
    WHERE model_id = target_id AND authority_state = 'allowed' AND (
      selected_mode = 'physical_only'
      OR (selected_mode = 'package_hierarchy' AND
        (operation_type NOT IN ('break_pack', 'assemble_pack') OR transformation_recipe_binding_id IS NOT NULL))
      OR (selected_mode = 'build_managed' AND
        (operation_type <> 'directed_conversion' OR transformation_recipe_binding_id IS NULL))
    )
  ) THEN
    RAISE EXCEPTION 'model % inventory behavior conflicts with allowed paths', target_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER transformation_model_behavior_guard
AFTER INSERT OR UPDATE ON inventory.transformation_model_versions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION inventory.guard_model_inventory_behavior();
CREATE CONSTRAINT TRIGGER transformation_path_behavior_guard
AFTER INSERT OR UPDATE OR DELETE ON inventory.transformation_model_paths
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION inventory.guard_model_inventory_behavior();
CREATE CONSTRAINT TRIGGER transformation_binding_behavior_guard
AFTER INSERT OR UPDATE OR DELETE ON inventory.transformation_recipe_bindings
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION inventory.guard_model_inventory_behavior();

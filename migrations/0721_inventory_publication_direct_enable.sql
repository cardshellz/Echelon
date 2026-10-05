-- A disabled account can be enabled directly by the inventory-owned command.
-- Preserve identity, revision, membership and live-stop protections.
CREATE OR REPLACE FUNCTION inventory.guard_inventory_publication_target_update()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.destination_kind IS DISTINCT FROM OLD.destination_kind
     OR NEW.channel_id IS DISTINCT FROM OLD.channel_id OR NEW.channel_connection_id IS DISTINCT FROM OLD.channel_connection_id
     OR NEW.dropship_store_connection_id IS DISTINCT FROM OLD.dropship_store_connection_id
     OR NEW.fulfillment_node_id IS DISTINCT FROM OLD.fulfillment_node_id
     OR NEW.provider_scope_type IS DISTINCT FROM OLD.provider_scope_type OR NEW.external_scope_id IS DISTINCT FROM OLD.external_scope_id
     OR NEW.publication_authority IS DISTINCT FROM OLD.publication_authority OR NEW.change_reason IS DISTINCT FROM OLD.change_reason
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'inventory publication target identity and creation evidence are immutable';
  END IF;
  IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'inventory publication target revision must increment by 1'; END IF;
  IF OLD.state='live' AND NEW.state NOT IN ('live','disabled') THEN
    RAISE EXCEPTION 'a live publication target can only remain live or enter the scoped disabled stop state';
  END IF;
  IF NEW.state='live' AND OLD.state='disabled' THEN
    -- Direct enable must own the same exclusive admission fence as setup promotion.
    PERFORM inventory.assert_cutover_admission_fence_owner();
  ELSIF NEW.state='live' AND OLD.state NOT IN ('preview','live') THEN
    RAISE EXCEPTION 'a publication target must be previewed before it becomes live';
  END IF;
  NEW.updated_at:=transaction_timestamp(); RETURN NEW;
END $$;

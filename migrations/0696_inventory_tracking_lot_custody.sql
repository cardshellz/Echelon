-- Picked and packed quantities remain inventory custody even when the lot has
-- no available stock. Serialize these writes with inventory policy changes.
DROP TRIGGER IF EXISTS inventory_lots_require_tracking ON inventory.inventory_lots;
CREATE TRIGGER inventory_lots_require_tracking BEFORE INSERT OR UPDATE ON inventory.inventory_lots
FOR EACH ROW WHEN (NEW.qty_on_hand <> 0 OR NEW.qty_reserved <> 0 OR NEW.qty_picked <> 0 OR NEW.qty_packed <> 0)
EXECUTE FUNCTION catalog.require_tracked_inventory_identity('product_variant_id');

# Future Work — Pick Zones & Split-Pick Routing

This doc tracks work deferred from the pick zones infrastructure PR.

## Context

As of migration `0081_pick_zones_infrastructure.sql` the database supports
per-warehouse pick zones, but the picker service is not yet zone-aware. Every
warehouse gets a single `DEFAULT` zone; all pick operations continue to behave
exactly as they did before.

This lets us model split-pick routing (EACH vs CASE vs PALLET, different
equipment, different priorities) without rewriting the picker today.

## Deferred work

### 1. Editable Pick Zones admin UI
- POST/PUT/DELETE routes on `/api/warehouse-pick-zones`
- Create/edit/delete zone dialogs on `/pick-zones` page
- Validation: cannot delete DEFAULT zone, cannot have overlapping UOM ranges

### 2. Per-location zone assignment
- UI on warehouse location detail page to assign a `pick_zone_id`
- Bulk reassign tool (e.g., "assign all locations with bin_type=pallet to zone CASE")
- Validation: zone must belong to the same warehouse as the location

### 3. Zone-aware pick task model
- Either split `order_items` at claim time by zone, or introduce a `pick_tasks`
  table that materialises (order_item × pick_zone) rows
- Pick queue returns tasks grouped by zone
- Claim flow becomes claim-task-in-zone, not claim-order

### 4. Zone priority ordering in picker UI
- Picker queue sorts tasks by zone priority first, then existing order priority
- Picker can filter to a single zone (e.g., "only show me CASE tasks")

### 5. UOM-based routing at wave-build time
- When building a pick task, look up `uom_variants.hierarchy_level` of the
  picked variant
- Find the zone whose `uom_hierarchy_min..uom_hierarchy_max` range covers that
  level; route the task there
- Fall through to DEFAULT zone if no range matches

### 6. Equipment filtering (optional)
- If a zone has `equipment_type = 'forklift'`, only users with a forklift
  capability flag can claim its tasks
- Requires adding capability tags to users (out of scope for now)

### 7. Zone strategy execution
- `zone_sequence` — sort pick lines by (zone, aisle, bay, level, bin)
- `shortest_path` — full TSP-style route optimisation (needs bin coordinates)
- `fifo` — sort by order creation time within the zone

## Related tables

- `inventory.warehouse_pick_zones` — the zones themselves
- `warehouse.warehouse_locations.pick_zone_id` — per-location assignment (nullable)
- `catalog.uom_variants.hierarchy_level` — UOM tier for routing

## Notes

- When designing the pick task model, prefer a dedicated `pick_tasks` table
  over mutating `order_items`. Keeps order data immutable and allows multiple
  materialisations (e.g., re-slice tasks if a zone is reassigned mid-wave).
- Cross-schema FK from `warehouse.warehouse_locations.pick_zone_id` to
  `inventory.warehouse_pick_zones.id` is declared in the migration, not the
  Drizzle schema, because Drizzle's cross-schema FK support is limited.

---

# Other Future Work

## Stale `app_settings` type export

Echelon's `shared/schema/warehouse.schema.ts` exports an `appSettings` type
that claims a `key/value` shape. The actual `warehouse.app_settings` table
in production is a single-row config-flag table owned by shellz-club-app
(Shopify creds, Klaviyo keys, offer codes, etc.). Echelon has no legitimate
use for this table and the stale type export should be removed.

Coordinated with shellz-club-app relocating the table out of the `warehouse`
schema entirely. See `shellz-club-app/docs/FUTURE_WORK.md` entry 1 for the
full plan.

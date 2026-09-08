import { z } from "zod";

const positiveBigint = z.string().regex(/^[1-9][0-9]*$/)
  .refine((value) => value.length <= 19 && /^[1-9][0-9]*$/.test(value)
    && BigInt(value) <= BigInt("9223372036854775807"), "Invalid PostgreSQL positive bigint");

export const inventoryCutoverFenceRequestSchema = z.object({
  expectedAuthority: z.enum(["legacy", "canonical"]),
  expectedConfigurationRunId: positiveBigint.nullable(),
}).strict();
export type InventoryCutoverFenceRequest = z.infer<typeof inventoryCutoverFenceRequestSchema>;

export const inventoryCutoverFenceReceiptSchema = z.object({
  epoch: positiveBigint,
  authority: z.enum(["legacy", "canonical"]),
  authorityRevision: positiveBigint,
  configurationRunId: positiveBigint.nullable(),
}).strict();
export type InventoryCutoverFenceReceipt = z.infer<typeof inventoryCutoverFenceReceiptSchema>;

/**
 * Proposed admission manifest for migration232 (not yet present or approved).
 * This list is a review contract, not proof that database guards are installed.
 * Covers supplySnapshot, WMS demand, inventory encumbrance, source/custody and
 * channel identity inputs; admission is independent of application entry point.
 */
export const INVENTORY_CUTOVER_CONFIGURATION_TABLES = [
  "catalog.products",
  "catalog.product_variants",
  "inventory.build_recipes",
  "inventory.build_recipe_components",
  "inventory.transformation_model_heads",
  "inventory.transformation_model_versions",
  "inventory.transformation_model_paths",
  "inventory.transformation_recipe_bindings",
  "inventory.transformation_recipe_component_snapshots",
  "inventory.transformation_model_reviews",
  "inventory.location_promise_policy_heads",
  "inventory.location_promise_policy_versions",
  "inventory.promise_safety_policy_heads",
  "inventory.promise_safety_policy_versions",
  "inventory.channel_exposure_policy_heads",
  "inventory.channel_exposure_policy_versions",
  "inventory.publication_source_binding_heads",
  "inventory.publication_source_binding_versions",
  "inventory.publication_source_binding_members",
  "inventory.publication_variant_mapping_heads",
  "inventory.publication_variant_mapping_versions",
  "inventory.inventory_publication_targets",
  "warehouse.warehouses",
  "warehouse.warehouse_locations",
  "warehouse.product_locations",
  "warehouse.fulfillment_nodes",
  "warehouse.fulfillment_provider_accounts",
  "warehouse.fulfillment_provider_locations",
  "warehouse.fulfillment_node_provider_bindings",
  "channels.channels",
  "channels.channel_connections",
  "channels.channel_warehouse_assignments",
  "channels.channel_allocation_rules",
  "dropship.dropship_store_connections",
] as const;
export const INVENTORY_CUTOVER_OPERATIONAL_TABLES = [
  "wms.orders",
  "wms.order_items",
  "wms.outbound_shipments",
  "wms.outbound_shipment_items",
  "wms.physical_shipments",
  "wms.physical_shipment_items",
  "wms.physical_shipment_item_quantity_adjustments",
  "wms.fulfillment_plans",
  "wms.fulfillment_plan_lines",
  "oms.oms_orders",
  "oms.oms_order_lines",
  "oms.oms_order_line_authority_events",
  "oms.order_item_costs",
  "inventory.inventory_levels",
  "inventory.inventory_lots",
  "inventory.inventory_transactions",
  "inventory.build_orders",
  "inventory.build_order_components",
  "inventory.build_order_dependencies",
  "inventory.build_component_reservations",
  "inventory.build_runs",
  "inventory.build_run_consumptions",
  "inventory.build_run_reversals",
  "inventory.availability_claims",
  "inventory.availability_claim_lines",
  "inventory.availability_claim_resources",
  "inventory.availability_claim_lot_allocations",
  "inventory.availability_claim_operations",
  "inventory.availability_claim_operation_inputs",
  "inventory.availability_claim_commands",
  "inventory.availability_claim_events",
  "inventory.availability_claim_build_handoffs",
  "inventory.availability_claim_pick_movements",
  "inventory.availability_claim_dispatch_receipts",
  "inventory.availability_claim_dispatch_movements",
  "inventory.demand_evidence_snapshots",
  "inventory.lot_cost_origins",
  "inventory.lot_cost_contributions",
  "inventory.cost_component_protections",
  "inventory.cost_applications",
  "inventory.cost_application_lots",
  "inventory.cost_reporting_events",
  "channels.channel_reservations",
] as const;

import { pgTable, pgSchema, text, varchar, integer, timestamp, jsonb, bigint, boolean, doublePrecision } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { products, productVariants } from "./catalog.schema";
import { warehouses, warehouseLocations } from "./warehouse.schema";
import { orders, orderItems, outboundShipments } from "./orders.schema";
import { receivingOrders, purchaseOrders } from "./procurement.schema";

// Inventory levels per location - all quantities in variant units (e.g., 5 cases, 10 packs)
// Base unit equivalents are computed at query time via: qty * product_variants.units_per_variant
const inventorySchema = pgSchema("inventory");

export const inventoryLevels = inventorySchema.table("inventory_levels", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  warehouseLocationId: integer("warehouse_location_id").notNull().references(() => warehouseLocations.id, { onDelete: "cascade" }),
  productVariantId: integer("product_variant_id").notNull().references(() => productVariants.id),
  variantQty: integer("variant_qty").notNull().default(0), // Physical on-hand count in variant units (e.g., 5 cases)
  reservedQty: integer("reserved_qty").notNull().default(0), // Allocated to orders (variant units)
  pickedQty: integer("picked_qty").notNull().default(0), // In picker carts (variant units)
  packedQty: integer("packed_qty").notNull().default(0), // Boxed, awaiting ship (variant units)
  backorderQty: integer("backorder_qty").notNull().default(0), // Backorder demand (variant units)
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertInventoryLevelSchema = createInsertSchema(inventoryLevels).omit({
  id: true,
  updatedAt: true,
});

export type InsertInventoryLevel = z.infer<typeof insertInventoryLevelSchema>;
export type InventoryLevel = typeof inventoryLevels.$inferSelect;

// Transaction types for audit trail
export const transactionTypeEnum = [
  "receipt",      // PO received
  "pick",         // Picked for order
  "adjustment",   // Manual count adjustment
  "break",        // Case/pack broken into smaller units
  "assemble",     // Smaller units assembled into larger pack (future)
  "replenish",    // Moved from bulk to pick location
  "transfer",     // Moved between locations
  "reserve",      // Reserved for order
  "unreserve",    // Reservation released (cancel, short)
  "ship",         // Shipped out
  "return",       // Customer return (future)
  "csv_upload",   // Bulk update from CSV file
  "sku_correction", // Cross-variant transfer for SKU corrections
] as const;
export type TransactionType = typeof transactionTypeEnum[number];

// Standardized adjustment reasons lookup table
export const adjustmentReasons = inventorySchema.table("adjustment_reasons", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: varchar("code", { length: 30 }).notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  transactionType: varchar("transaction_type", { length: 30 }).notNull(),
  requiresNote: integer("requires_note").notNull().default(0),
  isActive: integer("is_active").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAdjustmentReasonSchema = createInsertSchema(adjustmentReasons).omit({
  id: true,
  createdAt: true,
});

export type InsertAdjustmentReason = z.infer<typeof insertAdjustmentReasonSchema>;
export type AdjustmentReason = typeof adjustmentReasons.$inferSelect;

// Cycle count status workflow
export const cycleCountStatusEnum = ["draft", "in_progress", "pending_review", "completed", "cancelled"] as const;
export type CycleCountStatus = typeof cycleCountStatusEnum[number];

// Variance types for reconciliation
export const varianceTypeEnum = [
  "quantity_over",     // Found more than expected (overage)
  "quantity_under",    // Found less than expected, including zero (shortage)
  "sku_mismatch",      // Different SKU in bin than expected
  "unexpected_item",   // Item found but not expected in this bin
  "missing_item",      // DEPRECATED: legacy records only — now merged into quantity_under
] as const;
export type VarianceType = typeof varianceTypeEnum[number];

// Cycle count sessions (monthly reconciliation)
export const cycleCounts = inventorySchema.table("cycle_counts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: varchar("name", { length: 100 }).notNull(), // e.g., "January 2026 Cycle Count"
  description: text("description"),
  status: varchar("status", { length: 20 }).notNull().default("draft"),
  warehouseId: integer("warehouse_id").references(() => warehouses.id),
  zoneFilter: varchar("zone_filter", { length: 20 }), // Optional: limit to specific zone
  aisleFilter: varchar("aisle_filter", { length: 20 }), // Optional: limit to specific aisle (e.g., "A", "01")
  locationTypeFilter: text("location_type_filter"), // Optional: comma-separated list of location types to include
  binTypeFilter: text("bin_type_filter"), // Optional: comma-separated list of bin types to include (bin, pallet, carton_flow, etc.)
  locationCodes: text("location_codes"), // Optional: comma-separated specific bin codes for quick counts
  assignedTo: varchar("assigned_to", { length: 100 }), // User assigned to count
  totalBins: integer("total_bins").notNull().default(0),
  countedBins: integer("counted_bins").notNull().default(0),
  varianceCount: integer("variance_count").notNull().default(0),
  approvedVariances: integer("approved_variances").notNull().default(0),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdBy: varchar("created_by", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertCycleCountSchema = createInsertSchema(cycleCounts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertCycleCount = z.infer<typeof insertCycleCountSchema>;
export type CycleCount = typeof cycleCounts.$inferSelect;

// Inventory transactions ledger (audit trail) - Full WMS
// Every inventory movement is logged here for complete audit trail
export const inventoryTransactions = inventorySchema.table("inventory_transactions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productVariantId: integer("product_variant_id").references(() => productVariants.id),

  // Location tracking - for transfers, both are used; for receive/pick, one is null
  fromLocationId: integer("from_location_id").references(() => warehouseLocations.id, { onDelete: "set null" }),
  toLocationId: integer("to_location_id").references(() => warehouseLocations.id, { onDelete: "set null" }),

  transactionType: varchar("transaction_type", { length: 30 }).notNull(), // receipt, pick, adjustment, transfer, ship, return
  reasonId: integer("reason_id").references(() => adjustmentReasons.id),

  // Quantity changes in variant units
  variantQtyDelta: integer("variant_qty_delta").notNull().default(0), // Positive = add, negative = remove
  variantQtyBefore: integer("variant_qty_before"), // Snapshot: variant qty before at location
  variantQtyAfter: integer("variant_qty_after"), // Snapshot: variant qty after at location

  batchId: varchar("batch_id", { length: 50 }), // Groups transactions from same operation
  sourceState: varchar("source_state", { length: 20 }), // "on_hand", "committed", "picked", etc.
  targetState: varchar("target_state", { length: 20 }), // "committed", "picked", "shipped", etc.

  // Cost & lot tracking
  unitCostCents: doublePrecision("unit_cost_cents"), // Cost traceability on every transaction
  inventoryLotId: integer("inventory_lot_id"), // Lot linkage (FK added after inventoryLots table definition)

  // Reference links - which operation triggered this transaction
  orderId: integer("order_id").references(() => orders.id),
  orderItemId: integer("order_item_id").references(() => orderItems.id),
  receivingOrderId: integer("receiving_order_id").references(() => receivingOrders.id), // Link to receiving
  cycleCountId: integer("cycle_count_id").references(() => cycleCounts.id), // Link to cycle count
  shipmentId: integer("shipment_id").references(() => outboundShipments.id), // Link to shipment

  referenceType: varchar("reference_type", { length: 30 }), // "order", "receiving", "cycle_count", "manual"
  referenceId: varchar("reference_id", { length: 100 }), // External reference ID
  notes: text("notes"),
  isImplicit: integer("is_implicit").notNull().default(0), // 1 = auto-generated, 0 = explicit scan
  userId: varchar("user_id", { length: 100 }), // Who performed the action
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertInventoryTransactionSchema = createInsertSchema(inventoryTransactions).omit({
  id: true,
  createdAt: true,
});

export type InsertInventoryTransaction = z.infer<typeof insertInventoryTransactionSchema>;
export type InventoryTransaction = typeof inventoryTransactions.$inferSelect;

// Replenishment method types
export const replenMethodEnum = ["case_break", "full_case", "pallet_drop", "manual"] as const;
export type ReplenMethod = typeof replenMethodEnum[number];

// Replenishment trigger types
export const replenTriggerEnum = ["min_max", "wave", "manual", "stockout", "inline_pick"] as const;
export type ReplenTrigger = typeof replenTriggerEnum[number];

// Warehouse replenishment mode - who does replen work
export const replenModeEnum = ["inline", "queue", "hybrid"] as const;
export type ReplenMode = typeof replenModeEnum[number];

// Short pick action - what happens when picker encounters shortage
export const shortPickActionEnum = ["pause_and_replen", "partial_pick", "skip_to_next", "block_order"] as const;
export type ShortPickAction = typeof shortPickActionEnum[number];

// Auto-generate trigger - when replen tasks are automatically created
export const autoGenerateTriggerEnum = ["after_pick", "after_wave", "scheduled", "manual_only"] as const;
export type AutoGenerateTrigger = typeof autoGenerateTriggerEnum[number];

// Warehouse settings - configurable per warehouse
export const warehouseSettings = inventorySchema.table("warehouse_settings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  warehouseId: integer("warehouse_id").references(() => warehouses.id), // Link to actual warehouse (null = DEFAULT global settings)
  warehouseCode: varchar("warehouse_code", { length: 50 }).notNull().unique().default("DEFAULT"),
  warehouseName: varchar("warehouse_name", { length: 100 }).notNull().default("Main Warehouse"),

  // Replenishment workflow settings
  replenMode: varchar("replen_mode", { length: 20 }).notNull().default("queue"), // inline, queue, hybrid
  shortPickAction: varchar("short_pick_action", { length: 30 }).notNull().default("partial_pick"), // pause_and_replen, partial_pick, skip_to_next, block_order
  autoGenerateTrigger: varchar("auto_generate_trigger", { length: 30 }).notNull().default("manual_only"), // after_pick, after_wave, scheduled, manual_only

  // Hybrid mode thresholds
  inlineReplenMaxUnits: integer("inline_replen_max_units").default(50), // Max units for inline replen (larger goes to queue)
  inlineReplenMaxCases: integer("inline_replen_max_cases").default(2), // Max cases picker can grab inline

  // Priority settings
  urgentReplenThreshold: integer("urgent_replen_threshold").default(0), // Qty at which replen becomes urgent priority
  stockoutPriority: integer("stockout_priority").default(1), // Priority for stockout-triggered tasks
  minMaxPriority: integer("min_max_priority").default(5), // Priority for min/max triggered tasks

  // Scheduling settings (for scheduled mode)
  scheduledReplenIntervalMinutes: integer("scheduled_replen_interval_minutes").default(30),
  scheduledReplenEnabled: integer("scheduled_replen_enabled").default(0),

  // Pick path optimization
  pickPathOptimization: varchar("pick_path_optimization", { length: 30 }).default("zone_sequence"), // zone_sequence, shortest_path, fifo

  // Wave planning settings
  maxOrdersPerWave: integer("max_orders_per_wave").default(50),
  maxItemsPerWave: integer("max_items_per_wave").default(500),
  waveAutoRelease: integer("wave_auto_release").default(0), // Auto-release waves when full

  // Order combining settings
  enableOrderCombining: integer("enable_order_combining").notNull().default(1), // Show combine badges to pickers

  // Channel sync
  channelSyncEnabled: integer("channel_sync_enabled").notNull().default(0), // 0=disabled, 1=enabled — master kill switch for inventory push to sales channels
  channelSyncIntervalMinutes: integer("channel_sync_interval_minutes").notNull().default(15), // 0=disable scheduled sync

  // Velocity calculation
  velocityLookbackDays: integer("velocity_lookback_days").notNull().default(14), // Days of pick history for SKU velocity

  // Picking workflow settings
  postPickStatus: varchar("post_pick_status", { length: 30 }).notNull().default("ready_to_ship"), // ready_to_ship, picked, staged
  pickMode: varchar("pick_mode", { length: 20 }).notNull().default("single_order"), // single_order, batch, wave
  requireScanConfirm: integer("require_scan_confirm").notNull().default(0), // 0=optional, 1=required
  pickingBatchSize: integer("picking_batch_size").notNull().default(20), // Max orders per picking batch
  autoReleaseDelayMinutes: integer("auto_release_delay_minutes").notNull().default(30), // Minutes before unclaimed orders release

  isActive: integer("is_active").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertWarehouseSettingsSchema = createInsertSchema(warehouseSettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertWarehouseSettings = z.infer<typeof insertWarehouseSettingsSchema>;
export type WarehouseSettings = typeof warehouseSettings.$inferSelect;

// Replenishment task status workflow
export const replenTaskStatusEnum = ["pending", "assigned", "in_progress", "completed", "cancelled", "blocked"] as const;
export type ReplenTaskStatus = typeof replenTaskStatusEnum[number];

// Replenishment tier defaults - tier-based rules by UOM hierarchy level
// These are the DEFAULT rules that apply to all products at a given tier
export const replenTierDefaults = inventorySchema.table("replen_tier_defaults", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  warehouseId: integer("warehouse_id").references(() => warehouses.id), // Which warehouse this rule applies to (null = global default for all warehouses)
  hierarchyLevel: integer("hierarchy_level").notNull(), // Which tier this applies to (1=each, 2=pack, 3=case, etc.)
  sourceHierarchyLevel: integer("source_hierarchy_level").notNull(), // What tier to pull from
  pickLocationType: varchar("pick_location_type", { length: 30 }).notNull().default("pick"),
  sourceLocationType: varchar("source_location_type", { length: 30 }).notNull().default("reserve"),
  sourcePriority: varchar("source_priority", { length: 20 }).notNull().default("fifo"), // fifo, smallest_first
  triggerValue: integer("trigger_value").notNull().default(0), // case_break/full_case: min units. pallet_drop: coverage days
  maxQty: integer("max_qty"), // Fill up to this qty (null = use bin capacity or one source unit)
  replenMethod: varchar("replen_method", { length: 30 }).notNull().default("case_break"), // case_break, full_case, pallet_drop
  priority: integer("priority").notNull().default(5), // 1 = highest priority
  autoReplen: integer("auto_replen").notNull().default(0), // 1 = system auto-completes replen (no worker needed, e.g. pick-to-pick)
  isActive: integer("is_active").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertReplenTierDefaultSchema = createInsertSchema(replenTierDefaults).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertReplenTierDefault = z.infer<typeof insertReplenTierDefaultSchema>;
export type ReplenTierDefault = typeof replenTierDefaults.$inferSelect;

// Replenishment SKU overrides - product-specific exceptions to tier defaults
// Only create these when a product needs DIFFERENT behavior than its tier default
export const replenRules = inventorySchema.table("replen_rules", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productId: integer("product_id").references(() => products.id), // Which product this override applies to
  pickProductVariantId: integer("pick_product_variant_id").references(() => productVariants.id),
  sourceProductVariantId: integer("source_product_variant_id").references(() => productVariants.id),
  pickLocationType: varchar("pick_location_type", { length: 30 }), // Override: different pick location type
  sourceLocationType: varchar("source_location_type", { length: 30 }), // Override: different source location type
  sourcePriority: varchar("source_priority", { length: 20 }), // Override: different priority (fifo, smallest_first)
  triggerValue: integer("trigger_value"), // Override: case_break/full_case: min units. pallet_drop: coverage days
  maxQty: integer("max_qty"), // Override: different fill target
  replenMethod: varchar("replen_method", { length: 30 }), // Override: different method (case_break, full_case, pallet_drop)
  priority: integer("priority"), // Override: different task priority
  autoReplen: integer("auto_replen"), // Override: 1 = system auto-completes (null = use tier default)
  isActive: integer("is_active").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertReplenRuleSchema = createInsertSchema(replenRules).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertReplenRule = z.infer<typeof insertReplenRuleSchema>;
export type ReplenRule = typeof replenRules.$inferSelect;

// Per-location replen configuration overrides
// product_variant_id NULL = location-wide default, non-NULL = SKU-specific override at that location
export const locationReplenConfig = inventorySchema.table("location_replen_config", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  warehouseLocationId: integer("warehouse_location_id").notNull().references(() => warehouseLocations.id, { onDelete: "cascade" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
  triggerValue: varchar("trigger_value", { length: 20 }), // numeric(8,2) in DB — case_break: min units, pallet_drop: coverage days
  maxQty: integer("max_qty"),
  replenMethod: varchar("replen_method", { length: 30 }),
  isActive: integer("is_active").notNull().default(1),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertLocationReplenConfigSchema = createInsertSchema(locationReplenConfig).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertLocationReplenConfig = z.infer<typeof insertLocationReplenConfigSchema>;
export type LocationReplenConfig = typeof locationReplenConfig.$inferSelect;

// Replenishment tasks - work queue for warehouse workers
export const replenTasks = inventorySchema.table("replen_tasks", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  replenRuleId: integer("replen_rule_id").references(() => replenRules.id),
  fromLocationId: integer("from_location_id").notNull().references(() => warehouseLocations.id),
  toLocationId: integer("to_location_id").notNull().references(() => warehouseLocations.id),
  productId: integer("product_id").references(() => products.id),
  sourceProductVariantId: integer("source_product_variant_id").references(() => productVariants.id),
  pickProductVariantId: integer("pick_product_variant_id").references(() => productVariants.id),
  qtySourceUnits: integer("qty_source_units").notNull().default(1), // How many cases to pick
  qtyTargetUnits: integer("qty_target_units").notNull(), // How many eaches to put (after conversion)
  qtyCompleted: integer("qty_completed").notNull().default(0), // Eaches actually put
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  priority: integer("priority").notNull().default(5),
  triggeredBy: varchar("triggered_by", { length: 20 }).notNull().default("min_max"), // min_max, wave, manual, stockout
  executionMode: varchar("execution_mode", { length: 20 }).notNull().default("queue"), // queue, inline - based on warehouse settings
  replenMethod: varchar("replen_method", { length: 30 }).notNull().default("full_case"), // case_break, full_case, pallet_drop — persisted so executeTask knows how to run
  autoReplen: integer("auto_replen").notNull().default(0), // 1 = picker handles inline (auto-complete), 0 = worker queue
  warehouseId: integer("warehouse_id").references(() => warehouses.id), // Which warehouse this task belongs to
  createdBy: varchar("created_by", { length: 100 }),
  assignedTo: varchar("assigned_to", { length: 100 }),
  assignedAt: timestamp("assigned_at"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  notes: text("notes"),
  exceptionReason: varchar("exception_reason", { length: 30 }),
  linkedCycleCountId: integer("linked_cycle_count_id").references(() => cycleCounts.id),
  dependsOnTaskId: integer("depends_on_task_id"), // Blocked until this upstream task completes
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertReplenTaskSchema = createInsertSchema(replenTasks).omit({
  id: true,
  createdAt: true,
});

export type InsertReplenTask = z.infer<typeof insertReplenTaskSchema>;
export type ReplenTask = typeof replenTasks.$inferSelect;

// Individual bin counts within a cycle count session
export const cycleCountItems = inventorySchema.table("cycle_count_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  cycleCountId: integer("cycle_count_id").notNull().references(() => cycleCounts.id, { onDelete: "cascade" }),
  warehouseLocationId: integer("warehouse_location_id").notNull().references(() => warehouseLocations.id),
  productVariantId: integer("product_variant_id").references(() => productVariants.id), // Expected variant (null if bin should be empty)
  productId: integer("product_id").references(() => products.id), // Link to product

  // Expected (system) values at time of count
  expectedSku: varchar("expected_sku", { length: 100 }),
  expectedQty: integer("expected_qty").notNull().default(0),

  // Actual (counted) values
  countedSku: varchar("counted_sku", { length: 100 }),
  countedQty: integer("counted_qty"),

  // Variance tracking
  varianceQty: integer("variance_qty"), // countedQty - expectedQty
  varianceType: varchar("variance_type", { length: 30 }), // from varianceTypeEnum
  varianceReason: varchar("variance_reason", { length: 50 }), // damaged, shrinkage, misplaced, found, etc.
  varianceNotes: text("variance_notes"),

  // Status
  status: varchar("status", { length: 20 }).notNull().default("pending"), // pending, counted, variance, approved, adjusted, resolved, investigate

  // Related item for SKU mismatch workflow (links expected→found items)
  relatedItemId: integer("related_item_id"), // Points to the other half of a mismatch pair
  mismatchType: varchar("mismatch_type", { length: 20 }), // "expected_missing" or "unexpected_found"

  // Approval workflow
  requiresApproval: integer("requires_approval").notNull().default(0), // 1 if variance exceeds threshold
  approvedBy: varchar("approved_by", { length: 100 }),
  approvedAt: timestamp("approved_at"),
  adjustmentTransactionId: integer("adjustment_transaction_id").references(() => inventoryTransactions.id),

  // Resolution without adjustment
  resolvedBy: varchar("resolved_by", { length: 100 }),
  resolvedAt: timestamp("resolved_at"),

  // Audit
  countedBy: varchar("counted_by", { length: 100 }),
  countedAt: timestamp("counted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCycleCountItemSchema = createInsertSchema(cycleCountItems).omit({
  id: true,
  createdAt: true,
});

export type InsertCycleCountItem = z.infer<typeof insertCycleCountItemSchema>;
export type CycleCountItem = typeof cycleCountItems.$inferSelect;

// INVENTORY LOTS — FIFO cost layers (Phase 6, schema defined now)
// ============================================================================

export const inventoryLotStatusEnum = ["active", "depleted", "expired"] as const;
export type InventoryLotStatus = typeof inventoryLotStatusEnum[number];

export const inventoryLots = inventorySchema.table("inventory_lots", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  lotNumber: varchar("lot_number", { length: 50 }).notNull(), // Auto: LOT-YYYYMMDD-###
  productVariantId: integer("product_variant_id").notNull().references(() => productVariants.id),
  warehouseLocationId: integer("warehouse_location_id").notNull().references(() => warehouseLocations.id),
  receivingOrderId: integer("receiving_order_id").references(() => receivingOrders.id, { onDelete: "set null" }),
  purchaseOrderId: integer("purchase_order_id").references(() => purchaseOrders.id, { onDelete: "set null" }),
  unitCostCents: doublePrecision("unit_cost_cents").notNull().default(0), // Cost per variant unit
  qtyOnHand: integer("qty_on_hand").notNull().default(0),
  qtyReserved: integer("qty_reserved").notNull().default(0),
  qtyPicked: integer("qty_picked").notNull().default(0),
  receivedAt: timestamp("received_at").notNull(), // FIFO sort key
  expiryDate: timestamp("expiry_date"), // Future (perishables)
  status: varchar("status", { length: 20 }).default("active"), // active, depleted, expired
  inboundShipmentId: integer("inbound_shipment_id"), // FK to inbound_shipments (added post-definition)
  costProvisional: integer("cost_provisional").notNull().default(0), // 1 = landed cost not yet finalized
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertInventoryLotSchema = createInsertSchema(inventoryLots).omit({
  id: true,
  createdAt: true,
});

export type InsertInventoryLot = z.infer<typeof insertInventoryLotSchema>;
export type InventoryLot = typeof inventoryLots.$inferSelect;



export const orderLineCosts = inventorySchema.table('order_line_costs', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  orderId: integer('order_id').notNull(),
  orderItemId: integer('order_item_id').notNull(),
  productVariantId: integer('product_variant_id').notNull(),
  lotId: integer('lot_id'),
  qtyConsumed: integer('qty_consumed').notNull(),
  unitCostCents: integer('unit_cost_cents').notNull(),
  totalCostCents: integer('total_cost_cents').notNull(),
  shippedAt: timestamp('shipped_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type OrderLineCost = typeof orderLineCosts.$inferSelect;
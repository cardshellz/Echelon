import { sql } from "drizzle-orm";
import { bigint, check, date, index, integer, jsonb, pgSchema, text, timestamp, uniqueIndex, primaryKey, varchar } from "drizzle-orm/pg-core";
import { users } from "./identity.schema";
import { products, productVariants } from "./catalog.schema";
import { warehouses, warehouseLocations } from "./warehouse.schema";
import { inventoryLevels, inventoryLots, inventoryTransactions } from "./inventory.schema";
import { purchaseOrderLines, purchaseOrders, receivingLines, receivingOrders, supplierCreditLines, vendors } from "./procurement.schema";
import type { SupplierReturnStockPreviewLine } from "../procurement/supplier-return";
const procurement = pgSchema("procurement");
const inventory = pgSchema("inventory");
/** Recorded collections are immutable. Supplier credit, costing and physical
 * compensation retain their own history instead of editing this document. */
export const supplierReturns = procurement.table("supplier_returns", {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    vendorId: integer("vendor_id").notNull().references(() => vendors.id, { onDelete: "restrict" }),
    supplierReference: varchar("supplier_reference", { length: 200 }),
    returnCalendarDate: date("return_calendar_date").notNull(),
    evidenceReference: varchar("evidence_reference", { length: 1000 }).notNull(),
    reason: text("reason").notNull(),
    sourceFingerprint: varchar("source_fingerprint", { length: 64 }).notNull(),
    requestFingerprint: varchar("request_fingerprint", { length: 64 }).notNull(),
    commandKey: varchar("command_key", { length: 200 }).notNull(),
    recordedBy: text("recorded_by").notNull().references(() => users.id, { onDelete: "restrict" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
}, table => [
    uniqueIndex("supplier_returns_command_key_idx").on(table.commandKey),
    index("supplier_returns_vendor_idx").on(table.vendorId, table.id),
]);
export const supplierReturnLines = procurement.table("supplier_return_lines", {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    supplierReturnId: integer("supplier_return_id").notNull().references(() => supplierReturns.id, { onDelete: "restrict" }),
    inventoryLotId: integer("inventory_lot_id").notNull().references(() => inventoryLots.id, { onDelete: "restrict" }),
    inventoryLevelId: integer("inventory_level_id").notNull().references(() => inventoryLevels.id, { onDelete: "restrict" }),
    warehouseLocationId: integer("warehouse_location_id").notNull().references(() => warehouseLocations.id, { onDelete: "restrict" }),
    warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id, { onDelete: "restrict" }),
    productId: integer("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
    productVariantId: integer("product_variant_id").notNull().references(() => productVariants.id, { onDelete: "restrict" }),
    purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrders.id, { onDelete: "restrict" }),
    purchaseOrderLineId: integer("purchase_order_line_id").notNull().references(() => purchaseOrderLines.id, { onDelete: "restrict" }),
    receivingOrderId: integer("receiving_order_id").notNull().references(() => receivingOrders.id, { onDelete: "restrict" }),
    receivingLineId: integer("receiving_line_id").notNull().references(() => receivingLines.id, { onDelete: "restrict" }),
    originLotId: integer("origin_lot_id").notNull().references(() => inventoryLots.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(), unitsPerVariant: integer("units_per_variant").notNull(),
    basePieces: bigint("base_pieces", { mode: "number" }).notNull(),
    sourceSnapshot: jsonb("source_snapshot").$type<SupplierReturnStockPreviewLine>().notNull(),
}, table => [
    uniqueIndex("supplier_return_lines_document_lot_idx").on(table.supplierReturnId, table.inventoryLotId),
    index("supplier_return_lines_po_idx").on(table.purchaseOrderId, table.id),
    index("supplier_return_lines_receipt_idx").on(table.receivingOrderId, table.id),
    check("supplier_return_lines_quantity_check", sql `${table.quantity} > 0 AND ${table.unitsPerVariant} > 0 AND ${table.basePieces} = ${table.quantity}::bigint * ${table.unitsPerVariant}::bigint AND ${table.basePieces} <= 9007199254740991`),
]);
export const supplierReturnAllocations = inventory.table("supplier_return_allocations", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    supplierReturnLineId: integer("supplier_return_line_id").notNull().references(() => supplierReturnLines.id, { onDelete: "restrict" }),
    inventoryLotId: integer("inventory_lot_id").notNull().references(() => inventoryLots.id, { onDelete: "restrict" }),
    inventoryTransactionId: integer("inventory_transaction_id").notNull().references(() => inventoryTransactions.id, { onDelete: "restrict" }),
    // Raw cost-evidence tables are owned by SQL migrations; the migration enforces these FKs.
    allocationId: bigint("allocation_id", { mode: "number" }).notNull(),
    quantity: integer("quantity").notNull(), sourceEvidence: jsonb("source_evidence").notNull(),
    recordedBy: text("recorded_by").notNull().references(() => users.id, { onDelete: "restrict" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
}, table => [
    uniqueIndex("supplier_return_allocations_line_idx").on(table.supplierReturnLineId),
    uniqueIndex("supplier_return_allocations_cost_idx").on(table.allocationId),
    uniqueIndex("supplier_return_allocations_transaction_idx").on(table.inventoryTransactionId),
    index("supplier_return_allocations_lot_idx").on(table.inventoryLotId, table.id),
]);
export const supplierReturnCostEntries = inventory.table("supplier_return_cost_entries", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    returnAllocationId: bigint("return_allocation_id", { mode: "number" }).notNull().references(() => supplierReturnAllocations.id, { onDelete: "restrict" }),
    component: varchar("component", { length: 20 }).notNull(),
    previousMills: bigint("previous_mills", { mode: "number" }).notNull(),
    nextMills: bigint("next_mills", { mode: "number" }).notNull(),
    deltaMills: bigint("delta_mills", { mode: "number" }).notNull(),
    postingKey: varchar("posting_key", { length: 500 }).notNull(), reason: text("reason").notNull(),
    sourceRevisionId: bigint("source_revision_id", { mode: "number" }), applicationId: bigint("application_id", { mode: "number" }),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
}, table => [
    uniqueIndex("supplier_return_cost_entries_posting_idx").on(table.returnAllocationId, table.postingKey, table.component),
    index("supplier_return_cost_entries_current_idx").on(table.returnAllocationId, table.component, table.id),
]);
/** An entitlement identifies returned units once. Additional notes or explicit
 * replacements attach money to it without returning those units a second time. */
export const supplierReturnCreditEntitlements = procurement.table("supplier_return_credit_entitlements", {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    supplierReturnLineId: integer("supplier_return_line_id").notNull().references(() => supplierReturnLines.id, { onDelete: "restrict" }),
    returnAllocationId: bigint("return_allocation_id", { mode: "number" }).notNull().references(() => supplierReturnAllocations.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(), intervals: jsonb("intervals").notNull(), sourceEvidence: jsonb("source_evidence").notNull(),
    recordedBy: text("recorded_by").notNull().references(() => users.id, { onDelete: "restrict" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
}, table => [index("supplier_return_entitlements_line_idx").on(table.supplierReturnLineId, table.id)]);
export const supplierReturnCreditLinks = procurement.table("supplier_return_credit_links", {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    supplierCreditLineId: integer("supplier_credit_line_id").notNull().references(() => supplierCreditLines.id, { onDelete: "restrict" }),
    entitlementId: integer("entitlement_id").notNull().references(() => supplierReturnCreditEntitlements.id, { onDelete: "restrict" }),
    component: varchar("component", { length: 20 }).notNull(), amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    recordedBy: text("recorded_by").notNull().references(() => users.id, { onDelete: "restrict" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
}, table => [uniqueIndex("supplier_return_credit_links_credit_line_idx").on(table.supplierCreditLineId),
    index("supplier_return_credit_links_entitlement_idx").on(table.entitlementId, table.id)]);
export const supplierReturnReportingEvents = procurement.table("supplier_return_reporting_events", {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    supplierReturnId: integer("supplier_return_id").notNull().references(() => supplierReturns.id, { onDelete: "restrict" }),
    contractVersion: integer("contract_version").notNull(), payload: jsonb("payload").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
}, table => [uniqueIndex("supplier_return_reporting_events_document_idx").on(table.supplierReturnId)]);
/** Operational publication delivery is retryable; custody/value tables stay immutable. */
export const supplierReturnFollowups = inventory.table("supplier_return_followups", {
    supplierReturnId: integer("supplier_return_id").notNull().references(() => supplierReturns.id, { onDelete: "restrict" }),
    productVariantId: integer("product_variant_id").notNull().references(() => productVariants.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
}, table => [primaryKey({ columns: [table.supplierReturnId, table.productVariantId] })]);
export const supplierReturnCreditReviews = procurement.table("supplier_return_credit_reviews", {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    entitlementId: integer("entitlement_id").notNull().references(() => supplierReturnCreditEntitlements.id, { onDelete: "restrict" }),
    sourceFingerprint: varchar("source_fingerprint", { length: 64 }).notNull(),
    expectedVersion: varchar("expected_version", { length: 64 }).notNull(),
    disposition: varchar("disposition", { length: 30 }).notNull(),
    assignments: jsonb("assignments").notNull(), sourceEvidence: jsonb("source_evidence").notNull(),
    evidenceReference: varchar("evidence_reference", { length: 1000 }).notNull(), reason: text("reason").notNull(),
    recordedBy: text("recorded_by").notNull().references(() => users.id, { onDelete: "restrict" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
}, table => [uniqueIndex("supplier_return_credit_reviews_version_idx").on(table.entitlementId, table.expectedVersion)]);

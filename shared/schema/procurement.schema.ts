import { pgTable, pgSchema, text, varchar, integer, timestamp, jsonb, bigint, boolean, numeric, uniqueIndex, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { products, productVariants } from "./catalog.schema";
import { warehouses, warehouseLocations } from "./warehouse.schema";
import { users } from "./identity.schema";

// ============================================================================
// PROCUREMENT + FINANCE/AP TABLES
// Merged into one file to avoid circular FK dependencies between
// procurement (shipmentCosts) and finance (vendorInvoices).
// ============================================================================

// ===== ENUMS =====

// Receiving status workflow: draft → open → receiving → verified → closed
export const receivingStatusEnum = ["draft", "open", "receiving", "verified", "closed", "cancelled"] as const;
export type ReceivingStatus = typeof receivingStatusEnum[number];

// Receiving source types
export const receivingSourceEnum = ["po", "asn", "blind", "initial_load"] as const;
export type ReceivingSource = typeof receivingSourceEnum[number];

// Receiving line status
export const receivingLineStatusEnum = ["pending", "partial", "complete", "overage", "short"] as const;
export type ReceivingLineStatus = typeof receivingLineStatusEnum[number];

// PO status
export const poStatusEnum = [
  "draft", "pending_approval", "approved", "sent", "acknowledged",
  "partially_received", "received", "closed", "cancelled",
] as const;
export type PoStatus = typeof poStatusEnum[number];

// PO type
export const poTypeEnum = ["standard", "blanket", "dropship"] as const;
export type PoType = typeof poTypeEnum[number];

// PO priority
export const poPriorityEnum = ["rush", "high", "normal"] as const;
export type PoPriority = typeof poPriorityEnum[number];

// PO line status
export const poLineStatusEnum = ["open", "partially_received", "received", "closed", "cancelled"] as const;
export type PoLineStatus = typeof poLineStatusEnum[number];

// Inventory type for products
export const inventoryTypeEnum = ["inventory", "non_inventory", "expense"] as const;
export type InventoryType = typeof inventoryTypeEnum[number];

// Vendor invoice status
export const vendorInvoiceStatusEnum = [
  "draft", "received", "approved", "partially_paid", "paid", "disputed", "voided",
] as const;
export type VendorInvoiceStatus = typeof vendorInvoiceStatusEnum[number];

export const apPaymentStatusEnum = [
  "draft", "scheduled", "processing", "completed", "returned", "voided",
] as const;
export type ApPaymentStatus = typeof apPaymentStatusEnum[number];

export const apPaymentMethodEnum = [
  "ach", "check", "wire", "credit_card", "other",
] as const;
export type ApPaymentMethod = typeof apPaymentMethodEnum[number];

// ============================================================================
// 1. VENDORS (no internal refs)
// ============================================================================

const procurementSchema = pgSchema("procurement");

export const vendors = procurementSchema.table("vendors", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: varchar("code", { length: 20 }).notNull().unique(), // Short code like "ACME"
  name: text("name").notNull(),
  contactName: text("contact_name"),
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 50 }),
  address: text("address"),
  notes: text("notes"),
  active: integer("active").notNull().default(1),

  // ===== PROCUREMENT ENHANCEMENTS =====
  paymentTermsDays: integer("payment_terms_days").default(30), // Net payment days
  paymentTermsType: varchar("payment_terms_type", { length: 20 }).default("net"), // net, cod, prepaid, cia
  currency: varchar("currency", { length: 3 }).default("USD"), // Default transaction currency
  taxId: varchar("tax_id", { length: 50 }), // Vendor tax ID / EIN (1099 reporting)
  accountNumber: varchar("account_number", { length: 50 }), // Our account # with this vendor
  website: text("website"),
  defaultLeadTimeDays: integer("default_lead_time_days").default(120), // Default lead time
  minimumOrderCents: bigint("minimum_order_cents", { mode: "number" }).default(0), // Min PO dollar amount
  freeFreightThresholdCents: bigint("free_freight_threshold_cents", { mode: "number" }), // PO value above which freight is free
  vendorType: varchar("vendor_type", { length: 20 }).default("distributor"), // manufacturer, distributor, broker
  shipFromAddress: text("ship_from_address"), // Where they ship from (for landed cost)
  country: varchar("country", { length: 50 }).default("US"), // Origin country
  rating: integer("rating"), // 1-5 manual performance rating
  defaultIncoterms: varchar("default_incoterms", { length: 10 }), // FOB, CIF, EXW, DDP etc — pre-populates POs

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertVendorSchema = createInsertSchema(vendors).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertVendor = z.infer<typeof insertVendorSchema>;
export type Vendor = typeof vendors.$inferSelect;

// ============================================================================
// 2. VENDOR PRODUCTS (refs vendors, and external tables)
// ============================================================================

// ===== VENDOR PRODUCTS (product → vendor mapping) =====

export const vendorProducts = procurementSchema.table("vendor_products", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "set null" }), // Specific variant if vendor sells at variant level
  vendorSku: varchar("vendor_sku", { length: 100 }), // Vendor's own catalog number
  vendorProductName: text("vendor_product_name"), // Vendor's product name
  unitCostCents: bigint("unit_cost_cents", { mode: "number" }).default(0), // Negotiated cost per unit
  packSize: integer("pack_size").default(1), // Units in vendor's selling unit
  moq: integer("moq").default(1), // Minimum order quantity
  leadTimeDays: integer("lead_time_days"), // Vendor-specific override
  isPreferred: integer("is_preferred").default(0), // 1 = primary vendor for this product
  isActive: integer("is_active").default(1),
  lastPurchasedAt: timestamp("last_purchased_at"), // For stale-link detection
  lastCostCents: bigint("last_cost_cents", { mode: "number" }), // Cost from most recent closed PO
  // Packaging dimensions (for shipment tracking / landed cost allocation)
  weightKg: numeric("weight_kg", { precision: 10, scale: 3 }),
  lengthCm: numeric("length_cm", { precision: 8, scale: 2 }),
  widthCm: numeric("width_cm", { precision: 8, scale: 2 }),
  heightCm: numeric("height_cm", { precision: 8, scale: 2 }),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("vendor_products_vendor_product_variant_idx").on(table.vendorId, table.productId, table.productVariantId),
]);

export const insertVendorProductSchema = createInsertSchema(vendorProducts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertVendorProduct = z.infer<typeof insertVendorProductSchema>;
export type VendorProduct = typeof vendorProducts.$inferSelect;

// ============================================================================
// 3. PO APPROVAL TIERS (no internal refs)
// ============================================================================

// ===== PO APPROVAL TIERS =====

export const poApprovalTiers = procurementSchema.table("po_approval_tiers", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  tierName: text("tier_name").notNull(), // "Standard", "High Value", "Critical"
  thresholdCents: bigint("threshold_cents", { mode: "number" }).notNull(), // Min PO total to trigger this tier
  approverRole: varchar("approver_role", { length: 30 }).notNull(), // Required role: "lead", "admin"
  sortOrder: integer("sort_order").default(0),
  active: integer("active").default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPoApprovalTierSchema = createInsertSchema(poApprovalTiers).omit({
  id: true,
  createdAt: true,
});

export type InsertPoApprovalTier = z.infer<typeof insertPoApprovalTierSchema>;
export type PoApprovalTier = typeof poApprovalTiers.$inferSelect;

// ============================================================================
// 4. RECEIVING ORDERS (refs vendors)
// ============================================================================

// Receiving Orders - header for each receipt
export const receivingOrders = procurementSchema.table("receiving_orders", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

  // Identification
  receiptNumber: varchar("receipt_number", { length: 50 }).notNull().unique(), // Auto-generated RCV-YYYYMMDD-XXX
  poNumber: varchar("po_number", { length: 100 }), // External PO number from vendor
  purchaseOrderId: integer("purchase_order_id"), // FK to purchase_orders (added post-definition)
  asnNumber: varchar("asn_number", { length: 100 }), // Advance shipment notice number
  inboundShipmentId: integer("inbound_shipment_id"), // FK to inbound_shipments (added post-definition)

  // Source & vendor
  sourceType: varchar("source_type", { length: 20 }).notNull().default("blind"), // po, asn, blind, initial_load
  vendorId: integer("vendor_id").references(() => vendors.id, { onDelete: "set null" }),

  // Warehouse
  warehouseId: integer("warehouse_id").references(() => warehouses.id, { onDelete: "set null" }),
  receivingLocationId: integer("receiving_location_id").references(() => warehouseLocations.id, { onDelete: "set null" }), // Staging area

  // Status & dates
  status: varchar("status", { length: 20 }).notNull().default("draft"), // draft, open, receiving, verified, closed, cancelled
  expectedDate: timestamp("expected_date"),
  receivedDate: timestamp("received_date"), // When receiving started
  closedDate: timestamp("closed_date"), // When receipt was finalized

  // Counts
  expectedLineCount: integer("expected_line_count").default(0),
  receivedLineCount: integer("received_line_count").default(0),
  expectedTotalUnits: integer("expected_total_units").default(0),
  receivedTotalUnits: integer("received_total_units").default(0),

  // Audit
  notes: text("notes"),
  createdBy: varchar("created_by", { length: 100 }),
  receivedBy: varchar("received_by", { length: 100 }),
  closedBy: varchar("closed_by", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertReceivingOrderSchema = createInsertSchema(receivingOrders).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertReceivingOrder = z.infer<typeof insertReceivingOrderSchema>;
export type ReceivingOrder = typeof receivingOrders.$inferSelect;

// ============================================================================
// 5. RECEIVING LINES (refs receivingOrders)
// ============================================================================

// Receiving Lines - individual items on a receipt
export const receivingLines = procurementSchema.table("receiving_lines", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  receivingOrderId: integer("receiving_order_id").notNull().references(() => receivingOrders.id, { onDelete: "cascade" }),

  // Product reference
  productVariantId: integer("product_variant_id").references(() => productVariants.id),
  productId: integer("product_id").references(() => products.id),

  // Product info (cached for display)
  sku: varchar("sku", { length: 100 }),
  productName: text("product_name"),
  barcode: varchar("barcode", { length: 100 }),

  // Quantities
  expectedQty: integer("expected_qty").notNull().default(0), // From PO (0 for blind receives)
  receivedQty: integer("received_qty").notNull().default(0), // Actually received
  damagedQty: integer("damaged_qty").notNull().default(0), // Damaged during receipt

  // PO line linkage
  purchaseOrderLineId: integer("purchase_order_line_id"), // FK to purchase_order_lines (added post-definition)

  // Cost tracking
  unitCost: bigint("unit_cost", { mode: "number" }), // Cost per unit in cents

  // Put-away location (where it goes after receiving)
  putawayLocationId: integer("putaway_location_id").references(() => warehouseLocations.id, { onDelete: "set null" }),
  putawayComplete: integer("putaway_complete").notNull().default(0), // 1 = put away

  // Status
  status: varchar("status", { length: 20 }).notNull().default("pending"), // pending, partial, complete, overage, short

  // Audit
  receivedBy: varchar("received_by").references(() => users.id, { onDelete: "set null" }),
  receivedAt: timestamp("received_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertReceivingLineSchema = createInsertSchema(receivingLines).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertReceivingLine = z.infer<typeof insertReceivingLineSchema>;
export type ReceivingLine = typeof receivingLines.$inferSelect;

// ============================================================================
// 6. PURCHASE ORDERS (refs vendors, poApprovalTiers)
// ============================================================================

// ===== PURCHASE ORDERS =====

export const purchaseOrders = procurementSchema.table("purchase_orders", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  poNumber: varchar("po_number", { length: 30 }).notNull().unique(), // Auto: PO-YYYYMMDD-###
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  warehouseId: integer("warehouse_id").references(() => warehouses.id, { onDelete: "set null" }), // Ship-to warehouse
  shipToAddress: text("ship_to_address"), // Override warehouse address
  shipFromAddress: text("ship_from_address"), // Vendor's ship-from (for landed cost)

  // Status
  status: varchar("status", { length: 20 }).notNull().default("draft"),
  poType: varchar("po_type", { length: 20 }).default("standard"), // standard, blanket, dropship
  priority: varchar("priority", { length: 10 }).default("normal"), // rush, high, normal

  // Dates
  orderDate: timestamp("order_date"), // When PO placed (set on "send")
  expectedDeliveryDate: timestamp("expected_delivery_date"), // Our requested date
  confirmedDeliveryDate: timestamp("confirmed_delivery_date"), // Vendor's confirmed date
  cancelDate: timestamp("cancel_date"), // Auto-cancel if not received by
  actualDeliveryDate: timestamp("actual_delivery_date"), // When fully received

  // Financials
  currency: varchar("currency", { length: 3 }).default("USD"),
  subtotalCents: bigint("subtotal_cents", { mode: "number" }).default(0), // Sum of line totals
  discountCents: bigint("discount_cents", { mode: "number" }).default(0), // Header-level discount
  taxCents: bigint("tax_cents", { mode: "number" }).default(0),
  shippingCostCents: bigint("shipping_cost_cents", { mode: "number" }).default(0), // Freight estimate
  totalCents: bigint("total_cents", { mode: "number" }).default(0), // Grand total
  paymentTermsDays: integer("payment_terms_days"), // Copied from vendor, editable
  paymentTermsType: varchar("payment_terms_type", { length: 20 }),

  // Shipping
  shippingMethod: varchar("shipping_method", { length: 50 }), // ground, ocean, air, ltl, ftl
  shippingAccountNumber: varchar("shipping_account_number", { length: 50 }), // If using own freight account
  incoterms: varchar("incoterms", { length: 10 }), // FOB, CIF, EXW, DDP
  freightTerms: varchar("freight_terms", { length: 30 }), // prepaid, collect, third_party

  // Vendor
  referenceNumber: varchar("reference_number", { length: 100 }), // Vendor's quote/contract ref
  vendorContactName: varchar("vendor_contact_name", { length: 100 }),
  vendorContactEmail: varchar("vendor_contact_email", { length: 255 }),
  vendorAckDate: timestamp("vendor_ack_date"), // When vendor acknowledged
  vendorRefNumber: varchar("vendor_ref_number", { length: 100 }), // Vendor's order confirmation #

  // Counts
  lineCount: integer("line_count").default(0), // Denormalized
  receivedLineCount: integer("received_line_count").default(0),
  revisionNumber: integer("revision_number").default(0), // Increments on amendments after sent

  // Notes
  vendorNotes: text("vendor_notes"), // Printed on PO document
  internalNotes: text("internal_notes"), // Warehouse-only

  // Approval
  approvalTierId: integer("approval_tier_id").references(() => poApprovalTiers.id, { onDelete: "set null" }),
  approvedBy: varchar("approved_by").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at"),
  approvalNotes: text("approval_notes"),

  // Lifecycle
  sentToVendorAt: timestamp("sent_to_vendor_at"),
  cancelledAt: timestamp("cancelled_at"),
  cancelledBy: varchar("cancelled_by").references(() => users.id, { onDelete: "set null" }),
  cancelReason: text("cancel_reason"),
  closedAt: timestamp("closed_at"),
  closedBy: varchar("closed_by").references(() => users.id, { onDelete: "set null" }),
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  updatedBy: varchar("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  metadata: jsonb("metadata"), // Extensible (attachments, custom fields)

  // Auto-draft tracking
  source: varchar("source", { length: 30 }).default("manual"), // 'manual' | 'auto_draft' | 'reorder'
  autoDraftDate: date("auto_draft_date"),
});

export const insertPurchaseOrderSchema = createInsertSchema(purchaseOrders).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPurchaseOrder = z.infer<typeof insertPurchaseOrderSchema>;
export type PurchaseOrder = typeof purchaseOrders.$inferSelect;

// ============================================================================
// 7. PURCHASE ORDER LINES (refs purchaseOrders, vendorProducts)
// ============================================================================

// ===== PURCHASE ORDER LINES =====

export const purchaseOrderLines = procurementSchema.table("purchase_order_lines", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrders.id, { onDelete: "cascade" }),
  lineNumber: integer("line_number").notNull(), // Sequential for display

  // Product (required — catalog item must exist for full cost chain)
  productId: integer("product_id").notNull().references(() => products.id),
  productVariantId: integer("product_variant_id").notNull().references(() => productVariants.id),
  vendorProductId: integer("vendor_product_id").references(() => vendorProducts.id, { onDelete: "set null" }),
  sku: varchar("sku", { length: 100 }), // Cached at creation
  productName: text("product_name"), // Cached
  description: text("description"), // Special instructions, specs
  vendorSku: varchar("vendor_sku", { length: 100 }), // Vendor's SKU

  // Quantities
  unitOfMeasure: varchar("unit_of_measure", { length: 20 }), // each, pack, box, case
  unitsPerUom: integer("units_per_uom").default(1), // For base unit conversion
  orderQty: integer("order_qty").notNull(), // Ordered quantity (variant units)
  receivedQty: integer("received_qty").default(0), // Running tally from receipts
  damagedQty: integer("damaged_qty").default(0), // Running tally
  returnedQty: integer("returned_qty").default(0), // Running tally for RMA
  cancelledQty: integer("cancelled_qty").default(0),

  // Cost
  unitCostCents: bigint("unit_cost_cents", { mode: "number" }).notNull().default(0),
  discountPercent: numeric("discount_percent", { precision: 5, scale: 2 }).default("0"),
  discountCents: bigint("discount_cents", { mode: "number" }).default(0), // Computed
  taxRatePercent: numeric("tax_rate_percent", { precision: 5, scale: 2 }).default("0"),
  taxCents: bigint("tax_cents", { mode: "number" }).default(0),
  lineTotalCents: bigint("line_total_cents", { mode: "number" }), // (order_qty * unit_cost_cents) - discount + tax

  // Dates
  expectedDeliveryDate: timestamp("expected_delivery_date"), // Per-line override
  promisedDate: timestamp("promised_date"), // Vendor's per-line promise
  receivedDate: timestamp("received_date"), // When first receipt happened
  fullyReceivedDate: timestamp("fully_received_date"), // When received_qty >= order_qty
  lastReceivedAt: timestamp("last_received_at"), // Most recent receipt

  // Status
  status: varchar("status", { length: 20 }).default("open"), // open, partially_received, received, closed, cancelled
  closeShortReason: text("close_short_reason"), // Why closed before fully received

  // Meta
  weightGrams: integer("weight_grams"), // For freight estimation
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertPurchaseOrderLineSchema = createInsertSchema(purchaseOrderLines).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPurchaseOrderLine = z.infer<typeof insertPurchaseOrderLineSchema>;
export type PurchaseOrderLine = typeof purchaseOrderLines.$inferSelect;

// ============================================================================
// 8. PO STATUS HISTORY & PO REVISIONS (ref purchaseOrders, purchaseOrderLines)
// ============================================================================

// ===== PO STATUS HISTORY (status transition audit) =====

export const poStatusHistory = procurementSchema.table("po_status_history", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrders.id, { onDelete: "cascade" }),
  fromStatus: varchar("from_status", { length: 20 }), // NULL for creation
  toStatus: varchar("to_status", { length: 20 }).notNull(),
  changedBy: varchar("changed_by").references(() => users.id, { onDelete: "set null" }),
  changedAt: timestamp("changed_at").defaultNow().notNull(),
  notes: text("notes"), // Reason for change
  revisionNumber: integer("revision_number"), // Snapshot
});

export const insertPoStatusHistorySchema = createInsertSchema(poStatusHistory).omit({
  id: true,
  changedAt: true,
});

export type InsertPoStatusHistory = z.infer<typeof insertPoStatusHistorySchema>;
export type PoStatusHistory = typeof poStatusHistory.$inferSelect;

// ===== PO REVISIONS (field-level change audit) =====

export const poRevisions = procurementSchema.table("po_revisions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrders.id, { onDelete: "cascade" }),
  revisionNumber: integer("revision_number"),
  changedBy: varchar("changed_by").references(() => users.id, { onDelete: "set null" }),
  changeType: varchar("change_type", { length: 20 }), // line_added, line_removed, qty_changed, price_changed, date_changed, header_changed
  fieldChanged: varchar("field_changed", { length: 50 }),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  lineId: integer("line_id").references(() => purchaseOrderLines.id, { onDelete: "set null" }), // Nullable — for line-level changes
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPoRevisionSchema = createInsertSchema(poRevisions).omit({
  id: true,
  createdAt: true,
});

export type InsertPoRevision = z.infer<typeof insertPoRevisionSchema>;
export type PoRevision = typeof poRevisions.$inferSelect;

// ============================================================================
// 9. PO RECEIPTS (refs purchaseOrders, purchaseOrderLines, receivingOrders, receivingLines)
// ============================================================================

// ===== PO RECEIPTS (PO line → Receiving line link) =====

export const poReceipts = procurementSchema.table("po_receipts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrders.id, { onDelete: "cascade" }),
  purchaseOrderLineId: integer("purchase_order_line_id").notNull().references(() => purchaseOrderLines.id, { onDelete: "cascade" }),
  receivingOrderId: integer("receiving_order_id").notNull().references(() => receivingOrders.id, { onDelete: "cascade" }),
  receivingLineId: integer("receiving_line_id").notNull().references(() => receivingLines.id, { onDelete: "cascade" }),
  qtyReceived: integer("qty_received").notNull().default(0),
  poUnitCostCents: bigint("po_unit_cost_cents", { mode: "number" }), // Cost on PO
  actualUnitCostCents: bigint("actual_unit_cost_cents", { mode: "number" }), // Actual receipt cost
  varianceCents: bigint("variance_cents", { mode: "number" }), // actual - po
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("po_receipts_po_line_rcv_line_idx").on(table.purchaseOrderLineId, table.receivingLineId),
]);

export const insertPoReceiptSchema = createInsertSchema(poReceipts).omit({
  id: true,
  createdAt: true,
});

export type InsertPoReceipt = z.infer<typeof insertPoReceiptSchema>;
export type PoReceipt = typeof poReceipts.$inferSelect;

// ============================================================================
// 10. INBOUND SHIPMENTS (external refs only)
// ============================================================================

export const inboundShipments = procurementSchema.table("inbound_shipments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  shipmentNumber: varchar("shipment_number", { length: 30 }).notNull().unique(),
  status: varchar("status", { length: 20 }).notNull().default("draft"),
  mode: varchar("mode", { length: 20 }),
  carrierName: varchar("carrier_name", { length: 100 }),
  forwarderName: varchar("forwarder_name", { length: 100 }),
  shipperName: varchar("shipper_name", { length: 200 }),
  bookingReference: varchar("booking_reference", { length: 100 }),
  originPort: varchar("origin_port", { length: 100 }),
  destinationPort: varchar("destination_port", { length: 100 }),
  originCountry: varchar("origin_country", { length: 50 }),
  destinationCountry: varchar("destination_country", { length: 50 }),
  containerNumber: varchar("container_number", { length: 30 }),
  sealNumber: varchar("seal_number", { length: 30 }),
  containerSize: varchar("container_size", { length: 10 }),
  containerCapacityCbm: numeric("container_capacity_cbm", { precision: 8, scale: 2 }),
  bolNumber: varchar("bol_number", { length: 100 }),
  houseBol: varchar("house_bol", { length: 100 }),
  trackingNumber: varchar("tracking_number", { length: 200 }),
  shipDate: timestamp("ship_date"),
  etd: timestamp("etd"),
  eta: timestamp("eta"),
  actualArrival: timestamp("actual_arrival"),
  customsClearedDate: timestamp("customs_cleared_date"),
  deliveredDate: timestamp("delivered_date"),
  warehouseId: integer("warehouse_id").references(() => warehouses.id, { onDelete: "set null" }),
  totalWeightKg: numeric("total_weight_kg", { precision: 12, scale: 3 }),
  totalVolumeCbm: numeric("total_volume_cbm", { precision: 12, scale: 6 }),
  totalGrossVolumeCbm: numeric("total_gross_volume_cbm", { precision: 12, scale: 6 }),
  grossWeightKg: numeric("gross_weight_kg", { precision: 12, scale: 3 }),
  palletCount: integer("pallet_count"),
  totalPieces: integer("total_pieces"),
  totalCartons: integer("total_cartons"),
  estimatedTotalCostCents: bigint("estimated_total_cost_cents", { mode: "number" }),
  actualTotalCostCents: bigint("actual_total_cost_cents", { mode: "number" }),
  allocationMethodDefault: varchar("allocation_method_default", { length: 30 }),
  notes: text("notes"),
  internalNotes: text("internal_notes"),
  createdBy: varchar("created_by", { length: 100 }).references(() => users.id, { onDelete: "set null" }),
  closedBy: varchar("closed_by", { length: 100 }).references(() => users.id, { onDelete: "set null" }),
  closedAt: timestamp("closed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertInboundShipmentSchema = createInsertSchema(inboundShipments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertInboundShipment = z.infer<typeof insertInboundShipmentSchema>;
export type InboundShipment = typeof inboundShipments.$inferSelect;

// ============================================================================
// 11. INBOUND SHIPMENT LINES (refs inboundShipments, purchaseOrders, purchaseOrderLines)
// ============================================================================

export const inboundShipmentLines = procurementSchema.table("inbound_shipment_lines", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  inboundShipmentId: integer("inbound_shipment_id").notNull().references(() => inboundShipments.id, { onDelete: "cascade" }),
  purchaseOrderId: integer("purchase_order_id").references(() => purchaseOrders.id, { onDelete: "set null" }),
  purchaseOrderLineId: integer("purchase_order_line_id").references(() => purchaseOrderLines.id, { onDelete: "set null" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "set null" }),
  sku: varchar("sku", { length: 100 }),
  qtyShipped: integer("qty_shipped").notNull(),
  // Per-unit dimensions
  weightKg: numeric("weight_kg", { precision: 10, scale: 3 }),
  lengthCm: numeric("length_cm", { precision: 8, scale: 2 }),
  widthCm: numeric("width_cm", { precision: 8, scale: 2 }),
  heightCm: numeric("height_cm", { precision: 8, scale: 2 }),
  // Computed totals
  totalWeightKg: numeric("total_weight_kg", { precision: 12, scale: 3 }),
  totalVolumeCbm: numeric("total_volume_cbm", { precision: 12, scale: 6 }),
  chargeableWeightKg: numeric("chargeable_weight_kg", { precision: 12, scale: 3 }),
  // Gross volume
  grossVolumeCbm: numeric("gross_volume_cbm", { precision: 12, scale: 6 }),
  cartonCount: integer("carton_count"),
  palletCount: integer("pallet_count"),
  // Allocation results
  allocatedCostCents: bigint("allocated_cost_cents", { mode: "number" }),
  landedUnitCostCents: bigint("landed_unit_cost_cents", { mode: "number" }),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertInboundShipmentLineSchema = createInsertSchema(inboundShipmentLines).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertInboundShipmentLine = z.infer<typeof insertInboundShipmentLineSchema>;
export type InboundShipmentLine = typeof inboundShipmentLines.$inferSelect;

// ============================================================================
// 12. VENDOR INVOICES (refs vendors, inboundShipments) — MUST be before shipmentCosts!
// ============================================================================

// ===== VENDOR INVOICES =====

export const vendorInvoices = procurementSchema.table("vendor_invoices", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  invoiceNumber: varchar("invoice_number", { length: 100 }).notNull(), // Vendor's invoice number
  ourReference: varchar("our_reference", { length: 100 }), // Internal reference

  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  inboundShipmentId: integer("inbound_shipment_id").references(() => inboundShipments.id, { onDelete: "set null" }),

  status: varchar("status", { length: 20 }).notNull().default("received"),

  // Dates
  invoiceDate: timestamp("invoice_date"), // Date on the vendor's invoice
  receivedDate: timestamp("received_date"), // When we received it
  dueDate: timestamp("due_date"), // Computed: invoiceDate + paymentTermsDays
  approvedAt: timestamp("approved_at"),
  approvedBy: varchar("approved_by").references(() => users.id, { onDelete: "set null" }),

  // Amounts (bigint for totals; exact dollar amounts)
  invoicedAmountCents: bigint("invoiced_amount_cents", { mode: "number" }).notNull().default(0),
  paidAmountCents: bigint("paid_amount_cents", { mode: "number" }).notNull().default(0), // Denorm — updated on payment
  balanceCents: bigint("balance_cents", { mode: "number" }).notNull().default(0), // invoicedAmount - paidAmount

  currency: varchar("currency", { length: 3 }).default("USD"),
  paymentTermsDays: integer("payment_terms_days"), // Copied from PO/vendor at creation
  paymentTermsType: varchar("payment_terms_type", { length: 20 }),

  // Notes
  notes: text("notes"), // Vendor-facing
  internalNotes: text("internal_notes"),
  disputeReason: text("dispute_reason"),

  // Audit
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  updatedBy: varchar("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertVendorInvoiceSchema = createInsertSchema(vendorInvoices).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertVendorInvoice = z.infer<typeof insertVendorInvoiceSchema>;
export type VendorInvoice = typeof vendorInvoices.$inferSelect;

// ============================================================================
// 13. SHIPMENT COSTS (refs inboundShipments, vendors, vendorInvoices)
// ============================================================================

export const inboundFreightCosts = procurementSchema.table("inbound_freight_costs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  inboundShipmentId: integer("inbound_shipment_id").notNull().references(() => inboundShipments.id, { onDelete: "cascade" }),
  costType: varchar("cost_type", { length: 30 }).notNull(),
  description: text("description"),
  estimatedCents: bigint("estimated_cents", { mode: "number" }),
  actualCents: bigint("actual_cents", { mode: "number" }),
  currency: varchar("currency", { length: 3 }).default("USD"),
  exchangeRate: numeric("exchange_rate", { precision: 10, scale: 4 }).default("1"),
  allocationMethod: varchar("allocation_method", { length: 30 }),
  costStatus: varchar("cost_status", { length: 20 }).default("estimated"),
  invoiceNumber: varchar("invoice_number", { length: 100 }),
  invoiceDate: timestamp("invoice_date"),
  dueDate: timestamp("due_date"),
  paidDate: timestamp("paid_date"),
  vendorName: text("vendor_name"),
  vendorId: integer("vendor_id").references(() => vendors.id, { onDelete: "set null" }),
  vendorInvoiceId: integer("vendor_invoice_id").references(() => vendorInvoices.id, { onDelete: "set null" }),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertInboundFreightCostSchema = createInsertSchema(inboundFreightCosts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertInboundFreightCost = z.infer<typeof insertInboundFreightCostSchema>;
export type InboundFreightCost = typeof inboundFreightCosts.$inferSelect;

// ============================================================================
// 14. SHIPMENT COST ALLOCATIONS (refs shipmentCosts, inboundShipmentLines)
// ============================================================================

export const inboundFreightAllocations = procurementSchema.table("inbound_freight_allocations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  shipmentCostId: integer("shipment_cost_id").notNull().references(() => inboundFreightCosts.id, { onDelete: "cascade" }),
  inboundShipmentLineId: integer("inbound_shipment_line_id").notNull().references(() => inboundShipmentLines.id, { onDelete: "cascade" }),
  allocationBasisValue: numeric("allocation_basis_value", { precision: 14, scale: 6 }),
  allocationBasisTotal: numeric("allocation_basis_total", { precision: 14, scale: 6 }),
  sharePercent: numeric("share_percent", { precision: 8, scale: 4 }),
  allocatedCents: bigint("allocated_cents", { mode: "number" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertInboundFreightAllocationSchema = createInsertSchema(inboundFreightAllocations).omit({
  id: true,
  createdAt: true,
});

export type InsertInboundFreightAllocation = z.infer<typeof insertInboundFreightAllocationSchema>;
export type InboundFreightAllocation = typeof inboundFreightAllocations.$inferSelect;

// ============================================================================
// 15. LANDED COST SNAPSHOTS (refs inboundShipmentLines, purchaseOrderLines)
// ============================================================================

export const landedCostSnapshots = procurementSchema.table("landed_cost_snapshots", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  inboundShipmentLineId: integer("inbound_shipment_line_id").references(() => inboundShipmentLines.id, { onDelete: "cascade" }),
  purchaseOrderLineId: integer("purchase_order_line_id").references(() => purchaseOrderLines.id, { onDelete: "set null" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "set null" }),
  poUnitCostCents: bigint("po_unit_cost_cents", { mode: "number" }),
  freightAllocatedCents: bigint("freight_allocated_cents", { mode: "number" }),
  dutyAllocatedCents: bigint("duty_allocated_cents", { mode: "number" }),
  insuranceAllocatedCents: bigint("insurance_allocated_cents", { mode: "number" }),
  otherAllocatedCents: bigint("other_allocated_cents", { mode: "number" }),
  totalLandedCostCents: bigint("total_landed_cost_cents", { mode: "number" }),
  landedUnitCostCents: bigint("landed_unit_cost_cents", { mode: "number" }),
  qty: integer("qty"),
  finalizedAt: timestamp("finalized_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertLandedCostSnapshotSchema = createInsertSchema(landedCostSnapshots).omit({
  id: true,
  createdAt: true,
});

export type InsertLandedCostSnapshot = z.infer<typeof insertLandedCostSnapshotSchema>;
export type LandedCostSnapshot = typeof landedCostSnapshots.$inferSelect;

// ============================================================================
// 16. INBOUND SHIPMENT STATUS HISTORY (refs inboundShipments)
// ============================================================================

export const inboundShipmentStatusHistory = procurementSchema.table("inbound_shipment_status_history", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  inboundShipmentId: integer("inbound_shipment_id").notNull().references(() => inboundShipments.id, { onDelete: "cascade" }),
  fromStatus: varchar("from_status", { length: 20 }),
  toStatus: varchar("to_status", { length: 20 }).notNull(),
  changedBy: varchar("changed_by", { length: 100 }).references(() => users.id, { onDelete: "set null" }),
  changedAt: timestamp("changed_at").defaultNow().notNull(),
  notes: text("notes"),
});

export const insertInboundShipmentStatusHistorySchema = createInsertSchema(inboundShipmentStatusHistory).omit({
  id: true,
  changedAt: true,
});

export type InsertInboundShipmentStatusHistory = z.infer<typeof insertInboundShipmentStatusHistorySchema>;
export type InboundShipmentStatusHistory = typeof inboundShipmentStatusHistory.$inferSelect;

// ============================================================================
// 17. VENDOR INVOICE → PO LINKS (refs vendorInvoices, purchaseOrders)
// ============================================================================

// ===== VENDOR INVOICE → PO LINKS =====

export const vendorInvoicePoLinks = procurementSchema.table("vendor_invoice_po_links", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorInvoiceId: integer("vendor_invoice_id").notNull().references(() => vendorInvoices.id, { onDelete: "cascade" }),
  purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrders.id, { onDelete: "cascade" }),
  allocatedAmountCents: bigint("allocated_amount_cents", { mode: "number" }), // Portion of invoice for this PO (nullable = unallocated)
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("vendor_invoice_po_links_inv_po_idx").on(table.vendorInvoiceId, table.purchaseOrderId),
]);

export const insertVendorInvoicePoLinkSchema = createInsertSchema(vendorInvoicePoLinks).omit({
  id: true,
  createdAt: true,
});

export type InsertVendorInvoicePoLink = z.infer<typeof insertVendorInvoicePoLinkSchema>;
export type VendorInvoicePoLink = typeof vendorInvoicePoLinks.$inferSelect;

// ============================================================================
// 18. VENDOR INVOICE LINES (refs vendorInvoices, purchaseOrderLines)
// ============================================================================

// ===== VENDOR INVOICE LINES =====

export const vendorInvoiceLines = procurementSchema.table("vendor_invoice_lines", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorInvoiceId: integer("vendor_invoice_id").notNull().references(() => vendorInvoices.id, { onDelete: "cascade" }),
  purchaseOrderLineId: integer("purchase_order_line_id").references(() => purchaseOrderLines.id, { onDelete: "set null" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "set null" }),
  lineNumber: integer("line_number").notNull(),
  sku: varchar("sku", { length: 100 }),
  productName: text("product_name"),
  description: text("description"),
  qtyInvoiced: integer("qty_invoiced").notNull(),
  qtyOrdered: integer("qty_ordered"),
  qtyReceived: integer("qty_received"),
  unitCostCents: bigint("unit_cost_cents", { mode: "number" }).notNull(),
  lineTotalCents: bigint("line_total_cents", { mode: "number" }).notNull(),
  matchStatus: varchar("match_status", { length: 20 }).notNull().default("pending"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertVendorInvoiceLineSchema = createInsertSchema(vendorInvoiceLines).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertVendorInvoiceLine = z.infer<typeof insertVendorInvoiceLineSchema>;
export type VendorInvoiceLine = typeof vendorInvoiceLines.$inferSelect;

// ============================================================================
// 19. VENDOR INVOICE ATTACHMENTS (refs vendorInvoices)
// ============================================================================

// ===== VENDOR INVOICE ATTACHMENTS =====

export const vendorInvoiceAttachments = procurementSchema.table("vendor_invoice_attachments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorInvoiceId: integer("vendor_invoice_id").notNull().references(() => vendorInvoices.id, { onDelete: "cascade" }),
  fileName: varchar("file_name", { length: 255 }).notNull(),
  fileType: varchar("file_type", { length: 100 }),
  fileSizeBytes: integer("file_size_bytes"),
  filePath: text("file_path").notNull(),
  uploadedBy: varchar("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
  notes: text("notes"),
});

export const insertVendorInvoiceAttachmentSchema = createInsertSchema(vendorInvoiceAttachments).omit({
  id: true,
  uploadedAt: true,
});

export type InsertVendorInvoiceAttachment = z.infer<typeof insertVendorInvoiceAttachmentSchema>;
export type VendorInvoiceAttachment = typeof vendorInvoiceAttachments.$inferSelect;

// ============================================================================
// 20. AP PAYMENTS (refs vendors)
// ============================================================================

// ===== AP PAYMENTS =====

export const apPayments = procurementSchema.table("ap_payments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  paymentNumber: varchar("payment_number", { length: 30 }).notNull().unique(), // Auto: PAY-YYYYMMDD-###

  vendorId: integer("vendor_id").notNull().references(() => vendors.id),

  paymentDate: timestamp("payment_date").notNull(),
  paymentMethod: varchar("payment_method", { length: 20 }).notNull(), // ach, check, wire, credit_card, other
  referenceNumber: varchar("reference_number", { length: 100 }), // ACH trace, wire ref, etc.
  checkNumber: varchar("check_number", { length: 50 }),
  bankAccountLabel: varchar("bank_account_label", { length: 100 }), // e.g. "Chase Operating"

  totalAmountCents: bigint("total_amount_cents", { mode: "number" }).notNull(),
  currency: varchar("currency", { length: 3 }).default("USD"),

  status: varchar("status", { length: 20 }).notNull().default("completed"),

  voidedAt: timestamp("voided_at"),
  voidedBy: varchar("voided_by").references(() => users.id, { onDelete: "set null" }),
  voidReason: text("void_reason"),

  notes: text("notes"),

  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  updatedBy: varchar("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertApPaymentSchema = createInsertSchema(apPayments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertApPayment = z.infer<typeof insertApPaymentSchema>;
export type ApPayment = typeof apPayments.$inferSelect;

// ============================================================================
// 21. AP PAYMENT ALLOCATIONS (refs apPayments, vendorInvoices)
// ============================================================================

// ===== AP PAYMENT ALLOCATIONS =====

export const apPaymentAllocations = procurementSchema.table("ap_payment_allocations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  apPaymentId: integer("ap_payment_id").notNull().references(() => apPayments.id, { onDelete: "cascade" }),
  vendorInvoiceId: integer("vendor_invoice_id").notNull().references(() => vendorInvoices.id, { onDelete: "cascade" }),
  appliedAmountCents: bigint("applied_amount_cents", { mode: "number" }).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("ap_payment_allocations_pay_inv_idx").on(table.apPaymentId, table.vendorInvoiceId),
]);

export const insertApPaymentAllocationSchema = createInsertSchema(apPaymentAllocations).omit({
  id: true,
  createdAt: true,
});

export type InsertApPaymentAllocation = z.infer<typeof insertApPaymentAllocationSchema>;
export type ApPaymentAllocation = typeof apPaymentAllocations.$inferSelect;

// ============================================================================
// 22. REORDER EXCLUSION RULES
// ============================================================================

export const reorderExclusionRules = pgTable("reorder_exclusion_rules", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  field: varchar("field", { length: 50 }).notNull(), // 'category' | 'brand' | 'product_type' | 'sku_prefix' | 'sku_exact' | 'tag'
  value: text("value").notNull(),
  createdBy: varchar("created_by", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("reorder_exclusion_rules_field_value_uq").on(table.field, table.value),
]);

export const insertReorderExclusionRuleSchema = createInsertSchema(reorderExclusionRules).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertReorderExclusionRule = z.infer<typeof insertReorderExclusionRuleSchema>;
export type ReorderExclusionRule = typeof reorderExclusionRules.$inferSelect;

// ============================================================================
// 23. AUTO-DRAFT RUNS
// ============================================================================

export const autoDraftRuns = pgTable("auto_draft_runs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  runAt: timestamp("run_at").defaultNow().notNull(),
  triggeredBy: varchar("triggered_by", { length: 50 }).notNull().default("scheduler"), // 'scheduler' | 'manual'
  triggeredByUser: varchar("triggered_by_user", { length: 255 }),
  status: varchar("status", { length: 20 }).notNull().default("running"), // 'running' | 'success' | 'error'
  itemsAnalyzed: integer("items_analyzed").notNull().default(0),
  posCreated: integer("pos_created").notNull().default(0),
  posUpdated: integer("pos_updated").notNull().default(0),
  linesAdded: integer("lines_added").notNull().default(0),
  skippedNoVendor: integer("skipped_no_vendor").notNull().default(0),
  skippedOnOrder: integer("skipped_on_order").notNull().default(0),
  skippedExcluded: integer("skipped_excluded").notNull().default(0),
  errorMessage: text("error_message"),
  summaryJson: jsonb("summary_json"),
  finishedAt: timestamp("finished_at"),
});

export const insertAutoDraftRunSchema = createInsertSchema(autoDraftRuns).omit({
  id: true,
  runAt: true,
});

export type InsertAutoDraftRun = z.infer<typeof insertAutoDraftRunSchema>;
export type AutoDraftRun = typeof autoDraftRuns.$inferSelect;


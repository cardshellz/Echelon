import { pgTable, pgSchema, text, varchar, integer, timestamp, jsonb, bigint, boolean, numeric, uniqueIndex, index, date, check, foreignKey, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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

// PO status (legacy single-track — kept for back-compat)
export const poStatusEnum = [
  "draft", "pending_approval", "approved", "sent", "acknowledged",
  "partially_received", "received", "closed", "cancelled",
] as const;
export type PoStatus = typeof poStatusEnum[number];

// PO dual-track: physical (goods-movement) status values (migration 0565)
export const PO_PHYSICAL_STATUSES = [
  "draft", "sent", "acknowledged", "shipped", "in_transit",
  "arrived", "receiving", "received", "cancelled", "short_closed",
] as const;
export type PoPhysicalStatus = typeof PO_PHYSICAL_STATUSES[number];

// PO dual-track: financial (AP/payment) status values (migration 0565)
export const PO_FINANCIAL_STATUSES = [
  "unbilled", "invoiced", "partially_paid", "paid", "disputed",
] as const;
export type PoFinancialStatus = typeof PO_FINANCIAL_STATUSES[number];

// PO type
export const poTypeEnum = ["standard", "blanket", "dropship"] as const;
export type PoType = typeof poTypeEnum[number];

// PO priority
export const poPriorityEnum = ["rush", "high", "normal"] as const;
export type PoPriority = typeof poPriorityEnum[number];

// PO line status
export const poLineStatusEnum = ["open", "partially_received", "received", "closed", "cancelled"] as const;
export type PoLineStatus = typeof poLineStatusEnum[number];

// How a vendor expressed the authoritative price on a PO line. Mills are an
// internal precision unit; operators and integrations retain the vendor's
// original quote basis instead of being forced into a per-piece quote.
export const poLinePricingBasisEnum = [
  "legacy_unknown",
  "not_applicable",
  "per_piece",
  "per_purchase_uom",
  "extended_total",
] as const;
export type PoLinePricingBasis = typeof poLinePricingBasisEnum[number];

export const poLinePricingSourceEnum = [
  "legacy",
  "manual",
  "vendor_catalog",
  "recommendation",
] as const;
export type PoLinePricingSource = typeof poLinePricingSourceEnum[number];

export const vendorProductPricingBasisEnum = [
  "legacy_unknown",
  "per_piece",
  "per_purchase_uom",
] as const;
export type VendorProductPricingBasis = typeof vendorProductPricingBasisEnum[number];

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
  // Catalog identity is historical provenance. Variants are archived rather
  // than deleted; RESTRICT prevents a delete from silently collapsing a
  // variant mapping into the product-level NULL business key.
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "restrict" }), // Specific variant if vendor sells at variant level
  vendorSku: varchar("vendor_sku", { length: 100 }), // Vendor's own catalog number
  vendorProductName: text("vendor_product_name"), // Vendor's product name
  unitCostCents: bigint("unit_cost_cents", { mode: "number" }).default(0), // Negotiated cost per unit (cents; kept in sync with unit_cost_mills for back-compat)
  unitCostMills: bigint("unit_cost_mills", { mode: "number" }), // Negotiated cost per unit in mills (4-decimal precision). Authoritative when non-null.
  // Original reusable vendor-catalog quote. Legacy mappings retain their
  // existing normalized costs without inferring a quote basis.
  pricingBasis: varchar("pricing_basis", { length: 30 }).notNull().default("legacy_unknown"),
  purchaseUom: varchar("purchase_uom", { length: 50 }),
  quotedUnitCostMills: bigint("quoted_unit_cost_mills", { mode: "number" }),
  piecesPerPurchaseUom: integer("pieces_per_purchase_uom"),
  quoteReference: varchar("quote_reference", { length: 255 }),
  quotedAt: timestamp("quoted_at"),
  quoteValidUntil: date("quote_valid_until"),
  packSize: integer("pack_size").default(1), // Units in vendor's selling unit
  moq: integer("moq").default(1), // Minimum order quantity in base pieces
  leadTimeDays: integer("lead_time_days"), // Vendor-specific override
  isPreferred: integer("is_preferred").default(0), // 1 = primary vendor for this product
  isActive: integer("is_active").default(1),
  lastPurchasedAt: timestamp("last_purchased_at"), // For stale-link detection
  lastCostMills: bigint("last_cost_mills", { mode: "number" }), // Exact normalized cost from most recent completed PO
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
  // PostgreSQL treats NULL values as distinct in an ordinary unique index.
  // Coalescing the nullable variant closes that hole for product-level vendor
  // mappings while retaining one key for each concrete variant.
  uniqueIndex("vendor_products_vendor_product_variant_key_uidx").on(
    table.vendorId,
    table.productId,
    sql`COALESCE(${table.productVariantId}, 0)`,
  ),
  uniqueIndex("vendor_products_one_active_preferred_key_uidx")
    .on(
      table.productId,
      sql`COALESCE(${table.productVariantId}, 0)`,
    )
    .where(sql`${table.isActive} = 1 AND ${table.isPreferred} = 1`),
  check(
    "vendor_products_pricing_basis_chk",
    sql`${table.pricingBasis} IN ('legacy_unknown', 'per_piece', 'per_purchase_uom')`,
  ),
  check(
    "vendor_products_moq_positive_chk",
    sql`${table.moq} IS NULL OR ${table.moq} > 0`,
  ),
  check(
    "vendor_products_last_cost_precision_chk",
    sql`(
      ${table.lastCostMills} IS NULL
      AND ${table.lastCostCents} IS NULL
    ) OR (
      ${table.lastCostMills} IS NOT NULL
      AND ${table.lastCostMills} >= 0
      AND ${table.lastCostCents} IS NOT NULL
      AND ${table.lastCostCents} >= 0
      AND ${table.lastCostCents}::numeric = floor((${table.lastCostMills}::numeric + 50) / 100)
    )`,
  ),
  check(
    "vendor_products_explicit_pricing_consistency_chk",
    sql`(
      ${table.pricingBasis} = 'legacy_unknown'
      AND ${table.purchaseUom} IS NULL
      AND ${table.quotedUnitCostMills} IS NULL
      AND ${table.piecesPerPurchaseUom} IS NULL
      AND ${table.quoteReference} IS NULL
      AND ${table.quotedAt} IS NULL
      AND ${table.quoteValidUntil} IS NULL
    ) OR (
      ${table.unitCostMills} IS NOT NULL
      AND ${table.unitCostMills} >= 0
      AND ${table.unitCostCents} IS NOT NULL
      AND ${table.unitCostCents} >= 0
      AND ${table.quotedUnitCostMills} IS NOT NULL
      AND ${table.quotedUnitCostMills} >= 0
      AND ${table.quotedAt} IS NOT NULL
      AND (
        ${table.quoteValidUntil} IS NULL
        OR ${table.quoteValidUntil} >= ${table.quotedAt}::date
      )
      AND ${table.unitCostCents}::numeric = floor((${table.unitCostMills}::numeric + 50) / 100)
      AND (
        (
          ${table.pricingBasis} = 'per_piece'
          AND ${table.purchaseUom} IS NULL
          AND ${table.piecesPerPurchaseUom} IS NULL
          AND ${table.unitCostMills} = ${table.quotedUnitCostMills}
        ) OR (
          ${table.pricingBasis} = 'per_purchase_uom'
          AND ${table.purchaseUom} IS NOT NULL
          AND btrim(${table.purchaseUom}) <> ''
          AND ${table.piecesPerPurchaseUom} IS NOT NULL
          AND ${table.piecesPerPurchaseUom} > 0
          AND ${table.unitCostMills}::numeric = floor(
            ${table.quotedUnitCostMills}::numeric / NULLIF(${table.piecesPerPurchaseUom}, 0)::numeric + 0.5
          )
        )
      )
    )`,
  ),
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
  receiptNumber: varchar("receipt_number", { length: 50 }).notNull(), // Auto-generated RCV-YYYYMMDD-XXX (partial unique index in table constraints)
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
}, (table) => [
  uniqueIndex("receiving_orders_receipt_number_active_uidx").on(table.receiptNumber).where(sql`status <> 'cancelled'`),
  uniqueIndex("receiving_orders_shipment_po_active_uidx")
    .on(table.inboundShipmentId, table.purchaseOrderId)
    .where(sql`inbound_shipment_id IS NOT NULL AND purchase_order_id IS NOT NULL AND status IN ('draft', 'open', 'receiving', 'verified')`),
]);

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

  // Cost tracking.
  // `unitCost` (cents) is kept for back-compat; `unitCostMills` (4-decimal
  // precision, 1/10000 of a dollar) is authoritative when present. See
  // migration 0562_receiving_lines_unit_cost_mills.sql and
  // shared/utils/money.ts (millsToCents / centsToMills).
  unitCost: bigint("unit_cost", { mode: "number" }), // Cost per unit in cents
  unitCostMills: bigint("unit_cost_mills", { mode: "number" }), // Cost per unit in mills (4-decimal)

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
  poNumber: varchar("po_number", { length: 30 }).notNull(), // Auto: PO-YYYYMMDD-### (partial unique index in table constraints)
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
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
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
  overReceiptTolerancePct: numeric("over_receipt_tolerance_pct", { precision: 5, scale: 2 }).default("0"),

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

  // ── Dual-track lifecycle (migration 0565) ────────────────────────────────
  // physicalStatus tracks goods movement; financialStatus tracks AP/payment.
  // The legacy `status` column stays as a single-track aggregate for
  // back-compat with callers not yet updated to the dual-track model.
  //
  // Physical values: draft | sent | acknowledged | shipped | in_transit |
  //   arrived | receiving | received | cancelled | short_closed
  // Financial values: unbilled | invoiced | partially_paid | paid | disputed
  physicalStatus: varchar("physical_status", { length: 30 }).notNull().default("draft"),
  financialStatus: varchar("financial_status", { length: 30 }).notNull().default("unbilled"),

  // Physical lifecycle timestamps (complement the existing sentToVendorAt etc.)
  firstShippedAt: timestamp("first_shipped_at"),
  firstArrivedAt: timestamp("first_arrived_at"),

  // Financial lifecycle timestamps
  firstInvoicedAt: timestamp("first_invoiced_at"),
  firstPaidAt: timestamp("first_paid_at"),
  fullyPaidAt: timestamp("fully_paid_at"),

  // Rolled-up financial aggregates — kept current by recomputeFinancialAggregates.
  // Integer cents only (Rule #3 — no floats).
  invoicedTotalCents: bigint("invoiced_total_cents", { mode: "number" }).notNull().default(0),
  paidTotalCents: bigint("paid_total_cents", { mode: "number" }).notNull().default(0),
  outstandingCents: bigint("outstanding_cents", { mode: "number" }).notNull().default(0),
}, (table) => [
  uniqueIndex("purchase_orders_po_number_active_uidx").on(table.poNumber).where(sql`status <> 'cancelled'`),
  check("purchase_orders_currency_usd_chk", sql`${table.currency} = 'USD'`),
]);

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

  // Product reference. Nullable since migration 0564 because non-product
  // line types (discount / fee / tax / rebate / adjustment) carry no product.
  // Service-level validation (purchasing.service.validateCreateWithLinesInput)
  // still requires product_id on product lines and forbids it on non-product
  // lines, so the integrity constraint moves from the schema to the service:
  // wider data shape, narrower runtime rule.
  productId: integer("product_id").references(() => products.id),
  // Deprecated as purchasing identity; retained for compatibility. New receipt
  // planning should use expected_receive_variant_id.
  productVariantId: integer("product_variant_id").references(() => productVariants.id),
  // Variant/configuration expected at receiving time. The PO still buys
  // product SKU pieces through product_id + order_qty.
  expectedReceiveVariantId: integer("expected_receive_variant_id").references(() => productVariants.id),
  vendorProductId: integer("vendor_product_id").references(() => vendorProducts.id, { onDelete: "set null" }),
  sku: varchar("sku", { length: 100 }), // Cached at creation
  productName: text("product_name"), // Cached
  description: text("description"), // Special instructions, specs
  vendorSku: varchar("vendor_sku", { length: 100 }), // Vendor's SKU

  // Quantities
  unitOfMeasure: varchar("unit_of_measure", { length: 20 }), // legacy receive/display UOM
  unitsPerUom: integer("units_per_uom").default(1), // legacy receive units per UOM
  expectedReceiveUnitsPerVariant: integer("expected_receive_units_per_variant").default(1),
  orderQty: integer("order_qty").notNull(), // Ordered quantity in pieces/base units
  receivedQty: integer("received_qty").default(0), // Running tally from receipts
  damagedQty: integer("damaged_qty").default(0), // Running tally
  returnedQty: integer("returned_qty").default(0), // Running tally for RMA
  cancelledQty: integer("cancelled_qty").default(0),

  // Cost
  unitCostCents: bigint("unit_cost_cents", { mode: "number" }).notNull().default(0),
  // Per-unit cost in mills (1/10000 of a dollar). Authoritative when non-null.
  // unit_cost_cents is kept in sync (rounded, half-up) for back-compat.
  unitCostMills: bigint("unit_cost_mills", { mode: "number" }),
  discountPercent: numeric("discount_percent", { precision: 5, scale: 2 }).default("0"),
  discountCents: bigint("discount_cents", { mode: "number" }).default(0), // Computed
  taxRatePercent: numeric("tax_rate_percent", { precision: 5, scale: 2 }).default("0"),
  taxCents: bigint("tax_cents", { mode: "number" }).default(0),
  lineTotalCents: bigint("line_total_cents", { mode: "number" }), // (order_qty * unit_cost_cents) - discount + tax

  // Totals-based cost (Spec F Phase 1) — new source of truth.
  // Per-unit values (unit_cost_mills, unit_cost_cents) are now computed-derived.
  totalProductCostCents: bigint("total_product_cost_cents", { mode: "number" }).notNull().default(0),
  packagingCostCents: bigint("packaging_cost_cents", { mode: "number" }).notNull().default(0),

  // Vendor quote provenance. These fields preserve how the vendor priced the
  // line while unit_cost_mills and totals provide normalized system values.
  // Legacy rows are deliberately labeled, not reinterpreted or recalculated.
  pricingBasis: varchar("pricing_basis", { length: 30 }).notNull().default("legacy_unknown"),
  pricingSource: varchar("pricing_source", { length: 30 }).notNull().default("legacy"),
  purchaseUom: varchar("purchase_uom", { length: 50 }),
  purchaseUomQuantity: integer("purchase_uom_quantity"),
  piecesPerPurchaseUom: integer("pieces_per_purchase_uom"),
  quotedUnitCostMills: bigint("quoted_unit_cost_mills", { mode: "number" }),
  quotedTotalCents: bigint("quoted_total_cents", { mode: "number" }),
  // Signed so exact quote totals can retain a deterministic division/rounding
  // residual when normalized to per-piece mills.
  pricingRemainderMills: bigint("pricing_remainder_mills", { mode: "number" }).notNull().default(0),
  quoteReference: varchar("quote_reference", { length: 255 }),
  quotedAt: timestamp("quoted_at"),
  quoteValidUntil: date("quote_valid_until"),

  // Dates
  expectedDeliveryDate: timestamp("expected_delivery_date"), // Per-line override
  promisedDate: timestamp("promised_date"), // Vendor's per-line promise
  receivedDate: timestamp("received_date"), // When first receipt happened
  fullyReceivedDate: timestamp("fully_received_date"), // When received_qty >= order_qty
  lastReceivedAt: timestamp("last_received_at"), // Most recent receipt

  // Status
  status: varchar("status", { length: 20 }).notNull().default("open"), // open, partially_received, received, closed, cancelled
  closeShortReason: text("close_short_reason"), // Why closed before fully received

  // Meta
  weightGrams: integer("weight_grams"), // For freight estimation
  notes: text("notes"),

  // Line taxonomy (migration 0563) — enables discount/fee/tax/rebate/adjustment
  // lines alongside product lines. See PO_LINE_TYPES below for the full set.
  // 'product' is the default for back-compat; existing rows are implicitly
  // product. parent_line_id is an optional self-reference used by non-product
  // lines to target a specific product line (e.g. "10% off line 2"). Parent
  // must be a product line; no chains.
  lineType: varchar("line_type", { length: 20 }).notNull().default("product"),
  parentLineId: integer("parent_line_id"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("purchase_order_lines_po_id_line_id_uidx").on(table.purchaseOrderId, table.id),
  uniqueIndex("purchase_order_lines_po_id_line_number_active_uidx")
    .on(table.purchaseOrderId, table.lineNumber)
    .where(sql`${table.status} <> 'cancelled'`),
  check(
    "po_lines_pricing_basis_chk",
    sql`${table.pricingBasis} IN ('legacy_unknown', 'not_applicable', 'per_piece', 'per_purchase_uom', 'extended_total')`,
  ),
  check(
    "po_lines_pricing_source_chk",
    sql`${table.pricingSource} IN ('legacy', 'manual', 'vendor_catalog', 'recommendation')`,
  ),
  check(
    "po_lines_pricing_source_basis_consistency_chk",
    sql`(
      ${table.pricingBasis} = 'legacy_unknown'
      AND ${table.pricingSource} = 'legacy'
    ) OR (
      ${table.pricingBasis} = 'not_applicable'
      AND ${table.pricingSource} IN ('legacy', 'manual')
    ) OR (
      ${table.pricingBasis} IN ('per_piece', 'per_purchase_uom', 'extended_total')
      AND ${table.pricingSource} = 'manual'
    ) OR (
      ${table.pricingBasis} IN ('per_piece', 'per_purchase_uom')
      AND ${table.pricingSource} IN ('vendor_catalog', 'recommendation')
      AND ${table.vendorProductId} IS NOT NULL
      AND ${table.quotedAt} IS NOT NULL
    )`,
  ),
  check(
    "po_lines_quote_quantities_positive_chk",
    sql`(${table.purchaseUomQuantity} IS NULL OR ${table.purchaseUomQuantity} > 0)
      AND (${table.piecesPerPurchaseUom} IS NULL OR ${table.piecesPerPurchaseUom} > 0)`,
  ),
  check(
    "po_lines_quoted_amounts_nonnegative_chk",
    sql`(${table.quotedUnitCostMills} IS NULL OR ${table.quotedUnitCostMills} >= 0)
      AND (${table.quotedTotalCents} IS NULL OR ${table.quotedTotalCents} >= 0)`,
  ),
  check(
    "po_lines_quote_dates_consistency_chk",
    sql`${table.quotedAt} IS NULL
      OR ${table.quoteValidUntil} IS NULL
      OR ${table.quoteValidUntil} >= ${table.quotedAt}::date`,
  ),
  check(
    "po_lines_explicit_pricing_consistency_chk",
    sql`(
      ${table.pricingBasis} = 'legacy_unknown'
      AND ${table.lineType} = 'product'
      AND ${table.purchaseUom} IS NULL
      AND ${table.purchaseUomQuantity} IS NULL
      AND ${table.piecesPerPurchaseUom} IS NULL
      AND ${table.quotedUnitCostMills} IS NULL
      AND ${table.quotedTotalCents} IS NULL
      AND ${table.pricingRemainderMills} = 0
      AND ${table.quoteReference} IS NULL
      AND ${table.quotedAt} IS NULL
      AND ${table.quoteValidUntil} IS NULL
    ) OR (
      ${table.pricingBasis} = 'not_applicable'
      AND ${table.lineType} <> 'product'
      AND ${table.purchaseUom} IS NULL
      AND ${table.purchaseUomQuantity} IS NULL
      AND ${table.piecesPerPurchaseUom} IS NULL
      AND ${table.quotedUnitCostMills} IS NULL
      AND ${table.quotedTotalCents} IS NULL
      AND ${table.pricingRemainderMills} = 0
      AND ${table.quoteReference} IS NULL
      AND ${table.quotedAt} IS NULL
      AND ${table.quoteValidUntil} IS NULL
    ) OR (
      ${table.lineType} = 'product'
      AND ${table.orderQty} > 0
      AND ${table.unitCostMills} IS NOT NULL
      AND ${table.unitCostMills} >= 0
      AND ${table.unitCostCents} >= 0
      AND ${table.totalProductCostCents} >= 0
      AND ${table.packagingCostCents} >= 0
      AND ${table.discountCents} IS NOT NULL
      AND ${table.discountCents} >= 0
      AND ${table.taxCents} IS NOT NULL
      AND ${table.taxCents} >= 0
      AND ${table.lineTotalCents} IS NOT NULL
      AND (
        (
          ${table.pricingBasis} = 'per_piece'
          AND ${table.purchaseUom} IS NULL
          AND ${table.purchaseUomQuantity} IS NULL
          AND ${table.piecesPerPurchaseUom} IS NULL
          AND ${table.quotedUnitCostMills} IS NOT NULL
          AND ${table.quotedTotalCents} IS NULL
        ) OR (
          ${table.pricingBasis} = 'per_purchase_uom'
          AND ${table.purchaseUom} IS NOT NULL
          AND btrim(${table.purchaseUom}) <> ''
          AND ${table.purchaseUomQuantity} IS NOT NULL
          AND ${table.purchaseUomQuantity} > 0
          AND ${table.piecesPerPurchaseUom} IS NOT NULL
          AND ${table.piecesPerPurchaseUom} > 0
          AND ${table.quotedUnitCostMills} IS NOT NULL
          AND ${table.quotedTotalCents} IS NULL
          AND ${table.orderQty}::bigint =
            ${table.purchaseUomQuantity}::bigint * ${table.piecesPerPurchaseUom}::bigint
        ) OR (
          ${table.pricingBasis} = 'extended_total'
          AND ${table.purchaseUom} IS NULL
          AND ${table.purchaseUomQuantity} IS NULL
          AND ${table.piecesPerPurchaseUom} IS NULL
          AND ${table.quotedUnitCostMills} IS NULL
          AND ${table.quotedTotalCents} IS NOT NULL
        )
      )
      AND ${table.unitCostMills}::numeric = floor((
        CASE ${table.pricingBasis}
          WHEN 'per_piece' THEN ${table.quotedUnitCostMills}::numeric * ${table.orderQty}::numeric
          WHEN 'per_purchase_uom' THEN ${table.quotedUnitCostMills}::numeric * ${table.purchaseUomQuantity}::numeric
          WHEN 'extended_total' THEN ${table.quotedTotalCents}::numeric * 100
        END
      ) / NULLIF(${table.orderQty}, 0)::numeric + 0.5)
      AND (
        CASE ${table.pricingBasis}
          WHEN 'per_piece' THEN ${table.quotedUnitCostMills}::numeric * ${table.orderQty}::numeric
          WHEN 'per_purchase_uom' THEN ${table.quotedUnitCostMills}::numeric * ${table.purchaseUomQuantity}::numeric
          WHEN 'extended_total' THEN ${table.quotedTotalCents}::numeric * 100
        END
      ) = ${table.unitCostMills}::numeric * ${table.orderQty}::numeric
        + ${table.pricingRemainderMills}::numeric
      AND ${table.totalProductCostCents}::numeric = floor(((
        CASE ${table.pricingBasis}
          WHEN 'per_piece' THEN ${table.quotedUnitCostMills}::numeric * ${table.orderQty}::numeric
          WHEN 'per_purchase_uom' THEN ${table.quotedUnitCostMills}::numeric * ${table.purchaseUomQuantity}::numeric
          WHEN 'extended_total' THEN ${table.quotedTotalCents}::numeric * 100
        END
      ) + 50) / 100)
      AND ${table.unitCostCents}::numeric = floor((${table.unitCostMills}::numeric + 50) / 100)
      AND ${table.lineTotalCents}::numeric =
        ${table.totalProductCostCents}::numeric
        + ${table.packagingCostCents}::numeric
        - ${table.discountCents}::numeric
        + ${table.taxCents}::numeric
    )`,
  ),
]);

// ---------------------------------------------------------------------------
// PO line taxonomy (migration 0563)
// ---------------------------------------------------------------------------
// product     — ordered goods. requires product_id. cost_mills >= 0, qty > 0.
// discount    — flat/percent discount line. no variant. cost_mills <= 0, qty == 1.
// fee         — freight, tooling, surcharge. no variant. cost_mills >= 0, qty >= 1.
// tax         — itemized tax. no variant. cost_mills >= 0, qty == 1.
// rebate      — forward-looking rebate. no variant. cost_mills <= 0, qty == 1.
// adjustment  — catch-all. signed. qty == 1.
export const PO_LINE_TYPES = [
  "product",
  "discount",
  "fee",
  "tax",
  "rebate",
  "adjustment",
] as const;

export type PoLineType = (typeof PO_LINE_TYPES)[number];

export function isPoLineType(value: unknown): value is PoLineType {
  return typeof value === "string" && (PO_LINE_TYPES as readonly string[]).includes(value);
}

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

// ===== PO EMAIL OUTBOX (durable vendor delivery) =====

export const poEmailOutbox = procurementSchema.table("po_email_outbox", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrders.id, { onDelete: "restrict" }),
  idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  status: varchar("status", { length: 24 }).default("queued").notNull(),
  toEmail: varchar("to_email", { length: 320 }).notNull(),
  ccEmail: varchar("cc_email", { length: 320 }),
  subject: varchar("subject", { length: 500 }).notNull(),
  htmlBody: text("html_body").notNull(),
  textBody: text("text_body"),
  messageId: varchar("message_id", { length: 255 }).notNull(),
  attemptCount: integer("attempt_count").default(0).notNull(),
  maxAttempts: integer("max_attempts").default(10).notNull(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
  leaseToken: varchar("lease_token", { length: 64 }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  providerMessageId: varchar("provider_message_id", { length: 500 }),
  providerResponse: varchar("provider_response", { length: 1000 }),
  lastErrorCode: varchar("last_error_code", { length: 100 }),
  lastErrorMessage: varchar("last_error_message", { length: 1000 }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  replayOfId: integer("replay_of_id").references((): AnyPgColumn => poEmailOutbox.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("po_email_outbox_idempotency_idx").on(table.purchaseOrderId, table.idempotencyKey),
  uniqueIndex("po_email_outbox_message_id_idx").on(table.messageId),
  index("po_email_outbox_po_created_idx").on(table.purchaseOrderId, table.createdAt, table.id),
]);

export const purchaseRecommendationRuns = procurementSchema.table("purchase_recommendation_runs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  calculationVersion: varchar("calculation_version", { length: 80 }).notNull(),
  source: varchar("source", { length: 30 }).notNull().default("manual"),
  sourceRunKey: varchar("source_run_key", { length: 160 }),
  status: varchar("status", { length: 20 }).notNull().default("completed"),
  asOf: timestamp("as_of", { withTimezone: true }).notNull(),
  lookbackDays: integer("lookback_days").notNull(),
  policySnapshot: jsonb("policy_snapshot").notNull(),
  inputSummary: jsonb("input_summary").notNull().default({}),
  generatedBy: varchar("generated_by", { length: 255 }),
  generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("purchase_recommendation_runs_source_key_uidx")
    .on(table.source, table.sourceRunKey)
    .where(sql`${table.sourceRunKey} IS NOT NULL`),
  index("purchase_recommendation_runs_latest_idx").on(table.generatedAt, table.id),
  check("purchase_recommendation_runs_status_chk", sql`${table.status} IN ('completed', 'failed')`),
  check("purchase_recommendation_runs_source_chk", sql`${table.source} IN ('manual', 'auto_draft', 'api')`),
  check("purchase_recommendation_runs_lookback_chk", sql`${table.lookbackDays} > 0`),
]);

export const purchaseRecommendationLines = procurementSchema.table("purchase_recommendation_lines", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  runId: integer("run_id").notNull().references(() => purchaseRecommendationRuns.id, { onDelete: "restrict" }),
  recommendationKey: varchar("recommendation_key", { length: 160 }).notNull(),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "restrict" }),
  warehouseId: integer("warehouse_id").references(() => warehouses.id, { onDelete: "restrict" }),
  sku: varchar("sku", { length: 100 }).notNull(),
  productName: text("product_name").notNull(),
  requiredByDate: date("required_by_date"),
  recommendedPieces: integer("recommended_pieces").notNull(),
  baseUom: varchar("base_uom", { length: 30 }).notNull().default("piece"),
  preferredVendorId: integer("preferred_vendor_id").references(() => vendors.id, { onDelete: "restrict" }),
  preferredVendorProductId: integer("preferred_vendor_product_id").references(() => vendorProducts.id, { onDelete: "restrict" }),
  status: varchar("status", { length: 24 }).notNull().default("open"),
  evidenceSnapshot: jsonb("evidence_snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("purchase_recommendation_lines_run_key_uidx").on(table.runId, table.recommendationKey),
  index("purchase_recommendation_lines_run_status_idx").on(table.runId, table.status, table.id),
  index("purchase_recommendation_lines_product_idx").on(table.productId, table.productVariantId, table.warehouseId),
  check("purchase_recommendation_lines_qty_chk", sql`${table.recommendedPieces} > 0`),
  check("purchase_recommendation_lines_status_chk", sql`${table.status} IN ('open', 'cancelled')`),
]);

export const purchaseForecastObservationScopeEnum = ["product_all_warehouses"] as const;
export type PurchaseForecastObservationScope = typeof purchaseForecastObservationScopeEnum[number];

export const purchaseForecastObservations = procurementSchema.table("purchase_forecast_observations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  runId: integer("run_id").notNull().references(() => purchaseRecommendationRuns.id, { onDelete: "restrict" }),
  observationKey: varchar("observation_key", { length: 160 }).notNull(),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
  selectedReceiveVariantId: integer("selected_receive_variant_id").references(() => productVariants.id, { onDelete: "restrict" }),
  scope: varchar("scope", { length: 40 }).notNull().default("product_all_warehouses"),
  productSku: varchar("product_sku", { length: 100 }).notNull(),
  productName: text("product_name").notNull(),
  forecastMethod: varchar("forecast_method", { length: 40 }).notNull(),
  forecastVersion: integer("forecast_version").notNull(),
  forecastDailyPiecesMicros: bigint("forecast_daily_pieces_micros", { mode: "number" }).notNull(),
  baselineDailyPiecesMicros: bigint("baseline_daily_pieces_micros", { mode: "number" }).notNull(),
  forwardDemandPieces: integer("forward_demand_pieces").notNull().default(0),
  forwardDemandRawPieces: integer("forward_demand_raw_pieces").notNull().default(0),
  evidenceSnapshot: jsonb("evidence_snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("purchase_forecast_observations_run_product_scope_uidx")
    .on(table.runId, table.productId, table.scope),
  index("purchase_forecast_observations_product_run_idx").on(table.productId, table.runId),
  check("purchase_forecast_observations_scope_chk", sql`${table.scope} IN ('product_all_warehouses')`),
  check("purchase_forecast_observations_version_chk", sql`${table.forecastVersion} > 0`),
  check("purchase_forecast_observations_forecast_qty_chk", sql`${table.forecastDailyPiecesMicros} >= 0`),
  check("purchase_forecast_observations_baseline_qty_chk", sql`${table.baselineDailyPiecesMicros} >= 0`),
  check("purchase_forecast_observations_forward_qty_chk", sql`${table.forwardDemandPieces} >= 0 AND ${table.forwardDemandRawPieces} >= 0`),
  foreignKey({
    columns: [table.selectedReceiveVariantId, table.productId],
    foreignColumns: [productVariants.id, productVariants.productId],
    name: "purchase_forecast_observations_receive_variant_product_fk",
  }),
]);

export const purchaseForecastEvaluationHorizonDaysEnum = [7, 30, 90] as const;
export type PurchaseForecastEvaluationHorizonDays = typeof purchaseForecastEvaluationHorizonDaysEnum[number];

export const purchaseForecastEvaluations = procurementSchema.table("purchase_forecast_evaluations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  observationId: integer("observation_id").notNull().references(() => purchaseForecastObservations.id, { onDelete: "restrict" }),
  horizonDays: integer("horizon_days").notNull(),
  evaluationVersion: integer("evaluation_version").notNull(),
  demandQueryVersion: varchar("demand_query_version", { length: 80 }).notNull(),
  observedFrom: timestamp("observed_from", { withTimezone: true }).notNull(),
  observedThroughExclusive: timestamp("observed_through_exclusive", { withTimezone: true }).notNull(),
  actualDemandPieces: bigint("actual_demand_pieces", { mode: "number" }).notNull(),
  actualOrderCount: integer("actual_order_count").notNull(),
  actualActiveDays: integer("actual_active_days").notNull(),
  latestActualDemandAt: timestamp("latest_actual_demand_at", { withTimezone: true }),
  forecastDemandMicros: bigint("forecast_demand_micros", { mode: "number" }).notNull(),
  baselineDemandMicros: bigint("baseline_demand_micros", { mode: "number" }).notNull(),
  forecastAbsoluteErrorMicros: bigint("forecast_absolute_error_micros", { mode: "number" }).notNull(),
  baselineAbsoluteErrorMicros: bigint("baseline_absolute_error_micros", { mode: "number" }).notNull(),
  forecastBiasMicros: bigint("forecast_bias_micros", { mode: "number" }).notNull(),
  baselineBiasMicros: bigint("baseline_bias_micros", { mode: "number" }).notNull(),
  evidenceSnapshot: jsonb("evidence_snapshot").notNull(),
  evaluatedBy: varchar("evaluated_by", { length: 255 }),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("purchase_forecast_evaluations_observation_horizon_version_uidx")
    .on(table.observationId, table.horizonDays, table.evaluationVersion),
  index("purchase_forecast_evaluations_horizon_evaluated_idx")
    .on(table.horizonDays, table.evaluatedAt, table.id),
  check("purchase_forecast_evaluations_horizon_chk", sql`${table.horizonDays} IN (7, 30, 90)`),
  check("purchase_forecast_evaluations_version_chk", sql`${table.evaluationVersion} > 0`),
  check("purchase_forecast_evaluations_window_chk", sql`${table.observedThroughExclusive} > ${table.observedFrom}`),
  check("purchase_forecast_evaluations_actual_chk", sql`${table.actualDemandPieces} >= 0 AND ${table.actualOrderCount} >= 0 AND ${table.actualActiveDays} >= 0`),
  check("purchase_forecast_evaluations_prediction_chk", sql`${table.forecastDemandMicros} >= 0 AND ${table.baselineDemandMicros} >= 0`),
  check("purchase_forecast_evaluations_error_chk", sql`${table.forecastAbsoluteErrorMicros} >= 0 AND ${table.baselineAbsoluteErrorMicros} >= 0`),
]);

export const requestForQuoteStatusEnum = [
  "draft", "sent", "partially_quoted", "quoted", "declined", "cancelled", "expired",
] as const;
export type RequestForQuoteStatus = typeof requestForQuoteStatusEnum[number];

export const requestForQuotes = procurementSchema.table("request_for_quotes", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  rfqNumber: varchar("rfq_number", { length: 80 }).notNull().unique(),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id, { onDelete: "restrict" }),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  status: varchar("status", { length: 24 }).notNull().default("draft"),
  requestNote: text("request_note"),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  responseDueDate: date("response_due_date"),
  createdBy: varchar("created_by", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("request_for_quotes_vendor_idempotency_uidx").on(table.vendorId, table.idempotencyKey),
  index("request_for_quotes_vendor_status_idx").on(table.vendorId, table.status, table.createdAt),
  index("request_for_quotes_status_created_idx").on(table.status, table.createdAt),
  check("request_for_quotes_status_chk", sql`${table.status} IN ('draft', 'sent', 'partially_quoted', 'quoted', 'declined', 'cancelled', 'expired')`),
  check("request_for_quotes_currency_chk", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  check("request_for_quotes_request_hash_chk", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
]);

export const requestForQuoteLineStatusEnum = [
  "draft", "sent", "quoted", "declined", "cancelled", "accepted", "ordered",
] as const;
export type RequestForQuoteLineStatus = typeof requestForQuoteLineStatusEnum[number];

export const requestForQuoteLines = procurementSchema.table("request_for_quote_lines", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  rfqId: integer("rfq_id").notNull().references(() => requestForQuotes.id, { onDelete: "restrict" }),
  recommendationLineId: integer("recommendation_line_id").notNull().references(() => purchaseRecommendationLines.id, { onDelete: "restrict" }),
  vendorProductId: integer("vendor_product_id").notNull().references(() => vendorProducts.id, { onDelete: "restrict" }),
  requestedPieces: integer("requested_pieces").notNull(),
  purchaseUom: varchar("purchase_uom", { length: 50 }),
  piecesPerPurchaseUom: integer("pieces_per_purchase_uom"),
  requestedPurchaseUomQty: numeric("requested_purchase_uom_qty", { precision: 14, scale: 4 }),
  status: varchar("status", { length: 24 }).notNull().default("draft"),
  quantityOverrideReason: text("quantity_override_reason"),
  allocationOverrideReason: text("allocation_override_reason"),
  allocationOverrideApprovedBy: varchar("allocation_override_approved_by", { length: 255 }),
  allocationOverrideApprovedAt: timestamp("allocation_override_approved_at", { withTimezone: true }),
  allocationOverrideBaselinePieces: integer("allocation_override_baseline_pieces"),
  allocationOverrideExcessPieces: integer("allocation_override_excess_pieces"),
  quotedPieces: integer("quoted_pieces"),
  quotedUnitCostMills: bigint("quoted_unit_cost_mills", { mode: "number" }),
  quoteReference: varchar("quote_reference", { length: 255 }),
  quoteValidUntil: date("quote_valid_until"),
  quotedAt: timestamp("quoted_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  orderedAt: timestamp("ordered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("request_for_quote_lines_rfq_recommendation_uidx").on(table.rfqId, table.recommendationLineId),
  index("request_for_quote_lines_recommendation_idx").on(table.recommendationLineId, table.status),
  index("request_for_quote_lines_rfq_idx").on(table.rfqId, table.id),
  check("request_for_quote_lines_requested_qty_chk", sql`${table.requestedPieces} > 0`),
  check("request_for_quote_lines_pack_chk", sql`${table.piecesPerPurchaseUom} IS NULL OR ${table.piecesPerPurchaseUom} > 0`),
  check("request_for_quote_lines_status_chk", sql`${table.status} IN ('draft', 'sent', 'quoted', 'declined', 'cancelled', 'accepted', 'ordered')`),
  check("request_for_quote_lines_override_evidence_chk", sql`
    (
      ${table.allocationOverrideReason} IS NULL
      AND ${table.allocationOverrideApprovedBy} IS NULL
      AND ${table.allocationOverrideApprovedAt} IS NULL
      AND ${table.allocationOverrideBaselinePieces} IS NULL
      AND ${table.allocationOverrideExcessPieces} IS NULL
    )
    OR (
      NULLIF(BTRIM(${table.quantityOverrideReason}), '') IS NOT NULL
      AND LENGTH(BTRIM(${table.quantityOverrideReason})) >= 3
      AND NULLIF(BTRIM(${table.allocationOverrideReason}), '') IS NOT NULL
      AND LENGTH(BTRIM(${table.allocationOverrideReason})) >= 3
      AND ${table.allocationOverrideReason} = ${table.quantityOverrideReason}
      AND NULLIF(BTRIM(${table.allocationOverrideApprovedBy}), '') IS NOT NULL
      AND ${table.allocationOverrideApprovedAt} IS NOT NULL
      AND ${table.allocationOverrideBaselinePieces} >= 0
      AND ${table.allocationOverrideExcessPieces} > 0
    )
  `),
]);

export const insertPurchaseRecommendationRunSchema = createInsertSchema(purchaseRecommendationRuns).omit({ id: true, generatedAt: true });
export const insertPurchaseRecommendationLineSchema = createInsertSchema(purchaseRecommendationLines).omit({ id: true, createdAt: true });
export const insertPurchaseForecastObservationSchema = createInsertSchema(purchaseForecastObservations).omit({ id: true, createdAt: true });
export const insertPurchaseForecastEvaluationSchema = createInsertSchema(purchaseForecastEvaluations).omit({ id: true, evaluatedAt: true });
export const insertRequestForQuoteSchema = createInsertSchema(requestForQuotes).omit({ id: true, createdAt: true, updatedAt: true });
export const insertRequestForQuoteLineSchema = createInsertSchema(requestForQuoteLines).omit({ id: true, createdAt: true, updatedAt: true });

export type PurchaseRecommendationRun = typeof purchaseRecommendationRuns.$inferSelect;
export type PurchaseRecommendationLine = typeof purchaseRecommendationLines.$inferSelect;
export type PurchaseForecastObservation = typeof purchaseForecastObservations.$inferSelect;
export type PurchaseForecastEvaluation = typeof purchaseForecastEvaluations.$inferSelect;
export type RequestForQuote = typeof requestForQuotes.$inferSelect;
export type RequestForQuoteLine = typeof requestForQuoteLines.$inferSelect;

export type PoEmailOutbox = typeof poEmailOutbox.$inferSelect;

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
  poUnitCostCents: bigint("po_unit_cost_cents", { mode: "number" }), // Cost on PO (cents; rounded from po_unit_cost_mills)
  poUnitCostMills: bigint("po_unit_cost_mills", { mode: "number" }), // Cost on PO in mills (4-decimal). Authoritative when non-null.
  actualUnitCostCents: bigint("actual_unit_cost_cents", { mode: "number" }), // Actual receipt cost (cents; rounded from actual_unit_cost_mills)
  actualUnitCostMills: bigint("actual_unit_cost_mills", { mode: "number" }), // Actual receipt cost in mills. Authoritative when non-null.
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
  shipmentNumber: varchar("shipment_number", { length: 30 }).notNull(), // partial unique index: active records only (see migration 067)
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
}, (table) => [
  uniqueIndex("inbound_shipments_shipment_number_active_uidx").on(table.shipmentNumber).where(sql`status <> 'cancelled'`),
]);

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

  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
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
}, (table) => [
  uniqueIndex("vendor_invoices_vendor_invoice_idx").on(table.vendorId, table.invoiceNumber),
  check("vendor_invoices_currency_usd_chk", sql`${table.currency} = 'USD'`),
]);

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
  performedByName: text("performed_by_name"),
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
}, (table) => [
  uniqueIndex("inbound_freight_allocations_cost_line_uidx")
    .on(table.shipmentCostId, table.inboundShipmentLineId),
]);

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
}, (table) => [
  uniqueIndex("landed_cost_snapshots_shipment_line_uidx")
    .on(table.inboundShipmentLineId)
    .where(sql`${table.inboundShipmentLineId} IS NOT NULL`),
]);

export const insertLandedCostSnapshotSchema = createInsertSchema(landedCostSnapshots).omit({
  id: true,
  createdAt: true,
});

export type InsertLandedCostSnapshot = z.infer<typeof insertLandedCostSnapshotSchema>;
export type LandedCostSnapshot = typeof landedCostSnapshots.$inferSelect;

export const landedCostAdjustments = procurementSchema.table("landed_cost_adjustments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  inboundShipmentLineId: integer("inbound_shipment_line_id").notNull().references(() => inboundShipmentLines.id, { onDelete: "cascade" }),
  purchaseOrderLineId: integer("purchase_order_line_id").notNull().references(() => purchaseOrderLines.id),
  adjustmentAmountCents: bigint("adjustment_amount_cents", { mode: "number" }).notNull(),
  reason: text("reason").notNull(),
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertLandedCostAdjustmentSchema = createInsertSchema(landedCostAdjustments).omit({
  id: true,
  createdAt: true,
});

export type InsertLandedCostAdjustment = z.infer<typeof insertLandedCostAdjustmentSchema>;
export type LandedCostAdjustment = typeof landedCostAdjustments.$inferSelect;

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
  freightCostId: integer("freight_cost_id").references(() => inboundFreightCosts.id, { onDelete: "set null" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "set null" }),
  lineNumber: integer("line_number").notNull(),
  sku: varchar("sku", { length: 100 }),
  productName: text("product_name"),
  description: text("description"),
  qtyInvoiced: integer("qty_invoiced").notNull(),
  qtyOrdered: integer("qty_ordered"),
  qtyReceived: integer("qty_received"),
  unitCostCents: bigint("unit_cost_cents", { mode: "number" }).notNull(),
  // Per-unit invoiced cost in mills (4-decimal). Authoritative when non-null.
  unitCostMills: bigint("unit_cost_mills", { mode: "number" }),
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
  paymentNumber: varchar("payment_number", { length: 30 }).notNull(), // Auto: PAY-YYYYMMDD-### (partial unique index in table constraints)

  vendorId: integer("vendor_id").notNull().references(() => vendors.id),

  paymentDate: timestamp("payment_date").notNull(),
  paymentMethod: varchar("payment_method", { length: 20 }).notNull(), // ach, check, wire, credit_card, other
  referenceNumber: varchar("reference_number", { length: 100 }), // ACH trace, wire ref, etc.
  checkNumber: varchar("check_number", { length: 50 }),
  bankAccountLabel: varchar("bank_account_label", { length: 100 }), // e.g. "Chase Operating"

  totalAmountCents: bigint("total_amount_cents", { mode: "number" }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),

  status: varchar("status", { length: 20 }).notNull().default("completed"),

  voidedAt: timestamp("voided_at"),
  voidedBy: varchar("voided_by").references(() => users.id, { onDelete: "set null" }),
  voidReason: text("void_reason"),

  notes: text("notes"),

  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  updatedBy: varchar("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("ap_payments_payment_number_active_uidx").on(table.paymentNumber).where(sql`voided_at IS NULL`),
  check("ap_payments_currency_usd_chk", sql`${table.currency} = 'USD'`),
]);

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
  status: varchar("status", { length: 20 }).notNull().default("running"), // 'running' | 'success' | 'error' | 'interrupted'
  heartbeatAt: timestamp("heartbeat_at").defaultNow().notNull(),
  leaseExpiresAt: timestamp("lease_expires_at"),
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
}, (table) => [
  check(
    "auto_draft_runs_status_chk",
    sql`${table.status} IN ('running', 'success', 'error', 'interrupted')`,
  ),
  check(
    "auto_draft_runs_lifecycle_chk",
    sql`(
      ${table.status} = 'running'
      AND ${table.finishedAt} IS NULL
      AND ${table.leaseExpiresAt} IS NOT NULL
    ) OR (
      ${table.status} <> 'running'
      AND ${table.finishedAt} IS NOT NULL
      AND ${table.leaseExpiresAt} IS NULL
    )`,
  ),
  uniqueIndex("auto_draft_runs_single_running_uidx")
    .on(table.status)
    .where(sql`${table.status} = 'running'`),
]);

export const insertAutoDraftRunSchema = createInsertSchema(autoDraftRuns).omit({
  id: true,
  runAt: true,
});

export type InsertAutoDraftRun = z.infer<typeof insertAutoDraftRunSchema>;
export type AutoDraftRun = typeof autoDraftRuns.$inferSelect;


// ============================================================================
// 24. PURCHASING RECOMMENDATION DECISIONS
// ============================================================================

export const purchasingRecommendationDecisions = procurementSchema.table("purchasing_recommendation_decisions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  recommendationId: varchar("recommendation_id", { length: 160 }).notNull(),
  kind: varchar("kind", { length: 40 }).notNull(),
  decision: varchar("decision", { length: 40 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  decisionReason: varchar("decision_reason", { length: 100 }),
  note: text("note"),
  source: varchar("source", { length: 40 }).notNull().default("operator"),
  autoDraftRunId: integer("auto_draft_run_id").references(() => autoDraftRuns.id, { onDelete: "set null" }),
  productId: integer("product_id").references(() => products.id, { onDelete: "set null" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "set null" }),
  vendorId: integer("vendor_id").references(() => vendors.id, { onDelete: "set null" }),
  sku: varchar("sku", { length: 100 }),
  productName: text("product_name"),
  candidateScore: integer("candidate_score"),
  candidateBand: varchar("candidate_band", { length: 40 }),
  recommendationSnapshot: jsonb("recommendation_snapshot").notNull().default(sql`'{}'::jsonb`),
  decidedBy: varchar("decided_by", { length: 255 }),
  decidedAt: timestamp("decided_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  check(
    "purch_rec_decisions_auto_draft_run_chk",
    sql`${table.source} <> 'auto_draft' OR ${table.autoDraftRunId} IS NOT NULL`,
  ),
  index("purch_rec_decisions_rec_kind_decided_idx").on(table.recommendationId, table.kind, table.decidedAt),
  index("purch_rec_decisions_decision_decided_idx").on(table.decision, table.decidedAt),
  index("purch_rec_decisions_sku_idx").on(table.sku),
  uniqueIndex("purch_rec_decisions_id_rec_kind_uidx").on(table.id, table.recommendationId, table.kind),
  uniqueIndex("purch_rec_decisions_auto_draft_run_rec_kind_decision_uidx")
    .on(table.autoDraftRunId, table.recommendationId, table.kind, table.decision)
    .where(sql`${table.source} = 'auto_draft' AND ${table.status} = 'active' AND ${table.autoDraftRunId} IS NOT NULL`),
]);

export const insertPurchasingRecommendationDecisionSchema = createInsertSchema(purchasingRecommendationDecisions).omit({
  id: true,
  decidedAt: true,
  createdAt: true,
});

export type InsertPurchasingRecommendationDecision = z.infer<typeof insertPurchasingRecommendationDecisionSchema>;
export type PurchasingRecommendationDecision = typeof purchasingRecommendationDecisions.$inferSelect;

// ============================================================================
// 25. PURCHASING RECOMMENDATION PO HANDOFFS
// ============================================================================

export const purchasingRecommendationPoHandoffs = procurementSchema.table("purchasing_recommendation_po_handoffs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  acceptedDecisionId: integer("accepted_decision_id").notNull(),
  handoffDecisionId: integer("handoff_decision_id").notNull(),
  purchaseOrderId: integer("purchase_order_id").notNull(),
  purchaseOrderLineId: integer("purchase_order_line_id").notNull(),
  recommendationId: varchar("recommendation_id", { length: 160 }).notNull(),
  kind: varchar("kind", { length: 40 }).notNull(),
  createdBy: varchar("created_by", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  check(
    "purchasing_recommendation_po_handoffs_distinct_decisions_chk",
    sql`${table.acceptedDecisionId} <> ${table.handoffDecisionId}`,
  ),
  foreignKey({
    name: "purch_rec_po_handoff_accepted_decision_fk",
    columns: [table.acceptedDecisionId, table.recommendationId, table.kind],
    foreignColumns: [
      purchasingRecommendationDecisions.id,
      purchasingRecommendationDecisions.recommendationId,
      purchasingRecommendationDecisions.kind,
    ],
  }).onDelete("restrict"),
  foreignKey({
    name: "purch_rec_po_handoff_decision_fk",
    columns: [table.handoffDecisionId, table.recommendationId, table.kind],
    foreignColumns: [
      purchasingRecommendationDecisions.id,
      purchasingRecommendationDecisions.recommendationId,
      purchasingRecommendationDecisions.kind,
    ],
  }).onDelete("restrict"),
  foreignKey({
    name: "purch_rec_po_handoff_po_line_fk",
    columns: [table.purchaseOrderId, table.purchaseOrderLineId],
    foreignColumns: [purchaseOrderLines.purchaseOrderId, purchaseOrderLines.id],
  }).onDelete("restrict"),
  uniqueIndex("purch_rec_po_handoff_accepted_decision_uidx").on(table.acceptedDecisionId),
  uniqueIndex("purch_rec_po_handoff_decision_uidx").on(table.handoffDecisionId),
  uniqueIndex("purch_rec_po_handoff_po_line_uidx").on(table.purchaseOrderLineId),
  index("purch_rec_po_handoff_po_idx").on(table.purchaseOrderId),
  index("purch_rec_po_handoff_rec_kind_idx").on(table.recommendationId, table.kind),
]);

export const insertPurchasingRecommendationPoHandoffSchema = createInsertSchema(
  purchasingRecommendationPoHandoffs,
).omit({
  id: true,
  createdAt: true,
});

export type InsertPurchasingRecommendationPoHandoff = z.infer<
  typeof insertPurchasingRecommendationPoHandoffSchema
>;
export type PurchasingRecommendationPoHandoff = typeof purchasingRecommendationPoHandoffs.$inferSelect;

// ============================================================================
// 26. PO EVENTS - append-only lifecycle audit stream (Spec A)
// ============================================================================
//
// Separate from po_status_history so non-status events (edits, sends,
// duplicates) have a home without polluting the status machine table.
// Every row is an immutable audit record: who did what to which PO when.
//
// event_type values emitted by the PO module today include:
//   'created', 'submitted', 'approved', 'returned_to_draft',
//   'sent_to_vendor', 'vendor_acknowledged', 'marked_shipped',
//   'marked_in_transit', 'marked_arrived', 'receiving_started',
//   'received', 'closed', 'closed_short', 'cancelled',
//   'delivery_schedule_updated',
//   'edited', 'duplicated_from'
// Other modules (receiving, AP) will add more types over time.
//
// actor_type: 'user' | 'agent' | 'system'.
// actor_id: users.id for 'user'; free-form string for agents/systems
//           (e.g. 'system:auto', 'agent:auto-draft-job').

export const poEvents = procurementSchema.table("po_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
  poId: integer("po_id").notNull().references(() => purchaseOrders.id, { onDelete: "cascade" }),
  eventType: varchar("event_type", { length: 40 }).notNull(),
  actorType: varchar("actor_type", { length: 20 }).notNull(), // 'user' | 'agent' | 'system'
  actorId: varchar("actor_id", { length: 100 }),
  payloadJson: jsonb("payload_json"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPoEventSchema = createInsertSchema(poEvents).omit({
  id: true,
  createdAt: true,
});

export type InsertPoEvent = z.infer<typeof insertPoEventSchema>;
export type PoEvent = typeof poEvents.$inferSelect;

// ============================================================================
// 25. PO EXCEPTIONS — layered exception/issue tracking (migration 0566)
// ============================================================================
//
// Each row represents a single exception event on a PO (physical or financial).
// Rows are NEVER deleted; resolved exceptions stay forever for audit.
// Exception detection is event-driven (no cron in Phase 1).
//
// Idempotency: payload_hash (SHA-256 of po_id + kind + canonical payload JSON)
// prevents duplicate rows when detection hooks fire multiple times for the
// same underlying issue.

// ── Constants (Rule #11 — no magic strings) ──────────────────────────────────

export const EXCEPTION_KINDS = [
  // Physical exceptions
  'qty_short',
  'qty_over',
  'damaged_on_arrival',
  'wrong_product_received',
  'slow_ack',
  'slow_ship',
  'customs_hold',
  'lost_shipment',
  // Financial exceptions
  'match_mismatch',
  'invoice_disputed',
  'credit_memo_pending',
  'payment_failed',
  'overpaid',
  'past_due',
  'vendor_reissued_invoice',
  'receipt_reconciliation_failed',
] as const;
export type ExceptionKind = typeof EXCEPTION_KINDS[number];
export const RECEIPT_RECONCILIATION_FAILED_KIND: ExceptionKind = 'receipt_reconciliation_failed';

export const EXCEPTION_SEVERITIES = ['info', 'warn', 'error'] as const;
export type ExceptionSeverity = typeof EXCEPTION_SEVERITIES[number];

export const EXCEPTION_STATUSES = ['open', 'acknowledged', 'resolved', 'dismissed'] as const;
export type ExceptionStatus = typeof EXCEPTION_STATUSES[number];

// ── Table definition ─────────────────────────────────────────────────────────

export const poExceptions = procurementSchema.table('po_exceptions', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  poId: integer('po_id').notNull().references(() => purchaseOrders.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 40 }).notNull(),
  severity: varchar('severity', { length: 10 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('open'),
  payload: jsonb('payload').notNull().default({}),
  payloadHash: varchar('payload_hash', { length: 64 }).notNull(),
  title: varchar('title', { length: 120 }).notNull(),
  message: text('message'),
  // audit
  detectedAt: timestamp('detected_at', { withTimezone: true }).defaultNow().notNull(),
  detectedBy: varchar('detected_by', { length: 50 }),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  acknowledgedBy: varchar('acknowledged_by', { length: 50 }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: varchar('resolved_by', { length: 50 }),
  resolutionNote: text('resolution_note'),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
  dismissedBy: varchar('dismissed_by', { length: 50 }),
  dismissNote: text('dismiss_note'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const insertPoExceptionSchema = createInsertSchema(poExceptions).omit({
  id: true,
  detectedAt: true,
  updatedAt: true,
});

export type InsertPoException = z.infer<typeof insertPoExceptionSchema>;
export type PoException = typeof poExceptions.$inferSelect;

// ============================================================================
// FORWARD DEMAND EVENTS (Phase 7A)
// ============================================================================

export const demandEventTypeEnum = [
  "drop", "preorder", "promotion", "wholesale", "seasonal", "manual_forecast",
] as const;
export type DemandEventType = typeof demandEventTypeEnum[number];

export const demandEventStatusEnum = ["planned", "active", "completed", "cancelled"] as const;
export type DemandEventStatus = typeof demandEventStatusEnum[number];

export const demandEventConfidenceEnum = ["high", "medium", "low"] as const;
export type DemandEventConfidence = typeof demandEventConfidenceEnum[number];

export const demandEvents = procurementSchema.table("demand_events", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  name: varchar("name", { length: 255 }).notNull(),
  eventType: varchar("event_type", { length: 50 }).notNull().default("manual_forecast"),
  startDate: date("start_date").notNull(),
  endDate: date("end_date"),
  status: varchar("status", { length: 20 }).notNull().default("planned"),
  notes: text("notes"),
  createdBy: varchar("created_by", { length: 100 }).references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const demandEventLines = procurementSchema.table("demand_event_lines", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  demandEventId: integer("demand_event_id").notNull().references(() => demandEvents.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "restrict" }),
  expectedPieces: integer("expected_pieces").notNull(),
  confidence: varchar("confidence", { length: 10 }).notNull().default("medium"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertDemandEventSchema = createInsertSchema(demandEvents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDemandEvent = z.infer<typeof insertDemandEventSchema>;
export type DemandEvent = typeof demandEvents.$inferSelect;

export const insertDemandEventLineSchema = createInsertSchema(demandEventLines).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDemandEventLine = z.infer<typeof insertDemandEventLineSchema>;
export type DemandEventLine = typeof demandEventLines.$inferSelect;

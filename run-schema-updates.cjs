const fs = require('fs');
let content = fs.readFileSync('shared/schema/orders.schema.ts', 'utf8');

const wmsOrderCols = `  sourceTableId: varchar("source_table_id", { length: 100 }),
  shopifyOrderId: varchar("shopify_order_id", { length: 50 }),
  financialStatus: varchar("financial_status", { length: 30 }),
  shopifyFulfillmentStatus: varchar("shopify_fulfillment_status", { length: 30 }),
  cancelledAt: timestamp("cancelled_at"),
  notes: text("notes"),
  shortReason: text("short_reason"),
  metadata: jsonb("metadata"),
  legacyOrderId: varchar("legacy_order_id", { length: 100 }),
  shopifyCreatedAt: timestamp("shopify_created_at"),
  slaDueAt: timestamp("sla_due_at"),
  slaStatus: varchar("sla_status", { length: 20 }),
  exceptionAt: timestamp("exception_at"),
  exceptionResolution: varchar("exception_resolution", { length: 20 }),
  exceptionResolvedAt: timestamp("exception_resolved_at"),
  exceptionResolvedBy: varchar("exception_resolved_by", { length: 100 }),
  exceptionNotes: text("exception_notes"),`;

// Insert into wmsOrders
let wmsOrderStart = content.indexOf('export const wmsOrders =');
let wmsOrderEnd = content.indexOf('});', wmsOrderStart);
let beforeWmsOrder = content.substring(0, wmsOrderEnd);
let afterWmsOrder = content.substring(wmsOrderEnd);

// Only insert if not already there
if (!content.includes('shopifyOrderId: varchar("shopify_order_id')) {
    content = beforeWmsOrder + wmsOrderCols + '\n' + afterWmsOrder;
}

// Ensure jsonb is imported
let importMatch = content.match(/import \{([^}]+)\} from "drizzle-orm\/pg-core"/);
if (importMatch && !importMatch[1].includes('jsonb')) {
    content = content.replace(importMatch[0], importMatch[0].replace('}', ', jsonb }'));
}

// Rename wmsOrderId to orderId in wmsOrderItems
let wmsItemStart = content.indexOf('export const wmsOrderItems =');
let wmsItemBlock = content.substring(wmsItemStart, content.indexOf('});', wmsItemStart));
if (wmsItemBlock.includes('wmsOrderId:')) {
    content = content.replace(
        'wmsOrderId: integer("wms_order_id").notNull().references(() => wmsOrders.id, { onDelete: "cascade" }),',
        'orderId: integer("order_id").notNull().references(() => wmsOrders.id, { onDelete: "cascade" }),'
    );
}

const wmsItemCols = `  shopifyLineItemId: varchar("shopify_line_item_id", { length: 50 }),
  sourceItemId: varchar("source_item_id", { length: 100 }),`;

let wmsItemEnd = content.indexOf('});', wmsItemStart);
let beforeWmsItem = content.substring(0, wmsItemEnd);
let afterWmsItem = content.substring(wmsItemEnd);

if (!content.includes('shopifyLineItemId: varchar("shopify_line_item_id')) {
    content = beforeWmsItem + wmsItemCols + '\n' + afterWmsItem;
}

fs.writeFileSync('shared/schema/orders.schema.ts', content, 'utf8');

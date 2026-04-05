const fs = require('fs');
let c = fs.readFileSync('shared/schema/orders.schema.ts', 'utf8');

if (!c.includes('export const wmsSchema = pgSchema("wms");')) {
  console.log("wmsSchema not found");
  process.exit(1);
}

// 1. Move wmsSchema declaration to the top
c = c.replace('export const wmsSchema = pgSchema("wms");\n', '');
c = c.replace('export const orders = pgTable("orders", {', 'export const wmsSchema = pgSchema("wms");\n\nexport const orders = wmsSchema.table("orders", {');
c = c.replace('export const orderItems = pgTable("order_items", {', 'export const orderItems = wmsSchema.table("order_items", {');

// 2. Also rename picking logs table so we are fully off public if anything writes to pickingLogs
c = c.replace('export const pickingLogs = pgTable("picking_logs", {', 'export const pickingLogs = wmsSchema.table("picking_logs", {');

fs.writeFileSync('shared/schema/orders.schema.ts', c, 'utf8');
console.log("Patched successfully!");

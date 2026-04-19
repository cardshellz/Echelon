import fs from 'fs';
import path from 'path';

const tables = [
  "admin_sessions",
  "blockchain_config",
  "channel_pricing_rules",
  "channel_product_allocation",
  "channel_product_lines",
  "channel_sync_log",
  "combined_order_groups",
  "cost_adjustment_log",
  "discounts",
  "dropship_vendor_products",
  "dropship_vendors",
  "dropship_wallet_ledger",
  "ebay_category_aspects",
  "ebay_category_mappings",
  "ebay_listing_rules",
  "ebay_product_aspect_overrides",
  "ebay_type_aspect_defaults",
  "marketing_signup_config",
  "oms_order_events",
  "oms_order_lines",
  "oms_orders",
  "order_item_plan_savings_snapshots",
  "order_line_costs",
  "pricing_rules",
  "product_line_products",
  "product_lines",
  "product_types",
  "sc_admin_users",
  "sc_sessions",
  "session",
  "shopify_collections",
  "shopify_order_items",
  "shopify_orders",
  "shopify_products",
  "shopify_variants",
  "sync_log",
  "sync_settings"
];

const schemaDir = path.join(process.cwd(), 'shared', 'schema');
const files = fs.readdirSync(schemaDir).filter(f => f.endsWith('.ts'));

let results = "";

for (const table of tables) {
  let foundInFile = null;
  let schemaMatch = null;
  
  for (const file of files) {
    const content = fs.readFileSync(path.join(schemaDir, file), 'utf8');
    // Look for pgTable("table_name" or pgSchema("xxx").table("table_name"
    if (content.includes(`"${table}"`) || content.includes(`'${table}'`)) {
      foundInFile = file;
      
      // Try to find if it's bound to a schema
      const lines = content.split('\n');
      for (const line of lines) {
        if (line.includes(`"${table}"`) && line.includes('.table(')) {
          // It's using a schema object e.g. wmsSchema.table("orders"
          const schemaObj = line.split('.table(')[0].trim().split(' ').pop();
          // Find what that schemaObj maps to
          for (const l2 of lines) {
            if (l2.includes(schemaObj) && l2.includes('pgSchema(')) {
              schemaMatch = l2.match(/pgSchema\(['"](.+)['"]\)/)[1];
            }
          }
        }
      }
      break;
    }
  }
  
  if (foundInFile) {
    if (schemaMatch) {
      results += `| \`public.${table}\` | \`${schemaMatch}.${table}\` | Mapped in \`${foundInFile}\` | ACTION: **Migrate** |\n`;
    } else {
      results += `| \`public.${table}\` | \`public.${table}\` | Defined in \`${foundInFile}\` | ACTION: **Keep in Public** |\n`;
    }
  } else {
    results += `| \`public.${table}\` | - | Not found in \`shared/schema/*\` | ACTION: **Mark for Deletion** |\n`;
  }
}

const header = `| Current Public Table | Target Schema Namespace | Codebase Definition File | Recommended Action |\n| -------------------- | ----------------------- | ------------------------ | ------------------ |\n`;
fs.writeFileSync('C:/Users/owner/.gemini/antigravity/brain/625b473d-3962-467f-91f8-fa8f7e3e751b/public_schema_audit.md', header + results);

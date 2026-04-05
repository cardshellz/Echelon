import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from "dotenv";
dotenv.config();
process.env.PGSSLMODE = "require";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function run() {
  const { db } = await import("../server/db");
  const { sql } = await import("drizzle-orm");

  const schemaDir = path.join(import.meta.dirname, '../shared/schema');
  const files = fs.readdirSync(schemaDir).filter(f => f.endsWith('.schema.ts'));

  const tableMap: Record<string, string> = {};

  for (const file of files) {
    const content = fs.readFileSync(path.join(schemaDir, file), 'utf-8');
    const pgTableRegex = /pgTable\s*\(\s*["']([^"']+)["']/g;
    let match;
    while ((match = pgTableRegex.exec(content)) !== null) {
      const tableName = match[1];
      const logicalSchema = file.replace('.schema.ts', '');
      tableMap[tableName] = logicalSchema;
    }
  }

  // Also include the ones manually declared
  tableMap['products'] = 'catalog (Completed)';
  tableMap['product_variants'] = 'catalog (Completed)';
  tableMap['product_assets'] = 'catalog (Completed)';
  tableMap['order_items'] = 'wms (Completed)';
  tableMap['orders'] = 'wms (Completed)';
  tableMap['oms_orders'] = 'oms (Completed)';
  tableMap['oms_order_lines'] = 'oms (Completed)';
  tableMap['oms_order_events'] = 'oms (Completed)';

  const res = await db.execute(sql`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public'
    ORDER BY table_name;
  `);

  let md = "# 100% Exhaustive Echelon `public` Schema Map\n\n";
  md += "| Legacy Table (`public.*`) | Target Domain | Status / Notes |\n";
  md += "|---------------------------|---------------|----------------|\n";

  for (const row of res.rows) {
    const table = row.table_name as string;
    const target = tableMap[table];
    let note = "Pending Migration";
    let domain = target || "UNKNOWN / ORPHANED";

    // Known legacy drop candidates
    if (["orders", "order_items", "oms_orders", "oms_order_lines", "oms_order_events", "products", "product_variants"].includes(table)) {
      note = "ALREADY DELETED / REDUNDANT";
      domain = "NONE";
    }

    // Auto-migrate tables like drizzle specific stuff
    if (table.includes("drizzle") || table.includes("migration")) {
      note = "System Admin / Skip";
      domain = "SYSTEM";
    }

    md += `| \`${table}\` | **${domain.toUpperCase()}** | ${note} |\n`;
  }

  fs.writeFileSync(path.join(import.meta.dirname, '../artifact-exhaustive-map.md'), md);
  console.log("Wrote mapping to artifact-exhaustive-map.md");
  process.exit();
}
run();

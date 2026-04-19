import { db } from "./server/db";
import { sql } from "drizzle-orm";
async function run() {
  const query = sql`SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE column_name IN ('standard_cost_cents', 'last_cost_cents', 'avg_cost_cents', 'unit_cost_cents', 'discount_cents', 'tax_cents', 'line_total_cents', 'po_unit_cost_cents', 'actual_unit_cost_cents', 'variance_cents', 'landed_unit_cost_cents')`;
  const result = await db.execute(query);
  console.log(JSON.stringify(result.rows, null, 2));
  process.exit();
}
run();
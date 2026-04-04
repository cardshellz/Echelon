import * as dotenv from "dotenv";
dotenv.config();
process.env.PGSSLMODE = "require";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { db } from "../server/db";
import { sql } from "drizzle-orm";

async function mapSchemas() {
  const { db } = await import("../server/db");
  const { sql } = await import("drizzle-orm");
  try {
    const res = await db.execute(sql`
      SELECT table_schema, table_name 
      FROM information_schema.tables 
      WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
      ORDER BY table_schema, table_name;
    `);
    
    const tablesBySchema: Record<string, string[]> = {};
    for (const row of res.rows) {
      if (!tablesBySchema[row.table_schema]) tablesBySchema[row.table_schema] = [];
      tablesBySchema[row.table_schema].push(row.table_name);
    }
    
    console.log(JSON.stringify(tablesBySchema, null, 2));
  } catch (error) {
    console.error(error);
  }
  process.exit();
}

mapSchemas();

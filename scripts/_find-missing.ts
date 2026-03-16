import { Pool } from "pg";
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  
  // Get existing tables
  const res = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  const existing = new Set(res.rows.map((r: any) => r.tablename));
  
  // Tables referenced in 0001 migration
  const fs = await import("fs");
  const sql = fs.readFileSync("migrations/0001_past_molly_hayes.sql", "utf-8");
  const createMatches = sql.matchAll(/CREATE TABLE "(\w+)"/g);
  const missing: string[] = [];
  for (const m of createMatches) {
    if (!existing.has(m[1])) missing.push(m[1]);
  }
  console.log("Missing tables:", missing);
  await pool.end();
}
main();

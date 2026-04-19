import "dotenv/config";
import pkg from "pg";
const pool = new pkg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function check() {
  const c = await pool.connect();
  try {
    const res = await c.query(`
      SELECT table_schema, table_name 
      FROM information_schema.tables 
      WHERE table_schema IN ('public', 'oms', 'ebay', 'dropship', 'wms', 'membership')
        AND table_type = 'BASE TABLE'
      ORDER BY table_schema, table_name;
    `);
    
    const tablesBySchema: Record<string, string[]> = {};
    res.rows.forEach(r => {
      if (!tablesBySchema[r.table_schema]) tablesBySchema[r.table_schema] = [];
      tablesBySchema[r.table_schema].push(r.table_name);
    });
    
    console.log(JSON.stringify(tablesBySchema, null, 2));

  } catch(e) { console.error('Error', e.message); }
  c.release(); pool.end();
}
check();

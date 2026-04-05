import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function check() {
  try {
    const schemas = await pool.query(`
      SELECT schema_name 
      FROM information_schema.schemata 
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast') 
        AND schema_name NOT LIKE 'pg_temp_%' 
        AND schema_name NOT LIKE 'pg_toast_temp_%';
    `);
    console.log('SCHEMAS:', schemas.rows.map(r => r.schema_name));

    const tables = await pool.query(`
      SELECT table_schema, table_name 
      FROM information_schema.tables 
      WHERE table_schema IN ('oms', 'wms', 'membership', 'public') 
      ORDER BY table_schema, table_name;
    `);
    
    const bySchema = {};
    for (const row of tables.rows) {
      if (!bySchema[row.table_schema]) bySchema[row.table_schema] = [];
      bySchema[row.table_schema].push(row.table_name);
    }
    console.log('TABLES BY SCHEMA:', bySchema);
  } finally {
    await pool.end();
  }
}

check();

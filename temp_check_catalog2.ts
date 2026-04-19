import "dotenv/config";
import pkg from "pg";
const pool = new pkg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function check() {
  const c = await pool.connect();
  try {
    const res = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'catalog'");
    require('fs').writeFileSync('catalog_tables.txt', res.rows.map(r => r.table_name).join('\n'));
  } catch(e) { }
  c.release(); pool.end();
}
check();

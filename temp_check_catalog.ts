import "dotenv/config";
import pkg from "pg";
const pool = new pkg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function check() {
  const c = await pool.connect();
  try {
    const res = await c.query("SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = 'catalog' ORDER BY table_name");
    console.log(res.rows);
  } catch(e) { console.error('Error', e.message); }
  c.release(); pool.end();
}
check();

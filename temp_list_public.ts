import "dotenv/config";
import pkg from "pg";
const pool = new pkg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function check() {
  const c = await pool.connect();
  try {
    const res = await c.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `);
    console.log('Public Schema Tables:');
    res.rows.forEach(r => console.log(' - ' + r.table_name));
  } catch(e) { console.error('Error', e.message); }
  c.release(); pool.end();
}
check();

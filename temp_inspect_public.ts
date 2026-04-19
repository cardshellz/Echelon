import "dotenv/config";
import pkg from "pg";
const pool = new pkg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function check() {
  const c = await pool.connect();
  try {
    const res = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
    const tables = res.rows.map(r => r.table_name);
    
    console.log("--- TABLES IN PUBLIC ---");
    for (const t of tables) {
      if (!t.includes('migration')) {
        const rowRes = await c.query(`SELECT count(*) FROM public.${t}`);
        console.log(`${t}: ${rowRes.rows[0].count} rows`);
      } else {
        console.log(`${t}: (migration table)`);
      }
    }
  } catch(e) {
    console.error('Error', e.message);
  } finally {
    c.release();
    pool.end();
  }
}
check();

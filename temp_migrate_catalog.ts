import "dotenv/config";
import pkg from "pg";
const pool = new pkg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function migrateCatalog() {
  const c = await pool.connect();
  try {
    const tablesToMove = ["product_types", "products", "product_variants", "product_lines", "product_line_products", "product_assets"];
    
    for (const table of tablesToMove) {
      console.log(`Checking public.${table}...`);
      const checkPublic = await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [table]);
      const checkCatalog = await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'catalog' AND table_name = $1`, [table]);
      
      if (checkPublic.rows.length > 0 && checkCatalog.rows.length > 0) {
         console.log(`Dropping ghost public.${table}...`);
         await c.query(`DROP TABLE public.${table} CASCADE`);
      } else if (checkPublic.rows.length > 0) {
        console.log(`Migrating public.${table} to catalog schema...`);
        await c.query(`ALTER TABLE public.${table} SET SCHEMA catalog;`);
      } else {
        console.log(`Table public.${table} does not exist.`);
      }
    }
  } catch(e) {
    console.error('Error:', e.message);
  } finally {
    c.release();
    pool.end();
  }
}
migrateCatalog();

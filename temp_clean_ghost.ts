import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ 
  connectionString: process.env.DATABASE_URL, 
  ssl: { rejectUnauthorized: false } 
});

async function run() {
  const client = await pool.connect();
  try {
    const idsToClean = ['gid://shopify/Order/12011556438175', 'gid://shopify/Order/12011524849823'];
    
    for (const gid of idsToClean) {
      const wmsOrder = await client.query(`SELECT id FROM wms.orders WHERE external_order_id = $1`, [gid]);
      if (wmsOrder.rows.length > 0) {
        const id = wmsOrder.rows[0].id;
        console.log(`Cleaning bad order ID ${id}`);
        await client.query(`DELETE FROM wms.order_items WHERE order_id = $1`, [id]);
        await client.query(`DELETE FROM wms.orders WHERE id = $1`, [id]);
        console.log(`Successfully purged ${gid} ghost data`);
      }
    }
  } catch (err) {
    console.error("DB clean Error:", err);
  } finally {
    client.release();
    process.exit(0);
  }
}

run();

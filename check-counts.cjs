require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const resWms = await pool.query(`SELECT COUNT(*) FROM wms.orders`);
    const resPub = await pool.query(`SELECT COUNT(*) FROM public.orders`);
    const resWmsItems = await pool.query(`SELECT COUNT(*) FROM wms.order_items`);
    const resPubItems = await pool.query(`SELECT COUNT(*) FROM public.order_items`);

    console.log("WMS orders:", resWms.rows[0].count);
    console.log("Public orders:", resPub.rows[0].count);
    console.log("WMS order_items:", resWmsItems.rows[0].count);
    console.log("Public order_items:", resPubItems.rows[0].count);

    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();

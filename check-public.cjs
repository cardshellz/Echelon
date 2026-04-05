require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const res = await pool.query(`
      SELECT id, order_number, warehouse_status, source, source_table_id
      FROM public.orders 
      WHERE order_number IN ('#55554', '#55555', '#55556', '#55557', '#55558', '#55559', '#55560', '#55561', '#55566')
    `);
    console.table(res.rows);
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();

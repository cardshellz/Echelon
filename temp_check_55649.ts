import "dotenv/config";
import pkg from "pg";
const pool = new pkg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function check() {
  const c = await pool.connect();
  try {
    const o = await c.query("SELECT id, external_order_number, customer_email, status, financial_status, total_cents FROM oms.oms_orders WHERE external_order_number LIKE '%55649%'");
    console.log('OMS Orders:', JSON.stringify(o.rows, null, 2));

    const wms = await c.query("SELECT id, order_number, customer_name, financial_status FROM wms.orders WHERE order_number LIKE '%55649%'");
    console.log('WMS Orders:', JSON.stringify(wms.rows, null, 2));

    const m = await c.query("SELECT m.* FROM public.memberships m JOIN identity.users u ON m.user_id = u.id WHERE u.email='thejoefu@gmail.com'");
    console.log('Membership:', JSON.stringify(m.rows, null, 2));
    
  } catch(e) { console.error('Error', e.message); }
  c.release(); pool.end();
}
check();

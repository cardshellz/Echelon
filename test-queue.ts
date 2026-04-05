export {}
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.query(`
      SELECT o.*
      FROM orders o
      LEFT JOIN echelon_settings s ON s.key = CONCAT('warehouse_', o.warehouse_id, '_fifo_mode')
      WHERE o.warehouse_status NOT IN ('shipped', 'ready_to_ship', 'cancelled')
        AND (
          o.warehouse_status IN ('ready', 'in_progress')
          OR (o.warehouse_status = 'completed' AND o.completed_at >= NOW() - INTERVAL '24 HOURS')
        )
      ORDER BY
        o.on_hold ASC,           -- Held orders sink to the bottom
        CASE WHEN o.priority >= 9999 THEN 1 ELSE 0 END DESC, -- Bumped orders always float to top
        CASE WHEN s.value = 'true' THEN 0 ELSE o.priority END DESC, -- Bypass standard priority scoring if FIFO enabled
        o.sla_due_at ASC NULLS LAST,
        COALESCE(o.order_placed_at, o.shopify_created_at, o.created_at) ASC
`)
.then(res => { console.log('Rows:', res.rows.length); process.exit(0); })
.catch(err => { console.error('Error:', err); process.exit(1); })

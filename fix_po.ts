import { db } from './server/db';
import { sql } from 'drizzle-orm';

async function fix() {
  try {
    await db.execute(sql`UPDATE purchase_order_lines SET status = 'partially_received' WHERE status = 'partial'`);
    console.log("Updated po lines.");
    
    await db.execute(sql`
        UPDATE purchase_orders 
        SET status = 'partially_received'
        WHERE id IN (
            SELECT purchase_order_id
            FROM purchase_order_lines
            WHERE status IN ('partially_received')
        )
        AND status != 'received' AND status != 'closed'
    `);
    console.log("Updated po headers.");
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}

fix();

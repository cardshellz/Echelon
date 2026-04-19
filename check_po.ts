import * as dotenv from "dotenv";
dotenv.config();

import { db } from "./server/db";
import { sql } from "drizzle-orm";

async function run() {
  console.log("Checking PO-68 or any POs...");
  
  const pos = await db.execute(sql`
    SELECT id, po_number, status, line_count, received_line_count 
    FROM purchase_orders 
    ORDER BY id DESC LIMIT 5
  `);
  console.log("Recent POs:");
  console.table(pos.rows);

  const poLineStatus = await db.execute(sql`
    SELECT id, purchase_order_id, status, order_qty, received_qty, cancelled_qty, unit_of_measure, units_per_uom
    FROM purchase_order_lines
    WHERE purchase_order_id IN (SELECT id FROM purchase_orders ORDER BY id DESC LIMIT 5)
  `);
  console.log("Recent PO Lines:");
  console.table(poLineStatus.rows);

  const stuckPo = await db.execute(sql`
    SELECT id, po_number, status, line_count, received_line_count 
    FROM purchase_orders 
    WHERE status = 'partially_received'
  `);
  console.log("Partially Received POs:");
  console.table(stuckPo.rows);

  if (stuckPo.rows.length > 0) {
    const stuckLines = await db.execute(sql`
      SELECT id, purchase_order_id as po_id, status, order_qty, received_qty, cancelled_qty, unit_of_measure, units_per_uom
      FROM purchase_order_lines
      WHERE purchase_order_id = ${stuckPo.rows[0].id}
    `);
    console.log(`Lines for stuck PO ${stuckPo.rows[0].po_number}:`);
    console.table(stuckLines.rows);

    const receipts = await db.execute(sql`
      SELECT r.receipt_number, l.expected_qty, l.received_qty, l.status
      FROM receiving_orders r
      JOIN receiving_lines l ON l.receiving_order_id = r.id
      WHERE r.purchase_order_id = ${stuckPo.rows[0].id}
    `);
    console.log(`Receipts for stuck PO ${stuckPo.rows[0].po_number}:`);
    console.table(receipts.rows);
  }

  process.exit(0);
}
run();

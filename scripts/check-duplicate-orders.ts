/**
 * Check for duplicate orders in the database
 * Run with: npm run check-duplicates
 */

import { db } from "../server/db";
import { sql } from "drizzle-orm";

async function checkDuplicates() {
  console.log("Checking for duplicate orders in pick queue...\n");

  // Check duplicates in pick queue
  const pickQueueDupes = await db.execute(sql`
    SELECT 
      order_number, 
      COUNT(*) as count,
      array_agg(id ORDER BY created_at) as order_ids,
      array_agg(warehouse_status) as statuses,
      array_agg(created_at::text) as created_times
    FROM orders 
    WHERE warehouse_status IN ('ready', 'in_progress')
    GROUP BY order_number 
    HAVING COUNT(*) > 1
    ORDER BY order_number
    LIMIT 50
  `);

  if (pickQueueDupes.rows.length === 0) {
    console.log("✓ No duplicates found in pick queue");
    
    // Check all Shopify orders for duplicates
    console.log("\nChecking all Shopify orders for duplicates...\n");
    
    const allDupes = await db.execute(sql`
      SELECT 
        order_number,
        COUNT(*) as count,
        array_agg(id ORDER BY created_at) as order_ids
      FROM orders
      WHERE source = 'shopify'
      GROUP BY order_number
      HAVING COUNT(*) > 1
      ORDER BY order_number
      LIMIT 20
    `);
    
    if (allDupes.rows.length === 0) {
      console.log("✓ No duplicates found in all orders");
      console.log("\nDIAGNOSIS: UI rendering issue (frontend bug)");
    } else {
      console.log(`✗ Found ${allDupes.rows.length} duplicate order numbers (not in pick queue)`);
      console.log("\nDIAGNOSIS: Database duplicates exist but not currently in pick queue");
    }
  } else {
    console.log(`✗ Found ${pickQueueDupes.rows.length} duplicate order numbers in pick queue:\n`);
    
    pickQueueDupes.rows.forEach((row: any) => {
      console.log(`Order ${row.order_number}:`);
      console.log(`  Count: ${row.count}`);
      console.log(`  IDs: ${row.order_ids}`);
      console.log(`  Statuses: ${row.statuses}`);
      console.log(`  Created: ${row.created_times}`);
      console.log('');
    });
    
    console.log("\nDIAGNOSIS: Database has duplicate rows - race condition confirmed");
    console.log("\nRECOMMENDED ACTION:");
    console.log("1. Migration 0063 will prevent future duplicates");
    console.log("2. Run cleanup script to delete existing duplicates");
  }

  process.exit(0);
}

checkDuplicates().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

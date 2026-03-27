/**
 * Backfill ALL orders with member tiers from Shellz Club
 * Run once to populate historical data
 */

import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL || process.env.EXTERNAL_DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

async function backfillAll() {
  console.log('Starting full member tier backfill...');
  
  // Update oms_orders with member tiers via direct JOIN
  const result = await pool.query(`
    UPDATE oms_orders o
    SET member_tier = p.name
    FROM members m
    JOIN member_current_membership mcm ON mcm.member_id = m.id
    JOIN plans p ON p.id = mcm.plan_id
    WHERE LOWER(o.customer_email) = LOWER(m.email)
      AND mcm.status = 'active'
      AND (o.member_tier IS NULL OR o.member_tier != p.name)
  `);

  console.log(`✅ Updated ${result.rowCount} orders with member tiers`);

  // Show sample of enriched orders
  const sample = await pool.query(`
    SELECT id, external_order_id, customer_email, member_tier, ordered_at
    FROM oms_orders
    WHERE member_tier IS NOT NULL
    ORDER BY ordered_at DESC
    LIMIT 10
  `);

  console.log('\nSample enriched orders:');
  console.table(sample.rows);

  // Show stats
  const stats = await pool.query(`
    SELECT 
      COUNT(*) as total_orders,
      COUNT(member_tier) as has_tier,
      COUNT(*) - COUNT(member_tier) as no_tier
    FROM oms_orders
  `);

  console.log('\nOverall stats:');
  console.table(stats.rows);

  await pool.end();
}

backfillAll().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});

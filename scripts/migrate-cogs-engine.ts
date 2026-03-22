/**
 * COGS Engine Migration — adds cost columns to inventory_lots,
 * creates order_line_costs table, and cost_adjustment_log table.
 *
 * Safe to run multiple times (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
 */
import { Pool } from "pg";

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  console.log("🔧 Running COGS Engine migration...\n");

  // ─── 1. ALTER inventory_lots: add COGS columns ───────────────────

  const alterStatements = [
    `ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS po_line_id INTEGER`,
    `ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS po_unit_cost_cents NUMERIC(10,4) DEFAULT 0`,
    `ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS landed_cost_cents NUMERIC(10,4) DEFAULT 0`,
    `ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS total_unit_cost_cents NUMERIC(10,4) DEFAULT 0`,
    `ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS qty_received INTEGER DEFAULT 0`,
    `ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS qty_consumed INTEGER DEFAULT 0`,
    `ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS cost_source VARCHAR(20) DEFAULT 'manual'`,
    `ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS batch_number VARCHAR(100)`,
  ];

  for (const stmt of alterStatements) {
    try {
      await pool.query(stmt);
      const col = stmt.match(/ADD COLUMN IF NOT EXISTS (\w+)/)?.[1];
      console.log(`  ✓ inventory_lots.${col}`);
    } catch (err: any) {
      console.log(`  ⚠ ${err.message}`);
    }
  }

  // ─── 2. Backfill existing lots with COGS column values ──────────

  console.log("\n📊 Backfilling existing lots...");
  await pool.query(`
    UPDATE inventory_lots
    SET
      po_unit_cost_cents = COALESCE(unit_cost_cents, 0),
      landed_cost_cents = 0,
      total_unit_cost_cents = COALESCE(unit_cost_cents, 0),
      qty_received = COALESCE(qty_on_hand, 0) + COALESCE(qty_consumed, 0),
      cost_source = CASE
        WHEN purchase_order_id IS NOT NULL THEN 'po'
        ELSE 'manual'
      END
    WHERE po_unit_cost_cents = 0 AND total_unit_cost_cents = 0 AND unit_cost_cents > 0
  `);
  console.log("  ✓ Backfilled cost columns from unit_cost_cents");

  // ─── 3. CREATE order_line_costs table ────────────────────────────

  console.log("\n📋 Creating order_line_costs table...");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_line_costs (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL,
      order_item_id INTEGER,
      product_variant_id INTEGER NOT NULL,
      lot_id INTEGER NOT NULL REFERENCES inventory_lots(id),
      qty_consumed INTEGER NOT NULL,
      unit_cost_cents NUMERIC(10,4) NOT NULL,
      total_cost_cents NUMERIC(10,4) NOT NULL,
      shipped_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  console.log("  ✓ order_line_costs table created");

  // Indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_olc_order ON order_line_costs(order_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_olc_lot ON order_line_costs(lot_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_olc_variant ON order_line_costs(product_variant_id)`);
  console.log("  ✓ Indexes created");

  // ─── 4. CREATE cost_adjustment_log table ─────────────────────────

  console.log("\n📋 Creating cost_adjustment_log table...");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cost_adjustment_log (
      id SERIAL PRIMARY KEY,
      lot_id INTEGER NOT NULL,
      lot_number VARCHAR(50),
      product_variant_id INTEGER,
      sku VARCHAR(100),
      old_cost_cents NUMERIC(10,4),
      new_cost_cents NUMERIC(10,4),
      delta_cents NUMERIC(10,4),
      reason VARCHAR(100),
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  console.log("  ✓ cost_adjustment_log table created");

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cal_lot ON cost_adjustment_log(lot_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cal_created ON cost_adjustment_log(created_at DESC)`);

  // ─── 5. Indexes on inventory_lots for FIFO queries ───────────────

  console.log("\n🔍 Creating FIFO indexes...");
  try {
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_lots_variant_fifo
      ON inventory_lots (product_variant_id, received_at ASC)
      WHERE status = 'active'
    `);
    console.log("  ✓ idx_lots_variant_fifo");
  } catch (err: any) {
    console.log(`  ⚠ ${err.message}`);
  }

  try {
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_lots_shipment
      ON inventory_lots (inbound_shipment_id)
      WHERE inbound_shipment_id IS NOT NULL
    `);
    console.log("  ✓ idx_lots_shipment");
  } catch (err: any) {
    console.log(`  ⚠ ${err.message}`);
  }

  try {
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_lots_cost_source
      ON inventory_lots (cost_source)
      WHERE status = 'active'
    `);
    console.log("  ✓ idx_lots_cost_source");
  } catch (err: any) {
    console.log(`  ⚠ ${err.message}`);
  }

  console.log("\n✅ COGS Engine migration complete!");

  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

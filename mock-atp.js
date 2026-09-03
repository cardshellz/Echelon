import pg from "pg";
import { createAuthorityAwareInventoryAtpService } from "./server/modules/inventory-planning/infrastructure/inventory-availability-runtime-atp.repository.ts";

const { Pool } = pg;

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  const atpService = createAuthorityAwareInventoryAtpService(pool);
  
  const productRes = await pool.query(`SELECT id FROM catalog.products WHERE sku = 'SHLZ-SEMI-OVR'`);
  const pid = productRes.rows[0].id;
  
  // Test the new logic for warehouse 1 (LEONBERG)
  const variantAtps = await atpService.getAtpPerVariantByWarehouse(pid, 1);
  console.log('Per-Variant ATP for LEONBERG:');
  console.table(variantAtps);
  
  const directVariantAtps = await atpService.getDirectVariantAtpByWarehouse([173, 174], 1);
  console.log('Direct Variant ATP for LEONBERG (Expected: includes 435 from Route 19):', directVariantAtps);

  await pool.end();
}

run().catch(console.error);

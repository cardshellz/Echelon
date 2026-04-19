import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { createInventoryAtpService } from "./server/modules/inventory/atp.service.ts";
import * as schema from "./shared/schema/index.ts";

const { Client } = pg;

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  const db = drizzle(client, { schema });

  const atpService = createInventoryAtpService(db);
  
  const productRes = await client.query(`SELECT id FROM catalog.products WHERE sku = 'SHLZ-SEMI-OVR'`);
  const pid = productRes.rows[0].id;
  
  // Test the new logic for warehouse 1 (LEONBERG)
  const atpBaseByWarehouseId = await atpService.getAtpBaseByWarehouse(pid, 1);
  console.log('ATP Base for LEONBERG (Warehouse 1):', atpBaseByWarehouseId);
  
  const variantAtps = await atpService.getAtpPerVariantByWarehouse(pid, 1);
  console.log('Per-Variant ATP for LEONBERG:');
  console.table(variantAtps);
  
  const directVariantAtps = await atpService.getDirectVariantAtpByWarehouse([173, 174], 1);
  console.log('Direct Variant ATP for LEONBERG (Expected: includes 435 from Route 19):', directVariantAtps);

  await client.end();
}

run().catch(console.error);

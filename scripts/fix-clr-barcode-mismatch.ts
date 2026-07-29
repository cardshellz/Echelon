import { Pool, type PoolClient } from "pg";

import { repairOpenWmsOrderItemBarcode } from "../server/modules/wms/order-item-maintenance-commands";

const PACK_SKU = "SHLZ-TOP-55PT-CLR-P25";
const PACK_BARCODE = "13359263";
const CASE_SKU = "SHLZ-TOP-55PT-CLR-C800";
const CASE_BARCODE = "13392031";

function isExecuteMode(argv: string[]): boolean {
  const unknown = argv.filter((arg) => arg !== "--execute" && arg !== "--dry-run");
  if (unknown.length > 0) {
    throw new Error(`Unknown flag(s): ${unknown.join(", ")}`);
  }
  if (argv.includes("--execute") && argv.includes("--dry-run")) {
    throw new Error("Pass either --execute or --dry-run, not both");
  }
  return argv.includes("--execute");
}

async function loadEvidence(client: PoolClient): Promise<void> {
  const locations = await client.query(`
    SELECT
      pv.sku,
      pv.barcode AS variant_barcode,
      pl.id AS location_id,
      pl.location,
      pl.barcode AS location_barcode
    FROM warehouse.product_locations pl
    JOIN catalog.product_variants pv ON pv.id = pl.product_variant_id
    WHERE pv.sku = ANY($1::text[])
      AND pl.is_primary = 1
    ORDER BY pv.sku
  `, [[PACK_SKU, CASE_SKU]]);
  console.table(locations.rows);

  const orderItems = await client.query(`
    SELECT oi.id, oi.sku, oi.barcode, o.order_number, o.warehouse_status
    FROM wms.order_items oi
    JOIN wms.orders o ON o.id = oi.order_id
    WHERE oi.sku = $1
      AND o.warehouse_status IN ('ready', 'picking', 'in_progress')
    ORDER BY oi.id
  `, [PACK_SKU]);
  console.table(orderItems.rows);
}

async function applyRepair(client: PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    const packLocations = await client.query(`
      UPDATE warehouse.product_locations pl
      SET barcode = $1,
          updated_at = NOW()
      FROM catalog.product_variants pv
      WHERE pv.id = pl.product_variant_id
        AND pv.sku = $2
        AND pl.location = 'E-01'
        AND pl.barcode = $3
      RETURNING pl.id, pv.sku, pl.location, pl.barcode
    `, [PACK_BARCODE, PACK_SKU, CASE_BARCODE]);

    const caseLocations = await client.query(`
      UPDATE warehouse.product_locations pl
      SET barcode = $1,
          updated_at = NOW()
      FROM catalog.product_variants pv
      WHERE pv.id = pl.product_variant_id
        AND pv.sku = $2
        AND pl.location = 'H-03'
        AND pl.barcode IS NULL
      RETURNING pl.id, pv.sku, pl.location, pl.barcode
    `, [CASE_BARCODE, CASE_SKU]);

    const orderItems = await repairOpenWmsOrderItemBarcode(client, {
      sku: PACK_SKU,
      incorrectBarcode: CASE_BARCODE,
      correctBarcode: PACK_BARCODE,
    });

    await client.query("COMMIT");
    console.log(JSON.stringify({
      packLocationsUpdated: packLocations.rowCount ?? 0,
      caseLocationsUpdated: caseLocations.rowCount ?? 0,
      orderItemsUpdated: orderItems.length,
    }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main(): Promise<void> {
  const execute = isExecuteMode(process.argv.slice(2));
  const connectionString =
    process.env.EXTERNAL_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("EXTERNAL_DATABASE_URL or DATABASE_URL is required");
  }

  const useSsl =
    Boolean(process.env.EXTERNAL_DATABASE_URL) ||
    process.env.NODE_ENV === "production";
  const pool = new Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });
  const client = await pool.connect();
  try {
    console.log(`[CLR barcode repair] mode=${execute ? "execute" : "dry-run"}`);
    await loadEvidence(client);
    if (execute) {
      await applyRepair(client);
      await loadEvidence(client);
    } else {
      console.log("[CLR barcode repair] no changes written; pass --execute to apply");
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[CLR barcode repair] fatal", error);
  process.exitCode = 1;
});

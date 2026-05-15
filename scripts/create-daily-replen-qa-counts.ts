/**
 * Create a small daily random QA cycle count sample for replen/bin accuracy.
 *
 * Dry run:
 *   npx tsx scripts/create-daily-replen-qa-counts.ts --json
 *
 * Execute:
 *   npx tsx scripts/create-daily-replen-qa-counts.ts --execute --json
 */

import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { cycleCountItems, cycleCounts } from "@shared/schema";

type CliOptions = {
  execute: boolean;
  json: boolean;
  limit: number;
  warehouseId: number | null;
};

type CandidateLocation = {
  id: number;
  code: string;
  warehouse_id: number | null;
  location_type: string | null;
  bin_type: string | null;
  is_pickable: number | boolean | null;
  total_qty: string | number | null;
  has_assignment: boolean;
};

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    execute: false,
    json: false,
    limit: 2,
    warehouseId: null,
  };

  for (const arg of args) {
    if (arg === "--execute") {
      options.execute = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("--limit=")) {
      options.limit = parsePositiveInt(arg, "--limit=");
    } else if (arg.startsWith("--warehouseId=")) {
      options.warehouseId = parsePositiveInt(arg, "--warehouseId=");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parsePositiveInt(arg: string, prefix: string): number {
  const value = Number(arg.slice(prefix.length));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${prefix.slice(0, -1)} must be a positive integer`);
  }
  return value;
}

async function loadDotenvIfAvailable(): Promise<void> {
  try {
    const dotenv = await import("dotenv");
    dotenv.config({ quiet: true });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("dotenv")) {
      throw error;
    }
  }

  if (process.env.DATABASE_URL || process.env.EXTERNAL_DATABASE_URL) return;

  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const env = fs.readFileSync(envPath, "utf8").replace(/\0/g, "");
  for (const key of ["EXTERNAL_DATABASE_URL", "DATABASE_URL"]) {
    const line = env.split(/\r?\n/).find((entry) => entry.startsWith(`${key}=`));
    if (!line) continue;
    let value = line.slice(key.length + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    break;
  }
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function countName(day: string, warehouseId: number | null): string {
  return warehouseId
    ? `Daily Replen QA - ${day} - Warehouse ${warehouseId}`
    : `Daily Replen QA - ${day}`;
}

async function selectCandidates(db: any, limit: number, warehouseId: number | null): Promise<CandidateLocation[]> {
  const warehouseFilter = warehouseId ? sql`AND wl.warehouse_id = ${warehouseId}` : sql``;
  const result = await db.execute(sql`
    SELECT
      wl.id,
      wl.code,
      wl.warehouse_id,
      wl.location_type,
      wl.bin_type,
      wl.is_pickable,
      COALESCE(SUM(il.variant_qty), 0) AS total_qty,
      EXISTS (
        SELECT 1
        FROM warehouse.product_locations pl
        WHERE pl.warehouse_location_id = wl.id
          AND pl.status = 'active'
      ) AS has_assignment
    FROM warehouse.warehouse_locations wl
    LEFT JOIN inventory.inventory_levels il
      ON il.warehouse_location_id = wl.id
    WHERE wl.is_active = 1
      AND wl.cycle_count_freeze_id IS NULL
      AND (
        wl.is_pickable = 1
        OR wl.bin_type = 'pallet'
        OR wl.location_type = 'pallet'
      )
      ${warehouseFilter}
      AND (
        EXISTS (
          SELECT 1
          FROM warehouse.product_locations pl
          WHERE pl.warehouse_location_id = wl.id
            AND pl.status = 'active'
        )
        OR EXISTS (
          SELECT 1
          FROM inventory.inventory_levels il2
          WHERE il2.warehouse_location_id = wl.id
            AND il2.variant_qty <> 0
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM inventory.cycle_counts cc
        CROSS JOIN LATERAL regexp_split_to_table(UPPER(COALESCE(cc.location_codes, '')), '\\s*,\\s*') counted(code)
        WHERE cc.status IN ('draft', 'in_progress', 'pending_review')
          AND counted.code = UPPER(wl.code)
      )
    GROUP BY wl.id, wl.code, wl.warehouse_id, wl.location_type, wl.bin_type, wl.is_pickable
    ORDER BY random()
    LIMIT ${limit}
  `);

  return (result.rows ?? []) as CandidateLocation[];
}

async function buildItemsForLocation(db: any, cycleCountId: number, locationId: number) {
  const result = await db.execute(sql`
    SELECT DISTINCT ON (product_variant_id)
      product_variant_id,
      variant_qty,
      product_id,
      sku,
      is_assigned
    FROM (
      SELECT
        pv.id AS product_variant_id,
        COALESCE(il.variant_qty, 0) AS variant_qty,
        pv.product_id AS product_id,
        pv.sku AS sku,
        1 AS is_assigned
      FROM warehouse.product_locations pl
      JOIN catalog.product_variants pv ON UPPER(pv.sku) = UPPER(pl.sku)
      LEFT JOIN inventory.inventory_levels il ON il.product_variant_id = pv.id
        AND il.warehouse_location_id = ${locationId}
      WHERE pl.warehouse_location_id = ${locationId}

      UNION ALL

      SELECT
        il.product_variant_id,
        il.variant_qty,
        p.id AS product_id,
        COALESCE(pv.sku, p.sku) AS sku,
        0 AS is_assigned
      FROM inventory.inventory_levels il
      LEFT JOIN catalog.product_variants pv ON il.product_variant_id = pv.id
      LEFT JOIN catalog.products p ON pv.product_id = p.id
      WHERE il.warehouse_location_id = ${locationId}
        AND il.variant_qty > 0
        AND NOT EXISTS (
          SELECT 1
          FROM warehouse.product_locations pl2
          JOIN catalog.product_variants pv2 ON UPPER(pv2.sku) = UPPER(pl2.sku)
          WHERE pl2.warehouse_location_id = ${locationId}
            AND pv2.id = il.product_variant_id
        )
    ) combined
    ORDER BY product_variant_id, is_assigned DESC
  `);

  const rows = result.rows ?? [];
  if (rows.length === 0) {
    return [{
      cycleCountId,
      warehouseLocationId: locationId,
      productVariantId: null,
      productId: null,
      expectedSku: null,
      expectedQty: 0,
      status: "pending",
    }];
  }

  return rows.map((row: any) => ({
    cycleCountId,
    warehouseLocationId: locationId,
    productVariantId: row.product_variant_id ?? null,
    productId: row.product_id ?? null,
    expectedSku: row.sku ?? null,
    expectedQty: Number(row.variant_qty ?? 0),
    mismatchType: row.is_assigned ? null : "unexpected_found",
    varianceType: row.is_assigned ? null : "unexpected_item",
    requiresApproval: row.is_assigned ? 0 : 1,
    varianceNotes: row.is_assigned ? null : "Not assigned to this bin",
    status: "pending",
  }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadDotenvIfAvailable();

  if (!process.env.DATABASE_URL && !process.env.EXTERNAL_DATABASE_URL) {
    throw new Error("DATABASE_URL or EXTERNAL_DATABASE_URL is required");
  }

  const { db, pool } = await import("../server/db");
  const day = todayKey();
  const name = countName(day, options.warehouseId);

  try {
    const existing = await db.execute(sql`
      SELECT id, status, location_codes
      FROM inventory.cycle_counts
      WHERE name = ${name}
        AND status IN ('draft', 'in_progress', 'pending_review', 'completed')
      LIMIT 1
    `);
    const existingCount = existing.rows?.[0] ?? null;
    const candidates = existingCount
      ? []
      : await selectCandidates(db, options.limit, options.warehouseId);

    let cycleCountId: number | null = existingCount?.id ?? null;
    let createdItems = 0;

    if (options.execute && !existingCount && candidates.length > 0) {
      await db.transaction(async (tx: any) => {
        const [cycleCount] = await tx.insert(cycleCounts).values({
          name,
          description: `Daily random replen QA sample. Count these bins to spot inventory drift without requiring picker replen confirmation.`,
          status: "in_progress",
          warehouseId: options.warehouseId,
          locationCodes: candidates.map((location) => location.code).join(","),
          totalBins: candidates.length,
          countedBins: 0,
          varianceCount: 0,
          approvedVariances: 0,
          startedAt: new Date(),
          createdBy: "system:daily-replen-qa",
        }).returning();

        cycleCountId = cycleCount.id;

        const items = [];
        for (const location of candidates) {
          items.push(...await buildItemsForLocation(tx, cycleCount.id, location.id));
        }
        if (items.length > 0) {
          await tx.insert(cycleCountItems).values(items);
          createdItems = items.length;
        }

        await tx.execute(sql`
          UPDATE warehouse.warehouse_locations
          SET cycle_count_freeze_id = ${cycleCount.id}, updated_at = NOW()
          WHERE id IN (${sql.join(candidates.map((location) => sql`${location.id}`), sql`, `)})
            AND cycle_count_freeze_id IS NULL
        `);
      });
    }

    const output = {
      mode: options.execute ? "execute" : "dry-run",
      name,
      warehouseId: options.warehouseId,
      limit: options.limit,
      existingCount,
      selectedCount: candidates.length,
      cycleCountId,
      createdItems,
      candidates: candidates.map((location) => ({
        id: location.id,
        code: location.code,
        warehouseId: location.warehouse_id,
        locationType: location.location_type,
        binType: location.bin_type,
        isPickable: location.is_pickable,
        totalQty: Number(location.total_qty ?? 0),
        hasAssignment: location.has_assignment,
      })),
    };

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
    } else if (existingCount) {
      console.log(`Daily replen QA already exists: #${existingCount.id} (${existingCount.status})`);
    } else if (options.execute) {
      console.log(`Created daily replen QA count #${cycleCountId} for ${candidates.length} location(s).`);
    } else {
      console.log(`Dry run selected ${candidates.length} location(s): ${candidates.map((location) => location.code).join(", ")}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

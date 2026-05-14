import fs from "node:fs";

import { sql } from "drizzle-orm";

type Options = {
  execute: boolean;
  json: boolean;
  limit: number;
  sku?: string;
};

type PickStockLocation = {
  locationId: number;
  locationCode: string;
  qty: number;
};

type RepairAction =
  | "consolidate_to_valid_assignment"
  | "assign_from_pick_stock";

type RepairCandidate = {
  variantId: number;
  sku: string | null;
  action: RepairAction;
  targetLocationId: number;
  targetLocationCode: string;
  reason: string;
  assignmentCount: number;
  validAssignmentCount: number;
};

function parseArgs(argv: string[]): Options {
  const options: Options = { execute: false, json: false, limit: 100 };
  for (const arg of argv) {
    if (arg === "--execute") options.execute = true;
    else if (arg === "--json") options.json = true;
    else if (arg.startsWith("--limit=")) options.limit = Number(arg.slice("--limit=".length)) || options.limit;
    else if (arg.startsWith("--sku=")) options.sku = arg.slice("--sku=".length).trim().toUpperCase();
  }
  return options;
}

async function loadDotenvIfAvailable() {
  const envPath = ".env";
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

function groupByVariant<T extends { productVariantId: number }>(rows: T[]) {
  const grouped = new Map<number, T[]>();
  for (const row of rows) {
    const list = grouped.get(row.productVariantId) || [];
    list.push(row);
    grouped.set(row.productVariantId, list);
  }
  return grouped;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadDotenvIfAvailable();

  if (!process.env.DATABASE_URL && !process.env.EXTERNAL_DATABASE_URL) {
    throw new Error("DATABASE_URL or EXTERNAL_DATABASE_URL is required");
  }

  const { db, pool } = await import("../server/db");
  const { createBinAssignmentService } = await import("../server/modules/warehouse/bin-assignment.service");
  const { catalogStorage } = await import("../server/modules/catalog");
  const { warehouseStorage } = await import("../server/modules/warehouse");

  const service = createBinAssignmentService(db, { ...catalogStorage, ...warehouseStorage });
  const assignments = await service.getAssignmentsView(options.sku ? { search: options.sku } : undefined);
  const relevantAssignments = assignments.filter((row) =>
    (!options.sku || row.sku?.toUpperCase() === options.sku) &&
    (row.slotStatus === "invalid" || row.slotStatus === "duplicate" || row.slotStatus === "unassigned")
  );

  const stockRows = await db.execute(sql`
    SELECT
      il.product_variant_id,
      wl.id AS location_id,
      wl.code AS location_code,
      il.variant_qty
    FROM inventory.inventory_levels il
    JOIN warehouse.warehouse_locations wl ON wl.id = il.warehouse_location_id
    JOIN catalog.product_variants pv ON pv.id = il.product_variant_id
    WHERE il.variant_qty > 0
      AND wl.warehouse_id IS NOT NULL
      AND wl.is_active = 1
      AND wl.location_type = 'pick'
      AND wl.is_pickable = 1
      ${options.sku ? sql`AND UPPER(pv.sku) = ${options.sku}` : sql``}
    ORDER BY il.product_variant_id, il.variant_qty DESC, wl.pick_sequence NULLS LAST, wl.code ASC
  `);

  const stockByVariant = new Map<number, PickStockLocation[]>();
  for (const row of stockRows.rows as any[]) {
    const variantId = Number(row.product_variant_id);
    const list = stockByVariant.get(variantId) || [];
    list.push({
      locationId: Number(row.location_id),
      locationCode: String(row.location_code),
      qty: Number(row.variant_qty || 0),
    });
    stockByVariant.set(variantId, list);
  }

  const grouped = groupByVariant(relevantAssignments);
  const candidates: RepairCandidate[] = [];
  const unresolved: Array<{
    variantId: number;
    sku: string | null;
    reason: string;
    assignmentCount: number;
    validAssignmentCount: number;
    pickStockLocations: PickStockLocation[];
  }> = [];

  for (const [variantId, rows] of grouped) {
    const first = rows[0];
    const validRows = rows.filter((row) => row.productLocationId && !row.slotIssue && row.assignedLocationId);
    const stockLocations = stockByVariant.get(variantId) || [];

    if (validRows.length === 1) {
      candidates.push({
        variantId,
        sku: first.sku,
        action: "consolidate_to_valid_assignment",
        targetLocationId: validRows[0].assignedLocationId!,
        targetLocationCode: validRows[0].assignedLocationCode || String(validRows[0].assignedLocationId),
        reason: "exactly one valid active pick-face assignment exists; duplicate or invalid rows can be collapsed",
        assignmentCount: first.assignmentCount,
        validAssignmentCount: first.validAssignmentCount,
      });
      continue;
    }

    if (
      validRows.length > 1 &&
      stockLocations.length === 1 &&
      validRows.some((row) => row.assignedLocationId === stockLocations[0].locationId)
    ) {
      candidates.push({
        variantId,
        sku: first.sku,
        action: "consolidate_to_valid_assignment",
        targetLocationId: stockLocations[0].locationId,
        targetLocationCode: stockLocations[0].locationCode,
        reason: "multiple valid assignments exist, but exactly one assigned pick face currently has stock",
        assignmentCount: first.assignmentCount,
        validAssignmentCount: first.validAssignmentCount,
      });
      continue;
    }

    if (validRows.length === 0 && stockLocations.length === 1) {
      candidates.push({
        variantId,
        sku: first.sku,
        action: "assign_from_pick_stock",
        targetLocationId: stockLocations[0].locationId,
        targetLocationCode: stockLocations[0].locationCode,
        reason: "no valid assignment exists, but exactly one valid pick location has stock",
        assignmentCount: first.assignmentCount,
        validAssignmentCount: first.validAssignmentCount,
      });
      continue;
    }

    unresolved.push({
      variantId,
      sku: first.sku,
      reason: validRows.length > 1
        ? "multiple_valid_assignments"
        : stockLocations.length > 1
          ? "multiple_pick_stock_locations"
          : "no_valid_assignment_or_pick_stock",
      assignmentCount: first.assignmentCount,
      validAssignmentCount: first.validAssignmentCount,
      pickStockLocations: stockLocations,
    });
  }

  const limitedCandidates = candidates.slice(0, options.limit);
  const repaired: RepairCandidate[] = [];
  const failed: Array<RepairCandidate & { error: string }> = [];

  if (options.execute) {
    for (const candidate of limitedCandidates) {
      try {
        await service.assignVariantToLocation({
          productVariantId: candidate.variantId,
          warehouseLocationId: candidate.targetLocationId,
        });
        repaired.push(candidate);
      } catch (error: any) {
        failed.push({ ...candidate, error: error?.message || String(error) });
      }
    }
  }

  const output = {
    mode: options.execute ? "execute" : "dry-run",
    scannedProblemRows: relevantAssignments.length,
    scannedVariants: grouped.size,
    repairable: candidates.length,
    repairableConsolidateExisting: candidates.filter((c) => c.action === "consolidate_to_valid_assignment").length,
    repairableFromPickStock: candidates.filter((c) => c.action === "assign_from_pick_stock").length,
    unresolved: unresolved.length,
    repaired: repaired.length,
    failed: failed.length,
    repairableSamples: limitedCandidates.slice(0, 25),
    unresolvedSamples: unresolved.slice(0, 25),
    failedSamples: failed.slice(0, 25),
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(output);
  }

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

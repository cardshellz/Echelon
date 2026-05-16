/**
 * Create a small daily rotating QA cycle count sample for replen/bin accuracy.
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
  force: boolean;
  limit: number | null;
  cooldownDays: number | null;
  includePickBins: boolean | null;
  includePalletLocations: boolean | null;
  warehouseId: number | null;
};

type QaConfig = {
  enabled: boolean;
  limit: number;
  cooldownDays: number;
  includePickBins: boolean;
  includePalletLocations: boolean;
  source: "warehouse" | "default" | "fallback";
  settingsId: number | null;
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
  last_counted_at: string | Date | null;
  inside_cooldown: boolean;
};

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    execute: false,
    json: false,
    force: false,
    limit: null,
    cooldownDays: null,
    includePickBins: null,
    includePalletLocations: null,
    warehouseId: null,
  };

  for (const arg of args) {
    if (arg === "--execute") {
      options.execute = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg.startsWith("--limit=")) {
      options.limit = parsePositiveInt(arg, "--limit=");
    } else if (arg.startsWith("--cooldownDays=")) {
      options.cooldownDays = parseNonNegativeInt(arg, "--cooldownDays=");
    } else if (arg.startsWith("--includePickBins=")) {
      options.includePickBins = parseBoolean(arg, "--includePickBins=");
    } else if (arg.startsWith("--includePalletLocations=")) {
      options.includePalletLocations = parseBoolean(arg, "--includePalletLocations=");
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

function parseNonNegativeInt(arg: string, prefix: string): number {
  const value = Number(arg.slice(prefix.length));
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${prefix.slice(0, -1)} must be a non-negative integer`);
  }
  return value;
}

function parseBoolean(arg: string, prefix: string): boolean {
  const raw = arg.slice(prefix.length).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${prefix.slice(0, -1)} must be true or false`);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

function intFlag(value: unknown, fallback: boolean): boolean {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  return fallback;
}

async function resolveQaConfig(db: any, options: CliOptions): Promise<QaConfig> {
  const settingsResult = options.warehouseId
    ? await db.execute(sql`
        SELECT
          id,
          warehouse_id,
          warehouse_code,
          replen_qa_daily_enabled,
          replen_qa_daily_sample_limit,
          replen_qa_cooldown_days,
          replen_qa_include_pick_bins,
          replen_qa_include_pallet_locations
        FROM inventory.warehouse_settings
        WHERE warehouse_id = ${options.warehouseId}
           OR warehouse_code = 'DEFAULT'
        ORDER BY CASE WHEN warehouse_id = ${options.warehouseId} THEN 0 ELSE 1 END
        LIMIT 1
      `)
    : await db.execute(sql`
        SELECT
          id,
          warehouse_id,
          warehouse_code,
          replen_qa_daily_enabled,
          replen_qa_daily_sample_limit,
          replen_qa_cooldown_days,
          replen_qa_include_pick_bins,
          replen_qa_include_pallet_locations
        FROM inventory.warehouse_settings
        WHERE warehouse_code = 'DEFAULT'
        LIMIT 1
      `);

  const settings = settingsResult.rows?.[0] ?? null;
  const enabled = options.force
    ? true
    : intFlag(settings?.replen_qa_daily_enabled, true);
  const limit = clampInt(
    options.limit ?? Number(settings?.replen_qa_daily_sample_limit ?? 2),
    1,
    50,
  );
  const cooldownDays = clampInt(
    options.cooldownDays ?? Number(settings?.replen_qa_cooldown_days ?? 30),
    0,
    365,
  );
  const includePickBins = options.includePickBins ?? intFlag(settings?.replen_qa_include_pick_bins, true);
  const includePalletLocations =
    options.includePalletLocations ?? intFlag(settings?.replen_qa_include_pallet_locations, true);

  return {
    enabled,
    limit,
    cooldownDays,
    includePickBins,
    includePalletLocations,
    source: settings
      ? settings.warehouse_id === options.warehouseId && options.warehouseId != null
        ? "warehouse"
        : "default"
      : "fallback",
    settingsId: settings?.id ?? null,
  };
}

async function selectCandidates(db: any, config: QaConfig, warehouseId: number | null): Promise<CandidateLocation[]> {
  const warehouseFilter = warehouseId ? sql`AND wl.warehouse_id = ${warehouseId}` : sql``;
  const scopeParts = [];
  if (config.includePickBins) {
    scopeParts.push(sql`(wl.is_pickable = 1 OR wl.location_type = 'pick')`);
  }
  if (config.includePalletLocations) {
    scopeParts.push(sql`(wl.bin_type = 'pallet' OR wl.location_type = 'pallet')`);
  }
  if (scopeParts.length === 0) return [];
  const scopeFilter = sql`AND (${sql.join(scopeParts, sql` OR `)})`;

  const result = await db.execute(sql`
    WITH last_counts AS (
      SELECT
        cci.warehouse_location_id,
        MAX(COALESCE(cc.completed_at, cc.started_at, cc.created_at)) AS last_counted_at
      FROM inventory.cycle_count_items cci
      JOIN inventory.cycle_counts cc ON cc.id = cci.cycle_count_id
      WHERE cc.status <> 'cancelled'
      GROUP BY cci.warehouse_location_id
    )
    SELECT
      wl.id,
      wl.code,
      wl.warehouse_id,
      wl.location_type,
      wl.bin_type,
      wl.is_pickable,
      COALESCE(SUM(il.variant_qty), 0) AS total_qty,
      lc.last_counted_at,
      CASE
        WHEN lc.last_counted_at IS NULL THEN false
        WHEN ${config.cooldownDays} <= 0 THEN false
        WHEN lc.last_counted_at >= NOW() - make_interval(days => ${config.cooldownDays}) THEN true
        ELSE false
      END AS inside_cooldown,
      EXISTS (
        SELECT 1
        FROM warehouse.product_locations pl
        WHERE pl.warehouse_location_id = wl.id
          AND pl.status = 'active'
      ) AS has_assignment
    FROM warehouse.warehouse_locations wl
    LEFT JOIN inventory.inventory_levels il
      ON il.warehouse_location_id = wl.id
    LEFT JOIN last_counts lc
      ON lc.warehouse_location_id = wl.id
    WHERE wl.is_active = 1
      AND wl.cycle_count_freeze_id IS NULL
      ${scopeFilter}
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
    GROUP BY wl.id, wl.code, wl.warehouse_id, wl.location_type, wl.bin_type, wl.is_pickable, lc.last_counted_at
    ORDER BY
      CASE
        WHEN lc.last_counted_at IS NULL THEN 0
        WHEN ${config.cooldownDays} <= 0 THEN 1
        WHEN lc.last_counted_at < NOW() - make_interval(days => ${config.cooldownDays}) THEN 1
        ELSE 2
      END,
      lc.last_counted_at ASC NULLS FIRST,
      random()
    LIMIT ${config.limit}
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
    const config = await resolveQaConfig(db, options);
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
      : config.enabled
        ? await selectCandidates(db, config, options.warehouseId)
        : [];

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
      config,
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
        lastCountedAt: location.last_counted_at,
        insideCooldown: location.inside_cooldown,
      })),
    };

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
    } else if (existingCount) {
      console.log(`Daily replen QA already exists: #${existingCount.id} (${existingCount.status})`);
    } else if (!config.enabled) {
      console.log("Daily replen QA is disabled for this scope.");
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

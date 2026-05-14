/**
 * Audit replen source resolution without changing data.
 *
 * Default:
 *   npx tsx scripts/audit-replen-source-resolution.ts
 *
 * Useful filters:
 *   npx tsx scripts/audit-replen-source-resolution.ts --sku=ARM-ENV-SGL-P50
 *   npx tsx scripts/audit-replen-source-resolution.ts --json --limit=200
 */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;

type CliOptions = {
  json: boolean;
  issuesOnly: boolean;
  limit: number;
  sku: string | null;
};

type PickSlot = {
  product_location_id: number;
  pick_variant_id: number;
  pick_sku: string;
  pick_name: string | null;
  product_id: number | null;
  pick_hierarchy_level: number;
  pick_units_per_variant: number;
  pick_parent_variant_id: number | null;
  pick_location_id: number;
  pick_location_code: string;
  warehouse_id: number | null;
  pick_qty: number;
};

type ReplenRule = {
  id: number;
  product_id: number | null;
  pick_product_variant_id: number | null;
  source_product_variant_id: number | null;
  source_location_type: string | null;
  source_priority: string | null;
  trigger_value: number | null;
  max_qty: number | null;
  replen_method: string | null;
  priority: number | null;
};

type TierDefault = {
  id: number;
  warehouse_id: number | null;
  hierarchy_level: number;
  source_hierarchy_level: number;
  source_location_type: string;
  source_priority: string;
  trigger_value: number;
  max_qty: number | null;
  replen_method: string;
  priority: number;
};

type ProductVariant = {
  id: number;
  product_id: number | null;
  sku: string | null;
  name: string | null;
  hierarchy_level: number;
  units_per_variant: number;
  parent_variant_id: number | null;
  position: number | null;
  is_active: boolean;
};

type StockRow = {
  product_variant_id: number;
  location_id: number;
  location_code: string;
  location_type: string;
  is_pickable: number;
  is_active: number;
  cycle_count_freeze_id: number | null;
  warehouse_id: number | null;
  variant_qty: number;
  updated_at: string | null;
  pick_sequence: number | null;
  product_location_id: number | null;
  product_location_primary: number | null;
  product_location_status: string | null;
};

type AuditIssue = {
  severity: "error" | "warning";
  code: string;
  pickSku: string;
  pickLocation: string;
  message: string;
  selectedSourceSku?: string | null;
  selectedSourceLocation?: string | null;
  details?: Record<string, unknown>;
};

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    issuesOnly: true,
    limit: 100,
    sku: null,
  };

  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--all") {
      options.issuesOnly = false;
    } else if (arg.startsWith("--limit=")) {
      const limit = Number(arg.slice("--limit=".length));
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error("--limit must be a positive integer");
      }
      options.limit = limit;
    } else if (arg.startsWith("--sku=")) {
      options.sku = arg.slice("--sku=".length).trim();
      if (!options.sku) throw new Error("--sku cannot be empty");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
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

  if (!process.env.DATABASE_URL) {
    const envPath = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return;
    const env = fs.readFileSync(envPath, "utf8").replace(/\0/g, "");
    const line = env.split(/\r?\n/).find((entry) => entry.startsWith("DATABASE_URL="));
    if (!line) return;
    let value = line.slice("DATABASE_URL=".length).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env.DATABASE_URL = value;
  }
}

function units(variant: ProductVariant | PickSlot): number {
  return Math.max(1, Number("units_per_variant" in variant ? variant.units_per_variant : variant.pick_units_per_variant));
}

function isValidCaseBreakSource(source: ProductVariant, pick: PickSlot): boolean {
  const sourceUnits = units(source);
  const pickUnits = units(pick);
  return sourceUnits > pickUnits && sourceUnits % pickUnits === 0;
}

function slotRank(stock: StockRow): number {
  if (!stock.product_location_id) return 2;
  if (stock.product_location_status === "active" && stock.product_location_primary === 1) return 0;
  if (stock.product_location_status === "active") return 1;
  return 3;
}

function chooseRule(slot: PickSlot, rules: ReplenRule[]): { skuRule: ReplenRule | null; ignoredProductRules: ReplenRule[] } {
  const activeSkuRules = rules
    .filter((rule) => rule.pick_product_variant_id === slot.pick_variant_id)
    .sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5) || a.id - b.id);
  const ignoredProductRules = rules
    .filter((rule) => rule.pick_product_variant_id == null && rule.product_id === slot.product_id)
    .sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5) || a.id - b.id);

  return {
    skuRule: activeSkuRules[0] ?? null,
    ignoredProductRules,
  };
}

function chooseTierDefault(slot: PickSlot, defaults: TierDefault[]): TierDefault | null {
  return defaults
    .filter((entry) =>
      entry.hierarchy_level === slot.pick_hierarchy_level &&
      (entry.warehouse_id == null || entry.warehouse_id === slot.warehouse_id)
    )
    .sort((a, b) => {
      const aWarehouse = a.warehouse_id === slot.warehouse_id ? 0 : 1;
      const bWarehouse = b.warehouse_id === slot.warehouse_id ? 0 : 1;
      return aWarehouse - bWarehouse || a.id - b.id;
    })[0] ?? null;
}

function sourceStocksForVariant(
  variantId: number,
  sourceLocationType: string,
  warehouseId: number | null,
  stocksByVariant: Map<number, StockRow[]>,
): StockRow[] {
  return (stocksByVariant.get(variantId) ?? [])
    .filter((stock) =>
      stock.variant_qty > 0 &&
      stock.location_type === sourceLocationType &&
      stock.is_active === 1 &&
      stock.cycle_count_freeze_id == null &&
      (warehouseId == null || stock.warehouse_id === warehouseId)
    )
    .sort((a, b) => (
      new Date(a.updated_at ?? 0).getTime() - new Date(b.updated_at ?? 0).getTime() ||
      (a.pick_sequence ?? Number.MAX_SAFE_INTEGER) - (b.pick_sequence ?? Number.MAX_SAFE_INTEGER) ||
      a.location_id - b.location_id
    ));
}

function auditSlot(
  slot: PickSlot,
  variantsByProduct: Map<number, ProductVariant[]>,
  variantById: Map<number, ProductVariant>,
  stocksByVariant: Map<number, StockRow[]>,
  rules: ReplenRule[],
  defaults: TierDefault[],
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  if (slot.warehouse_id == null) {
    issues.push({
      severity: "error",
      code: "pick_slot_missing_warehouse",
      pickSku: slot.pick_sku,
      pickLocation: slot.pick_location_code,
      message: "Pick slot location is not assigned to a warehouse; replen source resolution is unsafe.",
    });
    return issues;
  }

  const { skuRule, ignoredProductRules } = chooseRule(slot, rules);
  const tierDefault = chooseTierDefault(slot, defaults);

  if (ignoredProductRules.length > 0 && !skuRule) {
    issues.push({
      severity: "warning",
      code: "ignored_product_level_rule",
      pickSku: slot.pick_sku,
      pickLocation: slot.pick_location_code,
      message: "Product-level replen rules exist, but runtime resolution currently only applies SKU-level pick_product_variant_id rules.",
      details: { ignoredRuleIds: ignoredProductRules.map((rule) => rule.id) },
    });
  }

  if (!skuRule && !tierDefault) {
    issues.push({
      severity: "error",
      code: "missing_replen_policy",
      pickSku: slot.pick_sku,
      pickLocation: slot.pick_location_code,
      message: "No SKU replen rule and no tier default applies to this pick slot.",
    });
    return issues;
  }

  const sourceLocationType = skuRule?.source_location_type ?? tierDefault?.source_location_type ?? "reserve";
  const sourceHierarchyLevel = tierDefault?.source_hierarchy_level ?? slot.pick_hierarchy_level;

  if (skuRule?.source_product_variant_id) {
    const sourceVariant = variantById.get(skuRule.source_product_variant_id);
    const sourceStocks = sourceStocksForVariant(skuRule.source_product_variant_id, sourceLocationType, slot.warehouse_id, stocksByVariant);
    if (!sourceVariant) {
      issues.push({
        severity: "error",
        code: "explicit_source_variant_missing",
        pickSku: slot.pick_sku,
        pickLocation: slot.pick_location_code,
        message: `SKU rule #${skuRule.id} points to missing source variant #${skuRule.source_product_variant_id}.`,
      });
    } else if (sourceStocks.length === 0) {
      issues.push({
        severity: "error",
        code: "explicit_source_no_stock",
        pickSku: slot.pick_sku,
        pickLocation: slot.pick_location_code,
        selectedSourceSku: sourceVariant.sku,
        message: `SKU rule #${skuRule.id} selects ${sourceVariant.sku}, but no valid ${sourceLocationType} source stock exists.`,
      });
    }
    return issues;
  }

  const productVariants = slot.product_id != null ? variantsByProduct.get(slot.product_id) ?? [] : [];
  const sourceVariants = sourceHierarchyLevel === slot.pick_hierarchy_level
    ? productVariants.filter((variant) => variant.id === slot.pick_variant_id)
    : productVariants.filter((variant) =>
        variant.id !== slot.pick_variant_id &&
        variant.hierarchy_level === sourceHierarchyLevel &&
        variant.is_active &&
        isValidCaseBreakSource(variant, slot)
      );

  const invalidSameLevel = productVariants.filter((variant) =>
    variant.id !== slot.pick_variant_id &&
    variant.hierarchy_level === sourceHierarchyLevel &&
    variant.is_active &&
    !isValidCaseBreakSource(variant, slot)
  );
  if (invalidSameLevel.length > 0) {
    issues.push({
      severity: "warning",
      code: "invalid_uom_source_candidates",
      pickSku: slot.pick_sku,
      pickLocation: slot.pick_location_code,
      message: "Some active source-level variants cannot cleanly replenish this pick UOM.",
      details: { variants: invalidSameLevel.map((variant) => ({ id: variant.id, sku: variant.sku, unitsPerVariant: variant.units_per_variant })) },
    });
  }

  if (sourceVariants.length === 0) {
    const sameVariantStocks = sourceStocksForVariant(slot.pick_variant_id, sourceLocationType, slot.warehouse_id, stocksByVariant);
    if (sameVariantStocks.length > 0) {
      issues.push({
        severity: "warning",
        code: "source_hierarchy_fallback_same_variant",
        pickSku: slot.pick_sku,
        pickLocation: slot.pick_location_code,
        selectedSourceSku: slot.pick_sku,
        selectedSourceLocation: sameVariantStocks[0].location_code,
        message: `No valid hierarchy level ${sourceHierarchyLevel} source variant exists; resolver will fall back to same-SKU ${sourceLocationType} stock.`,
      });
      return issues;
    }
    issues.push({
      severity: "error",
      code: "no_source_variant",
      pickSku: slot.pick_sku,
      pickLocation: slot.pick_location_code,
      message: `No valid active source variant exists at hierarchy level ${sourceHierarchyLevel}.`,
    });
    return issues;
  }

  const eligible = sourceVariants.flatMap((variant) => {
    const stocks = sourceStocksForVariant(variant.id, sourceLocationType, slot.warehouse_id, stocksByVariant);
    return stocks.map((stock) => ({
      variant,
      stock,
      slotRank: slotRank(stock),
      overfillUnits: Math.ceil(Math.max(1, slot.pick_qty) / units(variant)) * units(variant) - Math.max(1, slot.pick_qty),
    }));
  }).sort((a, b) => (
    a.slotRank - b.slotRank ||
    a.overfillUnits - b.overfillUnits ||
    units(a.variant) - units(b.variant) ||
    (a.stock.pick_sequence ?? Number.MAX_SAFE_INTEGER) - (b.stock.pick_sequence ?? Number.MAX_SAFE_INTEGER) ||
    a.variant.id - b.variant.id
  ));

  if (eligible.length === 0) {
    issues.push({
      severity: "error",
      code: "no_source_stock",
      pickSku: slot.pick_sku,
      pickLocation: slot.pick_location_code,
      message: `No valid ${sourceLocationType} source stock exists for source level ${sourceHierarchyLevel}.`,
      details: { checkedSourceSkus: sourceVariants.map((variant) => variant.sku) },
    });
    return issues;
  }

  const selected = eligible[0];
  if (eligible.length > 1) {
    issues.push({
      severity: "warning",
      code: "multiple_valid_source_candidates",
      pickSku: slot.pick_sku,
      pickLocation: slot.pick_location_code,
      selectedSourceSku: selected.variant.sku,
      selectedSourceLocation: selected.stock.location_code,
      message: "Multiple valid source candidates exist; resolver will choose deterministically, but an explicit SKU rule may be better.",
      details: {
        candidates: eligible.slice(0, 5).map((candidate) => ({
          sku: candidate.variant.sku,
          location: candidate.stock.location_code,
          qty: candidate.stock.variant_qty,
          slotRank: candidate.slotRank,
          overfillUnits: candidate.overfillUnits,
        })),
      },
    });
  }

  if (selected.slotRank > 0) {
    issues.push({
      severity: "warning",
      code: "source_stock_not_primary_slotted",
      pickSku: slot.pick_sku,
      pickLocation: slot.pick_location_code,
      selectedSourceSku: selected.variant.sku,
      selectedSourceLocation: selected.stock.location_code,
      message: "Selected source has physical stock but is not an active primary product-location slot.",
      details: { slotRank: selected.slotRank },
    });
  }

  return issues;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await loadDotenvIfAvailable();

  if (!process.env.DATABASE_URL && !process.env.EXTERNAL_DATABASE_URL) {
    throw new Error("DATABASE_URL or EXTERNAL_DATABASE_URL is required");
  }
  if (!process.env.EXTERNAL_DATABASE_URL && process.env.DATABASE_URL) {
    process.env.EXTERNAL_DATABASE_URL = process.env.DATABASE_URL;
  }

  const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
  const useSSL = Boolean(
    process.env.EXTERNAL_DATABASE_URL ||
    (process.env.DATABASE_URL && process.env.DATABASE_URL.includes("amazonaws.com"))
  );
  const pool = new Pool({
    connectionString,
    ssl: useSSL ? { rejectUnauthorized: false } : undefined,
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  try {
    const pickSlotsResult = await pool.query<PickSlot>(`
      SELECT
        pl.id AS product_location_id,
        pv.id AS pick_variant_id,
        pv.sku AS pick_sku,
        pv.name AS pick_name,
        pv.product_id,
        pv.hierarchy_level AS pick_hierarchy_level,
        pv.units_per_variant AS pick_units_per_variant,
        pv.parent_variant_id AS pick_parent_variant_id,
        wl.id AS pick_location_id,
        wl.code AS pick_location_code,
        wl.warehouse_id,
        COALESCE(il.variant_qty, 0)::int AS pick_qty
      FROM warehouse.product_locations pl
      JOIN catalog.product_variants pv ON pv.id = pl.product_variant_id
      JOIN warehouse.warehouse_locations wl ON wl.id = pl.warehouse_location_id
      LEFT JOIN inventory.inventory_levels il
        ON il.product_variant_id = pv.id
       AND il.warehouse_location_id = wl.id
      WHERE pl.status = 'active'
        AND pv.is_active = true
        AND wl.is_pickable = 1
        AND wl.is_active = 1
        AND wl.cycle_count_freeze_id IS NULL
        ${options.sku ? "AND pv.sku = $1" : ""}
      ORDER BY pv.sku, wl.code
    `, options.sku ? [options.sku] : []);

    const pickSlots = pickSlotsResult.rows;
    const productIds = Array.from(new Set(pickSlots.map((slot) => slot.product_id).filter((id): id is number => id != null)));

    const [rulesResult, defaultsResult, variantsResult, stocksResult] = await Promise.all([
      pool.query<ReplenRule>(`
        SELECT id, product_id, pick_product_variant_id, source_product_variant_id,
               source_location_type, source_priority, trigger_value, max_qty,
               replen_method, priority
        FROM inventory.replen_rules
        WHERE is_active = 1
        ORDER BY COALESCE(priority, 5), id
      `),
      pool.query<TierDefault>(`
        SELECT id, warehouse_id, hierarchy_level, source_hierarchy_level,
               source_location_type, source_priority, trigger_value, max_qty,
               replen_method, priority
        FROM inventory.replen_tier_defaults
        WHERE is_active = 1
        ORDER BY warehouse_id NULLS LAST, hierarchy_level, id
      `),
      pool.query<ProductVariant>(`
        SELECT id, product_id, sku, name, hierarchy_level, units_per_variant,
               parent_variant_id, position, is_active
        FROM catalog.product_variants
        WHERE product_id = ANY($1::int[])
        ORDER BY product_id, hierarchy_level, units_per_variant, id
      `, [productIds]),
      pool.query<StockRow>(`
        SELECT
          il.product_variant_id,
          wl.id AS location_id,
          wl.code AS location_code,
          wl.location_type,
          wl.is_pickable,
          wl.is_active,
          wl.cycle_count_freeze_id,
          wl.warehouse_id,
          wl.pick_sequence,
          il.variant_qty::int AS variant_qty,
          il.updated_at::text AS updated_at,
          pl.id AS product_location_id,
          pl.is_primary AS product_location_primary,
          pl.status AS product_location_status
        FROM inventory.inventory_levels il
        JOIN warehouse.warehouse_locations wl ON wl.id = il.warehouse_location_id
        LEFT JOIN warehouse.product_locations pl
          ON pl.product_variant_id = il.product_variant_id
         AND pl.warehouse_location_id = il.warehouse_location_id
        JOIN catalog.product_variants pv ON pv.id = il.product_variant_id
        WHERE pv.product_id = ANY($1::int[])
      `, [productIds]),
    ]);

    const variantsByProduct = new Map<number, ProductVariant[]>();
    const variantById = new Map<number, ProductVariant>();
    for (const variant of variantsResult.rows) {
      variantById.set(variant.id, variant);
      if (variant.product_id == null) continue;
      const existing = variantsByProduct.get(variant.product_id) ?? [];
      existing.push(variant);
      variantsByProduct.set(variant.product_id, existing);
    }

    const stocksByVariant = new Map<number, StockRow[]>();
    for (const stock of stocksResult.rows) {
      const existing = stocksByVariant.get(stock.product_variant_id) ?? [];
      existing.push(stock);
      stocksByVariant.set(stock.product_variant_id, existing);
    }

    const issues = pickSlots.flatMap((slot) =>
      auditSlot(slot, variantsByProduct, variantById, stocksByVariant, rulesResult.rows, defaultsResult.rows)
    );
    const errors = issues.filter((issue) => issue.severity === "error");
    const warnings = issues.filter((issue) => issue.severity === "warning");

    const result = {
      mode: "dry-run",
      scannedPickSlots: pickSlots.length,
      okPickSlots: pickSlots.length - new Set(issues.map((issue) => `${issue.pickSku}|${issue.pickLocation}`)).size,
      errors: errors.length,
      warnings: warnings.length,
      issueCounts: issues.reduce<Record<string, number>>((acc, issue) => {
        acc[issue.code] = (acc[issue.code] ?? 0) + 1;
        return acc;
      }, {}),
      samples: (options.issuesOnly ? issues : issues).slice(0, options.limit),
    };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

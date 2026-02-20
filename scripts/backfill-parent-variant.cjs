/**
 * Backfill parentVariantId for existing product variants.
 *
 * Strategy: For each product, sort variants by unitsPerVariant ascending.
 * Each variant's parent = the next-smaller variant (by unitsPerVariant).
 * The smallest variant has no parent (it's the base).
 *
 * Example: ARM-ENV-GRD has P10 (10), C60 (60), C100 (100)
 *   - P10 → parentVariantId = null (base)
 *   - C60 → parentVariantId = P10.id  (breaks into P10)
 *   - C100 → parentVariantId = P10.id (breaks into P10)
 *
 * For products with a 3-level hierarchy (P10, B50, C200):
 *   - P10 → null
 *   - B50 → P10 (next smaller)
 *   - C200 → B50 (next smaller)
 *
 * DRY RUN by default — pass --execute to actually update.
 *
 * Usage:
 *   node scripts/backfill-parent-variant.cjs           # dry run
 *   node scripts/backfill-parent-variant.cjs --execute  # apply changes
 */

const fs = require("fs");
const path = require("path");
const envPath = path.join(__dirname, "..", ".env");
const envContent = fs.readFileSync(envPath, "utf-8");
for (const line of envContent.split("\n")) {
  const idx = line.indexOf("=");
  if (idx > 0 && !line.startsWith("#")) {
    const key = line.substring(0, idx).trim();
    const val = line.substring(idx + 1).trim();
    if (key && val) process.env[key] = val;
  }
}
const { Client } = require("pg");

const DRY_RUN = !process.argv.includes("--execute");

async function main() {
  const client = new Client({
    connectionString: process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log(DRY_RUN ? "=== DRY RUN ===" : "=== EXECUTING ===");

  // Get all active variants grouped by product
  const { rows: variants } = await client.query(`
    SELECT id, product_id, sku, name, units_per_variant, hierarchy_level, parent_variant_id
    FROM product_variants
    WHERE is_active = true AND product_id IS NOT NULL
    ORDER BY product_id, units_per_variant ASC
  `);

  // Group by product
  const byProduct = new Map();
  for (const v of variants) {
    const arr = byProduct.get(v.product_id) || [];
    arr.push(v);
    byProduct.set(v.product_id, arr);
  }

  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalAlreadySet = 0;

  for (const [productId, productVariants] of byProduct) {
    if (productVariants.length < 2) {
      // Single-variant product — no parent to set
      continue;
    }

    // Sort by unitsPerVariant ascending
    productVariants.sort((a, b) => a.units_per_variant - b.units_per_variant);

    // The smallest variant is the base (parentVariantId = null)
    const base = productVariants[0];

    for (let i = 1; i < productVariants.length; i++) {
      const variant = productVariants[i];

      // Walk downward to find the largest smaller variant that divides evenly
      let parent = null;
      for (let j = i - 1; j >= 0; j--) {
        const candidate = productVariants[j];
        const ratio = variant.units_per_variant / candidate.units_per_variant;
        if (Number.isInteger(ratio) && ratio > 1) {
          parent = candidate;
          break;
        }
      }

      if (!parent) {
        console.warn(
          `  SKIP: ${variant.sku} (${variant.units_per_variant}) — no divisible smaller variant found`
        );
        totalSkipped++;
        continue;
      }

      const ratio = variant.units_per_variant / parent.units_per_variant;

      if (variant.parent_variant_id === parent.id) {
        totalAlreadySet++;
        continue;
      }

      console.log(
        `  ${variant.sku} (${variant.units_per_variant} units) → parent: ${parent.sku} (${parent.units_per_variant} units) [ratio ${ratio}:1]` +
          (variant.parent_variant_id
            ? ` (was: variant_id=${variant.parent_variant_id})`
            : "")
      );

      if (!DRY_RUN) {
        await client.query(
          `UPDATE product_variants SET parent_variant_id = $1, updated_at = NOW() WHERE id = $2`,
          [parent.id, variant.id]
        );
      }
      totalUpdated++;
    }
  }

  console.log(
    `\nSummary: ${totalUpdated} updated, ${totalAlreadySet} already correct, ${totalSkipped} skipped`
  );
  console.log(`Products with variants: ${byProduct.size}`);
  if (DRY_RUN) {
    console.log("\nThis was a DRY RUN. Pass --execute to apply changes.");
  }

  await client.end();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

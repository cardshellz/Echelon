import { pool } from "../server/db";
import path from "path";
import { fileURLToPath } from "url";
import {
  withdrawEbayProductListings,
  zeroEbayVariantListing,
} from "../server/routes/ebay/ebay-listing-state";
import { EBAY_CHANNEL_ID } from "../server/routes/ebay/ebay-utils";

interface Flags {
  execute: boolean;
  limit: number;
  productId?: number;
  variantId?: number;
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export function parseFlags(argv: string[]): Flags {
  const flags: Flags = { execute: false, limit: 50 };
  for (const arg of argv) {
    if (arg === "--execute") {
      flags.execute = true;
    } else if (arg === "--dry-run") {
      flags.execute = false;
    } else if (arg.startsWith("--limit=")) {
      flags.limit = parsePositiveInt(arg.slice("--limit=".length), "limit");
    } else if (arg.startsWith("--product-id=")) {
      flags.productId = parsePositiveInt(arg.slice("--product-id=".length), "productId");
    } else if (arg.startsWith("--variant-id=")) {
      flags.variantId = parsePositiveInt(arg.slice("--variant-id=".length), "variantId");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return flags;
}

async function findExcludedProductCandidates(flags: Flags) {
  const result = await pool.query(
    `
      SELECT DISTINCT
        p.id,
        p.sku,
        p.name
      FROM catalog.products p
      LEFT JOIN channels.channel_product_overrides cpo
        ON cpo.product_id = p.id
       AND cpo.channel_id = $1::integer
      JOIN catalog.product_variants pv ON pv.product_id = p.id
      JOIN channels.channel_listings cl
        ON cl.product_variant_id = pv.id
       AND cl.channel_id = $1::integer
       AND cl.sync_status = 'synced'
      WHERE (COALESCE(p.ebay_listing_excluded, false) = true OR COALESCE(cpo.is_listed, 1) = 0)
        AND ($2::integer IS NULL OR p.id = $2::integer)
      ORDER BY p.id
      LIMIT $3::integer
    `,
    [EBAY_CHANNEL_ID, flags.productId ?? null, flags.limit],
  );
  return result.rows as Array<{ id: number; sku: string | null; name: string }>;
}

async function findExcludedVariantCandidates(flags: Flags) {
  const result = await pool.query(
    `
      SELECT DISTINCT
        pv.id,
        pv.sku,
        p.id AS product_id,
        p.name AS product_name
      FROM catalog.product_variants pv
      JOIN catalog.products p ON p.id = pv.product_id
      LEFT JOIN channels.channel_product_overrides cpo
        ON cpo.product_id = p.id
       AND cpo.channel_id = $1::integer
      LEFT JOIN channels.channel_variant_overrides cvo
        ON cvo.product_variant_id = pv.id
       AND cvo.channel_id = $1::integer
      JOIN channels.channel_listings cl
        ON cl.product_variant_id = pv.id
       AND cl.channel_id = $1::integer
       AND cl.sync_status = 'synced'
      WHERE COALESCE(p.ebay_listing_excluded, false) = false
        AND COALESCE(cpo.is_listed, 1) <> 0
        AND (COALESCE(pv.ebay_listing_excluded, false) = true OR COALESCE(cvo.is_listed, 1) = 0)
        AND ($2::integer IS NULL OR pv.id = $2::integer)
      ORDER BY pv.id
      LIMIT $3::integer
    `,
    [EBAY_CHANNEL_ID, flags.variantId ?? null, flags.limit],
  );
  return result.rows as Array<{ id: number; sku: string | null; product_id: number; product_name: string }>;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const products = await findExcludedProductCandidates(flags);
  const remainingLimit = Math.max(0, flags.limit - products.length);
  const variants = remainingLimit > 0
    ? await findExcludedVariantCandidates({ ...flags, limit: remainingLimit })
    : [];

  console.log(
    `[eBay listing intent reconcile] mode=${flags.execute ? "execute" : "dry-run"} products=${products.length} variants=${variants.length} limit=${flags.limit}`,
  );

  for (const product of products) {
    console.log(`PRODUCT product=${product.id} sku=${product.sku ?? ""} name=${product.name}`);
    if (flags.execute) {
      const remote = await withdrawEbayProductListings(product.id);
      console.log(`  REMOTE ${remote.action} affected=${remote.affectedListings} ${remote.detail}`);
    }
  }

  for (const variant of variants) {
    console.log(`VARIANT variant=${variant.id} sku=${variant.sku ?? ""} product=${variant.product_id} name=${variant.product_name}`);
    if (flags.execute) {
      const remote = await zeroEbayVariantListing(variant.id);
      console.log(`  REMOTE ${remote.action} affected=${remote.affectedListings} ${remote.detail}`);
    }
  }
}

const isMain = process.argv[1]
  ? path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
  : false;

if (isMain) {
  main()
    .catch((err) => {
      console.error("[eBay listing intent reconcile] fatal:", err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}

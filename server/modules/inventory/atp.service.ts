import { eq, and, sql, inArray } from "drizzle-orm";
import {
  products,
  productVariants,
  inventoryLevels,
  channelFeeds,
  warehouseLocations,
} from "@shared/schema";

// ============================================================================
// Types
// ============================================================================

/** Aggregated base-unit totals across all variants and locations for a product. */
export interface BaseUnitTotals {
  onHand: number;
  reserved: number;
  picked: number;
  packed: number;
  backorder: number;
}

/** Per-variant ATP breakdown showing both base-unit pool and sellable variant units. */
export interface VariantAtp {
  productVariantId: number;
  sku: string;
  name: string;
  unitsPerVariant: number;
  /** Sellable units of THIS variant = floor(atpBase / unitsPerVariant) */
  atpUnits: number;
  /** Shared ATP pool in base units (same value for every variant of the product) */
  atpBase: number;
}

/** Channel-scoped ATP for variants listed on a specific sales channel. */
export interface ChannelVariantAtp {
  productVariantId: number;
  channelVariantId: string;
  atpUnits: number;
}

/** Full product-level ATP summary with variant detail. */
export interface ProductAtpSummary {
  productId: number;
  sku: string;
  name: string;
  totalOnHandBase: number;
  totalReservedBase: number;
  totalAtpBase: number;
  variants: Array<{
    productVariantId: number;
    sku: string;
    name: string;
    unitsPerVariant: number;
    atpUnits: number;
    /** Sum of variantQty across all warehouse locations */
    physicalQty: number;
  }>;
}

// ============================================================================
// Service
// ============================================================================

/**
 * Read-only service that calculates fungible Available-to-Promise (ATP)
 * for a multi-UOM inventory model.
 *
 * All inventory_levels quantities are stored in **variant units**. Base-unit
 * equivalents are computed at query time via `qty * product_variants.units_per_variant`.
 *
 * Key concept: all variants of the same product share a single pool of
 * "base units". A case, box, and pack of the same sleeve product all
 * draw from the same on-hand total expressed in the smallest sellable
 * unit (the pack). ATP is computed once in base units, then divided by
 * each variant's `unitsPerVariant` to get sellable quantities.
 *
 * This service never writes to the database.
 */
class InventoryAtpService {
  constructor(private readonly db: any) {}

  // --------------------------------------------------------------------------
  // 1. getTotalBaseUnits
  // --------------------------------------------------------------------------

  /**
   * Sum all inventory_levels across every variant of a product, converting
   * to base units via `qty * product_variants.units_per_variant`.
   *
   * @param productId - The product whose base-unit totals to compute.
   * @returns Aggregated base-unit totals. All fields default to 0.
   */
  async getTotalBaseUnits(productId: number): Promise<BaseUnitTotals> {
    const [row] = await this.db
      .select({
        onHand: sql<number>`COALESCE(SUM(${inventoryLevels.variantQty} * ${productVariants.unitsPerVariant}), 0)`,
        reserved: sql<number>`COALESCE(SUM(${inventoryLevels.reservedQty} * ${productVariants.unitsPerVariant}), 0)`,
        picked: sql<number>`COALESCE(SUM(${inventoryLevels.pickedQty} * ${productVariants.unitsPerVariant}), 0)`,
        packed: sql<number>`COALESCE(SUM(${inventoryLevels.packedQty} * ${productVariants.unitsPerVariant}), 0)`,
        backorder: sql<number>`COALESCE(SUM(${inventoryLevels.backorderQty} * ${productVariants.unitsPerVariant}), 0)`,
      })
      .from(inventoryLevels)
      .innerJoin(
        productVariants,
        eq(inventoryLevels.productVariantId, productVariants.id),
      )
      .where(eq(productVariants.productId, productId));

    return {
      onHand: Number(row.onHand),
      reserved: Number(row.reserved),
      picked: Number(row.picked),
      packed: Number(row.packed),
      backorder: Number(row.backorder),
    };
  }

  // --------------------------------------------------------------------------
  // 2. getAtpBase
  // --------------------------------------------------------------------------

  /**
   * Calculate the fungible ATP pool for a product in base units.
   *
   * Formula: ATP = totalOnHand - totalReserved - totalPicked - totalPacked
   */
  async getAtpBase(productId: number): Promise<number> {
    const totals = await this.getTotalBaseUnits(productId);
    return totals.onHand - totals.reserved - totals.picked - totals.packed;
  }

  // --------------------------------------------------------------------------
  // 2b. getAtpBaseByWarehouse
  // --------------------------------------------------------------------------

  /**
   * Calculate the fungible ATP pool for a product in base units,
   * scoped to a single warehouse.
   *
   * Used by channel sync to push per-warehouse quantities to
   * Shopify locations.
   */
  async getAtpBaseByWarehouse(
    productId: number,
    warehouseId: number,
  ): Promise<number> {
    const [row] = await this.db
      .select({
        onHand: sql<number>`COALESCE(SUM(${inventoryLevels.variantQty} * ${productVariants.unitsPerVariant}), 0)`,
        reserved: sql<number>`COALESCE(SUM(${inventoryLevels.reservedQty} * ${productVariants.unitsPerVariant}), 0)`,
        picked: sql<number>`COALESCE(SUM(${inventoryLevels.pickedQty} * ${productVariants.unitsPerVariant}), 0)`,
        packed: sql<number>`COALESCE(SUM(${inventoryLevels.packedQty} * ${productVariants.unitsPerVariant}), 0)`,
      })
      .from(inventoryLevels)
      .innerJoin(
        productVariants,
        eq(inventoryLevels.productVariantId, productVariants.id),
      )
      .innerJoin(
        warehouseLocations,
        eq(inventoryLevels.warehouseLocationId, warehouseLocations.id),
      )
      .where(
        and(
          eq(productVariants.productId, productId),
          eq(warehouseLocations.warehouseId, warehouseId),
        ),
      );

    const onHand = Number(row?.onHand ?? 0);
    const reserved = Number(row?.reserved ?? 0);
    const picked = Number(row?.picked ?? 0);
    const packed = Number(row?.packed ?? 0);
    return onHand - reserved - picked - packed;
  }

  /**
   * Per-variant ATP scoped to a single warehouse. Returns sellable
   * variant units for each active variant based on that warehouse's
   * inventory only.
   */
  async getAtpPerVariantByWarehouse(
    productId: number,
    warehouseId: number,
  ): Promise<VariantAtp[]> {
    const [atpBase, variants] = await Promise.all([
      this.getAtpBaseByWarehouse(productId, warehouseId),
      this.db
        .select({
          id: productVariants.id,
          sku: productVariants.sku,
          name: productVariants.name,
          unitsPerVariant: productVariants.unitsPerVariant,
        })
        .from(productVariants)
        .where(
          and(
            eq(productVariants.productId, productId),
            eq(productVariants.isActive, true),
          ),
        ),
    ]);

    return variants.map(
      (v: {
        id: number;
        sku: string | null;
        name: string;
        unitsPerVariant: number;
      }) => ({
        productVariantId: v.id,
        sku: v.sku ?? "",
        name: v.name,
        unitsPerVariant: v.unitsPerVariant,
        atpUnits: Math.floor(atpBase / v.unitsPerVariant),
        atpBase,
      }),
    );
  }

  // --------------------------------------------------------------------------
  // 3. getAtpPerVariant
  // --------------------------------------------------------------------------

  /**
   * For each active variant of a product, compute how many sellable
   * units can be promised based on the shared ATP pool.
   */
  async getAtpPerVariant(productId: number): Promise<VariantAtp[]> {
    const [atpBase, variants] = await Promise.all([
      this.getAtpBase(productId),
      this.db
        .select({
          id: productVariants.id,
          sku: productVariants.sku,
          name: productVariants.name,
          unitsPerVariant: productVariants.unitsPerVariant,
        })
        .from(productVariants)
        .where(
          and(
            eq(productVariants.productId, productId),
            eq(productVariants.isActive, true),
          ),
        ),
    ]);

    return variants.map(
      (v: {
        id: number;
        sku: string | null;
        name: string;
        unitsPerVariant: number;
      }) => ({
        productVariantId: v.id,
        sku: v.sku ?? "",
        name: v.name,
        unitsPerVariant: v.unitsPerVariant,
        atpUnits: Math.floor(atpBase / v.unitsPerVariant),
        atpBase,
      }),
    );
  }

  // --------------------------------------------------------------------------
  // 4. getAtpForChannel
  // --------------------------------------------------------------------------

  async getAtpForChannel(
    productId: number,
    channelId: number,
  ): Promise<ChannelVariantAtp[]> {
    const atpBase = await this.getAtpBase(productId);

    const { channels } = await import("@shared/schema");

    const feedRows = await this.db
      .select({
        productVariantId: productVariants.id,
        unitsPerVariant: productVariants.unitsPerVariant,
        channelVariantId: channelFeeds.channelVariantId,
      })
      .from(productVariants)
      .innerJoin(
        channelFeeds,
        eq(channelFeeds.productVariantId, productVariants.id),
      )
      .innerJoin(
        channels,
        eq(channels.provider, channelFeeds.channelType),
      )
      .where(
        and(
          eq(productVariants.productId, productId),
          eq(productVariants.isActive, true),
          eq(channels.id, channelId),
          eq(channelFeeds.isActive, 1),
        ),
      );

    return feedRows.map(
      (r: {
        productVariantId: number;
        unitsPerVariant: number;
        channelVariantId: string;
      }) => ({
        productVariantId: r.productVariantId,
        channelVariantId: r.channelVariantId,
        atpUnits: Math.floor(atpBase / r.unitsPerVariant),
      }),
    );
  }

  // --------------------------------------------------------------------------
  // 5. getProductSummary
  // --------------------------------------------------------------------------

  async getProductSummary(
    productId: number,
  ): Promise<ProductAtpSummary | null> {
    const [product] = await this.db
      .select({
        id: products.id,
        sku: products.sku,
        name: products.name,
      })
      .from(products)
      .where(eq(products.id, productId));

    if (!product) return null;

    const [totals, atpBase, variantPhysicals] = await Promise.all([
      this.getTotalBaseUnits(productId),
      this.getAtpBase(productId),
      this.db
        .select({
          productVariantId: productVariants.id,
          sku: productVariants.sku,
          name: productVariants.name,
          unitsPerVariant: productVariants.unitsPerVariant,
          physicalQty:
            sql<number>`COALESCE(SUM(${inventoryLevels.variantQty}), 0)`,
        })
        .from(productVariants)
        .leftJoin(
          inventoryLevels,
          eq(inventoryLevels.productVariantId, productVariants.id),
        )
        .where(
          and(
            eq(productVariants.productId, productId),
            eq(productVariants.isActive, true),
          ),
        )
        .groupBy(
          productVariants.id,
          productVariants.sku,
          productVariants.name,
          productVariants.unitsPerVariant,
        ),
    ]);

    return {
      productId: product.id,
      sku: product.sku ?? "",
      name: product.name,
      totalOnHandBase: totals.onHand,
      totalReservedBase: totals.reserved,
      totalAtpBase: atpBase,
      variants: variantPhysicals.map(
        (v: {
          productVariantId: number;
          sku: string | null;
          name: string;
          unitsPerVariant: number;
          physicalQty: number;
        }) => ({
          productVariantId: v.productVariantId,
          sku: v.sku ?? "",
          name: v.name,
          unitsPerVariant: v.unitsPerVariant,
          atpUnits: Math.floor(atpBase / v.unitsPerVariant),
          physicalQty: Number(v.physicalQty),
        }),
      ),
    };
  }

  // --------------------------------------------------------------------------
  // 6. getInventoryItemSummary (backward-compatible shape)
  // --------------------------------------------------------------------------

  async getInventoryItemSummary(productId: number): Promise<{
    productId: number;
    baseSku: string;
    name: string;
    totalOnHandPieces: number;
    totalReservedPieces: number;
    totalAtpPieces: number;
    variants: Array<{
      variantId: number;
      sku: string;
      name: string;
      unitsPerVariant: number;
      available: number;
      variantQty: number;
      reservedQty: number;
      pickedQty: number;
      atpPieces: number;
    }>;
  } | null> {
    const [product] = await this.db
      .select({ id: products.id, sku: products.sku, name: products.name })
      .from(products)
      .where(eq(products.id, productId));

    if (!product) return null;

    // Aggregate per-variant across all locations, computing base units via JOIN
    const variantRows = await this.db
      .select({
        productVariantId: productVariants.id,
        sku: productVariants.sku,
        name: productVariants.name,
        unitsPerVariant: productVariants.unitsPerVariant,
        variantQty: sql<number>`COALESCE(SUM(${inventoryLevels.variantQty}), 0)`,
        reservedQty: sql<number>`COALESCE(SUM(${inventoryLevels.reservedQty}), 0)`,
        pickedQty: sql<number>`COALESCE(SUM(${inventoryLevels.pickedQty}), 0)`,
        packedQty: sql<number>`COALESCE(SUM(${inventoryLevels.packedQty}), 0)`,
        // Base-unit equivalents computed on the fly
        onHandPieces: sql<number>`COALESCE(SUM(${inventoryLevels.variantQty} * ${productVariants.unitsPerVariant}), 0)`,
        reservedPieces: sql<number>`COALESCE(SUM(${inventoryLevels.reservedQty} * ${productVariants.unitsPerVariant}), 0)`,
        pickedPieces: sql<number>`COALESCE(SUM(${inventoryLevels.pickedQty} * ${productVariants.unitsPerVariant}), 0)`,
        packedPieces: sql<number>`COALESCE(SUM(${inventoryLevels.packedQty} * ${productVariants.unitsPerVariant}), 0)`,
      })
      .from(productVariants)
      .leftJoin(inventoryLevels, eq(inventoryLevels.productVariantId, productVariants.id))
      .where(eq(productVariants.productId, productId))
      .groupBy(
        productVariants.id,
        productVariants.sku,
        productVariants.name,
        productVariants.unitsPerVariant,
      );

    // Compute fungible ATP pool across ALL variants in base units (pieces)
    const totalOnHand = variantRows.reduce((s: number, v: any) => s + Number(v.onHandPieces), 0);
    const totalReserved = variantRows.reduce((s: number, v: any) => s + Number(v.reservedPieces), 0);
    const totalPicked = variantRows.reduce((s: number, v: any) => s + Number(v.pickedPieces), 0);
    const totalPacked = variantRows.reduce((s: number, v: any) => s + Number(v.packedPieces), 0);
    const totalAtpBase = totalOnHand - totalReserved - totalPicked - totalPacked;

    const variants = variantRows.map((v: any) => ({
      variantId: v.productVariantId,
      sku: v.sku ?? "",
      name: v.name,
      unitsPerVariant: v.unitsPerVariant,
      available: Math.floor(totalAtpBase / v.unitsPerVariant),
      variantQty: Number(v.variantQty),
      reservedQty: Number(v.reservedQty),
      pickedQty: Number(v.pickedQty),
      atpPieces: totalAtpBase,
    }));

    return {
      productId: product.id,
      baseSku: product.sku ?? "",
      name: product.name,
      totalOnHandPieces: totalOnHand,
      totalReservedPieces: totalReserved,
      totalAtpPieces: totalAtpBase,
      variants,
    };
  }

  // --------------------------------------------------------------------------
  // 7. getBulkAtp
  // --------------------------------------------------------------------------

  async getBulkAtp(productIds: number[]): Promise<Map<number, number>> {
    if (productIds.length === 0) return new Map();

    const rows = await this.db
      .select({
        productId: productVariants.productId,
        atp: sql<number>`
          COALESCE(SUM(${inventoryLevels.variantQty} * ${productVariants.unitsPerVariant}), 0)
          - COALESCE(SUM(${inventoryLevels.reservedQty} * ${productVariants.unitsPerVariant}), 0)
          - COALESCE(SUM(${inventoryLevels.pickedQty} * ${productVariants.unitsPerVariant}), 0)
          - COALESCE(SUM(${inventoryLevels.packedQty} * ${productVariants.unitsPerVariant}), 0)
        `,
      })
      .from(inventoryLevels)
      .innerJoin(
        productVariants,
        eq(inventoryLevels.productVariantId, productVariants.id),
      )
      .where(inArray(productVariants.productId, productIds))
      .groupBy(productVariants.productId);

    const result = new Map<number, number>();
    for (const row of rows) {
      result.set(row.productId, Number(row.atp));
    }
    return result;
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createInventoryAtpService(db: any) {
  return new InventoryAtpService(db);
}

import { eq, and, sql, inArray } from "drizzle-orm";
import {
  products,
  productVariants,
  inventoryLevels,
  channelFeeds,
  warehouseLocations,
} from "@shared/schema";
import { calculateFungibleAtpBase } from "./domain/inventory.domain";
import { createRecipeCapacityService, type RecipeCapacityService } from "./recipe-capacity.service";
import {
  calculateSellableVariantAtp,
  usesFungibleBaseUnitPool,
  type ProductInventoryStrategy,
} from "@shared/catalog/inventory-strategy";

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
  /** Sellable units under the product's configured inventory strategy. */
  atpUnits: number;
  /** Base-unit capacity represented by this variant's ATP calculation. */
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
  inventoryStrategy: ProductInventoryStrategy;
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
interface VariantPhysicalRow {
  productVariantId: number;
  sku: string | null;
  name: string;
  unitsPerVariant: number;
  physicalQty: number;
  reservedQty: number;
}

interface ProductSummaryVariantWithAtp {
  productVariantId: number;
  sku: string;
  name: string;
  unitsPerVariant: number;
  atpUnits: number;
  physicalQty: number;
  atpBase: number;
}

interface InventoryItemVariantSummary {
  variantId: number;
  sku: string;
  name: string;
  unitsPerVariant: number;
  available: number;
  variantQty: number;
  reservedQty: number;
  pickedQty: number;
  atpPieces: number;
}


// ============================================================================
// Service
// ============================================================================

/**
 * Read-only service that calculates Available-to-Promise (ATP) for a
 * strategy-aware multi-UOM inventory model.
 *
 * All inventory_levels quantities are stored in **variant units**. Base-unit
 * equivalents are computed at query time via `qty * product_variants.units_per_variant`.
 *
 * Package-hierarchy and recipe-managed products expose alternative sellable
 * capacities from a shared base-unit pool. Physical-only products expose each
 * variant strictly from that variant's own unreserved stock.
 *
 * This service never writes to the database.
 */
class InventoryAtpService {
  constructor(
    private readonly db: any,
    private readonly recipeCapacity: RecipeCapacityService,
  ) {}

  private async getRecipeVariantAtp(
    variants: Array<{ id: number; sku: string | null; name: string; unitsPerVariant: number }>,
    warehouseId?: number,
  ): Promise<VariantAtp[]> {
    return Promise.all(variants.map(async (variant) => {
      let atpUnits = 0;
      try {
        atpUnits = await this.recipeCapacity.getVariantCapacity(variant.id, warehouseId);
      } catch (error: any) {
        console.error(JSON.stringify({
          event: "recipe_atp_calculation_failed",
          productVariantId: variant.id,
          warehouseId: warehouseId ?? null,
          errorCode: error?.code ?? "RECIPE_ATP_UNKNOWN_ERROR",
          errorMessage: error?.message ?? String(error),
        }));
      }
      const atpBase = atpUnits * variant.unitsPerVariant;
      if (!Number.isSafeInteger(atpBase) || atpBase < 0) {
        throw new RangeError(`Recipe ATP base-unit conversion overflowed for variant ${variant.id}`);
      }
      return {
        productVariantId: variant.id,
        sku: variant.sku ?? "",
        name: variant.name,
        unitsPerVariant: variant.unitsPerVariant,
        atpUnits,
        atpBase,
      };
    }));
  }

  async getProductInventoryStrategy(
    productId: number,
    dbOverride: any = this.db,
  ): Promise<ProductInventoryStrategy> {
    const [product] = await dbOverride
      .select({ inventoryStrategy: products.inventoryStrategy })
      .from(products)
      .where(eq(products.id, productId));
    if (!product) {
      throw new Error(`Product ${productId} not found while calculating ATP`);
    }
    return product.inventoryStrategy;
  }

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
      .where(and(
        eq(productVariants.productId, productId),
        eq(productVariants.requiresShipping, true),
        sql`COALESCE(${productVariants.trackInventory}, true) = true`,
      ));

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
   * Formula: ATP = totalOnHand - totalReserved. Picked and packed units have
   * already left on-hand and remain visible only as workflow counters.
   */
  async getAtpBase(productId: number): Promise<number> {
    const totals = await this.getTotalBaseUnits(productId);
    return calculateFungibleAtpBase(totals);
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
    const result = await this.db.execute(sql`
      SELECT
        COALESCE(SUM(il.variant_qty * pv.units_per_variant), 0)::bigint as on_hand,
        COALESCE(SUM(il.reserved_qty * pv.units_per_variant), 0)::bigint as reserved,
        COALESCE(SUM(il.picked_qty * pv.units_per_variant), 0)::bigint as picked,
        COALESCE(SUM(il.packed_qty * pv.units_per_variant), 0)::bigint as packed
      FROM inventory.inventory_levels il
      JOIN catalog.product_variants pv ON pv.id = il.product_variant_id
      JOIN warehouse.warehouse_locations wl ON wl.id = il.warehouse_location_id
      WHERE pv.product_id = ${productId}
        AND pv.requires_shipping = true
        AND COALESCE(pv.track_inventory, true) = true
        AND (
        wl.warehouse_id = ${warehouseId}
        OR wl.warehouse_id IN (
          SELECT id FROM warehouse.warehouses WHERE hub_warehouse_id = ${warehouseId}
        )
      )
    `);
    const row = (result.rows as any[])[0] || {};
    const onHand = Number(row.on_hand ?? 0);
    const reserved = Number(row.reserved ?? 0);
    return onHand - reserved;
  }

  // --------------------------------------------------------------------------
  // 2c. getDirectVariantAtpByWarehouse
  // --------------------------------------------------------------------------

  /**
   * Per-variant ATP calculated directly from inventory_levels at a warehouse.
   *
   * Unlike getAtpPerVariantByWarehouse (which uses the shared base-unit pool),
   * this method computes ATP per-variant by summing across ALL inventory_levels
   * rows at the warehouse for each variant independently.
   *
   * Formula per variant:
   *   ATP = SUM(GREATEST(variant_qty - reserved_qty, 0))
   *   across all inventory_levels WHERE warehouse_location_id belongs to this warehouse.
   *
   * GREATEST(..., 0) is applied per-row so a negative bin doesn't drag down
   * positive bins.
   *
   * Used by the warehouse-aware sync orchestrator for per-location Shopify pushes.
   *
   * @param variantIds - The variant IDs to compute ATP for
   * @param warehouseId - The warehouse to scope to
   * @returns Map of variantId → ATP units (only includes variants with inventory)
   */
  async getDirectVariantAtpByWarehouse(
    variantIds: number[],
    warehouseId: number,
  ): Promise<Map<number, number>> {
    if (variantIds.length === 0) return new Map();

    // Include hub + spoke warehouses
    const idList = sql.join(variantIds.map(id => sql`${id}`), sql`, `);
    const rows = await this.db.execute(sql`
      SELECT 
        il.product_variant_id,
        SUM(GREATEST(il.variant_qty - il.reserved_qty, 0)) as atp
      FROM inventory.inventory_levels il
      JOIN catalog.product_variants pv ON pv.id = il.product_variant_id
      JOIN warehouse.warehouse_locations wl ON wl.id = il.warehouse_location_id
      WHERE il.product_variant_id IN (${idList})
        AND pv.requires_shipping = true
        AND COALESCE(pv.track_inventory, true) = true
        AND (
          wl.warehouse_id = ${warehouseId}
          OR wl.warehouse_id IN (
            SELECT id FROM warehouse.warehouses WHERE hub_warehouse_id = ${warehouseId}
          )
        )
      GROUP BY il.product_variant_id
    `);

    const result = new Map<number, number>();
    for (const row of rows.rows as any[]) {
      result.set(Number(row.product_variant_id), Math.max(0, Number(row.atp)));
    }

    // Variants with product_locations but no inventory_levels rows get 0
    for (const vid of variantIds) {
      if (!result.has(vid)) {
        result.set(vid, 0);
      }
    }

    return result;
  }

  private async getDirectVariantAtp(variantIds: number[]): Promise<Map<number, number>> {
    if (variantIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        productVariantId: inventoryLevels.productVariantId,
        atp: sql<number>`COALESCE(SUM(GREATEST(${inventoryLevels.variantQty} - ${inventoryLevels.reservedQty}, 0)), 0)`,
      })
      .from(inventoryLevels)
      .innerJoin(productVariants, eq(inventoryLevels.productVariantId, productVariants.id))
      .where(and(
        inArray(inventoryLevels.productVariantId, variantIds),
        eq(productVariants.requiresShipping, true),
        sql`COALESCE(${productVariants.trackInventory}, true) = true`,
      ))
      .groupBy(inventoryLevels.productVariantId);
    const result = new Map<number, number>();
    for (const row of rows) {
      result.set(Number(row.productVariantId), Math.max(0, Number(row.atp)));
    }
    for (const variantId of variantIds) {
      if (!result.has(variantId)) result.set(variantId, 0);
    }
    return result;
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
    const [inventoryStrategy, variants] = await Promise.all([
      this.getProductInventoryStrategy(productId),
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
            eq(productVariants.requiresShipping, true),
            sql`COALESCE(${productVariants.trackInventory}, true) = true`,
          ),
        ),
    ]);
    if (inventoryStrategy === "recipe_managed") {
      return this.getRecipeVariantAtp(variants, warehouseId);
    }
    const sharedAtpBase = usesFungibleBaseUnitPool(inventoryStrategy)
      ? await this.getAtpBaseByWarehouse(productId, warehouseId)
      : 0;
    const directAtp = usesFungibleBaseUnitPool(inventoryStrategy)
      ? new Map<number, number>()
      : await this.getDirectVariantAtpByWarehouse(variants.map((variant: any) => variant.id), warehouseId);

    return variants.map(
      (v: {
        id: number;
        sku: string | null;
        name: string;
        unitsPerVariant: number;
      }) => {
        const availability = calculateSellableVariantAtp({
          strategy: inventoryStrategy,
          unitsPerVariant: v.unitsPerVariant,
          sharedAtpBase,
          directAtpUnits: directAtp.get(v.id) ?? 0,
        });
        return {
          productVariantId: v.id,
          sku: v.sku ?? "",
          name: v.name,
          unitsPerVariant: v.unitsPerVariant,
          ...availability,
        };
      },
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
    const [inventoryStrategy, variants] = await Promise.all([
      this.getProductInventoryStrategy(productId),
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
            eq(productVariants.requiresShipping, true),
            sql`COALESCE(${productVariants.trackInventory}, true) = true`,
          ),
        ),
    ]);
    if (inventoryStrategy === "recipe_managed") {
      return this.getRecipeVariantAtp(variants);
    }
    const sharedAtpBase = usesFungibleBaseUnitPool(inventoryStrategy)
      ? await this.getAtpBase(productId)
      : 0;
    const directAtp = usesFungibleBaseUnitPool(inventoryStrategy)
      ? new Map<number, number>()
      : await this.getDirectVariantAtp(variants.map((variant: any) => variant.id));

    return variants.map(
      (v: {
        id: number;
        sku: string | null;
        name: string;
        unitsPerVariant: number;
      }) => {
        const availability = calculateSellableVariantAtp({
          strategy: inventoryStrategy,
          unitsPerVariant: v.unitsPerVariant,
          sharedAtpBase,
          directAtpUnits: directAtp.get(v.id) ?? 0,
        });
        return {
          productVariantId: v.id,
          sku: v.sku ?? "",
          name: v.name,
          unitsPerVariant: v.unitsPerVariant,
          ...availability,
        };
      },
    );
  }

  // --------------------------------------------------------------------------
  // 4. getAtpForChannel
  // --------------------------------------------------------------------------

  async getAtpForChannel(
    productId: number,
    channelId: number,
  ): Promise<ChannelVariantAtp[]> {
    const variants = await this.getAtpPerVariant(productId);
    const atpByVariant = new Map(variants.map((variant) => [variant.productVariantId, variant.atpUnits]));

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
          eq(productVariants.requiresShipping, true),
          sql`COALESCE(${productVariants.trackInventory}, true) = true`,
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
        atpUnits: atpByVariant.get(r.productVariantId) ?? 0,
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
        inventoryStrategy: products.inventoryStrategy,
      })
      .from(products)
      .where(eq(products.id, productId));

    if (!product) return null;

    const [totals, atpBase, variantPhysicals, variantAvailability] = await Promise.all([
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
          reservedQty:
            sql<number>`COALESCE(SUM(${inventoryLevels.reservedQty}), 0)`,
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
            eq(productVariants.requiresShipping, true),
            sql`COALESCE(${productVariants.trackInventory}, true) = true`,
          ),
        )
        .groupBy(
          productVariants.id,
          productVariants.sku,
          productVariants.name,
          productVariants.unitsPerVariant,
        ),
      this.getAtpPerVariant(productId),
    ]);

    const availabilityByVariant = new Map(
      variantAvailability.map((variant) => [variant.productVariantId, variant]),
    );
    const variants: ProductSummaryVariantWithAtp[] = variantPhysicals.map((variant: VariantPhysicalRow) => {
      const physicalQty = Number(variant.physicalQty);
      const reservedQty = Number(variant.reservedQty);
      const atp = availabilityByVariant.get(variant.productVariantId)
        ?? calculateSellableVariantAtp({
          strategy: product.inventoryStrategy,
          unitsPerVariant: variant.unitsPerVariant,
          sharedAtpBase: atpBase,
          directAtpUnits: Math.max(0, physicalQty - reservedQty),
        });
      return {
        productVariantId: variant.productVariantId,
        sku: variant.sku ?? "",
        name: variant.name,
        unitsPerVariant: variant.unitsPerVariant,
        atpUnits: atp.atpUnits,
        physicalQty,
        atpBase: atp.atpBase,
      };
    });
    const effectiveAtpBase = usesFungibleBaseUnitPool(product.inventoryStrategy)
      ? atpBase
      : variants.reduce((sum, variant) => sum + variant.atpBase, 0);

    return {
      productId: product.id,
      sku: product.sku ?? "",
      name: product.name,
      inventoryStrategy: product.inventoryStrategy,
      totalOnHandBase: totals.onHand,
      totalReservedBase: totals.reserved,
      totalAtpBase: effectiveAtpBase,
      variants: variants.map(({ atpBase: _atpBase, ...variant }) => variant),
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
      .select({
        id: products.id,
        sku: products.sku,
        name: products.name,
        inventoryStrategy: products.inventoryStrategy,
      })
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
      .where(and(
        eq(productVariants.productId, productId),
        eq(productVariants.requiresShipping, true),
        sql`COALESCE(${productVariants.trackInventory}, true) = true`,
      ))
      .groupBy(
        productVariants.id,
        productVariants.sku,
        productVariants.name,
        productVariants.unitsPerVariant,
      );

    // Compute the shared ATP pool across all variants in base units.
    const totalOnHand = variantRows.reduce((s: number, v: any) => s + Number(v.onHandPieces), 0);
    const totalReserved = variantRows.reduce((s: number, v: any) => s + Number(v.reservedPieces), 0);
    const totalPicked = variantRows.reduce((s: number, v: any) => s + Number(v.pickedPieces), 0);
    const totalPacked = variantRows.reduce((s: number, v: any) => s + Number(v.packedPieces), 0);
    const sharedAtpBase = totalOnHand - totalReserved - totalPicked - totalPacked;

    const recipeAvailability = product.inventoryStrategy === "recipe_managed"
      ? new Map((await this.getAtpPerVariant(productId)).map((variant) => [variant.productVariantId, variant]))
      : null;
    const variants: InventoryItemVariantSummary[] = variantRows.map((variant: any) => {
      const variantQty = Number(variant.variantQty);
      const reservedQty = Number(variant.reservedQty);
      const atp = recipeAvailability?.get(variant.productVariantId)
        ?? calculateSellableVariantAtp({
          strategy: product.inventoryStrategy,
          unitsPerVariant: variant.unitsPerVariant,
          sharedAtpBase,
          directAtpUnits: Math.max(0, variantQty - reservedQty),
        });
      return {
        variantId: variant.productVariantId,
        sku: variant.sku ?? "",
        name: variant.name,
        unitsPerVariant: variant.unitsPerVariant,
        available: atp.atpUnits,
        variantQty,
        reservedQty,
        pickedQty: Number(variant.pickedQty),
        atpPieces: atp.atpBase,
      };
    });
    const totalAtpBase = usesFungibleBaseUnitPool(product.inventoryStrategy)
      ? sharedAtpBase
      : variants.reduce((sum, variant) => sum + variant.atpPieces, 0);

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
      .where(and(
        inArray(productVariants.productId, productIds),
        eq(productVariants.requiresShipping, true),
        sql`COALESCE(${productVariants.trackInventory}, true) = true`,
      ))
      .groupBy(productVariants.productId);

    const result = new Map<number, number>();
    for (const row of rows) {
      result.set(row.productId, Number(row.atp));
    }

    const recipeProducts = await this.db
      .select({ id: products.id })
      .from(products)
      .where(and(
        inArray(products.id, productIds),
        eq(products.inventoryStrategy, "recipe_managed"),
      ));
    for (const product of recipeProducts) {
      const variants = await this.getAtpPerVariant(product.id);
      const recipeAtpBase = variants.reduce(
        (maximum, variant) => Math.max(maximum, variant.atpBase),
        0,
      );
      result.set(product.id, recipeAtpBase);
    }
    return result;
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createInventoryAtpService(db: any, recipeCapacity = createRecipeCapacityService(db)) {
  return new InventoryAtpService(db, recipeCapacity);
}

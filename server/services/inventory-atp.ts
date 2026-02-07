import { eq, and, sql, inArray } from "drizzle-orm";
import {
  products,
  productVariants,
  inventoryLevels,
  channelFeeds,
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
   * Sum all inventory_levels across every variant of a product.
   *
   * Because base units are fungible within a product, we aggregate
   * on_hand_base, reserved_base, picked_base, packed_base, and
   * backorder_base across ALL variants and ALL warehouse locations.
   *
   * @param productId - The product whose base-unit totals to compute.
   * @returns Aggregated base-unit totals. All fields default to 0 when
   *          no inventory records exist.
   */
  async getTotalBaseUnits(productId: number): Promise<BaseUnitTotals> {
    const [row] = await this.db
      .select({
        onHand: sql<number>`COALESCE(SUM(${inventoryLevels.onHandBase}), 0)`,
        reserved: sql<number>`COALESCE(SUM(${inventoryLevels.reservedBase}), 0)`,
        picked: sql<number>`COALESCE(SUM(${inventoryLevels.pickedBase}), 0)`,
        packed: sql<number>`COALESCE(SUM(${inventoryLevels.packedBase}), 0)`,
        backorder: sql<number>`COALESCE(SUM(${inventoryLevels.backorderBase}), 0)`,
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
   *
   * Reserved, picked, and packed units are all committed and therefore
   * unavailable for new order promises. Backorder is excluded from the
   * deduction because it represents future demand, not current stock
   * commitment.
   *
   * @param productId - The product to calculate ATP for.
   * @returns ATP in base units. May be negative when commitments exceed
   *          on-hand stock (over-promise scenario).
   */
  async getAtpBase(productId: number): Promise<number> {
    const totals = await this.getTotalBaseUnits(productId);
    return totals.onHand - totals.reserved - totals.picked - totals.packed;
  }

  // --------------------------------------------------------------------------
  // 3. getAtpPerVariant
  // --------------------------------------------------------------------------

  /**
   * For each active variant of a product, compute how many sellable
   * units can be promised based on the shared ATP pool.
   *
   * Every variant sees the SAME atpBase (the shared pool). The sellable
   * unit count is `floor(atpBase / unitsPerVariant)`.
   *
   * Example with atpBase = 1000 packs:
   *   - Pack  (unitsPerVariant=1)   → atpUnits = 1000
   *   - Box   (unitsPerVariant=5)   → atpUnits = 200
   *   - Case  (unitsPerVariant=100) → atpUnits = 10
   *
   * @param productId - The product whose variants to evaluate.
   * @returns Array of per-variant ATP, one entry per active variant.
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

  /**
   * Compute ATP for variants of a product that are listed on a specific
   * sales channel.
   *
   * Joins product_variants → channel_feeds (on productVariantId) and
   * filters to rows matching the given channelId via the channel_feeds
   * table. Only active channel_feed entries (isActive = 1) are included.
   *
   * @param productId  - The product to evaluate.
   * @param channelId  - Numeric channel ID. Matched against channel_feeds
   *                     rows by joining through the channels table.
   * @returns Array of channel-scoped ATPs with the external channel
   *          variant identifier.
   */
  async getAtpForChannel(
    productId: number,
    channelId: number,
  ): Promise<ChannelVariantAtp[]> {
    const atpBase = await this.getAtpBase(productId);

    // channel_feeds stores channelType (e.g. "shopify") rather than a
    // direct channelId FK.  We resolve the channel's provider first,
    // then filter channel_feeds by that type.
    //
    // Import `channels` lazily to keep the top-level import list lean;
    // this is the only method that needs it.
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

  /**
   * Build a comprehensive ATP summary for a single product.
   *
   * Includes:
   * - Product identity (id, sku, name)
   * - Aggregate base-unit totals (on-hand, reserved, ATP)
   * - Per-variant breakdown with sellable ATP and physical location counts
   *
   * Returns `null` if the product does not exist.
   *
   * @param productId - The product to summarise.
   */
  async getProductSummary(
    productId: number,
  ): Promise<ProductAtpSummary | null> {
    // Fetch product row
    const [product] = await this.db
      .select({
        id: products.id,
        sku: products.sku,
        name: products.name,
      })
      .from(products)
      .where(eq(products.id, productId));

    if (!product) return null;

    // Fetch totals, ATP, and per-variant physical quantities in parallel
    const [totals, atpBase, variantPhysicals] = await Promise.all([
      this.getTotalBaseUnits(productId),
      this.getAtpBase(productId),
      // Sum variantQty across all locations, grouped by variant
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

  /**
   * Returns an inventory summary in the legacy shape expected by existing
   * client pages (Inventory.tsx, etc.).
   *
   * Unlike `getProductSummary` (which returns fungible ATP and physicalQty),
   * this method includes per-variant onHandBase, reservedBase, and
   * per-variant atpBase so the client can render per-variant detail.
   *
   * @param productId - The product to summarise.
   * @returns Legacy-shaped summary, or `null` if product not found.
   */
  async getInventoryItemSummary(productId: number): Promise<{
    productId: number;
    baseSku: string;
    name: string;
    totalOnHandBase: number;
    totalReservedBase: number;
    totalAtpBase: number;
    variants: Array<{
      productVariantId: number;
      sku: string;
      name: string;
      unitsPerVariant: number;
      available: number;
      onHandBase: number;
      reservedBase: number;
      atpBase: number;
      variantQty: number;
    }>;
  } | null> {
    const [product] = await this.db
      .select({ id: products.id, sku: products.sku, name: products.name })
      .from(products)
      .where(eq(products.id, productId));

    if (!product) return null;

    const variantRows = await this.db
      .select({
        productVariantId: productVariants.id,
        sku: productVariants.sku,
        name: productVariants.name,
        unitsPerVariant: productVariants.unitsPerVariant,
        onHandBase: sql<number>`COALESCE(SUM(${inventoryLevels.onHandBase}), 0)`,
        reservedBase: sql<number>`COALESCE(SUM(${inventoryLevels.reservedBase}), 0)`,
        variantQty: sql<number>`COALESCE(SUM(${inventoryLevels.variantQty}), 0)`,
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

    const variants = variantRows.map((v: any) => {
      const onHand = Number(v.onHandBase);
      const reserved = Number(v.reservedBase);
      const atp = onHand - reserved;
      return {
        productVariantId: v.productVariantId,
        sku: v.sku ?? "",
        name: v.name,
        unitsPerVariant: v.unitsPerVariant,
        available: Math.floor(atp / v.unitsPerVariant),
        onHandBase: onHand,
        reservedBase: reserved,
        atpBase: atp,
        variantQty: Number(v.variantQty),
      };
    });

    const totalOnHand = variants.reduce((s: number, v: any) => s + v.onHandBase, 0);
    const totalReserved = variants.reduce((s: number, v: any) => s + v.reservedBase, 0);

    return {
      productId: product.id,
      baseSku: product.sku ?? "",
      name: product.name,
      totalOnHandBase: totalOnHand,
      totalReservedBase: totalReserved,
      totalAtpBase: totalOnHand - totalReserved,
      variants,
    };
  }

  // --------------------------------------------------------------------------
  // 7. getBulkAtp
  // --------------------------------------------------------------------------

  /**
   * Efficiently fetch ATP base units for many products in a single query.
   *
   * Uses a single SQL statement with `GROUP BY product_variants.product_id`
   * to avoid N+1 queries. Products with no inventory records are omitted
   * from the result map (implicitly ATP = 0).
   *
   * @param productIds - Array of product IDs to evaluate.
   * @returns Map from productId to ATP in base units.
   */
  async getBulkAtp(productIds: number[]): Promise<Map<number, number>> {
    if (productIds.length === 0) return new Map();

    const rows = await this.db
      .select({
        productId: productVariants.productId,
        atp: sql<number>`
          COALESCE(SUM(${inventoryLevels.onHandBase}), 0)
          - COALESCE(SUM(${inventoryLevels.reservedBase}), 0)
          - COALESCE(SUM(${inventoryLevels.pickedBase}), 0)
          - COALESCE(SUM(${inventoryLevels.packedBase}), 0)
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

/**
 * Create an InventoryAtpService instance bound to the given Drizzle
 * database client.
 *
 * @param db - A Drizzle ORM database instance (e.g. from `drizzle(pool)`).
 * @returns A new read-only ATP service.
 */
export function createInventoryAtpService(db: any) {
  return new InventoryAtpService(db);
}

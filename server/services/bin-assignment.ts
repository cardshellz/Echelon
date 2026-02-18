import { eq, and, sql } from "drizzle-orm";
import {
  productLocations,
  productVariants,
  products,
  warehouseLocations,
  inventoryLevels,
} from "@shared/schema";
import type {
  ProductLocation,
  ProductVariant,
  WarehouseLocation,
} from "@shared/schema";

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  execute: (query: any) => Promise<any>;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

/** Minimal storage interface — only the methods bin assignment needs. */
type Storage = {
  getProductVariantById: (id: number) => Promise<ProductVariant | undefined>;
  getProductVariantBySku: (sku: string) => Promise<ProductVariant | undefined>;
  getWarehouseLocationById: (id: number) => Promise<WarehouseLocation | undefined>;
  getWarehouseLocationByCode: (code: string) => Promise<WarehouseLocation | undefined>;
  getProductById: (id: number) => Promise<any | undefined>;
  getProductLocationById: (id: number) => Promise<ProductLocation | undefined>;
  deleteProductLocation: (id: number) => Promise<boolean>;
};

export type BinAssignmentRow = {
  productVariantId: number;
  productId: number;
  sku: string | null;
  productName: string;
  variantName: string;
  unitsPerVariant: number;
  productLocationId: number | null;
  assignedLocationCode: string | null;
  assignedLocationId: number | null;
  locationType: string | null;
  zone: string | null;
  isPrimary: number | null;
  currentQty: number | null;
};

export type AssignmentFilters = {
  search?: string;
  unassignedOnly?: boolean;
  zone?: string;
  warehouseId?: number;
};

export type ImportResult = {
  created: number;
  updated: number;
  errors: { row: number; sku: string; error: string }[];
};

/**
 * Bin Assignment service for Echelon WMS.
 *
 * Manages SKU-to-pick-bin assignments via the `product_locations` table.
 * Uses `warehouse_locations.is_pickable` as the authority for which
 * locations can receive assignments (NOT `product_locations.location_type`).
 */
export class BinAssignmentService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly storage: Storage,
  ) {}

  /**
   * Returns one row per active product variant, LEFT JOINed to its
   * pick-location assignment and current qty. Uses `wl.is_pickable = 1`
   * on the warehouse location rather than filtering on the stale
   * `product_locations.location_type` column.
   */
  async getAssignmentsView(filters?: AssignmentFilters): Promise<BinAssignmentRow[]> {
    const rows = await this.db.execute<{
      product_variant_id: number;
      product_id: number;
      sku: string | null;
      product_name: string;
      variant_name: string;
      units_per_variant: number;
      product_location_id: number | null;
      assigned_location_code: string | null;
      assigned_location_id: number | null;
      location_type: string | null;
      zone: string | null;
      is_primary: number | null;
      current_qty: number | null;
    }>(sql`
      SELECT
        pv.id AS product_variant_id,
        p.id AS product_id,
        COALESCE(pv.sku, p.sku) AS sku,
        COALESCE(p.title, p.name) AS product_name,
        pv.name AS variant_name,
        pv.units_per_variant,
        pl.id AS product_location_id,
        wl.code AS assigned_location_code,
        wl.id AS assigned_location_id,
        wl.location_type,
        wl.zone,
        pl.is_primary,
        il.variant_qty AS current_qty
      FROM product_variants pv
      JOIN products p ON pv.product_id = p.id
      LEFT JOIN product_locations pl ON pl.product_variant_id = pv.id
      LEFT JOIN warehouse_locations wl ON pl.warehouse_location_id = wl.id AND wl.is_pickable = 1
      LEFT JOIN inventory_levels il ON il.product_variant_id = pv.id AND il.warehouse_location_id = wl.id
      WHERE pv.is_active = true
      ${filters?.search ? sql`AND (UPPER(COALESCE(pv.sku, p.sku, '')) LIKE ${"%" + filters.search.toUpperCase() + "%"} OR UPPER(COALESCE(p.title, p.name, '')) LIKE ${"%" + filters.search.toUpperCase() + "%"})` : sql``}
      ${filters?.unassignedOnly ? sql`AND pl.id IS NULL` : sql``}
      ${filters?.zone ? sql`AND wl.zone = ${filters.zone.toUpperCase()}` : sql``}
      ${filters?.warehouseId ? sql`AND wl.warehouse_id = ${filters.warehouseId}` : sql``}
      ORDER BY COALESCE(pv.sku, p.sku) ASC
    `);

    return rows.rows.map((r: any) => ({
      productVariantId: r.product_variant_id,
      productId: r.product_id,
      sku: r.sku,
      productName: r.product_name,
      variantName: r.variant_name,
      unitsPerVariant: r.units_per_variant,
      productLocationId: r.product_location_id,
      assignedLocationCode: r.assigned_location_code,
      assignedLocationId: r.assigned_location_id,
      locationType: r.location_type,
      zone: r.zone,
      isPrimary: r.is_primary,
      currentQty: r.current_qty,
    }));
  }

  /**
   * Assign a product variant to a pickable warehouse location.
   * Validates that the target location has `is_pickable = 1`.
   * If the variant already has a pick assignment, moves it to the new location.
   */
  async assignVariantToLocation(params: {
    productVariantId: number;
    warehouseLocationId: number;
    isPrimary?: number;
  }): Promise<ProductLocation> {
    const variant = await this.storage.getProductVariantById(params.productVariantId);
    if (!variant) throw new Error(`Variant ${params.productVariantId} not found`);

    const loc = await this.storage.getWarehouseLocationById(params.warehouseLocationId);
    if (!loc) throw new Error(`Warehouse location ${params.warehouseLocationId} not found`);

    if (loc.isPickable !== 1) {
      throw new Error(`Location ${loc.code} is not pickable — cannot assign SKUs to non-pick locations`);
    }

    const product = await this.storage.getProductById(variant.productId);

    // Check for existing assignment for this variant
    const existing = await this.db
      .select()
      .from(productLocations)
      .where(eq(productLocations.productVariantId, params.productVariantId));

    const isPrimary = params.isPrimary ?? 1;

    if (existing.length > 0) {
      // Update existing assignment to new location
      const result = await this.db
        .update(productLocations)
        .set({
          warehouseLocationId: params.warehouseLocationId,
          location: loc.code,
          zone: loc.zone || "U",
          isPrimary,
          updatedAt: new Date(),
        })
        .where(eq(productLocations.id, existing[0].id))
        .returning();
      return result[0];
    }

    // Clear isPrimary on other locations for same product if setting this as primary
    if (isPrimary === 1) {
      await this.db
        .update(productLocations)
        .set({ isPrimary: 0, updatedAt: new Date() })
        .where(eq(productLocations.productId, variant.productId));
    }

    // Insert new assignment
    const result = await this.db
      .insert(productLocations)
      .values({
        productId: variant.productId,
        productVariantId: params.productVariantId,
        sku: (variant.sku || product?.sku || "").toUpperCase() || null,
        name: product?.name || variant.name,
        location: loc.code,
        zone: loc.zone || "U",
        warehouseLocationId: params.warehouseLocationId,
        isPrimary,
        status: "active",
        barcode: variant.barcode || null,
      })
      .returning();
    return result[0];
  }

  /**
   * Remove a bin assignment. Returns the deleted row for pick-queue sync.
   */
  async unassignVariant(productLocationId: number): Promise<ProductLocation | undefined> {
    const existing = await this.storage.getProductLocationById(productLocationId);
    if (!existing) return undefined;

    const deleted = await this.storage.deleteProductLocation(productLocationId);
    return deleted ? existing : undefined;
  }

  /**
   * Bulk import assignments from CSV rows. Validates each row:
   * - SKU must resolve to an active product variant
   * - Location code must resolve to a pickable warehouse location
   */
  async importAssignments(
    rows: { sku: string; locationCode: string }[],
  ): Promise<ImportResult> {
    const results: ImportResult = { created: 0, updated: 0, errors: [] };

    for (let i = 0; i < rows.length; i++) {
      const { sku, locationCode } = rows[i];
      try {
        if (!sku || !locationCode) {
          results.errors.push({ row: i + 1, sku: sku || "", error: "Missing sku or locationCode" });
          continue;
        }

        const variant = await this.storage.getProductVariantBySku(sku.toUpperCase());
        if (!variant) {
          results.errors.push({ row: i + 1, sku, error: `Variant not found for SKU: ${sku}` });
          continue;
        }

        const loc = await this.storage.getWarehouseLocationByCode(locationCode.toUpperCase());
        if (!loc) {
          results.errors.push({ row: i + 1, sku, error: `Location not found: ${locationCode}` });
          continue;
        }

        if (loc.isPickable !== 1) {
          results.errors.push({ row: i + 1, sku, error: `Location ${locationCode} is not pickable` });
          continue;
        }

        // Check if variant already has an assignment
        const existingResult = await this.db
          .select()
          .from(productLocations)
          .where(eq(productLocations.productVariantId, variant.id));

        await this.assignVariantToLocation({
          productVariantId: variant.id,
          warehouseLocationId: loc.id,
        });

        if (existingResult.length > 0) {
          results.updated++;
        } else {
          results.created++;
        }
      } catch (e: any) {
        results.errors.push({ row: i + 1, sku: sku || "", error: e.message });
      }
    }

    return results;
  }

  /**
   * Export all assigned variants as a CSV string.
   */
  async exportAssignments(): Promise<string> {
    const assignments = await this.getAssignmentsView();
    const assigned = assignments.filter((a) => a.productLocationId !== null);

    const csvHeader =
      "sku,product_name,variant_name,location_code,zone,is_primary,current_qty\n";
    const csvRows = assigned
      .map(
        (a) =>
          `"${a.sku || ""}","${(a.productName || "").replace(/"/g, '""')}","${(a.variantName || "").replace(/"/g, '""')}","${a.assignedLocationCode || ""}","${a.zone || ""}",${a.isPrimary || 0},${a.currentQty || 0}`,
      )
      .join("\n");

    return csvHeader + csvRows;
  }
}

// Factory function
export function createBinAssignmentService(
  db: DrizzleDb,
  storage: Storage,
): BinAssignmentService {
  return new BinAssignmentService(db, storage);
}

import { eq, and, sql } from "drizzle-orm";
import { backfillOpenOrderItemBinAssignment } from "../orders/bin-location-backfill";
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
  slotStatus: "valid" | "unassigned" | "invalid" | "duplicate";
  slotIssue: string | null;
  assignmentCount: number;
  validAssignmentCount: number;
  suggestedLocationId: number | null;
  suggestedLocationCode: string | null;
  suggestedLocationZone: string | null;
  suggestedQty: number | null;
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
    const rows = await this.db.execute(sql`
      WITH variant_base AS (
        SELECT
          pv.id AS product_variant_id,
          p.id AS product_id,
          COALESCE(pv.sku, p.sku) AS sku,
          p.name AS product_name,
          pv.name AS variant_name,
          pv.units_per_variant
        FROM catalog.product_variants pv
        JOIN catalog.products p ON pv.product_id = p.id
        WHERE pv.is_active = true
          ${filters?.search ? sql`AND (UPPER(COALESCE(pv.sku, p.sku, '')) LIKE ${"%" + filters.search.toUpperCase() + "%"} OR UPPER(COALESCE(p.title, p.name, '')) LIKE ${"%" + filters.search.toUpperCase() + "%"})` : sql``}
      ),
      active_assignments AS (
        SELECT
          vb.*,
          pl.id AS product_location_id,
          pl.location AS legacy_location_code,
          wl.code AS assigned_location_code,
          wl.id AS assigned_location_id,
          wl.location_type,
          wl.zone,
          wl.warehouse_id,
          wl.is_pickable,
          wl.is_active,
          pl.is_primary,
          il.variant_qty AS current_qty,
          CASE
            WHEN pl.id IS NULL THEN NULL
            WHEN pl.warehouse_location_id IS NULL OR wl.id IS NULL THEN 'assignment_missing_location'
            WHEN wl.warehouse_id IS NULL THEN 'location_missing_warehouse'
            WHEN wl.is_active <> 1 THEN 'location_inactive'
            WHEN wl.location_type <> 'pick' OR wl.is_pickable <> 1 THEN 'assignment_not_pick_face'
            ELSE NULL
          END AS slot_issue,
          CASE
            WHEN wl.id IS NOT NULL
             AND wl.warehouse_id IS NOT NULL
             AND wl.is_active = 1
             AND wl.location_type = 'pick'
             AND wl.is_pickable = 1
            THEN 1 ELSE 0
          END AS valid_pick_face
        FROM variant_base vb
        LEFT JOIN warehouse.product_locations pl
          ON pl.status = 'active'
         AND (
           pl.product_variant_id = vb.product_variant_id
           OR (
             pl.product_variant_id IS NULL
             AND pl.sku IS NOT NULL
             AND UPPER(pl.sku) = UPPER(COALESCE(vb.sku, ''))
           )
         )
        LEFT JOIN warehouse.warehouse_locations wl ON pl.warehouse_location_id = wl.id
        LEFT JOIN inventory.inventory_levels il
          ON il.product_variant_id = vb.product_variant_id
         AND il.warehouse_location_id = wl.id
      ),
      assignment_counts AS (
        SELECT
          product_variant_id,
          COUNT(product_location_id) AS assignment_count,
          COALESCE(SUM(valid_pick_face), 0) AS valid_assignment_count
        FROM active_assignments
        GROUP BY product_variant_id
      ),
      pick_stock_suggestions AS (
        SELECT DISTINCT ON (il.product_variant_id)
          il.product_variant_id,
          wl.id AS suggested_location_id,
          wl.code AS suggested_location_code,
          wl.zone AS suggested_location_zone,
          il.variant_qty AS suggested_qty
        FROM inventory.inventory_levels il
        JOIN warehouse.warehouse_locations wl ON wl.id = il.warehouse_location_id
        WHERE il.variant_qty > 0
          AND wl.warehouse_id IS NOT NULL
          AND wl.is_active = 1
          AND wl.location_type = 'pick'
          AND wl.is_pickable = 1
        ORDER BY
          il.product_variant_id,
          il.variant_qty DESC,
          wl.pick_sequence NULLS LAST,
          wl.code ASC
      )
      SELECT
        aa.product_variant_id,
        aa.product_id,
        aa.sku,
        aa.product_name,
        aa.variant_name,
        aa.units_per_variant,
        aa.product_location_id,
        COALESCE(aa.assigned_location_code, aa.legacy_location_code) AS assigned_location_code,
        aa.assigned_location_id,
        aa.location_type,
        aa.zone,
        aa.is_primary,
        aa.current_qty,
        CASE
          WHEN aa.product_location_id IS NULL THEN 'unassigned'
          WHEN aa.slot_issue IS NOT NULL THEN 'invalid'
          WHEN COALESCE(ac.assignment_count, 0) > 1 THEN 'duplicate'
          ELSE 'valid'
        END AS slot_status,
        aa.slot_issue,
        COALESCE(ac.assignment_count, 0) AS assignment_count,
        COALESCE(ac.valid_assignment_count, 0) AS valid_assignment_count,
        pss.suggested_location_id,
        pss.suggested_location_code,
        pss.suggested_location_zone,
        pss.suggested_qty
      FROM active_assignments aa
      JOIN assignment_counts ac ON ac.product_variant_id = aa.product_variant_id
      LEFT JOIN pick_stock_suggestions pss ON pss.product_variant_id = aa.product_variant_id
      WHERE 1 = 1
      ${filters?.unassignedOnly ? sql`AND aa.product_location_id IS NULL` : sql``}
      ${filters?.zone ? sql`AND aa.zone = ${filters.zone.toUpperCase()}` : sql``}
      ${filters?.warehouseId ? sql`AND aa.warehouse_id = ${filters.warehouseId}` : sql``}
      ORDER BY
        aa.sku ASC,
        CASE
          WHEN aa.slot_issue IS NOT NULL THEN 0
          WHEN COALESCE(ac.assignment_count, 0) > 1 THEN 1
          WHEN aa.product_location_id IS NULL THEN 2
          ELSE 3
        END,
        aa.is_primary DESC NULLS LAST,
        aa.assigned_location_code ASC NULLS LAST
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
      slotStatus: r.slot_status,
      slotIssue: r.slot_issue,
      assignmentCount: Number(r.assignment_count || 0),
      validAssignmentCount: Number(r.valid_assignment_count || 0),
      suggestedLocationId: r.suggested_location_id,
      suggestedLocationCode: r.suggested_location_code,
      suggestedLocationZone: r.suggested_location_zone,
      suggestedQty: r.suggested_qty,
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

    if (loc.isActive !== 1) {
      throw new Error(`Location ${loc.code} is inactive - cannot assign SKUs to inactive locations`);
    }

    if (loc.warehouseId == null) {
      throw new Error(`Location ${loc.code} is not assigned to a warehouse - cannot assign SKUs to orphan locations`);
    }

    if (loc.locationType !== "pick" || loc.isPickable !== 1) {
      throw new Error(`Location ${loc.code} is not a pick face - cannot assign SKUs to non-pick locations`);
    }

    const product = await this.storage.getProductById(variant.productId);

    const isPrimary = params.isPrimary ?? 1;
    const upperSku = (variant.sku || product?.sku || "").toUpperCase();

    const assigned = await this.db.transaction(async (tx) => {
      const existingResult = await tx.execute(sql`
        SELECT pl.id
        FROM warehouse.product_locations pl
        LEFT JOIN warehouse.warehouse_locations wl ON wl.id = pl.warehouse_location_id
        WHERE pl.status = 'active'
          AND (
            pl.product_variant_id = ${params.productVariantId}
            OR (
              pl.product_variant_id IS NULL
              AND pl.sku IS NOT NULL
              AND UPPER(pl.sku) = ${upperSku}
            )
          )
        ORDER BY
          CASE WHEN pl.warehouse_location_id = ${params.warehouseLocationId} THEN 0 ELSE 1 END,
          CASE
            WHEN wl.id IS NOT NULL
             AND wl.warehouse_id IS NOT NULL
             AND wl.is_active = 1
             AND wl.location_type = 'pick'
             AND wl.is_pickable = 1
            THEN 0 ELSE 1
          END,
          pl.is_primary DESC,
          pl.updated_at DESC,
          pl.id ASC
      `);
      const existingIds = existingResult.rows.map((row: any) => Number(row.id)).filter(Number.isInteger);
      const canonicalId = existingIds[0];

      if (isPrimary === 1) {
        await tx.execute(sql`
          UPDATE warehouse.product_locations
          SET is_primary = 0, updated_at = NOW()
          WHERE status = 'active'
            AND (
              product_variant_id = ${params.productVariantId}
              OR (
                product_variant_id IS NULL
                AND sku IS NOT NULL
                AND UPPER(sku) = ${upperSku}
              )
            )
        `);
      }

      if (canonicalId) {
        const result = await tx
          .update(productLocations)
          .set({
            productId: variant.productId,
            productVariantId: params.productVariantId,
            sku: upperSku || null,
            name: product?.name || variant.name,
            barcode: variant.barcode || null,
            warehouseLocationId: params.warehouseLocationId,
            location: loc.code,
            zone: loc.zone || "U",
            isPrimary,
            status: "active",
            updatedAt: new Date(),
          })
          .where(eq(productLocations.id, canonicalId))
          .returning();

        if (existingIds.length > 1) {
          await tx.execute(sql`
            DELETE FROM warehouse.product_locations
            WHERE id <> ${canonicalId}
              AND (
                product_variant_id = ${params.productVariantId}
                OR (
                  product_variant_id IS NULL
                  AND sku IS NOT NULL
                  AND UPPER(sku) = ${upperSku}
                )
              )
          `);
        }

        return result[0];
      }

      const result = await tx
        .insert(productLocations)
        .values({
          productId: variant.productId,
          productVariantId: params.productVariantId,
          sku: upperSku || null,
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
    });

    // After the assignment commits, stamp the new bin onto open order items
    // that were synced while this SKU had no bin (they carry "UNASSIGNED"
    // forever otherwise — the picker gun never updates). Best-effort; never
    // fails the assignment.
    await backfillOpenOrderItemBinAssignment({
      sku: assigned?.sku ?? upperSku,
      locationCode: assigned?.location,
      zone: assigned?.zone,
    });

    return assigned;
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
    const assigned = assignments.filter((a) =>
      a.productLocationId !== null &&
      a.slotIssue == null &&
      a.assignedLocationCode
    );

    const csvHeader =
      "sku,product_name,variant_name,location_code,zone,is_primary,current_qty,slot_status\n";
    const csvRows = assigned
      .map(
        (a) =>
          `"${a.sku || ""}","${(a.productName || "").replace(/"/g, '""')}","${(a.variantName || "").replace(/"/g, '""')}","${a.assignedLocationCode || ""}","${a.zone || ""}",${a.isPrimary || 0},${a.currentQty || 0},"${a.slotStatus}"`,
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

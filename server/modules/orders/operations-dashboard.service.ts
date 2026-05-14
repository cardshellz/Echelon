/**
 * Operations Dashboard service for Echelon WMS.
 *
 * Pure read-only analytics — no side effects, only dependency is `db`.
 * Provides bin inventory views, location health KPIs, exception detection,
 * pick readiness, activity history, and a unified action queue.
 */

import { sql, inArray } from "drizzle-orm";
import { inventoryLevels } from "@shared/schema";
import { getSettingsForWarehouse } from "../warehouse/settings.resolver";

// ── Minimal DB duck-type ────────────────────────────────────────────
type DrizzleDb = {
  execute: (query: any) => Promise<{ rows: any[] }>;
};

// ── Error class ─────────────────────────────────────────────────────
class OperationsDashboardError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = "OperationsDashboardError";
  }
}

// ── Sort expression helpers ─────────────────────────────────────────
type SortExpr = { asc: ReturnType<typeof sql>; desc: ReturnType<typeof sql> };

const BIN_SORT_EXPRESSIONS: Record<string, SortExpr> = {
  code: { asc: sql`wl.code ASC`, desc: sql`wl.code DESC` },
  qty: { asc: sql`total_variant_qty ASC, wl.code ASC`, desc: sql`total_variant_qty DESC, wl.code ASC` },
  skus: { asc: sql`sku_count ASC, wl.code ASC`, desc: sql`sku_count DESC, wl.code ASC` },
  reserved: { asc: sql`total_reserved_qty ASC, wl.code ASC`, desc: sql`total_reserved_qty DESC, wl.code ASC` },
  zone: { asc: sql`wl.zone ASC, wl.code ASC`, desc: sql`wl.zone DESC, wl.code ASC` },
  type: { asc: sql`wl.location_type ASC, wl.code ASC`, desc: sql`wl.location_type DESC, wl.code ASC` },
};

const ACTION_QUEUE_SORT_EXPRESSIONS: Record<string, SortExpr> = {
  priority: { asc: sql`priority ASC, location_code ASC`, desc: sql`priority DESC NULLS LAST, location_code ASC` },
  type: { asc: sql`type ASC, priority ASC`, desc: sql`type DESC, priority ASC` },
  location: { asc: sql`location_code ASC`, desc: sql`location_code DESC` },
  sku: { asc: sql`sku ASC NULLS LAST`, desc: sql`sku DESC NULLS LAST` },
  qty: { asc: sql`qty ASC NULLS LAST`, desc: sql`qty DESC NULLS LAST` },
};

const VALID_ACTION_FILTERS = ["all", "negative_inventory", "aging_receiving", "pallet_drop", "stuck_replen", "stale_bin"] as const;
const VALID_PICK_REPLEN_HEALTH_FILTERS = [
  "all",
  "stuck_replen",
  "replen_backlog",
  "stale_replen_no_demand",
  "duplicate_replen",
  "short_pick_unresolved",
  "open_allocation_exception",
  "allocation_review_needed",
  "cycle_count_review",
  "exception_order_no_blocker",
  "pick_bin_needs_replen",
] as const;

// ── Public param types ──────────────────────────────────────────────

export interface BinInventoryParams {
  warehouseId?: number | null;
  zone?: string | null;
  locationType?: string | null;
  binType?: string | null;
  search?: string | null;
  hasInventory?: boolean | null;
  page?: number;
  pageSize?: number;
  sortField?: string;
  sortDir?: "asc" | "desc";
}

export interface UnassignedInventoryParams {
  page?: number;
  pageSize?: number;
}

export interface LocationHealthParams {
  warehouseId?: number | null;
  staleDays?: number;
}

export interface ExceptionsParams {
  warehouseId?: number | null;
  staleDays?: number;
}

export interface PickReadinessParams {
  warehouseId?: number | null;
  threshold?: number;
}

export interface ActivityParams {
  locationId?: number | null;
  variantId?: number | null;
  limit?: number;
}

export interface ActionQueueParams {
  warehouseId?: number | null;
  filter?: string;
  search?: string;
  page?: number;
  pageSize?: number;
  sortField?: string;
  sortDir?: "asc" | "desc";
}

export interface PickReplenHealthParams {
  warehouseId?: number | null;
  filter?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

// ── Service class ───────────────────────────────────────────────────

export class OperationsDashboardService {
  constructor(private db: DrizzleDb) {}

  // ─── 1. Bin Inventory ───────────────────────────────────────────

  async getBinInventory(params: BinInventoryParams) {
    const {
      warehouseId = null,
      zone = null,
      locationType = null,
      binType = null,
      search = null,
      hasInventory = null,
    } = params;
    const page = Math.max(1, params.page || 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize || 50));
    const offset = (page - 1) * pageSize;

    const sortKey = params.sortField && params.sortField in BIN_SORT_EXPRESSIONS
      ? params.sortField
      : "code";
    const sortDir = params.sortDir === "desc" ? "desc" : "asc";
    const orderClause = BIN_SORT_EXPRESSIONS[sortKey][sortDir];

    // Compose filter fragments
    const whFilter = warehouseId ? sql`AND wl.warehouse_id = ${warehouseId}` : sql``;
    const zoneFilter = zone ? sql`AND wl.zone = ${zone}` : sql``;
    const ltFilter = locationType ? sql`AND wl.location_type = ${locationType}` : sql``;
    const btFilter = binType ? sql`AND wl.bin_type = ${binType}` : sql``;
    const searchFilter = search
      ? sql`AND LOWER(wl.code) LIKE ${"%" + search.toLowerCase() + "%"}`
      : sql``;
    const hasInvFilter =
      hasInventory === true
        ? sql`AND EXISTS (SELECT 1 FROM inventory.inventory_levels il2 WHERE il2.warehouse_location_id = wl.id AND il2.variant_qty > 0)`
        : hasInventory === false
          ? sql`AND NOT EXISTS (SELECT 1 FROM inventory.inventory_levels il2 WHERE il2.warehouse_location_id = wl.id AND il2.variant_qty > 0)`
          : sql``;

    // Count total for pagination
    const countResult = await this.db.execute(sql`
      SELECT COUNT(*)::int as total FROM warehouse.warehouse_locations wl
      WHERE 1=1 ${whFilter} ${zoneFilter} ${ltFilter} ${btFilter} ${searchFilter} ${hasInvFilter}
    `);
    const total = Number((countResult.rows[0] as any)?.total) || 0;

    // Get bins with aggregated inventory
    const binsResult = await this.db.execute(sql`
      SELECT
        wl.id as location_id,
        wl.code as location_code,
        wl.zone,
        wl.location_type,
        wl.bin_type,
        wl.is_pickable,
        wl.warehouse_id,
        wl.capacity_cubic_mm,
        w.code as warehouse_code,
        COUNT(DISTINCT CASE WHEN il.variant_qty > 0 THEN il.product_variant_id END)::int as sku_count,
        COALESCE(SUM(CASE WHEN il.variant_qty > 0 THEN il.variant_qty ELSE 0 END), 0)::int as total_variant_qty,
        COALESCE(SUM(CASE WHEN il.variant_qty > 0 THEN il.reserved_qty ELSE 0 END), 0)::int as total_reserved_qty
      FROM warehouse.warehouse_locations wl
      LEFT JOIN warehouse.warehouses w ON wl.warehouse_id = w.id
      LEFT JOIN inventory.inventory_levels il ON il.warehouse_location_id = wl.id
      WHERE 1=1 ${whFilter} ${zoneFilter} ${ltFilter} ${btFilter} ${searchFilter} ${hasInvFilter}
      GROUP BY wl.id, wl.code, wl.zone, wl.location_type, wl.bin_type, wl.is_pickable,
               wl.warehouse_id, wl.capacity_cubic_mm, w.code
      ORDER BY ${orderClause}
      LIMIT ${pageSize} OFFSET ${offset}
    `);

    const bins = binsResult.rows as any[];
    const locationIds = bins.map((b: any) => b.location_id);

    // Batch-fetch items per bin
    let itemsByLocation = new Map<number, any[]>();
    if (locationIds.length > 0) {
      const itemsResult = await this.db.execute(sql`
        SELECT inventory_levels.warehouse_location_id as location_id, pv.id as variant_id, pv.sku, pv.name,
               inventory_levels.variant_qty, inventory_levels.reserved_qty
        FROM inventory.inventory_levels
        JOIN catalog.product_variants pv ON inventory_levels.product_variant_id = pv.id
        WHERE ${inArray(inventoryLevels.warehouseLocationId, locationIds)}
          AND inventory_levels.variant_qty > 0
        ORDER BY inventory_levels.warehouse_location_id, pv.sku
      `);

      for (const row of itemsResult.rows as any[]) {
        const locId = row.location_id;
        if (!itemsByLocation.has(locId)) itemsByLocation.set(locId, []);
        itemsByLocation.get(locId)!.push({
          variantId: row.variant_id,
          sku: row.sku,
          name: row.name,
          variantQty: parseInt(row.variant_qty) || 0,
          reservedQty: parseInt(row.reserved_qty) || 0,
        });
      }
    }

    return {
      bins: bins.map((b: any) => ({
        locationId: b.location_id,
        locationCode: b.location_code,
        zone: b.zone,
        locationType: b.location_type,
        binType: b.bin_type,
        isPickable: b.is_pickable,
        warehouseId: b.warehouse_id,
        warehouseCode: b.warehouse_code,
        capacityCubicMm: b.capacity_cubic_mm ? parseInt(b.capacity_cubic_mm) : null,
        skuCount: parseInt(b.sku_count) || 0,
        totalVariantQty: parseInt(b.total_variant_qty) || 0,
        totalReservedQty: parseInt(b.total_reserved_qty) || 0,
        items: itemsByLocation.get(b.location_id) || [],
      })),
      total,
      page,
      pageSize,
    };
  }

  // ─── 2. Unassigned Inventory ────────────────────────────────────

  async getUnassignedInventory(params: UnassignedInventoryParams) {
    const page = Math.max(1, params.page || 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize || 50));
    const offset = (page - 1) * pageSize;

    const [countResult, result] = await Promise.all([
      this.db.execute(sql`
        SELECT COUNT(*) as total
        FROM inventory.inventory_levels il
        JOIN warehouse.warehouse_locations wl ON il.warehouse_location_id = wl.id
        WHERE il.variant_qty > 0
          AND (wl.location_type IN ('receiving', 'staging') OR wl.warehouse_id IS NULL)
      `),
      this.db.execute(sql`
        SELECT il.id as level_id, pv.id as variant_id, pv.sku, pv.name, il.variant_qty,
               wl.id as location_id, wl.code as location_code, wl.location_type
        FROM inventory.inventory_levels il
        JOIN catalog.product_variants pv ON il.product_variant_id = pv.id
        JOIN warehouse.warehouse_locations wl ON il.warehouse_location_id = wl.id
        WHERE il.variant_qty > 0
          AND (wl.location_type IN ('receiving', 'staging') OR wl.warehouse_id IS NULL)
        ORDER BY pv.sku
        LIMIT ${pageSize} OFFSET ${offset}
      `),
    ]);

    return {
      items: (result.rows as any[]).map((r: any) => ({
        levelId: r.level_id,
        variantId: r.variant_id,
        sku: r.sku,
        name: r.name,
        variantQty: parseInt(r.variant_qty) || 0,
        locationId: r.location_id,
        locationCode: r.location_code,
        locationType: r.location_type,
      })),
      total: parseInt((countResult.rows[0] as any).total) || 0,
      page,
      pageSize,
    };
  }

  // ─── 3. Location Health ─────────────────────────────────────────

  async getLocationHealth(params: LocationHealthParams) {
    const warehouseId = params.warehouseId ?? null;
    const staleDays = Math.max(1, Math.min(365, params.staleDays || 30));
    const warehouseFilter = warehouseId ? sql`AND wl.warehouse_id = ${warehouseId}` : sql``;

    const [locResult, auxResult] = await Promise.all([
      this.db.execute(sql`
        SELECT
          COUNT(*) as total_locations,
          COUNT(*) FILTER (WHERE wl.is_pickable = 1) as pick_locations,
          COUNT(*) FILTER (WHERE wl.location_type = 'reserve') as bulk_locations,
          COUNT(*) FILTER (WHERE NOT EXISTS (
            SELECT 1 FROM inventory.inventory_levels il WHERE il.warehouse_location_id = wl.id AND il.variant_qty > 0
          )) as empty_locations,
          COUNT(*) FILTER (WHERE wl.is_pickable = 1 AND NOT EXISTS (
            SELECT 1 FROM inventory.inventory_levels il WHERE il.warehouse_location_id = wl.id AND il.variant_qty > 0
          )) as empty_pick_locations,
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM inventory.inventory_levels il WHERE il.warehouse_location_id = wl.id AND il.variant_qty < 0
          )) as negative_inventory_count,
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM inventory.inventory_levels il WHERE il.warehouse_location_id = wl.id AND il.variant_qty > 0
          ) AND NOT EXISTS (
            SELECT 1 FROM inventory.inventory_transactions it
            WHERE (it.from_location_id = wl.id OR it.to_location_id = wl.id)
              AND it.created_at > NOW() - INTERVAL '1 day' * ${staleDays}
          )) as stale_inventory_count
        FROM warehouse.warehouse_locations wl
        WHERE 1=1 ${warehouseFilter}
      `),
      this.db.execute(sql`
        SELECT
          (SELECT COUNT(*) FROM inventory.replen_tasks WHERE status IN ('pending', 'assigned')) as pending_replen_tasks,
          (SELECT COUNT(*) FILTER (WHERE transaction_type = 'transfer') FROM inventory.inventory_transactions WHERE created_at > NOW() - INTERVAL '24 hours') as recent_transfer_count,
          (SELECT COUNT(*) FILTER (WHERE transaction_type = 'adjustment') FROM inventory.inventory_transactions WHERE created_at > NOW() - INTERVAL '24 hours') as recent_adjustment_count
      `),
    ]);

    const loc = locResult.rows[0] as any;
    const aux = auxResult.rows[0] as any;

    return {
      totalLocations: parseInt(loc.total_locations) || 0,
      emptyLocations: parseInt(loc.empty_locations) || 0,
      pickLocations: parseInt(loc.pick_locations) || 0,
      emptyPickLocations: parseInt(loc.empty_pick_locations) || 0,
      reserveLocations: parseInt(loc.bulk_locations) || 0,
      negativeInventoryCount: parseInt(loc.negative_inventory_count) || 0,
      pendingReplenTasks: parseInt(aux.pending_replen_tasks) || 0,
      recentTransferCount: parseInt(aux.recent_transfer_count) || 0,
      recentAdjustmentCount: parseInt(aux.recent_adjustment_count) || 0,
      staleInventoryCount: parseInt(loc.stale_inventory_count) || 0,
    };
  }

  // ─── 4. Exceptions ─────────────────────────────────────────────

  async getExceptions(params: ExceptionsParams) {
    const warehouseId = params.warehouseId ?? null;
    const staleDays = Math.max(1, Math.min(365, params.staleDays || 30));
    const warehouseFilter = warehouseId ? sql`AND wl.warehouse_id = ${warehouseId}` : sql``;

    // Run all 3 exception queries in parallel
    const [negResult, emptyPickResult, staleResult] = await Promise.all([
      // Negative inventory
      this.db.execute(sql`
        SELECT il.id as level_id, pv.id as variant_id, pv.sku, pv.name, il.variant_qty,
               wl.id as location_id, wl.code as location_code
        FROM inventory.inventory_levels il
        JOIN catalog.product_variants pv ON il.product_variant_id = pv.id
        JOIN warehouse.warehouse_locations wl ON il.warehouse_location_id = wl.id
        WHERE il.variant_qty < 0 ${warehouseFilter}
        ORDER BY il.variant_qty ASC
        LIMIT 50
      `),
      // Empty pick faces
      this.db.execute(sql`
        SELECT wl.id as location_id, wl.code as location_code,
               (SELECT pv.sku FROM inventory.inventory_transactions it
                JOIN catalog.product_variants pv ON it.product_variant_id = pv.id
                WHERE it.from_location_id = wl.id OR it.to_location_id = wl.id
                ORDER BY it.created_at DESC LIMIT 1) as last_sku,
               (SELECT MAX(it.created_at) FROM inventory.inventory_transactions it
                WHERE it.from_location_id = wl.id OR it.to_location_id = wl.id) as last_movement_at
        FROM warehouse.warehouse_locations wl
        WHERE wl.is_pickable = 1
          AND wl.location_type = 'pick'
          AND NOT EXISTS (
            SELECT 1 FROM inventory.inventory_levels il WHERE il.warehouse_location_id = wl.id AND il.variant_qty > 0
          )
          ${warehouseFilter}
        ORDER BY wl.code
        LIMIT 50
      `),
      // Stale bins
      this.db.execute(sql`
        SELECT wl.id as location_id, wl.code as location_code, wl.location_type,
               COUNT(DISTINCT il.product_variant_id) as sku_count,
               COALESCE(SUM(il.variant_qty), 0) as total_qty,
               (SELECT MAX(it.created_at) FROM inventory.inventory_transactions it
                WHERE it.from_location_id = wl.id OR it.to_location_id = wl.id) as last_movement_at
        FROM warehouse.warehouse_locations wl
        JOIN inventory.inventory_levels il ON il.warehouse_location_id = wl.id AND il.variant_qty > 0
        WHERE 1=1 ${warehouseFilter}
          AND NOT EXISTS (
            SELECT 1 FROM inventory.inventory_transactions it
            WHERE (it.from_location_id = wl.id OR it.to_location_id = wl.id)
              AND it.created_at > NOW() - INTERVAL '1 day' * ${staleDays}
          )
        GROUP BY wl.id, wl.code, wl.location_type
        ORDER BY wl.code
        LIMIT 50
      `),
    ]);

    return {
      negativeInventory: (negResult.rows as any[]).map((r: any) => ({
        levelId: r.level_id,
        variantId: r.variant_id,
        sku: r.sku,
        name: r.name,
        variantQty: parseInt(r.variant_qty) || 0,
        locationId: r.location_id,
        locationCode: r.location_code,
      })),
      emptyPickFaces: (emptyPickResult.rows as any[]).map((r: any) => ({
        locationId: r.location_id,
        locationCode: r.location_code,
        lastSku: r.last_sku || null,
        lastMovementAt: r.last_movement_at || null,
      })),
      staleBins: (staleResult.rows as any[]).map((r: any) => ({
        locationId: r.location_id,
        locationCode: r.location_code,
        locationType: r.location_type,
        skuCount: parseInt(r.sku_count) || 0,
        totalQty: parseInt(r.total_qty) || 0,
        lastMovementAt: r.last_movement_at || null,
        daysSinceMovement: r.last_movement_at
          ? Math.floor((Date.now() - new Date(r.last_movement_at).getTime()) / (1000 * 60 * 60 * 24))
          : null,
      })),
    };
  }

  // ─── 5. Pick Readiness ──────────────────────────────────────────

  async getPickReadiness(params: PickReadinessParams) {
    const warehouseId = params.warehouseId ?? null;
    const threshold = Math.max(1, Math.min(999, params.threshold || 5));
    const warehouseFilter = warehouseId ? sql`AND wl.warehouse_id = ${warehouseId}` : sql``;

    const result = await this.db.execute(sql`
      SELECT
        wl.id as location_id, wl.code as location_code,
        pv.id as variant_id, pv.sku, pv.name,
        il.variant_qty as current_qty,
        COALESCE(bulk.bulk_qty, 0) as bulk_available,
        rt.id as pending_replen_task_id,
        rt.status as pending_replen_status
      FROM warehouse.warehouse_locations wl
      JOIN inventory.inventory_levels il ON il.warehouse_location_id = wl.id
      JOIN catalog.product_variants pv ON il.product_variant_id = pv.id
      LEFT JOIN LATERAL (
        SELECT SUM(il2.variant_qty) as bulk_qty
        FROM inventory.inventory_levels il2
        JOIN warehouse.warehouse_locations wl2 ON il2.warehouse_location_id = wl2.id
        WHERE wl2.location_type = 'reserve' AND il2.variant_qty > 0
          AND il2.product_variant_id = pv.id
      ) bulk ON true
      LEFT JOIN LATERAL (
        SELECT rt2.id, rt2.status
        FROM inventory.replen_tasks rt2
        WHERE rt2.to_location_id = wl.id
          AND rt2.pick_product_variant_id = pv.id
          AND rt2.status IN ('pending', 'assigned', 'in_progress')
        ORDER BY rt2.created_at DESC LIMIT 1
      ) rt ON true
      WHERE wl.is_pickable = 1
        AND wl.location_type = 'pick'
        AND il.variant_qty <= ${threshold}
        ${warehouseFilter}
      ORDER BY il.variant_qty ASC, pv.sku
      LIMIT 100
    `);

    return (result.rows as any[]).map((r: any) => ({
      locationId: r.location_id,
      locationCode: r.location_code,
      variantId: r.variant_id,
      sku: r.sku,
      name: r.name,
      currentQty: parseInt(r.current_qty) || 0,
      bulkAvailable: parseInt(r.bulk_available) || 0,
      pendingReplenTaskId: r.pending_replen_task_id || null,
      pendingReplenStatus: r.pending_replen_status || null,
    }));
  }

  // ─── 6. Activity ────────────────────────────────────────────────

  async getActivity(params: ActivityParams) {
    const locationId = params.locationId ?? null;
    const variantId = params.variantId ?? null;
    const limit = Math.min(100, Math.max(1, params.limit || 20));

    let locationFilter = sql``;
    let variantFilter = sql``;
    if (locationId) {
      // Filter to transactions involving this location, but exclude 'ship' events
      // because the pick transaction already shows the deduction from the bin
      locationFilter = sql`AND (it.from_location_id = ${locationId} OR it.to_location_id = ${locationId}) AND it.transaction_type != 'ship'`;
    }
    if (variantId) {
      variantFilter = sql`AND it.product_variant_id = ${variantId}`;
    }

    const result = await this.db.execute(sql`
      SELECT it.id, it.transaction_type, it.variant_qty_delta,
             it.variant_qty_before, it.variant_qty_after,
             it.source_state, it.target_state,
             it.notes, it.user_id, it.created_at,
             pv.sku, pv.name as variant_name,
             fl.code as from_location_code,
             tl.code as to_location_code,
             it.order_id, it.reference_type, it.reference_id
      FROM inventory.inventory_transactions it
      LEFT JOIN catalog.product_variants pv ON it.product_variant_id = pv.id
      LEFT JOIN warehouse.warehouse_locations fl ON it.from_location_id = fl.id
      LEFT JOIN warehouse.warehouse_locations tl ON it.to_location_id = tl.id
      WHERE 1=1 ${locationFilter} ${variantFilter}
      ORDER BY it.created_at DESC
      LIMIT ${limit}
    `);

    return (result.rows as any[]).map((r: any) => ({
      id: r.id,
      transactionType: r.transaction_type,
      variantQtyDelta: parseInt(r.variant_qty_delta) || 0,
      variantQtyBefore: r.variant_qty_before != null ? parseInt(r.variant_qty_before) : null,
      variantQtyAfter: r.variant_qty_after != null ? parseInt(r.variant_qty_after) : null,
      sourceState: r.source_state,
      targetState: r.target_state,
      notes: r.notes,
      userId: r.user_id,
      createdAt: r.created_at,
      sku: r.sku,
      variantName: r.variant_name,
      fromLocationCode: r.from_location_code,
      toLocationCode: r.to_location_code,
      orderId: r.order_id,
      referenceType: r.reference_type,
      referenceId: r.reference_id,
    }));
  }

  // ─── 7. Action Queue ───────────────────────────────────────────

  async getPickReplenHealth(params: PickReplenHealthParams) {
    const warehouseId = params.warehouseId ?? null;
    const safeFilter = VALID_PICK_REPLEN_HEALTH_FILTERS.includes(params.filter as any)
      ? params.filter || "all"
      : "all";
    const page = Math.max(1, params.page || 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize || 50));
    const offset = (page - 1) * pageSize;
    const searchTerm = (params.search || "").trim();
    const searchPattern = `%${searchTerm}%`;

    const typeFilter = safeFilter !== "all" ? sql`AND type = ${safeFilter}` : sql``;
    const searchFilter = searchTerm
      ? sql`AND (
          sku ILIKE ${searchPattern}
          OR name ILIKE ${searchPattern}
          OR order_number ILIKE ${searchPattern}
          OR location_code ILIKE ${searchPattern}
          OR source_location_code ILIKE ${searchPattern}
          OR detail ILIKE ${searchPattern}
          OR source_id = ${searchTerm}
          OR task_id::text = ${searchTerm}
          OR exception_id::text = ${searchTerm}
          OR cycle_count_id::text = ${searchTerm}
        )`
      : sql``;
    const orderWarehouseFilter = warehouseId ? sql`AND o.warehouse_id = ${warehouseId}` : sql``;
    const targetWarehouseFilter = warehouseId ? sql`AND wl_to.warehouse_id = ${warehouseId}` : sql``;
    const locationWarehouseFilter = warehouseId ? sql`AND wl.warehouse_id = ${warehouseId}` : sql``;
    const countWarehouseFilter = warehouseId ? sql`AND cc.warehouse_id = ${warehouseId}` : sql``;
    const wsRow = await getSettingsForWarehouse(warehouseId ?? null, this.db as any);
    const lookbackDays = (wsRow?.velocityLookbackDays as number | null | undefined) ?? 14;

    const healthCte = sql`
      WITH health_items AS (
        SELECT
          CASE
            WHEN rt.status = 'blocked'
              AND rt.blocks_shipment = false
              AND rt.depends_on_task_id IS NULL
              AND COALESCE(rt.qty_source_units, 0) = 0
              AND COALESCE(rt.qty_target_units, 0) = 0
              AND COALESCE(rt.exception_reason, 'no_source_stock') IN ('no_source_stock', 'no_source_variant')
              AND COALESCE(demand.active_pending_lines, 0) = 0
            THEN 'stale_replen_no_demand'
            WHEN rt.status IN ('pending', 'assigned')
              AND rt.blocks_shipment = false
              AND rt.depends_on_task_id IS NULL
              AND COALESCE(demand.active_pending_lines, 0) = 0
              AND COALESCE(source_level.variant_qty, 0) < GREATEST(1, COALESCE(rt.qty_source_units, 0))
            THEN 'stale_replen_no_demand'
            WHEN rt.status IN ('blocked', 'in_progress')
            THEN 'stuck_replen'
            WHEN rt.status IN ('pending', 'assigned')
            THEN 'replen_backlog'
            ELSE 'stuck_replen'
          END::text as type,
          CASE
            WHEN rt.status = 'blocked'
              AND rt.blocks_shipment = false
              AND rt.depends_on_task_id IS NULL
              AND COALESCE(rt.qty_source_units, 0) = 0
              AND COALESCE(rt.qty_target_units, 0) = 0
              AND COALESCE(rt.exception_reason, 'no_source_stock') IN ('no_source_stock', 'no_source_variant')
              AND COALESCE(demand.active_pending_lines, 0) = 0
            THEN 4
            WHEN rt.status IN ('pending', 'assigned')
              AND rt.blocks_shipment = false
              AND rt.depends_on_task_id IS NULL
              AND COALESCE(demand.active_pending_lines, 0) = 0
              AND COALESCE(source_level.variant_qty, 0) < GREATEST(1, COALESCE(rt.qty_source_units, 0))
            THEN 4
            WHEN rt.status = 'blocked' THEN 1
            WHEN rt.status = 'in_progress' THEN 2
            WHEN COALESCE(demand.active_pending_lines, 0) > 0 THEN 2
            ELSE 3
          END as priority,
          rt.id::text as source_id,
          rt.id as task_id,
          NULL::int as exception_id,
          NULL::int as cycle_count_id,
          rt.order_id,
          o.order_number,
          rt.order_item_id,
          rt.pick_product_variant_id as variant_id,
          pv.sku,
          pv.name,
          wl_to.id as location_id,
          wl_to.code as location_code,
          wl_from.code as source_location_code,
          rt.status,
          rt.exception_reason,
          rt.qty_target_units as qty,
          FLOOR(EXTRACT(EPOCH FROM NOW() - COALESCE(rt.started_at, rt.assigned_at, rt.created_at)) / 3600)::int as age_hours,
          rt.created_at,
          CASE
            WHEN rt.status = 'blocked'
              AND rt.blocks_shipment = false
              AND rt.depends_on_task_id IS NULL
              AND COALESCE(rt.qty_source_units, 0) = 0
              AND COALESCE(rt.qty_target_units, 0) = 0
              AND COALESCE(rt.exception_reason, 'no_source_stock') IN ('no_source_stock', 'no_source_variant')
              AND COALESCE(demand.active_pending_lines, 0) = 0
            THEN 'no active demand and no executable replen quantity'
            WHEN rt.status IN ('pending', 'assigned')
              AND rt.blocks_shipment = false
              AND rt.depends_on_task_id IS NULL
              AND COALESCE(demand.active_pending_lines, 0) = 0
              AND COALESCE(source_level.variant_qty, 0) < GREATEST(1, COALESCE(rt.qty_source_units, 0))
            THEN 'no active demand and task source no longer has enough stock'
            WHEN rt.status = 'blocked' THEN COALESCE(rt.exception_reason, 'blocked')
            WHEN rt.status = 'in_progress' THEN 'in progress longer than 1h'
            WHEN COALESCE(demand.active_pending_lines, 0) > 0
              THEN CASE WHEN rt.execution_mode = 'inline'
                THEN 'active demand waiting on inline replen: '
                ELSE 'active demand waiting on queued replen: '
              END
                || demand.active_pending_lines::text || ' line'
                || CASE WHEN demand.active_pending_lines = 1 THEN '' ELSE 's' END
                || ', ' || COALESCE(demand.active_pending_units, 0)::text || ' unit'
                || CASE WHEN COALESCE(demand.active_pending_units, 0) = 1 THEN '' ELSE 's' END
            ELSE 'low-priority replen backlog; no active order demand is waiting'
          END as detail,
          CASE
            WHEN rt.status = 'blocked'
              AND rt.blocks_shipment = false
              AND rt.depends_on_task_id IS NULL
              AND COALESCE(rt.qty_source_units, 0) = 0
              AND COALESCE(rt.qty_target_units, 0) = 0
              AND COALESCE(rt.exception_reason, 'no_source_stock') IN ('no_source_stock', 'no_source_variant')
              AND COALESCE(demand.active_pending_lines, 0) = 0
            THEN 'cancel_no_demand'
            WHEN rt.status IN ('pending', 'assigned')
              AND rt.blocks_shipment = false
              AND rt.depends_on_task_id IS NULL
              AND COALESCE(demand.active_pending_lines, 0) = 0
              AND COALESCE(source_level.variant_qty, 0) < GREATEST(1, COALESCE(rt.qty_source_units, 0))
            THEN 'cancel_no_demand'
            WHEN rt.status = 'blocked' THEN 'resolve_blocker'
            WHEN COALESCE(demand.active_pending_lines, 0) > 0
              AND rt.execution_mode = 'inline'
            THEN 'complete_inline_replen'
            WHEN rt.status IN ('pending', 'assigned')
              AND COALESCE(demand.active_pending_lines, 0) = 0
            THEN 'cancel_no_demand'
            ELSE 'execute_or_cancel'
          END as action
        FROM inventory.replen_tasks rt
        JOIN warehouse.warehouse_locations wl_to ON rt.to_location_id = wl_to.id
        LEFT JOIN warehouse.warehouse_locations wl_from ON rt.from_location_id = wl_from.id
        LEFT JOIN catalog.product_variants pv ON rt.pick_product_variant_id = pv.id
        LEFT JOIN wms.orders o ON rt.order_id = o.id
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::int AS active_pending_lines,
            COALESCE(SUM(demand_line.units_needed), 0)::int AS active_pending_units
          FROM (
            SELECT
              oi.id::text AS demand_id,
              GREATEST(oi.quantity - COALESCE(oi.picked_quantity, 0), 0)::int AS units_needed
            FROM wms.order_items oi
            JOIN wms.orders demand_order
              ON demand_order.id = oi.order_id
             AND COALESCE(demand_order.warehouse_status, '') NOT IN ('shipped', 'cancelled')
            WHERE oi.sku = pv.sku
              AND oi.status = 'pending'
              AND oi.requires_shipping = 1

            UNION ALL

            SELECT
              ('allocation_exception:' || ae.id::text) AS demand_id,
              GREATEST(COALESCE(ae.requested_qty, 0), 1)::int AS units_needed
            FROM wms.allocation_exceptions ae
            JOIN wms.orders demand_order
              ON demand_order.id = ae.order_id
             AND COALESCE(demand_order.warehouse_status, '') NOT IN ('shipped', 'cancelled')
            WHERE ae.sku = pv.sku
              AND ae.status NOT IN ('resolved', 'resolved_inline', 'cancelled')
              AND (
                ae.status = 'blocked'
                OR LOWER(COALESCE(ae.metadata->>'shipmentBlocking', 'false')) = 'true'
              )
          ) demand_line
        ) demand ON true
        LEFT JOIN inventory.inventory_levels source_level
          ON source_level.product_variant_id = rt.source_product_variant_id
         AND source_level.warehouse_location_id = rt.from_location_id
        WHERE rt.status NOT IN ('completed', 'cancelled')
          AND (
            rt.status = 'blocked'
            OR (rt.status = 'in_progress' AND COALESCE(rt.started_at, rt.created_at) < NOW() - INTERVAL '1 hour')
            OR (rt.status IN ('pending', 'assigned') AND rt.created_at < NOW() - INTERVAL '4 hours')
          )
          ${targetWarehouseFilter}

        UNION ALL

        SELECT
          'duplicate_replen'::text,
          2,
          MIN(rt.id)::text,
          MIN(rt.id),
          NULL::int,
          NULL::int,
          MIN(rt.order_id),
          MIN(o.order_number),
          MIN(rt.order_item_id),
          rt.pick_product_variant_id,
          pv.sku,
          pv.name,
          wl_to.id,
          wl_to.code,
          NULL::text,
          'duplicate_active'::text,
          NULL::text,
          SUM(rt.qty_target_units)::int,
          FLOOR(EXTRACT(EPOCH FROM NOW() - MIN(rt.created_at)) / 3600)::int,
          MIN(rt.created_at),
          COUNT(*)::text || ' active tasks for same pick bin/SKU',
          'cancel_duplicate'
        FROM inventory.replen_tasks rt
        JOIN warehouse.warehouse_locations wl_to ON rt.to_location_id = wl_to.id
        LEFT JOIN catalog.product_variants pv ON rt.pick_product_variant_id = pv.id
        LEFT JOIN wms.orders o ON rt.order_id = o.id
        WHERE rt.status IN ('pending', 'assigned', 'in_progress', 'blocked')
          AND rt.blocks_shipment = false
          AND NOT (
            rt.status = 'blocked'
            AND rt.depends_on_task_id IS NULL
            AND COALESCE(rt.qty_source_units, 0) = 0
            AND COALESCE(rt.qty_target_units, 0) = 0
            AND COALESCE(rt.exception_reason, 'no_source_stock') IN ('no_source_stock', 'no_source_variant')
          )
          ${targetWarehouseFilter}
        GROUP BY rt.to_location_id, wl_to.id, wl_to.code, rt.pick_product_variant_id, pv.sku, pv.name
        HAVING COUNT(*) > 1

        UNION ALL

        SELECT
          'short_pick_unresolved'::text,
          CASE WHEN rt.id IS NULL AND ae.id IS NULL THEN 1 ELSE 2 END,
          oi.id::text,
          rt.id,
          ae.id,
          NULL::int,
          o.id,
          o.order_number,
          oi.id,
          pv.id,
          oi.sku,
          oi.name,
          wl.id,
          oi.location,
          NULL::text,
          oi.status,
          oi.short_reason,
          oi.quantity - oi.picked_quantity,
          FLOOR(EXTRACT(EPOCH FROM NOW() - COALESCE(oi.picked_at, o.completed_at, o.created_at)) / 3600)::int,
          COALESCE(oi.picked_at, o.completed_at, o.created_at),
          CASE
            WHEN rt.id IS NULL AND ae.id IS NULL THEN 'short pick has no active replen task or open exception'
            WHEN rt.id IS NOT NULL THEN 'short pick linked to replen task #' || rt.id::text || ' (' || rt.status || ')'
            ELSE 'short pick linked to allocation exception #' || ae.id::text || ' (' || ae.status || ')'
          END,
          CASE WHEN rt.id IS NULL AND ae.id IS NULL THEN 'create_replen_or_exception' ELSE 'review_short_pick' END
        FROM wms.order_items oi
        JOIN wms.orders o ON oi.order_id = o.id
        LEFT JOIN catalog.product_variants pv ON pv.sku = oi.sku
        LEFT JOIN warehouse.warehouse_locations wl
          ON UPPER(wl.code) = UPPER(oi.location)
          AND (o.warehouse_id IS NULL OR wl.warehouse_id = o.warehouse_id)
        LEFT JOIN LATERAL (
          SELECT rt2.id, rt2.status
          FROM inventory.replen_tasks rt2
          WHERE rt2.status IN ('pending', 'assigned', 'in_progress', 'blocked')
            AND NOT (
              rt2.status = 'blocked'
              AND rt2.blocks_shipment = false
              AND rt2.depends_on_task_id IS NULL
              AND COALESCE(rt2.qty_source_units, 0) = 0
              AND COALESCE(rt2.qty_target_units, 0) = 0
              AND COALESCE(rt2.exception_reason, 'no_source_stock') IN ('no_source_stock', 'no_source_variant')
            )
            AND (
              rt2.order_item_id = oi.id
              OR (pv.id IS NOT NULL AND rt2.pick_product_variant_id = pv.id AND wl.id IS NOT NULL AND rt2.to_location_id = wl.id)
            )
          ORDER BY rt2.created_at DESC
          LIMIT 1
        ) rt ON true
        LEFT JOIN LATERAL (
          SELECT ae2.id, ae2.status
          FROM wms.allocation_exceptions ae2
          WHERE ae2.order_item_id = oi.id
            AND ae2.status NOT IN ('resolved', 'resolved_inline', 'cancelled')
          ORDER BY ae2.created_at DESC
          LIMIT 1
        ) ae ON true
        WHERE oi.status = 'short'
          AND o.warehouse_status NOT IN ('shipped', 'cancelled')
          ${orderWarehouseFilter}

        UNION ALL

        SELECT
          CASE
            WHEN ae.status = 'blocked' OR COALESCE(ae.metadata->>'shipmentBlocking', 'false') = 'true'
              THEN 'open_allocation_exception'
            ELSE 'allocation_review_needed'
          END::text,
          CASE
            WHEN ae.status = 'blocked' OR COALESCE(ae.metadata->>'shipmentBlocking', 'false') = 'true'
              THEN 1
            ELSE 4
          END,
          ae.id::text,
          NULL::int,
          ae.id,
          NULL::int,
          ae.order_id,
          ae.order_number,
          ae.order_item_id,
          ae.product_variant_id,
          ae.sku,
          NULL::text,
          ae.selected_location_id,
          ae.selected_location_code,
          NULL::text,
          ae.status,
          ae.exception_type,
          ae.requested_qty,
          FLOOR(EXTRACT(EPOCH FROM NOW() - ae.created_at) / 3600)::int,
          ae.created_at,
          COALESCE(ae.review_reason, ae.exception_type),
          CASE
            WHEN ae.status = 'blocked' OR COALESCE(ae.metadata->>'shipmentBlocking', 'false') = 'true'
              THEN 'resolve_exception'
            ELSE 'review_exception'
          END
        FROM wms.allocation_exceptions ae
        JOIN wms.orders o ON ae.order_id = o.id
        WHERE ae.status NOT IN ('resolved', 'resolved_inline', 'cancelled')
          ${orderWarehouseFilter}

        UNION ALL

        SELECT
          'cycle_count_review'::text,
          CASE WHEN cc.status = 'pending_review' THEN 1 ELSE 3 END,
          cc.id::text,
          NULL::int,
          NULL::int,
          cc.id,
          NULL::int,
          NULL::text,
          NULL::int,
          NULL::int,
          NULL::text,
          cc.name,
          NULL::int,
          cc.location_codes,
          NULL::text,
          cc.status,
          NULL::text,
          cc.variance_count,
          FLOOR(EXTRACT(EPOCH FROM NOW() - cc.created_at) / 3600)::int,
          cc.created_at,
          COALESCE(cc.description, cc.name),
          CASE WHEN cc.status = 'pending_review' THEN 'approve_or_resolve_count' ELSE 'finish_count' END
        FROM inventory.cycle_counts cc
        WHERE cc.status IN ('in_progress', 'pending_review')
          AND (cc.status = 'pending_review' OR cc.created_at < NOW() - INTERVAL '24 hours')
          ${countWarehouseFilter}

        UNION ALL

        SELECT
          'exception_order_no_blocker'::text,
          3,
          o.id::text,
          NULL::int,
          NULL::int,
          NULL::int,
          o.id,
          o.order_number,
          NULL::int,
          NULL::int,
          NULL::text,
          o.customer_name,
          NULL::int,
          NULL::text,
          NULL::text,
          o.warehouse_status,
          NULL::text,
          NULL::int,
          FLOOR(EXTRACT(EPOCH FROM NOW() - COALESCE(o.exception_at, o.completed_at, o.created_at)) / 3600)::int,
          COALESCE(o.exception_at, o.completed_at, o.created_at),
          'order is exception but no open short item, allocation blocker, or shipment-blocking replen task was found',
          'review_order_status'
        FROM wms.orders o
        WHERE o.warehouse_status = 'exception'
          ${orderWarehouseFilter}
          AND NOT EXISTS (
            SELECT 1 FROM wms.order_items oi
            WHERE oi.order_id = o.id AND oi.requires_shipping = 1 AND oi.status = 'short'
          )
          AND NOT EXISTS (
            SELECT 1 FROM wms.allocation_exceptions ae
            WHERE ae.order_id = o.id
              AND ae.status NOT IN ('resolved', 'resolved_inline', 'cancelled')
          )
          AND NOT EXISTS (
            SELECT 1 FROM inventory.replen_tasks rt
            WHERE rt.order_id = o.id
              AND rt.blocks_shipment = TRUE
              AND rt.status NOT IN ('completed', 'cancelled')
          )

        UNION ALL

        SELECT
          'pick_bin_needs_replen'::text,
          CASE WHEN COALESCE(missing_demand.active_pending_lines, 0) > 0 THEN 1 ELSE 3 END,
          pl.id::text,
          NULL::int,
          NULL::int,
          NULL::int,
          NULL::int,
          NULL::text,
          NULL::int,
          pv.id,
          pv.sku,
          COALESCE(pv.name, pl.name),
          wl.id,
          wl.code,
          NULL::text,
          'no_active_task'::text,
          NULL::text,
          COALESCE(il.variant_qty, 0)::int,
          NULL::int,
          COALESCE(il.updated_at, pl.updated_at),
          CASE
            WHEN COALESCE(missing_demand.active_pending_lines, 0) > 0
              THEN 'active demand has no queued replen task: '
                || missing_demand.active_pending_lines::text || ' line'
                || CASE WHEN missing_demand.active_pending_lines = 1 THEN '' ELSE 's' END
                || ', ' || COALESCE(missing_demand.active_pending_units, 0)::text || ' unit'
                || CASE WHEN COALESCE(missing_demand.active_pending_units, 0) = 1 THEN '' ELSE 's' END
            WHEN missing_effective.replen_method = 'pallet_drop'
              THEN 'pallet-drop pick bin is below coverage trigger with source stock and no active replen task'
            ELSE 'pick bin at/below replen trigger with source stock and no active replen task'
          END,
          CASE
            WHEN COALESCE(missing_demand.active_pending_lines, 0) > 0 THEN 'queue_replen'
            ELSE 'queue_replen'
          END
        FROM warehouse.product_locations pl
        JOIN warehouse.warehouse_locations wl ON pl.warehouse_location_id = wl.id
        JOIN catalog.product_variants pv ON pl.product_variant_id = pv.id
        LEFT JOIN inventory.inventory_levels il
          ON il.warehouse_location_id = wl.id AND il.product_variant_id = pv.id
        LEFT JOIN LATERAL (
          SELECT *
          FROM inventory.location_replen_config lrc
          WHERE lrc.warehouse_location_id = wl.id
            AND (lrc.product_variant_id = pv.id OR lrc.product_variant_id IS NULL)
            AND lrc.is_active = 1
          ORDER BY CASE WHEN lrc.product_variant_id = pv.id THEN 0 ELSE 1 END
          LIMIT 1
        ) missing_loc_config ON true
        LEFT JOIN LATERAL (
          SELECT *
          FROM inventory.replen_rules rr
          WHERE rr.pick_product_variant_id = pv.id
            AND rr.is_active = 1
          LIMIT 1
        ) missing_rule_config ON true
        LEFT JOIN LATERAL (
          SELECT *
          FROM inventory.replen_tier_defaults rtd
          WHERE rtd.hierarchy_level = pv.hierarchy_level
            AND (rtd.warehouse_id = wl.warehouse_id OR rtd.warehouse_id IS NULL)
            AND rtd.is_active = 1
          ORDER BY CASE WHEN rtd.warehouse_id = wl.warehouse_id THEN 0 ELSE 1 END
          LIMIT 1
        ) missing_tier_config ON true
        CROSS JOIN LATERAL (
          SELECT
            COALESCE(missing_loc_config.replen_method, missing_rule_config.replen_method, missing_tier_config.replen_method, 'full_case') AS replen_method,
            COALESCE(missing_loc_config.trigger_value::numeric, missing_rule_config.trigger_value::numeric, missing_tier_config.trigger_value::numeric) AS trigger_value,
            COALESCE(missing_rule_config.source_location_type, missing_tier_config.source_location_type, 'reserve') AS source_location_type,
            missing_rule_config.source_product_variant_id AS source_variant_id,
            missing_tier_config.source_hierarchy_level AS source_hierarchy_level
        ) missing_effective
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(SUM(ABS(it.variant_qty_delta)), 0)::numeric / GREATEST(${lookbackDays}, 1) AS daily_velocity
          FROM inventory.inventory_transactions it
          WHERE it.product_variant_id = pv.id
            AND it.transaction_type = 'pick'
            AND it.created_at > NOW() - MAKE_INTERVAL(days => ${lookbackDays})
        ) missing_velocity ON true
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::int AS active_pending_lines,
            COALESCE(SUM(demand_line.units_needed), 0)::int AS active_pending_units
          FROM (
            SELECT
              oi.id::text AS demand_id,
              GREATEST(oi.quantity - COALESCE(oi.picked_quantity, 0), 0)::int AS units_needed
            FROM wms.order_items oi
            JOIN wms.orders o
              ON o.id = oi.order_id
             AND COALESCE(o.warehouse_status, '') NOT IN ('shipped', 'cancelled')
            WHERE oi.sku = pv.sku
              AND oi.status = 'pending'
              AND oi.requires_shipping = 1

            UNION ALL

            SELECT
              ('allocation_exception:' || ae.id::text) AS demand_id,
              GREATEST(COALESCE(ae.requested_qty, 0), 1)::int AS units_needed
            FROM wms.allocation_exceptions ae
            JOIN wms.orders o
              ON o.id = ae.order_id
             AND COALESCE(o.warehouse_status, '') NOT IN ('shipped', 'cancelled')
            WHERE ae.sku = pv.sku
              AND ae.status NOT IN ('resolved', 'resolved_inline', 'cancelled')
              AND (
                ae.status = 'blocked'
                OR LOWER(COALESCE(ae.metadata->>'shipmentBlocking', 'false')) = 'true'
              )
          ) demand_line
        ) missing_demand ON true
        WHERE pl.status = 'active'
          AND pl.is_primary = 1
          AND wl.is_pickable = 1
          AND wl.location_type = 'pick'
          AND COALESCE(il.variant_qty, 0) <= 0
          AND missing_effective.trigger_value IS NOT NULL
          AND (
            missing_effective.replen_method <> 'pallet_drop'
            OR COALESCE(missing_demand.active_pending_lines, 0) > 0
            OR (
              COALESCE(missing_velocity.daily_velocity, 0) > 0
              AND (COALESCE(il.variant_qty, 0)::numeric / missing_velocity.daily_velocity) < missing_effective.trigger_value
            )
          )
          ${locationWarehouseFilter}
          AND EXISTS (
            SELECT 1
            FROM inventory.inventory_levels ril
            JOIN warehouse.warehouse_locations rwl ON ril.warehouse_location_id = rwl.id
            JOIN catalog.product_variants source_pv ON source_pv.id = ril.product_variant_id
            WHERE ril.variant_qty > 0
              AND source_pv.product_id = pv.product_id
              AND rwl.location_type = missing_effective.source_location_type
              AND (wl.warehouse_id IS NULL OR rwl.warehouse_id = wl.warehouse_id)
              AND (
                (missing_effective.source_variant_id IS NOT NULL AND source_pv.id = missing_effective.source_variant_id)
                OR (
                  missing_effective.source_variant_id IS NULL
                  AND (
                    source_pv.id = pv.id
                    OR (
                      missing_effective.source_hierarchy_level IS NOT NULL
                      AND source_pv.hierarchy_level = missing_effective.source_hierarchy_level
                      AND source_pv.id <> pv.id
                      AND source_pv.is_active = true
                      AND source_pv.units_per_variant > pv.units_per_variant
                      AND MOD(source_pv.units_per_variant, pv.units_per_variant) = 0
                    )
                  )
                )
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM inventory.replen_tasks rt
            WHERE rt.to_location_id = wl.id
              AND rt.pick_product_variant_id = pv.id
              AND rt.status IN ('pending', 'assigned', 'in_progress', 'blocked')
              AND NOT (
                rt.status = 'blocked'
                AND rt.blocks_shipment = false
                AND rt.depends_on_task_id IS NULL
                AND COALESCE(rt.qty_source_units, 0) = 0
                AND COALESCE(rt.qty_target_units, 0) = 0
                AND COALESCE(rt.exception_reason, 'no_source_stock') IN ('no_source_stock', 'no_source_variant')
              )
          )
      )
    `;

    const countsResult = await this.db.execute(sql`
      ${healthCte}
      SELECT type, COUNT(*)::int as count
      FROM health_items
      WHERE 1=1 ${searchFilter}
      GROUP BY type
    `);

    const itemsResult = await this.db.execute(sql`
      ${healthCte}
      SELECT *
      FROM health_items
      WHERE 1=1 ${typeFilter} ${searchFilter}
      ORDER BY priority ASC, age_hours DESC NULLS LAST, created_at ASC
      LIMIT ${pageSize} OFFSET ${offset}
    `);

    const counts = VALID_PICK_REPLEN_HEALTH_FILTERS
      .filter(type => type !== "all")
      .reduce((acc, type) => ({ ...acc, [type]: 0 }), {} as Record<string, number>);
    for (const row of countsResult.rows as any[]) {
      counts[row.type] = parseInt(row.count) || 0;
    }
    const total = safeFilter === "all"
      ? Object.values(counts).reduce((sum, count) => sum + count, 0)
      : counts[safeFilter] || 0;

    const items = (itemsResult.rows as any[]).map((r: any) => ({
      id: `${r.type}-${r.source_id}`,
      type: r.type,
      priority: parseInt(r.priority) || 3,
      taskId: r.task_id != null ? parseInt(r.task_id) : null,
      exceptionId: r.exception_id != null ? parseInt(r.exception_id) : null,
      cycleCountId: r.cycle_count_id != null ? parseInt(r.cycle_count_id) : null,
      orderId: r.order_id != null ? parseInt(r.order_id) : null,
      orderNumber: r.order_number || null,
      orderItemId: r.order_item_id != null ? parseInt(r.order_item_id) : null,
      variantId: r.variant_id != null ? parseInt(r.variant_id) : null,
      sku: r.sku || null,
      name: r.name || null,
      locationId: r.location_id != null ? parseInt(r.location_id) : null,
      locationCode: r.location_code || null,
      sourceLocationCode: r.source_location_code || null,
      status: r.status || null,
      exceptionReason: r.exception_reason || null,
      qty: r.qty != null ? parseInt(r.qty) : null,
      ageHours: r.age_hours != null ? parseInt(r.age_hours) : null,
      createdAt: r.created_at || null,
      detail: r.detail || null,
      action: r.action || "review",
    }));

    return { items, total, page, pageSize, counts };
  }

  async getActionQueue(params: ActionQueueParams) {
    const warehouseId = params.warehouseId ?? null;
    const filter = params.filter || "all";
    const page = Math.max(1, params.page || 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize || 50));
    const offset = (page - 1) * pageSize;

    // Fetch velocity lookback days via the shared resolver (warehouse →
    // warehouse code → DEFAULT). No more SELECT ... LIMIT 1 picking
    // whatever row Postgres hands back first.
    // params.warehouseId is optional — null falls through to DEFAULT.
    const wsRow = await getSettingsForWarehouse(
      (params as any)?.warehouseId ?? null,
      this.db as any,
    );
    const lookbackDays = (wsRow?.velocityLookbackDays as number | null | undefined) ?? 14;

    const safeFilter = VALID_ACTION_FILTERS.includes(filter as any) ? filter : "all";

    const sortField = params.sortField || "priority";
    const aqSortDir = params.sortDir === "desc" ? "desc" : "asc";
    const orderClause = (ACTION_QUEUE_SORT_EXPRESSIONS[sortField] || ACTION_QUEUE_SORT_EXPRESSIONS.priority)[aqSortDir];

    const whFilter = warehouseId ? sql`AND wl.warehouse_id = ${warehouseId}` : sql``;
    const searchTerm = params.search || "";
    const hasTypeFilter = safeFilter !== "all";
    const hasSearch = searchTerm.length > 0;
    const searchPattern = `%${searchTerm}%`;

    const filterClause = hasTypeFilter && hasSearch
      ? sql`WHERE type = ${safeFilter} AND (sku ILIKE ${searchPattern} OR location_code ILIKE ${searchPattern} OR name ILIKE ${searchPattern})`
      : hasTypeFilter
        ? sql`WHERE type = ${safeFilter}`
        : hasSearch
          ? sql`WHERE sku ILIKE ${searchPattern} OR location_code ILIKE ${searchPattern} OR name ILIKE ${searchPattern}`
          : sql``;

    // Counts query — always all 5 types (for KPI badges)
    const countsPromise = this.db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM inventory.inventory_levels il
         JOIN warehouse.warehouse_locations wl ON il.warehouse_location_id = wl.id
         WHERE il.variant_qty < 0 ${whFilter}) as negative_count,
        (SELECT COUNT(*) FROM inventory.inventory_levels il
         JOIN warehouse.warehouse_locations wl ON il.warehouse_location_id = wl.id
         WHERE il.variant_qty > 0
           AND wl.location_type IN ('receiving', 'staging')
           AND il.updated_at < NOW() - INTERVAL '24 hours'
           ${whFilter}) as aging_receiving_count,
        (SELECT COUNT(*) FROM warehouse.warehouse_locations wl
         JOIN inventory.inventory_levels il ON il.warehouse_location_id = wl.id
         CROSS JOIN LATERAL (
           SELECT COALESCE(SUM(ABS(it.variant_qty_delta)), 0) / GREATEST(${lookbackDays}, 1) AS daily_velocity
           FROM inventory.inventory_transactions it
           WHERE it.product_variant_id = il.product_variant_id
             AND it.transaction_type = 'pick'
             AND it.created_at > NOW() - MAKE_INTERVAL(days => ${lookbackDays})
         ) vel
         CROSS JOIN LATERAL (
           SELECT COALESCE(
             (SELECT lrc.trigger_value::numeric FROM inventory.location_replen_config lrc
              WHERE lrc.warehouse_location_id = wl.id
                AND (lrc.product_variant_id = il.product_variant_id OR lrc.product_variant_id IS NULL)
                AND lrc.is_active = 1
              ORDER BY lrc.product_variant_id NULLS LAST LIMIT 1),
             (SELECT rr.trigger_value::numeric FROM inventory.replen_rules rr
              WHERE rr.pick_product_variant_id = il.product_variant_id
                AND rr.replen_method = 'pallet_drop' AND rr.is_active = 1 LIMIT 1),
             (SELECT rtd.trigger_value::numeric FROM inventory.replen_tier_defaults rtd
              WHERE rtd.replen_method = 'pallet_drop' AND rtd.is_active = 1
              ORDER BY rtd.hierarchy_level LIMIT 1),
             2
           ) AS effective_trigger
         ) trig
         WHERE wl.location_type = 'pick' AND wl.is_pickable = 1
           AND wl.bin_type IN ('pallet', 'floor')
           AND il.variant_qty > 0
           AND vel.daily_velocity > 0
           AND (il.variant_qty / vel.daily_velocity) < trig.effective_trigger
           AND EXISTS (
             SELECT 1 FROM inventory.inventory_levels il2
             JOIN warehouse.warehouse_locations wl2 ON il2.warehouse_location_id = wl2.id
             WHERE wl2.location_type = 'reserve' AND wl2.is_pickable = 0
               AND il2.product_variant_id = il.product_variant_id AND il2.variant_qty > 0
           )
           ${whFilter}) as pallet_drop_count,
        (SELECT COUNT(*) FROM inventory.replen_tasks rt
         LEFT JOIN warehouse.warehouse_locations wl ON rt.to_location_id = wl.id
         WHERE rt.status IN ('pending', 'assigned')
           AND rt.replen_method = 'pallet_drop'
           ${whFilter}) as pallet_drop_task_count,
        (SELECT COUNT(*) FROM inventory.replen_tasks rt
         LEFT JOIN warehouse.warehouse_locations wl ON rt.to_location_id = wl.id
         WHERE rt.status IN ('pending', 'assigned')
           AND rt.created_at < NOW() - INTERVAL '4 hours'
           AND COALESCE(rt.replen_method, '') != 'pallet_drop'
           ${whFilter}) as stuck_replen_count,
        (SELECT COUNT(DISTINCT wl.id) FROM warehouse.warehouse_locations wl
         JOIN inventory.inventory_levels il ON il.warehouse_location_id = wl.id AND il.variant_qty > 0
         WHERE NOT EXISTS (
           SELECT 1 FROM inventory.inventory_transactions it
           WHERE (it.from_location_id = wl.id OR it.to_location_id = wl.id)
             AND it.created_at > NOW() - INTERVAL '90 days')
         ${whFilter}) as stale_count
    `);

    // Items query — UNION ALL wrapped for filtering + pagination
    const itemsPromise = this.db.execute(sql`
      SELECT * FROM (
        -- 1. Negative Inventory (priority 1)
        SELECT 'negative_inventory'::text as type, 1 as priority,
          il.id as source_id, wl.id as location_id, wl.code as location_code, wl.location_type,
          pv.id as variant_id, pv.sku, pv.name,
          il.variant_qty as qty, NULL::text as detail, 'adjust'::text as action,
          NULL::int as bulk_available, NULL::text as pending_replen_status,
          NULL::int as days_since_movement, NULL::int as sku_count,
          NULL::int as hours_aging, NULL::int as task_id,
          NULL::int as from_location_id, NULL::text as from_location_code
        FROM inventory.inventory_levels il
        JOIN catalog.product_variants pv ON il.product_variant_id = pv.id
        JOIN warehouse.warehouse_locations wl ON il.warehouse_location_id = wl.id
        WHERE il.variant_qty < 0 ${whFilter}

        UNION ALL

        -- 2. Aging Receiving (priority 2)
        SELECT 'aging_receiving'::text, 2,
          il.id, wl.id, wl.code, wl.location_type,
          pv.id, pv.sku, pv.name,
          il.variant_qty,
          FLOOR(EXTRACT(EPOCH FROM NOW() - il.updated_at) / 3600)::text || 'h in ' || wl.location_type,
          'move'::text,
          NULL::int, NULL::text, NULL::int, NULL::int,
          FLOOR(EXTRACT(EPOCH FROM NOW() - il.updated_at) / 3600)::int, NULL::int,
          NULL::int, NULL::text
        FROM inventory.inventory_levels il
        JOIN catalog.product_variants pv ON il.product_variant_id = pv.id
        JOIN warehouse.warehouse_locations wl ON il.warehouse_location_id = wl.id
        WHERE il.variant_qty > 0
          AND wl.location_type IN ('receiving', 'staging')
          AND il.updated_at < NOW() - INTERVAL '24 hours'
          ${whFilter}

        UNION ALL

        -- 3. Pallet Drop Tasks (priority 2) — pending replen tasks with method pallet_drop
        SELECT 'pallet_drop'::text, 2,
          rt.id, wl_to.id, wl_to.code, wl_to.location_type,
          pv.id, pv.sku, pv.name,
          rt.qty_target_units,
          COALESCE(wl_from.code, '?') || ' → ' || wl_to.code || ' · ' || rt.status || ' ' || FLOOR(EXTRACT(EPOCH FROM NOW() - rt.created_at) / 3600)::text || 'h',
          'replenish'::text,
          NULL::int, rt.status, NULL::int, NULL::int,
          FLOOR(EXTRACT(EPOCH FROM NOW() - rt.created_at) / 3600)::int, rt.id,
          wl_from.id, wl_from.code
        FROM inventory.replen_tasks rt
        JOIN warehouse.warehouse_locations wl_to ON rt.to_location_id = wl_to.id
        LEFT JOIN warehouse.warehouse_locations wl_from ON rt.from_location_id = wl_from.id
        LEFT JOIN catalog.product_variants pv ON rt.pick_product_variant_id = pv.id
        WHERE rt.status IN ('pending', 'assigned')
          AND rt.replen_method = 'pallet_drop'
          ${whFilter}

        UNION ALL

        -- 4. Stuck Replen (priority 3) — non-pallet-drop tasks pending > 4 hours
        SELECT 'stuck_replen'::text, 3,
          rt.id, wl_to.id, wl_to.code, wl_to.location_type,
          pv.id, pv.sku, pv.name,
          rt.qty_target_units,
          rt.status || ' for ' || FLOOR(EXTRACT(EPOCH FROM NOW() - rt.created_at) / 3600)::text || 'h',
          'investigate'::text,
          NULL::int, rt.status, NULL::int, NULL::int,
          FLOOR(EXTRACT(EPOCH FROM NOW() - rt.created_at) / 3600)::int, rt.id,
          wl_from.id, wl_from.code
        FROM inventory.replen_tasks rt
        JOIN warehouse.warehouse_locations wl_to ON rt.to_location_id = wl_to.id
        LEFT JOIN warehouse.warehouse_locations wl_from ON rt.from_location_id = wl_from.id
        LEFT JOIN catalog.product_variants pv ON rt.pick_product_variant_id = pv.id
        WHERE rt.status IN ('pending', 'assigned')
          AND rt.created_at < NOW() - INTERVAL '4 hours'
          AND COALESCE(rt.replen_method, '') != 'pallet_drop'
          ${whFilter}

        UNION ALL

        -- 5. Stale Bins (priority 4)
        SELECT 'stale_bin'::text, 4,
          wl.id, wl.id, wl.code, wl.location_type,
          NULL::int, NULL::text, NULL::text,
          COALESCE(SUM(il.variant_qty), 0)::int,
          EXTRACT(DAY FROM NOW() - MAX(last_move.last_at))::text || 'd stale',
          'move'::text,
          NULL::int, NULL::text,
          EXTRACT(DAY FROM NOW() - MAX(last_move.last_at))::int,
          COUNT(DISTINCT il.product_variant_id)::int,
          NULL::int, NULL::int,
          NULL::int, NULL::text
        FROM warehouse.warehouse_locations wl
        JOIN inventory.inventory_levels il ON il.warehouse_location_id = wl.id AND il.variant_qty > 0
        LEFT JOIN LATERAL (
          SELECT MAX(it.created_at) as last_at
          FROM inventory.inventory_transactions it
          WHERE it.from_location_id = wl.id OR it.to_location_id = wl.id
        ) last_move ON true
        WHERE NOT EXISTS (
          SELECT 1 FROM inventory.inventory_transactions it
          WHERE (it.from_location_id = wl.id OR it.to_location_id = wl.id)
            AND it.created_at > NOW() - INTERVAL '90 days')
        ${whFilter}
        GROUP BY wl.id, wl.code, wl.location_type
      ) action_queue
      ${filterClause}
      ORDER BY ${orderClause}
      LIMIT ${pageSize} OFFSET ${offset}
    `);

    const [countsResult, itemsResult] = await Promise.all([countsPromise, itemsPromise]);
    const c = countsResult.rows[0] as any;

    const counts = {
      negative_inventory: parseInt(c.negative_count) || 0,
      aging_receiving: parseInt(c.aging_receiving_count) || 0,
      pallet_drop: parseInt(c.pallet_drop_task_count) || 0,
      stuck_replen: parseInt(c.stuck_replen_count) || 0,
      stale_bin: parseInt(c.stale_count) || 0,
    };

    // Derive total from counts based on active filter
    const total = safeFilter === "all"
      ? Object.values(counts).reduce((a, b) => a + b, 0)
      : counts[safeFilter as keyof typeof counts] || 0;

    const items = (itemsResult.rows as any[]).map((r: any) => ({
      id: `${r.type}-${r.source_id}`,
      type: r.type,
      priority: parseInt(r.priority),
      locationId: r.location_id,
      locationCode: r.location_code,
      locationType: r.location_type,
      variantId: r.variant_id || null,
      sku: r.sku || null,
      name: r.name || null,
      qty: r.qty != null ? parseInt(r.qty) : null,
      detail: r.detail || null,
      action: r.action,
      bulkAvailable: r.bulk_available != null ? parseInt(r.bulk_available) : null,
      pendingReplenStatus: r.pending_replen_status || null,
      daysSinceMovement: r.days_since_movement != null ? parseInt(r.days_since_movement) : null,
      skuCount: r.sku_count != null ? parseInt(r.sku_count) : null,
      hoursAging: r.hours_aging != null ? parseInt(r.hours_aging) : null,
      taskId: r.task_id != null ? parseInt(r.task_id) : null,
      fromLocationId: r.from_location_id != null ? parseInt(r.from_location_id) : null,
      fromLocationCode: r.from_location_code || null,
    }));

    return { items, total, page, pageSize, counts };
  }
}

// ── Factory function ────────────────────────────────────────────────

export function createOperationsDashboardService(db: DrizzleDb) {
  return new OperationsDashboardService(db);
}

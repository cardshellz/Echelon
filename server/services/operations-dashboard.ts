/**
 * Operations Dashboard service for Echelon WMS.
 *
 * Pure read-only analytics — no side effects, only dependency is `db`.
 * Provides bin inventory views, location health KPIs, exception detection,
 * pick readiness, activity history, and a unified action queue.
 */

import { sql, inArray } from "drizzle-orm";
import { inventoryLevels } from "@shared/schema";

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
        ? sql`AND EXISTS (SELECT 1 FROM inventory_levels il2 WHERE il2.warehouse_location_id = wl.id AND il2.variant_qty > 0)`
        : hasInventory === false
          ? sql`AND NOT EXISTS (SELECT 1 FROM inventory_levels il2 WHERE il2.warehouse_location_id = wl.id AND il2.variant_qty > 0)`
          : sql``;

    // Count total for pagination
    const countResult = await this.db.execute(sql`
      SELECT COUNT(*)::int as total FROM warehouse_locations wl
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
      FROM warehouse_locations wl
      LEFT JOIN warehouses w ON wl.warehouse_id = w.id
      LEFT JOIN inventory_levels il ON il.warehouse_location_id = wl.id
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
        FROM inventory_levels
        JOIN product_variants pv ON inventory_levels.product_variant_id = pv.id
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
        FROM inventory_levels il
        JOIN warehouse_locations wl ON il.warehouse_location_id = wl.id
        WHERE il.variant_qty > 0
          AND (wl.location_type IN ('receiving', 'staging') OR wl.warehouse_id IS NULL)
      `),
      this.db.execute(sql`
        SELECT il.id as level_id, pv.id as variant_id, pv.sku, pv.name, il.variant_qty,
               wl.id as location_id, wl.code as location_code, wl.location_type
        FROM inventory_levels il
        JOIN product_variants pv ON il.product_variant_id = pv.id
        JOIN warehouse_locations wl ON il.warehouse_location_id = wl.id
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
            SELECT 1 FROM inventory_levels il WHERE il.warehouse_location_id = wl.id AND il.variant_qty > 0
          )) as empty_locations,
          COUNT(*) FILTER (WHERE wl.is_pickable = 1 AND NOT EXISTS (
            SELECT 1 FROM inventory_levels il WHERE il.warehouse_location_id = wl.id AND il.variant_qty > 0
          )) as empty_pick_locations,
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM inventory_levels il WHERE il.warehouse_location_id = wl.id AND il.variant_qty < 0
          )) as negative_inventory_count,
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM inventory_levels il WHERE il.warehouse_location_id = wl.id AND il.variant_qty > 0
          ) AND NOT EXISTS (
            SELECT 1 FROM inventory_transactions it
            WHERE (it.from_location_id = wl.id OR it.to_location_id = wl.id)
              AND it.created_at > NOW() - INTERVAL '1 day' * ${staleDays}
          )) as stale_inventory_count
        FROM warehouse_locations wl
        WHERE 1=1 ${warehouseFilter}
      `),
      this.db.execute(sql`
        SELECT
          (SELECT COUNT(*) FROM replen_tasks WHERE status IN ('pending', 'assigned')) as pending_replen_tasks,
          (SELECT COUNT(*) FILTER (WHERE transaction_type = 'transfer') FROM inventory_transactions WHERE created_at > NOW() - INTERVAL '24 hours') as recent_transfer_count,
          (SELECT COUNT(*) FILTER (WHERE transaction_type = 'adjustment') FROM inventory_transactions WHERE created_at > NOW() - INTERVAL '24 hours') as recent_adjustment_count
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
        FROM inventory_levels il
        JOIN product_variants pv ON il.product_variant_id = pv.id
        JOIN warehouse_locations wl ON il.warehouse_location_id = wl.id
        WHERE il.variant_qty < 0 ${warehouseFilter}
        ORDER BY il.variant_qty ASC
        LIMIT 50
      `),
      // Empty pick faces
      this.db.execute(sql`
        SELECT wl.id as location_id, wl.code as location_code,
               (SELECT pv.sku FROM inventory_transactions it
                JOIN product_variants pv ON it.product_variant_id = pv.id
                WHERE it.from_location_id = wl.id OR it.to_location_id = wl.id
                ORDER BY it.created_at DESC LIMIT 1) as last_sku,
               (SELECT MAX(it.created_at) FROM inventory_transactions it
                WHERE it.from_location_id = wl.id OR it.to_location_id = wl.id) as last_movement_at
        FROM warehouse_locations wl
        WHERE wl.is_pickable = 1
          AND wl.location_type = 'pick'
          AND NOT EXISTS (
            SELECT 1 FROM inventory_levels il WHERE il.warehouse_location_id = wl.id AND il.variant_qty > 0
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
               (SELECT MAX(it.created_at) FROM inventory_transactions it
                WHERE it.from_location_id = wl.id OR it.to_location_id = wl.id) as last_movement_at
        FROM warehouse_locations wl
        JOIN inventory_levels il ON il.warehouse_location_id = wl.id AND il.variant_qty > 0
        WHERE 1=1 ${warehouseFilter}
          AND NOT EXISTS (
            SELECT 1 FROM inventory_transactions it
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
      FROM warehouse_locations wl
      JOIN inventory_levels il ON il.warehouse_location_id = wl.id
      JOIN product_variants pv ON il.product_variant_id = pv.id
      LEFT JOIN LATERAL (
        SELECT SUM(il2.variant_qty) as bulk_qty
        FROM inventory_levels il2
        JOIN warehouse_locations wl2 ON il2.warehouse_location_id = wl2.id
        WHERE wl2.location_type = 'reserve' AND il2.variant_qty > 0
          AND il2.product_variant_id = pv.id
      ) bulk ON true
      LEFT JOIN LATERAL (
        SELECT rt2.id, rt2.status
        FROM replen_tasks rt2
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
      locationFilter = sql`AND (it.from_location_id = ${locationId} OR it.to_location_id = ${locationId})`;
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
      FROM inventory_transactions it
      LEFT JOIN product_variants pv ON it.product_variant_id = pv.id
      LEFT JOIN warehouse_locations fl ON it.from_location_id = fl.id
      LEFT JOIN warehouse_locations tl ON it.to_location_id = tl.id
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

  async getActionQueue(params: ActionQueueParams) {
    const warehouseId = params.warehouseId ?? null;
    const filter = params.filter || "all";
    const page = Math.max(1, params.page || 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize || 50));
    const offset = (page - 1) * pageSize;

    // Fetch velocity lookback days from warehouse settings
    const wsResult = await this.db.execute(sql`SELECT velocity_lookback_days FROM warehouse_settings LIMIT 1`);
    const lookbackDays = (wsResult.rows[0] as any)?.velocity_lookback_days ?? 14;

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
        (SELECT COUNT(*) FROM inventory_levels il
         JOIN warehouse_locations wl ON il.warehouse_location_id = wl.id
         WHERE il.variant_qty < 0 ${whFilter}) as negative_count,
        (SELECT COUNT(*) FROM inventory_levels il
         JOIN warehouse_locations wl ON il.warehouse_location_id = wl.id
         WHERE il.variant_qty > 0
           AND wl.location_type IN ('receiving', 'staging')
           AND il.updated_at < NOW() - INTERVAL '24 hours'
           ${whFilter}) as aging_receiving_count,
        (SELECT COUNT(*) FROM warehouse_locations wl
         JOIN inventory_levels il ON il.warehouse_location_id = wl.id
         CROSS JOIN LATERAL (
           SELECT COALESCE(SUM(ABS(it.variant_qty_delta)), 0) / GREATEST(${lookbackDays}, 1) AS daily_velocity
           FROM inventory_transactions it
           WHERE it.product_variant_id = il.product_variant_id
             AND it.transaction_type = 'pick'
             AND it.created_at > NOW() - MAKE_INTERVAL(days => ${lookbackDays})
         ) vel
         CROSS JOIN LATERAL (
           SELECT COALESCE(
             (SELECT lrc.trigger_value::numeric FROM location_replen_config lrc
              WHERE lrc.warehouse_location_id = wl.id
                AND (lrc.product_variant_id = il.product_variant_id OR lrc.product_variant_id IS NULL)
                AND lrc.is_active = 1
              ORDER BY lrc.product_variant_id NULLS LAST LIMIT 1),
             (SELECT rr.trigger_value::numeric FROM replen_rules rr
              WHERE rr.pick_product_variant_id = il.product_variant_id
                AND rr.replen_method = 'pallet_drop' AND rr.is_active = 1 LIMIT 1),
             (SELECT rtd.trigger_value::numeric FROM replen_tier_defaults rtd
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
             SELECT 1 FROM inventory_levels il2
             JOIN warehouse_locations wl2 ON il2.warehouse_location_id = wl2.id
             WHERE wl2.location_type = 'reserve' AND wl2.is_pickable = 0
               AND il2.product_variant_id = il.product_variant_id AND il2.variant_qty > 0
           )
           ${whFilter}) as pallet_drop_count,
        (SELECT COUNT(*) FROM replen_tasks rt
         LEFT JOIN warehouse_locations wl ON rt.to_location_id = wl.id
         WHERE rt.status IN ('pending', 'assigned')
           AND rt.created_at < NOW() - INTERVAL '4 hours'
           ${whFilter}) as stuck_replen_count,
        (SELECT COUNT(DISTINCT wl.id) FROM warehouse_locations wl
         JOIN inventory_levels il ON il.warehouse_location_id = wl.id AND il.variant_qty > 0
         WHERE NOT EXISTS (
           SELECT 1 FROM inventory_transactions it
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
          NULL::int as hours_aging, NULL::int as task_id
        FROM inventory_levels il
        JOIN product_variants pv ON il.product_variant_id = pv.id
        JOIN warehouse_locations wl ON il.warehouse_location_id = wl.id
        WHERE il.variant_qty < 0 ${whFilter}

        UNION ALL

        -- 2. Aging Receiving (priority 2)
        SELECT 'aging_receiving'::text, 2,
          il.id, wl.id, wl.code, wl.location_type,
          pv.id, pv.sku, pv.name,
          il.variant_qty,
          EXTRACT(HOUR FROM NOW() - il.updated_at)::text || 'h in ' || wl.location_type,
          'move'::text,
          NULL::int, NULL::text, NULL::int, NULL::int,
          EXTRACT(HOUR FROM NOW() - il.updated_at)::int, NULL::int
        FROM inventory_levels il
        JOIN product_variants pv ON il.product_variant_id = pv.id
        JOIN warehouse_locations wl ON il.warehouse_location_id = wl.id
        WHERE il.variant_qty > 0
          AND wl.location_type IN ('receiving', 'staging')
          AND il.updated_at < NOW() - INTERVAL '24 hours'
          ${whFilter}

        UNION ALL

        -- 3. Pallet Drop Needed (priority 2)
        SELECT 'pallet_drop'::text, 2,
          il.id, wl.id, wl.code, wl.location_type,
          pv.id, pv.sku, pv.name,
          il.variant_qty,
          ROUND(vel.daily_velocity::numeric, 1) || ' units/day · ~' || ROUND((il.variant_qty / vel.daily_velocity)::numeric, 1) || ' days left',
          'replenish'::text,
          COALESCE(air.air_qty, 0)::int, NULL::text, NULL::int, NULL::int,
          NULL::int, NULL::int
        FROM warehouse_locations wl
        JOIN inventory_levels il ON il.warehouse_location_id = wl.id
        JOIN product_variants pv ON il.product_variant_id = pv.id
        CROSS JOIN LATERAL (
          SELECT COALESCE(SUM(ABS(it.variant_qty_delta)), 0) / GREATEST(${lookbackDays}, 1) AS daily_velocity
          FROM inventory_transactions it
          WHERE it.product_variant_id = il.product_variant_id
            AND it.transaction_type = 'pick'
            AND it.created_at > NOW() - MAKE_INTERVAL(days => ${lookbackDays})
        ) vel
        LEFT JOIN LATERAL (
          SELECT SUM(il2.variant_qty) as air_qty
          FROM inventory_levels il2
          JOIN warehouse_locations wl2 ON il2.warehouse_location_id = wl2.id
          WHERE wl2.location_type = 'reserve' AND wl2.is_pickable = 0
            AND il2.variant_qty > 0
            AND il2.product_variant_id = pv.id
        ) air ON true
        CROSS JOIN LATERAL (
          SELECT COALESCE(
            (SELECT lrc.trigger_value::numeric FROM location_replen_config lrc
             WHERE lrc.warehouse_location_id = wl.id
               AND (lrc.product_variant_id = il.product_variant_id OR lrc.product_variant_id IS NULL)
               AND lrc.is_active = 1
             ORDER BY lrc.product_variant_id NULLS LAST LIMIT 1),
            (SELECT rr.trigger_value::numeric FROM replen_rules rr
             WHERE rr.pick_product_variant_id = il.product_variant_id
               AND rr.replen_method = 'pallet_drop' AND rr.is_active = 1 LIMIT 1),
            (SELECT rtd.trigger_value::numeric FROM replen_tier_defaults rtd
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
          AND COALESCE(air.air_qty, 0) > 0
          ${whFilter}

        UNION ALL

        -- 4. Stuck Replen (priority 3)
        SELECT 'stuck_replen'::text, 3,
          rt.id, wl.id, wl.code, wl.location_type,
          pv.id, pv.sku, pv.name,
          rt.qty_target_units,
          rt.status || ' for ' || EXTRACT(HOUR FROM NOW() - rt.created_at)::text || 'h',
          'investigate'::text,
          NULL::int, rt.status, NULL::int, NULL::int,
          EXTRACT(HOUR FROM NOW() - rt.created_at)::int, rt.id
        FROM replen_tasks rt
        JOIN warehouse_locations wl ON rt.to_location_id = wl.id
        LEFT JOIN product_variants pv ON rt.pick_product_variant_id = pv.id
        WHERE rt.status IN ('pending', 'assigned')
          AND rt.created_at < NOW() - INTERVAL '4 hours'
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
          NULL::int, NULL::int
        FROM warehouse_locations wl
        JOIN inventory_levels il ON il.warehouse_location_id = wl.id AND il.variant_qty > 0
        LEFT JOIN LATERAL (
          SELECT MAX(it.created_at) as last_at
          FROM inventory_transactions it
          WHERE it.from_location_id = wl.id OR it.to_location_id = wl.id
        ) last_move ON true
        WHERE NOT EXISTS (
          SELECT 1 FROM inventory_transactions it
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
      pallet_drop: parseInt(c.pallet_drop_count) || 0,
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
    }));

    return { items, total, page, pageSize, counts };
  }
}

// ── Factory function ────────────────────────────────────────────────

export function createOperationsDashboardService(db: DrizzleDb) {
  return new OperationsDashboardService(db);
}

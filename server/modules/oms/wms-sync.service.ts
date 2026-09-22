/**
 * WMS Sync Service — Syncs orders from oms_orders → orders (WMS fulfillment)
 *
 * Provides the missing bridge between OMS ingestion layer and WMS operational layer.
 * After an order is ingested into oms_orders, this service:
 * 1. Maps OMS fields to WMS fields
 * 2. Applies business logic (routing, priority, member enrichment)
 * 3. Reserves inventory
 * 4. Creates WMS order for pick queue
 */

import { db } from "../../db";
import { sql, eq, and, notInArray } from "drizzle-orm";
import { omsOrders, omsOrderLines } from "@shared/schema/oms.schema";
import {
  channelWarehouseAssignments,
  outboundShipments,
  productLocations,
  productVariants,
  warehouses,
  warehouseLocations,
  wmsOrders,
  wmsOrderItems,
} from "@shared/schema";
import { logger } from "../../platform/observability/logger";
import {
  decideDropshipOrderWarehouse,
  hasDropshipAcceptanceStamp,
  isDropshipOmsOrder,
} from "./dropship-order-warehouse";
import type { InsertWmsOrder, InsertWmsOrderItem } from "@shared/schema";
import { omsOrderEvents } from "@shared/schema/oms.schema";
import type { ServiceRegistry } from "../../services";
import { computeSortRank, getShippingBase, resolveSlaDueAt, type ShippingServiceLevel } from "../orders/sort-rank";
import { getSlaCutoffConfig } from "../warehouse/settings.resolver";
import { selectPickBinCandidate } from "../warehouse/pick-bin-candidate";
import {
  validateOmsOrderFinancials,
  buildWmsOrderFinancialSnapshot,
  buildWmsItemFinancialSnapshot,
  buildResidualWmsItemFinancialSnapshot,
  buildResidualWmsOrderFinancialSnapshot,
} from "./wms-sync-financials";
import {
  createShipmentForOrder,
  PROVIDER_MEMBERSHIP_AUTHORITATIVE,
  PROVIDER_MEMBERSHIP_PENDING_APPEND,
  linkChildToParentShipment,
  ChildWithoutParentShipmentError,
} from "../wms/create-shipment";
import { WMS_ORDER_SHIPMENT_LOCK_NAMESPACE } from "../wms/shipment-lock-namespaces";
import {
  appendUncoveredItemsToShipment,
  createLateEditResidualShipment,
} from "../wms/late-order-shipment-coverage";
import {
  selectLateOrderShipmentTarget,
} from "../wms/late-order-shipment-selection";
import {
  insertWmsOrderItems,
  reconcileWmsOrderItemAuthority,
  refreshWmsOrderItemFinancialSnapshotsFromOms,
  replaceUnstartedWmsOrderItemsForRepair,
  updateWmsOrderItemCatalogSnapshot,
} from "../wms/order-item-commands";
import {
  enqueueShippingEngineShipmentAmendRetry,
  enqueueShipStationShipmentPushRetry,
  enqueueShipStationSortRankSyncRetry,
} from "./webhook-retry.worker";
import { buildChannelLineDisplayName } from "./line-display-name";
import {
  getOmsLineMaterializableQuantity,
  getOmsLineRemainingMaterializableQuantity,
} from "./oms-line-authority";
import { refreshOmsLineMaterializedQuantities } from "./oms-line-materialization.repository";
import { selectWmsCatalogSku } from "./domain/order-line-catalog-identity";
import { createOrderLineCatalogIdentityRepository } from "./infrastructure/order-line-catalog-identity.repository";
import type { ReservationResult } from "../channels/reservation.service";

type WmsBinLocation = { location: string; zone: string };
type DbLike = typeof db | any;
type MaterializableOmsLine = {
  id: number;
  productVariantId: number | null;
  catalogProductId?: number | null;
  inventoryTracking?: boolean | null;
  sku: string | null;
  name: string | null;
  title: string | null;
  variantTitle: string | null;
  quantity: number;
  authorityFulfillableQuantity: number;
  wmsMaterializedQuantity: number;
  requiresShipping: boolean | null;
  paidPriceCents: number;
  totalPriceCents: number;
  fulfillableQuantity?: number | null;
  fulfillmentStatus?: string | null;
};

const DEFAULT_FULFILLMENT_PARTITION_KEY = "default";
const UNAUTHORIZED_PAID_LINE_RECOVERY_PARTITION_KEY =
  "recovery:unauthorized-paid-lines:v1";

type WmsSyncMode =
  | "standard"
  | "terminal_residual_recovery"
  | "dropship_acceptance_claim";

export function shouldCreateInitialWmsShipment(input: {
  hasShippableItems: boolean;
  isDropshipAcceptanceClaim: boolean;
  warehouseStatus: string;
}): boolean {
  return input.hasShippableItems
    && !input.isDropshipAcceptanceClaim
    && input.warehouseStatus === "ready";
}

/**
 * The provider-work admission boundary for a newly materialized WMS order.
 *
 * WMS order/item rows must commit before inventory authority runs because a
 * failed inventory transaction can poison its PostgreSQL transaction. Provider
 * shipment/outbox writes happen only after the authority callback resolves.
 * An explicit business shortfall is represented by a resolved callback; thrown
 * authority/infrastructure failures fail closed before provider work exists.
 */
export async function admitInitialProviderShipmentAfterInventoryAuthority<T>(
  input: {
    hasShippableItems: boolean;
    isDropshipAcceptanceClaim: boolean;
    warehouseStatus: string;
  },
  dependencies: {
    assertInventoryAuthority: () => Promise<void>;
    persistProviderShipment: () => Promise<T>;
  },
): Promise<T | null> {
  if (!shouldCreateInitialWmsShipment(input)) return null;
  await dependencies.assertInventoryAuthority();
  return dependencies.persistProviderShipment();
}

export function requireRoutedWarehouseId(input: {
  omsOrderId: number;
  hasShippableItems: boolean;
  routedWarehouseId: unknown;
}): number | null {
  const warehouseId = Number(input.routedWarehouseId);
  if (Number.isSafeInteger(warehouseId) && warehouseId > 0) return warehouseId;
  if (!input.hasShippableItems) return null;
  throw new WmsShipmentPrerequisiteError(
    "A shippable OMS order requires an explicit fulfillment warehouse before WMS materialization.",
    {
      omsOrderId: input.omsOrderId,
      routedWarehouseId: input.routedWarehouseId ?? null,
    },
  );
}

export class WmsRequiredInventoryClaimError extends Error {
  readonly code = "WMS_REQUIRED_INVENTORY_CLAIM_FAILED";

  constructor(
    message: string,
    readonly context: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WmsRequiredInventoryClaimError";
  }
}

export class WmsShipmentPrerequisiteError extends Error {
  readonly code = "WMS_SHIPMENT_PREREQUISITE_FAILED";

  constructor(
    message: string,
    readonly context: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WmsShipmentPrerequisiteError";
  }
}

function requirePositiveWarehouseId(value: unknown): number {
  const warehouseId = Number(value);
  if (!Number.isSafeInteger(warehouseId) || warehouseId <= 0) {
    throw new WmsRequiredInventoryClaimError(
      "Dropship acceptance requires a positive frozen quote warehouse ID.",
      { expectedWarehouseId: value ?? null },
    );
  }
  return warehouseId;
}

function assertPinnedDropshipWarehouse(input: {
  omsOrderId: number;
  wmsOrderId: number;
  expectedWarehouseId: number | null;
  actualWarehouseId: number | null;
}): void {
  const expectedWarehouseId = requirePositiveWarehouseId(input.expectedWarehouseId);
  const actualWarehouseId = input.actualWarehouseId == null
    ? null
    : Number(input.actualWarehouseId);
  if (actualWarehouseId !== expectedWarehouseId) {
    throw new WmsRequiredInventoryClaimError(
      "Dropship acceptance WMS order does not match the frozen quote warehouse.",
      {
        omsOrderId: input.omsOrderId,
        wmsOrderId: input.wmsOrderId,
        expectedWarehouseId,
        actualWarehouseId,
      },
    );
  }
}

function normalizeFulfillmentPartitionKey(value: string | null | undefined): string {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : DEFAULT_FULFILLMENT_PARTITION_KEY;
}

function resolveOmsFulfillmentPartitionKey(mode: WmsSyncMode): string {
  return normalizeFulfillmentPartitionKey(
    mode === "terminal_residual_recovery"
      ? UNAUTHORIZED_PAID_LINE_RECOVERY_PARTITION_KEY
      : DEFAULT_FULFILLMENT_PARTITION_KEY,
  );
}

function buildOmsWmsOrderScope(omsOrderId: number, fulfillmentPartitionKey: string) {
  const normalizedPartitionKey = normalizeFulfillmentPartitionKey(fulfillmentPartitionKey);
  return and(
    eq(wmsOrders.omsFulfillmentOrderId, String(omsOrderId)),
    eq(wmsOrders.source, 'oms'),
    eq(wmsOrders.fulfillmentPartitionKey, normalizedPartitionKey),
  );
}

type WmsReconciliationAutoRepairRule =
  | "materialize_authorized_oms_line"
  | "create_missing_initial_shipment"
  | "attach_authorized_line_to_planned_shipment"
  | "attach_authorized_line_to_editable_engine_order"
  | "create_late_edit_residual_shipment";

type WmsReconciliationManualReviewRule =
  | "picked_quantity_exceeds_oms_authority"
  | "edit_removed_picked_wms_item"
  | "edit_picked_quantity_exceeds_oms_authority"
  | "ambiguous_late_edit_shipment_target"
  | "late_edit_provider_identity_missing"
  | "late_edit_shipment_requires_review"
  | "no_safe_late_edit_shipment_target";

type WmsReconciliationManualReviewSource =
  | "reconcileExistingWmsOrderLines"
  | "propagateOmsEditsToWms";

function toNonNegativeInteger(value: unknown, field: string): number {
  const normalized = Number(value ?? 0);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`[WMS Sync] ${field} must be a non-negative integer (got ${String(value)})`);
  }
  return normalized;
}

function toNullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const normalized = Number(value);
  return Number.isInteger(normalized) ? normalized : null;
}

function toNullableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  return value === true || value === 1 || value === "1" || value === "true";
}

/**
 * Resolve the bin an order line is stamped with.
 *
 * Every bin-backed slot row of the variant is a candidate; the primary flag
 * only ranks them. See pick-bin-candidate.ts for why the flag must not be a
 * gate: a pre-2026-05-14 writer bug left real slots with is_primary = 0, and
 * a hard `is_primary = 1` filter here returned null for them and stamped
 * UNASSIGNED on every order line (SHLZ-MAG-STND-P5, 2026-09). Rows without a
 * warehouse location are excluded by the inner join — they cannot direct a
 * picker anywhere.
 */
export async function resolveAssignedBinLocation(
  database: DbLike,
  variantId: number,
): Promise<WmsBinLocation | null> {
  const rows: Array<{
    slotId: number;
    slotStatus: string | null;
    isPrimary: number | null;
    code: string;
    warehouseZone: string | null;
    productZone: string | null;
    locationIsActive: number | null;
    locationIsPickable: number | null;
    locationType: string | null;
    cycleCountFreezeId: number | null;
  }> = await database
    .select({
      slotId: productLocations.id,
      slotStatus: productLocations.status,
      isPrimary: productLocations.isPrimary,
      code: warehouseLocations.code,
      warehouseZone: warehouseLocations.zone,
      productZone: productLocations.zone,
      locationIsActive: warehouseLocations.isActive,
      locationIsPickable: warehouseLocations.isPickable,
      locationType: warehouseLocations.locationType,
      cycleCountFreezeId: warehouseLocations.cycleCountFreezeId,
    })
    .from(productLocations)
    .innerJoin(
      warehouseLocations,
      eq(productLocations.warehouseLocationId, warehouseLocations.id),
    )
    .where(eq(productLocations.productVariantId, variantId));

  const best = selectPickBinCandidate(rows);
  return best
    ? {
        location: String(best.code),
        zone: best.warehouseZone || best.productZone || "U",
      }
    : null;
}

function mapLockedOmsLine(row: any): MaterializableOmsLine {
  return {
    id: toNonNegativeInteger(row.id, "oms_order_lines.id"),
    productVariantId: toNullableInteger(row.product_variant_id),
    catalogProductId: toNullableInteger(row.catalog_product_id),
    inventoryTracking: toNullableBoolean(row.inventory_tracking),
    sku: row.sku ?? null,
    name: row.name ?? null,
    title: row.title ?? null,
    variantTitle: row.variant_title ?? null,
    quantity: toNonNegativeInteger(row.quantity, "oms_order_lines.quantity"),
    authorityFulfillableQuantity: toNonNegativeInteger(
      row.authority_fulfillable_quantity,
      "oms_order_lines.authority_fulfillable_quantity",
    ),
    wmsMaterializedQuantity: toNonNegativeInteger(
      row.wms_materialized_quantity,
      "oms_order_lines.wms_materialized_quantity",
    ),
    requiresShipping: toNullableBoolean(row.requires_shipping),
    paidPriceCents: toNonNegativeInteger(row.paid_price_cents, "oms_order_lines.paid_price_cents"),
    totalPriceCents: toNonNegativeInteger(row.total_price_cents, "oms_order_lines.total_price_cents"),
    fulfillableQuantity: toNullableInteger(row.fulfillable_quantity),
    fulfillmentStatus: row.fulfillment_status ?? null,
  };
}

export async function buildWmsLineItemFromOmsLine(
  database: DbLike,
  line: MaterializableOmsLine,
  materializableQuantity: number,
  orderId = 0,
  financialScope: "source_line" | "residual_quantity" = "source_line",
): Promise<InsertWmsOrderItem> {
  if (materializableQuantity <= 0) {
    throw new Error(`[WMS Sync] Cannot create WMS item for OMS line ${line.id} with non-positive quantity ${materializableQuantity}`);
  }

  const variantId = line.productVariantId || null;
  const catalogSku = variantId
    ? await createOrderLineCatalogIdentityRepository(database).catalogSku(variantId)
    : line.catalogProductId ? await createOrderLineCatalogIdentityRepository(database).catalogProductSku(line.catalogProductId) : null;
  let binLocation: WmsBinLocation | null = null;
  if (variantId && line.inventoryTracking !== false) {
    try {
      binLocation = await resolveAssignedBinLocation(database, variantId);
    } catch (err: any) {
      console.warn(`[WMS Sync] Could not resolve bin for variant ${variantId}: ${err?.message ?? err}`);
    }
  }

  const itemRequiresShipping = line.requiresShipping !== false;
  const itemSnapshot =
    financialScope === "residual_quantity"
      ? buildResidualWmsItemFinancialSnapshot({
          id: line.id,
          remainingQuantity: materializableQuantity,
          paidPriceCents: line.paidPriceCents,
        })
      : buildWmsItemFinancialSnapshot({
          id: line.id,
          quantity: materializableQuantity,
          paidPriceCents: line.paidPriceCents,
          totalPriceCents: line.totalPriceCents,
        });

  return {
    orderId,
    omsOrderLineId: line.id,
    catalogProductId: line.catalogProductId ?? null,
    inventoryTracking: line.inventoryTracking ?? null,
    sku: selectWmsCatalogSku(line.sku, catalogSku),
    name: buildChannelLineDisplayName({
      name: line.name,
      title: line.title,
      variantTitle: line.variantTitle,
    }),
    quantity: materializableQuantity,
    pickedQuantity: itemRequiresShipping ? 0 : materializableQuantity,
    fulfilledQuantity: itemRequiresShipping ? 0 : materializableQuantity,
    status: itemRequiresShipping ? "pending" : "completed",
    location: binLocation?.location || "UNASSIGNED",
    zone: binLocation?.zone || "U",
    productId: variantId,
    requiresShipping: itemRequiresShipping ? 1 : 0,
    ...itemSnapshot,
  };
}

interface WmsSyncServices {
  /** Exact channel-owned warehouse assignments, such as a Walmart ship node. */
  resolveChannelWarehouse?: (channelId: number) => Promise<{ warehouseId: number; warehouseType: string } | null>;
  inventoryCore: any;
  reservation: any;
  fulfillmentRouter: any;
  /** Resolves the static internal Dropship OMS channel; Dropship orders bypass the router. */
  dropshipOmsChannel: { resolveChannelId(): Promise<number> };
  slaMonitor?: any;
  shippingEngine?: import("../shipping/engine").ShippingEngine;
  shipStation?: any;
  omsService?: any;
}

const ACTIVE_SORT_RANK_SYNC_STATUSES = new Set([
  "ready",
  "in_progress",
  "partially_shipped",
  "ready_to_ship",
]);

function dateTimeKey(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function slaStatusFor(dueAt: Date | null, now = new Date()): string | null {
  if (!dueAt) return null;
  if (dueAt.getTime() < now.getTime()) return "overdue";
  if (dueAt.getTime() - now.getTime() <= 24 * 60 * 60 * 1000) return "at_risk";
  return "on_time";
}

export class WmsSyncService {
  private services: WmsSyncServices;

  constructor(services: WmsSyncServices) {
    this.services = services;
  }

  private async lockOmsLinesForMaterialization(
    database: DbLike,
    omsOrderId: number,
  ): Promise<MaterializableOmsLine[]> {
    const result = await database.execute(sql`
      SELECT
        id,
        product_variant_id,
        catalog_product_id,
        inventory_tracking,
        sku,
        name,
        title,
        variant_title,
        quantity,
        requires_shipping,
        paid_price_cents,
        total_price_cents,
        authority_fulfillable_quantity,
        wms_materialized_quantity,
        fulfillable_quantity,
        fulfillment_status
      FROM oms.oms_order_lines
      WHERE order_id = ${omsOrderId}
      ORDER BY id
      FOR UPDATE
    `);

    return (result.rows ?? []).map(mapLockedOmsLine);
  }

  private async incrementOmsLineMaterializedQuantities(
    database: DbLike,
    items: Array<{ omsOrderLineId?: number | null; quantity?: number | null }>,
  ): Promise<void> {
    const consumptions = items
      .map((item) => ({
        omsOrderLineId: item.omsOrderLineId == null ? null : Number(item.omsOrderLineId),
        quantity: Number(item.quantity ?? 0),
      }))
      .filter(
        (item): item is { omsOrderLineId: number; quantity: number } =>
          typeof item.omsOrderLineId === "number" &&
          Number.isInteger(item.omsOrderLineId) &&
          item.omsOrderLineId > 0 &&
          Number.isInteger(item.quantity) &&
          item.quantity > 0,
      );

    if (consumptions.length === 0) return;

    const values = sql.join(
      consumptions.map((item) => sql`(${item.omsOrderLineId}::bigint, ${item.quantity}::int)`),
      sql`, `,
    );

    await database.execute(sql`
      WITH consumed(order_line_id, quantity) AS (
        VALUES ${values}
      )
      UPDATE oms.oms_order_lines ol
         SET wms_materialized_quantity = ol.wms_materialized_quantity + consumed.quantity,
             updated_at = NOW()
        FROM consumed
       WHERE ol.id = consumed.order_line_id
    `);
  }

  private async recordWmsReconciliationAuditEvent(
    database: DbLike,
    omsOrderId: number,
    rule: WmsReconciliationAutoRepairRule,
    details: Record<string, unknown>,
  ): Promise<void> {
    await database.insert(omsOrderEvents).values({
      orderId: omsOrderId,
      eventType: "wms_reconciliation_auto_repair",
      details: {
        classification: "safe_auto_repair",
        rule,
        source: "reconcileExistingWmsOrderLines",
        ...details,
      },
    });
  }

  private async recordWmsReconciliationReviewException(
    database: DbLike,
    args: {
      rule: WmsReconciliationManualReviewRule;
      source: WmsReconciliationManualReviewSource;
      omsOrderId: number;
      wmsOrderId: number;
      wmsOrderItemId: number;
      omsOrderLineId: number | null;
      sku: string | null;
      omsQuantity: number;
      wmsQuantity: number;
      pickedQuantity: number;
      externalLineItemId?: string | null;
      reviewMessage?: string;
      summary?: string;
    },
  ): Promise<void> {
    const idempotencyKey = [
      "oms_wms_reconciliation",
      args.rule,
      `oms-${args.omsOrderId}`,
      `wms-${args.wmsOrderId}`,
      `item-${args.wmsOrderItemId}`,
      `line-${args.omsOrderLineId ?? "none"}`,
    ].join(":").slice(0, 500);
    const summary = args.summary ??
      `WMS item ${args.wmsOrderItemId} has picked quantity ${args.pickedQuantity} ` +
      `above OMS-authorized quantity ${args.omsQuantity}`;
    const details = {
      source: args.source,
      omsOrderId: args.omsOrderId,
      wmsOrderId: args.wmsOrderId,
      wmsOrderItemId: args.wmsOrderItemId,
      omsOrderLineId: args.omsOrderLineId,
      externalLineItemId: args.externalLineItemId ?? null,
      sku: args.sku,
      omsQuantity: args.omsQuantity,
      wmsQuantity: args.wmsQuantity,
      pickedQuantity: args.pickedQuantity,
      reviewMessage: args.reviewMessage ?? null,
    };

    await database.execute(sql`
      INSERT INTO wms.reconciliation_exceptions (
        source,
        classification,
        rule,
        status,
        severity,
        wms_order_id,
        external_system,
        external_order_ref,
        idempotency_key,
        summary,
        details
      )
      VALUES (
        'oms_wms_reconciliation',
        'manual_review',
        ${args.rule},
        'open',
        'review',
        ${args.wmsOrderId},
        'oms',
        ${String(args.omsOrderId)},
        ${idempotencyKey},
        ${summary},
        ${JSON.stringify(details)}::jsonb
      )
      ON CONFLICT (idempotency_key)
        WHERE status IN ('open', 'acknowledged')
      DO UPDATE SET
        last_seen_at = NOW(),
        updated_at = NOW(),
        occurrence_count = wms.reconciliation_exceptions.occurrence_count + 1,
        details = wms.reconciliation_exceptions.details || EXCLUDED.details
    `);
  }

  /**
   * Sync an OMS order to WMS for fulfillment.
   * Idempotent - safe to call multiple times (checks if already synced).
   *
   * @param omsOrderId - The oms_orders.id to sync
   * @returns The WMS order ID when synced; `null` when sync was intentionally SKIPPED
   *   (already synced, order already final/cancelled/refunded, already shipped/fulfilled
   *   out-of-band with no WMS order, or no shippable lines) — a no-op success.
   * @throws on a genuine sync failure (DB error, etc.) — callers should retry. Do NOT
   *   treat a `null` return as a failure.
   */
  async syncOmsOrderToWms(omsOrderId: number): Promise<number | null> {
    return this.syncOmsOrderToWmsInternal(omsOrderId, "standard");
  }

  /**
   * Materialize an unpaid dropship acceptance as non-pickable WMS demand and
   * require one complete authority-aware reservation/claim. This path creates
   * no shipment, provider outbox command, or external ShipStation request.
   */
  async stageOmsOrderAndClaimInventory(input: {
    omsOrderId: number;
    expectedWarehouseId: number;
  }): Promise<{ wmsOrderId: number; warehouseId: number; inventoryClaimId: string | null }> {
    const expectedWarehouseId = requirePositiveWarehouseId(input.expectedWarehouseId);
    const wmsOrderId = await this.syncOmsOrderToWmsInternal(
      input.omsOrderId,
      "dropship_acceptance_claim",
      expectedWarehouseId,
    );
    if (wmsOrderId == null) {
      throw new WmsRequiredInventoryClaimError(
        "Dropship acceptance staging did not materialize a WMS order.",
        { omsOrderId: input.omsOrderId, expectedWarehouseId },
      );
    }
    const reservationStatus = await this.services.reservation.getOrderReservationStatus(wmsOrderId);
    if (Array.isArray(reservationStatus)
      || reservationStatus.authority !== "canonical"
      || reservationStatus.orderId !== wmsOrderId) {
      throw new WmsRequiredInventoryClaimError(
        "Dropship acceptance could not prove canonical inventory-claim identity.",
        { omsOrderId: input.omsOrderId, wmsOrderId },
      );
    }
    return {
      wmsOrderId,
      warehouseId: expectedWarehouseId,
      inventoryClaimId: reservationStatus.claim?.claimId ?? null,
    };
  }

  async releaseStagedInventoryClaim(input: {
    wmsOrderId: number;
    inventoryClaimId: string | null;
    reason: string;
  }): Promise<void> {
    const release = await this.services.reservation.releaseOrderReservation(
      input.wmsOrderId,
      input.reason,
      "dropship_acceptance",
      { expectedCanonicalClaimId: input.inventoryClaimId },
    );
    if (release.failed.length > 0) {
      throw new WmsRequiredInventoryClaimError(
        "Dropship acceptance inventory-claim compensation was incomplete.",
        { wmsOrderId: input.wmsOrderId, failed: release.failed },
      );
    }
  }

  /**
   * Materialize quantity missed by the historical paid/updated authority race
   * into a separate WMS partition after the original partition shipped.
   *
   * This is intentionally not a general terminal-order bypass. The method
   * validates that the OMS order is still partially fulfilled and paid, and
   * that an original default WMS partition has already shipped.
   */
  async recoverUnauthorizedPaidLinesToWms(
    omsOrderId: number,
  ): Promise<number | null> {
    return this.syncOmsOrderToWmsInternal(
      omsOrderId,
      "terminal_residual_recovery",
    );
  }

  private async syncOmsOrderToWmsInternal(
    omsOrderId: number,
    mode: WmsSyncMode,
    expectedDropshipWarehouseId?: number,
  ): Promise<number | null> {
    try {
      const omsOrderResult = await db
        .select()
        .from(omsOrders)
        .where(eq(omsOrders.id, omsOrderId))
        .limit(1);

      if (omsOrderResult.length === 0) {
        console.error(`[WMS Sync] OMS order ${omsOrderId} not found`);
        return null;
      }

      const omsOrder = omsOrderResult[0];
      const isTerminalResidualRecovery = mode === "terminal_residual_recovery";
      const isDropshipAcceptanceClaim = mode === "dropship_acceptance_claim";
      const pinnedDropshipWarehouseId = isDropshipAcceptanceClaim
        ? requirePositiveWarehouseId(expectedDropshipWarehouseId)
        : null;
      const isUnfinalizedDropshipAcceptance =
        (omsOrder as any).rawPayload?.dropship?.acceptanceState === "inventory_claim_required"
        && String(omsOrder.financialStatus ?? "").toLowerCase() !== "paid";
      if (isDropshipAcceptanceClaim && !isUnfinalizedDropshipAcceptance) {
        throw new WmsRequiredInventoryClaimError(
          "Dropship acceptance claim staging requires an unpaid canonical acceptance OMS order.",
          { omsOrderId, financialStatus: omsOrder.financialStatus },
        );
      }
      if (mode === "standard" && isUnfinalizedDropshipAcceptance) {
        console.warn(
          `[WMS Sync] OMS order ${omsOrderId} is awaiting canonical dropship acceptance finalization; skipped operational dispatch`,
        );
        return null;
      }
      const fulfillmentPartitionKey = resolveOmsFulfillmentPartitionKey(mode);

      if (this.isFinalOrCancelledOmsOrder(omsOrder)) {
        await this.cancelExistingWmsOrderForFinalOmsOrder(omsOrderId);
        console.log(
          `[WMS Sync] OMS order ${omsOrderId} is ${omsOrder.status}/${omsOrder.financialStatus}; skipped WMS sync`,
        );
        return null;
      }

      if (isTerminalResidualRecovery) {
        await this.assertUnauthorizedPaidLineRecoveryAllowed(
          omsOrderId,
          omsOrder,
        );
      }

      // 1. Check if already synced (orders.source_table_id points to oms_orders.id)
      const pinnedChannelWarehouse = await this.services.resolveChannelWarehouse?.(omsOrder.channelId) ?? null;
      const existingWmsOrder = await db
        .select({
          id: wmsOrders.id,
          warehouseStatus: wmsOrders.warehouseStatus,
          warehouseId: wmsOrders.warehouseId,
        })
        .from(wmsOrders)
        .where(buildOmsWmsOrderScope(omsOrderId, fulfillmentPartitionKey))
        .orderBy(sql`
          CASE
            WHEN ${wmsOrders.warehouseStatus} = 'cancelled' THEN 2
            WHEN ${wmsOrders.warehouseStatus} = 'shipped' THEN 1
            ELSE 0
          END,
          ${wmsOrders.id}
        `)
        .limit(1);

      if (existingWmsOrder.length > 0) {
        if (pinnedChannelWarehouse && existingWmsOrder[0].warehouseId !== pinnedChannelWarehouse.warehouseId) {
          throw new WmsShipmentPrerequisiteError("Existing warehouse order differs from the channel's configured fulfillment center", { omsOrderId });
        }
        const wmsOrderId = existingWmsOrder[0].id;
        if (isTerminalResidualRecovery) {
          await this.refreshOmsLineMaterializedQuantities(omsOrderId);
          console.log(
            `[WMS Sync] Residual recovery partition already exists for OMS order ${omsOrderId} (WMS ${wmsOrderId}); reused without mutating the shipped original partition`,
          );
          return wmsOrderId;
        }
        if (isDropshipAcceptanceClaim) {
          assertPinnedDropshipWarehouse({
            omsOrderId,
            wmsOrderId,
            expectedWarehouseId: pinnedDropshipWarehouseId,
            actualWarehouseId: existingWmsOrder[0].warehouseId,
          });
          await this.assertDropshipAcceptanceReplayIsNonOperational(
            omsOrderId,
            wmsOrderId,
            existingWmsOrder[0].warehouseStatus,
          );
          await this.reserveRequired(wmsOrderId, omsOrderId, "dropship_acceptance_replay");
          return wmsOrderId;
        }
        const headerRefresh = await this.refreshExistingWmsOrderHeaderFromOms(omsOrder, wmsOrderId);
        const reconciled = await this.reconcileExistingWmsOrderLines(omsOrderId, wmsOrderId);
        console.log(
          `[WMS Sync] Order ${omsOrderId} already synced to WMS (id ${wmsOrderId}); ` +
            `headerRefreshed=${headerRefresh.updated}; promoted=${headerRefresh.promoted}; reconciled ${reconciled.insertedItems} missing item(s)`,
        );

        return wmsOrderId;
      }

      // Defense-in-depth: no WMS order exists for this OMS order. If the OMS
      // order is ALREADY shipped/fulfilled, it was fulfilled outside this WMS
      // (manual/Shopify fulfillment or pre-WMS history). Creating a WMS order
      // now would create a planned shipment and push a DUPLICATE order to the
      // shipping engine for something already shipped. `isFinalOrCancelledOmsOrder`
      // deliberately does NOT include `shipped` (shipped is a success state and
      // must not cancel a legitimately-synced WMS order), so this guard lives
      // only on the create path. Callers (bridge enqueue, backfillUnsynced)
      // already exclude shipped orders; this is the last line of defense if one
      // slips through.
      const omsStatusLower = String(omsOrder.status ?? "").toLowerCase();
      const omsFulfillmentLower = String(omsOrder.fulfillmentStatus ?? "").toLowerCase();
      if (
        !isTerminalResidualRecovery &&
        (omsStatusLower === "shipped" || omsFulfillmentLower === "fulfilled")
      ) {
        console.warn(
          `[WMS Sync] OMS order ${omsOrderId} is ${omsStatusLower}/${omsFulfillmentLower} with no existing WMS order — fulfilled out-of-band; skipping WMS create to avoid a duplicate shipping-engine push`,
        );
        return null;
      }

      // 2. Fetch OMS line items
      const omsLines = await db
        .select()
        .from(omsOrderLines)
        .where(eq(omsOrderLines.orderId, omsOrderId));

      if (omsLines.length === 0) {
        console.warn(`[WMS Sync] OMS order ${omsOrderId} has no line items — skipping`);
        return null;
      }

      const materializableOmsLines = omsLines.filter((line) =>
        isTerminalResidualRecovery
          ? getOmsLineRemainingMaterializableQuantity(line) > 0
          : getOmsLineMaterializableQuantity(line) > 0,
      );

      if (materializableOmsLines.length === 0) {
        console.warn(
          `[WMS Sync] OMS order ${omsOrderId} has no OMS-authorized fulfillable quantity; skipping WMS materialization`,
        );
        return null;
      }

      // Snapshot financials into the WMS row so pushShipment reads cents
      // from wms.orders (WMS-owned push).
      validateOmsOrderFinancials(
        {
          id: omsOrder.id,
          subtotalCents: omsOrder.subtotalCents ?? 0,
          shippingCents: omsOrder.shippingCents ?? 0,
          taxCents: omsOrder.taxCents ?? 0,
          discountCents: omsOrder.discountCents ?? 0,
          totalCents: omsOrder.totalCents ?? 0,
          currency: omsOrder.currency ?? "USD",
        },
        materializableOmsLines.map((l) => ({
          id: l.id,
          quantity: getOmsLineMaterializableQuantity(l),
          paidPriceCents: (l as any).paidPriceCents ?? 0,
          totalPriceCents: (l as any).totalPriceCents ?? 0,
        })),
      );
      const orderFinancialSnapshot = isTerminalResidualRecovery
        ? buildResidualWmsOrderFinancialSnapshot(
            omsOrder.id,
            omsOrder.currency ?? "USD",
            materializableOmsLines.map((line) => ({
              id: line.id,
              paidPriceCents: (line as any).paidPriceCents ?? 0,
              remainingQuantity:
                getOmsLineRemainingMaterializableQuantity(line),
            })),
          )
        : buildWmsOrderFinancialSnapshot({
            id: omsOrder.id,
            subtotalCents: omsOrder.subtotalCents ?? 0,
            shippingCents: omsOrder.shippingCents ?? 0,
            taxCents: omsOrder.taxCents ?? 0,
            discountCents: omsOrder.discountCents ?? 0,
            totalCents: omsOrder.totalCents ?? 0,
            currency: omsOrder.currency ?? "USD",
          });

      // 3. Check if order has any shippable items
      const hasShippableItems = materializableOmsLines.some(line => line.requiresShipping !== false);

      // 3b. Route to a fulfillment warehouse UP FRONT, so the order carries its
      // warehouse through picking and its SLA cutoff is bucketed in that
      // warehouse's clock (not just the default fallback). A shippable order
      // cannot enter WMS or provider shipment processing without an explicit
      // warehouse. A digital-only order has no physical custody to route, so a
      // routing miss remains a valid null assignment for that path.
      // Dropship acceptance already selected and persisted a warehouse. Resolve
      // and revalidate that exact assignment before considering the generic
      // router, then verify the canonical claim's frozen quote agrees with it.
      let routing: { warehouseId: number; warehouseType: string } | null =
        pinnedChannelWarehouse ?? await this.resolvePinnedDropshipWarehouse(omsOrder);
      if (isDropshipAcceptanceClaim) {
        if (!routing || routing.warehouseId !== pinnedDropshipWarehouseId) {
          throw new WmsRequiredInventoryClaimError(
            "The Dropship OMS warehouse does not match the frozen quote warehouse required by the canonical claim.",
            {
              omsOrderId,
              expectedWarehouseId: pinnedDropshipWarehouseId,
              actualWarehouseId: routing?.warehouseId ?? null,
            },
          );
        }
      }
      if (!routing) {
        try {
          routing = await this.services.fulfillmentRouter.routeOrder({
            channelId: omsOrder.channelId,
            country: (omsOrder as any).shipToCountry ?? null,
            skus: materializableOmsLines.map((l: any) => l.sku).filter(Boolean),
          });
        } catch (err: any) {
          if (hasShippableItems) {
            throw new WmsShipmentPrerequisiteError(
              "Warehouse routing failed for a shippable OMS order; WMS materialization was not started.",
              { omsOrderId, causeCode: err?.code ?? null },
              { cause: err },
            );
          }
          console.warn(`[WMS Sync] Warehouse routing failed for OMS order ${omsOrderId}: ${err?.message ?? err}`);
        }
      }
      const routedWarehouseId = requireRoutedWarehouseId({
        omsOrderId,
        hasShippableItems,
        routedWarehouseId: routing?.warehouseId,
      });

      // 4. Map OMS → WMS order fields
      const warehouseStatus = !hasShippableItems
        ? "completed" // Pure digital/donation/membership → skip pick queue
        : routing?.warehouseType === "3pl"
          ? "awaiting_3pl" // 3PL fulfills externally — no internal pick/pack
          : isTerminalResidualRecovery
            ? this.determineResidualRecoveryWarehouseStatus(omsOrder)
            : this.determineWarehouseStatus(omsOrder);
      const { priority, memberPlanName, memberPlanColor } = await this.determinePriority(omsOrder);
      // Compute SLA due date at sync time so sort_rank includes urgency
      // from the start. Priority: platform ship-by-date -> channel SLA ->
      // partner-profile SLA -> global default.
      const channelShipBy = (omsOrder as any).channelShipByDate as Date | string | null | undefined;
      // Bucket the SLA cutoff in the ROUTED warehouse's clock (falls back to the
      // default fulfillment warehouse when routing yields nothing).
      const syncCutoffConfig = await getSlaCutoffConfig(routedWarehouseId, db);
      const slaDueAt = await resolveSlaDueAt({
        channelId: omsOrder.channelId,
        channelShipByDate: channelShipBy,
        explicitSlaDueAt: (omsOrder as any).slaDueAt ?? null,
        orderPlacedAt: omsOrder.orderedAt,
        createdAt: (omsOrder as any).createdAt,
        timezone: syncCutoffConfig.timezone,
        cutoffLocal: syncCutoffConfig.cutoffLocal,
      }, db);
      const sortRank = computeSortRank({
        priority,
        onHold: false,
        slaDueAt,
        orderPlacedAt: omsOrder.orderedAt,
      });

      const wmsOrderData: InsertWmsOrder = {
        channelId: omsOrder.channelId,
        warehouseId: routedWarehouseId, // assigned up front by the router (4)
        source: "oms", // Mark as coming from OMS layer
        omsFulfillmentOrderId: String(omsOrderId), // Link back to oms_orders for dedup
        externalOrderId: omsOrder.externalOrderId,
        orderNumber: omsOrder.externalOrderNumber || `OMS-${omsOrderId}`,
        customerName: omsOrder.customerName || omsOrder.shipToName || `Order ${omsOrderId}`,
        customerEmail: omsOrder.customerEmail || null,
        shippingName: omsOrder.shipToName || omsOrder.customerName || null,
        shippingCompany: (omsOrder as any).shipToCompany || null,
        shippingAddress: omsOrder.shipToAddress1 || null,
        shippingAddress2: omsOrder.shipToAddress2 || null,
        shippingCity: omsOrder.shipToCity || null,
        shippingState: omsOrder.shipToState || null,
        shippingPostalCode: omsOrder.shipToZip || null,
        shippingCountry: omsOrder.shipToCountry || "US",
        priority,
        shippingServiceLevel: ((omsOrder as any).shippingServiceLevel as string | null) || "standard",
        memberPlanName,
        memberPlanColor,
        channelShipByDate: channelShipBy ? new Date(channelShipBy as any) : null,
        slaDueAt,
        slaStatus: "on_time",
        sortRank,
        warehouseStatus,
        fulfillmentPartitionKey,
        itemCount: materializableOmsLines.length,
        unitCount: materializableOmsLines.reduce((sum, line) => sum + getOmsLineMaterializableQuantity(line), 0),
        orderPlacedAt: omsOrder.orderedAt,
        ...orderFinancialSnapshot,
      };

      // Phase one commits only WMS order/item materialization. Inventory
      // authority cannot run inside this transaction: a PostgreSQL inventory
      // constraint error aborts the whole transaction even when JavaScript
      // catches it. Provider shipment/outbox work is intentionally deferred to
      // phase two, after the authority boundary resolves.
      const { ordersStorage } = await import("../orders");

      const txResult = await db.transaction(async (tx: any) => {
        // ── C2.0 Concurrency guard (per-OMS-order serialization) ──────
        // Without this, two concurrent invocations of syncOmsOrderToWms
        // for the SAME OMS order (duplicate Shopify webhook, or webhook
        // racing the reconcile sweep) BOTH pass the step-1 "already
        // synced?" check above, BOTH insert a wms.orders row, each gets
        // its own outbound_shipments row, and each pushes its own
        // ShipStation order with a distinct echelon-wms-shp-<id> key →
        // duplicate (or triplicate) SS orders. There is no unique
        // constraint on oms_fulfillment_order_id to catch this at the DB.
        //
        // The advisory xact lock (key space 918407 = OMS→WMS order sync,
        // distinct from 918406 used by createShipmentForOrder) makes the
        // losing caller block here until the winner commits, then the
        // recheck below finds the winner's row and returns it WITHOUT
        // creating a duplicate. Auto-released on commit/rollback.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(918407, ${omsOrderId})`);

        // Authoritative existence recheck under the lock. Mirrors the
        // step-1 fast-path query; this is the one that actually prevents
        // the duplicate when two syncs race.
        const racedWmsOrder = await tx
          .select({ id: wmsOrders.id, warehouseId: wmsOrders.warehouseId })
          .from(wmsOrders)
          .where(buildOmsWmsOrderScope(omsOrderId, fulfillmentPartitionKey))
          .orderBy(sql`
            CASE
              WHEN ${wmsOrders.warehouseStatus} = 'cancelled' THEN 2
              WHEN ${wmsOrders.warehouseStatus} = 'shipped' THEN 1
              ELSE 0
            END,
            ${wmsOrders.id}
          `)
          .limit(1);
        if (racedWmsOrder.length > 0) {
          if (isDropshipAcceptanceClaim) {
            assertPinnedDropshipWarehouse({
              omsOrderId,
              wmsOrderId: Number(racedWmsOrder[0].id),
              expectedWarehouseId: pinnedDropshipWarehouseId,
              actualWarehouseId: racedWmsOrder[0].warehouseId,
            });
          }
          return { racedExistingWmsOrderId: Number(racedWmsOrder[0].id) };
        }

        const lockedOmsLines = await this.lockOmsLinesForMaterialization(tx, omsOrderId);
        const remainingOmsLines = lockedOmsLines.filter(
          (line) => getOmsLineRemainingMaterializableQuantity(line) > 0,
        );

        if (remainingOmsLines.length === 0) {
          console.warn(
            `[WMS Sync] OMS order ${omsOrderId} has no remaining authorized quantity to materialize after row lock`,
          );
          return { noMaterializableAuthority: true };
        }

        const txWmsLineItems: InsertWmsOrderItem[] = [];
        for (const line of remainingOmsLines) {
          txWmsLineItems.push(
            await buildWmsLineItemFromOmsLine(
              tx,
              line,
              getOmsLineRemainingMaterializableQuantity(line),
              0,
              isTerminalResidualRecovery
                ? "residual_quantity"
                : "source_line",
            ),
          );
        }

        const txHasShippableItems = remainingOmsLines.some((line) => line.requiresShipping !== false);
        const txWarehouseStatus = !txHasShippableItems ? "completed" : warehouseStatus;
        const txWmsOrderData: InsertWmsOrder = {
          ...wmsOrderData,
          warehouseStatus: txWarehouseStatus,
          itemCount: txWmsLineItems.length,
          unitCount: txWmsLineItems.reduce((sum, item) => sum + (item.quantity ?? 0), 0),
          ...(isTerminalResidualRecovery
            ? buildResidualWmsOrderFinancialSnapshot(
                omsOrder.id,
                omsOrder.currency ?? "USD",
                remainingOmsLines.map((line) => ({
                  id: line.id,
                  paidPriceCents: line.paidPriceCents,
                  remainingQuantity:
                    getOmsLineRemainingMaterializableQuantity(line),
                })),
              )
            : {}),
        };

        // 5. Create WMS order (writes to orders + order_items)
        const newWmsOrder = await ordersStorage.createOrderWithItems(txWmsOrderData, txWmsLineItems, tx);
        const returnedPartitionKey = normalizeFulfillmentPartitionKey(
          (newWmsOrder as any).fulfillmentPartitionKey,
        );

        if (
          (newWmsOrder as any).source !== "oms" ||
          String((newWmsOrder as any).omsFulfillmentOrderId ?? "") !== String(omsOrderId) ||
          returnedPartitionKey !== fulfillmentPartitionKey
        ) {
          if (isTerminalResidualRecovery) {
            throw new Error(
              `[WMS Sync] Residual recovery for OMS order ${omsOrderId} resolved to unexpected WMS order ${newWmsOrder.id} ` +
                `(source=${String((newWmsOrder as any).source ?? "")}, ` +
                `omsOrderId=${String((newWmsOrder as any).omsFulfillmentOrderId ?? "")}, ` +
                `partition=${returnedPartitionKey}); refusing to consume line authority`,
            );
          }
          console.warn(
            `[WMS Sync] createOrderWithItems returned WMS order ${newWmsOrder.id} outside OMS order ${omsOrderId} ` +
              `partition ${fulfillmentPartitionKey}; reconciling instead of consuming line authority`,
          );
          return { racedExistingWmsOrderId: Number(newWmsOrder.id) };
        }

        await this.incrementOmsLineMaterializedQuantities(tx, txWmsLineItems);

        if (isTerminalResidualRecovery) {
          await tx.insert(omsOrderEvents).values({
            orderId: omsOrderId,
            eventType: "terminal_residual_wms_partition_created",
            details: {
              fulfillmentPartitionKey,
              wmsOrderId: newWmsOrder.id,
              source: "recover-unauthorized-paid-lines",
              omsOrderLineIds: remainingOmsLines.map((line) => line.id),
              quantities: remainingOmsLines.map((line) => ({
                omsOrderLineId: line.id,
                quantity: getOmsLineRemainingMaterializableQuantity(line),
              })),
            },
          });
        }

        console.log(`[WMS Sync] Synced OMS order ${omsOrderId} → WMS order ${newWmsOrder.id} (${omsOrder.externalOrderNumber})`);

        return {
          newWmsOrder,
          warehouseStatus: txWarehouseStatus,
          hasShippableItems: txHasShippableItems,
        };
      });

      // Concurrency guard tripped: another sync of this same OMS order
      // won the race and already created the WMS order. Reconcile any
      // missing lines against the winner's row and return it — do NOT
      // create a second order or push a second ShipStation order.
      if ((txResult as any).racedExistingWmsOrderId) {
        const racedId = Number((txResult as any).racedExistingWmsOrderId);
        console.warn(
          `[WMS Sync] Concurrent sync race for OMS order ${omsOrderId} — WMS order ${racedId} already created by a parallel sync; reconciling instead of creating a duplicate`,
        );
        if (isDropshipAcceptanceClaim) {
          await this.reserveRequired(racedId, omsOrderId, "dropship_acceptance_race_replay");
          return racedId;
        }
        try {
          if (!isTerminalResidualRecovery) {
            await this.reconcileExistingWmsOrderLines(omsOrderId, racedId);
          }
          await this.refreshOmsLineMaterializedQuantities(omsOrderId);
        } catch (err: any) {
          if (err instanceof WmsShipmentPrerequisiteError) throw err;
          console.error(
            `[WMS Sync] Reconcile after race for OMS order ${omsOrderId} (WMS ${racedId}) failed: ${err.message}`,
          );
        }
        return racedId;
      }

      if ((txResult as any).noMaterializableAuthority) {
        return null;
      }

      // Past the race guard: txResult is the create-path variant.
      const { newWmsOrder, warehouseStatus: createdWarehouseStatus, hasShippableItems: createdHasShippableItems } = txResult as {
        newWmsOrder: { id: number };
        warehouseStatus: string;
        hasShippableItems: boolean;
      };

      // Inventory authority runs only after WMS order/items commit. For an
      // operational physical order, phase two creates the shipment and its
      // provider outbox command in a separate idempotent transaction only
      // after the authority callback resolves. A returned shortfall resolves
      // and remains eligible for discrepancy picking; a thrown error admits no
      // provider work. Pending, 3PL, digital, and acceptance-staging orders do
      // not enter the internal shipping-provider path here.
      let shipmentIdForPush: number | null = null;
      if (isDropshipAcceptanceClaim) {
        await this.reserveRequired(newWmsOrder.id, omsOrderId, "dropship_acceptance_prepare");
      } else {
        const persisted = await admitInitialProviderShipmentAfterInventoryAuthority(
          {
            hasShippableItems: createdHasShippableItems,
            isDropshipAcceptanceClaim,
            warehouseStatus: createdWarehouseStatus,
          },
          {
            assertInventoryAuthority: () => this.reserveBeforeShipmentProcessing(
              newWmsOrder.id,
              omsOrderId,
              "post_create",
            ),
            persistProviderShipment: () => this.persistInitialProviderShipmentAfterInventoryAuthority({
              omsOrderId,
              wmsOrderId: newWmsOrder.id,
              expectedWarehouseId: routedWarehouseId,
              recordReconciliationAudit: false,
            }),
          },
        );
        shipmentIdForPush = persisted?.shipmentIdForPush ?? null;
      }

      // (Warehouse routing now happens BEFORE order creation — see step 3b —
      // so the row is inserted with its warehouse_id and a warehouse-correct
      // SLA, instead of being patched afterward.)
      await this.refreshOmsLineMaterializedQuantities(omsOrderId);

      if (isDropshipAcceptanceClaim) {
        return newWmsOrder.id;
      }

      // 8. Push to ShipStation via WMS-owned pushShipment path.
      // Push failures never block the sync — reconcile retries.
      // Recheck OMS status: a cancellation webhook may have arrived
      // between step 5 (WMS order creation) and now.
      const engine = this.services.shippingEngine ?? this.services.shipStation;
      if (engine?.isConfigured?.() && shipmentIdForPush !== null) {
          const [recheckOms] = await db.select().from(omsOrders).where(eq(omsOrders.id, omsOrderId)).limit(1);
          if (recheckOms && this.isFinalOrCancelledOmsOrder(recheckOms)) {
            console.warn(`[WMS Sync] OMS order ${omsOrderId} cancelled/refunded after WMS creation — skipping engine push, cancelling WMS`);
            await this.cancelExistingWmsOrderForFinalOmsOrder(omsOrderId);
            return newWmsOrder.id;
          }
          try {
            if (this.services.shippingEngine) {
              await this.services.shippingEngine.upsertShipment({ shipmentId: shipmentIdForPush } as any);
            } else {
              await this.services.shipStation.pushShipment(shipmentIdForPush);
            }
            console.log(
              `[WMS Sync] Pushed shipment ${shipmentIdForPush} to ShipStation via pushShipment`,
            );
          } catch (err: any) {
            // Don't block the sync, but do persist a retry immediately.
            // Health/reconciliation is the safety net; this retry row is
            // the hot-path guarantee for transient ShipStation/API/data
            // failures after the WMS shipment row already exists.
            console.error(
              `[WMS Sync] pushShipment failed for shipment ${shipmentIdForPush} (OMS order ${omsOrderId}): ${err.message}`,
            );
            try {
              await enqueueShipStationShipmentPushRetry(
                db,
                shipmentIdForPush,
                err,
              );
            } catch (retryErr: any) {
              console.error(
                `[WMS Sync] failed to enqueue ShipStation retry for shipment ${shipmentIdForPush}: ${retryErr?.message ?? String(retryErr)}`,
              );
            }
          }
      }

      return newWmsOrder.id;
    } catch (err: any) {
      // RETHROW genuine failures so callers can distinguish them from an intentional
      // skip. This function returns `null` ONLY when sync was deliberately skipped
      // (order already final/cancelled/refunded, already shipped/fulfilled out-of-band
      // with no WMS order, or no shippable lines) — a no-op success, NOT a failure.
      // Before, errors also returned null, so every caller treated a harmless skip as a
      // failure and re-queued/dead-lettered it (e.g. old orders fulfilled in ShipStation
      // before Echelon's WMS existed).
      console.error(`[WMS Sync] Failed to sync OMS order ${omsOrderId} to WMS: ${err.message}`);
      throw err;
    }
  }

  /**
   * Dropship orders never go through the generic router: acceptance already
   * chose the warehouse and locked inventory there. Returns null for every
   * other order so the router decides as before.
   *
   * @throws WmsDropshipWarehouseError (permanent) when a Dropship order's
   *   warehouse is missing, inactive, or not an enabled Dropship OMS assignment.
   *   The sync fails loudly rather than shipping from a warehouse the vendor
   *   was never shown quantities for.
   */
  private async resolvePinnedDropshipWarehouse(
    omsOrder: typeof omsOrders.$inferSelect,
  ): Promise<{ warehouseId: number; warehouseType: string } | null> {
    const identity = {
      omsOrderChannelId: omsOrder.channelId ?? null,
      dropshipOmsChannelId: await this.resolveDropshipOmsChannelId(),
      hasDropshipAcceptanceStamp: hasDropshipAcceptanceStamp(omsOrder.rawPayload),
    };
    if (!isDropshipOmsOrder(identity)) return null;

    const warehouseId = omsOrder.warehouseId ?? null;
    const [warehouse] = warehouseId
      ? await db
          .select({
            id: warehouses.id,
            isActive: warehouses.isActive,
            warehouseType: warehouses.warehouseType,
          })
          .from(warehouses)
          .where(eq(warehouses.id, warehouseId))
          .limit(1)
      : [];
    const [assignment] = warehouseId && omsOrder.channelId
      ? await db
          .select({ id: channelWarehouseAssignments.id })
          .from(channelWarehouseAssignments)
          .where(
            and(
              eq(channelWarehouseAssignments.channelId, omsOrder.channelId),
              eq(channelWarehouseAssignments.warehouseId, warehouseId),
              eq(channelWarehouseAssignments.enabled, true),
            ),
          )
          .limit(1)
      : [];
    const decision = decideDropshipOrderWarehouse({
      ...identity,
      omsOrderId: omsOrder.id,
      omsOrderWarehouseId: warehouseId,
      warehouse: warehouse ?? null,
      enabledForChannel: assignment !== undefined,
    });
    if (decision.kind !== "pinned") return null;
    logger.info("wms_sync_dropship_warehouse", {
      outcome: "pinned",
      oms_order_id: omsOrder.id,
      channel_id: omsOrder.channelId,
      warehouse_id: decision.warehouseId,
      warehouse_type: decision.warehouseType,
    });
    return { warehouseId: decision.warehouseId, warehouseType: decision.warehouseType };
  }

  /**
   * Null when the Dropship OMS channel cannot be resolved. That must not stop
   * every other channel's sync, and Dropship orders are still recognized by the
   * acceptance stamp on their payload.
   */
  private async resolveDropshipOmsChannelId(): Promise<number | null> {
    try {
      return await this.services.dropshipOmsChannel.resolveChannelId();
    } catch (err: unknown) {
      const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : null;
      logger.warn("wms_sync_dropship_channel_resolve", {
        outcome: "unresolved",
        error_code: code ?? "DROPSHIP_OMS_CHANNEL_UNRESOLVED",
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Determine WMS warehouse_status based on OMS order state
   */
  private determineWarehouseStatus(omsOrder: typeof omsOrders.$inferSelect): string {
    if (omsOrder.status === "cancelled") return "cancelled";
    if (omsOrder.status === "shipped") return "shipped";
    if (omsOrder.fulfillmentStatus === "fulfilled") return "shipped";
    if (omsOrder.financialStatus === "paid") return "ready";
    return "pending";
  }

  private determineResidualRecoveryWarehouseStatus(
    omsOrder: typeof omsOrders.$inferSelect,
  ): string {
    const financialStatus = String(
      omsOrder.financialStatus ?? "",
    ).toLowerCase();
    return financialStatus === "paid" || financialStatus === "partially_paid"
      ? "ready"
      : "pending";
  }

  private async assertUnauthorizedPaidLineRecoveryAllowed(
    omsOrderId: number,
    omsOrder: typeof omsOrders.$inferSelect,
  ): Promise<void> {
    const financialStatus = String(
      omsOrder.financialStatus ?? "",
    ).toLowerCase();
    const fulfillmentStatus = String(
      omsOrder.fulfillmentStatus ?? "",
    ).toLowerCase();

    if (
      financialStatus !== "paid" &&
      financialStatus !== "partially_paid"
    ) {
      throw new Error(
        `[WMS Sync] Residual recovery rejected for OMS order ${omsOrderId}: financial status ${financialStatus || "blank"} is not paid`,
      );
    }
    if (fulfillmentStatus === "fulfilled") {
      throw new Error(
        `[WMS Sync] Residual recovery rejected for OMS order ${omsOrderId}: OMS fulfillment is already complete`,
      );
    }

    const originalPartitions = await db
      .select({
        id: wmsOrders.id,
        warehouseStatus: wmsOrders.warehouseStatus,
      })
      .from(wmsOrders)
      .where(
        buildOmsWmsOrderScope(
          omsOrderId,
          DEFAULT_FULFILLMENT_PARTITION_KEY,
        ),
      );

    const shippedOriginal = originalPartitions.some(
      (order) => order.warehouseStatus === "shipped",
    );
    const mutableOriginal = originalPartitions.find(
      (order) =>
        order.warehouseStatus !== "shipped" &&
        order.warehouseStatus !== "cancelled",
    );

    if (!shippedOriginal || mutableOriginal) {
      throw new Error(
        `[WMS Sync] Residual recovery rejected for OMS order ${omsOrderId}: expected a shipped default partition and no mutable default partition`,
      );
    }
  }

  private isFinalOrCancelledOmsOrder(omsOrder: typeof omsOrders.$inferSelect): boolean {
    const status = String(omsOrder.status ?? "").toLowerCase();
    const financialStatus = String(omsOrder.financialStatus ?? "").toLowerCase();
    return (
      status === "cancelled" ||
      status === "refunded" ||
      financialStatus === "refunded" ||
      financialStatus === "voided"
    );
  }

  private async refreshOmsLineMaterializedQuantities(omsOrderId: number): Promise<void> {
    await refreshOmsLineMaterializedQuantities(db, {
      omsOrderId,
      updatedAt: new Date(),
    });
  }

  private hasOpenShippableOmsDemand(lines: Array<typeof omsOrderLines.$inferSelect>): boolean {
    return lines.some((line) => {
      if (line.requiresShipping === false) return false;
      if (getOmsLineMaterializableQuantity(line) <= 0) return false;
      const lineFulfillmentStatus = String(line.fulfillmentStatus ?? "").toLowerCase();
      if (lineFulfillmentStatus === "fulfilled") return false;
      const fulfillableQuantity = line.fulfillableQuantity;
      return fulfillableQuantity == null || fulfillableQuantity > 0;
    });
  }

  /**
   * Persist initial provider shipment work after inventory authority has
   * resolved. The caller owns the authority call; this method owns only the
   * second, idempotent shipment/outbox transaction.
   */
  private async persistInitialProviderShipmentAfterInventoryAuthority(input: {
    omsOrderId: number;
    wmsOrderId: number;
    expectedWarehouseId: number | null;
    recordReconciliationAudit: boolean;
  }): Promise<{ shipmentIdForPush: number | null; changedItems: number }> {
    return db.transaction(async (tx: any) => {
      // Serialize all OMS->WMS materialization for this source order before
      // locking the WMS order. Shipment helpers take their narrower order-id
      // advisory lock after this lock.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(918407, ${input.omsOrderId})`);

      const orderStateResult = await tx.execute(sql`
        SELECT
          warehouse_status,
          warehouse_id,
          channel_id,
          combined_role,
          combined_group_id
        FROM wms.orders
        WHERE id = ${input.wmsOrderId}
        FOR UPDATE
      `);
      const orderState = orderStateResult.rows?.[0] as {
        warehouse_status: string;
        warehouse_id: number | null;
        channel_id: number | null;
        combined_role: string | null;
        combined_group_id: number | null;
      } | undefined;
      if (!orderState) {
        throw new WmsShipmentPrerequisiteError(
          "The WMS order disappeared before provider shipment admission.",
          { omsOrderId: input.omsOrderId, wmsOrderId: input.wmsOrderId },
        );
      }
      if (orderState.warehouse_status !== "ready") {
        return { shipmentIdForPush: null, changedItems: 0 };
      }

      const actualWarehouseId = requireRoutedWarehouseId({
        omsOrderId: input.omsOrderId,
        hasShippableItems: true,
        routedWarehouseId: orderState.warehouse_id,
      });
      if (actualWarehouseId !== input.expectedWarehouseId) {
        throw new WmsShipmentPrerequisiteError(
          "The WMS fulfillment warehouse changed after inventory authority resolved.",
          {
            omsOrderId: input.omsOrderId,
            wmsOrderId: input.wmsOrderId,
            expectedWarehouseId: input.expectedWarehouseId,
            actualWarehouseId,
          },
        );
      }

      const shippableItems: Array<{
        id: number;
        quantity: number;
        productVariantId: number | null;
      }> = (await tx
        .select({
          id: wmsOrderItems.id,
          quantity: wmsOrderItems.quantity,
          productVariantId: wmsOrderItems.productId,
          requiresShipping: wmsOrderItems.requiresShipping,
        })
        .from(wmsOrderItems)
        .where(eq(wmsOrderItems.orderId, input.wmsOrderId)))
        .filter((item: any) => item.requiresShipping !== 0 && Number(item.quantity ?? 0) > 0)
        .map((item: any) => ({
          id: Number(item.id),
          quantity: Number(item.quantity ?? 0),
          productVariantId: item.productVariantId == null
            ? null
            : Number(item.productVariantId),
        }));
      if (shippableItems.length === 0) {
        return { shipmentIdForPush: null, changedItems: 0 };
      }

      const orderItemIds = shippableItems.map((item) => item.id);
      const combinedRole = orderState.combined_role;
      const combinedGroupId = orderState.combined_group_id == null
        ? null
        : Number(orderState.combined_group_id);

      if (combinedRole === "child") {
        if (!Number.isSafeInteger(combinedGroupId) || Number(combinedGroupId) <= 0) {
          throw new WmsShipmentPrerequisiteError(
            "A combined child order requires a valid combined fulfillment group.",
            {
              omsOrderId: input.omsOrderId,
              wmsOrderId: input.wmsOrderId,
              combinedGroupId,
            },
          );
        }

        // linkChildToParentShipment has an idempotency probe but no internal
        // advisory lock. Take the same shipment namespace used by
        // createShipmentForOrder so concurrent sync/reconcile calls cannot
        // create two child shipment rows.
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            ${WMS_ORDER_SHIPMENT_LOCK_NAMESPACE},
            ${input.wmsOrderId}
          )
        `);
        const parentResult = await tx.execute(sql`
          SELECT id
          FROM wms.orders
          WHERE combined_group_id = ${combinedGroupId}
            AND combined_role = 'parent'
          ORDER BY id
          LIMIT 1
        `);
        const parentWmsOrderId = Number(
          (parentResult.rows?.[0] as { id?: unknown } | undefined)?.id ?? 0,
        );
        if (!Number.isSafeInteger(parentWmsOrderId) || parentWmsOrderId <= 0) {
          throw new WmsShipmentPrerequisiteError(
            "The combined parent WMS order is not materialized yet.",
            {
              omsOrderId: input.omsOrderId,
              wmsOrderId: input.wmsOrderId,
              combinedGroupId,
            },
          );
        }

        let linked: { shipmentId: number; created: boolean };
        try {
          linked = await linkChildToParentShipment(
            tx,
            input.wmsOrderId,
            parentWmsOrderId,
            orderState.channel_id,
            shippableItems,
          );
        } catch (error) {
          if (error instanceof ChildWithoutParentShipmentError) {
            throw new WmsShipmentPrerequisiteError(
              "The combined parent shipment is not provider-ready yet.",
              {
                omsOrderId: input.omsOrderId,
                wmsOrderId: input.wmsOrderId,
                parentWmsOrderId,
              },
              { cause: error },
            );
          }
          throw error;
        }

        const coverage = await appendUncoveredItemsToShipment(
          tx,
          input.wmsOrderId,
          linked.shipmentId,
          orderItemIds,
          {
            providerMembershipState: PROVIDER_MEMBERSHIP_AUTHORITATIVE,
            useXactLock: true,
          },
        );
        const changedItems = linked.created
          ? shippableItems.length
          : coverage.shipmentItemIds.length;
        if (input.recordReconciliationAudit && changedItems > 0) {
          await this.recordWmsReconciliationAuditEvent(
            tx,
            input.omsOrderId,
            "create_missing_initial_shipment",
            {
              wmsOrderId: input.wmsOrderId,
              wmsShipmentId: linked.shipmentId,
              parentWmsOrderId,
              orderItemIds,
              outboundShipmentItemIds: coverage.shipmentItemIds,
            },
          );
        }
        console.log(
          `[WMS Sync] Linked combined-child order ${input.wmsOrderId} to parent ${parentWmsOrderId}'s shipment ${linked.shipmentId} (created=${linked.created}); parent owns the provider push`,
        );
        return { shipmentIdForPush: null, changedItems };
      }

      const shipment = await createShipmentForOrder(
        tx,
        input.wmsOrderId,
        orderState.channel_id,
        shippableItems,
        { useXactLock: true },
      );
      const coverage = await appendUncoveredItemsToShipment(
        tx,
        input.wmsOrderId,
        shipment.shipmentId,
        orderItemIds,
        {
          providerMembershipState: PROVIDER_MEMBERSHIP_AUTHORITATIVE,
          useXactLock: true,
        },
      );
      await enqueueShipStationShipmentPushRetry(
        tx,
        shipment.shipmentId,
        "initial shipping-engine handoff after inventory authority",
      );

      const changedItems = shipment.created
        ? shippableItems.length
        : coverage.shipmentItemIds.length;
      if (input.recordReconciliationAudit && changedItems > 0) {
        await this.recordWmsReconciliationAuditEvent(
          tx,
          input.omsOrderId,
          "create_missing_initial_shipment",
          {
            wmsOrderId: input.wmsOrderId,
            wmsShipmentId: shipment.shipmentId,
            orderItemIds,
            outboundShipmentItemIds: coverage.shipmentItemIds,
          },
        );
      }
      console.log(
        `[WMS Sync] ${shipment.created ? "Created" : "Reused"} shipment ${shipment.shipmentId} for WMS order ${input.wmsOrderId} after inventory authority resolved`,
      );
      return { shipmentIdForPush: shipment.shipmentId, changedItems };
    });
  }

  /**
   * Run the authority-aware reservation boundary before provider shipment
   * processing (P0.1c, revised 2026-09-14).
   *
   * A shortfall (a line with no reservable stock — oversell, stale channel
   * mapping, or a not-yet-modeled preorder) is logged and recorded as an OMS
   * event, but the order is NOT held and the engine push proceeds. The earlier
   * order-level auto-hold froze every order containing one unreservable line,
   * never released it when stock arrived, and kept the order off ShipStation
   * entirely; until preorder is modeled, the intended flow is that pickers
   * short the unreservable line. A thrown infrastructure or authority error is
   * different from an explicit shortfall: it leaves claim state unknown, so
   * this sync fails and retries instead of continuing toward the provider.
   */
  private async reserveBeforeShipmentProcessing(
    wmsOrderId: number,
    omsOrderId: number | null,
    context: string,
  ): Promise<void> {
    let reserveResult: ReservationResult;
    try {
      reserveResult = await this.services.reservation.reserveOrder(wmsOrderId);
    } catch (err: any) {
      console.error(
        `[WMS Sync] Reservation authority failed for WMS order ${wmsOrderId} (${context}): ${err?.message ?? String(err)} — aborting shipment processing so the sync can retry`,
      );
      throw new WmsShipmentPrerequisiteError(
        "Authority-aware inventory reservation failed before shipment processing.",
        { wmsOrderId, omsOrderId, context, causeCode: err?.code ?? null },
        { cause: err },
      );
    }
    if (reserveResult.failed.length === 0) return;

    const detail = reserveResult.failed
      .map((failure: { sku: string; reason: string }) => `${failure.sku}: ${failure.reason}`)
      .join(", ");
    console.warn(
      `[WMS Sync] Reservation shortfall for WMS order ${wmsOrderId} (${context}): ${detail} — proceeding without hold; unreservable lines surface as pick shorts`,
    );
    if (omsOrderId) {
      try {
        await db.insert(omsOrderEvents).values({
          orderId: omsOrderId,
          eventType: "reservation_shortfall",
          details: {
            wmsOrderId,
            context,
            failed: reserveResult.failed,
          },
        });
      } catch (err: any) {
        console.error(
          `[WMS Sync] Failed to record reservation shortfall for OMS order ${omsOrderId}: ${err?.message ?? String(err)} — aborting shipment processing`,
        );
        throw new WmsShipmentPrerequisiteError(
          "The reservation shortfall was not durably recorded before shipment processing.",
          { wmsOrderId, omsOrderId, context, causeCode: err?.code ?? null },
          { cause: err },
        );
      }
    }
  }

  private async reserveRequired(
    wmsOrderId: number,
    omsOrderId: number,
    context: string,
  ): Promise<void> {
    let reserveResult: ReservationResult;
    try {
      reserveResult = await this.services.reservation.reserveOrder(
        wmsOrderId,
        "dropship_acceptance",
      );
    } catch (error) {
      await this.compensateFailedRequiredReservation(
        wmsOrderId,
        omsOrderId,
        context,
        null,
        error,
      );
      throw error;
    }
    if (reserveResult.failed.length === 0) return;

    const error = new WmsRequiredInventoryClaimError(
      "Dropship acceptance requires a complete whole-order inventory claim.",
      {
        wmsOrderId,
        omsOrderId,
        context,
        failed: reserveResult.failed,
        reserved: reserveResult.reserved,
        promised: reserveResult.promised,
      },
    );
    await this.compensateFailedRequiredReservation(
      wmsOrderId,
      omsOrderId,
      context,
      reserveResult.canonicalClaimId ?? null,
      error,
    );
    throw error;
  }

  private async assertDropshipAcceptanceReplayIsNonOperational(
    omsOrderId: number,
    wmsOrderId: number,
    warehouseStatus: string | null,
  ): Promise<void> {
    if (warehouseStatus === "pending") return;

    if (warehouseStatus === "completed") {
      const shippableItems = await db
        .select({ id: wmsOrderItems.id })
        .from(wmsOrderItems)
        .where(and(
          eq(wmsOrderItems.orderId, wmsOrderId),
          sql`COALESCE(${wmsOrderItems.requiresShipping}, 1) <> 0`,
        ))
        .limit(1);
      if (shippableItems.length === 0) return;
    }

    if (warehouseStatus === "awaiting_3pl") {
      const [assignment] = await db
        .select({ warehouseType: warehouses.warehouseType })
        .from(wmsOrders)
        .leftJoin(warehouses, eq(warehouses.id, wmsOrders.warehouseId))
        .where(eq(wmsOrders.id, wmsOrderId))
        .limit(1);
      if (assignment?.warehouseType === "3pl") return;
    }

    throw new WmsRequiredInventoryClaimError(
      "Dropship acceptance staging found a WMS order that is already operationally visible.",
      { omsOrderId, wmsOrderId, warehouseStatus },
    );
  }

  private async compensateFailedRequiredReservation(
    wmsOrderId: number,
    omsOrderId: number,
    context: string,
    inventoryClaimId: string | null,
    cause: unknown,
  ): Promise<void> {
    try {
      await this.releaseStagedInventoryClaim({
        wmsOrderId,
        inventoryClaimId,
        reason: `Required dropship acceptance inventory claim failed (${context})`,
      });
    } catch (compensationError) {
      throw new AggregateError(
        [cause, compensationError],
        `Dropship acceptance inventory claim and compensation both failed for OMS order ${omsOrderId}.`,
      );
    }
  }

  private async cancelExistingWmsOrderForFinalOmsOrder(omsOrderId: number): Promise<void> {
    const { cancelWmsOrderAndRelease } = await import("../orders/cancel-wms-order");
    const rows: any = await db.execute(sql`
      SELECT id FROM wms.orders
       WHERE (
               (source IN ('oms', 'ebay') AND oms_fulfillment_order_id = ${String(omsOrderId)})
            OR (source = 'shopify'        AND source_table_id        = ${String(omsOrderId)})
             )
         AND warehouse_status NOT IN ('cancelled', 'shipped')
    `);
    for (const row of rows?.rows ?? []) {
      // P0.1c: single cancel entrypoint — guarded transition + order-scoped
      // reservation release (D-SYNCANCEL: without release, units leak).
      const outcome = await cancelWmsOrderAndRelease(
        db,
        this.services.reservation,
        Number(row.id),
        "oms_final_state_cancel",
      );
      if (outcome.releaseFailed) {
        try {
          await db.insert(omsOrderEvents).values({
            orderId: omsOrderId,
            eventType: "cancel_release_failed",
            details: {
              wmsOrderId: row.id,
              requiresReview: true,
            },
          });
        } catch (_dlErr) {
          // Structured log inside the helper is our trace
        }
      }
    }
  }

  private async refreshExistingWmsOrderHeaderFromOms(
    omsOrder: typeof omsOrders.$inferSelect,
    wmsOrderId: number,
  ): Promise<{ updated: boolean; sortRankChanged: boolean; promoted: boolean }> {
    const [wmsOrder] = await db
      .select({
        id: wmsOrders.id,
        warehouseStatus: wmsOrders.warehouseStatus,
        priority: wmsOrders.priority,
        onHold: wmsOrders.onHold,
        channelShipByDate: wmsOrders.channelShipByDate,
        slaDueAt: wmsOrders.slaDueAt,
        sortRank: wmsOrders.sortRank,
        orderPlacedAt: wmsOrders.orderPlacedAt,
        createdAt: wmsOrders.createdAt,
      })
      .from(wmsOrders)
      .where(eq(wmsOrders.id, wmsOrderId))
      .limit(1);

    if (!wmsOrder || wmsOrder.warehouseStatus === "cancelled") {
      return { updated: false, sortRankChanged: false, promoted: false };
    }

    // Promote pending → ready when OMS order is now paid
    const nextWarehouseStatus = this.determineWarehouseStatus(omsOrder);
    const promoted =
      wmsOrder.warehouseStatus === "pending" && nextWarehouseStatus === "ready";

    const channelShipByDate = (omsOrder as any).channelShipByDate as Date | string | null | undefined;
    const reconcileCutoffConfig = await getSlaCutoffConfig((wmsOrder as any).warehouseId ?? null, db);
    const nextSlaDueAt = await resolveSlaDueAt({
      channelId: omsOrder.channelId,
      channelShipByDate,
      explicitSlaDueAt: null,
      orderPlacedAt: wmsOrder.orderPlacedAt ?? omsOrder.orderedAt,
      createdAt: wmsOrder.createdAt,
      timezone: reconcileCutoffConfig.timezone,
      cutoffLocal: reconcileCutoffConfig.cutoffLocal,
    }, db);
    const nextSortRank = computeSortRank({
      priority: wmsOrder.priority,
      onHold: wmsOrder.onHold,
      slaDueAt: nextSlaDueAt,
      orderPlacedAt: wmsOrder.orderPlacedAt ?? omsOrder.orderedAt ?? wmsOrder.createdAt,
    });
    const nextChannelShipByDate = channelShipByDate ? new Date(channelShipByDate as any) : null;
    const sortRankChanged = wmsOrder.sortRank !== nextSortRank;
    const changed =
      promoted ||
      dateTimeKey(wmsOrder.channelShipByDate) !== dateTimeKey(nextChannelShipByDate) ||
      dateTimeKey(wmsOrder.slaDueAt) !== dateTimeKey(nextSlaDueAt) ||
      sortRankChanged;

    if (!changed) {
      return { updated: false, sortRankChanged: false, promoted: false };
    }

    await db
      .update(wmsOrders)
      .set({
        ...(promoted ? { warehouseStatus: "ready" } : {}),
        channelShipByDate: nextChannelShipByDate,
        slaDueAt: nextSlaDueAt,
        slaStatus: slaStatusFor(nextSlaDueAt),
        sortRank: nextSortRank,
        updatedAt: new Date(),
      })
      .where(eq(wmsOrders.id, wmsOrderId));

    if (promoted) {
      console.log(
        `[WMS Sync] Promoted WMS order ${wmsOrderId} from pending → ready (OMS financial_status=${omsOrder.financialStatus})`,
      );
    }

    if (sortRankChanged && ACTIVE_SORT_RANK_SYNC_STATUSES.has(promoted ? "ready" : String(wmsOrder.warehouseStatus))) {
      await enqueueShipStationSortRankSyncRetry(
        db,
        wmsOrderId,
        "OMS/WMS sync refreshed SLA sort_rank from source order",
      );
    }

    return { updated: true, sortRankChanged, promoted };
  }

  private async reconcileExistingWmsOrderLines(
    omsOrderId: number,
    wmsOrderId: number,
  ): Promise<{ insertedItems: number; updatedShipments: number }> {
    const [omsOrder] = await db
      .select()
      .from(omsOrders)
      .where(eq(omsOrders.id, omsOrderId))
      .limit(1);

    if (!omsOrder || this.isFinalOrCancelledOmsOrder(omsOrder)) {
      await this.cancelExistingWmsOrderForFinalOmsOrder(omsOrderId);
      return { insertedItems: 0, updatedShipments: 0 };
    }

    let omsLines = await db.select().from(omsOrderLines).where(eq(omsOrderLines.orderId, omsOrderId));
    if (omsLines.length === 0) return { insertedItems: 0, updatedShipments: 0 };

    const [wmsOrderState] = await db
      .select({
        warehouseStatus: wmsOrders.warehouseStatus,
        channelId: wmsOrders.channelId,
      })
      .from(wmsOrders)
      .where(eq(wmsOrders.id, wmsOrderId))
      .limit(1);

    if (wmsOrderState?.warehouseStatus === "cancelled") {
      return { insertedItems: 0, updatedShipments: 0 };
    }

    if (
      wmsOrderState?.warehouseStatus === "shipped" &&
      !this.hasOpenShippableOmsDemand(omsLines)
    ) {
      return { insertedItems: 0, updatedShipments: 0 };
    }

    await this.refreshOmsLineMaterializedQuantities(omsOrderId);
    omsLines = await db.select().from(omsOrderLines).where(eq(omsOrderLines.orderId, omsOrderId));

    const existingItems = await db
      .select({
        id: wmsOrderItems.id,
        omsOrderLineId: wmsOrderItems.omsOrderLineId,
        sku: wmsOrderItems.sku,
        quantity: wmsOrderItems.quantity,
        pickedQuantity: wmsOrderItems.pickedQuantity,
        fulfilledQuantity: wmsOrderItems.fulfilledQuantity,
        status: wmsOrderItems.status,
      })
      .from(wmsOrderItems)
      .where(eq(wmsOrderItems.orderId, wmsOrderId));
    const existingOmsLineIds = new Set(
      existingItems.map((item) => item.omsOrderLineId).filter((id): id is number => id != null),
    );
    const missingLines = omsLines.filter(
      (line) => !existingOmsLineIds.has(line.id) && getOmsLineRemainingMaterializableQuantity(line) > 0,
    );

    // Sync cancellations and quantity changes from OMS to WMS. Reductions
    // below picked quantity require review; safe edits recalculate line status,
    // including reopening completed lines when channel authority increases.
    const omsLineById = new Map(omsLines.map((line) => [line.id, line]));
    for (const wmsItem of existingItems) {
      if (!wmsItem.omsOrderLineId) continue;
      if (wmsItem.status === "cancelled") continue;

      const omsLine = omsLineById.get(wmsItem.omsOrderLineId);
      const omsQty = omsLine ? getOmsLineMaterializableQuantity(omsLine) : 0;
      const wmsQty = wmsItem.quantity ?? 0;

      if (omsQty === wmsQty) continue;

      if ((wmsItem.pickedQuantity ?? 0) > 0 && omsQty < (wmsItem.pickedQuantity ?? 0)) {
        console.warn(
          `[WMS Sync] Item ${wmsItem.sku} (id ${wmsItem.id}): OMS qty reduced to ${omsQty} but ${wmsItem.pickedQuantity} already picked - needs manual review`,
        );
        await this.recordWmsReconciliationReviewException(db, {
          rule: "picked_quantity_exceeds_oms_authority",
          source: "reconcileExistingWmsOrderLines",
          omsOrderId,
          wmsOrderId,
          wmsOrderItemId: wmsItem.id,
          omsOrderLineId: wmsItem.omsOrderLineId,
          sku: wmsItem.sku,
          omsQuantity: omsQty,
          wmsQuantity: wmsQty,
          pickedQuantity: wmsItem.pickedQuantity ?? 0,
        });
      } else {
        const reconciled = await reconcileWmsOrderItemAuthority(db, {
          itemId: wmsItem.id,
          orderId: wmsOrderId,
          authorityQuantity: omsQty,
        });
        const reconciledStatus = reconciled.status;
        console.log(
          `[WMS Sync] Reconciled item ${wmsItem.sku} (id ${wmsItem.id}): qty ${wmsQty} -> ${omsQty}, status ${wmsItem.status} -> ${reconciledStatus}`,
        );
      }
    }

    const insertedItems: {
      id: number;
      omsOrderLineId: number | null;
      productId: number | null;
      quantity: number;
      requiresShipping: boolean;
    }[] = [];

    for (const line of missingLines) {
      const inserted = await db.transaction(async (tx: any) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(918407, ${omsOrderId})`);

        const duplicateItem = await tx
          .select({ id: wmsOrderItems.id })
          .from(wmsOrderItems)
          .where(and(
            eq(wmsOrderItems.orderId, wmsOrderId),
            eq(wmsOrderItems.omsOrderLineId, line.id),
          ))
          .limit(1);
        if (duplicateItem.length > 0) return null;

        const lockedLine = (await this.lockOmsLinesForMaterialization(tx, omsOrderId))
          .find((candidate) => candidate.id === line.id);
        if (!lockedLine) return null;

        const materializableQuantity = getOmsLineRemainingMaterializableQuantity(lockedLine);
        if (materializableQuantity <= 0) return null;

        const itemToInsert = await buildWmsLineItemFromOmsLine(
          tx,
          lockedLine,
          materializableQuantity,
          wmsOrderId,
        );

        const [created] = await insertWmsOrderItems(tx, [itemToInsert]);

        if (created) {
          await this.incrementOmsLineMaterializedQuantities(tx, [created]);
          await this.recordWmsReconciliationAuditEvent(
            tx,
            omsOrderId,
            "materialize_authorized_oms_line",
            {
              wmsOrderId,
              wmsOrderItemId: created.id,
              omsOrderLineId: created.omsOrderLineId,
              quantity: created.quantity,
              requiresShipping: Number((created as any).requiresShipping ?? 0) !== 0,
            },
          );
        }
        return created ?? null;
      });
      if (inserted) {
        insertedItems.push({
          ...inserted,
          requiresShipping: Number((inserted as any).requiresShipping ?? 0) !== 0,
        });
      }
    }

    await refreshWmsOrderItemFinancialSnapshotsFromOms(db, {
      wmsOrderId,
      omsOrderId,
    });

    const orphanItemResult = await db.execute<{
      id: number;
      oms_order_line_id: number | null;
      product_id: number | null;
      quantity: number;
    }>(sql`
      WITH active_shipment_qty AS (
        SELECT
          osi.order_item_id,
          COALESCE(SUM(osi.qty), 0)::int AS qty
        FROM wms.outbound_shipment_items osi
        JOIN wms.outbound_shipments os ON os.id = osi.shipment_id
        WHERE os.order_id = ${wmsOrderId}
          AND os.status NOT IN ('voided', 'cancelled')
        GROUP BY osi.order_item_id
      )
      SELECT
        oi.id,
        oi.oms_order_line_id,
        oi.product_id,
        GREATEST(
          COALESCE(oi.quantity, 0)
          - GREATEST(
              COALESCE(oi.fulfilled_quantity, 0),
              COALESCE(asq.qty, 0)
            ),
          0
        )::int AS quantity
      FROM wms.order_items oi
      LEFT JOIN active_shipment_qty asq
        ON asq.order_item_id = oi.id
      WHERE oi.order_id = ${wmsOrderId}
        AND COALESCE(oi.requires_shipping, 1) <> 0
        AND oi.status NOT IN ('cancelled')
        AND GREATEST(
          COALESCE(oi.quantity, 0)
          - GREATEST(
              COALESCE(oi.fulfilled_quantity, 0),
              COALESCE(asq.qty, 0)
            ),
          0
        ) > 0
    `);
    const shippableShipmentItems = (orphanItemResult.rows ?? [])
      .map((row) => ({
        id: Number(row.id),
        omsOrderLineId: row.oms_order_line_id == null ? null : Number(row.oms_order_line_id),
        productId: row.product_id == null ? null : Number(row.product_id),
        quantity: Number(row.quantity ?? 0),
      }))
      .filter((item) => Number.isInteger(item.id) && item.id > 0 && item.quantity > 0);

    await db.execute(sql`
      UPDATE wms.orders w
         SET warehouse_status = CASE
               WHEN w.warehouse_status IN ('cancelled', 'pending', 'awaiting_3pl')
                 THEN w.warehouse_status
               WHEN EXISTS (
                 SELECT 1
                 FROM wms.order_items pending_items
                 WHERE pending_items.order_id = w.id
                   AND COALESCE(pending_items.requires_shipping, 1) <> 0
                   AND COALESCE(pending_items.quantity, 0) > 0
                   AND COALESCE(pending_items.quantity, 0) > COALESCE(pending_items.fulfilled_quantity, 0)
                   AND pending_items.status NOT IN ('cancelled', 'completed')
               ) THEN 'ready'
               WHEN (
                 SELECT COUNT(*) FROM wms.order_items all_items
                 WHERE all_items.order_id = w.id
               ) = 0 THEN 'cancelled'
               -- Anything else means the order has lines but none of them are
               -- pickable right now. That is not evidence of completion, and
               -- this rollup has none: it cannot see picks or shipments, and it
               -- never stamps completed_at. It used to answer 'completed' here,
               -- which marked orders #62269 and #62226 done while they sat
               -- unpicked with zero units - and 'completed' is terminal, so the
               -- repair pass skipped them for three days. Completion is owned by
               -- completeOrder() and updateOrderStatus(), which check the
               -- transition is legal and record when it happened. Leave the
               -- status alone and let the writers with evidence move it.
               ELSE w.warehouse_status
             END,
             item_count = agg.item_count,
             unit_count = agg.unit_count,
             picked_count = agg.picked_count,
             updated_at = NOW()
        FROM (
          SELECT
            order_id,
            COUNT(*)::int AS item_count,
            COALESCE(SUM(quantity), 0)::int AS unit_count,
            COALESCE(SUM(picked_quantity), 0)::int AS picked_count
          FROM wms.order_items
          WHERE order_id = ${wmsOrderId}
          GROUP BY order_id
        ) agg
       WHERE w.id = agg.order_id
    `);

    await this.refreshOmsLineMaterializedQuantities(omsOrderId);

    // Re-check the post-reconciliation status. Ready orders must cross the
    // authority-aware reservation boundary after every newly materialized line
    // is present but before shipment creation, attachment, or provider outbox
    // writes. Explicit shortfalls remain valid; thrown/unknown claim failures
    // abort here.
    const [freshWmsState] = await db
      .select({
        warehouseStatus: wmsOrders.warehouseStatus,
        warehouseId: wmsOrders.warehouseId,
      })
      .from(wmsOrders)
      .where(eq(wmsOrders.id, wmsOrderId))
      .limit(1);
    if (freshWmsState?.warehouseStatus === "cancelled") {
      return { insertedItems: insertedItems.length, updatedShipments: 0 };
    }
    if (shippableShipmentItems.length === 0) {
      return { insertedItems: insertedItems.length, updatedShipments: 0 };
    }
    // Unpaid pending work and external 3PL custody do not enter the local
    // claim/provider path. A paid sync promotes pending -> ready before this
    // point. All provider mutation below therefore has an explicit warehouse
    // and a successfully resolved authority boundary.
    if (freshWmsState?.warehouseStatus !== "ready") {
      return { insertedItems: insertedItems.length, updatedShipments: 0 };
    }
    const reconciledWarehouseId = requireRoutedWarehouseId({
      omsOrderId,
      hasShippableItems: true,
      routedWarehouseId: freshWmsState.warehouseId,
    });
    await this.reserveBeforeShipmentProcessing(
      wmsOrderId,
      omsOrderId,
      "existing_order_reconciliation",
    );

    // Shipment reconciliation is driven by provider editability, not by an
    // assumption that every late order edit needs a second package.
    const activeShipments = await db
      .select({
        id: outboundShipments.id,
        status: outboundShipments.status,
        source: outboundShipments.source,
        shipmentPurpose: outboundShipments.shipmentPurpose,
        replacesShipmentId: outboundShipments.replacesShipmentId,
        shippingEngine: outboundShipments.shippingEngine,
        engineOrderRef: outboundShipments.engineOrderRef,
        shipstationOrderId: outboundShipments.shipstationOrderId,
        requiresReview: outboundShipments.requiresReview,
      })
      .from(outboundShipments)
      .where(and(
        eq(outboundShipments.orderId, wmsOrderId),
        notInArray(outboundShipments.status, ["voided", "cancelled"]),
      ));

    const orderItemIds = shippableShipmentItems.map((item) => item.id);
    let updatedShipments = 0;
    const recordLateEditReview = async (
      rule: WmsReconciliationManualReviewRule,
      summary: string,
      reviewMessage: string,
    ) => {
      const item = shippableShipmentItems[0];
      const line = omsLines.find((candidate) => candidate.id === item.omsOrderLineId);
      const existingItem = existingItems.find((candidate) => candidate.id === item.id);
      await this.recordWmsReconciliationReviewException(db, {
        rule,
        source: "reconcileExistingWmsOrderLines",
        omsOrderId,
        wmsOrderId,
        wmsOrderItemId: item.id,
        omsOrderLineId: item.omsOrderLineId,
        sku: line?.sku ?? null,
        omsQuantity: line ? getOmsLineMaterializableQuantity(line) : item.quantity,
        wmsQuantity: item.quantity,
        pickedQuantity: existingItem?.pickedQuantity ?? 0,
        summary,
        reviewMessage,
      });
    };

    if (activeShipments.length === 0) {
      const created = await this.persistInitialProviderShipmentAfterInventoryAuthority({
        omsOrderId,
        wmsOrderId,
        expectedWarehouseId: reconciledWarehouseId,
        recordReconciliationAudit: true,
      });
      updatedShipments += created.changedItems;
      return { insertedItems: insertedItems.length, updatedShipments };
    }

    const selection = selectLateOrderShipmentTarget(activeShipments);
    if (selection.state === "ambiguous") {
      await recordLateEditReview(
        "ambiguous_late_edit_shipment_target",
        `Late order edit for WMS order ${wmsOrderId} has multiple eligible package targets`,
        `Eligible shipment ids: ${selection.shipmentIds.join(", ")}`,
      );
      return { insertedItems: insertedItems.length, updatedShipments: 0 };
    }
    if (selection.state === "none") {
      await recordLateEditReview(
        "no_safe_late_edit_shipment_target",
        `Late order edit for WMS order ${wmsOrderId} has no safe customer-fulfillment package target`,
        `Observed shipment ids: ${activeShipments.map((shipment) => shipment.id).join(", ")}`,
      );
      return { insertedItems: insertedItems.length, updatedShipments: 0 };
    }

    const target = selection.shipment;
    if (target.requiresReview) {
      await recordLateEditReview(
        "late_edit_shipment_requires_review",
        `Late order edit for WMS order ${wmsOrderId} cannot modify shipment ${target.id} while it requires review`,
        `Shipment ${target.id} must be resolved before late demand is routed`,
      );
      return { insertedItems: insertedItems.length, updatedShipments: 0 };
    }

    if (target.status === "planned") {
      const coverage = await db.transaction(async (tx: any) => {
        const attached = await appendUncoveredItemsToShipment(
          tx,
          wmsOrderId,
          target.id,
          orderItemIds,
          {
            providerMembershipState: PROVIDER_MEMBERSHIP_AUTHORITATIVE,
            useXactLock: true,
          },
        );
        if (attached.shipmentItemIds.length > 0) {
          await enqueueShipStationShipmentPushRetry(
            tx,
            target.id,
            "WMS line reconciliation added authorized demand to planned shipment",
          );
          await this.recordWmsReconciliationAuditEvent(
            tx,
            omsOrderId,
            "attach_authorized_line_to_planned_shipment",
            {
              wmsOrderId,
              wmsShipmentId: target.id,
              orderItemIds,
              outboundShipmentItemIds: attached.shipmentItemIds,
              addedQuantity: attached.addedQuantity,
            },
          );
        }
        return attached;
      });
      updatedShipments += coverage.shipmentItemIds.length;
      return { insertedItems: insertedItems.length, updatedShipments };
    }

    if (target.status === "queued" || target.status === "on_hold") {
      const hasProviderIdentity = Boolean(
        (target.shippingEngine && target.engineOrderRef) ||
        target.shipstationOrderId,
      );
      if (!hasProviderIdentity) {
        await recordLateEditReview(
          "late_edit_provider_identity_missing",
          `Late order edit for WMS order ${wmsOrderId} cannot amend shipment ${target.id} without provider identity`,
          `Shipment ${target.id} status=${target.status} has no engine order reference`,
        );
        return { insertedItems: insertedItems.length, updatedShipments: 0 };
      }

      const coverage = await db.transaction(async (tx: any) => {
        const attached = await appendUncoveredItemsToShipment(
          tx,
          wmsOrderId,
          target.id,
          orderItemIds,
          {
            providerMembershipState: PROVIDER_MEMBERSHIP_PENDING_APPEND,
            useXactLock: true,
          },
        );
        if (attached.shipmentItemIds.length > 0) {
          await enqueueShippingEngineShipmentAmendRetry(
            tx,
            target.id,
            attached.shipmentItemIds,
            "OMS order edit added authorized demand after shipping-engine push",
          );
          await this.recordWmsReconciliationAuditEvent(
            tx,
            omsOrderId,
            "attach_authorized_line_to_editable_engine_order",
            {
              wmsOrderId,
              wmsShipmentId: target.id,
              orderItemIds,
              outboundShipmentItemIds: attached.shipmentItemIds,
              addedQuantity: attached.addedQuantity,
              providerMembershipState: PROVIDER_MEMBERSHIP_PENDING_APPEND,
            },
          );
        }
        return attached;
      });
      updatedShipments += coverage.shipmentItemIds.length;
      return { insertedItems: insertedItems.length, updatedShipments };
    }

    if (["labeled", "shipped", "delivered"].includes(target.status)) {
      const residual = await db.transaction(async (tx: any) => {
        const created = await createLateEditResidualShipment(
          tx,
          wmsOrderId,
          wmsOrderState?.channelId ?? null,
          orderItemIds,
          { useXactLock: true },
        );
        if (created.shipmentItemIds.length > 0) {
          await enqueueShipStationShipmentPushRetry(
            tx,
            created.shipmentId,
            `late order demand discovered after shipment ${target.id} reached ${target.status}`,
          );
          await this.recordWmsReconciliationAuditEvent(
            tx,
            omsOrderId,
            "create_late_edit_residual_shipment",
            {
              wmsOrderId,
              originalWmsShipmentId: target.id,
              residualWmsShipmentId: created.shipmentId,
              originalStatus: target.status,
              orderItemIds,
              outboundShipmentItemIds: created.shipmentItemIds,
              addedQuantity: created.addedQuantity,
            },
          );
        }
        return created;
      });
      updatedShipments += residual.shipmentItemIds.length;
      return { insertedItems: insertedItems.length, updatedShipments };
    }

    await recordLateEditReview(
      "no_safe_late_edit_shipment_target",
      `Late order edit for WMS order ${wmsOrderId} encountered unsupported shipment status ${target.status}`,
      `Shipment ${target.id} was not modified`,
    );
    return { insertedItems: insertedItems.length, updatedShipments: 0 };
  }

  /**
   * Propagate order edits from OMS to WMS after an orders/updated webhook.
   * Diffs OMS line items against WMS order items and applies changes
   * based on the WMS item's pick status.
   */
  async propagateOmsEditsToWms(
    omsOrderId: number,
    shopifyLineItems: any[] | undefined,
    sourceEventId: string,
  ): Promise<{
    updated: number;
    added: number;
    removed: number;
    flaggedForReview: string[];
  }> {
    const LOG = "[WMS Edit Propagation]";
    const result = { updated: 0, added: 0, removed: 0, flaggedForReview: [] as string[] };

    // 1. Find WMS order
    const wmsOrderResult = await db.execute<{
      id: number;
      warehouse_status: string;
    }>(sql`
      SELECT id, warehouse_status FROM wms.orders
      WHERE (source = 'oms' AND oms_fulfillment_order_id = ${String(omsOrderId)})
         OR (source = 'shopify' AND source_table_id = ${String(omsOrderId)})
      LIMIT 1
    `);
    if (wmsOrderResult.rows.length === 0) return result;

    const wmsOrderId = wmsOrderResult.rows[0].id;
    const warehouseStatus = wmsOrderResult.rows[0].warehouse_status;

    if (["shipped", "cancelled", "completed"].includes(warehouseStatus)) {
      console.log(`${LOG} Skipping order ${wmsOrderId} — terminal state '${warehouseStatus}'`);
      return result;
    }

    await this.refreshOmsLineMaterializedQuantities(omsOrderId);

    // 2. Current OMS lines (already updated by webhook handler)
    const omsLines = await db
      .select()
      .from(omsOrderLines)
      .where(eq(omsOrderLines.orderId, omsOrderId));

    // 3. Current WMS items
    const wmsItems = await db
      .select()
      .from(wmsOrderItems)
      .where(eq(wmsOrderItems.orderId, wmsOrderId));

    const wmsItemByOmsLineId = new Map(
      wmsItems
        .filter((item) => item.omsOrderLineId != null)
        .map((item) => [item.omsOrderLineId!, item]),
    );
    const omsLineById = new Map(omsLines.map((line) => [line.id, line]));

    // Shopify external line IDs still in the webhook payload
    const shopifyLineIdSet = shopifyLineItems
      ? new Set(shopifyLineItems.map((item: any) => String(item.id)))
      : null;

    const changes: string[] = [];

    // 4. Process existing WMS items — detect qty changes and removals
    for (const wmsItem of wmsItems) {
      if (!wmsItem.omsOrderLineId) continue;
      if (wmsItem.status === "cancelled") continue;

      const omsLine = omsLineById.get(wmsItem.omsOrderLineId);

      // Check if item was removed from Shopify order
      const wasRemoved =
        shopifyLineIdSet &&
        omsLine?.externalLineItemId &&
        !shopifyLineIdSet.has(omsLine.externalLineItemId);

      if (wasRemoved) {
        if (wmsItem.status === "pending") {
          await reconcileWmsOrderItemAuthority(db, {
            itemId: wmsItem.id,
            orderId: wmsOrderId,
            authorityQuantity: 0,
          });
          changes.push(`Cancelled pending item ${wmsItem.sku} (removed from order)`);
          result.removed++;
        } else if (wmsItem.status === "completed" || wmsItem.pickedQuantity > 0) {
          const reviewMessage =
            `Item ${wmsItem.sku} (id ${wmsItem.id}) removed from order but ${wmsItem.pickedQuantity} already picked - needs manual reversal`;
          result.flaggedForReview.push(reviewMessage);
          await this.recordWmsReconciliationReviewException(db, {
            rule: "edit_removed_picked_wms_item",
            source: "propagateOmsEditsToWms",
            omsOrderId,
            wmsOrderId,
            wmsOrderItemId: wmsItem.id,
            omsOrderLineId: wmsItem.omsOrderLineId,
            externalLineItemId: omsLine?.externalLineItemId ?? null,
            sku: wmsItem.sku,
            omsQuantity: 0,
            wmsQuantity: wmsItem.quantity ?? 0,
            pickedQuantity: wmsItem.pickedQuantity ?? 0,
            reviewMessage,
            summary: reviewMessage,
          });
        }
        continue;
      }

      if (!omsLine) continue;

      const omsQty = getOmsLineMaterializableQuantity(omsLine);
      const wmsQty = wmsItem.quantity;
      const catalogSku = omsLine.productVariantId
        ? await createOrderLineCatalogIdentityRepository(db).catalogSku(omsLine.productVariantId)
        : omsLine.catalogProductId ? await createOrderLineCatalogIdentityRepository(db).catalogProductSku(omsLine.catalogProductId) : null;
      const resolvedSku = selectWmsCatalogSku(omsLine.sku, catalogSku);

      if (omsQty === wmsQty) {
        // Qty unchanged — check for SKU/name/variant updates
        const updates: Record<string, any> = {};
        if (resolvedSku !== "UNKNOWN" && resolvedSku !== wmsItem.sku) updates.sku = resolvedSku;
        if (omsLine.title && omsLine.title !== wmsItem.name)
          updates.name = omsLine.title;
        if (
          omsLine.productVariantId &&
          omsLine.productVariantId !== wmsItem.productId
        ) {
          updates.productId = omsLine.productVariantId;
          const bin = await resolveAssignedBinLocation(db, omsLine.productVariantId);
          if (bin) {
            updates.location = bin.location;
            updates.zone = bin.zone;
          }
        }

        if (Object.keys(updates).length > 0) {
          await updateWmsOrderItemCatalogSnapshot(db, {
            itemId: wmsItem.id,
            ...updates,
          });
          changes.push(`Updated fields for ${wmsItem.sku}: ${Object.keys(updates).join(", ")}`);
          result.updated++;
        }
        continue;
      }

      // Qty changed
      if (wmsItem.status === "pending" || wmsItem.pickedQuantity === 0) {
        // Not yet picked — safe to update
        const updates: Record<string, any> = { quantity: omsQty };
        if (resolvedSku !== "UNKNOWN" && resolvedSku !== wmsItem.sku) updates.sku = resolvedSku;
        if (omsLine.title && omsLine.title !== wmsItem.name)
          updates.name = omsLine.title;
        if (
          omsLine.productVariantId &&
          omsLine.productVariantId !== wmsItem.productId
        ) {
          updates.productId = omsLine.productVariantId;
          const bin = await resolveAssignedBinLocation(db, omsLine.productVariantId);
          if (bin) {
            updates.location = bin.location;
            updates.zone = bin.zone;
          }
        }

        if (omsQty <= 0) {
          updates.status = "cancelled";
        }

        await reconcileWmsOrderItemAuthority(db, {
          itemId: wmsItem.id,
          orderId: wmsOrderId,
          authorityQuantity: omsQty,
          catalogSnapshot: updates,
        });
        changes.push(
          `${wmsItem.sku}: qty ${wmsQty} → ${omsQty}${omsQty <= 0 ? " (cancelled)" : ""}`,
        );
        result.updated++;
      } else if (wmsItem.pickedQuantity > 0) {
        if (omsQty < wmsItem.pickedQuantity) {
          // Qty reduced below what was already picked
          const reviewMessage =
            `Item ${wmsItem.sku} (id ${wmsItem.id}): qty reduced ${wmsQty} -> ${omsQty} but ${wmsItem.pickedQuantity} already picked`;
          result.flaggedForReview.push(reviewMessage);
          await this.recordWmsReconciliationReviewException(db, {
            rule: "edit_picked_quantity_exceeds_oms_authority",
            source: "propagateOmsEditsToWms",
            omsOrderId,
            wmsOrderId,
            wmsOrderItemId: wmsItem.id,
            omsOrderLineId: wmsItem.omsOrderLineId,
            externalLineItemId: omsLine.externalLineItemId ?? null,
            sku: wmsItem.sku,
            omsQuantity: omsQty,
            wmsQuantity: wmsQty,
            pickedQuantity: wmsItem.pickedQuantity ?? 0,
            reviewMessage,
            summary: reviewMessage,
          });
        } else if (omsQty > wmsQty) {
          // Qty increased — update qty, mark pending so picker picks the rest
          await reconcileWmsOrderItemAuthority(db, {
            itemId: wmsItem.id,
            orderId: wmsOrderId,
            authorityQuantity: omsQty,
          });
          changes.push(
            `${wmsItem.sku}: qty ${wmsQty} → ${omsQty} (${wmsItem.pickedQuantity} already picked, more picks needed)`,
          );
          result.updated++;
        } else {
          // Qty decreased but still >= picked — update qty
          await reconcileWmsOrderItemAuthority(db, {
            itemId: wmsItem.id,
            orderId: wmsOrderId,
            authorityQuantity: omsQty,
          });
          changes.push(`${wmsItem.sku}: qty ${wmsQty} → ${omsQty}`);
          result.updated++;
        }
      }
    }

    // 5. Add new items (OMS lines not yet in WMS)
    for (const omsLine of omsLines) {
      const materializableQuantity = getOmsLineRemainingMaterializableQuantity(omsLine);
      if (wmsItemByOmsLineId.has(omsLine.id)) continue;
      if (materializableQuantity <= 0) continue;

      // Skip items already removed from Shopify
      if (
        shopifyLineIdSet &&
        omsLine.externalLineItemId &&
        !shopifyLineIdSet.has(omsLine.externalLineItemId)
      ) {
        continue;
      }

      const inserted = await db.transaction(async (tx: any) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(918407, ${omsOrderId})`);

        const duplicateItem = await tx
          .select({ id: wmsOrderItems.id })
          .from(wmsOrderItems)
          .where(and(
            eq(wmsOrderItems.orderId, wmsOrderId),
            eq(wmsOrderItems.omsOrderLineId, omsLine.id),
          ))
          .limit(1);
        if (duplicateItem.length > 0) return null;

        const lockedLine = (await this.lockOmsLinesForMaterialization(tx, omsOrderId))
          .find((candidate) => candidate.id === omsLine.id);
        if (!lockedLine) return null;

        const remainingQuantity = getOmsLineRemainingMaterializableQuantity(lockedLine);
        if (remainingQuantity <= 0) return null;

        const itemToInsert = await buildWmsLineItemFromOmsLine(
          tx,
          lockedLine,
          remainingQuantity,
          wmsOrderId,
        );
        await insertWmsOrderItems(tx, [itemToInsert]);
        await this.incrementOmsLineMaterializedQuantities(tx, [itemToInsert]);
        return { sku: itemToInsert.sku, quantity: remainingQuantity };
      });

      if (!inserted) continue;

      changes.push(`Added new item ${inserted.sku} (qty ${inserted.quantity})`);
      result.added++;
    }

    const demandChanged = result.updated > 0 || result.added > 0 || result.removed > 0;

    // 6. Recalculate order-level counts
    if (demandChanged) {
      const updatedItems = await db
        .select()
        .from(wmsOrderItems)
        .where(eq(wmsOrderItems.orderId, wmsOrderId));
      const activeItems = updatedItems.filter(
        (item) => (item.status as string) !== "cancelled",
      );
      const newItemCount = activeItems.filter((i) => i.requiresShipping === 1).length;
      const newUnitCount = activeItems
        .filter((i) => i.requiresShipping === 1)
        .reduce((sum, item) => sum + (item.quantity || 0), 0);
      const newPickedCount = activeItems.reduce(
        (sum, item) => sum + (item.pickedQuantity || 0),
        0,
      );

      await db.execute(sql`
        UPDATE wms.orders SET
          item_count = ${newItemCount},
          unit_count = ${newUnitCount},
          picked_count = ${newPickedCount},
          updated_at = NOW()
        WHERE id = ${wmsOrderId}
      `);

      await this.refreshOmsLineMaterializedQuantities(omsOrderId);
    }

    // Always present the durable event to the authority-aware reconciler. On
    // retry the WMS rows may already contain the new demand, so `demandChanged`
    // can be false even though the canonical claim still needs reconciliation.
    let shouldRepush = demandChanged;
    try {
      const claimReconciliation = await this.services.reservation.reconcileOrderDemand({
        orderId: wmsOrderId,
        sourceEventId,
        demandChanged,
        reason: "Order edited — reconciling inventory claim for updated items",
      });
      shouldRepush = shouldRepush || claimReconciliation.reconciled === true;
    } catch (e: any) {
      if (e?.code === "CANONICAL_DEMAND_RECONCILIATION_FAILED") throw e;
      console.warn(`${LOG} Reservation rebalance failed for order ${wmsOrderId}: ${e.message}`);
    }

    if (shouldRepush) {
      // Re-push planned shipments to ShipStation so SS reflects updated items.
      // Only push 'planned' — 'queued'/'labeled' shipments are already in SS
      // and re-pushing would overwrite the SS order (undoing any SS-side
      // splits the operator made).
      const repushEngine = this.services.shippingEngine ?? this.services.shipStation;
      if (repushEngine?.isConfigured?.()) {
        try {
          const activeShipments = await db.execute<{ id: number }>(sql`
            SELECT id FROM wms.outbound_shipments
            WHERE order_id = ${wmsOrderId}
              AND status = 'planned'
              -- Never re-push a held shipment (line-item hold): it must stay out
              -- of ShipStation until released (pushShipment refuses it anyway).
              AND COALESCE(held, false) = false
            ORDER BY id
          `);
          for (const shipment of activeShipments.rows ?? []) {
            try {
              if (this.services.shippingEngine) {
                await this.services.shippingEngine.upsertShipment({ shipmentId: shipment.id } as any);
              } else {
                await this.services.shipStation.pushShipment(shipment.id);
              }
              console.log(`${LOG} Re-pushed shipment ${shipment.id} to engine after item edit`);
            } catch (pushErr: any) {
              await enqueueShipStationShipmentPushRetry(
                db,
                shipment.id,
                pushErr instanceof Error ? pushErr : new Error(pushErr?.message ?? String(pushErr)),
              );
            }
          }
        } catch (e: any) {
          console.error(`${LOG} Failed to re-push shipments to ShipStation for order ${wmsOrderId}: ${e.message}`);
        }
      }
    }

    // 7. Audit event
    if (result.updated > 0 || result.added > 0 || result.removed > 0 || result.flaggedForReview.length > 0) {
      await db.insert(omsOrderEvents).values({
        orderId: omsOrderId,
        eventType: "wms_edit_propagated",
        details: {
          wmsOrderId,
          warehouseStatus,
          changes,
          flaggedForReview: result.flaggedForReview,
          counts: { updated: result.updated, added: result.added, removed: result.removed },
        },
      });
    }

    if (result.flaggedForReview.length > 0) {
      console.warn(`${LOG} Order ${wmsOrderId} has items requiring review:`, result.flaggedForReview);
    }

    if (warehouseStatus === "picking") {
      console.warn(
        `${LOG} Order ${wmsOrderId} modified while picker is active — picker may have stale data`,
      );
    }

    console.log(
      `${LOG} Order ${wmsOrderId}: ${result.updated} updated, ${result.added} added, ${result.removed} removed, ${result.flaggedForReview.length} flagged`,
    );

    return result;
  }

  /**
   * Determine WMS priority via Composite Score:
   * WMS Priority = (Shipping Speed Base) + (Plan Tier Modifier)
   * Higher score = higher priority in the pick queue.
   * WMS "Bump" override uses 9999; "Hold" uses -1.
   */
  private async determinePriority(omsOrder: typeof omsOrders.$inferSelect): Promise<{
    priority: number;
    memberPlanName: string | null;
    memberPlanColor: string | null;
  }> {
    // 1. Shipping Service Level Base — higher base = picked sooner.
    //    Reads the normalized service_level field, NOT the customer-facing
    //    shipping_method string. The method label is zone-dependent and
    //    unreliable (e.g. "USPS Priority Mail" is a carrier service class,
    //    not a customer-paid expedite).
    //    Base scores are admin-configurable via /pick-priority (warehouse.echelon_settings).
    const level = (((omsOrder as any).shippingServiceLevel as string | null) || "standard") as ShippingServiceLevel;
    const base = await getShippingBase(level, db);

    // 2. Dynamic Tier Modifier + plan metadata snapshot.
    //    Fetches priority_modifier for sort math AND plan name/primary_color
    //    so the picker can render the membership badge without re-joining
    //    on every render. Snapshot is frozen at sync time.
    let modifier = 0;
    let memberPlanName: string | null = null;
    let memberPlanColor: string | null = null;

    try {
      // A member is still entitled to their CURRENT plan's priority modifier
      // until the billing cycle ends. A scheduled downgrade
      // (pending_downgrade) or cancellation (pending_cancellation) does NOT
      // revoke the plan immediately — it applies at cycle end. Matching only
      // status='active' previously dropped these members to a 0 modifier
      // (retail-tier pick priority) the moment they scheduled a change.
      //
      // This is the same entitled-status set used by the membership
      // member_current_membership view and shellz-club's
      // getActiveMemberSubscription(). ORDER BY created_at DESC mirrors the
      // view's "most recent subscription wins" rule so a member with both an
      // active and a pending row resolves deterministically to the latest.
      const result = await db.execute(sql`
        SELECT p.priority_modifier, p.name, p.primary_color
        FROM membership.plans p
        INNER JOIN membership.member_subscriptions ms ON p.id = ms.plan_id
        INNER JOIN membership.members m ON ms.member_id = m.id
        WHERE (
          m.email = ${omsOrder.customerEmail ?? null}
          OR m.shopify_customer_id = ${
            omsOrder.rawPayload
              ? (omsOrder.rawPayload as any).customer?.id ?? null
              : null
          }
        )
          AND ms.status IN ('active', 'pending_downgrade', 'pending_cancellation')
        ORDER BY ms.created_at DESC
        LIMIT 1
      `);

      if (result.rows.length > 0) {
        modifier = Number(result.rows[0].priority_modifier);
        memberPlanName = (result.rows[0].name as string) || null;
        memberPlanColor = (result.rows[0].primary_color as string) || null;
      } else if (omsOrder.memberTier) {
        const planResult = await db.execute(sql`
          SELECT priority_modifier, name, primary_color FROM membership.plans
          WHERE LOWER(name) = LOWER(${omsOrder.memberTier})
             OR id = ${omsOrder.memberTier}
          LIMIT 1
        `);
        if (planResult.rows.length > 0) {
          modifier = Number(planResult.rows[0].priority_modifier);
          memberPlanName = (planResult.rows[0].name as string) || null;
          memberPlanColor = (planResult.rows[0].primary_color as string) || null;
        }
      }
    } catch (err) {
      console.warn(`[WMS Sync] Failed to fetch priority modifier for order ${omsOrder.id}:`, err);
    }

    // Higher = Better: base + modifier. Leads can manually set 9999 (Bump) or -1 (Hold).
    return {
      priority: base + modifier,
      memberPlanName,
      memberPlanColor,
    };
  }

  /**
   * Batch sync multiple OMS orders to WMS
   */
  async syncBatch(omsOrderIds: number[]): Promise<{ synced: number; failed: number }> {
    let synced = 0;
    let failed = 0;

    for (const id of omsOrderIds) {
      const result = await this.syncOmsOrderToWms(id);
      if (result) {
        synced++;
      } else {
        failed++;
      }
    }

    console.log(`[WMS Sync] Batch sync: ${synced} synced, ${failed} failed`);
    return { synced, failed };
  }

  /**
   * Backfill: Find OMS orders not yet synced to WMS and sync them
   */
  async backfillUnsynced(limit: number = 100): Promise<number> {
    // Existence check MUST mirror the canonical OMS→WMS link used everywhere
    // else (syncOmsOrderToWms:142-162, cancelExistingWmsOrderForFinalOmsOrder:650-651,
    // propagateOmsEditsToWms:1137-1138): the live link is
    // `source='oms' AND oms_fulfillment_order_id = <oms id>`, with the
    // `source='shopify' AND source_table_id = <oms id>` legacy fallback.
    //
    // The previous query checked ONLY `source_table_id = oms id AND source='oms'`,
    // but source_table_id is always NULL for source='oms' rows — so NOT EXISTS
    // was always true, every order looked "unsynced", and `ORDER BY ordered_at
    // DESC LIMIT 100` only ever re-touched the 100 newest (already-synced, no-op).
    // Genuinely-stuck older orders were never reached. (Bug: dead safety net.)
    //
    // Terminal/externally-fulfilled orders are excluded: an order that is
    // already shipped/fulfilled but has NO WMS order was fulfilled outside this
    // WMS (manual/Shopify fulfillment or pre-WMS history). Creating a WMS order
    // for it now would push a DUPLICATE order to the shipping engine.
    const unsynced = await db.execute<{ id: number }>(sql`
      SELECT oo.id
      FROM oms.oms_orders oo
      WHERE NOT EXISTS (
        SELECT 1 FROM wms.orders o
        WHERE (o.source = 'oms'     AND o.oms_fulfillment_order_id = oo.id::text)
           OR (o.source = 'shopify' AND o.source_table_id          = oo.id::text)
      )
      AND oo.status            NOT IN ('cancelled', 'refunded', 'shipped')
      AND COALESCE(oo.fulfillment_status, '') <> 'fulfilled'
      AND COALESCE(oo.financial_status, '')   NOT IN ('refunded', 'voided')
      ORDER BY oo.ordered_at ASC
      LIMIT ${limit}
    `);

    const ids = unsynced.rows.map((r) => r.id);
    if (ids.length === 0) {
      console.log(`[WMS Sync] No unsynced orders found`);
      return 0;
    }

    const result = await this.syncBatch(ids);
    return result.synced;
  }

  /**
   * Reconcile cancellations: find OMS orders that are still active but
   * cancelled in shopify_orders, then cascade the cancellation through
   * OMS → WMS → shipments → ShipStation.
   *
   * This catches orders where the Shopify orders/cancelled webhook was
   * never delivered, was dropped, or failed silently.
   */
  async reconcileCancellations(limit: number = 100): Promise<{ cancelled: number; failed: number }> {
    const stale = await db.execute<{
      oms_id: number;
      external_order_number: string;
      wms_id: number | null;
    }>(sql`
      SELECT oo.id AS oms_id,
             oo.external_order_number,
             o.id AS wms_id
      FROM oms.oms_orders oo
      LEFT JOIN wms.orders o
        ON (o.source = 'oms' AND o.oms_fulfillment_order_id = oo.id::text)
        OR (o.source = 'shopify' AND o.source_table_id = oo.id::text)
      WHERE oo.status NOT IN ('cancelled', 'refunded')
        AND EXISTS (
          SELECT 1 FROM shopify_orders so
          WHERE split_part(so.id, '/', -1) = split_part(oo.external_order_id, '/', -1)
            AND so.cancelled_at IS NOT NULL
        )
      ORDER BY oo.ordered_at ASC
      LIMIT ${limit}
    `);

    const rows = stale.rows ?? [];
    if (rows.length === 0) {
      console.log(`[WMS Sync] Cancel reconcile: no stale cancellations found`);
      return { cancelled: 0, failed: 0 };
    }

    console.log(`[WMS Sync] Cancel reconcile: found ${rows.length} orders cancelled in Shopify but active in OMS`);

    const { cancelOrderCascade } = await import("./oms-webhooks");

    let ssService: any = null;
    try {
      const { createShipStationService } = await import("./shipstation.service");
      ssService = createShipStationService(db);
    } catch (_) {}

    let cancelled = 0;
    let failed = 0;
    const now = new Date();

    for (const row of rows) {
      try {
        await db.execute(sql`
          UPDATE oms.oms_orders SET
            status = 'cancelled',
            cancelled_at = ${now},
            updated_at = ${now}
          WHERE id = ${row.oms_id}
            AND status NOT IN ('cancelled', 'refunded')
        `);

        await cancelOrderCascade(db, row.oms_id, {
          wmsServices: this.services,
          shipStationService: ssService,
          source: "cancel_reconciliation",
          reason: "shopify_cancelled_at present, webhook missed",
          logPrefix: "[Cancel Reconcile]",
        });

        console.log(`[WMS Sync] Cancel reconcile: cancelled ${row.external_order_number} (OMS ${row.oms_id}, WMS ${row.wms_id ?? "none"})`);
        cancelled++;
      } catch (err: any) {
        console.error(`[WMS Sync] Cancel reconcile: failed for OMS ${row.oms_id} (${row.external_order_number}): ${err.message}`);
        failed++;
      }
    }

    console.log(`[WMS Sync] Cancel reconcile: ${cancelled} cancelled, ${failed} failed`);
    return { cancelled, failed };
  }

  /**
   * One-time cleanup: find OMS orders that were cancelled by the GID
   * normalization migration (101) but still have active ShipStation orders.
   * Cascades the cancellation through WMS → shipments → ShipStation.
   */
  async cleanupGidDuplicateShipments(limit: number = 200): Promise<{ cancelled: number; failed: number }> {
    const dupes = await db.execute<{
      oms_id: number;
      external_order_number: string;
      wms_id: number | null;
    }>(sql`
      SELECT oo.id AS oms_id,
             oo.external_order_number,
             o.id AS wms_id
      FROM oms.oms_orders oo
      LEFT JOIN wms.orders o
        ON o.source = 'oms' AND o.oms_fulfillment_order_id = oo.id::text
      WHERE oo.status = 'cancelled'
        AND EXISTS (
          SELECT 1 FROM wms.outbound_shipments s
          WHERE s.order_id = o.id
            AND s.shipstation_order_id IS NOT NULL
            AND s.status NOT IN ('cancelled', 'voided')
        )
        AND EXISTS (
          SELECT 1 FROM oms.oms_orders twin
          WHERE twin.channel_id = oo.channel_id
            AND twin.external_order_id = oo.external_order_id
            AND twin.id <> oo.id
            AND twin.status NOT IN ('cancelled', 'refunded')
        )
      LIMIT ${limit}
    `);

    const rows = dupes.rows ?? [];
    if (rows.length === 0) {
      console.log(`[WMS Sync] GID cleanup: no duplicate shipments to cancel`);
      return { cancelled: 0, failed: 0 };
    }

    console.log(`[WMS Sync] GID cleanup: found ${rows.length} cancelled OMS orders with active SS shipments`);

    const { cancelOrderCascade } = await import("./oms-webhooks");

    let ssService: any = null;
    try {
      const { createShipStationService } = await import("./shipstation.service");
      ssService = createShipStationService(db);
    } catch (_) {}

    let cancelled = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        await cancelOrderCascade(db, row.oms_id, {
          wmsServices: this.services,
          shipStationService: ssService,
          source: "gid_duplicate_cleanup",
          reason: "duplicate OMS order from GID/numeric mismatch",
          logPrefix: "[GID Cleanup]",
        });
        console.log(`[WMS Sync] GID cleanup: cascaded cancel for ${row.external_order_number} (OMS ${row.oms_id})`);
        cancelled++;
      } catch (err: any) {
        console.error(`[WMS Sync] GID cleanup: failed for OMS ${row.oms_id}: ${err.message}`);
        failed++;
      }
    }

    return { cancelled, failed };
  }

  /**
   * Resync items for an existing WMS order from its OMS source.
   * Use when a WMS order has 0 items or stale/wrong items.
   * WARNING: deletes all existing order_items for the WMS order, re-creates from OMS.
   */
  async resyncOrderItems(wmsOrderId: number): Promise<{ success: boolean; message: string; itemCount?: number }> {
    try {
      // 1. Find the WMS order
      const [wmsOrder] = await db.select().from(wmsOrders).where(eq(wmsOrders.id, wmsOrderId)).limit(1);
      if (!wmsOrder) return { success: false, message: `WMS order ${wmsOrderId} not found` };

      const omsOrderId = wmsOrder.omsFulfillmentOrderId ? parseInt(wmsOrder.omsFulfillmentOrderId, 10) : null;
      if (!omsOrderId) return { success: false, message: `WMS order ${wmsOrderId} has no OMS source link` };

      const newItems = await db.transaction(async (tx: any) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(918407, ${omsOrderId})`);
        const lockedOmsLines = await this.lockOmsLinesForMaterialization(tx, omsOrderId);
        if (lockedOmsLines.length === 0) {
          throw new Error(`OMS order ${omsOrderId} has no line items`);
        }

        // 3. Re-create items from OMS authority. The WMS command refuses this
        // destructive repair after pick, fulfillment, or shipment progress exists.
        const rebuiltItems: InsertWmsOrderItem[] = [];
        for (const line of lockedOmsLines) {
          const materializableQuantity = getOmsLineMaterializableQuantity(line);
          if (materializableQuantity <= 0) continue;
          rebuiltItems.push(
            await buildWmsLineItemFromOmsLine(
              tx,
              line,
              materializableQuantity,
              wmsOrderId,
            ),
          );
        }

        await replaceUnstartedWmsOrderItemsForRepair(tx, {
          orderId: wmsOrderId,
          items: rebuiltItems,
        });
        await tx.execute(sql`
          UPDATE oms.oms_order_lines
             SET wms_materialized_quantity = 0,
                 updated_at = NOW()
           WHERE order_id = ${omsOrderId}
        `);
        if (rebuiltItems.length > 0) {
          await this.incrementOmsLineMaterializedQuantities(tx, rebuiltItems);
        }

        return rebuiltItems;
      });

      // 5. Recalculate order counts
      const { ordersStorage } = await import('../orders');
      await ordersStorage.updateOrderProgress(wmsOrderId);

      console.log(`[WMS Resync] Resynced ${newItems.length} items for WMS order ${wmsOrderId} (OMS ${omsOrderId})`);
      return { success: true, message: `Resynced ${newItems.length} items`, itemCount: newItems.length };
    } catch (err: any) {
      console.error(`[WMS Resync] Failed for WMS order ${wmsOrderId}: ${err.message}`);
      return { success: false, message: err.message };
    }
  }

  /**
   * Find and repair WMS orders with broken items (0 items, or mismatch with OMS)
   */
  async repairBrokenOrders(dryRun = true): Promise<{ ordersFixed: number; ordersFailed: number; details: any[] }> {
    // Find WMS orders linked to OMS where item counts don't match
    const broken = await db.execute<{ wms_id: number; wms_order_number: string; wms_item_count: number; oms_line_count: number; oms_order_id: number }>(sql`
      SELECT 
        o.id as wms_id,
        o.order_number as wms_order_number,
        COUNT(oi.id) as wms_item_count,
        oms_counts.line_count as oms_line_count,
        oms_counts.oms_id as oms_order_id
      FROM wms.orders o
      LEFT JOIN wms.order_items oi ON oi.order_id = o.id
      JOIN (
        SELECT oo.id as oms_id, oo.external_order_number, COUNT(ol.id) as line_count
        FROM oms.oms_orders oo
        LEFT JOIN oms_order_lines ol ON ol.order_id = oo.id
        GROUP BY oo.id, oo.external_order_number
      ) oms_counts ON oms_counts.external_order_number = o.order_number
      WHERE o.source = 'oms'
        AND o.warehouse_status NOT IN ('shipped', 'cancelled')
      GROUP BY o.id, o.order_number, oms_counts.line_count, oms_counts.oms_id
      HAVING COUNT(oi.id) != oms_counts.line_count
      ORDER BY o.id DESC
    `);

    const details: any[] = [];
    let ordersFixed = 0;
    let ordersFailed = 0;

    for (const row of broken.rows) {
      const detail: any = {
        wmsOrderId: row.wms_id,
        orderNumber: row.wms_order_number,
        wmsItemCount: Number(row.wms_item_count),
        omsLineCount: Number(row.oms_line_count),
        action: dryRun ? 'dry_run' : 'pending',
      };

      if (!dryRun) {
        const result = await this.resyncOrderItems(row.wms_id);
        detail.action = result.success ? 'fixed' : 'failed';
        detail.message = result.message;
        if (result.success) ordersFixed++; else ordersFailed++;
      }
      details.push(detail);
    }

    return { ordersFixed, ordersFailed, details };
  }

}

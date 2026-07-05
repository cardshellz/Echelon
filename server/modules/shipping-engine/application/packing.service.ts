/**
 * Packing station (v2) — application layer.
 *
 * Closes the calibration loop opened by pack-plan.service (v1 pushed the
 * predicted box into ShipStation notes): the pack station shows the pack
 * plan per order and the packer confirms the ACTUAL box + weight used per
 * parcel (migration 121 columns on shipping.pack_plan_parcels). When every
 * parcel of a plan is confirmed the plan transitions active → 'packed'.
 * Predicted vs actual on the same parcel row is the dataset the cartonizer
 * tunes on.
 *
 * All shipping.pack_plans* writes live in this module (writer ratchet).
 * This service does NOT touch wms.orders.warehouse_status — order-status
 * transitions stay with the orders module (order-status-core).
 */

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  orderItems,
  orders,
  productVariants,
  shippingBoxCatalog,
  shippingPackPlanParcelItems,
  shippingPackPlanParcels,
  shippingPackPlans,
  type ShippingPackPlan,
  type ShippingPackPlanParcel,
} from "@shared/schema";
import { db } from "../../../db";

/**
 * Warehouse statuses whose orders belong on the packing queue. Picking hands
 * off via markReadyToShip → warehouse_status 'ready_to_ship' (picking.use-cases);
 * 'picked'/'packing' are the granular station states from order-status-core.
 */
export const PACKING_ELIGIBLE_WAREHOUSE_STATUSES = [
  "ready_to_ship",
  "picked",
  "packing",
] as const;

const QUEUE_LIMIT = 200;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** A parcel is confirmed once the pack station stamped it. */
export function isParcelConfirmed(parcel: { packedAt: Date | null }): boolean {
  return parcel.packedAt != null;
}

/** Plan is fully packed when EVERY parcel is confirmed (and there is at least one). */
export function allParcelsConfirmed(parcels: readonly { packedAt: Date | null }[]): boolean {
  return parcels.length > 0 && parcels.every(isParcelConfirmed);
}

/**
 * Predicted-vs-actual weight delta in grams (actual − estimated), or null
 * until the parcel has an actual weight recorded.
 */
export function weightDeltaGrams(
  estWeightGrams: number,
  actualWeightGrams: number | null,
): number | null {
  if (actualWeightGrams == null) return null;
  return actualWeightGrams - estWeightGrams;
}

// ---------------------------------------------------------------------------
// Queue read model
// ---------------------------------------------------------------------------

export interface PackingParcelItemView {
  productVariantId: number;
  sku: string | null;
  name: string | null;
  quantity: number;
  isRider: boolean;
}

export interface PackingParcelView {
  id: number;
  parcelSequence: number;
  boxId: number | null;
  boxCode: string | null;
  boxName: string | null;
  siocProductVariantId: number | null;
  siocSku: string | null;
  estWeightGrams: number;
  billableWeightGrams: number;
  actualBoxId: number | null;
  actualWeightGrams: number | null;
  weightDeltaGrams: number | null;
  packedAt: Date | null;
  packedBy: string | null;
  items: PackingParcelItemView[];
}

export interface PackingPlanView {
  id: number;
  status: string;
  engineVersion: string;
  createdAt: Date;
  parcels: PackingParcelView[];
}

export interface PackingQueueOrder {
  id: number;
  orderNumber: string;
  customerName: string;
  warehouseStatus: string;
  shippingServiceLevel: string;
  itemCount: number;
  unitCount: number;
  items: { sku: string; name: string; quantity: number }[];
  plan: PackingPlanView | null;
}

export interface PackingBoxOption {
  id: number;
  code: string;
  name: string;
  isActive: boolean;
}

export interface PackingQueueResult {
  orders: PackingQueueOrder[];
  boxes: PackingBoxOption[];
}

export async function getPackingQueue(): Promise<PackingQueueResult> {
  const queueOrders = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      customerName: orders.customerName,
      warehouseStatus: orders.warehouseStatus,
      shippingServiceLevel: orders.shippingServiceLevel,
      itemCount: orders.itemCount,
      unitCount: orders.unitCount,
    })
    .from(orders)
    .where(and(
      inArray(orders.warehouseStatus, [...PACKING_ELIGIBLE_WAREHOUSE_STATUSES]),
      eq(orders.onHold, 0),
    ))
    .orderBy(desc(orders.priority), asc(orders.createdAt))
    .limit(QUEUE_LIMIT);

  const orderIds = queueOrders.map((o) => o.id);

  const [itemRows, planByOrder, boxes] = await Promise.all([
    orderIds.length === 0
      ? Promise.resolve([])
      : db
          .select({
            orderId: orderItems.orderId,
            sku: orderItems.sku,
            name: orderItems.name,
            quantity: orderItems.quantity,
            requiresShipping: orderItems.requiresShipping,
          })
          .from(orderItems)
          .where(inArray(orderItems.orderId, orderIds)),
    loadPlansForOrders(orderIds),
    db
      .select({
        id: shippingBoxCatalog.id,
        code: shippingBoxCatalog.code,
        name: shippingBoxCatalog.name,
        isActive: shippingBoxCatalog.isActive,
      })
      .from(shippingBoxCatalog)
      .where(eq(shippingBoxCatalog.isActive, true))
      .orderBy(asc(shippingBoxCatalog.code)),
  ]);

  const itemsByOrder = new Map<number, { sku: string; name: string; quantity: number }[]>();
  for (const row of itemRows) {
    if (row.requiresShipping !== 1 || row.quantity <= 0) continue;
    const list = itemsByOrder.get(row.orderId) ?? [];
    list.push({ sku: row.sku, name: row.name, quantity: row.quantity });
    itemsByOrder.set(row.orderId, list);
  }

  return {
    orders: queueOrders.map((order) => ({
      ...order,
      items: itemsByOrder.get(order.id) ?? [],
      plan: planByOrder.get(order.id) ?? null,
    })),
    boxes,
  };
}

/**
 * Newest displayable plan per order: an 'active' plan wins over 'packed'
 * (a re-cartonized order supersedes its packed history), then highest id.
 */
async function loadPlansForOrders(orderIds: number[]): Promise<Map<number, PackingPlanView>> {
  const result = new Map<number, PackingPlanView>();
  if (orderIds.length === 0) return result;

  const planRows = await db
    .select()
    .from(shippingPackPlans)
    .where(and(
      inArray(shippingPackPlans.wmsOrderId, orderIds),
      inArray(shippingPackPlans.status, ["active", "packed"]),
    ))
    .orderBy(desc(shippingPackPlans.id));

  const chosenByOrder = new Map<number, ShippingPackPlan>();
  for (const plan of planRows) {
    if (plan.wmsOrderId == null) continue;
    const current = chosenByOrder.get(plan.wmsOrderId);
    if (!current) {
      chosenByOrder.set(plan.wmsOrderId, plan);
    } else if (current.status !== "active" && plan.status === "active") {
      chosenByOrder.set(plan.wmsOrderId, plan);
    }
    // Rows arrive newest-first, so the first hit per (order, status-class) sticks.
  }

  const chosenPlans = [...chosenByOrder.values()];
  if (chosenPlans.length === 0) return result;

  const parcelsByPlan = await loadParcelViews(chosenPlans.map((p) => p.id));
  for (const plan of chosenPlans) {
    result.set(plan.wmsOrderId as number, {
      id: plan.id,
      status: plan.status,
      engineVersion: plan.engineVersion,
      createdAt: plan.createdAt,
      parcels: parcelsByPlan.get(plan.id) ?? [],
    });
  }
  return result;
}

async function loadParcelViews(planIds: number[]): Promise<Map<number, PackingParcelView[]>> {
  const byPlan = new Map<number, PackingParcelView[]>();
  if (planIds.length === 0) return byPlan;

  const parcelRows = await db
    .select({
      parcel: shippingPackPlanParcels,
      boxCode: shippingBoxCatalog.code,
      boxName: shippingBoxCatalog.name,
      siocSku: productVariants.sku,
    })
    .from(shippingPackPlanParcels)
    .leftJoin(shippingBoxCatalog, eq(shippingBoxCatalog.id, shippingPackPlanParcels.boxId))
    .leftJoin(productVariants, eq(productVariants.id, shippingPackPlanParcels.siocProductVariantId))
    .where(inArray(shippingPackPlanParcels.packPlanId, planIds))
    .orderBy(asc(shippingPackPlanParcels.packPlanId), asc(shippingPackPlanParcels.parcelSequence));

  const parcelIds = parcelRows.map((r) => r.parcel.id);
  const itemRows = parcelIds.length === 0
    ? []
    : await db
        .select({
          parcelId: shippingPackPlanParcelItems.parcelId,
          productVariantId: shippingPackPlanParcelItems.productVariantId,
          quantity: shippingPackPlanParcelItems.quantity,
          isRider: shippingPackPlanParcelItems.isRider,
          sku: productVariants.sku,
          name: productVariants.name,
        })
        .from(shippingPackPlanParcelItems)
        .leftJoin(productVariants, eq(productVariants.id, shippingPackPlanParcelItems.productVariantId))
        .where(inArray(shippingPackPlanParcelItems.parcelId, parcelIds));

  const itemsByParcel = new Map<number, PackingParcelItemView[]>();
  for (const row of itemRows) {
    const list = itemsByParcel.get(row.parcelId) ?? [];
    list.push({
      productVariantId: row.productVariantId,
      sku: row.sku,
      name: row.name,
      quantity: row.quantity,
      isRider: row.isRider,
    });
    itemsByParcel.set(row.parcelId, list);
  }

  for (const row of parcelRows) {
    const parcel = row.parcel;
    const list = byPlan.get(parcel.packPlanId) ?? [];
    list.push({
      id: parcel.id,
      parcelSequence: parcel.parcelSequence,
      boxId: parcel.boxId,
      boxCode: row.boxCode,
      boxName: row.boxName,
      siocProductVariantId: parcel.siocProductVariantId,
      siocSku: parcel.siocProductVariantId != null ? row.siocSku : null,
      estWeightGrams: parcel.estWeightGrams,
      billableWeightGrams: parcel.billableWeightGrams,
      actualBoxId: parcel.actualBoxId,
      actualWeightGrams: parcel.actualWeightGrams,
      weightDeltaGrams: weightDeltaGrams(parcel.estWeightGrams, parcel.actualWeightGrams),
      packedAt: parcel.packedAt,
      packedBy: parcel.packedBy,
      items: itemsByParcel.get(parcel.id) ?? [],
    });
    byPlan.set(parcel.packPlanId, list);
  }
  return byPlan;
}

// ---------------------------------------------------------------------------
// Parcel confirmation
// ---------------------------------------------------------------------------

export interface ConfirmParcelInput {
  planId: number;
  parcelId: number;
  actualBoxId?: number | null;
  actualWeightGrams?: number | null;
  packedBy?: string | null;
}

export type ConfirmParcelResult =
  | { ok: true; planStatus: string; parcel: ShippingPackPlanParcel; allConfirmed: boolean }
  | { ok: false; code: "PLAN_NOT_FOUND" | "PARCEL_NOT_FOUND" | "PLAN_NOT_CONFIRMABLE" | "BOX_NOT_FOUND" };

/**
 * Record the actual box/weight for one parcel and stamp packed_at/packed_by.
 * When that leaves every parcel of the plan confirmed, the plan transitions
 * to 'packed' (from 'active' only — superseded/cancelled plans are frozen).
 * Re-confirming an already-confirmed parcel overwrites the actuals (packers
 * correct mistakes); packed_at is refreshed so the newest reading wins.
 */
export async function confirmParcel(input: ConfirmParcelInput): Promise<ConfirmParcelResult> {
  return db.transaction(async (tx) => {
    const [plan] = await tx
      .select()
      .from(shippingPackPlans)
      .where(eq(shippingPackPlans.id, input.planId))
      .limit(1);
    if (!plan) return { ok: false as const, code: "PLAN_NOT_FOUND" as const };
    if (plan.status !== "active" && plan.status !== "packed") {
      // Superseded/cancelled plans must never collect actuals — they no
      // longer describe what the packer is looking at.
      return { ok: false as const, code: "PLAN_NOT_CONFIRMABLE" as const };
    }

    if (input.actualBoxId != null) {
      const [box] = await tx
        .select({ id: shippingBoxCatalog.id })
        .from(shippingBoxCatalog)
        .where(eq(shippingBoxCatalog.id, input.actualBoxId))
        .limit(1);
      if (!box) return { ok: false as const, code: "BOX_NOT_FOUND" as const };
    }

    const [parcel] = await tx
      .update(shippingPackPlanParcels)
      .set({
        actualBoxId: input.actualBoxId ?? null,
        actualWeightGrams: input.actualWeightGrams ?? null,
        packedAt: new Date(),
        packedBy: input.packedBy?.trim() || null,
      })
      .where(and(
        eq(shippingPackPlanParcels.id, input.parcelId),
        eq(shippingPackPlanParcels.packPlanId, input.planId),
      ))
      .returning();
    if (!parcel) return { ok: false as const, code: "PARCEL_NOT_FOUND" as const };

    const siblings = await tx
      .select({ packedAt: shippingPackPlanParcels.packedAt })
      .from(shippingPackPlanParcels)
      .where(eq(shippingPackPlanParcels.packPlanId, input.planId));

    const allConfirmed = allParcelsConfirmed(siblings);
    let planStatus = plan.status;
    if (allConfirmed && plan.status === "active") {
      await tx
        .update(shippingPackPlans)
        .set({ status: "packed", updatedAt: new Date() })
        .where(and(
          eq(shippingPackPlans.id, input.planId),
          eq(shippingPackPlans.status, "active"),
        ));
      planStatus = "packed";
    }

    return { ok: true as const, planStatus, parcel, allConfirmed };
  });
}

/**
 * WMS adapter for the standalone cartonization module.
 *
 * Pack plans — PACKER INSTRUCTION v1 (application layer).
 *
 * A pack plan is ONE record consumed by both pricing and the pack station
 * (docs/SHIPPING-ENGINE-DESIGN.md) so the quoted box choice and the physical
 * pack can never diverge. ensurePackPlan() cartonizes the order's shippable
 * items, persists plan + parcels + unit placements (superseding any prior active
 * plan when the inputs changed), and renders a compact packer instruction
 * string ("BOX: M x2 + S x1") that rides ShipStation internalNotes.
 *
 * Contracts:
 *  - NEVER throws to callers: any failure → console.warn + null. The WMS
 *    packing handoff treats null as a blocker; the legacy ShipStation-note
 *    wrapper may still omit the note without breaking an already-started push.
 *  - Idempotent: an ACTIVE plan whose input_hash matches the current inputs
 *    is returned unchanged; otherwise prior active plans for the order are
 *    marked 'superseded' and a new plan is inserted in one transaction.
 *  - Incomplete data never instructs a packer: if ANY physical unit lacks a
 *    verified placement, nothing is persisted and no instruction is produced.
 *  - All shipping.pack_plans* writes live in THIS module (writer ratchet).
 */

import { createHash } from "crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  orderItems,
  orders,
  shippingPackPlanParcelItems,
  shippingPackPlanParcels,
  shippingPackPlans,
  type ShippingPackPlan,
} from "@shared/schema";
import { db } from "../../../db";
import {
  cartonize,
  CARTONIZE_ENGINE,
  isCartonizeCandidateVerified,
  type CartonizeBox,
  type CartonizeItem,
  type CartonParcel,
} from "../domain/cartonize";
import { buildCartonizeItems } from "../domain/build-items";
import {
  loadActiveBoxes,
  loadPackingInputs,
  resolveVariantIdsBySku,
} from "../infrastructure/packing-input.repository";

/** Origin used when an order has no warehouse assigned (primary warehouse). */
const DEFAULT_ORIGIN_WAREHOUSE_ID = 1;

/** Hard cap so ShipStation internalNotes never balloons past readability. */
export const PACK_INSTRUCTION_MAX_LENGTH = 200;

const ENGINE_VERSION = `${CARTONIZE_ENGINE.name}@${CARTONIZE_ENGINE.version}`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnsurePackPlanRequest {
  wmsOrderId: number;
  /** wms.shipment_requests id (NOT an outbound shipment id). Optional. */
  shipmentRequestId?: number | null;
}

export interface PackPlanResult {
  plan: ShippingPackPlan;
  /** Cartonizer parcels backing the plan (domain shape, deterministic). */
  parcels: CartonParcel[];
  /** Packer-facing instruction, or null when the packing is incomplete. */
  instruction: string | null;
  /** True when no parcel degraded to a fallback. */
  complete: boolean;
}

export interface PackPlanOrderLine {
  sku: string;
  quantity: number;
}

/** Injectable loaders/writers (DB defaults) — mirrors ShadowDeps. */
export interface PackPlanDeps {
  loadOrder: (
    wmsOrderId: number,
  ) => Promise<{ id: number; warehouseId: number | null } | null>;
  loadOrderItems: (wmsOrderId: number) => Promise<PackPlanOrderLine[]>;
  resolveVariantIdsBySku: typeof resolveVariantIdsBySku;
  loadPackingInputs: typeof loadPackingInputs;
  loadActiveBoxes: typeof loadActiveBoxes;
  findActivePlan: (wmsOrderId: number) => Promise<ShippingPackPlan | null>;
  /** Transactional: supersede prior active plans + insert plan/parcels/items. */
  persistPlan: (input: PersistPlanInput) => Promise<ShippingPackPlan>;
}

export interface PersistPlanInput {
  wmsOrderId: number;
  shipmentRequestId: number | null;
  engineVersion: string;
  inputHash: string;
  warnings: string[];
  parcels: CartonParcel[];
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Render the packer instruction from cartonizer parcels.
 *
 * Returns null when there is nothing to instruct or when ANY parcel is a
 * fallback — a guess must never reach the pack station. Boxed parcels group
 * by box code ("M x2"); SIOC parcels group by sku ("SIOC SLV-100 x2").
 * Rider items live INSIDE a host parcel, so they never add an entry.
 */
export function buildBoxInstruction(parcels: CartonParcel[]): string | null {
  if (parcels.length === 0) return null;
  if (parcels.some((p) => p.reason.includes("fallback"))) return null;

  const boxCounts = new Map<string, number>();
  const siocCounts = new Map<string, number>();
  for (const parcel of parcels) {
    if (parcel.boxCode != null) {
      boxCounts.set(parcel.boxCode, (boxCounts.get(parcel.boxCode) ?? 0) + 1);
    } else if (parcel.siocProductVariantId != null) {
      const sku = parcel.items[0]?.sku ?? `variant-${parcel.siocProductVariantId}`;
      siocCounts.set(sku, (siocCounts.get(sku) ?? 0) + 1);
    } else {
      // Neither a box nor a SIOC container — cannot describe it truthfully.
      return null;
    }
  }

  const parts = [
    ...[...boxCounts.entries()].map(([code, count]) => `${code} x${count}`),
    ...[...siocCounts.entries()].map(([sku, count]) => `SIOC ${sku} x${count}`),
  ];
  if (parts.length === 0) return null;

  let instruction = `BOX: ${parts.join(" + ")}`;
  if (instruction.length > PACK_INSTRUCTION_MAX_LENGTH) {
    // Truncate on a part boundary and mark the omission — a clipped-but-valid
    // prefix beats an ambiguous mid-token cut.
    const suffix = " +…";
    while (parts.length > 1 && instruction.length + suffix.length > PACK_INSTRUCTION_MAX_LENGTH) {
      parts.pop();
      instruction = `BOX: ${parts.join(" + ")}`;
    }
    instruction = `${instruction}${suffix}`;
    if (instruction.length > PACK_INSTRUCTION_MAX_LENGTH) {
      instruction = instruction.slice(0, PACK_INSTRUCTION_MAX_LENGTH);
    }
  }
  return instruction;
}

/**
 * Deterministic hash of the cartonization INPUT (items + packing attrs +
 * box suite) for cheap staleness checks — same construction idea as
 * rate-quote.service's request hash. Item and box order do not matter.
 */
export function computePackPlanInputHash(
  items: readonly CartonizeItem[],
  boxes: readonly CartonizeBox[],
): string {
  const normalized = {
    items: items
      .map((i) => ({
        productVariantId: i.productVariantId,
        sku: i.sku,
        quantity: i.quantity,
        weightGrams: i.weightGrams,
        lengthMm: i.lengthMm,
        widthMm: i.widthMm,
        heightMm: i.heightMm,
        shippingGroupCode: i.shippingGroupCode,
        shipsInOwnContainer: i.shipsInOwnContainer,
        riderEligible: i.riderEligible,
        riderVoidCm3: i.riderVoidCm3,
        riderVoidMaxWeightGrams: i.riderVoidMaxWeightGrams,
        riderVoidMaxItems: i.riderVoidMaxItems,
      }))
      .sort((a, b) =>
        a.productVariantId - b.productVariantId
        || (a.sku ?? "").localeCompare(b.sku ?? "")),
    boxes: boxes
      .map((box) => ({
        id: box.id,
        code: box.code,
        kind: box.kind,
        lengthMm: box.lengthMm,
        widthMm: box.widthMm,
        heightMm: box.heightMm,
        tareWeightGrams: box.tareWeightGrams,
        maxWeightGrams: box.maxWeightGrams,
        costCents: box.costCents,
        fillFactorBps: box.fillFactorBps,
        isActive: box.isActive,
      }))
      .sort((a, b) => a.id - b.id),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

// ---------------------------------------------------------------------------
// ensurePackPlan
// ---------------------------------------------------------------------------

export async function ensurePackPlan(
  request: EnsurePackPlanRequest,
  overrides: Partial<PackPlanDeps> = {},
): Promise<PackPlanResult | null> {
  const deps: PackPlanDeps = {
    loadOrder: loadWmsOrder,
    loadOrderItems: loadShippableOrderLines,
    resolveVariantIdsBySku,
    loadPackingInputs,
    loadActiveBoxes,
    findActivePlan: findActivePlanForOrder,
    persistPlan: persistPlanTransactional,
    ...overrides,
  };

  try {
    const wmsOrderId = request.wmsOrderId;
    if (!Number.isInteger(wmsOrderId) || wmsOrderId <= 0) {
      console.warn(`[PackPlan] invalid wmsOrderId ${String(wmsOrderId)}; no plan`);
      return null;
    }

    const order = await deps.loadOrder(wmsOrderId);
    if (!order) {
      console.warn(`[PackPlan] wms order ${wmsOrderId} not found; no plan`);
      return null;
    }

    const lines = await deps.loadOrderItems(wmsOrderId);
    if (lines.length === 0) {
      console.warn(`[PackPlan] wms order ${wmsOrderId} has no shippable items; no plan`);
      return null;
    }

    const variantIdBySku = await deps.resolveVariantIdsBySku(lines.map((l) => l.sku));
    const packingInputs = await deps.loadPackingInputs([...variantIdBySku.values()]);
    const { items, warnings: itemWarnings } = buildCartonizeItems(
      lines, variantIdBySku, packingInputs,
    );

    const originWarehouseId = order.warehouseId ?? DEFAULT_ORIGIN_WAREHOUSE_ID;
    const boxes = await deps.loadActiveBoxes(originWarehouseId);

    const packing = cartonize(items, boxes);
    // candidates[0] is the primary strategy (fewest-parcels, or fallback).
    const candidate = packing.candidates[0];
    const parcels = candidate.parcels;
    const instruction = buildBoxInstruction(parcels);
    const complete = instruction !== null && isCartonizeCandidateVerified(candidate);

    if (!complete) {
      // Fallback/degraded packings are never persisted: fallback parcels can
      // carry synthetic variant ids and zero weights that violate the
      // pack_plan_parcels FK/CHECK constraints, and a guessed plan must never
      // reach pricing or the pack station anyway.
      console.warn(
        `[PackPlan] order ${wmsOrderId}: packing incomplete (` +
          `${[...itemWarnings, ...candidate.warnings].slice(0, 3).join("; ") || "no parcels"}); no plan persisted`,
      );
      return null;
    }

    const inputHash = computePackPlanInputHash(items, boxes);

    const requestedShipmentId = request.shipmentRequestId ?? null;
    const existing = await deps.findActivePlan(wmsOrderId);
    if (
      existing
      && existing.inputHash === inputHash
      && existing.engineVersion === ENGINE_VERSION
      && (requestedShipmentId === null || existing.shipmentRequestId === requestedShipmentId)
    ) {
      // Same inputs and engine version mean the stored plan is already this
      // deterministic packing. Return it unchanged — no supersede, no insert.
      return { plan: existing, parcels, instruction, complete };
    }

    const plan = await deps.persistPlan({
      wmsOrderId,
      shipmentRequestId: requestedShipmentId,
      engineVersion: ENGINE_VERSION,
      inputHash,
      warnings: [...itemWarnings, ...candidate.warnings],
      parcels,
    });

    return { plan, parcels, instruction, complete };
  } catch (error) {
    console.warn(
      `[PackPlan] ensurePackPlan failed for order ${request.wmsOrderId}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// ShipStation-push wrapper (called from the oms module — read-only there)
// ---------------------------------------------------------------------------

/**
 * Feature-flagged instruction fetch for the ShipStation push payload.
 *
 * OFF unless SHIPPING_PACK_INSTRUCTION_ENABLED === "true" (zero behavior
 * change on deploy). Never throws; any failure degrades to null and the
 * push proceeds with the plain provenance note.
 *
 * @param wmsOrderId  wms.orders id
 * @param shipmentId  wms.outbound_shipments id — logging context only; it is
 *                    NOT a shipment_request_id, so it is never stored on the
 *                    plan (the FK targets wms.shipment_requests).
 */
export async function maybeGetPackInstruction(
  wmsOrderId: number,
  shipmentId?: number,
  overrides: Partial<PackPlanDeps> = {},
): Promise<string | null> {
  if (process.env.SHIPPING_PACK_INSTRUCTION_ENABLED !== "true") return null;
  try {
    const result = await ensurePackPlan({ wmsOrderId }, overrides);
    return result?.instruction ?? null;
  } catch (error) {
    // ensurePackPlan already never-throws; this is belt-and-suspenders.
    console.warn(
      `[PackPlan] pack instruction unavailable for order ${wmsOrderId}` +
        `${shipmentId != null ? ` (shipment ${shipmentId})` : ""}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Default DB loaders / writer
// ---------------------------------------------------------------------------

async function loadWmsOrder(
  wmsOrderId: number,
): Promise<{ id: number; warehouseId: number | null } | null> {
  const rows = await db
    .select({ id: orders.id, warehouseId: orders.warehouseId })
    .from(orders)
    .where(eq(orders.id, wmsOrderId))
    .limit(1);
  return rows[0] ?? null;
}

/** Remaining physical lines only; held and already-fulfilled units do not enter this pack plan. */
async function loadShippableOrderLines(wmsOrderId: number): Promise<PackPlanOrderLine[]> {
  const rows = await db
    .select({
      sku: orderItems.sku,
      quantity: orderItems.quantity,
      fulfilledQuantity: orderItems.fulfilledQuantity,
      requiresShipping: orderItems.requiresShipping,
      onHold: orderItems.onHold,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, wmsOrderId));

  return rows
    .map((row) => ({
      ...row,
      remainingQuantity: Math.max(0, row.quantity - row.fulfilledQuantity),
    }))
    .filter((row) => row.requiresShipping === 1 && !row.onHold && row.remainingQuantity > 0)
    .map((row) => ({ sku: row.sku, quantity: row.remainingQuantity }));
}

async function findActivePlanForOrder(wmsOrderId: number): Promise<ShippingPackPlan | null> {
  const rows = await db
    .select()
    .from(shippingPackPlans)
    .where(and(
      eq(shippingPackPlans.wmsOrderId, wmsOrderId),
      eq(shippingPackPlans.status, "active"),
    ))
    .orderBy(desc(shippingPackPlans.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * One transaction: supersede prior active plans for the order, then insert
 * the new plan + parcels + parcel items/placements. All writes to shipping.pack_plans*
 * MUST stay in this module (writer ratchet).
 */
async function persistPlanTransactional(input: PersistPlanInput): Promise<ShippingPackPlan> {
  return db.transaction(async (tx) => {
    await tx
      .update(shippingPackPlans)
      .set({ status: "superseded", updatedAt: new Date() })
      .where(and(
        eq(shippingPackPlans.wmsOrderId, input.wmsOrderId),
        eq(shippingPackPlans.status, "active"),
      ));

    const [plan] = await tx
      .insert(shippingPackPlans)
      .values({
        wmsOrderId: input.wmsOrderId,
        shipmentRequestId: input.shipmentRequestId,
        status: "active",
        engineVersion: input.engineVersion,
        inputHash: input.inputHash,
        warnings: input.warnings,
      })
      .returning();

    for (let i = 0; i < input.parcels.length; i++) {
      const parcel = input.parcels[i];
      const [parcelRow] = await tx
        .insert(shippingPackPlanParcels)
        .values({
          packPlanId: plan.id,
          parcelSequence: i + 1,
          // Exactly one of boxId / siocProductVariantId (DB XOR check).
          boxId: parcel.boxId,
          siocProductVariantId: parcel.boxId == null ? parcel.siocProductVariantId : null,
          estWeightGrams: parcel.estWeightGrams,
          billableWeightGrams: parcel.billableWeightGrams,
          lengthMm: parcel.lengthMm,
          widthMm: parcel.widthMm,
          heightMm: parcel.heightMm,
          placements: parcel.placements,
        })
        .returning({ id: shippingPackPlanParcels.id });

      // Aggregate by variant: pack_plan_parcel_items is unique per
      // (parcel, variant); a rider absorbed next to a boxed line of the same
      // variant must merge rather than violate the index.
      const byVariant = new Map<number, { quantity: number; isRider: boolean }>();
      for (const line of parcel.items) {
        const existing = byVariant.get(line.productVariantId);
        if (existing) {
          existing.quantity += line.quantity;
          existing.isRider = existing.isRider && line.isRider;
        } else {
          byVariant.set(line.productVariantId, {
            quantity: line.quantity,
            isRider: line.isRider,
          });
        }
      }
      if (byVariant.size > 0) {
        await tx.insert(shippingPackPlanParcelItems).values(
          [...byVariant.entries()].map(([productVariantId, agg]) => ({
            parcelId: parcelRow.id,
            productVariantId,
            quantity: agg.quantity,
            isRider: agg.isRider,
          })),
        );
      }
    }

    return plan;
  });
}

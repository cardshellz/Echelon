import { z } from "zod";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const quantity = z.number().int().nonnegative().max(2_147_483_647);
const scopeSchema = z.object({
  fulfillmentPlanId: id.nullable(),
  fulfillmentPlanLineId: id.nullable(),
  wmsOrderId: id,
  wmsOrderItemId: id,
  omsOrderId: id,
  omsOrderLineId: id,
  warehouseId: id.nullable(),
});
const targetSchema = scopeSchema.extend({
  legacyWmsShipmentItemId: id,
  shippingProvider: z.string().min(1),
  providerPhysicalShipmentId: z.string().min(1),
  quantityShipped: quantity.positive(),
  quantityPlanned: quantity.positive(),
});
const requestSchema = scopeSchema.extend({
  fulfillmentPlanId: id,
  fulfillmentPlanLineId: id,
  shipmentRequestId: id,
  shipmentRequestItemId: id,
  legacyWmsShipmentItemId: id.nullable(),
  quantityRequested: quantity.positive(),
  quantityCancelled: quantity,
  requestStatus: z.enum(["planned", "queued", "accepted", "cancelled", "shipped", "review"]),
  linkedToShippingOrder: z.boolean(),
});
const physicalSchema = z.object({
  shipmentRequestItemId: id,
  fulfillmentPlanLineId: id,
  legacyWmsShipmentItemId: id.nullable(),
  shippingProvider: z.string().min(1),
  providerPhysicalShipmentId: z.string().min(1),
  // Unlike legacy exclusive provenance, this identifies a portion of a source
  // line. Several independent packages can carry that same source identity.
  labelReplacementSourceItemId: id.nullable().optional(),
  // Retain the immutable quantity as well as any append-only correction.
  quantityShipped: quantity.positive(),
  effectiveQuantityShipped: quantity,
});

export type FulfillmentRequestAllocationTarget = z.infer<typeof targetSchema>;
export type FulfillmentRequestAllocationSnapshot = z.infer<typeof requestSchema>;
export type FulfillmentRequestPhysicalSnapshot = z.infer<typeof physicalSchema>;
export type FulfillmentRequestAllocationDecision =
  | Readonly<{ kind: "create" }>
  | Readonly<{
    kind: "reuse";
    shipmentRequestId: number;
    shipmentRequestItemId: number;
    reason: "physical_replay" | "source_item" | "shipping_order_remaining_quantity";
  }>;

export class FulfillmentRequestAllocationError extends Error {
  constructor(
    readonly code: "CANONICAL_STATE_CONFLICT" | "FULFILLMENT_AUTHORITY_EXCEEDED",
    message: string,
    readonly context: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "FulfillmentRequestAllocationError";
  }
}

/**
 * Requests reserve ordered units; physical packages consume those reservations.
 * A new carrier package is not new demand. Reuse requires exact order/line,
 * warehouse and shipping-order identity, never a SKU or a guessed source row.
 * Missing/ambiguous authority is rejected rather than moving another request's
 * units. The immutable physical-item FK records the chosen reservation.
 */
export function resolveFulfillmentRequestAllocation(
  rawTarget: FulfillmentRequestAllocationTarget,
  rawRequests: readonly FulfillmentRequestAllocationSnapshot[],
  rawPhysicalItems: readonly FulfillmentRequestPhysicalSnapshot[],
): FulfillmentRequestAllocationDecision {
  const parsed = z.object({ target: targetSchema, requests: z.array(requestSchema), physical: z.array(physicalSchema) })
    .safeParse({ target: rawTarget, requests: rawRequests, physical: rawPhysicalItems });
  if (!parsed.success) {
    throw new FulfillmentRequestAllocationError("CANONICAL_STATE_CONFLICT", "Invalid request allocation evidence", {
      issues: parsed.error.issues,
    });
  }
  const { target, requests, physical } = parsed.data;
  const fail = (reason: string, exceeded = false): never => {
    throw new FulfillmentRequestAllocationError(
      exceeded ? "FULFILLMENT_AUTHORITY_EXCEEDED" : "CANONICAL_STATE_CONFLICT",
      `Cannot allocate package ${target.providerPhysicalShipmentId} to OMS line ${target.omsOrderLineId}: ${reason}`,
      Object.freeze({ reason, omsOrderLineId: target.omsOrderLineId, legacyWmsShipmentItemId: target.legacyWmsShipmentItemId,
        fulfillmentPlanLineId: target.fulfillmentPlanLineId, warehouseId: target.warehouseId,
        packageQuantity: target.quantityShipped, paidQuantity: target.quantityPlanned,
        shipmentRequestItemIds: requests.map(request => request.shipmentRequestItemId) }),
    );
  };
  const sameLine = (request: FulfillmentRequestAllocationSnapshot): boolean =>
    request.fulfillmentPlanId === target.fulfillmentPlanId
    && request.fulfillmentPlanLineId === target.fulfillmentPlanLineId
    && request.wmsOrderId === target.wmsOrderId && request.wmsOrderItemId === target.wmsOrderItemId
    && request.omsOrderId === target.omsOrderId && request.omsOrderLineId === target.omsOrderLineId;
  const scoped = requests.filter(sameLine);
  if (requests.some(request => request.fulfillmentPlanLineId === target.fulfillmentPlanLineId && !sameLine(request))) {
    fail("request_scope_mismatch");
  }
  if (new Set(requests.map(request => request.shipmentRequestItemId)).size !== requests.length) fail("duplicate_request_evidence");
  for (const request of requests) {
    if (request.quantityCancelled > request.quantityRequested) fail("invalid_cancelled_request_quantity");
  }
  const samePackage = (item: FulfillmentRequestPhysicalSnapshot): boolean =>
    item.shippingProvider === target.shippingProvider && item.providerPhysicalShipmentId === target.providerPhysicalShipmentId;
  if (physical.some(item => item.legacyWmsShipmentItemId !== null && item.labelReplacementSourceItemId != null)) {
    fail("ambiguous_physical_source_provenance");
  }
  const replays = physical.filter(item => item.legacyWmsShipmentItemId === target.legacyWmsShipmentItemId
    || (item.labelReplacementSourceItemId === target.legacyWmsShipmentItemId && samePackage(item)));
  if (replays.length > 1) fail("ambiguous_physical_replay");
  const replay = replays[0];
  if (replay && (!samePackage(replay) || replay.fulfillmentPlanLineId !== target.fulfillmentPlanLineId
    || replay.quantityShipped !== target.quantityShipped || replay.effectiveQuantityShipped !== target.quantityShipped)) {
    fail("immutable_physical_allocation_changed");
  }
  const priorPhysical = physical.filter(item => item.fulfillmentPlanLineId === target.fulfillmentPlanLineId)
    .reduce((total, item) => total + BigInt(item.effectiveQuantityShipped), BigInt(0));
  if (priorPhysical + BigInt(replay ? 0 : target.quantityShipped) > BigInt(target.quantityPlanned)) {
    fail("physical_quantity_exceeds_paid_authority", true);
  }
  const priorRequested = scoped.reduce((total, request) => total + BigInt(request.quantityRequested - request.quantityCancelled), BigInt(0));
  if (priorRequested > BigInt(target.quantityPlanned)) fail("requests_exceed_paid_authority", true);
  const remaining = (request: FulfillmentRequestAllocationSnapshot): bigint =>
    BigInt(request.quantityRequested - request.quantityCancelled)
    - physical.filter(item => item.shipmentRequestItemId === request.shipmentRequestItemId)
      .reduce((total, item) => total + BigInt(item.effectiveQuantityShipped), BigInt(0));
  const reuse = (request: FulfillmentRequestAllocationSnapshot, reason: "physical_replay" | "source_item" | "shipping_order_remaining_quantity"):
    FulfillmentRequestAllocationDecision => {
    if (!sameLine(request) || request.warehouseId !== target.warehouseId) fail("request_scope_mismatch");
    if (request.requestStatus === "cancelled" || request.requestStatus === "review") fail("request_not_active");
    const additional = replay ? BigInt(0) : BigInt(target.quantityShipped);
    if (remaining(request) < additional) fail("request_quantity_exhausted", true);
    if (!replay && physical.some(item => samePackage(item) && item.shipmentRequestItemId === request.shipmentRequestItemId)) {
      fail("physical_package_already_allocated");
    }
    return Object.freeze({ kind: "reuse", shipmentRequestId: request.shipmentRequestId,
      shipmentRequestItemId: request.shipmentRequestItemId, reason });
  };
  if (replay) {
    const request = requests.find(request => request.shipmentRequestItemId === replay.shipmentRequestItemId);
    if (!request) return fail("physical_request_missing");
    return reuse(request, "physical_replay");
  }
  const direct = requests.filter(request => request.legacyWmsShipmentItemId === target.legacyWmsShipmentItemId);
  if (direct.length > 1) fail("ambiguous_source_request");
  if (direct[0]) return reuse(direct[0], "source_item");

  const available = scoped.filter(request => request.linkedToShippingOrder
    && request.warehouseId === target.warehouseId
    && request.requestStatus !== "cancelled" && request.requestStatus !== "review"
    && remaining(request) > BigInt(0));
  if (available.length > 1) fail("ambiguous_remaining_requests");
  if (available[0]) return reuse(available[0], "shipping_order_remaining_quantity");
  if (priorRequested + BigInt(target.quantityShipped) > BigInt(target.quantityPlanned)) {
    fail("no_unrequested_paid_quantity", true);
  }
  return Object.freeze({ kind: "create" });
}

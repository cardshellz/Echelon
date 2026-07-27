export type ShopifyWritebackDebtEvidenceMode = "direct" | "full_snapshot";

export interface ShopifyWritebackDebtItem {
  readonly legacyShipmentItemId: number;
  readonly wmsOrderItemId: number;
  readonly channelOrderLineId: string | null;
  readonly quantityRequired: number;
  readonly directEvidenceQuantity: number;
}

export interface ShopifyWritebackDebtShipment {
  readonly shipmentId: number;
  readonly trackingNumber: string | null;
  readonly historicalEmptySplitNoop: boolean;
  readonly retryIds: readonly number[];
  readonly sourceInboxIds: readonly number[];
  readonly items: readonly ShopifyWritebackDebtItem[];
}

export interface ShopifyAggregateFulfillmentEvidence {
  readonly channelOrderLineId: string;
  readonly quantity: number;
}

export type ShopifyWritebackDebtUnresolvedReason =
  | "no_eligible_items"
  | "direct_package_evidence_incomplete"
  | "full_snapshot_required"
  | "snapshot_package_coverage_incomplete";

export interface ShopifyWritebackDebtEvaluation {
  readonly resolvedShipmentIds: readonly number[];
  readonly resolvedRetryIds: readonly number[];
  readonly resolvedSourceInboxIds: readonly number[];
  readonly unresolved: readonly {
    readonly shipmentId: number;
    readonly reason: ShopifyWritebackDebtUnresolvedReason;
  }[];
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
}

function addQuantity(target: Map<number, number>, key: number, quantity: number): void {
  target.set(key, (target.get(key) ?? 0) + quantity);
}

/**
 * Decide whether obsolete internal Shopify writeback retries can be closed.
 *
 * Direct mode requires exact package-item lineage. Full-snapshot mode may also
 * close old trackingless aggregate rows, but only as one all-or-nothing group
 * after exact Shopify compatibility-package quantities cover every line.
 */
export function evaluateShopifyWritebackDebt(
  shipments: readonly ShopifyWritebackDebtShipment[],
  aggregateEvidence: readonly ShopifyAggregateFulfillmentEvidence[],
  mode: ShopifyWritebackDebtEvidenceMode,
): ShopifyWritebackDebtEvaluation {
  if (mode !== "direct" && mode !== "full_snapshot") {
    throw new Error(`Unsupported Shopify writeback debt evidence mode: ${String(mode)}`);
  }

  const shipmentIds = new Set<number>();
  for (const shipment of shipments) {
    assertPositiveInteger(shipment.shipmentId, "shipmentId");
    if (shipmentIds.has(shipment.shipmentId)) {
      throw new Error(`Duplicate Shopify writeback debt shipment ${shipment.shipmentId}`);
    }
    shipmentIds.add(shipment.shipmentId);
    for (const retryId of shipment.retryIds) assertPositiveInteger(retryId, "retryId");
    for (const inboxId of shipment.sourceInboxIds) assertPositiveInteger(inboxId, "sourceInboxId");
    for (const item of shipment.items) {
      assertPositiveInteger(item.legacyShipmentItemId, "legacyShipmentItemId");
      assertPositiveInteger(item.wmsOrderItemId, "wmsOrderItemId");
      if (item.channelOrderLineId !== null && !item.channelOrderLineId.trim()) {
        throw new Error("channelOrderLineId must be null or non-blank");
      }
      assertPositiveInteger(item.quantityRequired, "quantityRequired");
      assertNonNegativeInteger(item.directEvidenceQuantity, "directEvidenceQuantity");
    }
  }

  const aggregateByChannelLine = new Map<string, number>();
  for (const evidence of aggregateEvidence) {
    if (!evidence.channelOrderLineId.trim()) {
      throw new Error("aggregateEvidence.channelOrderLineId must be non-blank");
    }
    assertNonNegativeInteger(evidence.quantity, "aggregateEvidence.quantity");
    aggregateByChannelLine.set(
      evidence.channelOrderLineId,
      (aggregateByChannelLine.get(evidence.channelOrderLineId) ?? 0) + evidence.quantity,
    );
  }

  const resolved = new Set<number>();
  const unresolved = new Map<number, ShopifyWritebackDebtUnresolvedReason>();
  const trackinglessWithoutDirectProof: ShopifyWritebackDebtShipment[] = [];

  for (const shipment of shipments) {
    if (shipment.items.length === 0) {
      if (shipment.historicalEmptySplitNoop) {
        resolved.add(shipment.shipmentId);
      } else {
        unresolved.set(shipment.shipmentId, "no_eligible_items");
      }
      continue;
    }
    if (shipment.items.every((item) => item.directEvidenceQuantity >= item.quantityRequired)) {
      resolved.add(shipment.shipmentId);
      continue;
    }
    if (shipment.trackingNumber) {
      unresolved.set(shipment.shipmentId, "direct_package_evidence_incomplete");
      continue;
    }
    if (mode !== "full_snapshot") {
      unresolved.set(shipment.shipmentId, "full_snapshot_required");
      continue;
    }
    trackinglessWithoutDirectProof.push(shipment);
  }

  if (trackinglessWithoutDirectProof.length > 0) {
    const requiredByChannelLine = new Map<string, number>();
    let aggregateLineageComplete = true;
    for (const shipment of trackinglessWithoutDirectProof) {
      for (const item of shipment.items) {
        if (!item.channelOrderLineId) {
          aggregateLineageComplete = false;
          continue;
        }
        requiredByChannelLine.set(
          item.channelOrderLineId,
          (requiredByChannelLine.get(item.channelOrderLineId) ?? 0) + item.quantityRequired,
        );
      }
    }
    const aggregateCoverageComplete = aggregateLineageComplete
      && [...requiredByChannelLine.entries()].every(
        ([channelOrderLineId, quantityRequired]) =>
          (aggregateByChannelLine.get(channelOrderLineId) ?? 0) >= quantityRequired,
      );
    for (const shipment of trackinglessWithoutDirectProof) {
      if (aggregateCoverageComplete) {
        resolved.add(shipment.shipmentId);
      } else {
        unresolved.set(shipment.shipmentId, "snapshot_package_coverage_incomplete");
      }
    }
  }

  const resolvedShipments = shipments.filter((shipment) => resolved.has(shipment.shipmentId));
  return Object.freeze({
    resolvedShipmentIds: Object.freeze(resolvedShipments.map((shipment) => shipment.shipmentId)),
    resolvedRetryIds: Object.freeze([
      ...new Set(resolvedShipments.flatMap((shipment) => shipment.retryIds)),
    ]),
    resolvedSourceInboxIds: Object.freeze([
      ...new Set(resolvedShipments.flatMap((shipment) => shipment.sourceInboxIds)),
    ]),
    unresolved: Object.freeze(
      shipments
        .filter((shipment) => !resolved.has(shipment.shipmentId))
        .map((shipment) => Object.freeze({
          shipmentId: shipment.shipmentId,
          reason: unresolved.get(shipment.shipmentId) ?? "direct_package_evidence_incomplete",
        })),
    ),
  });
}

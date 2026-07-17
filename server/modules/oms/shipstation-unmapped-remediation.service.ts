import { sql } from "drizzle-orm";

import type {
  ShipStationService,
  ShipStationShipment,
  ShipStationShipmentItem,
} from "./shipstation.service";
import {
  SHIPSTATION_LEGACY_UNMAPPED_SPLIT_REASON,
  SHIPSTATION_UNMAPPED_PHYSICAL_RULE,
  buildShipStationUnmappedPhysicalIdempotencyKey,
  recordShipStationUnmappedPhysicalException,
  shipStationShipmentRefFromExternalFulfillmentId,
} from "./shipstation-unmapped-physical";
import { resolveVoidedShipStationUnmappedPhysicalException } from "./ship-notify-reconciliation.service";

export interface ShipStationUnmappedLocator {
  exceptionId?: number;
  shipmentId?: number;
}

export interface ShipStationUnmappedLineMapping {
  providerItemIndex?: number;
  orderItemId?: number;
  productVariantId?: number;
  quantity: number;
  evidenceSource?: "shipstation" | "original_wms" | "catalog";
}

export interface ShipStationUnmappedReshipAdoptionInput
  extends ShipStationUnmappedLocator {
  operator: string;
  originalShipmentId: number;
  reason: string;
  notes?: string;
  lineMappings: ShipStationUnmappedLineMapping[];
}

export interface ShipStationUnmappedVoidedResolutionInput
  extends ShipStationUnmappedLocator {
  operator: string;
}

interface RemediationContext {
  exceptionId: number | null;
  wmsOrderId: number;
  orderNumber: string;
  authorityShipmentId: number;
  candidateShipmentId: number | null;
  externalShipmentRef: string;
  trackingNumber: string | null;
  authorityExternalShipmentRef: string | null;
  authorityTrackingNumber: string | null;
}

export interface ShipStationProviderIdentityRepair {
  supersededCandidateShipmentId: number;
  supersededProviderShipmentId: number;
  supersededTrackingNumber: string | null;
  supersededVoidDate: string;
  activeCandidateShipmentId: number;
  activeProviderShipmentId: number;
  activeTrackingNumber: string;
}

export interface ShipStationOriginalPackageIdentityRepair {
  wmsShipmentId: number;
  providerShipmentId: number;
  providerOrderId: number;
  providerOrderKey: string;
  currentTrackingNumber: string;
  originalTrackingNumber: string;
  historicalSplitGhostShipmentId?: number;
}

interface ResolvedProviderShipment {
  context: RemediationContext;
  shipment: ShipStationShipment;
  identityRepair: ShipStationProviderIdentityRepair | null;
  originalPackageIdentityRepair: ShipStationOriginalPackageIdentityRepair | null;
  originalProviderShipment: ShipStationShipment | null;
}

interface PreviewOrderItem {
  id: number;
  sku: string;
  name: string;
  quantity: number;
  fulfilledQuantity: number;
  customerShippedQuantity: number;
  remainingQuantity: number;
}

interface PreviewShipment {
  id: number;
  status: string;
  source: string;
  shipmentPurpose: string;
  trackingNumber: string | null;
  externalShipmentRef: string | null;
  itemCount: number;
  createdAt: string | null;
  items: Array<{
    orderItemId: number;
    sku: string;
    name: string;
    quantity: number;
  }>;
}

export interface ShipStationUnmappedPreview {
  exceptionId: number | null;
  wmsOrderId: number;
  orderNumber: string;
  authorityShipmentId: number;
  candidateShipmentId: number | null;
  externalShipmentRef: string;
  providerShipment: ShipStationShipment;
  providerIdentityRepair: ShipStationProviderIdentityRepair | null;
  originalPackageIdentityRepair: ShipStationOriginalPackageIdentityRepair | null;
  orderItems: PreviewOrderItem[];
  shipments: PreviewShipment[];
}

interface PreparedLine {
  providerItemIndex: number | null;
  evidenceSource: "shipstation" | "original_wms" | "catalog";
  shipmentItemPurpose: "replacement" | "concession";
  orderItemId: number | null;
  sku: string;
  quantity: number;
  productVariantId: number;
  fromLocationId: number;
}

const RESHIP_REASONS = new Set([
  "lost",
  "damaged",
  "misdelivery",
  "carrier_replacement",
  "concession",
  "other",
]);
function resultRows(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}

function optionalPositiveInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function requiredOperator(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 120) {
    throw new Error("operator must contain between 1 and 120 characters");
  }
  return normalized;
}

function optionalNotes(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (normalized.length > 1_000) throw new Error("notes cannot exceed 1000 characters");
  return normalized;
}

function normalizeSku(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function locator(input: ShipStationUnmappedLocator): Required<ShipStationUnmappedLocator> {
  const exceptionId = optionalPositiveInteger(input.exceptionId) ?? 0;
  const shipmentId = optionalPositiveInteger(input.shipmentId) ?? 0;
  if ((exceptionId > 0) === (shipmentId > 0)) {
    throw new Error("exactly one of exceptionId or shipmentId is required");
  }
  return { exceptionId, shipmentId };
}

async function withOptionalTransaction<T>(
  db: any,
  work: (tx: any) => Promise<T>,
): Promise<T> {
  return typeof db.transaction === "function" ? db.transaction(work) : work(db);
}

async function loadContext(
  db: any,
  input: ShipStationUnmappedLocator,
): Promise<RemediationContext> {
  const target = locator(input);
  if (target.exceptionId > 0) {
    const result: any = await db.execute(sql`
      SELECT
        exception.id AS exception_id,
        COALESCE(exception.wms_order_id, authority.order_id) AS wms_order_id,
        COALESCE(
          NULLIF(BTRIM(exception.details->>'orderNumber'), ''),
          wms_order.order_number
        ) AS order_number,
        exception.wms_shipment_id AS authority_shipment_id,
        candidate.id AS candidate_shipment_id,
        exception.external_shipment_ref,
        COALESCE(candidate.tracking_number, exception.details->>'trackingNumber') AS tracking_number,
        authority.external_fulfillment_id AS authority_external_fulfillment_id,
        authority.tracking_number AS authority_tracking_number
      FROM wms.reconciliation_exceptions exception
      LEFT JOIN wms.outbound_shipments authority
        ON authority.id = exception.wms_shipment_id
      LEFT JOIN wms.outbound_shipments candidate
        ON candidate.external_fulfillment_id =
          'shipstation_shipment:' || exception.external_shipment_ref
      JOIN wms.orders wms_order
        ON wms_order.id = COALESCE(exception.wms_order_id, authority.order_id)
      WHERE exception.id = ${target.exceptionId}
        AND exception.rule = ${SHIPSTATION_UNMAPPED_PHYSICAL_RULE}
        AND exception.status IN ('open', 'acknowledged')
      LIMIT 1
    `);
    const row = resultRows(result)[0];
    if (!row) throw new Error("unmapped ShipStation exception not found or already resolved");
    return {
      exceptionId: positiveInteger(row.exception_id, "exceptionId"),
      wmsOrderId: positiveInteger(row.wms_order_id, "wmsOrderId"),
      orderNumber: String(row.order_number),
      authorityShipmentId: positiveInteger(row.authority_shipment_id, "authorityShipmentId"),
      candidateShipmentId: optionalPositiveInteger(row.candidate_shipment_id),
      externalShipmentRef: String(row.external_shipment_ref),
      trackingNumber: row.tracking_number == null ? null : String(row.tracking_number),
      authorityExternalShipmentRef: shipStationShipmentRefFromExternalFulfillmentId(
        row.authority_external_fulfillment_id,
      ),
      authorityTrackingNumber: row.authority_tracking_number == null
        ? null
        : String(row.authority_tracking_number),
    };
  }

  const result: any = await db.execute(sql`
    SELECT
      shipment.order_id AS wms_order_id,
      wms_order.order_number,
      shipment.id AS authority_shipment_id,
      shipment.id AS candidate_shipment_id,
      substring(
        shipment.external_fulfillment_id
        FROM '^shipstation_shipment:([1-9][0-9]*)$'
      ) AS external_shipment_ref,
      shipment.tracking_number,
      shipment.external_fulfillment_id AS authority_external_fulfillment_id,
      shipment.tracking_number AS authority_tracking_number
    FROM wms.outbound_shipments shipment
    JOIN wms.orders wms_order ON wms_order.id = shipment.order_id
    WHERE shipment.id = ${target.shipmentId}
      AND shipment.source = 'shipstation_split'
      AND shipment.review_reason = ${SHIPSTATION_LEGACY_UNMAPPED_SPLIT_REASON}
      AND COALESCE(shipment.requires_review, false) = true
      AND shipment.external_fulfillment_id ~ '^shipstation_shipment:[1-9][0-9]*$'
    LIMIT 1
  `);
  const row = resultRows(result)[0];
  if (!row) throw new Error("legacy unmapped ShipStation shipment not found or already resolved");
  return {
    exceptionId: null,
    wmsOrderId: positiveInteger(row.wms_order_id, "wmsOrderId"),
    orderNumber: String(row.order_number),
    authorityShipmentId: positiveInteger(row.authority_shipment_id, "authorityShipmentId"),
    candidateShipmentId: positiveInteger(row.candidate_shipment_id, "candidateShipmentId"),
    externalShipmentRef: String(row.external_shipment_ref),
    trackingNumber: row.tracking_number == null ? null : String(row.tracking_number),
    authorityExternalShipmentRef: shipStationShipmentRefFromExternalFulfillmentId(
      row.authority_external_fulfillment_id,
    ),
    authorityTrackingNumber: row.authority_tracking_number == null
      ? null
      : String(row.authority_tracking_number),
  };
}

function normalizedTrackingNumber(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function shipmentItemSignature(shipment: ShipStationShipment): string | null {
  const quantities = new Map<string, number>();
  const items = shipment.shipmentItems ?? [];
  if (items.length === 0) return null;
  for (const item of items) {
    const sku = normalizeSku(item.sku);
    const quantity = Number(item.quantity);
    if (!sku || !Number.isSafeInteger(quantity) || quantity <= 0) return null;
    quantities.set(sku, (quantities.get(sku) ?? 0) + quantity);
  }
  return [...quantities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sku, quantity]) => `${sku}:${quantity}`)
    .join("|");
}

interface ProviderWmsItemLine {
  shipmentItemId: number;
  quantity: number;
}

function providerWmsItemLines(shipment: ShipStationShipment): ProviderWmsItemLine[] | null {
  const quantities = new Map<number, number>();
  const items = shipment.shipmentItems ?? [];
  if (items.length === 0) return null;
  for (const item of items) {
    const match = /^wms-item-([1-9][0-9]*)$/.exec(String(item.lineItemKey ?? ""));
    const shipmentItemId = match ? Number(match[1]) : 0;
    const quantity = Number(item.quantity);
    if (
      !Number.isSafeInteger(shipmentItemId)
      || shipmentItemId <= 0
      || !Number.isSafeInteger(quantity)
      || quantity <= 0
    ) {
      return null;
    }
    quantities.set(shipmentItemId, (quantities.get(shipmentItemId) ?? 0) + quantity);
  }
  return [...quantities.entries()]
    .sort(([left], [right]) => left - right)
    .map(([shipmentItemId, quantity]) => ({ shipmentItemId, quantity }));
}

function providerWmsItemSignature(shipment: ShipStationShipment): string | null {
  const lines = providerWmsItemLines(shipment);
  if (!lines) return null;
  return lines
    .map(({ shipmentItemId, quantity }) => `${shipmentItemId}:${quantity}`)
    .join("|");
}

function historicalGhostItemsMatch(
  providerShipment: ShipStationShipment,
  authorityShipmentId: number,
  ghostShipmentId: number,
  rows: any[],
): boolean {
  const providerLines = providerWmsItemLines(providerShipment);
  if (!providerLines) return false;

  const parentRows = new Map<number, { orderItemId: number; quantity: number }>();
  const ghostQuantities = new Map<number, number>();
  for (const row of rows) {
    const shipmentId = optionalPositiveInteger(row.shipment_id);
    const itemId = optionalPositiveInteger(row.id);
    const orderItemId = optionalPositiveInteger(row.order_item_id);
    const quantity = Number(row.qty);
    if (
      shipmentId === null
      || itemId === null
      || orderItemId === null
      || !Number.isSafeInteger(quantity)
      || quantity <= 0
    ) {
      return false;
    }
    if (shipmentId === authorityShipmentId) {
      parentRows.set(itemId, { orderItemId, quantity });
    } else if (shipmentId === ghostShipmentId) {
      ghostQuantities.set(
        orderItemId,
        (ghostQuantities.get(orderItemId) ?? 0) + quantity,
      );
    }
  }

  const expectedGhostQuantities = new Map<number, number>();
  for (const line of providerLines) {
    const parent = parentRows.get(line.shipmentItemId);
    if (!parent || parent.quantity !== line.quantity) return false;
    expectedGhostQuantities.set(
      parent.orderItemId,
      (expectedGhostQuantities.get(parent.orderItemId) ?? 0) + line.quantity,
    );
  }
  if (ghostQuantities.size !== expectedGhostQuantities.size) return false;
  return [...expectedGhostQuantities.entries()].every(
    ([orderItemId, quantity]) => ghostQuantities.get(orderItemId) === quantity,
  );
}

function resolveOriginalPackageIdentityRepair(
  shipments: ShipStationShipment[],
  providerShipment: ShipStationShipment,
  context: RemediationContext,
): {
  repair: ShipStationOriginalPackageIdentityRepair;
  providerShipment: ShipStationShipment;
} | null {
  if (
    providerShipment.voidDate
    || !String(providerShipment.shipDate ?? "").trim()
    || (providerShipment.shipmentItems ?? []).length !== 0
    || context.authorityExternalShipmentRef === null
    || context.authorityExternalShipmentRef === String(providerShipment.shipmentId)
  ) {
    return null;
  }
  const currentTrackingNumber = normalizedTrackingNumber(
    context.authorityTrackingNumber,
  );
  if (
    !currentTrackingNumber
    || currentTrackingNumber !== normalizedTrackingNumber(providerShipment.trackingNumber)
  ) {
    return null;
  }
  const originalProviderShipment = shipments.find(
    (candidate) => String(candidate.shipmentId) === context.authorityExternalShipmentRef,
  );
  const originalTrackingNumber = normalizedTrackingNumber(
    originalProviderShipment?.trackingNumber,
  );
  if (
    !originalProviderShipment
    || originalProviderShipment.voidDate
    || !String(originalProviderShipment.shipDate ?? "").trim()
    || !originalTrackingNumber
    || originalTrackingNumber === currentTrackingNumber
    || originalProviderShipment.orderKey !== providerShipment.orderKey
    || providerWmsItemSignature(originalProviderShipment) === null
  ) {
    return null;
  }
  const providerOrderId = optionalPositiveInteger(originalProviderShipment.orderId);
  if (providerOrderId === null || !String(originalProviderShipment.orderKey ?? "").trim()) {
    return null;
  }
  return {
    repair: {
      wmsShipmentId: context.authorityShipmentId,
      providerShipmentId: originalProviderShipment.shipmentId,
      providerOrderId,
      providerOrderKey: originalProviderShipment.orderKey,
      currentTrackingNumber: providerShipment.trackingNumber,
      originalTrackingNumber: originalProviderShipment.trackingNumber,
    },
    providerShipment: originalProviderShipment,
  };
}

async function resolveHistoricalSplitGhostRepair(
  db: any,
  shipments: ShipStationShipment[],
  providerShipment: ShipStationShipment,
  context: RemediationContext,
): Promise<{
  repair: ShipStationOriginalPackageIdentityRepair;
  providerShipment: ShipStationShipment;
} | null> {
  const authorityTrackingNumber = normalizedTrackingNumber(
    context.authorityTrackingNumber,
  );
  if (
    providerShipment.voidDate
    || !String(providerShipment.shipDate ?? "").trim()
    || (providerShipment.shipmentItems ?? []).length !== 0
    || context.candidateShipmentId !== null
    || context.authorityExternalShipmentRef !== null
    || !authorityTrackingNumber
    || authorityTrackingNumber === normalizedTrackingNumber(providerShipment.trackingNumber)
  ) {
    return null;
  }

  const originalMatches = shipments.filter((candidate) => (
    candidate.shipmentId !== providerShipment.shipmentId
    && !candidate.voidDate
    && Boolean(String(candidate.shipDate ?? "").trim())
    && candidate.orderKey === providerShipment.orderKey
    && normalizedTrackingNumber(candidate.trackingNumber) === authorityTrackingNumber
    && providerWmsItemSignature(candidate) !== null
  ));
  if (originalMatches.length !== 1) return null;
  const originalProviderShipment = originalMatches[0];

  const ghostResult: any = await db.execute(sql`
    SELECT id, order_id, status, source, external_fulfillment_id,
           requires_review, review_reason
    FROM wms.outbound_shipments
    WHERE external_fulfillment_id = ${`shipstation_shipment:${originalProviderShipment.shipmentId}`}
    LIMIT 2
  `);
  const ghosts = resultRows(ghostResult);
  if (ghosts.length !== 1) return null;
  const ghost = ghosts[0];
  const ghostShipmentId = optionalPositiveInteger(ghost.id);
  if (
    ghostShipmentId === null
    || Number(ghost.order_id) !== context.wmsOrderId
    || !["cancelled", "voided"].includes(String(ghost.status))
    || String(ghost.source) !== "shipstation_split"
    || ghost.requires_review !== true
    || !String(ghost.review_reason ?? "").includes(
      "uq_outbound_shipments_shipped_order_tracking",
    )
  ) {
    return null;
  }

  const itemResult: any = await db.execute(sql`
    SELECT id, shipment_id, order_item_id, qty
    FROM wms.outbound_shipment_items
    WHERE shipment_id IN (${context.authorityShipmentId}, ${ghostShipmentId})
    ORDER BY shipment_id, id
  `);
  if (!historicalGhostItemsMatch(
    originalProviderShipment,
    context.authorityShipmentId,
    ghostShipmentId,
    resultRows(itemResult),
  )) {
    return null;
  }

  const providerOrderId = optionalPositiveInteger(originalProviderShipment.orderId);
  const providerOrderKey = String(originalProviderShipment.orderKey ?? "").trim();
  if (providerOrderId === null || !providerOrderKey) return null;
  return {
    repair: {
      wmsShipmentId: context.authorityShipmentId,
      providerShipmentId: originalProviderShipment.shipmentId,
      providerOrderId,
      providerOrderKey,
      currentTrackingNumber: context.authorityTrackingNumber!,
      originalTrackingNumber: originalProviderShipment.trackingNumber,
      historicalSplitGhostShipmentId: ghostShipmentId,
    },
    providerShipment: originalProviderShipment,
  };
}

async function resolveProviderShipment(
  db: any,
  shipStation: ShipStationService,
  context: RemediationContext,
): Promise<ResolvedProviderShipment> {
  const externalShipmentId = positiveInteger(
    context.externalShipmentRef,
    "externalShipmentRef",
  );
  const directShipment = await shipStation.getShipmentById(externalShipmentId);
  if (!directShipment) {
    throw new Error(
      `ShipStation physical shipment ${context.externalShipmentRef} was not found`,
    );
  }

  const needsVoidedLabelEvidence = Boolean(
    directShipment.voidDate && context.candidateShipmentId !== null,
  );
  const needsOriginalPackageEvidence = Boolean(
    !directShipment.voidDate
    && String(directShipment.shipDate ?? "").trim()
    && (directShipment.shipmentItems ?? []).length === 0
    && context.authorityExternalShipmentRef !== null
    && context.authorityExternalShipmentRef !== String(directShipment.shipmentId)
    && normalizedTrackingNumber(context.authorityTrackingNumber)
      === normalizedTrackingNumber(directShipment.trackingNumber),
  );
  const needsHistoricalSplitGhostEvidence = Boolean(
    !directShipment.voidDate
    && String(directShipment.shipDate ?? "").trim()
    && (directShipment.shipmentItems ?? []).length === 0
    && context.candidateShipmentId === null
    && context.authorityExternalShipmentRef === null
    && normalizedTrackingNumber(context.authorityTrackingNumber)
    && normalizedTrackingNumber(context.authorityTrackingNumber)
      !== normalizedTrackingNumber(directShipment.trackingNumber),
  );
  const shipments = [directShipment];
  if (
    needsVoidedLabelEvidence
    || needsOriginalPackageEvidence
    || needsHistoricalSplitGhostEvidence
  ) {
    const providerOrderId = positiveInteger(
      directShipment.orderId,
      "ShipStation shipment orderId",
    );
    const providerOrderNumber = String(directShipment.orderNumber ?? "").trim();
    const relatedShipments = await shipStation.getShipments(
      providerOrderId,
      providerOrderNumber ? { orderNumber: providerOrderNumber } : undefined,
    );
    for (const relatedShipment of relatedShipments) {
      if (!shipments.some((shipment) => shipment.shipmentId === relatedShipment.shipmentId)) {
        shipments.push(relatedShipment);
      }
    }
  }

  const providerShipment = directShipment;
  const originalPackageResolution = resolveOriginalPackageIdentityRepair(
    shipments,
    providerShipment,
    context,
  ) ?? await resolveHistoricalSplitGhostRepair(
    db,
    shipments,
    providerShipment,
    context,
  );
  const baseResolution: ResolvedProviderShipment = {
    context,
    shipment: providerShipment,
    identityRepair: null,
    originalPackageIdentityRepair: originalPackageResolution?.repair ?? null,
    originalProviderShipment: originalPackageResolution?.providerShipment ?? null,
  };
  if (!providerShipment.voidDate || context.candidateShipmentId === null) {
    return baseResolution;
  }

  const trackingNumber = normalizedTrackingNumber(context.trackingNumber);
  const supersededSignature = shipmentItemSignature(providerShipment);
  const supersededVoidAt = new Date(providerShipment.voidDate);
  if (
    !trackingNumber
    || !supersededSignature
    || Number.isNaN(supersededVoidAt.getTime())
  ) {
    return baseResolution;
  }
  const activeMatches = shipments.filter((shipment) => (
    !shipment.voidDate
    && Boolean(String(shipment.shipDate ?? "").trim())
    && normalizedTrackingNumber(shipment.trackingNumber) === trackingNumber
    && shipmentItemSignature(shipment) === supersededSignature
  ));
  if (activeMatches.length !== 1) {
    return baseResolution;
  }
  const activeShipment = activeMatches[0];
  if (activeShipment.shipmentId === providerShipment.shipmentId) {
    return baseResolution;
  }

  const activeExternalShipmentRef = String(activeShipment.shipmentId);
  const activeCandidateResult: any = await db.execute(sql`
    SELECT id, order_id, status, tracking_number
    FROM wms.outbound_shipments
    WHERE external_fulfillment_id = ${`shipstation_shipment:${activeExternalShipmentRef}`}
    LIMIT 2
  `);
  const activeCandidates = resultRows(activeCandidateResult);
  if (activeCandidates.length !== 1) {
    return baseResolution;
  }
  const activeCandidate = activeCandidates[0];
  const activeCandidateShipmentId = optionalPositiveInteger(activeCandidate.id);
  if (
    activeCandidateShipmentId === null
    || activeCandidateShipmentId === context.candidateShipmentId
    || Number(activeCandidate.order_id) !== context.wmsOrderId
    || String(activeCandidate.status) !== "voided"
    || normalizedTrackingNumber(activeCandidate.tracking_number) !== trackingNumber
  ) {
    return baseResolution;
  }

  const identityRepair: ShipStationProviderIdentityRepair = {
    supersededCandidateShipmentId: context.candidateShipmentId,
    supersededProviderShipmentId: providerShipment.shipmentId,
    supersededTrackingNumber: providerShipment.trackingNumber || null,
    supersededVoidDate: supersededVoidAt.toISOString(),
    activeCandidateShipmentId,
    activeProviderShipmentId: activeShipment.shipmentId,
    activeTrackingNumber: activeShipment.trackingNumber,
  };
  return {
    context: {
      ...context,
      candidateShipmentId: activeCandidateShipmentId,
      externalShipmentRef: activeExternalShipmentRef,
      trackingNumber: activeShipment.trackingNumber,
    },
    shipment: activeShipment,
    identityRepair,
    originalPackageIdentityRepair: null,
    originalProviderShipment: null,
  };
}

async function loadOrderItems(db: any, wmsOrderId: number): Promise<PreviewOrderItem[]> {
  const result: any = await db.execute(sql`
    SELECT
      order_item.id,
      order_item.sku,
      order_item.name,
      order_item.quantity,
      COALESCE(order_item.fulfilled_quantity, 0)::int AS fulfilled_quantity,
      COALESCE(SUM(shipment_item.qty) FILTER (
        WHERE shipment.status IN ('shipped', 'returned', 'lost')
          AND shipment_item.order_item_id = order_item.id
      ), 0)::int AS customer_shipped_quantity
    FROM wms.order_items order_item
    LEFT JOIN wms.outbound_shipment_items shipment_item
      ON shipment_item.order_item_id = order_item.id
    LEFT JOIN wms.outbound_shipments shipment
      ON shipment.id = shipment_item.shipment_id
    WHERE order_item.order_id = ${wmsOrderId}
      AND COALESCE(order_item.requires_shipping, 1) <> 0
      AND order_item.quantity > 0
    GROUP BY order_item.id, order_item.sku, order_item.name,
             order_item.quantity, order_item.fulfilled_quantity
    ORDER BY order_item.id
  `);
  return resultRows(result).map((row) => {
    const quantity = Number(row.quantity);
    const customerShippedQuantity = Number(row.customer_shipped_quantity ?? 0);
    return {
      id: Number(row.id),
      sku: String(row.sku),
      name: String(row.name),
      quantity,
      fulfilledQuantity: Number(row.fulfilled_quantity ?? 0),
      customerShippedQuantity,
      remainingQuantity: Math.max(0, quantity - customerShippedQuantity),
    };
  });
}

async function loadShipments(db: any, wmsOrderId: number): Promise<PreviewShipment[]> {
  const result: any = await db.execute(sql`
    SELECT
      shipment.id,
      shipment.status,
      shipment.source,
      shipment.shipment_purpose,
      shipment.tracking_number,
      shipment.external_fulfillment_id,
      shipment.created_at,
      COUNT(shipment_item.id)::int AS item_count,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'orderItemId', order_item.id,
            'sku', order_item.sku,
            'name', order_item.name,
            'quantity', shipment_item.qty
          )
          ORDER BY shipment_item.id
        ) FILTER (WHERE order_item.id IS NOT NULL),
        '[]'::jsonb
      ) AS items
    FROM wms.outbound_shipments shipment
    LEFT JOIN wms.outbound_shipment_items shipment_item
      ON shipment_item.shipment_id = shipment.id
    LEFT JOIN wms.order_items order_item
      ON order_item.id = shipment_item.order_item_id
    WHERE shipment.order_id = ${wmsOrderId}
    GROUP BY shipment.id
    ORDER BY COALESCE(shipment.shipped_at, shipment.created_at), shipment.id
  `);
  return resultRows(result).map((row) => {
    const items = Array.isArray(row.items) ? row.items : [];
    return {
      id: Number(row.id),
      status: String(row.status),
      source: String(row.source),
      shipmentPurpose: String(row.shipment_purpose ?? "customer_fulfillment"),
      trackingNumber: row.tracking_number == null ? null : String(row.tracking_number),
      externalShipmentRef: shipStationShipmentRefFromExternalFulfillmentId(
        row.external_fulfillment_id,
      ),
      itemCount: Number(row.item_count ?? 0),
      createdAt: row.created_at == null
        ? null
        : new Date(row.created_at).toISOString(),
      items: items.map((item: any) => ({
        orderItemId: Number(item.orderItemId),
        sku: String(item.sku),
        name: String(item.name),
        quantity: Number(item.quantity),
      })),
    };
  });
}

export async function getShipStationUnmappedPhysicalPreview(
  db: any,
  shipStation: ShipStationService,
  input: ShipStationUnmappedLocator,
): Promise<ShipStationUnmappedPreview> {
  const initialContext = await loadContext(db, input);
  const [resolvedProvider, orderItems, shipments] = await Promise.all([
    resolveProviderShipment(db, shipStation, initialContext),
    loadOrderItems(db, initialContext.wmsOrderId),
    loadShipments(db, initialContext.wmsOrderId),
  ]);
  const {
    context,
    shipment: providerShipment,
    identityRepair,
    originalPackageIdentityRepair,
  } = resolvedProvider;
  return {
    exceptionId: context.exceptionId,
    wmsOrderId: context.wmsOrderId,
    orderNumber: context.orderNumber,
    authorityShipmentId: context.authorityShipmentId,
    candidateShipmentId: context.candidateShipmentId,
    externalShipmentRef: context.externalShipmentRef,
    providerShipment,
    providerIdentityRepair: identityRepair,
    originalPackageIdentityRepair,
    orderItems,
    shipments,
  };
}

function resolveLineMappings(
  shipment: ShipStationShipment,
  orderItems: PreviewOrderItem[],
  requested: ShipStationUnmappedLineMapping[] | undefined,
): Array<{
  providerItemIndex: number | null;
  evidenceSource: "shipstation" | "original_wms" | "catalog";
  orderItemId: number | null;
  productVariantId: number | null;
  sku: string;
  quantity: number;
}> {
  const items: ShipStationShipmentItem[] = shipment.shipmentItems ?? [];
  if (items.length === 0) {
    if (!Array.isArray(requested) || requested.length === 0) {
      throw new Error("confirm at least one item that was physically sent");
    }
    const seenLines = new Set<string>();
    return requested.map((mapping) => {
      const quantity = positiveInteger(mapping.quantity, "quantity");
      if (mapping.evidenceSource === "catalog") {
        const productVariantId = positiveInteger(mapping.productVariantId, "productVariantId");
        const key = `catalog:${productVariantId}`;
        if (seenLines.has(key)) throw new Error("each catalog item can be confirmed only once");
        seenLines.add(key);
        return {
          providerItemIndex: null,
          evidenceSource: "catalog" as const,
          orderItemId: null,
          productVariantId,
          sku: "",
          quantity,
        };
      }
      if (mapping.evidenceSource !== "original_wms") {
        throw new Error("empty ShipStation packages require an ordered item or catalog item confirmation");
      }
      const orderItemId = positiveInteger(mapping.orderItemId, "orderItemId");
      const key = `order:${orderItemId}`;
      if (seenLines.has(key)) {
        throw new Error("each original WMS item can be confirmed only once");
      }
      seenLines.add(key);
      const orderItem = orderItems.find((item) => item.id === orderItemId);
      if (!orderItem) throw new Error(`WMS order item ${orderItemId} is not on this order`);
      return {
        providerItemIndex: null,
        evidenceSource: "original_wms" as const,
        orderItemId,
        productVariantId: null,
        sku: orderItem.sku,
        quantity,
      };
    });
  }
  if (items.some((item) => (
    normalizeSku(item.sku).length === 0 ||
    !Number.isSafeInteger(Number(item.quantity)) ||
    Number(item.quantity) <= 0
  ))) {
    throw new Error("every ShipStation item must have a SKU and positive integer quantity");
  }
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new Error("explicit WMS line mappings are required for every ShipStation item");
  }
  const mappings = requested;

  if (mappings.length !== items.length) {
    throw new Error("every ShipStation item must be mapped exactly once");
  }
  const seenProviderItems = new Set<number>();
  return mappings.map((mapping) => {
    const providerItemIndex = Number(mapping.providerItemIndex);
    if (
      !Number.isInteger(providerItemIndex) ||
      providerItemIndex < 0 ||
      providerItemIndex >= items.length ||
      seenProviderItems.has(providerItemIndex)
    ) {
      throw new Error("providerItemIndex must identify each ShipStation item exactly once");
    }
    seenProviderItems.add(providerItemIndex);
    const providerItem = items[providerItemIndex];
    const quantity = positiveInteger(mapping.quantity, "quantity");
    if (quantity !== Number(providerItem.quantity)) {
      throw new Error(`mapped quantity for SKU ${providerItem.sku} must equal provider quantity`);
    }
    if (mapping.evidenceSource === "catalog") {
      return {
        providerItemIndex,
        evidenceSource: "catalog" as const,
        orderItemId: null,
        productVariantId: positiveInteger(mapping.productVariantId, "productVariantId"),
        sku: String(providerItem.sku),
        quantity,
      };
    }
    if (mapping.evidenceSource && mapping.evidenceSource !== "shipstation") {
      throw new Error("provider package lines require ShipStation or catalog item evidence");
    }
    const orderItemId = positiveInteger(mapping.orderItemId, "orderItemId");
    const orderItem = orderItems.find((item) => item.id === orderItemId);
    if (!orderItem) throw new Error(`WMS order item ${orderItemId} is not on this order`);
    if (normalizeSku(orderItem.sku) !== normalizeSku(providerItem.sku)) {
      throw new Error(`ShipStation SKU ${providerItem.sku} does not match WMS SKU ${orderItem.sku}`);
    }
    return {
      providerItemIndex,
      evidenceSource: "shipstation" as const,
      orderItemId,
      productVariantId: null,
      sku: orderItem.sku,
      quantity,
    };
  });
}

async function prepareLines(
  db: any,
  context: RemediationContext,
  shipment: ShipStationShipment,
  orderItems: PreviewOrderItem[],
  input: ShipStationUnmappedReshipAdoptionInput,
): Promise<PreparedLine[]> {
  const mappings = resolveLineMappings(shipment, orderItems, input.lineMappings);
  const originalShipmentId = positiveInteger(input.originalShipmentId, "originalShipmentId");
  const prepared: PreparedLine[] = [];
  const replacementQuantityByOrderItem = new Map<number, number>();

  for (const mapping of mappings) {
    if (mapping.evidenceSource === "catalog") {
      const productVariantId = positiveInteger(mapping.productVariantId, "productVariantId");
      const catalogResult: any = await db.execute(sql`
        SELECT
          catalog_variant.id AS product_variant_id,
          catalog_variant.sku,
          (
            SELECT inventory_level.warehouse_location_id
            FROM inventory.inventory_levels inventory_level
            JOIN warehouse.warehouse_locations warehouse_location
              ON warehouse_location.id = inventory_level.warehouse_location_id
            WHERE inventory_level.product_variant_id = catalog_variant.id
              AND inventory_level.variant_qty - inventory_level.reserved_qty >= ${mapping.quantity}
              AND warehouse_location.cycle_count_freeze_id IS NULL
              AND (
                wms_order.warehouse_id IS NULL
                OR warehouse_location.warehouse_id = wms_order.warehouse_id
              )
            ORDER BY
              EXISTS (
                SELECT 1
                FROM warehouse.product_locations product_location
                WHERE product_location.product_variant_id = catalog_variant.id
                  AND product_location.warehouse_location_id = inventory_level.warehouse_location_id
                  AND product_location.status = 'active'
                  AND product_location.is_primary = 1
              ) DESC,
              inventory_level.variant_qty DESC,
              inventory_level.warehouse_location_id
            LIMIT 1
          ) AS from_location_id
        FROM catalog.product_variants catalog_variant
        JOIN wms.orders wms_order ON wms_order.id = ${context.wmsOrderId}
        WHERE catalog_variant.id = ${productVariantId}
          AND catalog_variant.is_active = true
          AND NULLIF(BTRIM(catalog_variant.sku), '') IS NOT NULL
        LIMIT 1
      `);
      const catalogLine = resultRows(catalogResult)[0];
      if (!catalogLine) throw new Error(`catalog item ${productVariantId} was not found or is inactive`);
      const sku = String(catalogLine.sku);
      if (mapping.providerItemIndex !== null && normalizeSku(mapping.sku) !== normalizeSku(sku)) {
        throw new Error(`ShipStation SKU ${mapping.sku} does not match catalog SKU ${sku}`);
      }
      const fromLocationId = optionalPositiveInteger(catalogLine.from_location_id);
      if (fromLocationId === null) {
        throw new Error(`SKU ${sku} has insufficient available inventory in this order's warehouse`);
      }
      prepared.push({
        providerItemIndex: mapping.providerItemIndex,
        evidenceSource: "catalog",
        shipmentItemPurpose: "concession",
        orderItemId: null,
        sku,
        quantity: mapping.quantity,
        productVariantId,
        fromLocationId,
      });
      continue;
    }

    const orderItemId = positiveInteger(mapping.orderItemId, "orderItemId");
    const sourceResult: any = await db.execute(sql`
      SELECT
        order_item.id AS order_item_id,
        order_item.sku,
        source_item.product_variant_id,
        COALESCE(
          source_item.from_location_id,
          (
            SELECT inventory_tx.from_location_id
            FROM inventory.inventory_transactions inventory_tx
            WHERE inventory_tx.order_item_id = order_item.id
              AND inventory_tx.product_variant_id = source_item.product_variant_id
              AND inventory_tx.from_location_id IS NOT NULL
            ORDER BY inventory_tx.created_at DESC
            LIMIT 1
          ),
          (
            SELECT inventory_level.warehouse_location_id
            FROM inventory.inventory_levels inventory_level
            WHERE inventory_level.product_variant_id = source_item.product_variant_id
              AND inventory_level.variant_qty >= ${mapping.quantity}
            ORDER BY inventory_level.variant_qty DESC
            LIMIT 1
          )
        ) AS from_location_id,
        source_item.qty AS source_quantity
      FROM wms.order_items order_item
      JOIN LATERAL (
        SELECT shipment_item.product_variant_id,
               shipment_item.from_location_id,
               shipment_item.qty
        FROM wms.outbound_shipment_items shipment_item
        JOIN wms.outbound_shipments source_shipment
          ON source_shipment.id = shipment_item.shipment_id
        WHERE shipment_item.order_item_id = order_item.id
          AND source_shipment.order_id = ${context.wmsOrderId}
          AND (${originalShipmentId}::int IS NULL OR source_shipment.id = ${originalShipmentId})
        ORDER BY
          CASE WHEN source_shipment.id = ${originalShipmentId} THEN 0 ELSE 1 END,
          COALESCE(source_shipment.shipped_at, source_shipment.created_at) DESC,
          shipment_item.id DESC
        LIMIT 1
      ) source_item ON true
      WHERE order_item.id = ${orderItemId}
        AND order_item.order_id = ${context.wmsOrderId}
      LIMIT 1
    `);
    const source = resultRows(sourceResult)[0];
    if (!source) {
      throw new Error(`WMS line ${orderItemId} has no shipment-item authority to copy`);
    }
    const replacementQuantity =
      (replacementQuantityByOrderItem.get(orderItemId) ?? 0) + mapping.quantity;
    if (Number(source.source_quantity) < replacementQuantity) {
      throw new Error(`replacement quantity for SKU ${mapping.sku} exceeds the original shipment`);
    }
    replacementQuantityByOrderItem.set(orderItemId, replacementQuantity);
    const productVariantId = optionalPositiveInteger(source.product_variant_id);
    const fromLocationId = optionalPositiveInteger(source.from_location_id);
    if (productVariantId === null || fromLocationId === null) {
      throw new Error(`SKU ${mapping.sku} has no provable inventory variant/location`);
    }
    prepared.push({
      ...mapping,
      shipmentItemPurpose: "replacement",
      orderItemId,
      productVariantId,
      fromLocationId,
    });
  }
  return prepared;
}

async function ensureException(
  db: any,
  context: RemediationContext,
  shipment: ShipStationShipment,
): Promise<number> {
  if (context.exceptionId !== null) return context.exceptionId;
  await recordShipStationUnmappedPhysicalException(db, {
    shipment,
    wmsOrderId: context.wmsOrderId,
    wmsShipmentId: context.authorityShipmentId,
    blockedReason: "legacy_unmapped_split_requires_operator_classification",
    currentPhysicalShipmentRef: `shipstation_shipment:${context.externalShipmentRef}`,
    currentTrackingNumber: context.trackingNumber,
  });
  const key = buildShipStationUnmappedPhysicalIdempotencyKey(shipment);
  const result: any = await db.execute(sql`
    SELECT id
    FROM wms.reconciliation_exceptions
    WHERE idempotency_key = ${key}
      AND status IN ('open', 'acknowledged')
    ORDER BY id DESC
    LIMIT 1
  `);
  const exceptionId = optionalPositiveInteger(resultRows(result)[0]?.id);
  if (exceptionId === null) throw new Error("failed to create reconciliation exception");
  return exceptionId;
}

function aggregatePreparedLines(lines: PreparedLine[]): PreparedLine[] {
  const byAuthority = new Map<string, PreparedLine>();
  for (const line of lines) {
    const key = line.shipmentItemPurpose === "concession"
      ? `concession:${line.productVariantId}`
      : `replacement:${line.orderItemId}`;
    const existing = byAuthority.get(key);
    if (!existing) {
      byAuthority.set(key, { ...line });
    } else {
      existing.quantity += line.quantity;
    }
  }
  return [...byAuthority.values()];
}

async function loadShipmentAuthorityCounts(
  db: any,
  shipmentId: number,
): Promise<{ itemCount: number; inventoryShipCount: number }> {
  const result: any = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM wms.outbound_shipment_items item
       WHERE item.shipment_id = ${shipmentId})::int AS count,
      (SELECT COUNT(*) FROM inventory.inventory_transactions inventory_tx
       WHERE inventory_tx.shipment_id = ${shipmentId}
         AND inventory_tx.transaction_type = 'ship')::int AS inventory_ship_count
  `);
  const row = resultRows(result)[0];
  return {
    itemCount: Number(row?.count ?? 0),
    inventoryShipCount: Number(row?.inventory_ship_count ?? 0),
  };
}

async function retireSupersededCandidate(
  tx: any,
  context: RemediationContext,
  identityRepair: ShipStationProviderIdentityRepair,
): Promise<void> {
  const staleResult: any = await tx.execute(sql`
    SELECT id, order_id, external_fulfillment_id, tracking_number
    FROM wms.outbound_shipments
    WHERE id = ${identityRepair.supersededCandidateShipmentId}
    FOR UPDATE
  `);
  const stale = resultRows(staleResult)[0];
  if (
    !stale
    || Number(stale.order_id) !== context.wmsOrderId
    || String(stale.external_fulfillment_id) !== `shipstation_shipment:${identityRepair.supersededProviderShipmentId}`
    || normalizedTrackingNumber(stale.tracking_number) !== normalizedTrackingNumber(identityRepair.activeTrackingNumber)
  ) {
    throw new Error("the crossed ShipStation identity changed before it could be repaired");
  }
  const staleAuthority = await loadShipmentAuthorityCounts(
    tx,
    identityRepair.supersededCandidateShipmentId,
  );
  if (staleAuthority.itemCount > 0 || staleAuthority.inventoryShipCount > 0) {
    throw new Error("the superseded shipment already owns WMS or inventory authority");
  }
  await tx.execute(sql`
    UPDATE wms.outbound_shipments
    SET status = 'voided',
        tracking_number = ${identityRepair.supersededTrackingNumber},
        voided_at = COALESCE(voided_at, ${new Date(identityRepair.supersededVoidDate)}),
        requires_review = false,
        review_reason = 'shipstation_superseded_label_reconciled',
        updated_at = NOW()
    WHERE id = ${identityRepair.supersededCandidateShipmentId}
  `);
}

async function restoreOriginalPackageIdentity(
  tx: any,
  original: any,
  identityRepair: ShipStationOriginalPackageIdentityRepair,
  providerShipment: ShipStationShipment,
): Promise<void> {
  const historicalGhostShipmentId = optionalPositiveInteger(
    identityRepair.historicalSplitGhostShipmentId,
  );
  if (
    Number(original.id) !== identityRepair.wmsShipmentId
    || normalizedTrackingNumber(original.tracking_number) !== normalizedTrackingNumber(identityRepair.currentTrackingNumber)
    || providerShipment.shipmentId !== identityRepair.providerShipmentId
    || providerShipment.orderId !== identityRepair.providerOrderId
    || providerShipment.orderKey !== identityRepair.providerOrderKey
    || normalizedTrackingNumber(providerShipment.trackingNumber) !== normalizedTrackingNumber(identityRepair.originalTrackingNumber)
    || (historicalGhostShipmentId === null
      ? String(original.external_fulfillment_id) !== `shipstation_shipment:${identityRepair.providerShipmentId}`
      : original.external_fulfillment_id !== null)
  ) {
    throw new Error("the original ShipStation package identity changed before it could be restored");
  }

  if (historicalGhostShipmentId !== null) {
    const ghostResult: any = await tx.execute(sql`
      SELECT id, order_id, status, source, external_fulfillment_id,
             requires_review, review_reason
      FROM wms.outbound_shipments
      WHERE id = ${historicalGhostShipmentId}
      FOR UPDATE
    `);
    const ghost = resultRows(ghostResult)[0];
    if (
      !ghost
      || Number(ghost.order_id) !== Number(original.order_id)
      || !["cancelled", "voided"].includes(String(ghost.status))
      || String(ghost.source) !== "shipstation_split"
      || String(ghost.external_fulfillment_id) !== `shipstation_shipment:${identityRepair.providerShipmentId}`
      || ghost.requires_review !== true
      || !String(ghost.review_reason ?? "").includes(
        "uq_outbound_shipments_shipped_order_tracking",
      )
    ) {
      throw new Error("the failed historical split changed before it could be repaired");
    }
    const itemResult: any = await tx.execute(sql`
      SELECT id, shipment_id, order_item_id, qty
      FROM wms.outbound_shipment_items
      WHERE shipment_id IN (${identityRepair.wmsShipmentId}, ${historicalGhostShipmentId})
      ORDER BY shipment_id, id
    `);
    if (!historicalGhostItemsMatch(
      providerShipment,
      identityRepair.wmsShipmentId,
      historicalGhostShipmentId,
      resultRows(itemResult),
    )) {
      throw new Error("the failed historical split items no longer match ShipStation evidence");
    }
    await tx.execute(sql`
      UPDATE wms.outbound_shipments
      SET external_fulfillment_id = NULL,
          requires_review = false,
          review_reason = 'shipstation_split_ghost_collapsed',
          updated_at = NOW()
      WHERE id = ${historicalGhostShipmentId}
    `);
  } else {
    const providerSignature = providerWmsItemSignature(providerShipment);
    const itemResult: any = await tx.execute(sql`
      SELECT id, qty
      FROM wms.outbound_shipment_items
      WHERE shipment_id = ${identityRepair.wmsShipmentId}
      ORDER BY id
    `);
    const wmsSignature = resultRows(itemResult)
      .map((row) => `${Number(row.id)}:${Number(row.qty)}`)
      .join("|");
    if (!providerSignature || providerSignature !== wmsSignature) {
      throw new Error("the original ShipStation package items no longer match WMS authority");
    }
  }
  await tx.execute(sql`
    UPDATE wms.outbound_shipments
    SET external_fulfillment_id = ${`shipstation_shipment:${identityRepair.providerShipmentId}`},
        tracking_number = ${identityRepair.originalTrackingNumber},
        shipstation_order_id = ${identityRepair.providerOrderId},
        shipstation_order_key = ${identityRepair.providerOrderKey},
        engine_order_ref = ${String(identityRepair.providerOrderId)},
        engine_shipment_ref = ${identityRepair.providerOrderKey},
        requires_review = false,
        review_reason = 'shipstation_original_identity_restored',
        updated_at = NOW()
    WHERE id = ${identityRepair.wmsShipmentId}
  `);
}

async function prepareMappedShipment(
  db: any,
  context: RemediationContext,
  exceptionId: number,
  shipment: ShipStationShipment,
  lines: PreparedLine[],
  input: ShipStationUnmappedReshipAdoptionInput,
  identityRepair: ShipStationProviderIdentityRepair | null,
  originalPackageIdentityRepair: ShipStationOriginalPackageIdentityRepair | null,
  originalProviderShipment: ShipStationShipment | null,
): Promise<number> {
  const operator = requiredOperator(input.operator);
  const originalShipmentId = positiveInteger(input.originalShipmentId, "originalShipmentId");
  if (originalShipmentId === context.candidateShipmentId) {
    throw new Error("the replacement package cannot replace itself");
  }
  const reason = String(input.reason).trim();
  if (!RESHIP_REASONS.has(reason)) {
    throw new Error("a valid replacement reason is required");
  }

  return withOptionalTransaction(db, async (tx) => {
    await tx.execute(sql`
      SELECT id
      FROM wms.reconciliation_exceptions
      WHERE id = ${exceptionId}
        AND status IN ('open', 'acknowledged')
      FOR UPDATE
    `);

    const originalResult: any = await tx.execute(sql`
      SELECT id, status, order_id, shipment_purpose,
             external_fulfillment_id, tracking_number,
             shipstation_order_id, shipstation_order_key,
             EXISTS (
               SELECT 1
               FROM wms.outbound_shipment_items original_item
               WHERE original_item.shipment_id = wms.outbound_shipments.id
                 AND original_item.order_item_id IS NOT NULL
             ) AS has_customer_items
      FROM wms.outbound_shipments
      WHERE id = ${originalShipmentId}
      FOR UPDATE
    `);
    const original = resultRows(originalResult)[0];
    if (!original || Number(original.order_id) !== context.wmsOrderId) {
      throw new Error("original shipment must belong to the same WMS order");
    }
    if (String(original.shipment_purpose ?? "customer_fulfillment") !== "customer_fulfillment") {
      throw new Error("original shipment must have customer-fulfillment authority");
    }
    if (!original.has_customer_items) {
      throw new Error("original shipment must contain customer-fulfillment items");
    }
    if (!["shipped", "returned", "lost"].includes(String(original.status))) {
      throw new Error("original shipment must already have physically shipped");
    }
    if (originalPackageIdentityRepair) {
      if (!originalProviderShipment) {
        throw new Error("original ShipStation package evidence is unavailable");
      }
      await restoreOriginalPackageIdentity(
        tx,
        original,
        originalPackageIdentityRepair,
        originalProviderShipment,
      );
    }
    if (reason === "lost" && String(original.status) !== "lost") {
      await tx.execute(sql`
        UPDATE wms.outbound_shipments
        SET status = 'lost',
            lost_at = COALESCE(lost_at, NOW()),
            lost_reason = COALESCE(lost_reason, 'operator_confirmed_lost_for_reship'),
            updated_at = NOW()
        WHERE id = ${originalShipmentId}
          AND status = 'shipped'
      `);
    }

    const existingResult: any = await tx.execute(sql`
      SELECT id, order_id, status, source, shipment_purpose
      FROM wms.outbound_shipments
      WHERE external_fulfillment_id = ${`shipstation_shipment:${context.externalShipmentRef}`}
      FOR UPDATE
    `);
    let candidate = resultRows(existingResult)[0];
    if (candidate && Number(candidate.order_id) !== context.wmsOrderId) {
      throw new Error("provider shipment is already attached to a different WMS order");
    }
    if (identityRepair && Number(candidate?.id) !== identityRepair.activeCandidateShipmentId) {
      throw new Error("the active ShipStation package no longer matches its WMS candidate");
    }

    if (!candidate) {
      const inserted: any = await tx.execute(sql`
        INSERT INTO wms.outbound_shipments (
          order_id, channel_id, external_fulfillment_id, source, status,
          tracking_number, carrier, service_code,
          shipstation_order_id, shipstation_order_key,
          shipping_engine, engine_order_ref, engine_shipment_ref,
          requires_review, review_reason,
          shipment_purpose, replaces_shipment_id, replacement_reason,
          replacement_authorized_at, replacement_authorized_by,
          created_at, updated_at
        )
        SELECT
          wms_order.id, wms_order.channel_id,
          ${`shipstation_shipment:${context.externalShipmentRef}`},
          'shipstation_reship_adopted',
          'queued', ${shipment.trackingNumber}, ${shipment.carrierCode}, ${shipment.serviceCode},
          ${shipment.orderId}, ${shipment.orderKey},
          'shipstation', ${String(shipment.orderId)}, ${shipment.orderKey},
          true, 'shipstation_reship_adoption_pending',
          'replacement', ${originalShipmentId}, ${reason},
          ${new Date()}, ${operator},
          NOW(), NOW()
        FROM wms.orders wms_order
        WHERE wms_order.id = ${context.wmsOrderId}
        RETURNING id, order_id, status, source, shipment_purpose
      `);
      candidate = resultRows(inserted)[0];
      if (!candidate) throw new Error("failed to create classified WMS shipment");
    } else {
      const { itemCount, inventoryShipCount } = await loadShipmentAuthorityCounts(
        tx,
        positiveInteger(candidate.id, "candidateShipmentId"),
      );
      const repairsCrossedVoid = Boolean(
        identityRepair
        && Number(candidate.id) === identityRepair.activeCandidateShipmentId
        && String(candidate.status) === "voided"
        && itemCount === 0
        && inventoryShipCount === 0,
      );
      if (
        ["cancelled", "voided", "returned", "lost"].includes(String(candidate.status))
        && !repairsCrossedVoid
      ) {
        throw new Error(`candidate shipment is ${candidate.status} and cannot be reclassified`);
      }
      if ((itemCount > 0 || inventoryShipCount > 0) && String(candidate.shipment_purpose) !== "replacement") {
        throw new Error("candidate shipment already has a different authority classification");
      }
      if (identityRepair) {
        await retireSupersededCandidate(tx, context, identityRepair);
        await tx.execute(sql`
          UPDATE wms.outbound_shipments
          SET status = 'queued',
              tracking_number = ${shipment.trackingNumber},
              voided_at = NULL,
              source = 'shipstation_reship_adopted',
              shipment_purpose = 'replacement',
              replaces_shipment_id = ${originalShipmentId},
              replacement_reason = ${reason},
              replacement_authorized_at = ${new Date()},
              replacement_authorized_by = ${operator},
              requires_review = true,
              review_reason = 'shipstation_reship_adoption_pending',
              updated_at = NOW()
          WHERE id = ${candidate.id}
        `);
      } else {
        await tx.execute(sql`
          UPDATE wms.outbound_shipments
          SET source = 'shipstation_reship_adopted',
              shipment_purpose = 'replacement',
              replaces_shipment_id = ${originalShipmentId},
              replacement_reason = ${reason},
              replacement_authorized_at = ${new Date()},
              replacement_authorized_by = ${operator},
              requires_review = true,
              review_reason = 'shipstation_reship_adoption_pending',
              updated_at = NOW()
          WHERE id = ${candidate.id}
        `);
      }
    }

    const candidateShipmentId = positiveInteger(candidate.id, "candidateShipmentId");
    for (const line of aggregatePreparedLines(lines)) {
      const authorityPredicate = line.shipmentItemPurpose === "concession"
        ? sql`shipment_item_purpose = 'concession' AND product_variant_id = ${line.productVariantId}`
        : sql`replacement_for_order_item_id = ${line.orderItemId}`;
      const existingLineResult: any = await tx.execute(sql`
        SELECT id, order_item_id, replacement_for_order_item_id, shipment_item_purpose,
               product_variant_id, qty, from_location_id
        FROM wms.outbound_shipment_items
        WHERE shipment_id = ${candidateShipmentId}
          AND ${authorityPredicate}
        LIMIT 1
      `);
      const existingLine = resultRows(existingLineResult)[0];
      if (existingLine) {
        const same =
          Number(existingLine.product_variant_id) === line.productVariantId &&
          Number(existingLine.qty) === line.quantity &&
          Number(existingLine.from_location_id) === line.fromLocationId &&
          String(existingLine.shipment_item_purpose) === line.shipmentItemPurpose &&
          (line.shipmentItemPurpose === "concession"
            ? existingLine.replacement_for_order_item_id == null
            : Number(existingLine.replacement_for_order_item_id) === line.orderItemId);
        if (!same) throw new Error(`existing mapped line for SKU ${line.sku} differs from this request`);
        continue;
      }
      await tx.execute(sql`
        INSERT INTO wms.outbound_shipment_items (
          shipment_id, order_item_id, replacement_for_order_item_id,
          shipment_item_purpose, product_variant_id, qty,
          from_location_id, tracking_id, created_at
        )
        VALUES (
          ${candidateShipmentId}, NULL,
          ${line.orderItemId}, ${line.shipmentItemPurpose}, ${line.productVariantId},
          ${line.quantity}, ${line.fromLocationId}, ${context.externalShipmentRef}, NOW()
        )
      `);
    }
    return candidateShipmentId;
  });
}

async function finishMappedShipment(
  db: any,
  exceptionId: number,
  candidateShipmentId: number,
  input: ShipStationUnmappedReshipAdoptionInput,
  shipment: ShipStationShipment,
  lines: PreparedLine[],
  identityRepair: ShipStationProviderIdentityRepair | null,
  originalPackageIdentityRepair: ShipStationOriginalPackageIdentityRepair | null,
): Promise<void> {
  const operator = requiredOperator(input.operator);
  const hasConcessionItem = lines.some((line) => line.shipmentItemPurpose === "concession");
  const resolution = hasConcessionItem
    ? "Operator recorded a different or free physical item against the shipment. Inventory moved; customer demand, fulfillment, and channel fulfillment were not changed."
    : "Operator authorized the provider package as a replacement shipment. Inventory moved; customer fulfillment and channel fulfillment were not repeated.";
  const details = JSON.stringify({
    remediationAction: "adopt_reship",
    remediationReason: input.reason,
    remediationNotes: optionalNotes(input.notes),
    originalShipmentId: input.originalShipmentId ?? null,
    candidateShipmentId,
    providerShipmentId: shipment.shipmentId,
    providerIdentityRepair: identityRepair,
    originalPackageIdentityRepair,
    lineMappings: lines.map((line) => ({
      providerItemIndex: line.providerItemIndex,
      evidenceSource: line.evidenceSource,
      shipmentItemPurpose: line.shipmentItemPurpose,
      orderItemId: line.orderItemId,
      sku: line.sku,
      quantity: line.quantity,
      productVariantId: line.productVariantId,
      fromLocationId: line.fromLocationId,
    })),
  });
  await withOptionalTransaction(db, async (tx) => {
    await tx.execute(sql`
      UPDATE wms.outbound_shipments
      SET requires_review = false,
          review_reason = 'shipstation_reship_adopted',
          updated_at = NOW()
      WHERE id = ${candidateShipmentId}
    `);
    await tx.execute(sql`
      UPDATE wms.reconciliation_exceptions
      SET classification = 'manual_review',
          status = 'resolved',
          severity = 'info',
          wms_shipment_id = ${candidateShipmentId},
          details = details || ${details}::jsonb,
          resolved_at = NOW(),
          resolved_by = ${operator},
          resolution = ${resolution},
          updated_at = NOW()
      WHERE id = ${exceptionId}
        AND status IN ('open', 'acknowledged')
    `);
  });
}

export async function adoptShipStationUnmappedPhysicalAsReship(
  db: any,
  shipStation: ShipStationService,
  input: ShipStationUnmappedReshipAdoptionInput,
): Promise<Record<string, unknown>> {
  const initialContext = await loadContext(db, input);
  const resolvedProvider = await resolveProviderShipment(db, shipStation, initialContext);
  const {
    context,
    shipment,
    identityRepair,
    originalPackageIdentityRepair,
    originalProviderShipment,
  } = resolvedProvider;
  if (shipment.voidDate) {
    throw new Error("a voided ShipStation shipment cannot be adopted as a reship");
  }
  if (!String(shipment.shipDate ?? "").trim()) {
    throw new Error("ShipStation shipment has no shipped date");
  }
  const exceptionId = await ensureException(db, context, shipment);
  const operator = requiredOperator(input.operator);

  const orderItems = await loadOrderItems(db, context.wmsOrderId);
  const lines = await prepareLines(db, context, shipment, orderItems, input);
  const candidateShipmentId = await prepareMappedShipment(
    db,
    context,
    exceptionId,
    shipment,
    lines,
    input,
    identityRepair,
    originalPackageIdentityRepair,
    originalProviderShipment,
  );

  const processed = await shipStation.processShipmentNotification(shipment);
  if (!processed.processed) {
    throw new Error("classified shipment did not complete the guarded ShipStation cascade");
  }
  await finishMappedShipment(
    db,
    exceptionId,
    candidateShipmentId,
    input,
    shipment,
    lines,
    identityRepair,
    originalPackageIdentityRepair,
  );
  return {
    changed: true,
    exceptionId,
    candidateShipmentId,
    operator,
    providerIdentityRepaired: identityRepair !== null,
    originalPackageIdentityRepaired: originalPackageIdentityRepair !== null,
  };
}

export async function resolveShipStationUnmappedPhysicalAsVoided(
  db: any,
  shipStation: ShipStationService,
  input: ShipStationUnmappedVoidedResolutionInput,
): Promise<Record<string, unknown>> {
  const operator = requiredOperator(input.operator);
  const context = await loadContext(db, input);
  const shipmentId = positiveInteger(
    context.externalShipmentRef,
    "externalShipmentRef",
  );
  const providerShipment = await shipStation.getShipmentById(shipmentId);
  if (!providerShipment) {
    throw new Error(`ShipStation physical shipment ${shipmentId} was not found`);
  }
  if (providerShipment.shipmentId !== shipmentId) {
    throw new Error("ShipStation returned a different physical shipment id");
  }
  if (!providerShipment.voidDate) {
    throw new Error("ShipStation reports this shipment as active, not voided");
  }

  if (context.exceptionId !== null) {
    const resolution = await resolveVoidedShipStationUnmappedPhysicalException(
      db,
      { shipmentId, voidDate: providerShipment.voidDate },
      { resolvedBy: operator },
    );
    if (!resolution) {
      throw new Error("voided ShipStation shipment exception is already resolved");
    }
    return {
      resolved: true,
      exceptionId: resolution.exceptionId,
      providerShipmentId: shipmentId,
      providerVoidDate: resolution.providerVoidDate,
      inventoryChanged: false,
      fulfillmentChanged: false,
    };
  }

  const result: any = await db.execute(sql`
    UPDATE wms.outbound_shipments
    SET requires_review = false,
        review_reason = 'shipstation_voided_label_resolved',
        updated_at = NOW()
    WHERE id = ${context.authorityShipmentId}
      AND external_fulfillment_id = ${`shipstation_shipment:${shipmentId}`}
      AND requires_review = true
    RETURNING id
  `);
  if (resultRows(result).length !== 1) {
    throw new Error("voided ShipStation shipment review is already resolved");
  }
  return {
    resolved: true,
    shipmentId: context.authorityShipmentId,
    providerShipmentId: shipmentId,
    providerVoidDate: providerShipment.voidDate,
    inventoryChanged: false,
    fulfillmentChanged: false,
  };
}

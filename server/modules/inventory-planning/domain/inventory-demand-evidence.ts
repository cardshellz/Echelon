import { createHash } from "node:crypto";

import {
  INVENTORY_DEMAND_METHOD_VERSION,
  INVENTORY_DEMAND_MIN_ACTIVE_DAYS,
  INVENTORY_DEMAND_MIN_CONSUMPTION_UNITS,
  INVENTORY_DEMAND_MIN_OBSERVED_DAYS,
  INVENTORY_DEMAND_MIN_SOURCE_EVENTS,
  INVENTORY_DEMAND_RECENCY_DAYS,
} from "@shared/types/inventory-promise-safety-admin";
import { canonicalJson } from "@shared/utils/canonical-json";

const MILLI_UNITS = BigInt(1_000);
const MILLISECONDS_PER_DAY = 86_400_000;

export const DEMAND_TRUST_REASON = {
  insufficientObservationDays: "INSUFFICIENT_OBSERVATION_DAYS",
  insufficientSourceEvents: "INSUFFICIENT_SOURCE_EVENTS",
  insufficientActiveDays: "INSUFFICIENT_ACTIVE_DAYS",
  insufficientConsumptionUnits: "INSUFFICIENT_CONSUMPTION_UNITS",
  noRecentConsumption: "NO_RECENT_CONSUMPTION",
  unresolvedVariant: "UNRESOLVED_VARIANT_CONSUMPTION",
  unresolvedWarehouse: "UNRESOLVED_WAREHOUSE_CONSUMPTION",
  unclassifiedPurpose: "UNCLASSIFIED_CONSUMPTION_PURPOSE",
  shipmentReview: "SHIPMENT_REQUIRES_REVIEW",
  missingShipLedger: "PHYSICAL_SHIPMENT_WITHOUT_SHIP_LEDGER",
  missingPhysicalShipment: "SHIP_LEDGER_WITHOUT_PHYSICAL_SHIPMENT",
} as const;

export interface DemandConsumptionEvent {
  eventKey: string;
  sourceKey: string;
  sourceType: "physical_shipment" | "build_component" | "ship_ledger_gap";
  productVariantId: number | null;
  warehouseId: number | null;
  occurredAt: Date;
  quantityUnits: bigint;
  purpose: string;
  trustReasons: readonly string[];
}

export interface DemandEvidencePlanningInput {
  resources: readonly DemandEvidenceResource[];
  windowStartedAt: Date;
  windowEndedAt: Date;
  calculatedAt: Date;
  events: readonly DemandConsumptionEvent[];
}

export interface DemandEvidenceResource {
  productVariantId: number;
  warehouseId: number;
  observationStartedAt: Date;
}

export interface PlannedDemandEvidenceSnapshot {
  productVariantId: number;
  warehouseId: number;
  windowStartedAt: Date;
  windowEndedAt: Date;
  irreversibleConsumptionUnits: bigint;
  observedDays: number;
  dailyDemandMilliUnits: bigint;
  trustStatus: "trusted" | "untrusted";
  trustReasons: string[];
  methodVersion: typeof INVENTORY_DEMAND_METHOD_VERSION;
  inputFingerprint: string;
  calculatedAt: Date;
}

export class InventoryDemandEvidenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "InventoryDemandEvidenceError";
  }
}

export function completeUtcDemandWindow(calculatedAt: Date, observationDays: number): {
  windowStartedAt: Date;
  windowEndedAt: Date;
} {
  if (!Number.isInteger(observationDays) || observationDays <= 0) {
    throw new InventoryDemandEvidenceError(
      "INVALID_OBSERVATION_DAYS",
      "Demand observation days must be a positive integer.",
      { observationDays },
    );
  }
  const timestamp = calculatedAt.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new InventoryDemandEvidenceError(
      "INVALID_CALCULATION_TIME",
      "Demand evidence calculation time is invalid.",
    );
  }
  const windowEndedAt = new Date(Date.UTC(
    calculatedAt.getUTCFullYear(),
    calculatedAt.getUTCMonth(),
    calculatedAt.getUTCDate(),
  ));
  return {
    windowStartedAt: new Date(windowEndedAt.getTime() - observationDays * MILLISECONDS_PER_DAY),
    windowEndedAt,
  };
}

export function planDemandEvidenceSnapshots(
  input: DemandEvidencePlanningInput,
): PlannedDemandEvidenceSnapshot[] {
  exactObservedDays(input.windowStartedAt, input.windowEndedAt);
  if (input.calculatedAt < input.windowEndedAt) {
    throw new InventoryDemandEvidenceError(
      "CALCULATION_PRECEDES_WINDOW",
      "Demand evidence cannot be calculated before the observation window ends.",
    );
  }
  const resources = parseResources(input.resources, input.calculatedAt);
  const events = input.events.map(parseEvent).sort((left, right) =>
    left.eventKey.localeCompare(right.eventKey));
  const duplicateEventKeys = events.filter((event, index) =>
    index > 0 && event.eventKey === events[index - 1]?.eventKey);
  if (duplicateEventKeys.length > 0) {
    throw new InventoryDemandEvidenceError(
      "DUPLICATE_CONSUMPTION_EVENT",
      "Demand consumption evidence contains duplicate event identities.",
      { eventKeys: [...new Set(duplicateEventKeys.map((event) => event.eventKey))] },
    );
  }
  const outsideWindow = events.find((event) =>
    event.occurredAt < input.windowStartedAt || event.occurredAt >= input.windowEndedAt);
  if (outsideWindow) {
    throw new InventoryDemandEvidenceError(
      "CONSUMPTION_EVENT_OUTSIDE_WINDOW",
      "Demand consumption evidence must fall inside the complete observation window.",
      { eventKey: outsideWindow.eventKey, occurredAt: outsideWindow.occurredAt.toISOString() },
    );
  }

  return resources.map((resource) => {
    const { productVariantId, warehouseId } = resource;
    const exactEvents = events.filter((event) =>
      event.productVariantId === productVariantId && event.warehouseId === warehouseId);
    const affectingEvents = events.filter((event) =>
      (event.productVariantId === productVariantId || event.productVariantId === null)
      && (event.warehouseId === warehouseId || event.warehouseId === null));
    const irreversibleConsumptionUnits = exactEvents.reduce(
      (total, event) => total + event.quantityUnits,
      BigInt(0),
    );
    const sourceEvents = new Set(exactEvents.map((event) => event.sourceKey)).size;
    const activeDays = new Set(exactEvents.map((event) => utcDay(event.occurredAt))).size;
    const latestConsumptionAt = exactEvents.reduce<Date | null>(
      (latest, event) => latest === null || event.occurredAt > latest ? event.occurredAt : latest,
      null,
    );
    const earliestConsumptionAt = exactEvents.reduce<Date | null>(
      (earliest, event) => earliest === null || event.occurredAt < earliest
        ? event.occurredAt
        : earliest,
      null,
    );
    const observationStartedAt = earliestConsumptionAt !== null
      && earliestConsumptionAt < resource.observationStartedAt
      ? earliestConsumptionAt
      : resource.observationStartedAt;
    const observedDays = completeObservedDays(
      input.windowStartedAt,
      input.windowEndedAt,
      observationStartedAt,
    );
    const reasons = new Set<string>();
    if (observedDays < INVENTORY_DEMAND_MIN_OBSERVED_DAYS) {
      reasons.add(DEMAND_TRUST_REASON.insufficientObservationDays);
    }
    if (sourceEvents < INVENTORY_DEMAND_MIN_SOURCE_EVENTS) {
      reasons.add(DEMAND_TRUST_REASON.insufficientSourceEvents);
    }
    if (activeDays < INVENTORY_DEMAND_MIN_ACTIVE_DAYS) {
      reasons.add(DEMAND_TRUST_REASON.insufficientActiveDays);
    }
    if (irreversibleConsumptionUnits < BigInt(INVENTORY_DEMAND_MIN_CONSUMPTION_UNITS)) {
      reasons.add(DEMAND_TRUST_REASON.insufficientConsumptionUnits);
    }
    const recencyBoundary = new Date(
      input.windowEndedAt.getTime() - INVENTORY_DEMAND_RECENCY_DAYS * MILLISECONDS_PER_DAY,
    );
    if (latestConsumptionAt === null || latestConsumptionAt < recencyBoundary) {
      reasons.add(DEMAND_TRUST_REASON.noRecentConsumption);
    }
    for (const event of affectingEvents) {
      if (event.productVariantId === null) reasons.add(DEMAND_TRUST_REASON.unresolvedVariant);
      if (event.warehouseId === null) reasons.add(DEMAND_TRUST_REASON.unresolvedWarehouse);
      event.trustReasons.forEach((reason) => reasons.add(reason));
    }
    const trustReasons = [...reasons].sort();
    const dailyDemandMilliUnits = observedDays === 0
      ? BigInt(0)
      : ceilDivide(irreversibleConsumptionUnits * MILLI_UNITS, BigInt(observedDays));
    const fingerprintProjection = {
      methodVersion: INVENTORY_DEMAND_METHOD_VERSION,
      productVariantId,
      warehouseId,
      windowStartedAt: input.windowStartedAt.toISOString(),
      windowEndedAt: input.windowEndedAt.toISOString(),
      observationStartedAt: observationStartedAt.toISOString(),
      observedDays,
      events: affectingEvents.map((event) => ({
        eventKey: event.eventKey,
        sourceKey: event.sourceKey,
        sourceType: event.sourceType,
        productVariantId: event.productVariantId,
        warehouseId: event.warehouseId,
        occurredAt: event.occurredAt.toISOString(),
        quantityUnits: event.quantityUnits.toString(),
        purpose: event.purpose,
        trustReasons: [...event.trustReasons].sort(),
      })),
      trustReasons,
    };
    return {
      productVariantId,
      warehouseId,
      windowStartedAt: input.windowStartedAt,
      windowEndedAt: input.windowEndedAt,
      irreversibleConsumptionUnits,
      observedDays,
      dailyDemandMilliUnits,
      trustStatus: trustReasons.length === 0 ? "trusted" as const : "untrusted" as const,
      trustReasons,
      methodVersion: INVENTORY_DEMAND_METHOD_VERSION,
      inputFingerprint: createHash("sha256")
        .update(canonicalJson(fingerprintProjection), "utf8")
        .digest("hex"),
      calculatedAt: input.calculatedAt,
    };
  });
}

function parseEvent(event: DemandConsumptionEvent): DemandConsumptionEvent {
  if (!event.eventKey.trim() || !event.sourceKey.trim() || !event.purpose.trim()) {
    throw new InventoryDemandEvidenceError(
      "INVALID_CONSUMPTION_EVENT",
      "Demand consumption evidence requires nonblank source identity and purpose.",
      { eventKey: event.eventKey, sourceKey: event.sourceKey },
    );
  }
  if (event.quantityUnits <= BigInt(0)) {
    throw new InventoryDemandEvidenceError(
      "INVALID_CONSUMPTION_QUANTITY",
      "Demand consumption quantity must be positive.",
      { eventKey: event.eventKey, quantityUnits: event.quantityUnits.toString() },
    );
  }
  if (
    event.productVariantId !== null
    && (!Number.isInteger(event.productVariantId) || event.productVariantId <= 0)
  ) {
    throw new InventoryDemandEvidenceError(
      "INVALID_CONSUMPTION_VARIANT",
      "Demand consumption product variant identifiers must be positive integers.",
      { eventKey: event.eventKey, productVariantId: event.productVariantId },
    );
  }
  if (
    event.warehouseId !== null
    && (!Number.isInteger(event.warehouseId) || event.warehouseId <= 0)
  ) {
    throw new InventoryDemandEvidenceError(
      "INVALID_CONSUMPTION_WAREHOUSE",
      "Demand consumption warehouse identifiers must be positive integers.",
      { eventKey: event.eventKey, warehouseId: event.warehouseId },
    );
  }
  const occurredAt = event.occurredAt.getTime();
  if (!Number.isFinite(occurredAt)) {
    throw new InventoryDemandEvidenceError(
      "INVALID_CONSUMPTION_TIME",
      "Demand consumption time is invalid.",
      { eventKey: event.eventKey },
    );
  }
  return {
    ...event,
    eventKey: event.eventKey.trim(),
    sourceKey: event.sourceKey.trim(),
    purpose: event.purpose.trim(),
    trustReasons: [...new Set(event.trustReasons.map((reason) => reason.trim()).filter(Boolean))].sort(),
  };
}

function exactObservedDays(start: Date, end: Date): number {
  const duration = end.getTime() - start.getTime();
  if (duration <= 0 || duration % MILLISECONDS_PER_DAY !== 0) {
    throw new InventoryDemandEvidenceError(
      "INVALID_OBSERVATION_WINDOW",
      "Demand observation window must contain complete UTC days.",
      { start: start.toISOString(), end: end.toISOString() },
    );
  }
  return duration / MILLISECONDS_PER_DAY;
}

function parseResources(
  resources: readonly DemandEvidenceResource[],
  calculatedAt: Date,
): DemandEvidenceResource[] {
  const sorted = [...resources].sort((left, right) =>
    left.productVariantId - right.productVariantId || left.warehouseId - right.warehouseId);
  const seen = new Set<string>();
  for (const resource of sorted) {
    if (
      !Number.isInteger(resource.productVariantId)
      || resource.productVariantId <= 0
      || !Number.isInteger(resource.warehouseId)
      || resource.warehouseId <= 0
    ) {
      throw new InventoryDemandEvidenceError(
        "INVALID_RESOURCE_ID",
        "Demand evidence resources require positive variant and warehouse identifiers.",
        { resource },
      );
    }
    if (
      !Number.isFinite(resource.observationStartedAt.getTime())
      || resource.observationStartedAt > calculatedAt
    ) {
      throw new InventoryDemandEvidenceError(
        "INVALID_RESOURCE_OBSERVATION_START",
        "Demand evidence resource observation must start no later than calculation time.",
        {
          productVariantId: resource.productVariantId,
          warehouseId: resource.warehouseId,
        },
      );
    }
    const key = `${resource.productVariantId}:${resource.warehouseId}`;
    if (seen.has(key)) {
      throw new InventoryDemandEvidenceError(
        "DUPLICATE_DEMAND_RESOURCE",
        "Demand evidence resources must be unique by variant and warehouse.",
        { productVariantId: resource.productVariantId, warehouseId: resource.warehouseId },
      );
    }
    seen.add(key);
  }
  return sorted;
}

function completeObservedDays(windowStart: Date, windowEnd: Date, observationStart: Date): number {
  if (observationStart <= windowStart) return exactObservedDays(windowStart, windowEnd);
  const firstCompleteDayStart = ceilUtcDay(observationStart);
  if (firstCompleteDayStart >= windowEnd) return 0;
  return exactObservedDays(firstCompleteDayStart, windowEnd);
}

function ceilUtcDay(value: Date): Date {
  const floor = new Date(Date.UTC(
    value.getUTCFullYear(),
    value.getUTCMonth(),
    value.getUTCDate(),
  ));
  return value.getTime() === floor.getTime()
    ? floor
    : new Date(floor.getTime() + MILLISECONDS_PER_DAY);
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= BigInt(0)) {
    throw new InventoryDemandEvidenceError(
      "INVALID_DIVISOR",
      "Demand evidence divisor must be positive.",
    );
  }
  return numerator === BigInt(0)
    ? BigInt(0)
    : (numerator + denominator - BigInt(1)) / denominator;
}

function utcDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

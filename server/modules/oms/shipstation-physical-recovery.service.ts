import { sql } from "drizzle-orm";
import type {
  ShipStationCompletedPhysicalPackage,
  ShipStationPhysicalRecoveryClient,
} from "../shipping/shipstation-physical-recovery.client";
import type { CarrierTrackingService } from "../shipping/carrier-tracking.service";
import {
  normalizeExactPositiveWmsShipmentItems,
  type ExactWmsShipmentItem,
} from "../shipping/shipstation-provider-contents.domain";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 500;
const DEFAULT_MIN_AGE_HOURS = 6;
const MAX_MIN_AGE_MINUTES = 24 * 30 * 60;

export type ShipStationPhysicalRecoveryMode = "dry-run" | "execute";

export interface ShipStationPhysicalRecoveryOptions {
  mode?: ShipStationPhysicalRecoveryMode;
  limit?: number | null;
  minAgeHours?: number;
  minAgeMinutes?: number;
  maxAgeDays?: number | null;
  orderNumber?: string | null;
}

export interface ShipStationPhysicalRecoveryCandidate {
  wmsOrderId: number;
  omsOrderId: number;
  orderNumber: string;
  provider: "shopify" | "ebay";
  wmsShipmentIds: number[];
  wmsShipmentItemIds: number[];
  wmsShipmentItems: readonly ExactWmsShipmentItem[];
  oldestShipmentCreatedAt: Date | string;
}

export interface ShipStationPhysicalRecoveryCandidateResult {
  candidate: ShipStationPhysicalRecoveryCandidate;
  matchedPackages: ShipStationCompletedPhysicalPackage[];
  outcome: "planned" | "recovered" | "no_match" | "client_not_configured" | "error";
  error: string | null;
  trackingWarnings: string[];
}

export interface ShipStationPhysicalRecoveryRunResult {
  mode: ShipStationPhysicalRecoveryMode;
  candidates: number;
  matchedPackages: number;
  labelsObserved: number;
  labelsInserted: number;
  labelLinksInserted: number;
  trackingSnapshotsHydrated: number;
  dispatchCommandsCreated: number;
  trackingWarnings: number;
  noMatch: number;
  errors: number;
  results: ShipStationPhysicalRecoveryCandidateResult[];
}

export interface ShipStationPhysicalRecoveryService {
  recover(
    options?: ShipStationPhysicalRecoveryOptions,
  ): Promise<ShipStationPhysicalRecoveryRunResult>;
}

export interface ShipStationPhysicalRecoveryDependencies {
  client: ShipStationPhysicalRecoveryClient;
  carrierTracking: Pick<
    CarrierTrackingService,
    | "observeShipStationLabel"
    | "reconcileShipStationLabel"
    | "hydrateShipStationTrackingIdentity"
  >;
}

function positiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${field} must be an integer from 1 through ${maximum}`);
  }
  return parsed;
}

function parsePgIntegerArray(value: unknown, field: string): number[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string" && /^\{.*\}$/.test(value)
      ? value.slice(1, -1).split(",").filter(Boolean)
      : [];
  const parsed = [...new Set(values.map(Number))].filter(
    (entry) => Number.isSafeInteger(entry) && entry > 0,
  );
  if (parsed.length === 0) {
    throw new Error(`${field} must contain at least one positive integer`);
  }
  return parsed.sort((left, right) => left - right);
}

function requiredPositiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}

function requiredString(value: unknown, field: string): string {
  const parsed = typeof value === "string" ? value.trim() : "";
  if (!parsed) throw new Error(`${field} is required`);
  return parsed;
}

function normalizeCandidate(row: Record<string, unknown>): ShipStationPhysicalRecoveryCandidate {
  const provider = requiredString(row.provider, "provider");
  if (provider !== "shopify" && provider !== "ebay") {
    throw new Error(`provider must be shopify or ebay (got ${provider})`);
  }
  const oldestShipmentCreatedAt = row.oldest_shipment_created_at as Date | string | null;
  if (!oldestShipmentCreatedAt || Number.isNaN(new Date(oldestShipmentCreatedAt).getTime())) {
    throw new Error("oldest_shipment_created_at must be a valid timestamp");
  }
  const wmsShipmentItems = normalizeExactPositiveWmsShipmentItems(
    row.wms_shipment_items,
  );
  if (!wmsShipmentItems) {
    throw new Error(
      "wms_shipment_items must contain unique positive PostgreSQL-integer item quantities",
    );
  }
  return {
    wmsOrderId: requiredPositiveInteger(row.wms_order_id, "wms_order_id"),
    omsOrderId: requiredPositiveInteger(row.oms_order_id, "oms_order_id"),
    orderNumber: requiredString(row.order_number, "order_number"),
    provider,
    wmsShipmentIds: parsePgIntegerArray(row.wms_shipment_ids, "wms_shipment_ids"),
    wmsShipmentItemIds: wmsShipmentItems.map((item) => item.sourceShipmentItemId),
    wmsShipmentItems,
    oldestShipmentCreatedAt,
  };
}

export async function findShipStationPhysicalRecoveryCandidates(
  dbArg: any,
  options: ShipStationPhysicalRecoveryOptions = {},
): Promise<ShipStationPhysicalRecoveryCandidate[]> {
  if (options.minAgeHours !== undefined && options.minAgeMinutes !== undefined) {
    throw new Error("Pass either minAgeHours or minAgeMinutes, not both");
  }
  const minAgeMinutes = options.minAgeMinutes !== undefined
    ? positiveInteger(
        options.minAgeMinutes,
        DEFAULT_MIN_AGE_HOURS * 60,
        MAX_MIN_AGE_MINUTES,
        "minAgeMinutes",
      )
    : positiveInteger(
        options.minAgeHours,
        DEFAULT_MIN_AGE_HOURS,
        MAX_MIN_AGE_MINUTES / 60,
        "minAgeHours",
      ) * 60;
  const limit = options.limit === null
    ? null
    : positiveInteger(options.limit, DEFAULT_LIMIT, MAX_LIMIT, "limit");
  const maxAgeDays = options.maxAgeDays === null
    ? null
    : positiveInteger(options.maxAgeDays, 30, 3650, "maxAgeDays");
  const orderNumber = options.orderNumber?.trim() || null;
  if (orderNumber !== null && orderNumber.length > 50) {
    throw new Error("orderNumber cannot exceed 50 characters");
  }
  const limitSql = limit === null ? sql`` : sql`LIMIT ${limit}`;
  const orderSql = orderNumber === null ? sql`` : sql`AND wo.order_number = ${orderNumber}`;
  const maxAgeSql = maxAgeDays === null
    ? sql``
    : sql`AND eligible.created_at > NOW() - (${maxAgeDays} * INTERVAL '1 day')`;

  const result = await dbArg.execute(sql`
    WITH covered_provider_item_ids AS (
      SELECT DISTINCT
        provider_identity.shipment_item_id
      FROM wms.shipping_provider_labels AS label
      JOIN wms.shipping_provider_label_events AS event
        ON event.shipping_provider_label_id = label.id
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(event.sanitized_payload->'shipmentItems') = 'array'
          THEN event.sanitized_payload->'shipmentItems'
          ELSE '[]'::jsonb
        END
      ) AS provider_item
      -- Historical v1 events were not DB-range validated. Extract at most ten
      -- digits before any cast, then cast to integer only after the bound.
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN bounded_key.wms_shipment_item_id_text::bigint <= 2147483647
          THEN bounded_key.wms_shipment_item_id_text::integer
          ELSE NULL
        END AS shipment_item_id
        FROM (
          SELECT substring(
            provider_item->>'lineItemKey'
            FROM '^wms-item-([1-9][0-9]{0,9})$'
          ) AS wms_shipment_item_id_text
        ) AS bounded_key
      ) AS provider_identity
      WHERE label.provider = 'shipstation'
        AND label.label_status = 'active'
        AND EXISTS (
          SELECT 1
          FROM wms.carrier_tracking_event_matches AS event_match
          WHERE event_match.shipping_provider_label_id = label.id
            AND event_match.match_status = 'matched'
        )
        AND provider_identity.shipment_item_id IS NOT NULL
    ),
    eligible_items AS (
      SELECT
        os.id AS shipment_id,
        os.order_id,
        os.created_at,
        osi.id AS shipment_item_id,
        osi.qty AS quantity
      FROM wms.outbound_shipments AS os
      JOIN wms.outbound_shipment_items AS osi ON osi.shipment_id = os.id
      JOIN wms.order_items AS oi ON oi.id = osi.order_item_id
      WHERE COALESCE(os.held, false) = false
        AND COALESCE(os.shipment_purpose, 'customer_fulfillment') = 'customer_fulfillment'
        AND COALESCE(osi.shipment_item_purpose, 'customer_fulfillment') = 'customer_fulfillment'
        AND os.created_at < NOW() - (${minAgeMinutes} * INTERVAL '1 minute')
        AND COALESCE(osi.qty, 0) > 0
        AND COALESCE(oi.requires_shipping, 1) <> 0
        AND COALESCE(oi.picked_quantity, 0) >= COALESCE(osi.qty, 0)
        AND oi.status = 'completed'
        AND COALESCE(oi.on_hold, false) = false
        AND NOT EXISTS (
          SELECT 1
          FROM covered_provider_item_ids AS covered
          WHERE covered.shipment_item_id = osi.id
        )
    )
    SELECT
      wo.id AS wms_order_id,
      oo.id AS oms_order_id,
      wo.order_number,
      channel.provider,
      ARRAY_AGG(DISTINCT eligible.shipment_id ORDER BY eligible.shipment_id)::int[]
        AS wms_shipment_ids,
      ARRAY_AGG(
        DISTINCT eligible.shipment_item_id
        ORDER BY eligible.shipment_item_id
      )::int[] AS wms_shipment_item_ids,
      JSONB_AGG(
        JSONB_BUILD_OBJECT(
          'sourceShipmentItemId', eligible.shipment_item_id,
          'quantity', eligible.quantity
        )
        ORDER BY eligible.shipment_item_id
      ) AS wms_shipment_items,
      MIN(eligible.created_at) AS oldest_shipment_created_at
    FROM eligible_items AS eligible
    JOIN wms.orders AS wo ON wo.id = eligible.order_id
    JOIN oms.oms_orders AS oo
      ON (
           (wo.source IN ('oms', 'ebay') AND wo.oms_fulfillment_order_id = oo.id::text)
        OR (wo.source_table_id = oo.id::text)
    )
    JOIN channels.channels AS channel ON channel.id = oo.channel_id
    WHERE channel.provider IN ('shopify', 'ebay')
      AND oo.status NOT IN ('cancelled', 'refunded')
      AND COALESCE(oo.fulfillment_status, '') <> 'fulfilled'
      AND wo.cancelled_at IS NULL
      AND wo.warehouse_status <> 'cancelled'
      ${maxAgeSql}
      ${orderSql}
    GROUP BY wo.id, oo.id, wo.order_number, channel.provider
    ORDER BY MIN(eligible.created_at), wo.id
    ${limitSql}
  `);

  return (result?.rows ?? []).map((row: Record<string, unknown>) => normalizeCandidate(row));
}

function exactPackageContents(
  physicalPackage: ShipStationCompletedPhysicalPackage,
): readonly ExactWmsShipmentItem[] | null {
  if (physicalPackage.isReturnLabel !== false) return null;
  return normalizeExactPositiveWmsShipmentItems(physicalPackage.wmsShipmentItems);
}

function eligibleQuantityByShipmentItemId(
  candidates: readonly ShipStationPhysicalRecoveryCandidate[],
): ReadonlyMap<number, number> {
  const quantities = new Map<number, number>();
  for (const candidate of candidates) {
    for (const item of candidate.wmsShipmentItems) {
      const prior = quantities.get(item.sourceShipmentItemId);
      if (prior !== undefined && prior !== item.quantity) {
        throw new Error(
          `WMS shipment item ${item.sourceShipmentItemId} has conflicting recovery quantities`,
        );
      }
      quantities.set(item.sourceShipmentItemId, item.quantity);
    }
  }
  return quantities;
}

function packageBelongsToCandidate(
  physicalPackage: ShipStationCompletedPhysicalPackage,
  candidateItemIds: ReadonlySet<number>,
  eligibleQuantities: ReadonlyMap<number, number>,
): boolean {
  const providerItems = exactPackageContents(physicalPackage);
  return providerItems !== null
    && providerItems.some((item) => candidateItemIds.has(item.sourceShipmentItemId))
    && providerItems.every(
      (item) => eligibleQuantities.get(item.sourceShipmentItemId) === item.quantity,
    );
}

export function buildShipStationRecoveredLabelObservation(
  physicalPackage: ShipStationCompletedPhysicalPackage,
): Record<string, unknown> {
  const providerItems = exactPackageContents(physicalPackage);
  if (!providerItems) {
    throw new Error("Recovered provider package lacks exact positive item quantities");
  }
  return {
    shipmentId: physicalPackage.legacyShipStationShipmentId,
    orderId: null,
    orderKey: null,
    trackingNumber: physicalPackage.trackingNumber,
    carrierCode: physicalPackage.carrierCode,
    serviceCode: physicalPackage.serviceCode,
    shipDate: physicalPackage.shipDate,
    voidDate: null,
    isReturnLabel: false,
    shipmentItems: providerItems.map((item) => ({
      lineItemKey: `wms-item-${item.sourceShipmentItemId}`,
      quantity: item.quantity,
    })),
  };
}

export function createShipStationPhysicalRecoveryService(
  dbArg: any,
  dependencies: ShipStationPhysicalRecoveryDependencies,
): ShipStationPhysicalRecoveryService {
  return {
    async recover(options = {}) {
      const mode = options.mode ?? "dry-run";
      if (mode !== "dry-run" && mode !== "execute") {
        throw new Error(`Unsupported recovery mode: ${String(mode)}`);
      }
      const candidates = await findShipStationPhysicalRecoveryCandidates(dbArg, options);
      const eligibleQuantities = eligibleQuantityByShipmentItemId(candidates);
      const results: ShipStationPhysicalRecoveryCandidateResult[] = [];
      const processedLabels = new Map<string, {
        error: string | null;
        trackingWarning: string | null;
      }>();
      let matchedPackages = 0;
      let labelsObserved = 0;
      let labelsInserted = 0;
      let labelLinksInserted = 0;
      let trackingSnapshotsHydrated = 0;
      let dispatchCommandsCreated = 0;
      let trackingWarnings = 0;
      let noMatch = 0;
      let errors = 0;

      for (const candidate of candidates) {
        if (!dependencies.client.isConfigured()) {
          errors += 1;
          results.push({
            candidate,
            matchedPackages: [],
            outcome: "client_not_configured",
            error: "SHIPSTATION_V2_API_KEY is not configured",
            trackingWarnings: [],
          });
          continue;
        }

        try {
          const expectedItemIds = new Set(
            candidate.wmsShipmentItems.map((item) => item.sourceShipmentItemId),
          );
          const providerPackages = await dependencies.client.listCompletedPackagesForOrder(
            candidate.orderNumber,
          );
          const authorizedPackages = providerPackages.filter((physicalPackage) =>
            packageBelongsToCandidate(physicalPackage, expectedItemIds, eligibleQuantities)
          );
          if (authorizedPackages.length === 0) {
            noMatch += 1;
            results.push({
              candidate,
              matchedPackages: [],
              outcome: "no_match",
              error: null,
              trackingWarnings: [],
            });
            continue;
          }

          matchedPackages += authorizedPackages.length;
          if (mode === "dry-run") {
            results.push({
              candidate,
              matchedPackages: authorizedPackages,
              outcome: "planned",
              error: null,
              trackingWarnings: [],
            });
            continue;
          }

          const candidateErrors: string[] = [];
          const candidateTrackingWarnings: string[] = [];
          for (const physicalPackage of authorizedPackages) {
            const providerLabelId = String(physicalPackage.legacyShipStationShipmentId);
            let processed = processedLabels.get(providerLabelId);
            if (!processed) {
              let hardError: string | null = null;
              let trackingWarning: string | null = null;
              try {
                const observation =
                  await dependencies.carrierTracking.observeShipStationLabel(
                    buildShipStationRecoveredLabelObservation(physicalPackage),
                  );
                labelsObserved += 1;
                if (observation.labelInserted) labelsInserted += 1;

                const links = await dependencies.carrierTracking
                  .reconcileShipStationLabel(providerLabelId);
                labelLinksInserted += links.linksInserted;
                if (links.totalLinks === 0) {
                  throw new Error(
                    `Recovered provider label ${providerLabelId} did not link to any authorized shipment`,
                  );
                }

                if (!physicalPackage.carrierCode) {
                  trackingWarning =
                    `Provider label ${providerLabelId} has no carrier code; tracking hydration was deferred`;
                } else {
                  try {
                    const hydration = await dependencies.carrierTracking
                      .hydrateShipStationTrackingIdentity({
                        carrierCode: physicalPackage.carrierCode,
                        trackingNumber: physicalPackage.trackingNumber,
                      });
                    trackingSnapshotsHydrated += 1;
                    if (hydration.dispatchCommandInserted) {
                      dispatchCommandsCreated += 1;
                    }
                  } catch (error) {
                    trackingWarning =
                      `Provider label ${providerLabelId} tracking hydration failed: ${
                        error instanceof Error ? error.message : String(error)
                      }`;
                  }
                }
              } catch (error) {
                hardError = error instanceof Error ? error.message : String(error);
              }
              processed = { error: hardError, trackingWarning };
              processedLabels.set(providerLabelId, processed);
            }
            if (processed.error) candidateErrors.push(processed.error);
            if (processed.trackingWarning) {
              candidateTrackingWarnings.push(processed.trackingWarning);
            }
          }

          errors += candidateErrors.length;
          trackingWarnings += candidateTrackingWarnings.length;
          results.push({
            candidate,
            matchedPackages: authorizedPackages,
            outcome: candidateErrors.length === authorizedPackages.length
              ? "error"
              : "recovered",
            error: candidateErrors.length > 0
              ? [...new Set(candidateErrors)].join("; ")
              : null,
            trackingWarnings: [...new Set(candidateTrackingWarnings)],
          });
        } catch (error) {
          errors += 1;
          results.push({
            candidate,
            matchedPackages: [],
            outcome: "error",
            error: error instanceof Error ? error.message : String(error),
            trackingWarnings: [],
          });
        }
      }

      return {
        mode,
        candidates: candidates.length,
        matchedPackages,
        labelsObserved,
        labelsInserted,
        labelLinksInserted,
        trackingSnapshotsHydrated,
        dispatchCommandsCreated,
        trackingWarnings,
        noMatch,
        errors,
        results,
      };
    },
  };
}

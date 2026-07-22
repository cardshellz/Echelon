import { sql } from "drizzle-orm";
import type {
  ShipStationCompletedPhysicalPackage,
  ShipStationPhysicalRecoveryClient,
} from "../shipping/shipstation-physical-recovery.client";
import { enqueueShipStationRetry } from "./webhook-retry.worker";

const SHIPSTATION_V1_SHIPMENT_RESOURCE = "https://ssapi.shipstation.com/shipments";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 500;
const DEFAULT_MIN_AGE_HOURS = 6;

export type ShipStationPhysicalRecoveryMode = "dry-run" | "execute";

export interface ShipStationPhysicalRecoveryOptions {
  mode?: ShipStationPhysicalRecoveryMode;
  limit?: number | null;
  minAgeHours?: number;
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
  oldestShipmentCreatedAt: Date | string;
}

export interface ShipStationPhysicalRecoveryCandidateResult {
  candidate: ShipStationPhysicalRecoveryCandidate;
  matchedPackages: ShipStationCompletedPhysicalPackage[];
  outcome: "planned" | "enqueued" | "no_match" | "client_not_configured" | "error";
  error: string | null;
}

export interface ShipStationPhysicalRecoveryRunResult {
  mode: ShipStationPhysicalRecoveryMode;
  candidates: number;
  matchedPackages: number;
  enqueueRequests: number;
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
  enqueueRetry?: (dbArg: any, payload: { resource_url: string }) => Promise<void>;
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
  return {
    wmsOrderId: requiredPositiveInteger(row.wms_order_id, "wms_order_id"),
    omsOrderId: requiredPositiveInteger(row.oms_order_id, "oms_order_id"),
    orderNumber: requiredString(row.order_number, "order_number"),
    provider,
    wmsShipmentIds: parsePgIntegerArray(row.wms_shipment_ids, "wms_shipment_ids"),
    wmsShipmentItemIds: parsePgIntegerArray(
      row.wms_shipment_item_ids,
      "wms_shipment_item_ids",
    ),
    oldestShipmentCreatedAt,
  };
}

export async function findShipStationPhysicalRecoveryCandidates(
  dbArg: any,
  options: ShipStationPhysicalRecoveryOptions = {},
): Promise<ShipStationPhysicalRecoveryCandidate[]> {
  const minAgeHours = positiveInteger(
    options.minAgeHours,
    DEFAULT_MIN_AGE_HOURS,
    24 * 30,
    "minAgeHours",
  );
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
    WITH eligible_shipments AS (
      SELECT
        os.id,
        os.order_id,
        os.created_at
      FROM wms.outbound_shipments AS os
      JOIN wms.outbound_shipment_items AS osi ON osi.shipment_id = os.id
      JOIN wms.order_items AS oi ON oi.id = osi.order_item_id
      WHERE os.status IN ('planned', 'queued', 'labeled')
        AND os.shipped_at IS NULL
        AND NULLIF(BTRIM(COALESCE(os.tracking_number, '')), '') IS NULL
        AND COALESCE(os.held, false) = false
        AND COALESCE(os.shipment_purpose, 'customer_fulfillment') = 'customer_fulfillment'
        AND os.created_at < NOW() - (${minAgeHours} * INTERVAL '1 hour')
        AND COALESCE(osi.qty, 0) > 0
        AND COALESCE(oi.requires_shipping, 1) <> 0
      GROUP BY os.id, os.order_id, os.created_at
      HAVING BOOL_AND(
        COALESCE(oi.picked_quantity, 0) >= COALESCE(osi.qty, 0)
        AND oi.status = 'completed'
        AND COALESCE(oi.on_hold, false) = false
      )
    )
    SELECT
      wo.id AS wms_order_id,
      oo.id AS oms_order_id,
      wo.order_number,
      channel.provider,
      ARRAY_AGG(DISTINCT eligible.id ORDER BY eligible.id)::int[] AS wms_shipment_ids,
      ARRAY_AGG(DISTINCT osi.id ORDER BY osi.id)::int[] AS wms_shipment_item_ids,
      MIN(eligible.created_at) AS oldest_shipment_created_at
    FROM eligible_shipments AS eligible
    JOIN wms.orders AS wo ON wo.id = eligible.order_id
    JOIN oms.oms_orders AS oo
      ON (
           (wo.source IN ('oms', 'ebay') AND wo.oms_fulfillment_order_id = oo.id::text)
        OR (wo.source_table_id = oo.id::text)
    )
    JOIN channels.channels AS channel ON channel.id = oo.channel_id
    JOIN wms.outbound_shipment_items AS osi ON osi.shipment_id = eligible.id
    WHERE channel.provider IN ('shopify', 'ebay')
      AND oo.status NOT IN ('cancelled', 'refunded')
      AND COALESCE(oo.fulfillment_status, '') <> 'fulfilled'
      AND wo.cancelled_at IS NULL
      AND wo.warehouse_status NOT IN ('cancelled', 'shipped')
      ${maxAgeSql}
      ${orderSql}
    GROUP BY wo.id, oo.id, wo.order_number, channel.provider
    ORDER BY MIN(eligible.created_at), wo.id
    ${limitSql}
  `);

  return (result?.rows ?? []).map((row: Record<string, unknown>) => normalizeCandidate(row));
}

function packageBelongsToCandidate(
  physicalPackage: ShipStationCompletedPhysicalPackage,
  candidateItemIds: Set<number>,
): boolean {
  return physicalPackage.wmsShipmentItemIds.some((itemId) => candidateItemIds.has(itemId));
}

function shipNotifyResourceUrl(legacyShipStationShipmentId: number): string {
  const query = new URLSearchParams({
    shipmentId: String(legacyShipStationShipmentId),
    includeShipmentItems: "false",
  });
  return `${SHIPSTATION_V1_SHIPMENT_RESOURCE}?${query.toString()}`;
}

export function createShipStationPhysicalRecoveryService(
  dbArg: any,
  dependencies: ShipStationPhysicalRecoveryDependencies,
): ShipStationPhysicalRecoveryService {
  const enqueueRetry = dependencies.enqueueRetry ?? enqueueShipStationRetry;

  return {
    async recover(options = {}) {
      const mode = options.mode ?? "dry-run";
      if (mode !== "dry-run" && mode !== "execute") {
        throw new Error(`Unsupported recovery mode: ${String(mode)}`);
      }
      const candidates = await findShipStationPhysicalRecoveryCandidates(dbArg, options);
      const results: ShipStationPhysicalRecoveryCandidateResult[] = [];
      let matchedPackages = 0;
      let enqueueRequests = 0;
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
          });
          continue;
        }

        try {
          const expectedItemIds = new Set(candidate.wmsShipmentItemIds);
          const providerPackages = await dependencies.client.listCompletedPackagesForOrder(
            candidate.orderNumber,
          );
          const authorizedPackages = providerPackages.filter((physicalPackage) =>
            packageBelongsToCandidate(physicalPackage, expectedItemIds)
          );
          if (authorizedPackages.length === 0) {
            noMatch += 1;
            results.push({
              candidate,
              matchedPackages: [],
              outcome: "no_match",
              error: null,
            });
            continue;
          }

          matchedPackages += authorizedPackages.length;
          if (mode === "execute") {
            for (const physicalPackage of authorizedPackages) {
              await enqueueRetry(dbArg, {
                resource_url: shipNotifyResourceUrl(
                  physicalPackage.legacyShipStationShipmentId,
                ),
              });
              enqueueRequests += 1;
            }
          }
          results.push({
            candidate,
            matchedPackages: authorizedPackages,
            outcome: mode === "execute" ? "enqueued" : "planned",
            error: null,
          });
        } catch (error) {
          errors += 1;
          results.push({
            candidate,
            matchedPackages: [],
            outcome: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return {
        mode,
        candidates: candidates.length,
        matchedPackages,
        enqueueRequests,
        noMatch,
        errors,
        results,
      };
    },
  };
}

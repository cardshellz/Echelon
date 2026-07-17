import { sql } from "drizzle-orm";

import { db } from "../../db";
import { SHIPSTATION_UNMAPPED_PHYSICAL_RULE } from "./shipstation-unmapped-physical";

const DEFAULT_RECOVERY_LIMIT = 250;
const MAX_RECOVERY_LIMIT = 1_000;
const DEFAULT_RESOLVED_BY = "system:ship_notify_reconciliation";
const RECOVERY_RESOLUTION =
  "The provider physical shipment is now linked to WMS; the earlier SHIP_NOTIFY no-match condition recovered.";
const VOIDED_SHIPMENT_RESOLUTION =
  "ShipStation voided this label before fulfillment. No replacement shipment or inventory movement occurred.";

interface QueryExecutor {
  execute: (query: unknown) => Promise<{ rows?: unknown[] }>;
}

export interface ShipNotifyExceptionRecoveryOptions {
  externalShipmentRef?: string | number | null;
  limit?: number;
  now?: Date;
  resolvedBy?: string;
}

export interface RecoveredShipNotifyException {
  exceptionId: number;
  wmsOrderId: number;
  wmsShipmentId: number | null;
  externalShipmentRef: string;
}

export interface ShipNotifyExceptionRecoveryResult {
  resolvedCount: number;
  recovered: RecoveredShipNotifyException[];
}

export interface VoidedShipStationShipmentEvidence {
  shipmentId: number;
  voidDate: string;
}

export interface ShipStationShipmentLookup {
  getShipmentById: (shipmentId: number) => Promise<{
    shipmentId: number;
    voidDate: string | null;
  } | null>;
}

export interface VoidedUnmappedExceptionResolution {
  exceptionId: number;
  externalShipmentRef: string;
  providerVoidDate: string;
}

export interface VoidedUnmappedExceptionSweepResult {
  checkedCount: number;
  resolvedCount: number;
  resolved: VoidedUnmappedExceptionResolution[];
  failures: Array<{ exceptionId: number; message: string }>;
}

function positiveInteger(value: unknown, field: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${field} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

function externalShipmentRef(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  const numeric = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new Error("externalShipmentRef must be a positive numeric ShipStation shipment id");
  }
  return normalized;
}

function validTimestamp(value: Date | undefined): Date {
  const timestamp = value ?? new Date();
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("now must be a valid Date");
  }
  return timestamp;
}

function resolvedByActor(value: string | undefined): string {
  const normalized = (value ?? DEFAULT_RESOLVED_BY).trim();
  if (!normalized || normalized.length > 120) {
    throw new Error("resolvedBy must contain between 1 and 120 characters");
  }
  return normalized;
}

function providerVoidDate(value: unknown): { raw: string; date: Date } {
  const raw = String(value ?? "").trim();
  const date = new Date(raw);
  if (!raw || Number.isNaN(date.getTime())) {
    throw new Error("voidDate must be a valid ShipStation void timestamp");
  }
  return { raw, date };
}

function rows(result: { rows?: unknown[] }): Record<string, unknown>[] {
  return Array.isArray(result.rows)
    ? result.rows.filter((row): row is Record<string, unknown> => row !== null && typeof row === "object")
    : [];
}

/**
 * Resolve historical SHIP_NOTIFY no-match exceptions only after the exact
 * provider physical shipment id is linked to a legacy or canonical WMS
 * shipment. Order ids, order keys, and tracking numbers are deliberately not
 * sufficient proof because they are reused by split and replacement packages.
 */
export async function resolveRecoveredShipNotifyNoMatchExceptions(
  dbArg: QueryExecutor = db as unknown as QueryExecutor,
  options: ShipNotifyExceptionRecoveryOptions = {},
): Promise<ShipNotifyExceptionRecoveryResult> {
  const shipmentRef = externalShipmentRef(options.externalShipmentRef);
  const limit = positiveInteger(
    options.limit ?? DEFAULT_RECOVERY_LIMIT,
    "limit",
    MAX_RECOVERY_LIMIT,
  );
  const resolvedAt = validTimestamp(options.now);
  const resolvedBy = resolvedByActor(options.resolvedBy);

  const result = await dbArg.execute(sql`
    WITH candidates AS (
      SELECT
        exception.id,
        exception.external_shipment_ref
      FROM wms.reconciliation_exceptions AS exception
      WHERE exception.rule = 'ship_notify_no_match'
        AND exception.external_system = 'shipstation'
        AND exception.status IN ('open', 'acknowledged')
        AND NULLIF(BTRIM(exception.external_shipment_ref), '') IS NOT NULL
        AND (${shipmentRef}::text IS NULL OR exception.external_shipment_ref = ${shipmentRef}::text)
      ORDER BY exception.first_seen_at, exception.id
      LIMIT ${limit}
    ),
    legacy_matches AS (
      SELECT
        candidate.id AS exception_id,
        shipment.order_id AS wms_order_id,
        shipment.id AS wms_shipment_id,
        candidate.external_shipment_ref,
        1 AS match_priority
      FROM candidates AS candidate
      JOIN wms.outbound_shipments AS shipment
        ON shipment.external_fulfillment_id =
          'shipstation_shipment:' || candidate.external_shipment_ref
    ),
    canonical_matches AS (
      SELECT
        candidate.id AS exception_id,
        request.wms_order_id,
        request.legacy_wms_shipment_id AS wms_shipment_id,
        candidate.external_shipment_ref,
        2 AS match_priority
      FROM candidates AS candidate
      JOIN wms.physical_shipments AS physical_shipment
        ON physical_shipment.provider = 'shipstation'
       AND physical_shipment.provider_physical_shipment_id IN (
         candidate.external_shipment_ref,
         'shipstation_shipment:' || candidate.external_shipment_ref
       )
      JOIN wms.shipment_requests AS request
        ON request.id = physical_shipment.shipment_request_id
    ),
    ranked_matches AS (
      SELECT DISTINCT ON (match.exception_id)
        match.exception_id,
        match.wms_order_id,
        match.wms_shipment_id,
        match.external_shipment_ref
      FROM (
        SELECT * FROM legacy_matches
        UNION ALL
        SELECT * FROM canonical_matches
      ) AS match
      WHERE match.wms_order_id IS NOT NULL
      ORDER BY
        match.exception_id,
        match.match_priority,
        match.wms_shipment_id DESC NULLS LAST
    )
    UPDATE wms.reconciliation_exceptions AS exception
    SET status = 'resolved',
        wms_order_id = COALESCE(exception.wms_order_id, match.wms_order_id),
        wms_shipment_id = COALESCE(exception.wms_shipment_id, match.wms_shipment_id),
        resolved_at = ${resolvedAt}::timestamptz,
        resolved_by = ${resolvedBy},
        resolution = ${RECOVERY_RESOLUTION},
        details = exception.details || jsonb_build_object(
          'autoResolvedReason', 'provider_physical_shipment_linked',
          'autoResolvedAt', ${resolvedAt}::timestamptz,
          'resolvedWmsOrderId', match.wms_order_id,
          'resolvedWmsShipmentId', match.wms_shipment_id
        ),
        updated_at = ${resolvedAt}::timestamptz
    FROM ranked_matches AS match
    WHERE exception.id = match.exception_id
      AND exception.status IN ('open', 'acknowledged')
      AND (
        exception.wms_order_id IS NULL
        OR exception.wms_order_id = match.wms_order_id
      )
      AND (
        exception.wms_shipment_id IS NULL
        OR exception.wms_shipment_id = match.wms_shipment_id
      )
    RETURNING
      exception.id AS exception_id,
      exception.wms_order_id,
      exception.wms_shipment_id,
      exception.external_shipment_ref
  `);

  const recovered = rows(result).map((row) => ({
    exceptionId: positiveInteger(row.exception_id, "exception_id", Number.MAX_SAFE_INTEGER),
    wmsOrderId: positiveInteger(row.wms_order_id, "wms_order_id", Number.MAX_SAFE_INTEGER),
    wmsShipmentId: row.wms_shipment_id == null
      ? null
      : positiveInteger(row.wms_shipment_id, "wms_shipment_id", Number.MAX_SAFE_INTEGER),
    externalShipmentRef: String(row.external_shipment_ref),
  }));

  return {
    resolvedCount: recovered.length,
    recovered,
  };
}

/**
 * Resolve one exact unmapped-physical exception from positive provider proof
 * that the label was voided. This never creates shipment or inventory state.
 */
export async function resolveVoidedShipStationUnmappedPhysicalException(
  dbArg: QueryExecutor,
  evidence: VoidedShipStationShipmentEvidence,
  options: Pick<ShipNotifyExceptionRecoveryOptions, "now" | "resolvedBy"> = {},
): Promise<VoidedUnmappedExceptionResolution | null> {
  const shipmentRef = externalShipmentRef(evidence.shipmentId);
  if (shipmentRef === null) {
    throw new Error("shipmentId must be a positive ShipStation shipment id");
  }
  const voided = providerVoidDate(evidence.voidDate);
  const resolvedAt = validTimestamp(options.now);
  const resolvedBy = resolvedByActor(
    options.resolvedBy ?? "system:shipstation_void_reconciliation",
  );

  const result = await dbArg.execute(sql`
    UPDATE wms.reconciliation_exceptions AS exception
    SET classification = 'safe_auto_repair',
        status = 'resolved',
        severity = 'info',
        resolved_at = ${resolvedAt}::timestamptz,
        resolved_by = ${resolvedBy},
        resolution = ${VOIDED_SHIPMENT_RESOLUTION},
        details = exception.details || jsonb_build_object(
          'autoResolvedReason', 'provider_physical_shipment_voided',
          'autoResolvedAt', ${resolvedAt}::timestamptz,
          'providerVoidDate', ${voided.date}::timestamptz
        ),
        updated_at = ${resolvedAt}::timestamptz
    WHERE exception.rule = ${SHIPSTATION_UNMAPPED_PHYSICAL_RULE}
      AND exception.external_system = 'shipstation'
      AND exception.external_shipment_ref = ${shipmentRef}
      AND exception.status IN ('open', 'acknowledged')
    RETURNING exception.id AS exception_id,
              exception.external_shipment_ref
  `);
  const row = rows(result)[0];
  if (!row) return null;
  return {
    exceptionId: positiveInteger(row.exception_id, "exception_id", Number.MAX_SAFE_INTEGER),
    externalShipmentRef: String(row.external_shipment_ref),
    providerVoidDate: voided.raw,
  };
}

/**
 * Re-check unresolved extra-package exceptions by exact ShipStation shipment
 * id. Missing or still-active provider records remain open for review.
 */
export async function resolveVoidedShipStationUnmappedPhysicalExceptions(
  dbArg: QueryExecutor,
  shipStation: ShipStationShipmentLookup,
  options: Pick<ShipNotifyExceptionRecoveryOptions, "limit" | "now" | "resolvedBy"> = {},
): Promise<VoidedUnmappedExceptionSweepResult> {
  const limit = positiveInteger(
    options.limit ?? 100,
    "limit",
    MAX_RECOVERY_LIMIT,
  );
  const candidateResult = await dbArg.execute(sql`
    SELECT exception.id AS exception_id,
           exception.external_shipment_ref
    FROM wms.reconciliation_exceptions AS exception
    WHERE exception.rule = ${SHIPSTATION_UNMAPPED_PHYSICAL_RULE}
      AND exception.external_system = 'shipstation'
      AND exception.status IN ('open', 'acknowledged')
      AND exception.external_shipment_ref ~ '^[1-9][0-9]*$'
    ORDER BY exception.first_seen_at, exception.id
    LIMIT ${limit}
  `);

  const candidates = rows(candidateResult);
  const resolved: VoidedUnmappedExceptionResolution[] = [];
  const failures: Array<{ exceptionId: number; message: string }> = [];
  for (const candidate of candidates) {
    const exceptionId = positiveInteger(
      candidate.exception_id,
      "exception_id",
      Number.MAX_SAFE_INTEGER,
    );
    try {
      const shipmentId = positiveInteger(
        candidate.external_shipment_ref,
        "external_shipment_ref",
        Number.MAX_SAFE_INTEGER,
      );
      const providerShipment = await shipStation.getShipmentById(shipmentId);
      if (!providerShipment?.voidDate || providerShipment.shipmentId !== shipmentId) {
        continue;
      }
      const resolution = await resolveVoidedShipStationUnmappedPhysicalException(
        dbArg,
        { shipmentId, voidDate: providerShipment.voidDate },
        options,
      );
      if (resolution) resolved.push(resolution);
    } catch (error: any) {
      failures.push({
        exceptionId,
        message: error?.message ?? String(error),
      });
    }
  }

  return {
    checkedCount: candidates.length,
    resolvedCount: resolved.length,
    resolved,
    failures,
  };
}

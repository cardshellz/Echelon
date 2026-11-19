/**
 * Shipment-Status Core (P1.1) — canonical transition matrix and CAS state
 * machine for `wms.outbound_shipments.status`.
 *
 * Rules:
 *   1. Physical dispatch (`shipped`, `returned`, `lost`, or non-null `shipped_at`
 *      on a cancellation path) is immutable against cancellation.
 *   2. `cancelled` is terminal for non-shipped transitions; `cancelled → shipped`
 *      is allowed only when carrier/provider physical dispatch is proven ("truth wins").
 *   3. `voided` represents a voided label (still open for re-queue / re-label /
 *      re-ship), allowed from `planned`, `queued`, `labeled`, or `shipped`
 *      (when the label of record is voided before carrier handoff), never from
 *      `cancelled`, `returned`, or `lost`.
 *   4. `returned` and `lost` require prior `shipped` state (`returned → lost`
 *      also allowed for post-return carrier loss).
 */

import { sql } from "drizzle-orm";
import {
  SHIPMENT_STATUS_VALUES,
  TERMINAL_SHIPMENT_STATUSES,
  type ShipmentStatus,
} from "@shared/enums/order-status";

type SqlExecutor = { execute: (...args: any[]) => any };

// Key = target status, Value = set of statuses permitted to transition TO target.
export const SHIPMENT_STATUS_TRANSITION_MATRIX: Record<
  ShipmentStatus,
  ReadonlySet<ShipmentStatus>
> = {
  planned: new Set(["voided"]),
  queued: new Set(["planned", "queued", "voided"]),
  labeled: new Set(["planned", "queued", "voided"]),
  shipped: new Set([
    "planned",
    "queued",
    "labeled",
    "voided",
    "shipped", // idempotent re-label / carrier mapping update
    "cancelled", // truth wins when physical carrier dispatch is proven
  ]),
  voided: new Set(["planned", "queued", "labeled", "shipped"]),
  cancelled: new Set(["planned", "queued", "labeled", "voided"]),
  returned: new Set(["shipped"]),
  lost: new Set(["shipped", "returned"]),
};

const TERMINAL_SET: ReadonlySet<ShipmentStatus> = new Set(TERMINAL_SHIPMENT_STATUSES);

export function isShipmentTransitionAllowed(
  from: ShipmentStatus,
  to: ShipmentStatus,
): boolean {
  const allowed = SHIPMENT_STATUS_TRANSITION_MATRIX[to];
  if (!allowed) return false;
  return allowed.has(from);
}

export function isTerminalShipmentStatus(status: ShipmentStatus): boolean {
  return TERMINAL_SET.has(status);
}

export function allowedShipmentFromStatuses(to: ShipmentStatus): ShipmentStatus[] {
  const allowed = SHIPMENT_STATUS_TRANSITION_MATRIX[to];
  if (!allowed) return [];
  return SHIPMENT_STATUS_VALUES.filter((s) => allowed.has(s));
}

export interface TransitionShipmentStatusRequest {
  from?: readonly ShipmentStatus[];
  to: ShipmentStatus;
  reason: string;
  now?: Date;
  /** When true (default for `cancelled`), refuses rows that already carry `shipped_at`. */
  requireUnshippedTimestamp?: boolean;
}

export type TransitionShipmentStatusResult =
  | {
      outcome: "transitioned";
      transitioned: true;
      shipmentId: number;
      previousStatus: ShipmentStatus;
      newStatus: ShipmentStatus;
      reason: string;
    }
  | {
      outcome: "already_in_state";
      transitioned: false;
      shipmentId: number;
      currentStatus: ShipmentStatus;
      reason: string;
    }
  | {
      outcome: "blocked_by_state";
      transitioned: false;
      shipmentId: number;
      currentStatus: ShipmentStatus;
      shippedAt: Date | string | null;
      reason: string;
    }
  | {
      outcome: "not_found";
      transitioned: false;
      shipmentId: number;
      reason: string;
    };

/**
 * Atomic compare-and-swap transition on `wms.outbound_shipments.status`.
 * Returns a discriminated verdict (`transitioned | already_in_state | blocked_by_state | not_found`).
 */
export async function transitionShipmentStatus(
  executor: SqlExecutor,
  shipmentId: number,
  request: TransitionShipmentStatusRequest,
): Promise<TransitionShipmentStatusResult> {
  const candidateFrom = request.from ?? allowedShipmentFromStatuses(request.to);
  const legalFrom = candidateFrom.filter((f) => isShipmentTransitionAllowed(f, request.to));
  const now = request.now ?? new Date();
  const requireUnshipped =
    request.requireUnshippedTimestamp ?? (request.to === "cancelled" || request.to === "planned" || request.to === "queued");

  if (legalFrom.length > 0) {
    const fromListSql = sql.join(
      legalFrom.map((s) => sql`${s}::wms.shipment_status`),
      sql`, `,
    );
    const updateRes: any = await executor.execute(sql`
      WITH prior AS (
        SELECT id, status, shipped_at
        FROM wms.outbound_shipments
        WHERE id = ${shipmentId}
          AND status IN (${fromListSql})
          ${requireUnshipped ? sql`AND shipped_at IS NULL` : sql``}
        FOR UPDATE
      )
      UPDATE wms.outbound_shipments AS os
      SET status = ${request.to}::wms.shipment_status,
          updated_at = ${now}
          ${request.to === "cancelled" ? sql`, cancelled_at = COALESCE(os.cancelled_at, ${now}), voided_reason = COALESCE(os.voided_reason, ${request.reason})` : sql``}
          ${request.to === "voided" ? sql`, voided_at = COALESCE(os.voided_at, ${now}), voided_reason = COALESCE(os.voided_reason, ${request.reason})` : sql``}
          ${request.to === "lost" ? sql`, lost_at = COALESCE(os.lost_at, ${now}), lost_reason = COALESCE(os.lost_reason, ${request.reason})` : sql``}
      FROM prior
      WHERE os.id = prior.id
      RETURNING prior.status AS previous_status, os.status AS new_status
    `);

    const updated = updateRes?.rows?.[0];
    if (updated) {
      return {
        outcome: "transitioned",
        transitioned: true,
        shipmentId,
        previousStatus: updated.previous_status as ShipmentStatus,
        newStatus: updated.new_status as ShipmentStatus,
        reason: request.reason,
      };
    }
  }

  const currentRes: any = await executor.execute(sql`
    SELECT status, shipped_at
    FROM wms.outbound_shipments
    WHERE id = ${shipmentId}
    LIMIT 1
  `);
  const row = currentRes?.rows?.[0];
  if (!row) {
    return {
      outcome: "not_found",
      transitioned: false,
      shipmentId,
      reason: `shipment ${shipmentId} not found`,
    };
  }

  const currentStatus = row.status as ShipmentStatus;
  if (currentStatus === request.to && (!requireUnshipped || row.shipped_at == null)) {
    return {
      outcome: "already_in_state",
      transitioned: false,
      shipmentId,
      currentStatus,
      reason: `shipment ${shipmentId} is already in '${currentStatus}'`,
    };
  }

  return {
    outcome: "blocked_by_state",
    transitioned: false,
    shipmentId,
    currentStatus,
    shippedAt: row.shipped_at ?? null,
    reason:
      requireUnshipped && row.shipped_at != null
        ? `shipment ${shipmentId} carries shipped_at (${String(row.shipped_at)}); cannot transition to '${request.to}'`
        : `illegal shipment transition '${currentStatus}' -> '${request.to}'`,
  };
}

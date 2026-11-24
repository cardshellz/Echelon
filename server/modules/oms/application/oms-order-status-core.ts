/**
 * OMS Order-Status Core (P1.2) — canonical transition matrix, driver contract,
 * CAS state machine (`transitionOmsOrderStatus`), and shipment-outcome recorder
 * (`recordShipmentOutcome`) for `oms.oms_orders.status`.
 *
 * Rules:
 *   1. Physical dispatch (`partially_shipped`, `shipped`, `delivered`, or a
 *      non-null `shipped_at` timestamp) is immutable against cancellation:
 *      late channel cancels, poll updates, or cancel reconcilers must NEVER
 *      regress a dispatched OMS order back to `cancelled`.
 *   2. `cancelled` and `refunded` are terminal against fulfillment promotion
 *      (`shipped` / `partially_shipped` / `confirmed` / `processing`).
 *   3. `delivered` is terminal against backward regression to `shipped` or
 *      `cancelled` (`delivered → refunded` remains allowed on full post-delivery
 *      refund disposition).
 *   4. Every transition declares (or defaults) its authority driver
 *      (`channel | engine | reconciler | operator`); `engine` may never cancel
 *      or refund an OMS order.
 */

import { sql } from "drizzle-orm";

type SqlExecutor = { execute: (...args: any[]) => any };

export const OMS_ORDER_LIFECYCLE_STATUS_VALUES = [
  "pending",
  "confirmed",
  "paid",
  "processing",
  "partially_shipped",
  "shipped",
  "delivered",
  "cancelled",
  "refunded",
] as const;

export type OmsOrderLifecycleStatus = (typeof OMS_ORDER_LIFECYCLE_STATUS_VALUES)[number];

export const TERMINAL_OMS_ORDER_STATUSES = [
  "cancelled",
  "refunded",
  "delivered",
] as const satisfies readonly OmsOrderLifecycleStatus[];

export const NON_CANCELLABLE_OMS_ORDER_STATUSES = [
  "partially_shipped",
  "shipped",
  "delivered",
  "refunded",
] as const satisfies readonly OmsOrderLifecycleStatus[];

export const OMS_TRANSITION_DRIVERS = [
  "channel",
  "engine",
  "reconciler",
  "operator",
] as const;

export type OmsTransitionDriver = (typeof OMS_TRANSITION_DRIVERS)[number];

// Key = target status, Value = set of statuses permitted to transition TO target.
export const OMS_ORDER_STATUS_TRANSITION_MATRIX: Record<
  OmsOrderLifecycleStatus,
  ReadonlySet<OmsOrderLifecycleStatus>
> = {
  pending: new Set<OmsOrderLifecycleStatus>([]),
  confirmed: new Set<OmsOrderLifecycleStatus>(["pending", "confirmed", "paid"]),
  paid: new Set<OmsOrderLifecycleStatus>(["pending", "confirmed", "paid"]),
  processing: new Set<OmsOrderLifecycleStatus>([
    "pending",
    "confirmed",
    "paid",
    "processing",
  ]),
  partially_shipped: new Set<OmsOrderLifecycleStatus>([
    "pending",
    "confirmed",
    "paid",
    "processing",
    "partially_shipped",
  ]),
  shipped: new Set<OmsOrderLifecycleStatus>([
    "pending",
    "confirmed",
    "paid",
    "processing",
    "partially_shipped",
    "shipped",
  ]),
  delivered: new Set<OmsOrderLifecycleStatus>([
    "partially_shipped",
    "shipped",
    "delivered",
  ]),
  cancelled: new Set<OmsOrderLifecycleStatus>([
    "pending",
    "confirmed",
    "paid",
    "processing",
  ]),
  refunded: new Set<OmsOrderLifecycleStatus>([
    "pending",
    "confirmed",
    "paid",
    "processing",
    "partially_shipped",
    "shipped",
    "delivered",
    "cancelled",
  ]),
};

export const OMS_DRIVER_ALLOWED_TARGETS: Record<
  OmsTransitionDriver,
  ReadonlySet<OmsOrderLifecycleStatus>
> = {
  channel: new Set<OmsOrderLifecycleStatus>([
    "confirmed",
    "paid",
    "processing",
    "partially_shipped",
    "shipped",
    "delivered",
    "cancelled",
    "refunded",
  ]),
  engine: new Set<OmsOrderLifecycleStatus>([
    "processing",
    "partially_shipped",
    "shipped",
    "delivered",
  ]),
  reconciler: new Set<OmsOrderLifecycleStatus>([
    "confirmed",
    "processing",
    "partially_shipped",
    "shipped",
    "delivered",
    "cancelled",
  ]),
  operator: new Set<OmsOrderLifecycleStatus>([
    "confirmed",
    "processing",
    "cancelled",
    "refunded",
  ]),
};

const TERMINAL_SET: ReadonlySet<string> = new Set(TERMINAL_OMS_ORDER_STATUSES);
const NON_CANCELLABLE_SET: ReadonlySet<string> = new Set(NON_CANCELLABLE_OMS_ORDER_STATUSES);

export function isTerminalOmsOrderStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && TERMINAL_SET.has(status);
}

export function isNonCancellableOmsOrderStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && NON_CANCELLABLE_SET.has(status);
}

export function isOmsOrderTransitionAllowed(
  from: string,
  to: OmsOrderLifecycleStatus,
  driver?: OmsTransitionDriver,
): boolean {
  if (driver && !OMS_DRIVER_ALLOWED_TARGETS[driver]?.has(to)) {
    return false;
  }
  const allowed = OMS_ORDER_STATUS_TRANSITION_MATRIX[to];
  if (!allowed) return false;
  return allowed.has(from as OmsOrderLifecycleStatus);
}

export function allowedOmsOrderFromStatuses(
  to: OmsOrderLifecycleStatus,
  driver?: OmsTransitionDriver,
): OmsOrderLifecycleStatus[] {
  if (driver && !OMS_DRIVER_ALLOWED_TARGETS[driver]?.has(to)) {
    return [];
  }
  const allowed = OMS_ORDER_STATUS_TRANSITION_MATRIX[to];
  if (!allowed) return [];
  return OMS_ORDER_LIFECYCLE_STATUS_VALUES.filter((s) => allowed.has(s));
}

export interface TransitionOmsOrderStatusRequest {
  from?: readonly OmsOrderLifecycleStatus[];
  to: OmsOrderLifecycleStatus;
  driver?: OmsTransitionDriver;
  reason: string;
  financialStatus?: string | null;
  fulfillmentStatus?: string | null;
  cancelledAt?: Date;
  now?: Date;
  /** Defaults to true when transitioning to `cancelled`. */
  requireUnshippedTimestamp?: boolean;
  /** Optional atomic audit event appended to `oms.oms_order_events` on transition. */
  event?: {
    eventType: string;
    details?: Record<string, unknown>;
  };
}

export type TransitionOmsOrderStatusResult =
  | {
      outcome: "transitioned";
      transitioned: true;
      omsOrderId: number;
      previousStatus: string;
      newStatus: OmsOrderLifecycleStatus;
      financialStatus: string | null;
      reason: string;
    }
  | {
      outcome: "already_in_state";
      transitioned: false;
      omsOrderId: number;
      currentStatus: string;
      financialStatus: string | null;
      reason: string;
    }
  | {
      outcome: "blocked_by_state";
      transitioned: false;
      omsOrderId: number;
      currentStatus: string;
      financialStatus: string | null;
      shippedAt: Date | string | null;
      reason: string;
    }
  | {
      outcome: "not_found";
      transitioned: false;
      omsOrderId: number;
      reason: string;
    };

/**
 * Atomic compare-and-swap transition on `oms.oms_orders.status`.
 * Returns a discriminated verdict (`transitioned | already_in_state | blocked_by_state | not_found`).
 */
export async function transitionOmsOrderStatus(
  executor: SqlExecutor,
  omsOrderId: number,
  request: TransitionOmsOrderStatusRequest,
): Promise<TransitionOmsOrderStatusResult> {
  const driverAllowed = !request.driver || OMS_DRIVER_ALLOWED_TARGETS[request.driver]?.has(request.to);
  const candidateFrom = request.from ?? allowedOmsOrderFromStatuses(request.to, request.driver);
  const legalFrom = driverAllowed
    ? candidateFrom.filter(
        (f) => f !== request.to && isOmsOrderTransitionAllowed(f, request.to, request.driver),
      )
    : [];
  const now = request.now ?? new Date();
  const requireUnshipped = request.requireUnshippedTimestamp ?? request.to === "cancelled";

  if (legalFrom.length > 0) {
    const fromListSql = sql.join(
      legalFrom.map((s) => sql`${s}`),
      sql`, `,
    );
    const cancelledAtValue = request.cancelledAt ?? now;
    const updateRes: any = await executor.execute(sql`
      WITH prior AS (
        SELECT id, status, financial_status, shipped_at
        FROM oms.oms_orders
        WHERE id = ${omsOrderId}
          AND status IN (${fromListSql})
          ${requireUnshipped ? sql`AND shipped_at IS NULL` : sql``}
        FOR UPDATE
      )
      UPDATE oms.oms_orders AS oo
      SET status = ${request.to},
          updated_at = ${now}
          ${request.to === "cancelled" ? sql`, cancelled_at = COALESCE(oo.cancelled_at, ${cancelledAtValue})` : sql``}
          ${request.financialStatus !== undefined && request.financialStatus !== null ? sql`, financial_status = ${request.financialStatus}` : sql``}
          ${request.fulfillmentStatus !== undefined && request.fulfillmentStatus !== null ? sql`, fulfillment_status = ${request.fulfillmentStatus}` : sql``}
      FROM prior
      WHERE oo.id = prior.id
      RETURNING prior.status AS previous_status, oo.status AS new_status, oo.financial_status
    `);

    const updated = updateRes?.rows?.[0];
    if (updated) {
      if (request.event) {
        const eventDetails = {
          previousStatus: updated.previous_status,
          newStatus: updated.new_status,
          driver: request.driver ?? null,
          reason: request.reason,
          ...(request.event.details ?? {}),
        };
        await executor.execute(sql`
          INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
          VALUES (${omsOrderId}, ${request.event.eventType}, ${JSON.stringify(eventDetails)}::jsonb, ${now})
        `);
      }

      return {
        outcome: "transitioned",
        transitioned: true,
        omsOrderId,
        previousStatus: String(updated.previous_status),
        newStatus: updated.new_status as OmsOrderLifecycleStatus,
        financialStatus: updated.financial_status ?? null,
        reason: request.reason,
      };
    }
  }

  const currentRes: any = await executor.execute(sql`
    SELECT status, financial_status, shipped_at
    FROM oms.oms_orders
    WHERE id = ${omsOrderId}
    LIMIT 1
  `);
  const row = currentRes?.rows?.[0];
  if (!row) {
    return {
      outcome: "not_found",
      transitioned: false,
      omsOrderId,
      reason: `OMS order ${omsOrderId} not found`,
    };
  }

  const currentStatus = String(row.status);
  if (
    driverAllowed &&
    currentStatus === request.to &&
    (!requireUnshipped || row.shipped_at == null)
  ) {
    return {
      outcome: "already_in_state",
      transitioned: false,
      omsOrderId,
      currentStatus,
      financialStatus: row.financial_status ?? null,
      reason: `OMS order ${omsOrderId} is already in '${currentStatus}'`,
    };
  }

  const blockedReason = !driverAllowed
    ? `driver '${request.driver}' is not permitted to transition OMS order ${omsOrderId} to '${request.to}'`
    : requireUnshipped && row.shipped_at != null
      ? `OMS order ${omsOrderId} carries shipped_at (${String(row.shipped_at)}); cannot transition to '${request.to}'`
      : `illegal OMS order transition '${currentStatus}' -> '${request.to}'`;

  return {
    outcome: "blocked_by_state",
    transitioned: false,
    omsOrderId,
    currentStatus,
    financialStatus: row.financial_status ?? null,
    shippedAt: row.shipped_at ?? null,
    reason: blockedReason,
  };
}

export interface RecordShipmentOutcomeInput {
  omsOrderId: number;
  status?: "partially_shipped" | "shipped";
  trackingNumber?: string | null;
  carrier?: string | null;
  shippedAt?: Date;
  now?: Date;
  markAllLinesFulfilled?: boolean;
  event?: {
    eventType?: string;
    details?: Record<string, unknown>;
  } | false;
}

export type RecordShipmentOutcomeResult =
  | {
      outcome: "recorded";
      changed: true;
      omsOrderId: number;
      previousStatus: string;
      newStatus: "partially_shipped" | "shipped";
    }
  | {
      outcome: "blocked_by_state";
      changed: false;
      omsOrderId: number;
      currentStatus: string;
      reason: string;
    }
  | {
      outcome: "not_found";
      changed: false;
      omsOrderId: number;
      reason: string;
    };

/**
 * Canonical OMS shipment-outcome chokepoint (`P1.2`).
 * Enforces `engine` driver rules (`cancelled`, `refunded`, and `delivered` are
 * protected against overwrite) while recording tracking, fulfillment status,
 * optional line fulfillment, and an `oms.oms_order_events` audit entry.
 */
export async function recordShipmentOutcome(
  executor: SqlExecutor,
  input: RecordShipmentOutcomeInput,
): Promise<RecordShipmentOutcomeResult> {
  const targetStatus = input.status ?? "shipped";
  const fulfillmentStatus = targetStatus === "shipped" ? "fulfilled" : "partial";
  const legalFrom = allowedOmsOrderFromStatuses(targetStatus, "engine");
  const fromListSql = sql.join(
    legalFrom.map((s) => sql`${s}`),
    sql`, `,
  );
  const now = input.now ?? new Date();
  const shippedAt = input.shippedAt ?? now;

  const updateRes: any = await executor.execute(sql`
    WITH prior AS (
      SELECT id, status
      FROM oms.oms_orders
      WHERE id = ${input.omsOrderId}
        AND status IN (${fromListSql})
      FOR UPDATE
    )
    UPDATE oms.oms_orders AS oo
    SET status = ${targetStatus},
        fulfillment_status = ${fulfillmentStatus},
        tracking_number = COALESCE(${input.trackingNumber ?? null}, oo.tracking_number),
        tracking_carrier = COALESCE(${input.carrier ?? null}, oo.tracking_carrier),
        shipped_at = COALESCE(oo.shipped_at, ${shippedAt}),
        updated_at = ${now}
    FROM prior
    WHERE oo.id = prior.id
    RETURNING prior.status AS previous_status, oo.status AS new_status
  `);

  const updated = updateRes?.rows?.[0];
  if (updated) {
    if (input.markAllLinesFulfilled && targetStatus === "shipped") {
      await executor.execute(sql`
        UPDATE oms.oms_order_lines
        SET fulfillment_status = 'fulfilled',
            updated_at = ${now}
        WHERE order_id = ${input.omsOrderId}
      `);
    }

    if (input.event !== false) {
      const eventType = input.event?.eventType ?? "shipped";
      const details = {
        trackingNumber: input.trackingNumber ?? null,
        carrier: input.carrier ?? null,
        ...(input.event?.details ?? {}),
      };
      await executor.execute(sql`
        INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
        VALUES (${input.omsOrderId}, ${eventType}, ${JSON.stringify(details)}::jsonb, ${now})
      `);
    }

    return {
      outcome: "recorded",
      changed: true,
      omsOrderId: input.omsOrderId,
      previousStatus: String(updated.previous_status),
      newStatus: updated.new_status as "partially_shipped" | "shipped",
    };
  }

  const currentRes: any = await executor.execute(sql`
    SELECT status
    FROM oms.oms_orders
    WHERE id = ${input.omsOrderId}
    LIMIT 1
  `);
  const row = currentRes?.rows?.[0];
  if (!row) {
    return {
      outcome: "not_found",
      changed: false,
      omsOrderId: input.omsOrderId,
      reason: `OMS order ${input.omsOrderId} not found`,
    };
  }

  return {
    outcome: "blocked_by_state",
    changed: false,
    omsOrderId: input.omsOrderId,
    currentStatus: String(row.status),
    reason: `OMS order ${input.omsOrderId} in '${String(row.status)}' cannot record engine shipment outcome '${targetStatus}'`,
  };
}

export const recordShipmentOutcomeInOms = recordShipmentOutcome;

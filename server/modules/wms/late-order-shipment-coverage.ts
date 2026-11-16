import { sql } from "drizzle-orm";
import {
  LATE_ORDER_EDIT_SHIPMENT_SOURCE,
  PROVIDER_MEMBERSHIP_AUTHORITATIVE,
  PROVIDER_MEMBERSHIP_PENDING_APPEND,
  resolveShipmentItemDefaults,
  type DbLike,
  type ProviderMembershipState,
} from "./create-shipment";
import {
  getDefaultSessionAdvisoryLockRunner,
  type SessionAdvisoryLockRunner,
} from "../../infrastructure/session-advisory-lock";
import { WMS_ORDER_SHIPMENT_LOCK_NAMESPACE } from "./shipment-lock-namespaces";

/**
 * Demand growth for an order item that already has a row on a package the
 * shipping engine holds. The row cannot simply be rewritten locally (the
 * engine still has the old quantity) and a second row for the same order item
 * is forbidden by uq_wms_outbound_shipment_items_shipment_order_item, so the
 * caller must hand it to a provider quantity amend.
 */
export interface ShipmentItemQuantityIncrease {
  shipmentItemId: number;
  orderItemId: number;
  fromQuantity: number;
  toQuantity: number;
}

export interface AppendUncoveredShipmentItemsResult {
  shipmentId: number;
  /** Rows inserted, or (planned packages only) rows whose quantity was raised. */
  shipmentItemIds: number[];
  addedQuantity: number;
  /** Existing rows on an engine-held package that need a provider quantity amend. */
  quantityIncreases: ShipmentItemQuantityIncrease[];
}

export interface MovePendingShipmentItemsResult {
  sourceShipmentId: number;
  residualShipmentId: number;
  shipmentItemIds: number[];
  movedQuantity: number;
  alreadyMoved: boolean;
  nextAction: "push" | "amend" | "none";
}

function normalizePositiveIntegerIds(values: readonly number[], field: string): number[] {
  const normalized = Array.from(new Set(values.map((value) => Number(value))))
    .sort((left, right) => left - right);
  if (
    normalized.length === 0 ||
    normalized.some((value) => !Number.isInteger(value) || value <= 0)
  ) {
    throw new Error(`${field} must contain positive integers`);
  }
  return normalized;
}

interface OrderShipmentLockOptions {
  /** True when the caller already runs inside a transaction on `db`. */
  useXactLock: boolean;
  /** Pinned-client session lock runner; defaults to the application pool. */
  sessionLock?: SessionAdvisoryLockRunner;
}

async function withOrderShipmentLock<T>(
  db: DbLike,
  wmsOrderId: number,
  lock: OrderShipmentLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  if (!Number.isInteger(wmsOrderId) || wmsOrderId <= 0) {
    throw new Error(`wmsOrderId must be a positive integer, got ${wmsOrderId}`);
  }
  if (lock.useXactLock) {
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(${WMS_ORDER_SHIPMENT_LOCK_NAMESPACE}, ${wmsOrderId})`,
    );
    return operation();
  }

  // Session path: the lock must live on ONE pinned connection. Issuing
  // pg_advisory_lock through the pooled db handle serialized nothing (see
  // server/infrastructure/session-advisory-lock.ts).
  const sessionLock = lock.sessionLock ?? getDefaultSessionAdvisoryLockRunner();
  return sessionLock(
    {
      namespace: WMS_ORDER_SHIPMENT_LOCK_NAMESPACE,
      key: wmsOrderId,
      label: "wms.late_order_shipment_coverage",
    },
    operation,
  );
}

/**
 * Attach only currently-uncovered WMS demand to one existing package.
 *
 * The order lock makes coverage calculation plus inserts serial for every
 * caller using this ownership API. `pending_append` means the row exists
 * locally but cannot be treated as provider package membership until the
 * shipping adapter verifies it after the remote write.
 */
export async function appendUncoveredItemsToShipment(
  db: DbLike,
  wmsOrderId: number,
  shipmentId: number,
  orderItemIds: readonly number[],
  options: {
    providerMembershipState: ProviderMembershipState;
    useXactLock?: boolean;
    sessionLock?: SessionAdvisoryLockRunner;
  },
): Promise<AppendUncoveredShipmentItemsResult> {
  if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
    throw new Error(`shipmentId must be a positive integer, got ${shipmentId}`);
  }
  const normalizedOrderItemIds = normalizePositiveIntegerIds(
    orderItemIds,
    "orderItemIds",
  );
  if (
    options.providerMembershipState !== PROVIDER_MEMBERSHIP_AUTHORITATIVE &&
    options.providerMembershipState !== PROVIDER_MEMBERSHIP_PENDING_APPEND
  ) {
    throw new Error(
      `unsupported providerMembershipState: ${options.providerMembershipState}`,
    );
  }

  return withOrderShipmentLock(
    db,
    wmsOrderId,
    { useXactLock: options.useXactLock === true, sessionLock: options.sessionLock },
    async () => {
      const target = await db.execute(sql`
        SELECT id, status
        FROM wms.outbound_shipments
        WHERE id = ${shipmentId}
          AND order_id = ${wmsOrderId}
          AND status NOT IN ('voided', 'cancelled')
        FOR UPDATE
      `);
      if ((target.rows?.length ?? 0) !== 1) {
        throw new Error(
          `shipment ${shipmentId} is not an active package for WMS order ${wmsOrderId}`,
        );
      }
      const targetStatus = String((target.rows?.[0] as any)?.status ?? "");

      const itemRowsResult = await db.execute(sql`
        SELECT id, quantity, fulfilled_quantity, product_id
        FROM wms.order_items
        WHERE order_id = ${wmsOrderId}
          AND id = ANY(ARRAY[${sql.join(normalizedOrderItemIds.map((id) => sql`${id}`), sql`, `)}]::int[])
          AND COALESCE(requires_shipping, 1) <> 0
          AND status <> 'cancelled'
        ORDER BY id
        FOR UPDATE
      `);
      const itemRows = itemRowsResult.rows ?? [];
      if (itemRows.length !== normalizedOrderItemIds.length) {
        throw new Error(
          `one or more order items are missing, cancelled, or non-shippable for WMS order ${wmsOrderId}`,
        );
      }

      const coverageResult = await db.execute(sql`
        SELECT
          osi.order_item_id,
          COALESCE(SUM(osi.qty), 0)::int AS covered_qty
        FROM wms.outbound_shipment_items osi
        JOIN wms.outbound_shipments os ON os.id = osi.shipment_id
        WHERE os.order_id = ${wmsOrderId}
          AND os.status NOT IN ('voided', 'cancelled')
          AND osi.order_item_id = ANY(ARRAY[${sql.join(normalizedOrderItemIds.map((id) => sql`${id}`), sql`, `)}]::int[])
        GROUP BY osi.order_item_id
      `);
      const coveredByOrderItemId = new Map<number, number>();
      for (const row of coverageResult.rows ?? []) {
        coveredByOrderItemId.set(
          Number((row as any).order_item_id),
          Number((row as any).covered_qty ?? 0),
        );
      }

      // A package holds at most one customer-fulfillment row per order item
      // (uq_wms_outbound_shipment_items_shipment_order_item). Growth for an
      // item already on this package changes that row instead of inserting.
      const existingRowResult = await db.execute(sql`
        SELECT id, order_item_id, qty
        FROM wms.outbound_shipment_items
        WHERE shipment_id = ${shipmentId}
          AND order_item_id = ANY(ARRAY[${sql.join(normalizedOrderItemIds.map((id) => sql`${id}`), sql`, `)}]::int[])
        FOR UPDATE
      `);
      const existingRowByOrderItemId = new Map<number, { id: number; qty: number }>();
      for (const row of existingRowResult.rows ?? []) {
        existingRowByOrderItemId.set(Number((row as any).order_item_id), {
          id: Number((row as any).id),
          qty: Number((row as any).qty ?? 0),
        });
      }

      const shipmentItemIds: number[] = [];
      const quantityIncreases: ShipmentItemQuantityIncrease[] = [];
      let addedQuantity = 0;
      for (const row of itemRows) {
        const orderItemId = Number((row as any).id);
        const quantity = Number((row as any).quantity ?? 0);
        const fulfilledQuantity = Number((row as any).fulfilled_quantity ?? 0);
        const coveredQuantity = coveredByOrderItemId.get(orderItemId) ?? 0;
        const uncoveredQuantity = Math.max(
          quantity - Math.max(fulfilledQuantity, coveredQuantity),
          0,
        );
        if (uncoveredQuantity <= 0) continue;

        const existingRow = existingRowByOrderItemId.get(orderItemId);
        if (existingRow) {
          const toQuantity = existingRow.qty + uncoveredQuantity;
          if (options.providerMembershipState === PROVIDER_MEMBERSHIP_PENDING_APPEND) {
            // The engine already holds this row at its old quantity.
            quantityIncreases.push({
              shipmentItemId: existingRow.id,
              orderItemId,
              fromQuantity: existingRow.qty,
              toQuantity,
            });
            continue;
          }
          if (targetStatus !== "planned") {
            // Authoritative growth may only be written locally while no engine
            // holds the package; anything else would silently diverge from it.
            throw new Error(
              `shipment ${shipmentId} (${targetStatus}) needs a provider quantity amend for order item ${orderItemId}`,
            );
          }
          const updated = await db.execute(sql`
            UPDATE wms.outbound_shipment_items
            SET qty = ${toQuantity}
            WHERE id = ${existingRow.id}
              AND qty = ${existingRow.qty}
            RETURNING id
          `);
          if ((updated.rows?.length ?? 0) !== 1) {
            throw new Error(
              `shipment item ${existingRow.id} changed while its planned quantity was raised`,
            );
          }
          shipmentItemIds.push(existingRow.id);
          addedQuantity += uncoveredQuantity;
          continue;
        }

        const defaults = await resolveShipmentItemDefaults(db, orderItemId);
        const inserted = await db.execute(sql`
          INSERT INTO wms.outbound_shipment_items (
            shipment_id,
            order_item_id,
            product_variant_id,
            from_location_id,
            qty,
            provider_membership_state
          ) VALUES (
            ${shipmentId},
            ${orderItemId},
            ${(row as any).product_id ?? defaults.productVariantId},
            ${defaults.fromLocationId},
            ${uncoveredQuantity},
            ${options.providerMembershipState}
          )
          RETURNING id
        `);
        const insertedId = Number(inserted.rows?.[0]?.id);
        if (!Number.isInteger(insertedId) || insertedId <= 0) {
          throw new Error(
            `failed to create shipment coverage for WMS order item ${orderItemId}`,
          );
        }
        shipmentItemIds.push(insertedId);
        addedQuantity += uncoveredQuantity;
      }

      return { shipmentId, shipmentItemIds, addedQuantity, quantityIncreases };
    },
  );
}

/**
 * Move exact, still-unconfirmed package rows to a residual package after the
 * provider proves the original package is locked. This is intentionally a
 * move, not a copy, so active coverage remains exactly once.
 */
export interface CreateLateEditResidualShipmentResult
  extends AppendUncoveredShipmentItemsResult {
  created: boolean;
}

/**
 * Create or reuse the currently-planned residual package and attach only the
 * uncovered demand. Callers use this when local package state is already
 * terminal enough that amending the original would be unsafe.
 */
export async function createLateEditResidualShipment(
  db: DbLike,
  wmsOrderId: number,
  channelId: number | null,
  orderItemIds: readonly number[],
  options?: { useXactLock?: boolean; sessionLock?: SessionAdvisoryLockRunner },
): Promise<CreateLateEditResidualShipmentResult> {
  if (
    channelId != null &&
    (!Number.isInteger(channelId) || channelId <= 0)
  ) {
    throw new Error(`channelId must be a positive integer when provided`);
  }
  const normalizedOrderItemIds = normalizePositiveIntegerIds(
    orderItemIds,
    "orderItemIds",
  );

  return withOrderShipmentLock(
    db,
    wmsOrderId,
    { useXactLock: options?.useXactLock === true, sessionLock: options?.sessionLock },
    async () => {
      const existing = await db.execute(sql`
        SELECT id
        FROM wms.outbound_shipments
        WHERE order_id = ${wmsOrderId}
          AND source = ${LATE_ORDER_EDIT_SHIPMENT_SOURCE}
          AND status = 'planned'
        ORDER BY id
        LIMIT 1
        FOR UPDATE
      `);
      let shipmentId = Number(existing.rows?.[0]?.id);
      let created = false;
      if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
        const inserted = await db.execute(sql`
          INSERT INTO wms.outbound_shipments (
            order_id,
            channel_id,
            status,
            source,
            shipment_purpose
          ) VALUES (
            ${wmsOrderId},
            ${channelId},
            'planned',
            ${LATE_ORDER_EDIT_SHIPMENT_SOURCE},
            'customer_fulfillment'
          )
          RETURNING id
        `);
        shipmentId = Number(inserted.rows?.[0]?.id);
        created = true;
      }
      if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
        throw new Error(
          `failed to create late-edit residual shipment for WMS order ${wmsOrderId}`,
        );
      }

      const coverage = await appendUncoveredItemsToShipment(
        db,
        wmsOrderId,
        shipmentId,
        normalizedOrderItemIds,
        {
          providerMembershipState: PROVIDER_MEMBERSHIP_AUTHORITATIVE,
          useXactLock: true,
        },
      );
      return { ...coverage, created };
    },
  );
}

export async function movePendingShipmentItemsToLateEditResidual(
  db: DbLike,
  sourceShipmentId: number,
  shipmentItemIds: readonly number[],
  options?: { useXactLock?: boolean; sessionLock?: SessionAdvisoryLockRunner },
): Promise<MovePendingShipmentItemsResult> {
  if (!Number.isInteger(sourceShipmentId) || sourceShipmentId <= 0) {
    throw new Error(
      `sourceShipmentId must be a positive integer, got ${sourceShipmentId}`,
    );
  }
  const normalizedShipmentItemIds = normalizePositiveIntegerIds(
    shipmentItemIds,
    "shipmentItemIds",
  );

  const sourceResult = await db.execute(sql`
    SELECT order_id, channel_id
    FROM wms.outbound_shipments
    WHERE id = ${sourceShipmentId}
    LIMIT 1
  `);
  const source = sourceResult.rows?.[0] as any;
  const wmsOrderId = Number(source?.order_id);
  if (!Number.isInteger(wmsOrderId) || wmsOrderId <= 0) {
    throw new Error(`source shipment ${sourceShipmentId} was not found`);
  }

  return withOrderShipmentLock(
    db,
    wmsOrderId,
    { useXactLock: options?.useXactLock === true, sessionLock: options?.sessionLock },
    async () => {
      const itemResult = await db.execute(sql`
        SELECT
          osi.id,
          osi.shipment_id,
          osi.qty,
          osi.provider_membership_state,
          os.source,
          os.status
        FROM wms.outbound_shipment_items osi
        JOIN wms.outbound_shipments os ON os.id = osi.shipment_id
        WHERE osi.id = ANY(ARRAY[${sql.join(normalizedShipmentItemIds.map((id) => sql`${id}`), sql`, `)}]::int[])
          AND os.order_id = ${wmsOrderId}
        ORDER BY osi.id
        FOR UPDATE OF osi
      `);
      const rows = itemResult.rows ?? [];
      if (rows.length !== normalizedShipmentItemIds.length) {
        throw new Error(
          `one or more pending shipment items are missing for source shipment ${sourceShipmentId}`,
        );
      }

      const rowsAlreadyOnResidual = rows.every(
        (row: any) => row.source === LATE_ORDER_EDIT_SHIPMENT_SOURCE,
      );
      if (rowsAlreadyOnResidual) {
        const residualShipmentIds = new Set(
          rows.map((row: any) => Number(row.shipment_id)),
        );
        const membershipStates = new Set(
          rows.map((row: any) => String(row.provider_membership_state)),
        );
        if (residualShipmentIds.size !== 1 || membershipStates.size !== 1) {
          throw new Error(
            `shipment items for source ${sourceShipmentId} have inconsistent residual membership`,
          );
        }
        const residualShipmentId = Array.from(residualShipmentIds)[0];
        const membershipState = Array.from(membershipStates)[0];
        const nextAction =
          membershipState === PROVIDER_MEMBERSHIP_PENDING_APPEND
            ? "amend"
            : membershipState === PROVIDER_MEMBERSHIP_AUTHORITATIVE
              ? "none"
              : null;
        if (!nextAction) {
          throw new Error(
            `shipment items for source ${sourceShipmentId} have unsupported residual membership ${membershipState}`,
          );
        }
        return {
          sourceShipmentId,
          residualShipmentId,
          shipmentItemIds: normalizedShipmentItemIds,
          movedQuantity: rows.reduce(
            (total: number, row: any) => total + Number(row.qty ?? 0),
            0,
          ),
          alreadyMoved: true,
          nextAction,
        };
      }

      const invalidRow = rows.find(
        (row: any) =>
          Number(row.shipment_id) !== sourceShipmentId ||
          row.provider_membership_state !== PROVIDER_MEMBERSHIP_PENDING_APPEND,
      );
      if (invalidRow) {
        throw new Error(
          `shipment item ${invalidRow.id} is not pending append on source shipment ${sourceShipmentId}`,
        );
      }

      const existingResidual = await db.execute(sql`
        SELECT id, status
        FROM wms.outbound_shipments
        WHERE order_id = ${wmsOrderId}
          AND source = ${LATE_ORDER_EDIT_SHIPMENT_SOURCE}
          AND id <> ${sourceShipmentId}
          AND status IN ('planned', 'queued', 'on_hold')
        ORDER BY id
        LIMIT 2
        FOR UPDATE
      `);
      if ((existingResidual.rows?.length ?? 0) > 1) {
        throw new Error(
          `multiple open late-edit residual shipments exist for WMS order ${wmsOrderId}`,
        );
      }
      let residualShipmentId = Number(existingResidual.rows?.[0]?.id);
      let residualStatus = String(
        existingResidual.rows?.[0]?.status ?? "planned",
      );
      if (!Number.isInteger(residualShipmentId) || residualShipmentId <= 0) {
        const inserted = await db.execute(sql`
          INSERT INTO wms.outbound_shipments (
            order_id,
            channel_id,
            status,
            source,
            shipment_purpose
          ) VALUES (
            ${wmsOrderId},
            ${source.channel_id ?? null},
            'planned',
            ${LATE_ORDER_EDIT_SHIPMENT_SOURCE},
            'customer_fulfillment'
          )
          RETURNING id
        `);
        residualShipmentId = Number(inserted.rows?.[0]?.id);
        residualStatus = "planned";
      }
      if (!Number.isInteger(residualShipmentId) || residualShipmentId <= 0) {
        throw new Error(
          `failed to create late-edit residual shipment for WMS order ${wmsOrderId}`,
        );
      }

      const targetMembershipState =
        residualStatus === "planned"
          ? PROVIDER_MEMBERSHIP_AUTHORITATIVE
          : PROVIDER_MEMBERSHIP_PENDING_APPEND;
      const moved = await db.execute(sql`
        UPDATE wms.outbound_shipment_items
        SET shipment_id = ${residualShipmentId},
            provider_membership_state = ${targetMembershipState}
        WHERE id = ANY(ARRAY[${sql.join(normalizedShipmentItemIds.map((id) => sql`${id}`), sql`, `)}]::int[])
          AND shipment_id = ${sourceShipmentId}
          AND provider_membership_state = ${PROVIDER_MEMBERSHIP_PENDING_APPEND}
        RETURNING id
      `);
      if ((moved.rows?.length ?? 0) !== normalizedShipmentItemIds.length) {
        throw new Error(
          `pending shipment membership changed while moving source shipment ${sourceShipmentId}`,
        );
      }

      return {
        sourceShipmentId,
        residualShipmentId,
        shipmentItemIds: normalizedShipmentItemIds,
        movedQuantity: rows.reduce(
          (total: number, row: any) => total + Number(row.qty ?? 0),
          0,
        ),
        alreadyMoved: false,
        nextAction: residualStatus === "planned" ? "push" : "amend",
      };
    },
  );
}

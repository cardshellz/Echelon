import type { Pool } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type { NormalizedDropshipOrderPayload } from "../application/dropship-order-intake-service";
import type {
  DropshipOrderAcceptanceWorkflowContext,
  DropshipOrderAcceptanceWorkflowRepository,
} from "../application/dropship-order-acceptance-workflow-service";

interface OrderAcceptanceContextRow {
  id: number;
  vendor_id: number;
  store_connection_id: number;
  normalized_payload: NormalizedDropshipOrderPayload | null;
  config: Record<string, unknown> | null;
  staged_shipping_quote_snapshot_id: number | string | null;
}

export class PgDropshipOrderAcceptanceWorkflowRepository implements DropshipOrderAcceptanceWorkflowRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async loadOrderAcceptanceContext(input: {
    vendorId: number;
    intakeId: number;
  }): Promise<DropshipOrderAcceptanceWorkflowContext | null> {
    const result = await this.dbPool.query<OrderAcceptanceContextRow>(
      `SELECT
         oi.id,
         oi.vendor_id,
         oi.store_connection_id,
         oi.normalized_payload,
         sc.config,
         st.shipping_quote_snapshot_id AS staged_shipping_quote_snapshot_id
       FROM dropship.dropship_order_intake oi
       INNER JOIN dropship.dropship_store_connections sc
         ON sc.id = oi.store_connection_id
        AND sc.vendor_id = oi.vendor_id
       LEFT JOIN dropship.dropship_order_acceptance_stages st
         ON st.intake_id = oi.id
       WHERE oi.id = $1
         AND oi.vendor_id = $2
       LIMIT 1`,
      [input.intakeId, input.vendorId],
    );

    const row = result.rows[0];
    if (!row) return null;
    if (!row.normalized_payload) {
      throw new DropshipError(
        "DROPSHIP_ORDER_INTAKE_PAYLOAD_REQUIRED",
        "Dropship order intake is missing normalized payload.",
        { intakeId: row.id, vendorId: row.vendor_id },
      );
    }

    return {
      intakeId: row.id,
      vendorId: row.vendor_id,
      storeConnectionId: row.store_connection_id,
      defaultWarehouseId: readOrderProcessingDefaultWarehouseId(row.config ?? {}),
      normalizedPayload: row.normalized_payload,
      stagedShippingQuoteSnapshotId: readStagedShippingQuoteSnapshotId(row),
    };
  }
}

// The stage's quote id never changes once written (migration 0667's update guard).
function readStagedShippingQuoteSnapshotId(row: OrderAcceptanceContextRow): number | null {
  if (row.staged_shipping_quote_snapshot_id === null) return null;
  const quoteSnapshotId = Number(row.staged_shipping_quote_snapshot_id);
  if (!Number.isSafeInteger(quoteSnapshotId) || quoteSnapshotId <= 0) {
    throw new DropshipError(
      "DROPSHIP_ORDER_ACCEPTANCE_STAGED_QUOTE_INVALID",
      "The acceptance stage for this intake names an invalid shipping quote.",
      { intakeId: row.id, shippingQuoteSnapshotId: String(row.staged_shipping_quote_snapshot_id) },
    );
  }
  return quoteSnapshotId;
}

function readOrderProcessingDefaultWarehouseId(config: Record<string, unknown>): number | null {
  const value = isRecord(config.orderProcessing)
    ? config.orderProcessing.defaultWarehouseId
    : undefined;
  if (value === null || typeof value === "undefined" || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

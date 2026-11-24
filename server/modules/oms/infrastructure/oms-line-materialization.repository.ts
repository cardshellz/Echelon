import { sql, type SQL } from "drizzle-orm";

export interface RefreshOmsLineMaterializedQuantitiesInput {
  omsOrderId: number;
  updatedAt: Date;
}

export interface OmsLineMaterializationDb {
  execute: (query: SQL) => PromiseLike<unknown>;
}

function assertRefreshInput(input: RefreshOmsLineMaterializedQuantitiesInput): void {
  if (!Number.isSafeInteger(input.omsOrderId) || input.omsOrderId <= 0) {
    throw new Error("omsOrderId must be a positive safe integer");
  }
  if (!(input.updatedAt instanceof Date) || Number.isNaN(input.updatedAt.getTime())) {
    throw new Error("updatedAt must be a valid Date");
  }
}

/**
 * Reconciles the OMS counter to the cumulative non-cancelled WMS materialization
 * linked to each OMS line. Callers must pass their current transaction when this
 * follows a WMS item mutation so both states commit or roll back together.
 */
export async function refreshOmsLineMaterializedQuantities(
  db: OmsLineMaterializationDb,
  input: RefreshOmsLineMaterializedQuantitiesInput,
): Promise<number> {
  assertRefreshInput(input);

  const result = await db.execute(sql`
    WITH target_lines AS (
      SELECT id
      FROM oms.oms_order_lines
      WHERE order_id = ${input.omsOrderId}
    ),
    materialized AS (
      SELECT
        oi.oms_order_line_id,
        COALESCE(SUM(COALESCE(oi.quantity, 0)), 0)::int AS quantity
      FROM wms.order_items oi
      JOIN target_lines ON target_lines.id = oi.oms_order_line_id
      WHERE COALESCE(oi.status, '') <> 'cancelled'
      GROUP BY oi.oms_order_line_id
    )
    UPDATE oms.oms_order_lines ol
       SET wms_materialized_quantity = COALESCE(materialized.quantity, 0),
           updated_at = ${input.updatedAt}
      FROM target_lines
      LEFT JOIN materialized
        ON materialized.oms_order_line_id = target_lines.id
     WHERE ol.id = target_lines.id
       AND ol.wms_materialized_quantity IS DISTINCT FROM COALESCE(materialized.quantity, 0)
    RETURNING ol.id
  `);

  const rows = (result as { rows?: unknown[] } | null)?.rows;
  if (Array.isArray(rows)) return rows.length;

  const rowCount = (result as { rowCount?: number } | null)?.rowCount;
  return typeof rowCount === "number" ? rowCount : 0;
}

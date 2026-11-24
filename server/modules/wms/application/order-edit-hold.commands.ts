import type { PoolClient } from "pg";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { z } from "zod";

type HoldTransaction =
  | Pick<PoolClient, "query">
  | {
      execute(
        statement: SQL,
      ): Promise<{ rows: unknown[]; rowCount?: number | null }>;
    };

const ownershipSchema = z
  .object({
    operationId: z.string().uuid(),
    wmsOrderIds: z.array(z.number().int().positive().safe()).min(1),
  })
  .strict()
  .refine(
    (input) => new Set(input.wmsOrderIds).size === input.wmsOrderIds.length,
    {
      message: "Warehouse order IDs must be unique",
    },
  );
const dialect = new PgDialect();

async function affectedRows(
  tx: HoldTransaction,
  statement: SQL,
): Promise<number> {
  // A Drizzle transaction also has a `query` property, but it is a relational
  // query namespace rather than the pg client's callable query method.
  if ("execute" in tx) {
    const result = await tx.execute(statement);
    return result.rowCount ?? result.rows.length;
  }
  const compiled = dialect.sqlToQuery(statement);
  const result = await tx.query(compiled.sql, compiled.params);
  return result.rowCount ?? result.rows.length;
}

/**
 * Transaction-composable WMS ownership primitive. The caller must hold the OMS
 * and WMS rows in canonical order and persist the operation/audit in the same
 * transaction. This dedicated owner never changes an unrelated manual hold.
 * Returns the affected count so the caller can classify a lost-ownership fence.
 */
export async function acquireOrderEditWarehouseHold(
  tx: HoldTransaction,
  input: { operationId: string; wmsOrderIds: number[] },
): Promise<number> {
  const value = ownershipSchema.parse(input);
  return affectedRows(
    tx,
    sql`UPDATE wms.orders SET order_edit_operation_id=${value.operationId}::uuid
    WHERE id=ANY(${sql.param(value.wmsOrderIds)}::int[])
      AND (order_edit_operation_id IS NULL OR order_edit_operation_id=${value.operationId}::uuid)
    RETURNING id`,
  );
}

/** Release only the supplied operation's ownership after caller verification. */
export async function releaseOrderEditWarehouseHold(
  tx: HoldTransaction,
  input: { operationId: string; wmsOrderIds: number[] },
): Promise<number> {
  const value = ownershipSchema.parse(input);
  return affectedRows(
    tx,
    sql`UPDATE wms.orders SET order_edit_operation_id=NULL
    WHERE id=ANY(${sql.param(value.wmsOrderIds)}::int[]) AND order_edit_operation_id=${value.operationId}::uuid
    RETURNING id`,
  );
}

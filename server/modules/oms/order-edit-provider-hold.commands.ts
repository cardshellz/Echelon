import type { PoolClient } from "pg";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { z } from "zod";
import { OrderEditError } from "../order-edits/domain/order-edit-error";

type HoldTransaction =
  | Pick<PoolClient, "query">
  | { execute(statement: SQL): Promise<{ rows: unknown[] }> };

const operationIdSchema = z.string().uuid();
const retirementSchema = z
  .object({ operationId: operationIdSchema, now: z.date() })
  .strict();
const transferSchema = z
  .object({
    fromOperationId: operationIdSchema,
    toOperationId: operationIdSchema,
    now: z.date(),
  })
  .strict()
  .refine((input) => input.fromOperationId !== input.toOperationId, {
    message: "Provider hold transfer requires distinct operations",
  });
const receiptSchema = z.object({
  shipment_id: z.number().int().positive().safe(),
  provider_order_id: z.union([
    z.string().regex(/^[1-9]\d*$/),
    z.number().int().positive().safe().transform(String),
  ]),
  was_held: z.boolean(),
});
const dialect = new PgDialect();

async function execute(
  tx: HoldTransaction,
  statement: SQL,
): Promise<{ rows: unknown[] }> {
  if ("execute" in tx) return tx.execute(statement);
  const compiled = dialect.sqlToQuery(statement);
  return tx.query(compiled.sql, compiled.params);
}

/**
 * OMS owns provider receipts. The caller must verify provider cleanup and hold
 * the order/operation locks, then persist state and audit in this transaction.
 * Retired receipts remain available for audit but cannot authorize a release.
 */
export async function retireOrderEditProviderHolds(
  tx: HoldTransaction,
  input: z.infer<typeof retirementSchema>,
): Promise<void> {
  const value = retirementSchema.parse(input);
  await execute(
    tx,
    sql`UPDATE oms.order_edit_provider_holds SET released_at=${value.now}
      WHERE operation_id=${value.operationId}::uuid AND released_at IS NULL`,
  );
}

/**
 * Transfer only active receipts to the certified edit that owns a source
 * conflict. The caller holds both operation locks and must commit the ownership
 * change and its audit together. Preserve both provider identity and prior holds.
 */
export async function transferOrderEditProviderHolds(
  tx: HoldTransaction,
  input: z.infer<typeof transferSchema>,
): Promise<void> {
  const value = transferSchema.parse(input);
  const result = await execute(
    tx,
    sql`SELECT shipment_id,provider_order_id,was_held FROM oms.order_edit_provider_holds
      WHERE operation_id=${value.fromOperationId}::uuid AND released_at IS NULL
      ORDER BY shipment_id FOR UPDATE`,
  );
  const receipts = z.array(receiptSchema).parse(result.rows);
  for (const receipt of receipts) {
    const transferred = await execute(
      tx,
      sql`INSERT INTO oms.order_edit_provider_holds(operation_id,shipment_id,provider_order_id,was_held)
        VALUES(${value.toOperationId}::uuid,${receipt.shipment_id},${receipt.provider_order_id}::bigint,${receipt.was_held})
        ON CONFLICT(operation_id,shipment_id) DO UPDATE
          SET was_held=oms.order_edit_provider_holds.was_held OR EXCLUDED.was_held,released_at=NULL
        WHERE oms.order_edit_provider_holds.provider_order_id=EXCLUDED.provider_order_id
        RETURNING shipment_id`,
    );
    if (transferred.rows.length !== 1)
      throw new OrderEditError(
        "ORDER_EDIT_PROVIDER_IDENTITY_CHANGED",
        "Provider hold ownership changed.",
      );
  }
  await retireOrderEditProviderHolds(tx, {
    operationId: value.fromOperationId,
    now: value.now,
  });
}

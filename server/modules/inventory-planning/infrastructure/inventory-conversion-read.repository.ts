import type { Pool, PoolClient } from "pg";
import { pool } from "../../../db";
import type { AllowedConversion, InventoryConversionReader } from "../application/inventory-conversion-read.port";

type QueryClient = Pick<PoolClient, "query" | "release">;

/** Read-only adapter for the planning module's published conversion interface. */
export class PostgresInventoryConversionReader implements InventoryConversionReader {
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = pool) {}

  async getAllowedConversions(productId: number): Promise<ReadonlyArray<AllowedConversion>> {
    if (!Number.isSafeInteger(productId) || productId <= 0) throw new Error("productId must be a positive integer");
    const client = await this.connectionPool.connect();
    try {
      const result = await client.query<{
        source_variant_id: number; destination_variant_id: number; operation_type: AllowedConversion["operationType"];
        input_qty: number; output_qty: number;
      }>(`SELECT path.source_variant_id, path.destination_variant_id, path.operation_type,
                  path.input_qty, path.output_qty
           FROM inventory.transformation_model_heads AS head
           JOIN inventory.transformation_model_versions AS model
             ON model.id = head.active_model_id
            AND model.product_id = head.product_id
           JOIN inventory.transformation_model_paths AS path
             ON path.model_id = model.id
           WHERE head.product_id = $1
             AND model.lifecycle_status = 'sealed'
             AND model.validation_state = 'valid'
             AND path.authority_state = 'allowed'
             AND path.validation_state = 'valid'
           ORDER BY path.source_variant_id, path.destination_variant_id, path.id`, [productId]);
      return result.rows.map((row) => ({
        sourceVariantId: Number(row.source_variant_id), destinationVariantId: Number(row.destination_variant_id),
        operationType: row.operation_type, inputQty: Number(row.input_qty), outputQty: Number(row.output_qty),
      }));
    } finally { client.release(); }
  }
}

import type { PoolClient } from "pg";
import type { ClaimPickPackagingPath } from "../domain/claim-pick-package-conversions";

/** Immutable, claim-selected path evidence. No SKU inference or configuration writes. */
export async function readClaimPickPackagingPath(
  client: PoolClient,
  authorityId: number,
): Promise<ClaimPickPackagingPath | null> {
  const result = await client.query<ClaimPickPackagingPath>(
    `SELECT path.id, path.operation_type AS "operationType",
            path.source_variant_id AS "sourceVariantId", path.destination_variant_id AS "destinationVariantId",
            source.product_id AS "sourceProductId", destination.product_id AS "destinationProductId",
            path.input_qty AS "inputQty", path.output_qty AS "outputQty",
            path.source_units_per_variant AS "sourceUnitsPerVariant",
            path.destination_units_per_variant AS "destinationUnitsPerVariant",
            path.authority_state AS "authorityState", path.validation_state AS "validationState"
     FROM inventory.transformation_model_paths path
     JOIN catalog.product_variants source ON source.id=path.source_variant_id
     JOIN catalog.product_variants destination ON destination.id=path.destination_variant_id
     WHERE path.id=$1`,
    [authorityId],
  );
  return result.rows[0] ?? null;
}

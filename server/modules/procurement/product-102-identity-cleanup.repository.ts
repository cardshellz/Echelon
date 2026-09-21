import type { PoolClient } from "pg";
import {
  PRODUCT_102_CLEANUP_KEY,
  cleanupRequire,
  product102CleanupAuditInputSchema,
} from "@shared/catalog/product-102-cleanup-contract";

/** Transaction-bound owner API for the reviewed 102 -> 5 repair only. No pool,
 * generic IDs, price/quantity updates, receiving fallback or matching hooks. */
export async function correctProduct102PurchasingIdentity(
  client: PoolClient,
): Promise<void> {
  const admitted = (
    await client.query<{ admitted: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM catalog.product_cleanup_receipts
    WHERE command_key=$1 AND owner_transaction_id=pg_current_xact_id()::text) AS admitted`,
      [PRODUCT_102_CLEANUP_KEY],
    )
  ).rows[0].admitted;
  cleanupRequire(
    admitted,
    "CLEANUP_ADMISSION_MISSING",
    "Purchasing correction requires the current authorized cleanup transaction.",
  );
  const line221 = await client.query(
    "UPDATE procurement.purchase_order_lines SET product_id=5,vendor_product_id=125 WHERE id=221 AND product_id=102 AND vendor_product_id=25",
  );
  const line39 = await client.query(
    "UPDATE procurement.purchase_order_lines SET product_id=5 WHERE id=39 AND product_id=102",
  );
  const supplier = await client.query(
    "DELETE FROM procurement.vendor_products WHERE id=25 AND product_id=102",
  );
  cleanupRequire(
    line221.rowCount === 1 && line39.rowCount === 1 && supplier.rowCount === 1,
    "CLEANUP_WRITE_SCOPE_CHANGED",
    "The exact purchasing cleanup row counts changed; roll back the transaction.",
  );
}

/** IDs and financial snapshots stay as exact PostgreSQL text, including audits
 * above Number.MAX_SAFE_INTEGER. The caller records the FK-protected receipt. */
export async function recordProduct102PurchasingCleanupAudit(
  client: PoolClient,
  input: unknown,
): Promise<{ auditEventId: string; poEventIds: string[] }> {
  const { command, requestHash, occurredAt, before, after } =
    product102CleanupAuditInputSchema.parse(input);
  const auditEventId = (
    await client.query<{ id: string }>(
      `INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
    VALUES($1,'AUDIT',$2,'catalog.product_identity_removed','product:102',
      jsonb_build_object('sourceProductId',102,'targetProductId',5,'stateHash',$3::text),
      jsonb_build_object('requestHash',$4::text,'commandKey',$5::text)) RETURNING id::text`,
      [
        occurredAt,
        command.actorId,
        command.expectedHash,
        requestHash,
        PRODUCT_102_CLEANUP_KEY,
      ],
    )
  ).rows[0].id;
  const poEventIds: string[] = [];
  for (const [lineId, poId] of [
    [39, 7],
    [221, 134],
  ]) {
    poEventIds.push(
      (
        await client.query<{ id: string }>(
          `INSERT INTO procurement.po_events(po_id,event_type,actor_type,actor_id,payload_json,created_at)
      VALUES($1,'product_identity_corrected','user',$2,jsonb_build_object('commandKey',$3::text,'lineId',$4::int,
        'before',(SELECT e FROM jsonb_array_elements($5::jsonb->'poLines') e WHERE e->>'id'=$4::text),
        'after',(SELECT e FROM jsonb_array_elements($6::jsonb->'poLines') e WHERE e->>'id'=$4::text)),$7) RETURNING id::text`,
          [
            poId,
            command.actorId,
            PRODUCT_102_CLEANUP_KEY,
            lineId,
            before,
            after,
            occurredAt,
          ],
        )
      ).rows[0].id,
    );
  }
  return { auditEventId, poEventIds };
}
